import { z } from 'zod';

export const STAFF_TIERS = ['CG', 'NA', 'PN'];
export const FORMAT_CATEGORIES = ['daily', 'weekly', 'monthly'];

// ---------- เกรดการดูแล ----------
export const gradeSchema = z.object({
  name: z.string().trim().min(1, 'กรุณากรอกชื่อเกรด').max(100),
  description: z.string().trim().max(1000).optional().nullable(),
  sort_order: z.number().int().optional(),
});
export const gradeUpdateSchema = gradeSchema.partial();

// ---------- รูปแบบบริการ ----------
export const formatSchema = z.object({
  name: z.string().trim().min(1, 'กรุณากรอกชื่อรูปแบบบริการ').max(100),
  category: z.enum(FORMAT_CATEGORIES, { errorMap: () => ({ message: 'หมวดหมู่ไม่ถูกต้อง' }) }).default('monthly'),
  graded: z.boolean().default(true), // false = เรทเดียวใช้ร่วมทุกเกรด (รายวัน/สัปดาห์)
  sort_order: z.number().int().optional(),
});
export const formatUpdateSchema = formatSchema.partial();

// ---------- ราคาแต่ละช่อง (bulk upsert) ----------
export const ratesSchema = z.object({
  rates: z
    .array(
      z.object({
        format_id: z.number().int('format_id ต้องเป็นจำนวนเต็ม'),
        grade_id: z.number().int().nullable().optional(), // null = รูปแบบไม่อิงเกรด
        staff_tier: z.enum(STAFF_TIERS),
        customer_price: z.number().nonnegative('ค่าบริการต้องไม่ติดลบ').nullable().optional(),
        staff_pay: z.number().nonnegative('ค่าตอบแทนต้องไม่ติดลบ').nullable().optional(),
        // ส่วนลด: กรอกเป็น % หรือเป็นบาทก็ได้ — ใส่ % ไว้จะใช้ % ก่อน
        discount_percent: z
          .number()
          .min(0, 'ส่วนลดต้องไม่ติดลบ')
          .max(100, 'ส่วนลดต้องไม่เกิน 100%')
          .nullable()
          .optional(),
        discount_amount: z.number().nonnegative('ส่วนลดต้องไม่ติดลบ').nullable().optional(),
        available: z.boolean().optional(),
      }),
    )
    .min(1, 'ต้องมีอย่างน้อยหนึ่งช่อง'),
});
