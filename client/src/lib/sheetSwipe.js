import { useEffect, useRef } from 'react';

// ระยะ/ความเร็วที่ถือว่า "ตั้งใจปัดปิด" — อย่างใดอย่างหนึ่งถึงก็พอ
// ปัดสั้นแต่เร็ว (สะบัดนิ้ว) กับปัดยาวแต่ช้า เป็นท่าปิดทั้งคู่
const CLOSE_DISTANCE = 110;  // px
const CLOSE_VELOCITY = 0.5;  // px ต่อ ms

/**
 * ปัดลงเพื่อปิดกล่อง — ใช้เฉพาะจอแคบที่กล่องเป็นแผ่นเลื่อนขึ้นมาจากขอบล่าง
 * (จอกว้างกล่องลอยอยู่กลางจอ การปัดลงไม่สื่อความหมายอะไร)
 *
 * คืน ref ไปแปะที่ <div className="modal"> ได้เลย
 * กล่องที่มี ref ของตัวเองอยู่แล้ว (เช่นตัวที่ทำ focus trap) ส่ง ref นั้นเข้ามาเป็นอาร์กิวเมนต์ที่สอง
 * แล้วใช้ ref เดิมต่อได้ — element เดียวแปะสอง ref ไม่ได้
 *
 * กติกาที่ทำให้ไม่ไปทับการใช้งานอื่น:
 *   - เริ่มลากได้เฉพาะตอนเนื้อหาข้างในเลื่อนอยู่บนสุด ไม่งั้นการปัดลงคือการเลื่อนอ่านเนื้อหา
 *   - ไม่เริ่มลากถ้านิ้วแตะช่องกรอก (จะได้เลือกข้อความ/วางเคอร์เซอร์ได้ตามปกติ)
 *   - ปัดขึ้นปล่อยผ่านทันที เป็นการเลื่อนเนื้อหาปกติ
 */
export function useSheetSwipe(onClose, externalRef) {
  const ownRef = useRef(null);
  const ref = externalRef ?? ownRef;
  // เก็บ onClose ล่าสุดไว้ใน ref — ผู้เรียกมักส่งฟังก์ชันใหม่ทุก render
  // ถ้าใส่ใน deps ของ effect จะถอด/ใส่ listener ใหม่ทุกครั้งโดยไม่จำเป็น
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const sheet = window.matchMedia('(max-width: 600px)');
    let startY = 0;
    let startAt = 0;
    let dy = 0;
    let dragging = false;

    /** นิ้วแตะอยู่ในส่วนที่เลื่อนค้างไว้อยู่หรือเปล่า — ถ้าใช่ การปัดลงคือการเลื่อนอ่าน ไม่ใช่การปิด */
    const scrolledInside = (target) => {
      for (let n = target; n && n !== el; n = n.parentElement) {
        if (n.scrollTop > 0) return true;
      }
      return false;
    };

    const reset = () => {
      el.style.transition = '';
      el.style.transform = '';
    };

    const onStart = (e) => {
      if (!sheet.matches || e.touches.length !== 1) return;
      const t = e.target;
      if (t.closest?.('input, textarea, select, [contenteditable]')) return;
      if (scrolledInside(t)) return;

      startY = e.touches[0].clientY;
      startAt = e.timeStamp;
      dy = 0;
      dragging = true;
      el.style.transition = 'none'; // ระหว่างลากต้องตามนิ้วทันที ไม่หน่วง
    };

    const onMove = (e) => {
      if (!dragging) return;
      dy = e.touches[0].clientY - startY;

      if (dy <= 0) {
        // ปัดขึ้น = ไม่ใช่ท่าปิด ยกเลิกการลากแล้วปล่อยให้เลื่อนเนื้อหาตามปกติ
        dragging = false;
        reset();
        return;
      }

      e.preventDefault(); // กันหน้าข้างหลังเลื่อนตามนิ้วไปด้วย
      el.style.transform = `translateY(${dy}px)`;
    };

    const onEnd = (e) => {
      if (!dragging) return;
      dragging = false;

      const velocity = dy / Math.max(1, e.timeStamp - startAt);
      reset();
      if (dy > CLOSE_DISTANCE || velocity > CLOSE_VELOCITY) close.current?.();
    };

    // passive: false เฉพาะ touchmove เพราะต้อง preventDefault ได้ ส่วนอีกสองตัวไม่ต้องบล็อกอะไร
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // ref เป็นกล่องที่ตัวมันเองไม่เปลี่ยน (ทั้งของตัวเองและที่รับมา) — ใส่ใน deps ไม่ทำให้ effect รันใหม่
    // แต่ oxlint มองไม่เห็นข้อนี้ จึงต้องบอกไว้ ไม่งั้นเตือนทุกครั้ง
  }, [ref]);

  return ref;
}
