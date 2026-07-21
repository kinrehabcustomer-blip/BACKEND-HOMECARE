import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import CustomerModal from '../components/CustomerModal.jsx';
import SortToggle from '../components/SortToggle.jsx';
import { GENDER_LABELS } from '../labels.js';

export default function CustomerListPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // เรียงตามรหัสลูกค้า = เรียงตามเวลาที่เพิ่มเข้าระบบ — ปริยาย desc = ล่าสุดขึ้นก่อน
  const [order, setOrder] = useState('desc');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // เปลี่ยนการเรียง = กลับไปหน้าแรกเสมอ ไม่งั้นจะค้างอยู่หน้ากลางของชุดข้อมูลใหม่
  const handleSort = (next) => {
    setOrder(next);
    setPage(1);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = Object.fromEntries(
        Object.entries({ q, page, sort: 'customer_id', order }).filter(([, v]) => v !== ''),
      );
      api.listCustomers(params).then(setResult).catch((err) => setError(err.message));
    }, 250);

    return () => clearTimeout(timer);
  }, [q, page, order, reloadKey]);

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ลูกค้า</h1>
          <p className="muted">{result ? `ทั้งหมด ${result.pagination.total} ราย` : ' '}</p>
        </div>
        <Link className="btn primary" to="/customers/new">+ เพิ่มลูกค้า</Link>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="ค้นหา รหัสลูกค้า / ชื่อ / เบอร์โทร"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <div className="table-wrap">
        <table className="table">
          <colgroup>
            <col style={{ width: '15%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>รหัสลูกค้า</th>
              <th>ชื่อ</th>
              <th>เพศ / อายุ</th>
              <th>เบอร์โทร</th>
              <th>
                <span className="sort-head-end">
                  จำนวนเคส
                  <SortToggle order={order} onChange={handleSort} />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((c) => (
              <tr
                key={c.customer_id}
                className="row-clickable"
                tabIndex={0}
                onClick={() => setOpenId(c.customer_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId(c.customer_id);
                  }
                }}
              >
                <td className="mono link">{c.customer_id}</td>
                <td>{c.name}</td>
                <td>
                  {[GENDER_LABELS[c.gender], c.age != null && `${c.age} ปี`].filter(Boolean).join(' / ') || '—'}
                </td>
                <td>{c.phone ?? '—'}</td>
                <td>{c.case_count} เคส</td>
              </tr>
            ))}
            {result?.data.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">ยังไม่มีลูกค้าที่ตรงกับเงื่อนไข</td>
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
        <CustomerModal
          customerId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </>
  );
}
