import { costRows as partnerCostRows } from '../partners/repo.js';
import { sql, transaction } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { todayTh } from '../lib/dates.js';
import { addonAmount, isPhysioBundle, isProcedure, normalizeAddons } from '../lib/addons.js';
import { ensureAddonLink, ensureCasePriceSnapshots } from '../cases/repo.js';
import { ensureFormatDays } from '../packages/formatDays.js';
import { ensureLedgerTables, netPaidSql, netTotalSql } from './ledger.js';

/**
 * รายงานรายได้ตาม BU ชุดใหม่ (ผู้ใช้ขอ 20 พ.ย. 2569 — "ทำข้อ 1–5 + ส่วนที่แนะนำ · รื้อของเก่าออกก่อน")
 * แทนที่ invoices/revenueBu.js + หน้าเจาะดูระดับบรรทัดเดิมทั้งหมด
 *
 *   1. กำไรขั้นต้น ตาม BU / แพ็กเกจ / พนักงานหลัก — ต้นทุน = ค่าจ้างที่ปล่อยจ่ายจริง (case_payouts ตามวันที่ปล่อย) · สิทธิ์ see_pay
 *   2. เทียบปีก่อน (ช่วงวันเดียวกันของปีที่แล้ว) + เป้ารายเดือนต่อ BU (revenue_targets · ตั้งได้เฉพาะ Super Admin/ผู้จัดการ)
 *   3. รับรู้รายได้ตามบริการที่ส่งมอบจริง — Homecare นับวันที่เช็คอิน · กายภาพนับครั้งที่เช็คอิน
 *      → รายได้รับล่วงหน้า (รับเงินแล้วยังไม่ได้ให้บริการ) · ให้บริการแล้วยังไม่ได้รับเงิน
 *   4. ลูกค้า: อัตราต่อเคส · อัตรายกเลิก + เหตุผล · การกระจุกตัวของลูกค้า 10 อันดับแรก
 *   5. ลูกหนี้ตาม BU แยกอายุหนี้ (ณ วันนี้)
 *   เสริม: ส่วนลด/เงินคืนต่อ BU · ราคาขายจริงเทียบราคาตั้งต่อแพ็กเกจ
 *
 * ---------- เงินก้อนไหนเป็นของ BU ไหน (กติกาเดิมของหน้า BU) ----------
 * ใบแจ้งหนี้แตกเป็นชิ้น (slice): ค่าบริการ · แพ็กกายภาพรวมใบ · หัตถการ · อุปกรณ์เช่า/ขาย
 *   อุปกรณ์/หัตถการ/แพ็กรวมใบ คิดเต็มราคา · ค่าบริการ = ยอดสุทธิของใบ (หลังลด/เพิ่มหนี้) − ชิ้นอื่น
 *   เงินแต่ละงวดแบ่งลงชิ้นตามสัดส่วน ปัดสตางค์แบบเศษเหลือมากสุด (ผลรวมเท่ายอดงวดทุกสตางค์) · เงินคืนติดลบสัดส่วนเดียวกัน
 *   ชิ้นค่าบริการเป็นของเคสในใบ · ชิ้นแพ็กกายภาพรวมใบเป็นของเคสกายภาพที่อ้าง (ref) — ต้นทุน/การรับรู้ตามไปที่เคสนั้น
 *   เงินที่จ่ายก่อนเข้าระบบ (carried_paid) และค่าจ้างก่อนเข้าระบบ (carried_staff_paid) ไม่นับทั้งสองฝั่ง
 *
 * ---------- รับรู้รายได้ (ข้อ 3) ----------
 * เคสแพ็ก = มีจำนวนหน่วยแน่นอน (รูปแบบ Homecare ที่มีจำนวนวัน · แพ็กกายภาพ) และมีราคา
 *   ราคาต่อหน่วย = (ราคาเคส − จ่ายก่อนเข้าระบบ + ลด/เพิ่มหนี้ของใบเคส ยกเว้นหนี้สูญ) ÷ (หน่วยทั้งแพ็ก − หน่วยที่ใช้ก่อนเข้าระบบ)
 *   รับรู้ในวันที่ให้บริการ (วันที่ของนัดที่เช็คอิน) · ให้บริการเกินแพ็กไม่รับรู้เพิ่ม
 * อย่างอื่นทั้งหมด (อุปกรณ์ · หัตถการ · เคสไม่มีแพ็ก) รับรู้วันที่ออกใบ
 */

export const BUS = [
  { key: 'homecare', label: 'Homecare' },
  { key: 'physio', label: 'กายภาพบำบัด' },
  { key: 'procedure', label: 'หัตถการ' },
  { key: 'rent', label: 'อุปกรณ์ (เช่า)' },
  { key: 'sale', label: 'อุปกรณ์ (ขาย)' },
  { key: 'other', label: 'ไม่ระบุบริการ' },
];
export const BU_KEYS = BUS.map((b) => b.key);
const BU_LABEL = Object.fromEntries(BUS.map((b) => [b.key, b.label]));
/** BU ที่ตั้งเป้าได้ — "ไม่ระบุบริการ" คือใบที่ไม่ผูกเคส ไม่ใช่สายธุรกิจ */
export const TARGET_BUS = BU_KEYS.filter((k) => k !== 'other');

const zero = () => Object.fromEntries(BU_KEYS.map((k) => [k, 0]));
export const round2 = (n) => Math.round(Number(n) * 100) / 100;
const add = (obj, key, v) => { obj[key] = round2((obj[key] ?? 0) + v); };

// ใบที่นับเป็นรายได้ — เงื่อนไขเดียวกับ COUNTS_AS_REVENUE ใน invoices/repo.js (ใบยกเลิกรุ่นเก่าที่ยังถือเงินไม่นับ)
const COUNTS_AS_REVENUE = `(i.status <> 'cancelled' OR ABS(${netPaidSql('i')}) < 0.005)`;
const PERSON = (a) => `NULLIF(btrim(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, '')), '')`;

