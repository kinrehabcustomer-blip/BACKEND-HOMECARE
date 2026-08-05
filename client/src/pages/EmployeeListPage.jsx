import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import EmployeeModal from '../components/EmployeeModal.jsx';
import SortHead from '../components/SortHead.jsx';
import Avatar from '../components/Avatar.jsx';
import { POSITION_LABELS, STATUS_LABELS, EMPLOYMENT_TYPE_LABELS } from '../labels.js';

const PER_PAGE_OPTIONS = [20, 50, 100];

// คอลัมน์ที่กดเรียงได้ — ต้องตรงกับ enum ของ sort ฝั่ง server (employees/schema.js)
// ไม่มี hire_date เพราะวันเริ่มงานไม่ได้อยู่ในตารางแล้ว (ย้ายไปดูในประวัติพนักงาน)
// ลิงก์เก่าที่มี ?sort=hire_date จะตกกลับไปใช้ค่าปริยาย ไม่พัง
const SORTABLE = {
  employee_id: { label: 'รหัสพนักงาน', hint: 'เรียงตามลำดับที่เพิ่มเข้าระบบ' },
  first_name: { label: 'ชื่อ-นามสกุล', hint: 'เรียงตามชื่อ' },
};

const DEFAULTS = { sort: 'employee_id', order: 'desc', per_page: '20', page: '1' };

