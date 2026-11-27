import { sql, transaction } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { FRONT_POSITIONS } from '../employees/schema.js';
import * as employees from '../employees/repo.js';
import { updateVisit, withVisitState, addReport, recordPartnerVisit, undoPartnerVisit } from '../cases/repo.js';
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
const PARTNER_COLS = (a = '') => `${a}partner_id, ${a}name, ${a}contact_name, ${a}phone, ${a}rate_per_visit, ${a}english_rate, ${a}service_kind, ${a}status, ${a}note,
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
    `INSERT INTO partners (name, contact_name, phone, rate_per_visit, english_rate, service_kind, note, created_by)
     VALUES (:name, :contact_name, :phone, :rate_per_visit, :english_rate, :service_kind, :note, :created_by)
     RETURNING ${PARTNER_COLS()}`,
    { name: input.name, contact_name: input.contact_name ?? null, phone: input.phone ?? null,
      rate_per_visit: input.rate_per_visit ?? 0, english_rate: input.english_rate ?? 0, service_kind: input.service_kind ?? 'homecare', note: input.note ?? null,
      created_by: actor.employee_id },
  );
}

export async function updatePartner(partnerId, input) {
  await ensurePartnerSchema();
  if (input.status === 'inactive') {
    /* ตรวจ 23 พ.ย. 2569: ปิดบริษัทแล้วกะที่ส่งไปค้างอยู่ — หัวหน้าปฏิเสธ/เปลี่ยนคนไม่ได้แล้ว KIN ก็ไม่ได้รับแจ้ง
       ให้ดึงกะคืนก่อน (ปุ่ม "ดึงคืน" ในตารางนัดของเคส) */
    const { n } = await sql.one(
      `SELECT COUNT(*)::int AS n FROM case_visits WHERE partner_id = :id AND status <> 'cancelled'
         AND check_out_at IS NULL AND (visit_date >= :today OR check_in_at IS NOT NULL)`,
      { id: partnerId, today: todayTH() },
    );
    if (n > 0) throw new ApiError(409, `บริษัทนี้ยังมีงานที่ส่งไปค้างอยู่ ${n} กะ — ดึงคืนก่อนแล้วจึงปิดใช้งาน`);
  }
  const cols = ['name', 'contact_name', 'phone', 'rate_per_visit', 'english_rate', 'service_kind', 'status', 'note'].filter((c) => c in input);
  if (!cols.length) return findPartner(partnerId);
  const row = await sql.one(
    `UPDATE partners SET ${cols.map((c) => `${c} = :${c}`).join(', ')}, updated_at = now()
     WHERE partner_id = :id RETURNING ${PARTNER_COLS()}`,
    { ...Object.fromEntries(cols.map((c) => [c, input[c] ?? null])), id: partnerId },
  );
  if (!row) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  return row;
}

/**
 * ลบบริษัทพาร์ทเนอร์ถาวร (ผู้ใช้ขอ 25 พ.ย. 2569) — พร้อมบัญชีหัวหน้า/ทีมของบริษัท
 *
 * ลบได้เฉพาะบริษัทที่ยังไม่มีประวัติเงิน — มีกะที่ไปจริง (เช็คอินแล้ว) หรือบันทึกจ่ายแล้ว = ลบไม่ได้
 * เพราะยอดสรุป/ต้นทุนตาม BU/สลิปจ่ายอ้างกะพวกนั้นอยู่ ให้ "ปิดใช้งาน" แทน
 * กะที่ส่งไปแล้วยังไม่มีคนไป (ยังไม่ยกเลิก) = ต้องดึงคืนก่อน (กติกาเดียวกับปิดใช้งาน) ไม่งั้นกะลอยไม่มีเจ้าของ
 * กะที่ยกเลิกไปแล้วแค่ปลดชื่อบริษัทออก · ประวัติส่ง/รับ/ปฏิเสธลบตาม
 */
export async function removePartner(partnerId) {
  await ensurePartnerSchema();
  await ensureStaffInbox();
  return transaction(async (tx) => {
    const p = await tx.one('SELECT partner_id, name FROM partners WHERE partner_id = :id FOR UPDATE', { id: partnerId });
    if (!p) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
    const b = await tx.one(
      `SELECT
         (SELECT COUNT(*)::int FROM partner_payments WHERE partner_id = :id) AS payments,
         (SELECT COUNT(*)::int FROM case_visits v
            WHERE v.check_in_at IS NOT NULL AND (v.partner_id = :id
               OR v.checked_in_by IN (SELECT employee_id FROM employees WHERE partner_id = :id))) AS worked,
         (SELECT COUNT(*)::int FROM case_visits WHERE partner_id = :id AND status <> 'cancelled' AND check_in_at IS NULL) AS open`,
      { id: partnerId },
    );
    if (b.payments > 0 || b.worked > 0) {
      throw new ApiError(409, `${p.name} มีประวัติงานที่ไปจริง${b.payments > 0 ? '/บันทึกจ่ายแล้ว' : ''} — ลบไม่ได้ ใช้ปิดใช้งานแทน`);
    }
    if (b.open > 0) throw new ApiError(409, `${p.name} ยังมีกะที่ส่งไปค้างอยู่ ${b.open} กะ — ดึงคืนก่อนแล้วจึงลบ`);

    await tx.run(`UPDATE case_visits SET partner_id = NULL, partner_status = NULL WHERE partner_id = :id`, { id: partnerId });
    await tx.run('DELETE FROM partner_visit_events WHERE partner_id = :id', { id: partnerId });
    const people = (await tx.all('SELECT employee_id FROM employees WHERE partner_id = :id', { id: partnerId })).map((r) => r.employee_id);
    if (people.length) {
      await tx.run('DELETE FROM staff_notifications WHERE employee_id = ANY(:ids::text[])', { ids: people });
      await tx.run('DELETE FROM employees WHERE employee_id = ANY(:ids::text[])', { ids: people });
    }
    await tx.run('DELETE FROM partners WHERE partner_id = :id', { id: partnerId });
    return { removed: true, people: people.length };
  });
}

/** คนของบริษัท (หัวหน้า + ทีม) — หลังบ้าน KIN ดู/สร้างหัวหน้า · หัวหน้าดูทีมตัวเอง */
export async function people(partnerId) {
  await ensurePartnerSchema();
  const month = todayTH().slice(0, 7);
  return sql.all(
    `SELECT e.employee_id, e.first_name, e.last_name, e.nickname, e.phone, e.email, e.position, e.status,
            e.last_login_at, (e.uses_default_password IS NOT FALSE) AS default_password,
            (SELECT COUNT(*)::int FROM case_visits v WHERE v.checked_in_by = e.employee_id
               AND v.check_out_at IS NOT NULL AND v.status <> 'cancelled' AND v.visit_date LIKE :month) AS done_this_month
     FROM employees e
     WHERE e.partner_id = :id
     ORDER BY (e.status IN ('active', 'probation')) DESC, (e.position = '${LEAD}') DESC, e.first_name`,
    { id: partnerId, month: `${month}%` },
  );
}

/**
 * รายละเอียดคนในทีม (หัวหน้ากดแถวในหน้าทีมของฉัน · ผู้ใช้ขอ 23 พ.ย. 2569)
 * ข้อมูลบัญชี + กะที่บริษัทนี้ให้คนนี้ไป (ล่าสุด 30 กะ) — ไม่มีค่าจ้าง/ราคา · เฉพาะกะของบริษัทตัวเอง
 */
export async function personDetail(partnerId, employeeId) {
  await ensurePartnerSchema();
  const person = (await people(partnerId)).find((p) => p.employee_id === employeeId);
  if (!person) throw new ApiError(404, 'ไม่พบคนนี้ในทีม');
  const visits = await sql.all(
    `SELECT v.visit_id, v.visit_date, v.planned_start, v.planned_end, v.status, v.check_in_at, v.check_out_at,
            c.client_name, COALESCE(pp.name, f.name) AS service_name
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
     LEFT JOIN pkg_service_formats f ON f.format_id = c.pkg_format_id
     WHERE v.assigned_to = :id AND v.partner_id = :pid
     ORDER BY v.visit_date DESC, v.planned_start DESC NULLS LAST LIMIT 30`,
    { id: employeeId, pid: partnerId },
  );
  const { done_total } = await sql.one(
    `SELECT COUNT(*)::int AS done_total FROM case_visits
     WHERE checked_in_by = :id AND check_out_at IS NOT NULL AND status <> 'cancelled' AND partner_id = :pid`,
    { id: employeeId, pid: partnerId },
  );
  return { ...person, done_total, visits };
}

/** อีเมลใช้เข้าระบบ — ห้ามซ้ำกับบัญชีอื่น (ดัชนี unique มีอยู่แล้ว แต่ตอบเป็นภาษาคนก่อนชน) */
async function ensureEmailFree(email, exceptId = null) {
  if (!email) return;
  const taken = await sql.one(
    'SELECT employee_id FROM employees WHERE lower(email) = lower(:email) AND employee_id IS DISTINCT FROM :except LIMIT 1',
    { email, except: exceptId },
  );
  if (taken) throw new ApiError(409, 'อีเมลนี้มีบัญชีอื่นใช้เข้าระบบอยู่แล้ว — ใช้อีเมลอื่น');
}

/** สร้างบัญชี — หลังบ้าน KIN สร้างหัวหน้า (asLead) · หัวหน้าเพิ่มคนในทีม · เข้าครั้งแรกด้วยรหัสเริ่มต้นแล้วถูกบังคับเปลี่ยน */
export async function createPerson(partnerId, input, { asLead = false } = {}) {
  const partner = await findPartner(partnerId);
  if (!partner) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  if (partner.status !== 'active') throw new ApiError(409, 'พาร์ทเนอร์นี้ปิดใช้งานอยู่');
  const position = asLead ? LEAD : input.position;
  if (!asLead && !TEAM_POSITIONS.includes(position)) throw new ApiError(400, 'ตำแหน่งไม่ถูกต้อง');
  await ensureEmailFree(input.email);
  return employees.create(
    { first_name: input.first_name, last_name: input.last_name, nickname: input.nickname ?? null,
      phone: input.phone ?? null, email: input.email ?? null, position, employment_type: 'contract', status: 'active' },
    { partnerId },
  );
}

/** แก้คนในทีม — ชื่อ/เบอร์/ตำแหน่ง · ปิดบัญชี (resigned) / เปิดคืน (active) · เฉพาะคนของบริษัทตัวเอง */
export async function updatePerson(partnerId, employeeId, input, { allowLead = false } = {}) {
  await ensurePartnerSchema();
  const person = await sql.one('SELECT employee_id, position, status, partner_id FROM employees WHERE employee_id = :id', { id: employeeId });
  if (!person || person.partner_id !== partnerId) throw new ApiError(404, 'ไม่พบคนนี้ในทีม');
  if (person.position === LEAD && !allowLead) throw new ApiError(403, 'แก้บัญชีหัวหน้าพาร์ทเนอร์ได้จากหลังบ้าน KIN เท่านั้น');
  if (input.position && person.position !== LEAD && !TEAM_POSITIONS.includes(input.position)) throw new ApiError(400, 'ตำแหน่งไม่ถูกต้อง');
  const patch = {};
  for (const c of ['first_name', 'last_name', 'nickname', 'phone', 'email']) if (c in input) patch[c] = input[c];
  if ('email' in patch) await ensureEmailFree(patch.email, employeeId);
  if (input.position && person.position !== LEAD) patch.position = input.position;
  if (input.status) {
    if (!['active', 'resigned'].includes(input.status)) throw new ApiError(400, 'สถานะไม่ถูกต้อง');
    /* ตรวจ 23 พ.ย. 2569: เดิมหัวหน้าเปิดบัญชีที่ KIN ปิด (เช่น ทำผิดวินัย) คืนได้ทันที
       KIN ปิด → 'suspended' · หัวหน้าปิด → 'resigned' · หัวหน้าเปิดคืนได้เฉพาะที่ตัวเองปิด (resigned) */
    if (input.status === 'active' && !allowLead && person.status !== 'resigned') {
      throw new ApiError(403, 'บัญชีนี้ถูก KIN ระงับไว้ — ติดต่อ KIN เพื่อเปิดคืน');
    }
    patch.status = input.status === 'resigned' && allowLead ? 'suspended' : input.status;
    patch.resign_date = input.status === 'resigned' ? todayTH() : null;
  }
  if (patch.status === 'resigned' || patch.status === 'suspended') {
    // คนที่ยังถือกะข้างหน้าอยู่ ปิดบัญชีไม่ได้ — ให้หัวหน้าเปลี่ยนคนในกะนั้นก่อน (ไม่งั้นกะค้างเป็นของคนที่เข้าระบบไม่ได้)
    const { n } = await sql.one(
      /* รวมกะที่เช็คอินแล้วแต่ยังไม่เช็คเอาท์ (ตรวจ 23 พ.ย. 2569) — ปิดกลางกะ = เช็คเอาท์ไม่ได้ กะไม่นับว่าไปแล้ว */
      `SELECT COUNT(*)::int AS n FROM case_visits WHERE assigned_to = :id AND status <> 'cancelled'
         AND ((check_in_at IS NULL AND visit_date >= :today) OR (check_in_at IS NOT NULL AND check_out_at IS NULL))`,
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
            v.partner_id, v.partner_status, c.client_name, c.status AS case_status, c.pkg_english,
            c.service_kind, c.physio_package_id
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
/**
 * ช่วงเวลาของกะเป็น "นาทีต่อเนื่องข้ามวัน" — หลักเดียวกับ cases/repo.js (SPAN/SPAN_END) ของระบบหลัก (ตรวจ 23 พ.ย. 2569)
 * กะดึก 20:00–08:00 (เวลาจบ ≤ เวลาเริ่ม) = จบ 08:00 ของวันถัดไป · ไม่ระบุเวลา = ทั้งวัน
 * เดิมตัดกะดึกที่ 24:00 และเทียบเฉพาะวันเดียวกัน → กะดึกเมื่อคืนไม่ชนกับนัด 06:00 เช้านี้
 * ชนกัน = ทับกันจริง (ต่อกันพอดี เช่น 08:00–20:00 แล้ว 20:00–08:00 ไม่นับว่าชน)
 */
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const spanOf = (date, s, e) => {
  const day = Date.parse(`${date}T00:00:00Z`) / 60000;
  const a = s ? toMin(s) : 0;
  let b = e ? toMin(e) : 1440;
  if (s && e && b <= a) b += 1440;
  return [day + a, day + b];
};
const overlaps = ([a1, a2], [b1, b2]) => a1 < b2 && b1 < a2;
/** วันก่อน–วันนั้น–วันถัดไป (กะดึกยาวไม่เกิน 24 ชม. จึงชนได้แค่วันข้างเคียง) */
const nearDays = (date) => {
  const d = Date.parse(`${date}T00:00:00Z`);
  const f = (n) => new Date(d + n * 864e5).toISOString().slice(0, 10);
  return { d0: f(-1), d2: f(1) };
};

/** ฝั่งงานของบริษัท (partners.service_kind) — Homecare หรือกายภาพบำบัด อย่างใดอย่างหนึ่ง */
const KIND_LABEL = { homecare: 'Homecare', physio: 'กายภาพบำบัด' };
/** เคสเป็นงานประเภทไหน — เกณฑ์เดียวกับหน้าเว็บ (เคสเก่าที่ service_kind ว่างแต่ผูกแพ็คกายภาพ = กายภาพ) */
export const caseKindOf = (c) => (c?.service_kind === 'physio' || c?.physio_package_id != null ? 'physio' : 'homecare');
/** ส่งงานให้บริษัทที่ไม่ได้รับงานประเภทนี้ไม่ได้ (26 พ.ย. 2569) */
function assertServes(partner, kind) {
  if ((partner.service_kind ?? 'homecare') !== kind) throw new ApiError(409, `${partner.name} ไม่ได้รับงาน${KIND_LABEL[kind]} — เลือกบริษัทอื่น หรือแก้ประเภทของบริษัทที่ตั้งค่าระบบ › พาร์ทเนอร์`);
}

/**
 * เรทของกะ ณ ตอนส่ง = เรทต่อครั้ง + ค่าภาษาต่อครั้ง (เฉพาะเคสที่ลูกค้าขอภาษาอังกฤษ · ผู้ใช้ขอ 25 พ.ย. 2569)
 * partner_rate เป็นยอดรวมเสมอ — สรุปรายเดือน/บันทึกจ่าย/ต้นทุนตาม BU อ่านช่องนี้ช่องเดียว จึงได้ค่าภาษาด้วยโดยไม่ต้องแก้
 * partner_english จดส่วนที่เป็นค่าภาษาไว้แยก ใช้แสดงว่ายอดของกะนี้รวมค่าภาษาเท่าไหร่
 */
export function partnerRateOf(partner, english) {
  const extra = english ? Number(partner.english_rate ?? 0) : 0;
  return { partner_rate: Number(partner.rate_per_visit ?? 0) + extra, partner_english: extra > 0 ? extra : null };
}

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
  assertServes(partner, caseKindOf(visit));
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
      partner_id: partnerId, partner_status: 'pending', ...partnerRateOf(partner, visit.pkg_english),
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

/** ตรวจบริษัทก่อนลงนัดแบบส่งพาร์ทเนอร์ (cases/routes.js /visits/bulk) — เปิดใช้อยู่ + รับงานประเภทนี้ + มีบัญชีหัวหน้า */
export async function prepareSend(partnerId, kind = null) {
  await ensurePartnerSchema();
  await ensureStaffInbox();
  const partner = await findPartner(partnerId);
  if (!partner) throw new ApiError(404, 'ไม่พบพาร์ทเนอร์');
  if (partner.status !== 'active') throw new ApiError(409, `${partner.name} ปิดใช้งานอยู่`);
  if (kind) assertServes(partner, kind);
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
         c.service_kind, c.case_type, c.physio_package_id,
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
    // รอรับ = ยังรับได้จริง (ถึงวันนี้) · เลยวันแล้วไปอยู่ "ที่ผ่านมา" (ตรวจ 23 พ.ย. 2569 — เดิมค้างในรอรับ/ด่วนตลอดไป)
    pending: `v.partner_status = 'pending' AND v.status <> 'cancelled' AND v.check_in_at IS NULL AND v.visit_date >= :today`,
    accepted: `v.partner_status = 'accepted' AND v.status <> 'cancelled' AND v.check_out_at IS NULL AND v.visit_date >= :yesterday`,
    past: `(v.check_out_at IS NOT NULL OR v.status = 'cancelled' OR v.visit_date < :yesterday
            OR (v.partner_status = 'pending' AND v.check_in_at IS NULL AND v.visit_date < :today))`,
  }[tab];
  if (!where) throw new ApiError(400, 'แท็บไม่ถูกต้อง');
  const order = tab === 'past' ? 'v.visit_date DESC, v.planned_start DESC NULLS LAST' : 'v.visit_date, v.planned_start NULLS FIRST';
  const yesterday = new Date(Date.now() + 7 * 3.6e6 - 864e5).toISOString().slice(0, 10);
  const rows = await sql.all(
    `${PARTNER_VISIT} WHERE v.partner_id = :pid AND ${where} ORDER BY ${order} LIMIT 200`,
    { pid: partnerId, yesterday, today: todayTH() },
  );
  return rows.map(withDeadline);
}

export async function partnerCounts(partnerId) {
  await ensurePartnerSchema();
  const yesterday = new Date(Date.now() + 7 * 3.6e6 - 864e5).toISOString().slice(0, 10);
  return sql.one(
    `SELECT COUNT(*) FILTER (WHERE v.partner_status = 'pending' AND v.status <> 'cancelled' AND v.check_in_at IS NULL
                               AND v.visit_date >= :today)::int AS pending,
            COUNT(*) FILTER (WHERE v.partner_status = 'accepted' AND v.status <> 'cancelled' AND v.check_out_at IS NULL
                               AND v.visit_date >= :yesterday)::int AS accepted,
            -- รอรับและใกล้นัดภายใน 24 ชม. (ไทล์ "ต้องเลือกคนด่วน" บนจอคอม)
            COUNT(*) FILTER (WHERE v.partner_status = 'pending' AND v.status <> 'cancelled' AND v.check_in_at IS NULL
                               AND v.visit_date >= :today AND ${START_AT} < now() + interval '24 hours')::int AS urgent,
            COUNT(*) FILTER (WHERE v.check_in_at IS NOT NULL AND v.check_out_at IS NOT NULL AND v.status <> 'cancelled'
                               AND v.pay_status IS DISTINCT FROM 'rejected' AND v.visit_date LIKE :month)::int AS done_month
     FROM case_visits v WHERE v.partner_id = :pid`,
    { pid: partnerId, yesterday, today: todayTH(), month: `${todayTH().slice(0, 7)}%` },
  );
}

async function partnerVisitOr404(partnerId, visitId) {
  const visit = await visitWithCase(visitId);
  // ของบริษัทอื่น/ไม่ได้ส่งมา = 404 เหมือนไม่มีกะนี้ (ไม่บอกใบ้ว่ามีอยู่จริง)
  if (!visit || visit.partner_id !== partnerId) throw new ApiError(404, 'ไม่พบงานนี้');
  return visit;
}

/**
 * รายละเอียดเคสของกะที่ส่งมา (ผู้ใช้ขอ 21 พ.ย. 2569 — กดการ์ดงานเพื่อดู)
 * ให้: ช่วงเคส · ครั้งที่เท่าไรของเคส · รายละเอียดผู้รับบริการชุดเดียวกับที่พนักงานภาคสนามเห็น
   (เพศ/อายุ/น้ำหนัก/ส่วนสูง · แพ้ยา/แพ้อาหาร · โรคประจำตัว · อาการปัจจุบัน · อุปกรณ์ · จุดประสงค์ — ผู้ใช้ขอเพิ่ม 23 พ.ย. 2569
   หัวหน้าต้องรู้อาการเพื่อเลือกคนที่เหมาะ) · โรคประจำตัว/แพ้ยาอ่านสดจากแฟ้มผู้รับบริการ เหมือน cases/repo.js PATIENT_LIVE
 * ไม่ให้: เบอร์โทรญาติ · ราคา · หมายเหตุภายในของเคส · กะของ KIN หรือของบริษัทอื่น
 */
export async function partnerVisitDetail(partnerId, visitId) {
  await partnerVisitOr404(partnerId, visitId);
  const v = await sql.one(
    `${PARTNER_VISIT.replace('c.service_kind,', `c.service_kind, c.patient_gender, c.patient_age, c.weight_kg, c.height_cm,
         c.medical_devices, c.start_date, c.end_date, c.current_symptoms, c.care_goal,
         COALESCE(pt.medical_history, c.medical_history) AS medical_history,
         pt.allergies AS patient_allergies, pt.food_allergies AS patient_food_allergies, pt.blood_type AS patient_blood_type,`)
      .replace('LEFT JOIN employees e ON', 'LEFT JOIN patients pt ON pt.patient_id = c.patient_id LEFT JOIN employees e ON')}
     WHERE v.visit_id = :id`,
    { id: visitId },
  );
  const order = await sql.one(
    // visit_id ตัดสินเมื่อวัน+เวลาเท่ากัน (กะไม่ระบุเวลาหลายกะในวันเดียว) ไม่งั้นได้ "ครั้งที่" ซ้ำกัน
    `SELECT COUNT(*) FILTER (WHERE (o.visit_date, COALESCE(o.planned_start, ''), o.visit_id)
                                   <= (CAST(:date AS text), COALESCE(CAST(:start AS text), ''), CAST(:id AS int)))::int AS no,
            COUNT(*)::int AS total
     FROM case_visits o WHERE o.case_id = :cid AND o.status <> 'cancelled'`,
    { cid: v.case_id, date: v.visit_date, start: v.planned_start, id: visitId },
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
  // กะที่ยกเลิกไม่อยู่ในลำดับ — ไม่โชว์ "ครั้งที่ x" ที่จริงเป็นของกะอื่น
  const cancelled = v.status === 'cancelled';
  return { ...rest, visit_no: cancelled ? null : order?.no ?? null, visit_total: cancelled ? null : order?.total ?? null, others };
}

/**
 * หัวหน้าพาร์ทเนอร์ลงรายงานของกะ พร้อมเวลาเริ่ม–จบที่ไปจริง (ผู้ใช้ขอ 27 พ.ย. 2569)
 * แทนเช็คอิน/เช็คเอาท์/ลงรายงานของพนักงานพาร์ทเนอร์ — ลงแล้วกะนับว่า "ไปจริง" และนับเงิน
 * start/end = 'HH:MM' ของวันนัด · จบ ≤ เริ่ม = จบวันถัดไป (กะดึก) · เวลาจบต้องไม่อยู่ในอนาคต
 * report = ช่องรายงานชุดเดียวกับพนักงาน KIN (createReportSchema แล้ว) · ผู้บันทึก = หัวหน้า
 */
export async function reportVisit(partnerId, visitId, { start, end, report }, user) {
  await ensurePartnerSchema();
  const visit = await partnerVisitOr404(partnerId, visitId);
  const full = await sql.one(
    'SELECT status, partner_status, assigned_to, check_in_at, visit_date FROM case_visits WHERE visit_id = :id', { id: visitId },
  );
  if (full.status === 'cancelled') throw new ApiError(409, 'กะนี้ถูกยกเลิกแล้ว');
  if (full.check_in_at) throw new ApiError(409, 'กะนี้ลงรายงาน/เวลาไปแล้ว');
  if (full.partner_status !== 'accepted' || !full.assigned_to) throw new ApiError(409, 'ต้องรับงานและเลือกคนที่ไปก่อน จึงลงรายงานได้');
  if (full.visit_date > todayTH()) throw new ApiError(409, 'ยังไม่ถึงวันนัด — ลงรายงานได้ตั้งแต่วันที่นัด');
  if (!['unassigned', 'assigned', 'in_progress'].includes(visit.case_status)) throw new ApiError(409, 'เคสนี้จบไปแล้ว ลงรายงานไม่ได้');

  const checkIn = new Date(`${full.visit_date}T${start}:00+07:00`);
  const checkOut = new Date(`${full.visit_date}T${end}:00+07:00`);
  if (checkOut <= checkIn) checkOut.setUTCDate(checkOut.getUTCDate() + 1);
  if (checkOut.getTime() > Date.now() + 60_000) throw new ApiError(400, 'เวลาจบยังมาไม่ถึง — ลงรายงานหลังจบงานแล้ว');
  if (checkOut.getTime() - checkIn.getTime() > 24 * 3.6e6) throw new ApiError(400, 'ช่วงเวลาทำงานยาวเกิน 24 ชม.');

  const actor = actorOf(user);
  const recorded = await recordPartnerVisit(visitId, { checkIn: checkIn.toISOString(), checkOut: checkOut.toISOString() }, actor);
  if (!recorded) throw new ApiError(409, 'กะนี้ถูกเปลี่ยนไประหว่างนั้น — โหลดหน้าใหม่แล้วลองอีกครั้ง');
  try {
    return await addReport(visit.case_id, { ...report, visit_id: visitId, report_date: full.visit_date }, actor);
  } catch (err) {
    await undoPartnerVisit(visitId, checkIn.toISOString()).catch(() => {});
    throw err;
  }
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
    `SELECT v.assigned_to, v.visit_id, v.visit_date, v.planned_start, v.planned_end
     FROM case_visits v
     WHERE v.visit_date BETWEEN :d0 AND :d2 AND v.status <> 'cancelled' AND v.visit_id <> :id
       AND v.assigned_to = ANY(:ids::text[])`,
    { ...nearDays(visit.visit_date), id: visitId, ids: team.map((t) => t.employee_id) },
  );
  const me = spanOf(visit.visit_date, full.planned_start, full.planned_end);
  return team.map((t) => {
    // โชว์งานของวันนั้น + งานวันข้างเคียงที่ทับเวลาจริง (กะดึกเมื่อคืน / กะเช้าพรุ่งนี้)
    const mine = busy.filter((b) => b.assigned_to === t.employee_id)
      .map((b) => ({ ...b, hit: overlaps(me, spanOf(b.visit_date, b.planned_start, b.planned_end)) }))
      .filter((b) => b.visit_date === visit.visit_date || b.hit);
    return {
      ...t,
      busy: mine.map((b) => ({ start: b.planned_start, end: b.planned_end, date: b.visit_date === visit.visit_date ? null : b.visit_date })),
      conflict: mine.some((b) => b.hit),
    };
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
  const CLASH_SQL = `SELECT visit_date, planned_start, planned_end FROM case_visits
     WHERE assigned_to = :emp AND visit_date BETWEEN :d0 AND :d2 AND status <> 'cancelled' AND visit_id <> :id`;
  const clashParams = { emp: employeeId, ...nearDays(visit.visit_date), id: visitId };
  const me = spanOf(visit.visit_date, mine.planned_start, mine.planned_end);
  const findClash = (rows) => rows.find((o) => overlaps(me, spanOf(o.visit_date, o.planned_start, o.planned_end)));
  const clash = findClash(await sql.all(CLASH_SQL, clashParams));
  if (clash) {
    const when = `${clash.visit_date !== visit.visit_date ? `${clash.visit_date} ` : ''}${clash.planned_start ?? 'ทั้งวัน'}${clash.planned_end ? `–${clash.planned_end}` : ''}`;
    throw new ApiError(409, `${person.first_name} มีงานอื่นชนเวลานี้ (${when}) — เลือกคนอื่น`);
  }
  const kind = visit.partner_status === 'accepted' ? 'reassigned' : 'accepted';
  const actor = actorOf(user);
  await updateVisit(visit.case_id, visitId, { assigned_to: employeeId }, actor, {
    keepPartner: true,
    note: `พาร์ทเนอร์${kind === 'accepted' ? 'รับงาน' : 'เปลี่ยนคน'}`,
    guard: lockedGuard('รับงาน', (v) => v.partner_id === partnerId),
    extra: { partner_status: 'accepted' },
    after: async (tx) => {
      /* ตรวจชนเวลาซ้ำหลังล็อกรายคน (ตรวจ 23 พ.ย. 2569) — ตัวตรวจด้านบนอ่านนอกธุรกรรม สองคำขอพร้อมกันผ่านได้ทั้งคู่
         ล็อกตาม employee_id: คำขอที่สองรอจนคำขอแรก commit แล้วเห็นกะนั้น → ชน → rollback ทั้งก้อน */
      await tx.one('SELECT pg_advisory_xact_lock(hashtext(:k)) AS ok', { k: `partner-assign:${employeeId}` });
      const hit = findClash(await tx.all(CLASH_SQL, clashParams));
      if (hit) throw new ApiError(409, `${person.first_name} เพิ่งได้งานอื่นชนเวลานี้ — เลือกคนอื่น`);
      await logPartnerEvent(tx, { visitId, caseId: visit.case_id, partnerId, kind, employeeId, actor });
    },
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
            v.partner_rate, v.partner_english, v.partner_status, c.client_name,
            COALESCE(v.checked_in_by, v.assigned_to) AS employee_id,
            e.first_name || ' ' || e.last_name AS employee_name
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees e ON e.employee_id = COALESCE(v.checked_in_by, v.assigned_to)
     WHERE v.partner_id = :pid AND v.visit_date LIKE :month AND v.status <> 'cancelled'
       -- KIN ไม่อนุมัติกะนี้ (เช็คอินนอกพื้นที่ ฯลฯ) = ไม่นับจ่าย เหมือนค่าจ้างพนักงาน KIN (ตรวจ 23 พ.ย. 2569)
       AND v.pay_status IS DISTINCT FROM 'rejected'
     ORDER BY v.visit_date DESC, v.planned_start DESC NULLS LAST`,
    { pid: partnerId, month: `${month}%` },
  );
  const today = todayTH();
  const visits = rows.map((r) => {
    const done = Boolean(r.check_in_at && r.check_out_at);
    // ขาดงาน = รับไปแล้วแต่ไม่มีใครไป · กะที่ยังไม่มีใครรับจนเลยวัน ไม่ใช่ความผิดของบริษัท (ตรวจ 23 พ.ย. 2569)
    const missed = !r.check_in_at && r.visit_date < today && r.partner_status === 'accepted';
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
      out.push({ partner_id: p.partner_id, name: p.name, rate_per_visit: p.rate_per_visit, english_rate: p.english_rate, service_kind: p.service_kind, status: p.status,
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
       AND v.status <> 'cancelled' AND v.pay_status IS DISTINCT FROM 'rejected' AND v.visit_date BETWEEN :from AND :to`,
    { from, to },
  );
}
