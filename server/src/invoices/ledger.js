import { sql, nextDocId, transaction } from '../db/index.js';
import { todayTh } from '../lib/dates.js';

/**
 * เอกสารการเงินที่ต่อจากใบแจ้งหนี้ (ดร.ธงชัย 4 พ.ย. 2569 · แผนภาพ "ผังเอกสารการเงิน HomeCare")
 *
 *   ใบแจ้งหนี้ ─► รับเงินแต่ละครั้ง ─► ใบเสร็จ (1 ครั้ง = 1 ใบ)
 *              └► ใบลดหนี้ / ใบเพิ่มหนี้ ─► คืนเงิน (เมื่อลดหนี้จนเงินที่รับไว้เกิน)
 *
 * ใบที่ออกแล้วห้ามแก้ยอดตรง ๆ — ยอดหน้าใบ (invoices.total) คงเดิมตลอดไป
 * ยอดที่ลูกค้าต้องจ่ายจริงคิดจากใบลดหนี้/เพิ่มหนี้ที่ยังไม่ยกเลิก ส่วนเงินที่รับคิดจากรับเงินหักคืนเงิน
 *
 *   ยอดสุทธิ  = total + Σ ใบเพิ่มหนี้ − Σ ใบลดหนี้
 *   รับแล้ว   = Σ รับเงิน − Σ คืนเงิน
 *   ค้างชำระ  = ยอดสุทธิ − รับแล้ว
 *
 * ทุกที่ที่คิดยอดเงินของใบต้องใช้ชิ้น SQL ในไฟล์นี้ ไม่เขียน SUM เอง
 * (ก่อนหน้านี้ SUM(invoice_payments) กระจายอยู่หลายไฟล์ เพิ่มลดหนี้/คืนเงินแล้วแก้ไม่ครบที่เดียว = ตัวเลขสองหน้าจอไม่ตรงกัน)
 */

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;
export const roundMoney = (n) => Math.round(Number(n) * 100) / 100;

