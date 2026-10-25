import { z } from 'zod';
import { zodDate, zodPastDate } from '../lib/dates.js';

export const PAYROLL_STATUSES = ['draft', 'paid', 'cancelled'];

// วันที่ต้องมีอยู่จริงในปฏิทิน ไม่ใช่แค่รูปแบบถูก (2026-02-31 เคยผ่านได้ — ดู lib/dates.js)
const date = zodDate(z);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนต้องอยู่ในรูปแบบ YYYY-MM');
const optionalText = z.string().trim().max(500).optional().nullable();

/**
 * เปิดรอบจ่าย — กรอกแค่ "วันตัดรอบ" ช่องเดียว
 *
 * เดือนของรอบกับเลขรอบที่ ระบบตั้งให้เองจากวันตัดรอบ (ดู createRun ใน repo)
 * ของเดิมให้กรอกเองทั้งสามช่อง ทั้งที่ตัวกวาดกะใช้แต่วันตัดรอบ — เดือน/รอบที่จึงเป็นแค่ป้ายชื่อ
 * ที่หลุดจากความจริงได้ (ใส่ป้าย "ส.ค. รอบที่ 1" แต่ตั้งวันตัดรอบเป็น ก.ย. ก็ได้ ไม่มีอะไรทัก)
 *
 * period_to = วันตัดรอบ ไม่ใช่ "วันเริ่มรอบ" เพราะรอบไม่มีขอบล่าง: กะที่อนุมัติแล้วและยังไม่เคย
 * ถูกจ่ายจะถูกกวาดเข้ามาทั้งหมดไม่ว่าทำไว้เมื่อไหร่ (ดู ELIGIBLE ใน repo)
 */
export const createRunSchema = z.object({
  period_to: date,
  note: optionalText,
});

/* ปิดรอบเป็น "จ่ายแล้ว" — ไม่ส่งวันที่มา = วันนี้ (ปกติกดตอนโอนเงินเสร็จพอดี)
   วันที่โอนเป็นอนาคตไม่ได้ (ตรวจรอบ 13 · เกณฑ์เดียวกับวันที่รับชำระของใบแจ้งหนี้)
   รอบที่ขึ้นว่า "จ่ายแล้ว เมื่อ 31 ธ.ค. 2099" คือบันทึกว่าเงินออกไปแล้วในวันที่ยังมาไม่ถึง
   และสลิปของพนักงานเรียงด้วย pay_date (ดู repo.js ORDER BY r.pay_date DESC) ใบนั้นจะค้าง
   อยู่หัวรายการสลิปของเขาไปตลอด ทับใบจริงของเดือนปัจจุบัน */
export const payRunSchema = z.object({
  pay_date: zodPastDate(z).optional(),
  method: optionalText,
  note: optionalText,
});

/**
 * "จ่ายเลย" — เปิดรอบ + จ่ายในคำขอเดียว
 * payout_ids = รหัสก้อนเงินทุกก้อนจากพรีวิวที่ผู้ใช้เห็นก่อนกด — server จ่ายเฉพาะเมื่อชุดตรงกันเป๊ะ
 */
export const payNowSchema = z.object({
  period_to: date,
  note: optionalText,
  pay_date: zodPastDate(z).optional(),   // เหตุผลเดียวกับ payRunSchema
  method: optionalText,
  payout_ids: z.array(z.coerce.number().int().positive()).min(1, 'ไม่มีก้อนค่าจ้างให้จ่าย').max(10000),
});

export const previewQuerySchema = z.object({ period_to: date });

/** ที่มาของยอดในแท็บสรุป — ต้องระบุทั้งเดือนและคน เพราะมันคือการกางยอดของช่องเดียวในตาราง */
export const employeeCasesQuerySchema = z.object({
  month,
  employee_id: z.string().trim().min(1),
});

export const listQuerySchema = z.object({
  month: month.optional(),
  status: z.enum(PAYROLL_STATUSES).optional(),
});