/* ============================== วันที่ ============================== */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const addMonths = (iso, n) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
export const monthEnd = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const daysInMonth = (ym) => Number(monthEnd(`${ym}-01`).slice(8));

export function checkRange(from, to) {
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '')) throw new ApiError(400, 'ช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD)');
  if (from > to) throw new ApiError(400, 'วันเริ่มต้องไม่เกินวันสิ้นสุด');
  if (daysBetween(from, to) > 3 * 366) throw new ApiError(400, 'เลือกช่วงได้ไม่เกิน 3 ปี');
}

/** ช่วงก่อนหน้าที่ยาวเท่ากัน — ช่วงเดือนเต็ม (1 ถึงสิ้นเดือน) ถอยเป็นเดือน ไม่งั้นถอยเป็นวัน */
export function previousRange(from, to) {
  if (from.endsWith('-01') && to === monthEnd(to)) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    return { from: addMonths(from, -months), to: addDays(from, -1) };
  }
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** วันเดียวกันของปีก่อน — 29 ก.พ. ถอยเป็น 28 ก.พ. · วันสิ้นเดือนถอยเป็นวันสิ้นเดือน (สิ้น ก.พ. ปีอธิกสุรทิน) */
export function lastYear(iso) {
  const y = Number(iso.slice(0, 4)) - 1;
  const ym = `${y}-${iso.slice(5, 7)}`;
  const last = daysInMonth(ym);
  const isMonthEnd = iso === monthEnd(iso);
  const day = isMonthEnd ? last : Math.min(Number(iso.slice(8)), last);
  return `${ym}-${String(day).padStart(2, '0')}`;
}
export const lastYearRange = (from, to) => ({ from: lastYear(from), to: lastYear(to) });

/** เดือนที่ช่วงครอบ 'YYYY-MM' เรียงจากเก่าไปใหม่ */
export function monthsIn(from, to) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 60; m = addMonths(`${m}-01`, 1).slice(0, 7)) out.push(m);
  return out;
}

/** จำนวนวันของเดือนนี้ที่อยู่ในช่วง — ใช้เฉลี่ยเป้ารายเดือนลงช่วงที่ไม่เต็มเดือน */
export function overlapDays(ym, from, to) {
  const s = `${ym}-01` > from ? `${ym}-01` : from;
  const e = monthEnd(`${ym}-01`) < to ? monthEnd(`${ym}-01`) : to;
  return s > e ? 0 : daysBetween(s, e) + 1;
}

/* ============================== แบ่งเงิน ============================== */

/** แบ่งยอดหนึ่งก้อนตามน้ำหนัก — ปัดสตางค์แบบเศษเหลือมากสุด ผลรวมเท่ายอดเดิมทุกสตางค์ (ติดลบได้ = เงินคืน) */
export function allocateLines(amount, weights) {
  const sign = amount < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(amount) * 100);
  const idx = weights.map((w, i) => ({ i, w: Math.max(0, Number(w) || 0) }));
  let sum = idx.reduce((s, x) => s + x.w, 0);
  if (sum <= 0) {
    idx.forEach((x) => { x.w = 1; });
    sum = idx.length;
  }
  const base = idx.map((x) => ({ ...x, exact: (cents * x.w) / sum }));
  base.forEach((x) => { x.c = Math.floor(x.exact); });
  let left = cents - base.reduce((s, x) => s + x.c, 0);
  [...base].sort((a, b) => (b.exact - b.c) - (a.exact - a.c)).forEach((x) => {
    if (left > 0) { x.c += 1; left -= 1; }
  });
  const out = new Array(weights.length).fill(0);
  for (const x of base) out[x.i] = (sign * x.c) / 100;
  return out;
}

/**
 * ชิ้นของใบหนึ่ง [{ bu, kind, case_id, weight }] — kind: service · bundle · procedure · rent · sale
 * case_id = เคสเจ้าของชิ้น (แพ็กรวมใบ = เคสกายภาพที่อ้าง · ไม่มี ref = ไม่ผูกเคส)
 */
export function invoiceSlices({ net_total: netTotal, addons, service_kind: kind, case_id: caseId }) {
  const out = [];
  let extras = 0;
  for (const a of normalizeAddons(addons)) {
    const amt = addonAmount(a);
    extras += amt;
    if (isPhysioBundle(a)) out.push({ bu: 'physio', kind: 'bundle', case_id: a.ref ?? null, weight: amt });
    else if (isProcedure(a)) out.push({ bu: 'procedure', kind: 'procedure', case_id: caseId ?? null, weight: amt });
    else {
      const sale = a.kind === 'sale';
      out.push({ bu: sale ? 'sale' : 'rent', kind: sale ? 'sale' : 'rent', case_id: caseId ?? null, weight: amt });
    }
  }
  const serviceBu = !caseId ? 'other' : kind === 'physio' ? 'physio' : 'homecare';
  out.push({ bu: serviceBu, kind: 'service', case_id: caseId ?? null, weight: Math.max(0, round2(Number(netTotal ?? 0) - extras)) });
  // ใบที่ยอดเป็นศูนย์ทั้งใบแต่มีเงินเข้า (ไม่ควรเกิด) — ให้ตกที่ค่าบริการ ไม่หายจากผลรวม
  if (out.every((s) => s.weight <= 0)) out[out.length - 1].weight = 1;
  return out;
}

/** สัดส่วนต่อ BU ของใบ { bu: ยอด } — ใช้แบ่งยอดค้างชำระ */
export function invoiceParts(inv) {
  const parts = zero();
  for (const s of invoiceSlices(inv)) parts[s.bu] += s.weight;
  return parts;
}

