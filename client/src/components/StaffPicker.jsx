import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import LineIcon from './LineIcon.jsx';
import { POSITION_LABELS } from '../labels.js';
import { useScrollLock } from '../lib/scrollLock.js';

/**
 * ช่องเลือกพนักงานรับเคส — แทน <select> ที่เคยใช้
 *
 * ทำไมไม่ใช้ <select>
 *   รายการที่กางออกมาเบราว์เซอร์เป็นคนวาด บน iOS ข้อความยาว "รหัส · ชื่อ (ตำแหน่ง) · ถืออยู่ n เคส"
 *   ถูกหักเป็นสามบรรทัดต่อคน กวาดตาหาชื่อแทบไม่ได้ และจัดหน้าตาอะไรไม่ได้เลย
 *   ที่นี่วาดเองเป็นสองบรรทัด: ชื่อตัวใหญ่ กับรายละเอียดตัวเล็กข้างใต้
 *
 * จอแคบ (มือถือ) = แผ่นเลื่อนขึ้นจากขอบล่าง กดง่ายด้วยนิ้วโป้ง
 * จอกว้าง = รายการกางใต้ปุ่ม วาดที่ <body> แบบ fixed ด้วยเหตุผลเดียวกับ TimeSelect
 * (ช่องนี้อยู่ในกล่อง popup ที่เนื้อในเลื่อนได้ ซึ่งตัดทุกอย่างที่ล้นออกนอกตัวเอง)
 */

const GAP = 4;
const WANT = 320;   // ความสูงที่อยากได้ของรายการบนจอกว้าง (~6 คน)
const LEAST = 140;
const MOBILE = '(max-width: 640px)';

export default function StaffPicker({
  staff,
  value,
  onChange,
  wantedPositions = null,
  placeholder = '— เลือกพนักงาน —',
  emptyText = 'ไม่มีพนักงานให้เลือก',
  label = 'เลือกพนักงาน',
  name,
  disabled = false,
  invalid = false,
}) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);

  const selected = staff.find((e) => e.employee_id === value) ?? null;
  const mismatch = (e) => Boolean(wantedPositions) && !wantedPositions.includes(e.position);

  // แผ่นจากขอบล่างบังทั้งจอ — หน้าข้างหลังต้องไม่เลื่อนตามนิ้ว (รายการแบบกางใต้ปุ่มไม่ต้องล็อก)
  useScrollLock(open && sheet);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
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

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  function toggle() {
    if (open) return close();
    setSheet(window.matchMedia(MOBILE).matches);
    setOpen(true);
  }

  function pick(id) {
    onChange(id);
    close();
  }

  useLayoutEffect(() => {
    if (open && !sheet) place();
  }, [open, sheet, place]);

  // เปิดแล้วโฟกัสคนที่เลือกอยู่ (หรือบรรทัดแรก) — ใช้ลูกศรขึ้นลงต่อได้ทันที และเลื่อนให้เห็นคนที่เลือกไว้
  useLayoutEffect(() => {
    if (!open || (!sheet && !pos)) return;
    const list = listRef.current;
    const target = list?.querySelector('[aria-selected="true"]') ?? list?.querySelector('[role="option"]');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
    // ทำครั้งเดียวต่อการเปิดหนึ่งครั้ง — pos เปลี่ยนทุกครั้งที่หน้าเลื่อน
  }, [open, sheet, Boolean(pos)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;

    const onDown = (e) => {
      if (!boxRef.current?.contains(e.target) && !listRef.current?.contains(e.target)) close(false);
    };
    /* Esc ปิดแค่รายการนี้ ไม่ใช่ popup ที่ครอบอยู่ — ดักช่วง capture แล้วหยุดส่งต่อ (แบบเดียวกับ TimeSelect) */
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const opts = [...(listRef.current?.querySelectorAll('[role="option"]') ?? [])];
      if (opts.length === 0) return;
      e.preventDefault();
      const i = opts.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
      opts[next].focus();
    };

    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    if (!sheet) {
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    }
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, sheet, place, close]);

  const options = (
    <>
      <button
        type="button"
        role="option"
        aria-selected={!value}
        className={`staff-opt staff-opt-none${!value ? ' is-on' : ''}`}
        onClick={() => pick('')}
      >
        <span className="staff-opt-name">{placeholder}</span>
      </button>
      {staff.length === 0 && <p className="staff-empty">{emptyText}</p>}
      {staff.map((e) => (
        <button
          key={e.employee_id}
          type="button"
          role="option"
          aria-selected={e.employee_id === value}
          className={`staff-opt${e.employee_id === value ? ' is-on' : ''}`}
          onClick={() => pick(e.employee_id)}
        >
          <span className="staff-opt-main">
            <span className="staff-opt-name">{e.first_name} {e.last_name}</span>
            <span className="staff-opt-sub">
              <span className="mono">{e.employee_id}</span> · {POSITION_LABELS[e.position] ?? e.position}
              {' · '}ถืออยู่ {e.active_cases ?? 0} เคส
            </span>
          </span>
          {mismatch(e) && <span className="staff-opt-tag">ไม่ตรงระดับ</span>}
          {e.employee_id === value && <LineIcon name="check" className="staff-opt-check" />}
        </button>
      ))}
    </>
  );

  return (
    <span className="staff-picker" ref={boxRef}>
      {/* ค่าจริงสำหรับฟอร์ม + จุดที่ฟอร์มเลื่อนจอไปหาตอน server ทักว่าช่องนี้ผิด (querySelector('[name=…]')) */}
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      <button
        type="button"
        ref={btnRef}
        className="staff-picker-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={selected ? `${label}: ${selected.first_name} ${selected.last_name}` : label}
        aria-invalid={invalid || undefined}
        onClick={toggle}
      >
        {selected ? (
          <span className="staff-opt-main">
            <span className="staff-opt-name">{selected.first_name} {selected.last_name}</span>
            <span className="staff-opt-sub">
              <span className="mono">{selected.employee_id}</span> · {POSITION_LABELS[selected.position] ?? selected.position}
              {mismatch(selected) && ' · ไม่ตรงระดับ'}
            </span>
          </span>
        ) : (
          <span className="staff-picker-placeholder">{placeholder}</span>
        )}
        <LineIcon name="chevron" className="picker-caret" />
      </button>

      {open && sheet &&
        createPortal(
          <div className="staff-sheet-backdrop">
            <div className="staff-sheet" role="dialog" aria-modal="true" aria-label={label}>
              <div className="staff-sheet-head">
                <strong>{label}</strong>
                <button type="button" className="staff-sheet-close" aria-label="ปิด" onClick={() => close()}>
                  <LineIcon name="close" />
                </button>
              </div>
              <div className="staff-sheet-list" role="listbox" aria-label={label} ref={listRef}>
                {options}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {open && !sheet && pos &&
        createPortal(
          <div className="staff-pop" role="listbox" aria-label={label} ref={listRef} style={pos}>
            {options}
          </div>,
          document.body,
        )}
    </span>
  );
}
