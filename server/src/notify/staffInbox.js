import { sql } from '../db/index.js';

/**
 * กระดิ่งแจ้งเตือนในแอปของพนักงานภาคสนาม (ผู้ใช้ขอ 9 พ.ย. 2569) — คู่ขนานกับ LINE @kinjobs ไม่ได้แทน
 *   visits_added    กะใหม่ที่เพิ่งถูกลงให้ (หรือถูกย้ายกะของคนอื่นมาให้)
 *   visit_moved     กะถูกเลื่อนวัน/เวลา
 *   visit_cancelled กะถูกยกเลิก/ลบ
 *   visit_removed   กะถูกย้ายไปให้คนอื่น
 *   remind_day      เตือนวันก่อนนัด (ตั้งแต่ 08:00) · remind_3h เตือน 3 ชม. ก่อนเวลาเริ่ม
 *
 * เก็บเป็นข้อมูล (payload) ไม่ใช่ข้อความสำเร็จรูป — หน้าเว็บเป็นคนเขียนข้อความเอง จะแก้ถ้อยคำได้โดยไม่ต้องย้อนแก้แถวเก่า
 * ไม่มีเงิน/ข้อมูลสุขภาพในนี้ — ชื่อผู้รับบริการ วันและเวลานัดเท่านั้น (เท่าที่พนักงานเห็นในตารางของตัวเองอยู่แล้ว)
 *
 * การเตือนก่อนนัดไม่ต้องมี cron: สร้างตอนพนักงานเปิดแอป/ดึงรายการ (materializeReminders)
 * แจ้งเตือนในแอปมีความหมายเฉพาะตอนเปิดแอปอยู่แล้ว — dedupe_key กันสร้างซ้ำ
 */
let ready = null;
export const ensureStaffInbox = () =>
  (ready ??= (async () => {
    await sql.run(`CREATE TABLE IF NOT EXISTS staff_notifications (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      employee_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      case_id TEXT,
      visit_id INTEGER,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    )`);
    await sql.run(`CREATE INDEX IF NOT EXISTS idx_staff_notifications_inbox
      ON staff_notifications (employee_id, created_at DESC)`);
  })().catch((err) => { ready = null; throw err; }));

