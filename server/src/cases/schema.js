import { z } from 'zod';

export const CASE_TYPES = [
  'elderly_care',
  'bedridden_care',
  'post_op_care',
  'physiotherapy',
  'wound_care',
  'hospital_watch',
  'medical_escort',
  'other',
];

export const CASE_STATUSES = ['unassigned', 'assigned', 'in_progress', 'closed', 'cancelled'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');
const optionalText = z.string().trim().max(500).optional().nullable();
const optionalLongText = z.string().trim().max(2000).optional().nullable(); // อาการ/โรคประจำตัว เขียนยาวได้

export const SERVICE_KINDS = ['homecare', 'physio'];

export const createCaseSchema = z.object({
  // ชื่อเคสถูกสร้างอัตโนมัติจากแพ็คเกจ + ชื่อผู้ป่วย (ไม่มีช่องให้กรอกแล้ว) — รับค่าที่ส่งมาได้แต่ไม่บังคับ
  title: z.string().trim().max(200).optional().nullable(),
  case_type: z.enum(CASE_TYPES, { errorMap: () => ({ message: 'ประเภทเคสไม่ถูกต้อง' }) }),

  // ลูกค้าที่เคสนี้ให้บริการ — เลือกแล้วระบบเติมข้อมูลผู้ป่วยด้านล่างให้อัตโนมัติ (เว้นว่างได้)
  customer_id: z.string().trim().optional().nullable(),
  // ผู้รับการดูแล (แฟ้มถาวรใน patients) — ผูกเมื่อเปิดเคสจากหน้าผู้ป่วย (เว้นว่างได้)
  patient_id: z.string().trim().optional().nullable(),

  // สายบริการที่เลือก: 'homecare' ใช้ตารางเรท (เกรด+รูปแบบ+ระดับ) | 'physio' ใช้แพ็คเกจกายภาพบำบัด (เว้นว่างได้ = ไม่ระบุบริการ)
  service_kind: z.enum(SERVICE_KINDS, { errorMap: () => ({ message: 'สายบริการไม่ถูกต้อง' }) }).optional().nullable(),

  // [homecare] เลือกเกรด + รูปแบบ + ระดับพนักงาน แล้วระบบเติมค่าจ้างจากค่าบริการให้
  pkg_grade_id: z.number().int().optional().nullable(), // ว่างได้ถ้ารูปแบบไม่อิงเกรด
  pkg_format_id: z.number().int().optional().nullable(),
  pkg_staff_tier: z.enum(['CG', 'NA', 'PN']).optional().nullable(),

  // [physio] แพ็คเกจกายภาพบำบัดที่ซื้อ — ระบบเติมค่าจ้างจากราคาพิเศษให้
  physio_package_id: z.number().int().optional().nullable(),

  // ---------- รายละเอียดผู้ป่วย ----------
  client_name: z.string().trim().min(1, 'กรุณากรอกชื่อผู้ป่วย').max(200),
  patient_gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  patient_age: z
    .number()
    .int('อายุต้องเป็นจำนวนเต็ม')
    .min(0, 'อายุต้องไม่ติดลบ')
    .max(130, 'อายุไม่ถูกต้อง')
    .optional()
    .nullable(),
  weight_kg: z.number().positive('น้ำหนักต้องมากกว่า 0').max(500).optional().nullable(),
  height_cm: z.number().positive('ส่วนสูงต้องมากกว่า 0').max(300).optional().nullable(),
  medical_history: optionalLongText,
  current_symptoms: optionalLongText,
  medical_devices: optionalLongText,
  care_goal: optionalLongText,

  // ---------- รายละเอียดการใช้บริการ ----------
  service_start_preference: optionalText,
  address: optionalText,
  client_phone: z
    .string()
    .regex(/^[0-9+\-\s]{8,20}$/, 'เบอร์โทรไม่ถูกต้อง')
    .optional()
    .nullable(),
  nurse_call_preference: optionalText,

  start_date: date.optional().nullable(),
  end_date: date.optional().nullable(),
  fee: z.number().nonnegative('ค่าจ้างต้องไม่ติดลบ').optional().nullable(),
  note: optionalText,

  // จับคู่พนักงานตั้งแต่ตอนสร้างเคยได้ ถ้าเว้นว่างจะเป็น 'ยังไม่จับคู่พนักงาน'
  assigned_to: z.string().trim().optional().nullable(),
});

// สถานะเปลี่ยนผ่าน endpoint เฉพาะ (assign/unassign/close/reopen) เท่านั้น ไม่ให้แก้ตรงๆ
// เพื่อไม่ให้เกิดกรณี 'จับคู่แล้ว' แต่ไม่มีพนักงาน
export const updateCaseSchema = createCaseSchema.omit({ assigned_to: true }).partial();

export const assignSchema = z.object({
  employee_id: z.string().trim().min(1, 'กรุณาเลือกพนักงาน'),
});

// ยกเลิกเคส — เหตุผลไม่บังคับ แต่เก็บไว้ให้ไล่ประวัติได้ว่าทำไมถึงยกเลิก
export const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional().nullable(),
});

// ช่วงเวลาที่เปิดเคส — ปีและเดือนแยกกัน (เดือนใช้ได้ต่อเมื่อระบุปีด้วย)
export const periodSchema = z.object({
  year: z.string().regex(/^\d{4}$/, 'ปีต้องเป็นตัวเลข 4 หลัก (ค.ศ.)').optional(),
  month: z.string().regex(/^(0[1-9]|1[0-2])$/, 'เดือนต้องเป็น 01–12').optional(),
});

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(CASE_STATUSES).optional(),
  case_type: z.enum(CASE_TYPES).optional(),
  assigned_to: z.string().trim().optional(),
  year: z.string().regex(/^\d{4}$/).optional(),
  month: z.string().regex(/^(0[1-9]|1[0-2])$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['case_id', 'title', 'start_date', 'created_at']).default('case_id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
