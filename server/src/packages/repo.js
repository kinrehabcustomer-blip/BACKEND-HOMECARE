import { sql, transaction } from '../db/index.js';

const NOW = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

// เปอร์เซ็นต์ที่คำนวณตอนอ่าน ไม่เก็บซ้ำใน DB — ต้องมีทั้งค่าบริการ (>0) และค่าตอบแทนจึงจะคำนวณได้ ไม่งั้นเป็น null
//   margin      = ส่วนต่างที่บริษัทได้    = (ค่าบริการ - ค่าตอบแทน) / ค่าบริการ * 100
//   staff_share = สัดส่วนค่าตอบแทนพนักงาน = ค่าตอบแทน / ค่าบริการ * 100      (margin + staff_share = 100)
// staff_share เตรียมไว้ใช้คำนวณรายได้ของพนักงานในอนาคต (ฐานคือ staff_pay ที่เก็บจริงในตาราง)
const withComputed = (r) => {
  const computable = r.customer_price != null && r.customer_price > 0 && r.staff_pay != null;
  return {
    ...r,
    margin: computable ? Math.round(((r.customer_price - r.staff_pay) / r.customer_price) * 100) : null,
    staff_share: computable ? Math.round((r.staff_pay / r.customer_price) * 100) : null,
  };
};

/** ตารางเรททั้งหมด: เกรด + รูปแบบบริการ + ราคาแต่ละช่อง (หน้าเว็บเอาไปประกอบเป็นตาราง) */
export async function getMatrix() {
  const [grades, formats, rates] = await Promise.all([
    sql.all('SELECT * FROM pkg_grades ORDER BY sort_order, grade_id'),
    sql.all('SELECT * FROM pkg_service_formats ORDER BY sort_order, format_id'),
    sql.all('SELECT * FROM pkg_rates'),
  ]);
  return { grades, formats, rates: rates.map(withComputed) };
}

/** ราคาช่องเดียว — ใช้ตอนเปิดเคสเพื่อดึงค่าบริการมาเป็น fee (grade_id ว่างได้ถ้ารูปแบบไม่อิงเกรด) */
export function findRate({ format_id, grade_id, staff_tier }) {
  return sql
    .one(
      `SELECT * FROM pkg_rates
       WHERE format_id = :format_id
         AND grade_id IS NOT DISTINCT FROM :grade_id
         AND staff_tier = :staff_tier`,
      { format_id, grade_id: grade_id ?? null, staff_tier },
    )
    .then((r) => (r ? withComputed(r) : null));
}

// ---------- เกรด ----------
export const findGrade = (id) => sql.one('SELECT * FROM pkg_grades WHERE grade_id = :id', { id });

export function createGrade(input) {
  return sql.one(
    `INSERT INTO pkg_grades (name, description, sort_order)
     VALUES (:name, :description, :sort_order) RETURNING *`,
    { name: input.name, description: input.description ?? null, sort_order: input.sort_order ?? 0 },
  );
}

export async function updateGrade(id, input) {
  const fields = ['name', 'description', 'sort_order'].filter((c) => c in input);
  if (!fields.length) return findGrade(id);
  const values = { grade_id: id };
  for (const c of fields) values[c] = input[c] ?? null;
  return sql.one(
    `UPDATE pkg_grades SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE grade_id = :grade_id RETURNING *`,
    values,
  );
}

// ลบเกรด -> pkg_rates ของเกรดนั้นหายตาม (CASCADE), cases.pkg_grade_id เป็น NULL (SET NULL)
export const removeGrade = (id) =>
  sql.run('DELETE FROM pkg_grades WHERE grade_id = :id', { id }).then((n) => n > 0);

// ---------- รูปแบบบริการ ----------
export const findFormat = (id) => sql.one('SELECT * FROM pkg_service_formats WHERE format_id = :id', { id });

export function createFormat(input) {
  return sql.one(
    `INSERT INTO pkg_service_formats (name, category, graded, sort_order)
     VALUES (:name, :category, :graded, :sort_order) RETURNING *`,
    {
      name: input.name,
      category: input.category ?? 'monthly',
      graded: input.graded ?? true,
      sort_order: input.sort_order ?? 0,
    },
  );
}

export async function updateFormat(id, input) {
  const fields = ['name', 'category', 'graded', 'sort_order'].filter((c) => c in input);
  if (!fields.length) return findFormat(id);
  const values = { format_id: id };
  for (const c of fields) values[c] = input[c] ?? null;
  return sql.one(
    `UPDATE pkg_service_formats SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE format_id = :format_id RETURNING *`,
    values,
  );
}

export const removeFormat = (id) =>
  sql.run('DELETE FROM pkg_service_formats WHERE format_id = :id', { id }).then((n) => n > 0);

// ---------- ราคา (bulk upsert) ----------
// อัปเดตช่องที่มีอยู่ ถ้ายังไม่มีก็สร้างใหม่ — เทียบ grade_id ด้วย IS NOT DISTINCT FROM เพื่อให้ NULL ตรงกับ NULL
async function upsertOne(tx, r) {
  const values = {
    format_id: r.format_id,
    grade_id: r.grade_id ?? null,
    staff_tier: r.staff_tier,
    customer_price: r.customer_price ?? null,
    staff_pay: r.staff_pay ?? null,
    available: r.available ?? true,
  };

  const updated = await tx.run(
    `UPDATE pkg_rates
     SET customer_price = :customer_price, staff_pay = :staff_pay, available = :available, updated_at = ${NOW}
     WHERE format_id = :format_id
       AND grade_id IS NOT DISTINCT FROM :grade_id
       AND staff_tier = :staff_tier`,
    values,
  );

  if (updated === 0) {
    await tx.one(
      `INSERT INTO pkg_rates (format_id, grade_id, staff_tier, customer_price, staff_pay, available)
       VALUES (:format_id, :grade_id, :staff_tier, :customer_price, :staff_pay, :available)
       RETURNING rate_id`,
      values,
    );
  }
}

export function upsertRates(rates) {
  return transaction(async (tx) => {
    for (const r of rates) await upsertOne(tx, r);
  }).then(getMatrix);
}
