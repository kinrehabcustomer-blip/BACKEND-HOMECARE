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
 * กรอบคร่าวๆ ของประเทศไทย — ใช้ "เรียงผลในไทยขึ้นก่อน" ไม่ใช่ตัดทิ้ง
 *
 * region=th ของ Google เป็นแค่การเอนเอียง ไม่ได้จำกัด พิมพ์ชื่อที่ซ้ำกับที่อื่นในโลก
 * (เช่น "ramathibodi" หรือชื่อหมู่บ้านทั่วไป) แล้วได้ผลจากต่างประเทศแทรกขึ้นมาก่อนได้
 * เรียงแทนการตัด เพราะถ้าตัดแล้วผลที่ Google เจอถูกอยู่แต่หลุดกรอบไปนิดเดียวจะกลายเป็น "ไม่พบ"
 */
const TH_BOUNDS = { minLat: 5.5, maxLat: 20.6, minLng: 97.2, maxLng: 105.8 };
const inThailand = (lat, lng) =>
  lat >= TH_BOUNDS.minLat && lat <= TH_BOUNDS.maxLat && lng >= TH_BOUNDS.minLng && lng <= TH_BOUNDS.maxLng;

/** เรียงผลในไทยขึ้นก่อน โดยคงลำดับความเกี่ยวข้องเดิมของ Google ไว้ภายในแต่ละกลุ่ม */
const thaiFirst = (rows) => [
  ...rows.filter((r) => inThailand(r.lat, r.lng)),
  ...rows.filter((r) => !inThailand(r.lat, r.lng)),
];

/**
 * ค้นหาสถานที่จากข้อความ (ชื่อที่ตั้ง/ที่อยู่) -> คืนหลายผลลัพธ์ให้ผู้ใช้เลือก
 * ลอง Places Text Search ก่อน (ดีกับ "ชื่อสถานที่" เช่น โรงพยาบาล/คอนโด) — ไม่ได้ค่อยตก Geocoding
 * คืน [] ถ้าไม่มี key / หาไม่เจอ / เน็ตพัง
 *
 * near = พิกัดที่ใช้เอนเอียงผลลัพธ์ (ปกติคือพิกัดที่เคสตั้งไว้แล้ว หรือที่ได้จากที่อยู่ที่กรอก)
 * คำค้นกว้างๆ อย่าง "โรงพยาบาล" หรือ "เซเว่น" ถ้าไม่บอกว่าใกล้ไหน Google จะให้ที่ไหนก็ได้ทั้งประเทศ
 * มี near แล้วมันจะให้ที่ใกล้บ้านคนไข้ก่อน ซึ่งเกือบทุกครั้งคือสิ่งที่คนค้นหาต้องการ
 */
export async function searchPlaces(query, { limit = 6, near = null } = {}) {
  if (!KEY || !query?.trim()) return [];
  const q = encodeURIComponent(query);

  // 30 กม. — กว้างพอครอบคลุมกรุงเทพฯ ทั้งเมืองและปริมณฑล แต่ยังแคบพอให้ผลใกล้ตัวมาก่อน
  // (เป็นการ "ให้น้ำหนัก" ไม่ใช่ขอบเขตตายตัว ที่นอกรัศมีก็ยังขึ้นได้ถ้าตรงกว่ามาก)
  const bias = near ? `&location=${near.lat},${near.lng}&radius=30000` : '';

  // 1) Places Text Search — เข้าใจชื่อสถานที่ได้ดีกว่า geocoding
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&language=th&region=th${bias}&key=${KEY}`,
    );
    const data = await res.json();
    if (data.status === 'OK' && data.results?.length) {
      return thaiFirst(
        data.results.map((r) => ({
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          name: r.name ?? null,
          formatted: r.formatted_address ?? null,
        })),
      ).slice(0, limit);
    }
  } catch {
    // ตกไปใช้ geocoding
  }

  // 2) fallback: Geocoding (เผื่อยังไม่ได้เปิด Places API)
  //    ตัวนี้รับ components=country:TH ซึ่ง "จำกัด" จริง ไม่ใช่แค่เอนเอียงเหมือน region
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${q}` +
        `&language=th&region=th&components=country:TH&key=${KEY}`,
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
