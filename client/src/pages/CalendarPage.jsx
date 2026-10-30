import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import CaseModal from '../components/CaseModal.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import {
  MONTH_LABELS, POSITION_LABELS, SERVICE_KIND_LABELS, VISIT_STATE_LABELS,
  formatDate, toBuddhistYear,
} from '../labels.js';
import { CAL_STATES, dayLabel, timeRange } from '../lib/calendarUi.js';
import LineIcon from '../components/LineIcon.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import { caseCode } from '../lib/patientCode.js';
import { useToast } from '../toast.jsx';
import TimeComboInput from '../components/TimeComboInput.jsx';

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
 * ย้ายวันได้เฉพาะกะที่ยังรอเช็คอิน ของเคสที่ยังเดินอยู่ และยังไม่เลยวันนัด (server ตรวจซ้ำอีกชั้น)
 * กะขาดงานไม่ให้ย้าย — ประวัติขาดงานของวันเดิมจะหายไป
 */
const ACTIVE_CASE = ['unassigned', 'assigned', 'in_progress'];
const canMove = (c, today) => c.state === 'scheduled' && ACTIVE_CASE.includes(c.status) && c.visit_date >= today;

/** ช่องเวลาในมุมมองสัปดาห์ — ชั่วโมงละช่อง ทั้ง 24 ชม. (กะดึกของ Homecare เริ่ม 20:00 ได้) */
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DEFAULT_HOUR = 8; // วันว่างเปิดมาที่ช่วงเช้า ไม่ใช่ตีหนึ่ง
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/** จอแคบ = จุดเดียวกับที่ CSS เปลี่ยนปฏิทินเป็นโหมดรายการ (@media max-width: 600px ใน index.css) */
const NARROW = '(max-width: 600px)';
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * เวลาใหม่เมื่อวางกะลงช่องชั่วโมง h — เริ่มตรงต้นชั่วโมง ความยาวกะเท่าเดิม
 * กะข้ามเที่ยงคืน (จบ ≤ เริ่ม) นับความยาวข้ามวันให้ถูก แล้วเวลาจบก็วนข้ามเที่ยงคืนตามเดิม
 * กะที่ไม่เคยระบุเวลาจบ ยังไม่มีเวลาจบเหมือนเดิม
 */
function timesForStart(v, startText) {
  const start = toMin(startText);
  if (!v.planned_start || !v.planned_end) return { planned_start: startText, planned_end: v.planned_end ?? null };
  const length = (toMin(v.planned_end) - toMin(v.planned_start) + 1440) % 1440 || 1440;
  return { planned_start: startText, planned_end: fromMin((start + length) % 1440) };
}
const timesForHour = (v, h) => timesForStart(v, hh(h));

