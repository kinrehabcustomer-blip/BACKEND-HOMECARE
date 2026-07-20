import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import {
  CASE_TYPE_LABELS, CASE_STATUS_LABELS, MONTH_LABELS,
  formatDate, formatPeriod, toBuddhistYear,
} from '../labels.js';

/** ตัวเลขสรุปหนึ่งช่อง — จุดสีคู่กับป้ายข้อความเสมอ ไม่ใช้สีสื่อความหมายเพียงอย่างเดียว */
function StatTile({ label, value, share, status, to }) {
  return (
    <Link className="tile" to={to}>
      <span className="tile-label">
        <i className={`dot case-${status}`} aria-hidden="true" />
        {label}
      </span>
      <span className="tile-value">{value}</span>
      <span className="tile-share">{share}</span>
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

  // ปี/เดือนที่มีข้อมูลจริง โหลดครั้งเดียว — ไม่ต้องดึงใหม่ทุกครั้งที่เปลี่ยนช่วงเวลา
  useEffect(() => {
    api.casePeriods().then(setPeriods).catch(() => {});
  }, []);

  useEffect(() => {
    const params = { status: 'unassigned', per_page: 5, sort: 'created_at', order: 'desc' };
    if (year) params.year = year;
    if (year && month) params.month = month;

    Promise.all([api.caseSummary({ year, month }), api.listCases(params)])
      .then(([s, list]) => {
        setSummary(s);
        setUnassigned(list.data);
      })
      .catch((err) => setError(err.message));
  }, [year, month]);

  // เดือนที่เลือกได้ = เฉพาะเดือนที่มีเคสจริงในปีที่เลือกอยู่
  const monthsOfYear = periods.find((p) => p.year === year)?.months ?? [];

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

  if (error) return <p className="error">{error}</p>;
  if (!summary) return <p className="muted">กำลังโหลด…</p>;

  const count = (status) => summary.by_status.find((s) => s.status === status)?.count ?? 0;
  const total = summary.total;
  const pct = (n) => (total === 0 ? '—' : `${Math.round((n / total) * 100)}% ของทั้งหมด`);

  // เรียงมากไปน้อย ประเภทที่ยังไม่มีเคสเลยไม่ต้องแสดง
  const byType = [...summary.by_type].sort((a, b) => b.count - a.count);
  const maxType = Math.max(...byType.map((t) => t.count), 1);

  return (
    <>
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

      {total === 0 ? (
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
            </div>

            <div className="tiles">
              <StatTile
                label={CASE_STATUS_LABELS.unassigned}
                value={count('unassigned').toLocaleString('th-TH')}
                share={pct(count('unassigned'))}
                status="unassigned"
                to={linkTo('unassigned')}
              />
              <StatTile
                label={CASE_STATUS_LABELS.assigned}
                value={count('assigned').toLocaleString('th-TH')}
                share={pct(count('assigned'))}
                status="assigned"
                to={linkTo('assigned')}
              />
              <StatTile
                label={CASE_STATUS_LABELS.in_progress}
                value={count('in_progress').toLocaleString('th-TH')}
                share={pct(count('in_progress'))}
                status="in_progress"
                to={linkTo('in_progress')}
              />
              <StatTile
                label={CASE_STATUS_LABELS.closed}
                value={count('closed').toLocaleString('th-TH')}
                share={pct(count('closed'))}
                status="closed"
                to={linkTo('closed')}
              />
            </div>
          </section>

          <div className="columns">
            <section className="card">
              <h2>เคสตามประเภท</h2>
              {/* แท่งสีเดียวทุกแถว — ประเภทเคสไม่มีลำดับสูงต่ำ การไล่สีตามจำนวนจะซ้ำกับความยาวแท่งเปล่าๆ */}
              <ul className="bars">
                {byType.map((t) => (
                  <li key={t.case_type} title={`${CASE_TYPE_LABELS[t.case_type]}: ${t.count} เคส (${Math.round((t.count / total) * 100)}%)`}>
                    <span className="bar-label">{CASE_TYPE_LABELS[t.case_type]}</span>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${(t.count / maxType) * 100}%` }} />
                    </span>
                    <span className="bar-value">{t.count}</span>
                  </li>
                ))}
              </ul>
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
        </>
      )}
    </>
  );
}
