import { sql, nextInvoiceId, transaction } from '../db/index.js';

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;
/* วันนี้ตามเวลาไทย ไม่ใช่ UTC — ใช้กับวันที่ออกใบ/วันรับชำระ/เกณฑ์เลยกำหนด
   ของเดิมใช้ UTC ทำให้ทุกอย่างที่ทำระหว่างเที่ยงคืนถึงตีเจ็ดถูกลงวันที่เป็นเมื่อวาน
   (ออกใบตีสองของวันที่ 1 ได้ issue_date เป็นวันที่ 31 ของเดือนก่อน — ผิดทั้งเอกสารและรอบบัญชี) */
const TODAY = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);
const roundMoney = (n) => Math.round(Number(n) * 100) / 100;

const ACTION_STATES = Object.freeze({
  update: ['draft', 'issued'],
  issue: ['draft'],
  billing_plan: ['draft'],
  cancel: ['draft', 'issued', 'paid'],
});

/** กติกาสถานะของทุกคำสั่งที่แก้ invoice — ต้องตัดสินจากแถวที่ล็อกแล้วเท่านั้น */
export function assessInvoiceAction(action, status) {
  const allowed = ACTION_STATES[action];
  if (!allowed) throw new Error(`ไม่รู้จักคำสั่ง invoice action: ${action}`);
  return allowed.includes(status) ? { status } : { reason: 'invalid_status', status };
}

/** ล็อก invoice เดี่ยว แล้วอ่านสถานะ/โครงสร้างล่าสุดสำหรับคำสั่งนั้น */
export async function invoiceForUpdate(tx, invoiceId, action) {
  const invoice = await tx.one(
    `SELECT i.*,
            EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id) AS has_items
     FROM invoices i
     WHERE i.invoice_id = :id
     FOR UPDATE OF i`,
    { id: invoiceId },
  );
  if (!invoice) return { reason: 'not_found' };

  const state = assessInvoiceAction(action, invoice.status);
  return state.reason ? { ...state, invoice } : { invoice };
}

/**
 * ล็อกสมาชิกของแผนด้วยลำดับเดียวเสมอ: หา root แบบไม่ล็อก -> ล็อก root -> ล็อก children ตามรหัส
 * ห้ามล็อก target ก่อน เพราะคำขอที่เริ่มจากใบ balance จะเกิดวงจร child -> root กับคำสั่งอื่นได้
 */
export async function invoicePlanForUpdate(tx, invoiceId) {
  const initial = await tx.one(
    `SELECT invoice_id, COALESCE(parent_invoice_id, invoice_id) AS root_id
     FROM invoices WHERE invoice_id = :id`,
    { id: invoiceId },
  );
  if (!initial) return { reason: 'not_found' };

  const root = await tx.one(
    `SELECT * FROM invoices WHERE invoice_id = :root_id FOR UPDATE`,
    { root_id: initial.root_id },
  );
  if (!root || root.parent_invoice_id != null) return { reason: 'state_changed' };

  /* เป็น statement ใหม่หลังได้ root lock เพื่อให้เห็น child ที่คำขอก่อนหน้าเพิ่งสร้างและ commit */
  const children = await tx.all(
    `SELECT * FROM invoices
     WHERE parent_invoice_id = :root_id
     ORDER BY invoice_id
     FOR UPDATE`,
    { root_id: initial.root_id },
  );
  const rows = [root, ...children];
  const target = rows.find((row) => row.invoice_id === invoiceId);
  if (!target || (target.invoice_id !== root.invoice_id && target.parent_invoice_id !== root.invoice_id)) {
    return { reason: 'state_changed' };
  }

  return { root_id: root.invoice_id, root, target, rows };
}

/**
 * ตรวจยอดรับชำระกับสถานะล่าสุดที่อ่านภายใน transaction
 * ผู้เรียกต้องล็อกแถว invoices ก่อน แล้วอ่าน SUM(invoice_payments) ด้วย statement ถัดไป
 * เพื่อให้คำขอที่รอ lock เห็น payment ที่คำขอก่อนหน้าเพิ่ง commit
 */
export function assessPaymentCapacity(status, totalAmount, paidAmount, requestedAmount) {
  const total = roundMoney(totalAmount);
  const paid = roundMoney(paidAmount ?? 0);
  const balance = roundMoney(total - paid);

  if (status === 'cancelled') return { reason: 'cancelled', total, paid, balance };
  if (status === 'paid' || balance <= 0) return { reason: 'fully_paid', total, paid, balance };

  // ไม่ส่งยอดมา = รับยอดคงเหลือ "ล่าสุด" หลังได้ row lock ไม่ใช่ balance เก่าจาก middleware
  const amount = requestedAmount == null ? balance : roundMoney(requestedAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { reason: 'invalid_amount', total, paid, balance, amount };
  }
  if (amount > balance) {
    return { reason: 'amount_exceeds_balance', total, paid, balance, amount };
  }

  return { total, paid, balance, amount };
}

async function paymentInvoiceForUpdate(tx, invoiceId) {
  return tx.one(
    `SELECT invoice_id, total, billing_kind, status
     FROM invoices WHERE invoice_id = :id FOR UPDATE`,
    { id: invoiceId },
  );
}

async function capacityForLockedPayment(tx, invoice, requestedAmount) {
  if (invoice.status === 'cancelled') return { reason: 'cancelled' };
  if (invoice.status === 'paid') return { reason: 'fully_paid' };
  if (invoice.billing_kind == null) return { reason: 'billing_plan_required' };

  /* อ่านยอดที่รับมาแล้วของ "ใบที่เพิ่งล็อก" — ต้องใช้รหัสจากแถวที่ล็อกไว้ ไม่ใช่ตัวแปรนอกสโคป
     (เคยเขียนเป็น invoiceId ซึ่งไม่มีในฟังก์ชันนี้ ทำให้การรับชำระทุกครั้งพังด้วย ReferenceError) */
  const { paid } = await tx.one(
    `SELECT COALESCE(SUM(amount), 0) AS paid
     FROM invoice_payments WHERE invoice_id = :id`,
    { id: invoice.invoice_id },
  );

  const capacity = assessPaymentCapacity(invoice.status, invoice.total, paid, requestedAmount);
  return capacity.reason ? capacity : { invoice, ...capacity };
}

/** อ่านสถานะรับชำระตามลำดับที่ทำให้ row lock ป้องกัน stale balance ได้จริง */
export async function paymentCapacityForUpdate(tx, invoiceId, requestedAmount) {
  const invoice = await paymentInvoiceForUpdate(tx, invoiceId);
  if (!invoice) return { reason: 'not_found' };
  return capacityForLockedPayment(tx, invoice, requestedAmount);
}

/** key เดิมใช้ซ้ำได้เฉพาะเจตนารับเงินชุดเดิม ห้ามเปลี่ยน payload แล้วอาศัย key เก่าทับรายการ */
export function assessPaymentReplay(payment, input, actor) {
  const requested = {
    amount: input.amount == null ? roundMoney(payment.amount) : roundMoney(input.amount),
    paid_at: input.paid_at ?? payment.paid_at,
    method: input.payment_method ?? null,
    note: input.note ?? null,
    received_by: actor?.employee_id ?? null,
  };
  const recorded = {
    amount: roundMoney(payment.amount),
    paid_at: payment.paid_at,
    method: payment.method ?? null,
    note: payment.note ?? null,
    received_by: payment.received_by ?? null,
  };

  const changed_fields = Object.keys(recorded).filter((field) => requested[field] !== recorded[field]);
  return changed_fields.length > 0
    ? { reason: 'idempotency_conflict', changed_fields }
    : { replayed: true, payment_id: payment.payment_id };
}

/**
 * ล็อก invoice ก่อนค้น request_id — คำขอซ้ำที่ยิงพร้อมกันจึงรอคำขอแรก commit แล้วเห็น payment เดิม
 * ต้องค้น key ก่อนเช็คสถานะ paid/cancelled เพราะ retry หลังคำขอแรกปิดยอดแล้วต้อง replay สำเร็จ
 */
