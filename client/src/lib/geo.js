/**
 * ขอพิกัดปัจจุบันจากเบราว์เซอร์ — คืนผลลัพธ์เสมอ (ไม่ throw/ไม่ reject)
 *   { ok: true, lat, lng, accuracy }        เมื่อได้พิกัด
 *   { ok: false, reason }                   เมื่อปฏิเสธ/ไม่มีสัญญาณ (ยังเช็คอินต่อได้ แต่จะถูก flag)
 *
 * GPS ใช้ได้เฉพาะบน HTTPS หรือ localhost (ข้อกำหนดของเบราว์เซอร์)
 */
export function getPosition({ timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      return resolve({ ok: false, reason: 'อุปกรณ์นี้ไม่รองรับการหาตำแหน่ง' });
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        }),
      (err) => resolve({ ok: false, reason: gpsErrorText(err) }),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

function gpsErrorText(err) {
  if (err.code === err.PERMISSION_DENIED) return 'คุณปิดการเข้าถึงตำแหน่งไว้ — เช็คอินได้แต่จะไม่มีพิกัดยืนยัน';
  if (err.code === err.POSITION_UNAVAILABLE) return 'หาตำแหน่งไม่ได้ (ไม่มีสัญญาณ GPS)';
  if (err.code === err.TIMEOUT) return 'หาตำแหน่งนานเกินไป ลองใหม่อีกครั้ง';
  return 'ขอตำแหน่งไม่สำเร็จ';
}
