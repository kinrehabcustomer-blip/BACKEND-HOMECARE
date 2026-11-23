import { sql } from '../db/index.js';
import { POSITIONS } from '../employees/schema.js';

/**
 * พาร์ทเนอร์ (ผู้รับเหมาช่วงรายครั้ง · ผู้ใช้ขอ 21 พ.ย. 2569) — โครงข้อมูล
 *
 *   partners              บริษัทพาร์ทเนอร์ + เรทต่อครั้ง (ค่าเดียวทั้งบริษัท ตามที่ตกลงรุ่นแรก)
 *   employees.partner_id  พนักงานของพาร์ทเนอร์ (ตำแหน่งหน้างานปกติ) และหัวหน้าพาร์ทเนอร์ (partner_lead)
 *   case_visits.partner_* กะที่ KIN ส่งให้พาร์ทเนอร์: pending = รอรับ · accepted = เลือกคนแล้ว
 *                         partner_rate = เรท ณ ตอนส่ง (เปลี่ยนเรททีหลังไม่ย้อนแก้ยอดเก่า)
 *                         partner_rejected_* = พาร์ทเนอร์ปฏิเสธล่าสุด (กะกลับมาหา KIN · กระดิ่งหลังบ้านนับ)
 *   partner_visit_events  ประวัติส่ง/รับ/เปลี่ยนคน/ปฏิเสธ/ดึงคืน (นับ "ปฏิเสธ" ในสรุปรายเดือน)
 *   partner_payments      KIN บันทึกว่าจ่ายยอดเดือนไหนให้บริษัทไหนแล้ว (ตรึงจำนวนครั้ง/ยอด ณ วันจ่าย)
 *
 * schema.sql มีชุดเดียวกัน (ตอน migrate) — ที่นี่สร้างให้เองตอนรันจริงกันกรณียังไม่ได้ migrate
 * ต้องมีก่อนคำขอแรก: requireAuth อ่าน employees.partner_id ทุกคำขอ (lib/auth.js)
 */
export const PARTNER_DDL = [
  `CREATE TABLE IF NOT EXISTS partners (
    partner_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           TEXT NOT NULL,
    contact_name   TEXT,
    phone          TEXT,
    rate_per_visit NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (rate_per_visit >= 0),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // โลโก้บริษัท (21 พ.ย. 2569) — ขึ้นที่ชิปส่งงาน/รายการพาร์ทเนอร์/หัวหน้าจอของหัวหน้าพาร์ทเนอร์
  'ALTER TABLE partners ADD COLUMN IF NOT EXISTS logo_data BYTEA',
  'ALTER TABLE partners ADD COLUMN IF NOT EXISTS logo_mime TEXT',
  'ALTER TABLE partners ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ',
  'ALTER TABLE employees ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES partners (partner_id) ON DELETE RESTRICT',
  'CREATE INDEX IF NOT EXISTS idx_employees_partner ON employees (partner_id) WHERE partner_id IS NOT NULL',
  'ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES partners (partner_id) ON DELETE RESTRICT',
  `ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_status TEXT CHECK (partner_status IN ('pending', 'accepted'))`,
  'ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_rate NUMERIC(12, 2)',
  'ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_sent_at TIMESTAMPTZ',
  'ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_sent_by TEXT',
  'ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_rejected_at TIMESTAMPTZ',
  'ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_rejected_by INTEGER',
  'ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS partner_reject_reason TEXT',
  'CREATE INDEX IF NOT EXISTS idx_case_visits_partner ON case_visits (partner_id, visit_date) WHERE partner_id IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS partner_visit_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    visit_id    INTEGER,
    case_id     TEXT,
    partner_id  INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('sent', 'accepted', 'reassigned', 'rejected', 'pulled')),
    employee_id TEXT,
    reason      TEXT,
    actor_id    TEXT,
    actor_name  TEXT,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_partner_visit_events_partner ON partner_visit_events (partner_id, at)',
  `CREATE TABLE IF NOT EXISTS partner_payments (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id   INTEGER NOT NULL REFERENCES partners (partner_id) ON DELETE RESTRICT,
    period_month TEXT NOT NULL CHECK (period_month ~ '^[0-9]{4}-[0-9]{2}$'),
    visits       INTEGER NOT NULL CHECK (visits >= 0),
    amount       NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    note         TEXT,
    paid_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_by      TEXT,
    paid_by_name TEXT,
    UNIQUE (partner_id, period_month)
  )`,
];

/** CHECK ของตำแหน่งต้องรู้จัก partner_lead — ทำใหม่เฉพาะตอนที่ของเดิมยังไม่มี (ไม่ล็อกตารางทุก cold start) */
async function ensurePositionCheck() {
  const row = await sql.one(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'employees'::regclass AND conname = 'employees_position_check'`,
  );
  if (!row || row.def.includes('partner_lead')) return; // ไม่มี CHECK (เช่นฐานทดสอบ) หรือมีแล้ว
  const list = POSITIONS.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
  await sql.run('ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_position_check');
  await sql.run(`ALTER TABLE employees ADD CONSTRAINT employees_position_check CHECK (position IN (${list}))`);
}

/* ทุกชิ้นของ PARTNER_DDL มีอยู่แล้วหรือยัง — อ่าน catalog อย่างเดียว ไม่ล็อกตาราง (ตรวจ 23 พ.ย. 2569)
   ALTER ... IF NOT EXISTS ขอล็อก ACCESS EXCLUSIVE ทุกครั้งแม้ไม่มีอะไรเปลี่ยน และ ensurePartnerSchema อยู่ใน requireAuth
   → instance ใหม่ต้องรอคิวล็อก case_visits ก่อนตอบคำขอแรก ถ้ามีรายงานยาวถือตารางอยู่ คำขออื่นทั้งหมดจะต่อคิวหลังมัน
   เช็คคอลัมน์ "ตัวท้ายสุด" ของแต่ละตาราง + ดัชนี/ตาราง — เพิ่มชิ้นใหม่ใน PARTNER_DDL ต้องเพิ่มที่นี่ด้วย */
const SCHEMA_PROBE = `
  SELECT (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND (
            (table_name = 'partners' AND column_name = 'logo_updated_at') OR
            (table_name = 'employees' AND column_name = 'partner_id') OR
            (table_name = 'case_visits' AND column_name IN ('partner_id', 'partner_status', 'partner_rate', 'partner_sent_at',
              'partner_sent_by', 'partner_rejected_at', 'partner_rejected_by', 'partner_reject_reason'))))::int AS cols,
         to_regclass('partner_visit_events') IS NOT NULL AND to_regclass('partner_payments') IS NOT NULL
           AND to_regclass('idx_employees_partner') IS NOT NULL AND to_regclass('idx_case_visits_partner') IS NOT NULL
           AND to_regclass('idx_partner_visit_events_partner') IS NOT NULL AS rels`;
const PROBE_COLS = 10;

let ready = null;
export const ensurePartnerSchema = () =>
  (ready ??= (async () => {
    const probe = await sql.one(SCHEMA_PROBE).catch(() => null);
    if (!(probe && probe.cols === PROBE_COLS && probe.rels)) {
      for (const ddl of PARTNER_DDL) await sql.run(ddl);
    }
    await ensurePositionCheck(); // อ่าน pg_constraint ก่อน แก้เฉพาะตอนยังไม่มี partner_lead
  })().catch((err) => { ready = null; throw err; }));
