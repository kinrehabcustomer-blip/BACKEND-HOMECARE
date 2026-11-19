import { sql } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { addonAmount, isPhysioBundle, isProcedure, normalizeAddons } from '../lib/addons.js';
import { ensureLedgerTables, netPaidSql, netTotalSql } from './ledger.js';

/**
 * รายได้ตาม BU (ผู้ใช้ขอ 19 พ.ย. 2569 — เมนูแยก + ส่งออกได้)
 *
 * ---------- BU มาจากไหน ----------
 * ไม่ต้องกรอกเพิ่ม — ใบแจ้งหนี้รู้อยู่แล้วว่าเงินแต่ละส่วนมาจากอะไร
 *   homecare / physio = ค่าบริการของใบ ตามสายของเคส (cases.service_kind) · ใบที่ไม่ผูกเคส = other
 *   physio อีกทาง      = แพ็กกายภาพที่เก็บรวมในใบ Homecare (addons kind 'physio')
 *   procedure          = บรรทัดหัตถการ (addons kind 'procedure')
 *   rent / sale        = อุปกรณ์เสริม เช่า (ไม่มี kind) / ซื้อขาด (kind 'sale')
 *
 * ---------- เงินก้อนไหนเป็นของ BU ไหน ----------
 * เกณฑ์เงินสดแบบเดียวกับกราฟรายได้หน้าภาพรวม (invoices/repo.js revenue) — รวมทุก BU = รายได้รวมที่หน้าภาพรวมเห็นพอดี
 *   · เงินแต่ละงวด (invoice_payments) แบ่งตามสัดส่วนของใบนั้น ลงวันที่เงินเข้า
 *   · เงินคืน (invoice_refunds ที่ยัง active) ติดลบตามสัดส่วนเดียวกัน ลงวันที่คืนจริง
 *   · สัดส่วนของใบ: อุปกรณ์/หัตถการ/แพ็กรวมใบ คิดเต็มราคา (ไม่มีส่วนลด — กติกาเดิมของระบบ)
 *     ค่าบริการ = ยอดสุทธิของใบ (หลังลดหนี้/เพิ่มหนี้) − ผลรวมรายการข้างบน → ส่วนลดและใบลด/เพิ่มหนี้ตกที่ BU ของค่าบริการ
 *   · ใบมัดจำไม่มีอุปกรณ์ (ระบบย้ายไปไว้ใบส่วนที่เหลือ) = ค่าบริการทั้งก้อน · ใบค่าใช้จ่ายเพิ่มเติม = อุปกรณ์/หัตถการล้วน
 *   · ปัดเศษแบบเศษเหลือมากสุด (largest remainder) — ทุก BU ของงวดหนึ่งรวมกันเท่ายอดงวดนั้นทุกสตางค์
 *   · เงินที่ลูกค้าจ่ายก่อนเข้าระบบ (เคสกลางทาง · carried_paid) ไม่นับ — ไม่ได้รับผ่านระบบ
 */

export const BUS = [
  { key: 'homecare', label: 'Homecare' },
  { key: 'physio', label: 'กายภาพบำบัด' },
  { key: 'procedure', label: 'หัตถการ' },
  { key: 'rent', label: 'อุปกรณ์ (เช่า)' },
  { key: 'sale', label: 'อุปกรณ์ (ขาย)' },
  { key: 'other', label: 'ไม่ระบุบริการ' },
];
const BU_KEYS = BUS.map((b) => b.key);
const zero = () => Object.fromEntries(BU_KEYS.map((k) => [k, 0]));
const round2 = (n) => Math.round(n * 100) / 100;

// ใบที่นับเป็นรายได้ — เงื่อนไขเดียวกับ COUNTS_AS_REVENUE ใน invoices/repo.js (ใบยกเลิกรุ่นเก่าที่ยังถือเงินไม่นับ)
const COUNTS_AS_REVENUE = `(i.status <> 'cancelled' OR ABS(${netPaidSql('i')}) < 0.005)`;

