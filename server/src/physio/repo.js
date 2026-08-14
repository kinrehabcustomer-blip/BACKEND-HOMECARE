import { sql, transaction } from '../db/index.js';

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;
const COLUMNS = [
  'name', 'sessions', 'duration_months', 'original_price', 'special_price',
  'discount_percent', 'discount_amount', 'staff_pay', 'active', 'note', 'sort_order',
];

/**
 * ส่วนลดเป็นบาทจากค่าที่ผู้ใช้กรอก — กรอก % ไว้ให้ใช้ % ก่อน ไม่งั้นใช้จำนวนเงิน
 * ตัดไม่ให้เกินราคาเต็ม เพื่อไม่ให้ราคาสุทธิติดลบแม้กรอกส่วนลดมากเกินไป
 */
function discountOf(price, percent, amount) {
  if (price == null || price <= 0) return 0;
  const raw = percent != null && percent > 0 ? (price * percent) / 100 : (amount ?? 0);
  return Math.min(Math.max(raw, 0), price);
}

/**
 * ราคาสุทธิให้ server คิดเองเสมอเมื่อมี "ราคาเต็ม" — หน้าเว็บส่งอะไรมาก็ไม่เชื่อ
 * จะได้ไม่มีทางที่ราคาสุทธิในฐานข้อมูลขัดกับส่วนลดที่เก็บไว้
 * ไม่มีราคาเต็ม = แพ็คเกจที่ไม่ได้ตั้งเป็นโปรโมชัน ใช้ราคาที่ส่งมาตรงๆ
 */
function resolveSpecialPrice(input, existing = {}) {
  const pick = (key) => (key in input ? input[key] : existing[key]);
  const full = pick('original_price');
  if (full == null) return pick('special_price');
  return full - discountOf(full, pick('discount_percent'), pick('discount_amount'));
}

/**
 * เติมตัวเลขที่คำนวณได้ตอนอ่าน ไม่เก็บลง DB — เก็บซ้ำแล้วมีโอกาสขัดกับราคาจริงเมื่อแก้ราคาแล้วลืมอัปเดต
 *  - avg_per_session = ราคาพิเศษ / จำนวนครั้ง  (คอลัมน์ "ตกเฉลี่ย บาท/ครั้ง")
 *  - discount / discount_percent = ส่วนลดจากราคาเดิม (null ถ้าไม่ได้ตั้งราคาเดิมไว้)
 */
const withComputed = (p) => {
  // ส่วนลดที่ผู้ใช้กรอกไว้ (%/บาท) — ไม่ทับ discount_percent/discount_amount ของเดิม เพราะเป็น "สิ่งที่กรอก"
  // ฟอร์มแก้ไขต้องอ่านค่าเดิมกลับไปให้ตรง (กรอกเป็นบาทไว้ ต้องไม่กลายเป็น % ตอนเปิดแก้)
  const explicit = discountOf(p.original_price, p.discount_percent, p.discount_amount);
  // แพ็คเกจเก่าที่ตั้งไว้ก่อนมีช่องส่วนลด — เดาส่วนลดจากผลต่างราคาเต็มกับราคาที่ขายจริง
  const legacy = p.original_price != null ? Math.max(0, p.original_price - p.special_price) : 0;

  // ส่วนต่างที่บริษัทได้จากราคาที่ขายจริง — สูตรเดียวกับตารางเรท Homecare (packages/repo.js)
  // คิดตอนอ่าน ไม่เก็บซ้ำ จะได้ไม่มีวันขัดกับราคา/ค่าจ้างที่แก้ทีหลัง
  const computable = p.special_price > 0 && p.staff_pay != null;

  return {
    ...p,
    avg_per_session: p.sessions > 0 ? Math.round(p.special_price / p.sessions) : null,
    discount: explicit > 0 ? explicit : legacy, // ส่วนลดเป็นบาทที่คิดได้จริง
    margin: computable ? Math.round(((p.special_price - p.staff_pay) / p.special_price) * 100) : null,
  };
};

/** ทุกแพ็คเกจเรียงตามลำดับที่ตั้งไว้ — เท่ากันให้เรียงตามจำนวนครั้งน้อยไปมาก (1 ครั้ง -> 30 ครั้ง) */
export async function listPackages() {
  const rows = await sql.all(
    'SELECT * FROM physio_packages ORDER BY sort_order, sessions, physio_package_id',
  );
  return rows.map(withComputed);
}

export const findPackage = (id) =>
  sql
    .one('SELECT * FROM physio_packages WHERE physio_package_id = :id', { id })
    .then((p) => (p ? withComputed(p) : null));

export async function createPackage(input) {
  // ไม่ระบุลำดับมา = ต่อท้ายรายการ
  const { next } = await sql.one(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM physio_packages',
  );
  const row = await sql.one(
    `INSERT INTO physio_packages
       (name, sessions, duration_months, original_price, special_price,
        discount_percent, discount_amount, staff_pay, active, note, sort_order)
     VALUES (:name, :sessions, :duration_months, :original_price, :special_price,
             :discount_percent, :discount_amount, :staff_pay, :active, :note, :sort_order)
     RETURNING *`,
    {
      name: input.name,
      sessions: input.sessions,
      duration_months: input.duration_months ?? null,
      original_price: input.original_price ?? null,
      special_price: resolveSpecialPrice(input),
      discount_percent: input.discount_percent ?? null,
      discount_amount: input.discount_amount ?? null,
      staff_pay: input.staff_pay ?? null,
      active: input.active ?? true,
      note: input.note ?? null,
      sort_order: input.sort_order ?? next,
    },
  );
  return withComputed(row);
}

export async function updatePackage(id, input) {
  const existing = await sql.one('SELECT * FROM physio_packages WHERE physio_package_id = :id', { id });
  if (!existing) return null;

  // แตะราคาเต็มหรือส่วนลดเมื่อไหร่ ต้องคิดราคาสุทธิใหม่ด้วยเสมอ ไม่งั้นสองค่าจะขัดกัน
  const PRICE_KEYS = ['original_price', 'discount_percent', 'discount_amount', 'special_price'];
  const patch = PRICE_KEYS.some((k) => k in input)
    ? { ...input, special_price: resolveSpecialPrice(input, existing) }
    : input;

  const fields = COLUMNS.filter((c) => c in patch);
  if (!fields.length) return findPackage(id);

  const values = { physio_package_id: id };
  for (const c of fields) values[c] = patch[c] ?? null;

  const row = await sql.one(
    `UPDATE physio_packages SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE physio_package_id = :physio_package_id RETURNING *`,
    values,
  );
  return row ? withComputed(row) : null;
}

export const removePackage = (id) =>
  sql.run('DELETE FROM physio_packages WHERE physio_package_id = :id', { id }).then((n) => n > 0);

/** จัดลำดับใหม่ทั้งชุด — ทำใน transaction เดียวเพื่อไม่ให้ลำดับค้างครึ่งๆ กลางๆ ถ้าพัง */
export function reorderPackages(order) {
  return transaction(async (tx) => {
    for (const [i, id] of order.entries()) {
      await tx.run(
        `UPDATE physio_packages SET sort_order = :sort_order, updated_at = ${NOW}
         WHERE physio_package_id = :id`,
        { sort_order: i + 1, id },
      );
    }
  }).then(listPackages);
}
