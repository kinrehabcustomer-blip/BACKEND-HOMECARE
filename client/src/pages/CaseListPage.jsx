import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import CaseModal from '../components/CaseModal.jsx';
import SortHead from '../components/SortHead.jsx';
import {
  CASE_TYPE_LABELS, CASE_STATUS_LABELS, MONTH_LABELS,
  formatBaht, formatDate, formatPeriod, toBuddhistYear,
} from '../labels.js';

const PER_PAGE_OPTIONS = [20, 50, 100];

// คอลัมน์ที่กดเรียงได้ — ต้องตรงกับ enum ของ sort ฝั่ง server (cases/schema.js)
// title ของเคสถูกตั้งอัตโนมัติเป็น "บริการ · ชื่อผู้ป่วย" การเรียงตาม title จึงคือการเรียงตามบริการ
const SORTABLE = {
  case_id: { label: 'รหัสเคส', hint: 'เรียงตามลำดับที่เปิดเคส' },
  title: { label: 'บริการ / ลูกค้า', hint: 'เรียงตามชื่อบริการ' },
  start_date: { label: 'เริ่ม / ค่าจ้าง', hint: 'เรียงตามวันเริ่มให้บริการ' },
};

const DEFAULTS = { sort: 'case_id', order: 'desc', per_page: '20', page: '1' };

