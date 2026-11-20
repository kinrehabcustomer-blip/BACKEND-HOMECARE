import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatBaht, formatDate, todayTH } from '../labels.js';
import { downloadCsv } from '../lib/attendanceUi.js';
import { caseCode } from '../lib/patientCode.js';
import ErrorBar from '../components/ErrorBar.jsx';
import LineIcon from '../components/LineIcon.jsx';

/**
 * บันทึกการเงิน (ผู้ใช้ขอ 20 พ.ย. 2569) — แท็บในหน้าตั้งค่าระบบ · สิทธิ์ finance_logs · server: finance/log.js
 *
 *   ยอดประจำวัน   แถวละวัน ตัวเลขที่จดไว้ ณ วันนั้น — ยอดคงค้างของวันที่ผ่านไปแล้วแก้ย้อนหลังไม่ได้
 *   รายการเงิน    ทุกความเคลื่อนไหว: รับเงิน · คืนเงิน · ยกเลิก · ออกใบ · ลดหนี้/เพิ่มหนี้ · ปล่อย/จ่ายค่าจ้าง
 *   ส่งออก CSV ได้ทั้งสองตาราง
 */
const money = (v) => (Number(v) < 0 ? `−${formatBaht(-Number(v))}` : formatBaht(v));
const signed = (v) => (Number(v) > 0 ? `+${formatBaht(v)}` : money(v));

export const KIND_LABELS = {
  payment: 'รับเงิน',
  payment_void: 'ยกเลิกรับเงิน',
  refund: 'คืนเงิน',
  refund_void: 'ยกเลิกเงินคืน',
  invoice_issued: 'ออกใบแจ้งหนี้',
  invoice_cancelled: 'ยกเลิกใบแจ้งหนี้',
  credit_note: 'ใบลดหนี้',
  credit_note_cancelled: 'ยกเลิกใบลดหนี้',
  debit_note: 'ใบเพิ่มหนี้',
  debit_note_cancelled: 'ยกเลิกใบเพิ่มหนี้',
  payout_released: 'ปล่อยค่าจ้าง',
  payroll_paid: 'จ่ายค่าจ้างรอบ',
};
const GROUPS = [
  { key: '', label: 'ทั้งหมด' },
  { key: 'cash', label: 'เงินเข้า/ออก' },
  { key: 'ar', label: 'ค้างชำระ' },
  { key: 'payroll', label: 'ค่าจ้าง' },
];
const GROUP_LABELS = { cash: 'เงินเข้า/ออก', ar: 'ค้างชำระ', payroll: 'ค่าจ้าง' };

const shiftDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
const prevMonth = (iso) => {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const from = d.toISOString().slice(0, 10);
  return { from, to: shiftDays(monthStart(iso), -1) };
};
const PRESETS = [
  { key: 'month', label: 'เดือนนี้', range: (t) => ({ from: monthStart(t), to: t }) },
  { key: 'last', label: 'เดือนที่แล้ว', range: (t) => prevMonth(t) },
  { key: '30', label: '30 วัน', range: (t) => ({ from: shiftDays(t, -29), to: t }) },
  { key: '90', label: '90 วัน', range: (t) => ({ from: shiftDays(t, -89), to: t }) },
];
// ตารางละ 10 แถวต่อหน้า (ผู้ใช้ขอ 20 พ.ย. 2569) — ที่เหลือกดหน้าถัดไป · CSV ยังส่งออกครบทุกแถว
const PAGE = 10;

