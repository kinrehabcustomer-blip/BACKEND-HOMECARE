import { useEffect, useRef } from 'react';

// ระยะที่ต้องลากถึงจะถือว่า "ตั้งใจรีเฟรช" — สั้นกว่านี้จะโดนตอนเลื่อนอ่านปกติ
const TRIGGER = 72;      // px
// ระยะที่ค้างไว้ระหว่างกำลังโหลด — พอให้เห็นวงกลมหมุน ไม่ดันเนื้อหาลงไปไกลเกิน
const HOLD = 56;         // px
// ลากได้ไกลสุดเท่านี้ ต่อให้ลากยาวกว่านั้น — หนืดขึ้นเรื่อยๆ ให้รู้สึกว่ามีปลายทาง
const MAX = 110;         // px
// ต้องเลื่อนนิ้วเกินระยะนี้ก่อนถึงเริ่มลากจริง — กันหน้าขยับตอนแค่แตะหรือนิ้วสั่น
// และเป็นจังหวะให้เบราว์เซอร์ตัดสินใจก่อนว่าท่านี้คือ scroll หรือ pull (ค่าเดียวกับ sheetSwipe)
const START_THRESHOLD = 8;
const SETTLE_MS = 240;   // เวลาที่ใช้ไถลกลับเข้าที่

/** ยิ่งลากยิ่งหนืด — เข้าใกล้ MAX แต่ไม่มีวันถึง ให้ความรู้สึกเหมือนดึงยาง ไม่ใช่ลากของแข็ง */
const resist = (raw) => MAX * (1 - Math.exp(-raw / MAX));

/**
 * ดึงลงเพื่อรีเฟรช — สำหรับหน้าที่เลื่อนทั้งหน้าด้วย window (ทุกหน้าในแอปนี้เป็นแบบนั้น)
 *
 * คืน ref สองตัว: zone แปะที่กรอบนอก (ตัวที่รับนิ้ว) · content แปะที่ก้อนที่จะเลื่อนตามนิ้ว
 * ตัวบอกสถานะหาเองจาก [data-pull-hint] ข้างใน zone
 *
 * ไม่แตะ state ของ React ระหว่างลากเลย — เขียน style ลง element ตรงๆ ทีละเฟรม
 * (touchmove ยิงถี่กว่าอัตราการวาดจอ ถ้า setState ทุกครั้งจะ render ทั้งหน้าใหม่เป็นร้อยรอบต่อวินาที)
 *
 * กติกาที่ทำให้ไม่ไปทับการใช้งานอื่น:
 *   - เริ่มลากได้เฉพาะตอนหน้าอยู่บนสุดจริงๆ ไม่งั้นการปัดลงคือการเลื่อนอ่านเนื้อหา
 *   - ไม่เริ่มลากถ้ามี popup เปิดอยู่ (ดูจาก body ที่ถูกล็อกไม่ให้เลื่อน) ไม่งั้นดึงหน้าหลังได้ทั้งที่ถูกบังอยู่
 *   - ไม่เริ่มลากถ้านิ้วแตะช่องกรอก
 *   - ปัดขึ้นปล่อยผ่านทันที เป็นการเลื่อนเนื้อหาปกติ
 */
