import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { VISIT_STATE_LABELS, formatBaht, formatDate, timeText, durationText } from '../labels.js';

/** หน้าติดตามการมาทำงานของพนักงานภาคสนาม (admin) */
export default function AttendancePage() {
  const [tab, setTab] = useState('exceptions');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>การมาทำงาน</h1>
          <p className="muted">ติดตามการเช็คอินของพนักงานภาคสนาม</p>
        </div>
      </header>

      <div className="att-tabs">
        <button className={`att-tab ${tab === 'exceptions' ? 'is-active' : ''}`} onClick={() => setTab('exceptions')}>
          รายการต้องตรวจ
        </button>
        <button className={`att-tab ${tab === 'log' ? 'is-active' : ''}`} onClick={() => setTab('log')}>
          ประวัติเช็คอิน
        </button>
        <button className={`att-tab ${tab === 'payroll' ? 'is-active' : ''}`} onClick={() => setTab('payroll')}>
          สรุปค่าตอบแทน
        </button>
      </div>

      {tab === 'exceptions' && <Exceptions />}
      {tab === 'log' && <Log />}
      {tab === 'payroll' && <Payroll />}
    </>
  );
}

/** escape ค่าเป็นเซลล์ CSV */
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function Payroll() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setRows(null);
    api.attendanceReport(month).then(setRows).catch((e) => setError(e.message));
  }, [month]);

  function exportCsv() {
    const header = ['รหัสพนักงาน', 'ชื่อ', 'จำนวนกะ', 'ชั่วโมงรวม', 'ค่าตอบแทนประมาณ (บาท)', 'กะที่มีเรท'];
    const lines = rows.map((r) => [
      r.employee_id,
      r.employee_name,
      r.shifts,
      (r.minutes / 60).toFixed(1),
      r.est_pay,
      `${r.priced_shifts}/${r.shifts}`,
    ]);
    const csv = [header, ...lines].map((a) => a.map(csvCell).join(',')).join('\r\n');
    // ﻿ (BOM) ให้ Excel อ่านภาษาไทยไม่เพี้ยน
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalShifts = rows?.reduce((s, r) => s + r.shifts, 0) ?? 0;
  const totalMinutes = rows?.reduce((s, r) => s + r.minutes, 0) ?? 0;
  const totalPay = rows?.reduce((s, r) => s + r.est_pay, 0) ?? 0;

  return (
    <>
      <div className="att-filter">
        <label>เดือน <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        {rows && rows.length > 0 && (
          <button className="btn" onClick={exportCsv}>⬇ ดาวน์โหลด CSV</button>
        )}
      </div>

      <p className="muted form-hint">
        ค่าตอบแทนเป็น<strong>ประมาณการ</strong> (staff_pay ของเรทที่เคสใช้ × จำนวนกะ) — ตรงกับเรทรายวัน
        ส่วนเรทรายเดือนต้องปรับมือ · <strong>ชั่วโมงรวม</strong>คือตัวเลขจริงจากการเช็คอิน/เอาท์
      </p>

      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : rows.length === 0 ? (
        <section className="card empty-state"><p>ยังไม่มีการเช็คอินในเดือนนี้</p></section>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>พนักงาน</th><th>จำนวนกะ</th><th>ชั่วโมงรวม</th><th>ค่าตอบแทนประมาณ</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee_id}>
                  <td>{r.employee_name}<span className="cell-sub mono">{r.employee_id}</span></td>
                  <td>{r.shifts}</td>
                  <td>{durationText(r.minutes)}</td>
                  <td>
                    {formatBaht(r.est_pay)}
                    {r.priced_shifts < r.shifts && (
                      <span className="cell-sub">มีเรท {r.priced_shifts}/{r.shifts} กะ</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>รวม {rows.length} คน</th>
                <th>{totalShifts}</th>
                <th>{durationText(totalMinutes)}</th>
                <th>{formatBaht(totalPay)}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
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

function reason(v) {
  if (v.state === 'missed') return 'ขาดงาน';
  if (v.state === 'stale') return 'ค้างเช็คเอาท์';
  if (v.location_flagged) return 'นอกพื้นที่';
  return VISIT_STATE_LABELS[v.state];
}

function Exceptions() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.attendanceExceptions().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function adjust(v, body, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    setError(null);
    try {
      await api.adjustVisit(v.case_id, v.visit_id, body);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">กำลังโหลด…</p>;
  if (rows.length === 0) {
    return (
      <section className="card empty-state">
        <p>ไม่มีรายการต้องตรวจ 🎉</p>
        <p className="muted">ทุกกะเช็คอิน/เช็คเอาท์เรียบร้อย</p>
      </section>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>วันที่</th><th>พนักงาน / เคส</th><th>ปัญหา</th><th>หลักฐาน</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.visit_id}>
              <td>{formatDate(v.visit_date)}</td>
              <td>
                {v.employee_name ?? '—'}
                <span className="cell-sub">{v.client_name} · <span className="mono">{v.case_id}</span></span>
              </td>
              <td><span className={`badge visit-${v.state}`}>{reason(v)}</span></td>
              <td><Evidence v={v} /></td>
              <td className="row-actions">
                {v.state === 'stale' && (
                  <button className="btn tiny" disabled={busy}
                    onClick={() => adjust(v, { check_out_at: new Date().toISOString(), status: 'done' },
                      `ปิดกะนี้ด้วยเวลาปัจจุบัน?\n(${v.employee_name} · ${formatDate(v.visit_date)})`)}>
                    ปิดกะ
                  </button>
                )}
                {v.state === 'missed' && (
                  <button className="btn tiny danger-ghost" disabled={busy}
                    onClick={() => adjust(v, { status: 'cancelled' }, 'ทำเครื่องหมายว่ากะนี้ยกเลิก?')}>
                    ยกเลิกกะ
                  </button>
                )}
                {v.location_flagged && (
                  <button className="btn tiny" disabled={busy}
                    onClick={() => adjust(v, { location_flagged: false })}>
                    เคลียร์ธง
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Log() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setRows(null);
    api.attendance({ month }).then(setRows).catch((e) => setError(e.message));
  }, [month]);

  return (
    <>
      <div className="att-filter">
        <label>เดือน <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
      </div>

      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : rows.length === 0 ? (
        <section className="card empty-state"><p>ยังไม่มีการเช็คอินในเดือนนี้</p></section>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>วันที่</th><th>พนักงาน / เคส</th><th>เข้า–ออก</th><th>รวม</th><th>สถานะ</th><th>หลักฐาน</th></tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.visit_id}>
                  <td>{formatDate(v.visit_date)}</td>
                  <td>
                    {v.employee_name ?? '—'}
                    <span className="cell-sub">{v.client_name} · <span className="mono">{v.case_id}</span></span>
                  </td>
                  <td>{timeText(v.check_in_at)} – {v.check_out_at ? timeText(v.check_out_at) : '…'}</td>
                  <td>{durationText(v.worked_minutes)}</td>
                  <td><span className={`badge visit-${v.state}`}>{VISIT_STATE_LABELS[v.state]}</span></td>
                  <td><Evidence v={v} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
