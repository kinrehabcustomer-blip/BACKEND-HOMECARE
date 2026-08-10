import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { serviceName } from '../components/MyCaseModal.jsx';
import PageRefresh, { RefreshButton, useUpdatedAt } from '../components/PageRefresh.jsx';
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
  const [loading, setLoading] = useState(true);

  /* แยกเป็นฟังก์ชันเพื่อให้ทั้ง effect ตอนเปลี่ยนเดือน และการดึงหน้าลงรีเฟรช เรียกตัวเดียวกัน
     ไม่ล้าง report/rows ทิ้งก่อนโหลดเหมือนเดิม — รีเฟรชแล้วตัวเลขวูบหายไปทั้งหน้า
     แล้วค่อยกลับมาเป็นภาพกระพริบที่ไม่มีใครสั่ง ของเดิมที่อ่านอยู่ควรค้างไว้จนกว่าของใหม่จะมา */
  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([api.myAttendanceReport(month), api.myAttendance(month)])
      .then(([r, list]) => {
        setReport(r);
        setRows(list);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { load(); }, [load]);

  // เวลาที่ข้อมูลชุดที่เห็นอยู่ถูกดึงมา — จับจากจังหวะที่ loading ลงจาก true เป็น false
  const updatedAt = useUpdatedAt(loading);

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      <header className="page-head">
        <div>
          <h1>ค่าตอบแทนของฉัน</h1>
          <p className="muted">ค่าจ้างและชั่วโมงทำงานของคุณ — เห็นเฉพาะของตัวเอง</p>
        </div>
        <RefreshButton onRefresh={load} busy={loading} updatedAt={updatedAt} />
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
                นับจากกะที่เช็คอิน–เอาท์ครบแล้วในเดือนนี้ = งานที่ลงแรงไปจริง */}
            <div className="hero">
              <span className="hero-label">ค่าจ้างจากกะที่ทำในเดือนนี้</span>
              <span className="hero-value">{formatBaht(report.pay)}</span>
            </div>

            <div className="tiles">
              <div className="tile is-static">
                <span className="tile-label">กะที่ทำจบแล้ว</span>
                <span className="tile-value">{report.shifts}</span>
                <span className="tile-share">
                  {report.unpriced_shifts > 0
                    ? `${report.unpriced_shifts} กะยังไม่ระบุค่าจ้าง`
                    : `${report.cases_worked} เคส`}
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
                  {report.open_cases > 0 ? 'กะที่เหลือจะทยอยเพิ่มยอด' : 'ไม่มีเคสค้าง'}
                </span>
              </div>
            </div>
          </section>

          {/* บอกกติกาให้ชัด ไม่งั้นพนักงานจะไม่รู้ว่าทำไมกะที่ยังไม่เช็คเอาท์ถึงไม่มียอด */}
          <p className="notice">
            ยอดขึ้นทันทีที่ <strong>เช็คอินและเช็คเอาท์ครบ</strong> โดยนับเข้าเดือนที่ไปทำงาน —
            กะที่ยังไม่เช็คเอาท์ยังไม่ถูกนับ · ตัวเลขอาจปรับได้จนกว่าผู้จัดการจะปิดเคส (ปิดแล้ว = ตรึงยอด)
            {report.unpriced_shifts > 0 && ' · มีกะที่ระบบยังไม่รู้ค่าจ้าง กรุณาสอบถามฝ่ายบุคคล'}
          </p>

          {/* ที่มาของยอด — ให้กางดูได้ว่าเงินมาจากเคสไหนบ้าง ไม่ใช่เห็นแค่ก้อนเดียว */}
          {report.cases.length > 0 && (
            <section className="card">
              <h2>เคสที่ทำในเดือนนี้ ({report.cases.length})</h2>
              {report.cases.map((c) => (
                <div className="history-item" key={c.case_id}>
                  <div>
                    <strong>{c.client_name}</strong>
                    <p className="muted">
                      <span className="mono">{c.case_id}</span>
                      {' · '}{serviceName(c)}
                      {' · '}{c.shifts} กะ
                      {c.closed_at && ` · ปิดเมื่อ ${formatDate(c.closed_at)}`}
                    </p>
                  </div>
                  <strong className={c.unpriced_shifts > 0 && c.pay === 0 ? 'muted' : ''}>
                    {c.unpriced_shifts > 0 && c.pay === 0 ? 'ยังไม่ระบุค่าจ้าง' : formatBaht(c.pay)}
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
              {/* หน้าของพนักงานภาคสนาม เปิดจากมือถือเป็นหลัก — จอเล็กแตกเป็นการ์ดต่อหนึ่งกะ
                  แทนตารางกว้างที่ต้องปัดซ้ายขวาถึงจะเห็นเวลาเข้า–ออก */}
              <table className="table table-cards table-2line">
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
                      <td data-label="วันที่">{formatDate(v.visit_date)}</td>
                      <td data-label="ผู้รับบริการ">
                        {v.client_name}
                        <span className="cell-sub">{serviceName(v)}</span>
                      </td>
                      <td data-label="เข้า–ออก">
                        {v.check_in_at ? (
                          <>
                            {timeText(v.check_in_at)} – {v.check_out_at ? timeText(v.check_out_at) : '…'}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td data-label="รวม">{durationText(v.worked_minutes)}</td>
                      <td data-label="สถานะ">
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
    </PageRefresh>
  );
}