/* ---------- ตาราง ----------
 * อยู่ใน schema.sql ด้วย แต่สร้างซ้ำแบบ lazy ที่นี่เหมือน invoice_slips/invoice_payment_voids
 * เพราะ SELECT ของใบแจ้งหนี้อ้างตารางพวกนี้ทุกครั้ง — deploy โค้ดก่อนรัน migrate แล้วหน้าใบแจ้งหนี้ล่มทั้งหน้า
 *
 * invoice_id ไม่มี ON DELETE CASCADE โดยตั้งใจ: ใบที่มีใบเสร็จ/ใบลดหนี้แล้วต้องลบไม่ได้ในระดับฐานข้อมูล
 * payment_id ของใบเสร็จไม่ผูก FK — ยกเลิกรายการรับเงินแล้วแถวรับเงินถูกลบ (ดู voidPayment) แต่ใบเสร็จต้องอยู่ต่อ
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS receipts (
    receipt_id      TEXT PRIMARY KEY,
    invoice_id      TEXT NOT NULL REFERENCES invoices (invoice_id) ON UPDATE CASCADE,
    payment_id      INTEGER,
    amount          DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    paid_at         TEXT NOT NULL,
    method          TEXT,
    is_deposit      BOOLEAN NOT NULL DEFAULT FALSE,
    bill_to_name    TEXT NOT NULL,
    bill_to_tax_id  TEXT,
    bill_to_address TEXT,
    balance_after   DOUBLE PRECISION NOT NULL,
    status          TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'voided')),
    void_reason     TEXT,
    voided_by       TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
    voided_by_name  TEXT,
    voided_at       TEXT,
    issued_by       TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
    issued_by_name  TEXT,
    created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_payment ON receipts (payment_id) WHERE payment_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_receipts_invoice ON receipts (invoice_id, receipt_id)',

  `CREATE TABLE IF NOT EXISTS invoice_adjustments (
    note_id           TEXT PRIMARY KEY,
    invoice_id        TEXT NOT NULL REFERENCES invoices (invoice_id) ON UPDATE CASCADE,
    kind              TEXT NOT NULL CHECK (kind IN ('credit', 'debit')),
    amount            DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    reason            TEXT NOT NULL,
    items             JSONB NOT NULL DEFAULT '[]'::jsonb,
    ref_receipt_id    TEXT,
    issue_date        TEXT NOT NULL,
    total_before      DOUBLE PRECISION NOT NULL,
    total_after       DOUBLE PRECISION NOT NULL,
    bill_to_name      TEXT NOT NULL,
    bill_to_tax_id    TEXT,
    bill_to_address   TEXT,
    status            TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
    cancel_reason     TEXT,
    cancelled_by      TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
    cancelled_by_name TEXT,
    cancelled_at      TEXT,
    issued_by         TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
    issued_by_name    TEXT,
    created_at        TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
  )`,
  'CREATE INDEX IF NOT EXISTS idx_invoice_adjustments_invoice ON invoice_adjustments (invoice_id, note_id)',

  `CREATE TABLE IF NOT EXISTS invoice_refunds (
    refund_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id       TEXT NOT NULL REFERENCES invoices (invoice_id) ON UPDATE CASCADE,
    note_id          TEXT REFERENCES invoice_adjustments (note_id) ON UPDATE CASCADE,
    amount           DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    refunded_at      TEXT NOT NULL,
    method           TEXT,
    note             TEXT,
    refunded_by      TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
    refunded_by_name TEXT,
    created_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
  )`,
  'CREATE INDEX IF NOT EXISTS idx_invoice_refunds_invoice ON invoice_refunds (invoice_id, refund_id)',

  /* ชุด A แผนแก้ระบบการเงิน (4 พ.ย. 2569) — ตรงกับท้าย schema.sql
     เงินคืนมีเลขเอกสาร HC-PV และสถานะของตัวเอง ยกเลิกได้เฉพาะพร้อมใบลดหนี้ของมัน (ดู cancelAdjustmentForTransaction)
     edit_log = ประวัติการแก้วันที่/ช่องทาง/หมายเหตุ เก็บค่าก่อนแก้ทุกครั้ง */
  'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS refund_doc_id TEXT',
  `ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
     CHECK (status IN ('active', 'voided'))`,
  'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS void_reason TEXT',
  `ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS voided_by TEXT
     REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE`,
  'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS voided_by_name TEXT',
  'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS voided_at TEXT',
  "ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS edit_log JSONB NOT NULL DEFAULT '[]'::jsonb",
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_refunds_doc ON invoice_refunds (refund_doc_id) WHERE refund_doc_id IS NOT NULL',
  `ALTER TABLE invoice_adjustments ADD COLUMN IF NOT EXISTS reason_code TEXT NOT NULL DEFAULT 'other'
     CHECK (reason_code IN ('discount', 'correction', 'not_rendered', 'bad_debt', 'extra_service', 'other'))`,
  'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_at TEXT',
  /* กันออกใบลดหนี้/เพิ่มหนี้ (และเงินคืน) ซ้ำเมื่อกดซ้ำหลังหมดเวลา — แบบเดียวกับ invoice_payments.request_id (ตรวจ 13 พ.ย. 2569) */
  'ALTER TABLE invoice_adjustments ADD COLUMN IF NOT EXISTS request_id UUID',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_adjustments_request ON invoice_adjustments (request_id) WHERE request_id IS NOT NULL',
];

let ledgerReady = null;
export const ensureLedgerTables = () =>
  (ledgerReady ??= (async () => {
    for (const statement of DDL) await sql.run(statement);
  })().catch((err) => {
    ledgerReady = null;
    throw err;
  }));

/* ---------- ชิ้น SQL ของยอดเงิน — a = alias หรือชื่อตารางของ invoices ในคำสั่งที่เรียกใช้ ---------- */
export const paymentsSumSql = (a) =>
  `COALESCE((SELECT SUM(lp.amount) FROM invoice_payments lp WHERE lp.invoice_id = ${a}.invoice_id), 0)`;
