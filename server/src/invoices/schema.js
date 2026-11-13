import { z } from 'zod';
import { zodDate, zodPastDate } from '../lib/dates.js';
import { imageSchema } from '../employees/schema.js';

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
  /* ไม่ส่ง = วันนี้ · ส่งมาได้เฉพาะวันที่ผ่านมาแล้ว (ลูกค้าโอนเมื่อวาน เพิ่งมาลงวันนี้)
     วันในอนาคตไม่ใช่ "เงินที่รับมาแล้ว" และกราฟรายได้กางถึงแค่วันนี้ (ดู revenue())
     เงินก้อนนั้นจึงหายจากรายงานทุกช่วงเงียบ ๆ ทั้งที่ใบขึ้นว่าชำระครบ */
  paid_at: zodPastDate(z).optional(),
  payment_method: optionalText,
  note: optionalText,
  // กรอกเมื่อทีมกด "ยืนยันรับเงินตามสลิปนี้" — server จะเปลี่ยนสลิป pending เป็น confirmed ใน transaction เดียวกัน
  slip_id: z.number().int().positive().optional().nullable(),
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
  // 'yes' = เฉพาะใบที่ยอด/ชื่อผู้จ่ายไม่ตรงกับเคสแล้ว (ตัวกรองของกระดิ่งแจ้งเตือน)
  stale: z.enum(['yes']).optional(),
  // 'yes' = เฉพาะใบร่างที่ค้างเกินเกณฑ์วัน (ตัวกรองของกระดิ่ง — เกณฑ์อยู่ใน invoices/repo.js)
  draft_stale: z.enum(['yes']).optional(),
  // 'yes' = ใบที่มีสลิปลูกค้ารอทีมการเงินตรวจอย่างน้อยหนึ่งใบ
  pending_slip: z.enum(['yes']).optional(),
  // 'yes' = ไม่แสดงใบที่ยกเลิก (ยกเว้นเลือกสถานะยกเลิกตรง ๆ) — ใบยกเลิกลบไม่ได้เพราะเลขที่ต้องต่อเนื่อง
  hide_cancelled: z.enum(['yes']).optional(),
  // ประเภทบริการของเคสต้นทาง — ใบที่ไม่ผูกเคสนับเป็น Homecare (ใบกายภาพออกจากเคสกายภาพเสมอ)
  service_kind: z.enum(['homecare', 'physio']).optional(),
  // ช่วงวันที่ออกใบ (รวมสองปลาย) — ใช้กับไฟล์ CSV รายวัน/สัปดาห์/เดือน · ใช้กับรายการปกติได้ด้วย
  issued_from: date.optional(),
  issued_to: date.optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['invoice_id', 'issue_date', 'total', 'created_at']).default('invoice_id'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// ---------- สลิปโอนเงิน ----------
/* ยกเลิกรายการรับชำระที่บันทึกผิด — บังคับให้พิมพ์เหตุผล เพราะนี่คือการลบเงินออกจากรายได้
   ข้อความนี้ไปอยู่ในประวัติ invoice_payment_voids ให้คนที่มาตรวจบัญชีทีหลังอ่าน */
export const voidPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'กรุณาบอกเหตุผลที่ยกเลิกรายการนี้ (เช่น กรอกยอดผิด · บันทึกซ้ำ)').max(300),
});

/**
 * ใบลดหนี้ (credit) / ใบเพิ่มหนี้ (debit) ของใบที่ออกแล้ว — ใบที่ออกแล้วแก้ยอดตรง ๆ ไม่ได้ (ดู invoices/ledger.js)
 * items = รายการที่ลด/เพิ่ม ไว้พิมพ์บนใบ (ไม่บังคับ) · ref_receipt_id = ใบเสร็จที่อ้างถึง (ไม่บังคับ)
 * refund = ข้อมูลการโอนคืน ต้องส่งมาเมื่อลดหนี้แล้วเงินที่รับไว้เกินยอดใหม่ (server คิดยอดคืนเอง ไม่รับจากหน้าเว็บ)
 */
