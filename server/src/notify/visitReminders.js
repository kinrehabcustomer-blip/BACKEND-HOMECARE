import { sql } from '../db/index.js';
import { ensureFamilyTable } from '../lib/family.js';
import { ensureCustomerLineColumns } from '../lib/customerLine.js';

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
  (ready ??= ['remind_day_at TEXT', 'remind_3h_at TEXT', 'remind_family_at TEXT']
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

/**
 * เตือนญาติ/ลูกค้าฝั่ง LINE Kin HomeCare วันก่อนนัด 08:00 ว่านักกายภาพจะไปถึงกี่โมง (ดร.ธงชัย 26 ต.ค. 2569)
 * เฉพาะเคสกายภาพ (เคส Homecare มีกะทุกวัน เตือนญาติทุกวัน = รบกวน) และนัดที่ระบุเวลาเริ่มแล้วเท่านั้น
 * ผู้รับ = ญาติที่ผูกเคสแล้ว (case_family_links ยอมรับแล้ว ยังไม่ถูกถอด) + ลูกค้าเจ้าของเคสที่ทักผ่าน LINE (customers.line_user_id)
 * ไม่มีผู้รับเลย = ไม่จอง — ถ้าญาติมาผูกทีหลังก่อนถึงนัด ยังได้รับการเตือน
 */
const PHYSIO = `(c.physio_package_id IS NOT NULL OR c.service_kind = 'physio' OR c.case_type = 'physiotherapy')`;
const FAMILY_IDS = `(SELECT array_agg(DISTINCT u) FROM (
    SELECT l.line_user_id AS u FROM case_family_links l
     WHERE l.case_id = c.case_id AND l.revoked_at IS NULL AND l.accepted_at IS NOT NULL AND l.line_user_id IS NOT NULL
    UNION
    SELECT cu.line_user_id FROM customers cu WHERE cu.customer_id = c.customer_id AND cu.line_user_id IS NOT NULL
  ) x)`;

export async function claimDueFamilyReminders() {
  await ensureVisitReminderColumns();
  await ensureFamilyTable();
  await ensureCustomerLineColumns();
  const ids = (
    await sql.all(
      `UPDATE case_visits v SET remind_family_at = ${NOW_TEXT}
       FROM cases c
       WHERE c.case_id = v.case_id AND v.remind_family_at IS NULL
         AND v.status = 'scheduled' AND v.check_in_at IS NULL AND v.planned_start IS NOT NULL
         AND c.status IN ('unassigned', 'assigned', 'in_progress') AND ${PHYSIO}
         AND now() >= ${DAY_AT} AND ${START_AT} > now()
         AND ${FAMILY_IDS} IS NOT NULL
         AND v.visit_date BETWEEN to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
                              AND to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '2 days', 'YYYY-MM-DD')
       RETURNING v.visit_id`,
    )
  ).map((r) => r.visit_id);
  if (!ids.length) return [];
  const slots = ids.map((_, i) => `:v${i}`).join(', ');
  const params = Object.fromEntries(ids.map((id, i) => [`v${i}`, id]));
  return sql.all(
    `SELECT 'family' AS kind, v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end,
            c.client_name, pp.sessions AS package_sessions,
            (SELECT COUNT(*) FROM case_visits o
              WHERE o.case_id = v.case_id AND o.status <> 'cancelled'
                AND (o.visit_date, COALESCE(o.planned_start, ''), o.visit_id)
                    <= (v.visit_date, COALESCE(v.planned_start, ''), v.visit_id))::int AS session_no,
            COALESCE(NULLIF(e.nickname, ''), e.first_name) AS employee_name, e.position AS employee_position,
            ${FAMILY_IDS} AS recipients
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees e ON e.employee_id = v.assigned_to
     LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
     WHERE v.visit_id IN (${slots})`,
    params,
  );
}

/**
 * แจ้งทันทีเมื่อเลื่อน/ยกเลิกนัด (ดร.ธงชัย 26 ต.ค. 2569 "หลังจากเลื่อนการนัดหมาย ส่งทางไลน์ให้กับลูกค้าและพนักงานทั้งคู่")
 * cases/repo.js updateVisit จดลง visit_change_outbox ในธุรกรรมเดียวกับการแก้ → cron ของ chat.kinorigin.com มารับไปส่ง
 *   moved     = เปลี่ยนวัน/เวลา (รวมเปลี่ยนคนพร้อมกัน) · cancelled = เปลี่ยนสถานะเป็นยกเลิก
 *   reassigned = เปลี่ยนแค่คนไป — แจ้งเฉพาะพนักงานคนเก่า (ถอดงาน) และคนใหม่ (ได้งาน) ไม่แจ้งญาติ
 * ผู้รับ: พนักงานคนเก่า+คนใหม่ที่ผูก LINE (@kinjobs) · ญาติที่ผูกเคส + ลูกค้าที่ทัก LINE (Kin HomeCare)
 * แก้นัดเดียวกันหลายรอบก่อน cron มารับ = ส่งเฉพาะสถานะล่าสุด (เทียบจาก "ค่าเดิม" ของรอบแรก)
 * นัดที่ผ่านไปแล้ว (ทั้งวันเดิมและวันใหม่อยู่ในอดีต) ไม่แจ้ง — เป็นการแก้บันทึกย้อนหลัง ไม่ใช่การเลื่อนนัดจริง
 */
let changeReady = null;
export const ensureVisitChangeTable = () =>
  (changeReady ??= sql
    .run(
      `CREATE TABLE IF NOT EXISTS visit_change_outbox (
         change_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         visit_id     INTEGER NOT NULL,
         case_id      TEXT NOT NULL,
         kind         TEXT NOT NULL,
         old_date     TEXT, old_start TEXT, old_end TEXT, old_assignee TEXT,
         new_date     TEXT, new_start TEXT, new_end TEXT, new_assignee TEXT,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         claimed_at   TIMESTAMPTZ
       )`,
    )
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_visit_change_pending ON visit_change_outbox (created_at) WHERE claimed_at IS NULL'))
    .catch((err) => {
      changeReady = null;
      throw err;
    }));

/** เรียกใน transaction ของ updateVisit หลัง UPDATE แล้ว — before = แถวกะก่อนแก้ · after = ค่าที่ส่งมาแก้ (เฉพาะช่องที่เปลี่ยน) */
export async function recordVisitChange(tx, caseId, visitId, before, after, changed) {
  const cancelled = changed.includes('status') && after.status === 'cancelled' && before.status !== 'cancelled';
  const moved = changed.some((c) => ['visit_date', 'planned_start'].includes(c));
  const reassigned = changed.includes('assigned_to');
  if (!cancelled && !moved && !reassigned) return;
  if (!cancelled && (before.status === 'cancelled' || (after.status && after.status !== 'scheduled'))) return;
  const pick = (c) => (changed.includes(c) ? after[c] ?? null : before[c] ?? null);
  const row = {
    visit_id: visitId, case_id: caseId,
    kind: cancelled ? 'cancelled' : moved ? 'moved' : 'reassigned',
    old_date: before.visit_date, old_start: before.planned_start ?? null, old_end: before.planned_end ?? null, old_assignee: before.assigned_to ?? null,
    new_date: pick('visit_date'), new_start: pick('planned_start'), new_end: pick('planned_end'), new_assignee: pick('assigned_to'),
  };
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  if (row.old_date < today && row.new_date < today) return;
  await tx.run(
    `INSERT INTO visit_change_outbox (visit_id, case_id, kind, old_date, old_start, old_end, old_assignee, new_date, new_start, new_end, new_assignee)
     VALUES (:visit_id, :case_id, :kind, :old_date, :old_start, :old_end, :old_assignee, :new_date, :new_start, :new_end, :new_assignee)`,
    row,
  );
}

/** จองรายการแจ้งเลื่อน/ยกเลิกที่ยังไม่ส่ง → รวมเป็นหนึ่งรายการต่อนัด (ค่าเดิมจากรอบแรก ค่าใหม่จากรอบล่าสุด) พร้อมผู้รับ */
export async function claimVisitChanges() {
  await ensureVisitChangeTable();
  await ensureFamilyTable();
  await ensureCustomerLineColumns();
  // รอ 2 นาทีหลังแก้ครั้งสุดท้าย — แอดมินมักแก้วันแล้วแก้เวลาต่อทันที ไม่ควรได้สองข้อความ
  const rows = await sql.all(
    `UPDATE visit_change_outbox o SET claimed_at = now()
     WHERE o.claimed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM visit_change_outbox n
                        WHERE n.visit_id = o.visit_id AND n.claimed_at IS NULL AND n.created_at > now() - interval '2 minutes')
     RETURNING o.*`,
  );
  if (!rows.length) return [];
  const byVisit = new Map();
  for (const r of rows.sort((a, b) => a.change_id - b.change_id)) {
    const prev = byVisit.get(r.visit_id);
    byVisit.set(r.visit_id, prev ? { ...r, old_date: prev.old_date, old_start: prev.old_start, old_end: prev.old_end, old_assignee: prev.old_assignee,
      kind: r.kind === 'cancelled' ? 'cancelled' : prev.kind === 'moved' || r.kind === 'moved' ? 'moved' : r.kind } : r);
  }
  const out = [];
  for (const r of byVisit.values()) {
    // เลื่อนไปแล้วเลื่อนกลับที่เดิม = ไม่มีอะไรเปลี่ยน ไม่ต้องรบกวนใคร
    if (r.kind !== 'cancelled' && r.old_date === r.new_date && (r.old_start ?? '') === (r.new_start ?? '') && r.old_assignee === r.new_assignee) continue;
    const info = await sql.one(
      `SELECT c.client_name, c.case_id,
              ${FAMILY_IDS} AS family,
              (SELECT json_agg(json_build_object('employee_id', e.employee_id, 'line_user_id', e.line_user_id,
                       'name', COALESCE(NULLIF(e.nickname, ''), e.first_name), 'position', e.position))
                 FROM employees e WHERE e.employee_id IN (:old_a, :new_a)) AS staff
       FROM cases c WHERE c.case_id = :case_id`,
      { case_id: r.case_id, old_a: r.old_assignee ?? '', new_a: r.new_assignee ?? '' },
    );
    if (!info) continue;
    const staff = info.staff ?? [];
    const find = (id) => staff.find((s) => s.employee_id === id) ?? null;
    out.push({
      kind: r.kind, visit_id: r.visit_id, case_id: r.case_id, client_name: info.client_name,
      old: { date: r.old_date, start: r.old_start, end: r.old_end, staff: find(r.old_assignee) },
      new: { date: r.new_date, start: r.new_start, end: r.new_end, staff: find(r.new_assignee) },
      // เปลี่ยนแค่คน = เรื่องภายใน ไม่แจ้งญาติ
      family: r.kind === 'reassigned' ? [] : info.family ?? [],
    });
  }
  return out;
}