export const refundsSumSql = (a) =>
  `COALESCE((SELECT SUM(lr.amount) FROM invoice_refunds lr
             WHERE lr.invoice_id = ${a}.invoice_id AND lr.status = 'active'), 0)`;
/** ยอดที่ตัดเป็นหนี้สูญ — ใบที่ปิดด้วยหนี้สูญหน้าจอต้องไม่ขึ้นว่า "ชำระแล้ว" เฉย ๆ */
export const badDebtSumSql = (a) =>
  `COALESCE((SELECT SUM(lb.amount) FROM invoice_adjustments lb
             WHERE lb.invoice_id = ${a}.invoice_id AND lb.status = 'issued'
               AND lb.kind = 'credit' AND lb.reason_code = 'bad_debt'), 0)`;
export const adjustmentsSumSql = (a) =>
  `COALESCE((SELECT SUM(CASE WHEN la.kind = 'debit' THEN la.amount ELSE -la.amount END)
             FROM invoice_adjustments la
             WHERE la.invoice_id = ${a}.invoice_id AND la.status = 'issued'), 0)`;
/** ยอดที่ลูกค้าต้องจ่ายจริงหลังลดหนี้/เพิ่มหนี้ */
export const netTotalSql = (a) => `(${a}.total + ${adjustmentsSumSql(a)})`;
/** เงินที่อยู่กับเราจริง = รับมา − คืนไป */
export const netPaidSql = (a) => `(${paymentsSumSql(a)} - ${refundsSumSql(a)})`;

/** ยอดของใบเดียว — ผู้เรียกต้องล็อกแถว invoices ก่อน แล้วค่อยเรียกนี่เป็น statement ถัดไป */
export async function ledgerFor(tx, invoiceId) {
  const row = await tx.one(
    `SELECT ${netTotalSql('i')} AS net_total,
            ${netPaidSql('i')} AS net_paid,
            (SELECT MAX(p.paid_at) FROM invoice_payments p WHERE p.invoice_id = i.invoice_id) AS last_paid_at
     FROM invoices i WHERE i.invoice_id = :id`,
    { id: invoiceId },
  );
  if (!row) return null;
  const netTotal = roundMoney(row.net_total);
  const netPaid = roundMoney(row.net_paid);
  return { netTotal, netPaid, balance: roundMoney(netTotal - netPaid), lastPaidAt: row.last_paid_at };
}

/**
 * ตั้งสถานะใบให้ตรงกับยอดหลังลดหนี้/เพิ่มหนี้/คืนเงิน — แตะเฉพาะใบที่ออกแล้วหรือชำระแล้ว
 * ค้าง ≤ 0 = ชำระแล้ว (รวมใบที่ลดหนี้จนยอดสุทธิเป็น 0) · ยังค้าง = ออกแล้ว (ใบเพิ่มหนี้ทำให้ใบที่ปิดไปแล้วถอยกลับ)
 */
export async function settleStatus(tx, invoiceId) {
  const ledger = await ledgerFor(tx, invoiceId);
  const settled = ledger.balance <= 0;
  await tx.run(
    `UPDATE invoices
     SET status  = CASE WHEN :settled THEN 'paid' ELSE 'issued' END,
         paid_at = CASE WHEN :settled THEN COALESCE(paid_at, :last_paid_at, :today) ELSE NULL END,
         updated_at = ${NOW}
     WHERE invoice_id = :id AND status IN ('issued', 'paid')`,
    { id: invoiceId, settled, last_paid_at: ledger.lastPaidAt, today: todayTh() },
  );
  return ledger;
}

/* ---------- ใบเสร็จ ---------- */

/**
 * ออกใบเสร็จของการรับเงินหนึ่งครั้ง — เรียกใน transaction เดียวกับที่บันทึกรับเงิน
 * ผู้จ่ายเป็นสำเนา ณ วันออกเหมือนใบแจ้งหนี้ · balance_after = ยอดค้างหลังรับครั้งนี้ ให้ลูกค้าเห็นว่ายังเหลือเท่าไหร่
 */
