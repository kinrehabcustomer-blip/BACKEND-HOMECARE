import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import InvoiceModal from '../components/InvoiceModal.jsx';
import SortHead from '../components/SortHead.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import { api } from '../api.js';
import { INVOICE_STATUS_LABELS, formatBaht, formatDate } from '../labels.js';

const PER_PAGE_OPTIONS = [20, 50, 100];

// คอลัมน์ที่กดเรียงได้ — ต้องตรงกับ enum ของ sort ฝั่ง server (invoices/schema.js)
const SORTABLE = {
  invoice_id: { label: 'เลขที่ใบ', hint: 'เรียงตามลำดับที่ออกใบ' },
  issue_date: { label: 'วันที่ออก', hint: 'เรียงตามวันที่ออกใบ' },
  total: { label: 'ยอดสุทธิ', hint: 'เรียงตามยอดเงิน' },
};

const DEFAULTS = { sort: 'invoice_id', order: 'desc', per_page: '20', page: '1' };

/**
 * ชื่อรายการที่เก็บในใบเป็น "<บริการ> — ผู้รับบริการ: <ชื่อ>" ซึ่งยาวเกินคอลัมน์เสมอ
 * แล้วโดน … ตัดกลางคำจนอ่านไม่ออกทั้งสองส่วน — ในตารางเอาแค่ชื่อบริการพอ
 * ชื่อผู้รับบริการยังดูได้จากเคสที่ลิงก์ไว้ใต้บรรทัด และข้อความเต็มอยู่ใน title (ชี้เมาส์ค้าง)
 * ส่วนบนใบที่พิมพ์ออกไปจริงยังใช้ข้อความเต็มเหมือนเดิม ไม่ได้ตัดอะไรทิ้ง
 */
const serviceHead = (s) => (s ?? '').replace(/\s+—\s+ผู้รับบริการ:.*$/, '');

