import { z } from 'zod';
import { zodDate } from '../lib/dates.js';

export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'cancelled'];

// วันที่ต้องมีอยู่จริงในปฏิทิน ไม่ใช่แค่รูปแบบถูก (2026-02-31 เคยผ่านได้ — ดู lib/dates.js)
const date = zodDate(z);
const optionalText = z.string().trim().max(500).optional().nullable();
const money = z
  .number()
  .nonnegative('จำนวนเงินต้องไม่ติดลบ')
  .multipleOf(0.01, 'จำนวนเงินต้องมีทศนิยมไม่เกิน 2 ตำแหน่ง');

/**
 * สร้างใบแจ้งหนี้ — ปกติสร้างจากเคส (ส่ง case_id มา) แล้ว server คัดลอกชื่อผู้จ่าย/ที่อยู่/ค่าบริการมาให้เอง
 * ช่องที่ส่งมาเองจะทับค่าที่คัดลอกมา (เผื่อกรณีอยากแก้ข้อความบนใบก่อนออก)
 */
export const createInvoiceSchema = z.object({
  case_id: z.string().trim().min(1, 'กรุณาเลือกเคสที่จะออกใบแจ้งหนี้'),

  /**
   * ฐานการคิดเงินของใบนี้
   * 'package' (ปริยาย) = ทั้งแพ็คเกจเป็นบรรทัดเดียวตามค่าบริการของเคส
   * 'visits'            = แตกเป็นรายครั้งจากกะที่ไปมาแล้วจริง (ใช้กับเคสที่ตกลงกันเป็นรายครั้ง
   *                       หรือเก็บเงินระหว่างทางก่อนเคสจบ) · from/to = จำกัดช่วงวันของกะที่เอามาคิด
   */
  basis: z.enum(['package', 'visits']).optional(),
  from: date.optional(),
  to: date.optional(),

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

/**
 * บันทึกการรับชำระหนึ่งงวด
 *
 * amount ว่าง = รับเต็มยอดที่ค้างอยู่ (พฤติกรรมเดิมของปุ่ม "ยืนยันรับชำระ")
 * ส่งมาน้อยกว่ายอดค้าง = รับบางส่วน (เช่น มัดจำงวดแรก) ใบยังไม่ปิดจนกว่าจะครบ
 * ยอดที่รับต้องมากกว่า 0 — งวดที่รับ 0 บาทไม่มีความหมาย มีแต่จะทำให้รายการรับเงินรก
 */
export const paySchema = z.object({
  request_id: z.string().uuid('รหัสคำขอรับชำระไม่ถูกต้อง'),
  amount: money.positive('จำนวนเงินที่รับต้องมากกว่า 0').optional().nullable(),
  paid_at: date.optional(),          // ไม่ส่ง = วันนี้
  payment_method: optionalText,
  note: optionalText,
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

/**
 * เลือกวิธีเก็บเงินของใบที่ยังไม่ได้ใช้เป็นเอกสาร
 *   full    = เก็บครั้งเดียวจบ (ใบนี้คือยอดเต็ม)
 *   deposit = แบ่งเป็นใบมัดจำ + ใบส่วนที่เหลือ · deposit_amount ต้องน้อยกว่ายอดเต็ม
 *             (เท่ากับยอดเต็ม = ไม่ใช่การมัดจำ แต่คือเก็บเต็มจำนวน ซึ่งมีตัวเลือกของมันอยู่แล้ว)
 */
export const billingPlanSchema = z
  .object({
    mode: z.enum(['full', 'deposit'], { errorMap: () => ({ message: 'วิธีเก็บเงินไม่ถูกต้อง' }) }),
    deposit_amount: money.positive('ยอดมัดจำต้องมากกว่า 0').optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'deposit' && v.deposit_amount == null) {
      ctx.addIssue({ code: 'custom', path: ['deposit_amount'], message: 'กรุณากรอกยอดมัดจำ' });
    }
  });

/**
 * แก้ยอดมัดจำของแผนที่แบ่งใบไปแล้ว — ยอดเต็มของแผนไม่เปลี่ยน ใบส่วนที่เหลือถูกคิดใหม่ให้ผลรวมเท่าเดิม
 * มัดจำ 0 บาทไม่มีอยู่จริง (เท่ากับไม่ได้แบ่งใบตั้งแต่แรก) จึงต้องมากกว่า 0 เหมือนตอนแบ่งงวดครั้งแรก
 */
export const depositAmountSchema = z.object({
  deposit_amount: money.positive('ยอดมัดจำต้องมากกว่า 0'),
});

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
