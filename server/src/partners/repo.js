import { sql, transaction } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { FRONT_POSITIONS } from '../employees/schema.js';
import * as employees from '../employees/repo.js';
import { updateVisit, withVisitState } from '../cases/repo.js';
import { ensureStaffInbox, inboxPartnerJob } from '../notify/staffInbox.js';
import { ensurePartnerSchema } from './schema.js';

/**
 * พาร์ทเนอร์ (ผู้รับเหมาช่วงรายครั้ง · ผู้ใช้ขอ 21 พ.ย. 2569)
 *
 *   KIN ส่งกะให้บริษัท → หัวหน้าพาร์ทเนอร์ รับ + เลือกคนในทีม / ปฏิเสธ (กะกลับมาหา KIN) → พนักงานไปตามปกติ
 *   KIN ดึงกะคืนได้ทุกเมื่อก่อนเช็คอิน · เงิน = กะที่ไปจริง (เช็คอิน+เช็คเอาท์) × เรท ณ ตอนส่ง จ่ายบริษัทรายเดือน
 *
 * ทุกฟังก์ชันฝั่งหัวหน้าพาร์ทเนอร์รับ partnerId จาก session (req.user.partner_id) และกรองด้วยมันเสมอ
 * ไม่มีราคาที่ลูกค้าจ่าย ไม่มีข้อมูลสุขภาพ ไม่มีกะอื่นของเคส ออกไปทางนี้
 */

const todayTH = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);
const LEAD = 'partner_lead';
const ACTIVE = ['active', 'probation'];
/** ตำแหน่งที่หัวหน้าพาร์ทเนอร์เพิ่มในทีมได้ — หน้างานจริง (ไม่รวม "ว่าง") */
export const TEAM_POSITIONS = FRONT_POSITIONS.filter((p) => p !== 'unassigned');

const actorOf = (user) => ({ employee_id: user.employee_id, name: user.name });
/** คอลัมน์ของบริษัทที่ส่งออกไป — ไม่เอาไบนารีโลโก้ (ส่งแค่ "มีไหม" + เลขรุ่นไว้กันแคช) */
const PARTNER_COLS = (a = '') => `${a}partner_id, ${a}name, ${a}contact_name, ${a}phone, ${a}rate_per_visit, ${a}status, ${a}note,
  ${a}created_at, ${a}created_by, ${a}updated_at,
  (${a}logo_data IS NOT NULL) AS has_logo,
  COALESCE(EXTRACT(EPOCH FROM ${a}logo_updated_at)::bigint, 0) AS logo_version`;

async function logPartnerEvent(db, { visitId, caseId, partnerId, kind, employeeId = null, reason = null, actor }) {
  await db.run(
    `INSERT INTO partner_visit_events (visit_id, case_id, partner_id, kind, employee_id, reason, actor_id, actor_name)
     VALUES (:visit_id, :case_id, :partner_id, :kind, :employee_id, :reason, :actor_id, :actor_name)`,
    { visit_id: visitId, case_id: caseId, partner_id: partnerId, kind, employee_id: employeeId, reason,
      actor_id: actor?.employee_id ?? null, actor_name: actor?.name ?? null },
  );
}

// ============================================================================
// บริษัทพาร์ทเนอร์ (หลังบ้าน KIN)
// ============================================================================

export async function listPartners() {
  await ensurePartnerSchema();
  const month = todayTH().slice(0, 7);
  return sql.all(
    `SELECT ${PARTNER_COLS('p.')},
            (SELECT COUNT(*)::int FROM employees e WHERE e.partner_id = p.partner_id AND e.position = '${LEAD}'
               AND e.status IN ('active', 'probation')) AS leads,
            (SELECT COUNT(*)::int FROM employees e WHERE e.partner_id = p.partner_id AND e.position <> '${LEAD}'
               AND e.status IN ('active', 'probation')) AS staff,
            (SELECT COUNT(*)::int FROM case_visits v WHERE v.partner_id = p.partner_id AND v.status <> 'cancelled'
               AND v.check_in_at IS NULL AND v.visit_date >= :today) AS open_visits,
            (SELECT COUNT(*)::int FROM case_visits v WHERE v.partner_id = p.partner_id AND v.status <> 'cancelled'
               AND v.check_out_at IS NOT NULL AND v.visit_date LIKE :month) AS done_this_month
     FROM partners p
     ORDER BY p.status, p.name`,
    { today: todayTH(), month: `${month}%` },
  );
}

export async function findPartner(partnerId) {
  await ensurePartnerSchema();
  return sql.one(`SELECT ${PARTNER_COLS()} FROM partners WHERE partner_id = :id`, { id: partnerId });
}

