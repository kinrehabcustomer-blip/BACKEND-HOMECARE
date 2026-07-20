import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import PatientModal from '../components/PatientModal.jsx';
import { GENDER_LABELS, PATIENT_STATUS_LABELS, ageFromBirthDate } from '../labels.js';

export default function PatientListPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = Object.fromEntries(
        Object.entries({ q, status, page }).filter(([, v]) => v !== ''),
      );
      api.listPatients(params).then(setResult).catch((err) => setError(err.message));
    }, 250);

    return () => clearTimeout(timer);
  }, [q, status, page, reloadKey]);

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ผู้รับการดูแล</h1>
          <p className="muted">{result ? `ทั้งหมด ${result.pagination.total} ราย` : ' '}</p>
        </div>
        <Link className="btn primary" to="/patients/new">+ เพิ่มผู้รับการดูแล</Link>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="ค้นหา รหัส / ชื่อ / เลขบัตร"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">ทุกสถานะ</option>
          {Object.entries(PATIENT_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <colgroup>
            <col style={{ width: '14%' }} />
            <col style={{ width: '26%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '10%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>รหัส</th>
              <th>ชื่อ</th>
              <th>เพศ / อายุ</th>
              <th>ผู้ว่าจ้าง</th>
              <th>สถานะ</th>
              <th>เคส</th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((p) => {
              const age = ageFromBirthDate(p.birth_date) ?? p.age;
              return (
                <tr
                  key={p.patient_id}
                  className="row-clickable"
                  tabIndex={0}
                  onClick={() => setOpenId(p.patient_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpenId(p.patient_id);
                    }
                  }}
                >
                  <td className="mono link">{p.patient_id}</td>
                  <td>
                    {p.name}
                    {p.nickname && <span className="muted"> ({p.nickname})</span>}
                  </td>
                  <td>
                    {[GENDER_LABELS[p.gender], age != null && `${age} ปี`].filter(Boolean).join(' / ') || '—'}
                  </td>
                  <td>{p.customer_name ?? <span className="muted">— ยังไม่ผูกลูกค้า —</span>}</td>
                  <td><span className={`badge ${p.status}`}>{PATIENT_STATUS_LABELS[p.status]}</span></td>
                  <td>{p.case_count} เคส</td>
                </tr>
              );
            })}
            {result?.data.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">ยังไม่มีผู้รับการดูแลที่ตรงกับเงื่อนไข</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {result && result.pagination.total_pages > 1 && (
        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>ก่อนหน้า</button>
          <span className="muted">หน้า {result.pagination.page} / {result.pagination.total_pages}</span>
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
        <PatientModal
          patientId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </>
  );
}
