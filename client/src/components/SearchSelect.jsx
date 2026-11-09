import { Children, Fragment, forwardRef, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * <select> ที่พิมพ์ค้นหาได้ — ใช้แทน <select> ธรรมดาได้ทุกที่ (ชื่อ prop และ <option> เหมือนเดิมทุกอย่าง)
 *
 * ตัวช่องยังเป็น <select> จริง จึงได้ทุกอย่างของเดิมฟรี: สไตล์ (.toolbar select ฯลฯ) · required/disabled
 * · การตรวจฟอร์มของเบราว์เซอร์ · onChange ที่รับ event จริง (e.target.value)
 * ที่ต่างคือดักตอนกด/กดปุ่มเปิดรายการ แล้วกางรายการของเราเองที่มีช่องค้นหาแทนรายการของเบราว์เซอร์
 * เลือกค่าแล้วสั่งให้ <select> จริงเปลี่ยนค่าและยิง change ตามปกติ
 */

/** ข้อความของ <option> — ลูกเป็นสตริง/ตัวเลขล้วน */
const textOf = (node) => Children.toArray(node).join('');

/* จอสัมผัส (มือถือ/แท็บเล็ต) — iOS Safari เปิดรายการของเครื่อง (picker) ทุกครั้งที่ <select> ได้โฟกัส
   แม้จะสั่ง focus() จากโค้ด: เลือกจากรายการของเราแล้วคืนโฟกัสให้ช่อง = picker เด้งซ้อนขึ้นมาอีกอัน
   คืนโฟกัสจึงทำเฉพาะเครื่องที่ใช้เมาส์/คีย์บอร์ด (ที่นั่นจำเป็น — กด Tab ต่อจากช่องเดิมได้) */
const isTouch = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const refocus = (el) => { if (el && !isTouch()) el.focus(); };

/** แตก <option>/<optgroup>/Fragment/อาร์เรย์ ที่ซ้อนกันอยู่ ออกมาเป็นรายการแบน */
function flatten(children, group = null, out = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) {
      flatten(child.props.children, group, out);
      return;
    }
    if (child.type === 'optgroup') {
      flatten(child.props.children, child.props.label, out);
      return;
    }
    if (child.type !== 'option' || child.props.hidden) return;
    const label = textOf(child.props.children);
    out.push({
      value: String(child.props.value ?? label),
      label,
      disabled: Boolean(child.props.disabled),
      group,
    });
  });
  return out;
}

const SearchSelect = forwardRef(function SearchSelect({ children, onMouseDown, onKeyDown, onClick, ...rest }, forwardedRef) {
  const ref = useRef(null);
  const setRef = useCallback(
    (node) => {
      ref.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const popRef = useRef(null);

  const options = useMemo(() => flatten(children), [children]);
  const current = ref.current?.value ?? String(rest.value ?? rest.defaultValue ?? '');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  /** วางรายการใต้ช่อง (หรือเหนือช่องถ้าข้างล่างไม่พอ) — เรียกซ้ำได้ตอนจอเลื่อนเพราะคีย์บอร์ดมือถือเด้งขึ้น */
  const measure = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const width = Math.max(rect.width, 240);
    const up = below < 220 && rect.top > below; // ที่ล่างไม่พอและด้านบนกว้างกว่า = กางขึ้น
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      ...(up
        ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.min(320, rect.top - 12) }
        : { top: rect.bottom + 4, maxHeight: Math.min(320, below - 12) }),
    });
  }, []);

  function openList() {
    if (rest.disabled || !ref.current) return;
    measure();
    const at = options.findIndex((o) => o.value === ref.current.value);
    setActive(Math.max(0, at));
    setOpen(true);
  }

  function choose(opt) {
    if (opt.disabled) return;
    const el = ref.current;
    if (el && el.value !== opt.value) {
      // ตั้งค่าและยิง change จริง — onChange ของผู้เรียกได้ event ตามปกติ (ทั้งแบบ controlled และไม่ controlled)
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, opt.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
    refocus(el);
  }

  /* จอสัมผัสไม่โฟกัสช่องค้นหาให้เอง — คีย์บอร์ดจะเด้งขึ้นมาบังรายการทันทีทั้งที่ส่วนใหญ่แค่จะแตะเลือก
     อยากค้นหาค่อยแตะช่องค้นหาเอง */
  useLayoutEffect(() => {
    if (open && !isTouch()) searchRef.current?.focus();
  }, [open]);

  // เลื่อนรายการให้ตัวที่ชี้อยู่เห็นเสมอ
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, shown]);

  // ปิดเมื่อกดนอกรายการ / เลื่อนหน้า / ปรับขนาดจอ (ตำแหน่งที่คำนวณไว้จะเพี้ยน)
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || ref.current?.contains(e.target)) return;
      close();
    };
    /* กำลังพิมพ์ในช่องค้นหาอยู่ = จอเลื่อน/หดเพราะคีย์บอร์ดมือถือ (iOS เลื่อนหน้าให้ช่องที่โฟกัสพ้นคีย์บอร์ดเอง)
       ไม่ใช่ผู้ใช้เลื่อนหนี — ย้ายรายการตามช่องแทนการปิดทิ้ง ไม่งั้นแตะแล้วรายการเด้งปิดทันที */
    const typing = () => popRef.current?.contains(document.activeElement);
    const onScroll = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (typing()) measure();
      else close();
    };
    const onResize = () => (typing() ? measure() : close());
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close, measure]);

  function onSearchKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // ไม่ให้ปิด popup/โมดัลแม่ไปด้วย
      e.nativeEvent.stopImmediatePropagation();
      close();
      refocus(ref.current);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (shown[active]) choose(shown[active]);
    } else if (e.key === 'Tab') {
      close();
    }
  }

  let lastGroup = null;
  return (
    <>
      <select
        {...rest}
        ref={setRef}
        onMouseDown={(e) => {
          onMouseDown?.(e);
          if (e.button !== 0) return;
          e.preventDefault(); // ไม่ให้รายการของเบราว์เซอร์เปิด
          if (open) close();
          else {
            refocus(ref.current);
            openList();
          }
        }}
        onClick={(e) => {
          onClick?.(e);
          e.preventDefault();
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (['ArrowDown', 'ArrowUp', ' ', 'Enter'].includes(e.key)) {
            if (e.key === 'Enter' && e.target.form && !open) return; // Enter ส่งฟอร์มตามปกติ
            e.preventDefault();
            openList();
          }
        }}
      >
        {children}
      </select>

      {open && pos && createPortal(
        <div className="ss-pop" style={pos} role="listbox" ref={popRef}>
          <input
            ref={searchRef}
            className="ss-search"
            type="text"
            placeholder="พิมพ์เพื่อค้นหา…"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKey}
          />
          <ul className="ss-list" ref={listRef}>
            {shown.length === 0 && <li className="ss-empty">ไม่พบรายการที่ตรงกับ “{query}”</li>}
            {shown.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? <li className="ss-group" key={`g-${o.group}`}>{o.group}</li> : null;
              lastGroup = o.group;
              return (
                <Fragment key={`${o.value}-${i}`}>
                  {head}
                  <li
                    role="option"
                    aria-selected={o.value === current}
                    aria-disabled={o.disabled || undefined}
                    data-active={i === active}
                    className={`ss-item ${o.value === current ? 'is-selected' : ''} ${o.disabled ? 'is-disabled' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(o);
                    }}
                  >
                    {o.label || '—'}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
});

export default SearchSelect;
