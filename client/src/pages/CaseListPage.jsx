import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import CaseModal from '../components/CaseModal.jsx';
import SortToggle from '../components/SortToggle.jsx';
import {
  CASE_TYPE_LABELS, CASE_STATUS_LABELS, MONTH_LABELS, formatPeriod, toBuddhistYear,
} from '../labels.js';

const EMPTY_FILTERS = { q: '', status: '', case_type: '', year: '', month: '' };

export default function CaseListPage() {
  // รับค่ากรองจาก URL ได้ (?status=unassigned&year=2026&month=07) เพื่อให้ลิงก์จากหน้าภาพรวมกรองมาให้เลย
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    ...EMPTY_FILTERS,
    status: searchParams.get('status') ?? '',
    case_type: searchParams.get('case_type') ?? '',
    year: searchParams.get('year') ?? '',
    month: searchParams.get('month') ?? '',
  }));
  const [periods, setPeriods] = useState([]);
  const [page, setPage] = useState(1);
  // เรียงตามรหัสเคส = เรียงตามเวลาที่เปิดเคส — ปริยาย desc = เคสล่าสุดขึ้นก่อน
  const [order, setOrder] = useState('desc');
  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0); // เด้งค่าเพื่อดึงรายการใหม่หลังแก้ไขใน popup

  useEffect(() => {
    api.casePeriods().then(setPeriods).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      // เดือนที่ไม่มีปีกำกับไม่มีความหมาย — ตัดทิ้งก่อนส่ง
      const clean = { ...filters, page, sort: 'case_id', order };
      if (!clean.year) clean.month = '';

      const params = Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== ''));
      api.listCases(params).then(setResult).catch((err) => setError(err.message));
    }, 250);

    return () => clearTimeout(timer);
  }, [filters, page, order, reloadKey]);

  // ยอดสรุปด้านบนต้องนับเฉพาะช่วงเวลาที่กรองอยู่ ไม่งั้นตัวเลขจะไม่ตรงกับรายการที่เห็น
  useEffect(() => {
    api
      .caseSummary({ year: filters.year, month: filters.month })
      .then(setSummary)
      .catch(() => {});
  }, [result, filters.year, filters.month]);

  const setFilter = (key, value) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
      // เปลี่ยนปีแล้วล้างเดือน — เดือนเดิมอาจไม่มีข้อมูลในปีใหม่
      ...(key === 'year' ? { month: '' } : null),
    }));
    setPage(1);
  };

  const handleSort = (next) => {
    setOrder(next);
    setPage(1);
  };

  const monthsOfYear = periods.find((p) => p.year === filters.year)?.months ?? [];
  const count = (status) => summary?.by_status.find((s) => s.status === status)?.count ?? 0;

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>เคส</h1>
          <p className="muted">
            {summary
              ? `${filters.year ? `เปิดใน${formatPeriod(filters.year, filters.month)} · ` : ''}ทั้งหมด ${summary.total} เคส · ยังไม่จับคู่ ${count('unassigned')} · จับคู่แล้ว ${count('assigned')} · กำลังให้บริการ ${count('in_progress')} · ปิดแล้ว ${count('closed')}`
              : ' '}
          </p>
        </div>
        <Link className="btn primary" to="/cases/new">+ เปิดเคสใหม่</Link>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="ค้นหา รหัสเคส / แพ็คเกจ / ชื่อผู้ป่วย / เบอร์โทร"
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={filters.year} onChange={(e) => setFilter('year', e.target.value)} aria-label="ปี">
          <option value="">ทุกปี</option>
          {periods.map((p) => (
            <option key={p.year} value={p.year}>ปี {toBuddhistYear(p.year)} ({p.count})</option>
          ))}
        </select>
        <select
          value={filters.month}
          onChange={(e) => setFilter('month', e.target.value)}
          disabled={!filters.year}
          aria-label="เดือน"
          title={filters.year ? undefined : 'เลือกปีก่อน'}
        >
          <option value="">{filters.year ? 'ทั้งปี' : 'ทุกเดือน'}</option>
          {monthsOfYear.map((m) => (
            <option key={m.month} value={m.month}>{MONTH_LABELS[m.month]} ({m.count})</option>
          ))}
        </select>
        <select value={filters.case_type} onChange={(e) => setFilter('case_type', e.target.value)}>
          <option value="">ทุกประเภท</option>
          {Object.entries(CASE_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {Object.entries(CASE_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {/* จอแคบ: ให้ตารางเลื่อนแนวนอนในกล่องของตัวเอง ไม่ดันทั้งหน้าให้เลื่อนตาม */}
      <div className="table-wrap">
      <table className="table table-2line">
        <colgroup>
          <col style={{ width: '13%' }} />
          <col style={{ width: '27%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '22%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>รหัสเคส</th>
            <th>แพ็คเกจ / ลูกค้า</th>
            <th>ประเภท</th>
            <th>พนักงานที่รับ</th>
            <th>
              <span className="sort-head-end">
                สถานะ
                <SortToggle order={order} onChange={handleSort} />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {result?.data.map((c) => (
            <tr
              key={c.case_id}
              className="row-clickable"
              tabIndex={0}
              onClick={() => setOpenId(c.case_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpenId(c.case_id);
                }
              }}
            >
              <td className="mono link">{c.case_id}</td>
              <td>
                {/* สองสายบริการเก็บชื่อคนละคอลัมน์ — กายภาพมาก่อนเพราะเคสที่ผูกแพ็คเกจไว้จะไม่มีเรท Homecare */}
                {c.physio_package_name ? (
                  <>{c.physio_package_name}
                    {c.physio_sessions && <span className="muted"> · {c.physio_sessions} ครั้ง</span>}</>
                ) : c.format_name ? (
                  <>{c.format_name}{c.grade_name && <span className="muted"> · {c.grade_name}</span>}</>
                ) : (
                  <span className="muted">ไม่ระบุบริการ</span>
                )}
                <span className="cell-sub">{c.customer_name ?? c.client_name}</span>
              </td>
              <td>{CASE_TYPE_LABELS[c.case_type]}</td>
              <td>
                {c.assigned_name ?? <span className="muted">—</span>}
                {c.assigned_to && <span className="cell-sub mono">{c.assigned_to}</span>}
              </td>
              <td>
                <span className={`badge case-${c.status}`}>{CASE_STATUS_LABELS[c.status]}</span>
              </td>
            </tr>
          ))}
          {result?.data.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">ยังไม่มีเคสที่ตรงกับเงื่อนไข</td>
            </tr>
          )}
        </tbody>
      </table>
      </div>

      {result && result.pagination.total_pages > 1 && (
        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ก่อนหน้า
          </button>
          <span className="muted">
            หน้า {result.pagination.page} / {result.pagination.total_pages}
          </span>
          <button
            className="btn"
            disabled={page >= result.pagination.total_pages}
            onClick={() => setPage((p) => p + 1)}
          >
            ถัดไป
          </button>
        </div>
      )}

      {openId && (
        <CaseModal
          caseId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </>
  );
}
