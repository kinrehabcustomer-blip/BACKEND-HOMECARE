import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { formatDate, todayTH, invoiceStatusLabel, MONTH_LABELS, toBuddhistYear } from '../labels.js';
import { downloadCsv } from '../lib/attendanceUi.js';
import LineIcon from './LineIcon.jsx';
import { placeUnder } from '../lib/popover.js';

/**
 * ดาวน์โหลดใบแจ้งหนี้เป็น CSV แบบรายวัน / รายสัปดาห์ / รายเดือน (ผู้ใช้ขอ 6 พ.ย. 2569)
 *
 * ช่วงที่เลือก = ช่วงบริการ (24 พ.ย. 2569 · เดิมคิดจากวันที่ออกใบ) · สัปดาห์ = จันทร์–อาทิตย์ของวันที่เลือก · เดือน = วันที่ 1 ถึงสิ้นเดือน
 * ใช้ตัวกรองที่เลือกอยู่บนหน้า (ค้นหา / บริการ / สถานะ / ซ่อนใบยกเลิก) ชุดเดียวกับตาราง — ไฟล์จึงตรงกับที่เห็น
 * แถวละหนึ่งบรรทัดของใบ (ไม่มีแถวยอดรวมท้ายไฟล์ — ไฟล์รายบรรทัดใช้ทำ pivot ต่อ แถวรวมจะถูกนับซ้ำ)
 * ใบยกเลิก (ถ้าตัวกรองให้แสดง) อยู่ในไฟล์ แต่ยอดในช่วง/ชำระ/ค้าง = 0
 *
 * filters = เงื่อนไขของรายการตอนนี้ (ไม่มี page/per_page/sort) · filterNote = ข้อความบอกว่าใช้ตัวกรองอะไรอยู่
 */
