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
 * ช่วงคิดจาก "วันที่ออกใบ" · สัปดาห์ = จันทร์–อาทิตย์ของวันที่เลือก · เดือน = วันที่ 1 ถึงสิ้นเดือน
 * ใช้ตัวกรองที่เลือกอยู่บนหน้า (ค้นหา / บริการ / สถานะ / ซ่อนใบยกเลิก) ชุดเดียวกับตาราง — ไฟล์จึงตรงกับที่เห็น
 * แถวสุดท้ายเป็นยอดรวม ไม่นับใบที่ยกเลิก (ใบยกเลิกยังอยู่ในไฟล์ให้เห็นว่าเลขที่ไม่ขาดช่วง)
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
      const { data, truncated } = await api.exportInvoices({ ...filters, issued_from: range.from, issued_to: range.to });
      if (data.length === 0) {
        setMsg({ tone: 'error', text: `ไม่มีใบแจ้งหนี้ที่ออกในช่วง ${rangeText} ตามตัวกรองนี้` });
        return;
      }
      const header = [
        'ลำดับ', 'เลขที่ใบ', 'วันที่ออก', 'ครบกำหนด', 'วันที่ชำระ', 'สถานะ', 'รหัสเคส', 'ผู้รับบริการ', 'ผู้จ่าย',
        'เบอร์ติดต่อ', 'รายการ', 'ยอดหน้าใบ', 'ลดหนี้/เพิ่มหนี้', 'ยอดสุทธิ', 'รับชำระแล้ว', 'คงค้าง',
      ];
      const lines = data.map((v, i) => [
        i + 1,
        v.invoice_id,
        v.issue_date ?? '',
        v.due_date ?? '',
        v.paid_at ? String(v.paid_at).slice(0, 10) : '',
        v.is_overdue ? 'เกินกำหนด' : invoiceStatusLabel(v),
        v.case_id ?? '',
        v.patient_name ?? '',
        v.bill_to_name ?? '',
        v.contact_phone ?? '',
        v.service_description ?? '',
        num(v.total),
        num(v.adjustment_total),
        num(v.net_total ?? v.total),
        num(v.paid_amount),
        num(v.status === 'cancelled' ? 0 : v.balance),
      ]);
      // ยอดรวมท้ายไฟล์ — ไม่นับใบยกเลิก (ยกเลิกแล้วไม่ใช่เงินที่ต้องเก็บ)
      const live = data.filter((v) => v.status !== 'cancelled');
      const sum = (f) => num(live.reduce((s, v) => s + Number(f(v) ?? 0), 0));
      lines.push([
        '', `รวม ${live.length} ใบ (ไม่นับใบยกเลิก)`, '', '', '', '', '', '', '', '', '',
        sum((v) => v.total), sum((v) => v.adjustment_total), sum((v) => v.net_total ?? v.total),
        sum((v) => v.paid_amount), sum((v) => v.balance),
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
          ? `ดาวน์โหลดแล้ว ${data.length} ใบแรก — ช่วงนี้มีมากกว่านั้น ลองแบ่งช่วงให้สั้นลง`
          : `ดาวน์โหลดแล้ว ${data.length} ใบ`,
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
        <LineIcon name="download" />
        <span className="inv-csv-label">CSV</span>
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
                aria-label={kind === 'week' ? 'วันใดก็ได้ในสัปดาห์นั้น' : 'วันที่ออกใบ'}
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
