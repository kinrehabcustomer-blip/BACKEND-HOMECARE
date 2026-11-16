import { pool, sql, transaction } from '../db/index.js';
import { ApiError } from '../lib/errors.js';

/**
 * หมวดหมู่ (category / sub category) — ตารางเดียวใช้ร่วมทุกส่วน แยกด้วย domain (ผู้ใช้ขอ 16 พ.ย. 2569 · เฟสแรก)
 *
 *   หมวดหลัก (parent_id ว่าง) → หมวดย่อย (parent_id = หมวดหลัก) · ลึกได้ 2 ชั้นเท่านั้น (trigger ในฐานกันไว้)
 *   รหัส (code): <โดเมน 3 ตัว>-<หมวดหลัก 3 ตัว>[-<หมวดย่อย 2 หลัก>] เช่น RCS-CUS-02 · ตั้งแล้วเปลี่ยนไม่ได้
 *   ไม่มีการลบ — เลิกใช้ = ปิด (active = false) รายงานย้อนหลังยังมีชื่อหมวดให้อ่าน
 *
 * สองแบบของโดเมน
 *   · เหตุผล (cancel_*): หมวดย่อยคือตัวเหตุผลเอง — เพิ่ม/แก้/ปิดได้จากหน้าจัดการหมวด แล้วโผล่ในช่องเลือกเหตุผลทันที
 *   · รายการที่กำหนดในระบบ (procedure · incident): ตัวรายการ (PR0001 · fall) อยู่ในโค้ด หมวดย่อยถือรายชื่อรหัสไว้ (item_keys)
 *     แก้ชื่อ/ลำดับ/เปิดปิดได้ แต่เพิ่มหมวดใหม่ไม่ได้ (หมวดเปล่าที่ไม่มีรายการไม่มีประโยชน์)
 *
 * เหตุผลยกเลิกเก็บเป็น cancel_reason_id ของเคส/กะ/ใบแจ้งหนี้ (ไว้ทำรายงาน) และชื่อเหตุผลถูกเขียนนำหน้าข้อความ
 * cancel_reason เดิม — หน้าจอ/ข้อความ LINE ที่แสดง cancel_reason อยู่แล้วจึงเห็นชื่อเหตุผลโดยไม่ต้องแก้ตาม
 */

export const CATEGORY_DOMAINS = {
  cancel_case: { prefix: 'RCS', label: 'เหตุผลยกเลิกเคส', editable: true },
  cancel_visit: { prefix: 'RVS', label: 'เหตุผลยกเลิกนัด / กะ', editable: true },
  cancel_invoice: { prefix: 'RIV', label: 'เหตุผลยกเลิกใบแจ้งหนี้', editable: true },
  procedure: { prefix: 'PRC', label: 'หมวดหัตถการ', editable: false, itemLabel: 'หัตถการ' },
  incident: { prefix: 'INC', label: 'หมวดเหตุการณ์ผิดปกติ (รายงานการดูแล)', editable: false, itemLabel: 'เหตุการณ์' },
};
export const DOMAIN_KEYS = Object.keys(CATEGORY_DOMAINS);

/* ---------- หมวดตั้งต้น ----------
 * [รหัสหมวดหลัก, ชื่อ, [[ชื่อหมวดย่อย, รายการ?], …]] — หมวดย่อยได้เลข 01, 02, … ตามลำดับ
 * ใส่ครั้งเดียวตอนยังไม่มีรหัสนั้น (ON CONFLICT DO NOTHING) — ชื่อที่ผู้ใช้แก้แล้วไม่ถูกทับตอน migrate รอบหลัง */
