// ดึงพิกัดจาก "ลิงก์ Google Maps" ที่ผู้ใช้วางมา (รวมลิงก์ย่อจากปุ่มแชร์ในแอป)
//
// ลิงก์ย่อ (maps.app.goo.gl / goo.gl) ไม่มีพิกัดในตัว ต้องตามรีไดเรกต์ไปหน้าจริงก่อนแล้วค่อยอ่าน
// รับเฉพาะโดเมนของ Google เท่านั้น — กัน SSRF (ไม่ให้วาง URL ภายในระบบ/เมทาดาทามาให้ server ยิง)

import { ApiError } from './errors.js';

/* โดเมนที่ยอมให้ server ยิงออกไป — เขียนเป็นรายชื่อจริง ไม่ใช่รูปแบบกว้างๆ
   ของเดิมเป็นรูปแบบที่ดูเหมือนล็อกไว้ที่ Google แต่หางของมัน (google.<อะไรก็ได้>) กินได้ทั้งก้อน
   ทำให้ "google.evil.com" กับ "www.google.attacker.io" ผ่านหมด — ใครก็ตามที่ตั้งซับโดเมน
   ชื่อ google บนโดเมนของตัวเอง จึงสั่งให้ server ของเรายิงไปที่ไหนก็ได้ (SSRF)

   จับคู่แบบ "เท่ากับ" หรือ "เป็นซับโดเมนของ" เท่านั้น ต่อท้ายโดเมนอื่นเข้ามาไม่ได้ */
const ALLOWED_DOMAINS = ['google.com', 'google.co.th', 'goo.gl', 'g.co'];

export const isAllowedHost = (host) => {
  const h = String(host ?? '').toLowerCase().replace(/[.]$/, ''); // ตัดจุดท้าย FQDN ทิ้ง
  return ALLOWED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
};

// ตามรีไดเรกต์ได้ไม่เกินเท่านี้ — ลิงก์ย่อของ Google เด้งชั้นเดียวหรือสองชั้น เกินกว่านี้คือผิดปกติ
const MAX_REDIRECTS = 5;

// รูปแบบพิกัดที่พบในลิงก์/หน้าเพจ เรียงตามความแม่น: หมุดจริง (!3d!4d) > จุดกลางแผนที่ (@) > q=lat,lng
const COORD_PATTERNS = [
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,
  /[?&](?:q|query|ll|destination|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
];

function coordsFrom(text) {
  for (const re of COORD_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    }
  }
  return null;
}

function assertGoogleHost(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ApiError(400, 'ลิงก์ไม่ถูกต้อง');
  }
  if (!isAllowedHost(host)) throw new ApiError(400, 'รองรับเฉพาะลิงก์จาก Google Maps เท่านั้น');
}

/**
 * ลิงก์ Google Maps -> { lat, lng } หรือ null (อ่านพิกัดไม่ได้)
 * โยน ApiError(400) ถ้าลิงก์ผิดรูป/ไม่ใช่โดเมน Google
 */
export async function resolveMapLink(raw) {
  const url = (raw ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new ApiError(400, 'กรุณาวางลิงก์ที่ขึ้นต้นด้วย http(s)');
  assertGoogleHost(url);

  // ลิงก์เต็มที่มีพิกัดอยู่แล้ว — อ่านได้เลย ไม่ต้องยิงเน็ต
  const direct = coordsFrom(url);
  if (direct) return direct;

  /* ลิงก์ย่อ — ตามรีไดเรกต์เอง ทีละชั้น ตรวจโดเมนก่อนยิงทุกครั้ง
     redirect: 'follow' ยิงตามให้จนจบแล้วค่อยให้เราตรวจ ซึ่งสายเกินไป: คำขอไปยังโฮสต์
     ระหว่างทาง (เช่น 169.254.169.254 หรือเครื่องในวงแลน) ถูกส่งออกไปแล้ว
     ตรวจปลายทางทีหลังจึงกันได้แค่ "อ่านค่ากลับมา" ไม่ได้กัน "ยิงออกไป" ซึ่งคือตัว SSRF จริงๆ */
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      assertGoogleHost(current);
      const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        current = new URL(location, current).toString(); // ปลายทางอาจส่งมาเป็น path เปล่า
        const hit = coordsFrom(current);
        if (hit) return hit;
        continue;
      }

      return coordsFrom(current) ?? coordsFrom(await res.text());
    }
    return null; // เด้งวนเกินจำนวนที่ยอมรับ — ไม่ใช่ลิงก์ปกติของ Google Maps
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return null; // เน็ตพัง/อ่านไม่ได้ — ให้ผู้เรียกแจ้งผู้ใช้ลองลิงก์อื่น
  }
}
