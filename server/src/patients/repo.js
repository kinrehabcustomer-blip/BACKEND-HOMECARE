import { sql, nextPatientId, transaction } from '../db/index.js';

const COLUMNS = [
  'customer_id', // ผู้ว่าจ้าง (FK ไป customers) — ไม่ใช่ตัวผู้ป่วยเอง
  // ตัวตน
  'name',
  'title',
  'nickname',
  'name_en',
  'gender',
  'national_id',
  'passport_no',
  'birth_date',
  'age',
  'nationality',
  'relation_to_customer',

  // การแพทย์เชิงคงที่
  'weight_kg',
  'height_cm',
  'medical_history',
  'allergies',      // แพ้ยา
  'food_allergies', // แพ้อาหาร — แยกกันเพราะคนละคนที่ต้องรู้ (ให้ยา vs เตรียมอาหาร)
  'blood_type',
  'medical_rights',

  // ที่อยู่สถานที่ดูแล
  'address',
  'subdistrict',
  'district',
  'province',
  'postal_code',

  // ญาติ/ผู้ติดต่อฉุกเฉิน
  'emergency_contact_name',
  'emergency_contact_phone',
  'emergency_contact_relation',

  'status',
  'note',
];

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;

export async function list({ q, customer_id, has_customer, status, page, per_page, sort, order }) {
  const where = [];
  const params = {};

  if (q) {
    where.push(`(p.patient_id ILIKE :q OR p.name ILIKE :q OR p.nickname ILIKE :q
                 OR p.name_en ILIKE :q OR p.national_id ILIKE :q)`);
    params.q = `%${q}%`;
  }
  if (customer_id) {
    where.push('p.customer_id = :customer_id');
    params.customer_id = customer_id;
  }
  if (status) {
    where.push('p.status = :status');
    params.status = status;
  }
  // แฟ้มที่ยังไม่ผูกผู้ว่าจ้าง = ยังไม่รู้ว่าใครจ่าย ต้องตามเก็บ จึงต้องกรองหาได้
  if (has_customer === 'yes' || has_customer === 'no') {
    where.push(`p.customer_id IS ${has_customer === 'no' ? '' : 'NOT '}NULL`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM patients p ${clause}`, params);

  // ดึงชื่อ/เบอร์ผู้ว่าจ้างและจำนวนเคสของผู้ป่วยมาด้วย หน้าเว็บจะได้ไม่ต้องยิง API ซ้ำทีละแถว
  // (ผู้รับการดูแลไม่มีเบอร์ของตัวเอง — เบอร์ที่โทรจริงคือเบอร์ผู้ว่าจ้าง)
  // ต้องใส่ prefix p. ให้ sort เพราะ join customers ที่มีคอลัมน์ name/created_at ชื่อชนกัน
  const rows = await sql.all(
    `SELECT p.*, cu.name AS customer_name, cu.phone AS customer_phone,
            (SELECT COUNT(*) FROM cases WHERE patient_id = p.patient_id) AS case_count
     FROM patients p
     LEFT JOIN customers cu ON cu.customer_id = p.customer_id
     ${clause}
     ORDER BY p.${sort} ${order.toUpperCase()}
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return {
    data: rows.map((r) => ({ ...r, case_count: Number(r.case_count) })),
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

export function findById(patientId) {
  return sql.one('SELECT * FROM patients WHERE patient_id = :id', { id: patientId });
}

/** ผู้ป่วยพร้อมผู้ว่าจ้าง (ลูกค้า) และเคสทั้งหมดที่ผูกกับผู้ป่วยรายนี้ (ผูกด้วย patient_id) */
export async function findDetailById(patientId) {
  const patient = await findById(patientId);
  if (!patient) return null;

  const [customer, cases] = await Promise.all([
    patient.customer_id
      ? sql.one(
          'SELECT customer_id, name, phone FROM customers WHERE customer_id = :id',
          { id: patient.customer_id },
        )
      : Promise.resolve(null),
    sql.all(
      `SELECT c.case_id, c.title, c.case_type, c.status, c.start_date, c.end_date, c.fee,
              e.first_name || ' ' || e.last_name AS assigned_name
       FROM cases c
       LEFT JOIN employees e ON e.employee_id = c.assigned_to
       WHERE c.patient_id = :id
       ORDER BY c.case_id DESC`,
      { id: patientId },
    ),
  ]);

  return { ...patient, customer, cases };
}

export function create(input) {
  return transaction(async (tx) => {
    const patientId = await nextPatientId(tx);
    const values = { patient_id: patientId };
    for (const col of COLUMNS) values[col] = input[col] ?? null;
    // status เป็น NOT NULL DEFAULT 'active' — ส่ง null ไม่ได้ ถ้าไม่ระบุมาให้ใช้ค่าปริยาย
    values.status = input.status ?? 'active';

    return tx.one(
      `INSERT INTO patients (patient_id, ${COLUMNS.join(', ')})
       VALUES (:patient_id, ${COLUMNS.map((c) => `:${c}`).join(', ')})
       RETURNING *`,
      values,
    );
  });
}

export async function update(patientId, input) {
  const fields = COLUMNS.filter((col) => col in input);
  if (fields.length === 0) return findById(patientId);

  const values = { patient_id: patientId };
  for (const col of fields) values[col] = input[col] ?? null;

  return sql.one(
    `UPDATE patients
     SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE patient_id = :patient_id
     RETURNING *`,
    values,
  );
}

export async function remove(patientId) {
  // เคสที่ผูกผู้ป่วยรายนี้ไม่หายไปด้วย — FK เป็น ON DELETE SET NULL และเคสคัดลอกข้อมูลผู้ป่วยไว้แล้ว
  const changes = await sql.run('DELETE FROM patients WHERE patient_id = :id', { id: patientId });
  return changes > 0;
}
