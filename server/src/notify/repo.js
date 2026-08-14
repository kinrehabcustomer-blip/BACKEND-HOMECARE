import { sql } from '../db/index.js';
import { LATE_THRESHOLD_MINUTES } from '../cases/repo.js';

/**
 * ข้อมูลของ "สรุปประจำวัน" ที่ส่งให้ผู้จัดการทางอีเมล
 *
 * ทุกอย่างในนี้ดูได้จากหน้าเว็บอยู่แล้ว — ที่ต้องมีอีเมลเพราะของพวกนี้ต้องรีบรู้
 * ("เมื่อวานไม่มีคนไปบ้านคุณยาย") แต่ถ้ารอให้คนเปิดหน้าเอง กว่าจะเห็นก็ผ่านไปหลายวัน
 */

/** วันนี้/เมื่อวาน ตามโซนไทย — ใช้ตัวเดียวกันทุก query ในสรุปฉบับเดียว ตัวเลขจะได้ไม่เหลื่อมกัน */
export const todayTH = () =>
  sql.one(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')              AS today,
            to_char((now() - interval '14 days') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS since`,
  );

const VISIT_ROW = `
  SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start,
         v.check_in_at, v.location_flagged, v.off_schedule, v.check_in_late_minutes,
         c.client_name,
         COALESCE(ci.first_name || ' ' || ci.last_name, ae.first_name || ' ' || ae.last_name) AS employee_name
  FROM case_visits v
  JOIN cases c ON c.case_id = v.case_id
  LEFT JOIN employees ci ON ci.employee_id = v.checked_in_by
  LEFT JOIN employees ae ON ae.employee_id = v.assigned_to
`;

/** กะที่เลยวันแล้วไม่มีใครเช็คอิน — ย้อนหลังจำกัดช่วง ไม่งั้นของเก่าค้างจะท่วมอีเมลทุกวัน */
export const missedShifts = ({ today, since }) =>
  sql.all(
    `${VISIT_ROW}
     WHERE v.status = 'scheduled' AND v.check_in_at IS NULL
       AND v.visit_date < :today AND v.visit_date >= :since
     ORDER BY v.visit_date DESC`,
    { today, since },
  );

/** เช็คอินแล้วไม่เช็คเอาท์เกิน 16 ชม. — ตรงกับเกณฑ์ 'stale' ที่หน้าเว็บใช้ */
export const staleShifts = () =>
  sql.all(
    `${VISIT_ROW}
     WHERE v.status = 'scheduled' AND v.check_in_at IS NOT NULL AND v.check_out_at IS NULL
       AND v.check_in_at < now() - interval '16 hours'
     ORDER BY v.check_in_at`,
  );

/**
 * เช็คอินที่ผิดปกติในรอบวัน — นอกพื้นที่ · กดคนละวันกับที่นัด · มาสายเกินเกณฑ์
 * ใช้เกณฑ์สายตัวเดียวกับหน้า "รายการต้องตรวจ" เพื่อไม่ให้อีเมลกับหน้าเว็บบอกไม่ตรงกัน
 */
export const flaggedCheckIns = () =>
  sql.all(
    `${VISIT_ROW}
     WHERE v.check_in_at >= now() - interval '24 hours'
       AND (v.location_flagged = TRUE OR v.off_schedule = TRUE OR v.check_in_late_minutes > :late)
     ORDER BY v.check_in_at DESC`,
    { late: LATE_THRESHOLD_MINUTES },
  );

/**
 * กะของวันนี้ที่ยังไม่มีคน "รับ" — เตือนตั้งแต่เช้าให้ยังหาคนทัน
 *
 * เกณฑ์คือ assigned_to ว่าง ไม่ใช่ "ยังไม่มีใครเช็คอิน" (ตอน 08:00 กะบ่ายยังไม่ถึงเวลาอยู่แล้ว)
 * ในทางปฏิบัติจะเจอเฉพาะกะของเคสที่ยังไม่จับคู่พนักงาน เพราะตอนลงกะระบบเติมผู้รับผิดชอบเคสให้เสมอ
 * — ตั้งใจให้แคบแบบนี้ ของที่ "มีคนรับแล้วแต่ไม่ไป" ไปโผล่ในหัวข้อขาดงาน/ค้างเช็คเอาท์แทน
 */
export const unstaffedToday = ({ today }) =>
  sql.all(
    `${VISIT_ROW}
     WHERE v.status = 'scheduled' AND v.visit_date = :today AND v.assigned_to IS NULL
     ORDER BY v.planned_start NULLS FIRST`,
    { today },
  );

/** ใบแจ้งหนี้ที่ออกไปแล้วและเลยวันครบกำหนด (ยังไม่ชำระ) */
export const overdueInvoices = ({ today }) =>
  sql.all(
    `SELECT invoice_id, bill_to_name, total, due_date
     FROM invoices
     WHERE status = 'issued' AND due_date IS NOT NULL AND due_date < :today
     ORDER BY due_date`,
    { today },
  );

/**
 * ผู้รับสรุปประจำวัน = คนที่เข้าหลังบ้านได้และยังทำงานอยู่
 * ยึด "ตำแหน่ง" เป็นเกณฑ์เดียวกับสิทธิ์ในระบบ (ADMIN_POSITIONS ใน lib/auth.js) ไม่ใช่คอลัมน์ role
 * ไม่งั้นคนที่เพิ่งเลื่อนเป็นผู้จัดการจะเข้าหน้าเว็บได้แต่ไม่ได้รับอีเมล
 */
export const digestRecipients = () =>
  sql.all(
    `SELECT employee_id, email, first_name || ' ' || last_name AS name
     FROM employees
     WHERE position IN ('manager', 'hr')
       AND status NOT IN ('resigned', 'suspended')
       AND email IS NOT NULL
     ORDER BY employee_id`,
  );
