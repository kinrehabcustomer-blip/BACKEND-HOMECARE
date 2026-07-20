import { sql, transaction } from '../db/index.js';

const NOW = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;
const COLUMNS = ['name', 'sessions', 'duration_months', 'original_price', 'special_price', 'active', 'note', 'sort_order'];

/**
 * เติมตัวเลขที่คำนวณได้ตอนอ่าน ไม่เก็บลง DB — เก็บซ้ำแล้วมีโอกาสขัดกับราคาจริงเมื่อแก้ราคาแล้วลืมอัปเดต
 *  - avg_per_session = ราคาพิเศษ / จำนวนครั้ง  (คอลัมน์ "ตกเฉลี่ย บาท/ครั้ง")
 *  - discount / discount_percent = ส่วนลดจากราคาเดิม (null ถ้าไม่ได้ตั้งราคาเดิมไว้)
 */
const withComputed = (p) => ({
  ...p,
  avg_per_session: p.sessions > 0 ? Math.round(p.special_price / p.sessions) : null,
  discount: p.original_price != null ? p.original_price - p.special_price : null,
  discount_percent:
    p.original_price != null && p.original_price > 0
      ? Math.round(((p.original_price - p.special_price) / p.original_price) * 100)
      : null,
});

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
    `INSERT INTO physio_packages (name, sessions, duration_months, original_price, special_price, active, note, sort_order)
     VALUES (:name, :sessions, :duration_months, :original_price, :special_price, :active, :note, :sort_order)
     RETURNING *`,
    {
      name: input.name,
      sessions: input.sessions,
      duration_months: input.duration_months ?? null,
      original_price: input.original_price ?? null,
      special_price: input.special_price,
      active: input.active ?? true,
      note: input.note ?? null,
      sort_order: input.sort_order ?? next,
    },
  );
  return withComputed(row);
}

export async function updatePackage(id, input) {
  const fields = COLUMNS.filter((c) => c in input);
  if (!fields.length) return findPackage(id);

  const values = { physio_package_id: id };
  for (const c of fields) values[c] = input[c] ?? null;

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
