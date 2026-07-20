import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import EmployeeModal from '../components/EmployeeModal.jsx';
import { POSITION_LABELS, STATUS_LABELS, EMPLOYMENT_TYPE_LABELS } from '../labels.js';

const EMPTY_FILTERS = { q: '', status: '', position: '' };

export default function EmployeeListPage() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null); // employee_id ของแถวที่เปิด popup อยู่

  useEffect(() => {
    // หน่วงเล็กน้อยระหว่างพิมพ์ค้นหา จะได้ไม่ยิง API ทุกตัวอักษร
    const timer = setTimeout(() => {
      const params = Object.fromEntries(Object.entries({ ...filters, page }).filter(([, v]) => v !== ''));
      api
        .listEmployees(params)
        .then(setResult)
        .catch((err) => setError(err.message));
    }, 250);

    return () => clearTimeout(timer);
  }, [filters, page]);

  useEffect(() => {
    api.summary().then(setSummary).catch(() => {});
  }, [result]);

  const setFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1); // เปลี่ยนตัวกรองแล้วต้องกลับไปหน้าแรก ไม่งั้นอาจค้างอยู่หน้าที่ไม่มีข้อมูล
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>พนักงาน</h1>
          <p className="muted">
            {summary ? `ทั้งหมด ${summary.total} คน · ทำงานอยู่ ${summary.by_status.find((s) => s.status === 'active')?.count ?? 0} คน` : ' '}
          </p>
        </div>
        <Link className="btn primary" to="/employees/new">
          + เพิ่มพนักงาน
        </Link>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="ค้นหา รหัส / ชื่อ / ชื่อเล่น / เบอร์โทร"
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={filters.position} onChange={(e) => setFilter('position', e.target.value)}>
          <option value="">ทุกตำแหน่ง</option>
          {Object.entries(POSITION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {/* จอแคบ: ให้ตารางเลื่อนแนวนอนในกล่องของตัวเอง ไม่ดันทั้งหน้าให้เลื่อนตาม */}
      <div className="table-wrap">
      <table className="table">
        {/* ตรึงความกว้างคอลัมน์ไว้ ไม่ให้ตารางขยับตามความยาวชื่อของแต่ละแถว */}
        <colgroup>
          <col style={{ width: '16%' }} />
          <col style={{ width: '30%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '17%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>รหัสพนักงาน</th>
            <th>ชื่อ-นามสกุล</th>
            <th>ตำแหน่ง</th>
            <th>ประเภท</th>
            <th>สถานะ</th>
          </tr>
        </thead>
        <tbody>
          {result?.data.map((emp) => (
            <tr
              key={emp.employee_id}
              className="row-clickable"
              tabIndex={0}
              onClick={() => setOpenId(emp.employee_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpenId(emp.employee_id);
                }
              }}
            >
              <td className="mono link">{emp.employee_id}</td>
              <td>
                {emp.first_name} {emp.last_name}
                {emp.nickname && <span className="muted"> ({emp.nickname})</span>}
              </td>
              <td>{POSITION_LABELS[emp.position]}</td>
              <td>{EMPLOYMENT_TYPE_LABELS[emp.employment_type]}</td>
              <td>
                <span className={`badge ${emp.status}`}>{STATUS_LABELS[emp.status]}</span>
              </td>
            </tr>
          ))}
          {result?.data.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">ไม่พบพนักงานที่ตรงกับเงื่อนไข</td>
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

      {openId && <EmployeeModal employeeId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
