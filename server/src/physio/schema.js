import { z } from 'zod';

// แพ็คเกจกายภาพบำบัด = ซื้อเหมาจำนวนครั้ง (ต่างจาก Homecare ที่เป็นตารางเรทตามเกรด)
// "ตกเฉลี่ย" ไม่รับจากฝั่งหน้าเว็บ — คำนวณจาก special_price / sessions ตอนอ่านเสมอ
export const physioPackageSchema = z
  .object({
    name: z.string().trim().min(1, 'กรุณากรอกชื่อแพ็คเกจ').max(100),
    sessions: z.number().int('จำนวนครั้งต้องเป็นจำนวนเต็ม').positive('จำนวนครั้งต้องมากกว่า 0'),
    duration_months: z
      .number()
      .int('ระยะเวลาต้องเป็นจำนวนเต็ม')
      .positive('ระยะเวลาต้องมากกว่า 0')
      .nullable()
      .optional(),
    original_price: z.number().nonnegative('ราคารวมเดิมต้องไม่ติดลบ').nullable().optional(),
    special_price: z.number().nonnegative('ราคาพิเศษต้องไม่ติดลบ'),
    // ส่วนลด: กรอกเป็น % หรือเป็นบาทก็ได้ — ใส่ % ไว้จะใช้ % ก่อน (server คำนวณราคาสุทธิให้เอง)
    discount_percent: z
      .number()
      .min(0, 'ส่วนลดต้องไม่ติดลบ')
      .max(100, 'ส่วนลดต้องไม่เกิน 100%')
      .nullable()
      .optional(),
    discount_amount: z.number().nonnegative('ส่วนลดต้องไม่ติดลบ').nullable().optional(),
    // ค่าจ้างพนักงานต่อแพ็คเกจ — เคสคัดลอกไปเป็น cases.staff_pay ตอนเลือกแพ็คเกจ
    staff_pay: z.number().nonnegative('ค่าจ้างพนักงานต้องไม่ติดลบ').nullable().optional(),
    active: z.boolean().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    sort_order: z.number().int().optional(),
  })
  // ราคาเดิมที่ถูกกว่าราคาพิเศษแปลว่ากรอกสลับช่อง — ปล่อยผ่านจะได้ส่วนลดติดลบโชว์หน้าเว็บ
  .refine((v) => v.original_price == null || v.original_price >= v.special_price, {
    message: 'ราคารวมเดิมต้องไม่น้อยกว่าราคาพิเศษ (กรอกสลับช่องหรือเปล่า?)',
    path: ['original_price'],
  });

// partial() ใช้กับ ZodEffects ไม่ได้ จึงประกาศ shape ซ้ำแล้วค่อยผูก refine เดิม
// (PATCH ส่งมาบางฟิลด์ได้ แต่ถ้าส่งราคามาทั้งคู่ก็ยังต้องผ่านกฎเดียวกัน)
export const physioPackageUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'กรุณากรอกชื่อแพ็คเกจ').max(100),
    sessions: z.number().int().positive('จำนวนครั้งต้องมากกว่า 0'),
    duration_months: z.number().int().positive().nullable(),
    original_price: z.number().nonnegative().nullable(),
    special_price: z.number().nonnegative(),
    discount_percent: z.number().min(0, 'ส่วนลดต้องไม่ติดลบ').max(100, 'ส่วนลดต้องไม่เกิน 100%').nullable(),
    discount_amount: z.number().nonnegative('ส่วนลดต้องไม่ติดลบ').nullable(),
    staff_pay: z.number().nonnegative('ค่าจ้างพนักงานต้องไม่ติดลบ').nullable(),
    active: z.boolean(),
    note: z.string().trim().max(1000).nullable(),
    sort_order: z.number().int(),
  })
  .partial()
  .refine(
    (v) =>
      v.original_price == null ||
      v.special_price == null ||
      v.original_price >= v.special_price,
    { message: 'ราคารวมเดิมต้องไม่น้อยกว่าราคาพิเศษ', path: ['original_price'] },
  );

// จัดลำดับใหม่จากการลากในตาราง — ส่งลำดับทั้งชุดมาทีเดียว
export const reorderSchema = z.object({
  order: z.array(z.number().int()).min(1, 'ต้องมีอย่างน้อยหนึ่งแพ็คเกจ'),
});
