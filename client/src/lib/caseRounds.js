/**
 * วันของรอบใหม่ตอนต่อเคส — เริ่มวันถัดจากวันสิ้นสุดของรอบก่อน และยาวเท่ารอบก่อน
 *
 * รอบก่อนไม่ได้ระบุวันสิ้นสุด = ไม่รู้ว่าต่อจากวันไหน → เริ่มวันนี้ ปล่อยวันสิ้นสุดว่างให้กรอกเอง
 * รอบก่อนมีแต่วันสิ้นสุด (ไม่มีวันเริ่ม) = รู้วันเริ่มรอบใหม่ แต่ไม่รู้ความยาว → ปล่อยวันสิ้นสุดว่าง
 *
 * คิดเป็นวันแบบ UTC ล้วนๆ จากสตริง 'YYYY-MM-DD' — ไม่ผ่านเขตเวลาของเครื่อง จึงไม่เลื่อนวันตอนข้ามเที่ยงคืน
 */
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

export function nextRoundDates(start, end, today) {
  if (!end) return { start_date: today, end_date: '' };
  const nextStart = dayMs(end) + DAY;
  if (!start) return { start_date: isoDay(nextStart), end_date: '' };
  const length = Math.max(0, Math.round((dayMs(end) - dayMs(start)) / DAY));
  return { start_date: isoDay(nextStart), end_date: isoDay(nextStart + length * DAY) };
}

/**
 * จำนวนวันของรูปแบบบริการ Homecare แต่ละหมวด — ใช้ตั้งวันสิ้นสุดอัตโนมัติจากวันเริ่มที่กรอก
 * นับรวมวันเริ่ม: รายวัน = วันเดียวกัน · รายสัปดาห์ = เริ่ม+6 · รายเดือน = เริ่ม+29 (ครบ 30 วันพอดี)
 */
export const SERVICE_DAYS = { daily: 1, weekly: 7, monthly: 30 };

/** วันสิ้นสุดตามจำนวนวันของหมวด — ไม่มีวันเริ่ม/ไม่รู้หมวด = null (ผู้เรียกคงค่าเดิมไว้) */
export function endDateFor(start, category) {
  const days = SERVICE_DAYS[category];
  if (!start || !days) return null;
  return isoDay(dayMs(start) + (days - 1) * DAY);
}