export default function CalendarPage() {
  const [params, setParams] = useSearchParams();

  const [visits, setVisits] = useState(null);
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const toast = useToast();
  const [dragging, setDragging] = useState(null); // กะที่กำลังลากอยู่
  const [dropDay, setDropDay] = useState(''); // ช่องวันที่ลากผ่านอยู่ — ไว้ไฮไลต์
  const [pendingMove, setPendingMove] = useState(null); // { visit, to } รอกดยืนยัน
  const [moving, setMoving] = useState(false);
  const narrow = useNarrow();

  const get = (key) => params.get(key) ?? '';
  const view = get('view') === 'week' ? 'week' : 'month';
  const slotted = view === 'week' && !narrow; // slot ชั่วโมงในช่องวัน — เฉพาะมุมมองสัปดาห์บนจอกว้าง
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

  const filtered = Boolean(employeeId || kind || state);

  /** ขยับช่วงที่ดู — เดือนละก้าว หรือสัปดาห์ละก้าวตามมุมมอง */
  function shift(delta) {
    const d = new Date(anchorDate);
    if (view === 'week') d.setDate(d.getDate() + delta * 7);
    else {
      // ตั้งเป็นวันที่ 1 ก่อนเลื่อนเดือน — 31 ม.ค. + 1 เดือน จะกลายเป็น "31 ก.พ." แล้วล้นไป มี.ค. (ข้ามเดือนไปเลย)
      d.setDate(1);
      d.setMonth(d.getMonth() + delta);
    }
    patch({ date: isoOf(d) });
  }

  /**
   * ย้ายกะหลังกดยืนยัน — ขยับการ์ดไปวันใหม่ทันที (ไม่ต้องรอโหลดใหม่) ถ้า server ปฏิเสธค่อยคืนที่เดิม
   * การย้ายส่ง LINE "เลื่อนนัด" ถึงพนักงานและญาติ (รอ 2 นาที — ย้ายกลับที่เดิมทันจะไม่ส่ง) จึงต้องยืนยันก่อนเสมอ
   */
  /** times = เวลาที่เลือกในกล่องยืนยัน (null = เวลาเดิม) — กล่องเป็นคนตัดสินเวลาสุดท้าย ไม่ใช่ช่องที่วาง */
  async function confirmMove(times) {
    const { visit, to } = pendingMove;
    const before = { visit_date: visit.visit_date, planned_start: visit.planned_start, planned_end: visit.planned_end };
    const after = { visit_date: to, ...times };
    const place = (fields) => (list) => list?.map((v) => (v.visit_id === visit.visit_id ? { ...v, ...fields } : v));
    const where = `${formatDate(to)}${times ? ` ${times.planned_start}` : ''}`;
    setMoving(true);
    setVisits(place(after));
    try {
      const res = await api.moveVisit(visit.case_id, visit.visit_id, to, times);
      setPendingMove(null);
      toast(
        res.conflicts?.length
          ? `ย้ายไป ${where} แล้ว · ชนกับงานอื่นของ ${visit.assigned_name ?? 'พนักงาน'} ${res.conflicts.length} กะ ตรวจตารางอีกครั้ง`
          : `ย้ายไป ${where} แล้ว · ระบบจะแจ้งพนักงานและญาติทาง LINE`,
      );
      setReloadKey((k) => k + 1);
    } catch (e) {
      setVisits(place(before));
      setPendingMove(null);
      setError(e.message);
    } finally {
      setMoving(false);
    }
  }

  /*
   * ลากวาง (จอที่มีเมาส์) — มือถือใช้ปุ่ม "ย้ายวัน" ในหน้ารายละเอียดวันแทน เพราะลากบนจอสัมผัสไม่ได้
   * เป้าวางมีสองแบบ: ช่องวัน (มุมมองเดือน · ย้ายแค่วัน) และช่องชั่วโมง (มุมมองสัปดาห์ · ย้ายวันและเวลา)
   * hour = null คือช่องวัน · ตัวเลขคือช่องชั่วโมงนั้น
   */
  const canDropOn = (key, hour = null) => {
    if (!dragging || key < today) return false;
    if (hour == null) return key !== dragging.visit_date;
    // แถว "ไม่ระบุเวลา" ของมุมมองสัปดาห์ รับเฉพาะกะที่ไม่มีเวลาอยู่แล้ว — กะที่มีเวลาต้องลงช่องชั่วโมง
    if (hour === 'none') return !dragging.planned_start && key !== dragging.visit_date;
    if (typeof hour !== 'number') return false; // แถว "ก่อน 08:00" / "หลัง 20:00" — ไม่รู้เวลาเริ่ม จึงวางไม่ได้
    if (key === today && hour * 60 < nowMinutes()) return false; // ชั่วโมงที่ผ่านไปแล้วของวันนี้
    const sameSlot = key === dragging.visit_date && dragging.planned_start && Number(dragging.planned_start.slice(0, 2)) === hour;
    return !sameSlot;
  };
  const dropProps = (key, hour = null) => {
    const id = hour == null ? key : `${key}|${hour}`;
    return {
      onDragOver: (e) => {
        if (!canDropOn(key, hour)) return;
        e.preventDefault();
        e.stopPropagation(); // ช่องชั่วโมงอยู่ในคอลัมน์วัน — ไม่ให้คอลัมน์แย่งไฮไลต์
        e.dataTransfer.dropEffect = 'move';
        if (dropDay !== id) setDropDay(id);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget) && dropDay === id) setDropDay('');
      },
      onDrop: (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (canDropOn(key, hour)) {
          const times = typeof hour === 'number' ? timesForHour(dragging, hour) : null;
          setPendingMove({ visit: dragging, to: key, times });
        }
        setDragging(null);
        setDropDay('');
      },
    };
  };

  /** การ์ดกะหนึ่งใบ — ใช้ทั้งตารางเดือนและตารางช่องเวลาของสัปดาห์ */
  const chip = (c) => (
    <button
      key={`v${c.visit_id}`}
      type="button"
      /* สีตามสถานะ "กะ" (เช็คอินแล้วหรือยัง) ไม่ใช่สถานะ "เคส" — คนดูตารางงาน
         อยากรู้ว่ากะนี้เรียบร้อยไหม ไม่ใช่ว่าเคสอยู่ขั้นไหนของสัญญา */
      className={`cal-chip visit-${c.state}${canMove(c, today) ? ' is-movable' : ''}${dragging?.visit_id === c.visit_id ? ' is-dragging' : ''}`}
      onClick={() => patch({ open: c.case_id })}
      draggable={canMove(c, today)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(c.visit_id)); // Firefox ไม่เริ่มลากถ้าไม่มีข้อมูล
        setDragging(c);
      }}
      onDragEnd={() => { setDragging(null); setDropDay(''); }}
      title={[
        timeRange(c),
        caseCode(c.case_id),
        SERVICE_KIND_LABELS[kindOf(c)],
        c.client_name,
        c.assigned_name ?? 'ยังไม่จับคู่พนักงาน',
        VISIT_STATE_LABELS[c.state],
        canMove(c, today) && (slotted ? 'ลากลงช่องเวลาของวันที่ต้องการเพื่อย้าย' : 'ลากไปวันอื่นเพื่อย้าย'),
      ].filter(Boolean).join(' · ')}
    >
      {timeRange(c) && <span className="cal-chip-time">{timeRange(c)}</span>}
      {c.assigned_name ?? '— ยังไม่จับคู่ —'}
      <span className="cal-chip-sub">{c.client_name}</span>
    </button>
  );

  const rangeTitle =
    view === 'week'
      ? `${formatDate(days[0])} – ${formatDate(days[6])}`
      : `${MONTH_LABELS[mm]} ${toBuddhistYear(year)}`;

  return (
    <PageRefresh onRefresh={() => setReloadKey((k) => k + 1)} busy={loading}>
      {/* ไม่มีหัวหน้าบนจอ (ชื่อเดือน/สัปดาห์เป็นส่วนบนสุด) — คง h1 ไว้ให้โปรแกรมอ่านหน้าจอ */}
      <h1 className="sr-only">ตารางงาน</h1>

      {/* หัวปฏิทิน: ไอคอน + ช่วงเวลาที่ดูอยู่ (ซ้าย) · คำอธิบายสี (ขวา) — ปุ่มเลื่อนช่วงเวลาอยู่ท้ายแถบตัวกรอง */}
      <div className="cal-hero">
        <div className="cal-hero-main">
          <span className="cal-hero-icon" aria-hidden="true"><LineIcon name="calendar" /></span>
          <div>
            <p className="cal-hero-kicker">
              {view === 'week' ? 'ตารางงานรายสัปดาห์' : 'ตารางงานประจำเดือน'}
              {loading && ' · กำลังโหลด…'}
            </p>
            <h2 className="cal-title">
              {view === 'week' ? rangeTitle : (
                <>{MONTH_LABELS[mm]} <span className="cal-hero-year">{toBuddhistYear(year)}</span></>
              )}
            </h2>
          </div>
        </div>

        {/* คำอธิบายสี — ชิปมี 5 สีตามสถานะกะ ไม่มีอะไรบอกก็เดาไม่ถูก */}
        <div className="cal-legend">
          {CAL_STATES.map((s) => (
            <span key={s} className="cal-legend-item">
              <i className={`cal-swatch visit-${s}`} aria-hidden="true" />
              {VISIT_STATE_LABELS[s]}
            </span>
          ))}
        </div>
      </div>

      <div className="toolbar no-print">
        <span className="seg">
          <button className={view === 'month' ? 'on' : ''} onClick={() => patch({ view: '' })}>เดือน</button>
          <button className={view === 'week' ? 'on' : ''} onClick={() => patch({ view: 'week' })}>สัปดาห์</button>
        </span>

        <select value={employeeId} onChange={(e) => patch({ employee_id: e.target.value })} aria-label="เลือกพนักงาน">
          <option value="">พนักงานทุกคน</option>
          {/* เฉพาะพนักงาน front (คนที่รับเคส/มีกะ) · คนที่เลือกค้างอยู่ใน URL ยังโชว์ไว้ */}
          {staff.filter((s) => s.can_take_cases || s.employee_id === employeeId).map((s) => (
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
        {/* เลื่อนช่วงเวลา — ท้ายแถบตัวกรอง ชิดขวา */}
        <div className="cal-hero-nav toolbar-action">
          <button type="button" onClick={() => shift(-1)} aria-label={view === 'week' ? 'สัปดาห์ก่อนหน้า' : 'เดือนก่อนหน้า'}>
            <LineIcon name="chevron" className="cal-hero-prev" />
          </button>
          <button type="button" onClick={() => patch({ date: '' })}>วันนี้</button>
          <button type="button" onClick={() => shift(1)} aria-label={view === 'week' ? 'สัปดาห์ถัดไป' : 'เดือนถัดไป'}>
            <LineIcon name="chevron" className="cal-hero-next" />
          </button>
        </div>
      </div>

      {/* error เป็นแถบเหนือปฏิทิน ไม่ทับทั้งหน้า — ตัวกรองที่ตั้งไว้ต้องไม่หายเพราะเน็ตสะดุด */}
      {error && <p className="error no-print">{error}</p>}

      {/* จอแคบ: ให้ปฏิทินเลื่อนแนวนอนในกล่องของตัวเอง ไม่ดันทั้งหน้าให้เลื่อนตาม */}
      <div className="table-wrap cal-print">
        {/* --cal-rows = จำนวนแถวสัปดาห์ของเดือนนี้ (4–6) — CSS ใช้แบ่งความสูงจอให้ทั้งเดือนพอดีจอเดียว */}
        <div
          className={`cal-grid ${view === 'week' ? 'is-week' : ''} ${slotted ? 'has-slots' : ''}`}
          style={view === 'month' ? { '--cal-rows': Math.ceil((new Date(year, month - 1, 1).getDay() + days.length) / 7) } : undefined}
        >
          {WEEKDAYS.map((w) => <div key={w} className="cal-head">{w}</div>)}

          {/* ช่องว่างก่อนวันแรก — ให้คอลัมน์ตรงกับวันในสัปดาห์ (มุมมองสัปดาห์เริ่มวันอาทิตย์อยู่แล้ว) */}
          {view === 'month' &&
            Array.from({ length: new Date(year, month - 1, 1).getDay() }, (_, i) => (
              <div key={`pad-${i}`} className="cal-cell is-empty" />
            ))}

          {days.map((key) => {
            const list = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                data-day={key}
                className={[
                  'cal-cell',
                  key === today && 'is-today',
                  dragging && (canDropOn(key) ? 'is-drop-ok' : 'is-drop-no'),
                  dropDay === key && 'is-drop-over',
                ].filter(Boolean).join(' ')}
                {...dropProps(key)}
              >
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

                {/* มุมมองสัปดาห์บนจอกว้าง: ในช่องวันมี slot ชั่วโมงของวันนั้น — ลากกะลง slot ไหน = ย้ายไปวัน-เวลานั้น
                    มุมมองเดือนและมือถือ: รายการกะแบบเดิม (ลากไปวันอื่นแล้วเลือกเวลาในกล่องยืนยัน / ปุ่ม "ย้ายวัน / เวลา") */}
                {!slotted ? (
                  <>
                    {/* กะเยอะกว่าที่ช่องรับไหว — ในมุมมองเดือน CSS โชว์แค่ MONTH_VISIBLE ตัวแรก ที่เหลืออยู่หลังปุ่ม "+N" */}
                    <div className="cal-chips">{list.map(chip)}</div>
                    {/* วันที่ไม่มีงานสักกะ — โหมดรายการบนมือถือยุบวันแบบนี้ทิ้งหมด ยกเว้น "วันนี้" ที่ต้องเห็นเสมอ
                        (CSS ซ่อนบรรทัดนี้ในโหมดตาราง — ที่นั่นช่องว่างทั้งเดือนจะกลายเป็นคำว่า "ไม่มีงาน" เต็มปฏิทิน) */}
                    {list.length === 0 && <p className="cal-empty-day">ไม่มีงาน</p>}
                    {/* บอกว่ายังมีงานอีกกี่กะที่ไม่ได้แสดง แล้วกดเปิดดูทั้งวันได้จากตรงนี้ (CSS ซ่อนบนมือถือ) */}
                    {list.length > MONTH_VISIBLE && (
                      <button type="button" className="cal-more" onClick={() => patch({ day: key })}>
                        +{list.length - MONTH_VISIBLE} งานที่เหลือ
                      </button>
                    )}
                  </>
                ) : (
                  <DaySlots
                    day={key}
                    list={list}
                    chip={chip}
                    dragging={dragging}
                    dropKey={dropDay}
                    canDropOn={canDropOn}
                    dropProps={dropProps}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="muted cal-note no-print">
        ทุกเคส (ทั้ง <strong>Homecare</strong> และ <strong>กายภาพบำบัด</strong>) แสดงตาม
        <strong>วันนัดที่ลงไว้</strong>ในหน้าจัดการเคส — เคสที่ยังไม่ลงวันนัดจะไม่ขึ้นบนปฏิทิน
        · ย้ายได้โดย<strong>ลากกะที่รอเช็คอิน</strong>ไปวันอื่นแล้วเลือกเวลาในกล่องยืนยัน
        (มุมมองสัปดาห์ลากลงช่องเวลาได้เลย) หรือกดที่วันแล้วเลือก "ย้ายวัน / เวลา"
      </p>

      {openDay && (
        <DayPanel
          day={openDay}
          list={byDay.get(openDay) ?? []}
          today={today}
          onOpenCase={(id) => patch({ day: '', open: id })}
          onMove={(visit, to, times) => setPendingMove({ visit, to, times })}
          onClose={() => patch({ day: '' })}
        />
      )}

      {pendingMove && (
        <MoveConfirm
          move={pendingMove}
          busy={moving}
          today={today}
          onConfirm={confirmMove}
          onCancel={() => !moving && setPendingMove(null)}
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
function DayPanel({ day, list, today, onOpenCase, onMove, onClose }) {
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด
  const [movingId, setMovingId] = useState(null); // กะที่กดปุ่ม "ย้ายวัน" อยู่
  const [moveTo, setMoveTo] = useState('');
  const [moveStart, setMoveStart] = useState(''); // '' = เวลาเดิม · 'HH:MM' = เวลาเริ่มใหม่
  const [moveValid, setMoveValid] = useState(true);
  /** ค่าที่เลือกในฟอร์มย้ายวัน → เวลาใหม่ หรือ null ถ้าคงเวลาเดิม · และย้ายได้จริงไหม */
  const moveTimes = (c) => (moveStart && moveValid ? timesForStart(c, moveStart) : null);
  const moveOk = (c) => {
    if (!moveValid || !moveTo || moveTo < today) return false;
    const t = moveTimes(c);
    const start = t?.planned_start ?? c.planned_start;
    if (moveTo === today && start && toMin(start) < nowMinutes()) return false; // เวลานั้นของวันนี้ผ่านไปแล้ว
    return moveTo !== c.visit_date || (t && t.planned_start !== c.planned_start);
  };

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
                  {c.client_name} · {SERVICE_KIND_LABELS[kindOf(c)]}
                </p>
                <p className="muted">
                  <button className="btn link-btn" onClick={() => onOpenCase(c.case_id)}>
                    <span className="mono">{caseCode(c.case_id)}</span> — เปิดเคส
                  </button>
                </p>
                {/* ย้ายวันแบบไม่ต้องลาก — ทางเดียวที่ใช้ได้บนมือถือ (ลากบนจอสัมผัสไม่ได้) */}
                {canMove(c, today) && (movingId === c.visit_id ? (
                  <form
                    className="cal-move-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (moveOk(c)) onMove(c, moveTo, moveTimes(c));
                    }}
                  >
                    <label htmlFor={`move-${c.visit_id}`} className="sr-only">ย้ายไปวันที่</label>
                    <input
                      id={`move-${c.visit_id}`}
                      type="date"
                      min={today}
                      value={moveTo}
                      onChange={(e) => setMoveTo(e.target.value)}
                      required
                    />
                    <label htmlFor={`move-hour-${c.visit_id}`} className="sr-only">เวลาเริ่มใหม่</label>
                    <TimeComboInput
                      id={`move-hour-${c.visit_id}`}
                      value={moveStart}
                      emptyLabel={c.planned_start ? `เวลาเดิม ${c.planned_start}` : 'ไม่ระบุเวลา'}
                      around={c.planned_start ?? ''}
                      onChange={(v, ok) => { setMoveStart(v); setMoveValid(ok); }}
                    />
                    <button type="submit" className="btn tiny primary" disabled={!moveOk(c)}>
                      ย้าย
                    </button>
                    <button type="button" className="btn tiny" onClick={() => setMovingId(null)}>ยกเลิก</button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() => { setMovingId(c.visit_id); setMoveTo(c.visit_date); setMoveStart(''); setMoveValid(true); }}
                  >
                    ย้ายวัน / เวลา
                  </button>
                ))}
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

/**
 * ยืนยันก่อนย้ายกะ — การย้ายส่ง LINE ถึงพนักงานและญาติ ลากพลาดต้องไม่กลายเป็นข้อความถึงลูกค้า
 * มีช่องเลือกเวลาเริ่มใหม่ทีละชั่วโมง — มุมมองเดือนลากได้แค่ระดับวัน (ช่องวันเล็กเกินจะแบ่ง 24 ชม.) จึงเลือกเวลาที่นี่
 * ค่าเริ่มต้น = ชั่วโมงของช่องที่วาง (มุมมองสัปดาห์/ฟอร์มมือถือ) หรือ "เวลาเดิม" (มุมมองเดือน)
 */
function MoveConfirm({ move, busy, today, onConfirm, onCancel }) {
  const { visit, to } = move;
  // '' = เวลาเดิม · 'HH:MM' = เวลาเริ่มใหม่ (เลือกจากรายการหรือพิมพ์เอง)
  const [start, setStart] = useState(move.times?.planned_start ?? '');
  const [valid, setValid] = useState(true);
  const times = valid && start ? timesForStart(visit, start) : null;
  const after = times ? { ...visit, ...times } : visit;
  const past = valid && to === today && after.planned_start && toMin(after.planned_start) < nowMinutes();
  const unchanged = valid && to === visit.visit_date && (!times || times.planned_start === visit.planned_start);
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onCancel();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-narrow" role="alertdialog" aria-modal="true" aria-labelledby="move-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseCode(visit.case_id)}</p>
            <h2 id="move-title">ย้ายวันและเวลานัด</h2>
          </div>
        </header>
        <div className="modal-body">
          <p>
            <strong>{visit.assigned_name ?? '— ยังไม่จับคู่ —'}</strong>
            <br />
            <span className="muted">{visit.client_name}</span>
          </p>
          <div className="cal-move-dates">
            <span>
              {formatDate(visit.visit_date)}
              <br />
              <span className="muted">{timeRange(visit) ?? 'ไม่ระบุเวลา'}</span>
            </span>
            <span aria-hidden="true">→</span>
            <span className="sr-only">ไป</span>
            <strong>
              {formatDate(to)}
              <br />
              {timeRange(after) ?? 'ไม่ระบุเวลา'}
            </strong>
          </div>
          <div className="field cal-move-hour">
            <label htmlFor="move-confirm-hour" className="field-label">เวลาเริ่มใหม่ (เลือก หรือพิมพ์เอง)</label>
            <TimeComboInput
              id="move-confirm-hour"
              value={start}
              emptyLabel={visit.planned_start ? `เวลาเดิม (${visit.planned_start})` : 'ไม่ระบุเวลา (คงเดิม)'}
              around={visit.planned_start ?? ''}
              disabled={busy}
              onChange={(v, ok) => { setStart(v); setValid(ok); }}
            />
          </div>
          {past && <p className="error" role="alert">เวลา {after.planned_start} ของวันนี้ผ่านไปแล้ว — เลือกเวลาที่ยังไม่ถึง</p>}
          {unchanged && <p className="muted" role="status">วันและเวลายังเหมือนเดิม — เลือกเวลาใหม่ก่อน</p>}
          <p className="muted">
            {times ? 'ความยาวกะและพนักงานคงเดิม' : 'เวลาและพนักงานคงเดิม'} ระบบจะแจ้งเลื่อนนัดทาง LINE ถึงพนักงานและญาติที่ผูกไว้
          </p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="button" className="btn primary" onClick={() => onConfirm(times)} disabled={busy || !valid || past || unchanged}>
            {busy ? 'กำลังย้าย…' : 'ยืนยันย้าย'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * slot ชั่วโมงในช่องวันหนึ่งช่อง (มุมมองสัปดาห์บนจอกว้าง) — 08:00–20:00 (ผู้ใช้ขอ 30 ต.ค. 2569)
 * กะอยู่ใน slot ของ "ชั่วโมงที่เริ่ม" (14:30 อยู่ slot 14:00) · ลากลง slot = ย้ายไปวันนั้น เริ่มต้นชั่วโมงนั้น ความยาวกะเท่าเดิม
 * slot "ไม่ระบุเวลา" ตรึงบนสุดของช่อง มีเฉพาะเมื่อวันนั้นมีกะไม่ระบุเวลา หรือกำลังลากกะแบบนั้นอยู่ (วางที่นี่ = ย้ายแค่วัน)
 * กะนอกช่วง (กะดึก/เช้ามืดของ Homecare) ไม่หายไปไหน — รวมอยู่ในแถว "ก่อน 08:00" / "หลัง 20:00" ที่ขึ้นเฉพาะวันที่มี
 *   สองแถวนี้วางไม่ได้ (ไม่รู้ว่าจะให้เริ่มกี่โมง) — ย้ายกะไปเวลานอกช่วงใช้ช่องเวลาในกล่องยืนยันหรือปุ่ม "ย้ายวัน / เวลา"
 */
const FIRST_SLOT = 8;
const LAST_SLOT = 20;
const SLOT_HOURS = HOURS.filter((h) => h >= FIRST_SLOT && h <= LAST_SLOT);
const slotOf = (c) => {
  if (!c.planned_start) return 'none';
  const h = Number(c.planned_start.slice(0, 2));
  return h < FIRST_SLOT ? 'early' : h > LAST_SLOT ? 'late' : h;
};

function DaySlots({ day, list, chip, dragging, dropKey, canDropOn, dropProps }) {
  const boxRef = useRef(null);

  const byHour = useMemo(() => {
    const map = new Map();
    for (const c of list) {
      const slot = slotOf(c);
      if (!map.has(slot)) map.set(slot, []);
      map.get(slot).push(c);
    }
    return map;
  }, [list]);

  const showNone = byHour.has('none') || (dragging && !dragging.planned_start);
  // เลื่อนไปที่ slot แรกที่มีกะ — กะก่อน 08:00 อยู่แถวบนสุดอยู่แล้ว · วันว่างอยู่ที่ 08:00
  const timed = list.filter((c) => c.planned_start).map((c) => Number(c.planned_start.slice(0, 2)));
  const firstHour = timed.length ? Math.min(...timed) : DEFAULT_HOUR;
  const first = firstHour < FIRST_SLOT ? 'early' : firstHour > LAST_SLOT ? 'late' : firstHour;

  // ตั้งตำแหน่งเลื่อนตอนเปิดวัน/ข้อมูลเปลี่ยน — ไม่ทำระหว่างลาก (ช่องจะกระโดดหนีเมาส์)
  // แถว "ไม่ระบุ" ตรึงอยู่บนสุด ต้องหักความสูงออก ไม่งั้นชั่วโมงแรกไปซ่อนอยู่ใต้มัน
  const draggingNow = Boolean(dragging);
  useLayoutEffect(() => {
    if (draggingNow) return;
    const box = boxRef.current;
    const row = box?.querySelector(`[data-hour="${first}"]`);
    const pinned = box?.querySelector('[data-hour="none"]')?.offsetHeight ?? 0;
    if (box && row) box.scrollTop = row.offsetTop - pinned;
  }, [day, first, draggingNow, showNone]);

  const slotClass = (hour) => [
    'cal-slot',
    hour === 'none' && 'is-none',
    (hour === 'early' || hour === 'late') && 'is-outside',
    dragging && (canDropOn(day, hour) ? 'is-drop-ok' : 'is-drop-no'),
    dropKey === `${day}|${hour}` && 'is-drop-over',
  ].filter(Boolean).join(' ');

  const row = (hour, label) => (
    <div key={hour} className={slotClass(hour)} data-hour={hour} {...dropProps(day, hour)}>
      <span className="cal-slot-time">{label}</span>
      <div className="cal-slot-chips">{(byHour.get(hour) ?? []).map(chip)}</div>
    </div>
  );

  return (
    <div className="cal-slots" ref={boxRef}>
      {showNone && row('none', 'ไม่ระบุ')}
      {byHour.has('early') && row('early', `ก่อน ${hh(FIRST_SLOT)}`)}
      {SLOT_HOURS.map((h) => row(h, hh(h)))}
      {byHour.has('late') && row('late', `หลัง ${hh(LAST_SLOT)}`)}
    </div>
  );
}
