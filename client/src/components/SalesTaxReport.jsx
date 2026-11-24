import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { ISSUER, printStamp } from '../lib/issuer.js';
import { MONTH_LABELS, formatDate, toBuddhistYear, todayTH } from '../labels.js';
import LineIcon from './LineIcon.jsx';
import './SalesTaxReport.css';

/**
 * รายงานภาษีขายรายเดือน (ผู้ใช้ขอ 24 พ.ย. 2569 — "ตามรูปตัวอย่าง แต่เป็น design โปรแกรมเราเอง")
 *
 * ตัวเลขทั้งหมดมาจาก server (server/src/invoices/salesTax.js):
 *   ใบเสร็จรับเงิน/ใบกำกับภาษีตามวันที่รับเงิน + ใบลดหนี้ (ติดลบ) / ใบเพิ่มหนี้ ตามวันที่ออก
 *   ไม่จด VAT → ภาษีมูลค่าเพิ่ม 0 ทุกแถว · ใบที่ยกเลิกแสดงเป็น 0 พร้อมป้าย "ยกเลิก" (เลขที่ไม่ขาดช่วง)
 *
 * พิมพ์ / PDF: ตัวเอกสารชุดเดียวกันวางสองที่ — ในกล่องบนจอ (ดูก่อนพิมพ์) กับสำเนาใน .print-sheet
 * (ลูกตรงของ <body> · ตอนพิมพ์ซ่อนทั้งแอปเหลือตัวนี้ ดู index.css) แบบเดียวกับใบแจ้งหนี้
 * รายงานยาวได้หลายแผ่น — หัวตารางพิมพ์ซ้ำทุกแผ่นเอง (thead)
 */

const money = (n) => Number(n ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 'YYYY-MM-DD' -> 'DD-MM-พ.ศ.' แบบในแบบฟอร์มภาษี */
const docDate = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${toBuddhistYear(iso.slice(0, 4))}` : '');
/** เลขผู้เสียภาษี 13 หลัก -> 0-1055-61155-23-6 */
const taxIdText = (id) => {
  const d = String(id ?? '').replace(/\D/g, '');
  return d.length === 13 ? `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}` : (id ?? '');
};
const ISSUER_NAME = ISSUER.name.replace(/\s*\(สำนักงานใหญ่\)\s*$/, '');
const IS_HEAD_OFFICE = /สำนักงานใหญ่/.test(ISSUER.name);

const DOC_LABEL = { credit: 'ใบลดหนี้', debit: 'ใบเพิ่มหนี้' };
/** ป้ายเล็กใต้ชื่อผู้ซื้อ — งวดของใบ / ใบลด-เพิ่มหนี้ / ยกเลิก */
function tagsOf(r) {
  const tags = [];
  if (r.cancelled) tags.push({ text: 'ยกเลิก', tone: 'cancel' });
  if (DOC_LABEL[r.doc_type]) tags.push({ text: DOC_LABEL[r.doc_type], tone: r.doc_type });
  else if (r.billing_kind === 'deposit' || r.is_deposit) tags.push({ text: 'งวด 1/2', tone: 'part' });
  else if (r.billing_kind === 'balance') tags.push({ text: 'งวด 2/2', tone: 'part' });
  return tags;
}

/** ข้อความช่วงของรายงาน — ทั้งเดือน = "พฤศจิกายน ปี 2569" · ช่วงวันที่ = "1 พฤศจิกายน 2569 ถึง 24 พฤศจิกายน 2569" */
const longDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTH_LABELS[iso.slice(5, 7)]} ${toBuddhistYear(iso.slice(0, 4))}`;
const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * ตัดรายงานช่วงที่กว้างกว่าให้เหลือช่วงที่ต้องการ — แถวกรองด้วยวันที่ของเอกสารชุดเดียวกับที่ server ใช้
 * (ใบเสร็จ = วันที่รับเงิน · ใบลด/เพิ่มหนี้ = วันที่ออก) ผลจึงเท่ากับขอ server ใหม่ทุกแถว ไม่ต้องรอโหลด
 */
const r2 = (n) => Math.round(n * 100) / 100;
function sliceReport(src, from, to, month) {
  const data = src.data.filter((r) => r.doc_date >= from && r.doc_date <= to);
  const sum = (k) => r2(data.reduce((s, r) => s + r[k], 0));
  return { month, from, to, data, totals: { count: data.length, base: sum('base'), vat: sum('vat'), total: sum('total') } };
}

