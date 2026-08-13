import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

const GAP = 4;         // ระยะระหว่างปุ่มกับรายการ
const WANT = 176;      // ความสูงที่อยากได้ (11rem ≈ 6 บรรทัด) — ย่อลงได้ถ้าที่ไม่พอ
const LEAST = 96;      // เตี้ยกว่านี้เลือกไม่ไหว ยอมให้ล้นออกนอกที่ว่างดีกว่า

/**
 * dropdown ขนาดเล็กที่คุมความสูงเองได้
 *
 * รายการวาดที่ <body> ด้วย position: fixed ไม่ใช่วางซ้อนในตัวมันเอง
 * เพราะช่องเลือกเวลาถูกใช้ในกล่อง popup ที่เนื้อในเลื่อนได้ (overflow-y: auto)
 * กล่องแบบนั้น "ตัด" ทุกอย่างที่ล้นออกนอกตัวเอง รายการจึงเหลือโผล่มาแค่สองบรรทัด
 * พร้อมแถบเลื่อนของกล่องแม่ — และบนมือถือมันไปโผล่ทับหัว popup จนไม่เห็นว่าตั้งเวลาให้วันไหน
 *
 * เปิดขึ้นบนแทนถ้าที่ว่างข้างล่างไม่พอ — ช่องเลือกเวลามักอยู่ใกล้ขอบล่างจอบนมือถือ
 */
function Picker({ value, options, onPick, disabled, label }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const listRef = useRef(null);

  /* ตำแหน่งของรายการคิดจากตำแหน่งจริงของปุ่มบนหน้าจอ ณ ตอนนั้น
     ต้องคิดใหม่ทุกครั้งที่มีอะไรเลื่อน (เนื้อใน popup เลื่อนได้) ไม่งั้นรายการค้างอยู่ที่เดิมขณะปุ่มเลื่อนหนีไป */
  const place = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    const up = below < WANT && above > below;
    setPos({
      left: r.left,
      width: r.width,
      maxHeight: Math.max(LEAST, Math.min(WANT, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  /* เลื่อนให้ค่าที่เลือกอยู่เห็นได้ ไม่ใช่ให้ไล่หาเองทุกครั้งที่เปิด (เลือก 20:00 ไว้ ต้องไม่เปิดมาเจอ 00)
     ต้องรอให้รายการถูกวาดจริงก่อน — จังหวะที่กดเปิด ตำแหน่งยังคำนวณไม่เสร็จ รายการจึงยังไม่มีตัวตน
     ทำครั้งเดียวต่อการเปิดหนึ่งครั้ง: pos เปลี่ยนทุกครั้งที่มีอะไรเลื่อน ถ้าไม่กันไว้
     รายการจะดีดกลับไปที่ค่าที่เลือกทุกครั้งที่ผู้ใช้กำลังเลื่อนหาเลขอื่นอยู่
     block: 'nearest' — 'center' จะสั่งให้กล่องแม่ทุกชั้นเลื่อนตามด้วย หน้าจอข้างหลังเลยกระโดด */
  const scrolledRef = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      scrolledRef.current = false;
      return;
    }
    if (!pos || scrolledRef.current) return;
    scrolledRef.current = true;
    listRef.current?.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' });
  }, [open, pos]);

  useEffect(() => {
    if (!open) return undefined;

    // capture — ต้องรู้ทุกการเลื่อน รวมถึงในกล่องที่เลื่อนได้ข้างใน ซึ่ง scroll ไม่ลอยขึ้นมาถึง document
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);

    const onDown = (e) => {
      // รายการอยู่นอก .picker แล้ว (วาดที่ body) ต้องยกเว้นให้ด้วย
      // ไม่งั้นแตะตัวเลือกจะถูกนับเป็น "แตะข้างนอก" แล้วรายการปิดไปก่อนที่ click จะทำงาน = เลือกไม่ได้เลย
      if (!boxRef.current?.contains(e.target) && !listRef.current?.contains(e.target)) setOpen(false);
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
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, place]);

  return (
    <span className="picker" ref={boxRef}>
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

      {open && pos &&
        createPortal(
          // ตัวเลือกต้องเป็นลูกโดยตรงของ listbox — ห่อด้วย <li> อีกชั้นแล้วโปรแกรมอ่านหน้าจอจะจับคู่ไม่ติด
          <div className="picker-list" role="listbox" aria-label={label} ref={listRef} style={pos}>
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
          </div>,
          document.body,
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
