import { sql } from '../db/index.js';

/**
 * เตือนนัดทาง LINE @kinjobs ให้พนักงานที่ถูกลงกะ (ดร.ธงชัย 26 ต.ค. 2569)
 *   - รอบ "day": วันก่อนนัด 08:00 น.
 *   - รอบ "3h":  3 ชั่วโมงก่อนเวลานัด (เฉพาะกะที่ระบุเวลาเริ่ม)
 *
 * ระบบนี้ไม่ส่ง LINE เอง — chat.kinorigin.com (cron ทุก 15 นาที) ยิงมาที่ /api/integration/visits/reminders
 * แล้วรับรายการไปส่งเอง (ทางเดียวกับใบแจ้งหนี้ invoices/share.js)
 * จองก่อนส่ง (UPDATE ... RETURNING) — cron สองรอบซ้อนกันได้รายการคนละชุด ไม่เตือนซ้ำ
 * ย้ายวัน/เวลา/คนของกะ = ล้างตราเตือน (cases/repo.js updateVisit) จึงเตือนใหม่ตามนัดใหม่
 */
let ready = null;
export const ensureVisitReminderColumns = () =>
  (ready ??= ['remind_day_at TEXT', 'remind_3h_at TEXT']
    .reduce((p, col) => p.then(() => sql.run(`ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS ${col}`)), Promise.resolve())
    .catch((err) => {
      ready = null;
      throw err;
    }));

const NOW_TEXT = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;
// เวลาเริ่มนัดเป็น timestamptz — ไม่ระบุเวลา ถือว่า 08:00 (ใช้กับรอบ day เท่านั้น)
const START_AT = `((v.visit_date || ' ' || COALESCE(v.planned_start, '08:00'))::timestamp AT TIME ZONE 'Asia/Bangkok')`;
const DAY_AT = `(((v.visit_date)::date - 1 + time '08:00') AT TIME ZONE 'Asia/Bangkok')`;

/** กะที่ยังต้องไปจริง — นัดอยู่ เคสยังเดิน คนไปผูก LINE แล้ว ยังไม่ได้เช็คอิน */
const ELIGIBLE = `v.status = 'scheduled' AND v.check_in_at IS NULL
  AND c.status IN ('unassigned', 'assigned', 'in_progress')
  AND e.line_user_id IS NOT NULL AND ${START_AT} > now()`;

async function claim(kind) {
  const col = kind === 'day' ? 'remind_day_at' : 'remind_3h_at';
  const due =
    kind === 'day'
      ? // ถึง 08:00 ของวันก่อนนัดแล้ว และยังห่างนัดเกิน 3 ชม. (ใกล้กว่านั้นรอบ 3h ทำหน้าที่แทน ไม่ส่งสองข้อความติดกัน)
        `now() >= ${DAY_AT} AND now() < ${START_AT} - interval '3 hours'`
      : `v.planned_start IS NOT NULL AND now() >= ${START_AT} - interval '3 hours'`;
  return sql.all(
    `UPDATE case_visits v SET ${col} = ${NOW_TEXT}
     FROM cases c, employees e
     WHERE c.case_id = v.case_id AND e.employee_id = v.assigned_to
       AND v.${col} IS NULL AND ${ELIGIBLE} AND ${due}
       AND v.visit_id IN (
         SELECT v2.visit_id FROM case_visits v2
         WHERE v2.status = 'scheduled' AND v2.visit_date BETWEEN to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
                                                           AND to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '2 days', 'YYYY-MM-DD'))
     RETURNING v.visit_id`,
  );
}

/**
 * จองรายการที่ถึงเวลาเตือน แล้วคืนรายละเอียดสำหรับเขียนข้อความ
 * ครั้งที่ = ลำดับของกะนี้ในบรรดากะที่ไม่ยกเลิกของเคส (นับตามวัน-เวลา) · total = จำนวนครั้งในแพ็กกายภาพ (เคส Homecare = null)
 */
export async function claimDueVisitReminders() {
  await ensureVisitReminderColumns();
  const out = [];
  for (const kind of ['day', '3h']) {
    const ids = (await claim(kind)).map((r) => r.visit_id);
    if (!ids.length) continue;
    const slots = ids.map((_, i) => `:v${i}`).join(', ');
    const params = Object.fromEntries(ids.map((id, i) => [`v${i}`, id]));
    const rows = await sql.all(
      `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end,
              c.client_name, c.address, c.geo_lat, c.geo_lng, c.service_kind,
              pp.sessions AS package_sessions,
              (SELECT COUNT(*) FROM case_visits o
                WHERE o.case_id = v.case_id AND o.status <> 'cancelled'
                  AND (o.visit_date, COALESCE(o.planned_start, ''), o.visit_id)
                      <= (v.visit_date, COALESCE(v.planned_start, ''), v.visit_id))::int AS session_no,
              e.line_user_id, e.employee_id, COALESCE(NULLIF(e.nickname, ''), e.first_name) AS employee_name
       FROM case_visits v
       JOIN cases c ON c.case_id = v.case_id
       JOIN employees e ON e.employee_id = v.assigned_to
       LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
       WHERE v.visit_id IN (${slots})`,
      params,
    );
    for (const r of rows) out.push({ kind, ...r });
  }
  return out;
}