export async function paymentRequestForUpdate(tx, invoiceId, input, actor) {
  if (!input.request_id) return { reason: 'request_id_required' };

  const invoice = await paymentInvoiceForUpdate(tx, invoiceId);
  if (!invoice) return { reason: 'not_found' };

  const existing = await tx.one(
    `SELECT payment_id, amount, paid_at, method, note, received_by
     FROM invoice_payments
     WHERE invoice_id = :invoice_id AND request_id = :request_id`,
    { invoice_id: invoiceId, request_id: input.request_id },
  );
  if (existing) {
    const replay = assessPaymentReplay(existing, input, actor);
    return replay.reason ? replay : { invoice, payment: existing, ...replay };
  }

  return capacityForLockedPayment(tx, invoice, input.amount);
}

// ช่องที่แก้ได้ตอนยังเป็นร่าง (สถานะ/ยอดรวมไม่อยู่ในนี้ — total คิดจาก amount-discount เสมอ)
const EDITABLE = [
  'issue_date', 'due_date', 'bill_to_name', 'bill_to_tax_id', 'bill_to_address',
  'service_description', 'amount', 'discount', 'payment_method', 'note',
];

// case_payer_name = ชื่อผู้จ่าย "ที่ควรจะเป็น" ของเคสตอนนี้ ไล่ตามลำดับ:
//   ผู้ว่าจ้างของเคส -> ผู้ว่าจ้างของแฟ้มผู้ป่วย (เผื่อเพิ่งผูกทีหลัง เคสยังไม่มี) -> ชื่อผู้ป่วยในเคส
// ใช้เทียบกับ bill_to_name ในใบ เพื่อรู้ว่าใบยังตรงกับผู้จ่ายปัจจุบันไหม (ดู withComputed.payer_stale)
const SELECT_INVOICE = `
  SELECT i.*,
         EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id) AS has_items,
         /* ยอดที่รับมาแล้วจริง คิดสดจากรายการรับเงินทุกครั้ง ไม่เก็บยอดสะสมซ้ำไว้บนใบ
            (เก็บสองที่แล้ววันหนึ่งจะไม่ตรงกัน เช่น ลบรายการรับเงินแล้วลืมหักยอดสะสม) */
         COALESCE((SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.invoice_id), 0) AS paid_amount,
         c.title       AS case_title,
         c.status      AS case_status,
         c.fee         AS case_fee,
         cu.name       AS customer_name,
         cu.phone      AS customer_phone,
         COALESCE(ccu.name, pcu.name, c.client_name) AS case_payer_name
  FROM invoices i
  LEFT JOIN cases c      ON c.case_id      = i.case_id
  LEFT JOIN customers cu ON cu.customer_id = i.customer_id
  LEFT JOIN customers ccu ON ccu.customer_id = c.customer_id
  LEFT JOIN patients p    ON p.patient_id   = c.patient_id
  LEFT JOIN customers pcu ON pcu.customer_id = p.customer_id
`;

/**
 * ราคาเต็มก่อนลดของเคส — กายภาพใช้ราคาเต็มของแพ็คเกจ · Homecare ใช้ค่าบริการในตารางเรท
 * ว่าง = ไม่ได้ตั้งราคาเต็มไว้ (แพ็คที่ไม่ใช่โปรโมชัน / เคสที่ไม่ได้เลือกบริการ) = ไม่มีส่วนลดให้แสดง
 */
const listPriceOf = (c) =>
  c.service_kind === 'physio' || c.physio_package_id != null
    ? c.physio_original_price
    : c.rate_customer_price;

/**
 * แยกค่าจ้างของเคสเป็น "ยอดก่อนลด + ส่วนลด" เพื่อให้ใบแจ้งหนี้แสดงส่วนลดที่ลูกค้าได้รับ
 *
 * fee ของเคสเป็นราคา "หลังลด" อยู่แล้ว (คัดลอกมาจากราคาสุทธิของแพ็คเกจ/เรท) — ถ้าเอาลงใบตรงๆ
 * บรรทัดส่วนลดจะเป็น 0 เสมอทั้งที่ลูกค้าได้ส่วนลดจริง จึงย้อนกลับด้วยราคาเต็มที่เคสอ้างอิงอยู่
 * ยอดสุทธิ (total) ยังเท่ากับ fee เสมอ — ตัวเลขที่ลูกค้าต้องจ่ายไม่เปลี่ยน แค่แจกแจงที่มาให้เห็น
 *
 * ไม่มีราคาเต็ม หรือราคาเต็มไม่เกินค่าจ้าง (เช่น แก้ค่าจ้างเองให้สูงกว่าราคาตั้ง) = ไม่มีส่วนลด
 */
function priceParts(caseRow) {
  const net = caseRow.fee ?? 0;
  const list = listPriceOf(caseRow);
  return list != null && list > net
    ? { amount: list, discount: list - net }
    : { amount: net, discount: 0 };
}

/**
 * "เกินกำหนดชำระ" คำนวณตอนอ่าน ไม่เก็บเป็นสถานะใน DB
 * เพราะมันเปลี่ยนเองตามวันที่ผ่านไป ถ้าเก็บไว้ต้องมีงานคอยไล่อัปเดตทุกวัน แล้วก็มีโอกาสค้างไม่ตรงจริง
 */
const withComputed = (row) => {
  /*
   * ใบไม่ตรงกับข้อมูลเคสแล้ว — แยกเป็น 2 กรณี เพราะทางแก้/ข้อความที่โชว์ต่างกัน:
   *   fee_stale   = ยอดในใบไม่ตรงกับค่าจ้างของเคส
   *   payer_stale = ชื่อผู้จ่ายในใบไม่ตรงกับผู้จ่ายปัจจุบันของเคส
   *                 (มักเกิดตอนออกใบไปก่อน แล้วเพิ่งมาผูกผู้ว่าจ้างกับผู้ป่วย/เคสทีหลัง)
   * ใบร่างระบบซิงก์ให้เองตอนแก้เคส/ผูกลูกค้า แต่ยังไม่ตรงได้ถ้ามีคนแก้ยอดในใบเอง — จึงเช็คทุกสถานะ
   * แล้วให้หน้าเว็บเลือกทางแก้ตามสถานะ (ร่าง/ออกใบแล้ว = กดรีเฟรช · ชำระแล้ว = ยกเลิกแล้วออกใบใหม่)
   */
  // เทียบกับยอดสุทธิ ไม่ใช่ยอดก่อนลด — amount เป็นราคาเต็มแล้ว ส่วน total คือเงินที่ลูกค้าต้องจ่ายจริง
  // ซึ่งเป็นตัวที่ต้องตรงกับค่าจ้างของเคส (ดู priceParts)
  // ใบที่แตกเป็นรายครั้ง (มี items) ตั้งใจให้ยอดเป็นสัดส่วนของกะที่ไปจริง ไม่ใช่ยอดเต็มของเคส
  // เทียบกับ fee ของเคสแล้วจะขึ้นป้าย "ไม่ตรงกับเคส" ตลอดทั้งที่ถูกต้องอยู่แล้ว
  /* ใบที่เป็นงวดหนึ่งของแผน (มัดจำ/ส่วนที่เหลือ) ตั้งใจให้ยอดน้อยกว่าค่าบริการของเคสอยู่แล้ว
     เทียบกับ fee ของเคสจะขึ้นป้าย "ไม่ตรงกับเคส" ตลอดทั้งที่ถูกต้อง — เกณฑ์เดียวกับใบที่แตกรายครั้ง */
  const isPart = row.billing_kind === 'deposit' || row.billing_kind === 'balance';
  const feeStale =
    !row.has_items && !isPart &&
    row.case_id != null && row.case_fee != null && Number(row.case_fee) !== Number(row.total);
  const payerStale =
    row.case_id != null && row.case_payer_name != null && row.case_payer_name !== row.bill_to_name;

  /* ยอดคงเหลือและ "ยังไม่ครบ" คิดที่นี่ที่เดียว หน้าเว็บจะได้ไม่คำนวณเงินเอง
     ปัดสองตำแหน่งกันเศษทศนิยมลอย (0.1 + 0.2 ของ float) ที่ทำให้ใบจ่ายครบแล้วเหลือค้าง 0.0000001 บาท */
  const paid = Math.round(Number(row.paid_amount ?? 0) * 100) / 100;
  const balance = Math.round((Number(row.total ?? 0) - paid) * 100) / 100;

  return {
    ...row,
    paid_amount: paid,
    balance,
    // รับมาบางส่วนแล้วแต่ยังไม่ครบ — ไม่เก็บเป็นสถานะในฐานข้อมูล คิดตอนอ่านเหมือน "เกินกำหนด"
    is_partial: row.status !== 'cancelled' && paid > 0 && balance > 0,
    // ใบที่ระบบเตรียมไว้ตอนเปิดเคส แต่ยังไม่ได้เลือกว่าจะเก็บเต็มจำนวนหรือแบ่งมัดจำ
    // ยังไม่ใช่เอกสาร — หน้าเว็บจะให้เลือกวิธีเก็บเงินก่อน แล้วค่อยแสดงตัวใบ
    needs_plan: row.status === 'draft' && row.billing_kind == null,
    is_plan_part: isPart,
    is_overdue: row.status === 'issued' && row.due_date != null && row.due_date < TODAY(),
    fee_stale: feeStale,
    payer_stale: payerStale,
    is_stale: feeStale || payerStale,
  };
};

