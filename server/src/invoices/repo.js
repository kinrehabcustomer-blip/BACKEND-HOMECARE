import { sql, nextInvoiceId, transaction } from '../db/index.js';

const NOW = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;
const TODAY = () => new Date().toISOString().slice(0, 10);

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
  const feeStale =
    row.case_id != null && row.case_fee != null && Number(row.case_fee) !== Number(row.amount);
  const payerStale =
    row.case_id != null && row.case_payer_name != null && row.case_payer_name !== row.bill_to_name;

  return {
    ...row,
    is_overdue: row.status === 'issued' && row.due_date != null && row.due_date < TODAY(),
    fee_stale: feeStale,
    payer_stale: payerStale,
    is_stale: feeStale || payerStale,
  };
};

export async function list({ q, status, customer_id, case_id, page, per_page, sort, order }) {
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

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM invoices i ${clause}`, params);

  const rows = await sql.all(
    `${SELECT_INVOICE} ${clause}
     ORDER BY i.${sort} ${order.toUpperCase()}
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return {
    data: rows.map(withComputed),
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

export const findById = (id) =>
  sql.one(`${SELECT_INVOICE} WHERE i.invoice_id = :id`, { id }).then((r) => (r ? withComputed(r) : null));

/** ใบแจ้งหนี้ทั้งหมดของลูกค้ารายหนึ่ง — ให้หน้าลูกค้าเอาไปแสดง */
export const listForCustomer = (customerId) =>
  sql
    .all(`${SELECT_INVOICE} WHERE i.customer_id = :id ORDER BY i.invoice_id DESC`, { id: customerId })
    .then((rows) => rows.map(withComputed));

/** ใบแจ้งหนี้ของเคสหนึ่งใบ — เคสหนึ่งออกได้ใบเดียว แต่ถ้ายกเลิกแล้วออกใหม่ได้ จึงคืนเป็นรายการ */
export const listForCase = (caseId) =>
  sql
    .all(`${SELECT_INVOICE} WHERE i.case_id = :id ORDER BY i.invoice_id DESC`, { id: caseId })
    .then((rows) => rows.map(withComputed));

/**
 * สร้างใบแจ้งหนี้จากเคส — คัดลอกข้อมูลผู้จ่ายและค่าบริการ ณ ตอนนี้มาเก็บไว้ในใบ
 * ไม่ผูกอ่านสด เพราะใบที่ออกไปแล้วต้องคงเดิมแม้ลูกค้าจะย้ายบ้านหรือเคสจะถูกแก้ราคา
 */
export function createFromCase(caseRow, input, actor) {
  const customer = caseRow.customer ?? null;

  const amount = input.amount ?? caseRow.fee ?? 0;
  const discount = input.discount ?? 0;

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
    return invoiceId;
  }).then(findById);
}

// ใบที่ยัง "แก้ได้" — เอกสารยังอยู่ในมือเรา ยังไม่ได้ส่งมอบให้ลูกค้าจริง
// ชำระแล้ว = เงินเข้ามือแล้ว ยอดกลายเป็นข้อเท็จจริง · ยกเลิกแล้ว = จบไปแล้ว ทั้งคู่จึงไม่แตะ
const OPEN_STATUSES = "('draft', 'issued')";

/**
 * เคสถูกแก้ -> ดึงข้อมูลใหม่ลงใบที่ยังแก้ได้ของเคสนั้นให้ตรงกัน
 *
 * ส่วนลดของแต่ละใบไม่ยุ่ง (เป็นข้อตกลงเฉพาะใบ ไม่ได้มาจากเคส) แต่คิดยอดสุทธิใหม่ให้ตามยอดที่เปลี่ยน
 */
export async function syncOpenFromCase(caseRow, customer) {
  const changed = await sql.run(
    `UPDATE invoices
     SET customer_id         = :customer_id,
         bill_to_name        = :bill_to_name,
         bill_to_tax_id      = :bill_to_tax_id,
         bill_to_address     = :bill_to_address,
         service_description = :service_description,
         amount              = :amount,
         total               = GREATEST(0, :amount - discount),
         updated_at          = ${NOW}
     WHERE case_id = :case_id AND status IN ${OPEN_STATUSES}`,
    {
      case_id: caseRow.case_id,
      customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
      bill_to_name: customer?.name ?? caseRow.client_name,
      bill_to_tax_id: customer?.tax_id ?? null,
      bill_to_address:
        customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,
      service_description: describeService(caseRow),
      amount: caseRow.fee ?? 0,
    },
  );
  return changed;
}