/* ============================== โหลดข้อมูล ============================== */

let targetsReady = null;
export const REVENUE_TARGET_DDL = `
CREATE TABLE IF NOT EXISTS revenue_targets (
  month           TEXT NOT NULL CHECK (month ~ '^\\d{4}-\\d{2}$'),
  bu              TEXT NOT NULL CHECK (bu IN ('homecare', 'physio', 'procedure', 'rent', 'sale')),
  amount          DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
  updated_by      TEXT,
  updated_by_name TEXT,
  updated_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (month, bu)
);`;
/** ตารางของจริงสร้างตอน migrate — ตัวนี้กันกรณี deploy โค้ดก่อนรัน migrate */
export const ensureReportTables = () =>
  (targetsReady ??= (async () => {
    await Promise.all([ensureLedgerTables(), ensureCasePriceSnapshots(), ensureAddonLink(), ensureFormatDays()]);
    await sql.run(REVENUE_TARGET_DDL);
  })().catch((err) => { targetsReady = null; throw err; }));

/** ใบแจ้งหนี้ตามรหัส + ชิ้นของใบ */
async function loadInvoices(ids) {
  if (ids.length === 0) return new Map();
  const rows = await sql.all(
    `SELECT i.invoice_id, i.bill_to_name, i.customer_id, i.case_id, i.addons, i.issue_date, i.status,
            i.discount, ${netTotalSql('i')} AS net_total, c.service_kind, cu.name AS customer_name
       FROM invoices i
       LEFT JOIN cases c ON c.case_id = i.case_id
       LEFT JOIN customers cu ON cu.customer_id = i.customer_id
      WHERE i.invoice_id = ANY(:ids::text[])`,
    { ids },
  );
  return new Map(rows.map((inv) => {
    // ใบที่อ้างเคสที่ถูกลบไปแล้ว (case_id ถูกตั้งเป็น NULL) = ไม่ผูกเคส
    const v = { ...inv, net_total: Number(inv.net_total) };
    return [inv.invoice_id, { ...v, slices: invoiceSlices(v) }];
  }));
}

const customerOf = (inv) => ({
  key: inv.customer_id ?? `name:${(inv.bill_to_name ?? '').trim()}`,
  label: inv.customer_name ?? inv.bill_to_name ?? 'ไม่ระบุลูกค้า',
});

/**
 * เงินเข้า/คืนในช่วง แตกลงชิ้นของใบ — แถวละหนึ่งชิ้นของหนึ่งงวด
 * [{ date, type, ref_id, invoice_id, customer, bu, kind, case_id, amount }]
 */
export async function cashRows(from, to) {
  const entries = await sql.all(
    `SELECT 'payment' AS type, p.payment_id AS ref_id, p.invoice_id, p.amount, LEFT(p.paid_at, 10) AS date
       FROM invoice_payments p JOIN invoices i ON i.invoice_id = p.invoice_id
      WHERE ${COUNTS_AS_REVENUE} AND LEFT(p.paid_at, 10) BETWEEN :from AND :to
     UNION ALL
     SELECT 'refund', r.refund_id, r.invoice_id, -r.amount, LEFT(r.refunded_at, 10)
       FROM invoice_refunds r JOIN invoices i ON i.invoice_id = r.invoice_id
      WHERE ${COUNTS_AS_REVENUE} AND r.status = 'active' AND LEFT(r.refunded_at, 10) BETWEEN :from AND :to
     ORDER BY 5, 1, 2`,
    { from, to },
  );
  const invoices = await loadInvoices([...new Set(entries.map((e) => e.invoice_id))]);
  const out = [];
  for (const e of entries) {
    const inv = invoices.get(e.invoice_id);
    const amounts = allocateLines(Number(e.amount), inv.slices.map((s) => s.weight));
    inv.slices.forEach((s, k) => {
      if (amounts[k] === 0) return;
      out.push({
        date: e.date, type: e.type, ref_id: e.ref_id, invoice_id: e.invoice_id, customer: customerOf(inv),
        bu: s.bu, kind: s.kind, case_id: s.case_id, invoice_case_id: inv.case_id ?? null, amount: amounts[k],
      });
    });
  }
  return out;
}

/** ข้อมูลเคสทุกใบที่รายงานต้องใช้ — แพ็ก · พนักงานหลัก · หน่วย · ราคา (ระบบมีเคสหลักร้อย–พัน อ่านทีเดียวคุ้มกว่า) */
export async function loadCases() {
  const rows = await sql.all(
    `SELECT c.case_id, c.service_kind, c.status, c.client_name, c.customer_id, c.assigned_to, ${PERSON('e')} AS staff_name,
            c.pkg_format_id, c.pkg_grade_id, c.pkg_staff_tier AS tier, c.physio_package_id, c.pkg_quantity,
            c.carried_used, c.carried_paid, c.joined_midway, c.round_no, c.renewed_from, c.addon_of,
            c.fee, c.service_customer_price_snapshot AS price_snap, c.service_list_price_snapshot AS list_snap,
            LEFT(c.created_at, 10) AS created_on, LEFT(c.closed_at, 10) AS closed_on,
            LEFT(c.cancelled_at, 10) AS cancelled_on, c.cancel_reason,
            f.name AS format_name, f.days AS format_days, g.name AS grade_name,
            r.code AS rate_code, r.customer_price AS rate_price,
            pp.name AS pp_name, pp.code AS pp_code, pp.sessions AS pp_sessions, pp.original_price AS pp_original,
            COALESCE((SELECT SUM(CASE WHEN a.kind = 'debit' THEN a.amount ELSE -a.amount END)
                        FROM invoice_adjustments a JOIN invoices ai ON ai.invoice_id = a.invoice_id
                       WHERE ai.case_id = c.case_id AND ai.status <> 'cancelled' AND a.status = 'issued'
                         AND ai.billing_kind IS DISTINCT FROM 'extra' AND a.reason_code <> 'bad_debt'), 0) AS adjustments,
            EXISTS (SELECT 1 FROM cases rn WHERE rn.renewed_from = c.case_id AND rn.status <> 'cancelled') AS renewed
       FROM cases c
       LEFT JOIN employees e ON e.employee_id = c.assigned_to
       LEFT JOIN pkg_service_formats f ON f.format_id = c.pkg_format_id
       LEFT JOIN pkg_grades g ON g.grade_id = c.pkg_grade_id
       LEFT JOIN pkg_rates r ON r.format_id = c.pkg_format_id AND r.grade_id IS NOT DISTINCT FROM c.pkg_grade_id
                            AND r.staff_tier = c.pkg_staff_tier
       LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id`,
  );
  return new Map(rows.map((c) => [c.case_id, describeCase(c)]));
}