/**
 * ประเภทของใบลดหนี้/เพิ่มหนี้ — ใช้แยกยอดในรายงาน (ส่วนลดจริงกับหนี้สูญต้องไม่ปนกัน)
 * bad_debt มีกติกาของตัวเอง: ลดได้ไม่เกินยอดค้าง และลดจนเหลือ 0 ได้ (ดู assessAdjustment)
 * ต้องตรงกับ CHECK ของ invoice_adjustments.reason_code
 */
export const ADJUSTMENT_REASONS = Object.freeze({
  credit: ['discount', 'correction', 'not_rendered', 'bad_debt', 'other'],
  debit: ['extra_service', 'correction', 'other'],
});

export const adjustmentSchema = z.object({
  kind: z.enum(['credit', 'debit'], { errorMap: () => ({ message: 'ชนิดเอกสารต้องเป็นใบลดหนี้หรือใบเพิ่มหนี้' }) }),
  reason_code: z.enum(['discount', 'correction', 'not_rendered', 'bad_debt', 'extra_service', 'other']).default('other'),
  amount: money.positive('จำนวนเงินต้องมากกว่า 0'),
  reason: z.string().trim().min(3, 'กรุณาบอกเหตุผล (เช่น ยกเลิกกะ 2 วัน · เพิ่มหัตถการ)').max(300),
  items: z
    .array(z.object({ description: z.string().trim().min(1).max(200), amount: money }))
    .max(50)
    .optional(),
  ref_receipt_id: z.string().trim().max(40).optional().nullable(),
  // กันออกเอกสารซ้ำเมื่อกดซ้ำหลังหมดเวลา — หน้าเว็บส่งรหัสเดิมทุกครั้งที่กดในฟอร์มเดิม (ดู ledger.js)
  request_id: z.string().uuid('รหัสคำขอไม่ถูกต้อง').optional(),
  refund: z
    .object({
      refunded_at: zodPastDate(z).optional(),
      method: optionalText,
      note: optionalText,
    })
    .optional()
    .nullable(),
}).superRefine((v, ctx) => {
  if (!ADJUSTMENT_REASONS[v.kind].includes(v.reason_code)) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason_code'],
      message: v.kind === 'credit' ? 'ประเภทนี้ใช้กับใบลดหนี้ไม่ได้' : 'ประเภทนี้ใช้กับใบเพิ่มหนี้ไม่ได้',
    });
  }
});

/** ยกเลิกใบแจ้งหนี้ — ต้องมีเหตุผลเสมอ (เก็บไว้กับใบ คู่กับชื่อคนที่ยกเลิก) */
/* ปิดลิงก์บิลสาธารณะ — ไม่ระบุ token_hash = ปิดทุกลิงก์ที่ยังเปิดได้ของใบนั้น
   (Codex ข้อ 10 · 8 พ.ย. 2569 · อายุ 180 วันคงเดิมตามคำเคาะ ดร. 24 ต.ค. 2569) */
export const revokeShareSchema = z.object({
  token_hash: z.string().trim().regex(/^[0-9a-f]{64}$/, 'รหัสลิงก์ไม่ถูกต้อง').optional().nullable(),
  reason: z.string().trim().max(300).optional().nullable(),
});

export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(3, 'กรุณาบอกเหตุผลที่ยกเลิกใบนี้').max(300),
});

export const cancelAdjustmentSchema = z.object({
  reason: z.string().trim().min(3, 'กรุณาบอกเหตุผลที่ยกเลิกเอกสารนี้').max(300),
});

/** แก้ข้อมูลเงินคืนที่กรอกผิด — ยอดเงินแก้ไม่ได้ (ดู updateRefundForTransaction) */
export const updateRefundSchema = z
  .object({
    refunded_at: zodPastDate(z),
    method: optionalText,
    note: optionalText,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'ไม่มีข้อมูลที่จะแก้' });

export const slipSchema = z.object({ image: imageSchema });

export const rejectSlipSchema = z.object({
  reason: z.string().trim().min(3).max(300).optional().nullable(),
});
