import { z } from 'zod';

export const PAYROLL_STATUSES = ['draft', 'paid', 'cancelled'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนต้องอยู่ในรูปแบบ YYYY-MM');
const optionalText = z.string().trim().max(500).optional().nullable();

/**
 * เปิดรอบจ่าย
 *
 * round_no จำกัด 1–3 ตามที่ตกลงกันว่าเดือนหนึ่งแบ่งจ่ายได้ไม่เกินสามรอบ
 * (ฐานข้อมูลมี CHECK ตัวเดียวกัน — ที่นี่ตอบเป็น 400 พร้อมชื่อช่อง แทนที่จะไปตายที่ CHECK)
 *
 * period_to = วันตัดรอบ ไม่ใช่ "วันเริ่มรอบ" เพราะรอบไม่มีขอบล่าง: กะที่อนุมัติแล้วและยังไม่เคย
 * ถูกจ่ายจะถูกกวาดเข้ามาทั้งหมดไม่ว่าทำไว้เมื่อไหร่ (ดู ELIGIBLE ใน repo)
 * ต้องไม่อยู่ก่อนเดือนของรอบ ไม่งั้นรอบจะไม่มีทางมีกะของเดือนตัวเองเลยสักกะ
 */
export const createRunSchema = z
  .object({
    period_month: month,
    round_no: z.coerce
      .number({ invalid_type_error: 'รอบที่ต้องเป็นตัวเลข' })
      .int('รอบที่ต้องเป็นจำนวนเต็ม')
      .min(1, 'เดือนหนึ่งแบ่งจ่ายได้ 1–3 รอบ')
      .max(3, 'เดือนหนึ่งแบ่งจ่ายได้ 1–3 รอบ'),
    period_to: date,
    note: optionalText,
  })
  .superRefine((v, ctx) => {
    if (v.period_to < `${v.period_month}-01`) {
      ctx.addIssue({
        code: 'custom',
        path: ['period_to'],
        message: 'วันตัดรอบต้องไม่อยู่ก่อนเดือนของรอบ',
      });
    }
  });

/** ปิดรอบเป็น "จ่ายแล้ว" — ไม่ส่งวันที่มา = วันนี้ (ปกติกดตอนโอนเงินเสร็จพอดี) */
export const payRunSchema = z.object({
  pay_date: date.optional(),
  method: optionalText,
  note: optionalText,
});

export const previewQuerySchema = z.object({ period_to: date });

export const listQuerySchema = z.object({
  month: month.optional(),
  status: z.enum(PAYROLL_STATUSES).optional(),
});
