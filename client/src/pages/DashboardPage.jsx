import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import RevenueChart from '../components/RevenueChart.jsx';
import CaseTypeChart from '../components/CaseTypeChart.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import {
  CASE_TYPE_LABELS, CASE_STATUS_LABELS, MONTH_LABELS,
  formatDate, formatPeriod, toBuddhistYear,
} from '../labels.js';

/** สถานะเคสตามลำดับการทำงานจริง: รอจับคู่ → จับคู่แล้ว → กำลังให้บริการ → ปิดเคส */
const STATUSES = ['unassigned', 'assigned', 'in_progress', 'closed'];

/** ตัวเลขสรุปหนึ่งช่อง — จุดสีคู่กับป้ายข้อความเสมอ ไม่ใช้สีสื่อความหมายเพียงอย่างเดียว */
function StatTile({ label, value, share, status, to }) {
  return (
    <Link className="tile" to={to}>
      <span className="tile-label">
        <i className={`dot case-${status}`} aria-hidden="true" />
        {label}
      </span>
      <span className="tile-value">{value}</span>
      {/* "ของทั้งหมด" ถูกซ่อนบนจอแคบ (ดู index.css) — ที่นั่นมีแถบสัดส่วนอยู่เหนือช่องพวกนี้แล้ว
          บอกว่าเทียบกับอะไร ส่วนบนจอกว้างไม่มีแถบ ข้อความเต็มจึงยังต้องมี */}
      <span className="tile-share">
        {share}
        {share !== '—' && <span className="tile-of"> ของทั้งหมด</span>}
      </span>
    </Link>
  );
}