/** สัดส่วนของใบหนึ่ง { bu: ยอด } — ดูหัวไฟล์ */
export function invoiceParts({ net_total: netTotal, addons, service_kind: kind, has_case: hasCase }) {
  const parts = zero();
  let extras = 0;
  for (const a of normalizeAddons(addons)) {
    const amt = addonAmount(a);
    const bu = isPhysioBundle(a) ? 'physio' : isProcedure(a) ? 'procedure' : a.kind === 'sale' ? 'sale' : 'rent';
    parts[bu] += amt;
    extras += amt;
  }
  const serviceBu = !hasCase ? 'other' : kind === 'physio' ? 'physio' : 'homecare';
  parts[serviceBu] += Math.max(0, round2(Number(netTotal ?? 0) - extras));
  // ใบที่ยอดเป็นศูนย์ทั้งใบแต่มีเงินเข้า (ไม่ควรเกิด) — ให้ตกที่ BU ของค่าบริการ ไม่หายจากผลรวม
  if (Object.values(parts).every((v) => v <= 0)) parts[serviceBu] = 1;
  return parts;
}

/** แบ่งเงินหนึ่งก้อนตามสัดส่วน — ปัดเป็นสตางค์แบบเศษเหลือมากสุด ผลรวมเท่ายอดเดิมพอดี (ติดลบได้ = เงินคืน) */
export function allocate(amount, parts) {
  const sign = amount < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(amount) * 100);
  const keys = BU_KEYS.filter((k) => parts[k] > 0);
  const sum = keys.reduce((s, k) => s + parts[k], 0);
  const raw = keys.map((k) => ({ k, exact: (cents * parts[k]) / sum }));
  const base = raw.map((r) => ({ ...r, c: Math.floor(r.exact) }));
  let left = cents - base.reduce((s, r) => s + r.c, 0);
  [...base].sort((a, b) => (b.exact - b.c) - (a.exact - a.c)).forEach((r) => {
    if (left > 0) { r.c += 1; left -= 1; }
  });
  const out = {};
  for (const r of base) if (r.c !== 0) out[r.k] = (sign * r.c) / 100;
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addMonths = (iso, n) => {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
};
const monthEnd = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** ช่วงก่อนหน้าที่ยาวเท่ากัน — ช่วงที่เป็นเดือนเต็ม (1 ถึงสิ้นเดือน) ถอยเป็นเดือน ไม่งั้นถอยเป็นวัน */
export function previousRange(from, to) {
  if (from.endsWith('-01') && to === monthEnd(to)) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    const pFrom = addMonths(from, -months);
    return { from: pFrom, to: addDays(from, -1) };
  }
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** หัวช่วงของวันหนึ่งตามความละเอียด — สัปดาห์เริ่มวันจันทร์ (แบบเดียวกับกราฟรายได้) */
function bucketOf(date, group) {
  if (group === 'month') return date.slice(0, 7);
  if (group === 'week') {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    return addDays(date, -((dow + 6) % 7));
  }
  return date;
}

/** หัวช่วงทั้งหมดในช่วงวันที่ — ช่วงที่ไม่มีเงินเข้าต้องได้ 0 ไม่ใช่หายไป */
function bucketsIn(from, to, group) {
  const out = [];
  let cur = bucketOf(from, group);
  const last = bucketOf(to, group);
  while (cur <= last && out.length < 400) {
    out.push(cur);
    cur = group === 'month' ? addMonths(`${cur}-01`, 1).slice(0, 7) : addDays(cur, group === 'week' ? 7 : 1);
  }
  return out;
}

export function checkRange(from, to) {
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '')) throw new ApiError(400, 'ช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD)');
  if (from > to) throw new ApiError(400, 'วันเริ่มต้องไม่เกินวันสิ้นสุด');
  if (daysBetween(from, to) > 3 * 366) throw new ApiError(400, 'เลือกช่วงได้ไม่เกิน 3 ปี');
}

/**
 * เงินเข้า/ออกในช่วง แบ่ง BU แล้ว — แถวละหนึ่ง BU ของหนึ่งงวด
 * [{ date, type: 'payment'|'refund', ref_id, invoice_id, bill_to_name, case_id, method, entry_amount, bu, amount }]
 */
