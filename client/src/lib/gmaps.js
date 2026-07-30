// โหลด Google Maps JS API ครั้งเดียวทั้งแอป — ใช้กับแผนที่ปักหมุด
// key ฝั่งเบราว์เซอร์มาจาก client/.env (VITE_GOOGLE_MAPS_KEY) — ต้อง restrict HTTP referrer ในคอนโซล

const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
export const hasMapsKey = Boolean(KEY);

let loadPromise = null;

/** คืน promise ของ window.google.maps — โหลดสคริปต์ครั้งแรกครั้งเดียว, reject ถ้าไม่มี key/โหลดพัง */
export function loadGoogleMaps() {
  if (!KEY) return Promise.reject(new Error('ยังไม่ได้ตั้ง VITE_GOOGLE_MAPS_KEY'));
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&language=th&region=TH`;
    s.async = true;
    s.onload = () => resolve(window.google.maps);
    s.onerror = () => {
      loadPromise = null; // ให้ลองใหม่ได้
      reject(new Error('โหลด Google Maps ไม่สำเร็จ — ตรวจ key / การเชื่อมต่อ'));
    };
    document.head.appendChild(s);
  });
  return loadPromise;
}