/** แพ็ก · หน่วย · ราคาต่อหน่วยของเคส (ตัวเลขทั้งหมดของข้อ 3 มาจากที่นี่) */
export function describeCase(c) {
  const qty = Number(c.pkg_quantity) >= 1 ? Math.trunc(Number(c.pkg_quantity)) : 1;
  const bu = c.service_kind === 'physio' || c.physio_package_id != null ? 'physio' : 'homecare';
  let pkg;
  let units = null;
  let listUnit = null;
  if (c.physio_package_id != null) {
    pkg = { key: `pp:${c.physio_package_id}`, label: c.pp_name ?? 'แพ็กกายภาพ', code: c.pp_code ?? null };
    units = c.pp_sessions ? Number(c.pp_sessions) * qty : null;
    listUnit = c.pp_original;
  } else if (c.pkg_format_id != null) {
    pkg = {
      key: `hc:${c.pkg_format_id}:${c.pkg_grade_id ?? ''}:${c.tier ?? ''}`,
      label: [c.format_name, c.grade_name, c.tier].filter(Boolean).join(' · ') || 'แพ็ก Homecare',
      code: c.rate_code ?? null,
    };
    units = c.format_days ? Number(c.format_days) * qty : null;
    listUnit = c.rate_price;
  } else {
    pkg = { key: `none:${bu}`, label: `${BU_LABEL[bu]} (ไม่ระบุแพ็ก)`, code: null };
  }
  const contract = c.price_snap ?? c.fee;
  const list = c.list_snap ?? (listUnit != null ? Number(listUnit) * qty : null);
  const carriedUsed = Number(c.carried_used ?? 0);
  const carriedPaid = c.joined_midway ? Number(c.carried_paid ?? 0) : 0;
  const unitsIn = units != null ? units - carriedUsed : null;
  const valueIn = contract != null ? round2(Number(contract) - carriedPaid + Number(c.adjustments ?? 0)) : null;
  const metered = unitsIn != null && unitsIn > 0 && valueIn != null && valueIn > 0;
  return {
    case_id: c.case_id,
    bu,
    status: c.status,
    client_name: c.client_name,
    staff: c.assigned_to ? { key: c.assigned_to, label: c.staff_name ?? c.assigned_to } : null,
    pkg,
    qty,
    round_no: Number(c.round_no ?? 1),
    joined_midway: Boolean(c.joined_midway),
    addon_of: c.addon_of ?? null,
    renewed: Boolean(c.renewed),
    created_on: c.created_on,
    closed_on: c.status === 'closed' ? c.closed_on : null,
    cancelled_on: c.status === 'cancelled' ? (c.cancelled_on ?? c.closed_on) : null,
    cancel_reason: c.cancel_reason ?? null,
    contract: contract != null ? Number(contract) : null,
    list: list != null ? Number(list) : null,
    units,
    carried_used: carriedUsed,
    units_in: unitsIn,
    value_in: valueIn,
    // เคสแพ็กที่วัดหน่วยได้ = รับรู้ตามบริการที่ส่งมอบ · ไม่ใช่ = รับรู้วันที่ออกใบ
    metered,
    unit_price: metered ? valueIn / unitsIn : null,
  };
}

/**
 * หน่วยที่ส่งมอบแล้วถึงวันที่ to ของเคสแพ็ก — Map case_id → [{ date, units }] เรียงตามวัน ตัดส่วนที่เกินแพ็กแล้ว
 * Homecare: วันละหนึ่งหน่วย (หลายกะในวันเดียวนับหนึ่ง — เกณฑ์เดียวกับ physioQuota) · กายภาพ: ครั้งละหนึ่งหน่วย
 */
async function deliveredUnits(cases, to) {
  const rows = await sql.all(
    `SELECT v.case_id, v.visit_date AS date, COUNT(*)::int AS n
       FROM case_visits v
      WHERE v.check_in_at IS NOT NULL AND v.visit_date <= :to
      GROUP BY v.case_id, v.visit_date
      ORDER BY v.case_id, v.visit_date`,
    { to },
  );
  const out = new Map();
  for (const r of rows) {
    const c = cases.get(r.case_id);
    if (!c?.metered) continue;
    const list = out.get(r.case_id) ?? [];
    const used = list.reduce((s, x) => s + x.units, 0);
    const want = c.bu === 'physio' ? Number(r.n) : 1;
    const units = Math.min(want, Math.max(0, c.units_in - used));
    if (units > 0) list.push({ date: r.date, units });
    out.set(r.case_id, list);
  }
  return out;
}

