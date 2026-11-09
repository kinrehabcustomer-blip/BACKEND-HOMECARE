/*
 * PWA — ลง service worker + จับจังหวะ "ติดตั้งแอป" ของ Chrome/Android
 *
 * beforeinstallprompt ยิงครั้งเดียวตั้งแต่โหลดหน้า (ก่อนผู้ใช้เปิดหน้าตั้งค่านานมาก)
 * จึงต้องดักไว้ตั้งแต่ main.jsx แล้วเก็บไว้ที่นี่ ให้ปุ่ม "ติดตั้งแอป" ในหน้าตั้งค่าหยิบมาใช้ทีหลัง
 */
let deferred = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export function initPwa() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // ไม่ให้แถบติดตั้งของ Chrome เด้งเองทุกหน้า — ติดตั้งจากปุ่มในหน้าตั้งค่า
    deferred = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
  /* ลงเฉพาะ build จริง — ตอน dev (vite) ถ้ามี service worker คอยถือไฟล์ไว้ แก้โค้ดแล้วจะงงว่าทำไมหน้าไม่เปลี่ยน
     และไม่ลงตอนถูกฝังใน iframe ของเว็บอื่น (kinorigin) — แอปติดตั้งเปิดเต็มจออยู่แล้ว ไม่ต้องใช้ */
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.top === window) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {}); // ลงไม่ได้ = ใช้เป็นเว็บธรรมดาต่อ ไม่กระทบงาน
    });
  }
}

/** เปิดจากไอคอนบนหน้าโฮมอยู่ (ติดตั้งแล้ว) */
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

/** iPhone/iPad — Safari ไม่มีปุ่มติดตั้งให้เว็บเรียก ต้องสอนให้กด "แชร์ → เพิ่มไปยังหน้าจอโฮม" เอง */
export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const canPromptInstall = () => deferred !== null;

/** เปิดหน้าต่างติดตั้งของ Chrome — คืน true ถ้าผู้ใช้กดติดตั้ง */
export async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null; // ใช้ได้ครั้งเดียว
  emit();
  e.prompt();
  const { outcome } = await e.userChoice;
  return outcome === 'accepted';
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
