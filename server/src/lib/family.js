import { createHash, randomInt } from 'node:crypto';
import { sql } from '../db/index.js';

/**
 * ญาติดูการดูแลผ่าน LINE OA KIN HomeCare หลัก (ดร.ธงชัย 22 ต.ค. 2569 · แบบร่าง coordination/family-line-page-design-20261022.md)
 *
 * ต้องเชิญเท่านั้น: แอดมินกด "เชิญญาติ" ในหน้าเคส (ยืนยันว่าได้รับความยินยอมจากผู้ป่วย/ผู้แทนแล้ว)
 * → ได้รหัส 6 ตัว อายุ 7 วัน ใช้ได้ครั้งเดียว → ญาติส่ง "ญาติ <รหัส>" ในแชท OA → ผูก LINE ของญาติกับเคสนั้นเคสเดียว
 * ระบบไม่จับคู่ญาติเองจากชื่อ/เบอร์ · แอดมินปลดได้ทุกเมื่อ · เคสปิดเกิน 30 วันแล้วญาติดูไม่ได้
 * ข้อมูลที่ญาติเห็นเป็น "สรุป" (ดร. เคาะ): เวลาเข้า–ออกจริง · ผู้ดูแล · สรุปรายงานสั้น + สัญญาณชีพหลัก · นัดถัดไป
 * ไม่ส่ง: GPS · เซลฟี่ · ค่าจ้าง/ราคา · บันทึกภายใน · เบอร์เจ้าหน้าที่
 */
export const FAMILY_MAX_PER_CASE = 5;
const CODE_DAYS = 7;
export const CLOSED_GRACE_DAYS = 30;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // ตัด 0/O/1/I/L ที่อ่านสับสน

export const hashCode = (code) => createHash('sha256').update(`kin-family:${String(code).toUpperCase()}`).digest('hex');
export const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

let ready = null;
export const ensureFamilyTable = () =>
  (ready ??= sql
    .run(
      `CREATE TABLE IF NOT EXISTS case_family_links (
         link_id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         case_id          TEXT NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE ON UPDATE CASCADE,
         code_hash        TEXT,
         code_expires_at  TIMESTAMPTZ,
         line_user_id     TEXT,
         display_name     TEXT,
         invited_by       TEXT NOT NULL,
         consent_by       TEXT NOT NULL,
         created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
         accepted_at      TIMESTAMPTZ,
         revoked_at       TIMESTAMPTZ
       )`,
    )
    // แบบ ข (ดร. 22 ต.ค.): ญาติคนแรกที่แอดมินเชิญ (can_invite) ชวนคนอื่นต่อได้ · คนที่ถูกชวนต่อชวนต่อไม่ได้
    .then(() => sql.run('ALTER TABLE case_family_links ADD COLUMN IF NOT EXISTS can_invite BOOLEAN NOT NULL DEFAULT false'))
    .then(() => sql.run('ALTER TABLE case_family_links ADD COLUMN IF NOT EXISTS invited_via INTEGER'))
    // ไทม์ไลน์เคส (แบบ 3): ข้อความ/รูปจากญาติและทีม — ทุกคนในเคสเห็นเหมือนกัน · ลบ = ซ่อน (deleted_at)
    .then(() =>
      sql.run(
        `CREATE TABLE IF NOT EXISTS case_family_messages (
           message_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           case_id       TEXT NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE ON UPDATE CASCADE,
           author_kind   TEXT NOT NULL CHECK (author_kind IN ('family', 'team', 'staff')),
           author_name   TEXT NOT NULL,
           line_user_id  TEXT,
           employee_id   TEXT,
           body          TEXT,
           photo_data    BYTEA,
           photo_mime    TEXT,
           created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
           deleted_at    TIMESTAMPTZ
         )`,
      ),
    )
    // ตารางถูกสร้างไปแล้วก่อนมี 'staff' (ผู้ดูแล/นักกายภาพตอบแชทญาติ · ดร. 24 ต.ค.) — CREATE TABLE IF NOT EXISTS
    // จึงไม่ช่วย ต้องปลด constraint เดิมแล้วใส่ใหม่ ไม่งั้นผู้ดูแลกดส่งแล้ว 500 ทุกครั้ง (เจอ 25 ต.ค.)
    .then(() => sql.run('ALTER TABLE case_family_messages DROP CONSTRAINT IF EXISTS case_family_messages_author_kind_check'))
    .then(() => sql.run(
      "ALTER TABLE case_family_messages ADD CONSTRAINT case_family_messages_author_kind_check CHECK (author_kind IN ('family','team','staff'))"))
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_family_msg_case ON case_family_messages (case_id, created_at DESC)'))
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_family_case ON case_family_links (case_id)'))
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_family_line ON case_family_links (line_user_id) WHERE line_user_id IS NOT NULL'))
    .catch((err) => {
      ready = null;
      throw err;
    }));

