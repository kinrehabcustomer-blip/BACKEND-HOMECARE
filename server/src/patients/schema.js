import { z } from 'zod';
import { zodDate } from '../lib/dates.js';

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

// วันที่ต้องมีอยู่จริงในปฏิทิน ไม่ใช่แค่รูปแบบถูก (2026-02-31 เคยผ่านได้ — ดู lib/dates.js)
const date = zodDate(z);

/**
 * รหัสผู้ป่วย = KN + ปี พ.ศ. 2 หลัก + เลข 7 หลักที่เจ้าหน้าที่กรอกเอง (เช่น KN690202463)
 * ไม่ใช่เลขรันอัตโนมัติแบบ PAT-0001 เดิม — เลขชุดนี้มาจากเอกสารของศูนย์ ระบบจึงแค่ตรวจรูปแบบและห้ามซ้ำ
 * แฟ้มเก่าที่ยังเป็น PAT-xxxx ใช้ต่อได้ และแก้เป็นรหัส KN ได้ในหน้าแก้ไขผู้ป่วย
 * (ต้องตรงกับ PATIENT_CODE_RE ใน client/src/lib/patientCode.js)
 */
export const PATIENT_CODE_RE = /^KN\d{9}$/;
export const patientCode = z
  .string()
  .trim()
  .regex(PATIENT_CODE_RE, 'รหัสผู้ป่วยต้องเป็น KN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก (เช่น KN690202463)');

/**
 * มีแต่ชื่อที่บังคับกรอก — เหมือน customers เพราะข้อมูลมักได้มาทีละนิดทางโทรศัพท์
 * customer_id (ผู้ว่าจ้าง) ไม่บังคับ: บาง lead ยังไม่มีลูกค้าในระบบ หรือยังไม่รู้ว่าใครจ่าย
 */
export const createPatientSchema = z.object({
  // รหัสผู้ป่วย — บังคับตอนสร้าง · ตอนแก้ (updatePatientSchema) ส่งมา = เปลี่ยนรหัส
  patient_id: patientCode,
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
  employer_relation: optionalShort, // ผู้ว่าจ้างเป็นอะไรกับผู้ป่วย

  weight_kg: z.number().positive('น้ำหนักต้องมากกว่า 0').max(500).optional().nullable(),
  height_cm: z.number().positive('ส่วนสูงต้องมากกว่า 0').max(300).optional().nullable(),
  medical_history: optionalLongText,
  allergies: optionalLongText,      // แพ้ยา
  food_allergies: optionalLongText, // แพ้อาหาร
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
  // 'no' = แฟ้มที่ยังไม่ได้ผูกผู้ว่าจ้าง (ยังไม่รู้ว่าใครเป็นคนจ่าย) — กลุ่มที่ต้องตามเก็บ
  has_customer: z.enum(['yes', 'no']).optional(),
  status: z.enum(PATIENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['patient_id', 'name', 'created_at']).default('patient_id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