const SEED = {
  cancel_case: [
    ['CUS', 'ฝั่งลูกค้า / ผู้รับบริการ', [
      ['ลูกค้าเปลี่ยนใจ / ไม่ต้องการบริการแล้ว'], ['ผู้รับบริการเข้าโรงพยาบาล'], ['ผู้รับบริการเสียชีวิต'],
      ['ย้ายไปใช้ผู้ให้บริการอื่น'], ['ราคา / งบประมาณ'], ['ญาติดูแลเอง'],
    ]],
    ['COM', 'ฝั่งบริษัท', [['หาพนักงานไม่ได้'], ['อยู่นอกพื้นที่ให้บริการ'], ['เปิดเคสผิด / ซ้ำ']]],
    ['STF', 'ฝั่งพนักงาน', [['พนักงานลาออก / ไม่มาทำงาน'], ['ลูกค้าขอเปลี่ยนพนักงาน หาคนแทนไม่ได้']]],
    ['OTH', 'อื่น ๆ', [['อื่น ๆ (ระบุในรายละเอียด)']]],
  ],
  cancel_visit: [
    ['CUS', 'ฝั่งลูกค้า / ผู้รับบริการ', [
      ['ผู้รับบริการไม่สบาย / เข้าโรงพยาบาล'], ['ลูกค้าขอเลื่อน / งดนัด'], ['ไม่มีคนอยู่บ้าน / เข้าบ้านไม่ได้'],
    ]],
    ['STF', 'ฝั่งพนักงาน', [['พนักงานป่วย / ลา'], ['พนักงานไม่มาโดยไม่แจ้ง']]],
    ['COM', 'ฝั่งบริษัท', [['ลงนัดผิด / ซ้ำ'], ['ปรับแผนการดูแล']]],
    ['FRC', 'เหตุสุดวิสัย', [['ภัยธรรมชาติ / การเดินทาง']]],
    ['OTH', 'อื่น ๆ', [['อื่น ๆ (ระบุในรายละเอียด)']]],
  ],
  cancel_invoice: [
    ['ERR', 'ออกใบผิด', [['ยอด / รายการผิด'], ['ชื่อ / ที่อยู่ผู้ชำระผิด'], ['ออกใบซ้ำ']]],
    ['CUS', 'ฝั่งลูกค้า', [['ลูกค้ายกเลิกบริการ'], ['เปลี่ยนแพ็คเกจ / รูปแบบบริการ']]],
    ['OTH', 'อื่น ๆ', [['อื่น ๆ (ระบุในรายละเอียด)']]],
  ],
  // รายการ = รหัสใน client/src/lib/procedureCatalog.js
  procedure: [
    ['RES', 'ทางเดินหายใจ', [['ดูดเสมหะ', ['PR0003']], ['ออกซิเจน / พ่นยา', ['PR0007', 'PR0021', 'PR0029']]]],
    ['FED', 'การให้อาหารทางสาย', [['ให้อาหาร / นมทางสาย', ['PR0001', 'PR0002']], ['ใส่สายให้อาหาร', ['PR0014', 'PR0015', 'PR0016']]]],
    ['WND', 'แผล', [['ทำแผลทั่วไป', ['PR0008', 'PR0009', 'PR0010']], ['แผลเจาะคอ / หน้าท้อง', ['PR0004', 'PR0005', 'PR0006']]]],
    ['URO', 'ทางเดินปัสสาวะ', [['สวนปัสสาวะ', ['PR0017', 'PR0018']]]],
    ['LAB', 'ตรวจ / เจาะเลือด', [['ตรวจน้ำตาลปลายนิ้ว', ['PR0019', 'PR0020']], ['เจาะเลือด', ['PR0022']]]],
    ['CAR', 'บุคลากรดูแล / เฝ้า', [
      ['ผู้เฝ้า / นักบริบาลเฝ้าพิเศษ', ['PR0011', 'PR0023']], ['ค่าดูแลผู้ป่วยรายเดือน', ['PR0024', 'PR0025']],
      ['แพทย์ตรวจประเมิน', ['PR0028']],
    ]],
    ['REH', 'ฟื้นฟู', [['กายภาพพื้นฐาน', ['PR0026']], ['ทีมฟื้นฟูสหวิชาชีพ', ['PR0027']]]],
    ['EQP', 'อุปกรณ์', [['เตียงลม', ['PR0012', 'PR0013']]]],
  ],
  // รายการ = ค่าใน INCIDENT_TYPES / PHYSIO_INCIDENT_TYPES (client/src/lib/dailyCare.js · คอลัมน์ case_reports.incident_types)
  incident: [
    ['SAF', 'ความปลอดภัย / อุบัติเหตุ', [['ล้ม / เกือบล้ม', ['fall']], ['บาดเจ็บระหว่างทำ', ['injury']], ['ความผิดพลาดเรื่องยา', ['med_error']]]],
    ['RES', 'ระบบหายใจ', [['หายใจลำบาก / เหนื่อย', ['breathing', 'dyspnea']], ['ออกซิเจนต่ำ', ['spo2']], ['เสมหะผิดปกติ', ['sputum']]]],
    ['CVS', 'หัวใจและการไหลเวียน', [
      ['ความดันผิดปกติ', ['bp_abnormal']], ['ชีพจรผิดปกติ', ['pulse_abnormal']], ['เจ็บแน่นหน้าอก', ['chest_pain']],
      ['เวียนศีรษะ / หน้ามืด', ['dizzy']],
    ]],
    ['NEU', 'ระบบประสาท', [['ความรู้สึกตัวเปลี่ยน', ['consciousness']], ['ชัก', ['seizure']], ['เกร็งผิดปกติ', ['spasticity']]]],
    ['GEN', 'อาการทั่วไป', [['ไข้', ['fever']], ['อาเจียน', ['vomiting']], ['ปัสสาวะลดลง', ['urine']], ['ปวดเพิ่มขึ้น', ['pain_up']]]],
    ['SKN', 'ผิวหนัง / แผล / เลือด', [['แผล / รอยแดงใหม่', ['wound', 'skin']], ['เลือดออก', ['bleeding']]]],
    ['DEV', 'สายและอุปกรณ์', [['สายทางการแพทย์มีปัญหา', ['tube']], ['อุปกรณ์ขัดข้อง', ['equipment']]]],
    ['OTH', 'อื่น ๆ', [['ปฏิเสธการรักษา / หยุดกลางคัน', ['refuse']], ['อื่น ๆ', ['other']]]],
  ],
};

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (items) => `ARRAY[${(items ?? []).map(lit).join(', ')}]::text[]`;

