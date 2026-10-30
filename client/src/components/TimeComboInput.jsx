import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import LineIcon from './LineIcon.jsx';
import { parseTime } from '../lib/calendarUi.js';

/**
 * ช่องเวลาที่พิมพ์เองได้ + รายการชั่วโมงให้กดเลือก — ใช้ในกล่องย้ายกะของหน้าปฏิทิน
 *
 * ต่างจาก TimeSelect.jsx สองข้อ (ตามที่ผู้ใช้ขอ 30 ต.ค. 2569):
 *   1. พิมพ์เวลาเองได้ทุกนาที — "930" "9.30" "09:30" กลายเป็น 09:30 เมื่อออกจากช่อง
 *   2. รายการเปิด "ลงล่าง" เสมอ — <select> ของเบราว์เซอร์ (และ TimeSelect) พลิกขึ้นบนเมื่อใกล้ขอบจอ
 *      แล้วไปทับหัวกล่องจนไม่เห็นว่ากำลังย้ายกะไหน · ถ้าที่ข้างล่างไม่พอ เลื่อนช่องขึ้นก่อนแล้วค่อยเปิด
 *
 * รายการวาดที่ <body> (position: fixed) ด้วยเหตุผลเดียวกับ TimeSelect: กล่อง popup ที่เลื่อนได้จะตัดของที่ล้นออกนอกตัว
 *
 * value = '' (ใช้ค่า emptyLabel เช่น "เวลาเดิม") หรือ 'HH:MM'
 * onChange(value, valid) — valid = false เมื่อข้อความที่พิมพ์ยังไม่ใช่เวลา (ให้ผู้ใช้หน้ากันปุ่มยืนยันไว้)
 */

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
const GAP = 4;
const WANT = 208; // ≈ 7 บรรทัด
const LEAST = 120;

/** around = เวลาที่ใช้เลื่อนรายการไปใกล้ ๆ ตอนยังไม่ได้เลือก (เช่นเวลาเดิมของกะ) */
export default function TimeComboInput({ id, value, onChange, emptyLabel = 'ไม่ระบุ', around = '', disabled = false }) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const listRef = useRef(null);

  // ค่าจากข้างนอกเปลี่ยน (เช่นกดเลือกจากรายการ) → ข้อความในช่องตาม
  useEffect(() => setText(value), [value]);

  const invalid = parseTime(text) === null;

  const place = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - GAP - 8;
    setPos({ left: r.left, width: r.width, top: r.bottom + GAP, maxHeight: Math.max(LEAST, Math.min(WANT, below)) });
  }, []);

  function openList() {
    const r = boxRef.current?.getBoundingClientRect();
    // ที่ข้างล่างไม่พอ = เลื่อนช่องขึ้นไปก่อน (ในกล่องที่เลื่อนได้) แทนการพลิกรายการขึ้นบน
    if (r && window.innerHeight - r.bottom < LEAST + 16) boxRef.current.scrollIntoView({ block: 'start' });
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // เปิดมาเห็นชั่วโมงที่ใกล้ค่าปัจจุบัน ไม่ใช่ 00:00 ทุกครั้ง
  const scrolledRef = useRef(false);
  useLayoutEffect(() => {
    if (!open) { scrolledRef.current = false; return; }
    if (!pos || scrolledRef.current) return;
    scrolledRef.current = true;
    const hour = (parseTime(text) || around || '').slice(0, 2);
    listRef.current?.querySelector(`[data-hour="${hour}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, pos, text, around]);

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const onDown = (e) => {
      if (!boxRef.current?.contains(e.target) && !listRef.current?.contains(e.target)) setOpen(false);
    };
    // Esc ปิดแค่รายการ ไม่ปิดกล่องยืนยันที่ครอบอยู่ (กล่องฟัง keydown ที่ document ช่วง bubble)
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, place]);

  const pick = (v) => {
    setText(v);
    onChange(v, true);
    setOpen(false);
  };

  return (
    <span className={`time-combo${invalid ? ' is-invalid' : ''}`} ref={boxRef}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={emptyLabel}
        value={text}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-hint` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseTime(e.target.value);
          onChange(parsed ?? e.target.value, parsed !== null);
        }}
        onBlur={() => {
          const parsed = parseTime(text);
          if (parsed !== null && parsed !== text) { setText(parsed); onChange(parsed, true); }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); openList(); }
        }}
      />
      <button
        type="button"
        className="time-combo-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="เลือกเวลาจากรายการ"
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <LineIcon name="chevron" className="picker-caret" />
      </button>
      {invalid && <span id={`${id}-hint`} className="time-combo-hint">พิมพ์เป็น ชั่วโมง:นาที เช่น 09:30</span>}

      {open && pos &&
        createPortal(
          <div className="picker-list time-combo-list" role="listbox" aria-label="เวลาเริ่ม" ref={listRef} style={pos}>
            <button type="button" role="option" aria-selected={value === ''} className={value === '' ? 'is-on' : ''} onClick={() => pick('')}>
              {emptyLabel}
            </button>
            {HOURS.map((h) => (
              <button
                key={h}
                type="button"
                role="option"
                data-hour={h.slice(0, 2)}
                aria-selected={value === h}
                className={value === h ? 'is-on' : ''}
                onClick={() => pick(h)}
              >
                {h}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
