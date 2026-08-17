import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { VISIT_STATE_LABELS, formatBaht, formatDate, timeText, durationText, distanceText } from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import TimeSelect from '../components/TimeSelect.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';

const TABS = {
  exceptions: 'รายการต้องตรวจ',
  approvals: 'รออนุมัติค่าจ้าง',
  log: 'ประวัติเช็คอิน',
  payroll: 'สรุปค่าตอบแทน',
};

const LOG_PER_PAGE = 30;

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** เลื่อนเดือนไปข้างหน้า/ข้างหลัง — ใช้ UTC เพราะค่าที่เก็บเป็น 'YYYY-MM' ล้วน ไม่มีโซนเวลาเข้ามาเกี่ยว */
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** จำนวนวันที่ผ่านมาแล้วนับจากวันที่กะ — ใช้บอกว่ากะค้างเช็คเอาท์มานานแค่ไหน */
function daysAgo(dateStr) {
  const then = new Date(`${dateStr}T00:00:00`);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  return days > 0 ? days : 0;
}

/**
 * escape ค่าเป็นเซลล์ CSV
 *
 * นำหน้าด้วย ' เมื่อค่าขึ้นต้นด้วย = + - @ (รวม tab/CR ที่ Excel มองข้ามก่อนอ่านตัวแรก):
 * Excel/Sheets ถือว่าเซลล์แบบนั้นเป็น "สูตร" แล้วรันทันทีที่เปิดไฟล์ ชื่อผู้รับบริการอย่าง
 * "=cmd|..." จึงกลายเป็นคำสั่งบนเครื่องคนที่เปิดไฟล์ ไม่ใช่ข้อความ — เครื่องหมาย ' ทำให้
 * Excel อ่านเป็นข้อความล้วนและไม่แสดงตัว ' นั้นในเซลล์
 *
 * \r ต้องอยู่ในเงื่อนไขครอบด้วย ไม่ใช่แค่ \n — ค่าที่มี CR เดี่ยวๆ (ข้อมูลที่ก๊อปมาจาก
 * โปรแกรมเก่า/Mac รุ่นก่อน) จะทำให้แถวขาดกลางคันเพราะตัวคั่นบรรทัดของไฟล์เป็น \r\n
 */
const csvCell = (v) => {
  const raw = String(v ?? '');
  // ตัวเลขล้วน (รวมติดลบ/ทศนิยม) ต้องไม่โดนเติม ' ไม่งั้นกลายเป็นข้อความแล้วเอาไปรวมยอดใน Excel ไม่ได้
  const risky = /^[\t\r ]*[=+\-@]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw);
  const s = risky ? `'${raw}` : raw;
  return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** ดาวน์โหลดตารางเป็น CSV — BOM นำหน้าให้ Excel อ่านภาษาไทยไม่เพี้ยน */
