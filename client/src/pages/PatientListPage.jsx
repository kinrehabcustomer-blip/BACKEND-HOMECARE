import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import PatientModal from '../components/PatientModal.jsx';
import SortHead from '../components/SortHead.jsx';
import { GENDER_LABELS, PATIENT_STATUS_LABELS, ageFromBirthDate } from '../labels.js';

const PER_PAGE_OPTIONS = [20, 50, 100];

// คอลัมน์ที่กดเรียงได้ — ต้องตรงกับ enum ของ sort ฝั่ง server (patients/schema.js)
// จำนวนเคสเรียงไม่ได้ เพราะเป็นค่าที่นับมาตอน SELECT ไม่ใช่คอลัมน์จริงในตาราง
const SORTABLE = {
  patient_id: { label: 'รหัส', hint: 'เรียงตามลำดับที่เพิ่มเข้าระบบ' },
  name: { label: 'ชื่อ', hint: 'เรียงตามชื่อ' },
};

const DEFAULTS = { sort: 'patient_id', order: 'desc', per_page: '20', page: '1' };

export default function PatientListPage() {
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
  const status = PATIENT_STATUS_LABELS[get('status')] ? get('status') : '';
  const hasCustomer = ['yes', 'no'].includes(get('has_customer')) ? get('has_customer') : '';
  const customerId = get('customer_id'); // มาจากลิงก์ "ดูผู้รับการดูแลของลูกค้ารายนี้"
  const sort = SORTABLE[get('sort')] ? get('sort') : DEFAULTS.sort;
  const order = get('order') === 'asc' ? 'asc' : 'desc';
  const perPage = PER_PAGE_OPTIONS.includes(Number(get('per_page'))) ? get('per_page') : DEFAULTS.per_page;
  const page = Math.max(1, Number(get('page')) || 1);
  const openId = params.get('open');

  const filtered = Boolean(q || status || hasCustomer || customerId);

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
  const clearFilters = () => patch({ q: '', status: '', has_customer: '', customer_id: '', page: '1' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // หน่วงเล็กน้อยระหว่างพิมพ์ค้นหา จะได้ไม่ยิง API ทุกตัวอักษร
    const timer = setTimeout(() => {
      const query = Object.fromEntries(
        Object.entries({
          q, status, has_customer: hasCustomer, customer_id: customerId,
          page, per_page: perPage, sort, order,
        }).filter(([, v]) => v !== '' && v != null),
      );

      api
        .listPatients(query)
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
  }, [q, status, hasCustomer, customerId, page, perPage, sort, order, reloadKey]);

  // popup ถูกปิดด้วยปุ่มย้อนกลับของเบราว์เซอร์ — ประวัติที่เรา push ไว้ถูกใช้ไปแล้ว ต้องล้างธงทิ้ง
  useEffect(() => {
    if (!openId) pushedOpen.current = false;
  }, [openId]);

  const openPatient = (id) => {
    pushedOpen.current = true;
    patch({ open: id }, { push: true }); // push เพื่อให้ปุ่มย้อนกลับ/ปัดกลับบนมือถือ = ปิด popup
  };

  const closePatient = () => {
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
  const visibleIds = rows.map((p) => p.patient_id);

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
          placeholder="ค้นหา รหัส / ชื่อ / ชื่อเล่น / ชื่ออังกฤษ / เลขบัตร"
          value={q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {Object.entries(PATIENT_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <select value={hasCustomer} onChange={(e) => setFilter('has_customer', e.target.value)}>
          <option value="">ผู้ว่าจ้าง: ทั้งหมด</option>
          <option value="yes">ผูกลูกค้าแล้ว</option>
          <option value="no">ยังไม่ผูกลูกค้า</option>
        </select>
        {/* โผล่เฉพาะตอนมีอะไรกรองอยู่ — ปุ่มที่กดแล้วไม่เกิดอะไรขึ้นไม่ควรมีให้เห็น */}
        {filtered && <button className="btn" onClick={clearFilters}>ล้างตัวกรอง</button>}
      </div>

      {/* กรองมาจากลิงก์ของลูกค้ารายหนึ่ง — ต้องบอกให้เห็น ไม่งั้นคนอ่านนึกว่านี่คือทั้งระบบ */}
      {customerId && (
        <p className="notice filter-chip">
          แสดงเฉพาะผู้รับการดูแลของ <strong className="mono">{customerId}</strong>
          <button className="btn link-btn" onClick={() => setFilter('customer_id', '')}>แสดงทั้งหมด</button>
        </p>
      )}

      {/* error เป็นแถบเหนือตาราง ไม่ทับทั้งหน้า — คำค้นที่พิมพ์ไว้ต้องไม่หายไปเพราะเน็ตสะดุด */}
      {error && <p className="error">{error}</p>}

      <div className="table-wrap">
        <table className="table table-cards table-indexed">
          <colgroup>
            <col style={{ width: '6%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '25%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '21%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '10%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th><SortHead column="patient_id" {...SORTABLE.patient_id} sort={sort} order={order} onSort={sortBy} /></th>
              <th><SortHead column="name" {...SORTABLE.name} sort={sort} order={order} onSort={sortBy} /></th>
              <th>เพศ / อายุ</th>
              <th>ผู้ว่าจ้าง</th>
              <th>สถานะ</th>
              <th>เคส</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => {
              const age = ageFromBirthDate(p.birth_date) ?? p.age;
              return (
                <tr
                  key={p.patient_id}
                  className="row-clickable"
                  tabIndex={0}
                  onClick={() => openPatient(p.patient_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openPatient(p.patient_id);
                    }
                  }}
                >
                  {/* ลำดับนับต่อเนื่องข้ามหน้า — เป็นลำดับของ "รายการที่เห็นตอนนี้" ไม่ใช่เลขประจำตัว */}
                  <td className="row-index" data-label="ลำดับ">{(page - 1) * Number(perPage) + i + 1}</td>
                  <td className="mono link" data-label="รหัส">{p.patient_id}</td>
                  <td data-label="ชื่อ">
                    {p.name}
                    {p.nickname && <span className="muted"> ({p.nickname})</span>}
                    {/* การแพ้เป็นข้อมูลอันตรายที่สุดในหน้านี้ — ต้องเห็นตั้งแต่ตอนกวาดตาดูรายชื่อ
                        ไม่ใช่ต้องเปิด popup ก่อนถึงจะรู้ · ไอคอน + ข้อความเต็มใน title ไม่ใช้สีอย่างเดียว
                        แยกสองป้าย เพราะคนละคนที่ต้องรู้ (คนให้ยา vs คนเตรียมอาหาร) */}
                    {p.allergies && (
                      <span className="allergy-flag" title={`แพ้ยา: ${p.allergies}`}>⚠ แพ้ยา</span>
                    )}
                    {p.food_allergies && (
                      <span className="allergy-flag food" title={`แพ้อาหาร: ${p.food_allergies}`}>⚠ แพ้อาหาร</span>
                    )}
                  </td>
                  <td data-label="เพศ / อายุ">
                    {[GENDER_LABELS[p.gender], age != null && `${age} ปี`].filter(Boolean).join(' / ') || (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="ผู้ว่าจ้าง">
                    {p.customer_name ? (
                      <>
                        {/* stopPropagation กันไม่ให้การกดลิงก์เปิด popup ผู้รับการดูแลตามไปด้วย */}
                        <Link
                          className="link"
                          to={`/customers?open=${p.customer_id}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.customer_name}
                        </Link>
                        {p.customer_phone && (
                          <span className="cell-sub">
                            <a className="link mono" href={`tel:${p.customer_phone}`} onClick={(e) => e.stopPropagation()}>
                              {p.customer_phone}
                            </a>
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">— ยังไม่ผูกลูกค้า —</span>
                    )}
                  </td>
                  <td data-label="สถานะ">
                    <span className={`badge ${p.status}`}>{PATIENT_STATUS_LABELS[p.status]}</span>
                  </td>
                  <td data-label="เคส">
                    {p.case_count === 0 ? <span className="muted">—</span> : `${p.case_count} เคส`}
                  </td>
                </tr>
              );
            })}

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
                      ไม่พบผู้รับการดูแลที่ตรงกับเงื่อนไข{' '}
                      <button className="btn link-btn" onClick={clearFilters}>ล้างตัวกรอง</button>
                    </>
                  ) : (
                    <>
                      ยังไม่มีผู้รับการดูแลในระบบ{' '}
                      <Link className="link" to="/patients/new">เพิ่มรายแรก →</Link>
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
        <PatientModal
          patientId={openId}
          siblings={visibleIds}
          onNavigate={(id) => patch({ open: id })}
          onChanged={() => setReloadKey((k) => k + 1)}
          onClose={closePatient}
        />
      )}
    </>
  );
}