/** มิติของข้อเท็จจริงหนึ่งแถว (ชิ้นเงิน / ต้นทุน / รายได้รับรู้) — BU · แพ็กเกจ · พนักงานหลัก */
const KIND_PACKAGE = {
  procedure: { key: 'k:procedure', label: 'หัตถการ' },
  rent: { key: 'k:rent', label: 'อุปกรณ์ (เช่า)' },
  sale: { key: 'k:sale', label: 'อุปกรณ์ (ขาย)' },
};
const NO_STAFF = { key: 'none', label: 'ไม่มีพนักงานหลัก' };
function dimsOf(fact, cases) {
  const own = fact.case_id ? cases.get(fact.case_id) : null;
  const staffCase = own ?? (fact.invoice_case_id ? cases.get(fact.invoice_case_id) : null);
  let pkg;
  if (KIND_PACKAGE[fact.kind]) pkg = KIND_PACKAGE[fact.kind];
  else if (own) pkg = own.pkg;
  else pkg = fact.bu === 'other' ? { key: 'k:other', label: 'ไม่ระบุบริการ' } : { key: `none:${fact.bu}`, label: `${BU_LABEL[fact.bu]} (ไม่ระบุแพ็ก)` };
  return {
    bu: { key: fact.bu, label: BU_LABEL[fact.bu] },
    package: { ...pkg, bu: fact.bu },
    staff: staffCase?.staff ?? NO_STAFF,
  };
}

/* ============================== รับรู้รายได้ ============================== */

/**
 * รายได้ที่รับรู้ในช่วง — [{ date, bu, kind, case_id, invoice_case_id, amount, source: 'delivery'|'invoice', units }]
 * delivered = ผลของ deliveredUnits() ที่โหลดถึงวันสิ้นช่วงแล้ว
 */
async function recognizedRows(from, to, cases, delivered) {
  const out = [];
  for (const [caseId, list] of delivered) {
    const c = cases.get(caseId);
    for (const d of list) {
      if (d.date < from || d.date > to) continue;
      out.push({ date: d.date, bu: c.bu, kind: 'service', case_id: caseId, invoice_case_id: caseId, amount: d.units * c.unit_price, units: d.units, source: 'delivery' });
    }
  }
  // ส่วนที่รับรู้วันที่ออกใบ — ใบที่ออกจริงแล้ว (ไม่นับร่าง/ยกเลิก)
  const invIds = (await sql.all(
    `SELECT i.invoice_id FROM invoices i WHERE i.status IN ('issued', 'paid') AND i.issue_date BETWEEN :from AND :to`,
    { from, to },
  )).map((r) => r.invoice_id);
  const invoices = await loadInvoices(invIds);
  for (const inv of invoices.values()) {
    for (const s of inv.slices) {
      const metered = (s.kind === 'service' || s.kind === 'bundle') && s.case_id && cases.get(s.case_id)?.metered;
      if (metered || s.weight <= 0) continue;
      out.push({ date: inv.issue_date, bu: s.bu, kind: s.kind, case_id: s.case_id, invoice_case_id: inv.case_id ?? null, amount: s.weight, units: 0, source: 'invoice' });
    }
  }
  return out;
}

/* ============================== ข้อ 2 · ภาพรวม + เป้า + ปีก่อน ============================== */

async function targetsFor(months) {
  if (months.length === 0) return [];
  return sql.all('SELECT month, bu, amount FROM revenue_targets WHERE month = ANY(:months::text[])', { months });
}

/** เป้าของช่วง — เป้ารายเดือนเฉลี่ยตามจำนวนวันที่ช่วงครอบในเดือนนั้น · BU ที่ไม่ได้ตั้งเลยสักเดือน = null */
export function proratedTargets(rows, from, to) {
  const out = Object.fromEntries(TARGET_BUS.map((k) => [k, null]));
  for (const r of rows) {
    const days = overlapDays(r.month, from, to);
    if (!days) continue;
    out[r.bu] = round2((out[r.bu] ?? 0) + (Number(r.amount) * days) / daysInMonth(r.month));
  }
  return out;
}

const sumBy = (rows, pick = (r) => r.bu) => {
  const out = zero();
  for (const r of rows) add(out, pick(r), r.amount);
  return out;
};
const inRange = (rows, from, to) => rows.filter((r) => r.date >= from && r.date <= to);

export async function overview({ from, to }) {
  checkRange(from, to);
  await ensureReportTables();
  const prev = previousRange(from, to);
  const ly = lastYearRange(from, to);
  // แนวโน้ม 12 เดือนที่จบเดือนของวันสิ้นช่วง + เดือนเดียวกันของปีก่อน
  const trendMonths = monthsIn(addMonths(`${to.slice(0, 7)}-01`, -11), to);
  const trendFrom = `${trendMonths[0]}-01`;
  const lyTrendFrom = lastYear(trendFrom);
  const loadFrom = [from, prev.from, ly.from, lyTrendFrom].sort()[0];
  const [rows, targets] = await Promise.all([
    cashRows(loadFrom, to),
    targetsFor([...new Set([...monthsIn(from, to), ...trendMonths])]),
  ]);

  const cur = inRange(rows, from, to);
  const payers = new Set(cur.filter((r) => r.type === 'payment').map((r) => r.customer.key));
  const trend = trendMonths.map((m) => {
    const lyM = lastYear(`${m}-01`).slice(0, 7);
    const mRows = rows.filter((r) => r.date.startsWith(m) && r.date <= to);
    const mTargets = targets.filter((t) => t.month === m);
    return {
      month: m,
      values: sumBy(mRows),
      total: round2(mRows.reduce((s, r) => s + r.amount, 0)),
      last_year_total: round2(rows.filter((r) => r.date.startsWith(lyM)).reduce((s, r) => s + r.amount, 0)),
      target_total: mTargets.length ? round2(mTargets.reduce((s, t) => s + Number(t.amount), 0)) : null,
      partial: m === to.slice(0, 7) && to < monthEnd(`${m}-01`),
    };
  });
  return {
    from, to, today: todayTh(), previous: prev, last_year: ly, bus: BUS,
    current: sumBy(cur),
    previous_totals: sumBy(inRange(rows, prev.from, prev.to)),
    last_year_totals: sumBy(inRange(rows, ly.from, ly.to)),
    targets: proratedTargets(targets.filter((t) => monthsIn(from, to).includes(t.month)), from, to),
    payments: new Set(cur.filter((r) => r.type === 'payment').map((r) => r.ref_id)).size,
    payers: payers.size,
    trend,
  };
}