export default function InvoiceListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // เราเป็นคนเปิด popup เองหรือเปล่า — ใช้ตัดสินว่าตอนปิดควรถอยประวัติ (back) หรือลบพารามิเตอร์ทิ้ง
  const pushedOpen = useRef(false);

  /* สถานะของหน้าทั้งหมดอยู่ใน URL ที่เดียว — รีเฟรชแล้วยังอยู่ที่เดิม ส่งลิงก์ให้คนอื่นได้
     และปุ่มย้อนกลับของเบราว์เซอร์ปิด popup แทนที่จะเด้งออกจากหน้า */
  const get = (key) => params.get(key) ?? DEFAULTS[key] ?? '';
  const q = get('q');
  const status = INVOICE_STATUS_LABELS[get('status')] ? get('status') : '';
  const overdue = get('overdue') === 'yes' ? 'yes' : '';
  const sort = SORTABLE[get('sort')] ? get('sort') : DEFAULTS.sort;
  const order = get('order') === 'asc' ? 'asc' : 'desc';
  const perPage = PER_PAGE_OPTIONS.includes(Number(get('per_page'))) ? get('per_page') : DEFAULTS.per_page;
  const page = Math.max(1, Number(get('page')) || 1);
  const openId = params.get('open');

  const filtered = Boolean(q || status || overdue);

  /** เขียนค่าลง URL — ปริยาย replace เพื่อไม่ให้ทุกตัวอักษรที่พิมพ์กลายเป็นประวัติหนึ่งชั้น */
  const patch = (changes, { push = false } = {}) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === '' || value == null || value === DEFAULTS[key]) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: !push });
  };

  // เปลี่ยนตัวกรอง/การเรียง/จำนวนแถว แล้วต้องกลับไปหน้าแรกเสมอ ไม่งั้นอาจค้างอยู่หน้าที่ไม่มีข้อมูล
  const setFilter = (key, value) => patch({ [key]: value, page: '1' });
  const sortBy = (s, o) => patch({ sort: s, order: o, page: '1' });
  const clearFilters = () => patch({ q: '', status: '', overdue: '', page: '1' });

  /* สถานะกับเกินกำหนดเป็นคนละแกนกัน แต่เลือกพร้อมกันแล้วสับสน (เกินกำหนด = ออกใบแล้วเสมอ)
     จึงยุบเป็น dropdown เดียว — ค่า 'overdue' ไม่ใช่สถานะใน DB ต้องแปลงเป็นพารามิเตอร์คนละตัว */
  const statusValue = overdue ? 'overdue' : status;
  const setStatusFilter = (value) =>
    patch({
      status: value === 'overdue' ? '' : value,
      overdue: value === 'overdue' ? 'yes' : '',
      page: '1',
    });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const query = Object.fromEntries(
      Object.entries({ q, status, overdue, page, per_page: perPage, sort, order })
        .filter(([, v]) => v !== '' && v != null),
    );

    // หน่วงเล็กน้อยระหว่างพิมพ์ค้นหา จะได้ไม่ยิง API ทุกตัวอักษร
    const timer = setTimeout(() => {
      api
        .listInvoices(query)
        .then((data) => {
          if (cancelled) return; // ผลของเงื่อนไขเก่าที่มาถึงช้ากว่า ต้องไม่ทับผลของเงื่อนไขปัจจุบัน
          setResult(data);
          setError(null); // สำเร็จแล้วต้องล้าง error ของรอบก่อน ไม่งั้นเน็ตสะดุดครั้งเดียวหน้าค้างเป็น error ตลอด
        })
        .catch((err) => !cancelled && setError(err.message))
        .finally(() => !cancelled && setLoading(false));

      // ยอดสรุปใช้ตัวกรองชุดเดียวกัน (ตัดหน้า/การเรียงออก) — ตัวเลขด้านบนจะได้ตรงกับรายการที่เห็น
      const { page: _p, per_page: _pp, sort: _s, order: _o, ...forSummary } = query;
      api.invoiceSummary(forSummary).then((s) => !cancelled && setSummary(s)).catch(() => {});
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, status, overdue, page, perPage, sort, order, reloadKey]);

  // popup ถูกปิดด้วยปุ่มย้อนกลับของเบราว์เซอร์ — ประวัติที่เรา push ไว้ถูกใช้ไปแล้ว ต้องล้างธงทิ้ง
  useEffect(() => {
    if (!openId) pushedOpen.current = false;
  }, [openId]);

  const openInvoice = (id) => {
    pushedOpen.current = true;
    patch({ open: id }, { push: true }); // push เพื่อให้ปุ่มย้อนกลับ/ปัดกลับบนมือถือ = ปิด popup
  };

  const closeInvoice = () => {
    // เปิดเองในหน้านี้ → ถอยประวัติกลับไปสถานะก่อนเปิด
    // เข้ามาจากลิงก์ที่มี ?open=... อยู่แล้ว → ถอยจะหลุดออกจากแอป จึงลบพารามิเตอร์ทิ้งแทน
    if (pushedOpen.current) {
      pushedOpen.current = false;
      navigate(-1);
    } else {
      patch({ open: '' });
    }
  };

  const stat = (s) => summary?.find((x) => x.status === s) ?? { count: 0, amount: 0 };
  const unpaid = stat('issued');
  // ยอดรวมของ "รายการที่กรองอยู่" ทุกสถานะ — ตอบคำถาม "ที่เห็นอยู่นี่รวมเท่าไหร่"
  const grandTotal = (summary ?? []).reduce((sum, s) => sum + s.amount, 0);

  const rows = result?.data ?? [];
  const visibleIds = rows.map((v) => v.invoice_id);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ใบแจ้งหนี้</h1>
          <p className="muted">
            {result ? `ทั้งหมด ${result.pagination.total} ใบ · รวม ${formatBaht(grandTotal)} · ` : ''}
            รอชำระ {unpaid.count} ใบ ({formatBaht(unpaid.amount)}) · ชำระแล้ว {stat('paid').count} ใบ
            {filtered && <> · <span className="mono">เฉพาะที่กรองอยู่</span></>}
          </p>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="ค้นหา เลขที่ใบ / ชื่อผู้จ่าย / รหัสเคส"
          value={q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={statusValue} onChange={(e) => setStatusFilter(e.target.value)} aria-label="สถานะ">
          <option value="">ทุกสถานะ</option>
          {Object.entries(INVOICE_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
          {/* ไม่ใช่สถานะใน DB — คิดสดจากวันครบกำหนดที่ผ่านมาแล้ว แต่คนใช้มองเป็นสถานะหนึ่ง */}
          <option value="overdue">เกินกำหนดชำระ</option>
        </select>
        {/* โผล่เฉพาะตอนมีอะไรกรองอยู่ — ปุ่มที่กดแล้วไม่เกิดอะไรขึ้นไม่ควรมีให้เห็น */}
        {filtered && <button className="btn" onClick={clearFilters}>ล้างตัวกรอง</button>}
      </div>

      {/* error เป็นแถบเหนือตาราง ไม่ทับทั้งหน้า — คำค้นที่พิมพ์ไว้ต้องไม่หายไปเพราะเน็ตสะดุด */}
      <ErrorBar message={error} onRetry={() => setReloadKey((k) => k + 1)} busy={loading} />

      <div className="table-wrap">
        <table className="table table-cards table-2line table-indexed">
          <colgroup>
            {/* เลขที่ใบต้องกว้างพอสำหรับ "INV-0001 + ป้ายไม่ตรงกับเคส" และสถานะพอสำหรับป้ายเต็มก้อน
                ที่ยืมมาคือชื่อผู้จ่ายกับรายการ ซึ่งเป็นข้อความอิสระ ตัดท้ายได้ตามออกแบบ */}
            <col style={{ width: '5%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '19%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '15%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th><SortHead column="invoice_id" {...SORTABLE.invoice_id} sort={sort} order={order} onSort={sortBy} /></th>
              <th>ผู้จ่าย / เบอร์</th>
              <th className="cell-text">รายการ / เคส</th>
              <th><SortHead column="issue_date" {...SORTABLE.issue_date} sort={sort} order={order} onSort={sortBy} /></th>
              <th><SortHead column="total" {...SORTABLE.total} sort={sort} order={order} onSort={sortBy} /></th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v, i) => (
              <tr
                key={v.invoice_id}
                className="row-clickable"
                tabIndex={0}
                onClick={() => openInvoice(v.invoice_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openInvoice(v.invoice_id);
                  }
                }}
              >
                {/* ลำดับนับต่อเนื่องข้ามหน้า — เป็นลำดับของ "รายการที่เห็นตอนนี้" ไม่ใช่เลขที่เอกสาร */}
                <td className="row-index" data-label="ลำดับ">{(page - 1) * Number(perPage) + i + 1}</td>
                <td className="mono link" data-label="เลขที่ใบ">
                  {v.invoice_id}
                  {/* ใบไม่ตรงกับข้อมูลเคสแล้ว — เดิมรู้ได้ต่อเมื่อเปิดใบขึ้นมาดู ต้องเห็นตั้งแต่ในรายการ

                      บอกให้ตรงว่าไม่ตรงเรื่องอะไร — server แยก fee_stale / payer_stale มาให้อยู่แล้ว
                      และ popup เคสก็ใช้ความต่างนี้อยู่ ("ผู้จ่ายในใบไม่ตรง" vs "ไม่ตรงกับค่าจ้างเคส")
                      หน้ารายการเคยทิ้งไปเหลือ "ไม่ตรงกับเคส" กลางๆ ซึ่งต้องเปิดใบดูอยู่ดีว่าเรื่องอะไร

                      ใบที่ยกเลิกแล้วไม่ต้องเตือน ไม่มีใครต้องไปรีเฟรชมัน (เกณฑ์เดียวกับอีกสองที่) */}
                  {v.is_stale && v.status !== 'cancelled' && (
                    <span className="stale-flag" title="ข้อมูลในใบไม่ตรงกับเคสแล้ว — เปิดใบแล้วกด “รีเฟรชจากเคส”">
                      {v.fee_stale && v.payer_stale
                        ? 'ยอด/ผู้จ่ายไม่ตรง'
                        : v.payer_stale ? 'ผู้จ่ายไม่ตรง' : 'ยอดไม่ตรง'}
                    </span>
                  )}
                </td>
                <td data-label="ผู้จ่าย" title={v.bill_to_name || undefined}>
                  {v.bill_to_name}
                  {v.customer_phone && (
                    <span className="cell-sub">
                      {/* stopPropagation กันไม่ให้การกดเบอร์เปิด popup ตามไปด้วย */}
                      <a className="link mono" href={`tel:${v.customer_phone}`} onClick={(e) => e.stopPropagation()}>
                        {v.customer_phone}
                      </a>
                    </span>
                  )}
                </td>
                {/* รายละเอียดบริการเป็นข้อความอิสระ ยาวเกินคอลัมน์เสมอและถูก … ตัดท้าย
                    บนมือถือมันตัดบรรทัดจึงอ่านได้ครบ แต่บน PC ที่บังคับบรรทัดเดียวจะอ่านต่อไม่ได้เลย
                    title ให้ชี้เมาส์ค้างแล้วเห็นข้อความเต็ม — เป็นทางอ่านที่มีเฉพาะบน PC อยู่แล้ว */}
                <td className="cell-text" data-label="รายการ" title={v.service_description || undefined}>
                  {serviceHead(v.service_description)}
                  {v.case_id && (
                    <span className="cell-sub">
                      <Link className="link mono" to={`/cases?open=${v.case_id}`} onClick={(e) => e.stopPropagation()}>
                        {v.case_id}
                      </Link>
                    </span>
                  )}
                </td>
                <td data-label="วันที่ออก">
                  {formatDate(v.issue_date)}
                  {v.due_date && <span className="cell-sub">ครบกำหนด {formatDate(v.due_date)}</span>}
                </td>
                <td data-label="ยอดสุทธิ">{formatBaht(v.total)}</td>
                <td data-label="สถานะ">
                  <span className={`badge invoice-${v.is_overdue ? 'overdue' : v.status}`}>
                    {v.is_overdue ? 'เกินกำหนด' : INVOICE_STATUS_LABELS[v.status]}
                  </span>
                </td>
              </tr>
            ))}

            {/* โหลดครั้งแรกยังไม่มีข้อมูลเลย — ต้องบอกว่ากำลังโหลด ไม่ใช่ปล่อยตารางว่างเงียบๆ
                (ถ้ามีข้อมูลเก่าอยู่แล้ว คงไว้ให้อ่านต่อระหว่างโหลดรอบใหม่ ไม่ให้จอกระพริบ) */}
            {loading && rows.length === 0 && (
              <tr><td colSpan={7} className="empty">กำลังโหลด…</td></tr>
            )}

            {/* error มีแถบของตัวเองอยู่แล้ว — ไม่ต้องบอกซ้ำว่า "ไม่มีข้อมูล" ทั้งที่จริงๆ คือโหลดไม่สำเร็จ */}
            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  {filtered ? (
                    <>
                      ไม่พบใบแจ้งหนี้ที่ตรงกับเงื่อนไข{' '}
                      <button className="btn link-btn" onClick={clearFilters}>ล้างตัวกรอง</button>
                    </>
                  ) : (
                    <>
                      ยังไม่มีใบแจ้งหนี้ —{' '}
                      <Link className="link" to="/cases">ออกใบได้จากปุ่มในหน้าเคส →</Link>
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {result && (
        <div className="pager">
          {/* มีหน้าเดียวก็ไม่ต้องมีปุ่มเลื่อนหน้าที่กดไม่ได้ — แต่ตัวเลือกจำนวนแถวยังต้องอยู่ */}
          {result.pagination.total_pages > 1 && (
            <>
              <button className="btn" disabled={page <= 1} onClick={() => patch({ page: String(page - 1) })}>
                ก่อนหน้า
              </button>
              <span className="muted">
                หน้า {result.pagination.page} / {result.pagination.total_pages}
              </span>
              <button
                className="btn"
                disabled={page >= result.pagination.total_pages}
                onClick={() => patch({ page: String(page + 1) })}
              >
                ถัดไป
              </button>
            </>
          )}

          <label className="per-page">
            แสดง
            <select value={perPage} onChange={(e) => setFilter('per_page', e.target.value)}>
              {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            ต่อหน้า
          </label>
        </div>
      )}

      {openId && (
        <InvoiceModal
          invoiceId={openId}
          siblings={visibleIds}
          onNavigate={(id) => patch({ open: id })}
          onChanged={() => setReloadKey((k) => k + 1)}
          onReissued={(newId) => patch({ open: newId })}
          onClose={closeInvoice}
        />
      )}
    </>
  );
}
