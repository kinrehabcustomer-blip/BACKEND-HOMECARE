import { pool, sql } from '../db/index.js';
import { todayTh } from '../lib/dates.js';
import { ensureLedgerTables, netPaidSql, netTotalSql, roundMoney } from '../invoices/ledger.js';
import { COUNTS_AS_REVENUE, ensurePaymentVoidTable } from '../invoices/repo.js';

/**
 * บันทึกการเงิน (ผู้ใช้ขอ 20 พ.ย. 2569 "เก็บ log เฉพาะเรื่องการเงิน — เงินเข้า ยอดค้างจ่ายในระบบ หรืออื่นๆ")
 *
 * สองส่วน:
 *
 * 1) ยอดประจำวัน (finance_snapshots) — ตัวเลข "ยอดคงค้าง" ที่ย้อนดูภายหลังไม่ได้ ต้องจดไว้ ณ วันนั้น
 *    ลูกหนี้ค้างชำระ · เกินกำหนด · ใบร่างที่ยังไม่ออก · ค่าจ้างพนักงานที่ปล่อยแล้วแต่ยังไม่จ่าย · เคสที่ยังไม่ปล่อยค่าจ้าง
 *    (ยอดพวกนี้เปลี่ยนตลอด — วันนี้ลูกค้าจ่ายใบเก่า ยอดค้างของ "เมื่อวาน" ที่คิดใหม่จะไม่ใช่ที่หน้าจอเคยบอกแล้ว)
 *    พร้อมยอดเคลื่อนไหวของวันนั้น: เงินเข้า · เงินคืน · สุทธิ · จ่ายค่าจ้าง · ลดหนี้/เพิ่มหนี้
 *    จดวันละหนึ่งแถว: งานตั้งเวลาทุกเช้า (notify/routes.js daily-digest) + ทุกครั้งที่เปิดหน้าบันทึกการเงิน
 *    แถวของ "วันนี้" อัปเดตได้จนจบวัน · แถวของวันที่ผ่านไปแล้วแก้/ลบไม่ได้ในระดับฐานข้อมูล (trigger)
 *
 * 2) สมุดรายการเงิน (events) — ทุกความเคลื่อนไหวของเงิน เรียงตามเวลา คิดจากเอกสารต้นทางโดยตรง:
 *    รับเงิน · ยกเลิกรายการรับเงิน · คืนเงิน (+ ยกเลิกเงินคืน) · ออกใบแจ้งหนี้ · ยกเลิกใบ · ใบลดหนี้/เพิ่มหนี้ (+ ยกเลิก)
 *    · ปล่อยค่าจ้าง (ตั้งค้างจ่ายพนักงาน) · จ่ายค่าจ้างรอบ
 *    ไม่ต้องตามแก้ทุกจุดที่บันทึกเงิน (พลาดจุดเดียว = log ขาด) และมีประวัติย้อนหลังตั้งแต่วันแรกของระบบ
 *    เอกสารต้นทางไม่มีทางหายเงียบอยู่แล้ว: รับเงินที่ยกเลิกย้ายไป invoice_payment_voids · ใบ/เงินคืน/CN-DN เปลี่ยนสถานะ ไม่ลบ
 *
 * กลุ่ม (group) ของรายการ: cash = เงินสดเข้า/ออกจริง · ar = ยอดลูกหนี้ (ไม่ใช่เงินสด) · payroll = ค่าจ้างพนักงาน
 * amount มีเครื่องหมาย: cash + = เงินเข้า − = เงินออก · ar + = ลูกหนี้เพิ่ม − = ลดลง · payroll + = ค้างจ่ายเพิ่ม − = จ่ายออก
 */