function seedSql() {
  const out = [];
  for (const [domain, mains] of Object.entries(SEED)) {
    const { prefix } = CATEGORY_DOMAINS[domain];
    mains.forEach(([cat, name, subs], i) => {
      const code = `${prefix}-${cat}`;
      out.push(`INSERT INTO categories (domain, code, name_th, sort_order) VALUES (${lit(domain)}, ${lit(code)}, ${lit(name)}, ${(i + 1) * 10})
        ON CONFLICT (code) DO NOTHING;`);
      subs.forEach(([subName, items], j) => {
        const subCode = `${code}-${String(j + 1).padStart(2, '0')}`;
        out.push(`INSERT INTO categories (domain, parent_id, code, name_th, sort_order, item_keys)
          SELECT ${lit(domain)}, category_id, ${lit(subCode)}, ${lit(subName)}, ${(j + 1) * 10}, ${arr(items)}
            FROM categories WHERE code = ${lit(code)}
          ON CONFLICT (code) DO NOTHING;`);
      });
    });
  }
  return out.join('\n');
}

/* ---------- โครงสร้าง ----------
 * แหล่งเดียว (แบบเดียวกับ audit_logs) — migrate.js รันทั้งก้อนทุกครั้ง · แอปรันเองตอนยังไม่มีตาราง
 * รวมคอลัมน์ cancel_reason_id ของเคส/กะ/ใบแจ้งหนี้ไว้ที่นี่ เพราะชี้มาที่ตารางนี้ (ต้องเกิดหลังตาราง) */
