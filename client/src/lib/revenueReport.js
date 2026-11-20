/**
 * ตัวช่วยล้วนของหน้ารายได้ตาม BU (RevenueBuPage · server: invoices/buReport.js · 20 พ.ย. 2569)
 * ช่วงเวลา · ตัวเลข · ตาราง CSV ของแต่ละแท็บ — ไม่แตะ DOM เทสได้ใน client/test/logic.test.js
 */

export const BU_ORDER = ['homecare', 'physio', 'procedure', 'rent', 'sale', 'other'];
export const BU_LABELS = {
  homecare: 'Homecare',
  physio: 'กายภาพบำบัด',
  procedure: 'หัตถการ',
  rent: 'อุปกรณ์ (เช่า)',
  sale: 'อุปกรณ์ (ขาย)',
  other: 'ไม่ระบุบริการ',
};
/** BU ที่ตั้งเป้าได้ (ตรงกับ TARGET_BUS ฝั่ง server) */
export const TARGET_BUS = BU_ORDER.filter((k) => k !== 'other');

/* ============================== ช่วงเวลา ============================== */

const pad = (n) => String(n).padStart(2, '0');
export const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
export const monthEnd = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};
export const addMonths = (iso, n) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysIn = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
const monthsIn = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

/** ตัวเลือกช่วงด่วน */
export const PRESETS = [
  { key: 'this_month', label: 'เดือนนี้', range: (t) => [monthStart(t), t] },
  { key: 'last_month', label: 'เดือนก่อน', range: (t) => { const s = addMonths(t, -1); return [s, monthEnd(s)]; } },
  {
    key: 'quarter', label: 'ไตรมาสนี้',
    range: (t) => { const m = Number(t.slice(5, 7)); const q = Math.floor((m - 1) / 3) * 3 + 1; return [`${t.slice(0, 4)}-${pad(q)}-01`, t]; },
  },
  { key: 'year', label: 'ปีนี้', range: (t) => [`${t.slice(0, 4)}-01-01`, t] },
  { key: '12m', label: '12 เดือนล่าสุด', range: (t) => [addMonths(t, -11), t] },
];

/**
 * ลูกศร ‹ › — ช่วงเดือน (เริ่มวันที่ 1 จบสิ้นเดือนหรือวันนี้) เลื่อนทีละจำนวนเดือนเท่าเดิม · ช่วงอื่นเลื่อนทีละความยาวเท่าเดิม
 * ไปข้างหน้าไม่เกินวันนี้
 */
export function stepRange(from, to, dir, today) {
  if (from.endsWith('-01') && (to === monthEnd(to) || to === today)) {
    const n = monthsIn(from, to);
    const f = addMonths(from, dir * n);
    const t = monthEnd(addMonths(f, n - 1));
    return [f, t > today ? today : t];
  }
  const n = daysIn(from, to);
  const t = addDays(to, dir * n);
  return [addDays(from, dir * n), t > today ? today : t];
}