const SNAPSHOT_DDL = `
CREATE TABLE IF NOT EXISTS finance_snapshots (
  snap_date        TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' วันไทย
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cash_in          DOUBLE PRECISION NOT NULL DEFAULT 0,
  refunds_out      DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_cash         DOUBLE PRECISION NOT NULL DEFAULT 0,
  payments_count   INTEGER NOT NULL DEFAULT 0,
  ar_outstanding   DOUBLE PRECISION NOT NULL DEFAULT 0,
  ar_count         INTEGER NOT NULL DEFAULT 0,
  ar_overdue       DOUBLE PRECISION NOT NULL DEFAULT 0,
  ar_overdue_count INTEGER NOT NULL DEFAULT 0,
  draft_total      DOUBLE PRECISION NOT NULL DEFAULT 0,
  draft_count      INTEGER NOT NULL DEFAULT 0,
  issued_total     DOUBLE PRECISION NOT NULL DEFAULT 0,
  credit_notes     DOUBLE PRECISION NOT NULL DEFAULT 0,
  debit_notes      DOUBLE PRECISION NOT NULL DEFAULT 0,
  payroll_owed     DOUBLE PRECISION NOT NULL DEFAULT 0,
  payroll_paid     DOUBLE PRECISION NOT NULL DEFAULT 0,
  unreleased_cases INTEGER NOT NULL DEFAULT 0
);
CREATE OR REPLACE FUNCTION finance_snapshots_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.snap_date >= to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'ยอดประจำวันของวันที่ผ่านไปแล้ว (finance_snapshots) แก้ไขหรือลบไม่ได้';
END
$fn$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'finance_snapshots_guard') THEN
    CREATE TRIGGER finance_snapshots_guard BEFORE UPDATE OR DELETE ON finance_snapshots
      FOR EACH ROW EXECUTE FUNCTION finance_snapshots_guard();
  END IF;
END
$do$;
`;
export const FINANCE_DDL = SNAPSHOT_DDL;

let ready = null;
/** ตารางของจริงสร้างตอน migrate (db/migrate.js) — ตัวนี้กันกรณี deploy โค้ดก่อนรัน migrate */
export const ensureFinanceTables = () =>
  (ready ??= (async () => {
    await Promise.all([ensureLedgerTables(), ensurePaymentVoidTable()]);
    const { rows } = await pool.query(`SELECT to_regclass('finance_snapshots') IS NOT NULL AS ok`);
    if (!rows[0].ok) await pool.query(SNAPSHOT_DDL);
  })().catch((err) => {
    ready = null;
    throw err;
  }));

/* ค่าจ้างที่ปล่อยแล้วแต่ยังไม่ได้อยู่ในรอบที่ "จ่ายแล้ว" — รวมทั้งที่รอเข้ารอบ และที่อยู่ในรอบร่าง */
const PAYROLL_OWED = `
  SELECT COALESCE(SUM(p.amount), 0) AS amount
  FROM case_payouts p
  WHERE p.employee_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payroll_payout_lines pl
      JOIN payroll_items it ON it.item_id = pl.item_id
      JOIN payroll_runs r ON r.run_id = it.run_id AND r.status = 'paid'
      WHERE pl.payout_id = p.payout_id)`;

/** ปิดเคสแล้ว (หรือยกเลิกหลังมีงาน) แต่ยังไม่เคยปล่อยค่าจ้าง — เกณฑ์ย่อของ payroll/repo.js unreleasedCases */
const UNRELEASED = `
  SELECT COUNT(*) AS n FROM cases c
  WHERE c.staff_pay IS NOT NULL AND c.status = 'closed'
    AND NOT EXISTS (SELECT 1 FROM case_payouts p WHERE p.case_id = c.case_id)`;

const n = (v) => roundMoney(Number(v ?? 0));
const int = (v) => Number(v ?? 0);

