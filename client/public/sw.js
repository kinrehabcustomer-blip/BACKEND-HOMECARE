/*
 * Service worker ของแอป KIN Homecare (PWA — ติดตั้งลงหน้าโฮมได้)
 *
 * เก็บเฉพาะ "เปลือกแอป" (ไฟล์ JS/CSS/ไอคอน) ไว้ในเครื่อง เพื่อให้เปิดเร็วและมีหน้า "ไม่มีสัญญาณ" แทนหน้าขาว
 * ไม่แตะ /api เด็ดขาด — ข้อมูลเคส/ผู้ป่วย/เงินต้องไม่ค้างอยู่ในเครื่อง (PDPA) และต้องเป็นข้อมูลล่าสุดเสมอ
 *
 * - หน้าเว็บ (navigation): ขอจากเน็ตก่อนทุกครั้ง → deploy ใหม่เห็นทันที ไม่ค้างเวอร์ชันเก่า · เน็ตหลุด = offline.html
 * - /assets/* (ชื่อไฟล์มี hash ของ Vite ไม่เปลี่ยนเนื้อหา): ใช้ของในเครื่องก่อน ไม่มีค่อยโหลดแล้วเก็บไว้
 *
 * แก้ไฟล์นี้เมื่อไร ให้เลื่อน VERSION — เบราว์เซอร์จะลงตัวใหม่และล้างแคชรุ่นเก่าทิ้งเอง
 */
const VERSION = 'v2';
const SHELL = `kin-shell-${VERSION}`;
const ASSETS = `kin-assets-${VERSION}`;
const PRECACHE = ['/offline.html', '/icons/icon-192.png'];
const MAX_ASSETS = 80; // deploy หลายรอบ ไฟล์ hash เก่าจะสะสม — เกินนี้ลบตัวเก่าสุดทิ้ง

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, ASSETS]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // ฟอนต์ Google ฯลฯ ให้เบราว์เซอร์จัดการเอง
  if (url.pathname.startsWith('/api')) return;       // ข้อมูลจริง — ไม่ผ่านแคชเด็ดขาด

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || Response.error()));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        event.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)));
      }
      return res;
    })());
  }
});
