import { sql } from '../db/index.js';

/**
 * จำนวนวันต่อรอบของรูปแบบบริการ Homecare (pkg_service_formats.days) — ผู้ใช้ขอ 16 พ.ย. 2569
 * "ทำเหมือนเคสกายภาพเช็คลงวันนัดเกิน · รายเดือน = 30 วัน · รายเดือนหยุด 4 วัน = 26 วัน"
 *
 * ใช้ล็อกการลงกะของเคสไม่ให้เกินจำนวนวันของแพ็กที่ซื้อ (นับเป็น "วัน" ไม่ใช่จำนวนกะ —
 * เคส 24 ชม. บางเคสแบ่งเป็นสองกะต่อวัน คนละคน วันเดียวกันจึงนับหนึ่ง) · NULL = ไม่จำกัด (เช่น รายวัน)
 *
 * คอลัมน์สร้างแบบ lazy (Vercel ไม่ได้รัน schema.sql ตอน deploy) แล้วเติมค่าตั้งต้นจากชื่อ "ครั้งเดียว" ตอนสร้าง:
 *   รายเดือน = 30 · ชื่อมี "หยุด N วัน" = 30 − N · รายสัปดาห์ = 7 · รายวัน = ไม่จำกัด
 * หลังจากนั้นแก้ได้ที่หน้าแพ็คเกจ — ไม่เติมทับค่าที่ตั้งเอง (รวมการตั้งเป็นไม่จำกัด)
 */
export function defaultFormatDays({ name = '', category }) {
  if (category === 'weekly') return 7;
  if (category !== 'monthly') return null;
  const off = /หยุด\s*(\d+)\s*วัน/.exec(name);
  return off ? Math.max(1, 30 - Number(off[1])) : 30;
}

let ready = null;
export const ensureFormatDays = () =>
  (ready ??= (async () => {
    const had = await sql.one(
      `SELECT 1 AS x FROM information_schema.columns
        WHERE table_name = 'pkg_service_formats' AND column_name = 'days'`,
    );
    if (had) return;
    await sql.run('ALTER TABLE pkg_service_formats ADD COLUMN IF NOT EXISTS days INTEGER CHECK (days > 0 AND days <= 366)');
    for (const f of await sql.all('SELECT format_id, name, category FROM pkg_service_formats WHERE days IS NULL')) {
      const days = defaultFormatDays(f);
      if (days) await sql.run('UPDATE pkg_service_formats SET days = :days WHERE format_id = :id AND days IS NULL', { days, id: f.format_id });
    }
  })().catch((err) => {
    ready = null;
    throw err;
  }));