/** โลโก้ — image = { data, mime } (decodeImage แล้ว) หรือ null = ลบ · ดัน logo_updated_at ให้หน้าเว็บโหลดรูปใหม่ */
export async function setLogo(partnerId, image) {
  await ensurePartnerSchema();
  const row = await sql.one(
    `UPDATE partners SET logo_data = :data, logo_mime = :mime, logo_updated_at = CASE WHEN :has THEN now() END, updated_at = now()
     WHERE partner_id = :id RETURNING ${PARTNER_COLS()}`,
    { id: partnerId, data: image?.data ?? null, mime: image?.mime ?? null, has: Boolean(image) },
  );
  if (!row) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  return row;
}

export async function getLogo(partnerId) {
  await ensurePartnerSchema();
  return sql.one('SELECT logo_data, logo_mime FROM partners WHERE partner_id = :id AND logo_data IS NOT NULL', { id: partnerId });
}

export async function createPartner(input, actor) {
  await ensurePartnerSchema();
  return sql.one(
    `INSERT INTO partners (name, contact_name, phone, rate_per_visit, note, created_by)
     VALUES (:name, :contact_name, :phone, :rate_per_visit, :note, :created_by)
     RETURNING ${PARTNER_COLS()}`,
    { name: input.name, contact_name: input.contact_name ?? null, phone: input.phone ?? null,
      rate_per_visit: input.rate_per_visit ?? 0, note: input.note ?? null, created_by: actor.employee_id },
  );
}

export async function updatePartner(partnerId, input) {
  await ensurePartnerSchema();
  const cols = ['name', 'contact_name', 'phone', 'rate_per_visit', 'status', 'note'].filter((c) => c in input);
  if (!cols.length) return findPartner(partnerId);
  const row = await sql.one(
    `UPDATE partners SET ${cols.map((c) => `${c} = :${c}`).join(', ')}, updated_at = now()
     WHERE partner_id = :id RETURNING ${PARTNER_COLS()}`,
    { ...Object.fromEntries(cols.map((c) => [c, input[c] ?? null])), id: partnerId },
  );
  if (!row) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  return row;
}

/** คนของบริษัท (หัวหน้า + ทีม) — หลังบ้าน KIN ดู/สร้างหัวหน้า · หัวหน้าดูทีมตัวเอง */
export async function people(partnerId) {
  await ensurePartnerSchema();
  const month = todayTH().slice(0, 7);
  return sql.all(
    `SELECT e.employee_id, e.first_name, e.last_name, e.nickname, e.phone, e.position, e.status,
            e.last_login_at, (e.uses_default_password IS NOT FALSE) AS default_password,
            (SELECT COUNT(*)::int FROM case_visits v WHERE v.checked_in_by = e.employee_id
               AND v.check_out_at IS NOT NULL AND v.status <> 'cancelled' AND v.visit_date LIKE :month) AS done_this_month
     FROM employees e
     WHERE e.partner_id = :id
     ORDER BY (e.status IN ('active', 'probation')) DESC, (e.position = '${LEAD}') DESC, e.first_name`,
    { id: partnerId, month: `${month}%` },
  );
}

/** สร้างบัญชี — หลังบ้าน KIN สร้างหัวหน้า (asLead) · หัวหน้าเพิ่มคนในทีม · เข้าครั้งแรกด้วยรหัสเริ่มต้นแล้วถูกบังคับเปลี่ยน */
export async function createPerson(partnerId, input, { asLead = false } = {}) {
  const partner = await findPartner(partnerId);
  if (!partner) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  if (partner.status !== 'active') throw new ApiError(409, 'พาร์ทเนอร์นี้ปิดใช้งานอยู่');
  const position = asLead ? LEAD : input.position;
  if (!asLead && !TEAM_POSITIONS.includes(position)) throw new ApiError(400, 'ตำแหน่งไม่ถูกต้อง');
  return employees.create(
    { first_name: input.first_name, last_name: input.last_name, nickname: input.nickname ?? null,
      phone: input.phone ?? null, position, employment_type: 'contract', status: 'active' },
    { partnerId },
  );
}

