import { sql, nextInvoiceId, transaction } from '../db/index.js';
import { PATIENT_PENDING } from '../cases/schema.js';
import {
  normalizeAddons, addonAmount, addonsTotal, addonsTotalSql, addonLabel, unbilledAddons, isPhysioBundle, PHYSIO_BUNDLE,
} from '../lib/addons.js';
import { ensureAddonLink, ensureCasePriceSnapshots } from '../cases/repo.js';
import { bundleCoveredSql } from '../cases/addonLink.js';
import { ensureShareTables, hasBeenShared } from './share.js';
import { likeEscape } from '../lib/likeEscape.js';
import {
  ensureLedgerTables, netTotalSql, netPaidSql, paymentsSumSql, refundsSumSql, adjustmentsSumSql, badDebtSumSql,
  ledgerFor, issueReceipt, voidReceiptForPayment, listReceipts, listAdjustments, listRefunds,
} from './ledger.js';

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

  /* อ่านยอดของ "ใบที่เพิ่งล็อก" — ต้องใช้รหัสจากแถวที่ล็อกไว้ ไม่ใช่ตัวแปรนอกสโคป
     (เคยเขียนเป็น invoiceId ซึ่งไม่มีในฟังก์ชันนี้ ทำให้การรับชำระทุกครั้งพังด้วย ReferenceError)
     เพดานคือยอดสุทธิหลังลดหนี้/เพิ่มหนี้ หักเงินที่รับไว้สุทธิหลังคืนเงิน (ดู ledger.js) */
  const ledger = await ledgerFor(tx, invoice.invoice_id);

  const capacity = assessPaymentCapacity(invoice.status, ledger.netTotal, ledger.netPaid, requestedAmount);
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
    slip_id: input.slip_id ?? null,
  };
  const recorded = {
    amount: roundMoney(payment.amount),
    paid_at: payment.paid_at,
    method: payment.method ?? null,
    note: payment.note ?? null,
    received_by: payment.received_by ?? null,
    slip_id: payment.slip_id ?? null,
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
    `SELECT payment_id, amount, paid_at, method, note, received_by, slip_id
     FROM invoice_payments
     WHERE invoice_id = :invoice_id AND request_id = :request_id`,
    { invoice_id: invoiceId, request_id: input.request_id },
  );
  if (existing) {
    const replay = assessPaymentReplay(existing, input, actor);
    return replay.reason ? replay : { invoice, payment: existing, ...replay };
  }

  if (input.slip_id != null) {
    const slip = await tx.one(
      `SELECT slip_id FROM invoice_slips
       WHERE invoice_id = :invoice_id AND slip_id = :slip_id AND status = 'pending'
       FOR UPDATE`,
      { invoice_id: invoiceId, slip_id: input.slip_id },
    );
    if (!slip) return { reason: 'slip_unavailable' };
  }

  return capacityForLockedPayment(tx, invoice, input.amount);
}

// ช่องที่แก้ได้ตอนยังเป็นร่าง (สถานะ/ยอดรวมไม่อยู่ในนี้ — total คิดจาก amount-discount เสมอ)
const EDITABLE = [
  'issue_date', 'due_date', 'bill_to_name', 'bill_to_tax_id', 'bill_to_address',
  'service_description', 'amount', 'discount', 'payment_method', 'note',
];

// ช่องที่ syncOpenFromCase เขียนทับจากเคส — แก้ช่องพวกนี้ที่ใบเองแล้วใบต้องหลุดจากการซิงก์อัตโนมัติ
const SYNCED_FIELDS = [
  'amount', 'discount', 'bill_to_name', 'bill_to_tax_id', 'bill_to_address', 'service_description',
];

/* บริการที่เคสเลือกอยู่ ย่อเป็นข้อความเดียว — จดไว้ในใบ (service_key) ตอนออก/ซิงก์ แล้วเทียบตอนอ่าน
   เพื่อจับว่าเคสเปลี่ยนแพ็คเกจหลังออกใบ (ดู withComputed.service_stale)
   สูตรต้องตรงกับที่เติมของเก่าใน schema.sql · ไม่รวม service_kind ด้วยเหตุผลที่เขียนไว้ที่นั่น
   อุปกรณ์เสริมต่อท้ายเฉพาะเคสที่มี (concat_ws ข้าม NULL) — เคสที่ไม่มีจึงได้ key เดิมทุกตัวอักษร
   ใบเก่าไม่โดนป้าย "แพ็คเกจไม่ตรง" ทั้งระบบเพราะเพิ่มฟีเจอร์นี้ */
/* ยอดที่ใบควรเป็นตามเคสตอนนี้ = ค่าบริการของเคส + อุปกรณ์เสริมที่ "ใบนี้" เก็บ — ต้องตรงกับ priceParts
   อุปกรณ์ใช้ของใบ ไม่ใช่ของเคส: อุปกรณ์ที่เพิ่มเข้าเคสทีหลังไปอยู่ใบค่าใช้จ่ายเพิ่มเติม (ดู unbilledAddons)
   ใบแพ็คเกจที่ไม่มีอุปกรณ์ตัวนั้นจึงยังถูกต้อง ไม่ต้องขึ้นป้าย "ยอดไม่ตรง"
   ไม่ได้ตั้งค่าบริการและใบไม่มีอุปกรณ์ = NULL (ยังไม่มีราคาให้เทียบ ไม่ขึ้นป้าย "ยอดไม่ตรง")
   ไม่ได้ตั้งค่าบริการแต่มีอุปกรณ์ = ค่าอุปกรณ์ล้วน เหมือนที่ priceParts ใช้ fee ?? 0 */
/* ค่าบริการ "ที่ใบใช้จริง" = ราคาที่จดไว้ตอนเลือกบริการ ถ้าไม่มีจึงใช้ fee — ลำดับเดียวกับ priceParts (ตรวจ 11 พ.ย. 2569)
   เดิมเทียบกับ fee ล้วน: เคสที่ไม่ได้กรอก fee เอง (ใช้ราคาตามตารางเรท) ใบคิด 2,000 ตามราคาที่จดไว้
   แต่ป้ายเทียบกับ fee ว่าง = 0 → ใบที่ถูกต้องขึ้น "ยอดไม่ตรงกับเคส" ทั้งที่ไม่ผิด */
/* คอลัมน์ราคาที่จดไว้ของเคสเติมแบบ lazy (ดู ensureCasePriceSnapshots) — คิวรีอ่านใบอ้างถึงมันแล้ว (caseNetFeeSql)
   ดู catalog ก่อนแทน ALTER ทุก cold start (ALTER ขอล็อกทั้งตารางแม้คอลัมน์มีแล้ว — เหตุผลเดียวกับ ensureAddonLink) */