export async function allocatedEntries(from, to) {
  await ensureLedgerTables();
  const entries = await sql.all(
    `SELECT 'payment' AS type, p.payment_id AS ref_id, p.invoice_id, p.amount, LEFT(p.paid_at, 10) AS date, p.method
       FROM invoice_payments p JOIN invoices i ON i.invoice_id = p.invoice_id
      WHERE ${COUNTS_AS_REVENUE} AND LEFT(p.paid_at, 10) BETWEEN :from AND :to
     UNION ALL
     SELECT 'refund', r.refund_id, r.invoice_id, -r.amount, LEFT(r.refunded_at, 10), r.method
       FROM invoice_refunds r JOIN invoices i ON i.invoice_id = r.invoice_id
      WHERE ${COUNTS_AS_REVENUE} AND r.status = 'active' AND LEFT(r.refunded_at, 10) BETWEEN :from AND :to
     ORDER BY 5, 1, 2`,
    { from, to },
  );
  if (entries.length === 0) return [];
  const ids = [...new Set(entries.map((e) => e.invoice_id))];
  const invoices = await sql.all(
    `SELECT i.invoice_id, i.bill_to_name, i.case_id, i.addons, ${netTotalSql('i')} AS net_total,
            c.service_kind, (c.case_id IS NOT NULL) AS has_case
       FROM invoices i LEFT JOIN cases c ON c.case_id = i.case_id
      WHERE i.invoice_id = ANY(:ids::text[])`,
    { ids },
  );
  const byId = new Map(invoices.map((inv) => [inv.invoice_id, { ...inv, parts: invoiceParts(inv) }]));
  const out = [];
  for (const e of entries) {
    const inv = byId.get(e.invoice_id);
    const split = allocate(Number(e.amount), inv.parts);
    for (const bu of BU_KEYS) {
      if (split[bu] == null) continue;
      out.push({
        date: e.date,
        type: e.type,
        ref_id: e.ref_id,
        invoice_id: e.invoice_id,
        bill_to_name: inv.bill_to_name,
        case_id: inv.case_id,
        method: e.method,
        entry_amount: round2(Number(e.amount)),
        bu,
        amount: split[bu],
      });
    }
  }
  return out;
}

function summarize(rows) {
  const totals = zero();
  const invoices = Object.fromEntries(BU_KEYS.map((k) => [k, new Set()]));
  const cases = Object.fromEntries(BU_KEYS.map((k) => [k, new Set()]));
  for (const r of rows) {
    totals[r.bu] = round2(totals[r.bu] + r.amount);
    if (r.type === 'payment') {
      invoices[r.bu].add(r.invoice_id);
      if (r.case_id) cases[r.bu].add(r.case_id);
    }
  }
  return {
    totals,
    total: round2(Object.values(totals).reduce((s, v) => s + v, 0)),
    invoices: Object.fromEntries(BU_KEYS.map((k) => [k, invoices[k].size])),
    cases: Object.fromEntries(BU_KEYS.map((k) => [k, cases[k].size])),
  };
}

/** สรุปตาม BU + ชุดข้อมูลรายช่วงสำหรับกราฟ + ช่วงก่อนหน้าไว้เทียบ */
export async function revenueByBu({ from, to, group }) {
  checkRange(from, to);
  const prev = previousRange(from, to);
  const [rows, prevRows] = await Promise.all([allocatedEntries(from, to), allocatedEntries(prev.from, prev.to)]);

  const series = bucketsIn(from, to, group).map((period) => ({ period, values: zero(), total: 0 }));
  const at = new Map(series.map((s) => [s.period, s]));
  for (const r of rows) {
    const s = at.get(bucketOf(r.date, group));
    if (!s) continue;
    s.values[r.bu] = round2(s.values[r.bu] + r.amount);
    s.total = round2(s.total + r.amount);
  }

  return {
    from,
    to,
    group,
    bus: BUS,
    ...summarize(rows),
    previous: { ...prev, ...summarize(prevRows) },
    series,
  };
}