function downloadCsv(filename, header, lines) {
  const csv = [header, ...lines].map((a) => a.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** เลือกเดือนพร้อมปุ่มถอย/เดินหน้าทีละเดือน — เดือนที่อยากดูมักอยู่ติดกับเดือนปัจจุบัน */
function MonthPicker({ month, onChange, children }) {
  return (
    <div className="att-filter">
      <span className="month-step">
        <button className="btn icon-btn" onClick={() => onChange(shiftMonth(month, -1))} title="เดือนก่อนหน้า" aria-label="เดือนก่อนหน้า"><LineIcon name="chevron-left" /></button>
        <input type="month" value={month} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="เดือน" />
        <button
          className="btn icon-btn"
          onClick={() => onChange(shiftMonth(month, 1))}
          disabled={month >= thisMonth()}
          title="เดือนถัดไป"
          aria-label="เดือนถัดไป"
        ><LineIcon name="chevron-right" /></button>
      </span>
      {children}
    </div>
  );
}

/** หน้าติดตามการมาทำงานของพนักงานภาคสนาม (admin) */
export default function AttendancePage() {
  const [params, setParams] = useSearchParams();

  // รายการต้องตรวจโหลดที่นี่ ไม่ใช่ในแท็บ — ตัวเลขบนแท็บต้องเห็นได้โดยไม่ต้องกดเข้าไปก่อน
  const [exceptions, setExceptions] = useState(null);
  const [exError, setExError] = useState(null);
  const [staff, setStaff] = useState([]);
  /* ตัวนับสั่งโหลดใหม่ระดับหน้า — ส่งลงไปเป็น dep ของแท็บ "ประวัติ" กับ "สรุปค่าตอบแทน"
     เพราะสองแท็บนั้นโหลดข้อมูลเอง หน้าแม่สั่งตรงไม่ได้ */
  const [reloadKey, setReloadKey] = useState(0);

  const get = (key) => params.get(key) ?? '';
  const tab = TABS[get('tab')] ? get('tab') : 'exceptions';
  const employeeId = get('employee_id');
  // สรุปค่าตอบแทนปริยายเป็นเดือนที่แล้ว — เดือนปัจจุบันยังปิดเคสไม่ครบ ตัวเลขยังไม่ใช่ของจริง
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(get('month'))
    ? get('month')
    : (tab === 'payroll' ? shiftMonth(thisMonth(), -1) : thisMonth());

  /** เขียนค่าลงย URL — replace เพื่อไม่ให้การสลับแท็บ/เดือนถมประวัติเบราว์เซอร์ */
  const patch = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === '' || value == null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const loadExceptions = useCallback(() => {
    return api
      .attendanceExceptions()
      .then((r) => {
        setExceptions(r);
        setExError(null); // สำเร็จแล้วต้องล้าง error ของรอบก่อน ไม่งั้นเน็ตสะดุดครั้งเดียวหน้าค้างเป็น error ตลอด
      })
      .catch((e) => setExError(e.message));
  }, []);

  useEffect(() => {
    loadExceptions();
    api.assignableEmployees().then(setStaff).catch(() => {});
  }, [loadExceptions]);

  /* ดึงใหม่ทั้งหน้า — เด้งตัวนับให้แท็บที่เปิดอยู่โหลดเอง และโหลดรายการต้องตรวจ (ตัวเลขบนแท็บ) ไปพร้อมกัน
     คืน promise ของรายการต้องตรวจออกไป ให้ตัวดึงหน้าลงรู้ว่าคาวงกลมหมุนไว้ถึงเมื่อไร */
  const refreshAll = useCallback(() => {
    setReloadKey((k) => k + 1);
    return loadExceptions();
  }, [loadExceptions]);

  // กรองพนักงานฝั่งหน้าเว็บ — endpoint รายการต้องตรวจไม่รับพารามิเตอร์ (ตั้งใจให้เห็นทุกคนเสมอ)
  const shownExceptions = exceptions?.filter((v) => !employeeId || v.employee_id === employeeId) ?? null;
  const pending = exceptions?.length ?? 0;

  const employeePicker = (
    <select value={employeeId} onChange={(e) => patch({ employee_id: e.target.value, page: '' })} aria-label="พนักงาน">
      <option value="">พนักงานทุกคน</option>
      {staff.map((e) => (
        <option key={e.employee_id} value={e.employee_id}>{e.first_name} {e.last_name}</option>
      ))}
    </select>
  );

  return (
    <PageRefresh onRefresh={refreshAll}>
      <header className="page-head">
        <div>
          <h1>การมาทำงาน</h1>
          <p className="muted">ติดตามการเช็คอินของพนักงานภาคสนาม</p>
        </div>
      </header>

      <div className="att-tabs" role="tablist" aria-label="มุมมองการมาทำงาน">
        {Object.entries(TABS).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`att-tab ${tab === key ? 'is-active' : ''}`}
            onClick={() => patch({ tab: key === 'exceptions' ? '' : key, page: '' })}
          >
            {label}
            {/* ตัวเลขงานค้างต้องเห็นจากแท็บอื่นด้วย ไม่งั้นต้องคอยกดเข้าไปเช็คเอง */}
            {key === 'exceptions' && pending > 0 && <span className="tab-count">{pending}</span>}
          </button>
        ))}
      </div>

      {tab === 'exceptions' && (
        <Exceptions
          rows={shownExceptions}
          error={exError}
          onReload={loadExceptions}
          filters={employeePicker}
        />
      )}
      {tab === 'log' && (
        <Log
          month={month}
          employeeId={employeeId}
          state={get('state')}
          q={get('q')}
          page={Math.max(1, Number(get('page')) || 1)}
          patch={patch}
          employeePicker={employeePicker}
          reloadKey={reloadKey}
        />
      )}
      {tab === 'approvals' && (
        <Approvals
          month={month}
          employeeId={employeeId}
          patch={patch}
          employeePicker={employeePicker}
          reloadKey={reloadKey}
        />
      )}
      {tab === 'payroll' && (
        <Payroll
          month={month}
          employeeId={employeeId}
          patch={patch}
          employeePicker={employeePicker}
          reloadKey={reloadKey}
        />
      )}
    </PageRefresh>
  );
}

/**
 * คิวอนุมัติค่าจ้าง — กะที่ทำงานจบแล้วแต่เงินยังไม่เข้าพนักงานจนกว่าจะกดอนุมัติที่นี่
 *
 * ต้องเลือกทีละหลายกะได้ เพราะเดือนหนึ่งมีหลักร้อยกะ ถ้าให้กดทีละใบจะไม่มีใครทำ
 * แต่ต้องเห็น "ธงที่ต้องดู" ของแต่ละกะก่อนกดด้วย (นอกพื้นที่/สาย/ทำงาน 0 นาที)
 * ไม่งั้นปุ่มอนุมัติทั้งหมดจะกลายเป็นตรายางที่ไม่มีใครอ่านอะไรเลย
 */