/** ข้อความรายการบริการบนใบ — ประกอบจากสิ่งที่เคสเลือกไว้ */
function describeService(c) {
  const parts =
    c.service_kind === 'physio'
      ? [c.physio_package_name, c.physio_sessions && `${c.physio_sessions} ครั้ง`]
      : [c.format_name, c.grade_name, c.pkg_staff_tier];

  const service = parts.filter(Boolean).join(' · ');
  return [service || c.title, c.client_name && `ผู้รับบริการ: ${c.client_name}`]
    .filter(Boolean)
    .join(' — ');
}

export async function update(invoiceId, input) {
  const fields = EDITABLE.filter((c) => c in input);
  if (fields.length === 0) return findById(invoiceId);

  const values = { invoice_id: invoiceId };
  for (const c of fields) values[c] = input[c] ?? null;

  // ยอดสุทธิคิดใหม่ทุกครั้งที่ยอด/ส่วนลดถูกแตะ — ไม่ให้หน้าเว็บส่ง total มาเอง จะได้ไม่มีทางขัดกัน
  const sets = fields.map((c) => `${c} = :${c}`);
  if ('amount' in input || 'discount' in input) {
    sets.push('total = GREATEST(0, COALESCE(:amount_f, amount) - COALESCE(:discount_f, discount))');
    values.amount_f = input.amount ?? null;
    values.discount_f = input.discount ?? null;
  }

  await sql.run(
    `UPDATE invoices SET ${sets.join(', ')}, updated_at = ${NOW} WHERE invoice_id = :invoice_id`,
    values,
  );
  return findById(invoiceId);
}

/** ออกใบ (ร่าง -> ออกแล้ว) — หลังจากนี้แก้ไม่ได้ เพราะถือว่าส่งให้ลูกค้าไปแล้ว */
export async function issue(invoiceId) {
  await sql.run(
    `UPDATE invoices SET status = 'issued', updated_at = ${NOW} WHERE invoice_id = :id`,
    { id: invoiceId },
  );
  return findById(invoiceId);
}

/** บันทึกรับชำระ — เก็บชื่อพนักงานที่รับเงินไว้ใช้เป็นผู้ลงนามบนใบเสร็จ (อาจคนละคนกับผู้ออกใบ) */
export async function pay(invoiceId, { paid_at, payment_method }, actor) {
  await sql.run(
    `UPDATE invoices
     SET status = 'paid',
         paid_at = :paid_at,
         payment_method = COALESCE(:payment_method, payment_method),
         paid_by = :paid_by,
         paid_by_name = :paid_by_name,
         updated_at = ${NOW}
     WHERE invoice_id = :id`,
    {
      id: invoiceId,
      paid_at: paid_at ?? TODAY(),
      payment_method: payment_method ?? null,
      paid_by: actor?.employee_id ?? null,
      paid_by_name: actor?.name ?? null,
    },
  );
  return findById(invoiceId);
}

/** ยกเลิก — ไม่ลบทิ้ง เพราะเลขที่เอกสารต้องเรียงต่อเนื่อง ห้ามข้าม */
export async function cancel(invoiceId) {
  await sql.run(
    `UPDATE invoices SET status = 'cancelled', updated_at = ${NOW} WHERE invoice_id = :id`,
    { id: invoiceId },
  );
  return findById(invoiceId);
}

export const remove = (invoiceId) =>
  sql.run('DELETE FROM invoices WHERE invoice_id = :id', { id: invoiceId }).then((n) => n > 0);

export async function summary() {
  const rows = await sql.all('SELECT status, COUNT(*) AS count, SUM(total) AS amount FROM invoices GROUP BY status');
  return rows.map((r) => ({ ...r, count: Number(r.count), amount: Number(r.amount ?? 0) }));
}
