import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { VISIT_STATE_LABELS, formatBaht, formatDate, timeText, durationText } from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';

const TABS = {
  exceptions: 'รายการต้องตรวจ',
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

/** escape ค่าเป็นเซลล์ CSV */
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
    <>
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
        />
      )}
      {tab === 'payroll' && <Payroll month={month} patch={patch} />}
    </>
  );
}

function Payroll({ month, patch }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .attendanceReport(month)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [month]);

  function exportCsv() {
    downloadCsv(
      `payroll-${month}.csv`,
      ['รหัสพนักงาน', 'ชื่อ', 'เคสที่ปิด', 'ค่าจ้างรวม (บาท)', 'เคสที่ยังไม่ระบุค่าจ้าง', 'จำนวนกะ', 'ชั่วโมงรวม'],
      rows.map((r) => [
        r.employee_id, r.employee_name, r.closed_cases, r.pay, r.unpriced_cases, r.shifts, (r.minutes / 60).toFixed(1),
      ]),
    );
  }

  const totalCases = rows?.reduce((s, r) => s + r.closed_cases, 0) ?? 0;
  const totalMinutes = rows?.reduce((s, r) => s + r.minutes, 0) ?? 0;
  const totalPay = rows?.reduce((s, r) => s + r.pay, 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>
        {rows?.length > 0 && <button className="btn" onClick={exportCsv}><LineIcon name="download" />ดาวน์โหลด CSV</button>}
      </MonthPicker>

      <p className="muted form-hint">
        ค่าจ้างนับจาก<strong>เคสที่ปิดแล้ว</strong>ในเดือนนั้น (ค่าจ้างที่คัดลอกไว้ในเคสตอนเลือกแพ็คเกจ) —
        ปิดเคส = ยืนยันยอด แล้วพนักงานจะเห็นตัวเลขนี้ในหน้าของตัวเอง ·
        <strong>ชั่วโมงรวม</strong>คือเวลาจริงจากการเช็คอิน/เอาท์ ซึ่งเป็นคนละมิติกับค่าจ้าง
      </p>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : !error && rows?.length === 0 ? (
        <section className="card empty-state"><p>เดือนนี้ยังไม่มีเคสที่ปิดและไม่มีการเช็คอิน</p></section>
      ) : rows?.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>พนักงาน</th><th>เคสที่ปิด</th><th>ค่าจ้างรวม</th><th>จำนวนกะ</th><th>ชั่วโมงรวม</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee_id}>
                  <td data-label="พนักงาน">{r.employee_name}<span className="cell-sub mono">{r.employee_id}</span></td>
                  <td data-label="เคสที่ปิด">{r.closed_cases}</td>
                  <td data-label="ค่าจ้างรวม">
                    {formatBaht(r.pay)}
                    {/* กดไปหาเคสที่ปิดของคนนี้ได้เลย — เดิมรู้ว่ามีปัญหาแต่ไม่รู้ว่าเคสไหน */}
                    {r.unpriced_cases > 0 && (
                      <span className="cell-sub">
                        <Link className="link flag-text" to={`/cases?assigned_to=${r.employee_id}&status=closed`}>
                          {r.unpriced_cases} เคสยังไม่ระบุค่าจ้าง →
                        </Link>
                      </span>
                    )}
                  </td>
                  <td data-label="จำนวนกะ">{r.shifts}</td>
                  <td data-label="ชั่วโมงรวม">{durationText(r.minutes)}</td>
                </tr>
              ))}
            </tbody>
            {/* data-label ไม่ได้มีไว้แค่สวย — จอเล็กหัวตารางถูกซ่อน แถวรวมที่เหลือแต่ตัวเลขเปล่าๆ
                จะอ่านไม่ออกว่าเลขไหนคืออะไร */}
            <tfoot>
              <tr>
                <th data-label="พนักงาน">รวม {rows.length} คน</th>
                <th data-label="เคสที่ปิด">{totalCases}</th>
                <th data-label="ค่าจ้างรวม">{formatBaht(totalPay)}</th>
                <th />
                <th data-label="ชั่วโมงรวม">{durationText(totalMinutes)}</th>
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