/** แก้คนในทีม — ชื่อ/เบอร์/ตำแหน่ง · ปิดบัญชี (resigned) / เปิดคืน (active) · เฉพาะคนของบริษัทตัวเอง */
export async function updatePerson(partnerId, employeeId, input, { allowLead = false } = {}) {
  await ensurePartnerSchema();
  const person = await sql.one('SELECT employee_id, position, partner_id FROM employees WHERE employee_id = :id', { id: employeeId });
  if (!person || person.partner_id !== partnerId) throw new ApiError(404, 'ไม่พบคนนี้ในทีม');
  if (person.position === LEAD && !allowLead) throw new ApiError(403, 'แก้บัญชีหัวหน้าพาร์ทเนอร์ได้จากหลังบ้าน KIN เท่านั้น');
  if (input.position && person.position !== LEAD && !TEAM_POSITIONS.includes(input.position)) throw new ApiError(400, 'ตำแหน่งไม่ถูกต้อง');
  const patch = {};
  for (const c of ['first_name', 'last_name', 'nickname', 'phone']) if (c in input) patch[c] = input[c];
  if (input.position && person.position !== LEAD) patch.position = input.position;
  if (input.status) {
    if (!['active', 'resigned'].includes(input.status)) throw new ApiError(400, 'สถานะไม่ถูกต้อง');
    patch.status = input.status;
    patch.resign_date = input.status === 'resigned' ? todayTH() : null;
  }
  if (patch.status === 'resigned') {
    // คนที่ยังถือกะข้างหน้าอยู่ ปิดบัญชีไม่ได้ — ให้หัวหน้าเปลี่ยนคนในกะนั้นก่อน (ไม่งั้นกะค้างเป็นของคนที่เข้าระบบไม่ได้)
    const { n } = await sql.one(
      `SELECT COUNT(*)::int AS n FROM case_visits WHERE assigned_to = :id AND status <> 'cancelled'
         AND check_in_at IS NULL AND visit_date >= :today`,
      { id: employeeId, today: todayTH() },
    );
    if (n > 0) throw new ApiError(409, `คนนี้ยังมีกะข้างหน้า ${n} กะ — เปลี่ยนคนในกะเหล่านั้นก่อนปิดบัญชี`);
  }
  return employees.update(employeeId, patch);
}

// ============================================================================
// ส่ง / ดึงคืน (หลังบ้าน KIN)
// ============================================================================

async function visitWithCase(visitId) {
  return sql.one(
    `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.status, v.assigned_to, v.check_in_at,
            v.partner_id, v.partner_status, c.client_name, c.status AS case_status
     FROM case_visits v JOIN cases c ON c.case_id = v.case_id
     WHERE v.visit_id = :id`,
    { id: visitId },
  );
}

function assertOpen(visit, what) {
  if (!visit) throw new ApiError(404, 'ไม่พบกะนี้');
  if (visit.status === 'cancelled') throw new ApiError(409, `กะนี้ถูกยกเลิกแล้ว — ${what}ไม่ได้`);
  if (visit.check_in_at) throw new ApiError(409, `กะนี้เช็คอินไปแล้ว — ${what}ไม่ได้`);
  if (visit.visit_date < todayTH()) throw new ApiError(409, `กะนี้เลยวันไปแล้ว — ${what}ไม่ได้`);
}

/**
 * ตรวจซ้ำหลังล็อกแถวกะ (updateVisit opts.guard) — ค่าที่อ่านก่อนหน้าอาจเก่าแล้วถ้าอีกฝั่งกดพร้อมกัน
 * (KIN ดึงคืนขณะหัวหน้ากดรับ ฯลฯ) · owner(v) ตรวจว่ากะยังเป็นของฝั่งที่คิดว่าเป็นอยู่
 */
const lockedGuard = (what, owner) => (v) => {
  assertOpen(v, what);
  if (owner && !owner(v)) throw new ApiError(409, 'กะนี้ถูกเปลี่ยนไประหว่างนั้น — โหลดหน้าใหม่แล้วลองอีกครั้ง');
};

/** ช่วงเวลาของกะ (ไม่ระบุเวลา = ทั้งวัน) — ใช้ตรวจชนตอนเลือกคน */
const slotOf = (s, e) => [s ?? '00:00', e && e > (s ?? '00:00') ? e : '24:00'];

