import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useCanSeeStaffPay } from '../auth.jsx';
import { todayTH } from '../labels.js';
import { useChartTokens } from '../lib/chartTheme.js';
import { downloadCsv } from '../lib/attendanceUi.js';
import ErrorBar from '../components/ErrorBar.jsx';
import LineIcon from '../components/LineIcon.jsx';
import {
  CustomersTab, MarginTab, OverviewTab, PricingTab, ReceivablesTab, RecognitionTab,
} from '../components/RevenueBuTabs.jsx';
import {
  PRESETS, customersCsv, marginCsv, monthStart, overviewCsv, pricingCsv, rangeDates, rangeName,
  receivablesCsv, recognitionCsv, stepRange,
} from '../lib/revenueReport.js';

/**
 * รายได้ตาม BU (ผู้ใช้ขอ 20 พ.ย. 2569 — "ทำข้อ 1–5 + ส่วนที่แนะนำ · รื้อของเก่าออกก่อน") · server: invoices/buReport.js · สิทธิ์ revenue
 *
 *   ภาพรวม        รายได้ต่อ BU (เงินสด) เทียบช่วงก่อน + ปีก่อน + เป้ารายเดือน · แนวโน้ม 12 เดือน
 *   กำไร          กำไรขั้นต้นตาม BU / แพ็กเกจ / พนักงานหลัก — ต้นทุน = ค่าจ้างที่ปล่อยจ่ายจริง · เฉพาะคนที่มีสิทธิ์ see_pay
 *   รับรู้รายได้   ตามบริการที่ส่งมอบจริง · รับเงินล่วงหน้า · ให้บริการแล้วยังไม่ได้รับเงิน
 *   ลูกหนี้        ค้างชำระตาม BU แยกอายุหนี้ (ณ วันนี้)
 *   ลูกค้า        อัตราต่อเคส · อัตรายกเลิก + เหตุผล · การกระจุกตัวของลูกค้า 10 อันดับแรก
 *   ส่วนลดและราคา  ส่วนลด/เงินคืนต่อ BU · ราคาขายจริงเทียบราคาตั้งต่อแพ็ก
 * แต่ละแท็บโหลดเมื่อเปิดครั้งแรกของช่วงนั้น (จำไว้ — สลับแท็บกลับมาไม่โหลดซ้ำ) · ปุ่ม CSV ส่งออกแท็บที่เปิดอยู่
 * แท็บที่เลือกจำไว้ใน ?tab= (ส่งลิงก์ให้กันได้)
 */

const TABS = [
  { key: 'overview', label: 'ภาพรวม', csv: (d) => overviewCsv(d), file: 'ภาพรวม' },
  { key: 'margin', label: 'กำไร', pay: true, csv: (d, o) => marginCsv(d, o.basis), file: 'กำไรขั้นต้น' },
  { key: 'recognition', label: 'รับรู้รายได้', csv: (d) => recognitionCsv(d), file: 'รับรู้รายได้' },
  { key: 'receivables', label: 'ลูกหนี้', noRange: true, csv: (d) => receivablesCsv(d), file: 'ลูกหนี้แยกอายุ' },
  { key: 'customers', label: 'ลูกค้า', csv: (d) => customersCsv(d), file: 'ลูกค้า' },
  { key: 'pricing', label: 'ส่วนลดและราคา', csv: (d) => pricingCsv(d), file: 'ส่วนลดและราคา' },
];

