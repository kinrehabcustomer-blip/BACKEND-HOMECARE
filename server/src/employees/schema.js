import { z } from 'zod';
import { zodDate } from '../lib/dates.js';

/**
 * สายบำบัด — กายภาพบำบัด, กิจกรรมบำบัด, แก้ไขการพูด
 *
 * สามตำแหน่งนี้ทำงานเหมือนกันทุกข้อในระบบ: รับเคสกายภาพได้, ไม่มีระดับ (CG/NA/PN/RN)
 * ในตารางราคาเหมือนสายดูแล และเปิดรับแบบประเมินความพึงพอใจจากญาติ
 *
 * ประกาศเป็นรายการเดียวเพราะมีหลายที่ที่ต้องถามคำถามเดียวกันว่า "เป็นสายบำบัดหรือเปล่า"
 * (REVIEW_POSITIONS ของแบบประเมิน · positionsForCase ฝั่งหน้าเว็บ · CHECK ใน schema.sql)
 * — เขียนแยกกันไว้ วันหนึ่งจะมีที่ที่เพิ่มตำแหน่งใหม่แล้วอีกที่ไม่ได้เพิ่มตาม
 */
export const THERAPY_POSITIONS = ['therapist', 'occupational_therapist', 'speech_therapist'];

export const POSITIONS = [
  'caregiver', 'assistant_nurse', 'practical_nurse', 'nurse',
  ...THERAPY_POSITIONS,
  // unassigned = "ว่าง" — นำเข้ารายชื่อมาแล้วแต่ยังไม่ได้กำหนดตำแหน่ง (28 ต.ค. 2569) · อยู่กลุ่ม front
  // แต่ไม่ตรงระดับไหนในตารางราคา จึงไม่ถูกเสนอตอนจับคู่เคสจนกว่าจะตั้งตำแหน่งจริง (ดู positionsForCase)
  'unassigned',
  // สายสำนักงาน (กลุ่ม back) — สิทธิ์ของแต่ละตำแหน่งดูที่ POSITION_PERMISSIONS ใน lib/auth.js
  // 'admin' = Admin HC (ชื่อเดิม "แอดมิน") · 'finance' = การเงิน (Admin IPD เลิกใช้แล้ว — ย้ายเป็น Admin HC)
  'manager', 'hr', 'admin', 'finance',
  // super_admin = บัญชีดูแลระบบสูงสุด (ใช้ login หลังล้างระบบ) — สิทธิ์ครบทุกหมวด และเป็นคนเดียวที่ตั้ง/แก้ super admin ได้
  'super_admin',
];
/**
 * พนักงานแบ่งเป็นสองกลุ่ม (ต้องตรงกับ client/src/labels.js)
 *   back  = สายสำนักงาน: Super Admin · ผู้จัดการ · HR · Admin HC · การเงิน
 *   front = ทุกตำแหน่งที่เหลือ: สายดูแล (CG/NA/PN/RN) + สายบำบัด — คนที่ออกไปดูแลผู้รับบริการจริง
 * front เท่านั้นที่รับเคส/ลงกะได้ และเปิดรับแบบประเมินจากญาติ
 * ประกาศ front เป็น "ทุกอย่างที่ไม่ใช่ back" — เพิ่มตำแหน่งหน้างานใหม่ที่ POSITIONS แล้วตามมาเอง
 */
export const BACK_POSITIONS = ['super_admin', 'manager', 'hr', 'admin', 'finance'];
export const FRONT_POSITIONS = POSITIONS.filter((p) => !BACK_POSITIONS.includes(p));

export const EMPLOYMENT_TYPES = ['fulltime', 'parttime', 'contract', 'daily'];
export const STATUSES = ['active', 'probation', 'on_leave', 'suspended', 'resigned'];

// วันที่ต้องมีอยู่จริงในปฏิทิน ไม่ใช่แค่รูปแบบถูก (2026-02-31 เคยผ่านได้ — ดู lib/dates.js)
const date = zodDate(z);
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

/**
 * รหัสพนักงานที่กรอกเอง = A + ตัวเลข 7 หลัก (ปี พ.ศ. 2 · ชุด 2 · เลขรัน 3) เช่น A6901059
 * ไม่กรอก = ระบบออกให้อัตโนมัติ (ดู nextEmployeeId) · ต้องตรงกับ EMPLOYEE_CODE_RE ใน client/src/lib/employeeCode.js
 */
export const EMPLOYEE_CODE_RE = /^A\d{7}$/;
export const employeeCode = z
  .string()
  .trim()
  .regex(EMPLOYEE_CODE_RE, 'รหัสพนักงานต้องเป็น A + ตัวเลข 7 หลัก (เช่น A6901059)');

export const createEmployeeSchema = z.object({
  // กรอกเองได้ (add-on) — ไม่ส่งมา = ระบบออกให้ · ตอนแก้ (update) ส่งมา = เปลี่ยนรหัส
  employee_id: employeeCode.optional(),
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
  /* ไม่ใช่ข้อความ = .slice/.indexOf ไม่มีในของชิ้นนั้น แล้วหลุดออกไปเป็น TypeError
     ซึ่งผู้เรียกบางเส้นแปลงเป็น 400 พร้อมข้อความอังกฤษ "dataUrl.indexOf is not a function"
     ถึงหน้าจอพนักงาน (เส้นแชทเคสรับ image มาดิบๆ ไม่ผ่าน zod · ตรวจรอบ 10A) */
  if (typeof dataUrl !== 'string') throw new Error('ไฟล์แนบต้องเป็นรูปภาพ (JPG, PNG หรือ WebP)');

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