/**
 * เงื่อนไขกรองที่ใช้ร่วมกันระหว่างรายการกับยอดสรุป — ต้องเป็นก้อนเดียวกันจริงๆ
 * ไม่งั้นตัวเลขสรุปด้านบนจะไม่ตรงกับรายการที่เห็นข้างล่าง (เช่น กรอง "ชำระแล้ว" แต่ยังขึ้น "รอชำระ 5 ใบ")
 */
function buildWhere({ q, status, customer_id, case_id, overdue }) {
  const where = [];
  const params = {};

  if (q) {
    where.push('(i.invoice_id ILIKE :q OR i.bill_to_name ILIKE :q OR i.case_id ILIKE :q)');
    params.q = `%${q}%`;
  }
  if (status) {
    where.push('i.status = :status');
    params.status = status;
  }
  if (customer_id) {
    where.push('i.customer_id = :customer_id');
    params.customer_id = customer_id;
  }
  if (case_id) {
    where.push('i.case_id = :case_id');
    params.case_id = case_id;
  }
  // "เกินกำหนด" ไม่ใช่สถานะใน DB — คิดสดจากวันครบกำหนดที่ผ่านมาแล้ว (นิยามเดียวกับ withComputed)
  if (overdue === 'yes') {
    where.push("i.status = 'issued' AND i.due_date IS NOT NULL AND i.due_date < :today");
    params.today = TODAY();
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function list({ q, status, customer_id, case_id, overdue, page, per_page, sort, order }) {
  const { clause, params } = buildWhere({ q, status, customer_id, case_id, overdue });
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM invoices i ${clause}`, params);

  // NULLS LAST — due_date/paid_at ว่างได้ ถ้าไม่ใส่ การเรียงจากมากไปน้อยจะเอาใบที่ยังไม่ได้ระบุขึ้นก่อน
  const rows = await sql.all(
    `${SELECT_INVOICE} ${clause}
     ORDER BY i.${sort} ${order.toUpperCase()} NULLS LAST
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return {
    data: rows.map(withComputed),
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

/**
 * ใบเดี่ยว + รายการย่อย — หน้ารายการไม่ต้องใช้ items จึงดึงเฉพาะตอนเปิดดูใบจริง
 * items ว่าง = ใบแบบแพ็คเกจบรรทัดเดียว (ส่วนใหญ่เป็นแบบนี้)
 */
export const findById = async (id) => {
  const row = await sql.one(`${SELECT_INVOICE} WHERE i.invoice_id = :id`, { id });
  if (!row) return null;
  const [items, payments] = await Promise.all([listItems(id), listPayments(id)]);
  return withComputed({ ...row, items, payments });
};

/** หลัง commit อาจมีคำขออื่นลบใบก่อน SELECT ตอบกลับ — แปลงเป็น conflict แทนการคืน null/เกิด TypeError ที่ route */
export async function invoiceMutationResult(result, loadInvoice = findById) {
  if (result.reason) return result;
  return (await loadInvoice(result.invoice_id)) ?? { reason: 'state_changed' };
}

// ใบแจ้งหนี้ของลูกค้ารายหนึ่งดึงผ่าน list({ customer_id }) ซึ่งมีตัวกรอง/แบ่งหน้าครบอยู่แล้ว
// เคยมี listForCustomer แยกไว้ที่นี่แต่ไม่มีใครเรียก — ลบทิ้งแล้ว

/** ใบแจ้งหนี้ของเคสหนึ่งใบ — เคสหนึ่งออกได้ใบเดียว แต่ถ้ายกเลิกแล้วออกใหม่ได้ จึงคืนเป็นรายการ */
export const listForCase = (caseId) =>
  sql
    .all(`${SELECT_INVOICE} WHERE i.case_id = :id ORDER BY i.invoice_id DESC`, { id: caseId })
    .then((rows) => rows.map(withComputed));

/**
 * ใบร่างที่ยังค้างอยู่ของเคส — เคสหนึ่งมีใบร่างได้ทีละใบเท่านั้น
 *
 * ใบร่างคือเอกสารที่ยังไม่ได้ส่งให้ใคร มีสองใบพร้อมกันเมื่อไหร่ก็ไม่มีทางรู้ว่าใบไหนคือใบจริง
 * แถมใบร่างซิงก์ตามเคสให้เองทั้งคู่ (ดู syncOpenFromCase) จึงกลายเป็นใบเหมือนกันเป๊ะสองใบ
 * ต่างจากใบที่ออก/ชำระแล้วซึ่งมีหลายใบต่อเคสได้ตามปกติ (เก็บเป็นงวด หรือออกตามกะที่ไปจริง)
 */
export const findDraftForCase = (caseId) =>
  sql.one(
    `SELECT invoice_id FROM invoices
     WHERE case_id = :id AND status = 'draft'
     ORDER BY invoice_id LIMIT 1`,
    { id: caseId },
  );

/** การรับชำระของใบ เรียงตามลำดับที่รับจริง — งวดแรกอยู่บน (มัดจำมักเป็นงวดแรก) */
export const listPayments = (invoiceId) =>
  sql.all(
    `SELECT payment_id, amount, paid_at, is_deposit, method, note, received_by_name, created_at
     FROM invoice_payments WHERE invoice_id = :id ORDER BY payment_id`,
    { id: invoiceId },
  );

/** รายการย่อยของใบ (ว่าง = ใบแบบแพ็คเกจบรรทัดเดียวตามปกติ) */
export const listItems = (invoiceId) =>
  sql.all(
    `SELECT seq, description, quantity, unit_price, amount
     FROM invoice_items WHERE invoice_id = :id ORDER BY seq`,
    { id: invoiceId },
  );

/**
 * แตกใบเป็นรายการรายครั้งจาก "กะที่ไปมาแล้วจริง" ของเคส
 *
 * ราคาต่อครั้ง = ค่าบริการของเคส ÷ จำนวนกะที่นัดไว้ทั้งหมด (นิยามเดียวกับการเกลี่ยค่าจ้างพนักงาน)
 * บรรทัดสุดท้ายรับเศษที่ปัดทิ้งไป ผลรวมจึงเท่ากับยอดที่ตั้งใจเก็บเป๊ะ ไม่ขาดไม่เกินสตางค์
 * ไม่มีกะที่ทำเสร็จเลย = ออกใบแบบนี้ไม่ได้ (ให้ผู้เรียกตัดสินใจต่อ)
 */
export async function visitLines(caseRow, { from, to } = {}) {
  const where = ['v.case_id = :id', 'v.check_out_at IS NOT NULL'];
  const params = { id: caseRow.case_id };
  if (from) {
    where.push('v.visit_date >= :from');
    params.from = from;
  }
  if (to) {
    where.push('v.visit_date <= :to');
    params.to = to;
  }

  const [visits, booked] = await Promise.all([
    sql.all(
      `SELECT v.visit_date, v.planned_start, v.planned_end,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM case_visits v
       LEFT JOIN employees e ON e.employee_id = v.checked_in_by
       WHERE ${where.join(' AND ')}
       ORDER BY v.visit_date, v.planned_start NULLS FIRST, v.visit_id`,
      params,
    ),
    sql.one(
      `SELECT COUNT(*) AS n FROM case_visits WHERE case_id = :id AND status <> 'cancelled'`,
      { id: caseRow.case_id },
    ),
  ]);

  if (visits.length === 0) return { lines: [], amount: 0 };

  const perVisit = Number(booked.n) > 0 ? (caseRow.fee ?? 0) / Number(booked.n) : 0;
  const rounded = Math.round(perVisit * 100) / 100;
  // เก็บเฉพาะครั้งที่ไปจริง — ยอดรวมจึงเป็นสัดส่วนของกะที่ทำ ไม่ใช่ทั้งแพ็คเกจ
  const total = Math.round(rounded * visits.length * 100) / 100;

  const lines = visits.map((v, i) => ({
    seq: i + 1,
    description: [
      `${v.visit_date}`,
      [v.planned_start, v.planned_end].filter(Boolean).join('-'),
      v.employee_name,
    ]
      .filter(Boolean)
      .join(' · '),
    quantity: 1,
    unit_price: rounded,
    // บรรทัดสุดท้ายกลืนเศษการปัดของทุกบรรทัดก่อนหน้า
    amount: i === visits.length - 1 ? Math.round((total - rounded * i) * 100) / 100 : rounded,
  }));

  return { lines, amount: total };
}

/**
 * สร้างใบแจ้งหนี้จากเคส — คัดลอกข้อมูลผู้จ่ายและค่าบริการ ณ ตอนนี้มาเก็บไว้ในใบ
 * ไม่ผูกอ่านสด เพราะใบที่ออกไปแล้วต้องคงเดิมแม้ลูกค้าจะย้ายบ้านหรือเคสจะถูกแก้ราคา
 *
 * items = รายการรายครั้งที่ route เตรียมมาให้ (ออกใบตามกะที่ไปจริง) — ไม่ส่งมา = ใบแบบแพ็คเกจตามเดิม
 */
export function createFromCase(caseRow, input, actor, items = []) {
  const customer = caseRow.customer ?? null;

  // ยอดก่อนลด + ส่วนลด แจกแจงมาจากราคาเต็มที่เคสอ้างอิงอยู่ (ดู priceParts)
  // ส่งยอดมาเองก็ให้ส่วนลดเป็นของผู้เรียกล้วนๆ ไม่เดาจากราคาตั้งของเคส จะได้ไม่ขัดกับยอดที่ตั้งใจ
  // ใบที่แตกเป็นรายครั้งใช้ผลรวมของรายการเป็นยอดก่อนลด — ราคาตั้งของแพ็คเกจไม่เกี่ยวแล้ว
  const auto = items.length > 0
    ? { amount: items.reduce((s, i) => s + i.amount, 0), discount: 0 }
    : priceParts(caseRow);
  const amount = input.amount ?? auto.amount;
  const discount = input.discount ?? (input.amount != null ? 0 : auto.discount);

  const values = {
    case_id: caseRow.case_id,
    // ผู้ว่าจ้างที่ route หามาให้ (อาจมาจากแฟ้มผู้ป่วยถ้าเคสยังไม่มี) — ต้องตรงกับ bill_to ด้านล่าง
    // ไม่งั้น "รหัสลูกค้า" ว่างแต่ชื่อขึ้น หรือกลับกัน
    customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
    issue_date: input.issue_date ?? TODAY(),
    due_date: input.due_date ?? null,

    bill_to_name: input.bill_to_name ?? customer?.name ?? caseRow.client_name,
    bill_to_tax_id: input.bill_to_tax_id ?? customer?.tax_id ?? null,
    bill_to_address:
      input.bill_to_address ?? customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,

    service_description: input.service_description ?? describeService(caseRow),
    amount,
    discount,
    total: Math.max(0, amount - discount),

    payment_method: input.payment_method ?? null,
    note: input.note ?? null,

    // พนักงานที่กดออกใบ — เก็บชื่อ ณ ตอนนั้นไว้เลย ใบจะได้ไม่เปลี่ยนชื่อผู้ทำรายการทีหลัง
    issued_by: actor?.employee_id ?? null,
    issued_by_name: actor?.name ?? null,
  };

  return transaction(async (tx) => {
    const invoiceId = await nextInvoiceId(tx);
    await tx.one(
      `INSERT INTO invoices
         (invoice_id, case_id, customer_id, issue_date, due_date,
          bill_to_name, bill_to_tax_id, bill_to_address,
          service_description, amount, discount, total, payment_method, note,
          issued_by, issued_by_name)
       VALUES
         (:invoice_id, :case_id, :customer_id, :issue_date, :due_date,
          :bill_to_name, :bill_to_tax_id, :bill_to_address,
          :service_description, :amount, :discount, :total, :payment_method, :note,
          :issued_by, :issued_by_name)
       RETURNING invoice_id`,
      { ...values, invoice_id: invoiceId },
    );

    for (const line of items) {
      await tx.run(
        `INSERT INTO invoice_items (invoice_id, seq, description, quantity, unit_price, amount)
         VALUES (:invoice_id, :seq, :description, :quantity, :unit_price, :amount)`,
        { ...line, invoice_id: invoiceId },
      );
    }

    return invoiceId;
  }).then(findById);
}

// ใบที่ยัง "แก้ได้" — เอกสารยังอยู่ในมือเรา ยังไม่ได้ส่งมอบให้ลูกค้าจริง
// ชำระแล้ว = เงินเข้ามือแล้ว ยอดกลายเป็นข้อเท็จจริง · ยกเลิกแล้ว = จบไปแล้ว ทั้งคู่จึงไม่แตะ
const OPEN_STATUSES = "('draft', 'issued')";

/**
 * เคสถูกแก้ -> ดึงข้อมูลใหม่ลงใบที่ยังแก้ได้ของเคสนั้นให้ตรงกัน
 *
 * ยอดก่อนลด/ส่วนลด ถูกคิดใหม่ทั้งคู่จากราคาของเคส (ดู priceParts) — ทับค่าเดิมในใบ
 * เพราะสองตัวนี้เป็นคู่กัน ถ้าอัปเดตแค่ตัวเดียวยอดสุทธิจะเพี้ยนทันที
 */
export async function syncOpenFromCase(caseRow, customer) {
  const price = priceParts(caseRow);

  /* ::double precision ในบรรทัด total ไม่ใช่ของประดับ — node-postgres ส่งพารามิเตอร์มาโดยไม่ระบุชนิด
     พอเขียน ":amount - :discount" ตรงๆ Postgres เจอ unknown ลบ unknown แล้วเลือกไม่ถูกว่าจะใช้
     ตัวลบของชนิดไหน (int/numeric/date/…) จึงโยน "operator is not unique: unknown - unknown"
     ตั้งแต่ตอน parse — คือพังทุกครั้งที่บันทึกเคส ไม่ว่าจะมีใบแจ้งหนี้ให้ซิงก์อยู่จริงหรือไม่
     เพราะ Postgres ตรวจไวยากรณ์ก่อนดูว่า WHERE ตรงกับแถวไหนบ้าง

     บรรทัด total ใน update() ด้านล่างเขียนคล้ายกันแต่ไม่เจอปัญหา เพราะห่อด้วย COALESCE คู่กับคอลัมน์
     คอลัมน์จึงบอกชนิดให้พารามิเตอร์ไปแล้ว — ต่างกันแค่นั้น

     หมายเหตุ: ห้ามเขียนคอมเมนต์ที่มีข้อความหน้าตาแบบ :ชื่อ ไว้ในสตริง SQL —
     ตัวแปลง :name เป็น $n ใน db/index.js ข้ามแค่ string literal กับ cast ไม่ได้ข้ามคอมเมนต์ของ SQL
     ข้อความในคอมเมนต์จึงถูกนับเป็นพารามิเตอร์ไปด้วย แล้วลำดับ $n จะเพี้ยนทั้งคำสั่ง */
  const changed = await sql.run(
    `UPDATE invoices
     SET customer_id         = :customer_id,
         bill_to_name        = :bill_to_name,
         bill_to_tax_id      = :bill_to_tax_id,
         bill_to_address     = :bill_to_address,
         service_description = :service_description,
         amount              = :amount,
         discount            = :discount,
         total               = GREATEST(0, :amount::double precision - :discount::double precision),
         updated_at          = ${NOW}
     WHERE case_id = :case_id AND status IN ${OPEN_STATUSES}
       /* ใบมัดจำ/ใบส่วนที่เหลือมียอดของงวดนั้นโดยเฉพาะ ซิงก์ทับจะกลายเป็นยอดเต็มทั้งสองใบ
          (ผู้จ่าย/ที่อยู่ก็ไม่ทับด้วย เพราะคำสั่งเดียวกัน — แก้ที่ใบเองหรือลบแล้วแบ่งใหม่) */
       AND billing_kind IS DISTINCT FROM 'deposit'
       AND billing_kind IS DISTINCT FROM 'balance'
       AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = invoices.invoice_id)`,
    {
      case_id: caseRow.case_id,
      customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
      bill_to_name: customer?.name ?? caseRow.client_name,
      bill_to_tax_id: customer?.tax_id ?? null,
      bill_to_address:
        customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,
      service_description: describeService(caseRow),
      amount: price.amount,
      discount: price.discount,
    },
  );
  return changed;
}

/** ข้อความรายการบริการบนใบ — ประกอบจากสิ่งที่เคสเลือกไว้ */
function describeService(c) {
  /* แพ็คเกจกายภาพที่นี่ตั้งชื่อตามจำนวนครั้งอยู่แล้ว ("แพ็ค 20 ครั้ง", "10 ครั้ง 3 เดือน")
     เติม "· 20 ครั้ง" ต่อท้ายอีกจึงได้ "แพ็ค 20 ครั้ง · 20 ครั้ง" ซึ่งซ้ำคำเปล่าๆ
     และกินที่จนรายการโดน … ตัดกลางคำในตาราง — เติมเฉพาะตอนชื่อยังไม่ได้บอกจำนวนครั้งไว้ */
  const sessions =
    c.physio_sessions && !String(c.physio_package_name ?? '').includes(`${c.physio_sessions} ครั้ง`)
      ? `${c.physio_sessions} ครั้ง`
      : null;

  const parts =
    c.service_kind === 'physio'
      ? [c.physio_package_name, sessions]
      : [c.format_name, c.grade_name, c.pkg_staff_tier];

  const service = parts.filter(Boolean).join(' · ');
  return [service || c.title, c.client_name && `ผู้รับบริการ: ${c.client_name}`]
    .filter(Boolean)
    .join(' — ');
}

export async function updateInvoiceForTransaction(tx, invoiceId, input) {
  const fields = EDITABLE.filter((c) => c in input);
  const locked = await invoiceForUpdate(tx, invoiceId, 'update');
  if (locked.reason) return locked;
  const invoice = locked.invoice;

  if (fields.length === 0) return { invoice_id: invoiceId };

  const changesAmount = 'amount' in input || 'discount' in input;
  if (
    changesAmount &&
    (invoice.parent_invoice_id != null || invoice.billing_kind === 'deposit' || invoice.billing_kind === 'balance')
  ) {
    return { reason: 'plan_amount_locked', invoice_id: invoiceId };
  }

  const values = { invoice_id: invoiceId };
  for (const c of fields) values[c] = input[c] ?? null;

  // ยอดสุทธิคิดใหม่ทุกครั้งที่ยอด/ส่วนลดถูกแตะ — ไม่ให้หน้าเว็บส่ง total มาเอง จะได้ไม่มีทางขัดกัน
  const sets = fields.map((c) => `${c} = :${c}`);
  if (changesAmount) {
    const nextAmount = 'amount' in input ? input.amount : invoice.amount;
    const nextDiscount = 'discount' in input ? input.discount : invoice.discount;
    const nextTotal = roundMoney(Math.max(0, Number(nextAmount) - Number(nextDiscount)));
    const payment = await tx.one(
      `SELECT COALESCE(SUM(amount), 0) AS paid, MAX(paid_at) AS last_paid_at
       FROM invoice_payments WHERE invoice_id = :invoice_id`,
      { invoice_id: invoiceId },
    );
    const paid = roundMoney(payment.paid);
    if (nextTotal < paid) {
      return { reason: 'amount_below_paid', invoice_id: invoiceId, total: nextTotal, paid };
    }

    /* total ที่ตรวจเพดานกับ total ที่บันทึกต้องเป็นเลขเดียวกัน ไม่อย่างนั้นเศษเกินสตางค์
       อาจผ่านการตรวจด้วยค่าที่ปัดแล้ว แต่ถูกเขียนเป็น DOUBLE PRECISION ดิบคนละค่า */
    sets.push('total = :next_total');
    sets.push(`status = CASE WHEN :settled THEN 'paid' ELSE status END`);
    sets.push('paid_at = CASE WHEN :settled THEN COALESCE(paid_at, :last_paid_at) ELSE paid_at END');
    values.next_total = nextTotal;
    values.settled = paid > 0 && nextTotal === paid;
    values.last_paid_at = payment.last_paid_at;
  }

  const changed = await tx.run(
    `UPDATE invoices
     SET ${sets.join(', ')}, updated_at = ${NOW}
     WHERE invoice_id = :invoice_id AND status IN ('draft', 'issued')`,
    values,
  );
  return changed === 1 ? { invoice_id: invoiceId } : { reason: 'state_changed' };
}

export async function update(invoiceId, input) {
  const result = await transaction((tx) => updateInvoiceForTransaction(tx, invoiceId, input));
  return invoiceMutationResult(result);
}

/** ออกใบ (ร่าง -> ออกแล้ว) — หลังจากนี้แก้ไม่ได้ เพราะถือว่าส่งให้ลูกค้าไปแล้ว */
export async function issueInvoiceForTransaction(tx, invoiceId) {
  const locked = await invoiceForUpdate(tx, invoiceId, 'issue');
  if (locked.reason) return locked;
  if (locked.invoice.billing_kind == null) return { reason: 'billing_plan_required' };

  const changed = await tx.run(
    `UPDATE invoices
     SET status = 'issued', updated_at = ${NOW}
     WHERE invoice_id = :id AND status = 'draft'`,
    { id: invoiceId },
  );
  return changed === 1 ? { invoice_id: invoiceId } : { reason: 'state_changed' };
}

export async function issue(invoiceId) {
  const result = await transaction((tx) => issueInvoiceForTransaction(tx, invoiceId));
  return invoiceMutationResult(result);
}

/**
 * บันทึกรับชำระหนึ่งงวด — เก็บเป็นรายการแยกทุกครั้ง (มัดจำก่อน แล้วเก็บส่วนที่เหลือทีหลัง)
 *
 * ไม่ส่ง amount มา = รับเต็มยอดที่ค้างอยู่ (พฤติกรรมเดิมของปุ่ม "ยืนยันรับชำระ")
 * ใบจะเปลี่ยนเป็น "ชำระแล้ว" ก็ต่อเมื่อรับครบยอดสุทธิ — งวดแรกที่ยังไม่ครบ ใบยังเป็น "ออกใบแล้ว"
 * (ปัดสองตำแหน่งก่อนเทียบ กันเศษทศนิยมลอยทำให้ใบที่จ่ายครบแล้วไม่ยอมปิด)
 *
 * เก็บชื่อพนักงานที่รับเงินไว้ทั้งบนงวดและบนใบ — บนใบใช้เป็นผู้ลงนามใบเสร็จ (คนรับงวดสุดท้าย)
 */
export async function payInvoiceForTransaction(tx, invoiceId, input, actor) {
  const request = await paymentRequestForUpdate(tx, invoiceId, input, actor);
  if (request.reason) return request;
  if (request.replayed) return { invoice_id: invoiceId, replayed: true };

  const inv = request.invoice;
  const received = request.amount;
  const paidAt = input.paid_at ?? TODAY();

  // ใบมัดจำทั้งใบคือเงินมัดจำ — ธงนี้ใช้แยกในใบเสร็จและรายงาน
  const isDeposit = inv.billing_kind === 'deposit';

  await tx.run(
    `INSERT INTO invoice_payments
       (invoice_id, request_id, amount, paid_at, is_deposit, method, note, received_by, received_by_name)
     VALUES (:id, :request_id, :amount, :paid_at, :is_deposit, :method, :note, :by, :by_name)`,
    {
      id: invoiceId,
      request_id: input.request_id,
      amount: received,
      paid_at: paidAt,
      is_deposit: isDeposit,
      method: input.payment_method ?? null,
      note: input.note ?? null,
      by: actor?.employee_id ?? null,
      by_name: actor?.name ?? null,
    },
  );

  const settled = received >= request.balance;

  /* รับเงินเข้าใบร่าง = ใบนั้นถูก "ออก" ไปแล้วโดยพฤตินัย — ยกสถานะให้ตรงกับความจริงทันที
     ปล่อยไว้เป็นร่างแปลว่ายอดยังถูกแก้ได้ (update อนุญาต draft) ทั้งที่มีเงินผูกอยู่แล้ว
     และเอกสารที่ลูกค้าถืออยู่จะเป็น "ร่าง" ตลอดไป — หน้าจอยอมให้กดรับชำระจากใบร่างโดยตั้งใจ
     (ลูกค้าโอนมาก่อนออกใบเป็นเรื่องปกติ) จึงแก้ที่ผลลัพธ์ ไม่ใช่ปิดทางนั้นทิ้ง */
  const issuedNow = inv.status === 'draft';

  await tx.run(
    `UPDATE invoices
     SET status = CASE WHEN :settled THEN 'paid'
                       WHEN :issued_now THEN 'issued'
                       ELSE status END,
         paid_at = CASE WHEN :settled THEN :paid_at ELSE paid_at END,
         payment_method = COALESCE(:payment_method, payment_method),
         paid_by = :paid_by,
         paid_by_name = :paid_by_name,
         updated_at = ${NOW}
     WHERE invoice_id = :id`,
    {
      id: invoiceId,
      settled,
      issued_now: issuedNow,
      paid_at: paidAt,
      payment_method: input.payment_method ?? null,
      paid_by: actor?.employee_id ?? null,
      paid_by_name: actor?.name ?? null,
    },
  );

  return { invoice_id: invoiceId, replayed: false, issued_now: issuedNow };
}

export async function pay(invoiceId, input, actor) {
  const result = await transaction((tx) => payInvoiceForTransaction(tx, invoiceId, input, actor));

  return invoiceMutationResult(result);
}

/**
 * เลือกวิธีเก็บเงินของใบ — ทำได้ครั้งเดียวตอนใบยังเป็นร่างและยังไม่ได้เลือก
 *
 * full    = ใบนี้คือยอดเต็ม จบในใบเดียว
 * deposit = ใบนี้กลายเป็น "ใบมัดจำ" (ยอด = ที่กรอก) แล้วออก "ใบส่วนที่เหลือ" ตามมาอีกใบ
 *           ยอดใบที่สอง = ยอดเต็มเดิม − มัดจำ · สองใบรวมกันได้เท่ากับค่าบริการของเคสเสมอ
 *
 * ทำใน transaction เดียว เพราะครึ่งทาง (ใบมัดจำถูกแก้แล้วแต่ใบส่วนที่เหลือยังไม่เกิด)
 * แปลว่าลูกค้าจะได้บิลที่น้อยกว่าที่ตกลงไว้โดยไม่มีอะไรตามเก็บส่วนที่เหลือ
 */
export async function setBillingPlanForTransaction(tx, invoiceId, { mode, deposit_amount }, actor) {
  const locked = await invoiceForUpdate(tx, invoiceId, 'billing_plan');
  if (locked.reason) return locked;
  const inv = locked.invoice;

  if (inv.billing_kind != null) return { reason: 'billing_plan_already_set' };
  if (inv.parent_invoice_id != null) return { reason: 'plan_invalid' };

  /* root ที่ยังไม่เคยแบ่งต้องไม่มี child อยู่แล้ว หากมีแปลว่าข้อมูลแผนไม่สมบูรณ์ ห้ามสร้างซ้ำทับลงไป */
  const children = await tx.all(
    `SELECT invoice_id FROM invoices
     WHERE parent_invoice_id = :id
     ORDER BY invoice_id
     FOR UPDATE`,
    { id: invoiceId },
  );
  if (children.length > 0) return { reason: 'plan_invalid' };

  const { paid } = await tx.one(
    `SELECT COALESCE(SUM(amount), 0) AS paid
     FROM invoice_payments WHERE invoice_id = :id`,
    { id: invoiceId },
  );
  if (roundMoney(paid) > 0) return { reason: 'has_payments', invoice_id: invoiceId };
  if (roundMoney(inv.total) <= 0) return { reason: 'empty_total' };

  if (mode === 'full') {
    const changed = await tx.run(
      `UPDATE invoices
       SET billing_kind = 'full', updated_at = ${NOW}
       WHERE invoice_id = :id AND status = 'draft' AND billing_kind IS NULL`,
      { id: invoiceId },
    );
    return changed === 1 ? { invoice_id: invoiceId } : { reason: 'state_changed' };
  }

  const deposit = roundMoney(deposit_amount);
  const rest = roundMoney(Number(inv.total) - deposit);
  if (!Number.isFinite(deposit) || deposit <= 0 || rest <= 0) {
    return { reason: 'deposit_not_less_than_total', total: roundMoney(inv.total) };
  }

  // ใบแรกกลายเป็นใบมัดจำ — ส่วนลดถูกคิดไปแล้วในยอดเต็ม จึงไม่ยกมาที่งวด (ไม่งั้นลดซ้ำสองรอบ)
  const changed = await tx.run(
    `UPDATE invoices
     SET billing_kind = 'deposit',
         service_description = :description,
         amount = :amount, discount = 0, total = :amount,
         updated_at = ${NOW}
     WHERE invoice_id = :id AND status = 'draft' AND billing_kind IS NULL`,
    { id: invoiceId, amount: deposit, description: `เงินมัดจำ — ${inv.service_description}` },
  );
  if (changed !== 1) return { reason: 'state_changed' };

  const nextId = await nextInvoiceId(tx);
  await tx.run(
    `INSERT INTO invoices
       (invoice_id, case_id, customer_id, issue_date, due_date,
        bill_to_name, bill_to_tax_id, bill_to_address,
        service_description, amount, discount, total, payment_method, note,
        issued_by, issued_by_name, billing_kind, parent_invoice_id)
     VALUES
       (:invoice_id, :case_id, :customer_id, :issue_date, :due_date,
        :bill_to_name, :bill_to_tax_id, :bill_to_address,
        :description, :amount, 0, :amount, :payment_method, :note,
        :issued_by, :issued_by_name, 'balance', :parent)`,
    {
      invoice_id: nextId,
      case_id: inv.case_id,
      customer_id: inv.customer_id,
      issue_date: inv.issue_date,
      due_date: inv.due_date,
      bill_to_name: inv.bill_to_name,
      bill_to_tax_id: inv.bill_to_tax_id,
      bill_to_address: inv.bill_to_address,
      description: `ยอดคงเหลือหลังหักมัดจำ — ${inv.service_description}`,
      amount: rest,
      payment_method: inv.payment_method,
      note: inv.note,
      issued_by: actor?.employee_id ?? null,
      issued_by_name: actor?.name ?? null,
      parent: invoiceId,
    },
  );

  return { invoice_id: invoiceId };
}

export async function setBillingPlan(invoiceId, input, actor) {
  const result = await transaction((tx) => setBillingPlanForTransaction(tx, invoiceId, input, actor));
  return invoiceMutationResult(result);
}

/** ใบอื่นที่อยู่ในแผนเดียวกัน (คู่มัดจำ–ส่วนที่เหลือ) — ให้หน้าเว็บลิงก์ถึงกันได้ */
export const listPlanSiblings = (invoiceId) =>
  sql.all(
    `SELECT invoice_id, billing_kind, total, status,
            COALESCE((SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = invoices.invoice_id), 0) AS paid_amount
     FROM invoices
     WHERE invoice_id <> :id
       AND (parent_invoice_id = :id
            OR invoice_id = (SELECT parent_invoice_id FROM invoices WHERE invoice_id = :id))
     ORDER BY invoice_id`,
    { id: invoiceId },
  );

/**
 * แก้ยอดมัดจำของแผนที่แบ่งใบไปแล้ว — ใบส่วนที่เหลือถูกคิดใหม่ให้สองใบรวมกันได้เท่าเดิมเสมอ
 *
 * ยอดเต็มของแผน = ยอดใบมัดจำ + ยอดใบส่วนที่เหลือ ณ ตอนนี้ ไม่ใช่ค่าจ้างของเคส
 * เพราะใบที่แบ่งงวดแล้วไม่ถูกซิงก์ตามเคส (ดู syncOpenFromCase) ยอดที่ตกลงกับลูกค้าจึงอยู่ในใบเท่านั้น
 * ถ้าไปอ่านค่าจ้างของเคสสด ใบที่ตกลงกันไว้ก่อนแล้วเคสถูกแก้ราคาทีหลังจะเด้งเป็นยอดใหม่โดยไม่มีใครสั่ง
 *
 * อ่านยอดของทั้งคู่ใหม่ในทรานแซกชันนี้เอง ไม่รับมาจากผู้เรียก — ระหว่างที่คนหนึ่งกำลังกรอกยอดใหม่
 * อีกคนอาจเพิ่งรับเงินเข้ามา ตัวเลขที่อ่านไว้ตอนเปิดหน้าจึงเก่าได้เสมอ
 *
 * ยอดใหม่ของใบไหนเท่ากับเงินที่รับมาแล้วพอดี = ใบนั้นปิดยอดทันที ไม่ต้องให้ไปกดรับชำระ 0 บาท
 * (เกิดตอนลดยอดมัดจำลงมาเท่ากับที่ลูกค้าโอนมาแล้ว — ใบจะค้างอยู่ทั้งที่ไม่เหลืออะไรให้เก็บ)
 */
export async function setDepositAmountForTransaction(tx, depositId, deposit) {
  const plan = await invoicePlanForUpdate(tx, depositId);
  if (plan.reason) return plan;
  if (plan.target.invoice_id !== plan.root_id || plan.root.billing_kind !== 'deposit') {
    return { reason: 'not_deposit_invoice', billing_kind: plan.target.billing_kind };
  }

  const balances = plan.rows.filter((row) => row.billing_kind === 'balance');
  const unexpected = plan.rows.filter(
    (row) => row.invoice_id !== plan.root_id && row.billing_kind !== 'balance',
  );
  if (balances.length !== 1 || unexpected.length > 0) return { reason: 'plan_invalid' };
  const balance = balances[0];

  for (const row of [plan.root, balance]) {
    if (!['draft', 'issued'].includes(row.status)) {
      return { reason: 'invalid_status', invoice_id: row.invoice_id, status: row.status };
    }
  }

  /* อ่านเงินหลังล็อกทั้งคู่แล้วเป็น statement ใหม่ เพื่อเห็น payment ที่เพิ่ง commit ครบ */
  const paymentRows = await tx.all(
    `SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid, MAX(paid_at) AS last_paid_at
     FROM invoice_payments
     WHERE invoice_id = ANY(:ids::text[])
     GROUP BY invoice_id`,
    { ids: [plan.root_id, balance.invoice_id] },
  );
  const payments = new Map(paymentRows.map((row) => [row.invoice_id, row]));
  const paymentFor = (id) => payments.get(id) ?? { paid: 0, last_paid_at: null };

  const planTotal = roundMoney(Number(plan.root.total) + Number(balance.total));
  const depositNew = roundMoney(deposit);
  const restNew = roundMoney(planTotal - depositNew);
  if (!Number.isFinite(depositNew) || depositNew <= 0 || restNew <= 0) {
    return { reason: 'deposit_not_less_than_total', total: planTotal };
  }

  const depositPaid = roundMoney(paymentFor(plan.root_id).paid);
  if (depositNew < depositPaid) {
    return { reason: 'deposit_below_paid', paid: depositPaid, total: planTotal };
  }
  const balancePaid = roundMoney(paymentFor(balance.invoice_id).paid);
  if (restNew < balancePaid) {
    return {
      reason: 'balance_below_paid',
      invoice_id: balance.invoice_id,
      paid: balancePaid,
      max_deposit: roundMoney(planTotal - balancePaid),
    };
  }

  for (const row of [plan.root, balance]) {
    const amount = row.invoice_id === plan.root_id ? depositNew : restNew;
    const payment = paymentFor(row.invoice_id);
    const paid = roundMoney(payment.paid);
    const settled = paid > 0 && amount === paid;
    const changed = await tx.run(
      `UPDATE invoices
       SET amount   = :amount,
           discount = 0,
           total    = :amount,
           status   = CASE WHEN :settled THEN 'paid' ELSE status END,
           paid_at  = CASE WHEN :settled THEN COALESCE(paid_at, :last_paid) ELSE paid_at END,
           updated_at = ${NOW}
       WHERE invoice_id = :invoice_id AND status IN ('draft', 'issued')`,
      { invoice_id: row.invoice_id, amount, settled, last_paid: payment.last_paid_at },
    );
    /* หลังถือ row lock อยู่ rowCount ต้องเป็น 1 เสมอ หาก schema/trigger ภายนอกทำให้ไม่ใช่
       ต้อง throw เพื่อ rollback ทั้งคู่ ห้ามคืน reason แล้ว commit ใบแรกไว้ครึ่งทาง */
    if (changed !== 1) throw new Error(`ปรับยอดแผนวางบิลไม่ครบที่ invoice ${row.invoice_id}`);
  }

  return { invoice_id: depositId };
}

export async function setDepositAmount(depositId, deposit) {
  const result = await transaction((tx) => setDepositAmountForTransaction(tx, depositId, deposit));
  return invoiceMutationResult(result);
}

/** ยกเลิก — ไม่ลบทิ้ง เพราะเลขที่เอกสารต้องเรียงต่อเนื่อง ห้ามข้าม */
export async function cancelInvoiceForTransaction(tx, invoiceId) {
  const locked = await invoiceForUpdate(tx, invoiceId, 'cancel');
  if (locked.reason) return locked;
  const changed = await tx.run(
    `UPDATE invoices
     SET status = 'cancelled', updated_at = ${NOW}
     WHERE invoice_id = :id AND status <> 'cancelled'`,
    { id: invoiceId },
  );
  return changed === 1 ? { invoice_id: invoiceId } : { reason: 'state_changed' };
}

export async function cancel(invoiceId) {
  const result = await transaction((tx) => cancelInvoiceForTransaction(tx, invoiceId));
  return invoiceMutationResult(result);
}

/**
 * ลบใบทิ้งถาวร — ใบที่เป็นงวดหนึ่งของแผนมัดจำถูกลบทั้งแผน ไม่ใช่ทีละใบ
 *
 * ใบมัดจำกับใบส่วนที่เหลือคือยอดเดียวกันคนละครึ่ง ลบใบเดียวจะเหลืออีกใบลอยอยู่โดยไม่มีอะไรรับส่วนที่หายไป
 * (ลบใบมัดจำแล้วเงินมัดจำไม่มีใบไหนเรียกเก็บอีกเลย ส่วนใบที่เหลือก็ยังเขียนว่า "ยอดคงเหลือหลังหักมัดจำ"
 *  ทั้งที่ไม่มีมัดจำแล้ว — ลูกค้าได้บิลที่น้อยกว่าที่ตกลงไว้โดยไม่มีใครสังเกต เพราะ parent_invoice_id
 *  เป็น ON DELETE SET NULL ใบที่เหลือจึงเงียบสนิท ไม่มีอะไรฟ้องว่าขาดคู่ไป)
 * ลบทั้งแผนแล้วออกใบร่างใหม่ให้เลือกวิธีเก็บเงินอีกรอบ จึงเป็นทางเดียวที่ยอดไม่หายไประหว่างทาง
 *
 * ใบที่ยกเลิกไปแล้วในแผนไม่ถูกลบตาม — ตั้งใจเก็บไว้เป็นประวัติ และไม่ถูกนับเป็นเงินอยู่แล้ว
 *
 * รากของแผน = COALESCE(parent_invoice_id, invoice_id): ใบมัดจำเป็นรากของตัวเอง ใบส่วนที่เหลือชี้กลับไปหามัน
 * ใบที่ไม่ได้แบ่งงวดจึงเป็นแผนที่มีสมาชิกใบเดียวคือตัวมันเอง — คำสั่งเดียวใช้ได้กับทั้งสองแบบ
 */
export async function removeInvoiceForTransaction(tx, invoiceId) {
  const plan = await invoicePlanForUpdate(tx, invoiceId);
  if (plan.reason) return plan;

  const candidates = plan.rows
    .filter((row) => row.invoice_id === invoiceId || row.status !== 'cancelled')
    .sort((a, b) => a.invoice_id.localeCompare(b.invoice_id));
  const ids = candidates.map((row) => row.invoice_id);

  /* ห้ามใช้ paid_amount จาก middleware: payment อาจ commit ระหว่างโหลดหน้ากับได้ lock */
  const paymentRows = await tx.all(
    `SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid
     FROM invoice_payments
     WHERE invoice_id = ANY(:ids::text[])
     GROUP BY invoice_id`,
    { ids },
  );
  const paidById = new Map(paymentRows.map((row) => [row.invoice_id, roundMoney(row.paid)]));
  const blocker = candidates.find(
    (row) => row.status === 'paid' || (paidById.get(row.invoice_id) ?? 0) > 0,
  );
  if (blocker) {
    return {
      reason: 'has_payments',
      invoice_id: blocker.invoice_id,
      paid: paidById.get(blocker.invoice_id) ?? 0,
    };
  }

  const deleted = await tx.all(
    `DELETE FROM invoices
     WHERE invoice_id = ANY(:ids::text[])
     RETURNING invoice_id`,
    { ids },
  );
  if (deleted.length !== ids.length) {
    throw new Error('ลบสมาชิกแผนวางบิลได้ไม่ครบ แม้ถือ row lock แล้ว');
  }
  return { deleted: deleted.map((row) => row.invoice_id).sort() };
}

export async function remove(invoiceId) {
  return transaction((tx) => removeInvoiceForTransaction(tx, invoiceId));
}

/**
 * ยอดสรุปแยกตามสถานะ — รับตัวกรองชุดเดียวกับ list() เพื่อให้ตัวเลขด้านบนตรงกับรายการที่เห็น
 * ไม่ส่งตัวกรองมา = นับทั้งระบบเหมือนเดิม
 */
export async function summary(filters = {}) {
  const { clause, params } = buildWhere(filters);
  const rows = await sql.all(
    /* outstanding = เงินที่ยังไม่ได้รับจริง (ยอดสุทธิ − ที่รับมาแล้ว)
       ตั้งแต่มีมัดจำ ใบที่ยัง "รอชำระ" อาจรับเงินมาแล้วบางส่วน การรวม total ทั้งใบ
       จะทำให้ตัวเลข "รอชำระ" สูงกว่าเงินที่ต้องตามเก็บจริง แล้วไปวางแผนกระแสเงินสดผิด
       amount (ยอดเต็มของใบ) ยังคงไว้ เพราะยอดรวมของรายการที่กรองอยู่ต้องเป็นยอดหน้าใบ */
    `SELECT i.status,
            COUNT(*) AS count,
            SUM(i.total) AS amount,
            SUM(GREATEST(0, i.total - COALESCE(
              (SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.invoice_id), 0))) AS outstanding
     FROM invoices i ${clause} GROUP BY i.status`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    count: Number(r.count),
    amount: Number(r.amount ?? 0),
    outstanding: Number(r.outstanding ?? 0),
  }));
}

// ความละเอียดของแกนเวลาในกราฟรายได้ — ค่ามาจาก enum ใน schema แล้ว จึงต่อเข้า SQL ตรงๆ ได้
// (สัปดาห์ของ date_trunc เริ่มวันจันทร์ ตรงกับที่คนไทยนับสัปดาห์)
const BUCKETS = {
  day: { unit: 'day', step: '1 day' },
  week: { unit: 'week', step: '1 week' },
};

/**
 * รายได้ตามช่วงเวลา สำหรับกราฟเส้นในหน้าภาพรวม
 *
 * นับเฉพาะใบที่ "ชำระแล้ว" และยึด paid_at (วันที่เงินเข้า) ไม่ใช่ issue_date — ใบที่ออกไปแล้ว
 * แต่ยังไม่เก็บเงินไม่ใช่รายได้ และวันที่ออกใบกับวันที่รับเงินมักคนละวัน
 *
 * ช่วงเวลาถูกกางด้วย generate_series ก่อนแล้วค่อย LEFT JOIN — วันที่ไม่มีใบชำระเลยต้องได้ 0
 * ไม่ใช่หายไปจากผลลัพธ์ ไม่งั้นกราฟเส้นจะลากข้ามช่องว่างเหมือนวันนั้นมีรายได้ต่อเนื่อง
 *
 * หมายเหตุ: "วันนี้" อิงเวลาไทยเหมือน TODAY() ที่ใช้ตอนบันทึกชำระ — เส้นแบ่งวันของกราฟ
 * จึงตรงกับเส้นแบ่งวันของข้อมูลที่บันทึกไว้ และตรงกับวันที่คนดูกราฟเข้าใจ
 */
export async function revenue({ bucket, points }) {
  const { unit, step } = BUCKETS[bucket];

  const rows = await sql.all(
    `WITH buckets AS (
       SELECT generate_series(
                date_trunc('${unit}', :today::date) - :span::interval,
                date_trunc('${unit}', :today::date),
                '${step}'::interval
              )::date AS bucket
     )
     SELECT to_char(b.bucket, 'YYYY-MM-DD') AS period,
            COALESCE(SUM(i.total), 0)       AS revenue,
            COUNT(i.invoice_id)             AS invoices
     FROM buckets b
     LEFT JOIN invoices i
            ON i.status = 'paid'
           AND i.paid_at IS NOT NULL
           AND date_trunc('${unit}', LEFT(i.paid_at, 10)::date)::date = b.bucket
     GROUP BY b.bucket
     ORDER BY b.bucket`,
    { today: TODAY(), span: `${points - 1} ${unit}` },
  );

  const data = rows.map((r) => ({
    period: r.period,
    revenue: Number(r.revenue),
    invoices: Number(r.invoices),
  }));

  return {
    bucket,
    data,
    total: data.reduce((sum, r) => sum + r.revenue, 0),
    invoices: data.reduce((sum, r) => sum + r.invoices, 0),
  };
}
