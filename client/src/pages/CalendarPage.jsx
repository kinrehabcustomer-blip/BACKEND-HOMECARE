import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import CaseModal from '../components/CaseModal.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import {
  CASE_TYPE_LABELS, MONTH_LABELS, POSITION_LABELS, SERVICE_KIND_LABELS, VISIT_STATE_LABELS,
  formatDate, toBuddhistYear,
} from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';
import PageRefresh from '../components/PageRefresh.jsx';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/**
 * จำนวนกะที่ช่องหนึ่งวันในมุมมอง "เดือน" แสดงได้พอดี ที่เหลือยุบเป็นปุ่ม "+N"
 *
 * เดิมงานส่วนเกินถูกซ่อนไว้หลังการเลื่อนภายในกล่องสูง 86px ที่แทบไม่มีใครรู้ว่าเลื่อนได้
 * วันที่มี 8 กะจึงเห็นแค่ 3 อีก 5 หายไปเงียบๆ ไม่มีอะไรบอกว่ายังมีอยู่
 * (บนมือถือช่องยืดตามเนื้อหา เลยเห็นครบทุกกะมาตลอด — ยกท่านั้นมาทำให้ PC รู้ตัวบ้าง)
 * ตัวเลขนี้ต้องตรงกับ .cal-chips > .cal-chip:nth-child(n + 3) ใน index.css
 */
const MONTH_VISIBLE = 2;

// สถานะกะที่ขึ้นบนปฏิทินได้จริง (ยกเลิกถูกตัดออกตั้งแต่ฝั่ง server)
const CAL_STATES = ['scheduled', 'working', 'done', 'stale', 'missed'];

/**
 * สายบริการของเคส — เคสที่เปิดก่อนมีระบบสองสายยังมี service_kind เป็น null
 * จึงดูจากแพ็คเกจกายภาพที่ผูกไว้จริงด้วย (กติกาเดียวกับ CaseModal/MyCaseModal)
 * ไม่ระบุอะไรเลยถือเป็น Homecare — ระบบกะ/วันนัดเป็นของฝั่ง Homecare อยู่แล้ว
 */
const kindOf = (c) => (c.service_kind === 'physio' || c.physio_package_id != null ? 'physio' : 'homecare');

/** 'YYYY-MM-DD' จากตัวเลขปี/เดือน/วัน — ประกอบเองไม่ผ่าน toISOString เพราะตัวนั้นแปลงเป็น UTC แล้ววันเพี้ยน */
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const isoOf = (date) => iso(date.getFullYear(), date.getMonth() + 1, date.getDate());
const todayISO = () => isoOf(new Date());

/**
 * ป้ายวันแบบอ่านออกได้ด้วยตัวเอง — 'พฤ. 13 ส.ค.'
 *
 * ใช้ในโหมดรายการบนมือถือ ซึ่งไม่มีหัวคอลัมน์วันในสัปดาห์และไม่มีวันข้างๆ ให้เทียบแล้ว
 * เห็นเลข "13" ลอยอยู่ในกล่องจึงบอกอะไรไม่ได้เลยว่าเป็นวันอะไร
 */
