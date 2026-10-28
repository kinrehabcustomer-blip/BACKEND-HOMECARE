import { sql, transaction } from '../db/index.js';
import { likeEscape } from '../lib/likeEscape.js';
import { ApiError } from '../lib/errors.js';

/** เจ้าของรหัสผู้รับบริการนี้ (ถ้ามี) — ใช้ทั้งตอนบันทึก และเส้นตรวจซ้ำที่หน้าฟอร์มเรียกระหว่างพิมพ์ */
export const patientCodeOwner = (db, code, exceptId = null) =>
  db.one(
    'SELECT patient_id, name FROM patients WHERE patient_id = :code AND patient_id IS DISTINCT FROM :except',
    { code, except: exceptId },
  );

/** รหัสผู้รับบริการซ้ำ — เช็คก่อนเขียน จะได้บอกได้ว่าซ้ำกับใคร (ชนกันพร้อมกันพอดียังมี PK กันอีกชั้น) */
export async function ensurePatientCodeFree(db, code, exceptId = null) {
  const taken = await patientCodeOwner(db, code, exceptId);
  if (taken) {
    throw new ApiError(409, `รหัสผู้รับบริการ ${code} มีอยู่แล้ว (${taken.name})`, [
      { field: 'patient_id', message: `รหัสนี้ถูกใช้กับ ${taken.name} แล้ว` },
    ]);
  }
}

const COLUMNS = [
  'customer_id', // ผู้ว่าจ้าง (FK ไป customers) — ไม่ใช่ตัวผู้รับบริการเอง
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
  'employer_relation',

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
    params.q = `%${likeEscape(q)}%`;
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

  // ดึงชื่อ/เบอร์ผู้ว่าจ้างและจำนวนเคสของผู้รับบริการมาด้วย หน้าเว็บจะได้ไม่ต้องยิง API ซ้ำทีละแถว
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

/** ผู้รับบริการพร้อมผู้ว่าจ้าง (ลูกค้า) และเคสทั้งหมดที่ผูกกับผู้รับบริการรายนี้ (ผูกด้วย patient_id) */
export async function findDetailById(patientId) {
  const patient = await findById(patientId);
  if (!patient) return null;

  const [customer, cases] = await Promise.all([
    patient.customer_id
      ? sql.one(
          // ส่งครบทุกช่องที่ฟอร์มผู้รับบริการแก้ได้ — ขาดช่องไหน ฟอร์มจะเห็นเป็นค่าว่างแล้วบันทึกทับของจริงทิ้ง
          'SELECT customer_id, name, phone, tax_id, billing_address FROM customers WHERE customer_id = :id',
          { id: patient.customer_id },
        )
      : Promise.resolve(null),
    sql.all(
      `SELECT c.case_id, c.title, c.case_type, c.service_kind, c.physio_package_id, c.status, c.start_date, c.end_date, c.fee,
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
    await ensurePatientCodeFree(tx, input.patient_id);
    const values = { patient_id: input.patient_id };
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
  /* เปลี่ยนรหัส (เช่น PAT-0003 → KN690202463) — cases.patient_id เป็น ON UPDATE CASCADE
     เคสที่ผูกอยู่ทุกใบจึงตามรหัสใหม่ไปเองในคำสั่งเดียวกัน */
  const nextId = input.patient_id && input.patient_id !== patientId ? input.patient_id : null;
  const fields = COLUMNS.filter((col) => col in input);
  if (fields.length === 0 && !nextId) return findById(patientId);

  return transaction(async (tx) => {
    if (nextId) await ensurePatientCodeFree(tx, nextId, patientId);

    const values = { patient_id: patientId, next_id: nextId ?? patientId };
    for (const col of fields) values[col] = input[col] ?? null;
    const sets = [...fields.map((c) => `${c} = :${c}`), 'patient_id = :next_id', `updated_at = ${NOW}`];

    const updated = await tx.one(
      `UPDATE patients
       SET ${sets.join(', ')}
       WHERE patient_id = :patient_id
       RETURNING *`,
      values,
    );

    /* รหัสเคส = รหัสผู้รับบริการ (ดู cases/caseCode.js) — เปลี่ยนรหัสคนแล้วรหัสเคสต้องตาม
       KN เดิม → KN ใหม่ · KN เดิม-R2 → KN ใหม่-R2 (อ้างเคสทุกตารางเป็น ON UPDATE CASCADE) */
    if (nextId) {
      await tx.run(
        `UPDATE cases SET case_id = :next_id || substr(case_id, length(:patient_id) + 1)
         WHERE patient_id = :next_id AND (case_id = :patient_id OR case_id LIKE :pattern)`,
        { patient_id: patientId, next_id: nextId, pattern: `${patientId}-R%` },
      );
    }
    return updated;
  });
}

export async function remove(patientId) {
  return transaction(async (tx) => {
    const found = await tx.one('SELECT patient_id FROM patients WHERE patient_id = :id FOR UPDATE', { id: patientId });
    if (!found) return { removed: false };
    const row = await tx.one(
      `SELECT COUNT(*) AS active_cases FROM cases
       WHERE patient_id = :id AND status NOT IN ('closed', 'cancelled')`,
      { id: patientId },
    );
    const activeCases = Number(row?.active_cases ?? 0);
    if (activeCases > 0) return { removed: false, reason: 'in_use', active_cases: activeCases };

    // เคสเก่าที่จบแล้วไม่หายไปด้วย — FK เป็น SET NULL และมี snapshot ของผู้รับบริการอยู่ในเคส
    const changes = await tx.run('DELETE FROM patients WHERE patient_id = :id', { id: patientId });
    return { removed: changes > 0 };
  });
}
