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

/**
 * รายการคิดเงินเพิ่มของรอบก่อนที่ต่อให้รอบใหม่เอง — เฉพาะของเช่า (ใช้ต่อเนื่อง คิดใหม่ทุกรอบ)
 * ซื้อขาด = ลูกค้าจ่ายไปแล้วในรอบก่อน · หัตถการ = ทำไปแล้วครั้งเดียว — ต่อให้เองคือเก็บเงินซ้ำ
 * สองแบบหลังไม่ทิ้ง แต่ให้ผู้ใช้กดต่อเองทีละรายการถ้ารอบนี้มีอีก
 */
export const carriesOver = (addon) => addon?.kind !== 'sale' && addon?.kind !== 'procedure';

const weekdayOf = (iso) => new Date(dayMs(iso)).getUTCDay();

/**
 * แบบกะของรอบก่อน — กะที่คนเดียวกัน เวลาเดียวกัน รวมเป็นแบบเดียว พร้อมวันในสัปดาห์ที่เคยลง
 * ใช้ลงกะรอบใหม่ให้เหมือนรอบก่อน (ไม่นับกะที่ยกเลิก) · เรียงจากแบบที่ลงบ่อยสุด
 *
 * วันที่โผล่ครั้งเดียวในแบบที่วันอื่นซ้ำทุกสัปดาห์ = นัดเลื่อน/นัดแทรก ไม่ใช่วันประจำ
 * (นัดกายภาพ จ.–พ. ที่เลื่อนไปเสาร์หนึ่งครั้ง ไม่ได้แปลว่ารอบหน้าต้องไปทุกเสาร์) — ตัดออก แล้วบอกไว้ใน rare_weekdays
 */
export function shiftPatterns(visits) {
  const groups = new Map();
  for (const v of visits ?? []) {
    if (v.status === 'cancelled' || !v.visit_date) continue;
    const key = [v.assigned_to ?? '', v.planned_start ?? '', v.planned_end ?? ''].join('|');
    const g = groups.get(key) ?? {
      key,
      assigned_to: v.assigned_to ?? null,
      assigned_name: v.assigned_name ?? null,
      planned_start: v.planned_start ?? null,
      planned_end: v.planned_end ?? null,
      perDay: new Map(),
      count: 0,
    };
    const day = weekdayOf(v.visit_date);
    g.perDay.set(day, (g.perDay.get(day) ?? 0) + 1);
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ perDay, ...g }) => {
      const days = [...perDay.keys()].sort((a, b) => a - b);
      const regular = Math.max(...perDay.values()) >= 2;
      return {
        ...g,
        weekdays: regular ? days.filter((d) => perDay.get(d) >= 2) : days,
        rare_weekdays: regular ? days.filter((d) => perDay.get(d) < 2) : [],
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** จำนวนวันในช่วง (รวมหัวท้าย) ที่ตรงกับวันในสัปดาห์ — ตรงกับที่ server ลงกะให้จริง (datesInRange) */
export function countDaysInRange(from, to, weekdays) {
  if (!from || !to || to < from) return 0;
  let n = 0;
  for (let t = dayMs(from); t <= dayMs(to); t += DAY) {
    if (!weekdays?.length || weekdays.includes(new Date(t).getUTCDay())) n += 1;
  }
  return n;
}