export default function FinanceLogPage() {
  const today = todayTH();
  const [range, setRange] = useState(() => PRESETS[0].range(today));
  const [preset, setPreset] = useState('month');
  const [view, setView] = useState('events');
  const [error, setError] = useState(null);

  const [snaps, setSnaps] = useState(null);
  const [events, setEvents] = useState(null);
  const [grp, setGrp] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [snapPage, setSnapPage] = useState(1);

  const rangeOk = range.from && range.to && range.from <= range.to;
  useEffect(() => {
    if (!rangeOk || view !== 'daily') return undefined;
    let off = false;
    setSnaps(null);
    setSnapPage(1);
    /* จดยอดของวันนี้ให้เป็นตัวเลขล่าสุดก่อน แล้วค่อยโหลดตาราง — แถว "วันนี้" จึงตรงกับตอนที่เปิดดูเสมอ
       (การ์ดตัวเลขสดด้านบนเอาออกแล้ว · ผู้ใช้ขอ 20 พ.ย. 2569 — ทุกเช้างานตั้งเวลาก็จดให้อยู่แล้ว) */
    api.financeToday().catch(() => {})
      .then(() => api.financeSnapshots(range))
      .then((r) => !off && setSnaps(r.rows))
      .catch((e) => !off && setError(e.message));
    return () => { off = true; };
  }, [range, view, rangeOk]);

  useEffect(() => {
    if (!rangeOk || view !== 'events') return undefined;
    let off = false;
    setEvents(null);
    setPage(1);
    api.financeEvents({ ...range, ...(grp ? { grp } : {}), ...(query ? { q: query } : {}) })
      .then((r) => !off && setEvents(r))
      .catch((e) => !off && setError(e.message));
    return () => { off = true; };
  }, [range, view, grp, query, rangeOk]);

  // พิมพ์ค้นหาแล้วหยุด 0.4 วินาทีค่อยยิง — ไม่ยิงทุกตัวอักษร
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const pickPreset = (p) => { setPreset(p.key); setRange(p.range(today)); };
  const setDate = (k, v) => { setPreset(''); setRange((r) => ({ ...r, [k]: v })); };
  const tag = `${range.from}_${range.to}`;

  function exportSnapshots() {
    downloadCsv(`บันทึกการเงิน_ยอดประจำวัน_${tag}.csv`,
      ['วันที่', 'เงินเข้า', 'เงินคืน', 'สุทธิ', 'จำนวนรายการรับเงิน', 'ลูกหนี้ค้างชำระ', 'จำนวนใบค้างชำระ',
        'เกินกำหนด', 'จำนวนใบเกินกำหนด', 'ใบร่างยังไม่ออก', 'จำนวนใบร่าง', 'ออกใบวันนั้น', 'ใบลดหนี้', 'ใบเพิ่มหนี้',
        'ค่าจ้างค้างจ่าย', 'จ่ายค่าจ้างวันนั้น', 'เคสรอปล่อยค่าจ้าง', 'จดเมื่อ'],
      (snaps ?? []).map((s) => [s.snap_date, s.cash_in, s.refunds_out, s.net_cash, s.payments_count, s.ar_outstanding,
        s.ar_count, s.ar_overdue, s.ar_overdue_count, s.draft_total, s.draft_count, s.issued_total, s.credit_notes,
        s.debit_notes, s.payroll_owed, s.payroll_paid, s.unreleased_cases, s.captured_at]));
  }
  function exportEvents() {
    downloadCsv(`บันทึกการเงิน_รายการ_${tag}.csv`,
      ['วันที่', 'เวลาที่บันทึก', 'กลุ่ม', 'รายการ', 'จำนวนเงิน', 'เลขเอกสาร', 'ใบแจ้งหนี้', 'รหัสเคส', 'ลูกค้า/พนักงาน', 'ช่องทาง', 'ผู้ทำรายการ', 'หมายเหตุ'],
      (events?.rows ?? []).map((r) => [r.day, r.at ?? '', GROUP_LABELS[r.grp], KIND_LABELS[r.kind] ?? r.kind, r.amount,
        r.doc_id ?? '', r.invoice_id ?? '', r.case_id ? caseCode(r.case_id) : '', r.party ?? '', r.method ?? '', r.actor ?? '', r.note ?? '']));
  }

  return (
    <div className="fin">
      <ErrorBar message={error} />

      {/* การ์ดเดียว (ผู้ใช้ขอ 20 พ.ย. 2569): แถวบน = มุมมอง + ช่วงเวลา · แถวสอง = ตัวกรองของมุมมองนั้น · แล้วตาราง */}
      <section className="set-card fin-card">
      <div className="fin-bar">
        <div className="seg" role="tablist" aria-label="มุมมอง">
          <button type="button" role="tab" aria-selected={view === 'events'} className={view === 'events' ? 'on' : ''} onClick={() => setView('events')}>รายการเงิน</button>
          <button type="button" role="tab" aria-selected={view === 'daily'} className={view === 'daily' ? 'on' : ''} onClick={() => setView('daily')}>ยอดประจำวัน</button>
        </div>
        <div className="fin-range">
          <div className="seg is-flat" role="group" aria-label="ช่วงเวลา">
            {PRESETS.map((p) => (
              <button key={p.key} type="button" className={preset === p.key ? 'on' : ''} onClick={() => pickPreset(p)}>{p.label}</button>
            ))}
          </div>
          <label className="fin-date"><span className="sr-only">ตั้งแต่</span>
            <input type="date" value={range.from} max={range.to || today} onChange={(e) => setDate('from', e.target.value)} />
          </label>
          <span className="muted">–</span>
          <label className="fin-date"><span className="sr-only">ถึง</span>
            <input type="date" value={range.to} min={range.from} max={today} onChange={(e) => setDate('to', e.target.value)} />
          </label>
        </div>
      </div>
      {!rangeOk && <p className="error fin-pad">วันเริ่มต้องไม่เกินวันสิ้นสุด</p>}

      {view === 'events' ? (
        <>
          <div className="fin-card-head">
            <div className="seg is-flat" role="group" aria-label="กลุ่มรายการ">
              {GROUPS.map((g) => (
                <button key={g.key || 'all'} type="button" className={grp === g.key ? 'on' : ''} onClick={() => setGrp(g.key)}>{g.label}</button>
              ))}
            </div>
            <input className="fin-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหาเลขใบ / เคส / ชื่อลูกค้า / ผู้ทำ" aria-label="ค้นหารายการเงิน" />
            <button type="button" className="btn" disabled={!events?.rows.length} onClick={exportEvents}>
              <LineIcon name="csv" className="btn-ico csv-ico" />ดาวน์โหลด CSV
            </button>
          </div>

          {events && (
            <dl className="fin-sum">
              <div><dt>เงินเข้า</dt><dd className="is-in">{money(events.summary.cash_in)}</dd></div>
              <div><dt>เงินออก (คืน/ยกเลิก)</dt><dd className="is-out">{money(events.summary.cash_out)}</dd></div>
              <div><dt>สุทธิ</dt><dd>{money(events.summary.net_cash)}</dd></div>
              <div><dt title="ออกใบแจ้งหนี้ ± ใบลดหนี้/เพิ่มหนี้ − ใบที่ยกเลิก">ตั้งหนี้สุทธิ</dt><dd>{money(events.summary.invoiced)}</dd></div>
              <div><dt>ปล่อยค่าจ้าง</dt><dd>{money(events.summary.payroll_released)}</dd></div>
              <div><dt>จ่ายค่าจ้าง</dt><dd>{money(events.summary.payroll_paid)}</dd></div>
            </dl>
          )}

          {!events ? <p className="muted fin-pad">กำลังโหลด…</p> : events.rows.length === 0 ? (
            <p className="muted fin-pad">ไม่มีรายการในช่วงนี้</p>
          ) : (
            <>
              <div className="table-wrap fin-scroll">
                {/* มือถือ: แถวละการ์ด แบบหน้าบันทึกการใช้งาน (fin-events · CSS) — จอคอมเป็นตารางตามเดิม */}
                <table className="fin-table fin-events">
                  <thead>
                    <tr>
                      <th>วันที่</th><th>รายการ</th><th className="num">จำนวนเงิน</th><th>เอกสาร</th>
                      <th>ลูกค้า / พนักงาน</th><th>ช่องทาง</th><th>ผู้ทำรายการ</th><th>หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.rows.slice((page - 1) * PAGE, page * PAGE).map((r, i) => (
                      <tr key={`${r.kind}-${r.doc_id ?? ''}-${r.at ?? ''}-${i}`}>
                        <td className="nw fe-date">
                          {formatDate(r.day)}
                          {r.at && <span className="cell-sub">{String(r.at).slice(11, 16)} น.</span>}
                        </td>
                        <td className="fe-kind"><span className={`fin-kind is-${r.grp} k-${r.kind}`}>{KIND_LABELS[r.kind] ?? r.kind}</span></td>
                        <td className={`num fe-amount ${r.grp === 'cash' ? (r.amount >= 0 ? 'is-in' : 'is-out') : ''}`}>{signed(r.amount)}</td>
                        <td className="nw fe-doc">
                          {r.doc_id && <span className="mono">{r.doc_id}</span>}
                          {r.invoice_id && r.invoice_id !== r.doc_id && <span className="cell-sub mono">{r.invoice_id}</span>}
                          {r.case_id && <span className="cell-sub mono">{caseCode(r.case_id)}</span>}
                        </td>
                        <td className="fin-party fe-meta" data-label="ลูกค้า / พนักงาน">{r.party ?? '—'}</td>
                        <td className={`fe-meta${r.method ? '' : ' is-blank'}`} data-label="ช่องทาง">{r.method ?? '—'}</td>
                        <td className="nw fe-meta" data-label="ผู้ทำรายการ">{r.actor ?? '—'}</td>
                        <td className={`fin-note fe-note${r.note ? '' : ' is-blank'}`}>{r.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={page} total={events.rows.length} onPage={setPage} unit="รายการ"
                note={events.truncated ? `ช่วงนี้มี ${events.count.toLocaleString('th-TH')} รายการ — แสดง/ส่งออก 5,000 รายการล่าสุด ลองย่อช่วงวันที่` : null} />
            </>
          )}
        </>
      ) : (
        <>
          <div className="fin-card-head">
            <p className="muted fin-hint">
              ยอดคงค้าง (ลูกหนี้ · เกินกำหนด · ใบร่าง · ค่าจ้างค้างจ่าย) เป็นตัวเลข ณ เวลาที่จดของวันนั้น — วันที่ผ่านไปแล้วแก้ไขไม่ได้
            </p>
            <button type="button" className="btn" disabled={!snaps?.length} onClick={exportSnapshots}>
              <LineIcon name="csv" className="btn-ico csv-ico" />ดาวน์โหลด CSV
            </button>
          </div>
          {!snaps ? <p className="muted fin-pad">กำลังโหลด…</p> : snaps.length === 0 ? (
            <p className="muted fin-pad">ยังไม่มียอดที่จดไว้ในช่วงนี้ — ระบบเริ่มจดตั้งแต่วันที่เปิดใช้บันทึกการเงิน (ทุกเช้า และทุกครั้งที่เปิดหน้านี้)</p>
          ) : (
            <div className="table-wrap fin-scroll">
              <table className="fin-table">
                <thead>
                  <tr>
                    <th>วันที่</th><th className="num">เงินเข้า</th><th className="num">เงินคืน</th><th className="num">สุทธิ</th>
                    <th className="num">ลูกหนี้ค้างชำระ</th><th className="num">เกินกำหนด</th><th className="num">ใบร่าง</th>
                    <th className="num">ค่าจ้างค้างจ่าย</th><th className="num">จ่ายค่าจ้าง</th><th>จดเมื่อ</th>
                  </tr>
                </thead>
                <tbody>
                  {snaps.slice((snapPage - 1) * PAGE, snapPage * PAGE).map((s) => (
                    <tr key={s.snap_date}>
                      <td className="nw">{formatDate(s.snap_date)}{s.snap_date === today && <span className="cell-sub">วันนี้ (ยังอัปเดตได้)</span>}</td>
                      <td className="num is-in">{money(s.cash_in)}</td>
                      <td className="num">{s.refunds_out ? money(-s.refunds_out) : '—'}</td>
                      <td className="num strong">{money(s.net_cash)}</td>
                      <td className="num">{money(s.ar_outstanding)}<span className="cell-sub">{s.ar_count} ใบ</span></td>
                      <td className={`num ${s.ar_overdue > 0 ? 'is-out' : ''}`}>{money(s.ar_overdue)}<span className="cell-sub">{s.ar_overdue_count} ใบ</span></td>
                      <td className="num">{money(s.draft_total)}<span className="cell-sub">{s.draft_count} ใบ</span></td>
                      <td className="num">{money(s.payroll_owed)}{s.unreleased_cases > 0 && <span className="cell-sub">+{s.unreleased_cases} เคสรอปล่อย</span>}</td>
                      <td className="num">{s.payroll_paid ? money(s.payroll_paid) : '—'}</td>
                      <td className="nw muted">{s.captured_at?.slice(11)} น.</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {snaps?.length > 0 && <Pager page={snapPage} total={snaps.length} onPage={setSnapPage} unit="วัน" />}
        </>
      )}
      </section>
    </div>
  );
}

/** ก่อนหน้า · หน้า x / y · ถัดไป — ไม่ถึงหน้าที่สองไม่ต้องมีปุ่ม (เหลือแค่จำนวนทั้งหมด) */
function Pager({ page, total, onPage, unit, note = null }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const first = (page - 1) * PAGE + 1;
  const last = Math.min(page * PAGE, total);
  return (
    <div className="fin-pager">
      <span className="muted">
        {total > PAGE ? `${first.toLocaleString('th-TH')}–${last.toLocaleString('th-TH')} จาก ` : 'ทั้งหมด '}
        {total.toLocaleString('th-TH')} {unit}
        {note && <span className="cell-sub">{note}</span>}
      </span>
      {pages > 1 && (
        <div className="fin-pager-nav">
          <button type="button" className="btn tiny" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ ก่อนหน้า</button>
          <span className="muted">หน้า {page} / {pages}</span>
          <button type="button" className="btn tiny" disabled={page >= pages} onClick={() => onPage(page + 1)}>ถัดไป ›</button>
        </div>
      )}
    </div>
  );
}
