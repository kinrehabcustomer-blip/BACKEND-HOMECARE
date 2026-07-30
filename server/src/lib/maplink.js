// ดึงพิกัดจาก "ลิงก์ Google Maps" ที่ผู้ใช้วางมา (รวมลิงก์ย่อจากปุ่มแชร์ในแอป)
//
// ลิงก์ย่อ (maps.app.goo.gl / goo.gl) ไม่มีพิกัดในตัว ต้องตามรีไดเรกต์ไปหน้าจริงก่อนแล้วค่อยอ่าน
// รับเฉพาะโดเมนของ Google เท่านั้น — กัน SSRF (ไม่ให้วาง URL ภายในระบบ/เมทาดาทามาให้ server ยิง)

import { ApiError } from './errors.js';

// รับเฉพาะโดเมน Google Maps: google.<tld>, goo.gl, maps.app.goo.gl, g.co
const ALLOWED_HOST = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co)$/i;

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
  if (!ALLOWED_HOST.test(host)) throw new ApiError(400, 'รองรับเฉพาะลิงก์จาก Google Maps เท่านั้น');
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

  // ลิงก์ย่อ — ตามรีไดเรกต์ไปหน้าจริง แล้วอ่านจาก URL สุดท้าย (หรือจากเนื้อหาหน้าเป็นทางสำรอง)
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const finalUrl = res.url || url;
    if (res.url) assertGoogleHost(res.url); // ปลายทางต้องยังเป็น Google
    return coordsFrom(finalUrl) ?? coordsFrom(await res.text());
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return null; // เน็ตพัง/อ่านไม่ได้ — ให้ผู้เรียกแจ้งผู้ใช้ลองลิงก์อื่น
  }
}