/** ญาติของเคส (ทั้งที่รอรับคำเชิญและที่เชื่อมแล้ว) — ไม่ส่งรหัส/LINE userId ออกไป */
export const listForCase = (caseId) =>
  sql.all(
    `SELECT link_id, display_name, invited_by, consent_by, created_at, accepted_at, code_expires_at, can_invite,
            CASE WHEN accepted_at IS NOT NULL THEN 'linked'
                 WHEN code_expires_at < now() THEN 'expired' ELSE 'pending' END AS state
     FROM case_family_links WHERE case_id = :id AND revoked_at IS NULL
     ORDER BY created_at`,
    { id: caseId },
  );

export const activeCount = async (caseId) =>
  (
    await sql.one(
      `SELECT count(*)::int AS n FROM case_family_links
       WHERE case_id = :id AND revoked_at IS NULL AND (accepted_at IS NOT NULL OR code_expires_at > now())`,
      { id: caseId },
    )
  ).n;

/** ออกรหัสเชิญ · canInvite = ญาติคนแรก (แอดมินเชิญ) ชวนต่อได้ · via = link_id ของญาติที่ชวน */
export async function createInvite(caseId, actorName, { canInvite = true, via = null, consentBy = actorName } = {}) {
  const code = newCode();
  await sql.run(
    `INSERT INTO case_family_links (case_id, code_hash, code_expires_at, invited_by, consent_by, can_invite, invited_via)
     VALUES (:case_id, :hash, now() + make_interval(days => :days), :actor, :consent, :can_invite, :via)`,
    { case_id: caseId, hash: hashCode(code), days: CODE_DAYS, actor: actorName, consent: consentBy, can_invite: canInvite, via },
  );
  return { code, days: CODE_DAYS };
}

/** ลิงก์ของ LINE นี้ในเคสนี้ (เชื่อมแล้ว ยังไม่ถูกปลด) — ใช้ตรวจสิทธิ์ทุกเส้นฝั่งญาติ */
export const memberLink = (lineUserId, caseId) =>
  sql.one(
    `SELECT link_id, display_name, can_invite, consent_by FROM case_family_links
     WHERE line_user_id = :uid AND case_id = :case_id AND revoked_at IS NULL AND accepted_at IS NOT NULL`,
    { uid: lineUserId, case_id: caseId },
  );

/** ญาติคนแรกชวนญาติอีกคน (แบบ ข) — รวมทั้งเคสไม่เกิน 5 · ความยินยอมอ้างอิงจากที่แอดมินยืนยันไว้กับญาติคนแรก */
export async function familyInvite(lineUserId, caseId) {
  const me = await memberLink(lineUserId, caseId);
  if (!me) return { ok: false, reason: 'not_member' };
  if (!me.can_invite) return { ok: false, reason: 'cannot_invite' };
  if ((await activeCount(caseId)) >= FAMILY_MAX_PER_CASE) return { ok: false, reason: 'full' };
  const inv = await createInvite(caseId, `${me.display_name || 'ญาติ'} (ญาติชวน)`, {
    canInvite: false,
    via: me.link_id,
    consentBy: me.consent_by,
  });
  return { ok: true, ...inv };
}

