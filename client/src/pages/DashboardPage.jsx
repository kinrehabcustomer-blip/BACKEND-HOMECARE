import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useCanSeeRevenue } from '../auth.jsx';
import RevenueChart from '../components/RevenueChart.jsx';
import { KpiRow, ServiceDonut, ShiftDonut, WorkloadList } from '../components/DashboardCharts.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import { SERVICE_KIND_LABELS, serviceKindOf, formatDate } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';

/** วันนี้แบบอ่านง่ายใต้ชื่อหน้า เช่น "จันทร์ 23 พ.ย. 2569" — แสดงอย่างเดียว */
const TODAY_TEXT = () => {
  const d = new Date();
  const wd = d.toLocaleDateString('th-TH', { weekday: 'long' }).replace(/^วัน/, '');
  return `${wd} ${d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

/**
 * หน้าภาพรวม — การ์ด KPI → วงแหวนสัดส่วนบริการ/ผลการเข้างาน → ภาระงาน/รอจับคู่ → รายได้
 *
 * การ์ดสรุปสถานะเคส (ตัวเลข 4 ช่อง + ตัวเลือกปี/เดือน) ถูกเอาออกตามที่ผู้ใช้ขอ (30 ต.ค. 2569)
 * ตัวเลือกปี/เดือนออกไปด้วย เพราะมันคุมแค่การ์ดนั้น — สัดส่วนบริการกับรอจับคู่จึงนับทั้งระบบเสมอ
 */
export default function DashboardPage() {
  const [summary, setSummary] = useState(null);
  const [unassigned, setUnassigned] = useState([]);
  const [unassignedTotal, setUnassignedTotal] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0); // เด้งค่าเพื่อสั่งโหลดใหม่จากปุ่ม "ลองใหม่"
  const canSeeRevenue = useCanSeeRevenue(); // รายได้รวมของบริษัท = เฉพาะผู้จัดการ (HR ไม่เห็น)
  const [charts, setCharts] = useState(null);
  const [chartsError, setChartsError] = useState(null);

  /* กราฟกะงาน/เคสรายเดือน/ภาระงาน — โหลดแยกจากสรุปเคส
     โหลดไม่สำเร็จไม่ลากการ์ดอื่นให้หายไปด้วย */
  useEffect(() => {
    let cancelled = false;
    api.caseDashboard()
      .then((d) => { if (!cancelled) { setCharts(d); setChartsError(null); } })
      .catch((err) => !cancelled && setChartsError(err.message));
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.caseSummary(),
      api.listCases({ status: 'unassigned', per_page: 5, sort: 'created_at', order: 'desc' }),
    ])
      .then(([s, list]) => {
        if (cancelled) return;
        setSummary(s);
        setUnassigned(list.data);
        setUnassignedTotal(s.by_status.find((x) => x.status === 'unassigned')?.count ?? list.data.length);
        setError(null); // สำเร็จแล้วต้องล้าง error ของรอบก่อน ไม่งั้นเน็ตสะดุดครั้งเดียวแถบจะค้างตลอด
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const total = summary?.total ?? 0;

  return (
    <PageRefresh onRefresh={reload} busy={loading}>
      {/* ดีไซน์ v2 (23 พ.ย. 2569): หัวหน้ากลับมาแสดง — ชื่อหน้า + วันนี้ (ตัวหนังสืออย่างเดียว ไม่แตะข้อมูล) */}
      <header className="page-head ops-head">
        <div>
          <h1>ภาพรวม</h1>
          <p className="muted">{TODAY_TEXT()}</p>
        </div>
      </header>

      {/* error เป็นแถบเหนือเนื้อหา ไม่ทับทั้งหน้า — มีทางกดกลับมาเองโดยไม่ต้องรีเฟรชเบราว์เซอร์ */}
      <ErrorBar message={error} onRetry={reload} busy={loading} />

      {!summary ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : total === 0 ? (
        <section className="card empty-state">
          <p>ยังไม่มีเคสในระบบ</p>
          <p className="muted">เปิดเคสแรกเพื่อเริ่มติดตามงานและจับคู่พนักงาน</p>
          <Link className="btn primary" to="/cases/new">+ เปิดเคสใหม่</Link>
        </section>
      ) : (
        <>
          {/* การ์ด KPI กับผลการเข้างาน/ภาระงาน มีช่วงเวลาของตัวเอง (บอกในการ์ดแต่ละใบ) */}
          {chartsError && <p className="error">โหลดกราฟไม่สำเร็จ: {chartsError}</p>}
          {charts && <KpiRow data={charts} />}

          <div className="columns dash-columns">
            <ServiceDonut byService={summary.by_service ?? []} periodLabel="เคสทั้งหมดในระบบ" />
            {charts && <ShiftDonut data={charts} />}
          </div>

          <div className="columns dash-columns">
            {charts && <WorkloadList data={charts} />}

            <section className="card">
              <div className="card-head dash-pending-head">
                <h2>รอจับคู่พนักงาน</h2>
                {/* ป้ายจำนวน — ตัวเลขเดียวกับลิงก์ "ดูทั้งหมด" ด้านล่าง */}
                {unassignedTotal > 0 && <span className="ops-count-pill">{unassignedTotal} เคส</span>}
              </div>
              {unassigned.length === 0 ? (
                <p className="muted">ทุกเคสมีพนักงานรับผิดชอบแล้ว</p>
              ) : (
                <>
                  <ul className="todo dash-pending">
                    {unassigned.map((c) => (
                      <li key={c.case_id}>
                        <div>
                          <strong>{c.title}</strong>
                          <p className="muted">
                            <span className="mono">{caseCode(c.case_id)}</span>
                            {' · '}{SERVICE_KIND_LABELS[serviceKindOf(c)]}
                            {c.start_date && ` · เริ่ม ${formatDate(c.start_date)}`}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {unassignedTotal > unassigned.length && (
                    <Link className="link" to="/cases?status=unassigned">
                      ดูทั้งหมด {unassignedTotal} เคส →
                    </Link>
                  )}
                </>
              )}
            </section>
          </div>

          {/* ไม่ขึ้นสำหรับคนที่ไม่ใช่ผู้จัดการ ไม่ใช่ขึ้นแล้วโชว์ error — เส้น API ตอบ 403 อยู่แล้ว
              (ดู requireManager ที่ /api/invoices/revenue) การ์ดที่ขึ้นมาเพื่อบอกว่า "คุณดูไม่ได้"
              ไม่ได้ช่วยใครทำงาน มีแต่บอกว่ามีตัวเลขที่ตัวเองไม่มีสิทธิ์อยู่ */}
          {canSeeRevenue && <RevenueChart />}
        </>
      )}
    </PageRefresh>
  );
}