/** db = sql หรือ tx — ต้องเรียก ensureStaffInbox() ก่อนเปิด transaction (DDL ใน tx ที่ล็อกแถวอยู่เสี่ยงค้าง) */
async function push(db, { employeeId, kind, caseId = null, visitId = null, payload, key = null }) {
  if (!employeeId) return;
  await db.run(
    `INSERT INTO staff_notifications (employee_id, kind, case_id, visit_id, payload, dedupe_key)
     VALUES (:employeeId, :kind, :caseId, :visitId, :payload::jsonb, :key)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    { employeeId, kind, caseId, visitId, payload: JSON.stringify(payload), key },
  );
}

const clientOf = async (db, caseId) =>
  (await db.one('SELECT client_name FROM cases WHERE case_id = :id', { id: caseId }))?.client_name ?? null;

/** กะใหม่ของแต่ละคน (จาก caseEvents.onVisitsAdded — กรองกะย้อนหลัง/กะที่ยังไม่มีคนรับออกแล้ว) — คนละหนึ่งแจ้งเตือน */
export async function inboxVisitsAdded(caseId, employeeId, visits) {
  if (!visits.length) return;
  await ensureStaffInbox();
  const sorted = [...visits].sort((a, b) =>
    `${a.visit_date} ${a.planned_start ?? ''}`.localeCompare(`${b.visit_date} ${b.planned_start ?? ''}`));
  const first = sorted[0];
  const ids = visits.map((v) => v.visit_id);
  await push(sql, {
    employeeId, kind: 'visits_added', caseId, visitId: first.visit_id,
    key: `added:${caseId}:${employeeId}:${Math.min(...ids)}-${Math.max(...ids)}`,
    payload: {
      client: await clientOf(sql, caseId),
      total: visits.length,
      date: first.visit_date, start: first.planned_start ?? null,
      last_date: sorted[sorted.length - 1].visit_date,
    },
  });
}

/**
 * เรียกจาก recordVisitChange (ใน transaction เดียวกับการแก้กะ) — row = แถวที่จดลง visit_change_outbox
 * กติกาเดียวกับ LINE: นัดที่อยู่ในอดีตทั้งเก่าและใหม่ไม่ถึงตรงนี้ (recordVisitChange ข้ามไปแล้ว)
 */
export async function inboxVisitChange(tx, row) {
  const client = await clientOf(tx, row.case_id);
  const base = { caseId: row.case_id, visitId: row.visit_id };
  const old = { client, date: row.old_date, start: row.old_start };
  const fresh = { client, date: row.new_date, start: row.new_start };
  const sameStaff = row.old_assignee === row.new_assignee;

  if (row.kind === 'cancelled') {
    await push(tx, { ...base, employeeId: row.old_assignee, kind: 'visit_cancelled', payload: old });
    return;
  }
  if (sameStaff) {
    // เลื่อนวัน/เวลา คนเดิม
    await push(tx, {
      ...base, employeeId: row.new_assignee, kind: 'visit_moved',
      payload: { client, old_date: row.old_date, old_start: row.old_start, date: row.new_date, start: row.new_start },
    });
    return;
  }
  // เปลี่ยนคน (จะเลื่อนวันด้วยหรือไม่ก็ตาม): คนเก่าเสียกะนี้ไป · คนใหม่ได้กะใหม่
  await push(tx, { ...base, employeeId: row.old_assignee, kind: 'visit_removed', payload: old });
  await push(tx, { ...base, employeeId: row.new_assignee, kind: 'visits_added', payload: { ...fresh, total: 1, last_date: row.new_date } });
}

/* เงื่อนไขเดียวกับการเตือนทาง LINE (visitReminders.js) — กะที่ยังต้องไปจริง ยังไม่เช็คอิน เคสยังเดิน */
const START_AT = `((v.visit_date || ' ' || COALESCE(v.planned_start, '08:00'))::timestamp AT TIME ZONE 'Asia/Bangkok')`;
const DAY_AT = `(((v.visit_date)::date - 1 + time '08:00') AT TIME ZONE 'Asia/Bangkok')`;
const DUE_BASE = `v.assigned_to = :me AND v.status = 'scheduled' AND v.check_in_at IS NULL
  AND c.status IN ('unassigned', 'assigned', 'in_progress') AND ${START_AT} > now()
  AND v.visit_date BETWEEN to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
                       AND to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '2 days', 'YYYY-MM-DD')`;

/** สร้างแจ้งเตือนก่อนนัดที่ถึงเวลาแล้วของพนักงานคนนี้ · กุญแจผูกวัน+เวลานัด → เลื่อนนัดแล้วได้เตือนใหม่ตามนัดใหม่ */
async function materializeReminders(me) {
  const payload = `jsonb_build_object('client', c.client_name, 'date', v.visit_date, 'start', v.planned_start, 'end', v.planned_end)`;
  // วันก่อนนัด — ยังห่างนัดเกิน 3 ชม. (ใกล้กว่านั้นรอบ 3 ชม. แจ้งแทน ไม่ซ้อนสองอัน)
  await sql.run(
    `INSERT INTO staff_notifications (employee_id, kind, case_id, visit_id, payload, dedupe_key)
     SELECT v.assigned_to, 'remind_day', v.case_id, v.visit_id, ${payload},
            'remind-day:' || v.visit_id || ':' || v.visit_date
     FROM case_visits v JOIN cases c ON c.case_id = v.case_id
     WHERE ${DUE_BASE} AND now() >= ${DAY_AT} AND now() < ${START_AT} - interval '3 hours'
     ON CONFLICT (dedupe_key) DO NOTHING`,
    { me },
  );
  await sql.run(
    `INSERT INTO staff_notifications (employee_id, kind, case_id, visit_id, payload, dedupe_key)
     SELECT v.assigned_to, 'remind_3h', v.case_id, v.visit_id, ${payload},
            'remind-3h:' || v.visit_id || ':' || v.visit_date || ':' || v.planned_start
     FROM case_visits v JOIN cases c ON c.case_id = v.case_id
     WHERE ${DUE_BASE} AND v.planned_start IS NOT NULL AND now() >= ${START_AT} - interval '3 hours'
     ON CONFLICT (dedupe_key) DO NOTHING`,
    { me },
  );
}

/** รายการล่าสุด 30 วัน (สูงสุด 40) + จำนวนที่ยังไม่อ่าน · ของเก่ากว่า 60 วันลบทิ้งไปด้วย */
export async function listInbox(me) {
  await ensureStaffInbox();
  await materializeReminders(me);
  await sql.run(`DELETE FROM staff_notifications WHERE employee_id = :me AND created_at < now() - interval '60 days'`, { me });
  const items = await sql.all(
    `SELECT id, kind, case_id, visit_id, payload, created_at, read_at
     FROM staff_notifications
     WHERE employee_id = :me AND created_at > now() - interval '30 days'
     ORDER BY created_at DESC, id DESC LIMIT 40`,
    { me },
  );
  const { unread } = await sql.one(
    `SELECT count(*)::int AS unread FROM staff_notifications
     WHERE employee_id = :me AND read_at IS NULL AND created_at > now() - interval '30 days'`,
    { me },
  );
  return { items, unread };
}

/** ids ว่าง/ไม่ส่ง = อ่านทั้งหมด · แตะได้เฉพาะแถวของตัวเอง */
export async function markRead(me, ids = null) {
  await ensureStaffInbox();
  const list = Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : null;
  if (list && !list.length) return 0;
  return sql.run(
    `UPDATE staff_notifications SET read_at = now()
     WHERE employee_id = :me AND read_at IS NULL ${list ? 'AND id = ANY(:ids::bigint[])' : ''}`,
    { me, ids: list ? `{${list.join(',')}}` : null },
  );
}
