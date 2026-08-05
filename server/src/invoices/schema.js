import { z } from 'zod';

export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'cancelled'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');
const optionalText = z.string().trim().max(500).optional().nullable();
const money = z.number().nonnegative('จำนวนเงินต้องไม่ติดลบ');

/**
 * สร้างใบแจ้งหนี้ — ปกติสร้างจากเคส (ส่ง case_id มา) แล้ว server คัดลอกชื่อผู้จ่าย/ที่อยู่/ค่าบริการมาให้เอง
 * ช่องที่ส่งมาเองจะทับค่าที่คัดลอกมา (เผื่อกรณีอยากแก้ข้อความบนใบก่อนออก)
 */
export const createInvoiceSchema = z.object({
  case_id: z.string().trim().min(1, 'กรุณาเลือกเคสที่จะออกใบแจ้งหนี้'),

  issue_date: date.optional(),   // ไม่ส่ง = วันนี้
  due_date: date.optional().nullable(),

  // ทับค่าที่คัดลอกมาจากเคส/ลูกค้าได้ ถ้าไม่ส่งมาก็ใช้ของเดิม
  bill_to_name: z.string().trim().max(200).optional().nullable(),
  bill_to_tax_id: z.string().trim().max(20).optional().nullable(),
  bill_to_address: z.string().trim().max(500).optional().nullable(),
  service_description: z.string().trim().max(500).optional().nullable(),

  amount: money.optional().nullable(),
  discount: money.optional().nullable(),

  payment_method: optionalText,
  note: optionalText,
});

/** แก้ได้เฉพาะตอนยังเป็นร่าง (เช็คที่ชั้น route) — สถานะเปลี่ยนผ่าน endpoint เฉพาะเท่านั้น */
export const updateInvoiceSchema = z
  .object({
    issue_date: date,
    due_date: date.nullable(),
    bill_to_name: z.string().trim().min(1, 'กรุณากรอกชื่อผู้จ่าย').max(200),
    bill_to_tax_id: z.string().trim().max(20).nullable(),
    bill_to_address: z.string().trim().max(500).nullable(),
    service_description: z.string().trim().min(1, 'กรุณากรอกรายการบริการ').max(500),
    amount: money,
    discount: money,
    payment_method: optionalText,
    note: optionalText,
  })
  .partial();

/** บันทึกการชำระเงิน */
export const paySchema = z.object({
  paid_at: date.optional(),          // ไม่ส่ง = วันนี้
  payment_method: optionalText,
});

/**
 * กราฟรายได้ — bucket = ความละเอียดของแกนเวลา · points = จำนวนช่องย้อนหลัง (รวมช่องปัจจุบัน)
 * ปริยายต่างกันตาม bucket: รายวันดู 30 วัน · รายสัปดาห์ดู 12 สัปดาห์ (ยาวพอเห็นแนวโน้ม ไม่แน่นเกินอ่าน)
 */
export const revenueQuerySchema = z
  .object({
    bucket: z.enum(['day', 'week']).default('day'),
    points: z.coerce.number().int().min(2).max(90).optional(),
  })
  .transform((q) => ({ ...q, points: q.points ?? (q.bucket === 'week' ? 12 : 30) }));

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  customer_id: z.string().trim().optional(),
  case_id: z.string().trim().optional(),
  // 'yes' = เฉพาะใบที่ออกไปแล้วและเลยวันครบกำหนด — คิดสดจากวันที่ ไม่ใช่สถานะใน DB
  overdue: z.enum(['yes']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['invoice_id', 'issue_date', 'total', 'created_at']).default('invoice_id'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