export default function RevenueBuPage() {
  const today = todayTH();
  const canPay = useCanSeeStaffPay();
  const tabs = TABS.filter((t) => !t.pay || canPay);
  const [params, setParams] = useSearchParams();
  const tab = tabs.find((t) => t.key === params.get('tab')) ?? tabs[0];
  const [range, setRange] = useState({ from: monthStart(today), to: today });
  const [store, setStore] = useState({});
  const [error, setError] = useState(null);
  // ตัวเลือกของแท็บกำไร — อยู่ที่หน้า เพราะไฟล์ CSV ต้องใช้เกณฑ์เดียวกับที่เห็น
  const [basis, setBasis] = useState('recognized');
  const [dim, setDim] = useState('bu');
  const tokens = useChartTokens();

  const { from, to } = range;
  const key = tab.noRange ? tab.key : `${tab.key}:${from}:${to}`;
  const data = store[key];

  useEffect(() => {
    if (store[key]) return undefined;
    let cancelled = false;
    setError(null);
    api.revenueBu(tab.key, tab.noRange ? null : { from, to })
      .then((d) => !cancelled && setStore((s) => ({ ...s, [key]: d })))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickTab = (k) => setParams(k === 'overview' ? {} : { tab: k }, { replace: true });
  const step = (dir) => { const [f, t] = stepRange(from, to, dir, today); setRange({ from: f, to: t }); };
  const exportCsv = () => {
    const { header, lines } = tab.csv(data, { basis });
    const tag = tab.noRange ? `ณ_${data.today}` : `${from}_${to}`;
    downloadCsv(`รายได้BU_${tab.file}${tab.key === 'margin' ? `_${basis === 'cash' ? 'เงินสด' : 'ตามบริการ'}` : ''}_${tag}.csv`, header, lines);
  };

  const props = { d: data, tokens };
  return (
    <>
      <h1 className="sr-only">รายได้ตาม BU</h1>

      <div className="bu-filters" role="toolbar" aria-label="ช่วงเวลาและส่งออก">
        <div className={`bu-range-ctl${tab.noRange ? ' is-off' : ''}`} title={tab.noRange ? 'แท็บลูกหนี้แสดงยอด ณ วันนี้ ไม่ขึ้นกับช่วงเวลา' : undefined}>
          <button type="button" className="bu-step" onClick={() => step(-1)} aria-label="ช่วงก่อนหน้า" title="ช่วงก่อนหน้า">‹</button>
          <RangePicker from={from} to={to} today={today} onApply={(f, t) => setRange({ from: f, to: t })} />
          <button type="button" className="bu-step" onClick={() => step(1)} disabled={to >= today} aria-label="ช่วงถัดไป" title="ช่วงถัดไป">›</button>
        </div>
      </div>

      {/* แถวแท็บ + ปุ่ม CSV ชิดขวา (ผู้ใช้ขอ 20 พ.ย. 2569 "ย้ายปุ่มดาวน์โหลด csv มาอยู่ตรงที่วง") */}
      <div className="rbu-tabbar">
        <div className="rbu-tabs">
          <div className="seg" role="tablist" aria-label="หัวข้อรายงาน">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={t.key === tab.key} className={t.key === tab.key ? 'on' : ''}
                onClick={() => pickTab(t.key)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="bu-export-slot">
          {/* ไอคอนไฟล์ CSV สีเขียว + "ดาวน์โหลด CSV" แบบเดียวกับทุกหน้า — ส่งออกแท็บที่เปิดอยู่ */}
          <button type="button" className="btn" disabled={!data} onClick={exportCsv} title={`ส่งออกแท็บ "${tab.label}" เป็น CSV`}>
            <LineIcon name="csv" className="btn-ico csv-ico" />ดาวน์โหลด CSV
          </button>
        </div>
      </div>

      <ErrorBar message={error} />
      {!data && !error && <p className="muted">กำลังโหลด…</p>}
      {data && (
        <div role="tabpanel" aria-label={tab.label}>
          {tab.key === 'overview' && <OverviewTab {...props} />}
          {tab.key === 'margin' && <MarginTab {...props} basis={basis} setBasis={setBasis} dim={dim} setDim={setDim} />}
          {tab.key === 'recognition' && <RecognitionTab key={key} {...props} />}
          {tab.key === 'receivables' && <ReceivablesTab {...props} />}
          {tab.key === 'customers' && <CustomersTab {...props} />}
          {tab.key === 'pricing' && <PricingTab {...props} />}
        </div>
      )}
    </>
  );
}

/**
 * ปุ่มช่วงเวลา — บอกชื่อช่วง + วันที่ · กดแล้วกางตัวเลือกด่วน (ติ๊กตัวที่ใช้อยู่) และช่องกำหนดเองท้ายรายการ
 * กำหนดเองต้องกด "ใช้ช่วงนี้" ก่อนถึงโหลดใหม่ — ไม่ยิงข้อมูลทุกครั้งที่เลื่อนปฏิทินไปมา
 */
function RangePicker({ from, to, today, onApply }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [draft, setDraft] = useState({ from, to });
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const name = rangeName(from, to, today);

  useEffect(() => {
    if (!open) return undefined;
    setDraft({ from, to });
    const r = btnRef.current.getBoundingClientRect();
    const width = Math.min(272, window.innerWidth - 24);
    setPos({ top: r.bottom + 6, left: Math.min(Math.max(12, r.left), window.innerWidth - width - 12), width });
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (f, t) => { onApply(f, t); setOpen(false); };
  const draftOk = draft.from && draft.to && draft.from <= draft.to && draft.to <= today;

  return (
    <>
      <button ref={btnRef} type="button" className="bu-range-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <LineIcon name="calendar" />
        <span className="bu-range-text">
          {name && <strong>{name}</strong>}
          <span className={name ? 'muted' : ''}>{rangeDates(from, to)}</span>
        </span>
        <span className="bu-caret" aria-hidden="true">▾</span>
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} className="bu-range-pop" style={pos} role="dialog" aria-label="เลือกช่วงเวลา">
          <ul className="bu-range-list">
            {PRESETS.map((p) => {
              const [f, t] = p.range(today);
              const on = f === from && t === to;
              return (
                <li key={p.key}>
                  <button type="button" className={`bu-range-opt${on ? ' is-on' : ''}`} onClick={() => pick(f, t)}>
                    <span className="bu-check" aria-hidden="true">{on ? '✓' : ''}</span>
                    <span className="bu-opt-name">{p.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="bu-range-custom">
            <p className="field-label">กำหนดเอง</p>
            <div className="bu-range-inputs">
              <label>
                <span className="muted">ตั้งแต่</span>
                <input type="date" value={draft.from} max={draft.to || today} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
              </label>
              <label>
                <span className="muted">ถึง</span>
                <input type="date" value={draft.to} min={draft.from || undefined} max={today} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
              </label>
            </div>
            <button type="button" className="btn primary bu-range-apply" disabled={!draftOk} onClick={() => pick(draft.from, draft.to)}>ใช้ช่วงนี้</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
