// ระยะทางระหว่างพิกัดสองจุด (เมตร) — ใช้ตัดสิน geofence ตอนเช็คอิน
// คิดฝั่ง server จากพิกัดที่เก็บไว้ ไม่เรียก Google (ฟรี ไม่มีค่าใช้จ่ายต่อการเช็คอิน)

const EARTH_RADIUS_M = 6_371_000; // รัศมีโลกเฉลี่ย
const rad = (deg) => (deg * Math.PI) / 180;

/** ระยะเส้นตรงบนผิวโลกระหว่าง (lat1,lng1) กับ (lat2,lng2) เป็นเมตร (ปัดเป็นจำนวนเต็ม) — สูตร Haversine */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));
}

// รัศมี geofence ปริยาย (เมตร) เมื่อเคสไม่ได้ตั้งค่าเฉพาะไว้ — GPS ในเมือง/ตึกทึบคลาดได้หลายสิบเมตร
// จึงเผื่อไว้พอสมควร (เกินรัศมีแค่ "flag" ให้ admin ตรวจ ไม่บล็อกการเช็คอิน)
export const DEFAULT_GEOFENCE_M = 200;
