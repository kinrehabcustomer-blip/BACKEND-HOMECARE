import { api } from '../api.js';
import { isIos, isStandalone } from './pwa.js';

/**
 * แจ้งเตือนบนมือถือ (Web Push · ผู้ใช้ขอ 20 พ.ย. 2569) — เฉพาะพนักงานภาคสนาม · server: notify/webPush.js
 * สมัครต่อ "เครื่อง+เบราว์เซอร์" (endpoint) ผูกกับคนที่ล็อกอินอยู่ · ออกจากระบบ = เลิกรับเครื่องนี้
 *
 * ข้อจำกัดของแพลตฟอร์ม:
 *   Android (Chrome) — ได้ทั้งเปิดเว็บธรรมดาและแอปที่ติดตั้ง
 *   iPhone/iPad — ต้อง iOS 16.4 ขึ้นไป และต้อง "เพิ่มไปยังหน้าจอโฮม" แล้วเปิดจากไอคอนเท่านั้น (Safari ในแท็บปกติไม่มี push)
 */

/** สถานะที่หน้าจอใช้ตัดสินว่าจะโชว์อะไร */
export function pushSupport() {
  if (typeof window === 'undefined') return 'unsupported';
  const hasApi = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isStandalone()) return 'ios-install'; // iOS: ต้องติดตั้งลงหน้าโฮมก่อน API ถึงจะมี
  if (!hasApi) return 'unsupported';
  if (!import.meta.env.PROD) return 'dev'; // service worker ลงเฉพาะ build จริง (lib/pwa.js)
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

const registration = async () => {
  // รอ service worker ที่ลงไว้ตอนโหลดหน้า (lib/pwa.js) — ไม่เกิน 10 วินาที
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('แอปยังโหลดไม่เสร็จ ลองใหม่อีกครั้ง')), 10_000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
};

export async function currentSubscription() {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** base64url → Uint8Array (applicationServerKey) */
function keyBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** เปิดแจ้งเตือนเครื่องนี้ — ขออนุญาต (ต้องมาจากการกดปุ่ม) → สมัครกับเบราว์เซอร์ → ส่งให้ server */
export async function enablePush() {
  const status = await api.pushStatus();
  if (!status.enabled || !status.public_key) throw new Error('ระบบยังไม่ได้เปิดใช้แจ้งเตือนบนมือถือ — แจ้งผู้ดูแลระบบ');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'เครื่องนี้ปิดการแจ้งเตือนของแอปไว้ — เปิดได้ที่การตั้งค่าของเครื่อง แล้วกลับมากดใหม่'
      : 'ยังไม่ได้อนุญาตการแจ้งเตือน');
  }
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // กุญแจของ server เปลี่ยน (ตั้ง VAPID ใหม่) — ของเดิมใช้ไม่ได้แล้ว สมัครใหม่
  const want = keyBytes(status.public_key);
  const have = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  const json = sub.toJSON();
  await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys });
  return sub;
}

/** ปิดแจ้งเตือนเครื่องนี้ — ลบที่ server ก่อน (ยังมี session) แล้วค่อยเลิกกับเบราว์เซอร์ */
export async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function testPush() {
  const sub = await currentSubscription();
  if (!sub) throw new Error('เครื่องนี้ยังไม่ได้เปิดแจ้งเตือน');
  return api.pushTest(sub.endpoint);
}