export async function issueReceipt(tx, { invoiceId, paymentId, amount, paidAt, method, isDeposit, balanceAfter, actor, now }) {
  const receiptId = await nextDocId(tx, 'RC', now);
  await tx.run(
    `INSERT INTO receipts
       (receipt_id, invoice_id, payment_id, amount, paid_at, method, is_deposit,
        bill_to_name, bill_to_tax_id, bill_to_address, balance_after, issued_by, issued_by_name)
     SELECT :receipt_id, i.invoice_id, :payment_id::integer, :amount::double precision, :paid_at, :method,
            :is_deposit::boolean, i.bill_to_name, i.bill_to_tax_id, i.bill_to_address,
            :balance_after::double precision, :by, :by_name
     FROM invoices i WHERE i.invoice_id = :invoice_id`,
    {
      receipt_id: receiptId,
      invoice_id: invoiceId,
      payment_id: paymentId,
      amount: roundMoney(amount),
      paid_at: paidAt,
      method: method ?? null,
      is_deposit: Boolean(isDeposit),
      balance_after: Math.max(0, roundMoney(balanceAfter)),
      by: actor?.employee_id ?? null,
      by_name: actor?.name ?? null,
    },
  );
  return receiptId;
}

/** ยกเลิกรายการรับเงิน = ใบเสร็จคู่กันกลายเป็น "ยกเลิก" (ใบยังอยู่ เลขที่ไม่หาย) */
export async function voidReceiptForPayment(tx, paymentId, reason, actor) {
  return tx.run(
    `UPDATE receipts
     SET status = 'voided', void_reason = :reason, voided_by = :by, voided_by_name = :by_name, voided_at = ${NOW}
     WHERE payment_id = :payment_id AND status = 'issued'`,
    { payment_id: paymentId, reason, by: actor?.employee_id ?? null, by_name: actor?.name ?? null },
  );
}

export async function listReceipts(invoiceId) {
  await ensureLedgerTables();
  return sql.all(
    `SELECT receipt_id, payment_id, amount, paid_at, method, is_deposit,
            bill_to_name, bill_to_tax_id, bill_to_address, balance_after,
            status, void_reason, voided_by_name, voided_at, issued_by_name, created_at
     FROM receipts WHERE invoice_id = :id ORDER BY created_at, receipt_id`,
    { id: invoiceId },
  );
}

/**
 * ใบเสร็จย้อนหลังให้รายการรับเงินที่บันทึกไว้ก่อนมีระบบใบเสร็จ — ไล่ตามลำดับที่บันทึกจริง รันซ้ำได้
 * ยอดค้างหลังรับคิดจากลำดับรับเงินของใบนั้นทั้งหมด (คิดก่อนกรองแถวที่มีใบเสร็จแล้ว ไม่งั้นยอดสะสมเพี้ยน)
 * วันที่ในเลขที่ = วันที่บันทึกรับเงินครั้งนั้น
 */
export async function backfillReceipts() {
  await ensureLedgerTables();
  const pending = await sql.all(
    `SELECT * FROM (
       SELECT p.payment_id, p.invoice_id, p.amount, p.paid_at, p.method, p.is_deposit,
              p.received_by, p.received_by_name, p.created_at,
              i.total - SUM(p.amount) OVER (PARTITION BY p.invoice_id ORDER BY p.payment_id) AS balance_after
       FROM invoice_payments p JOIN invoices i ON i.invoice_id = p.invoice_id
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.payment_id = x.payment_id)
     ORDER BY x.created_at, x.payment_id`,
  );
  for (const p of pending) {
    const day = String(p.created_at ?? p.paid_at).slice(0, 10);
    await transaction((tx) =>
      issueReceipt(tx, {
        invoiceId: p.invoice_id,
        paymentId: p.payment_id,
        amount: p.amount,
        paidAt: p.paid_at,
        method: p.method,
        isDeposit: p.is_deposit,
        balanceAfter: p.balance_after,
        actor: { employee_id: p.received_by, name: p.received_by_name },
        now: new Date(`${day}T12:00:00+07:00`),
      }),
    );
  }
  return pending.length;
}

