import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import CustomerModal from '../components/CustomerModal.jsx';
import SortHead from '../components/SortHead.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import { GENDER_LABELS } from '../labels.js';

const PER_PAGE_OPTIONS = [20, 50, 100];

// คอลัมน์ที่กดเรียงได้ — ต้องตรงกับ enum ของ sort ฝั่ง server (customers/schema.js)
// จำนวนเคสเรียงไม่ได้ เพราะเป็นค่าที่นับมาตอน SELECT ไม่ใช่คอลัมน์จริงในตาราง
const SORTABLE = {
  customer_id: { label: 'รหัสลูกค้า', hint: 'เรียงตามลำดับที่เพิ่มเข้าระบบ' },
  name: { label: 'ชื่อ', hint: 'เรียงตามชื่อ' },
};

const DEFAULTS = { sort: 'customer_id', order: 'desc', per_page: '20', page: '1' };

export default function CustomerListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // เราเป็นคนเปิด popup เองหรือเปล่า — ใช้ตัดสินว่าตอนปิดควรถอยประวัติ (back) หรือลบพารามิเตอร์ทิ้ง
  const pushedOpen = useRef(false);

  /* สถานะของหน้าทั้งหมดอยู่ใน URL ที่เดียว — รีเฟรชแล้วยังอยู่ที่เดิม ส่งลิงก์ให้คนอื่นได้
     และปุ่มย้อนกลับของเบราว์เซอร์ปิด popup แทนที่จะเด้งออกจากหน้า */
  const get = (key) => params.get(key) ?? DEFAULTS[key] ?? '';
  const q = get('q');
  const hasCases = ['yes', 'no'].includes(get('has_cases')) ? get('has_cases') : '';
  const sort = SORTABLE[get('sort')] ? get('sort') : DEFAULTS.sort;
  const order = get('order') === 'asc' ? 'asc' : 'desc';
  const perPage = PER_PAGE_OPTIONS.includes(Number(get('per_page'))) ? get('per_page') : DEFAULTS.per_page;
  const page = Math.max(1, Number(get('page')) || 1);
  const openId = params.get('open');

  const filtered = Boolean(q || hasCases);

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
  const clearFilters = () => patch({ q: '', has_cases: '', page: '1' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // หน่วงเล็กน้อยระหว่างพิมพ์ค้นหา จะได้ไม่ยิง API ทุกตัวอักษร
    const timer = setTimeout(() => {
      const query = Object.fromEntries(
        Object.entries({ q, has_cases: hasCases, page, per_page: perPage, sort, order })
          .filter(([, v]) => v !== '' && v != null),
      );

      api
        .listCustomers(query)
        .then((data) => {
          if (cancelled) return; // ผลของเงื่อนไขเก่าที่มาถึงช้ากว่า ต้องไม่ทับผลของเงื่อนไขปัจจุบัน
          setResult(data);
          setError(null); // สำเร็จแล้วต้องล้าง error ของรอบก่อน ไม่งั้นเน็ตสะดุดครั้งเดียวหน้าค้างเป็น error ตลอด
        })
        .catch((err) => !cancelled && setError(err.message))
        .finally(() => !cancelled && setLoading(false));
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, hasCases, page, perPage, sort, order, reloadKey]);

  // popup ถูกปิดด้วยปุ่มย้อนกลับของเบราว์เซอร์ — ประวัติที่เรา push ไว้ถูกใช้ไปแล้ว ต้องล้างธงทิ้ง
  useEffect(() => {
    if (!openId) pushedOpen.current = false;
  }, [openId]);

  const openCustomer = (id) => {
    pushedOpen.current = true;
    patch({ open: id }, { push: true }); // push เพื่อให้ปุ่มย้อนกลับ/ปัดกลับบนมือถือ = ปิด popup
  };

  const closeCustomer = () => {
    // เปิดเองในหน้านี้ → ถอยประวัติกลับไปสถานะก่อนเปิด
    // เข้ามาจากลิงก์ที่มี ?open=... อยู่แล้ว → ถอยจะหลุดออกจากแอป จึงลบพารามิเตอร์ทิ้งแทน
    if (pushedOpen.current) {
      pushedOpen.current = false;
      navigate(-1);
    } else {
      patch({ open: '' });
    }
  };

  const rows = result?.data ?? [];
  const visibleIds = rows.map((c) => c.customer_id);

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
          placeholder="ค้นหา รหัสลูกค้า / ชื่อ / ชื่อเล่น / เบอร์โทร / เลขบัตร / Line ID"
          value={q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={hasCases} onChange={(e) => setFilter('has_cases', e.target.value)}>
          <option value="">ทุกคน</option>
          <option value="yes">เคยใช้บริการแล้ว</option>
          <option value="no">ยังไม่เคยเปิดเคส</option>
        </select>
        {/* โผล่เฉพาะตอนมีอะไรกรองอยู่ — ปุ่มที่กดแล้วไม่เกิดอะไรขึ้นไม่ควรมีให้เห็น */}
        {filtered && <button className="btn" onClick={clearFilters}>ล้างตัวกรอง</button>}
      </div>

      {/* error เป็นแถบเหนือตาราง ไม่ทับทั้งหน้า — คำค้นที่พิมพ์ไว้ต้องไม่หายไปเพราะเน็ตสะดุด */}
      <ErrorBar message={error} onRetry={() => setReloadKey((k) => k + 1)} busy={loading} />

      <div className="table-wrap">
        <table className="table table-cards table-indexed">
          <colgroup>
            <col style={{ width: '7%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '14%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th><SortHead column="customer_id" {...SORTABLE.customer_id} sort={sort} order={order} onSort={sortBy} /></th>
              <th><SortHead column="name" {...SORTABLE.name} sort={sort} order={order} onSort={sortBy} /></th>
              <th>เพศ / อายุ</th>
              <th>เบอร์โทร</th>
              <th>จำนวนเคส</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr
                key={c.customer_id}
                className="row-clickable"
                tabIndex={0}
                onClick={() => openCustomer(c.customer_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openCustomer(c.customer_id);
                  }
                }}
              >
                {/* ลำดับนับต่อเนื่องข้ามหน้า — เป็นลำดับของ "รายการที่เห็นตอนนี้" ไม่ใช่เลขประจำตัว */}
                <td className="row-index" data-label="ลำดับ">{(page - 1) * Number(perPage) + i + 1}</td>
                <td className="mono link" data-label="รหัส">{c.customer_id}</td>
                <td data-label="ชื่อ" title={[c.name, c.nickname && `(${c.nickname})`].filter(Boolean).join(" ")}>
                  {c.name}
                  {c.nickname && <span className="muted"> ({c.nickname})</span>}
                </td>
                <td data-label="เพศ / อายุ">
                  {[GENDER_LABELS[c.gender], c.age != null && `${c.age} ปี`].filter(Boolean).join(' / ') || (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label="เบอร์โทร">
                  {c.phone ? (
                    // stopPropagation กันไม่ให้การกดเบอร์เปิด popup ตามไปด้วย
                    <a className="link mono" href={`tel:${c.phone}`} onClick={(e) => e.stopPropagation()}>
                      {c.phone}
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label="จำนวนเคส">
                  {c.case_count === 0 ? <span className="muted">ยังไม่มีเคส</span> : `${c.case_count} เคส`}
                </td>
              </tr>
            ))}

            {/* โหลดครั้งแรกยังไม่มีข้อมูลเลย — ต้องบอกว่ากำลังโหลด ไม่ใช่ปล่อยตารางว่างเงียบๆ
                (ถ้ามีข้อมูลเก่าอยู่แล้ว คงไว้ให้อ่านต่อระหว่างโหลดรอบใหม่ ไม่ให้จอกระพริบ) */}
            {loading && rows.length === 0 && (
              <tr><td colSpan={6} className="empty">กำลังโหลด…</td></tr>
            )}

            {/* error มีแถบของตัวเองอยู่แล้ว — ไม่ต้องบอกซ้ำว่า "ไม่มีข้อมูล" ทั้งที่จริงๆ คือโหลดไม่สำเร็จ */}
            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {filtered ? (
                    <>
                      ไม่พบลูกค้าที่ตรงกับเงื่อนไข{' '}
                      <button className="btn link-btn" onClick={clearFilters}>ล้างตัวกรอง</button>
                    </>
                  ) : (
                    <>
                      ยังไม่มีลูกค้าในระบบ{' '}
                      <Link className="link" to="/customers/new">เพิ่มรายแรก →</Link>
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
        <CustomerModal
          customerId={openId}
          siblings={visibleIds}
          onNavigate={(id) => patch({ open: id })}
          onChanged={() => setReloadKey((k) => k + 1)}
          onClose={closeCustomer}
        />
      )}
    </>
  );
}