function Approvals({ month, employeeId, patch, employeePicker, reloadKey }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .pendingApprovals({ month, employee_id: employeeId || undefined })
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setPicked(new Set());  // เปลี่ยนตัวกรองแล้วสิ่งที่ติ๊กไว้ไม่เกี่ยวข้องอีกต่อไป
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [month, employeeId, reloadKey]);

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allPicked = rows?.length > 0 && picked.size === rows.length;
  const pickedRows = rows?.filter((v) => picked.has(v.visit_id)) ?? [];
  const pickedTotal = pickedRows.reduce((s, v) => s + (v.pay ?? 0), 0);

  async function decide(approve) {
    const ids = [...picked];
    if (ids.length === 0) return;

    let reason = null;
    if (!approve) {
      // ไม่อนุมัติต้องมีเหตุผลเสมอ — เป็นสิ่งเดียวที่พนักงานจะได้รู้ว่าทำไมกะนั้นไม่ได้เงิน
      reason = prompt(`ไม่อนุมัติ ${ids.length} กะ — เหตุผล (พนักงานจะเห็นข้อความนี้)`);
      if (!reason?.trim()) return;
    } else if (!confirm(`อนุมัติค่าจ้าง ${ids.length} กะ รวม ${formatBaht(pickedTotal)}?`)) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { changed } = await api.decidePay(ids, approve, reason?.trim() ?? null);
      toast(`${approve ? 'อนุมัติ' : 'ไม่อนุมัติ'} ${changed} กะแล้ว`);
      setRows((prev) => prev.filter((v) => !picked.has(v.visit_id)));
      setPicked(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** ธงที่ทำให้กะนี้ควรถูกดูก่อนอนุมัติ — ไม่มีเลย = กะปกติ */
  const flags = (v) =>
    [
      v.location_flagged && 'นอกพื้นที่',
      v.off_schedule && 'นอกวันนัด',
      v.check_in_late_minutes > LATE_MINUTES && `สาย ${durationText(v.check_in_late_minutes)}`,
      v.worked_minutes === 0 && 'ทำงาน 0 นาที',
      v.pay == null && 'ยังไม่ระบุค่าจ้าง',
    ].filter(Boolean);

  const total = rows?.reduce((s, v) => s + (v.pay ?? 0), 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>{employeePicker}</MonthPicker>

      <p className="muted form-hint">
        กะที่เช็คเอาท์แล้วจะยัง<strong>ไม่เข้าสรุปค่าตอบแทน</strong>ของพนักงาน จนกว่าจะอนุมัติที่นี่ ·
        ยอดที่เห็นคือค่าจ้างของกะนั้น (เกลี่ยจากค่าจ้างเคสถ้าไม่ได้ตั้งรายกะ) ·
        <strong>แตะที่แถวเพื่อเลือก</strong>
      </p>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : rows?.length === 0 ? (
        <section className="card empty-state">
          <p><LineIcon name="check" className="text-ico" />ไม่มีกะรออนุมัติ</p>
          <p className="muted">ค่าจ้างของเดือนนี้ยืนยันครบแล้ว</p>
        </section>
      ) : rows?.length > 0 ? (
        <>
          {/* ปุ่มเลือกทั้งหมดต้องอยู่นอกหัวตาราง — จอแคบหัวตารางถูกซ่อน (แถวกลายเป็นการ์ด)
              ถ้าฝากไว้ในหัวตารางอย่างเดียว บนมือถือจะไม่มีทางเลือกทั้งหมดได้เลย */}
          {/* att-presets — ระยะห่างของแถวนี้เมื่อยืนเดี่ยวๆ ในหน้า ไม่ใช่ตอนอยู่ติดใต้ปฏิทินในโมดัลลงกะ
              ที่นั่นมันเกาะกับปฏิทินโดยตั้งใจ ที่นี่มันถูกขนาบด้วยข้อความอธิบายกับการ์ดกะจนดูอัดกัน */}
          <div className="pick-presets att-presets">
            <button
              className="btn tiny"
              disabled={busy}
              onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((v) => v.visit_id)))}
            >
              {allPicked ? 'ล้างที่เลือก' : `เลือกทั้งหมด (${rows.length})`}
            </button>
            {picked.size > 0 && !allPicked && <span className="muted">เลือกไว้ {picked.size} กะ</span>}
          </div>

          <div className="table-wrap">
            <table className="table table-cards table-2line">
              <thead>
                <tr>
                  <th className="col-check" aria-label="เลือก" />
                  <th>วันที่</th>
                  <th>พนักงาน / เคส</th>
                  <th>เข้า–ออก</th>
                  <th>รวม</th>
                  <th>ค่าจ้าง</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  /* ทั้งแถวคือปุ่มเลือก — เล็งช่องติ๊กเล็กๆ บนมือถือยากและพลาดง่าย
                     ช่องติ๊กเหลือไว้เป็นตัวบอกสถานะอย่างเดียว (pointer-events ปิดใน CSS)
                     จึงไม่เกิดการสลับสองครั้งเมื่อแตะโดนช่องติ๊กพอดี */
                  <tr
                    key={v.visit_id}
                    className={`is-tappable ${picked.has(v.visit_id) ? 'is-picked' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={picked.has(v.visit_id)}
                    aria-label={`กะวันที่ ${v.visit_date} ของ ${v.employee_name}`}
                    onClick={() => toggle(v.visit_id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault(); // เว้นวรรคบนแถวที่โฟกัสอยู่ = เลือก ไม่ใช่เลื่อนหน้า
                      toggle(v.visit_id);
                    }}
                  >
                    <td data-label="เลือก" className="col-check">
                      <input
                        type="checkbox"
                        checked={picked.has(v.visit_id)}
                        readOnly
                        tabIndex={-1}
                        aria-hidden="true"
                      />
                    </td>
                    <td data-label="วันที่">{formatDate(v.visit_date)}</td>
                    <td data-label="พนักงาน / เคส">
                      {v.employee_name}
                      <span className="cell-sub">
                        {v.client_name} ·{' '}
                        {/* ลิงก์ไปเปิดเคส — ต้องไม่ถูกนับเป็นการเลือกแถวไปด้วย */}
                        <Link
                          className="link mono"
                          to={`/cases?open=${v.case_id}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {v.case_id}
                        </Link>
                      </span>
                    </td>
                    <td data-label="เข้า–ออก">
                      {timeText(v.check_in_at)} – {timeText(v.check_out_at)}
                      {flags(v).length > 0 && <span className="cell-sub flag-text">{flags(v).join(' · ')}</span>}
                    </td>
                    <td data-label="รวม">{durationText(v.worked_minutes)}</td>
                    <td data-label="ค่าจ้าง">
                      {v.pay == null ? <span className="muted">—</span> : formatBaht(v.pay)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th />
                  <th data-label="รวม">{rows.length} กะ</th>
                  <th />
                  <th />
                  <th />
                  <th data-label="ค่าจ้างรวม">{formatBaht(total)}</th>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* แถบยืนยันติดขอบล่าง — ติ๊กมา 40 กะแล้วต้องเลื่อนกลับขึ้นไปหาปุ่มคือคนละเรื่องกัน */}
          {picked.size > 0 && (
            <div className="approve-bar">
              <p className="pick-count">
                เลือกไว้ <strong>{picked.size}</strong> กะ · รวม <strong>{formatBaht(pickedTotal)}</strong>
              </p>
              <div className="pick-actions">
                <button className="btn primary" disabled={busy} onClick={() => decide(true)}>
                  อนุมัติ {picked.size} กะ
                </button>
                <button className="btn danger-ghost" disabled={busy} onClick={() => decide(false)}>
                  ไม่อนุมัติ
                </button>
                <button className="btn" disabled={busy} onClick={() => setPicked(new Set())}>ล้าง</button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

function Payroll({ month, employeeId, patch, employeePicker, reloadKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .attendanceReport(month, employeeId || undefined)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [month, employeeId, reloadKey]);

  function exportCsv() {
    downloadCsv(
      // ใส่รหัสพนักงานในชื่อไฟล์ตอนกรองคนเดียว — ไม่งั้นไฟล์ของคนละคนทับกันในโฟลเดอร์ดาวน์โหลด
      `payroll-${month}${employeeId ? `-${employeeId}` : ''}.csv`,
      ['รหัสพนักงาน', 'ชื่อ', 'จำนวนกะ', 'ชั่วโมงรวม', 'เคสที่ทำ', 'ค่าจ้างที่อนุมัติแล้ว (บาท)',
        'กะที่อนุมัติแล้ว', 'รออนุมัติ (บาท)', 'กะที่รออนุมัติ', 'กะที่ไม่อนุมัติ', 'กะที่ยังไม่ระบุค่าจ้าง'],
      rows.map((r) => [
        r.employee_id, r.employee_name, r.shifts, (r.minutes / 60).toFixed(1), r.cases_worked, r.pay,
        r.approved_shifts, r.pending_pay, r.pending_shifts, r.rejected_shifts, r.unpriced_shifts,
      ]),
    );
  }

  const totalShifts = rows?.reduce((s, r) => s + r.shifts, 0) ?? 0;
  const totalMinutes = rows?.reduce((s, r) => s + r.minutes, 0) ?? 0;
  const totalPay = rows?.reduce((s, r) => s + r.pay, 0) ?? 0;
  const totalPending = rows?.reduce((s, r) => s + r.pending_pay, 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>
        {employeePicker}
        {rows?.length > 0 && <button className="btn" onClick={exportCsv}><LineIcon name="download" />ดาวน์โหลด CSV</button>}
      </MonthPicker>

      <p className="muted form-hint">
        ค่าจ้างนับจาก<strong>กะที่เช็คอิน–เอาท์ครบและผ่านการอนุมัติแล้ว</strong> จ่ายให้คนที่ไปทำจริง —
        ยอดต่อกะใช้ค่าจ้างที่ตั้งไว้ที่กะ ถ้าไม่ได้ตั้งก็เกลี่ยจากค่าจ้างของเคสหารจำนวนกะที่นัดไว้ ·
        <strong>ชั่วโมงรวม</strong>คือเวลาจริงจากการเช็คอิน/เอาท์ (นับทุกกะ ไม่ว่าจะอนุมัติแล้วหรือยัง)
      </p>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : !error && rows?.length === 0 ? (
        // บอกให้ชัดว่าว่างเพราะ "ไม่มีใครเช็คอิน" หรือเพราะ "คนที่กรองไว้ไม่ได้เช็คอิน" — ไม่งั้นเข้าใจว่าข้อมูลหาย
        <section className="card empty-state">
          <p>{employeeId ? 'เดือนนี้พนักงานคนนี้ยังไม่มีการเช็คอิน' : 'เดือนนี้ยังไม่มีการเช็คอิน'}</p>
        </section>
      ) : rows?.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>พนักงาน</th><th>จำนวนกะ</th><th>ชั่วโมงรวม</th><th>รออนุมัติ</th><th>ค่าจ้างรวม</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee_id}>
                  <td data-label="พนักงาน">{r.employee_name}<span className="cell-sub mono">{r.employee_id}</span></td>
                  <td data-label="จำนวนกะ">
                    {r.shifts}
                    <span className="cell-sub">{r.cases_worked} เคส</span>
                  </td>
                  <td data-label="ชั่วโมงรวม">{durationText(r.minutes)}</td>
                  {/* เงินที่ค้างอยู่ที่โต๊ะผู้จัดการเอง ไม่ใช่ปัญหาของพนักงาน — กดไปที่คิวอนุมัติได้เลย */}
                  <td data-label="รออนุมัติ">
                    {r.pending_shifts > 0 ? (
                      <Link className="link" to={`/attendance?tab=approvals&month=${month}&employee_id=${r.employee_id}`}>
                        {formatBaht(r.pending_pay)}
                        <span className="cell-sub">{r.pending_shifts} กะ →</span>
                      </Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="ค่าจ้างรวม">
                    {formatBaht(r.pay)}
                    {/* กดไปหาเคสของคนนี้ได้เลย — เดิมรู้ว่ามีปัญหาแต่ไม่รู้ว่าเคสไหน */}
                    {r.unpriced_shifts > 0 && (
                      <span className="cell-sub">
                        <Link className="link flag-text" to={`/cases?assigned_to=${r.employee_id}`}>
                          {r.unpriced_shifts} กะยังไม่ระบุค่าจ้าง →
                        </Link>
                      </span>
                    )}
                    {r.rejected_shifts > 0 && (
                      <span className="cell-sub flag-text">ไม่อนุมัติ {r.rejected_shifts} กะ</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {/* data-label ไม่ได้มีไว้แค่สวย — จอเล็กหัวตารางถูกซ่อน แถวรวมที่เหลือแต่ตัวเลขเปล่าๆ
                จะอ่านไม่ออกว่าเลขไหนคืออะไร */}
            <tfoot>
              <tr>
                <th data-label="พนักงาน">รวม {rows.length} คน</th>
                <th data-label="จำนวนกะ">{totalShifts}</th>
                <th data-label="ชั่วโมงรวม">{durationText(totalMinutes)}</th>
                <th data-label="รออนุมัติ">{totalPending > 0 ? formatBaht(totalPending) : '—'}</th>
                <th data-label="ค่าจ้างรวม">{formatBaht(totalPay)}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </>
  );
}

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;

/** รูปแผนที่เล็ก (Static Maps) — หมุดแดง = จุดเช็คอิน, หมุดเขียว = ที่ตั้งเคส */
function staticMapUrl(v) {
  const markers = [`markers=color:red%7C${v.check_in_lat},${v.check_in_lng}`];
  if (v.case_geo_lat != null) markers.push(`markers=color:green%7C${v.case_geo_lat},${v.case_geo_lng}`);
  return `https://maps.googleapis.com/maps/api/staticmap?size=130x90&scale=2&${markers.join('&')}&key=${MAPS_KEY}`;
}

/**
 * หลักฐานตำแหน่ง: แผนที่ + รูปเซลฟี่ + ระยะห่างจากจุดเคส
 *
 * วางเป็นสองชั้น — รูปหลักฐานเรียงข้างกันชั้นบน ระยะห่างเป็นบรรทัดล่าง
 * เดิมยัดสามอย่างไว้แถวเดียวในคอลัมน์ที่แคบที่สุดของตาราง พอไม่พอที่ลิงก์ "รูป"
 * จะตกไปบรรทัดใหม่แล้วโดนความสูงแถวตัดจนอ่านไม่ออก — ซึ่งคือหลักฐานชิ้นที่หนักที่สุด
 * (เซลฟี่หน้างาน) กลายเป็นชิ้นที่เห็นยากที่สุด
 */
function Evidence({ v }) {
  const hasLoc = v.check_in_lat != null;
  const fullMap = hasLoc ? `https://www.google.com/maps?q=${v.check_in_lat},${v.check_in_lng}` : null;

  return (
    <span className="att-evidence">
      <span className="att-evidence-media">
        {hasLoc && MAPS_KEY && (
          <a href={fullMap} target="_blank" rel="noreferrer" title="เปิดแผนที่เต็ม">
            <img className="att-thumb" src={staticMapUrl(v)} alt="ตำแหน่งเช็คอิน" loading="lazy" />
          </a>
        )}
        {/* เซลฟี่แสดงเป็นรูปย่อเหมือนแผนที่ ไม่ใช่ลิงก์ตัวหนังสือ — ตรวจว่า "ใช่คนนี้จริงไหม"
            ต้องเห็นรูปถึงจะตอบได้ ลิงก์ที่ต้องกดเปิดแท็บใหม่ทีละแถวไม่มีใครไล่ดูจริง */}
        {v.has_photo && (
          <a
            href={api.visitCheckinPhotoUrl(v.case_id, v.visit_id)}
            target="_blank"
            rel="noreferrer"
            title="เปิดรูปเต็ม"
          >
            <img
              className="att-thumb"
              src={api.visitCheckinPhotoUrl(v.case_id, v.visit_id)}
              alt="เซลฟี่ตอนเช็คอิน"
              loading="lazy"
            />
          </a>
        )}
        {/* ไม่ได้ตั้ง key แผนที่ไว้ — ยังต้องมีทางเปิดดูตำแหน่ง แค่ไม่มีรูปย่อให้ */}
        {hasLoc && !MAPS_KEY && <a href={fullMap} target="_blank" rel="noreferrer">เปิดแผนที่</a>}
      </span>

      {v.check_in_distance_m != null && (
        <span className={`att-distance ${v.location_flagged ? 'flag-text' : 'muted'}`}>
          ห่าง {distanceText(v.check_in_distance_m)}
        </span>
      )}
    </span>
  );
}

/** ชื่อพนักงาน + ผู้รับบริการ + ลิงก์ไปเคส — ใช้ร่วมกันทั้งสองตาราง */
function WhoCell({ v }) {
  return (
    <>
      {v.employee_name ?? '—'}
      <span className="cell-sub">
        {v.client_name} ·{' '}
        <Link className="link mono" to={`/cases?open=${v.case_id}`}>{v.case_id}</Link>
      </span>
    </>
  );
}

/* เกณฑ์เดียวกับฝั่ง server (LATE_THRESHOLD_MINUTES) — ต่ำกว่านี้ถือเป็นเรื่องปกติของการเดินทาง
   ไม่ได้ดึงมาจาก API เพราะเป็นแค่การเลือก "คำ" ที่จะแสดงในคอลัมน์ปัญหา
   ตัวตัดสินว่าแถวไหนขึ้นหน้านี้เป็นของ server ล้วนๆ */
const LATE_MINUTES = 30;

/** ปัญหาที่ทำให้กะนี้ต้องถูกตรวจ — เรียงตามความรีบ อันที่ต้องรีบสุดขึ้นก่อน */
function reason(v) {
  if (v.state === 'missed') return 'ขาดงาน';
  if (v.state === 'stale') return 'ค้างเช็คเอาท์';
  if (v.location_flagged) return 'นอกพื้นที่';
  if (v.off_schedule) return 'เช็คอินนอกวันนัด';
  if (v.check_in_late_minutes > LATE_MINUTES) return `มาสาย ${durationText(v.check_in_late_minutes)}`;
  return VISIT_STATE_LABELS[v.state];
}

/** สีป้ายในคอลัมน์ปัญหา — กะที่ "เสร็จแล้ว" แต่มาสาย ต้องไม่ใช้สีเทาของกะที่จบปกติ
    ไม่งั้นแถวที่มีปัญหาจะกลืนไปกับพื้นหลังของหน้าที่ตั้งใจให้ไล่ดูปัญหา */
function reasonTone(v) {
  if (v.state === 'missed' || v.state === 'stale') return `visit-${v.state}`;
  if (v.location_flagged || v.off_schedule || v.check_in_late_minutes > LATE_MINUTES) return 'visit-missed';
  return `visit-${v.state}`;
}

/**
 * มาสายกี่นาที / เช็คอินคนละวันกับที่นัด — สองอย่างนี้ต้องเห็นคู่กับเวลาเข้าเสมอ
 * ตัวเลขสายมีเฉพาะกะที่ระบุเวลานัดไว้และเช็คอินในวันนัดจริง (ดู my/routes.js)
 */
function LateTag({ v }) {
  if (v.off_schedule) return <span className="cell-sub flag-text">เช็คอินนอกวันนัด</span>;
  if (!v.check_in_late_minutes) return null;
  return <span className="cell-sub flag-text">สาย {durationText(v.check_in_late_minutes)}</span>;
}

/** เวลาที่เลือกครบและใช้ได้จริงหรือยัง — 24 ชม. เท่านั้น (00:00–23:59) */
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

/** 'HH:MM' ของเวลาที่บันทึกไว้ — รูปแบบเดียวกับที่ TimeSelect และ planned_start ใช้ */
const clockValue = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 'YYYY-MM-DD' + 'HH:MM' (+ ข้ามวัน) → ISO เต็มรูปแบบตามที่ adjustVisitSchema ต้องการ */
const stamp = (date, time, nextDay = false) => {
  const d = new Date(`${date}T${time}:00`);
  if (nextDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
};

/**
 * ลงเวลาเข้า–ออกย้อนหลัง — สำหรับกะที่พนักงาน "ไปทำงานจริงแต่ลืมเช็คอิน"
 *
 * เดิมกะแบบนี้มีทางออกเดียวคือยกเลิกทิ้ง ซึ่งแปลว่ากะหลุดจากสรุปค่าตอบแทน = พนักงานทำงานฟรี
 * หรือไม่ก็ปล่อยค้างอยู่ในคิว "รายการต้องตรวจ" ตลอดไป
 *
 * บันทึกแล้วกะจะออกจากคิวนี้ไปเข้าคิว "รออนุมัติค่าจ้าง" ตามทางปกติ — ไม่ได้ข้ามขั้นอนุมัติ
 */
function TimeFix({ visit, busy, onClose, onSave }) {
  const sheetRef = useSheetSwipe(onClose);
  const [start, setStart] = useState(clockValue(visit.check_in_at) || visit.planned_start || '');
  const [end, setEnd] = useState(clockValue(visit.check_out_at) || visit.planned_end || '');

  useScrollLock();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* กะ 24 ชม. มีจริงในแพ็คเกจ (รายวัน/รายเดือน 24 ชม.) เวลาออกจึงเป็นวันถัดไปได้
     ไม่ถามเป็นช่องติ๊ก — เดาให้จากเวลาที่กรอก แล้วบอกไว้ในบรรทัดสรุปว่าจะบันทึกเป็นวันไหน */
  const ready = isTime(start) && isTime(end); // กรอกครบทั้งสองช่องและอยู่ในช่วงที่เป็นเวลาจริง
  const nextDay = ready && end <= start;
  const minutes = ready
    ? (Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) + (nextDay ? 1440 : 0))
      - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3)))
    : null;

  /* ไม่มีพนักงานผูกกับกะนี้ = บันทึกไปก็ไม่รู้ว่าใครทำ และค่าตอบแทนจะไม่เข้าใคร
     (สรุปค่าตอบแทนนับจากคนที่เช็คอิน ซึ่ง server จะเติมจากพนักงานที่ถูกจัดให้กะนี้) */
  const noStaff = !visit.employee_id;
  const canSave = ready && !noStaff && !busy;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>บันทึกเวลาจริง</h2>
            <p className="muted">
              {formatDate(visit.visit_date)} · {visit.employee_name ?? 'ยังไม่มีพนักงาน'} · {visit.client_name}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          {noStaff ? (
            <p className="error timefix-hint">
              กะนี้ยังไม่มีพนักงานรับผิดชอบ — จับคู่พนักงานที่หน้าเคสก่อน ไม่งั้นค่าตอบแทนจะไม่เข้าใคร
            </p>
          ) : (
            <p className="muted timefix-hint">
              ใช้เมื่อพนักงานไปทำงานจริงแต่ลืมกดเช็คอิน · กะจะเข้าคิว
              <strong> รออนุมัติค่าจ้าง</strong> ต่อตามปกติ
            </p>
          )}

          {/* ใช้ตัวเลือกเวลาตัวเดียวกับหน้าลงกะ — dropdown ที่ทำเอง สูงราว 6 บรรทัดแล้วเลื่อนดูที่เหลือ
              (<select> ของเบราว์เซอร์กางยาวเท่าจำนวนรายการ 24 บรรทัดจนทับทั้งกล่อง สั่งความสูงไม่ได้)
              และเป็นตัวเดียวกับที่ผู้จัดการใช้ตอนลงเวลานัด จึงกรอกด้วยท่าเดิมไม่ต้องเรียนรู้ใหม่ */}
          <div className="grid cols-2 timefix-times">
            <label>เวลาเข้า *
              <TimeSelect label="เวลาเข้า" value={start} disabled={noStaff} onChange={setStart} />
            </label>
            <label>เวลาออก *
              <TimeSelect label="เวลาออก" value={end} disabled={noStaff} onChange={setEnd} />
            </label>
          </div>

          {/* ยืนยันสิ่งที่จะถูกบันทึกก่อนกด — โดยเฉพาะกรณีข้ามวัน ซึ่งระบบเดาให้เอง */}
          {minutes != null && (
            <p className="notice timefix-sum">
              {formatDate(visit.visit_date)} {start} → {nextDay && 'วันถัดไป '}{end}
              {' · รวม '}{durationText(minutes)}
            </p>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn" disabled={busy} onClick={onClose}>ยกเลิก</button>
          <button
            className="btn primary"
            disabled={!canSave}
            onClick={() =>
              onSave({
                check_in_at: stamp(visit.visit_date, start),
                check_out_at: stamp(visit.visit_date, end, nextDay),
                status: 'done',
              })
            }
          >
            {busy ? 'กำลังบันทึก…' : 'บันทึกเวลา'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Exceptions({ rows, error, onReload, filters }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [fixing, setFixing] = useState(null); // กะที่กำลังลงเวลาย้อนหลัง (null = ปิดฟอร์ม)

  async function adjust(v, body, done) {
    setBusy(true);
    setActionError(null);
    try {
      await api.adjustVisit(v.case_id, v.visit_id, body);
      toast(done);
      await onReload();
      return true;
    } catch (e) {
      setActionError(e.message);
      return false; // ฟอร์มลงเวลาต้องค้างไว้ให้แก้ต่อ ไม่ใช่ปิดทิ้งพร้อมเวลาที่เพิ่งกรอก
    } finally {
      setBusy(false);
    }
  }

  /* ปกติ cron ส่งสรุปให้เองทุกเช้า — ปุ่มนี้ไว้ส่งซ้ำตอนอยากให้ทีมเห็นเดี๋ยวนี้ หรือทดสอบว่าอีเมลออกจริง */
  async function sendDigest() {
    setBusy(true);
    setActionError(null);
    try {
      const r = await api.sendDailyDigest();
      toast(r.sent ? `ส่งสรุปให้ผู้จัดการ ${r.recipients} คนแล้ว` : `ไม่ได้ส่ง — ${r.reason}`);
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="att-filter">
        {filters}
        <button className="btn" disabled={busy} onClick={sendDigest}>
          <LineIcon name="mail" />ส่งสรุปทางอีเมลตอนนี้
        </button>
      </div>

      {/* error เป็นแถบเหนือตาราง ไม่ทับทั้งหน้า — แท็บกับตัวกรองต้องไม่หายเพราะเน็ตสะดุด */}
      {error && <p className="error">{error}</p>}
      {actionError && <p className="error">{actionError}</p>}

      {!rows ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : rows.length === 0 ? (
        <section className="card empty-state">
          <p><LineIcon name="check" className="text-ico" />ไม่มีรายการต้องตรวจ</p>
          <p className="muted">ทุกกะเช็คอิน/เช็คเอาท์เรียบร้อย</p>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="table table-cards table-2line">
            <thead>
              <tr><th>วันที่</th><th>พนักงาน / เคส</th><th>ปัญหา</th><th>หลักฐาน</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.visit_id}>
                  <td data-label="วันที่">
                    {formatDate(v.visit_date)}
                    {/* ค้างมานานแค่ไหนคือสิ่งที่บอกว่าควรจัดการอันไหนก่อน */}
                    {v.state === 'stale' && daysAgo(v.visit_date) > 0 && (
                      <span className="cell-sub flag-text">ค้างมา {daysAgo(v.visit_date)} วัน</span>
                    )}
                    <LateTag v={v} />
                  </td>
                  <td data-label="พนักงาน / เคส"><WhoCell v={v} /></td>
                  <td data-label="ปัญหา"><span className={`badge ${reasonTone(v)}`}>{reason(v)}</span></td>
                  <td data-label="หลักฐาน"><Evidence v={v} /></td>
                  <td className="row-actions">
                    {/* ลงเวลาจริงย้อนหลัง — ทางออกของกะที่ "ไปทำงานจริงแต่ลืมเช็คอิน"
                        ทั้งกะที่ขาดงาน (ไม่มีเวลาเลย) และกะที่ค้างเช็คเอาท์ (มีแต่เวลาเข้า)
                        ต่างจากปุ่ม "ปิดกะ" ที่ยัดเวลาปัจจุบันให้ ซึ่งใช้ได้เฉพาะตอนที่เพิ่งเลิกงานจริงๆ */}
                    {(v.state === 'missed' || v.state === 'stale') && (
                      <button className="btn tiny" disabled={busy} onClick={() => setFixing(v)}>
                        บันทึกเวลาจริง
                      </button>
                    )}
                    {v.state === 'stale' && (
                      <ConfirmButton
                        className="btn tiny"
                        disabled={busy}
                        danger={false}
                        title="ปิดกะนี้ด้วยเวลาปัจจุบัน?"
                        detail={`${v.employee_name} · ${formatDate(v.visit_date)} — ถ้าเลิกงานไปนานแล้ว ให้ใช้ "บันทึกเวลาจริง" แทน`}
                        confirmLabel="ปิดกะ"
                        cancelLabel="ไม่ปิด"
                        onConfirm={() => adjust(v, { check_out_at: new Date().toISOString(), status: 'done' }, 'ปิดกะแล้ว')}
                      >
                        ปิดกะ
                      </ConfirmButton>
                    )}
                    {v.location_flagged && (
                      <button className="btn tiny" disabled={busy}
                        onClick={() => adjust(v, { location_flagged: false }, 'เคลียร์ธงแล้ว')}>
                        เคลียร์ธง
                      </button>
                    )}
                    {/* ยกเลิกกะ = กะนี้ไม่ได้เกิดขึ้นจริง (ลูกค้าเลื่อน/ยกเลิก) อยู่ท้ายสุดเสมอ
                        เป็นทางเลือกสุดท้ายหลังจากดูแล้วว่าไม่ใช่กรณีลืมเช็คอิน */}
                    {v.state === 'missed' && (
                      <ConfirmButton
                        className="btn tiny danger-ghost"
                        disabled={busy}
                        title="ทำเครื่องหมายว่ากะนี้ยกเลิก?"
                        detail={`${v.employee_name ?? 'ยังไม่มีพนักงาน'} · ${formatDate(v.visit_date)} — กะที่ยกเลิกจะไม่เข้าสรุปค่าตอบแทน`}
                        confirmLabel="ยกเลิกกะ"
                        cancelLabel="ไม่ยกเลิก"
                        onConfirm={() => adjust(v, { status: 'cancelled' }, 'ยกเลิกกะแล้ว')}
                      >
                        ยกเลิกกะ
                      </ConfirmButton>
                    )}
                    {/* เช็คอินนอกวันนัด: ปกติแก้ด้วยการเลื่อนวันกะให้ตรงกับวันที่ไปจริง
                        ทำที่หน้าเคส จึงลิงก์ไปแทนที่จะมีปุ่มลัดที่นี่ */}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fixing && (
        <TimeFix
          visit={fixing}
          busy={busy}
          onClose={() => setFixing(null)}
          onSave={async (body) => {
            if (await adjust(fixing, body, 'บันทึกเวลาแล้ว — กะนี้เข้าคิวรออนุมัติค่าจ้าง')) setFixing(null);
          }}
        />
      )}
    </>
  );
}

function Log({ month, employeeId, state, q, page, patch, employeePicker, reloadKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .attendance({ month, employee_id: employeeId })
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [month, employeeId, reloadKey]);

  /* กรองสถานะกับคำค้นฝั่งหน้าเว็บ — endpoint คืนทั้งเดือนมาแล้ว (เดือนหนึ่งไม่กี่ร้อยแถว)
     ยิงซ้ำเพื่อกรองจึงช้ากว่าและไม่ได้อะไรเพิ่ม */
  const term = q.trim().toLowerCase();
  const filteredRows = (rows ?? []).filter((v) => {
    if (state && v.state !== state) return false;
    if (!term) return true;
    return [v.employee_name, v.client_name, v.case_id].some((s) => String(s ?? '').toLowerCase().includes(term));
  });

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / LOG_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const shown = filteredRows.slice((safePage - 1) * LOG_PER_PAGE, safePage * LOG_PER_PAGE);
  const filtered = Boolean(state || term || employeeId);

  function exportCsv() {
    downloadCsv(
      `attendance-${month}.csv`,
      ['วันที่', 'พนักงาน', 'ผู้รับบริการ', 'รหัสเคส', 'เข้า', 'ออก', 'ชั่วโมง', 'สถานะ',
        'ห่างจากจุดเคส (ม.)', 'สาย (นาที)', 'นอกวันนัด'],
      // ส่งออก "ทุกแถวที่กรองอยู่" ไม่ใช่แค่หน้าปัจจุบัน — คนกด export ต้องการทั้งชุดไปตรวจ
      filteredRows.map((v) => [
        v.visit_date, v.employee_name, v.client_name, v.case_id,
        v.check_in_at ? timeText(v.check_in_at) : '',
        v.check_out_at ? timeText(v.check_out_at) : '',
        v.worked_minutes != null ? (v.worked_minutes / 60).toFixed(1) : '',
        VISIT_STATE_LABELS[v.state] ?? v.state,
        v.check_in_distance_m ?? '',
        v.check_in_late_minutes ?? '',
        v.off_schedule ? 'ใช่' : '',
      ]),
    );
  }

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m, page: '' })}>
        {employeePicker}
        <select value={state} onChange={(e) => patch({ state: e.target.value, page: '' })} aria-label="สถานะกะ">
          <option value="">ทุกสถานะ</option>
          {Object.entries(VISIT_STATE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input
          className="search"
          placeholder="ค้นหา ชื่อพนักงาน / ผู้รับบริการ / รหัสเคส"
          value={q}
          onChange={(e) => patch({ q: e.target.value, page: '' })}
        />
        {filtered && (
          <button className="btn" onClick={() => patch({ state: '', q: '', employee_id: '', page: '' })}>
            ล้างตัวกรอง
          </button>
        )}
        {filteredRows.length > 0 && <button className="btn" onClick={exportCsv}><LineIcon name="download" />ดาวน์โหลด CSV</button>}
      </MonthPicker>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : !error && filteredRows.length === 0 ? (
        <section className="card empty-state">
          <p>{filtered ? 'ไม่พบกะที่ตรงกับเงื่อนไข' : 'ยังไม่มีการเช็คอินในเดือนนี้'}</p>
          {filtered && (
            <button className="btn" onClick={() => patch({ state: '', q: '', employee_id: '', page: '' })}>
              ล้างตัวกรอง
            </button>
          )}
        </section>
      ) : filteredRows.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="table table-cards table-2line">
              <thead>
                <tr><th>วันที่</th><th>พนักงาน / เคส</th><th>เข้า–ออก</th><th>รวม</th><th>สถานะ</th><th>หลักฐาน</th></tr>
              </thead>
              <tbody>
                {shown.map((v) => (
                  <tr key={v.visit_id}>
                    <td data-label="วันที่">{formatDate(v.visit_date)}</td>
                    <td data-label="พนักงาน / เคส"><WhoCell v={v} /></td>
                    <td data-label="เข้า–ออก">
                      {timeText(v.check_in_at)} – {v.check_out_at ? timeText(v.check_out_at) : '…'}
                      <LateTag v={v} />
                    </td>
                    <td data-label="รวม">{durationText(v.worked_minutes)}</td>
                    <td data-label="สถานะ"><span className={`badge visit-${v.state}`}>{VISIT_STATE_LABELS[v.state]}</span></td>
                    <td data-label="หลักฐาน"><Evidence v={v} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pager">
            {totalPages > 1 && (
              <>
                <button className="btn" disabled={safePage <= 1} onClick={() => patch({ page: String(safePage - 1) })}>
                  ก่อนหน้า
                </button>
                <span className="muted">หน้า {safePage} / {totalPages}</span>
                <button className="btn" disabled={safePage >= totalPages} onClick={() => patch({ page: String(safePage + 1) })}>
                  ถัดไป
                </button>
              </>
            )}
            <span className="muted per-page">ทั้งหมด {filteredRows.length} กะ</span>
          </div>
        </>
      ) : null}
    </>
  );
}
