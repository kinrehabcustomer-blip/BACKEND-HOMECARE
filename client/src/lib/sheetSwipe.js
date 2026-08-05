import { useEffect, useRef } from 'react';

// ระยะ/ความเร็วที่ถือว่า "ตั้งใจปัดปิด" — อย่างใดอย่างหนึ่งถึงก็พอ
// ปัดสั้นแต่เร็ว (สะบัดนิ้ว) กับปัดยาวแต่ช้า เป็นท่าปิดทั้งคู่
const CLOSE_DISTANCE = 110;  // px
const CLOSE_VELOCITY = 0.5;  // px ต่อ ms

// ต้องเลื่อนนิ้วเกินระยะนี้ก่อนถึงเริ่มลากจริง — กันกล่องขยับตอนแค่แตะหรือนิ้วสั่น
// และเป็นจังหวะให้เบราว์เซอร์ตัดสินใจก่อนว่าท่านี้คือ scroll หรือ drag
const START_THRESHOLD = 8;   // px

const CLOSE_MS = 200;        // เวลาที่ใช้ไถลลงไปจนสุดก่อนปิดจริง (ต้องตรงกับ transition ใน CSS)

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
    let active = false;   // นิ้วแตะอยู่และมีสิทธิ์ลาก
    let dragging = false; // เลื่อนเกินระยะเริ่มแล้ว กล่องกำลังขยับตามนิ้ว
    let frame = 0;
    let closeTimer = 0;

    /**
     * เขียน transform ทีละเฟรม ไม่ใช่ทุก touchmove
     * touchmove ยิงถี่กว่าอัตราการวาดจอ — เขียนทุกครั้งคือสั่งงานทิ้งเปล่าและทำให้ภาพสะดุด
     */
    const paint = () => {
      frame = 0;
      el.style.transform = `translate3d(0, ${dy}px, 0)`;
    };

    /** นิ้วแตะอยู่ในส่วนที่เลื่อนค้างไว้อยู่หรือเปล่า — ถ้าใช่ การปัดลงคือการเลื่อนอ่าน ไม่ใช่การปิด */
    const scrolledInside = (target) => {
      for (let n = target; n && n !== el; n = n.parentElement) {
        if (n.scrollTop > 0) return true;
      }
      return false;
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      active = false;
      dragging = false;
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
    };

    const onStart = (e) => {
      if (!sheet.matches || e.touches.length !== 1) return;
      const t = e.target;
      if (t.closest?.('input, textarea, select, [contenteditable]')) return;
      if (scrolledInside(t)) return;

      startY = e.touches[0].clientY;
      startAt = e.timeStamp;
      dy = 0;
      active = true;
      dragging = false;
    };

    const onMove = (e) => {
      if (!active) return;
      const raw = e.touches[0].clientY - startY;

      if (raw <= 0) {
        // ปัดขึ้น = ไม่ใช่ท่าปิด ยกเลิกแล้วปล่อยให้เลื่อนเนื้อหาตามปกติ
        if (dragging) stop();
        active = false;
        return;
      }

      if (!dragging) {
        if (raw < START_THRESHOLD) return; // ยังไม่พอ ปล่อยให้เบราว์เซอร์ตัดสินใจก่อน
        dragging = true;
        // ปิด transition ระหว่างลากเพื่อให้ตามนิ้วทันที และบอกเบราว์เซอร์ให้ยกขึ้นเลเยอร์ของ GPU ไว้ก่อน
        el.style.transition = 'none';
        el.style.willChange = 'transform';
      }

      // ลบระยะเริ่มออก — ไม่งั้นกล่องจะกระโดด 8px ทันทีที่เริ่มลาก
      dy = raw - START_THRESHOLD;
      e.preventDefault(); // กันหน้าข้างหลังเลื่อนตามนิ้วไปด้วย
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onEnd = (e) => {
      if (!active) return;
      if (!dragging) {
        active = false;
        return;
      }

      const velocity = dy / Math.max(1, e.timeStamp - startAt);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;

      if (dy > CLOSE_DISTANCE || velocity > CLOSE_VELOCITY) {
        /* ไถลลงจนพ้นจอก่อนแล้วค่อยปิด — เดิมปิดทันทีที่ปล่อยนิ้ว กล่องจึงหายวับ
           ทั้งที่นิ้วเพิ่งลากมาได้ครึ่งทาง ความรู้สึกเลยเหมือนภาพกระชาก */
        el.style.transition = `transform ${CLOSE_MS}ms cubic-bezier(0.32, 0, 0.67, 0)`;
        el.style.transform = `translate3d(0, ${el.offsetHeight}px, 0)`;
        active = false;
        dragging = false;
        closeTimer = setTimeout(() => close.current?.(), CLOSE_MS);
        return;
      }

      // ไม่ถึงเกณฑ์ = ดีดกลับที่เดิม (เส้นโค้งอยู่ใน CSS ของ .modal)
      stop();
    };

    // passive: false เฉพาะ touchmove เพราะต้อง preventDefault ได้ ส่วนที่เหลือไม่ต้องบล็อกอะไร
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });

    return () => {
      clearTimeout(closeTimer);
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // ref เป็นกล่องที่ตัวมันเองไม่เปลี่ยน (ทั้งของตัวเองและที่รับมา) — ใส่ใน deps ไม่ทำให้ effect รันใหม่
  }, [ref]);

  return ref;
}