export default function DashboardPage() {
  const [year, setYear] = useState(''); // '' = ทุกปี
  const [month, setMonth] = useState(''); // '' = ทั้งปี
  const [periods, setPeriods] = useState([]);
  const [summary, setSummary] = useState(null);
  const [unassigned, setUnassigned] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0); // เด้งค่าเพื่อสั่งโหลดใหม่จากปุ่ม "ลองใหม่"

  // ปี/เดือนที่มีข้อมูลจริง โหลดครั้งเดียว — ไม่ต้องดึงใหม่ทุกครั้งที่เปลี่ยนช่วงเวลา
  useEffect(() => {
    api.casePeriods().then(setPeriods).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const params = { status: 'unassigned', per_page: 5, sort: 'created_at', order: 'desc' };
    if (year) params.year = year;
    if (year && month) params.month = month;

    Promise.all([api.caseSummary({ year, month }), api.listCases(params)])
      .then(([s, list]) => {
        if (cancelled) return; // ผลของช่วงเวลาเก่าที่มาถึงช้ากว่า ต้องไม่ทับของที่เลือกอยู่
        setSummary(s);
        setUnassigned(list.data);
        setError(null); // สำเร็จแล้วต้องล้าง error ของรอบก่อน ไม่งั้นเน็ตสะดุดครั้งเดียวแถบจะค้างตลอด
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [year, month, reloadKey]);

  // เดือนที่เลือกได้ = เฉพาะเดือนที่มีเคสจริงในปีที่เลือกอยู่
  const monthsOfYear = periods.find((p) => p.year === year)?.months ?? [];

  const reload = () => setReloadKey((k) => k + 1);

  /** เปลี่ยนปีแล้วต้องล้างเดือนทิ้ง — เดือนเดิมอาจไม่มีข้อมูลในปีใหม่ */
  const changeYear = (value) => {
    setYear(value);
    setMonth('');
  };

  /** ลิงก์จาก tile ไปหน้าเคส — พาช่วงเวลาที่เลือกอยู่ไปด้วย ไม่งั้นตัวเลขที่กดกับรายการที่เห็นจะไม่ตรงกัน */
  const linkTo = (status) => {
    const params = new URLSearchParams({ status });
    if (year) params.set('year', year);
    if (year && month) params.set('month', month);
    return `/cases?${params}`;
  };

  const count = (status) => summary?.by_status.find((s) => s.status === status)?.count ?? 0;
  const total = summary?.total ?? 0;
  const pct = (n) => (total === 0 ? '—' : `${Math.round((n / total) * 100)}%`);

  // เรียงมากไปน้อย ประเภทที่ยังไม่มีเคสเลยไม่ต้องแสดง (กราฟเรียงซ้ำอีกชั้นเผื่อถูกเรียกจากที่อื่น)
  const byType = summary ? [...summary.by_type].sort((a, b) => b.count - a.count) : [];

  return (
    <PageRefresh onRefresh={reload} busy={loading}>
      <header className="page-head">
        <div>
          <h1>ภาพรวม</h1>
          <p className="muted">
            {year ? `เคสที่เปิดใน${formatPeriod(year, month)}` : 'สรุปสถานะเคสทั้งหมดในระบบ'}
          </p>
        </div>

        {/* ตัวกรองอยู่แถวเดียวเหนือทุกอย่างที่มันควบคุม — ทั้งหน้าเปลี่ยนตามพร้อมกัน */}
        <div className="period-picker">
          <select value={year} onChange={(e) => changeYear(e.target.value)} aria-label="เลือกปี">
            <option value="">ทุกปี</option>
            {periods.map((p) => (
              <option key={p.year} value={p.year}>
                ปี {toBuddhistYear(p.year)} ({p.count})
              </option>
            ))}
          </select>

          {/* เลือกเดือนไม่ได้จนกว่าจะเลือกปี — "พฤษภาคม" ของปีไหนไม่มีคำตอบ */}
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            disabled={!year}
            aria-label="เลือกเดือน"
            title={year ? undefined : 'เลือกปีก่อน'}
          >
            <option value="">{year ? 'ทั้งปี' : 'ทุกเดือน'}</option>
            {monthsOfYear.map((m) => (
              <option key={m.month} value={m.month}>
                {MONTH_LABELS[m.month]} ({m.count})
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* error เป็นแถบเหนือเนื้อหา ไม่ทับทั้งหน้า — ตัวเลือกปี/เดือนกับตัวเลขที่โหลดมาได้แล้ว
          ต้องไม่หายไปเพราะเน็ตสะดุดครั้งเดียว และต้องมีทางกดกลับมาเองโดยไม่ต้องรีเฟรชเบราว์เซอร์ */}
      <ErrorBar message={error} onRetry={reload} busy={loading} />

      {!summary ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : total === 0 ? (
        <section className="card empty-state">
          <p>{year ? `ไม่มีเคสที่เปิดใน${formatPeriod(year, month)}` : 'ยังไม่มีเคสในระบบ'}</p>
          {year ? (
            <button className="btn" onClick={() => changeYear('')}>ดูทุกช่วงเวลา</button>
          ) : (
            <>
              <p className="muted">เปิดเคสแรกเพื่อเริ่มติดตามงานและจับคู่พนักงาน</p>
              <Link className="btn primary" to="/cases/new">+ เปิดเคสใหม่</Link>
            </>
          )}
        </section>
      ) : (
        <>
          <section className="hero-card">
            <div className="hero">
              <span className="hero-label">
                {!year ? 'เคสทั้งหมด' : month ? 'เคสในเดือนนี้' : 'เคสในปีนี้'}
              </span>
              <span className="hero-value">{total.toLocaleString('th-TH')}</span>

              {/* แถบสัดส่วนสถานะ — บอก "งานกองอยู่ตรงไหน" ในบรรทัดเดียว โดยไม่ต้องไล่อ่าน % ทีละช่อง
                  ขึ้นเฉพาะจอแคบ (ดู index.css): ที่นั่นช่องตัวเลขเรียงเป็น 2×2 ซึ่งเทียบขนาดกันด้วยตาไม่ได้
                  ส่วนจอกว้างช่องทั้งสี่เรียงเป็นแถวเดียวเทียบกันได้อยู่แล้ว และคอลัมน์นี้แคบเกินกว่าจะอ่านแถบออก

                  aria-hidden — เป็นภาพแทนตัวเลขชุดเดียวกับที่อยู่ในช่องด้านล่าง ไม่ใช่ข้อมูลใหม่
                  ปล่อยไว้โปรแกรมอ่านหน้าจอจะอ่านสัดส่วนซ้ำอีกรอบโดยไม่ได้ความหมายเพิ่ม */}
              <div className="share-bar" aria-hidden="true">
                {STATUSES.map((s) =>
                  count(s) > 0 ? (
                    <span
                      key={s}
                      className={`share-seg case-${s}`}
                      style={{ width: `${(count(s) / total) * 100}%` }}
                    />
                  ) : null,
                )}
              </div>
            </div>

            <div className="tiles">
              {STATUSES.map((s) => (
                <StatTile
                  key={s}
                  label={CASE_STATUS_LABELS[s]}
                  value={count(s).toLocaleString('th-TH')}
                  share={pct(count(s))}
                  status={s}
                  to={linkTo(s)}
                />
              ))}
            </div>
          </section>

          <div className="columns">
            <section className="card">
              <h2>เคสตามประเภท</h2>
              <CaseTypeChart byType={byType} total={total} />
            </section>

            <section className="card">
              <h2>รอจับคู่พนักงาน</h2>
              {unassigned.length === 0 ? (
                <p className="muted">ทุกเคสมีพนักงานรับผิดชอบแล้ว</p>
              ) : (
                <>
                  <ul className="todo">
                    {unassigned.map((c) => (
                      <li key={c.case_id}>
                        <div>
                          <strong>{c.title}</strong>
                          <p className="muted">
                            <span className="mono">{c.case_id}</span>
                            {' · '}{CASE_TYPE_LABELS[c.case_type]}
                            {c.start_date && ` · เริ่ม ${formatDate(c.start_date)}`}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {count('unassigned') > unassigned.length && (
                    <Link className="link" to={linkTo('unassigned')}>
                      ดูทั้งหมด {count('unassigned')} เคส →
                    </Link>
                  )}
                </>
              )}
            </section>
          </div>

          {/* อยู่ใต้ทุกอย่างที่ตัวกรองด้านบนควบคุม เพราะการ์ดนี้มีช่วงเวลาของตัวเอง (บอกไว้ในหัวการ์ด)
              ไม่ได้ขึ้นกับปี/เดือนที่เลือก — วางแทรกกลางจะอ่านเหมือนถูกกรองไปด้วย */}
          <RevenueChart />
        </>
      )}
    </PageRefresh>
  );
}
