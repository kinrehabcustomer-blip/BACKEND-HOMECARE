import { z } from 'zod';

const optionalText = z.string().trim().max(500).optional().nullable();
const optionalShort = z.string().trim().max(100).optional().nullable();
const optionalPhone = z
  .string()
  .regex(/^[0-9+\-\s]{8,20}$/, 'เบอร์โทรไม่ถูกต้อง')
  .optional()
  .nullable();

export const TITLES = ['mr', 'mrs', 'miss', 'boy', 'girl'];
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');

/**
 * มีแต่ชื่อที่บังคับกรอก — เคสส่วนใหญ่รับทางโทรศัพท์ ได้ข้อมูลมาทีละนิด
 * บังคับมากกว่านี้จะเปิดเคสไม่ได้ตั้งแต่แรก แล้วคนก็จะกรอกข้อมูลมั่วเพื่อผ่านฟอร์ม
 */
export const createCustomerSchema = z.object({
  name: z.string().trim().min(1, 'กรุณากรอกชื่อลูกค้า').max(200),
  title: z.enum(TITLES).optional().nullable(),
  nickname: optionalShort,
  name_en: optionalShort,
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),

  // เลขบัตร 13 หลัก — ตรวจแค่ความยาว/ตัวเลข ไม่ตรวจ checksum เพราะบางเคสกรอกจากที่ญาติบอกทางโทรศัพท์
  national_id: z
    .string()
    .trim()
    .regex(/^\d{13}$/, 'เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก')
    .optional()
    .nullable(),
  passport_no: optionalShort,
  birth_date: date.optional().nullable(),
  age: z
    .number()
    .int('อายุต้องเป็นจำนวนเต็ม')
    .min(0, 'อายุต้องไม่ติดลบ')
    .max(130, 'อายุไม่ถูกต้อง')
    .optional()
    .nullable(),
  nationality: optionalShort,
  marital_status: z.enum(MARITAL_STATUSES).optional().nullable(),

  // ข้อมูลสุขภาพ (น้ำหนัก/ส่วนสูง/โรคประจำตัว/แพ้ยา/กรุ๊ปเลือด/สิทธิการรักษา) ไม่เก็บที่ลูกค้าแล้ว
  // ผู้ว่าจ้างเป็นคนจ่ายเงิน ไม่ใช่ผู้รับการดูแล — ข้อมูลสุขภาพอยู่ที่แฟ้ม patients เท่านั้น

  phone: optionalPhone,
  home_phone: optionalPhone,
  line_id: optionalShort,
  email: z.string().trim().email('อีเมลไม่ถูกต้อง').max(200).optional().nullable(),

  address: optionalText,
  subdistrict: optionalShort,
  district: optionalShort,
  province: optionalShort,
  postal_code: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก')
    .optional()
    .nullable(),

  emergency_contact_name: optionalShort,
  emergency_contact_phone: optionalPhone,

  occupation: optionalShort,
  customer_type: optionalShort,
  referral_source: optionalShort,
  note: optionalText,
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['customer_id', 'name', 'created_at']).default('customer_id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
