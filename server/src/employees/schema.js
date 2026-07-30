import { z } from 'zod';

export const POSITIONS = ['caregiver', 'assistant_nurse', 'practical_nurse', 'nurse', 'therapist', 'manager', 'hr'];
export const EMPLOYMENT_TYPES = ['fulltime', 'parttime', 'contract', 'daily'];
export const STATUSES = ['active', 'probation', 'on_leave', 'suspended', 'resigned'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');
const optionalText = z.string().trim().max(500).optional().nullable();
const optionalLongText = z.string().trim().max(2000).optional().nullable(); // ประวัติการศึกษา เขียนยาวได้

// ชื่ออังกฤษต้องเป็นอักษรละติน — กันกรอกภาษาไทยสลับช่องมาโดยไม่รู้ตัว
const englishName = (field) =>
  z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z\s.'-]*$/, `${field}ภาษาอังกฤษต้องเป็นตัวอักษรภาษาอังกฤษเท่านั้น`)
    .optional()
    .nullable();

export const createEmployeeSchema = z.object({
  first_name: z.string().trim().min(1, 'กรุณากรอกชื่อ').max(100),
  last_name: z.string().trim().min(1, 'กรุณากรอกนามสกุล').max(100),
  first_name_en: englishName('ชื่อ'),
  last_name_en: englishName('นามสกุล'),
  nickname: optionalText,
  national_id: z
    .string()
    .regex(/^\d{13}$/, 'เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก')
    .optional()
    .nullable(),
  phone: z
    .string()
    .regex(/^[0-9+\-\s]{8,20}$/, 'เบอร์โทรไม่ถูกต้อง')
    .optional()
    .nullable(),
  email: z.string().email('อีเมลไม่ถูกต้อง').optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  birth_date: date.optional().nullable(),
  address: optionalText,
  education: optionalLongText,

  position: z.enum(POSITIONS, { errorMap: () => ({ message: 'ตำแหน่งไม่ถูกต้อง' }) }),
  employment_type: z.enum(EMPLOYMENT_TYPES).default('fulltime'),
  status: z.enum(STATUSES).default('active'),

  hire_date: date.optional().nullable(),
  resign_date: date.optional().nullable(),
  base_salary: z.number().nonnegative('เงินเดือนต้องไม่ติดลบ').optional().nullable(),

  emergency_contact_name: optionalText,
  emergency_contact_phone: optionalText,
  note: optionalText,
});

// แก้ไขบางส่วนได้ แต่ห้ามแก้ employee_id — เป็น PK ที่โมดูลอื่นอ้างอิงอยู่
export const updateEmployeeSchema = createEmployeeSchema.partial();

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(STATUSES).optional(),
  position: z.enum(POSITIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['employee_id', 'first_name', 'hire_date', 'created_at']).default('employee_id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// ---------- รูปใบรับรอง ----------
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB หลังย่อแล้ว — เผื่อไว้เยอะกว่าที่ควรจะเป็นมาก

// รูปส่งมาเป็น data URL จากเบราว์เซอร์: "data:image/jpeg;base64,/9j/4AAQ..."
export const imageSchema = z
  .string()
  .regex(
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/,
    'ไฟล์ต้องเป็นรูปภาพ (JPG, PNG หรือ WebP)',
  );

/**
 * แปลง data URL เป็นไบนารีพร้อมเก็บ พร้อมตรวจว่าเป็นรูปจริง
 * เช็ค magic bytes ด้วย — ชนิดไฟล์ที่ browser บอกมาปลอมได้ (เปลี่ยนนามสกุลไฟล์เอา)
 */
export function decodeImage(dataUrl) {
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const data = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

  if (!ALLOWED_IMAGE_TYPES.includes(mime)) {
    throw new Error('รองรับเฉพาะไฟล์ JPG, PNG และ WebP');
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new Error(`รูปใหญ่เกินไป (${Math.round(data.length / 1024 / 1024)} MB) — จำกัดที่ 5 MB`);
  }

  const looksLikeImage =
    (mime === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8) ||
    (mime === 'image/png' && data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG') ||
    (mime === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF');

  if (!looksLikeImage) throw new Error('ไฟล์นี้ไม่ใช่รูปภาพที่ถูกต้อง');

  return { data, mime, size: data.length };
}

export const certificateSchema = z.object({
  name: z.string().trim().min(1, 'กรุณากรอกชื่อใบรับรอง').max(200),
  issuer: optionalText,
  issued_date: date.optional().nullable(),
  expiry_date: date.optional().nullable(),
  image: imageSchema.optional().nullable(),
});

export const certificateImageSchema = z.object({
  image: imageSchema.nullable(), // null = ลบรูปทิ้ง
});

// ---------- รูปพนักงาน ----------
// แยกจาก createEmployeeSchema เพราะรูปไปคนละเส้น (PUT .../photo) — ฟอร์มพนักงานส่ง JSON ก้อนเล็ก
// ไม่ต้องแบกรูป base64 ไปด้วยทุกครั้งที่แก้แค่เบอร์โทร
export const employeePhotoSchema = z.object({
  image: imageSchema.nullable(), // null = ลบรูปทิ้ง
});

// ---------- ผลงาน (โปรไฟล์พนักงาน) ----------
export const portfolioSchema = z.object({
  title: z.string().trim().min(1, 'กรุณากรอกชื่อผลงาน').max(200),
  description: optionalLongText,
  image: imageSchema, // ผลงานต้องมีรูปเสมอ
});

// แก้ไขได้เฉพาะชื่อกับคำอธิบาย — เปลี่ยนรูปให้ลบแล้วอัปโหลดใหม่
export const portfolioUpdateSchema = portfolioSchema.omit({ image: true });
