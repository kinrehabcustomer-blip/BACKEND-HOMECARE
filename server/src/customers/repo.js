import { sql, nextCustomerId, transaction } from '../db/index.js';

const COLUMNS = [
  // ตัวตน
  'name',
  'title',
  'nickname',
  'name_en',
  'gender',
  'national_id',
  'passport_no',
  'birth_date',
  'age', // ใช้เมื่อรู้แต่อายุคร่าวๆ ไม่รู้วันเกิด — ถ้ามี birth_date ให้คำนวณสดแทน
  'nationality',
  'marital_status',

  // ติดต่อ
  'phone',
  'home_phone',
  'line_id',
  'email',

  // ที่อยู่
  'address',
  'subdistrict',
  'district',
  'province',
  'postal_code',

  // ผู้ดูแล/ญาติ
  'emergency_contact_name',
  'emergency_contact_phone',

  'occupation',
  'customer_type',
  'referral_source',
  'note',

  // ข้อมูลออกบิล
  'tax_id',
  'payment_terms',
  'billing_address',
];

const NOW = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

export async function list({ q, has_cases, page, per_page, sort, order }) {
  const where = [];
  const params = {};

  if (q) {
    // ค้นจากทุกอย่างที่คนใช้เรียกลูกค้าจริง — ชื่อเล่นกับเลขบัตรถูกถามหาบ่อยพอๆ กับชื่อจริง
    where.push(`(customer_id ILIKE :q OR name ILIKE :q OR nickname ILIKE :q OR name_en ILIKE :q
                 OR phone ILIKE :q OR home_phone ILIKE :q OR national_id ILIKE :q OR line_id ILIKE :q)`);
    params.q = `%${q}%`;
  }

  // "ยังไม่เคยเปิดเคส" = ลูกค้าที่ติดต่อเข้ามาแล้วแต่ยังไม่ได้ใช้บริการ — กลุ่มที่ต้องตามต่อ
  // ใช้ EXISTS ไม่ใช่ COUNT(*) > 0 เพราะหยุดทันทีที่เจอแถวแรก ไม่ต้องนับให้ครบ
  if (has_cases === 'yes' || has_cases === 'no') {
    const not = has_cases === 'no' ? 'NOT ' : '';
    where.push(`${not}EXISTS (SELECT 1 FROM cases WHERE cases.customer_id = c.customer_id)`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // ต้องมี alias c ทั้งสอง query — เงื่อนไข has_cases อ้าง c.customer_id
  // (เงื่อนไขอื่นเขียนชื่อคอลัมน์เปล่าๆ ซึ่งยังทำงานได้ตามปกติเมื่อมี alias)
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM customers c ${clause}`, params);

  // นับเคสของลูกค้าแต่ละคนมาด้วย หน้าเว็บจะได้ไม่ต้องยิง API ซ้ำทีละแถว
  const rows = await sql.all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM cases WHERE customer_id = c.customer_id) AS case_count
     FROM customers c ${clause}
     ORDER BY ${sort} ${order.toUpperCase()}
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return {
    data: rows.map((r) => ({ ...r, case_count: Number(r.case_count) })),
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

export function findById(customerId) {
  return sql.one('SELECT * FROM customers WHERE customer_id = :id', { id: customerId });
}

/** ลูกค้าพร้อมผู้รับการดูแล (patients) และเคสทั้งหมดที่เคยใช้บริการ (ผูกด้วย customer_id) */
export async function findDetailById(customerId) {
  const customer = await findById(customerId);
  if (!customer) return null;

  const [patients, cases] = await Promise.all([
    // ผู้รับการดูแลที่อยู่ใต้ลูกค้ารายนี้ (ลูกค้าหนึ่งคนดูแลได้หลายคน)
    sql.all(
      `SELECT patient_id, name, nickname, gender, birth_date, age, relation_to_customer, status
       FROM patients WHERE customer_id = :id ORDER BY patient_id`,
      { id: customerId },
    ),
    sql.all(
      `SELECT c.case_id, c.title, c.case_type, c.status, c.start_date, c.end_date, c.fee,
              e.first_name || ' ' || e.last_name AS assigned_name
       FROM cases c
       LEFT JOIN employees e ON e.employee_id = c.assigned_to
       WHERE c.customer_id = :id
       ORDER BY c.case_id DESC`,
      { id: customerId },
    ),
  ]);

  return { ...customer, patients, cases };
}

export function create(input) {
  return transaction(async (tx) => {
    const customerId = await nextCustomerId(tx);
    const values = { customer_id: customerId };
    for (const col of COLUMNS) values[col] = input[col] ?? null;

    return tx.one(
      `INSERT INTO customers (customer_id, ${COLUMNS.join(', ')})
       VALUES (:customer_id, ${COLUMNS.map((c) => `:${c}`).join(', ')})
       RETURNING *`,
      values,
    );
  });
}

export async function update(customerId, input) {
  const fields = COLUMNS.filter((col) => col in input);
  if (fields.length === 0) return findById(customerId);

  const values = { customer_id: customerId };
  for (const col of fields) values[col] = input[col] ?? null;

  return sql.one(
    `UPDATE customers
     SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE customer_id = :customer_id
     RETURNING *`,
    values,
  );
}

export async function remove(customerId) {
  // เคสของลูกค้าคนนี้ไม่หายไปด้วย — FK เป็น ON DELETE SET NULL และเคสคัดลอกข้อมูลลูกค้าไว้แล้ว
  const changes = await sql.run('DELETE FROM customers WHERE customer_id = :id', { id: customerId });
  return changes > 0;
}