const MONTH_FMT = { month: 'long', year: 'numeric', timeZone: 'UTC' };
/** ชื่อช่วงที่คนอ่านเข้าใจ: ชื่อตัวเลือกด่วน → "พฤศจิกายน 2569" → "ปี 2569" → null */
export function rangeName(from, to, today) {
  const p = PRESETS.find((x) => { const [f, t] = x.range(today); return f === from && t === to; });
  if (p) return p.label;
  if (from.endsWith('-01') && to === monthEnd(from)) return new Date(`${from}T00:00:00Z`).toLocaleDateString('th-TH', MONTH_FMT);
  if (from.endsWith('-01-01') && to.endsWith('-12-31') && from.slice(0, 4) === to.slice(0, 4)) return `ปี ${Number(from.slice(0, 4)) + 543}`;
  return null;
}
/** วันที่ของช่วงแบบสั้น: 1–19 พ.ย. 2569 · 1 ต.ค. – 19 พ.ย. 2569 */
export function rangeDates(from, to) {
  const d = (iso, o) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('th-TH', { timeZone: 'UTC', ...o });
  const full = { day: 'numeric', month: 'short', year: 'numeric' };
  if (from === to) return d(from, full);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${d(to, full)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${d(from, { day: 'numeric', month: 'short' })} – ${d(to, full)}`;
  return `${d(from, full)} – ${d(to, full)}`;
}
export const monthLabel = (ym, long = false) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('th-TH', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit', timeZone: 'UTC' });

/* ============================== ตัวเลข ============================== */

export const r2 = (n) => Math.round(Number(n) * 100) / 100;
/** สัดส่วนเป็น % (ตัวหารเป็นศูนย์ = null — หน้าเว็บเขียน "—") */
export const pct = (part, whole) => (whole ? (Number(part) / Number(whole)) * 100 : null);
/** เปลี่ยนแปลงจากฐาน (%) — ฐานศูนย์ = null */
export const change = (now, before) => (before ? ((Number(now) - Number(before)) / Math.abs(Number(before))) * 100 : null);
export const pctText = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v.toLocaleString('th-TH', { maximumFractionDigits: digits })}%`);
const num = (v) => (v == null ? '' : r2(v));
const pctCsv = (v) => (v == null || !Number.isFinite(v) ? '' : r2(v));

/**
 * กำไรขั้นต้นของแถว — basis 'recognized' (รับรู้ตามบริการ) | 'cash' (เงินสด)
 * อุปกรณ์/หัตถการไม่มีต้นทุนในระบบ = กำไรเท่ารายได้ (หน้าเว็บบอกไว้ใต้ตาราง)
 */
export function marginOf(row, basis) {
  const revenue = Number(row[basis] ?? 0);
  const cost = Number(row.cost ?? 0);
  return { revenue, cost, profit: r2(revenue - cost), margin: pct(revenue - cost, revenue) };
}

/* ============================== CSV ของแต่ละแท็บ ============================== */

const buName = (k) => BU_LABELS[k] ?? k;
const busOf = (rows) => BU_ORDER.filter((k) => rows.some((r) => r.bu === k));

/** ภาพรวม — ต่อ BU: รายได้ · ก่อนหน้า · ปีก่อน · เป้า + แนวโน้ม 12 เดือน */
export function overviewCsv(d) {
  const bus = BU_ORDER.filter((k) => k !== 'other' || d.current.other || d.previous_totals.other || d.last_year_totals.other);
  const sum = (o) => r2(bus.reduce((s, k) => s + Number(o[k] ?? 0), 0));
  const tgt = (k) => d.targets[k] ?? null;
  const tgtSum = bus.some((k) => tgt(k) != null) ? r2(bus.reduce((s, k) => s + Number(tgt(k) ?? 0), 0)) : null;
  const row = (label, cur, prev, ly, target) => [
    label, num(cur), num(prev), pctCsv(change(cur, prev)), num(ly), pctCsv(change(cur, ly)), num(target), pctCsv(target ? pct(cur, target) : null),
  ];
  const lines = bus.map((k) => row(buName(k), d.current[k], d.previous_totals[k], d.last_year_totals[k], tgt(k)));
  lines.push(row('รวม', sum(d.current), sum(d.previous_totals), sum(d.last_year_totals), tgtSum));
  lines.push([]);
  lines.push([`ช่วง ${d.from} ถึง ${d.to} · ช่วงก่อนหน้า ${d.previous.from} ถึง ${d.previous.to} · ปีก่อน ${d.last_year.from} ถึง ${d.last_year.to}`]);
  lines.push(['เกณฑ์เงินสด: วันที่รับเงิน หักเงินคืน · เป้าเฉลี่ยตามจำนวนวันที่ช่วงครอบในแต่ละเดือน']);
  lines.push([]);
  lines.push(['เดือน', ...BU_ORDER.map(buName), 'รวม', 'ปีก่อน', 'เป้า']);
  for (const t of d.trend) lines.push([t.month, ...BU_ORDER.map((k) => num(t.values[k])), num(t.total), num(t.last_year_total), num(t.target_total)]);
  return {
    header: ['BU', 'รายได้ (บาท)', 'ช่วงก่อนหน้า (บาท)', 'เทียบช่วงก่อน (%)', 'ปีก่อน (บาท)', 'เทียบปีก่อน (%)', 'เป้า (บาท)', 'ทำได้ (%)'],
    lines,
  };
}

export const MARGIN_DIMS = [
  { key: 'bu', label: 'BU' },
  { key: 'package', label: 'แพ็กเกจ' },
  { key: 'staff', label: 'พนักงานหลัก' },
];

/** กำไร — ทั้งสามมิติต่อกันในไฟล์เดียว (มิติละหนึ่งตาราง) */
export function marginCsv(d, basis) {
  const lines = [];
  for (const dim of MARGIN_DIMS) {
    lines.push([`แยกตาม${dim.label}`]);
    for (const r of d[dim.key]) {
      const m = marginOf(r, basis);
      lines.push([dim.label, r.label, r.code ?? '', r.bu ? buName(r.bu) : '', num(r.cash), num(r.recognized), num(m.cost), num(m.profit), pctCsv(m.margin), r.case_count]);
    }
    lines.push([]);
  }
  lines.push([`ช่วง ${d.from} ถึง ${d.to} · กำไรคิดจาก${basis === 'cash' ? 'เงินสด' : 'รายได้ที่รับรู้ตามบริการ'} − ค่าจ้างที่ปล่อยจ่ายในช่วง · อุปกรณ์/หัตถการไม่มีต้นทุนในระบบ`]);
  return {
    header: ['มิติ', 'ชื่อ', 'รหัส', 'BU', 'เงินสด (บาท)', 'รับรู้ (บาท)', 'ต้นทุนค่าจ้าง (บาท)', 'กำไรขั้นต้น (บาท)', 'อัตรากำไร (%)', 'จำนวนเคส'],
    lines,
  };
}

/** รับรู้รายได้ — ต่อ BU + รายเคสแพ็ก */
export function recognitionCsv(d) {
  const lines = d.by_bu.filter((b) => b.cash || b.recognized || b.deferred || b.unpaid).map((b) => [
    buName(b.bu), num(b.cash), num(b.recognized), num(b.from_delivery), num(b.from_invoice), num(b.deferred), b.deferred_cases, num(b.unpaid), b.unpaid_cases,
  ]);
  lines.push([]);
  lines.push(['เลขเคส', 'ผู้รับบริการ', 'BU', 'แพ็กเกจ', 'หน่วยทั้งแพ็ก', 'ใช้แล้ว (รวมก่อนเข้าระบบ)', 'ใช้ในช่วง', 'ราคาต่อหน่วย', 'รับเงินแล้ว', 'รับรู้แล้ว', 'รับรู้ในช่วง', 'คงเหลือ (+ รับล่วงหน้า / − ค้างรับ)']);
  for (const c of d.cases) {
    lines.push([c.case_id, c.client_name, buName(c.bu), c.package, c.units, c.units_done, c.units_in_period, num(c.unit_price), num(c.paid_to_date), num(c.recognized_to_date), num(c.recognized_in_period), num(c.balance)]);
  }
  lines.push([]);
  lines.push([`ช่วง ${d.from} ถึง ${d.to} · ยอดคงเหลือ ณ ${d.to} · Homecare รับรู้ตามวันที่ให้บริการ · กายภาพตามครั้ง · อุปกรณ์/หัตถการ/เคสไม่มีแพ็ก รับรู้วันที่ออกใบ`]);
  return {
    header: ['BU', 'เงินสด (บาท)', 'รับรู้ (บาท)', 'รับรู้จากบริการ', 'รับรู้จากใบ', 'รับเงินล่วงหน้า (บาท)', 'เคส', 'ให้บริการแล้วยังไม่ได้รับเงิน (บาท)', 'เคส'],
    lines,
  };
}

/** ลูกหนี้ — ตาราง BU × อายุหนี้ + รายใบ */
export function receivablesCsv(d) {
  const lines = d.by_bu.filter((b) => b.total).map((b) => [buName(b.bu), ...d.aging.map((a) => num(b[a.key])), num(b.total)]);
  lines.push(['รวม', ...d.aging.map((a) => num(d.by_bu.reduce((s, b) => s + b[a.key], 0))), num(d.by_bu.reduce((s, b) => s + b.total, 0))]);
  lines.push([]);
  lines.push(['เลขที่ใบ', 'ลูกค้า', 'ผู้รับบริการ', 'เลขเคส', 'วันที่ออก', 'ครบกำหนด', 'เกินกำหนด (วัน)', 'ช่วงอายุ', 'ค้างชำระ (บาท)', ...BU_ORDER.map(buName)]);
  const agingLabel = Object.fromEntries(d.aging.map((a) => [a.key, a.label]));
  for (const i of d.invoices) {
    lines.push([i.invoice_id, i.customer, i.client_name ?? '', i.case_id ?? '', i.issue_date, i.due_date ?? '', i.days_overdue, agingLabel[i.bucket], num(i.balance), ...BU_ORDER.map((k) => num(i.parts[k] ?? 0))]);
  }
  lines.push([]);
  lines.push([`ณ ${d.today} · ใบที่ออกแล้วยังรอชำระ · ไม่มีวันครบกำหนด = ครบกำหนดวันออกใบ`]);
  return { header: ['BU', ...d.aging.map((a) => a.label), 'รวม (บาท)'], lines };
}

/** ลูกค้า — ต่อเคส/ยกเลิกต่อ BU · เหตุผล · 10 อันดับ */
export function customersCsv(d) {
  const lines = d.lifecycle.map((l) => [
    buName(l.bu), l.started, l.started_new, l.started_renew, l.started_midway, l.started_addon,
    l.closed, l.renewed, pctCsv(pct(l.renewed, l.closed)), l.cancelled, pctCsv(pct(l.cancelled, l.closed + l.cancelled)),
  ]);
  lines.push([]);
  lines.push(['เหตุผลยกเลิก', 'จำนวน', 'Homecare', 'กายภาพบำบัด']);
  for (const r of d.reasons) lines.push([r.reason, r.count, r.homecare, r.physio]);
  lines.push([]);
  lines.push(['อันดับ', 'ลูกค้า (ผู้ชำระ)', 'ยอดเงินเข้า (บาท)', 'สัดส่วน (%)', ...BU_ORDER.map(buName)]);
  d.top.forEach((c, i) => lines.push([i + 1, c.label, num(c.amount), pctCsv(pct(c.amount, d.concentration.total)), ...BU_ORDER.map((k) => num(c.by_bu[k] ?? 0))]));
  lines.push([]);
  lines.push([`ผู้ชำระ ${d.concentration.payers} ราย · อันดับ 1 = ${pctText(pct(d.concentration.top1, d.concentration.total))} · 5 อันดับ = ${pctText(pct(d.concentration.top5, d.concentration.total))} · 10 อันดับ = ${pctText(pct(d.concentration.top10, d.concentration.total))}`]);
  return {
    header: ['BU', 'เปิดเคสในช่วง', 'ใหม่', 'ต่อเคส', 'กลางทาง', 'แพ็กเสริม', 'ปิดจบในช่วง', 'ต่อเคสแล้ว', 'อัตราต่อเคส (%)', 'ยกเลิก', 'อัตรายกเลิก (%)'],
    lines,
  };
}

/** ส่วนลด/ราคา — ต่อ BU + ต่อแพ็ก */
export function pricingCsv(d) {
  const lines = d.by_bu.filter((b) => b.billed || b.received || b.refunds).map((b) => {
    const disc = b.discount + b.credit_discount;
    return [buName(b.bu), num(b.billed), num(b.discount), num(b.credit_discount), pctCsv(pct(disc, b.billed + b.discount)), num(b.received), num(b.refunds), pctCsv(pct(b.refunds, b.received))];
  });
  lines.push([]);
  lines.push(['แพ็กเกจ', 'รหัส', 'BU', 'เคส', 'จำนวนแพ็ก', 'เคสที่มีราคาตั้ง', 'ราคาตั้งรวม (บาท)', 'ขายจริงรวม (บาท)', 'ราคาจริง (% ของราคาตั้ง)']);
  for (const p of d.packages) {
    lines.push([p.label, p.code ?? '', buName(p.bu), p.cases, p.packs, p.priced, num(p.list_total), num(p.actual_total), pctCsv(pct(p.actual_total, p.list_total))]);
  }
  lines.push([]);
  lines.push([`ช่วง ${d.from} ถึง ${d.to} · ส่วนลดหน้าใบเป็นของค่าบริการ · ลดหนี้ = ใบลดหนี้เหตุผล "ส่วนลด" · ราคาจริงนับเคสที่เปิดในช่วง (ไม่นับยกเลิก)`]);
  return {
    header: ['BU', 'ยอดออกใบสุทธิ (บาท)', 'ส่วนลดหน้าใบ (บาท)', 'ลดหนี้-ส่วนลด (บาท)', 'อัตราส่วนลด (%)', 'รับเงิน (บาท)', 'คืนเงิน (บาท)', 'อัตราคืนเงิน (%)'],
    lines,
  };
}

export { busOf };
