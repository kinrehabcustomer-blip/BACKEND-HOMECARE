import { sql } from '../db/index.js';
import { todayTh } from '../lib/dates.js';
import { addonAmount, addonLabel, isPhysioBundle, isProcedure, normalizeAddons } from '../lib/addons.js';
import { exportRows } from './repo.js';
import { addDays, allocateLines, ensureReportTables, loadCases, round2 } from './buReport.js';

/**
 * CSV ใบแจ้งหนี้แบบรายบรรทัด + เฉลี่ยตามช่วงบริการ (ผู้ใช้ขอ 24 พ.ย. 2569 — หัวคอลัมน์ตามไฟล์ตัวอย่าง)
 *
 * ผู้ใช้เลือก (24 พ.ย. 2569):
 *   - ใบไหนเข้าไฟล์ = บรรทัดที่ "ช่วงบริการ" คาบเกี่ยวช่วงที่เลือก (ไม่ใช่วันที่ออกใบ) · ยอด "ในช่วงที่เลือก"
 *     เฉลี่ยตามจำนวนวัน: ยอดบรรทัด × (วันที่อยู่ในช่วง ÷ วันทั้งหมดของช่วงบริการ)
 *   - VAT: ธุรกิจไม่ได้จด VAT (ดู schema.sql ตาราง invoices) → ทุกบรรทัด "ไม่มี VAT" · ช่องมี VAT/VAT 7% = 0
 *   - สาขา = ประเภทบริการของเคส (Homecare / กายภาพบำบัด) · สัญญา = เว้นว่าง
 *
 * บรรทัดของใบ = กติกาเดียวกับรายงานรายได้ตาม BU (invoiceSlices ใน buReport.js) แต่เก็บชื่อ/จำนวนไว้ด้วย
 *   อุปกรณ์/หัตถการ/แพ็กกายภาพรวมใบ = เต็มราคา · ค่าบริการ = ยอดสุทธิของใบ (หลังส่วนลด ลด/เพิ่มหนี้) − บรรทัดอื่น
 *   ผลรวมทุกบรรทัดของใบ = ยอดสุทธิของใบ · เงินที่รับแล้วแบ่งลงบรรทัดตามสัดส่วน (ปัดสตางค์ให้ผลรวมตรง)
 *
 * ช่วงบริการของแต่ละบรรทัด
 *   ค่าบริการ / อุปกรณ์เช่า = ช่วงสัญญาของเคส (start_date–end_date) · ไม่มีวันสิ้นสุด = นับจากจำนวนวันของแพ็ก
 *   แพ็กกายภาพรวมใบ = ช่วงของเคสกายภาพที่อ้าง · หัตถการ / อุปกรณ์ขาย = วันที่ออกใบ (เกิดครั้งเดียว)
 *   ไม่มีข้อมูลวันเลย = วันที่ออกใบ (ใบร่างที่ยังไม่ออก = วันที่สร้าง)
 */

