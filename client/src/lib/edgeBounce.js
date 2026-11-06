import { useEffect, useRef } from 'react';

/**
 * เลื่อนลงจนสุดหน้าแล้ว "เด้งกลับนิดหนึ่ง" บนมือถือ (ผู้ใช้ขอ 6 พ.ย. 2569)
 *
 * เดิมเลื่อนถึงท้ายหน้าแล้วหยุดแข็งทื่อ ไม่มีอะไรบอกว่าสุดแล้ว — ทำให้มีสองจังหวะ:
 *   1. ลากนิ้วเลยท้ายหน้า   — เนื้อหายืดขึ้นตามนิ้วแบบหนืด (ยิ่งลากยิ่งตึง) ปล่อยแล้วดีดกลับที่เดิม
 *   2. ปัดแรงแล้วไหลไปชนท้าย — เนื้อหาเด้งขึ้นไปเล็กน้อยตามแรงที่ไหลมา แล้วดีดกลับ
 *
 * ขยับด้วย transform ของกรอบเนื้อหาเท่านั้น (ไม่แตะ scroll จริง) และล้างทิ้งทันทีที่เด้งจบ
 * ไม่ทำบน iPhone/iPad — Safari เด้งของมันเองอยู่แล้ว ซ้อนกันจะเด้งสองชั้น
 * ไม่ทำบนจอที่ใช้เมาส์ และเมื่อผู้ใช้ตั้ง "ลดการเคลื่อนไหว" ไว้ในเครื่อง
 *
 * กันชนกับของอื่น (เงื่อนไขชุดเดียวกับดึงรีเฟรชด้านบน — lib/pullRefresh.js):
 *   - มี popup เปิดอยู่ (body ถูกล็อกการเลื่อน) — ไม่ยืดหน้าที่ถูกบังอยู่ข้างหลัง
 *   - นิ้วอยู่ในช่องกรอก / เมนูข้าง / แถบล่าง / กล่องที่เลื่อนในตัวเองได้ (เช่นห้องแชท) — นั่นคือการเลื่อนกล่องนั้น
 *   - หน้าสั้นกว่าจอ (ไม่มีอะไรให้เลื่อน) — ไม่มี "ท้ายหน้า" ให้ชน
 */

const MAX = 56;              // ลากเลยท้ายได้ไกลสุด (px) — เข้าใกล้แต่ไม่ถึง
const START_THRESHOLD = 8;   // ต้องลากเลยท้ายเกินนี้ก่อนถึงเริ่มยืด กันนิ้วสั่น
const SETTLE_MS = 420;       // เวลาดีดกลับหลังปล่อยนิ้ว
const FLING_MIN = 0.6;       // ความเร็วขั้นต่ำ (px/ms) ตอนไหลไปชนท้าย ถึงจะเด้ง — เลื่อนช้าๆ มาถึงท้ายไม่ต้องเด้ง
const FLING_MAX_PX = 26;     // เด้งไกลสุดตอนไหลมาชน (px)
// ดีดกลับเลยจุดเดิมเล็กน้อยแล้วค่อยเข้าที่ — ให้รู้สึกเป็นยาง ไม่ใช่สไลด์เฉยๆ
const SPRING = 'cubic-bezier(0.22, 1.35, 0.4, 1)';

const resist = (raw) => MAX * (1 - Math.exp(-raw / MAX));

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const scrollRoom = () => document.documentElement.scrollHeight - window.innerHeight;
const atBottom = () => scrollRoom() > 1 && window.scrollY >= scrollRoom() - 1;
const locked = () => document.body.style.overflow === 'hidden';

/** นิ้วแตะอยู่ในกล่องที่เลื่อนในตัวเองได้ไหม (ห้องแชท / รายการในแผ่น ฯลฯ) — นั่นคือการเลื่อนกล่องนั้น ไม่ใช่ทั้งหน้า */
function inOwnScroller(el, stop) {
  for (let e = el; e && e !== stop && e !== document.body; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1) {
      const oy = getComputedStyle(e).overflowY;
      if (oy === 'auto' || oy === 'scroll') return true;
    }
  }
  return false;
}