export const revoke = (caseId, linkId) =>
  sql.run('UPDATE case_family_links SET revoked_at = now() WHERE case_id = :case_id AND link_id = :id AND revoked_at IS NULL', {
    case_id: caseId,
    id: linkId,
  });

/** รับคำเชิญ — รหัสใช้ได้ครั้งเดียว · LINE เดียวกันกับเคสเดิมซ้ำ = ถือว่าสำเร็จ (กดส่งซ้ำ) */
export async function accept(code, lineUserId, displayName) {
  const link = await sql.one(
    `SELECT l.link_id, l.case_id, l.accepted_at, l.line_user_id, l.invited_by, (l.invited_via IS NOT NULL) AS via_family,
            (l.code_expires_at < now()) AS expired, c.client_name,
            /* เคสปิด/ยกเลิกไปแล้วและพ้นช่วงผ่อนผัน = รับคำเชิญไม่ได้ เดิมไม่เช็คสถานะเคสเลย
               ญาติจึงกดรับคำเชิญของเคสที่ปิดไปนานแล้วได้ (รหัสอายุ 7 วัน แต่เคสอาจปิดไปก่อน) */
            (c.status IN ('closed', 'cancelled') AND NOT (${WITHIN_GRACE})) AS case_over
     FROM case_family_links l JOIN cases c ON c.case_id = l.case_id
     WHERE l.code_hash = :hash AND l.revoked_at IS NULL`,
    { hash: hashCode(code), grace: CLOSED_GRACE_DAYS },
  );
  if (!link) return { ok: false, reason: 'not_found' };
  if (link.accepted_at) {
    return link.line_user_id === lineUserId ? { ok: true, case_id: link.case_id, client_name: link.client_name } : { ok: false, reason: 'used' };
  }
  if (link.expired) return { ok: false, reason: 'expired' };
  if (link.case_over) return { ok: false, reason: 'case_closed' };
  await sql.run(
    `UPDATE case_family_links SET line_user_id = :uid, display_name = :name, accepted_at = now(), code_hash = NULL
     WHERE link_id = :id`,
    { uid: lineUserId, name: displayName ? String(displayName).slice(0, 80) : null, id: link.link_id },
  );
  return { ok: true, case_id: link.case_id, client_name: link.client_name, invited_by: link.invited_by, via_family: link.via_family, first: true };
}

/**
 * เคสที่ปิด/ยกเลิกแล้วยังอยู่ในช่วงผ่อนผัน 30 วันไหม (ต้องมี :grace เป็นพารามิเตอร์ของคำสั่งนั้น)
 *
 * ต้องดู cancelled_at ด้วย ไม่ใช่ closed_at อย่างเดียว — ตอนยกเลิกเคส cases/repo.js เซ็ต cancelled_at
 * ไม่ได้เซ็ต closed_at เดิมจึงตกไปที่ now() ซึ่งแปลว่า "ยังไม่หมดอายุ" ตลอดกาล เคสที่ยกเลิกไปแล้ว
 * ญาติดูข้อมูลผู้ป่วยได้ไม่สิ้นสุด · ไม่มีวันปิดบันทึกไว้เลย = ถือว่าหมดอายุ ('epoch') ปลอดภัยกว่าเปิดค้าง
 */
export const WITHIN_GRACE = `coalesce(nullif(c.closed_at, ''), nullif(c.cancelled_at, ''), 'epoch')::timestamp
            > now() - make_interval(days => :grace)`;

/**
 * "เคสนี้ยังส่งข้อมูลถึงญาติได้ไหม" — ชิ้นส่วน SQL ที่ทุกเส้นของญาติต้องใช้ตัวเดียวกัน
 * ต้องมี alias `c` = cases และพารามิเตอร์ `:grace` (= CLOSED_GRACE_DAYS) ในคำสั่งนั้นด้วย
 *
 * เดิมบังคับเฉพาะ "ทางดึง" (ญาติเปิดหน้า /family) ส่วน "ทางส่ง" เข้า LINE สามเส้นใน integration/routes.js
 * ไม่เช็คเลย (ตรวจรอบ 7) — เคสที่ปิดเกิน 30 วันแล้วทีมลงรายงานย้อนหลัง cron จึงยังดึงไปส่งถึงญาติ
 * ที่สิทธิ์หมดไปแล้วได้ ทั้งที่เจ้าตัวเปิดหน้าดูเองไม่ได้แล้ว (PDPA)
 */