export default function EmployeeListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0); // เด้งค่าเพื่อดึงรายการใหม่หลังแก้ด่วนใน popup

  // เราเป็นคนเปิด popup เองหรือเปล่า — ใช้ตัดสินว่าตอนปิดควรถอยประวัติ (back) หรือลบพารามิเตอร์ทิ้ง
  const pushedOpen = useRef(false);

  /* สถานะของหน้าทั้งหมดอยู่ใน URL ที่เดียว (เหมือน CaseListPage) — รีเฟรชแล้วยังอยู่ที่เดิม
     ส่งลิงก์ให้คนอื่นได้ และปุ่มย้อนกลับของเบราว์เซอร์ปิด popup แทนที่จะเด้งออกจากหน้า */
  const get = (key) => params.get(key) ?? DEFAULTS[key] ?? '';
  const q = get('q');
  const status = get('status');
  const position = get('position');
  const sort = SORTABLE[get('sort')] ? get('sort') : DEFAULTS.sort;
  const order = get('order') === 'asc' ? 'asc' : 'desc';
  const perPage = PER_PAGE_OPTIONS.includes(Number(get('per_page'))) ? get('per_page') : DEFAULTS.per_page;
  const page = Math.max(1, Number(get('page')) || 1);
  const openId = params.get('open');

  const filtered = Boolean(q || status || position);

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // หน่วงเล็กน้อยระหว่างพิมพ์ค้นหา จะได้ไม่ยิง API ทุกตัวอักษร
    const timer = setTimeout(() => {
      const query = Object.fromEntries(
        Object.entries({ q, status, position, page, per_page: perPage, sort, order })
          .filter(([, v]) => v !== '' && v != null),
      );

      api
        .listEmployees(query)
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
  }, [q, status, position, page, perPage, sort, order, reloadKey]);

  useEffect(() => {
    api.summary().then(setSummary).catch(() => {});
  }, [result]);

  // popup ถูกปิดด้วยปุ่มย้อนกลับของเบราว์เซอร์ — ประวัติที่เรา push ไว้ถูกใช้ไปแล้ว ต้องล้างธงทิ้ง
  useEffect(() => {
    if (!openId) pushedOpen.current = false;
  }, [openId]);

  const openEmployee = (id) => {
    pushedOpen.current = true;
    patch({ open: id }, { push: true }); // push เพื่อให้ปุ่มย้อนกลับ/ปัดกลับบนมือถือ = ปิด popup
  };

  const closeEmployee = () => {
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
  // รายชื่อของหน้านี้ ใช้ทำปุ่มดูคนก่อนหน้า/ถัดไปใน popup
  const visibleIds = rows.map((r) => r.employee_id);

  const activeCount = summary?.by_status.find((s) => s.status === 'active')?.count ?? 0;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>พนักงาน</h1>
          <p className="muted">
            {summary ? `ทั้งหมด ${summary.total} คน · ทำงานอยู่ ${activeCount} คน` : ' '}
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
          value={q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={position} onChange={(e) => setFilter('position', e.target.value)}>
          <option value="">ทุกตำแหน่ง</option>
          {Object.entries(POSITION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {/* โผล่เฉพาะตอนมีอะไรกรองอยู่ — ปุ่มที่กดแล้วไม่เกิดอะไรขึ้นไม่ควรมีให้เห็น */}
        {filtered && (
          <button className="btn" onClick={() => patch({ q: '', status: '', position: '', page: '1' })}>
            ล้างตัวกรอง
          </button>
        )}
      </div>

      {/* error เป็นแถบเหนือตาราง ไม่ทับทั้งหน้า — คำค้นและตัวกรองที่ตั้งไว้ต้องไม่หายไปเพราะเน็ตสะดุด */}
      {error && <p className="error">{error}</p>}

      {/* จอแคบ: ให้ตารางเลื่อนแนวนอนในกล่องของตัวเอง ไม่ดันทั้งหน้าให้เลื่อนตาม */}
      <div className="table-wrap">
        <table className="table table-cards table-2line table-indexed">
          {/* ตรึงความกว้างคอลัมน์ไว้ ไม่ให้ตารางขยับตามความยาวชื่อของแต่ละแถว */}
          <colgroup>
            <col style={{ width: '7%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '29%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '15%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th><SortHead column="employee_id" {...SORTABLE.employee_id} sort={sort} order={order} onSort={sortBy} /></th>
              <th><SortHead column="first_name" {...SORTABLE.first_name} sort={sort} order={order} onSort={sortBy} /></th>
              <th>เบอร์โทร</th>
              <th>ตำแหน่ง</th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((emp, i) => (
              <tr
                key={emp.employee_id}
                className="row-clickable"
                tabIndex={0}
                onClick={() => openEmployee(emp.employee_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openEmployee(emp.employee_id);
                  }
                }}
              >
                {/* ลำดับนับต่อเนื่องข้ามหน้า — หน้า 2 เริ่มที่ 21 ไม่ใช่ 1
                    เป็นลำดับของ "รายการที่เห็นตอนนี้" จึงเปลี่ยนตามการเรียง/ตัวกรอง ไม่ใช่เลขประจำตัว */}
                <td className="row-index" data-label="ลำดับ">{(page - 1) * Number(perPage) + i + 1}</td>
                <td className="mono link" data-label="รหัส">{emp.employee_id}</td>
                <td data-label="ชื่อ">
                  <span className="name-cell">
                    <Avatar employee={emp} />
                    <span>
                      {emp.first_name} {emp.last_name}
                      {emp.nickname && <span className="muted"> ({emp.nickname})</span>}
                    </span>
                  </span>
                </td>
                <td data-label="เบอร์โทร">
                  {emp.phone ? (
                    // stopPropagation กันไม่ให้การกดเบอร์เปิด popup ตามไปด้วย
                    <a className="link mono" href={`tel:${emp.phone}`} onClick={(e) => e.stopPropagation()}>
                      {emp.phone}
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label="ตำแหน่ง">
                  {POSITION_LABELS[emp.position]}
                  <span className="cell-sub">{EMPLOYMENT_TYPE_LABELS[emp.employment_type]}</span>
                </td>
                <td data-label="สถานะ">
                  <span className={`badge ${emp.status}`}>{STATUS_LABELS[emp.status]}</span>
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
                      ไม่พบพนักงานที่ตรงกับเงื่อนไข{' '}
                      <button className="btn link-btn" onClick={() => patch({ q: '', status: '', position: '', page: '1' })}>
                        ล้างตัวกรอง
                      </button>
                    </>
                  ) : (
                    <>
                      ยังไม่มีพนักงานในระบบ{' '}
                      <Link className="link" to="/employees/new">เพิ่มคนแรก →</Link>
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
        <EmployeeModal
          employeeId={openId}
          siblings={visibleIds}
          onNavigate={(id) => patch({ open: id })}
          onSaved={() => setReloadKey((k) => k + 1)}
          onClose={closeEmployee}
        />
      )}
    </>
  );
}
