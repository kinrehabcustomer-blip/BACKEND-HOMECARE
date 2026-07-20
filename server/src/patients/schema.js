import { z } from 'zod';

const optionalText = z.string().trim().max(500).optional().nullable();
const optionalLongText = z.string().trim().max(2000).optional().nullable();
const optionalShort = z.string().trim().max(100).optional().nullable();
const optionalPhone = z
  .string()
  .regex(/^[0-9+\-\s]{8,20}$/, 'เบอร์โทรไม่ถูกต้อง')
  .optional()
  .nullable();

export const TITLES = ['mr', 'mrs', 'miss', 'boy', 'girl'];
export const BLOOD_TYPES = ['A', 'B', 'AB', 'O'];
export const PATIENT_STATUSES = ['active', 'inactive'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');

/**
 * มีแต่ชื่อที่บังคับกรอก — เหมือน customers เพราะข้อมูลมักได้มาทีละนิดทางโทรศัพท์
 * customer_id (ผู้ว่าจ้าง) ไม่บังคับ: บาง lead ยังไม่มีลูกค้าในระบบ หรือยังไม่รู้ว่าใครจ่าย
 */
export const createPatientSchema = z.object({
  name: z.string().trim().min(1, 'กรุณากรอกชื่อผู้รับการดูแล').max(200),
  customer_id: optionalShort,
  title: z.enum(TITLES).optional().nullable(),
  nickname: optionalShort,
  name_en: optionalShort,
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),

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
  relation_to_customer: optionalShort,

  weight_kg: z.number().positive('น้ำหนักต้องมากกว่า 0').max(500).optional().nullable(),
  height_cm: z.number().positive('ส่วนสูงต้องมากกว่า 0').max(300).optional().nullable(),
  medical_history: optionalLongText,
  allergies: optionalLongText,
  blood_type: z.enum(BLOOD_TYPES).optional().nullable(),
  medical_rights: optionalShort,

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
  emergency_contact_relation: optionalShort,

  status: z.enum(PATIENT_STATUSES).optional(),
  note: optionalText,
});

export const updatePatientSchema = createPatientSchema.partial();

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  customer_id: z.string().trim().optional(),
  status: z.enum(PATIENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['patient_id', 'name', 'created_at']).default('patient_id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
