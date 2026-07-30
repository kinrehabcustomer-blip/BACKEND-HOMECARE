// แปลงที่อยู่ (ข้อความ) เป็นพิกัด ผ่าน Google Geocoding API — เรียกจาก server ตอน admin ตั้งพิกัดเคส
// เรียกครั้งเดียวตอนบันทึก แล้วเก็บ lat/lng ลง DB (ไม่เรียกทุกครั้งที่อ่าน) เพื่อคุมค่าใช้จ่าย
// คืน null ถ้าไม่มี key / หาไม่เจอ / เน็ตพัง — ไม่ throw เพื่อให้ยังบันทึกเคสได้แล้วค่อยกรอกพิกัดมือ

const KEY = process.env.GOOGLE_MAPS_SERVER_KEY;

/** ที่อยู่ -> { lat, lng, formatted } หรือ null */
export async function geocode(address) {
  if (!KEY || !address?.trim()) return null;

  try {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json' +
      `?address=${encodeURIComponent(address)}&language=th&region=th&key=${KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK' || !data.results?.length) return null;
    const best = data.results[0];
    return {
      lat: best.geometry.location.lat,
      lng: best.geometry.location.lng,
      formatted: best.formatted_address,
    };
  } catch {
    return null; // เน็ต/JSON พัง — ให้ผู้เรียกไปกรอกพิกัดมือแทน
  }
}

/**
 * ค้นหาสถานที่จากข้อความ (ชื่อที่ตั้ง/ที่อยู่) -> คืนหลายผลลัพธ์ให้ผู้ใช้เลือก
 * ลอง Places Text Search ก่อน (ดีกับ "ชื่อสถานที่" เช่น โรงพยาบาล/คอนโด) — ไม่ได้ค่อยตก Geocoding
 * คืน [] ถ้าไม่มี key / หาไม่เจอ / เน็ตพัง
 */
export async function searchPlaces(query, limit = 6) {
  if (!KEY || !query?.trim()) return [];
  const q = encodeURIComponent(query);

  // 1) Places Text Search — เข้าใจชื่อสถานที่ได้ดีกว่า geocoding
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&language=th&region=th&key=${KEY}`,
    );
    const data = await res.json();
    if (data.status === 'OK' && data.results?.length) {
      return data.results.slice(0, limit).map((r) => ({
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        name: r.name ?? null,
        formatted: r.formatted_address ?? null,
      }));
    }
  } catch {
    // ตกไปใช้ geocoding
  }

  // 2) fallback: Geocoding (เผื่อยังไม่ได้เปิด Places API)
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&language=th&region=th&key=${KEY}`,
    );
    const data = await res.json();
    if (data.status === 'OK' && data.results?.length) {
      return data.results.slice(0, limit).map((r) => ({
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        name: null,
        formatted: r.formatted_address ?? null,
      }));
    }
  } catch {
    // noop
  }

  return [];
}

/** พิกัด -> ที่อยู่ (ข้อความ) หรือ null — ใช้อ่านที่อยู่จากพิกัดที่ได้จากลิงก์ Google Maps */
export async function reverseGeocode(lat, lng) {
  if (!KEY || lat == null || lng == null) return null;

  try {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json' +
      `?latlng=${lat},${lng}&language=th&region=th&key=${KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK' || !data.results?.length) return null;
    return data.results[0].formatted_address;
  } catch {
    return null;
  }
}

export const geocodeConfigured = Boolean(KEY);