/** ตัวเลขทั้งชุด ณ ตอนนี้ — date = วันไทยที่ใช้คิดยอดเคลื่อนไหว (เงินเข้า/คืน/จ่ายของวันนั้น) */
export async function currentFigures(date = todayTh()) {
  await ensureFinanceTables();
  const month = date.slice(0, 7);
  const [cash, month_cash, ar, drafts, notes, owed, paid, unreleased] = await Promise.all([
    sql.one(
      `SELECT
         COALESCE((SELECT SUM(p.amount) FROM invoice_payments p JOIN invoices i ON i.invoice_id = p.invoice_id
                   WHERE p.paid_at = :d AND ${COUNTS_AS_REVENUE}), 0) AS cash_in,
         COALESCE((SELECT COUNT(*) FROM invoice_payments p JOIN invoices i ON i.invoice_id = p.invoice_id
                   WHERE p.paid_at = :d AND ${COUNTS_AS_REVENUE}), 0) AS payments_count,
         COALESCE((SELECT SUM(r.amount) FROM invoice_refunds r JOIN invoices i ON i.invoice_id = r.invoice_id
                   WHERE r.status = 'active' AND r.refunded_at = :d AND ${COUNTS_AS_REVENUE}), 0) AS refunds_out`,
      { d: date },
    ),
    sql.one(
      `SELECT
         COALESCE((SELECT SUM(p.amount) FROM invoice_payments p JOIN invoices i ON i.invoice_id = p.invoice_id
                   WHERE substr(p.paid_at, 1, 7) = :m AND p.paid_at <= :d AND ${COUNTS_AS_REVENUE}), 0)
       - COALESCE((SELECT SUM(r.amount) FROM invoice_refunds r JOIN invoices i ON i.invoice_id = r.invoice_id
                   WHERE r.status = 'active' AND substr(r.refunded_at, 1, 7) = :m AND r.refunded_at <= :d
                     AND ${COUNTS_AS_REVENUE}), 0) AS net`,
      { m: month, d: date },
    ),
    /* ลูกหนี้ = ใบที่ออกแล้วยังรอชำระ (ไม่นับใบร่าง/ใบยกเลิก) — นิยามเดียวกับ "รอชำระ" ของหน้าใบแจ้งหนี้ (summary)
       เกินกำหนด = เกณฑ์เดียวกับ is_overdue ของหน้ารายการ (due_date < วันนี้) */
    sql.one(
      `SELECT COUNT(*) FILTER (WHERE x.bal > 0.005) AS ar_count,
              COALESCE(SUM(x.bal), 0) AS ar_outstanding,
              COUNT(*) FILTER (WHERE x.bal > 0.005 AND x.due_date IS NOT NULL AND x.due_date < :d) AS ar_overdue_count,
              COALESCE(SUM(x.bal) FILTER (WHERE x.due_date IS NOT NULL AND x.due_date < :d), 0) AS ar_overdue
       FROM (SELECT i.due_date, GREATEST(0, ${netTotalSql('i')} - ${netPaidSql('i')}) AS bal
             FROM invoices i WHERE i.status = 'issued') x`,
      { d: date },
    ),
    sql.one(`SELECT COUNT(*) AS draft_count, COALESCE(SUM(i.total), 0) AS draft_total FROM invoices i WHERE i.status = 'draft'`),
    sql.one(
      `SELECT COALESCE(SUM(a.amount) FILTER (WHERE a.kind = 'credit'), 0) AS credit_notes,
              COALESCE(SUM(a.amount) FILTER (WHERE a.kind = 'debit'), 0) AS debit_notes,
              COALESCE((SELECT SUM(i.total) FROM invoices i
                        WHERE i.status <> 'cancelled' AND substr(i.issued_at, 1, 10) = :d), 0) AS issued_total
       FROM invoice_adjustments a WHERE a.status = 'issued' AND a.issue_date = :d`,
      { d: date },
    ),
    sql.one(PAYROLL_OWED),
    sql.one(
      `SELECT COALESCE(SUM(it.total_pay), 0) AS amount
       FROM payroll_runs r JOIN payroll_items it ON it.run_id = r.run_id
       WHERE r.status = 'paid' AND r.pay_date = :d`,
      { d: date },
    ),
    sql.one(UNRELEASED),
  ]);
  return {
    snap_date: date,
    cash_in: n(cash.cash_in),
    refunds_out: n(cash.refunds_out),
    net_cash: n(Number(cash.cash_in) - Number(cash.refunds_out)),
    payments_count: int(cash.payments_count),
    month_net_cash: n(month_cash.net),
    ar_outstanding: n(ar.ar_outstanding),
    ar_count: int(ar.ar_count),
    ar_overdue: n(ar.ar_overdue),
    ar_overdue_count: int(ar.ar_overdue_count),
    draft_total: n(drafts.draft_total),
    draft_count: int(drafts.draft_count),
    issued_total: n(notes.issued_total),
    credit_notes: n(notes.credit_notes),
    debit_notes: n(notes.debit_notes),
    payroll_owed: n(owed.amount),
    payroll_paid: n(paid.amount),
    unreleased_cases: int(unreleased.n),
  };
}