function TaxDoc({ report }) {
  const isMonth = Boolean(report.month);
  const [y, m] = (report.month ?? report.from).split('-');
  const period = isMonth ? `เดือนภาษี ${MONTH_LABELS[m]} ปี ${toBuddhistYear(y)}` : `ช่วงวันที่ ${longDate(report.from)} ถึง ${longDate(report.to)}`;
  return (
    <div className="invoice-doc tax-doc">
      <p className="inv-printed">วันที่พิมพ์: {printStamp()}</p>
      <div className="tax-doc-head">
        <h3>รายงานภาษีขาย</h3>
        <p>{period}</p>
      </div>
      <div className="tax-doc-org">
        <div>
          <p>ชื่อผู้ประกอบการ : <strong>{ISSUER_NAME}</strong></p>
          <p>ชื่อสถานประกอบการ : {ISSUER.address}</p>
        </div>
        <div className="tax-doc-org-right">
          <p>เลขประจำตัวผู้เสียภาษีอากร : <strong>{taxIdText(ISSUER.taxId)}</strong></p>
          <p>
            <span className="tax-box">{IS_HEAD_OFFICE ? '☑' : '☐'}</span> สำนักงานใหญ่{' '}
            <span className="tax-box">{IS_HEAD_OFFICE ? '☐' : '☑'}</span> สาขาที่ .....
          </p>
        </div>
      </div>

      <table className="inv-table tax-table">
        <thead>
          <tr>
            <th rowSpan={2} className="tx-no">ลำดับ</th>
            <th colSpan={2}>ใบกำกับภาษี</th>
            <th rowSpan={2}>ชื่อผู้ซื้อสินค้า / ผู้รับบริการ</th>
            <th rowSpan={2} className="tx-tax">เลขประจำตัวผู้เสียภาษีของผู้ซื้อ</th>
            <th rowSpan={2} className="tx-branch">สนญ. / สาขา</th>
            <th rowSpan={2} className="tx-money">มูลค่าสินค้า / บริการ</th>
            <th rowSpan={2} className="tx-money">จำนวนเงินภาษีมูลค่าเพิ่ม</th>
            <th rowSpan={2} className="tx-money">มูลค่าสุทธิ</th>
          </tr>
          <tr>
            <th className="tx-date">วันที่</th>
            <th className="tx-id">เลขที่</th>
          </tr>
        </thead>
        <tbody>
          {report.data.length === 0 && (
            <tr><td colSpan={9} className="inv-c tax-empty">ไม่มีใบเสร็จ / ใบลดหนี้ / ใบเพิ่มหนี้ใน{isMonth ? 'เดือนนี้' : 'ช่วงนี้'}</td></tr>
          )}
          {report.data.map((r, i) => (
            <tr key={`${r.doc_type}:${r.doc_id}`} className={r.cancelled ? 'is-cancelled' : undefined}>
              <td className="inv-c">{i + 1}</td>
              <td className="inv-c">{docDate(r.doc_date)}</td>
              <td className="tx-id">{r.doc_id}</td>
              <td>
                <span className="tax-buyer">{r.buyer_name || '—'}</span>
                {tagsOf(r).map((t) => <span key={t.text} className={`tax-tag is-${t.tone}`}>{t.text}</span>)}
                <span className="tax-ref">ใบ {r.invoice_id}</span>
              </td>
              <td className="inv-c">{r.buyer_tax_id ? taxIdText(r.buyer_tax_id) : ''}</td>
              <td className="inv-c" />
              <td className="inv-r">{money(r.base)}</td>
              <td className="inv-r">{money(r.vat)}</td>
              <td className="inv-r">{money(r.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6} className="inv-r"><strong>รวม {report.totals.count} รายการ</strong></td>
            <td className="inv-r"><strong>{money(report.totals.base)}</strong></td>
            <td className="inv-r"><strong>{money(report.totals.vat)}</strong></td>
            <td className="inv-r"><strong>{money(report.totals.total)}</strong></td>
          </tr>
        </tfoot>
      </table>
      <p className="tax-note">ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม — จำนวนเงินภาษีมูลค่าเพิ่มเป็น 0 ทุกรายการ</p>

      <div className="tax-signs">
        <div><span className="tax-sign-line" /><p>ผู้จัดทำ</p></div>
        <div><span className="tax-sign-line" /><p>ผู้ตรวจสอบ</p></div>
      </div>
    </div>
  );
}

export default function SalesTaxReport({ onClose }) {
  const today = todayTH();
  const thisMonth = today.slice(0, 7);
  /* ดูได้สองแบบ (ผู้ใช้ขอเพิ่ม 24 พ.ย. 2569): ทั้งเดือน (แบบฟอร์มยื่นภาษี) หรือช่วงวันที่ที่เลือกเอง
     ช่วงวันที่เริ่มต้น = ต้นเดือนนี้ถึงวันนี้ · เปลี่ยนไปมาแล้วค่าที่เลือกไว้ของแต่ละแบบยังอยู่ */
  const [mode, setMode] = useState('month');
  const [month, setMonth] = useState(thisMonth);
  const [from, setFrom] = useState(`${thisMonth}-01`);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const want = mode === 'month' ? { from: `${month}-01`, to: monthEnd(month) } : { from, to };
  const rangeError = mode === 'range' && from > to ? 'วันเริ่มต้องไม่เกินวันสิ้นสุด' : null;

  /* รายงานที่เคยโหลดในกล่องนี้ (เปิดกล่องใหม่ = โหลดใหม่ ข้อมูลไม่ค้างเก่า) — ผู้ใช้แจ้ง 24 พ.ย. 2569:
     สลับ "รายเดือน" → "ช่วงวันที่" แล้วต้องรอโหลดใหม่ทั้งที่ช่วงเริ่มต้นอยู่ในเดือนที่โหลดไว้แล้ว
     ช่วงที่อยู่ในรายงานที่มีอยู่ = ตัดจากของเดิมทันที ไม่ยิงคำขอ · นอกนั้นค่อยถาม server */
  const loaded = useRef([]);
  useEffect(() => {
    if (rangeError) return undefined;
    const monthMode = mode === 'month';
    const cover = loaded.current.find((r) => r.from <= want.from && r.to >= want.to);
    if (cover) {
      setReport(sliceReport(cover, want.from, want.to, monthMode ? month : null));
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.salesTaxReport(monthMode ? { month } : { from, to })
      .then((r) => {
        loaded.current.push(r);
        if (!cancelled) setReport(r);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [mode, month, from, to, rangeError]); // eslint-disable-line react-hooks/exhaustive-deps -- want มาจากค่าชุดนี้

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [y, m] = month.split('-');
  const title = mode === 'month'
    ? `รายงานภาษีขาย · ${MONTH_LABELS[m]} ปี ${toBuddhistYear(y)}`
    : `รายงานภาษีขาย · ${formatDate(from)} – ${formatDate(to)}`;
  // คำตอบที่ตรงกับช่วงที่เลือกอยู่ตอนนี้เท่านั้น (เปลี่ยนช่วงระหว่างโหลด = ไม่โชว์/พิมพ์ของช่วงเก่า)
  const ready = !rangeError && report && report.from === want.from && report.to === want.to
    && Boolean(report.month) === (mode === 'month');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide tax-modal" role="dialog" aria-modal="true" aria-labelledby="tax-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="tax-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>
        <div className="modal-body">
          <div className="tax-toolbar">
            <div className="tax-pick">
              <div className="seg" role="group" aria-label="ช่วงของรายงาน">
                <button type="button" className={mode === 'month' ? 'on' : ''} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>รายเดือน</button>
                <button type="button" className={mode === 'range' ? 'on' : ''} aria-pressed={mode === 'range'} onClick={() => setMode('range')}>ช่วงวันที่</button>
              </div>
              {mode === 'month' ? (
                <label className="tax-month">
                  <span>เดือนภาษี</span>
                  <input type="month" value={month} max={thisMonth} onChange={(e) => setMonth(e.target.value || thisMonth)} />
                </label>
              ) : (
                <div className="tax-range">
                  <input type="date" aria-label="ตั้งแต่วันที่" value={from} max={today} onChange={(e) => setFrom(e.target.value || from)} />
                  <span aria-hidden="true">ถึง</span>
                  <input type="date" aria-label="ถึงวันที่" value={to} max={today} onChange={(e) => setTo(e.target.value || to)} />
                </div>
              )}
            </div>
            {ready && (
              <p className="muted">
                {report.totals.count} รายการ · มูลค่าสุทธิ <strong>{money(report.totals.total)}</strong> บาท
              </p>
            )}
          </div>
          {(rangeError || error) && <p className="error">{rangeError ?? error}</p>}
          {/* ระหว่างโหลดช่วงใหม่ คงกระดาษเดิมไว้แบบจาง (ไม่กระพริบเป็นหน้าว่าง) — ปุ่มพิมพ์ปิดจนกว่าจะได้ช่วงที่เลือกจริง */}
          <div className={`tax-paper-wrap${report && !ready ? ' is-stale' : ''}`} aria-busy={loading}>
            {report ? <TaxDoc report={report} /> : loading && <p className="muted loading-center">กำลังโหลด…</p>}
          </div>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>ปิด</button>
          <button type="button" className="btn primary" disabled={!ready} onClick={() => window.print()}>
            <LineIcon name="printer" />พิมพ์
          </button>
        </footer>
      </div>
      {/* สำเนาสำหรับพิมพ์ — บนจอไม่แสดง ตอนพิมพ์เหลือตัวนี้ตัวเดียว (ดู .print-sheet ใน index.css) */}
      {ready && createPortal(<div className="print-sheet" aria-hidden="true"><TaxDoc report={report} /></div>, document.body)}
    </div>
  );
}
