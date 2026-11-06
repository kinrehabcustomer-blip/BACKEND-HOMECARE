import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* แยกจาก FilterBar.jsx — ไฟล์คอมโพเนนต์ที่ export hook ด้วยทำให้ fast refresh ของ Vite ใช้ไม่ได้
   ชิปอ่านจาก <select> จริงในแผ่น (SearchSelect ก็เป็น <select> จริงข้างใต้) — แผ่นจึง mount ค้างไว้ตลอด (แค่ซ่อน)
   แผ่น portal ไปที่ body — .pull-content ของดึงรีเฟรชใส่ transform ตอนดึง ซึ่งจะลาก position: fixed ไปด้วย */

/* ตัด "(12)" ท้ายตัวเลือก (จำนวนรายการ) — ในชิปเหลือแค่ชื่อตัวกรอง */
const chipText = (text) => text.replace(/\s*\(\d[\d,]*\)\s*$/, '').trim();

/** ล้าง <select> ช่องเดียวแบบเดียวกับที่ผู้ใช้เลือกเอง — React รับ change event จริงแล้วไปเรียก onChange ของหน้านั้น */
function resetSelect(select) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setValue.call(select, '');
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ไอคอนเส้นในปุ่ม/ชิป — ฟังก์ชันธรรมดา ไม่ใช่คอมโพเนนต์ (ไฟล์นี้ export hook) */
const ico = (children) => (
  <svg className="fbar-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/**
 * ปุ่ม "ตัวกรอง" + ชิปตัวกรองที่ติดอยู่ + แผ่นตัวกรอง (เลื่อนลงจากขอบบน) — ชิ้นส่วนมือถือที่ใช้ร่วมกัน
 * FilterBar ใช้ตัวนี้ และหน้าที่มีแถบตัวกรองของตัวเอง (หน้าการมาทำงาน) ก็หยิบไปวางในแถบเดิมได้
 *
 * filters  = dropdown ที่จะอยู่ในแผ่น (SearchSelect/<select>) — ชิปอ่านค่าจาก <select> จริงในแผ่น
 * filtered = มีอะไรกรองอยู่ไหม (รวมคำค้น) — ไม่มี = ไม่วาดแถวชิป
 * onClear  = ล้างทั้งหมด (ปุ่ม "ล้างทั้งหมด" ในแถวชิป และ "ล้างตัวกรอง" ในแผ่น)
 * คืน { button, chips, sheet } — วาดเองตามตำแหน่งที่ต้องการ (sheet portal ไปที่ body อยู่แล้ว)
 */
export function useFilterSheet({ filters, filtered, onClear }) {
  const [open, setOpen] = useState(false);
  const [chips, setChips] = useState([]);
  const fieldsRef = useRef(null);

  /* อ่านตัวกรองที่ติดอยู่หลังทุก render — ค่าเปลี่ยนเมื่อไหร่หน้าแม่ render ใหม่ (ค่าอยู่ใน URL) แถบนี้ก็ตามมาเอง
     เทียบก่อน set กันวน render ไม่รู้จบ · ไม่มี deps โดยตั้งใจ (ค่าอยู่ใน DOM ไม่ใช่ใน prop) */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const root = fieldsRef.current;
    const next = !root ? [] : [...root.querySelectorAll('select')]
      .map((s, i) => ({ i, value: s.value, label: chipText(s.selectedOptions[0]?.text ?? '') }))
      .filter((c) => c.value !== '' && c.label);
    setChips((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const clearOne = (chip) => {
    const select = fieldsRef.current?.querySelectorAll('select')[chip.i];
    if (select) resetSelect(select);
  };

  const button = (
    <button
      type="button"
      className={`btn fbar-btn${chips.length ? ' is-on' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      {ico(<><path d="M4 6h16M7 12h10M10 18h4" /></>)}
      <span>ตัวกรอง</span>
      {chips.length > 0 && <span className="fbar-count" aria-label={`ใช้อยู่ ${chips.length} ตัว`}>{chips.length}</span>}
    </button>
  );

  const chipRow = filtered ? (
    <div className="fbar-chips">
      {chips.map((c) => (
        <button key={c.i} type="button" className="fbar-chip" onClick={() => clearOne(c)} aria-label={`เอาตัวกรอง ${c.label} ออก`}>
          {c.label}
          {ico(<><path d="M6 6l12 12M18 6L6 18" /></>)}
        </button>
      ))}
      <button type="button" className="fbar-chip fbar-chip-clear" onClick={onClear}>ล้างทั้งหมด</button>
    </div>
  ) : null;

  const sheet = createPortal(
    <div className="fbar-sheet-wrap" hidden={!open}>
      <div className="fbar-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="fbar-sheet" role="dialog" aria-modal="true" aria-label="ตัวกรอง">
        {/* ไม่มีหัวแผ่น — ทั้งชื่อ "ตัวกรอง" และปุ่ม ✕ (ผู้ใช้ขอ 6 พ.ย. 2569) · ชื่อแผ่นยังอยู่ใน aria-label ให้โปรแกรมอ่านหน้าจอ
            ปิดด้วยการแตะพื้นที่มืดนอกแผ่น · ปุ่ม "ดูผลลัพธ์" · Esc */}
        <div className="fbar-fields" ref={fieldsRef}>{filters}</div>
        <div className="fbar-sheet-foot">
          <button type="button" className="btn" onClick={onClear} disabled={!chips.length}>ล้างตัวกรอง</button>
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>ดูผลลัพธ์</button>
        </div>
      </div>
    </div>,
    document.body,
  );

  return { button, chips: chipRow, sheet };
}

