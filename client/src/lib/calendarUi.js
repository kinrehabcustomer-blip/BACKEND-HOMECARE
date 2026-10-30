/**
 * ของกลางของหน้าปฏิทินทั้งสองหน้า (ตารางงานของ admin กับตารางงานของฉันฝั่งพนักงาน)
 *
 * แยกออกมาเพราะสองหน้านี้ใช้โครง .cal-grid / .cal-chip ชุดเดียวกันและมี CSS ร่วมกันอยู่แล้ว
 * ตัวช่วยที่ก๊อปไว้คนละไฟล์คือที่ที่สองหน้าจะค่อยๆ เพี้ยนจากกันโดยไม่มีใครสังเกต
 */

/** สถานะกะที่ขึ้นบนปฏิทินได้จริง (ยกเลิกถูกตัดออกตั้งแต่ฝั่ง server) — ลำดับเดียวกับคำอธิบายสี */
export const CAL_STATES = ['scheduled', 'working', 'done', 'stale', 'missed'];

/**
 * ป้ายวันแบบอ่านออกได้ด้วยตัวเอง — 'พฤ. 13 ส.ค.'
 *
 * ใช้ในโหมดรายการบนมือถือ ซึ่งไม่มีหัวคอลัมน์วันในสัปดาห์และไม่มีวันข้างๆ ให้เทียบแล้ว
 * เห็นเลข "13" ลอยอยู่ในกล่องจึงบอกอะไรไม่ได้เลยว่าเป็นวันอะไร
 */
export const dayLabel = (key) =>
  new Date(`${key}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * เวลาที่ผู้ใช้พิมพ์เอง → 'HH:MM' (24 ชม.) · '' = ไม่ได้กรอก · null = ไม่ใช่เวลา
 * รับ "9" "09" "930" "0930" "9:30" "9.30" "9 30" — คนพิมพ์เวลาบนมือถือแบบไหนก็ได้ผลเดียวกัน
 */
export function parseTime(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  let h;
  let m;
  const sep = t.match(/^(\d{1,2})\s*[:.\s]\s*(\d{1,2})$/);
  if (sep) [, h, m] = sep;
  else if (/^\d{1,2}$/.test(t)) [h, m] = [t, '0'];
  else if (/^\d{3,4}$/.test(t)) [h, m] = [t.slice(0, -2), t.slice(-2)];
  else return null;
  const hour = Number(h);
  const minute = Number(m);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** ช่วงเวลานัดของกะ — เก็บเป็น 'HH:MM' อยู่แล้ว ไม่ต้องแปลงโซนเวลา */
export const timeRange = (v) =>
  v.planned_start ? `${v.planned_start}${v.planned_end ? `–${v.planned_end}` : ''}` : null;
