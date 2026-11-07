import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PROCEDURE_MIN_CHARS, RATE_LABELS, defaultRate, rateNumber, searchProcedures } from '../lib/procedureCatalog.js';

/**
 * ช่องชื่อหัตถการ — พิมพ์ค้นหาจากรายการมาตรฐาน (ขึ้นรายการเมื่อพิมพ์ครบ 3 ตัวอักษร)
 * เลือกจากรายการแล้วใส่ชื่อให้ · พิมพ์ชื่อเองที่ไม่อยู่ในรายการก็ยังได้ (ข้อมูลเก่าเป็นข้อความอิสระ)
 * รายการวาดที่ <body> แบบ fixed เหมือน SearchSelect เพราะช่องนี้อยู่ในกล่องที่ตัดของที่ล้นออกนอกตัวเอง
 */
export default function ProcedureNameInput({ value, onChange, onPick, ...rest }) {
  const inputRef = useRef(null);
  const popRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);

  const matches = useMemo(() => searchProcedures(value ?? ''), [value]);
  const showing = open && matches.length > 0;
  const typed = (value ?? '').trim().length;

  const place = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 8;
    const up = below < 220 && rect.top > below;
    setPos({
      left: rect.left,
      width: rect.width,
      ...(up
        ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.min(320, rect.top - 12) }
        : { top: rect.bottom + 4, maxHeight: Math.min(320, below) }),
    });
  }, []);

  useEffect(() => {
    if (!showing) return undefined;
    place();
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || inputRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => {
      if (!popRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [showing, place]);

  useEffect(() => {
    if (!showing) return;
    popRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [showing, active]);

  /** rate = 'visit' | 'day' | 'month' ที่กดชิป · ไม่ระบุ = ราคาแรกที่มี (ครั้ง → วัน → เดือน) */
  function pick(p, rate) {
    const text = rate ? p.rates[rate] : defaultRate(p);
    if (onPick) onPick(p, text ? rateNumber(text) : null);
    else onChange(p.name);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e) {
    if (!showing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault(); // ไม่ส่งฟอร์ม — เลือกรายการที่ชี้อยู่
      pick(matches[Math.min(active, matches.length - 1)]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation(); // ไม่ให้ปิดโมดัลแม่ไปด้วย
      setOpen(false);
    }
  }

  return (
    <>
      <input
        {...rest}
        ref={inputRef}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={showing}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && typed > 0 && typed < PROCEDURE_MIN_CHARS && (
        <span className="form-hint muted">พิมพ์อีก {PROCEDURE_MIN_CHARS - typed} ตัวอักษรเพื่อค้นหาหัตถการ</span>
      )}
      {showing && pos && createPortal(
        <div className="ss-pop" style={pos} role="listbox" ref={popRef}>
          <ul className="ss-list">
            {matches.map((p, i) => (
              <li
                key={p.code}
                role="option"
                aria-selected={p.name === value}
                data-active={i === active}
                className={`ss-item ${p.name === value ? 'is-selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p);
                }}
              >
                <span className="proc-opt-main">
                  <span className="mono muted">{p.code}</span> {p.name}
                </span>
                <span className="proc-rates">
                  {Object.entries(RATE_LABELS).map(([k, label]) => (
                    <button
                      type="button"
                      key={k}
                      className="proc-rate"
                      disabled={!p.rates[k]}
                      tabIndex={-1}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        pick(p, k);
                      }}
                    >
                      <small>ราย{label}</small>
                      <b>{p.rates[k] ?? '-'}</b>
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