export const FAMILY_CASE_OPEN = `(c.status NOT IN ('closed', 'cancelled') OR ${WITHIN_GRACE})`;

const short = (s, n = 180) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** สรุปการดูแลของทุกเคสที่ LINE นี้ถูกเชิญ (หน้า /family ฝั่ง chat) */
export async function summaryFor(lineUserId) {
  const cases = await sql.all(
    `SELECT c.case_id, c.client_name, c.status, c.service_kind, c.start_date, c.end_date
     FROM case_family_links l JOIN cases c ON c.case_id = l.case_id
     WHERE l.line_user_id = :uid AND l.revoked_at IS NULL AND l.accepted_at IS NOT NULL
       AND ${FAMILY_CASE_OPEN}
     ORDER BY c.case_id`,
    { uid: lineUserId, grace: CLOSED_GRACE_DAYS },
  );
  const out = [];
  for (const c of cases) {
    const [visits, next, reports] = await Promise.all([
      sql.all(
        `SELECT v.visit_date, v.planned_start, v.planned_end, v.status,
                to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_in,
                to_char(v.check_out_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_out,
                e.first_name AS staff_first, e.nickname AS staff_nick, e.position AS staff_position
         FROM case_visits v LEFT JOIN employees e ON e.employee_id = v.assigned_to
         WHERE v.case_id = :id AND v.status <> 'cancelled'
           AND v.visit_date <= to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
         ORDER BY v.visit_date DESC, v.planned_start DESC NULLS LAST LIMIT 14`,
        { id: c.case_id },
      ),
      sql.one(
        `SELECT v.visit_date, v.planned_start, e.first_name AS staff_first, e.nickname AS staff_nick
         FROM case_visits v LEFT JOIN employees e ON e.employee_id = v.assigned_to
         WHERE v.case_id = :id AND v.status <> 'cancelled' AND v.check_in_at IS NULL
           AND v.visit_date > to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
         ORDER BY v.visit_date, v.planned_start NULLS LAST LIMIT 1`,
        { id: c.case_id },
      ),
      sql.all(
        `SELECT r.report_date, r.report_time, r.condition_change, r.bp_systolic, r.bp_diastolic, r.pulse, r.spo2,
                r.temperature_c, r.pain_score, r.symptoms, r.care_given, r.note, r.follow_up,
                e.first_name AS staff_first, e.nickname AS staff_nick
         FROM case_reports r LEFT JOIN employees e ON e.employee_id = r.reported_by
         WHERE r.case_id = :id
         ORDER BY r.report_date DESC, r.report_id DESC LIMIT 10`,
        { id: c.case_id },
      ),
    ]);
    const staffName = (r) => (r.staff_nick ? `${r.staff_first} (${r.staff_nick})` : r.staff_first) || null;
    const [me, family, messages] = await Promise.all([
      memberLink(lineUserId, c.case_id),
      sql.all(
        `SELECT display_name FROM case_family_links
         WHERE case_id = :id AND revoked_at IS NULL AND accepted_at IS NOT NULL ORDER BY accepted_at`,
        { id: c.case_id },
      ),
      messagesFor(c.case_id),
    ]);
    out.push({
      can_invite: !!me?.can_invite,
      family: family.map((f) => f.display_name || 'ญาติ'),
      family_max: FAMILY_MAX_PER_CASE,
      messages,
      case_id: c.case_id,
      client_name: c.client_name,
      status: c.status,
      service_kind: c.service_kind,
      visits: visits.map((v) => ({
        date: v.visit_date, planned: v.planned_start, check_in: v.check_in, check_out: v.check_out, staff: staffName(v),
      })),
      next_visit: next ? { date: next.visit_date, planned: next.planned_start, staff: staffName(next) } : null,
      reports: reports.map((r) => ({
        date: r.report_date,
        time: r.report_time,
        staff: staffName(r),
        condition: r.condition_change,
        vitals: {
          bp: r.bp_systolic && r.bp_diastolic ? `${r.bp_systolic}/${r.bp_diastolic}` : null,
          pulse: r.pulse, spo2: r.spo2, temp: r.temperature_c, pain: r.pain_score,
        },
        summary: short([r.symptoms, r.care_given, r.note].filter(Boolean).join(' · ')),
        follow_up: short(r.follow_up, 120) || null,
      })),
    });
  }
  return out;
}

