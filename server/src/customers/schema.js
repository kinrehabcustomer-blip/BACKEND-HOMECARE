import { z } from 'zod';
import { zodDate, zodPastDate } from '../lib/dates.js';

const optionalText = z.string().trim().max(500).optional().nullable();
const optionalShort = z.string().trim().max(100).optional().nullable();
/* ต้องมีตัวเลขพอที่จะโทรออกได้จริง (ตรวจรอบ 18)
   กฎเดิมดูแค่ "อักขระที่อนุญาต 8–20 ตัว" — "++++++++" กับเว้นวรรคแปดตัวจึงผ่านเข้าฐานเป็นเบอร์
   แล้วคนที่เปิดแฟ้มมาเห็นช่องเบอร์มีค่าอยู่ แต่โทรไม่ได้และค้นไม่เจอ */
const optionalPhone = z
  .string()
  .regex(/^[0-9+\-\s]{8,20}$/, 'เบอร์โทรไม่ถูกต้อง')
  .refine((v) => (v.match(/\d/g) ?? []).length >= 8, 'เบอร์โทรต้องมีตัวเลขอย่างน้อย 8 หลัก')
  .optional()
  .nullable();

export const TITLES = ['mr', 'mrs', 'miss', 'boy', 'girl'];
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'];

// วันที่ต้องมีอยู่จริงในปฏิทิน ไม่ใช่แค่รูปแบบถูก (2026-02-31 เคยผ่านได้ — ดู lib/dates.js)
const date = zodDate(z);
/* วันเกิดเป็นอนาคตไม่ได้ (ตรวจรอบ 18 — เดิมรับ 2099 ได้ 201)
   อายุถูกคำนวณจากช่องนี้ไปขึ้นในแฟ้มและรายงาน กรอกผิดแล้วได้อายุติดลบ */
const birthDate = zodPastDate(z);

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
  birth_date: birthDate.optional().nullable(),
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

  // ---------- ข้อมูลออกบิล ----------
  // เลขผู้เสียภาษี 13 หลัก (นิติบุคคล) — ตรวจแค่รูปแบบ ไม่ตรวจ checksum เพราะบางทีได้มาทางโทรศัพท์
  tax_id: z
    .string()
    .trim()
    .regex(/^\d{13}$/, 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก')
    .optional()
    .nullable(),
  payment_terms: optionalShort,   // เช่น 'เงินสด', 'เครดิต 30 วัน'
  billing_address: optionalText,  // ว่าง = ใช้ที่อยู่หลัก
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  // 'no' = ลูกค้าที่ยังไม่เคยเปิดเคสเลย (กลุ่มที่ต้องตามต่อ) · 'yes' = เคยใช้บริการแล้ว
  has_cases: z.enum(['yes', 'no']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['customer_id', 'name', 'created_at']).default('customer_id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