const KIND_CATEGORY = {
  homecare: 'ค่าบริการดูแล (Homecare)',
  physio: 'ค่ากายภาพบำบัด',
  bundle: 'ค่ากายภาพบำบัด',
  procedure: 'ค่าหัตถการ',
  rent: 'ค่าเช่าอุปกรณ์',
  sale: 'ค่าอุปกรณ์ (ขาย)',
};
const BRANCH = { homecare: 'Homecare', physio: 'กายภาพบำบัด' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayCount = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;

/** ช่วงวันที่ของเคส { start, end } หรือ null — end ว่าง = นับจากหน่วยของแพ็ก (วัน) · ยังไม่รู้ = วันเดียว */
function casePeriod(c, info) {
  if (!c || !DATE.test(c.start_date ?? '')) return null;
  const start = c.start_date;
  let end = DATE.test(c.end_date ?? '') ? c.end_date : null;
  if (!end && info?.bu === 'homecare' && info.units) end = addDays(start, info.units - 1);
  if (!end || end < start) end = start;
  return { start, end };
}

/** วันที่อยู่ทั้งในช่วงบริการและช่วงที่เลือก */
function overlap(p, from, to) {
  const s = p.start > from ? p.start : from;
  const e = p.end < to ? p.end : to;
  return s > e ? 0 : dayCount(s, e);
}

export async function exportLines(filters, from, to) {
  // ทุกใบตามตัวกรองบนหน้า (ไม่จำกัดวันที่ออก) — ใบที่ออกก่อน/หลังช่วงยังมีบริการคาบเกี่ยวได้
  const { issued_from: _f, issued_to: _t, ...rest } = filters;
  await ensureReportTables(); // loadCases อ่านคอลัมน์ที่ตารางรายงานสร้าง (จำนวนวันของรูปแบบ · ราคา snapshot · ลด/เพิ่มหนี้)
  const { data: invoices, truncated } = await exportRows(rest);
  if (invoices.length === 0) return { data: [], truncated };

  const ids = invoices.map((v) => v.invoice_id);
  const caseIds = [...new Set(invoices.map((v) => v.case_id).filter(Boolean))];
  const [cases, caseDates, pays, itemQty] = await Promise.all([
    loadCases(),
    sql.all(`SELECT case_id, start_date, end_date FROM cases WHERE case_id = ANY(:ids::text[])
             OR case_id IN (SELECT DISTINCT a->>'ref' FROM invoices i, jsonb_array_elements(COALESCE(i.addons, '[]'::jsonb)) a
                             WHERE i.invoice_id = ANY(:inv::text[]) AND a->>'kind' = 'physio')`,
      { ids: caseIds, inv: ids }),
    sql.all(`SELECT invoice_id, MAX(LEFT(paid_at, 10)) AS last_paid,
                    string_agg(DISTINCT NULLIF(btrim(method), ''), ', ') AS methods
               FROM invoice_payments WHERE invoice_id = ANY(:ids::text[]) GROUP BY invoice_id`, { ids }),
    sql.all(`SELECT invoice_id, SUM(quantity) AS qty FROM invoice_items WHERE invoice_id = ANY(:ids::text[]) GROUP BY invoice_id`, { ids }),
  ]);
  const dates = new Map(caseDates.map((c) => [c.case_id, c]));
  const payOf = new Map(pays.map((p) => [p.invoice_id, p]));
  const itemsOf = new Map(itemQty.map((r) => [r.invoice_id, Number(r.qty)]));
  const today = todayTh();

  const out = [];
  for (const inv of invoices) {
    const info = inv.case_id ? cases.get(inv.case_id) : null;
    const issued = DATE.test(inv.issue_date ?? '') ? inv.issue_date : String(inv.created_at ?? '').slice(0, 10);
    const oneDay = DATE.test(issued) ? { start: issued, end: issued } : null;
    const casePer = casePeriod(dates.get(inv.case_id), info) ?? oneDay;
    const net = round2(Number(inv.net_total ?? inv.total ?? 0));

    // บรรทัดของใบ
    const lines = [];
    let extras = 0;
    for (const a of normalizeAddons(inv.addons)) {
      const amt = addonAmount(a);
      extras += amt;
      if (isPhysioBundle(a)) {
        const ref = a.ref ? cases.get(a.ref) : null;
        lines.push({ kind: 'bundle', code: ref?.pkg?.code ?? '', label: addonLabel(a), qty: a.quantity, amount: amt,
          period: casePeriod(dates.get(a.ref), ref) ?? casePer });
      } else if (isProcedure(a)) {
        lines.push({ kind: 'procedure', code: '', label: addonLabel(a), qty: a.quantity, amount: amt, period: oneDay ?? casePer });
      } else {
        const sale = a.kind === 'sale';
        lines.push({ kind: sale ? 'sale' : 'rent', code: '', label: addonLabel(a), qty: a.quantity, amount: amt,
          period: sale ? (oneDay ?? casePer) : casePer });
      }
    }
    const serviceKind = info?.bu ?? (inv.service_kind === 'physio' ? 'physio' : 'homecare');
    const service = round2(Math.max(0, net - extras));
    if (service > 0 || lines.length === 0) {
      lines.unshift({
        kind: serviceKind,
        code: info?.pkg?.code ?? '',
        label: inv.service_description || inv.case_title || 'ค่าบริการ',
        qty: itemsOf.get(inv.invoice_id) ?? info?.qty ?? 1,
        amount: service,
        period: casePer,
      });
    }
    // ใบที่ลดหนี้จนต่ำกว่าบรรทัดอุปกรณ์/หัตถการ — ยอดรวมบรรทัดต้องเท่ายอดสุทธิเสมอ: แบ่งยอดสุทธิตามสัดส่วนบรรทัด
    const lineSum = round2(lines.reduce((s, l) => s + l.amount, 0));
    const amounts = Math.abs(lineSum - net) < 0.005 ? lines.map((l) => l.amount) : allocateLines(net, lines.map((l) => l.amount));

    const cancelled = inv.status === 'cancelled';
    const paidShare = allocateLines(cancelled ? 0 : Number(inv.paid_amount ?? 0), amounts);
    const pay = payOf.get(inv.invoice_id);
    const overdueDays = !cancelled && inv.status !== 'draft' && Number(inv.balance ?? 0) > 0.005
      && DATE.test(inv.due_date ?? '') && inv.due_date < today ? dayCount(inv.due_date, today) - 1 : 0;

    lines.forEach((l, k) => {
      const p = l.period;
      if (!p) return;
      const inRange = overlap(p, from, to);
      if (inRange === 0) return; // ช่วงบริการไม่คาบเกี่ยวช่วงที่เลือก — ไม่อยู่ในไฟล์
      const totalDays = dayCount(p.start, p.end);
      const amount = amounts[k];
      const portion = cancelled ? 0 : round2((amount * inRange) / totalDays);
      out.push({
        issue_date: inv.issue_date ?? '',
        invoice_id: inv.invoice_id,
        patient_id: inv.patient_id ?? '',
        patient_name: inv.patient_name ?? '',
        branch: inv.case_id ? BRANCH[serviceKind] : '',
        billing_kind: inv.billing_kind ?? null,
        has_items: Boolean(inv.has_items),
        code: l.code,
        description: l.label,
        category: KIND_CATEGORY[l.kind] ?? '',
        quantity: l.qty,
        amount,
        service_start: p.start,
        service_end: p.end,
        total_days: totalDays,
        days_in_range: inRange,
        vat_base: 0,
        vat: 0,
        non_vat: portion,
        in_range_total: portion,
        paid: cancelled ? 0 : paidShare[k],
        outstanding: cancelled ? 0 : round2(amount - paidShare[k]),
        // ใช้ทำป้ายสถานะฝั่งหน้าเว็บ (invoiceStatusLabel) — ไม่ได้เป็นคอลัมน์ตรงๆ
        status: inv.status,
        is_overdue: Boolean(inv.is_overdue),
        bad_debt_amount: inv.bad_debt_amount ?? 0,
        paid_on: inv.status === 'paid' && inv.paid_at ? String(inv.paid_at).slice(0, 10) : (pay?.last_paid ?? ''),
        payment_methods: pay?.methods ?? inv.payment_method ?? '',
        overdue_days: overdueDays,
      });
    });
  }
  return { data: out, truncated };
}