export const CATEGORY_DDL = `
CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain      TEXT NOT NULL,
  parent_id   INTEGER REFERENCES categories (category_id) ON DELETE RESTRICT,
  code        TEXT NOT NULL UNIQUE,
  name_th     TEXT NOT NULL,
  name_en     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  item_keys   TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_categories_domain ON categories (domain, parent_id, sort_order);

CREATE OR REPLACE FUNCTION categories_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE p categories%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.code <> OLD.code OR NEW.domain <> OLD.domain
                           OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    RAISE EXCEPTION 'รหัส โดเมน และหมวดแม่ของหมวดหมู่เปลี่ยนไม่ได้';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO p FROM categories WHERE category_id = NEW.parent_id;
    IF p.parent_id IS NOT NULL THEN RAISE EXCEPTION 'หมวดหมู่ลึกได้ 2 ชั้น (หมวดหลัก → หมวดย่อย) เท่านั้น'; END IF;
    IF p.domain <> NEW.domain THEN RAISE EXCEPTION 'หมวดย่อยต้องอยู่โดเมนเดียวกับหมวดหลัก'; END IF;
  END IF;
  RETURN NEW;
END
$fn$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'categories_guard') THEN
    CREATE TRIGGER categories_guard BEFORE INSERT OR UPDATE ON categories
      FOR EACH ROW EXECUTE FUNCTION categories_guard();
  END IF;
END
$do$;

ALTER TABLE cases       ADD COLUMN IF NOT EXISTS cancel_reason_id INTEGER REFERENCES categories (category_id) ON DELETE SET NULL;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS cancel_reason_id INTEGER REFERENCES categories (category_id) ON DELETE SET NULL;
ALTER TABLE invoices    ADD COLUMN IF NOT EXISTS cancel_reason_id INTEGER REFERENCES categories (category_id) ON DELETE SET NULL;

${seedSql()}
`;

let ready = null;
/** สร้างตาราง + หมวดตั้งต้นครั้งแรกของแต่ละ instance ถ้ายังไม่มี (ของจริงสร้างตอน migrate · ดู db/migrate.js) */
export const ensureCategories = () =>
  (ready ??= (async () => {
    const { rows } = await pool.query(`SELECT to_regclass('categories') IS NOT NULL AS ok`);
    if (!rows[0].ok) await pool.query(CATEGORY_DDL);
  })().catch((err) => {
    ready = null;
    throw err;
  }));

const COLUMNS = `category_id, domain, parent_id, code, name_th, name_en, sort_order, active, item_keys,
                 to_char(updated_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS updated_at`;

/** รายการหมวด (แบนราบ หน้าเว็บประกอบเป็นต้นไม้เอง) — includeInactive สำหรับหน้าจัดการหมวด */
export async function list({ domain = null, includeInactive = false } = {}) {
  await ensureCategories();
  return sql.all(
    `SELECT ${COLUMNS} FROM categories
      WHERE (:domain::text IS NULL OR domain = :domain::text)
        AND (:all::boolean OR active)
      ORDER BY domain, sort_order, category_id`,
    { domain, all: includeInactive },
  );
}

/**
 * เพิ่มหมวด — หมวดหลักต้องตั้งรหัส 3 ตัวอักษรเอง · หมวดย่อยได้เลขถัดไปของหมวดแม่ให้เอง
 * โดเมนที่รายการอยู่ในโค้ด (editable: false) เพิ่มไม่ได้ — หมวดเปล่าที่ไม่มีรายการไม่มีประโยชน์
 */
