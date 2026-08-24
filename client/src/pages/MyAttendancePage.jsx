import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { serviceName } from '../components/MyCaseModal.jsx';
import PageRefresh, { RefreshButton, useUpdatedAt } from '../components/PageRefresh.jsx';
import { VISIT_STATE_LABELS, PAY_STATUS_LABELS, formatBaht, formatDate, timeText, durationText } from '../labels.js';

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
  const [payslips, setPayslips] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  /* แยกเป็นฟังก์ชันเพื่อให้ทั้ง effect ตอนเปลี่ยนเดือน และการดึงหน้าลงรีเฟรช เรียกตัวเดียวกัน
     ไม่ล้าง report/rows ทิ้งก่อนโหลดเหมือนเดิม — รีเฟรชแล้วตัวเลขวูบหายไปทั้งหน้า
     แล้วค่อยกลับมาเป็นภาพกระพริบที่ไม่มีใครสั่ง ของเดิมที่อ่านอยู่ควรค้างไว้จนกว่าของใหม่จะมา */
  const load = useCallback((staleCheck) => {
    // ปุ่มรีเฟรชส่ง event ของการคลิกมาเป็นอาร์กิวเมนต์แรก — ใช้เฉพาะตอนที่เป็นฟังก์ชันจริง
    const isStale = typeof staleCheck === 'function' ? staleCheck : () => false;
    setLoading(true);
    return Promise.all([api.myAttendanceReport(month), api.myAttendance(month), api.myPayslips()])
      .then(([r, list, slips]) => {
        if (isStale()) return; // เปลี่ยนเดือนไปแล้วระหว่างรอ — ของชุดนี้เป็นของเดือนเก่า ทิ้งไป
        setReport(r);
        setRows(list);
        setPayslips(slips);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => !isStale() && setError(e.message))
      .finally(() => !isStale() && setLoading(false));
  }, [month]);

  /* ธง cancelled: เปลี่ยนเดือนเร็วๆ แล้วคำตอบของเดือนก่อนหน้ามาถึงทีหลัง จะทับตัวเลขของเดือนที่เลือกอยู่
     ค่าจ้างของเดือนผิดที่ดูเหมือนถูกต้องทุกอย่างคือของที่คนอ่านไม่มีทางจับได้ด้วยตาเปล่า */
  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => { cancelled = true; };
  }, [load]);

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
              <span className="hero-label">ค่าจ้างที่อนุมัติแล้ว</span>
              <span className="hero-value">{formatBaht(report.pay)}</span>
            </div>

            <div className="tiles">
              {/* กะที่รอผู้จัดการยืนยัน — ยังไม่ใช่ยอดเงิน เพราะค่าจ้างเป็นก้อนต่อเคส
                  แต่ต้องเห็น เพราะกะที่ยังไม่ยืนยันจะไม่ถูกนับเป็นสัดส่วนตอนแบ่งค่าจ้าง */}
              <div className="tile is-static">
                <span className="tile-label">กะรออนุมัติ</span>
                <span className="tile-value">{report.pending_shifts}</span>
                <span className="tile-share">
                  {report.pending_shifts > 0 ? 'รอผู้จัดการยืนยัน' : 'ยืนยันครบแล้ว'}
                </span>
              </div>
              {/* อนุมัติแล้วยังไม่ใช่ได้เงิน — เงินออกจริงตอนรอบจ่ายถูกปิด
                  ไม่แยกสองตัวนี้ พนักงานจะอ่านยอดบนสุดว่า "ได้แล้ว" ทั้งก้อน แล้วมาถามว่าทำไมเงินไม่เข้า */}
              <div className="tile is-static">
                <span className="tile-label">รอโอน</span>
                <span className="tile-value">{formatBaht(report.unpaid_pay ?? 0)}</span>
                <span className="tile-share">
                  {(report.unpaid_pay ?? 0) > 0 ? 'จะเข้ารอบจ่ายถัดไป' : `โอนแล้ว ${formatBaht(report.paid_pay ?? 0)}`}
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

          {/* คำอธิบายกติกาทั่วไปถูกเอาออกแล้ว — ขึ้นแถบนี้เฉพาะตอนมีเรื่องที่พนักงานต้องทำอะไรต่อจริงๆ
              (กะที่ยังไม่มีค่าจ้าง / กะที่ไม่ได้รับอนุมัติ) ไม่งั้นเขาจะไม่รู้เลยว่าต้องไปถามใคร */}
          {report.rejected_shifts > 0 && (
            <p className="notice">
              มี {report.rejected_shifts} กะที่ไม่ได้รับอนุมัติ ดูเหตุผลได้ที่รายการกะด้านล่าง
            </p>
          )}

          {/* สลิปของรอบที่จ่ายไปแล้ว — ไม่ผูกกับเดือนที่เลือกด้านบน เพราะรอบหนึ่งกวาดกะข้ามเดือนได้
              (กะเก่าที่เพิ่งอนุมัติจะถูกจ่ายในรอบถัดไป ซึ่งเป็นคนละเดือนกับวันที่ไปทำงาน) */}
          {payslips.length > 0 && (
            <section className="card">
              <h2>รอบที่จ่ายแล้ว ({payslips.length})</h2>
              {payslips.map((s) => (
                <div className="history-item" key={s.item_id}>
                  <div>
                    <strong>{formatBaht(s.total_pay)}</strong>
                    {/* จำนวนเคส ไม่ใช่จำนวนกะ — เงินก้อนนี้ประกอบด้วยงวดของเคส ไม่ได้คิดเป็นรายกะ */}
                    <p className="muted">
                      <span className="mono">{s.run_id}</span>
                      {' · '}{s.period_month} รอบที่ {s.round_no}
                      {' · '}{(s.cases ?? []).length} เคส
                    </p>

                    {/* เงินเข้าบัญชีเป็นก้อนเดียวรวมทุกเคส แต่ก้อนนั้นต้องกางได้ว่ามาจากเคสไหน
                        เคสละเท่าไหร่ งวดที่เท่าไหร่ — พนักงานที่จำได้ว่า "เคสนี้ตกลงงวดแรก 7,000"
                        ไม่มีทางรู้เลยว่ายอดนั้นรวมอยู่ในใบนี้หรือยัง ถ้าเห็นแต่ยอดรวม
                        กางไว้เลยไม่ต้องกด: สลิปหนึ่งใบมีไม่กี่เคส และนี่คือสิ่งที่เปิดมาดู */}
                    {(s.cases ?? []).length > 0 && (
                      <ul className="plain-list payroll-item-cases">
                        {s.cases.map((c) => (
                          <li key={c.case_id}>
                            <span>
                              {c.client_name ?? c.case_title ?? 'เคสที่ถูกลบแล้ว'}
                              <span className="cell-sub mono">{c.case_id}</span>
                            </span>
                            <span>
                              {formatBaht(c.amount)}
                              <span className="cell-sub">งวดที่ {c.installments.join(', ')}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="muted">
                    จ่าย {formatDate(s.pay_date)}
                    {s.method && <span className="cell-sub">{s.method}</span>}
                  </div>
                </div>
              ))}
            </section>
          )}

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
                  <div className="pay-cell">
                    {/* ค่าจ้างเป็นก้อนต่อเคส ผู้จัดการเป็นคนกดปล่อย — ยังไม่ปล่อยก็ยังไม่มียอดของเดือนนี้
                        บอกให้ตรงว่า "ยังไม่ถูกปล่อย" ไม่ใช่ ฿0 ซึ่งอ่านแล้วเหมือนทำงานฟรี */}
                    <strong className={c.pay === 0 ? 'muted' : ''}>
                      {c.pay === 0 ? 'ยังไม่ปล่อยค่าจ้าง' : formatBaht(c.pay)}
                    </strong>
                    {/* ค่าจ้างของเคสแบ่งจ่ายได้ถึงสามงวด — ยอดก้อนนี้เป็นงวดไหนคือสิ่งที่บอกได้ว่า
                        "ได้ครบตามที่ตกลงแล้ว" หรือ "ยังมีงวดต่อไปรออยู่" ซึ่งตัวเลขเปล่าๆ บอกไม่ได้ */}
                    {c.installments && (
                      <span className="cell-sub">งวดที่ {c.installments}</span>
                    )}
                    {c.pending_shifts > 0 && (
                      <span className="cell-sub">รออนุมัติ {c.pending_shifts} กะ</span>
                    )}
                  </div>
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
                        {/* กะที่ทำจบแล้วต้องบอกด้วยว่าเงินถึงไหนแล้ว — รออนุมัติ / อนุมัติ / ไม่อนุมัติ(พร้อมเหตุผล)
                            ไม่งั้นพนักงานเห็นแค่ "เสร็จแล้ว" แต่ยอดไม่ขึ้น ก็ไม่รู้จะไปถามใครเรื่องอะไร */}
                        {v.state === 'done' && (
                          <span className={`cell-sub ${v.pay_status === 'rejected' ? 'flag-text' : ''}`}>
                            {PAY_STATUS_LABELS[v.pay_status]}
                            {v.pay_status === 'rejected' && v.pay_note && ` — ${v.pay_note}`}
                          </span>
                        )}
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