/* ---------- ใบลดหนี้ / ใบเพิ่มหนี้ / คืนเงิน ---------- */

export async function listAdjustments(invoiceId) {
  await ensureLedgerTables();
  return sql.all(
    `SELECT note_id, kind, amount, reason, reason_code, items, ref_receipt_id, issue_date, total_before, total_after,
            bill_to_name, bill_to_tax_id, bill_to_address,
            status, cancel_reason, cancelled_by_name, cancelled_at, issued_by_name, created_at
     FROM invoice_adjustments WHERE invoice_id = :id ORDER BY created_at, note_id`,
    { id: invoiceId },
  );
}

export async function listRefunds(invoiceId) {
  await ensureLedgerTables();
  return sql.all(
    `SELECT refund_id, refund_doc_id, note_id, amount, refunded_at, method, note, refunded_by_name, created_at,
            status, void_reason, voided_by_name, voided_at, edit_log
     FROM invoice_refunds WHERE invoice_id = :id ORDER BY refund_id`,
    { id: invoiceId },
  );
}

/** เลข HC-PV ย้อนหลังให้เงินคืนที่บันทึกก่อนมีเลขเอกสาร — ไล่ตามลำดับที่บันทึกจริง รันซ้ำได้ (เรียกจาก migrate) */
export async function backfillRefundDocs() {
  await ensureLedgerTables();
  const pending = await sql.all(
    'SELECT refund_id, created_at FROM invoice_refunds WHERE refund_doc_id IS NULL ORDER BY created_at, refund_id',
  );
  for (const r of pending) {
    const day = String(r.created_at).slice(0, 10);
    await transaction(async (tx) => {
      const docId = await nextDocId(tx, 'PV', new Date(`${day}T12:00:00+07:00`));
      await tx.run(
        'UPDATE invoice_refunds SET refund_doc_id = :doc WHERE refund_id = :id AND refund_doc_id IS NULL',
        { doc: docId, id: r.refund_id },
      );
    });
  }
  return pending.length;
}

/**
 * แก้ข้อมูลการคืนเงินที่กรอกผิด — แก้ได้เฉพาะวันที่ ช่องทาง หมายเหตุ ยอดเงินแก้ไม่ได้
 * (ยอดคืนถูกคิดจากใบลดหนี้ ถ้ายอดผิดแปลว่าใบลดหนี้ผิด ต้องยกเลิกใบลดหนี้แล้วออกใหม่)
 * ค่าก่อนแก้ต่อท้ายไว้ใน edit_log ทุกครั้ง ให้คนตรวจบัญชีย้อนดูได้
 */
export async function updateRefundForTransaction(tx, invoiceId, refundId, input, actor) {
  const inv = await tx.one('SELECT invoice_id FROM invoices WHERE invoice_id = :id FOR UPDATE', { id: invoiceId });
  if (!inv) return { reason: 'not_found' };
  const refund = await tx.one(
    `SELECT refund_id, refunded_at, method, note, status FROM invoice_refunds
     WHERE refund_id = :rid AND invoice_id = :id FOR UPDATE`,
    { rid: refundId, id: invoiceId },
  );
  if (!refund) return { reason: 'refund_not_found' };
  if (refund.status !== 'active') return { reason: 'refund_voided' };

  const next = {
    refunded_at: input.refunded_at ?? refund.refunded_at,
    method: input.method === undefined ? refund.method : input.method,
    note: input.note === undefined ? refund.note : input.note,
  };
  if (next.refunded_at === refund.refunded_at && next.method === refund.method && next.note === refund.note) {
    return { invoice_id: invoiceId, refund_id: refundId, unchanged: true };
  }

  const entry = {
    at: todayTh(),
    by: actor?.name ?? null,
    before: { refunded_at: refund.refunded_at, method: refund.method, note: refund.note },
  };
  await tx.run(
    `UPDATE invoice_refunds
     SET refunded_at = :refunded_at, method = :method, note = :note,
         edit_log = edit_log || jsonb_build_array(:entry::jsonb)
     WHERE refund_id = :rid`,
    { ...next, entry: JSON.stringify(entry), rid: refundId },
  );
  return { invoice_id: invoiceId, refund_id: refundId };
}