export async function create({ domain, parent_id = null, code = null, name_th, name_en = null }) {
  await ensureCategories();
  const meta = CATEGORY_DOMAINS[domain];
  if (!meta) throw new ApiError(400, 'ไม่รู้จักโดเมนนี้');
  if (!meta.editable) throw new ApiError(400, `${meta.label}: รายการอยู่ในระบบ เพิ่มหมวดเองไม่ได้ — แก้ชื่อ/ลำดับ/เปิดปิดได้`);

  if (parent_id == null) {
    if (!/^[A-Z]{3}$/.test(code ?? '')) throw new ApiError(400, 'รหัสหมวดหลักต้องเป็นตัวอักษรภาษาอังกฤษพิมพ์ใหญ่ 3 ตัว (เช่น CUS)');
    const fullCode = `${meta.prefix}-${code}`;
    if (await sql.one('SELECT 1 FROM categories WHERE code = :c', { c: fullCode })) {
      throw new ApiError(409, `รหัส ${fullCode} ถูกใช้แล้ว`);
    }
    const next = await sql.one(
      `SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM categories WHERE domain = :domain AND parent_id IS NULL`,
      { domain },
    );
    return sql.one(
      `INSERT INTO categories (domain, code, name_th, name_en, sort_order)
       VALUES (:domain, :code, :name_th, :name_en, :sort) RETURNING ${COLUMNS}`,
      { domain, code: fullCode, name_th, name_en, sort: next.n },
    );
  }

  /* หมวดย่อย — เลขถัดไปคิดจากรหัสที่มีอยู่ (รวมที่ปิดไปแล้ว — เลขเก่าไม่ถูกเอามาใช้ซ้ำ)
     ล็อกหมวดแม่ไว้กันสองคนกดเพิ่มพร้อมกันแล้วได้เลขเดียวกัน */
  return transaction(async (tx) => {
    const parent = await tx.one('SELECT * FROM categories WHERE category_id = :id FOR UPDATE', { id: parent_id });
    if (!parent || parent.domain !== domain) throw new ApiError(400, 'ไม่พบหมวดหลักนี้ในโดเมนที่เลือก');
    if (parent.parent_id != null) throw new ApiError(400, 'หมวดหมู่ลึกได้ 2 ชั้น — เพิ่มใต้หมวดหลักเท่านั้น');
    const { n, sort } = await tx.one(
      `SELECT COALESCE(max(substring(code FROM '-(\\d+)$')::int), 0) + 1 AS n,
              COALESCE(max(sort_order), 0) + 10 AS sort
         FROM categories WHERE parent_id = :id`,
      { id: parent_id },
    );
    if (n > 99) throw new ApiError(409, 'หมวดนี้มีหมวดย่อยครบ 99 รายการแล้ว');
    return tx.one(
      `INSERT INTO categories (domain, parent_id, code, name_th, name_en, sort_order)
       VALUES (:domain, :parent_id, :code, :name_th, :name_en, :sort) RETURNING ${COLUMNS}`,
      { domain, parent_id, code: `${parent.code}-${String(n).padStart(2, '0')}`, name_th, name_en, sort },
    );
  });
}

/** แก้ชื่อ / ลำดับ / เปิด-ปิด — รหัส โดเมน และหมวดแม่เปลี่ยนไม่ได้ (trigger กันซ้ำอีกชั้น) */
export async function update(id, input) {
  await ensureCategories();
  const fields = ['name_th', 'name_en', 'sort_order', 'active'].filter((k) => k in input);
  if (fields.length === 0) throw new ApiError(400, 'ไม่มีอะไรให้แก้');
  const row = await sql.one(
    `UPDATE categories SET ${fields.map((f) => `${f} = :${f}`).join(', ')}, updated_at = now()
      WHERE category_id = :id RETURNING ${COLUMNS}`,
    { id, ...Object.fromEntries(fields.map((f) => [f, input[f] ?? null])) },
  );
  if (!row) throw new ApiError(404, 'ไม่พบหมวดนี้');
  return row;
}

/**
 * ตรวจเหตุผลที่เลือกมา — ต้องเป็นหมวดย่อย (มีหมวดแม่) ของโดเมนนั้น และยังเปิดใช้อยู่ทั้งตัวเองและหมวดแม่
 * คืน { id, code, name, label } · label = "หมวดหลัก › เหตุผล" ไว้เขียนนำหน้าข้อความเหตุผลเดิม
 */
export async function resolveReason(domain, id) {
  if (id == null) return null;
  await ensureCategories();
  const row = await sql.one(
    `SELECT c.category_id, c.code, c.name_th, c.active, c.domain, p.name_th AS parent_name, p.active AS parent_active
       FROM categories c LEFT JOIN categories p ON p.category_id = c.parent_id
      WHERE c.category_id = :id`,
    { id },
  );
  if (!row || row.domain !== domain || row.parent_name == null) {
    throw new ApiError(400, 'เหตุผลที่เลือกไม่ถูกต้อง — กรุณาเลือกจากรายการ');
  }
  if (!row.active || !row.parent_active) throw new ApiError(400, 'เหตุผลนี้ถูกปิดใช้แล้ว — กรุณาเลือกใหม่');
  return { id: row.category_id, code: row.code, name: row.name_th, label: `${row.parent_name} › ${row.name_th}` };
}

/** ข้อความเหตุผลที่เก็บ/แสดง = ชื่อเหตุผล [— รายละเอียดที่พิมพ์เพิ่ม] */
export const reasonText = (reason, text) => {
  const extra = (text ?? '').trim();
  if (!reason) return extra || null;
  return extra ? `${reason.name} — ${extra}` : reason.name;
};
