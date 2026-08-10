import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import LineIcon from './LineIcon.jsx';

/**
 * ช่องเลือกเวลาแบบ 24 ชั่วโมง — สองช่อง (ชั่วโมง : นาที) คืนค่าเป็นข้อความ 'HH:MM'
 *
 * ทำไมไม่ใช้ <input type="time">
 *   รูปแบบที่มันแสดง (AM/PM หรือ 24 ชม.) มาจากภาษาของ "เบราว์เซอร์/เครื่อง" ไม่ใช่ของหน้าเว็บ
 *   ตั้ง lang="th" ที่ <html> แล้วเครื่องที่ตั้งเป็นอังกฤษ (สหรัฐฯ) ก็ยังขึ้น AM/PM อยู่ดี
 *   ซึ่งขัดกับทั้งระบบที่เก็บ/แสดงเวลาเป็น 24 ชม. และ 04 PM กับ 04 AM ต่างกันแค่ตัวเดียว กดผิดง่าย
 *
 * ทำไมไม่ใช้ <select>
 *   ความสูงของรายการที่กางออกมาเป็นของเบราว์เซอร์ สั่งจาก CSS ไม่ได้ — บนมือถือชั่วโมง 24 บรรทัด
 *   จึงกางเต็มจอทับทุกอย่างจนไม่เห็นว่ากำลังตั้งเวลาให้วันไหนอยู่
 *   รายการของเราเองคุมได้ว่าให้เห็นทีละกี่บรรทัดแล้วเลื่อนดูที่เหลือ
 */

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
// ทีละ 5 นาที — ละเอียดพอสำหรับเวลานัด/เข้างาน แต่รายการสั้นพอกวาดตาหาได้
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

/**
 * dropdown ขนาดเล็กที่คุมความสูงเองได้
 * เปิดขึ้นบนแทนถ้าที่ว่างข้างล่างไม่พอ — แถบเลือกเวลาอยู่ใกล้ขอบล่างจอบนมือถือ
 * ถ้าไม่พลิกด้าน รายการจะโผล่นอกกรอบที่เลื่อนได้แล้วโดนตัดหายไปครึ่งหนึ่ง
 */
function Picker({ value, options, onPick, disabled, label }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const boxRef = useRef(null);
  const listRef = useRef(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = boxRef.current?.getBoundingClientRect();
    if (rect) setDropUp(window.innerHeight - rect.bottom < 200 && rect.top > 200);
    // เลื่อนให้ค่าที่เลือกอยู่มาอยู่กลางรายการ ไม่ใช่ให้ผู้ใช้ไล่หาเองทุกครั้งที่เปิด
    listRef.current?.querySelector('.is-on')?.scrollIntoView({ block: 'center' });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const onDown = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    /* Esc ต้องปิดแค่รายการนี้ ไม่ใช่ปิด popup ที่ครอบอยู่ไปด้วย
       ดักช่วง capture แล้วหยุดส่งต่อ — ตัวจัดการของ popup แม่ผูกไว้ที่ document ช่วง bubble */
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };

    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <span className={`picker ${dropUp ? 'is-up' : ''}`} ref={boxRef}>
      <button
        type="button"
        className="picker-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {value || '--'}
        <LineIcon name="chevron" className="picker-caret" />
      </button>

      {open && (
        // ตัวเลือกต้องเป็นลูกโดยตรงของ listbox — ห่อด้วย <li> อีกชั้นแล้วโปรแกรมอ่านหน้าจอจะจับคู่ไม่ติด
        <div className="picker-list" role="listbox" aria-label={label} ref={listRef}>
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="option"
              aria-selected={o === value}
              className={o === value ? 'is-on' : ''}
              onClick={() => {
                onPick(o);
                setOpen(false);
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export default function TimeSelect({ value = '', onChange, disabled = false, label = 'เวลา' }) {
  const [hour = '', minute = ''] = value ? value.split(':') : [];

  // ยังไม่เลือกชั่วโมง = ยังไม่ถือว่ามีเวลา · เลือกชั่วโมงแล้วไม่แตะนาที = ลงตัวที่ 00
  const emit = (h, m) => onChange(h ? `${h}:${m || '00'}` : '');

  return (
    <span className="time-select">
      <Picker
        label={`${label} — ชั่วโมง`}
        value={hour}
        options={HOURS}
        disabled={disabled}
        onPick={(h) => emit(h, minute)}
      />
      <span aria-hidden="true">:</span>
      <Picker
        label={`${label} — นาที`}
        // นาทีที่ไม่ตรงช่วง 5 นาที (ข้อมูลเดิม/แก้ผ่าน API) ต้องมีให้เลือกด้วย ไม่งั้นค่าที่เห็นจะหายไปเฉยๆ
        value={minute}
        options={MINUTES.includes(minute) || !minute ? MINUTES : [minute, ...MINUTES]}
        disabled={disabled}
        onPick={(m) => emit(hour || '00', m)}
      />
    </span>
  );
}