/** หลักฐานตำแหน่ง: thumbnail (มี key) หรือลิงก์ Google Maps ธรรมดา (ไม่มี key) + รูปเซลฟี่ */
function Evidence({ v }) {
  const hasLoc = v.check_in_lat != null;
  const fullMap = hasLoc ? `https://www.google.com/maps?q=${v.check_in_lat},${v.check_in_lng}` : null;
  return (
    <span className="att-evidence">
      {v.check_in_distance_m != null && (
        <span className={v.location_flagged ? 'flag-text' : ''}>ห่าง {v.check_in_distance_m} ม.</span>
      )}
      {hasLoc && MAPS_KEY && (
        <a href={fullMap} target="_blank" rel="noreferrer" title="เปิดแผนที่เต็ม">
          <img className="att-thumb" src={staticMapUrl(v)} alt="ตำแหน่งเช็คอิน" loading="lazy" />
        </a>
      )}
      {hasLoc && !MAPS_KEY && <a href={fullMap} target="_blank" rel="noreferrer">แผนที่</a>}
      {v.has_photo && (
        <a href={api.visitCheckinPhotoUrl(v.case_id, v.visit_id)} target="_blank" rel="noreferrer">รูป</a>
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

function reason(v) {
  if (v.state === 'missed') return 'ขาดงาน';
  if (v.state === 'stale') return 'ค้างเช็คเอาท์';
  if (v.location_flagged) return 'นอกพื้นที่';
  return VISIT_STATE_LABELS[v.state];
}

function Exceptions({ rows, error, onReload, filters }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  async function adjust(v, body, confirmMsg, done) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.adjustVisit(v.case_id, v.visit_id, body);
      toast(done);
      await onReload();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="att-filter">{filters}</div>

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
                  </td>
                  <td data-label="พนักงาน / เคส"><WhoCell v={v} /></td>
                  <td data-label="ปัญหา"><span className={`badge visit-${v.state}`}>{reason(v)}</span></td>
                  <td data-label="หลักฐาน"><Evidence v={v} /></td>
                  <td className="row-actions">
                    {v.state === 'stale' && (
                      <button className="btn tiny" disabled={busy}
                        onClick={() => adjust(v, { check_out_at: new Date().toISOString(), status: 'done' },
                          `ปิดกะนี้ด้วยเวลาปัจจุบัน?\n(${v.employee_name} · ${formatDate(v.visit_date)})`,
                          'ปิดกะแล้ว')}>
                        ปิดกะ
                      </button>
                    )}
                    {v.state === 'missed' && (
                      <button className="btn tiny danger-ghost" disabled={busy}
                        onClick={() => adjust(v, { status: 'cancelled' }, 'ทำเครื่องหมายว่ากะนี้ยกเลิก?', 'ยกเลิกกะแล้ว')}>
                        ยกเลิกกะ
                      </button>
                    )}
                    {v.location_flagged && (
                      <button className="btn tiny" disabled={busy}
                        onClick={() => adjust(v, { location_flagged: false }, null, 'เคลียร์ธงแล้ว')}>
                        เคลียร์ธง
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Log({ month, employeeId, state, q, page, patch, employeePicker }) {
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
  }, [month, employeeId]);

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
      ['วันที่', 'พนักงาน', 'ผู้รับบริการ', 'รหัสเคส', 'เข้า', 'ออก', 'ชั่วโมง', 'สถานะ', 'ห่างจากจุดเคส (ม.)'],
      // ส่งออก "ทุกแถวที่กรองอยู่" ไม่ใช่แค่หน้าปัจจุบัน — คนกด export ต้องการทั้งชุดไปตรวจ
      filteredRows.map((v) => [
        v.visit_date, v.employee_name, v.client_name, v.case_id,
        v.check_in_at ? timeText(v.check_in_at) : '',
        v.check_out_at ? timeText(v.check_out_at) : '',
        v.worked_minutes != null ? (v.worked_minutes / 60).toFixed(1) : '',
        VISIT_STATE_LABELS[v.state] ?? v.state,
        v.check_in_distance_m ?? '',
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
                    <td data-label="เข้า–ออก">{timeText(v.check_in_at)} – {v.check_out_at ? timeText(v.check_out_at) : '…'}</td>
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
