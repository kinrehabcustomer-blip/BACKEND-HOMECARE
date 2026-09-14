import * as cases from '../cases/repo.js';
import * as invoices from '../invoices/repo.js';
import * as payroll from '../payroll/repo.js';
import { canSeeStaffPay } from '../lib/auth.js';
import { todayTH, missedShifts, unstaffedToday } from './repo.js';

/**
 * ของค้างทั้งระบบสำหรับกระดิ่งแจ้งเตือนบนแถบเมนู
 *
 * ตัวเลขทุกตัวมาจาก repo ของหน้าที่มันชี้ไป ไม่ได้เขียน query ใหม่ที่นี่ —
 * กระดิ่งที่บอกเลขไม่ตรงกับหน้าที่กดเข้าไปคือกระดิ่งที่คนเลิกเชื่อตั้งแต่ครั้งที่สอง
 * (attendance.exceptions ใช้ฟังก์ชันตัวเดียวกับป้ายตัวเลขบนแท็บ "รายการต้องตรวจ"
 *  ส่วน missed/unstaffed ใช้ตัวเดียวกับอีเมลสรุปประจำวัน)
 *
 * ยิงทุก query พร้อมกัน — กระดิ่งถูกเรียกตอนเปิดหน้าเว็บ ไม่ควรต่อคิวรอกันเอง
 */
/**
 * คีย์ที่ collectAlerts คืนมา — สัญญาระหว่าง server กับ client/src/lib/alertDefs.js
 *
 * ใช้จริงในการประกอบ payload ด้านล่าง (ไม่ใช่รายการประดับ) — repo ตัวไหนเลิกคืนคีย์ไหน
 * ค่าจะกลายเป็น 0 ให้เห็นทันที ไม่ใช่คีย์หายไปเงียบๆ แล้วหน้าเว็บซ่อนแถวนั้นทิ้ง
 * และมีเทสคุมว่าป้ายภาษาไทยฝั่งหน้าเว็บครอบคีย์พวกนี้ครบ
 */
export const ALERT_KEYS = {
  attendance: ['exceptions', 'missed', 'unstaffed_today'],
  payroll: ['unreleased', 'unbatched', 'draft_runs'],
  cases: ['unassigned', 'overdue_close', 'no_staff_pay', 'closed_no_invoice'],
  invoices: ['overdue', 'draft_stale', 'data_stale'],
};

/** หยิบเฉพาะคีย์ตามสัญญา และเติม 0 ให้คีย์ที่ repo ไม่ได้คืนมา */
const pick = (group, counts) =>
  Object.fromEntries(ALERT_KEYS[group].map((k) => [k, Number(counts?.[k] ?? 0)]));

export async function collectAlerts(user) {
  const { today, since } = await todayTH();

  /* ค่าตอบแทนพนักงานเป็น manager-only (requireManager หน้า /api/payroll)
     ตัดทั้งกลุ่มออกจาก payload ของคนที่ไม่ใช่ผู้จัดการ ไม่ใช่ส่งไปแล้วให้หน้าเว็บซ่อน —
     ไม่งั้น HR เห็นกระดิ่งบอกว่ามีเงินค้าง 5 เคส แล้วกดเข้าไปเจอ 403
     กลายเป็นแจ้งเตือนที่หลอกให้ไปชนกำแพง */
  const wantsPayroll = canSeeStaffPay(user?.position);

  const [caseCounts, invoiceCounts, payrollCounts, exceptions, missed, unstaffed] = await Promise.all([
    cases.alertCounts(),
    invoices.alertCounts(),
    wantsPayroll ? payroll.alertCounts(today) : null,
    cases.attendanceExceptions(),
    missedShifts({ today, since }),
    unstaffedToday({ today }),
  ]);

  const groups = {
    cases: pick('cases', caseCounts),
    invoices: pick('invoices', invoiceCounts),
    attendance: pick('attendance', {
      exceptions: exceptions.length,
      missed: missed.length,
      unstaffed_today: unstaffed.length,
    }),
  };
  if (payrollCounts) groups.payroll = pick('payroll', payrollCounts);

  /* ยอดรวมคิดฝั่ง server ไม่ใช่ให้หน้าเว็บบวกเอง — เลขบนกระดิ่งต้องตรงกับสิ่งที่กางออกมาเสมอ
     ถ้าหน้าเว็บบวกเอง วันที่เพิ่มกลุ่มใหม่แล้วลืมแก้ตัวบวก เลขจะเพี้ยนโดยไม่มีอะไรฟ้อง */
  const total = Object.values(groups)
    .flatMap((g) => Object.values(g))
    .reduce((sum, n) => sum + n, 0);

  return { total, groups };
}