let priceSnapshotColumnsReady = null;
const ensurePriceSnapshotColumns = () =>
  (priceSnapshotColumnsReady ??= (async () => {
    const { n } = await sql.one(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'cases'
          AND column_name IN ('service_list_price_snapshot', 'service_customer_price_snapshot')`,
    );
    if (n < 2) await ensureCasePriceSnapshots();
  })().catch((err) => { priceSnapshotColumnsReady = null; throw err; }));

const caseNetFeeSql = (c) => `COALESCE(${c}.service_customer_price_snapshot, ${c}.fee)`;
const caseBillableSql = (c, i) =>
  `CASE WHEN ${caseNetFeeSql(c)} IS NULL AND ${i}.addons = '[]'::jsonb THEN NULL
        ELSE COALESCE(${caseNetFeeSql(c)}, 0) + ${addonsTotalSql(i)} END`;

/* บรรทัดแพ็กกายภาพเสริมในใบนี้ ที่เคสกายภาพถูกยกเลิกไปแล้ว และยังไม่มีใครจัดการ (ตรวจ 11 พ.ย. 2569)
   เดิมเตือนแค่ popup ครั้งเดียวตอนกดยกเลิกแพ็ก — กดปิดไปแล้วไม่ได้ออกใบลดหนี้ เงินค่าแพ็กที่ไม่ได้ให้บริการ
   ค้างอยู่กับเราโดยไม่มีอะไรเตือนอีก · ป้ายค้างบนใบจนกว่าจะ "จัดการแล้ว" =
   มีใบลดหนี้ (ที่ไม่ใช่ตัดหนี้สูญ) ของใบนี้ออกหลังเวลายกเลิกแพ็ก — ลดเต็ม/บางส่วนเป็นการตัดสินใจของคนทำ
   หรือเปิดแพ็กกลับมาใหม่ (สถานะไม่ใช่ยกเลิกแล้ว) · ใบร่างไม่นับ: ใบร่างซิงก์ตามเคสเอาบรรทัดออกเอง/แก้ในใบได้
   คืนยอดรวมของบรรทัดพวกนั้น (0 = ไม่มี) */
/* ใบนี้มีบรรทัดแพ็กกายภาพที่เคสถูกยกเลิกแล้ว (จัดการแล้วหรือยังก็ตาม) — ใบแบบนี้ไม่เทียบ "ยอดไม่ตรงกับเคส"
   ยอดที่ถูกต้องหลังยกเลิกแพ็กคือการตัดสินใจของคนทำ (ลดเต็ม/ลดบางส่วนตามครั้งที่ทำไปแล้ว) ระบบเดาไม่ได้
   ป้าย bundle_stale ทำหน้าที่เตือนแทนจนกว่าจะออกใบลดหนี้ — ไม่ให้สองป้ายซ้อนกันหรือค้างหลังจัดการแล้ว */
const hasCancelledBundleSql = (i) => `EXISTS (
    SELECT 1 FROM jsonb_array_elements(${i}.addons) hb JOIN cases hbc ON hbc.case_id = hb ->> 'ref'
     WHERE hb ->> 'kind' = '${PHYSIO_BUNDLE}' AND hbc.status = 'cancelled')`;
const cancelledBundleSql = (i) => `CASE WHEN ${i}.status IN ('issued', 'paid') THEN COALESCE((
    SELECT SUM(ROUND((a ->> 'quantity')::numeric * (a ->> 'unit_price')::numeric, 2))
      FROM jsonb_array_elements(${i}.addons) a
      JOIN cases bc ON bc.case_id = a ->> 'ref'
     WHERE a ->> 'kind' = '${PHYSIO_BUNDLE}' AND bc.status = 'cancelled'
       AND NOT EXISTS (
         SELECT 1 FROM invoice_adjustments bla
          WHERE bla.invoice_id = ${i}.invoice_id AND bla.kind = 'credit' AND bla.status = 'issued'
            AND bla.reason_code <> 'bad_debt' AND bla.created_at >= COALESCE(bc.cancelled_at, ''))
  ), 0)::double precision ELSE 0 END`;

/* แผนมัดจำ–ส่วนที่เหลือ: เทียบ "ทั้งแผน" กับเคส ไม่ใช่ทีละใบ (ตรวจ 11 พ.ย. 2569)
   ใบงวดตั้งใจให้ยอดน้อยกว่าค่าบริการอยู่แล้ว จึงเคยถูกยกเว้นจากป้าย "ยอดไม่ตรง" ทั้งหมด
   ผลคือขึ้นค่าบริการเคส 30,000 → 36,000 หลังแบ่งมัดจำแล้ว ไม่มีอะไรเตือนเลย ส่วนต่าง 6,000 หลุดไม่มีใครเก็บ
   (ใบงวดไม่ซิงก์ตามเคสโดยตั้งใจ — ดู syncOpenFromCase) · รากของแผน = COALESCE(parent_invoice_id, invoice_id)
   ไม่นับใบในแผนที่ถูกยกเลิก · อุปกรณ์เสริมของแผนอยู่ที่ใบส่วนที่เหลือ (ใบมัดจำเป็น '[]') รวมทั้งแผนจึงได้ครบ */
const planRowsSql = (i) =>
  `FROM invoices pi WHERE COALESCE(pi.parent_invoice_id, pi.invoice_id) = COALESCE(${i}.parent_invoice_id, ${i}.invoice_id)
     AND pi.status <> 'cancelled'`;
const planNetTotalSql = (i) => `(SELECT SUM(${netTotalSql('pi')}) ${planRowsSql(i)})`;
const planBillableSql = (c, i) =>
  `CASE WHEN ${caseNetFeeSql(c)} IS NULL THEN NULL
        ELSE ${caseNetFeeSql(c)} + COALESCE((SELECT SUM(${addonsTotalSql('pi')}) ${planRowsSql(i)}), 0) END`;

/* ส่วนแพ็คเกจ/เรทของ service_key (4 ช่องแรก) — ตัดรายการอุปกรณ์ที่ต่อท้ายทิ้งก่อนเทียบ
   อุปกรณ์ที่เพิ่มทีหลังไม่ทำให้ใบแพ็คเกจ "ไม่ตรง" แล้ว เพราะไปออกเป็นใบค่าใช้จ่ายเพิ่มเติมแยก
   ไม่แก้สูตร serviceKeySql เอง: key ที่จดไว้ในใบเก่าทั้งระบบยังมีอุปกรณ์ต่อท้ายอยู่ ตัดตอนเทียบจึงใช้ได้ทั้งเก่าและใหม่ */
const serviceCoreSql = (key) => `array_to_string((string_to_array(${key}, '|'))[1:4], '|')`;
const serviceCore = (key) => String(key).split('|').slice(0, 4).join('|');

const serviceKeySql = (c) => `concat_ws('|',
  COALESCE(${c}.physio_package_id::text, ''), COALESCE(${c}.pkg_format_id::text, ''),
  COALESCE(${c}.pkg_grade_id::text, ''), COALESCE(${c}.pkg_staff_tier, ''),
  NULLIF(${c}.addons::text, '[]'))`;

// case_payer_name = ชื่อผู้จ่าย "ที่ควรจะเป็น" ของเคสตอนนี้ ไล่ตามลำดับ:
//   ผู้ว่าจ้างของเคส -> ผู้ว่าจ้างของแฟ้มผู้รับบริการ (เผื่อเพิ่งผูกทีหลัง เคสยังไม่มี) -> ชื่อผู้รับบริการในเคส
// ใช้เทียบกับ bill_to_name ในใบ เพื่อรู้ว่าใบยังตรงกับผู้จ่ายปัจจุบันไหม (ดู withComputed.payer_stale)
const SELECT_INVOICE = `
  SELECT i.*,
         EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id) AS has_items,
         (SELECT COUNT(*)::int FROM invoice_slips s
           WHERE s.invoice_id = i.invoice_id AND s.status = 'pending') AS pending_slip_count,
         /* ยอดที่รับมาแล้วจริง คิดสดจากรายการรับเงินทุกครั้ง ไม่เก็บยอดสะสมซ้ำไว้บนใบ
            (เก็บสองที่แล้ววันหนึ่งจะไม่ตรงกัน เช่น ลบรายการรับเงินแล้วลืมหักยอดสะสม)
            paid_amount = รับมาหักคืนไป · net_total = ยอดหน้าใบหลังลดหนี้/เพิ่มหนี้ (ดู ledger.js) */
         ${netPaidSql('i')} AS paid_amount,
         ${paymentsSumSql('i')} AS received_amount,
         ${refundsSumSql('i')} AS refunded_amount,
         ${adjustmentsSumSql('i')} AS adjustment_total,
         ${netTotalSql('i')} AS net_total,
         ${badDebtSumSql('i')} AS bad_debt_amount,
         c.title       AS case_title,
         /* ผู้รับบริการของเคส — หัวใบแจ้งหนี้โชว์รหัส/ชื่อผู้รับบริการ (ผู้จ่ายยังอยู่ที่ bill_to_* และช่องลงนาม)
            เคสที่ยังไม่รู้ชื่อผู้รับบริการได้ NULL ไม่ใช่คำแทนชื่อ — เอกสารที่ส่งลูกค้าต้องไม่มีคำว่า "ยังไม่ระบุผู้รับบริการ" */
         c.patient_id  AS patient_id,
         NULLIF(c.client_name, '${PATIENT_PENDING}') AS patient_name,
         c.status      AS case_status,
         /* ยอดที่ใบควรเป็นตามเคสตอนนี้ = ค่าบริการ + อุปกรณ์เสริมของใบนี้ (ดู caseBillableSql) */
         ${caseBillableSql('c', 'i')} AS case_fee,
         /* ใบงวด: ยอดรวมทั้งแผน กับยอดที่แผนควรเป็นตามเคสตอนนี้ (ดู planBillableSql) */
         CASE WHEN i.billing_kind IN ('deposit', 'balance') THEN ${planNetTotalSql('i')} END AS plan_net_total,
         ${cancelledBundleSql('i')} AS cancelled_bundle_amount,
         ${hasCancelledBundleSql('i')} AS has_cancelled_bundle,
         CASE WHEN i.billing_kind IN ('deposit', 'balance') THEN ${planBillableSql('c', 'i')} END AS plan_case_fee,
         CASE WHEN c.case_id IS NOT NULL THEN ${serviceKeySql('c')} END AS case_service_key,
         cu.name       AS customer_name,
         cu.phone      AS customer_phone,
         /* เบอร์ติดต่อของฝั่งผู้รับบริการ (ตารางใบแจ้งหนี้โชว์ "ผู้รับบริการ / เบอร์") — ไล่จากเบอร์ญาติในเคส
            -> ผู้ติดต่อฉุกเฉินในแฟ้มผู้รับบริการ -> เบอร์ผู้ว่าจ้าง (ผู้รับบริการไม่มีช่องเบอร์ของตัวเอง) */
         COALESCE(NULLIF(c.client_phone, ''), NULLIF(p.emergency_contact_phone, ''), cu.phone, pcu.phone) AS contact_phone,
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
  c.service_list_price_snapshot ?? (
    c.service_kind === 'physio' || c.physio_package_id != null
      ? c.physio_original_price
      : c.rate_customer_price
  );

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
  // เคสใหม่ใช้ snapshot ณ วันที่เลือกบริการ; เคสเก่าที่ยังว่าง fallback ตารางราคาปัจจุบันเหมือนเดิม
  const net = caseRow.service_customer_price_snapshot ?? caseRow.fee ?? 0;
  const list = listPriceOf(caseRow);
  // อุปกรณ์เสริมคิดเต็มราคาเสมอ ไม่มีส่วนลด — บวกเข้ายอดก่อนลด ส่วนลดยังเป็นของค่าบริการล้วนๆ
  const extra = addonsTotal(caseRow.addons);
  return list != null && list > net
    ? { amount: list + extra, discount: list - net }
    : { amount: net + extra, discount: 0 };
}

/** บรรทัดอุปกรณ์เสริม/หัตถการในรูปเดียวกับ invoice_items — ใช้ต่อท้ายใบที่แตกเป็นรายครั้ง */
export const addonLines = (addons, startSeq = 1) =>
  normalizeAddons(addons).map((a, i) => ({
    seq: startSeq + i,
    description: addonLabel(a),
    quantity: a.quantity,
    unit_price: a.unit_price,
    amount: addonAmount(a),
  }));

/**
 * อุปกรณ์เสริม/หัตถการที่ใบ (ที่ไม่ได้ยกเลิก) ของเคสนี้เก็บไปแล้ว รวมทุกใบเป็นรายการเดียว — ใช้กับ unbilledAddons
 * except = ไม่นับใบนี้ (ใบที่กำลังซิงก์ตัวเอง) · db = tx เมื่อต้องอ่านหลังล็อกเคสแล้ว
 */
export const billedAddons = (caseId, { except = null, db = sql } = {}) =>
  db
    .all(
      `SELECT addons FROM invoices
       WHERE case_id = :id AND status <> 'cancelled' AND invoice_id IS DISTINCT FROM :except::text`,
      { id: caseId, except },
    )
    .then((rows) => rows.flatMap((r) => r.addons ?? []));

/**
 * รายการคิดเงินเพิ่มของเคสสำหรับใบแจ้งหนี้ = อุปกรณ์/หัตถการของเคส + แพ็กกายภาพเสริมที่เก็บรวมในใบนี้
 *
 * แพ็กเสริมที่ซื้อมาพร้อมเคส Homecare (cases.bill_with_parent) ไม่มีใบของตัวเอง — ใบ Homecare เก็บแทน
 * ประกอบสดจากเคสกายภาพทุกครั้งที่ออก/ซิงก์ใบ: เปลี่ยนแพ็ก/ราคาที่เคสกายภาพ ใบร่างของ Homecare ตาม
 * ยกเลิกเคสกายภาพ = บรรทัดหายจากใบร่าง (ใบที่ออกแล้วไม่ถูกแตะ — ปรับด้วยใบลดหนี้เหมือนอุปกรณ์)
 * ไม่ได้เขียนลง cases.addons ของ Homecare เพราะนั่นคือข้อมูลที่หน้าแก้เคสกรอก จะซ้ำกับยอดในเคสกายภาพ
 */
export async function bundledAddons(caseRow, db = sql) {
  const own = normalizeAddons(caseRow?.addons);
  if (!caseRow?.case_id) return own;
  /* ALTER TABLE ในทรานแซกชันอื่นขณะที่ db (tx) ถือล็อกแถว cases อยู่ = รอกันเองไม่จบ
     ผู้เรียกที่ส่ง tx มาต้องเรียก ensureAddonLink ก่อนเปิดทรานแซกชันเอง (ดู createFromCase) */
  if (db === sql) await ensureAddonLink();
  const rows = await db.all(
    `SELECT c.case_id, c.fee, pp.name AS package_name, pp.sessions
     FROM cases c
     LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
     WHERE c.addon_of = :id AND c.bill_with_parent AND c.status <> 'cancelled'
     ORDER BY c.created_at, c.case_id`,
    { id: caseRow.case_id },
  );
  const lines = rows.map((r) => {
    const name = r.package_name ?? 'แพ็คเกจกายภาพบำบัด';
    // ชื่อแพ็กส่วนใหญ่บอกจำนวนครั้งอยู่แล้ว ("10 ครั้ง 3 เดือน") — เติมเฉพาะตอนยังไม่บอก (เกณฑ์เดียวกับ describeService)
    const sessions = r.sessions && !name.includes(`${r.sessions} ครั้ง`) ? ` · ${r.sessions} ครั้ง` : '';
    return { name: `${name}${sessions}`, quantity: 1, unit_price: Number(r.fee ?? 0), kind: PHYSIO_BUNDLE, ref: r.case_id };
  });
  return [...own, ...lines];
}

/** เคสกายภาพนี้เก็บเงินผ่านเคส Homecare อยู่จริงไหม (ดู bundleCoveredSql ใน cases/addonLink.js) — ใช้ยืนยันหลังซิงก์/ก่อนออกใบแยก */
export const bundleCovered = async (physioCaseId) => {
  await ensureAddonLink();
  return sql
    .one(`SELECT ${bundleCoveredSql('c')} AS ok FROM cases c WHERE c.case_id = :id`, { id: physioCaseId })
    .then((r) => Boolean(r?.ok));
};

/**
 * ใบแจ้งหนี้ของเคส Homecare ที่ยังมีบรรทัดแพ็กกายภาพนี้อยู่ (ไม่นับใบยกเลิก) — ใช้หลังยกเลิกแพ็ก (11 พ.ย. 2569)
 * ใบร่างปกติถูกซิงก์เอาบรรทัดออกไปแล้ว ที่เหลือคือใบที่ระบบแก้ให้ไม่ได้: ออกใบ/รับเงินแล้ว · แบ่งมัดจำ · แก้มือไว้
 * = ลูกค้ายังถูกเรียกเก็บค่าแพ็กที่ยกเลิกไปแล้ว ต้องมีคนออกใบลดหนี้หรือแก้ใบเอง
 */
export async function invoicesHoldingBundle(physioCaseId, parentCaseId) {
  if (!physioCaseId || !parentCaseId) return [];
  return sql.all(
    `SELECT invoice_id, status FROM invoices
     WHERE case_id = :parent AND status <> 'cancelled'
       AND addons @> jsonb_build_array(jsonb_build_object('kind', '${PHYSIO_BUNDLE}', 'ref', :ref::text))
     ORDER BY invoice_id`,
    { parent: parentCaseId, ref: physioCaseId },
  );
}

/** ค่าใช้จ่ายนอกแพ็คเกจของเคสที่ยังไม่ได้ออกใบ — { items, total } (ดู unbilledAddons) */
export async function unbilledExtras(caseRow) {
  const items = unbilledAddons(await bundledAddons(caseRow), await billedAddons(caseRow.case_id));
  return { case_id: caseRow.case_id, items, total: addonsTotal(items) };
}

/**
 * เคสที่มีค่าใช้จ่ายเพิ่มเติมรอออกใบ — หน้ารายการใบแจ้งหนี้ใช้เสนอปุ่มออกใบค่าใช้จ่ายเพิ่มเติม
 * เฉพาะเคสที่มีใบที่ใช้งานอยู่แล้ว: เคสที่ยังไม่มีใบเลย อุปกรณ์จะไปอยู่ในใบแพ็คเกจตอนออกใบตามปกติ
 * (เคสพวกนั้นอยู่ในรายการ "ยังไม่มีใบแจ้งหนี้" อยู่แล้ว)
 */
export async function casesWithUnbilledExtras() {
  const rows = await sql.all(
    `SELECT c.case_id, c.title, c.client_name, c.status, c.start_date, c.end_date, c.addons,
            COALESCE((
              SELECT jsonb_agg(a) FROM invoices i, jsonb_array_elements(i.addons) a
              WHERE i.case_id = c.case_id AND i.status <> 'cancelled'
            ), '[]'::jsonb) AS billed
     FROM cases c
     WHERE c.status <> 'cancelled' AND c.addons <> '[]'::jsonb
       AND EXISTS (SELECT 1 FROM invoices i WHERE i.case_id = c.case_id AND i.status <> 'cancelled')
     ORDER BY c.case_id DESC`,
  );
  return rows
    .map(({ addons, billed, ...c }) => {
      const items = unbilledAddons(addons, billed);
      return { ...c, items, total: addonsTotal(items) };
    })
    .filter((c) => c.items.length > 0)
    .slice(0, 50);
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
   *                 (มักเกิดตอนออกใบไปก่อน แล้วเพิ่งมาผูกผู้ว่าจ้างกับผู้รับบริการ/เคสทีหลัง)
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
  /* เทียบกับยอดสุทธิหลังลดหนี้/เพิ่มหนี้ — เคสขึ้นราคาแล้วออกใบเพิ่มหนี้ตามแล้ว ป้ายต้องหาย */
  const netTotal = Math.round(Number(row.net_total ?? row.total ?? 0) * 100) / 100;
  const planNet = row.plan_net_total == null ? null : Math.round(Number(row.plan_net_total) * 100) / 100;
  const planFee = row.plan_case_fee == null ? null : Math.round(Number(row.plan_case_fee) * 100) / 100;
  /* ใบงวดเทียบทั้งแผน — มัดจำ + ส่วนที่เหลือรวมกันต้องเท่าค่าบริการของเคส (ดู planBillableSql) */
  const bundleLeft = Math.round(Number(row.cancelled_bundle_amount ?? 0) * 100) / 100;
  const bundleStale = bundleLeft > 0;
  const planStale = isPart && !row.has_cancelled_bundle && row.case_id != null && planNet != null && planFee != null && planFee !== planNet;
  const feeStale =
    planStale || (
      !row.has_items && !isPart && !row.has_cancelled_bundle &&
      row.case_id != null && row.case_fee != null && Number(row.case_fee) !== netTotal);
  const payerStale =
    row.case_id != null && row.case_payer_name != null && row.case_payer_name !== row.bill_to_name;
  /* เคสเปลี่ยนแพ็คเกจ/เรทหลังออกใบนี้ — เช็คทุกแบบใบ รวมใบงวดและใบรายครั้งที่ fee_stale ไม่ครอบ
     ใบที่ซิงก์ตามเคสได้จะได้ service_key ใหม่ไปพร้อมยอด จึงไม่ขึ้นป้ายนี้ค้าง */
  const serviceStale =
    row.case_id != null && row.service_key != null && row.case_service_key != null &&
    serviceCore(row.service_key) !== serviceCore(row.case_service_key);

  /* ยอดคงเหลือและ "ยังไม่ครบ" คิดที่นี่ที่เดียว หน้าเว็บจะได้ไม่คำนวณเงินเอง
     ปัดสองตำแหน่งกันเศษทศนิยมลอย (0.1 + 0.2 ของ float) ที่ทำให้ใบจ่ายครบแล้วเหลือค้าง 0.0000001 บาท */
  const paid = Math.round(Number(row.paid_amount ?? 0) * 100) / 100;
  const balance = Math.round((netTotal - paid) * 100) / 100;

  return {
    ...row,
    net_total: netTotal,
    paid_amount: paid,
    received_amount: Math.round(Number(row.received_amount ?? 0) * 100) / 100,
    refunded_amount: Math.round(Number(row.refunded_amount ?? 0) * 100) / 100,
    adjustment_total: Math.round(Number(row.adjustment_total ?? 0) * 100) / 100,
    bad_debt_amount: Math.round(Number(row.bad_debt_amount ?? 0) * 100) / 100,
    balance,
    // รับมาบางส่วนแล้วแต่ยังไม่ครบ — ไม่เก็บเป็นสถานะในฐานข้อมูล คิดตอนอ่านเหมือน "เกินกำหนด"
    is_partial: row.status !== 'cancelled' && paid > 0 && balance > 0,
    // ใบที่ระบบเตรียมไว้ตอนเปิดเคส แต่ยังไม่ได้เลือกว่าจะเก็บเต็มจำนวนหรือแบ่งมัดจำ
    // ยังไม่ใช่เอกสาร — หน้าเว็บจะให้เลือกวิธีเก็บเงินก่อน แล้วค่อยแสดงตัวใบ
    needs_plan: row.status === 'draft' && row.billing_kind == null,
    is_plan_part: isPart,
    is_overdue: row.status === 'issued' && row.due_date != null && row.due_date < TODAY(),
    /* เคสต้นทางถูกยกเลิกไปแล้ว แต่ใบยังเปิดค้างอยู่ — ไม่ใช่ "ข้อมูลไม่ตรง" (is_stale) ที่กดรีเฟรชแล้วจบ
       แต่เป็นคำถามว่ายังจะเก็บเงินใบนี้อยู่ไหม · คนตามเก็บเงินเห็นแต่ยอดค้างในรายการ
       ไม่มีอะไรบอกว่าเคสล่มไปแล้ว แล้วโทรไปทวงลูกค้าที่ยกเลิกบริการไปแล้ว (ตรวจรอบ 13)
       ใบที่ชำระ/ยกเลิกแล้วไม่ต้องเตือน — ไม่มีเงินให้ตามแล้ว */
    case_cancelled: row.case_status === 'cancelled' && (row.status === 'draft' || row.status === 'issued'),
    plan_net_total: planNet,
    plan_case_fee: planFee,
    plan_stale: planStale,
    cancelled_bundle_amount: bundleLeft,
    bundle_stale: bundleStale,
    fee_stale: feeStale,
    payer_stale: payerStale,
    service_stale: serviceStale,
    is_stale: feeStale || payerStale || serviceStale || bundleStale,
  };
};

/* เกณฑ์ "ใบไม่ตรงกับเคสแล้ว" ฉบับ SQL — ต้องตรงกับ feeStale/payerStale/serviceStale ใน withComputed ข้างบนเป๊ะ
   อยู่ติดกันโดยตั้งใจ: แก้กฎที่หนึ่งแล้วอีกที่ต้องแก้ตาม ถ้าวางแยกไฟล์กันวันหนึ่งจะบอกไม่ตรงกัน
   (ต้องมีฉบับ SQL เพราะทั้งกระดิ่งและตัวกรอง ?stale=yes ต้องการเงื่อนไขนี้ใน WHERE
    ดึงใบทั้งหมดมา map ผ่าน withComputed แล้วนับ/กรองฝั่ง JS จะพังทันทีที่ข้อมูลโต)

   ค่าจ้าง / ผู้จ่าย / แพ็คเกจ "ปัจจุบัน" ของเคสอ่านจากเคสแถวเดียวใน EXISTS ก้อนเดียว (optimize 6 พ.ย. 2569)
   — เดิมเป็นซับคิวรีแยกต่อค่า และค่าจ้าง/ผู้จ่ายถูกเขียนสองรอบ (IS NOT NULL แล้วเทียบอีกที) = ค้นเคส 5 รอบต่อใบ
     กระดิ่งนับทุกใบที่ยังไม่ยกเลิกทุกครั้งที่เปลี่ยนหน้า (9,000 ใบ ≈ 450 ms → ~ครึ่งหนึ่ง)
   ผลเท่าเดิมทุกกรณี: case_id เป็น PK (เคสมีได้แถวเดียว) · ไม่พบเคส = ซับคิวรีเดิมได้ NULL ทุกตัว = ไม่ stale
   เหมือน EXISTS ที่ไม่เจอแถว · ใช้ได้เฉพาะในเงื่อนไขบวก (WHERE … AND STALE) เหมือนเดิม ห้ามเอาไปครอบ NOT
   ชื่อย่อ sc/scu/… กันชนกับ c ของคิวรีที่ครอบอยู่

   i.case_id IS NOT NULL ยกขึ้นมาข้างนอก เพราะทุกสาขาต้องการเหมือนกัน */
const STALE_SQL = `
  i.case_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM cases sc
    LEFT JOIN customers sccu ON sccu.customer_id = sc.customer_id
    LEFT JOIN patients spp   ON spp.patient_id   = sc.patient_id
    LEFT JOIN customers spcu ON spcu.customer_id = spp.customer_id
    WHERE sc.case_id = i.case_id AND (
      (NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id)
         AND i.billing_kind IS DISTINCT FROM 'deposit'
         AND i.billing_kind IS DISTINCT FROM 'balance'
         AND NOT ${hasCancelledBundleSql('i')}
         AND (${caseBillableSql('sc', 'i')}) IS NOT NULL
         AND (${caseBillableSql('sc', 'i')}) <> ${netTotalSql('i')})
      OR (i.billing_kind IN ('deposit', 'balance') AND NOT ${hasCancelledBundleSql('i')}
         AND (${planBillableSql('sc', 'i')}) IS NOT NULL
         AND ROUND((${planBillableSql('sc', 'i')})::numeric, 2) <> ROUND((${planNetTotalSql('i')})::numeric, 2))
      OR (${cancelledBundleSql('i')}) > 0
      OR (COALESCE(sccu.name, spcu.name, sc.client_name) IS NOT NULL
          AND COALESCE(sccu.name, spcu.name, sc.client_name) <> i.bill_to_name)
      OR (i.service_key IS NOT NULL
          AND ${serviceCoreSql(`(${serviceKeySql('sc')})`)} <> ${serviceCoreSql('i.service_key')})
    )
  )
`;

/** ใบร่างที่ออกไม่ทันกี่วันถือว่า "ลืม" — หนึ่งสัปดาห์คือรอบการทำงานของฝ่ายบัญชี */
const DRAFT_STALE_DAYS = 7;

/* เกณฑ์ "ใบร่างค้างนานเกินไป" — ใช้ทั้งใน alertCounts() และตัวกรอง ?draft_stale=yes
   เขียนที่เดียวเหมือน STALE_SQL ข้างบน ไม่งั้นกระดิ่งกับหน้าที่มันลิงก์ไปบอกไม่ตรงกัน
   (เคยลิงก์ไป ?status=draft เฉยๆ ซึ่งไม่มีเงื่อนไขอายุ จึงนับ 7 แต่แสดงใบร่างทั้งหมด —
    บังเอิญตรงกันเพราะใบร่างทุกใบเก่ากว่า 7 วันพอดี ระบบเตรียมใบร่างให้เองตอนเปิดเคส
    เปิดเคสใหม่ทีเดียวก็เพี้ยนทันที) */
const DRAFT_STALE_SQL = `
  i.status = 'draft' AND i.issue_date IS NOT NULL AND i.issue_date < :draft_cutoff`;

/** เส้นแบ่ง "ค้างเกินหนึ่งสัปดาห์" — คิดฝั่ง JS ด้วยเวลาไทยเหมือน TODAY() ที่ไฟล์นี้ใช้ทุกที่ */
const draftStaleCutoff = () =>
  new Date(Date.now() + 7 * 3.6e6 - DRAFT_STALE_DAYS * 86_400_000).toISOString().slice(0, 10);

/**
 * ของค้างของหน้าใบแจ้งหนี้ — ตัวเลขสำหรับกระดิ่งแจ้งเตือน (ดู notify/alerts.js)
 * overdue ใช้เกณฑ์เดียวกับ is_overdue ของแถวและกับอีเมลสรุปประจำวัน (notify/repo.js)
 */
export async function alertCounts() {
  await ensurePriceSnapshotColumns();
  const today = TODAY();

  const row = await sql.one(
    `SELECT
       (SELECT COUNT(*) FROM invoices
        WHERE status = 'issued' AND due_date IS NOT NULL AND due_date < :today) AS overdue,

       /* ใบร่างที่ค้างเกินหนึ่งสัปดาห์ — ระบบเตรียมใบไว้ตอนเปิดเคส ถ้าไม่มีใครออก
          ลูกค้าก็ไม่เคยได้รับบิล และไม่มีอะไรบนหน้าจอฟ้องว่ามันค้าง */
       (SELECT COUNT(*) FROM invoices i WHERE ${DRAFT_STALE_SQL}) AS draft_stale,

       (SELECT COUNT(*) FROM invoices i
        WHERE i.status <> 'cancelled' AND (${STALE_SQL})) AS data_stale`,
    { today, draft_cutoff: draftStaleCutoff() },
  );

  return {
    overdue: Number(row.overdue),
    draft_stale: Number(row.draft_stale),
    data_stale: Number(row.data_stale),
  };
}

/**
 * เงื่อนไขกรองที่ใช้ร่วมกันระหว่างรายการกับยอดสรุป — ต้องเป็นก้อนเดียวกันจริงๆ
 * ไม่งั้นตัวเลขสรุปด้านบนจะไม่ตรงกับรายการที่เห็นข้างล่าง (เช่น กรอง "ชำระแล้ว" แต่ยังขึ้น "รอชำระ 5 ใบ")
 */
/* เคสกายภาพ — นิยามเดียวกับ PHYSIO_CASE_SQL ใน cases/repo.js (หน้าเคสกรองด้วยเกณฑ์นี้) */
const PHYSIO_INVOICE_SQL = `EXISTS (SELECT 1 FROM cases sk WHERE sk.case_id = i.case_id
  AND (COALESCE(sk.service_kind, '') = 'physio' OR sk.physio_package_id IS NOT NULL OR sk.case_type = 'physiotherapy'))`;

function buildWhere({ q, status, customer_id, case_id, overdue, stale, draft_stale, pending_slip, hide_cancelled, service_kind, issued_from, issued_to }) {
  const where = [];
  const params = {};

  /* ใบยกเลิกลบไม่ได้ (เลขที่ต้องต่อเนื่อง) แต่ไม่ต้องรกหน้ารายการ — ซ่อนเมื่อหน้าเว็บขอ
     เลือกดูสถานะ "ยกเลิก" ตรง ๆ ยังเห็นครบ (แผนแก้ระบบการเงิน L3) */
  if (hide_cancelled === 'yes' && !status) {
    where.push("i.status <> 'cancelled'");
  }
  if (q) {
    where.push(`(i.invoice_id ILIKE :q OR i.bill_to_name ILIKE :q OR i.case_id ILIKE :q
      OR EXISTS (SELECT 1 FROM cases qc WHERE qc.case_id = i.case_id AND qc.client_name ILIKE :q))`);
    params.q = `%${likeEscape(q)}%`;
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
  /* ใบที่ยอด/ผู้จ่ายไม่ตรงกับเคสแล้ว — ใช้เกณฑ์ก้อนเดียวกับที่กระดิ่งนับ (STALE_SQL)
     ใบที่ยกเลิกไม่นับ เพราะไม่มีใครต้องไปแก้ใบที่ยกเลิกไปแล้ว */
  if (stale === 'yes') {
    where.push(`i.status <> 'cancelled' AND (${STALE_SQL})`);
  }
  /* ใบร่างที่ลืมออก — ใช้เกณฑ์ก้อนเดียวกับที่กระดิ่งนับ (DRAFT_STALE_SQL)
     ไม่ต้องเช็คสถานะเพิ่ม เพราะก้อนนั้นบังคับ status = 'draft' อยู่แล้ว */
  if (draft_stale === 'yes') {
    where.push(`(${DRAFT_STALE_SQL})`);
    params.draft_cutoff = draftStaleCutoff();
  }
  if (pending_slip === 'yes') {
    where.push("EXISTS (SELECT 1 FROM invoice_slips ps WHERE ps.invoice_id = i.invoice_id AND ps.status = 'pending')");
  }
  if (service_kind) {
    where.push(service_kind === 'physio' ? PHYSIO_INVOICE_SQL : `NOT ${PHYSIO_INVOICE_SQL}`);
  }
  // ช่วงวันที่ออกใบ (รวมสองปลาย) — issue_date เก็บเป็นข้อความ YYYY-MM-DD เทียบตรงๆ ได้
  if (issued_from) {
    where.push('i.issue_date >= :issued_from');
    params.issued_from = issued_from;
  }
  if (issued_to) {
    where.push('i.issue_date <= :issued_to');
    params.issued_to = issued_to;
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function list({
  q, status, customer_id, case_id, overdue, stale, draft_stale, pending_slip, hide_cancelled, service_kind, issued_from, issued_to,
  page, per_page, sort, order,
}) {
  await Promise.all([ensureSlipSchema(), ensureLedgerTables(), ensurePriceSnapshotColumns()]);
  const { clause, params } = buildWhere({
    q, status, customer_id, case_id, overdue, stale, draft_stale, pending_slip, hide_cancelled, service_kind, issued_from, issued_to,
  });
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM invoices i ${clause}`, params);

  // NULLS LAST — due_date/paid_at ว่างได้ ถ้าไม่ใส่ การเรียงจากมากไปน้อยจะเอาใบที่ยังไม่ได้ระบุขึ้นก่อน
  const orderBy = sort === 'invoice_id'
    /* เลขใบมีสองรูปแบบปนกัน (INV-0001 เดิม · HC-IV6909010001 ใหม่) เรียงตามตัวอักษร "INV" จะอยู่เหนือ "HC"
       ใบใหม่จึงจมใต้ใบเก่า — เรียงตามเวลาที่ออกใบแทน แล้วใช้เลขใบตัดสินใบที่ออกวินาทีเดียวกัน */
    ? `i.created_at ${order.toUpperCase()}, i.invoice_id ${order.toUpperCase()}`
    : `${sort === 'total' ? netTotalSql('i') : `i.${sort}`} ${order.toUpperCase()} NULLS LAST, i.invoice_id ${order.toUpperCase()}`;
  /* เลือกเลขใบของหน้านี้ก่อน (เรียง+ตัดหน้าบนตาราง invoices อย่างเดียว) แล้วค่อยคิดยอดรับชำระ/ลดหนี้/สลิปของแค่ใบในหน้า
     — เดิมคิดคอลัมน์คำนวณของ "ทุกใบที่เข้าเงื่อนไข" ก่อนแล้วค่อยตัดเหลือ 20 (9,000 ใบ ≈ 150 ms ต่อการเปิดหน้า · optimize 6 พ.ย. 2569)
     orderBy อ้างแค่คอลัมน์ของ i (sort ถูกจำกัดใน schema) และมี invoice_id ตัดสินเสมอ ลำดับจึงเหมือนเดิมทุกแถว
     = ANY(ARRAY(…)) ไม่ใช่ IN (…) — IN ให้ planner เลือก hash semi join ที่คิดทุกใบก่อนได้ · ARRAY ถูกคิดครั้งเดียวแล้วค้นด้วย PK */
  const rows = await sql.all(
    `${SELECT_INVOICE}
     WHERE i.invoice_id = ANY(ARRAY(
       SELECT i.invoice_id FROM invoices i ${clause}
       ORDER BY ${orderBy}
       LIMIT :limit OFFSET :offset))
     ORDER BY ${orderBy}`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return {
    data: rows.map(withComputed),
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

/** ส่งออกได้มากสุดกี่ใบต่อไฟล์ — เพดานกันคำขอที่ไม่มีขอบเขตกินหน่วยความจำ (หนึ่งเดือนของบริษัทนี้ไม่ถึงหลักพัน) */
export const EXPORT_LIMIT = 5000;

/**
 * ใบแจ้งหนี้ทั้งชุดตามตัวกรอง (ไม่แบ่งหน้า) สำหรับไฟล์ CSV รายวัน/สัปดาห์/เดือน — เรียงตามวันที่ออกแล้วเลขใบ
 * ใช้ buildWhere + withComputed ตัวเดียวกับรายการ ยอดในไฟล์จึงตรงกับที่เห็นบนหน้าจอทุกช่อง
 * คืน { data, truncated } — truncated = มีเกินเพดาน (ไฟล์มีแค่ EXPORT_LIMIT ใบแรก)
 */
export async function exportRows(filters) {
  await Promise.all([ensureSlipSchema(), ensureLedgerTables(), ensurePriceSnapshotColumns()]);
  const { clause, params } = buildWhere(filters);
  const rows = await sql.all(
    `${SELECT_INVOICE} ${clause}
     ORDER BY i.issue_date NULLS LAST, i.created_at, i.invoice_id
     LIMIT :limit`,
    { ...params, limit: EXPORT_LIMIT + 1 },
  );
  return { data: rows.slice(0, EXPORT_LIMIT).map(withComputed), truncated: rows.length > EXPORT_LIMIT };
}

/**
 * ใบเดี่ยว + รายการย่อย — หน้ารายการไม่ต้องใช้ items จึงดึงเฉพาะตอนเปิดดูใบจริง
 * items ว่าง = ใบแบบแพ็คเกจบรรทัดเดียว (ส่วนใหญ่เป็นแบบนี้)
 */
export const findById = async (id) => {
  await Promise.all([ensureSlipSchema(), ensureLedgerTables(), ensurePriceSnapshotColumns()]);
  const row = await sql.one(`${SELECT_INVOICE} WHERE i.invoice_id = :id`, { id });
  if (!row) return null;
  /* รายการรับชำระที่ถูกยกเลิกไปแล้วมาด้วย — เงินที่เคยบันทึกแล้วหายไปจากใบต้องมีร่องรอยให้เห็น
     ไม่งั้นคนที่เปิดใบทีหลังอ่านไม่ออกว่าทำไมยอดเปลี่ยน (ตรวจรอบ 13)
     ใบเสร็จ/ใบลดหนี้/ใบเพิ่มหนี้/คืนเงินมาด้วยทุกครั้ง — ยอดสุทธิของใบอ่านไม่ออกถ้าไม่เห็นที่มา */
  const [items, payments, slips, payment_voids, receipts, adjustments, refunds] = await Promise.all([
    listItems(id), listPayments(id), listSlips(id), listPaymentVoids(id).catch(() => []),
    listReceipts(id), listAdjustments(id), listRefunds(id),
  ]);
  return withComputed({ ...row, items, payments, slips, payment_voids, receipts, adjustments, refunds });
};

/** หลัง commit อาจมีคำขออื่นลบใบก่อน SELECT ตอบกลับ — แปลงเป็น conflict แทนการคืน null/เกิด TypeError ที่ route */
export async function invoiceMutationResult(result, loadInvoice = findById) {
  if (result.reason) return result;
  return (await loadInvoice(result.invoice_id)) ?? { reason: 'state_changed' };
}

// ใบแจ้งหนี้ของลูกค้ารายหนึ่งดึงผ่าน list({ customer_id }) ซึ่งมีตัวกรอง/แบ่งหน้าครบอยู่แล้ว
// เคยมี listForCustomer แยกไว้ที่นี่แต่ไม่มีใครเรียก — ลบทิ้งแล้ว

/**
 * เคสที่ไม่มีใบแจ้งหนี้เหลืออยู่เลย (ไม่นับใบที่ยกเลิก) — ปกติระบบออกใบร่างให้ตั้งแต่เปิดเคส
 * ที่ตกมาอยู่ตรงนี้คือใบถูกลบไป (เช่น กด "ไม่ต้อง" หลังลบ) หรือเคสเก่าก่อนมีระบบออกอัตโนมัติ
 * เคสที่ยกเลิกไม่นับ เพราะ POST /api/invoices ไม่ให้ออกใบให้เคสที่ยกเลิกอยู่แล้ว
 */
export const casesWithoutInvoice = () =>
  ensureAddonLink().then(() => sql.all(
    `SELECT c.case_id, c.title, c.client_name, c.status,
            -- ยอดที่ใบจะออก = ค่า Homecare + แพ็กกายภาพที่รวมอยู่ในเคสนี้ (ใบเดียวกัน)
            c.fee + COALESCE((SELECT SUM(b.fee) FROM cases b
                              WHERE b.addon_of = c.case_id AND b.bill_with_parent AND b.status <> 'cancelled'), 0) AS fee
     FROM cases c
     WHERE c.status <> 'cancelled'
       -- แพ็กกายภาพที่รวมอยู่ในเคส Homecare ออกใบที่เคส Homecare (เคสเดียวกันในสายตาคนใช้)
       -- ขึ้นเองเฉพาะตอนเคส Homecare ดูแลการเก็บเงินแพ็กนี้ไม่ได้แล้ว (ดู bundleCoveredSql)
       AND NOT ${bundleCoveredSql('c')}
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.case_id = c.case_id AND i.status <> 'cancelled')
     ORDER BY c.case_id DESC
     LIMIT 50`,
  ));

/** ใบแจ้งหนี้ของเคสหนึ่งใบ — เคสหนึ่งออกได้ใบเดียว แต่ถ้ายกเลิกแล้วออกใหม่ได้ จึงคืนเป็นรายการ */
export const listForCase = async (caseId) => {
  await Promise.all([ensureSlipSchema(), ensureLedgerTables(), ensurePriceSnapshotColumns()]);
  return sql
    .all(`${SELECT_INVOICE} WHERE i.case_id = :id ORDER BY i.created_at DESC, i.invoice_id DESC`, { id: caseId })
    .then((rows) => rows.map(withComputed));
};

/**
 * ใบร่างที่ยังค้างอยู่ของเคส — เคสหนึ่งมีใบร่างได้ทีละใบเท่านั้น
 *
 * ใบร่างคือเอกสารที่ยังไม่ได้ส่งให้ใคร มีสองใบพร้อมกันเมื่อไหร่ก็ไม่มีทางรู้ว่าใบไหนคือใบจริง
 * แถมใบร่างซิงก์ตามเคสให้เองทั้งคู่ (ดู syncOpenFromCase) จึงกลายเป็นใบเหมือนกันเป๊ะสองใบ
 * ต่างจากใบที่ออก/ชำระแล้วซึ่งมีหลายใบต่อเคสได้ตามปกติ (เก็บเป็นงวด หรือออกตามกะที่ไปจริง)
 * ใบค่าใช้จ่ายเพิ่มเติมไม่นับ — มีรายการของตัวเองไม่ซ้ำใบแพ็คเกจ และไม่ซิงก์ตามเคส
 */
export const findDraftForCase = (caseId) =>
  sql.one(
    `SELECT invoice_id FROM invoices
     WHERE case_id = :id AND status = 'draft' AND billing_kind IS DISTINCT FROM 'extra'
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

/* ---------- ยกเลิกรายการรับชำระที่บันทึกผิด (ตรวจรอบ 13) ----------
 *
 * เดิมไม่มีทางแก้เลย: กรอก 500 แทน 5,000 หรือกดบันทึกซ้ำเป็นสองรายการ แล้วยอดค้างกับกราฟรายได้
 * ผิดถาวร ทางเดียวคือยกเลิกใบทั้งใบแล้วออกใหม่ ซึ่งทำให้เลขที่เอกสารข้าม ใบที่ส่งลูกค้าไปแล้ว
 * ใช้ไม่ได้ และลิงก์ใบเสร็จของลูกค้าเปลี่ยนเป็น "ยกเลิกแล้ว" ทั้งที่แค่พิมพ์เลขผิด
 *
 * ลบแถวจริงแทนการติดธง "ยกเลิก" โดยตั้งใจ — ยอดที่รับมาแล้วถูกคิดด้วย SUM(invoice_payments)
 * อยู่ 6 ที่ (ใบ · สรุป · กราฟรายได้ · เพดานรับชำระ · แบ่งมัดจำ · แก้ยอดมัดจำ) ถ้าใช้ธง
 * ต้องไปเติม WHERE ให้ครบทุกที่ พลาดที่เดียว = ตัวเลขเงินสองหน้าจอไม่ตรงกันแบบเงียบ ๆ
 * หลักฐานไม่หาย — สำเนาทั้งแถวย้ายไป invoice_payment_voids พร้อมคนยกเลิกและเหตุผล
 */
let voidsReady = null;
export const ensurePaymentVoidTable = () =>
  (voidsReady ??= sql
    .run(`CREATE TABLE IF NOT EXISTS invoice_payment_voids (
      void_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      invoice_id     TEXT NOT NULL,
      payment_id     INTEGER NOT NULL,
      amount         DOUBLE PRECISION NOT NULL,
      paid_at        TEXT NOT NULL,
      method         TEXT,
      note           TEXT,
      received_by      TEXT,
      received_by_name TEXT,
      payment_created_at TEXT,
      reason         TEXT NOT NULL,
      voided_by      TEXT,
      voided_by_name TEXT,
      voided_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
    )`)
    .catch((err) => { voidsReady = null; throw err; }));

/** ประวัติรายการรับชำระที่ถูกยกเลิกของใบ — โชว์ใต้รายการรับเงิน ไม่ให้เงินหายแบบไร้ร่องรอย */
export async function listPaymentVoids(invoiceId) {
  await ensurePaymentVoidTable();
  return sql.all(
    `SELECT void_id, payment_id, amount, paid_at, method, received_by_name, reason, voided_by_name, voided_at
     FROM invoice_payment_voids WHERE invoice_id = :id ORDER BY void_id`,
    { id: invoiceId },
  );
}

/**
 * ใครยกเลิกรายการไหนได้ — คิดจากข้อมูลล้วน แยกไว้เทสได้โดยไม่ต้องมีฐานข้อมูล
 *   money (ผู้จัดการ/การเงิน/Super Admin) = ทุกรายการ
 *   billing ล้วน (HR/Admin HC) = เฉพาะรายการที่ตัวเองบันทึก และบันทึกวันนี้
 *     — คนกรอกต้องแก้ของตัวเองที่เพิ่งพิมพ์ผิดได้ทันที ไม่ต้องรอผู้จัดการ
 *       แต่ต้องลบรายได้ของเดือนก่อนย้อนหลังไม่ได้
 */
export function assessPaymentVoid(payment, actor, { hasMoneyPermission, today }) {
  if (!payment) return { reason: 'not_found' };
  if (hasMoneyPermission) return { allowed: true };
  if (payment.received_by && actor?.employee_id && payment.received_by === actor.employee_id
      && String(payment.created_at ?? '').slice(0, 10) === today) {
    return { allowed: true };
  }
  return { reason: 'forbidden' };
}

export async function voidPaymentForTransaction(tx, invoiceId, paymentId, { reason }, actor, opts) {
  // ล็อกใบก่อน — สองคนกดยกเลิกรายการเดียวกันพร้อมกันต้องสำเร็จคนเดียว
  const inv = await tx.one(
    `SELECT invoice_id, total, status FROM invoices WHERE invoice_id = :id FOR UPDATE`,
    { id: invoiceId },
  );
  if (!inv) return { reason: 'not_found' };

  const payment = await tx.one(
    `SELECT payment_id, amount, paid_at, method, note, received_by, received_by_name, created_at
     FROM invoice_payments WHERE invoice_id = :id AND payment_id = :pid FOR UPDATE`,
    { id: invoiceId, pid: paymentId },
  );
  const verdict = assessPaymentVoid(payment, actor, opts);
  if (verdict.reason) return verdict;

  /* เงินที่คืนลูกค้าไปแล้วต้องมีเงินรับรองรับอยู่เสมอ — ยกเลิกรายการรับเงินจนยอดรับสุทธิติดลบ
     แปลว่าคืนเงินที่ไม่เคยรับ ให้ยกเลิกไม่ได้ (ต้องดูเรื่องคืนเงินก่อน) */
  const before = await ledgerFor(tx, invoiceId);
  if (roundMoney(before.netPaid - Number(payment.amount)) < 0) return { reason: 'has_refunds' };

  await tx.run(
    `INSERT INTO invoice_payment_voids
       (invoice_id, payment_id, amount, paid_at, method, note, received_by, received_by_name,
        payment_created_at, reason, voided_by, voided_by_name)
     VALUES (:id, :pid, :amount, :paid_at, :method, :note, :rby, :rbyname, :pcreated, :reason, :vby, :vbyname)`,
    {
      id: invoiceId, pid: payment.payment_id, amount: payment.amount, paid_at: payment.paid_at,
      method: payment.method ?? null, note: payment.note ?? null,
      rby: payment.received_by ?? null, rbyname: payment.received_by_name ?? null,
      pcreated: payment.created_at ?? null, reason,
      vby: actor?.employee_id ?? null, vbyname: actor?.name ?? null,
    },
  );
  await tx.run(`DELETE FROM invoice_payments WHERE invoice_id = :id AND payment_id = :pid`,
    { id: invoiceId, pid: payment.payment_id });
  // ใบเสร็จของรายการนี้ไม่หาย แต่กลายเป็น "ยกเลิก" พร้อมเหตุผลเดียวกัน (เลขที่ใบเสร็จต้องไม่ขาดช่วง)
  await voidReceiptForPayment(tx, payment.payment_id, reason, actor);

  /* ยอดที่เหลือหลังยกเลิก → สถานะต้องเดินถอยตาม ไม่งั้นใบขึ้น "ชำระแล้ว" ทั้งที่เงินไม่ครบ
     ใบที่ยกเลิกไปแล้วคงสถานะ cancelled ไว้ (เงินคืนไปแล้ว ใบไม่กลับมามีชีวิต) */
  const after = await ledgerFor(tx, invoiceId);
  const stillPaid = after.balance <= 0;
  if (inv.status !== 'cancelled' && !stillPaid) {
    await tx.run(
      `UPDATE invoices
       SET status = CASE WHEN status = 'paid' THEN 'issued' ELSE status END,
           paid_at = NULL, paid_by = NULL, paid_by_name = NULL, updated_at = ${NOW}
       WHERE invoice_id = :id`,
      { id: invoiceId },
    );
  }
  return { invoice_id: invoiceId, voided_payment_id: payment.payment_id, amount: roundMoney(payment.amount) };
}

export async function voidPayment(invoiceId, paymentId, input, actor, opts) {
  await Promise.all([ensurePaymentVoidTable(), ensureLedgerTables()]);
  const result = await transaction((tx) => voidPaymentForTransaction(tx, invoiceId, paymentId, input, actor, opts));
  return invoiceMutationResult(result);
}

/* ---------- สลิปโอนเงิน ----------
 * ตารางเดิมเก็บรูปอย่างเดียว รอบนี้เพิ่มสถานะ/แหล่งที่มา/ค่าที่ AI อ่าน โดยรันซ้ำได้ทุกคำสั่ง
 * ค่า default confirmed+staff ทำให้สลิปเก่ากับปุ่มแนบของทีมยังทำงานเหมือนเดิมทุกใบ
 */
let slipReady = null;
export const ensureSlipSchema = () =>
  (slipReady ??= (async () => {
    await sql.run("ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed'");
    await sql.run("ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'");
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS extracted_amount DOUBLE PRECISION');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS extracted_date TEXT');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS extracted_ref TEXT');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS extracted_bank TEXT');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS reviewed_at TEXT');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS rejection_reason TEXT');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS payment_id INTEGER');
    await sql.run('ALTER TABLE invoice_slips ADD COLUMN IF NOT EXISTS source_ref TEXT');
    await sql.run('ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS slip_id INTEGER');
    await sql.run("CREATE INDEX IF NOT EXISTS idx_invoice_slips_pending ON invoice_slips (invoice_id, slip_id) WHERE status = 'pending'");
    await sql.run('CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_slips_source_ref ON invoice_slips (source_ref)');
    await sql.run(`CREATE TABLE IF NOT EXISTS invoice_slip_outbox (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      slip_id INTEGER NOT NULL UNIQUE REFERENCES invoice_slips (slip_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      error TEXT
    )`);
    await sql.run('CREATE INDEX IF NOT EXISTS idx_invoice_slip_outbox_pending ON invoice_slip_outbox (created_at) WHERE sent_at IS NULL');
  })().catch((err) => {
    slipReady = null;
    throw err;
  }));

/** สลิปของใบ — รูปดึงแยกทีละใบผ่าน findSlipImage เพื่อไม่ให้ JSON ก้อนใหญ่ */
export async function listSlips(invoiceId) {
  await ensureSlipSchema();
  return sql.all(
    `SELECT slip_id, image_size, uploaded_by_name, status, source,
            extracted_amount, extracted_date, extracted_ref, extracted_bank,
            reviewed_at, reviewed_by_name, rejection_reason, payment_id, created_at
     FROM invoice_slips WHERE invoice_id = :id ORDER BY slip_id`,
    { id: invoiceId },
  );
}

export async function findSlipImage(invoiceId, slipId) {
  await ensureSlipSchema();
  return sql.one(
    'SELECT image_data, image_mime FROM invoice_slips WHERE invoice_id = :id AND slip_id = :slip_id',
    { id: invoiceId, slip_id: slipId },
  );
}

const actorName = (actor) =>
  actor?.name || [actor?.first_name, actor?.last_name].filter(Boolean).join(' ') || null;

/** เพิ่มสลิปในตารางเดิม · pending จากลูกค้าถูกใส่คิวแจ้งทีมใน transaction เดียวกัน */
export async function addSlip(invoiceId, image, actor, {
  status = 'confirmed', source = 'staff', sourceRef = null, extracted = {}, notify = false,
} = {}) {
  await ensureSlipSchema();
  return transaction(async (tx) => {
    const row = await tx.one(
      `INSERT INTO invoice_slips
         (invoice_id, image_data, image_mime, image_size, uploaded_by, uploaded_by_name,
          status, source, source_ref, extracted_amount, extracted_date, extracted_ref, extracted_bank)
       VALUES (:id, :data, :mime, :size, :by, :by_name,
               :status, :source, :source_ref, :amount, :date, :ref, :bank)
       ON CONFLICT (source_ref) DO UPDATE SET source_ref = EXCLUDED.source_ref
       RETURNING slip_id, invoice_id`,
      {
        id: invoiceId, data: image.data, mime: image.mime, size: image.size,
        by: actor?.employee_id ?? null, by_name: actorName(actor), status, source, source_ref: sourceRef,
        amount: extracted.amount ?? null, date: extracted.date ?? null,
        ref: extracted.ref ?? null, bank: extracted.bank ?? null,
      },
    );
    if (notify) {
      await tx.run(
        'INSERT INTO invoice_slip_outbox (slip_id) VALUES (:id) ON CONFLICT (slip_id) DO NOTHING',
        { id: row.slip_id },
      );
    }
    return row;
  });
}

export async function rejectSlip(invoiceId, slipId, actor, reason = null) {
  await ensureSlipSchema();
  return transaction(async (tx) => {
    const changed = await tx.run(
      `UPDATE invoice_slips
          SET status = 'rejected', reviewed_at = ${NOW}, reviewed_by = :by,
              reviewed_by_name = :by_name, rejection_reason = :reason
        WHERE invoice_id = :id AND slip_id = :slip_id AND status = 'pending'`,
      {
        id: invoiceId, slip_id: slipId, by: actor?.employee_id ?? null,
        by_name: actorName(actor), reason: reason || 'ไม่ใช่สลิป/ปฏิเสธโดยทีม',
      },
    );
    if (changed) {
      await tx.run(
        "UPDATE invoice_slip_outbox SET sent_at = now(), error = 'ข้าม: ทีมตรวจสลิปแล้ว' WHERE slip_id = :id AND sent_at IS NULL",
        { id: slipId },
      );
    }
    return changed > 0;
  });
}

export async function removeSlip(invoiceId, slipId) {
  await ensureSlipSchema();
  return sql
    .run('DELETE FROM invoice_slips WHERE invoice_id = :id AND slip_id = :slip_id', { id: invoiceId, slip_id: slipId })
    .then((n) => n > 0);
}

/** คิวสลิปรอตรวจให้ระบบแชทดึงไปแจ้งทีม HomeCare */
export async function slipOutboxPending(limit = 20) {
  await ensureSlipSchema();
  return transaction(async (tx) => {
    const rows = await tx.all(
      `SELECT o.id, s.slip_id, s.invoice_id, s.source, s.extracted_amount, s.extracted_date,
              s.extracted_ref, s.extracted_bank, i.customer_id, i.case_id, i.bill_to_name
         FROM invoice_slip_outbox o
         JOIN invoice_slips s ON s.slip_id = o.slip_id
         JOIN invoices i ON i.invoice_id = s.invoice_id
        WHERE o.sent_at IS NULL AND o.attempts < 3 AND s.status = 'pending'
          AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '10 minutes')
        ORDER BY o.id LIMIT :limit FOR UPDATE OF o SKIP LOCKED`,
      { limit },
    );
    for (const row of rows) {
      await tx.run(
        'UPDATE invoice_slip_outbox SET claimed_at = now(), attempts = attempts + 1 WHERE id = :id',
        { id: row.id },
      );
    }
    return rows;
  });
}

export async function slipOutboxAck(results) {
  await ensureSlipSchema();
  let n = 0;
  for (const r of results.slice(0, 50)) {
    const id = Number(r?.id);
    if (!Number.isInteger(id)) continue;
    n += await sql.run(
      r.ok
        ? 'UPDATE invoice_slip_outbox SET sent_at = now(), error = NULL WHERE id = :id AND sent_at IS NULL'
        : 'UPDATE invoice_slip_outbox SET error = :error, claimed_at = NULL WHERE id = :id AND sent_at IS NULL',
      { id, error: String(r.error || 'แจ้งทีมไม่สำเร็จ').slice(0, 300) },
    );
  }
  return n;
}

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
  const where = [
    'v.case_id = :id',
    'v.check_out_at IS NOT NULL',
    /* กะที่ถูกยกเลิกไม่ใช่ครั้งที่ให้บริการ จึงเก็บเงินไม่ได้ — เกณฑ์เดียวกับทุกที่ที่นับกะ
       (NOT_CANCELLED ใน cases/repo.js) · กะที่ยกเลิก "หลังเช็คเอาท์ไปแล้ว" มีจริง: checkOutVisit
       ยอมบันทึกเวลาออกของกะที่ admin เพิ่งยกเลิก และ /adjust ก็เปลี่ยนสถานะกะที่ทำไปแล้วได้
       ถ้าไม่กรองตรงนี้ กะพวกนั้นจะโผล่เป็นบรรทัดในใบ ขณะที่ booked ข้างล่างไม่นับมันเป็นตัวหาร
       → ราคาต่อครั้งสูงขึ้น แล้วยอดรวมของใบทะลุค่าบริการของเคส (ลูกค้าถูกเก็บเกิน) */
    "v.status <> 'cancelled'",
    /* กะที่อยู่ในใบอื่นที่ยังไม่ยกเลิกแล้ว = เก็บเงินไปแล้ว ไม่เอามาเก็บซ้ำ
       (ออกใบตามกะเป็นรอบๆ ช่วงวันที่เลือกซ้อนกันได้ง่าย หรือกดออกซ้ำโดยไม่ได้ลบใบเดิม) */
    `NOT EXISTS (
       SELECT 1 FROM invoice_items ii
       JOIN invoices bi ON bi.invoice_id = ii.invoice_id
       WHERE ii.visit_id = v.visit_id AND bi.status <> 'cancelled')`,
  ];
  const params = { id: caseRow.case_id };
  if (from) {
    where.push('v.visit_date >= :from');
    params.from = from;
  }
  if (to) {
    where.push('v.visit_date <= :to');
    params.to = to;
  }

  const [visits, booked, billed, remaining] = await Promise.all([
    sql.all(
      `SELECT v.visit_id, v.vn, v.visit_date, v.planned_start, v.planned_end,
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
    sql.one(
      `SELECT COALESCE(SUM(ii.amount), 0) AS amount
         FROM invoice_items ii JOIN invoices i ON i.invoice_id = ii.invoice_id
        WHERE i.case_id = :id AND i.status <> 'cancelled' AND ii.visit_id IS NOT NULL`,
      { id: caseRow.case_id },
    ),
    sql.one(
      `SELECT COUNT(*)::int AS n FROM case_visits v
        WHERE v.case_id = :id AND v.status <> 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM invoice_items ii JOIN invoices i ON i.invoice_id = ii.invoice_id
             WHERE ii.visit_id = v.visit_id AND i.status <> 'cancelled')`,
      { id: caseRow.case_id },
    ),
  ]);

  if (visits.length === 0) return { lines: [], amount: 0 };

  const perVisit = Number(booked.n) > 0 ? (caseRow.fee ?? 0) / Number(booked.n) : 0;
  const rounded = Math.round(perVisit * 100) / 100;
  // เก็บเฉพาะครั้งที่ไปจริง — ยอดรวมจึงเป็นสัดส่วนของกะที่ทำ ไม่ใช่ทั้งแพ็คเกจ
  const isFinalUnbilledBatch = Number(remaining.n) === visits.length;
  const outstanding = Math.max(0, Math.round(((caseRow.fee ?? 0) - Number(billed.amount ?? 0)) * 100) / 100);
  const total = isFinalUnbilledBatch
    ? outstanding
    : Math.round(rounded * visits.length * 100) / 100;

  const lines = visits.map((v, i) => ({
    seq: i + 1,
    visit_id: v.visit_id, // จดไว้ในบรรทัด กันกะนี้ถูกเก็บซ้ำในใบถัดไป (ดู NOT EXISTS ข้างบน)
    description: [
      v.vn, // กายภาพ: หนึ่งนัด = หนึ่ง VN — ใส่ไว้ในบรรทัดให้ลูกค้า/การเงินอ้างอิงครั้งที่ให้บริการได้
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
 * อุปกรณ์เสริมที่ใบนี้เก็บ = ของเคสที่ยังไม่อยู่ในใบอื่น (ดู unbilledAddons) คิดหลังล็อกเคสแล้ว
 *   ใบรายครั้ง/ใบค่าใช้จ่ายเพิ่มเติมต่อท้ายเป็นบรรทัดใน items · ใบแพ็คเกจเก็บในคอลัมน์ addons แล้วหน้าเอกสารแตกบรรทัดเอง
 * extra = ใบค่าใช้จ่ายเพิ่มเติม — มีแต่อุปกรณ์/หัตถการที่เพิ่มเข้าเคสหลังใบแพ็คเกจออกไปแล้ว ไม่มีค่าบริการ
 *   แอดมินกดออกเอง (ดร.ธงชัย 4 พ.ย. 2569) · ไม่มีรายการค้างเก็บ = { reason: 'no_extras' }
 */
export function createFromCase(caseRow, input, actor, visitItems = [], { extra = false } = {}) {
  const customer = caseRow.customer ?? null;

  const baseValues = {
    case_id: caseRow.case_id,
    // ผู้ว่าจ้างที่ route หามาให้ (อาจมาจากแฟ้มผู้รับบริการถ้าเคสยังไม่มี) — ต้องตรงกับ bill_to ด้านล่าง
    // ไม่งั้น "รหัสลูกค้า" ว่างแต่ชื่อขึ้น หรือกลับกัน
    customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
    issue_date: input.issue_date ?? TODAY(),
    due_date: input.due_date ?? null,

    bill_to_name: input.bill_to_name ?? customer?.name ?? caseRow.client_name,
    bill_to_tax_id: input.bill_to_tax_id ?? customer?.tax_id ?? null,
    bill_to_address:
      input.bill_to_address ?? customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,

    service_description:
      input.service_description ??
      (extra ? `ค่าใช้จ่ายเพิ่มเติม — ${describeService(caseRow)}` : describeService(caseRow)),

    payment_method: input.payment_method ?? null,
    note: input.note ?? null,

    // พนักงานที่กดออกใบ — เก็บชื่อ ณ ตอนนั้นไว้เลย ใบจะได้ไม่เปลี่ยนชื่อผู้ทำรายการทีหลัง
    issued_by: actor?.employee_id ?? null,
    issued_by_name: actor?.name ?? null,
    // ใบค่าใช้จ่ายเพิ่มเติมเก็บเต็มจำนวนเสมอ ไม่ต้องถามวิธีเก็บเงิน · ใบอื่นเริ่มที่ NULL ให้เลือกก่อนออก
    billing_kind: extra ? 'extra' : null,
  };

  // ต้องมีคอลัมน์ของแพ็กเสริมก่อนเปิดทรานแซกชัน (ดู bundledAddons)
  return ensureAddonLink().then(() => transaction(async (tx) => {
    /* ล็อกแถวเคสก่อนเช็ค — การออกใบของเคสเดียวกันเข้าคิวทีละคำขอ
       ของเดิมเช็ค "มีใบร่างอยู่แล้วไหม" นอก transaction แล้วค่อย INSERT คำขอสองตัวที่มาพร้อมกัน
       (กดปุ่มซ้ำ / เปิดเคสซ้ำตอนเน็ตกระตุก) จึงผ่านด่านทั้งคู่ได้ใบร่างสองใบ
       เลือกล็อกแทน unique index เพราะฐานจริงอาจมีใบร่างซ้ำค้างอยู่แล้ว สร้าง index จะล้มตอน migrate */
    if (caseRow.case_id) {
      await tx.one('SELECT case_id FROM cases WHERE case_id = :id FOR UPDATE', { id: caseRow.case_id });
    }
    // ใบค่าใช้จ่ายเพิ่มเติมไม่ติดด่านใบร่าง — ใบแพ็คเกจยังเป็นร่างอยู่ได้ (เช่น ใบส่วนที่เหลือที่ยังไม่ถึงกำหนด)
    if (caseRow.case_id && !extra) {
      const draft = await tx.one(
        `SELECT invoice_id FROM invoices
         WHERE case_id = :id AND status = 'draft' AND billing_kind IS DISTINCT FROM 'extra'
         ORDER BY invoice_id LIMIT 1`,
        { id: caseRow.case_id },
      );
      if (draft) return { reason: 'draft_exists', invoice_id: draft.invoice_id };
    }
    /* ใบแพ็คเกจ (ยอดเต็มของเคส) มีได้ชุดเดียว — เคสมีใบที่ออก/ชำระแล้วอยู่ แล้วกดออกใบแพ็คเกจใหม่
       ได้บิลยอดเต็มซ้ำอีกใบ ลูกค้าโดนเก็บสองรอบ (ตรวจ 11 พ.ย. 2569) · ยอดเปลี่ยน = ใบเพิ่มหนี้/ลดหนี้
       ออกใหม่ทั้งใบ = ยกเลิกใบเดิมก่อน · ใบรายครั้ง (มีกะเป็นบรรทัด) และใบค่าใช้จ่ายเพิ่มเติม ออกหลายใบได้ตามปกติ */
    if (caseRow.case_id && !extra && visitItems.length === 0) {
      const pkg = await tx.one(
        `SELECT invoice_id, status FROM invoices i
         WHERE i.case_id = :id AND i.status <> 'cancelled' AND i.billing_kind IS DISTINCT FROM 'extra'
           AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id)
         ORDER BY i.invoice_id LIMIT 1`,
        { id: caseRow.case_id },
      );
      if (pkg) return { reason: 'package_exists', invoice_id: pkg.invoice_id, status: pkg.status };
    }

    // อ่านหลังล็อกเคส — สองคำขอที่มาพร้อมกันจะไม่เก็บอุปกรณ์ชิ้นเดียวกันซ้ำสองใบ
    const addons = caseRow.case_id
      ? unbilledAddons(await bundledAddons(caseRow, tx), await billedAddons(caseRow.case_id, { db: tx }))
      : normalizeAddons(caseRow.addons);
    if (extra && addons.length === 0) return { reason: 'no_extras' };

    const items = extra
      ? addonLines(addons, 1)
      : visitItems.length > 0
        ? [...visitItems, ...addonLines(addons, visitItems.length + 1)]
        : [];

    // ยอดก่อนลด + ส่วนลด แจกแจงมาจากราคาเต็มที่เคสอ้างอิงอยู่ (ดู priceParts)
    // ส่งยอดมาเองก็ให้ส่วนลดเป็นของผู้เรียกล้วนๆ ไม่เดาจากราคาตั้งของเคส จะได้ไม่ขัดกับยอดที่ตั้งใจ
    // ใบที่แตกเป็นรายการใช้ผลรวมของรายการเป็นยอดก่อนลด — ราคาตั้งของแพ็คเกจไม่เกี่ยวแล้ว
    const auto = items.length > 0
      ? { amount: roundMoney(items.reduce((s, i) => s + i.amount, 0)), discount: 0 }
      : priceParts({ ...caseRow, addons });
    const amount = input.amount ?? auto.amount;
    const discount = input.discount ?? (input.amount != null ? 0 : auto.discount);
    const values = {
      ...baseValues,
      amount,
      discount,
      total: Math.max(0, amount - discount),
      addons: JSON.stringify(addons),
    };

    if (caseRow.case_id) {

      // ตรวจกะซ้ำอีกรอบหลังได้ล็อก — visitLines อ่านไว้ก่อนเข้า transaction อาจมีใบอื่นเพิ่งเก็บกะเดียวกันไป
      const visitIds = items.map((l) => l.visit_id).filter((id) => id != null);
      if (visitIds.length > 0) {
        const billed = await tx.one(
          `SELECT ii.visit_id FROM invoice_items ii
           JOIN invoices bi ON bi.invoice_id = ii.invoice_id
           WHERE ii.visit_id = ANY(:ids::int[]) AND bi.status <> 'cancelled'
           LIMIT 1`,
          { ids: visitIds },
        );
        if (billed) return { reason: 'visits_already_billed' };
      }
    }

    const invoiceId = await nextInvoiceId(tx);
    await tx.one(
      `INSERT INTO invoices
         (invoice_id, case_id, customer_id, issue_date, due_date,
          bill_to_name, bill_to_tax_id, bill_to_address,
          service_description, amount, discount, total, payment_method, note,
          issued_by, issued_by_name, addons, billing_kind, service_key)
       VALUES
         (:invoice_id, :case_id, :customer_id, :issue_date, :due_date,
          :bill_to_name, :bill_to_tax_id, :bill_to_address,
          :service_description, :amount, :discount, :total, :payment_method, :note,
          :issued_by, :issued_by_name, :addons, :billing_kind,
          (SELECT ${serviceKeySql('c')} FROM cases c WHERE c.case_id = :case_id))
       RETURNING invoice_id`,
      { ...values, invoice_id: invoiceId },
    );

    for (const line of items) {
      await tx.run(
        `INSERT INTO invoice_items (invoice_id, seq, description, quantity, unit_price, amount, visit_id)
         VALUES (:invoice_id, :seq, :description, :quantity, :unit_price, :amount, :visit_id)`,
        { ...line, visit_id: line.visit_id ?? null, invoice_id: invoiceId },
      );
    }

    return { invoice_id: invoiceId };
  })).then((result) => (result.reason ? result : findById(result.invoice_id)));
}

// ใบที่ยัง "แก้ได้" — เอกสารยังอยู่ในมือเรา ยังไม่ได้ส่งมอบให้ลูกค้าจริง
// ชำระแล้ว = เงินเข้ามือแล้ว ยอดกลายเป็นข้อเท็จจริง · ยกเลิกแล้ว = จบไปแล้ว ทั้งคู่จึงไม่แตะ
const OPEN_STATUSES = "('draft', 'issued')";

/**
 * เคสถูกแก้ -> ดึงข้อมูลใหม่ลงใบที่ยังแก้ได้ของเคสนั้นให้ตรงกัน
 *
 * ยอดก่อนลด/ส่วนลด ถูกคิดใหม่ทั้งคู่จากราคาของเคส (ดู priceParts) — ทับค่าเดิมในใบ
 * เพราะสองตัวนี้เป็นคู่กัน ถ้าอัปเดตแค่ตัวเดียวยอดสุทธิจะเพี้ยนทันที
 *
 * ใบที่ถูกแก้ยอด/ผู้จ่าย/รายการด้วยมือ (manual_edit) ไม่ถูกทับ — สิ่งที่คนตั้งใจแก้ในใบชนะการซิงก์อัตโนมัติ
 * ยกเว้น forceInvoiceId = ใบที่ผู้ใช้กด "ดึงข้อมูลจากเคส" เอง ใบนั้นถูกทับและล้างธงไปพร้อมกัน
 */
export async function syncOpenFromCase(caseRow, customer, { forceInvoiceId = null } = {}) {
  // ต้องมีตาราง invoice_shares ก่อนใช้ใน WHERE ข้างล่าง (สร้างแบบ lazy ตอนส่งลิงก์ครั้งแรก)
  await ensureShareTables();

  /* ทีละใบ เพราะอุปกรณ์ที่ใบหนึ่งเก็บได้ = ของเคสหักที่ใบอื่นเก็บไปแล้ว (ดู unbilledAddons)
     อุปกรณ์ที่อยู่ในใบค่าใช้จ่ายเพิ่มเติมแล้วจึงไม่ถูกดึงกลับเข้าใบแพ็คเกจซ้ำตอนรีเฟรช
     ใบไหนซิงก์ได้จริงยังตัดสินที่ WHERE ของ UPDATE เหมือนเดิม — ตรงนี้แค่ไล่รายชื่อใบที่ยังเปิดอยู่ */
  const open = await sql.all(
    `SELECT invoice_id FROM invoices WHERE case_id = :id AND status IN ${OPEN_STATUSES} ORDER BY invoice_id`,
    { id: caseRow.case_id },
  );
  let changed = 0;
  const source = open.length > 0 ? await bundledAddons(caseRow) : [];
  for (const { invoice_id: target } of open) {
    const addons = unbilledAddons(source, await billedAddons(caseRow.case_id, { except: target }));
    changed += await syncOneFromCase(target, { ...caseRow, addons }, customer, forceInvoiceId);
  }
  return changed;
}

async function syncOneFromCase(target, caseRow, customer, forceInvoiceId) {
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
  return sql.run(
    `UPDATE invoices
     SET customer_id         = :customer_id,
         bill_to_name        = :bill_to_name,
         bill_to_tax_id      = :bill_to_tax_id,
         bill_to_address     = :bill_to_address,
         service_description = :service_description,
         amount              = :amount,
         discount            = :discount,
         total               = GREATEST(0, :amount::double precision - :discount::double precision),
         addons              = :addons,
         service_key         = (SELECT ${serviceKeySql('c')} FROM cases c WHERE c.case_id = invoices.case_id),
         manual_edit         = FALSE,
         updated_at          = ${NOW}
     WHERE invoice_id = :target AND case_id = :case_id AND status IN ${OPEN_STATUSES}
       /* ซิงก์อัตโนมัติเฉพาะใบร่าง — ใบที่กด "ออกใบ" แล้วมีเลขที่เอกสารและถือเป็นเอกสารแล้ว
          ห้ามเปลี่ยนว่าเก็บเงินจากใครเองเงียบ ๆ (ตรวจรอบ 18)
          ย้ายผู้รับบริการไปอยู่ใต้ผู้ว่าจ้างคนใหม่ แล้วใบที่ออกไปแล้วเปลี่ยนชื่อ เลขผู้เสียภาษี
          และที่อยู่ออกบิลเป็นของอีกบ้านทันที โดยไม่มีอะไรบอกคนทำงาน
          ไม่ได้ปิดตาย — ใบที่ไม่ตรงจะขึ้นป้าย "ผู้จ่ายไม่ตรง" (payer_stale) ในรายการและในใบ
          แล้วกดปุ่ม "ดึงข้อมูลจากเคส" เองได้ (เส้นนั้นส่ง force_id มา จึงผ่านเงื่อนไขนี้)
          = ให้คนเห็นแล้วตัดสินใจ แทนที่ระบบจะเปลี่ยนเอกสารให้เอง */
       AND (status = 'draft' OR invoice_id = :force_id::text)
       AND (NOT manual_edit OR invoice_id = :force_id::text)
       /* ใบมัดจำ/ใบส่วนที่เหลือมียอดของงวดนั้นโดยเฉพาะ ซิงก์ทับจะกลายเป็นยอดเต็มทั้งสองใบ
          (ผู้จ่าย/ที่อยู่ก็ไม่ทับด้วย เพราะคำสั่งเดียวกัน — แก้ที่ใบเองหรือลบแล้วแบ่งใหม่) */
       AND billing_kind IS DISTINCT FROM 'deposit'
       AND billing_kind IS DISTINCT FROM 'balance'
       AND billing_kind IS DISTINCT FROM 'extra'
       AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = invoices.invoice_id)
       /* ใบที่ส่งลิงก์ให้ลูกค้าไปแล้วไม่ซิงก์ทับอีก (ตรวจรอบ 18)
          เกณฑ์เดิมคือ "สถานะ issued = เอกสารยังอยู่ในมือเรา ยังไม่ได้ส่งมอบ" ซึ่งจริงตอนที่ส่งมอบ
          มีทางเดียวคือพิมพ์ออกมา · พอมีปุ่มส่งเข้า LINE ลูกค้า (24 ต.ค. 2569) ข้อสันนิษฐานนั้นไม่จริงแล้ว
          ย้ายผู้รับบริการไปอยู่ใต้ผู้ว่าจ้างคนใหม่ แล้วใบที่ลูกค้าถือลิงก์อยู่เปลี่ยนชื่อ เลขผู้เสียภาษี
          และที่อยู่ออกบิลเป็นของอีกบ้านทันที ทั้งที่เขาเปิดลิงก์เดิมดูได้ตลอด 6 เดือน
          (พิสูจน์แล้ว: ก่อนย้าย = บ้าน A/0105566000201 · หลังย้าย = บ้าน B/0105566000202 สถานะยัง issued)
          มีแถวใน invoice_shares = เคยกดส่งให้ลูกค้าแล้ว · ต้องแก้ที่ใบเองหรือออกใบใหม่ */
       AND NOT EXISTS (SELECT 1 FROM invoice_shares sh WHERE sh.invoice_id = invoices.invoice_id)
       /* ใบที่รับเงินมาแล้วบางส่วน ยอดของมันกลายเป็นข้อตกลงกับลูกค้าไปแล้ว — ซิงก์ทับอาจลดยอดให้ต่ำกว่า
          ที่จ่ายมา (ยอดค้างติดลบแต่สถานะยังเป็น issued) ซึ่ง update() กันไว้ด้วย amount_below_paid
          ทางนี้ต้องไม่เป็นประตูหลังให้เลี่ยงด่านนั้น — ถ้าต้องปรับยอดจริงให้แก้ที่ใบเอง */
       AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = invoices.invoice_id)`,
    {
      target,
      case_id: caseRow.case_id,
      force_id: forceInvoiceId,
      customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
      bill_to_name: customer?.name ?? caseRow.client_name,
      bill_to_tax_id: customer?.tax_id ?? null,
      bill_to_address:
        customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,
      service_description: describeService(caseRow),
      amount: price.amount,
      discount: price.discount,
      addons: JSON.stringify(normalizeAddons(caseRow.addons)),
    },
  );
}

/**
 * ปุ่ม "ดึงข้อมูลจากเคส" ของใบที่ออกแล้ว — ดึงเฉพาะผู้จ่าย (ชื่อ เลขผู้เสียภาษี ที่อยู่ออกบิล)
 * ยอด/รายการไม่แตะ: ใบที่ออกแล้วปรับยอดได้ทางใบลดหนี้/เพิ่มหนี้เท่านั้น (ตัดสินใจ 4 พ.ย. 2569)
 */
export async function refreshPayerFromCase(invoiceId, caseRow, customer) {
  return sql.run(
    `UPDATE invoices
     SET customer_id     = :customer_id,
         bill_to_name    = :bill_to_name,
         bill_to_tax_id  = :bill_to_tax_id,
         bill_to_address = :bill_to_address,
         updated_at      = ${NOW}
     WHERE invoice_id = :id AND status = 'issued'`,
    {
      id: invoiceId,
      customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
      bill_to_name: customer?.name ?? caseRow.client_name,
      bill_to_tax_id: customer?.tax_id ?? null,
      bill_to_address: customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,
    },
  );
}

/**
 * รับทราบว่าเคสเปลี่ยนแพ็คเกจหลังออกใบนี้ และตรวจแล้วว่าใบยังใช้ได้ตามเดิม — ปิดป้าย service_stale
 *
 * ใบงวด/ใบรายครั้ง/ใบที่รับเงินแล้วซิงก์ทับไม่ได้ ถ้าไม่มีทางรับทราบ ป้ายจะค้างตลอดไป
 * แม้คนดูแลจะตัดสินใจแล้วว่าเก็บตามแพ็คเกจเดิม (เช่น ลูกค้าจ่ายแพ็คเดิมไปแล้ว ส่วนเพิ่มออกใบแยก)
 * ไม่แตะยอด/รายการในใบ — แค่จดว่าใบนี้ถูกตรวจกับบริการชุดปัจจุบันของเคสแล้ว
 */
export async function acknowledgeService(invoiceId) {
  const changed = await sql.run(
    `UPDATE invoices
     SET service_key = (SELECT ${serviceKeySql('c')} FROM cases c WHERE c.case_id = invoices.case_id),
         updated_at  = ${NOW}
     WHERE invoice_id = :id AND case_id IS NOT NULL AND status <> 'cancelled'`,
    { id: invoiceId },
  );
  return changed === 1 ? findById(invoiceId) : null;
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
      ? [c.physio_package_name, sessions, c.pkg_english && 'ภาษาอังกฤษ']
      : [c.format_name, c.grade_name, c.pkg_staff_tier, c.pkg_english && 'ภาษาอังกฤษ'];

  const service = parts.filter(Boolean).join(' · ');
  // เคสที่ยังไม่รู้ชื่อผู้รับบริการ ไม่พิมพ์ "ผู้รับบริการ: ยังไม่ระบุผู้รับบริการ" ลงเอกสารที่ส่งลูกค้า
  const patient = c.client_name && c.client_name !== PATIENT_PENDING ? c.client_name : null;
  const head = service || c.title;
  /* ยังไม่ได้เลือกบริการ — หัวรายการใช้ชื่อเคสแทน ซึ่งมักเป็นชื่อผู้รับบริการอยู่แล้ว (เติมชื่อผู้รับบริการตอนหลัง)
     ต่อท้าย "ผู้รับบริการ: …" อีกจะได้ "สมชาย — ผู้รับบริการ: สมชาย" ซ้ำคำ จึงข้ามเมื่อหัวรายการมีชื่อนั้นอยู่แล้ว */
  const showPatient = patient && !String(head ?? '').includes(patient);
  return [head, showPatient && `ผู้รับบริการ: ${patient}`]
    .filter(Boolean)
    .join(' — ');
}

/**
 * ทุกอย่างของเคสที่การซิงก์ใบ (syncOpenFromCase) อ่านไปใช้ ย่อเป็นข้อความเดียวไว้เทียบก่อน/หลังแก้เคส
 *
 * ของเดิมซิงก์ทุกครั้งที่บันทึกเคส แม้แก้แค่โน้ตหรือเวลานัด — ใบที่ฝ่ายบัญชีปรับไว้จึงถูกทับโดยไม่มีใครตั้งใจ
 * ประกอบจากผลลัพธ์ของ priceParts/describeService เอง ไม่ใช่รายชื่อคอลัมน์ที่จดแยกไว้
 * วันหนึ่งสองฟังก์ชันนั้นอ่านช่องใหม่เพิ่ม ตัวเทียบนี้จะตามไปเองโดยไม่ต้องจำมาแก้ที่นี่
 * customer_id/patient_id อยู่ด้วยเพราะผู้จ่ายไล่จากสองช่องนี้ (ดู resolvePayer) · address คือที่อยู่ออกบิลสำรอง
 */
export function billingSignature(c) {
  if (!c) return null;
  return JSON.stringify([
    priceParts(c),
    describeService(c),
    normalizeAddons(c.addons),
    c.customer_id ?? null,
    c.patient_id ?? null,
    c.client_name ?? null,
    c.address ?? null,
  ]);
}

/* ทางออกเดียวที่ปลดล็อกยอดใบงวด (ตรวจ 11 พ.ย. 2569): ใบส่วนที่เหลือที่ยังเป็นร่าง แก้ยอดได้
   เฉพาะเมื่อยอดใหม่ทำให้ "ทั้งแผน" เท่ากับค่าบริการของเคสตอนนี้พอดี (ดู planBillableSql)
   เคสขึ้นราคาหลังรับมัดจำแล้ว — ช่อง "ยอดมัดจำ" แก้ไม่ได้ (รับเงินแล้ว) และใบร่างออกใบเพิ่มหนี้ไม่ได้
   เดิมจึงต้องออกใบส่วนที่เหลือด้วยยอดที่รู้ว่าผิด แล้วค่อยตามด้วยใบเพิ่มหนี้
   ยอดอื่นที่ไม่ทำให้แผนตรงกับเคสยังล็อกเหมือนเดิม — ยอดรวมของแผนยังขยับเองตามใจไม่ได้ */
async function balanceRealignsPlan(tx, invoice, input) {
  if (invoice.billing_kind !== 'balance' || invoice.status !== 'draft') return false;
  if ('discount' in input && Number(input.discount ?? 0) !== Number(invoice.discount ?? 0)) return false;
  if (!('amount' in input)) return false;
  const row = await tx.one(
    `SELECT ${planBillableSql('c', 'i')} AS plan_fee,
            ${planNetTotalSql('i')} - ${netTotalSql('i')} AS others
       FROM invoices i JOIN cases c ON c.case_id = i.case_id
      WHERE i.invoice_id = :id`,
    { id: invoice.invoice_id },
  );
  if (row?.plan_fee == null) return false;
  // ยอดสุทธิที่ใบนี้ควรเป็น = ค่าบริการทั้งแผน − ใบอื่นในแผน · ช่อง amount คือยอดก่อนหักส่วนลด
  const target = roundMoney(Number(row.plan_fee) - Number(row.others ?? 0) + Number(invoice.discount ?? 0));
  return target > 0 && roundMoney(input.amount) === target;
}

export async function updateInvoiceForTransaction(tx, invoiceId, rawInput) {
  const locked = await invoiceForUpdate(tx, invoiceId, 'update');
  if (locked.reason) return locked;
  const invoice = locked.invoice;

  /* ใบที่ออกแล้วห้ามแก้ยอดตรง ๆ — ต้องออกใบลดหนี้/เพิ่มหนี้ (ตัดสินใจ 4 พ.ย. 2569 · ดู ledger.js)
     ฟอร์มส่งทุกช่องกลับมาทุกครั้งที่บันทึก จึงปฏิเสธเฉพาะตอนตัวเลขเปลี่ยนจริง ส่วนที่ส่งมาเท่าเดิมตัดทิ้ง
     (ปล่อยไว้จะเข้าทางคิดยอดใหม่ข้างล่าง ซึ่งเทียบกับยอดหน้าใบ ไม่ใช่ยอดหลังลดหนี้/เพิ่มหนี้) */
  const input = { ...rawInput };
  if (invoice.status !== 'draft') {
    for (const c of ['amount', 'discount']) {
      if (!(c in input)) continue;
      if (Number(input[c] ?? 0) !== Number(invoice[c] ?? 0)) return { reason: 'amount_locked_issued', invoice_id: invoiceId };
      delete input[c];
    }
  }

  const fields = EDITABLE.filter((c) => c in input);
  if (fields.length === 0) return { invoice_id: invoiceId };

  /* ส่งลิงก์ให้ลูกค้าไปแล้ว = เอกสารออกนอกระบบแล้ว ห้ามแก้ "หน้าตาเอกสาร" อีก (Codex ข้อ 7 · 8 พ.ย. 2569)
     ลิงก์สาธารณะอ่านใบสดจากฐาน ลูกค้าเปิด URL เดิมแล้วเห็นชื่อผู้จ่าย/ที่อยู่/รายละเอียดบริการคนละชุด
     โดยไม่มีเลขรุ่นอะไรบอกว่าเปลี่ยนไป
     ยอดถูกกันไปแล้วด้านบน (ต้องออกใบลดหนี้/เพิ่มหนี้) ที่เหลือคือช่องข้อความบนเอกสาร
     ช่องภายในที่ไม่ขึ้นเอกสารลูกค้า (เช่น note, payment_method) ยังแก้ได้ตามเดิม */
  const CUSTOMER_FACING = [
    'bill_to_name', 'bill_to_tax_id', 'bill_to_address', 'service_description', 'issue_date', 'due_date',
  ];
  const changedFacing = CUSTOMER_FACING.filter(
    (c) => c in input && (input[c] ?? null) !== (invoice[c] ?? null),
  );
  if (changedFacing.length && (await hasBeenShared(tx, invoiceId))) {
    return { reason: 'already_shared', invoice_id: invoiceId, fields: changedFacing };
  }

  const changesAmount = 'amount' in input || 'discount' in input;
  if (
    changesAmount &&
    (invoice.parent_invoice_id != null || invoice.billing_kind === 'deposit' || invoice.billing_kind === 'balance') &&
    !(await balanceRealignsPlan(tx, invoice, input))
  ) {
    return { reason: 'plan_amount_locked', invoice_id: invoiceId };
  }

  const values = { invoice_id: invoiceId };
  for (const c of fields) values[c] = input[c] ?? null;

  // ยอดสุทธิคิดใหม่ทุกครั้งที่ยอด/ส่วนลดถูกแตะ — ไม่ให้หน้าเว็บส่ง total มาเอง จะได้ไม่มีทางขัดกัน
  const sets = fields.map((c) => `${c} = :${c}`);

  /* แก้ช่องที่การซิงก์ตามเคสจะเขียนทับ = ตั้งธง manual_edit ให้ซิงก์ข้ามใบนี้ (ดู syncOpenFromCase)
     ตั้งเฉพาะตอนค่าเปลี่ยนจริง — ฟอร์มส่งทุกช่องกลับมาทุกครั้งที่บันทึก แก้แค่โน้ตแล้วติดธงไปด้วย
     ใบจะหลุดจากการซิงก์ทั้งที่ไม่มีใครแตะยอดเลย */
  const manualEdit = SYNCED_FIELDS.some(
    (c) =>
      c in input &&
      (c === 'amount' || c === 'discount'
        ? Number(input[c] ?? 0) !== Number(invoice[c] ?? 0)
        : (input[c] ?? null) !== (invoice[c] ?? null)),
  );
  if (manualEdit) sets.push('manual_edit = TRUE');
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
  // ต้องมีตาราง invoice_shares ก่อน — updateInvoiceForTransaction ถามมันว่าใบนี้ส่งลิงก์ไปแล้วหรือยัง
  await Promise.all([ensureShareTables(), ensurePriceSnapshotColumns()]);
  const result = await transaction((tx) => updateInvoiceForTransaction(tx, invoiceId, input));
  return invoiceMutationResult(result);
}

/** ออกใบ (ร่าง -> ออกแล้ว) — หลังจากนี้แก้ไม่ได้ เพราะถือว่าส่งให้ลูกค้าไปแล้ว */
export async function issueInvoiceForTransaction(tx, invoiceId) {
  const locked = await invoiceForUpdate(tx, invoiceId, 'issue');
  if (locked.reason) return locked;
  if (locked.invoice.billing_kind == null) return { reason: 'billing_plan_required' };
  const issueDate = TODAY();
  if (locked.invoice.due_date && locked.invoice.due_date < issueDate) {
    return { reason: 'due_before_issue', issue_date: issueDate, due_date: locked.invoice.due_date };
  }
  // เคสถูกยกเลิกไปแล้ว — ใบของเคสนั้นไม่ควรถูกส่งให้ลูกค้า (ใบร่างเก่าที่หลุดรอดมาก่อนมีการยกเลิกตาม)
  if (locked.invoice.case_id) {
    const caseRow = await tx.one('SELECT status FROM cases WHERE case_id = :id', { id: locked.invoice.case_id });
    if (caseRow?.status === 'cancelled') return { reason: 'case_cancelled' };
  }

  const changed = await tx.run(
    `UPDATE invoices
     SET status = 'issued', issue_date = :issue_date, issued_at = ${NOW}, updated_at = ${NOW}
     WHERE invoice_id = :id AND status = 'draft'`,
    { id: invoiceId, issue_date: issueDate },
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

  const payment = await tx.one(
    `INSERT INTO invoice_payments
       (invoice_id, request_id, amount, paid_at, is_deposit, method, note, received_by, received_by_name, slip_id)
     VALUES (:id, :request_id, :amount, :paid_at, :is_deposit, :method, :note, :by, :by_name, :slip_id)
     RETURNING payment_id`,
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
      slip_id: input.slip_id ?? null,
    },
  );

  if (input.slip_id != null) {
    const changed = await tx.run(
      `UPDATE invoice_slips
          SET status = 'confirmed', reviewed_at = ${NOW}, reviewed_by = :by,
              reviewed_by_name = :by_name, payment_id = :payment_id
        WHERE invoice_id = :id AND slip_id = :slip_id AND status = 'pending'`,
      {
        id: invoiceId, slip_id: input.slip_id, by: actor?.employee_id ?? null,
        by_name: actorName(actor), payment_id: payment.payment_id,
      },
    );
    if (changed !== 1) return { reason: 'slip_unavailable' };
    await tx.run(
      "UPDATE invoice_slip_outbox SET sent_at = now(), error = 'ข้าม: ทีมตรวจสลิปแล้ว' WHERE slip_id = :id AND sent_at IS NULL",
      { id: input.slip_id },
    );
  }

  // ใบเสร็จหนึ่งใบต่อการรับเงินหนึ่งครั้ง — ออกพร้อมกันใน transaction นี้ ไม่มีรับเงินที่ไม่มีใบเสร็จ
  const receiptId = await issueReceipt(tx, {
    invoiceId,
    paymentId: payment.payment_id,
    amount: received,
    paidAt,
    method: input.payment_method ?? null,
    isDeposit,
    balanceAfter: request.balance - received,
    actor,
  });

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
         issued_at = COALESCE(issued_at, ${NOW}),
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

  return { invoice_id: invoiceId, replayed: false, issued_now: issuedNow, receipt_id: receiptId };
}

export async function pay(invoiceId, input, actor) {
  await Promise.all([ensureSlipSchema(), ensureLedgerTables(), ensurePriceSnapshotColumns()]);
  let result;
  try {
    result = await transaction((tx) => payInvoiceForTransaction(tx, invoiceId, input, actor));
  } catch (err) {
    /* request_id ไม่ซ้ำทั้งตาราง แต่การค้นคำขอเดิมดูแค่ในใบนี้ — รหัสเดียวกันที่เคยใช้กับใบอื่น
       ชน unique index แล้วกลายเป็น 500 ทั้งที่จริงคือ "คำขอเดิมแต่ข้อมูลต่างกัน" */
    if (err.code === '23505' && err.constraint === 'uq_invoice_payments_request_id') {
      return { reason: 'idempotency_conflict' };
    }
    throw err;
  }

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
/**
 * มัดจำของใบที่เก็บแพ็กกายภาพเสริมรวมอยู่ด้วย ต้องหักจากค่า Homecare เท่านั้น (ดร.ธงชัย 9 พ.ย. 2569)
 * บรรทัดแพ็กกายภาพ (และอุปกรณ์) ย้ายไปใบส่วนที่เหลือเต็มจำนวน — มัดจำเกินค่า Homecare
 * = ใบส่วนที่เหลือเหลือเงินไม่พอให้บรรทัดเหล่านั้น บรรทัด Homecare ติดลบ/แตกบรรทัดไม่ลง
 * คืนเพดานมัดจำ หรือ null ถ้าใบไม่มีแพ็กกายภาพ (ใบเดิมของระบบใช้กติกาเดิม ไม่เปลี่ยนพฤติกรรม)
 */
function depositCeiling(addons, total) {
  if (!normalizeAddons(addons).some(isPhysioBundle)) return null;
  return roundMoney(Number(total) - addonsTotal(addons));
}

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

  /* ใบรายครั้งแบ่งมัดจำไม่ได้ — บรรทัดรายกะ (รวมกันเท่ายอดเต็ม) จะค้างอยู่ที่ใบมัดจำ
     ใบมัดจำจึงพิมพ์รายการรวมเต็มยอดทั้งที่เรียกเก็บแค่มัดจำ ส่วนอุปกรณ์เสริมที่อยู่ในบรรทัดอยู่แล้ว
     ก็ถูกยกไปใบส่วนที่เหลือซ้ำอีกรอบ — ย้ายบรรทัดให้ถูกต้องไม่ได้ เพราะมัดจำไม่ได้ผูกกับกะไหน */
  if (inv.has_items) return { reason: 'has_items' };

  const deposit = roundMoney(deposit_amount);
  const rest = roundMoney(Number(inv.total) - deposit);
  if (!Number.isFinite(deposit) || deposit <= 0 || rest <= 0) {
    return { reason: 'deposit_not_less_than_total', total: roundMoney(inv.total) };
  }
  const homecareMax = depositCeiling(inv.addons, inv.total);
  if (homecareMax != null && deposit > homecareMax) {
    return { reason: 'deposit_over_homecare', max_deposit: homecareMax };
  }

  // ใบแรกกลายเป็นใบมัดจำ — ส่วนลดถูกคิดไปแล้วในยอดเต็ม จึงไม่ยกมาที่งวด (ไม่งั้นลดซ้ำสองรอบ)
  // อุปกรณ์เสริมย้ายไปอยู่ใบส่วนที่เหลือ (ดู INSERT ด้านล่าง) — ใบมัดจำเป็นเงินก้อนเดียว ไม่แตกบรรทัด
  const changed = await tx.run(
    `UPDATE invoices
     SET billing_kind = 'deposit',
         service_description = :description,
         amount = :amount, discount = 0, total = :amount,
         addons = '[]'::jsonb,
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
        issued_by, issued_by_name, billing_kind, parent_invoice_id, service_key, addons)
     VALUES
       (:invoice_id, :case_id, :customer_id, :issue_date, :due_date,
        :bill_to_name, :bill_to_tax_id, :bill_to_address,
        :description, :amount, 0, :amount, :payment_method, :note,
        :issued_by, :issued_by_name, 'balance', :parent, :service_key, :addons)`,
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
      // งวดที่เหลือออกตามบริการชุดเดียวกับใบมัดจำ ไม่ใช่ของเคสตอนนี้ — ถ้าเคสเปลี่ยนไปแล้วต้องขึ้นป้ายทั้งคู่
      service_key: inv.service_key ?? null,
      /* อุปกรณ์เสริมเก็บในใบส่วนที่เหลือ ให้แยกเป็นบรรทัดของตัวเองออกจากค่าแพ็คเกจได้
         (ยอดส่วนที่เหลือรวมค่าอุปกรณ์ไว้แล้ว เพราะ inv.total = ค่าบริการ + อุปกรณ์) */
      addons: JSON.stringify(normalizeAddons(inv.addons)),
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
    `SELECT invoice_id, billing_kind, ${netTotalSql('invoices')} AS total, status,
            ${netPaidSql('invoices')} AS paid_amount
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
    /* แก้ยอดมัดจำ = แก้ยอดหน้าใบทั้งคู่ — ใบที่ออกแล้วต้องใช้ใบลดหนี้/เพิ่มหนี้แทน (ดู ledger.js) */
    if (row.status !== 'draft') return { reason: 'amount_locked_issued', invoice_id: row.invoice_id };
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

  const homecareMax = depositCeiling(balance.addons, planTotal);
  if (homecareMax != null && depositNew > homecareMax) {
    return { reason: 'deposit_over_homecare', max_deposit: homecareMax };
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

/**
 * ยกเลิก — ไม่ลบทิ้ง เพราะเลขที่เอกสารต้องเรียงต่อเนื่อง ห้ามข้าม
 *
 * ใบที่เป็นงวดหนึ่งของแผนมัดจำ: ใบคู่ที่ยังไม่รับเงินถูกยกเลิกตามไปด้วย (เหตุผลเดียวกับ remove ด้านล่าง —
 * ยกเลิกใบมัดจำใบเดียว ใบส่วนที่เหลือยังเรียกเก็บ "ยอดคงเหลือหลังหักมัดจำ" ทั้งที่ไม่มีมัดจำแล้ว
 * ลูกค้าได้บิลน้อยกว่าที่ตกลงโดยไม่มีอะไรฟ้อง) · ใบคู่รับเงินมาแล้ว = ปฏิเสธ ให้คนตัดสินใจเอง
 * เพราะเงินที่รับแล้วต้องมีใบรองรับ ยกเลิกตามให้อัตโนมัติไม่ได้
 */
export async function cancelInvoiceForTransaction(tx, invoiceId, { reason = null, actor = null } = {}) {
  const audit = { reason, by: actor?.employee_id ?? null, by_name: actorName(actor) };
  const head = await tx.one(
    'SELECT billing_kind, parent_invoice_id FROM invoices WHERE invoice_id = :id',
    { id: invoiceId },
  );
  if (!head) return { reason: 'not_found' };
  if (head.billing_kind === 'deposit' || head.billing_kind === 'balance' || head.parent_invoice_id != null) {
    return cancelPlanPart(tx, invoiceId, audit);
  }

  const locked = await invoiceForUpdate(tx, invoiceId, 'cancel');
  if (locked.reason) return locked;
  /* แถวที่ล็อกแล้วกลายเป็นงวดของแผน (มีคนเพิ่งแบ่งมัดจำระหว่างนี้) — ทางนี้ไม่ได้ล็อกใบคู่ไว้ */
  if (locked.invoice.billing_kind === 'deposit' || locked.invoice.billing_kind === 'balance') {
    return { reason: 'state_changed' };
  }
  const blocked = await moneyHeld(tx, invoiceId);
  if (blocked) return blocked;
  const changed = await tx.run(
    `UPDATE invoices
     SET status = 'cancelled', ${CANCEL_AUDIT}, updated_at = ${NOW}
     WHERE invoice_id = :id AND status <> 'cancelled'`,
    { id: invoiceId, ...audit },
  );
  return changed === 1 ? { invoice_id: invoiceId } : { reason: 'state_changed' };
}

/**
 * ใบที่ยังถือเงินลูกค้าอยู่ยกเลิกไม่ได้ (ตัดสินใจ 4 พ.ย. 2569) — เงินที่รับมาต้องมีใบรองรับเสมอ
 * ทางที่ถูกคือออกใบลดหนี้เต็มยอดพร้อมบันทึกคืนเงิน (ยอดรับสุทธิเหลือ 0) แล้วค่อยยกเลิกใบ
 * ของเดิมยกเลิกใบที่ชำระแล้วได้เลย เงินจึงค้างอยู่บนใบที่ยกเลิกโดยไม่มีเอกสารบอกว่าคืนหรือยัง
 */
async function moneyHeld(tx, invoiceId) {
  const ledger = await ledgerFor(tx, invoiceId);
  return ledger.netPaid > 0 ? { reason: 'has_net_payments', invoice_id: invoiceId, paid: ledger.netPaid } : null;
}

/** ยกเลิกงวดหนึ่งของแผน + ใบคู่ที่ยังไม่รับเงิน — ล็อกทั้งแผนตามลำดับ root → children (ดู invoicePlanForUpdate) */
async function cancelPlanPart(tx, invoiceId, audit) {
  const plan = await invoicePlanForUpdate(tx, invoiceId);
  if (plan.reason) return plan;
  const state = assessInvoiceAction('cancel', plan.target.status);
  if (state.reason) return state;
  const blocked = await moneyHeld(tx, invoiceId);
  if (blocked) return blocked;

  const siblings = plan.rows.filter((row) => row.invoice_id !== invoiceId && row.status !== 'cancelled');
  if (siblings.length > 0) {
    /* อ่านเงินหลังล็อกครบแล้ว — payment ที่เพิ่ง commit ระหว่างรอ lock ต้องถูกนับ
       นับเงินสุทธิหลังคืนเงิน: ใบคู่ที่ลดหนี้และคืนเงินครบแล้วไม่ถือเงินลูกค้าอีก */
    const paymentRows = await tx.all(
      `SELECT i.invoice_id, ${netPaidSql('i')} AS paid
       FROM invoices i
       WHERE i.invoice_id = ANY(:ids::text[])`,
      { ids: siblings.map((row) => row.invoice_id) },
    );
    const paidById = new Map(paymentRows.map((row) => [row.invoice_id, roundMoney(row.paid)]));
    const blocker = siblings.find((row) => (paidById.get(row.invoice_id) ?? 0) > 0);
    if (blocker) return { reason: 'sibling_has_payments', invoice_id: blocker.invoice_id };
  }

  const ids = [invoiceId, ...siblings.map((row) => row.invoice_id)];
  const changed = await tx.run(
    `UPDATE invoices
     SET status = 'cancelled', ${CANCEL_AUDIT}, updated_at = ${NOW}
     WHERE invoice_id = ANY(:ids::text[]) AND status <> 'cancelled'`,
    { ids, ...audit },
  );
  if (changed !== ids.length) throw new Error('ยกเลิกสมาชิกแผนวางบิลได้ไม่ครบ แม้ถือ row lock แล้ว');
  return { invoice_id: invoiceId };
}

/* ใครยกเลิก เมื่อไหร่ เพราะอะไร — ใบคู่ในแผนมัดจำที่ถูกยกเลิกตามไปด้วยได้เหตุผลเดียวกัน */
const CANCEL_AUDIT = `cancel_reason = :reason, cancelled_by = :by, cancelled_by_name = :by_name, cancelled_at = ${NOW}`;

export async function cancel(invoiceId, { reason = null } = {}, actor = null) {
  const result = await transaction((tx) => cancelInvoiceForTransaction(tx, invoiceId, { reason, actor }));
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

  /* ลบถาวรได้เฉพาะใบร่าง (ตัดสินใจ 4 พ.ย. 2569) — ใบที่กดออกแล้วมีเลขที่เอกสาร ต้องยกเลิกแทน
     ใบที่ยกเลิกแล้วก็ลบไม่ได้ เพราะส่วนใหญ่คือใบที่เคยออกไปแล้ว ลบทิ้งแล้วเลขที่ขาดช่วงตรวจย้อนไม่ได้ */
  const issued = candidates.find((row) => row.status !== 'draft');
  if (issued) return { reason: 'not_draft', invoice_id: issued.invoice_id, status: issued.status };

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

  /* เคยออกลิงก์ให้ลูกค้าแล้ว = เอกสารออกนอกระบบไปแล้ว แม้ยังไม่รับเงินก็ห้าม hard delete
     ไม่เช่นนั้น invoice_shares/outbox จะ CASCADE หายและลิงก์ที่ลูกค้าเก็บไว้กลายเป็น 404 ทันที */
  const shared = await tx.one(
    `SELECT invoice_id FROM (
       SELECT invoice_id FROM invoice_shares WHERE invoice_id = ANY(:ids::text[])
       UNION ALL
       SELECT invoice_id FROM invoice_line_outbox WHERE invoice_id = ANY(:ids::text[])
     ) sent
     LIMIT 1`,
    { ids },
  );
  if (shared) return { reason: 'shared_with_customer', invoice_id: shared.invoice_id };

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
  await ensureShareTables();
  return transaction((tx) => removeInvoiceForTransaction(tx, invoiceId));
}

/**
 * ยอดสรุปแยกตามสถานะ — รับตัวกรองชุดเดียวกับ list() เพื่อให้ตัวเลขด้านบนตรงกับรายการที่เห็น
 * ไม่ส่งตัวกรองมา = นับทั้งระบบเหมือนเดิม
 */
export async function summary(filters = {}) {
  await Promise.all([ensureSlipSchema(), ensureLedgerTables(), ensurePriceSnapshotColumns()]);
  const { clause, params } = buildWhere(filters);
  const rows = await sql.all(
    /* outstanding = เงินที่ยังไม่ได้รับจริง (ยอดสุทธิ − ที่รับมาแล้ว)
       ตั้งแต่มีมัดจำ ใบที่ยัง "รอชำระ" อาจรับเงินมาแล้วบางส่วน การรวม total ทั้งใบ
       จะทำให้ตัวเลข "รอชำระ" สูงกว่าเงินที่ต้องตามเก็บจริง แล้วไปวางแผนกระแสเงินสดผิด
       amount = ยอดสุทธิหลังลดหนี้/เพิ่มหนี้ (เงินที่ตกลงเก็บจริง ไม่ใช่ยอดหน้าใบที่ถูกปรับไปแล้ว) */
    `SELECT i.status,
            COUNT(*) AS count,
            SUM(${netTotalSql('i')}) AS amount,
            SUM(GREATEST(0, ${netTotalSql('i')} - ${netPaidSql('i')})) AS outstanding
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
 * เกณฑ์เงินสด: รวมเงินที่รับจริงทุกงวด (invoice_payments) ตามวันที่เงินเข้าของงวดนั้น ไม่ใช่ issue_date
 * ของเดิมนับยอดเต็มของใบที่ "ชำระครบแล้ว" ลงวันรับงวดสุดท้าย — มัดจำที่รับเดือนก่อนไปโผล่เดือนที่ปิดยอด
 * และใบที่รับไปบางงวดแต่ยังไม่ครบไม่ถูกนับเลย ทั้งที่เงินเข้าบัญชีแล้ว
 * ใบที่ยกเลิกแล้วยังนับทั้งเงินเข้าและเงินคืน ตามวันที่เกิดจริง (ตรวจรอบ 6 พ.ย. 2569) — เดิมตัดทิ้งทั้งใบ
 * กดยกเลิกเดือนนี้แล้วรายได้ของเดือนที่รับเงินมาหายย้อนหลัง และเดือนที่คืนเงินก็ไม่เห็นยอดติดลบ
 * ตั้งแต่ 4 พ.ย. 2569 ยกเลิกได้เฉพาะใบที่คืนเงินครบแล้ว (เงินเข้า − เงินคืน = 0) ผลรวมจึงเป็นศูนย์อยู่แล้ว
 * ใบยกเลิกรุ่นเก่าที่ยังถือเงินโดยไม่มีบันทึกคืน (ก่อนกติกานั้น) ยังตัดทิ้งเหมือนเดิม — ไม่มีวันที่คืนให้ลง
 * paid_at เป็นวันที่ตามเวลาไทยอยู่แล้ว (ดู TODAY)
 * invoices = จำนวนใบที่มีเงินเข้าในช่วงนั้น (ใบเดียวรับหลายงวดในช่วงเดียวกันนับครั้งเดียว)
 *
 * ช่วงเวลาถูกกางด้วย generate_series ก่อนแล้วค่อย LEFT JOIN — วันที่ไม่มีใบชำระเลยต้องได้ 0
 * ไม่ใช่หายไปจากผลลัพธ์ ไม่งั้นกราฟเส้นจะลากข้ามช่องว่างเหมือนวันนั้นมีรายได้ต่อเนื่อง
 *
 * หมายเหตุ: "วันนี้" อิงเวลาไทยเหมือน TODAY() ที่ใช้ตอนบันทึกชำระ — เส้นแบ่งวันของกราฟ
 * จึงตรงกับเส้นแบ่งวันของข้อมูลที่บันทึกไว้ และตรงกับวันที่คนดูกราฟเข้าใจ
 */
const COUNTS_AS_REVENUE = `(i.status <> 'cancelled' OR ABS(${netPaidSql('i')}) < 0.005)`;

export async function revenue({ bucket, points }) {
  const { unit, step } = BUCKETS[bucket];
  await ensureLedgerTables();

  const rows = await sql.all(
    `WITH buckets AS (
       SELECT generate_series(
                date_trunc('${unit}', :today::date) - :span::interval,
                date_trunc('${unit}', :today::date),
                '${step}'::interval
              )::date AS bucket
     )
     SELECT to_char(b.bucket, 'YYYY-MM-DD')  AS period,
            COALESCE(SUM(pay.amount), 0)     AS revenue,
            COUNT(DISTINCT pay.invoice_id) FILTER (WHERE pay.amount > 0) AS invoices
     FROM buckets b
     LEFT JOIN (
       SELECT p.invoice_id, p.amount, p.paid_at
       FROM invoice_payments p
       JOIN invoices i ON i.invoice_id = p.invoice_id
       WHERE ${COUNTS_AS_REVENUE}
       UNION ALL
       /* เงินที่คืนลูกค้า (ตามใบลดหนี้) หักออกจากรายได้ของวันที่คืนจริง ไม่ใช่ย้อนไปวันที่รับ */
       SELECT r.invoice_id, -r.amount, r.refunded_at
       FROM invoice_refunds r
       JOIN invoices i ON i.invoice_id = r.invoice_id
       WHERE ${COUNTS_AS_REVENUE} AND r.status = 'active'
     ) pay ON date_trunc('${unit}', LEFT(pay.paid_at, 10)::date)::date = b.bucket
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
