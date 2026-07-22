import { useEffect, useState } from 'react';
import InvoiceModal from '../components/InvoiceModal.jsx';
import SortToggle from '../components/SortToggle.jsx';
import { api } from '../api.js';
import { INVOICE_STATUS_LABELS, formatBaht, formatDate } from '../labels.js';

export default function InvoiceListPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  // เรียงตามเลขที่ใบ = เรียงตามเวลาที่ออก — ปริยาย desc = ใบล่าสุดขึ้นก่อน
  const [order, setOrder] = useState('desc');
  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState([]);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const handleSort = (next) => {
    setOrder(next);
    setPage(1);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = Object.fromEntries(
        Object.entries({ q, status, page, sort: 'invoice_id', order }).filter(([, v]) => v !== ''),
      );
      api.listInvoices(params).then(setResult).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, status, page, order, reloadKey]);

  useEffect(() => {
    api.invoiceSummary().then(setSummary).catch(() => {});
  }, [result]);

  if (error) return <p className="error">{error}</p>;

  const stat = (s) => summary.find((x) => x.status === s) ?? { count: 0, amount: 0 };
  const unpaid = stat('issued');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ใบแจ้งหนี้</h1>
          <p className="muted">
            {result ? `ทั้งหมด ${result.pagination.total} ใบ · ` : ''}
            รอชำระ {unpaid.count} ใบ ({formatBaht(unpaid.amount)}) · ชำระแล้ว {stat('paid').count} ใบ
          </p>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="ค้นหา เลขที่ใบ / ชื่อผู้จ่าย / รหัสเคส"
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
          {Object.entries(INVOICE_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table className="table table-2line">
          <colgroup>
            <col style={{ width: '14%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>เลขที่ใบ</th>
              <th>ผู้จ่าย / รายการ</th>
              <th>วันที่ออก</th>
              <th>ยอดสุทธิ</th>
              <th>
                <span className="sort-head-end">
                  สถานะ
                  <SortToggle order={order} onChange={handleSort} />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((v) => (
              <tr
                key={v.invoice_id}
                className="row-clickable"
                tabIndex={0}
                onClick={() => setOpenId(v.invoice_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId(v.invoice_id);
                  }
                }}
              >
                <td className="mono link">{v.invoice_id}</td>
                <td>
                  {v.bill_to_name}
                  <span className="cell-sub">{v.service_description}</span>
                </td>
                <td>
                  {formatDate(v.issue_date)}
                  {v.due_date && <span className="cell-sub">ครบกำหนด {formatDate(v.due_date)}</span>}
                </td>
                <td>{formatBaht(v.total)}</td>
                <td>
                  <span className={`badge invoice-${v.is_overdue ? 'overdue' : v.status}`}>
                    {v.is_overdue ? 'เกินกำหนด' : INVOICE_STATUS_LABELS[v.status]}
                  </span>
                </td>
              </tr>
            ))}
            {result?.data.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  ยังไม่มีใบแจ้งหนี้ — ออกใบได้จากปุ่มในหน้าเคส
                </td>
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
        <InvoiceModal
          invoiceId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setReloadKey((k) => k + 1)}
          onReissued={(newId) => setOpenId(newId)}
        />
      )}
    </>
  );
}