const PERIODS = [
  { key: 'day', label: 'วัน' },
  { key: 'week', label: 'สัปดาห์' },
  { key: 'month', label: 'เดือน' },
];

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** ช่วงวันที่ (รวมสองปลาย) ของแต่ละแบบ — คิดแบบ UTC ล้วน โซนเวลาเครื่องไม่ทำให้วันเลื่อน */
function periodRange(kind, value) {
  if (kind === 'month') {
    const [y, m] = value.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${value}-01`, to: `${value}-${String(last).padStart(2, '0')}` };
  }
  if (kind === 'week') {
    const dow = new Date(`${value}T00:00:00Z`).getUTCDay(); // 0 = อาทิตย์
    const from = addDays(value, -((dow + 6) % 7)); // ถอยไปวันจันทร์
    return { from, to: addDays(from, 6) };
  }
  return { from: value, to: value };
}

const num = (v) => (v == null || v === '' ? '' : Math.round(Number(v) * 100) / 100);

/** ประเภทใบ — billing_kind ของใบ (มัดจำ/ส่วนที่เหลือ/ค่าใช้จ่ายเพิ่มเติม) · ใบแตกรายครั้งบอกไว้ด้วย */
function billingKindText(r) {
  if (r.billing_kind === 'deposit') return 'ใบมัดจำ';
  if (r.billing_kind === 'balance') return 'ใบส่วนที่เหลือ';
  if (r.billing_kind === 'extra') return 'ค่าใช้จ่ายเพิ่มเติม';
  return r.has_items ? 'ใบแจ้งหนี้ (รายครั้ง)' : 'ใบแจ้งหนี้';
}

export default function InvoiceExport({ filters, filterNote }) {
  const today = todayTH();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [kind, setKind] = useState('day');
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { tone: 'error' | 'ok', text }
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  // วางแผงใต้ปุ่ม (portal ไป body — การ์ดรายการตัดของที่ล้นขอบ) · กดที่อื่น / Esc = ปิด (แบบเดียวกับแผงรอออกใบ)
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos(placeUnder(r, { maxWidth: 304 })); // 19rem เท่าความกว้างเดิมของแผงนี้
    };
    place();
    const onDown = (e) => {
      if (!panelRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const range = periodRange(kind, kind === 'month' ? month : day);
  const rangeText = kind === 'month'
    ? `${MONTH_LABELS[month.slice(5, 7)]} ${toBuddhistYear(Number(month.slice(0, 4)))}`
    : kind === 'week'
      // เดือนเดียวกัน = "2–8 พ.ย. 2569" (สั้นพอให้บรรทัดสรุปไม่ตัดกลางคำ) · ข้ามเดือนเขียนเต็มสองฝั่ง
      ? range.from.slice(0, 7) === range.to.slice(0, 7)
        ? `${Number(range.from.slice(8))}–${formatDate(range.to)}`
        : `${formatDate(range.from)} – ${formatDate(range.to)}`
      : formatDate(range.from);

  async function download() {
    setBusy(true);
    setMsg(null);
    try {
      /* รายบรรทัด + เฉลี่ยตามช่วงบริการ (ผู้ใช้ขอ 24 พ.ย. 2569 — หัวคอลัมน์ตามไฟล์ตัวอย่างของผู้ใช้)
         ใบเข้าไฟล์ = ช่วงบริการคาบเกี่ยวช่วงที่เลือก · ไม่จด VAT = ทุกบรรทัด "ไม่มี VAT" · สาขา = ประเภทบริการ · สัญญา = ว่าง
         ตัวเลขทั้งหมดคิดที่ server (server/src/invoices/exportLines.js) หน้านี้แค่เรียงลงคอลัมน์ */
      const { data, truncated } = await api.exportInvoiceLines({ ...filters, from: range.from, to: range.to });
      if (data.length === 0) {
        setMsg({ tone: 'error', text: `ไม่มีรายการที่ช่วงบริการคาบเกี่ยว ${rangeText} ตามตัวกรองนี้` });
        return;
      }
      const header = [
        'วันที่', 'เลขที่เอกสาร', 'สัญญา', 'HN', 'ชื่อผู้รับบริการ', 'สาขา', 'ประเภทใบ', 'รหัสสินค้า', 'รายการ',
        'หมวดในใบเสร็จ', 'จำนวน', 'ยอดในใบ (รวม VAT)', 'ประเภทภาษี', 'ช่วงบริการ เริ่ม', 'ช่วงบริการ สิ้นสุด',
        'วันทั้งหมดของช่วงบริการ', 'วันที่อยู่ในช่วงที่เลือก', 'มูลค่าที่มี VAT (ก่อน VAT) ในช่วงที่เลือก',
        'VAT 7% ในช่วงที่เลือก', 'มูลค่าที่ไม่มี VAT ในช่วงที่เลือก', 'รวม (รวม VAT) ในช่วงที่เลือก',
        'ชำระแล้วของรายการ (รวม VAT)', 'ค้างชำระของรายการ (รวม VAT)', 'สถานะ', 'วันที่รับชำระ', 'ชำระด้วย', 'ค้างชำระ (วัน)',
      ];
      const lines = data.map((r) => [
        r.issue_date,
        r.invoice_id,
        '',
        r.patient_id,
        r.patient_name,
        r.branch,
        billingKindText(r),
        r.code,
        r.description,
        r.category,
        num(r.quantity),
        num(r.amount),
        'ไม่มี VAT',
        r.service_start,
        r.service_end,
        r.total_days,
        r.days_in_range,
        num(r.vat_base),
        num(r.vat),
        num(r.non_vat),
        num(r.in_range_total),
        num(r.paid),
        num(r.outstanding),
        r.is_overdue ? 'เกินกำหนด' : invoiceStatusLabel(r),
        r.paid_on,
        r.payment_methods,
        r.overdue_days || '',
      ]);

      const name = kind === 'month'
        ? `invoices-${month}.csv`
        : kind === 'week'
          ? `invoices-week-${range.from}_${range.to}.csv`
          : `invoices-${range.from}.csv`;
      downloadCsv(name, header, lines);
      setMsg({
        tone: truncated ? 'error' : 'ok',
        text: truncated
          ? `ดาวน์โหลดแล้ว ${data.length} รายการ — ใบตามตัวกรองนี้มีเกิน 5,000 ใบ ลองใส่ตัวกรองเพิ่ม`
          : `ดาวน์โหลดแล้ว ${data.length} รายการ จาก ${new Set(data.map((r) => r.invoice_id)).size} ใบ`,
      });
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`btn inv-csv-btn${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="ดาวน์โหลด CSV"
        onClick={() => setOpen((v) => !v)}
      >
        {/* ไอคอนไฟล์ CSV สีเขียว + "ดาวน์โหลด CSV" — แบบเดียวกันทุกปุ่ม CSV (ผู้ใช้ขอ 20 พ.ย. 2569) · มือถือเหลือแค่ไอคอน */}
        <LineIcon name="csv" className="btn-ico csv-ico" />
        <span className="inv-csv-label">ดาวน์โหลด CSV</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="todo-panel export-panel"
          role="dialog"
          aria-label="ดาวน์โหลดใบแจ้งหนี้เป็น CSV"
          style={pos}
        >
          {/* กะทัดรัด (ผู้ใช้ขอ 6 พ.ย. 2569): ไม่มีหัวแผง (ปุ่มที่กดเปิดบอกอยู่แล้วว่า CSV)
              แถว 1 = ช่วงเวลา · แถว 2 = วันที่ + ปุ่มดาวน์โหลด · แถว 3 = ช่วงที่ได้จริง + ตัวกรองที่ใช้ บรรทัดเล็กบรรทัดเดียว */}
          <div className="export-seg" role="radiogroup" aria-label="ช่วงเวลา">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={kind === p.key}
                className={kind === p.key ? 'on' : ''}
                onClick={() => { setKind(p.key); setMsg(null); }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="export-row">
            {kind === 'month' ? (
              <input
                type="month"
                aria-label="เดือน"
                value={month}
                max={today.slice(0, 7)}
                onChange={(e) => { setMonth(e.target.value || today.slice(0, 7)); setMsg(null); }}
              />
            ) : (
              <input
                type="date"
                aria-label={kind === 'week' ? 'วันใดก็ได้ในสัปดาห์นั้น' : 'วันที่'}
                value={day}
                max={today}
                onChange={(e) => { setDay(e.target.value || today); setMsg(null); }}
              />
            )}
            <button type="button" className="btn primary export-go" disabled={busy} onClick={download}>
              <LineIcon name="download" />
              {busy ? 'กำลังเตรียม…' : 'ดาวน์โหลด'}
            </button>
          </div>

          <p className="export-sum">
            <strong>{rangeText}</strong> · {filterNote}
          </p>

          {msg && <p className={msg.tone === 'error' ? 'error export-msg' : 'export-msg is-ok'}>{msg.text}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}