export async function updateRefund(invoiceId, refundId, input, actor) {
  await ensureLedgerTables();
  return transaction((tx) => updateRefundForTransaction(tx, invoiceId, refundId, input, actor));
}

/**
 * ตัดสินว่าออกใบลดหนี้/เพิ่มหนี้ได้ไหม — คิดจากข้อมูลล้วน แยกไว้เทสได้โดยไม่ต้องมีฐานข้อมูล
 *
 * ใบร่างไม่ต้องใช้ CN/DN (แก้ยอดในใบได้ตรง ๆ) · ใบยกเลิกไม่มียอดให้ปรับแล้ว
 * ลดหนี้ได้ไม่เกินยอดสุทธิ (ยอดติดลบไม่มีความหมาย)
 * ลดหนี้จนเงินที่รับไว้เกินยอดใหม่ = ต้องคืนเงินส่วนเกินทันที (ไม่เก็บเป็นเครดิต — ตัดสินใจ 4 พ.ย. 2569)
 *
 * หนี้สูญ = ตัดยอดที่ลูกค้าไม่จ่ายทิ้ง จึงตัดได้ไม่เกินยอดค้าง (ไม่มีทางทำให้ต้องคืนเงิน)
 * ยังไม่ได้รับเงินเลยแล้วลดจนยอดสุทธิเป็น 0 = ไม่มีการขายเหลืออยู่ ทางที่ถูกคือยกเลิกใบ
 * ยกเว้นหนี้สูญ เพราะการขายเกิดขึ้นจริง แค่เก็บเงินไม่ได้ (แผนแก้ระบบการเงิน L4)
 */
export function assessAdjustment(status, ledger, { kind, amount, refund, reason_code: reasonCode = 'other' }) {
  if (status === 'draft') return { reason: 'draft_editable' };
  if (status !== 'issued' && status !== 'paid') return { reason: 'invalid_status', status };

  const value = roundMoney(amount);
  if (!Number.isFinite(value) || value <= 0) return { reason: 'invalid_amount' };
  if (kind === 'credit' && value > ledger.netTotal) {
    return { reason: 'exceeds_total', net_total: ledger.netTotal };
  }
  if (reasonCode === 'bad_debt') {
    if (kind !== 'credit') return { reason: 'invalid_reason_code' };
    const balance = roundMoney(ledger.netTotal - ledger.netPaid);
    if (value > balance) return { reason: 'exceeds_balance', balance: Math.max(0, balance) };
  }

  const totalAfter = roundMoney(kind === 'credit' ? ledger.netTotal - value : ledger.netTotal + value);
  if (kind === 'credit' && totalAfter <= 0 && ledger.netPaid <= 0 && reasonCode !== 'bad_debt') {
    return { reason: 'cancel_instead' };
  }
  const refundAmount = Math.max(0, roundMoney(ledger.netPaid - totalAfter));
  if (refundAmount > 0 && !refund) return { reason: 'refund_required', refund_amount: refundAmount };

  return { amount: value, totalBefore: ledger.netTotal, totalAfter, refundAmount };
}