/** โพสต์ลงไทม์ไลน์เคส — kind 'family' (ญาติจากหน้า LINE) หรือ 'team' (ทีมจากหน้าเคสใน staff) */
export async function postMessage(caseId, { kind, name, lineUserId = null, employeeId = null, body = null, photo = null }) {
  return sql.one(
    `INSERT INTO case_family_messages (case_id, author_kind, author_name, line_user_id, employee_id, body, photo_data, photo_mime)
     VALUES (:case_id, :kind, :name, :uid, :emp, :body, :data, :mime)
     RETURNING message_id, created_at`,
    {
      case_id: caseId, kind, name: String(name || 'ญาติ').slice(0, 80), uid: lineUserId, emp: employeeId,
      body: body ? String(body).trim().slice(0, 1000) : null, data: photo?.data ?? null, mime: photo?.mime ?? null,
    },
  );
}

export const messagesFor = (caseId, limit = 60) =>
  sql.all(
    `SELECT message_id, author_kind, author_name, body, (photo_data IS NOT NULL) AS has_photo, created_at
     FROM case_family_messages WHERE case_id = :id AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT :limit`,
    { id: caseId, limit },
  );

export const messagePhoto = (caseId, messageId) =>
  sql.one(
    `SELECT photo_data AS data, photo_mime AS mime FROM case_family_messages
     WHERE case_id = :case_id AND message_id = :id AND deleted_at IS NULL AND photo_data IS NOT NULL`,
    { case_id: caseId, id: messageId },
  );

export const hideMessage = (caseId, messageId) =>
  sql.run('UPDATE case_family_messages SET deleted_at = now() WHERE case_id = :case_id AND message_id = :id AND deleted_at IS NULL', {
    case_id: caseId,
    id: messageId,
  });

/**
 * "ให้ LINE นี้ดูการดูแล" — ผูก LINE ของลูกค้าเจ้าของเคส (คนที่ทักมาทาง OA Kin HomeCare) เป็นญาติคนแรกทันที
 * ไม่ต้องส่งรหัส เพราะรู้ LINE อยู่แล้วจากแชท (lib/customerLine.js) · แอดมินต้องติ๊กยินยอมเหมือนการเชิญปกติ
 * คืน { ok } · { ok:false, reason: 'no_line' | 'already' | 'full' }
 */
export async function linkCustomerLine(caseId, actorName) {
  const row = await sql.one(
    `SELECT cu.line_user_id, cu.line_display_name FROM cases c JOIN customers cu ON cu.customer_id = c.customer_id
     WHERE c.case_id = :id`,
    { id: caseId },
  );
  if (!row?.line_user_id) return { ok: false, reason: 'no_line' };
  const exists = await sql.one(
    `SELECT 1 AS x FROM case_family_links WHERE case_id = :id AND line_user_id = :uid AND revoked_at IS NULL`,
    { id: caseId, uid: row.line_user_id },
  );
  if (exists) return { ok: false, reason: 'already' };
  if ((await activeCount(caseId)) >= FAMILY_MAX_PER_CASE) return { ok: false, reason: 'full' };
  await sql.run(
    `INSERT INTO case_family_links (case_id, line_user_id, display_name, invited_by, consent_by, accepted_at, can_invite)
     VALUES (:id, :uid, :name, :actor, :actor, now(), true)`,
    { id: caseId, uid: row.line_user_id, name: row.line_display_name || 'ลูกค้า (LINE)', actor: actorName },
  );
  return { ok: true };
}
