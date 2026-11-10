import { useEffect, useRef, useState } from 'react';
import { dayLabel, timeRange } from '../lib/calendarUi.js';

/**
 * ปฏิทินบนมือถือ (ผู้ใช้ขอ 10 พ.ย. 2569 — แบบแอปปฏิทินบนโทรศัพท์)
 *   บน: ตารางเดือนย่อ — เลขวัน + จุดสีสถานะกะใต้เลข · วันนี้เป็นวงทอง · กดวันเพื่อเลือก
 *   ล่าง: รายการงาน (agenda) เริ่มจากวันที่เลือก ไล่ไปจนสุดช่วงที่แสดง — หัววัน "วันนี้" / "พรุ่งนี้"
 * ใช้ร่วมกันทั้งตารางงาน admin (CalendarPage) และตารางงานของฉัน (MyCalendarPage)
 * จอกว้างยังใช้ตาราง .cal-grid แบบเดิม — สลับกันด้วย useNarrow() จุดเดียวกัน
 */

export const NARROW = '(max-width: 600px)';
export function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const MAX_DOTS = 4;
const SWIPE_MIN = 50;  // ปัดเกินกี่ px ถึงนับว่าเปลี่ยนเดือน — น้อยกว่านี้ดีดกลับที่เดิม
const LOCK_AT = 8;     // ขยับเกินนี้ก่อนค่อยตัดสินว่าเป็นปัดแนวนอนหรือเลื่อนหน้าแนวตั้ง

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (key, n) => {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
};

/**
 * @param days      วันที่แสดงในตาราง ('YYYY-MM-DD' ต่อเนื่องกัน — ทั้งเดือน หรือหนึ่งสัปดาห์)
 * @param byDay     Map วัน → รายการกะ
 * @param selected  วันที่เลือกอยู่ (รายการงานเริ่มจากวันนี้)
 * @param itemText  (กะ) → { title, sub } — แต่ละหน้าเลือกเองว่าจะโชว์ชื่อพนักงานหรือผู้รับบริการ
 * @param onOpen    กดงาน → เปิดเคส
 * @param onDayOpen (ไม่บังคับ) ปุ่ม "จัดการ" ที่หัววัน — ฝั่ง admin ใช้เปิดหน้ารายละเอียดวัน (ย้ายวัน/เวลา)
 * @param onShift   ปัดตารางซ้าย/ขวา → onShift(+1 | -1) เดือน (หรือสัปดาห์) ถัดไป/ก่อนหน้า
 *                  มือถือไม่มีปุ่ม ‹ วันนี้ › แล้ว (ผู้ใช้ขอ 10 พ.ย. 2569) — ปัดคือทางเปลี่ยนเดือนทางเดียว
 */