/* ============================== ข้อ 1 · กำไรขั้นต้น ============================== */

async function payoutRows(from, to) {
  const rows = await sql.all(
    `SELECT p.case_id, p.amount, LEFT(p.released_at, 10) AS date
       FROM case_payouts p WHERE LEFT(p.released_at, 10) BETWEEN :from AND :to`,
    { from, to },
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function margin({ from, to }) {
  checkRange(from, to);
  await ensureReportTables();
  const cases = await loadCases();
  /* ต้นทุน = ค่าจ้างที่ปล่อยจ่าย + ค่าพาร์ทเนอร์ (กะที่ไปจริง × เรท ณ ตอนส่ง · นับตามวันกะ — partners/repo.js costRows) */
  const [cash, delivered, payouts, partnerCost] = await Promise.all([
    cashRows(from, to), deliveredUnits(cases, to), payoutRows(from, to), partnerCostRows(from, to),
  ]);
  const recognized = await recognizedRows(from, to, cases, delivered);

  const dims = { bu: new Map(), package: new Map(), staff: new Map() };
  const touch = (dim, d) => {
    const m = dims[dim];
    if (!m.has(d.key)) m.set(d.key, { key: d.key, label: d.label, code: d.code ?? null, bu: d.bu ?? null, cash: 0, recognized: 0, cost: 0, cases: new Set() });
    return m.get(d.key);
  };
  const feed = (fact, field, caseId) => {
    const d = dimsOf(fact, cases);
    for (const dim of Object.keys(dims)) {
      const row = touch(dim, d[dim]);
      row[field] = round2(row[field] + fact.amount);
      if (caseId) row.cases.add(caseId);
    }
  };
  for (const r of cash) feed(r, 'cash', r.case_id);
  for (const r of recognized) feed(r, 'recognized', r.case_id);
  for (const p of [...payouts, ...partnerCost]) {
    const c = cases.get(p.case_id);
    if (!c) continue;
    feed({ bu: c.bu, kind: 'service', case_id: p.case_id, amount: p.amount }, 'cost', p.case_id);
  }
  const done = (m) => [...m.values()]
    .map(({ cases: set, ...row }) => ({ ...row, recognized: round2(row.recognized), case_count: set.size }))
    .sort((a, b) => b.recognized - a.recognized || b.cash - a.cash || b.cost - a.cost);
  const total = (field, list) => round2(list.reduce((s, r) => s + r[field], 0));
  const byBu = done(dims.bu);
  return {
    from, to, bus: BUS,
    bu: byBu,
    package: done(dims.package),
    staff: done(dims.staff),
    totals: { cash: total('cash', byBu), recognized: total('recognized', byBu), cost: total('cost', byBu) },
  };
}

/* ============================== ข้อ 3 · รับรู้รายได้ ============================== */

export async function recognition({ from, to }) {
  checkRange(from, to);
  await ensureReportTables();
  const cases = await loadCases();
  const [cashAll, delivered] = await Promise.all([cashRows('0000-01-01', to), deliveredUnits(cases, to)]);
  const recognized = await recognizedRows(from, to, cases, delivered);
  const cash = inRange(cashAll, from, to);

  const byBu = Object.fromEntries(BU_KEYS.map((k) => [k, {
    bu: k, cash: 0, recognized: 0, from_delivery: 0, from_invoice: 0,
    deferred: 0, deferred_cases: 0, unpaid: 0, unpaid_cases: 0,
  }]));
  for (const r of cash) add(byBu[r.bu], 'cash', r.amount);
  for (const r of recognized) {
    add(byBu[r.bu], 'recognized', r.amount);
    add(byBu[r.bu], r.source === 'delivery' ? 'from_delivery' : 'from_invoice', r.amount);
  }

  // ยอดสะสมของเคสแพ็ก ณ วันสิ้นช่วง: เงินที่รับ (ค่าบริการ/แพ็กรวมใบ) เทียบกับมูลค่าบริการที่ส่งมอบแล้ว
  const paidTo = new Map();
  for (const r of cashAll) {
    if ((r.kind === 'service' || r.kind === 'bundle') && r.case_id && cases.get(r.case_id)?.metered) {
      paidTo.set(r.case_id, round2((paidTo.get(r.case_id) ?? 0) + r.amount));
    }
  }
  const caseIds = new Set([...paidTo.keys(), ...delivered.keys()]);
  const list = [];
  for (const id of caseIds) {
    const c = cases.get(id);
    const units = delivered.get(id) ?? [];
    const unitsTo = units.reduce((s, x) => s + x.units, 0);
    const unitsIn = units.filter((x) => x.date >= from).reduce((s, x) => s + x.units, 0);
    const recTo = round2(unitsTo * c.unit_price);
    const paid = paidTo.get(id) ?? 0;
    const balance = round2(paid - recTo);
    if (balance > 0.005) { add(byBu[c.bu], 'deferred', balance); byBu[c.bu].deferred_cases += 1; }
    if (balance < -0.005) { add(byBu[c.bu], 'unpaid', -balance); byBu[c.bu].unpaid_cases += 1; }
    // เคสที่ไม่มีอะไรค้างและไม่มีความเคลื่อนไหวในช่วง ไม่ต้องขึ้นตาราง
    if (Math.abs(balance) < 0.005 && unitsIn === 0) continue;
    list.push({
      case_id: id, client_name: c.client_name, bu: c.bu, status: c.status, package: c.pkg.label, package_code: c.pkg.code,
      staff: c.staff?.label ?? null, units: c.units, carried_used: c.carried_used, units_done: unitsTo + c.carried_used,
      units_in_period: unitsIn, unit_price: round2(c.unit_price), value_in: c.value_in,
      paid_to_date: paid, recognized_to_date: recTo, recognized_in_period: round2(unitsIn * c.unit_price), balance,
    });
  }
  list.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  const series = monthsIn(from, to).map((m) => ({
    month: m,
    cash: round2(cash.filter((r) => r.date.startsWith(m)).reduce((s, r) => s + r.amount, 0)),
    recognized: round2(recognized.filter((r) => r.date.startsWith(m)).reduce((s, r) => s + r.amount, 0)),
  }));
  return { from, to, bus: BUS, by_bu: BU_KEYS.map((k) => byBu[k]), series, cases: list };
}

/* ============================== ข้อ 5 · ลูกหนี้แยกอายุ ============================== */

export const AGING = [
  { key: 'current', label: 'ยังไม่ถึงกำหนด' },
  { key: 'd1_30', label: '1–30 วัน' },
  { key: 'd31_60', label: '31–60 วัน' },
  { key: 'd61_90', label: '61–90 วัน' },
  { key: 'd90', label: 'เกิน 90 วัน' },
];
export const agingBucket = (days) => (days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90');

/** ณ วันนี้ — ใบที่ออกแล้วยังรอชำระ (นิยามเดียวกับ "ค้างชำระ" ของบันทึกการเงิน) · ไม่มีวันครบกำหนด = ครบกำหนดวันออกใบ */
export async function receivables() {
  await ensureReportTables();
  const today = todayTh();
  const rows = await sql.all(
    `SELECT i.invoice_id, i.bill_to_name, i.customer_id, i.case_id, i.addons, i.issue_date, i.due_date,
            ${netTotalSql('i')} AS net_total, ${netPaidSql('i')} AS net_paid, c.service_kind, c.client_name, cu.name AS customer_name
       FROM invoices i
       LEFT JOIN cases c ON c.case_id = i.case_id
       LEFT JOIN customers cu ON cu.customer_id = i.customer_id
      WHERE i.status = 'issued' AND ${netTotalSql('i')} - ${netPaidSql('i')} > 0.005`,
  );
  const byBu = Object.fromEntries(BU_KEYS.map((k) => [k, { bu: k, total: 0, ...Object.fromEntries(AGING.map((a) => [a.key, 0])) }]));
  const invoices = rows.map((inv) => {
    const balance = round2(Number(inv.net_total) - Number(inv.net_paid));
    const due = inv.due_date ?? inv.issue_date;
    const days = daysBetween(due, today);
    const bucket = agingBucket(days);
    const slices = invoiceSlices({ ...inv, net_total: Number(inv.net_total) });
    const amounts = allocateLines(balance, slices.map((s) => s.weight));
    const parts = {};
    slices.forEach((s, k) => {
      if (!amounts[k]) return;
      add(parts, s.bu, amounts[k]);
      add(byBu[s.bu], bucket, amounts[k]);
      add(byBu[s.bu], 'total', amounts[k]);
    });
    return {
      invoice_id: inv.invoice_id, customer: customerOf(inv).label, client_name: inv.client_name ?? null, case_id: inv.case_id ?? null,
      issue_date: inv.issue_date, due_date: inv.due_date ?? null, days_overdue: Math.max(0, days), bucket, balance, parts,
    };
  }).sort((a, b) => b.days_overdue - a.days_overdue || b.balance - a.balance);
  return { today, bus: BUS, aging: AGING, by_bu: BU_KEYS.map((k) => byBu[k]), invoices };
}

/* ============================== ข้อ 4 · ลูกค้า ============================== */

export async function customers({ from, to }) {
  checkRange(from, to);
  await ensureReportTables();
  const [cases, cash] = await Promise.all([loadCases(), cashRows(from, to)]);
  const all = [...cases.values()];
  const within = (d) => d && d >= from && d <= to;
  const SERVICE_BUS = ['homecare', 'physio'];

  // ต่อเคส: เคสที่ปิดจบในช่วง มีรอบถัดไปที่ไม่ได้ยกเลิกแล้วหรือยัง · ยกเลิก: เทียบกับเคสที่จบในช่วงทั้งหมด (ปิด + ยกเลิก)
  const lifecycle = SERVICE_BUS.map((bu) => {
    const closed = all.filter((c) => c.bu === bu && within(c.closed_on));
    const cancelled = all.filter((c) => c.bu === bu && within(c.cancelled_on));
    const started = all.filter((c) => c.bu === bu && within(c.created_on));
    return {
      bu,
      closed: closed.length,
      renewed: closed.filter((c) => c.renewed).length,
      cancelled: cancelled.length,
      started: started.length,
      started_new: started.filter((c) => !c.addon_of && !c.joined_midway && c.round_no <= 1).length,
      started_renew: started.filter((c) => !c.addon_of && c.round_no > 1).length,
      started_midway: started.filter((c) => !c.addon_of && c.joined_midway && c.round_no <= 1).length,
      started_addon: started.filter((c) => c.addon_of).length,
    };
  });
  const reasons = new Map();
  for (const c of all) {
    if (!within(c.cancelled_on)) continue;
    const label = (c.cancel_reason ?? '').trim() || 'ไม่ระบุเหตุผล';
    const r = reasons.get(label) ?? { reason: label, count: 0, homecare: 0, physio: 0 };
    r.count += 1;
    r[c.bu] += 1;
    reasons.set(label, r);
  }

  // การกระจุกตัว: ยอดเงินเข้าสุทธิต่อผู้ชำระ
  const payers = new Map();
  for (const r of cash) {
    const p = payers.get(r.customer.key) ?? { key: r.customer.key, label: r.customer.label, amount: 0, by_bu: {} };
    p.amount = round2(p.amount + r.amount);
    add(p.by_bu, r.bu, r.amount);
    payers.set(r.customer.key, p);
  }
  const ranked = [...payers.values()].filter((p) => p.amount > 0.005).sort((a, b) => b.amount - a.amount);
  const total = round2(ranked.reduce((s, p) => s + p.amount, 0));
  const share = (n) => (total > 0 ? round2(ranked.slice(0, n).reduce((s, p) => s + p.amount, 0)) : 0);
  return {
    from, to, bus: BUS,
    lifecycle,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    concentration: { total, payers: ranked.length, top1: share(1), top5: share(5), top10: share(10) },
    top: ranked.slice(0, 10),
  };
}

/* ============================== เสริม · ส่วนลด เงินคืน ราคาจริง ============================== */

export async function pricing({ from, to }) {
  checkRange(from, to);
  await ensureReportTables();
  const [cases, cash, issued, credits] = await Promise.all([
    loadCases(),
    cashRows(from, to),
    sql.all(`SELECT i.invoice_id FROM invoices i WHERE i.status IN ('issued', 'paid') AND i.issue_date BETWEEN :from AND :to`, { from, to }),
    sql.all(
      `SELECT a.invoice_id, a.amount FROM invoice_adjustments a
        WHERE a.status = 'issued' AND a.kind = 'credit' AND a.reason_code = 'discount' AND a.issue_date BETWEEN :from AND :to`,
      { from, to },
    ),
  ]);
  const invoices = await loadInvoices([...new Set([...issued.map((r) => r.invoice_id), ...credits.map((r) => r.invoice_id)])]);
  const issuedIds = new Set(issued.map((r) => r.invoice_id));
  const byBu = Object.fromEntries(BU_KEYS.map((k) => [k, { bu: k, billed: 0, discount: 0, credit_discount: 0, received: 0, refunds: 0 }]));
  const serviceSlice = (inv) => inv.slices[inv.slices.length - 1];
  for (const inv of invoices.values()) {
    if (!issuedIds.has(inv.invoice_id)) continue;
    for (const s of inv.slices) if (s.weight > 0 && !(s.weight === 1 && inv.net_total === 0)) add(byBu[s.bu], 'billed', s.weight);
    // ส่วนลดหน้าใบเป็นของค่าบริการเสมอ (อุปกรณ์/หัตถการคิดเต็มราคา)
    if (Number(inv.discount) > 0) add(byBu[serviceSlice(inv).bu], 'discount', Number(inv.discount));
  }
  for (const a of credits) {
    const inv = invoices.get(a.invoice_id);
    if (inv) add(byBu[serviceSlice(inv).bu], 'credit_discount', Number(a.amount));
  }
  for (const r of cash) add(byBu[r.bu], r.type === 'refund' ? 'refunds' : 'received', Math.abs(r.amount));

  // ราคาขายจริงเทียบราคาตั้ง: เคสที่เปิดในช่วง (ไม่นับยกเลิก) ต่อแพ็กเกจ
  const pkgs = new Map();
  for (const c of cases.values()) {
    if (c.created_on < from || c.created_on > to || c.status === 'cancelled' || c.pkg.key.startsWith('none:')) continue;
    const p = pkgs.get(c.pkg.key) ?? { key: c.pkg.key, label: c.pkg.label, code: c.pkg.code, bu: c.bu, cases: 0, priced: 0, list_total: 0, actual_total: 0, packs: 0 };
    p.cases += 1;
    p.packs += c.qty;
    if (c.list != null && c.list > 0 && c.contract != null) {
      p.priced += 1;
      p.list_total = round2(p.list_total + c.list);
      p.actual_total = round2(p.actual_total + c.contract);
    }
    pkgs.set(c.pkg.key, p);
  }
  return {
    from, to, bus: BUS,
    by_bu: BU_KEYS.map((k) => byBu[k]),
    packages: [...pkgs.values()].sort((a, b) => b.actual_total - a.actual_total || b.cases - a.cases),
  };
}

/* ============================== เป้ารายได้ ============================== */

export async function listTargets(year) {
  await ensureReportTables();
  const rows = await sql.all(
    `SELECT month, bu, amount, updated_by_name, updated_at FROM revenue_targets WHERE month LIKE :y ORDER BY month, bu`,
    { y: `${year}-%` },
  );
  return { year, bus: BUS.filter((b) => TARGET_BUS.includes(b.key)), rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
}

/** บันทึกเป้าทั้งปีในคราวเดียว — ช่องว่าง/ศูนย์ = ลบเป้าของเดือนนั้น */
export async function saveTargets(year, rows, actor) {
  await ensureReportTables();
  const name = actor?.name || [actor?.first_name, actor?.last_name].filter(Boolean).join(' ') || null;
  await transaction(async (tx) => {
    for (const r of rows) {
      if (!r.month.startsWith(`${year}-`)) throw new ApiError(400, `เดือน ${r.month} ไม่อยู่ในปี ${year}`);
      if (r.amount == null || Number(r.amount) <= 0) {
        await tx.run('DELETE FROM revenue_targets WHERE month = :month AND bu = :bu', { month: r.month, bu: r.bu });
      } else {
        await tx.run(
          `INSERT INTO revenue_targets (month, bu, amount, updated_by, updated_by_name)
           VALUES (:month, :bu, :amount, :by, :name)
           ON CONFLICT (month, bu) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by,
             updated_by_name = EXCLUDED.updated_by_name,
             updated_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
           WHERE revenue_targets.amount IS DISTINCT FROM EXCLUDED.amount`,
          { month: r.month, bu: r.bu, amount: round2(r.amount), by: actor?.employee_id ?? null, name },
        );
      }
    }
  });
  return listTargets(year);
}