export function usePullToRefresh(onRefresh, enabled = true) {
  const zoneRef = useRef(null);
  const contentRef = useRef(null);
  // เก็บฟังก์ชันล่าสุดไว้ใน ref — ผู้เรียกมักส่งฟังก์ชันใหม่ทุก render
  // ถ้าใส่ใน deps ของ effect จะถอด/ใส่ listener ใหม่ทุกครั้งโดยไม่จำเป็น
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const zone = zoneRef.current;
    const content = contentRef.current;
    if (!enabled || !zone || !content) return undefined;

    const hint = zone.querySelector('[data-pull-hint]');

    let startY = 0;
    let pull = 0;
    let active = false;    // นิ้วแตะอยู่และมีสิทธิ์ลาก
    let dragging = false;  // เลื่อนเกินระยะเริ่มแล้ว หน้ากำลังขยับตามนิ้ว
    let busy = false;      // กำลังโหลดอยู่ ห้ามเริ่มรอบใหม่ซ้อน
    let frame = 0;
    let settleTimer = 0;

    const paint = () => {
      frame = 0;
      content.style.transform = `translate3d(0, ${pull}px, 0)`;
      if (!hint) return;
      // ตัวบอกสถานะโผล่ขึ้นมาในช่องว่างที่เนื้อหาเลื่อนลงไปเปิดให้ — ลอยอยู่กึ่งกลางช่องนั้นพอดี
      hint.style.opacity = String(Math.min(1, pull / TRIGGER));
      hint.style.transform = `translate3d(0, ${pull / 2}px, 0) rotate(${pull * 2.5}deg)`;
      hint.classList.toggle('is-ready', pull >= TRIGGER);
    };

    const glideTo = (to) => {
      pull = to;
      content.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      content.style.transform = `translate3d(0, ${to}px, 0)`;
      if (hint) {
        hint.style.transition = `opacity ${SETTLE_MS}ms ease, transform ${SETTLE_MS}ms ease`;
        hint.style.opacity = to > 0 ? '1' : '0';
        hint.style.transform = `translate3d(0, ${to / 2}px, 0)`;
      }
    };

    const reset = () => {
      glideTo(0);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        // อาจถูกแตะใหม่ระหว่างที่ยังไถลกลับ — อย่าไปล้างสิ่งที่รอบใหม่ตั้งไว้
        if (dragging || busy) return;
        content.style.transition = '';
        content.style.transform = '';
        content.style.willChange = '';
        if (hint) {
          hint.style.transition = '';
          hint.style.transform = '';
          hint.classList.remove('is-ready', 'is-busy');
        }
      }, SETTLE_MS);
    };

    const onStart = (e) => {
      if (busy || e.touches.length !== 1) return;
      // หน้ายังเลื่อนค้างอยู่ = ปัดลงคือการเลื่อนอ่าน ไม่ใช่การรีเฟรช
      if (window.scrollY > 0) return;
      // popup เปิดอยู่ (ตัวที่ล็อกการเลื่อนของหน้าหลังไว้) — ห้ามดึงหน้าที่ถูกบังอยู่
      if (document.body.style.overflow === 'hidden') return;
      // เมนูข้างที่กางอยู่เป็นแผ่นลอยทับหน้า ปัดในนั้นไม่ใช่การสั่งรีเฟรชหน้าที่อยู่ข้างหลัง
      if (e.target.closest?.('.sidebar, input, textarea, select, [contenteditable]')) return;

      startY = e.touches[0].clientY;
      pull = 0;
      active = true;
      dragging = false;
    };

    const onMove = (e) => {
      if (!active) return;
      const raw = e.touches[0].clientY - startY;

      if (raw <= 0) {
        // ปัดขึ้น = ไม่ใช่ท่ารีเฟรช ยกเลิกแล้วปล่อยให้เลื่อนเนื้อหาตามปกติ
        if (dragging) reset();
        active = false;
        dragging = false;
        return;
      }

      if (!dragging) {
        if (raw < START_THRESHOLD) return; // ยังไม่พอ ปล่อยให้เบราว์เซอร์ตัดสินใจก่อน
        dragging = true;
        content.style.transition = 'none';
        content.style.willChange = 'transform';
        if (hint) hint.style.transition = 'none';
      }

      pull = resist(raw - START_THRESHOLD);
      e.preventDefault(); // กันหน้าเลื่อนตามนิ้วไปด้วย
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onEnd = async () => {
      if (!active) return;
      active = false;
      if (!dragging) return;
      dragging = false;

      if (frame) cancelAnimationFrame(frame);
      frame = 0;

      if (pull < TRIGGER) return reset(); // ไม่ถึงเกณฑ์ = ดีดกลับที่เดิม เฉยๆ

      // ถึงเกณฑ์ — ค้างไว้ที่ระยะโหลดจนกว่าจะได้ข้อมูลจริง
      // ปล่อยแล้วดีดกลับทันทีจะดูเหมือนไม่มีอะไรเกิดขึ้น ทั้งที่กำลังโหลดอยู่
      busy = true;
      hint?.classList.add('is-busy');
      glideTo(HOLD);
      try {
        await refresh.current?.();
      } finally {
        busy = false;
        hint?.classList.remove('is-busy');
        reset();
      }
    };

    /* ปิดการรีเฟรชหน้าเว็บของเบราว์เซอร์เอง (Chrome บน Android) เฉพาะตอนอยู่หน้านี้
       ไม่ปิด ดึงทีเดียวจะได้ทั้งของเราและของเบราว์เซอร์ — ของเบราว์เซอร์คือโหลดใหม่ทั้งแอป
       ซึ่งช้ากว่ามากและทิ้งทุกอย่างที่ค้างอยู่ */
    const root = document.documentElement;
    const prevOverscroll = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = 'contain';

    /* ฟังที่ document ไม่ใช่ที่กรอบเนื้อหา — กรอบสูงเท่าเนื้อหาจริง วันที่มีกะเดียว
       ครึ่งล่างของจอจะอยู่นอกกรอบ ดึงตรงนั้นแล้วไม่มีอะไรเกิดขึ้น ทั้งที่เป็นที่ว่างของหน้าเดียวกัน
       ดึงที่ไหนก็ได้บนจอคือสิ่งที่คนคาดหวังจากท่านี้ (เงื่อนไขกันชนอยู่ใน onStart ครบแล้ว)
       passive: false เฉพาะ touchmove เพราะต้อง preventDefault ได้ ส่วนที่เหลือไม่ต้องบล็อกอะไร */
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      root.style.overscrollBehaviorY = prevOverscroll;
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled]);

  return { zoneRef, contentRef };
}
