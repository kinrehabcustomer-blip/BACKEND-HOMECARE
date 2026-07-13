import { z } from 'zod';

export const POSITIONS = ['caregiver', 'nurse', 'assistant_nurse', 'therapist', 'admin', 'driver', 'manager'];
export const EMPLOYMENT_TYPES = ['fulltime', 'parttime', 'contract', 'daily'];
export const STATUSES = ['active', 'probation', 'on_leave', 'suspended', 'resigned'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');
const optionalText = z.string().trim().max(500).optional().nullable();

export const createEmployeeSchema = z.object({
  first_name: z.string().trim().min(1, 'กรุณากรอกชื่อ').max(100),
  last_name: z.string().trim().min(1, 'กรุณากรอกนามสกุล').max(100),
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

export const certificateSchema = z.object({
  name: z.string().trim().min(1, 'กรุณากรอกชื่อใบรับรอง').max(200),
  issuer: optionalText,
  issued_date: date.optional().nullable(),
  expiry_date: date.optional().nullable(),
});
