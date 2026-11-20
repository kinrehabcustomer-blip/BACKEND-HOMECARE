import { z } from 'zod';

/* เงินต้องมีทศนิยมไม่เกิน 2 ตำแหน่ง (ตรวจรอบ 15 — เดิม PATCH /api/packages/rates รับ 1500.567 ได้)
   เรทที่มีเศษเกินสตางค์ถูกคัดลอกไปเป็นค่าบริการของเคสและยอดในใบแจ้งหนี้ ซึ่งปัด 2 ตำแหน่ง
   ตัวเลขสองหน้าจอจึงต่างกันทีละสตางค์โดยหาที่มาไม่เจอ · เกณฑ์เดียวกับ invoices/schema.js */
const money = (msg) => z.number().nonnegative(msg).multipleOf(0.01, 'จำนวนเงินต้องมีทศนิยมไม่เกิน 2 ตำแหน่ง');

/* รหัสแพ็คเกจ (ดู packages/codes.js) — ตัวพิมพ์ใหญ่ให้เอง · ช่องว่างกลางคำเป็น - · ว่าง = ให้ระบบตั้งรหัสตั้งต้นให้
   ใช้ทั้งเรท Homecare และแพ็คกายภาพ (physio/schema.js import ไปใช้) กติกาจึงมีที่เดียว */
export const packageCode = z
  .string()
  .max(40)
  .transform((s) => s.trim().toUpperCase().replace(/\s+/g, '-'))
  .refine((s) => s === '' || /^[A-Z0-9-]{1,20}$/.test(s), {
    message: 'รหัสแพ็คเกจใช้ได้เฉพาะ A-Z, 0-9 และ - ยาวไม่เกิน 20 ตัว',
  });

export const STAFF_TIERS = ['CG', 'NA', 'PN', 'RN'];
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
  // จำนวนวันต่อรอบ — ล็อกการลงกะไม่ให้เกิน (16 พ.ย. 2569) · null = ไม่จำกัด · ไม่ส่ง = ใช้ค่าตั้งต้นจากชื่อ/หมวด
  days: z.number().int().min(1, 'จำนวนวันต้องมากกว่า 0').max(366, 'จำนวนวันมากเกินไป').nullable().optional(),
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
        customer_price: money('ค่าบริการต้องไม่ติดลบ').nullable().optional(),
        staff_pay: money('ค่าตอบแทนต้องไม่ติดลบ').nullable().optional(),
        // ส่วนลด: กรอกเป็น % หรือเป็นบาทก็ได้ — ใส่ % ไว้จะใช้ % ก่อน
        discount_percent: z
          .number()
          .min(0, 'ส่วนลดต้องไม่ติดลบ')
          .max(100, 'ส่วนลดต้องไม่เกิน 100%')
          .nullable()
          .optional(),
        discount_amount: money('ส่วนลดต้องไม่ติดลบ').nullable().optional(),
        available: z.boolean().optional(),
        // ไม่ส่งคีย์ = ไม่แตะรหัสเดิม · ส่ง '' = ให้ระบบตั้งรหัสตั้งต้นใหม่
        code: packageCode.optional(),
      }),
    )
    .min(1, 'ต้องมีอย่างน้อยหนึ่งช่อง'),
});