const dayLabel = (key) =>
  new Date(`${key}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });

/** ช่วงเวลานัดของกะ — เก็บเป็น 'HH:MM' อยู่แล้ว ไม่ต้องแปลงโซนเวลา */
const timeRange = (v) =>
  v.planned_start ? `${v.planned_start}${v.planned_end ? `–${v.planned_end}` : ''}` : null;

export default function CalendarPage() {
  const [params, setParams] = useSearchParams();

  const [visits, setVisits] = useState(null);
  const [unscheduled, setUnscheduled] = useState([]);
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const get = (key) => params.get(key) ?? '';
  const view = get('view') === 'week' ? 'week' : 'month';
  // วันอ้างอิงจุดเดียว — มุมมองเดือนใช้ปี/เดือนของมัน มุมมองสัปดาห์ใช้สัปดาห์ที่มันอยู่
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(get('date')) ? get('date') : todayISO();
  const employeeId = get('employee_id');
  const kind = SERVICE_KIND_LABELS[get('kind')] ? get('kind') : '';
  const state = CAL_STATES.includes(get('state')) ? get('state') : '';
  const openDay = /^\d{4}-\d{2}-\d{2}$/.test(get('day')) ? get('day') : '';
  const openId = get('open');

  const patch = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === '' || value == null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const anchorDate = new Date(`${anchor}T00:00:00`);
  const year = anchorDate.getFullYear();
  const month = anchorDate.getMonth() + 1;
  const mm = String(month).padStart(2, '0');
  const today = todayISO();

  // ช่วงวันที่แสดงอยู่ — มุมมองสัปดาห์เริ่มวันอาทิตย์ตามหัวตาราง
  const weekStart = new Date(anchorDate);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const days = useMemo(() => {
    if (view === 'week') {
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return isoOf(d);
      });
    }
    const total = new Date(year, month, 0).getDate();
    return Array.from({ length: total }, (_, i) => iso(year, month, i + 1));
  }, [view, anchor, year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.assignableEmployees().then(setStaff).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // สัปดาห์คาบสองเดือนได้ — ต้องโหลดทั้งสองเดือนแล้วรวมกัน ไม่งั้นครึ่งสัปดาห์หาย
    const months = [...new Set(days.map((d) => d.slice(0, 7)))];

    Promise.all(
      months.map((ym) => api.caseCalendar({ year: ym.slice(0, 4), month: ym.slice(5, 7), employee_id: employeeId })),
    )
      .then((chunks) => {
        if (cancelled) return; // ผลของเดือนเก่าที่มาถึงช้ากว่า ต้องไม่ทับเดือนที่กำลังดูอยู่
        setVisits(chunks.flat());
        setError(null); // สำเร็จแล้วต้องล้าง error ของรอบก่อน ไม่งั้นเน็ตสะดุดครั้งเดียวหน้าค้างเป็น error ตลอด
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [days, employeeId, reloadKey]);

  /* เคสที่รับงานแล้วแต่ยังไม่มีวันนัดในช่วงที่ดูอยู่ — เดิมหน้านี้บอกแค่ว่า "จะไม่ขึ้นบนปฏิทิน"
     แต่ไม่มีทางรู้ว่าเคสไหนบ้าง ทั้งที่นี่คือรายการที่ต้องลงนัดต่อ */
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listCases({ status: 'assigned', per_page: 100 }),
      api.listCases({ status: 'in_progress', per_page: 100 }),
    ])
      .then(([a, b]) => !cancelled && setUnscheduled([...a.data, ...b.data]))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reloadKey]);

  // กรองสายบริการ/สถานะกะในหน้าเว็บ ไม่ยิง API ใหม่ — ข้อมูลทั้งช่วงโหลดมาแล้ว สลับดูจึงเปลี่ยนทันที
  const shown = useMemo(
    () => (visits ?? []).filter((c) => (!kind || kindOf(c) === kind) && (!state || c.state === state)),
    [visits, kind, state],
  );

  const byDay = useMemo(() => {
    const map = new Map();
    for (const c of shown) {
      if (!map.has(c.visit_date)) map.set(c.visit_date, []);
      map.get(c.visit_date).push(c);
    }
    return map;
  }, [shown]);

  const scheduledCaseIds = useMemo(() => new Set((visits ?? []).map((v) => v.case_id)), [visits]);
  const needSchedule = unscheduled.filter((c) => !scheduledCaseIds.has(c.case_id));

  const selected = staff.find((s) => s.employee_id === employeeId);
  const filtered = Boolean(employeeId || kind || state);

  /** ขยับช่วงที่ดู — เดือนละก้าว หรือสัปดาห์ละก้าวตามมุมมอง */
  function shift(delta) {
    const d = new Date(anchorDate);
    if (view === 'week') d.setDate(d.getDate() + delta * 7);
    else d.setMonth(d.getMonth() + delta);
    patch({ date: isoOf(d) });
  }

  const rangeTitle =
    view === 'week'
      ? `${formatDate(days[0])} – ${formatDate(days[6])}`
      : `${MONTH_LABELS[mm]} ${toBuddhistYear(year)}`;

  return (
    <PageRefresh onRefresh={() => setReloadKey((k) => k + 1)} busy={loading}>
      <header className="page-head no-print">
        <div>
          <h1>ตารางงาน</h1>
          <p className="muted">
            {selected && <>ตารางของ <strong>{selected.first_name} {selected.last_name}</strong> · </>}
            {kind && <>เฉพาะ <strong>{SERVICE_KIND_LABELS[kind]}</strong> · </>}
            {state && <>เฉพาะ <strong>{VISIT_STATE_LABELS[state]}</strong> · </>}
            {view === 'week' ? 'สัปดาห์นี้' : 'เดือนนี้'}มี {shown.length} กะ
            {filtered && visits && visits.length !== shown.length && (
              <span className="muted"> (จากทั้งหมด {visits.length})</span>
            )}
          </p>
        </div>
        {/* cal-nav — ปุ่มเลื่อนช่วงเวลา ไม่ใช่ปุ่มสั่งงานหลักของหน้า
            บนมือถือปุ่มใน .actions ปกติจะยืดหารความกว้างกันจนเต็มบรรทัด ซึ่งใหญ่เกินหน้าที่ของมัน
            (ลูกศรตัวเดียวกินพื้นที่เท่าปุ่มบันทึก) และไม่เข้ากับแถบตัวกรองที่อยู่ใต้ลงมา */}
        <div className="actions cal-nav">
          <button className="btn" onClick={() => shift(-1)} aria-label={view === 'week' ? 'สัปดาห์ก่อนหน้า' : 'เดือนก่อนหน้า'}>←</button>
          <button className="btn" onClick={() => patch({ date: '' })}>วันนี้</button>
          <button className="btn" onClick={() => shift(1)} aria-label={view === 'week' ? 'สัปดาห์ถัดไป' : 'เดือนถัดไป'}>→</button>
        </div>
      </header>

      <div className="toolbar no-print">
        <span className="seg">
          <button className={view === 'month' ? 'on' : ''} onClick={() => patch({ view: '' })}>เดือน</button>
          <button className={view === 'week' ? 'on' : ''} onClick={() => patch({ view: 'week' })}>สัปดาห์</button>
        </span>

        <select value={employeeId} onChange={(e) => patch({ employee_id: e.target.value })} aria-label="เลือกพนักงาน">
          <option value="">พนักงานทุกคน</option>
          {staff.map((s) => (
            <option key={s.employee_id} value={s.employee_id}>
              {s.first_name} {s.last_name}
              {s.nickname ? ` (${s.nickname})` : ''} · {POSITION_LABELS[s.position]}
            </option>
          ))}
        </select>

        <select value={kind} onChange={(e) => patch({ kind: e.target.value })} aria-label="เลือกประเภทบริการ">
          <option value="">ทุกประเภทบริการ</option>
          {Object.entries(SERVICE_KIND_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>

        <select value={state} onChange={(e) => patch({ state: e.target.value })} aria-label="เลือกสถานะกะ">
          <option value="">ทุกสถานะกะ</option>
          {CAL_STATES.map((s) => <option key={s} value={s}>{VISIT_STATE_LABELS[s]}</option>)}
        </select>

        {filtered && (
          <button className="btn" onClick={() => patch({ employee_id: '', kind: '', state: '' })}>ล้างตัวกรอง</button>
        )}
        <button className="btn" onClick={() => window.print()}>
          <LineIcon name="printer" />พิมพ์
        </button>
      </div>

      {/* error เป็นแถบเหนือปฏิทิน ไม่ทับทั้งหน้า — ตัวกรองที่ตั้งไว้ต้องไม่หายเพราะเน็ตสะดุด */}
      {error && <p className="error no-print">{error}</p>}

      <h2 className="cal-title">
        {rangeTitle}
        {loading && <span className="muted"> · กำลังโหลด…</span>}
      </h2>

      {/* คำอธิบายสี — ชิปมี 5 สีตามสถานะกะ ไม่มีอะไรบอกก็เดาไม่ถูก */}
      <div className="cal-legend">
        {CAL_STATES.map((s) => (
          <span key={s} className="cal-legend-item">
            <i className={`cal-swatch visit-${s}`} aria-hidden="true" />
            {VISIT_STATE_LABELS[s]}
          </span>
        ))}
      </div>

      {!loading && shown.length === 0 && (
        <p className="notice no-print">
          {/* ว่างเพราะตัวกรอง กับ ว่างเพราะไม่มีงานจริง เป็นคนละเรื่อง — บอกให้ตรงเหตุ */}
          {filtered && visits?.length > 0
            ? `ช่วงนี้ไม่มีกะที่ตรงกับตัวกรอง (มีทั้งหมด ${visits.length} กะ)`
            : 'ไม่มีกะในช่วงนี้'}
        </p>
      )}

      {/* จอแคบ: ให้ปฏิทินเลื่อนแนวนอนในกล่องของตัวเอง ไม่ดันทั้งหน้าให้เลื่อนตาม */}
      <div className="table-wrap cal-print">
        <div className={`cal-grid ${view === 'week' ? 'is-week' : ''}`}>
          {WEEKDAYS.map((w) => <div key={w} className="cal-head">{w}</div>)}

          {/* ช่องว่างก่อนวันแรก — ให้คอลัมน์ตรงกับวันในสัปดาห์ (มุมมองสัปดาห์เริ่มวันอาทิตย์อยู่แล้ว) */}
          {view === 'month' &&
            Array.from({ length: new Date(year, month - 1, 1).getDay() }, (_, i) => (
              <div key={`pad-${i}`} className="cal-cell is-empty" />
            ))}

          {days.map((key) => {
            const list = byDay.get(key) ?? [];
            return (
              <div key={key} className={`cal-cell ${key === today ? 'is-today' : ''}`}>
                {/* กดหัววันเพื่อดูงานทั้งวันแบบเต็ม — ช่องในปฏิทินเล็กเกินกว่าจะใส่รายละเอียดครบ */}
                <button
                  type="button"
                  className="cal-date-btn"
                  onClick={() => patch({ day: key })}
                  title={`ดูงานของ ${formatDate(key)}`}
                >
                  <span className="cal-date">{Number(key.slice(8))}</span>
                  {/* สองอันนี้ใช้เฉพาะโหมดรายการบนมือถือ (CSS ซ่อนไว้ในโหมดตาราง)
                      ที่นั่นการ์ดหนึ่งใบต้องบอกตัวเองได้ครบว่าเป็นวันอะไร ไม่มีตารางรอบข้างให้เทียบ */}
                  <span className="cal-date-full">{dayLabel(key)}</span>
                  {key === today && <span className="cal-today-tag">วันนี้</span>}
                  {list.length > 0 && <span className="cal-count">{list.length}</span>}
                </button>

                {/* กะเยอะกว่าที่ช่องรับไหว = เลื่อนดูในช่องได้เลย ไม่ตัดทิ้ง
                    ในมุมมองเดือน CSS จะโชว์แค่ MONTH_VISIBLE ตัวแรก ที่เหลืออยู่หลังปุ่ม "+N" ด้านล่าง */}
                <div className="cal-chips">
                  {list.map((c) => (
                    <button
                      key={`v${c.visit_id}`}
                      type="button"
                      /* สีตามสถานะ "กะ" (เช็คอินแล้วหรือยัง) ไม่ใช่สถานะ "เคส" — คนดูตารางงาน
                         อยากรู้ว่ากะนี้เรียบร้อยไหม ไม่ใช่ว่าเคสอยู่ขั้นไหนของสัญญา */
                      className={`cal-chip visit-${c.state}`}
                      onClick={() => patch({ open: c.case_id })}
                      title={[
                        timeRange(c),
                        c.case_id,
                        SERVICE_KIND_LABELS[kindOf(c)],
                        CASE_TYPE_LABELS[c.case_type],
                        c.client_name,
                        c.assigned_name ?? 'ยังไม่จับคู่พนักงาน',
                        VISIT_STATE_LABELS[c.state],
                      ].filter(Boolean).join(' · ')}
                    >
                      {timeRange(c) && <span className="cal-chip-time">{timeRange(c)}</span>}
                      {c.assigned_name ?? '— ยังไม่จับคู่ —'}
                      <span className="cal-chip-sub">{c.client_name}</span>
                    </button>
                  ))}
                </div>

                {/* วันที่ไม่มีงานสักกะ — โหมดรายการบนมือถือยุบวันแบบนี้ทิ้งหมด ยกเว้น "วันนี้" ที่ต้องเห็นเสมอ
                    การ์ดที่มีแต่ตัวเลขวันกับที่ว่างอ่านเหมือนหน้าจอค้างหรือโหลดไม่เสร็จ
                    (CSS ซ่อนบรรทัดนี้ในโหมดตาราง — ที่นั่นช่องว่างทั้งเดือนจะกลายเป็นคำว่า "ไม่มีงาน" เต็มปฏิทิน) */}
                {list.length === 0 && <p className="cal-empty-day">ไม่มีงาน</p>}

                {/* บอกให้เห็นกับตาว่ายังมีงานอีกกี่กะที่ไม่ได้แสดง แล้วกดเปิดดูทั้งวันได้จากตรงนี้เลย
                    CSS ซ่อนปุ่มนี้ในมุมมองสัปดาห์และบนมือถือ ซึ่งช่องสูงพอจะแสดงครบอยู่แล้ว */}
                {list.length > MONTH_VISIBLE && (
                  <button type="button" className="cal-more" onClick={() => patch({ day: key })}>
                    +{list.length - MONTH_VISIBLE} งานที่เหลือ
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="muted cal-note no-print">
        ทุกเคส (ทั้ง <strong>Homecare</strong> และ <strong>กายภาพบำบัด</strong>) แสดงตาม
        <strong>วันนัดที่ลงไว้</strong>ในหน้าจัดการเคส — เคสที่ยังไม่ลงวันนัดจะไม่ขึ้นบนปฏิทิน
      </p>

      {needSchedule.length > 0 && (
        <details className="card no-print">
          <summary>เคสที่รับงานแล้วแต่ยังไม่มีวันนัด ({needSchedule.length})</summary>
          <ul className="todo">
            {needSchedule.map((c) => (
              <li key={c.case_id}>
                <div>
                  <strong>{c.title}</strong>
                  <p className="muted">
                    <span className="mono">{c.case_id}</span>
                    {' · '}{c.assigned_name ?? 'ยังไม่จับคู่'}
                    {' · '}{CASE_TYPE_LABELS[c.case_type]}
                  </p>
                </div>
                <button className="btn tiny" onClick={() => patch({ open: c.case_id })}>ลงวันนัด</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {openDay && (
        <DayPanel
          day={openDay}
          list={byDay.get(openDay) ?? []}
          onOpenCase={(id) => patch({ day: '', open: id })}
          onClose={() => patch({ day: '' })}
        />
      )}

      {openId && (
        <CaseModal
          caseId={openId}
          onClose={() => patch({ open: '' })}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </PageRefresh>
  );
}

/** งานทั้งวันแบบเต็ม — ช่องในปฏิทินเล็กเกินกว่าจะใส่เวลา/สถานะ/ผู้รับบริการครบในที่เดียว */
function DayPanel({ day, list, onOpenCase, onClose }) {
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด

  useScrollLock();
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{day}</p>
            <h2>{formatDate(day)}</h2>
            <p className="muted">{list.length === 0 ? 'ไม่มีกะในวันนี้' : `${list.length} กะ`}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          {list.map((c) => (
            <div className="history-item" key={c.visit_id}>
              <div>
                <strong>{timeRange(c) ?? 'ไม่ระบุเวลา'} · {c.assigned_name ?? '— ยังไม่จับคู่ —'}</strong>
                <p className="muted">
                  {c.client_name} · {CASE_TYPE_LABELS[c.case_type]} · {SERVICE_KIND_LABELS[kindOf(c)]}
                </p>
                <p className="muted">
                  <button className="btn link-btn" onClick={() => onOpenCase(c.case_id)}>
                    <span className="mono">{c.case_id}</span> — เปิดเคส
                  </button>
                </p>
              </div>
              <span className={`badge visit-${c.state}`}>{VISIT_STATE_LABELS[c.state]}</span>
            </div>
          ))}
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>ปิด</button>
        </footer>
      </div>
    </div>
  );
}