export default function CaseListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [periods, setPeriods] = useState([]);
  const [staff, setStaff] = useState([]);
  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0); // เด้งค่าเพื่อดึงรายการใหม่หลังแก้ไขใน popup

  // เราเป็นคนเปิด popup เองหรือเปล่า — ใช้ตัดสินว่าตอนปิดควรถอยประวัติ (back) หรือลบพารามิเตอร์ทิ้ง
  const pushedOpen = useRef(false);

  /* สถานะของหน้าทั้งหมดอยู่ใน URL ที่เดียว — เดิมอ่านค่าจาก URL ได้แต่ไม่เขียนกลับ
     ตัวกรองที่ผู้ใช้เลือกเองจึงหายทุกครั้งที่รีเฟรช และปุ่มย้อนกลับพาออกจากหน้าแทนที่จะปิด popup */
  const get = (key) => params.get(key) ?? DEFAULTS[key] ?? '';
  const q = get('q');
  const status = CASE_STATUS_LABELS[get('status')] ? get('status') : '';
  const caseType = CASE_TYPE_LABELS[get('case_type')] ? get('case_type') : '';
  const assignedTo = get('assigned_to');
  const year = /^\d{4}$/.test(get('year')) ? get('year') : '';
  // เดือนที่ไม่มีปีกำกับไม่มีความหมาย (พฤษภาคมของปีไหน?) — ตัดทิ้งตั้งแต่ตอนอ่าน
  const month = year && /^(0[1-9]|1[0-2])$/.test(get('month')) ? get('month') : '';
  const sort = SORTABLE[get('sort')] ? get('sort') : DEFAULTS.sort;
  const order = get('order') === 'asc' ? 'asc' : 'desc';
  const perPage = PER_PAGE_OPTIONS.includes(Number(get('per_page'))) ? get('per_page') : DEFAULTS.per_page;
  const page = Math.max(1, Number(get('page')) || 1);
  const openId = params.get('open');

  const filtered = Boolean(q || status || caseType || assignedTo || year);

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
  // เปลี่ยนปีแล้วล้างเดือนทิ้ง — เดือนเดิมอาจไม่มีข้อมูลในปีใหม่
  const setFilter = (key, value) =>
    patch({ [key]: value, page: '1', ...(key === 'year' ? { month: '' } : null) });
  const sortBy = (s, o) => patch({ sort: s, order: o, page: '1' });
  const clearFilters = () =>
    patch({ q: '', status: '', case_type: '', assigned_to: '', year: '', month: '', page: '1' });

  useEffect(() => {
    api.casePeriods().then(setPeriods).catch(() => {});
    api.assignableEmployees().then(setStaff).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // หน่วงเล็กน้อยระหว่างพิมพ์ค้นหา จะได้ไม่ยิง API ทุกตัวอักษร
    const timer = setTimeout(() => {
      const query = Object.fromEntries(
        Object.entries({
          q, status, case_type: caseType, assigned_to: assignedTo, year, month,
          page, per_page: perPage, sort, order,
        }).filter(([, v]) => v !== '' && v != null),
      );

      api
        .listCases(query)
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
  }, [q, status, caseType, assignedTo, year, month, page, perPage, sort, order, reloadKey]);

  // ยอดสรุปด้านบนต้องนับเฉพาะช่วงเวลาที่กรองอยู่ ไม่งั้นตัวเลขจะไม่ตรงกับรายการที่เห็น
  useEffect(() => {
    api.caseSummary({ year, month }).then(setSummary).catch(() => {});
  }, [result, year, month]);

  // popup ถูกปิดด้วยปุ่มย้อนกลับของเบราว์เซอร์ — ประวัติที่เรา push ไว้ถูกใช้ไปแล้ว ต้องล้างธงทิ้ง
  useEffect(() => {
    if (!openId) pushedOpen.current = false;
  }, [openId]);

  const openCase = (id) => {
    pushedOpen.current = true;
    patch({ open: id }, { push: true }); // push เพื่อให้ปุ่มย้อนกลับ/ปัดกลับบนมือถือ = ปิด popup
  };

  const closeCase = () => {
    // เปิดเองในหน้านี้ → ถอยประวัติกลับไปสถานะก่อนเปิด
    // เข้ามาจากลิงก์ที่มี ?open=... อยู่แล้ว → ถอยจะหลุดออกจากแอป จึงลบพารามิเตอร์ทิ้งแทน
    if (pushedOpen.current) {
      pushedOpen.current = false;
      navigate(-1);
    } else {
      patch({ open: '' });
    }
  };

  const monthsOfYear = periods.find((p) => p.year === year)?.months ?? [];
  const count = (s) => summary?.by_status.find((x) => x.status === s)?.count ?? 0;

  const rows = result?.data ?? [];
  const visibleIds = rows.map((c) => c.case_id);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>เคส</h1>
          <p className="muted">
            {summary
              ? `${year ? `เปิดใน${formatPeriod(year, month)} · ` : ''}ทั้งหมด ${summary.total} เคส · ยังไม่จับคู่ ${count('unassigned')} · จับคู่แล้ว ${count('assigned')} · กำลังให้บริการ ${count('in_progress')} · ปิดแล้ว ${count('closed')}`
              : ' '}
          </p>
        </div>
        <Link className="btn primary" to="/cases/new">+ เปิดเคสใหม่</Link>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="ค้นหา รหัสเคส / แพ็คเกจ / ชื่อผู้ป่วย / เบอร์โทร"
          value={q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={year} onChange={(e) => setFilter('year', e.target.value)} aria-label="ปี">
          <option value="">ทุกปี</option>
          {periods.map((p) => (
            <option key={p.year} value={p.year}>ปี {toBuddhistYear(p.year)} ({p.count})</option>
          ))}
        </select>
        {/* เลือกเดือนไม่ได้จนกว่าจะเลือกปี — "พฤษภาคม" ของปีไหนไม่มีคำตอบ */}
        <select
          value={month}
          onChange={(e) => setFilter('month', e.target.value)}
          disabled={!year}
          aria-label="เดือน"
          title={year ? undefined : 'เลือกปีก่อน'}
        >
          <option value="">{year ? 'ทั้งปี' : 'ทุกเดือน'}</option>
          {monthsOfYear.map((m) => (
            <option key={m.month} value={m.month}>{MONTH_LABELS[m.month]} ({m.count})</option>
          ))}
        </select>
        <select value={caseType} onChange={(e) => setFilter('case_type', e.target.value)} aria-label="ประเภท">
          <option value="">ทุกประเภท</option>
          {Object.entries(CASE_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setFilter('status', e.target.value)} aria-label="สถานะ">
          <option value="">ทุกสถานะ</option>
          {Object.entries(CASE_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {/* "เคสของคนนี้" เป็นคำถามที่ถามบ่อย — server รองรับ assigned_to อยู่แล้ว แค่ไม่เคยมีช่องให้เลือก */}
        <select value={assignedTo} onChange={(e) => setFilter('assigned_to', e.target.value)} aria-label="พนักงานที่รับ">
          <option value="">พนักงานทุกคน</option>
          {staff.map((e) => (
            <option key={e.employee_id} value={e.employee_id}>
              {e.first_name} {e.last_name}
            </option>
          ))}
        </select>
        {/* โผล่เฉพาะตอนมีอะไรกรองอยู่ — ปุ่มที่กดแล้วไม่เกิดอะไรขึ้นไม่ควรมีให้เห็น */}
        {filtered && <button className="btn" onClick={clearFilters}>ล้างตัวกรอง</button>}
      </div>

      {/* error เป็นแถบเหนือตาราง ไม่ทับทั้งหน้า — ตัวกรองที่ตั้งไว้ต้องไม่หายไปเพราะเน็ตสะดุด */}
      {error && <p className="error">{error}</p>}

      {/* จอแคบ: ให้ตารางเลื่อนแนวนอนในกล่องของตัวเอง ไม่ดันทั้งหน้าให้เลื่อนตาม */}
      <div className="table-wrap">
        <table className="table table-cards table-2line table-indexed">
          <colgroup>
            {/* สถานะกว้าง 16% เพราะป้ายที่ยาวที่สุด ("ยังไม่จับคู่พนักงาน") ต้องการ 139px
                ที่ 13% บนจอ 1280/1440 ได้ไม่ถึง แล้วป้ายโดน … ตัดจนอ่านไม่ออกว่าเคสอยู่สถานะไหน
                ที่ยืมมาคือคอลัมน์บริการ ซึ่งเป็นข้อความอิสระ ตัดท้ายแล้วยังเดาความได้ */}
            <col style={{ width: '6%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '23%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '16%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th><SortHead column="case_id" {...SORTABLE.case_id} sort={sort} order={order} onSort={sortBy} /></th>
              <th><SortHead column="title" {...SORTABLE.title} sort={sort} order={order} onSort={sortBy} /></th>
              <th><SortHead column="start_date" {...SORTABLE.start_date} sort={sort} order={order} onSort={sortBy} /></th>
              <th>เบอร์โทร</th>
              <th>พนักงานที่รับ</th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr
                key={c.case_id}
                className="row-clickable"
                tabIndex={0}
                onClick={() => openCase(c.case_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openCase(c.case_id);
                  }
                }}
              >
                {/* ลำดับนับต่อเนื่องข้ามหน้า — เป็นลำดับของ "รายการที่เห็นตอนนี้" ไม่ใช่เลขประจำตัว */}
                <td className="row-index" data-label="ลำดับ">{(page - 1) * Number(perPage) + i + 1}</td>
                <td className="mono link" data-label="รหัสเคส">{c.case_id}</td>
                <td data-label="บริการ">
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
                <td data-label="เริ่ม / ค่าจ้าง">
                  {c.start_date ? formatDate(c.start_date) : <span className="muted">ยังไม่ระบุ</span>}
                  {c.fee != null && <span className="cell-sub">{formatBaht(c.fee)}</span>}
                </td>
                <td data-label="เบอร์โทร">
                  {c.client_phone ? (
                    // stopPropagation กันไม่ให้การกดเบอร์เปิด popup ตามไปด้วย
                    <a className="link mono" href={`tel:${c.client_phone}`} onClick={(e) => e.stopPropagation()}>
                      {c.client_phone}
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label="พนักงานที่รับ">
                  {c.assigned_name ?? <span className="muted">—</span>}
                  {c.assigned_to && <span className="cell-sub mono">{c.assigned_to}</span>}
                </td>
                <td data-label="สถานะ">
                  <span className={`badge case-${c.status}`}>{CASE_STATUS_LABELS[c.status]}</span>
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
                      ไม่พบเคสที่ตรงกับเงื่อนไข{' '}
                      <button className="btn link-btn" onClick={clearFilters}>ล้างตัวกรอง</button>
                    </>
                  ) : (
                    <>
                      ยังไม่มีเคสในระบบ{' '}
                      <Link className="link" to="/cases/new">เปิดเคสแรก →</Link>
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
        <CaseModal
          caseId={openId}
          siblings={visibleIds}
          onNavigate={(id) => patch({ open: id })}
          onChanged={() => setReloadKey((k) => k + 1)}
          onClose={closeCase}
        />
      )}
    </>
  );
}
