import { z } from 'zod';

export const PAYROLL_STATUSES = ['draft', 'paid', 'cancelled'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');
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

/** ปิดรอบเป็น "จ่ายแล้ว" — ไม่ส่งวันที่มา = วันนี้ (ปกติกดตอนโอนเงินเสร็จพอดี) */
export const payRunSchema = z.object({
  pay_date: date.optional(),
  method: optionalText,
  note: optionalText,
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
