/**
 * คำนวณเวลาตอนย้ายนัด/กะ — ใช้ร่วมกันระหว่างปฏิทิน (ลากวาง) กับตารางนัดในเคส (ปุ่มเลื่อนนัด)
 * เวลาเก็บเป็นข้อความ 'HH:MM' อยู่แล้ว จึงคิดเป็นนาทีล้วน ไม่แตะโซนเวลา
 */
export const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const fromMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/**
 * เวลาใหม่เมื่อเลื่อนเวลาเริ่มเป็น startText — ความยาวกะเท่าเดิม
 * กะข้ามเที่ยงคืน (จบ ≤ เริ่ม) นับความยาวข้ามวันให้ถูก แล้วเวลาจบก็วนข้ามเที่ยงคืนตามเดิม
 * กะที่ไม่เคยระบุเวลาจบ ยังไม่มีเวลาจบเหมือนเดิม
 */
export function timesForStart(v, startText) {
  const start = toMin(startText);
  if (!v.planned_start || !v.planned_end) return { planned_start: startText, planned_end: v.planned_end ?? null };
  const length = (toMin(v.planned_end) - toMin(v.planned_start) + 1440) % 1440 || 1440;
  return { planned_start: startText, planned_end: fromMin((start + length) % 1440) };
}