/** ส่งกะให้พาร์ทเนอร์ — คน KIN ที่ถืออยู่เดิม (ถ้ามี) ได้แจ้ง "กะถูกย้าย" · หัวหน้าทุกคนของบริษัทได้แจ้งงานใหม่ */
export async function sendVisit(visitId, partnerId, user) {
  await ensurePartnerSchema();
  await ensureStaffInbox();
  const visit = await visitWithCase(visitId);
  assertOpen(visit, 'ส่งให้พาร์ทเนอร์');
  if (!['unassigned', 'assigned', 'in_progress'].includes(visit.case_status)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
  const partner = await findPartner(partnerId);
  if (!partner) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  if (partner.status !== 'active') throw new ApiError(409, `${partner.name} ปิดใช้งานอยู่`);
  if (visit.partner_id === partnerId) throw new ApiError(409, `กะนี้อยู่กับ ${partner.name} อยู่แล้ว`);
  const leads = await sql.all(
    `SELECT employee_id FROM employees WHERE partner_id = :id AND position = '${LEAD}' AND status IN ('active', 'probation')`,
    { id: partnerId },
  );
  if (!leads.length) throw new ApiError(409, `${partner.name} ยังไม่มีบัญชีหัวหน้าพาร์ทเนอร์ — สร้างที่ตั้งค่าระบบ › พาร์ทเนอร์ก่อน`);

  const actor = actorOf(user);
  await updateVisit(visit.case_id, visitId, { assigned_to: null }, actor, {
    keepPartner: true,
    note: `ส่งให้พาร์ทเนอร์ ${partner.name}`,
    guard: lockedGuard('ส่งให้พาร์ทเนอร์', (v) => v.partner_id !== partnerId),
    extra: {
      partner_id: partnerId, partner_status: 'pending', partner_rate: partner.rate_per_visit,
      partner_sent_at: new Date(), partner_sent_by: user.employee_id,
      partner_rejected_at: null, partner_rejected_by: null, partner_reject_reason: null,
    },
    after: async (tx, locked) => {
      // ย้ายจากบริษัทหนึ่งไปอีกบริษัท — บริษัทเดิมมีประวัติว่าถูกดึงคืน (สรุปของเขาจะได้ไม่งง)
      if (locked.partner_id && locked.partner_id !== partnerId) {
        await logPartnerEvent(tx, { visitId, caseId: visit.case_id, partnerId: locked.partner_id, kind: 'pulled', actor });
      }
      await logPartnerEvent(tx, { visitId, caseId: visit.case_id, partnerId, kind: 'sent', actor });
      await inboxPartnerJob(tx, leads.map((l) => l.employee_id), {
        caseId: visit.case_id, visitId, client: visit.client_name, date: visit.visit_date, start: visit.planned_start,
      });
    },
  });
}

/** ตรวจบริษัทก่อนลงนัดแบบส่งพาร์ทเนอร์ (cases/routes.js /visits/bulk) — เปิดใช้อยู่ + มีบัญชีหัวหน้า */
export async function prepareSend(partnerId) {
  await ensurePartnerSchema();
  await ensureStaffInbox();
  const partner = await findPartner(partnerId);
  if (!partner) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  if (partner.status !== 'active') throw new ApiError(409, `${partner.name} ปิดใช้งานอยู่`);
  const leads = await sql.all(
    `SELECT employee_id FROM employees WHERE partner_id = :id AND position = '${LEAD}' AND status IN ('active', 'probation')`,
    { id: partnerId },
  );
  if (!leads.length) throw new ApiError(409, `${partner.name} ยังไม่มีบัญชีหัวหน้าพาร์ทเนอร์ — สร้างที่ตั้งค่าระบบ › พาร์ทเนอร์ก่อน`);
  return { partner, leads: leads.map((l) => l.employee_id) };
}

/** หลังลงนัดแบบส่งพาร์ทเนอร์ — จดประวัติทีละกะ + แจ้งหัวหน้าบริษัทครั้งเดียว ("งานใหม่ N งาน") */
export async function afterBulkSend(db, caseId, visitIds, { partner, leads }, user) {
  if (!visitIds?.length) return;
  const actor = actorOf(user);
  const rows = await db.all(
    `SELECT v.visit_id, v.visit_date, v.planned_start, c.client_name
     FROM case_visits v JOIN cases c ON c.case_id = v.case_id
     WHERE v.visit_id = ANY(:ids::int[]) ORDER BY v.visit_date, v.planned_start NULLS FIRST`,
    { ids: visitIds },
  );
  for (const r of rows) {
    await logPartnerEvent(db, { visitId: r.visit_id, caseId, partnerId: partner.partner_id, kind: 'sent', actor });
  }
  const first = rows[0];
  await inboxPartnerJob(db, leads, {
    caseId, visitId: first.visit_id, client: first.client_name, date: first.visit_date, start: first.planned_start,
    total: rows.length, lastDate: rows[rows.length - 1].visit_date,
  });
}

/** ดึงกะคืน — assignedTo = คน KIN ที่จะรับต่อ (ตรวจสิทธิ์รับงานที่ route แล้ว) หรือ null = ยังไม่มีคน */
export async function pullVisit(visitId, assignedTo, user) {
  await ensurePartnerSchema();
  const visit = await visitWithCase(visitId);
  assertOpen(visit, 'ดึงคืน');
  if (!visit.partner_id) throw new ApiError(409, 'กะนี้ไม่ได้ส่งให้พาร์ทเนอร์');
  const actor = actorOf(user);
  await updateVisit(visit.case_id, visitId, { assigned_to: assignedTo ?? null }, actor, {
    keepPartner: true,
    note: 'ดึงกะคืนจากพาร์ทเนอร์',
    guard: lockedGuard('ดึงคืน', (v) => v.partner_id === visit.partner_id),
    extra: { partner_id: null, partner_status: null, partner_rejected_at: null, partner_rejected_by: null, partner_reject_reason: null },
    after: (tx) => logPartnerEvent(tx, { visitId, caseId: visit.case_id, partnerId: visit.partner_id, kind: 'pulled', employeeId: assignedTo, actor }),
  });
}

/** กะที่หลังบ้านต้องดู: ส่งแล้วยังไม่มีคน (ใกล้นัด 24 ชม.) · พาร์ทเนอร์ปฏิเสธแล้วยังไม่มีคนรับต่อ */
export const ATTENTION_HOURS = 24;
const START_AT = `((v.visit_date || ' ' || COALESCE(v.planned_start, '08:00'))::timestamp AT TIME ZONE 'Asia/Bangkok')`;
const ATTENTION_WHERE = `v.status = 'scheduled' AND v.check_in_at IS NULL AND v.visit_date >= :today
  AND ((v.partner_id IS NOT NULL AND v.partner_status = 'pending' AND ${START_AT} < now() + make_interval(hours => :hours))
       OR (v.partner_id IS NULL AND v.partner_rejected_at IS NOT NULL AND v.assigned_to IS NULL))`;

export async function attention() {
  await ensurePartnerSchema();
  return sql.all(
    `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end, c.client_name,
            v.partner_status, v.partner_reject_reason, v.partner_rejected_at,
            COALESCE(p.name, rp.name) AS partner_name,
            CASE WHEN v.partner_id IS NULL THEN 'rejected' ELSE 'unstaffed' END AS reason
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN partners p ON p.partner_id = v.partner_id
     LEFT JOIN partners rp ON rp.partner_id = v.partner_rejected_by
     WHERE ${ATTENTION_WHERE}
     ORDER BY v.visit_date, v.planned_start NULLS FIRST`,
    { today: todayTH(), hours: ATTENTION_HOURS },
  );
}

export async function attentionCount() {
  await ensurePartnerSchema();
  const { n } = await sql.one(`SELECT COUNT(*)::int AS n FROM case_visits v WHERE ${ATTENTION_WHERE}`,
    { today: todayTH(), hours: ATTENTION_HOURS });
  return n;
}

// ============================================================================
// ฝั่งหัวหน้าพาร์ทเนอร์
// ============================================================================

/** ข้อมูลที่หัวหน้าพาร์ทเนอร์เห็นต่อกะ — ชื่อ/ที่อยู่/แผนที่/บริการ เท่านั้น (ไม่มีราคา ไม่มีอาการ ไม่มีเบอร์ญาติ) */
const PARTNER_VISIT = `
  SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end, v.status,
         v.check_in_at, v.check_out_at, v.assigned_to, v.partner_status, v.partner_sent_at,
         e.first_name || ' ' || e.last_name AS assigned_name, e.nickname AS assigned_nickname,
         c.client_name, c.address, c.geo_lat, c.geo_lng,
         COALESCE(pp.name, f.name) AS service_name,
         c.service_kind,
         -- เคสมีคน KIN ดูแลอยู่ = ไปแทน · ไม่มี = งานรายครั้ง
         (c.assigned_to IS NOT NULL) AS substitute
  FROM case_visits v
  JOIN cases c ON c.case_id = v.case_id
  LEFT JOIN employees e ON e.employee_id = v.assigned_to
  LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
  LEFT JOIN pkg_service_formats f ON f.format_id = c.pkg_format_id
`;

const withDeadline = (v) => {
  const s = withVisitState(v);
  const start = new Date(`${v.visit_date}T${v.planned_start ?? '08:00'}:00+07:00`);
  return { ...s, starts_in_hours: Math.round((start.getTime() - Date.now()) / 36e5) };
};

export async function partnerVisits(partnerId, tab = 'pending') {
  await ensurePartnerSchema();
  const where = {
    pending: `v.partner_status = 'pending' AND v.status <> 'cancelled' AND v.check_in_at IS NULL`,
    accepted: `v.partner_status = 'accepted' AND v.status <> 'cancelled' AND v.check_out_at IS NULL AND v.visit_date >= :yesterday`,
    past: `(v.check_out_at IS NOT NULL OR v.status = 'cancelled' OR v.visit_date < :yesterday)`,
  }[tab];
  if (!where) throw new ApiError(400, 'แท็บไม่ถูกต้อง');
  const order = tab === 'past' ? 'v.visit_date DESC, v.planned_start DESC NULLS LAST' : 'v.visit_date, v.planned_start NULLS FIRST';
  const yesterday = new Date(Date.now() + 7 * 3.6e6 - 864e5).toISOString().slice(0, 10);
  const rows = await sql.all(
    `${PARTNER_VISIT} WHERE v.partner_id = :pid AND ${where} ORDER BY ${order} LIMIT 200`,
    { pid: partnerId, yesterday },
  );
  return rows.map(withDeadline);
}

export async function partnerCounts(partnerId) {
  await ensurePartnerSchema();
  const yesterday = new Date(Date.now() + 7 * 3.6e6 - 864e5).toISOString().slice(0, 10);
  return sql.one(
    `SELECT COUNT(*) FILTER (WHERE v.partner_status = 'pending' AND v.status <> 'cancelled' AND v.check_in_at IS NULL)::int AS pending,
            COUNT(*) FILTER (WHERE v.partner_status = 'accepted' AND v.status <> 'cancelled' AND v.check_out_at IS NULL
                               AND v.visit_date >= :yesterday)::int AS accepted,
            -- รอรับและใกล้นัดภายใน 24 ชม. (ไทล์ "ต้องเลือกคนด่วน" บนจอคอม)
            COUNT(*) FILTER (WHERE v.partner_status = 'pending' AND v.status <> 'cancelled' AND v.check_in_at IS NULL
                               AND ${START_AT} < now() + interval '24 hours')::int AS urgent,
            COUNT(*) FILTER (WHERE v.check_in_at IS NOT NULL AND v.check_out_at IS NOT NULL AND v.status <> 'cancelled'
                               AND v.visit_date LIKE :month)::int AS done_month
     FROM case_visits v WHERE v.partner_id = :pid`,
    { pid: partnerId, yesterday, month: `${todayTH().slice(0, 7)}%` },
  );
}

async function partnerVisitOr404(partnerId, visitId) {
  const visit = await visitWithCase(visitId);
  // ของบริษัทอื่น/ไม่ได้ส่งมา = 404 เหมือนไม่มีกะนี้ (ไม่บอกใบ้ว่ามีอยู่จริง)
  if (!visit || visit.partner_id !== partnerId) throw new ApiError(404, 'ไม่พบงานนี้');
  return visit;
}

/**
 * รายละเอียดเคสคร่าวๆ ของกะที่ส่งมา (ผู้ใช้ขอ 21 พ.ย. 2569 — กดการ์ดงานเพื่อดู)
 * ให้เท่าที่ใช้เตรียมตัวไปหน้างาน: เพศ/อายุ/น้ำหนัก/ส่วนสูง · อุปกรณ์ที่ติดตัวผู้รับบริการ · ช่วงเคส · ครั้งที่เท่าไรของเคส
 * ไม่ให้: อาการ/โรคประจำตัว (ผู้ใช้สั่งตัดอาการออก) · เบอร์โทร · ราคา · กะของ KIN หรือของบริษัทอื่น
 */
export async function partnerVisitDetail(partnerId, visitId) {
  await partnerVisitOr404(partnerId, visitId);
  const v = await sql.one(
    `${PARTNER_VISIT.replace('c.service_kind,', `c.service_kind, c.patient_gender, c.patient_age, c.weight_kg, c.height_cm,
         c.medical_devices, c.start_date, c.end_date,`)}
     WHERE v.visit_id = :id`,
    { id: visitId },
  );
  const order = await sql.one(
    `SELECT COUNT(*) FILTER (WHERE (o.visit_date, COALESCE(o.planned_start, '')) <= (:date, COALESCE(:start::text, '')))::int AS no,
            COUNT(*)::int AS total
     FROM case_visits o WHERE o.case_id = :cid AND o.status <> 'cancelled'`,
    { cid: v.case_id, date: v.visit_date, start: v.planned_start },
  );
  // กะอื่นของเคสนี้ที่ส่งให้บริษัทเดียวกัน — ดูว่าครั้งก่อน/ครั้งหน้าใครไป
  const others = await sql.all(
    `SELECT v.visit_id, v.visit_date, v.planned_start, v.planned_end, v.status, v.check_in_at, v.check_out_at,
            e.first_name || ' ' || e.last_name AS assigned_name
     FROM case_visits v LEFT JOIN employees e ON e.employee_id = v.assigned_to
     WHERE v.case_id = :cid AND v.partner_id = :pid AND v.visit_id <> :id
     ORDER BY v.visit_date DESC, v.planned_start DESC NULLS LAST LIMIT 10`,
    { cid: v.case_id, pid: partnerId, id: visitId },
  );
  const { case_id: _cid, ...rest } = withDeadline(v);
  return { ...rest, visit_no: order?.no ?? null, visit_total: order?.total ?? null, others };
}

/** คนในทีมที่เลือกให้กะนี้ได้ + กะอื่นของแต่ละคนในวันเดียวกัน (หน้าเว็บโชว์ "ชนเวลา") */
export async function candidates(partnerId, visitId) {
  const visit = await partnerVisitOr404(partnerId, visitId);
  const full = await sql.one('SELECT planned_start, planned_end FROM case_visits WHERE visit_id = :id', { id: visitId });
  const team = await sql.all(
    `SELECT e.employee_id, e.first_name, e.last_name, e.nickname, e.position
     FROM employees e
     WHERE e.partner_id = :pid AND e.position = ANY(:positions::text[]) AND e.status IN ('active', 'probation')
     ORDER BY e.first_name`,
    { pid: partnerId, positions: TEAM_POSITIONS },
  );
  const busy = await sql.all(
    `SELECT v.assigned_to, v.visit_id, v.planned_start, v.planned_end
     FROM case_visits v
     WHERE v.visit_date = :date AND v.status <> 'cancelled' AND v.visit_id <> :id
       AND v.assigned_to = ANY(:ids::text[])`,
    { date: visit.visit_date, id: visitId, ids: team.map((t) => t.employee_id) },
  );
  const [a1, a2] = slotOf(full.planned_start, full.planned_end);
  return team.map((t) => {
    const mine = busy.filter((b) => b.assigned_to === t.employee_id);
    const conflict = mine.some((b) => {
      const [b1, b2] = slotOf(b.planned_start, b.planned_end);
      return a1 < b2 && b1 < a2;
    });
    return { ...t, busy: mine.map((b) => ({ start: b.planned_start, end: b.planned_end })), conflict };
  });
}

/** รับงาน + เลือกคน (หรือเปลี่ยนคน) — คนต้องเป็นทีมของบริษัทนี้ ยังทำงานอยู่ และเป็นตำแหน่งหน้างาน */
export async function acceptVisit(partnerId, visitId, employeeId, user) {
  await ensurePartnerSchema();
  const visit = await partnerVisitOr404(partnerId, visitId);
  assertOpen(visit, 'รับงาน');
  const person = await sql.one(
    'SELECT employee_id, first_name, last_name, position, status, partner_id FROM employees WHERE employee_id = :id',
    { id: employeeId },
  );
  if (!person || person.partner_id !== partnerId) throw new ApiError(400, 'เลือกได้เฉพาะคนในทีมของบริษัทคุณ');
  if (!ACTIVE.includes(person.status)) throw new ApiError(409, `${person.first_name} ปิดบัญชีอยู่`);
  if (!TEAM_POSITIONS.includes(person.position)) throw new ApiError(409, `${person.first_name} ไม่ใช่ตำแหน่งหน้างาน`);
  if (visit.partner_status === 'accepted' && visit.assigned_to === employeeId) throw new ApiError(409, `${person.first_name} รับกะนี้อยู่แล้ว`);
  /* ชนเวลากับกะอื่นของคนนี้ในวันเดียวกัน = ไม่ให้รับ (หน้าเว็บกันไว้แล้ว แต่ server ต้องกันด้วย — เรียก API ตรง/สองหัวหน้ากดพร้อมกัน) */
  const mine = await sql.one('SELECT planned_start, planned_end FROM case_visits WHERE visit_id = :id', { id: visitId });
  const others = await sql.all(
    `SELECT planned_start, planned_end FROM case_visits
     WHERE assigned_to = :emp AND visit_date = :date AND status <> 'cancelled' AND visit_id <> :id`,
    { emp: employeeId, date: visit.visit_date, id: visitId },
  );
  const [a1, a2] = slotOf(mine.planned_start, mine.planned_end);
  const clash = others.find((o) => { const [b1, b2] = slotOf(o.planned_start, o.planned_end); return a1 < b2 && b1 < a2; });
  if (clash) {
    throw new ApiError(409, `${person.first_name} มีงานอื่นชนเวลานี้ (${clash.planned_start ?? 'ทั้งวัน'}${clash.planned_end ? `–${clash.planned_end}` : ''}) — เลือกคนอื่น`);
  }
  const kind = visit.partner_status === 'accepted' ? 'reassigned' : 'accepted';
  const actor = actorOf(user);
  await updateVisit(visit.case_id, visitId, { assigned_to: employeeId }, actor, {
    keepPartner: true,
    note: `พาร์ทเนอร์${kind === 'accepted' ? 'รับงาน' : 'เปลี่ยนคน'}`,
    guard: lockedGuard('รับงาน', (v) => v.partner_id === partnerId),
    extra: { partner_status: 'accepted' },
    after: (tx) => logPartnerEvent(tx, { visitId, caseId: visit.case_id, partnerId, kind, employeeId, actor }),
  });
}

/** ปฏิเสธ — กะกลับไปหา KIN (ไม่มีคน) + จดเหตุผล · กระดิ่งหลังบ้านนับจนกว่าจะมีคนรับต่อ */
export async function rejectVisit(partnerId, visitId, reason, user) {
  await ensurePartnerSchema();
  const visit = await partnerVisitOr404(partnerId, visitId);
  assertOpen(visit, 'ปฏิเสธ');
  const actor = actorOf(user);
  await updateVisit(visit.case_id, visitId, { assigned_to: null }, actor, {
    keepPartner: true,
    note: `พาร์ทเนอร์ปฏิเสธงาน${reason ? ` (${reason})` : ''}`,
    guard: lockedGuard('ปฏิเสธ', (v) => v.partner_id === partnerId),
    extra: {
      partner_id: null, partner_status: null,
      partner_rejected_at: new Date(), partner_rejected_by: partnerId, partner_reject_reason: reason || null,
    },
    after: (tx) => logPartnerEvent(tx, { visitId, caseId: visit.case_id, partnerId, kind: 'rejected', reason: reason || null, actor }),
  });
}

// ============================================================================
// สรุปรายเดือน (ทั้งสองฝั่ง) + บันทึกจ่าย
// ============================================================================

/** กะของบริษัทในเดือน: ไปจริง (เช็คอิน+เช็คเอาท์) = นับเงิน · ขาดงาน = เลยวันแล้วไม่มีเช็คอิน · ปฏิเสธ = จากประวัติ */
export async function summary(partnerId, month) {
  await ensurePartnerSchema();
  const rows = await sql.all(
    `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.check_in_at, v.check_out_at, v.status,
            v.partner_rate, c.client_name,
            COALESCE(v.checked_in_by, v.assigned_to) AS employee_id,
            e.first_name || ' ' || e.last_name AS employee_name
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees e ON e.employee_id = COALESCE(v.checked_in_by, v.assigned_to)
     WHERE v.partner_id = :pid AND v.visit_date LIKE :month AND v.status <> 'cancelled'
     ORDER BY v.visit_date DESC, v.planned_start DESC NULLS LAST`,
    { pid: partnerId, month: `${month}%` },
  );
  const today = todayTH();
  const visits = rows.map((r) => {
    const done = Boolean(r.check_in_at && r.check_out_at);
    const missed = !r.check_in_at && r.visit_date < today;
    return { ...r, done, missed, amount: done ? Number(r.partner_rate ?? 0) : 0 };
  });
  const { rejected } = await sql.one(
    `SELECT COUNT(*)::int AS rejected FROM partner_visit_events
     WHERE partner_id = :pid AND kind = 'rejected' AND to_char(at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') = :month`,
    { pid: partnerId, month },
  );
  const byStaff = new Map();
  for (const v of visits.filter((x) => x.done)) {
    const k = v.employee_id ?? '-';
    const cur = byStaff.get(k) ?? { employee_id: v.employee_id, name: v.employee_name ?? '—', done: 0, amount: 0 };
    cur.done += 1;
    cur.amount += v.amount;
    byStaff.set(k, cur);
  }
  const payment = await sql.one(
    'SELECT * FROM partner_payments WHERE partner_id = :pid AND period_month = :month', { pid: partnerId, month },
  );
  return {
    month,
    done: visits.filter((v) => v.done).length,
    missed: visits.filter((v) => v.missed).length,
    rejected,
    amount: Math.round(visits.reduce((t, v) => t + v.amount, 0) * 100) / 100,
    by_staff: [...byStaff.values()].sort((a, b) => b.done - a.done),
    visits: visits.filter((v) => v.done || v.missed),
    payment,
  };
}

/** หลังบ้าน KIN: สรุปทุกบริษัทของเดือน */
export async function summaryAll(month) {
  const partners = await listPartners();
  const out = [];
  for (const p of partners) {
    const s = await summary(p.partner_id, month);
    if (p.status === 'active' || s.done || s.missed || s.payment) {
      out.push({ partner_id: p.partner_id, name: p.name, rate_per_visit: p.rate_per_visit, status: p.status,
        done: s.done, missed: s.missed, rejected: s.rejected, amount: s.amount, payment: s.payment });
    }
  }
  return out;
}

/** บันทึกว่าจ่ายแล้ว — ตรึงจำนวนครั้ง/ยอด ณ วันนี้ · เดือนที่ยังไม่จบจ่ายไม่ได้ (ยอดยังเปลี่ยน) */
export async function markPaid(partnerId, month, { note } = {}, user) {
  await ensurePartnerSchema();
  if (month >= todayTH().slice(0, 7)) throw new ApiError(409, 'เดือนนี้ยังไม่จบ — บันทึกจ่ายได้หลังสิ้นเดือน');
  const s = await summary(partnerId, month);
  if (s.payment) throw new ApiError(409, 'เดือนนี้บันทึกจ่ายไปแล้ว');
  if (!s.done) throw new ApiError(409, 'เดือนนี้ไม่มีกะที่ไปจริง');
  /* กดพร้อมกันสองคน: ตัวที่สองชน UNIQUE แล้วได้ "จ่ายไปแล้ว" (409) ไม่ใช่ 500 — ON CONFLICT ไม่คืนแถว */
  const row = await sql.one(
    `INSERT INTO partner_payments (partner_id, period_month, visits, amount, note, paid_by, paid_by_name)
     VALUES (:pid, :month, :visits, :amount, :note, :by, :by_name)
     ON CONFLICT (partner_id, period_month) DO NOTHING RETURNING *`,
    { pid: partnerId, month, visits: s.done, amount: s.amount, note: note ?? null, by: user.employee_id, by_name: user.name },
  );
  if (!row) throw new ApiError(409, 'เดือนนี้บันทึกจ่ายไปแล้ว');
  return row;
}

/** ต้นทุนพาร์ทเนอร์ในช่วงวันที่ (รายงานกำไรตาม BU) — กะที่ไปจริง × เรท ณ ตอนส่ง นับตามวันกะ */
export async function costRows(from, to) {
  await ensurePartnerSchema();
  return sql.all(
    `SELECT v.case_id, COALESCE(v.partner_rate, 0)::float AS amount, v.visit_date AS date
     FROM case_visits v
     WHERE v.partner_id IS NOT NULL AND v.check_in_at IS NOT NULL AND v.check_out_at IS NOT NULL
       AND v.status <> 'cancelled' AND v.visit_date BETWEEN :from AND :to`,
    { from, to },
  );
}
