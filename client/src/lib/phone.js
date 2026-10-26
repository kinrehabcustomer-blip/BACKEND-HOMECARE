/**
 * เบอร์โทรแสดงเป็น xxx-xxx-xxxx (มือถือ 10 หลัก)
 * เบอร์ที่ไม่ใช่ 10 หลัก (เบอร์บ้าน 9 หลัก, +66…) คืนค่าเดิม ไม่เดาเอาเอง
 */
export function formatPhone(value) {
  if (value == null) return value;
  const s = String(value).trim();
  if (s.startsWith('+')) return s;
  const d = s.replace(/\D/g, '');
  if (d.length !== 10) return s;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** ใช้ตอนพิมพ์ในช่อง — ใส่ขีดให้เองระหว่างพิมพ์ ตัดที่ 10 หลัก; ขึ้นต้นด้วย + ปล่อยตามที่พิมพ์ */
export function formatPhoneInput(value) {
  const s = String(value ?? '');
  if (s.trim().startsWith('+')) return s;
  const d = s.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