export async function createAdjustmentForTransaction(tx, invoiceId, input, actor) {
  const inv = await tx.one(
    `SELECT invoice_id, status, bill_to_name, bill_to_tax_id, bill_to_address
     FROM invoices WHERE invoice_id = :id FOR UPDATE`,
    { id: invoiceId },
  );
  if (!inv) return { reason: 'not_found' };

  /* คำขอเดิม (กดซ้ำหลังหมดเวลา ทั้งที่ server ออกเอกสารไปแล้ว) = คืนเอกสารเดิม ไม่ออกใบที่สอง
     ตรวจหลังล็อกใบ — คำขอซ้ำที่มาพร้อมกันรอคิวกันที่ล็อก แล้วตัวที่สองเห็นแถวของตัวแรก */
  if (input.request_id) {
    const prior = await tx.one(
      `SELECT a.note_id, a.invoice_id, r.refund_doc_id, COALESCE(r.amount, 0) AS refund_amount
         FROM invoice_adjustments a
         LEFT JOIN invoice_refunds r ON r.note_id = a.note_id
        WHERE a.request_id = :rid`,
      { rid: input.request_id },
    );
    if (prior) {
      if (prior.invoice_id !== invoiceId) return { reason: 'idempotency_conflict' };
      return { invoice_id: invoiceId, note_id: prior.note_id, refund_amount: Number(prior.refund_amount), refund_doc_id: prior.refund_doc_id, replayed: true };
    }
  }

  const ledger = await ledgerFor(tx, invoiceId);
  const verdict = assessAdjustment(inv.status, ledger, input);
  if (verdict.reason) return verdict;

  if (input.ref_receipt_id) {
    const ref = await tx.one(
      'SELECT receipt_id FROM receipts WHERE receipt_id = :rid AND invoice_id = :id',
      { rid: input.ref_receipt_id, id: invoiceId },
    );
    if (!ref) return { reason: 'receipt_not_found' };
  }

  const noteId = await nextDocId(tx, input.kind === 'credit' ? 'CN' : 'DN');
  await tx.run(
    `INSERT INTO invoice_adjustments
       (note_id, invoice_id, kind, amount, reason, reason_code, items, ref_receipt_id, issue_date,
        total_before, total_after, bill_to_name, bill_to_tax_id, bill_to_address, issued_by, issued_by_name, request_id)
     VALUES (:note_id, :invoice_id, :kind, :amount, :reason, :reason_code, :items, :ref_receipt_id, :issue_date,
             :total_before, :total_after, :bill_to_name, :bill_to_tax_id, :bill_to_address, :by, :by_name, :request_id)`,
    {
      request_id: input.request_id ?? null,
      note_id: noteId,
      invoice_id: invoiceId,
      kind: input.kind,
      amount: verdict.amount,
      reason: input.reason,
      reason_code: input.reason_code ?? 'other',
      items: JSON.stringify(input.items ?? []),
      ref_receipt_id: input.ref_receipt_id ?? null,
      issue_date: todayTh(),
      total_before: verdict.totalBefore,
      total_after: verdict.totalAfter,
      bill_to_name: inv.bill_to_name,
      bill_to_tax_id: inv.bill_to_tax_id,
      bill_to_address: inv.bill_to_address,
      by: actor?.employee_id ?? null,
      by_name: actor?.name ?? null,
    },
  );

  let refundDocId = null;
  if (verdict.refundAmount > 0) {
    refundDocId = await nextDocId(tx, 'PV');
    await tx.run(
      `INSERT INTO invoice_refunds
         (refund_doc_id, invoice_id, note_id, amount, refunded_at, method, note, refunded_by, refunded_by_name)
       VALUES (:refund_doc_id, :invoice_id, :note_id, :amount, :refunded_at, :method, :note, :by, :by_name)`,
      {
        refund_doc_id: refundDocId,
        invoice_id: invoiceId,
        note_id: noteId,
        amount: verdict.refundAmount,
        refunded_at: input.refund.refunded_at ?? todayTh(),
        method: input.refund.method ?? null,
        note: input.refund.note ?? null,
        by: actor?.employee_id ?? null,
        by_name: actor?.name ?? null,
      },
    );
  }

  await settleStatus(tx, invoiceId);
  return { invoice_id: invoiceId, note_id: noteId, refund_amount: verdict.refundAmount, refund_doc_id: refundDocId };
}

export async function createAdjustment(invoiceId, input, actor) {
  await ensureLedgerTables();
  return transaction((tx) => createAdjustmentForTransaction(tx, invoiceId, input, actor));
}