export function useBottomBounce() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || isIOS()) return undefined;
    const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const enabled = () => touchOnly.matches && !reduce.matches;

    let startY = 0;
    let active = false;     // นิ้วแตะอยู่และมีสิทธิ์ยืด
    let dragging = false;   // กำลังยืดตามนิ้วอยู่
    let pull = 0;
    let frame = 0;
    let settleTimer = 0;
    let anim = null;        // ตัวเด้งตอนไหลมาชน
    let touching = false;
    // ความเร็วเลื่อนล่าสุด (ใช้ตัดสินว่าไหลมาชนท้ายแรงพอจะเด้งไหม)
    let lastY = window.scrollY;
    let lastT = performance.now();
    let velocity = 0;
    let wasAtBottom = atBottom();

    const clear = () => {
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
    };

    const paint = () => {
      frame = 0;
      el.style.transform = `translate3d(0, ${-pull}px, 0)`;
    };

    const settle = () => {
      el.style.transition = `transform ${SETTLE_MS}ms ${SPRING}`;
      el.style.transform = 'translate3d(0, 0, 0)';
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (!dragging) clear();
      }, SETTLE_MS);
    };

    const onStart = (e) => {
      touching = true;
      active = false;
      if (!enabled() || e.touches.length !== 1 || locked()) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable], .sidebar, .tabbar, .modal')) return;
      if (inOwnScroller(e.target, el)) return;
      anim?.cancel();
      startY = e.touches[0].clientY;
      active = true;
      dragging = false;
    };

    const onMove = (e) => {
      if (!active) return;
      const y = e.touches[0].clientY;
      if (!dragging) {
        // ยังไม่ถึงท้าย = กำลังเลื่อนอ่านปกติ — เลื่อนจุดเริ่มตามนิ้วไปเรื่อยๆ
        // พอถึงท้ายในการลากครั้งเดียวกัน ระยะที่ลากเลยออกไปถึงเริ่มนับ (เหมือนเด้งของ iPhone)
        if (!atBottom()) {
          startY = y;
          return;
        }
        if (startY - y < START_THRESHOLD) {
          if (y > startY) startY = y; // ลากกลับลง = เลื่อนขึ้นอ่านตามปกติ
          return;
        }
        dragging = true;
        clearTimeout(settleTimer);
        el.style.transition = 'none';
        el.style.willChange = 'transform';
      }
      const raw = startY - y - START_THRESHOLD;
      if (raw <= 0) {
        // ลากกลับลงจนพ้นท้ายแล้ว — คืนที่เดิม ปล่อยให้เลื่อนขึ้นตามปกติ
        pull = 0;
        dragging = false;
        paint();
        clear();
        return;
      }
      pull = resist(raw);
      e.preventDefault(); // กันเบราว์เซอร์เลื่อน/ยืดซ้อน
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onEnd = () => {
      touching = false;
      lastY = window.scrollY;
      lastT = performance.now();
      if (!active) return;
      active = false;
      if (!dragging) return;
      dragging = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pull = 0;
      settle();
    };

    /* ไหลไปชนท้าย — วัดความเร็วจาก scroll ล่าสุด · เด้งเฉพาะตอนปล่อยนิ้วแล้ว (ไหลด้วยแรงเหวี่ยง)
       ระหว่างนิ้วยังแตะอยู่เป็นหน้าที่ของการยืดตามนิ้วด้านบน */
    const onScroll = () => {
      const now = performance.now();
      const y = window.scrollY;
      const dt = now - lastT;
      if (dt > 0) velocity = (y - lastY) / dt;
      lastY = y;
      lastT = now;
      const bottom = atBottom();
      if (bottom && !wasAtBottom && !touching && !dragging && velocity > FLING_MIN && enabled() && !locked()) {
        const amp = Math.min(FLING_MAX_PX, velocity * 14);
        anim?.cancel();
        anim = el.animate(
          [
            { transform: 'translate3d(0, 0, 0)', easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
            { transform: `translate3d(0, ${-amp}px, 0)`, offset: 0.32, easing: SPRING },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          { duration: 560 },
        );
        anim.onfinish = () => { anim = null; };
      }
      wasAtBottom = bottom;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      anim?.cancel();
      clear();
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return ref;
}
