import { useEffect } from 'react';

/*
 * ล็อกการเลื่อนหน้าหลังตอนมี popup เปิดอยู่ — นับชั้นการซ้อน ไม่ใช่ตั้ง/ล้างตรงๆ
 *
 * popup ในระบบนี้ซ้อนกันได้จริง (เคส → ตารางกะ, เคส → ใบแจ้งหนี้, ใบแจ้งหนี้ → กล่องยืนยันลบ)
 * ถ้าแต่ละตัวสั่ง overflow = 'hidden' ตอนเปิดแล้วสั่ง '' ตอนปิดเหมือนกันหมด
 * การปิดแผ่นบนจะไปปลดล็อกให้ทั้งกอง — หน้าหลังเลื่อนได้ทั้งที่ popup แม่ยังเปิดอยู่
 * (ซึ่งบนมือถือแปลว่านิ้วปัดในกล่องแล้วหน้าข้างหลังไหลตามไปด้วย)
 *
 * ตัวนับกลางแก้ปัญหานี้โดยไม่ต้องให้ popup แต่ละตัวรู้ว่าตัวเองซ้อนอยู่บนอะไร:
 * ล็อกตอนชั้นแรกเปิด และคืนค่าเดิมตอนชั้นสุดท้ายปิดเท่านั้น
 */
let depth = 0;
let previous = '';

export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return undefined;

    if (depth === 0) {
      previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    depth += 1;

    return () => {
      depth -= 1;
      if (depth === 0) document.body.style.overflow = previous;
    };
  }, [active]);
}
