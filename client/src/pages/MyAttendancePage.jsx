import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { serviceName } from '../components/MyCaseModal.jsx';
import { VISIT_STATE_LABELS, formatBaht, formatDate, timeText, durationText } from '../labels.js';

/**
 * การมาทำงาน + ค่าตอบแทนของพนักงานภาคสนามเอง
 *
 * ทั้งสองเส้นที่เรียก (/my/attendance, /my/attendance/report) กรองด้วย employee_id จาก session
 * จึงเห็นได้เฉพาะตัวเลขของตัวเอง ไม่เห็นของเพื่อนร่วมงาน (ต่างจากหน้า "การมาทำงาน" ของ admin ที่เห็นทุกคน)
 */
export default function MyAttendancePage() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [report, setReport] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setRows(null);
    setError(null);

    Promise.all([api.myAttendanceReport(month), api.myAttendance(month)])
      .then(([r, list]) => {
        if (cancelled) return;
        setReport(r);
        setRows(list);
      })
      .catch((e) => !cancelled && setError(e.message));

    return () => {
      cancelled = true;
    };
  }, [month]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ค่าตอบแทนของฉัน</h1>
          <p className="muted">ค่าจ้างและชั่วโมงทำงานของคุณ — เห็นเฉพาะของตัวเอง</p>
        </div>
      </header>

      <div className="att-filter">
        <label>เดือน <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
      </div>

      {error && <p className="error">{error}</p>}
      {!error && !report && <p className="muted">กำลังโหลด…</p>}

      {report && (
        <>
          <section className="hero-card">
            {/* ยอดเงินเป็นตัวเลขนำของหน้า — เป็นสิ่งที่พนักงานเปิดหน้านี้มาดู
                นับเฉพาะเคสที่ผู้จัดการปิดแล้ว = ยืนยันยอดแล้ว จึงพูดได้เต็มปากว่า "ได้รับ" */}
            <div className="hero">
              <span className="hero-label">ค่าจ้างจากเคสที่ปิดแล้ว</span>
              <span className="hero-value">{formatBaht(report.pay)}</span>
            </div>

            <div className="tiles">
              <div className="tile is-static">
                <span className="tile-label">เคสที่ปิดในเดือนนี้</span>
                <span className="tile-value">{report.closed_cases}</span>
                <span className="tile-share">
                  {report.unpriced_cases > 0
                    ? `${report.unpriced_cases} เคสยังไม่ระบุค่าจ้าง`
                    : 'ยืนยันยอดครบแล้ว'}
                </span>
              </div>
              <div className="tile is-static">
                <span className="tile-label">ชั่วโมงทำงาน</span>
                <span className="tile-value">{(report.minutes / 60).toFixed(1)}</span>
                <span className="tile-share">{durationText(report.minutes)} · {report.shifts} กะ</span>
              </div>
              <div className="tile is-static">
                <span className="tile-label">เคสที่ยังทำอยู่</span>
                <span className="tile-value">{report.open_cases}</span>
                <span className="tile-share">
                  {report.open_cases > 0 ? 'ยอดจะขึ้นเมื่อผู้จัดการปิดเคส' : 'ไม่มีเคสค้าง'}
                </span>
              </div>
            </div>
          </section>

          {/* บอกกติกาให้ชัด ไม่งั้นพนักงานที่ทำงานทั้งเดือนแต่เคสยังไม่ปิดจะเห็น ฿0 แล้วเข้าใจผิด */}
          <p className="notice">
            ยอดค่าจ้างจะขึ้นก็ต่อเมื่อ <strong>ผู้จัดการปิดเคสแล้ว</strong> เท่านั้น —
            เคสที่ยังให้บริการอยู่จะยังไม่ถูกนับ และยอดจะไปอยู่ในเดือนที่ปิดเคส
            {report.unpriced_cases > 0 && ' · มีเคสที่ปิดแล้วแต่ยังไม่ได้ระบุค่าจ้างในระบบ กรุณาสอบถามฝ่ายบุคคล'}
          </p>

          {/* ที่มาของยอด — ให้กางดูได้ว่าเงินมาจากเคสไหนบ้าง ไม่ใช่เห็นแค่ก้อนเดียว */}
          {report.cases.length > 0 && (
            <section className="card">
              <h2>เคสที่ปิดในเดือนนี้ ({report.cases.length})</h2>
              {report.cases.map((c) => (
                <div className="history-item" key={c.case_id}>
                  <div>
                    <strong>{c.client_name}</strong>
                    <p className="muted">
                      <span className="mono">{c.case_id}</span>
                      {' · '}{serviceName(c)}
                      {' · '}ปิดเมื่อ {formatDate(c.closed_at)}
                    </p>
                  </div>
                  <strong className={c.staff_pay == null ? 'muted' : ''}>
                    {c.staff_pay == null ? 'ยังไม่ระบุค่าจ้าง' : formatBaht(c.staff_pay)}
                  </strong>
                </div>
              ))}
            </section>
          )}

          <h2 className="cal-title">กะงานในเดือนนี้</h2>

          {rows?.length === 0 ? (
            <section className="card empty-state">
              <p>เดือนนี้คุณยังไม่มีกะงาน</p>
              <p className="muted">เมื่อผู้จัดการนัดกะให้คุณ งานจะปรากฏที่นี่</p>
            </section>
          ) : (
            <div className="table-wrap">
              <table className="table table-2line">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>ผู้รับบริการ / บริการ</th>
                    <th>เข้า–ออก</th>
                    <th>รวม</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {rows?.map((v) => (
                    <tr key={v.visit_id}>
                      <td>{formatDate(v.visit_date)}</td>
                      <td>
                        {v.client_name}
                        <span className="cell-sub">{serviceName(v)}</span>
                      </td>
                      <td>
                        {v.check_in_at ? (
                          <>
                            {timeText(v.check_in_at)} – {v.check_out_at ? timeText(v.check_out_at) : '…'}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>{durationText(v.worked_minutes)}</td>
                      <td>
                        <span className={`badge visit-${v.state}`}>{VISIT_STATE_LABELS[v.state]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