/**
 * ยกเลิกใบลดหนี้/เพิ่มหนี้ที่ออกผิด — ใบยังอยู่ เลขที่ไม่หาย แค่ไม่ถูกนับในยอดสุทธิแล้ว
 * ยกเลิกใบเพิ่มหนี้แล้วยอดสุทธิต้องไม่ต่ำกว่าเงินที่รับไว้ ไม่งั้นต้องคืนเงินแทน
 *
 * ใบลดหนี้ที่มีเงินคืน: เงินคืนถูกยกเลิกไปด้วยใน transaction เดียวกัน ยกเลิกเงินคืนแยกเดี่ยวไม่ได้
 * (ยกเลิกแค่เงินคืนแต่ใบลดหนี้ยังอยู่ = รับเงินเกินยอดทันที — แผนแก้ระบบการเงิน L2)
 * ย้อนคู่กันไม่มีทางเกินยอด: เงินคืน ≤ ยอดลดหนี้เสมอ (คืนเฉพาะส่วนที่ลดจนต่ำกว่าเงินที่รับ)
 * หลังย้อน รับสุทธิ +เงินคืน ยอดสุทธิ +ยอดลดหนี้ — ฝั่งยอดสุทธิโตเท่ากันหรือมากกว่าเสมอ
 * ใช้เมื่อเงินคืนไม่ได้เกิดขึ้นจริง หรือลูกค้าโอนกลับมาแล้ว — หน้าเว็บต้องให้ยืนยันเรื่องนี้ก่อน
 */
export async function cancelAdjustmentForTransaction(tx, invoiceId, noteId, { reason }, actor) {
  const inv = await tx.one(
    'SELECT invoice_id, status FROM invoices WHERE invoice_id = :id FOR UPDATE',
    { id: invoiceId },
  );
  if (!inv) return { reason: 'not_found' };
  if (inv.status !== 'issued' && inv.status !== 'paid') return { reason: 'invalid_status', status: inv.status };

  const note = await tx.one(
    `SELECT note_id, kind, amount, status
     FROM invoice_adjustments a WHERE a.invoice_id = :id AND a.note_id = :note_id FOR UPDATE`,
    { id: invoiceId, note_id: noteId },
  );
  if (!note) return { reason: 'note_not_found' };
  if (note.status !== 'issued') return { reason: 'note_cancelled' };

  let voidedRefunds = 0;
  if (note.kind === 'credit') {
    voidedRefunds = await tx.run(
      `UPDATE invoice_refunds
       SET status = 'voided', void_reason = :reason, voided_by = :by, voided_by_name = :by_name, voided_at = ${NOW}
       WHERE note_id = :note_id AND status = 'active'`,
      {
        note_id: noteId,
        reason: `ยกเลิกพร้อมใบลดหนี้ ${noteId}: ${reason}`,
        by: actor?.employee_id ?? null,
        by_name: actor?.name ?? null,
      },
    );
  }

  if (note.kind === 'debit') {
    const ledger = await ledgerFor(tx, invoiceId);
    if (roundMoney(ledger.netTotal - note.amount) < ledger.netPaid) {
      return { reason: 'below_paid', paid: ledger.netPaid };
    }
  }

  await tx.run(
    `UPDATE invoice_adjustments
     SET status = 'cancelled', cancel_reason = :reason, cancelled_by = :by, cancelled_by_name = :by_name,
         cancelled_at = ${NOW}
     WHERE note_id = :note_id`,
    { note_id: noteId, reason, by: actor?.employee_id ?? null, by_name: actor?.name ?? null },
  );
  await settleStatus(tx, invoiceId);
  return { invoice_id: invoiceId, note_id: noteId, voided_refunds: voidedRefunds };
}

export async function cancelAdjustment(invoiceId, noteId, input, actor) {
  await ensureLedgerTables();
  return transaction((tx) => cancelAdjustmentForTransaction(tx, invoiceId, noteId, input, actor));
}
