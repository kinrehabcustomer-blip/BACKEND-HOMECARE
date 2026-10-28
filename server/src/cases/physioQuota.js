import { sql } from '../db/index.js';

/**
 * สิทธิ์แพ็กกายภาพ — ซื้อกี่ครั้ง ลงนัดแล้วกี่ครั้ง และใช้ได้ถึงวันไหน (ดร.ธงชัย 26 ต.ค. 2569)
 * 🔴 ข้อมูลไว้แสดง/เตือนเท่านั้น ไม่บล็อกการนัด — ดร. เคาะ 26 ต.ค. *"เตือนอย่างเดียวพอครับ อย่าบล็อก"*
 *    (ลูกค้าซื้อเพิ่มกลางคอร์ส / ชดเชยนัดที่ยกเลิก เกิดขึ้นจริง · ดู test/_qa_physio_quota_20261026.mjs)
 *
 * นับเฉพาะกะที่ไม่ถูกยกเลิก — ลูกค้าเลื่อน/ยกเลิกแล้ว ครั้งนั้นต้องกลับมาเป็นสิทธิ์ที่ลงนัดใหม่ได้
 * วันหมดอายุ = วันเริ่มแพ็ก + duration_months (นับจาก start_date ของเคส · ยังไม่มี = นัดแรกของเคส)
 * แพ็กที่ไม่ได้ตั้งอายุไว้ (duration_months ว่าง) = ไม่ตรวจวันหมดอายุ ตรวจแค่จำนวนครั้ง
 * เคส Homecare (ไม่มีแพ็กกายภาพ) คืน null — ไม่มีโควตาให้ตรวจ
 */
export async function physioQuota(caseId, db = sql) {
  const row = await db.one(
    `SELECT c.case_id, c.start_date, pp.sessions, pp.duration_months,
            (SELECT COUNT(*) FROM case_visits v WHERE v.case_id = c.case_id AND v.status <> 'cancelled')::int AS booked,
            (SELECT COUNT(*) FROM case_visits v WHERE v.case_id = c.case_id AND v.check_in_at IS NOT NULL)::int AS attended,
            (SELECT MIN(v.visit_date) FROM case_visits v WHERE v.case_id = c.case_id AND v.status <> 'cancelled') AS first_visit
     FROM cases c
     JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
     WHERE c.case_id = :id`,
    { id: caseId },
  );
  if (!row || !row.sessions) return null;
  const startsOn = row.start_date ? String(row.start_date).slice(0, 10) : row.first_visit ?? null;
  return {
    sessions: Number(row.sessions),
    booked: Number(row.booked),
    attended: Number(row.attended),
    remaining: Math.max(0, Number(row.sessions) - Number(row.booked)),
    duration_months: row.duration_months ? Number(row.duration_months) : null,
    starts_on: startsOn,
    expires_on: startsOn && row.duration_months ? expiryDate(startsOn, Number(row.duration_months)) : null,
  };
}

/** วันสุดท้ายที่ใช้สิทธิ์ได้ = วันเริ่ม + n เดือน − 1 วัน (เริ่ม 26 ต.ค. แพ็ก 3 เดือน → ใช้ได้ถึง 25 ม.ค.) · คิดบน UTC ให้วันไม่เลื่อน */
export function expiryDate(startsOn, months) {
  const d = new Date(`${startsOn}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
