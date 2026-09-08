-- ==========================================================================
-- ตารางราคาแพ็คเกจ Homecare — ชุดแยกสำหรับเอาไปใช้ในโปรเจคอื่น
--
-- ไฟล์นี้ "ไม่ได้" ถูกรันโดย npm run migrate (migrate.js อ่านแค่ schema.sql)
-- มีไว้ให้ก๊อปไปรันบนฐานข้อมูลของโปรเจคอื่นโดยตรง:
--
--     psql "$DATABASE_URL_ของโปรเจคใหม่" -f homecare-packages.sql
--
-- สามตารางนี้แยกออกมาได้สะอาดเพราะ FK อ้างถึงกันเองเท่านั้น ไม่มีเส้นไปหา
-- employees / cases / customers เลย — รันบนฐานเปล่าได้ทันที ไม่ต้องลากตารางอื่นตามมา
--
-- ตัดออกจาก schema.sql ตัวเต็มมาแล้วสองอย่าง (จงใจ ไม่ใช่ตกหล่น):
--   1. ALTER TABLE cases ADD COLUMN pkg_grade_id / pkg_format_id / pkg_staff_tier
--      — เป็นฝั่งที่ "เคส" อ้างมาหาตารางราคา ไม่ใช่ส่วนของตารางราคาเอง
--   2. ตาราง physio_packages (แพ็คเกจกายภาพ) — คนละโมเดลกัน ไม่เกี่ยวกับตารางเรทนี้
--
-- ⚠️ รูปแบบเวลา: created_at/updated_at เป็น TEXT 'YYYY-MM-DD HH:MM:SS' เวลาไทยแล้ว
--    ไม่ใช่ TIMESTAMPTZ — โปรเจคที่อ่านต่อห้ามบวก timezone ซ้ำ ไม่งั้นเพี้ยนไป 7 ชั่วโมง
--    (คงรูปแบบเดิมไว้เพื่อให้ข้อมูลที่ dump จากฐานเดิมใส่ลงได้ตรงๆ)
--
-- รันซ้ำได้ทั้งไฟล์ — IF NOT EXISTS / DROP CONSTRAINT IF EXISTS ทุกคำสั่ง
-- ==========================================================================

-- เกรดการดูแล (ระดับความยากของเคส)
-- เช่น เกรด 1 ผู้สูงอายุทั่วไป, เกรด 2 NG tube/ดูดเสมหะ, เกรด 3 ติดเตียง
CREATE TABLE IF NOT EXISTS pkg_grades (
  grade_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
);

-- รูปแบบบริการ — เช่น 'รายวัน 12 ชม.', 'รายเดือน 24 ชม. ไม่มีวันหยุด'
-- category ใช้จัดกลุ่มแสดงผล
-- graded = false -> เรทเดียวใช้ร่วมทุกเกรด (รายวัน/รายสัปดาห์)
-- graded = true  -> แยกราคาตามเกรด (รายเดือน)
CREATE TABLE IF NOT EXISTS pkg_service_formats (
  format_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'monthly' CHECK (category IN ('daily', 'weekly', 'monthly')),
  graded      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
);

-- ราคาแต่ละช่องของตาราง: (รูปแบบ, เกรด, ระดับพนักงาน) -> ค่าบริการ + ค่าตอบแทน
--
-- grade_id = NULL สำหรับรูปแบบที่ไม่อิงเกรด (รายวัน/สัปดาห์) — เรทเดียวใช้ทุกเกรด
-- available = false = ช่องที่ให้บริการระดับนี้ไม่ได้ (ช่องเทาในตาราง เช่น CG ทำเคสติดเตียงไม่ได้)
--
-- ราคาสุทธิและส่วนต่าง% ไม่ได้เก็บไว้ในตาราง — คิดตอนอ่านเสมอ เก็บซ้ำแล้วมีวันขัดกับราคาจริง
--   ราคาสุทธิ  = customer_price − ส่วนลด (มี discount_percent ให้ใช้ % ก่อน ไม่งั้นใช้ discount_amount)
--   ส่วนต่าง%  = (customer_price − staff_pay) / customer_price × 100
CREATE TABLE IF NOT EXISTS pkg_rates (
  rate_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  format_id      INTEGER NOT NULL REFERENCES pkg_service_formats (format_id) ON DELETE CASCADE,
  grade_id       INTEGER REFERENCES pkg_grades (grade_id) ON DELETE CASCADE,
  staff_tier     TEXT NOT NULL CHECK (staff_tier IN ('CG', 'NA', 'PN', 'RN')),
  customer_price DOUBLE PRECISION CHECK (customer_price >= 0),
  staff_pay      DOUBLE PRECISION CHECK (staff_pay >= 0),
  available      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
);

-- ส่วนลดของเรท — กรอกเป็น % หรือเป็นจำนวนเงินก็ได้ (กรอก % ไว้จะใช้ % ก่อน)
-- เก็บเฉพาะ "ค่าที่ผู้ใช้กรอก" ส่วนราคาสุทธิคำนวณตอนอ่าน
ALTER TABLE pkg_rates ADD COLUMN IF NOT EXISTS discount_percent DOUBLE PRECISION
  CHECK (discount_percent >= 0 AND discount_percent <= 100);
ALTER TABLE pkg_rates ADD COLUMN IF NOT EXISTS discount_amount  DOUBLE PRECISION
  CHECK (discount_amount >= 0);

-- หนึ่งช่องต่อหนึ่ง (รูปแบบ, เกรด, ระดับ)
-- แยกเป็น 2 index เพราะ NULL ใน UNIQUE ปกติไม่ชนกัน — เรทที่ไม่อิงเกรดจึงต้องมี index ของตัวเอง
CREATE UNIQUE INDEX IF NOT EXISTS idx_rates_graded
  ON pkg_rates (format_id, grade_id, staff_tier) WHERE grade_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rates_ungraded
  ON pkg_rates (format_id, staff_tier) WHERE grade_id IS NULL;

-- ระดับพนักงาน 4 ระดับ: CG (ผู้ดูแล) · NA (ผู้ช่วยพยาบาล) · PN (พยาบาลเทคนิค) · RN (พยาบาลวิชาชีพ)
-- ประกาศซ้ำเป็น named constraint เพื่อให้ฐานที่สร้างจากไฟล์รุ่นเก่าตามมาได้ด้วย
ALTER TABLE pkg_rates DROP CONSTRAINT IF EXISTS pkg_rates_staff_tier_check;
ALTER TABLE pkg_rates ADD CONSTRAINT pkg_rates_staff_tier_check
  CHECK (staff_tier IN ('CG', 'NA', 'PN', 'RN'));