export default function MobileCalendar({ days, byDay, today, selected, onSelect, onShift, itemText, onOpen, onDayOpen, rangeName = 'เดือนนี้' }) {
  const gridRef = useRef(null);
  const touch = useRef(null);        // { x, y, dx, lock: null | 'x' | 'y' } ของนิ้วที่แตะอยู่
  const swipedAt = useRef(0);        // ปัดเสร็จแล้วนิ้วไปจบบนปุ่มวัน — ไม่ให้นับเป็นการกดเลือกวัน
  const [enter, setEnter] = useState(''); // 'next' | 'prev' — ทิศที่ตารางใหม่เลื่อนเข้ามา

  /* ตารางเลื่อนตามนิ้วแนวนอน (ขยับ style ตรงๆ ไม่ re-render ทุกเฟรม) — แนวตั้งปล่อยให้หน้าเลื่อนตามปกติ
     touch-action: pan-y ใน CSS ทำให้เบราว์เซอร์ไม่แย่งท่าแนวนอนไปเอง จึงไม่ต้อง preventDefault */
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, dx: 0, lock: null };
  };
  const onTouchMove = (e) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.lock) {
      if (Math.abs(dx) < LOCK_AT && Math.abs(dy) < LOCK_AT) return;
      s.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (s.lock !== 'x') return;
    s.dx = dx;
    const el = gridRef.current;
    el.style.transition = 'none';
    el.style.transform = `translateX(${dx * 0.6}px)`;
    el.style.opacity = String(1 - Math.min(Math.abs(dx) / 500, 0.45));
  };
  const onTouchEnd = () => {
    const s = touch.current;
    touch.current = null;
    if (!s || s.lock !== 'x') return;
    swipedAt.current = Date.now();
    const el = gridRef.current;
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
    if (Math.abs(s.dx) < SWIPE_MIN) return;
    const delta = s.dx < 0 ? 1 : -1; // ปัดซ้าย = เดือนถัดไป (แบบแอปปฏิทินทั่วไป)
    setEnter(delta > 0 ? 'next' : 'prev');
    onShift(delta);
  };

  const first = days[0];
  const last = days[days.length - 1];
  const inRange = new Set(days);

  // เติมวันของเดือนก่อน/ถัดไปให้ครบแถวสัปดาห์ (สีจาง กดไม่ได้) — ตารางไม่แหว่งหัวท้าย
  const leading = new Date(`${first}T00:00:00`).getDay();
  const trailing = 6 - new Date(`${last}T00:00:00`).getDay();
  const cells = [
    ...Array.from({ length: leading }, (_, i) => addDays(first, i - leading)),
    ...days,
    ...Array.from({ length: trailing }, (_, i) => addDays(last, i + 1)),
  ];

  const start = inRange.has(selected) ? selected : first;
  const tomorrow = addDays(today, 1);
  // วันที่เลือกขึ้นเสมอ (ว่างก็บอกว่าว่าง) · วันถัดไปขึ้นเฉพาะวันที่มีงาน
  const agenda = days.filter((k) => k === start || (k > start && byDay.get(k)?.length));

  return (
    <div className="mcal cal-print">
      {/* key = วันแรกของช่วง — เปลี่ยนเดือนแล้วตารางใหม่ mount ใหม่ เล่นแอนิเมชันเลื่อนเข้าตามทิศที่ปัด */}
      <div
        key={first}
        ref={gridRef}
        className={`mcal-grid${enter ? ` is-enter-${enter}` : ''}`}
        role="grid"
        aria-label={`เลือกวัน — ปัดซ้ายหรือขวาเพื่อเปลี่ยน${rangeName === 'สัปดาห์นี้' ? 'สัปดาห์' : 'เดือน'}`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`mcal-head${i === 0 || i === 6 ? ' is-weekend' : ''}`} role="columnheader">{w}</div>
        ))}
        {cells.map((key, i) => {
          const out = !inRange.has(key);
          const list = out ? [] : byDay.get(key) ?? [];
          const weekend = i % 7 === 0 || i % 7 === 6;
          return (
            <button
              key={key}
              type="button"
              disabled={out}
              className={[
                'mcal-day',
                out && 'is-out',
                weekend && 'is-weekend',
                key === today && 'is-today',
                !out && key === start && 'is-selected',
              ].filter(Boolean).join(' ')}
              aria-pressed={!out && key === start}
              aria-label={`${dayLabel(key)}${list.length ? ` · ${list.length} งาน` : ''}`}
              onClick={() => Date.now() - swipedAt.current > 350 && onSelect(key)}
            >
              <span className="mcal-num">{Number(key.slice(8))}</span>
              <span className="mcal-dots" aria-hidden="true">
                {list.slice(0, MAX_DOTS).map((c) => <i key={c.visit_id} className={`mcal-dot visit-${c.state}`} />)}
              </span>
            </button>
          );
        })}
      </div>

      {/* ไม่มีปุ่มเลื่อนเดือนบนมือถือแล้ว — บอกท่าปัดไว้ใต้ตาราง ไม่งั้นคนใหม่ไม่รู้ว่าเปลี่ยนเดือนยังไง */}
      <p className="mcal-hint" aria-hidden="true">‹ ปัดตารางซ้าย–ขวาเพื่อเปลี่ยน{rangeName === 'สัปดาห์นี้' ? 'สัปดาห์' : 'เดือน'} ›</p>

      <div className="mcal-agenda">
        {agenda.map((key) => {
          const list = byDay.get(key) ?? [];
          const tag = key === today ? 'วันนี้' : key === tomorrow ? 'พรุ่งนี้' : null;
          return (
            <section key={key} className="mcal-group" aria-label={dayLabel(key)}>
              <header className={`mcal-dayhead${key === today ? ' is-today' : ''}`}>
                {tag && <span className="mcal-dayhead-tag">{tag}</span>}
                <span>{dayLabel(key)}</span>
                <span className="mcal-dayhead-count">{list.length ? `${list.length} งาน` : ''}</span>
                {onDayOpen && (
                  <button type="button" className="mcal-dayhead-btn" onClick={() => onDayOpen(key)}>จัดการ</button>
                )}
              </header>
              {list.length === 0 && <p className="mcal-empty">ไม่มีงาน</p>}
              {list.map((c) => {
                const { title, sub } = itemText(c);
                return (
                  <button key={c.visit_id} type="button" className="mcal-item" onClick={() => onOpen(c)}>
                    <i className={`mcal-dot visit-${c.state}`} aria-hidden="true" />
                    <span className="mcal-item-body">
                      <span className="mcal-item-time">{timeRange(c) ?? 'ไม่ระบุเวลา'}</span>
                      <span className="mcal-item-title">{title}</span>
                      {sub && <span className="mcal-item-sub">{sub}</span>}
                    </span>
                  </button>
                );
              })}
            </section>
          );
        })}
        {agenda.length === 1 && (
          <p className="mcal-end">ไม่มีงานต่อจากนี้ใน{rangeName}</p>
        )}
      </div>
    </div>
  );
}