const SNAPSHOT_COLS = [
  'cash_in', 'refunds_out', 'net_cash', 'payments_count', 'ar_outstanding', 'ar_count', 'ar_overdue', 'ar_overdue_count',
  'draft_total', 'draft_count', 'issued_total', 'credit_notes', 'debit_notes', 'payroll_owed', 'payroll_paid', 'unreleased_cases',
];

/** จดยอดของวันนี้ (แถวเดียวต่อวัน · จดซ้ำในวันเดียวกัน = ทับด้วยตัวเลขล่าสุด) — คืนตัวเลขที่จด */
export async function captureSnapshot() {
  const figures = await currentFigures(todayTh());
  await sql.run(
    `INSERT INTO finance_snapshots (snap_date, captured_at, ${SNAPSHOT_COLS.join(', ')})
     VALUES (:snap_date, now(), ${SNAPSHOT_COLS.map((c) => `:${c}`).join(', ')})
     ON CONFLICT (snap_date) DO UPDATE SET captured_at = now(), ${SNAPSHOT_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    figures,
  );
  return figures;
}

export async function listSnapshots({ from, to }) {
  await ensureFinanceTables();
  const rows = await sql.all(
    `SELECT snap_date, to_char(captured_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS captured_at,
            ${SNAPSHOT_COLS.join(', ')}
     FROM finance_snapshots WHERE snap_date BETWEEN :from AND :to ORDER BY snap_date DESC`,
    { from, to },
  );
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
    [k, ['snap_date', 'captured_at'].includes(k) ? v : Number(v)])));
}

/* ---------- สมุดรายการเงิน ----------
 * แต่ละชิ้นคืนคอลัมน์ชุดเดียวกัน: at (วันเวลาที่ทำรายการ) · day (วันที่ทางบัญชี) · kind · grp · amount · doc_id
 * · invoice_id · case_id · party · method · actor · note */
const EVENT_SOURCES = {
  payment: `
    SELECT p.created_at AS at, p.paid_at AS day, 'payment' AS kind, 'cash' AS grp, p.amount,
           (SELECT r.receipt_id FROM receipts r WHERE r.payment_id = p.payment_id) AS doc_id,
           p.invoice_id, i.case_id, i.bill_to_name AS party, p.method, p.received_by_name AS actor,
           CASE WHEN p.is_deposit THEN 'มัดจำ' END AS note
    FROM invoice_payments p JOIN invoices i ON i.invoice_id = p.invoice_id`,
  // รับเงินที่ถูกยกเลิกภายหลัง — ตัวรายการรับเงินเดิมย้ายมาอยู่ที่นี่ (แถวเดิมถูกลบ) จึงต้องคืนทั้งสองเหตุการณ์
  payment_voided_original: `
    SELECT COALESCE(v.payment_created_at, v.paid_at) AS at, v.paid_at AS day, 'payment' AS kind, 'cash' AS grp, v.amount,
           NULL AS doc_id, v.invoice_id, i.case_id, i.bill_to_name AS party, v.method, v.received_by_name AS actor,
           'รายการนี้ถูกยกเลิกภายหลัง' AS note
    FROM invoice_payment_voids v LEFT JOIN invoices i ON i.invoice_id = v.invoice_id`,
  payment_void: `
    SELECT v.voided_at AS at, substr(v.voided_at, 1, 10) AS day, 'payment_void' AS kind, 'cash' AS grp, -v.amount AS amount,
           NULL AS doc_id, v.invoice_id, i.case_id, i.bill_to_name AS party, v.method, v.voided_by_name AS actor,
           v.reason AS note
    FROM invoice_payment_voids v LEFT JOIN invoices i ON i.invoice_id = v.invoice_id`,
  refund: `
    SELECT r.created_at AS at, r.refunded_at AS day, 'refund' AS kind, 'cash' AS grp, -r.amount AS amount,
           r.refund_doc_id AS doc_id, r.invoice_id, i.case_id, i.bill_to_name AS party, r.method,
           r.refunded_by_name AS actor, r.note
    FROM invoice_refunds r JOIN invoices i ON i.invoice_id = r.invoice_id`,
  refund_void: `
    SELECT r.voided_at AS at, substr(r.voided_at, 1, 10) AS day, 'refund_void' AS kind, 'cash' AS grp, r.amount,
           r.refund_doc_id AS doc_id, r.invoice_id, i.case_id, i.bill_to_name AS party, r.method,
           r.voided_by_name AS actor, r.void_reason AS note
    FROM invoice_refunds r JOIN invoices i ON i.invoice_id = r.invoice_id
    WHERE r.status = 'voided' AND r.voided_at IS NOT NULL`,
  invoice_issued: `
    SELECT i.issued_at AS at, substr(i.issued_at, 1, 10) AS day, 'invoice_issued' AS kind, 'ar' AS grp, i.total AS amount,
           i.invoice_id AS doc_id, i.invoice_id, i.case_id, i.bill_to_name AS party, NULL AS method,
           i.issued_by_name AS actor, NULL AS note
    FROM invoices i WHERE i.issued_at IS NOT NULL`,
  invoice_cancelled: `
    SELECT i.cancelled_at AS at, substr(i.cancelled_at, 1, 10) AS day, 'invoice_cancelled' AS kind, 'ar' AS grp,
           -i.total AS amount, i.invoice_id AS doc_id, i.invoice_id, i.case_id, i.bill_to_name AS party, NULL AS method,
           i.cancelled_by_name AS actor, i.cancel_reason AS note
    FROM invoices i WHERE i.status = 'cancelled' AND i.issued_at IS NOT NULL AND i.cancelled_at IS NOT NULL`,
  adjustment: `
    SELECT a.created_at AS at, a.issue_date AS day,
           CASE WHEN a.kind = 'credit' THEN 'credit_note' ELSE 'debit_note' END AS kind, 'ar' AS grp,
           CASE WHEN a.kind = 'credit' THEN -a.amount ELSE a.amount END AS amount,
           a.note_id AS doc_id, a.invoice_id, i.case_id, a.bill_to_name AS party, NULL AS method,
           a.issued_by_name AS actor, a.reason AS note
    FROM invoice_adjustments a JOIN invoices i ON i.invoice_id = a.invoice_id`,
  adjustment_cancelled: `
    SELECT a.cancelled_at AS at, substr(a.cancelled_at, 1, 10) AS day,
           CASE WHEN a.kind = 'credit' THEN 'credit_note_cancelled' ELSE 'debit_note_cancelled' END AS kind, 'ar' AS grp,
           CASE WHEN a.kind = 'credit' THEN a.amount ELSE -a.amount END AS amount,
           a.note_id AS doc_id, a.invoice_id, i.case_id, a.bill_to_name AS party, NULL AS method,
           a.cancelled_by_name AS actor, a.cancel_reason AS note
    FROM invoice_adjustments a JOIN invoices i ON i.invoice_id = a.invoice_id
    WHERE a.status = 'cancelled' AND a.cancelled_at IS NOT NULL`,
  payout_released: `
    SELECT p.released_at AS at, substr(p.released_at, 1, 10) AS day, 'payout_released' AS kind, 'payroll' AS grp, p.amount,
           NULL AS doc_id, NULL AS invoice_id, p.case_id, p.employee_name AS party, NULL AS method,
           p.released_by_name AS actor, p.note
    FROM case_payouts p`,
  payroll_paid: `
    SELECT COALESCE(r.updated_at, r.pay_date) AS at, r.pay_date AS day, 'payroll_paid' AS kind, 'payroll' AS grp,
           -COALESCE((SELECT SUM(it.total_pay) FROM payroll_items it WHERE it.run_id = r.run_id), 0) AS amount,
           r.run_id AS doc_id, NULL AS invoice_id, NULL AS case_id,
           (SELECT COUNT(*) FROM payroll_items it WHERE it.run_id = r.run_id) || ' คน' AS party,
           r.method, r.paid_by_name AS actor, r.note
    FROM payroll_runs r WHERE r.status = 'paid' AND r.pay_date IS NOT NULL`,
};

export const EVENT_KINDS = [
  'payment', 'payment_void', 'refund', 'refund_void', 'invoice_issued', 'invoice_cancelled',
  'credit_note', 'credit_note_cancelled', 'debit_note', 'debit_note_cancelled', 'payout_released', 'payroll_paid',
];
export const EVENT_GROUPS = ['cash', 'ar', 'payroll'];
export const EVENT_LIMIT = 5000;

/** รายการเงินในช่วงวันที่ (วันที่ทางบัญชี) — กรองกลุ่ม/ชนิดได้ · คืนสรุปยอดของทั้งช่วงด้วย (ไม่ขึ้นกับ limit) */
export async function listEvents({ from, to, grp = null, kind = null, q = null }) {
  await ensureFinanceTables();
  const union = Object.values(EVENT_SOURCES).map((s) => `(${s})`).join(' UNION ALL ');
  const where = ['e.day BETWEEN :from AND :to'];
  const params = { from, to, limit: EVENT_LIMIT };
  if (grp) { where.push('e.grp = :grp'); params.grp = grp; }
  if (kind) { where.push('e.kind = :kind'); params.kind = kind; }
  if (q) {
    where.push(`(e.invoice_id ILIKE :q OR e.case_id ILIKE :q OR e.doc_id ILIKE :q OR e.party ILIKE :q OR e.actor ILIKE :q)`);
    params.q = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  const base = `FROM (${union}) e WHERE ${where.join(' AND ')}`;
  const [rows, totals] = await Promise.all([
    sql.all(`SELECT e.* ${base} ORDER BY e.day DESC, e.at DESC NULLS LAST, e.kind LIMIT :limit`, params),
    sql.all(`SELECT e.grp, e.kind, COUNT(*) AS n, COALESCE(SUM(e.amount), 0) AS amount ${base} GROUP BY e.grp, e.kind`, params),
  ]);
  const byKind = Object.fromEntries(totals.map((t) => [t.kind, { count: Number(t.n), amount: n(t.amount) }]));
  const sumOf = (kinds) => n(kinds.reduce((s, k) => s + (byKind[k]?.amount ?? 0), 0));
  const count = totals.reduce((s, t) => s + Number(t.n), 0);
  return {
    from, to, count, truncated: count > rows.length,
    rows: rows.map((r) => ({ ...r, amount: n(r.amount) })),
    by_kind: byKind,
    summary: {
      cash_in: sumOf(['payment', 'refund_void']),
      cash_out: -sumOf(['refund', 'payment_void']),
      net_cash: sumOf(['payment', 'refund_void', 'refund', 'payment_void']),
      invoiced: sumOf(['invoice_issued', 'invoice_cancelled', 'debit_note', 'debit_note_cancelled', 'credit_note', 'credit_note_cancelled']),
      payroll_released: sumOf(['payout_released']),
      payroll_paid: -sumOf(['payroll_paid']),
    },
  };
}
