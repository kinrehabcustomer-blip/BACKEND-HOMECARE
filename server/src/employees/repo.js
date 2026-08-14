import { sql, nextEmployeeId, transaction } from '../db/index.js';
import { hashPassword } from '../lib/auth.js';

const COLUMNS = [
  'first_name',
  'last_name',
  'first_name_en',
  'last_name_en',
  'nickname',
  'national_id',
  'phone',
  'email',
  'gender',
  'birth_date',
  'address',
  'education',
  'position',
  'employment_type',
  'status',
  'hire_date',
  'resign_date',
  'base_salary',
  'emergency_contact_name',
  'emergency_contact_phone',
  'note',
];

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;

// คอลัมน์ที่ส่งออก API ได้ — เขียนชื่อทีละตัวแทน SELECT * เพื่อไม่ให้ password_hash หลุดออกไปหน้าเว็บ
// photo_data ก็ไม่อยู่ในนี้ด้วยเหตุผลเดียวกับรูปใบรับรอง: ไบนารีรูปจะทำให้ทุก response อ้วนขึ้นหลายร้อย KB
// ส่งไปแค่ "มีรูปไหม" ให้หน้าเว็บตัดสินใจว่าจะเรียก GET .../photo มาแสดงหรือไม่
const PUBLIC = [
  'employee_id',
  ...COLUMNS,
  'role',
  'must_change_password',
  'last_login_at',
  'created_at',
  'updated_at',
  'photo_size',
  '(photo_data IS NOT NULL) AS has_photo',
].join(', ');

export async function list({ q, status, position, page, per_page, sort, order }) {
  const where = [];
  const params = {};

  if (q) {
    // ค้นได้ทั้งรหัสพนักงาน ชื่อไทย ชื่ออังกฤษ ชื่อเล่น และเบอร์โทร
    where.push(`(
      employee_id ILIKE :q OR first_name ILIKE :q OR last_name ILIKE :q
      OR first_name_en ILIKE :q OR last_name_en ILIKE :q
      OR nickname ILIKE :q OR phone ILIKE :q
    )`);
    params.q = `%${q}%`;
  }
  if (status) {
    where.push('status = :status');
    params.status = status;
  }
  if (position) {
    where.push('position = :position');
    params.position = position;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM employees ${clause}`, params);

  // sort/order ผ่าน enum ของ zod มาแล้ว จึงต่อ string ตรงนี้ได้ (Postgres ไม่ bind ชื่อคอลัมน์)
  // NULLS LAST — hire_date ว่างได้ ถ้าไม่ใส่ การเรียงจากใหม่ไปเก่าจะเอาคนที่ยังไม่ได้กรอกวันเริ่มงาน
  // ขึ้นก่อนคนที่เพิ่งเริ่มงานจริง (ค่าปริยายของ Postgres คือ NULLS FIRST เมื่อเรียงจากมากไปน้อย)
  const rows = await sql.all(
    `SELECT ${PUBLIC} FROM employees ${clause}
     ORDER BY ${sort} ${order.toUpperCase()} NULLS LAST
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  // COUNT(*) เป็น bigint — pg ส่งกลับมาเป็น string เพื่อกันค่าเกิน Number.MAX_SAFE_INTEGER
  const count = Number(total);

  return {
    data: rows,
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

export function findById(employeeId) {
  return sql.one(`SELECT ${PUBLIC} FROM employees WHERE employee_id = :id`, { id: employeeId });
}

/** ดึงพนักงานพร้อมข้อมูลที่ผูกกับ employee_id จากโมดูลอื่น (ใบรับรอง + ผลงาน + เคสที่รับผิดชอบ) */
export async function findDetailById(employeeId) {
  const employee = await findById(employeeId);
  if (!employee) return null;

  const [certificates, portfolio, cases] = await Promise.all([
    certificates_.listFor(employeeId),
    portfolio_.listFor(employeeId),
    // ประวัติการทำงาน: เคสที่กำลังทำอยู่และที่ปิดไปแล้ว — เรียงใหม่สุดขึ้นก่อน
    sql.all(
      `SELECT case_id, title, case_type, client_name, status,
              start_date, end_date, assigned_at, closed_at, fee
       FROM cases
       WHERE assigned_to = :id
       ORDER BY case_id DESC`,
      { id: employeeId },
    ),
  ]);

  return { ...employee, certificates, portfolio, cases };
}

export function create(input) {
  return transaction(async (tx) => {
    const employeeId = await nextEmployeeId(tx);
    const values = { employee_id: employeeId };
    for (const col of COLUMNS) values[col] = input[col] ?? null;

    // รหัสผ่านเริ่มต้นคือรหัสพนักงานของตัวเอง — เก็บเป็น hash ไม่เก็บ plain text
    values.password_hash = await hashPassword(employeeId);

    return tx.one(
      `INSERT INTO employees (employee_id, password_hash, ${COLUMNS.join(', ')})
       VALUES (:employee_id, :password_hash, ${COLUMNS.map((c) => `:${c}`).join(', ')})
       RETURNING ${PUBLIC}`,
      values,
    );
  });
}

export async function update(employeeId, input) {
  const fields = COLUMNS.filter((col) => col in input);
  if (fields.length === 0) return findById(employeeId);

  const values = { employee_id: employeeId };
  for (const col of fields) values[col] = input[col] ?? null;

  return sql.one(
    `UPDATE employees
     SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE employee_id = :employee_id
     RETURNING ${PUBLIC}`,
    values,
  );
}

/** ลาออก: เก็บประวัติไว้ ไม่ลบแถว เพราะ employee_id ยังถูกอ้างอิงจากโมดูลอื่น */
export function resign(employeeId, resignDate) {
  return sql.one(
    `UPDATE employees
     SET status = 'resigned', resign_date = :resign_date, updated_at = ${NOW}
     WHERE employee_id = :employee_id
     RETURNING ${PUBLIC}`,
    { employee_id: employeeId, resign_date: resignDate ?? null },
  );
}

export async function remove(employeeId) {
  return transaction(async (tx) => {
    // ปลดเคสที่ถืออยู่ก่อนลบ: เคสที่ยังทำงานอยู่กลับไปเป็น 'ยังไม่จับคู่' รอหาคนใหม่
    // (ต้องทำเองก่อน DELETE เพราะ FK จะ SET NULL ให้ แต่จะไปชน CHECK ที่ห้ามเคส 'assigned' ไม่มีพนักงาน)
    await tx.run(
      `UPDATE cases
       SET assigned_to = NULL,
           assigned_at = NULL,
           status = CASE WHEN status = 'assigned' THEN 'unassigned' ELSE status END,
           updated_at = ${NOW}
       WHERE assigned_to = :id`,
      { id: employeeId },
    );

    const changes = await tx.run('DELETE FROM employees WHERE employee_id = :id', { id: employeeId });
    return changes > 0;
  });
}

/**
 * จำนวนผู้จัดการที่ยังใช้งานระบบได้ — ใช้กันไม่ให้เหลือศูนย์
 *
 * ผู้จัดการเป็นตำแหน่งเดียวที่เห็นต้นทุน/กำไรและตั้งค่าจ้างได้ (ดู canSeeStaffPay)
 * ถ้าลดตำแหน่ง/ลาออก/ลบจนหมด จะไม่มีใครกู้กลับมาได้เลยนอกจากแก้ที่ฐานข้อมูลตรงๆ
 * นับเกณฑ์เดียวกับที่ใช้กันไม่ให้ login (BLOCKED_STATUSES) — คนที่พักงานอยู่ไม่นับว่าใช้ได้
 */
export async function activeManagerCount(excludeId = null) {
  const row = await sql.one(
    `SELECT COUNT(*) AS n FROM employees
     WHERE position = 'manager'
       AND status NOT IN ('resigned', 'suspended')
       AND (:exclude::text IS NULL OR employee_id <> :exclude)`,
    { exclude: excludeId },
  );
  return Number(row.n);
}

export async function summary() {
  const [byStatus, byPosition, totals] = await Promise.all([
    sql.all('SELECT status, COUNT(*) AS count FROM employees GROUP BY status'),
    sql.all('SELECT position, COUNT(*) AS count FROM employees GROUP BY position'),
    sql.one('SELECT COUNT(*) AS total FROM employees'),
  ]);

  const toNumber = (rows) => rows.map((row) => ({ ...row, count: Number(row.count) }));

  return {
    total: Number(totals.total),
    by_status: toNumber(byStatus),
    by_position: toNumber(byPosition),
  };
}

// ---------- รูปพนักงาน (หนึ่งคนหนึ่งรูป) ----------
export const photo = {
  /** ดึงไบนารีรูป — เรียกเฉพาะตอนหน้าเว็บขอรูปจริง */
  find(employeeId) {
    return sql.one(
      'SELECT photo_data, photo_mime FROM employees WHERE employee_id = :id AND photo_data IS NOT NULL',
      { id: employeeId },
    );
  },

  /**
   * แนบรูปใหม่ทับของเดิม (image = null คือลบรูปทิ้ง)
   * ต้องดัน updated_at ด้วย เพราะหน้าเว็บใช้ค่านี้เป็นตัวกันแคช — ไม่ดันแล้วเปลี่ยนรูปไปก็ยังเห็นรูปเก่า
   */
  set(employeeId, image) {
    return sql.one(
      `UPDATE employees
       SET photo_data = :photo_data, photo_mime = :photo_mime, photo_size = :photo_size,
           updated_at = ${NOW}
       WHERE employee_id = :id
       RETURNING ${PUBLIC}`,
      {
        id: employeeId,
        photo_data: image?.data ?? null,
        photo_mime: image?.mime ?? null,
        photo_size: image?.size ?? null,
      },
    );
  },
};

// คอลัมน์ที่ส่งออก API ได้ — ไม่รวม image_data (ไบนารีรูป) เพราะจะทำให้ทุก response อ้วนขึ้นหลายร้อย KB
// รูปดึงแยกผ่าน GET .../image เมื่อหน้าเว็บต้องใช้จริงเท่านั้น
const CERT_PUBLIC = `
  certificate_id, employee_id, name, issuer, issued_date, expiry_date, created_at,
  image_mime, image_size,
  (image_data IS NOT NULL) AS has_image
`;

const certificates_ = {
  listFor(employeeId) {
    return sql.all(
      `SELECT ${CERT_PUBLIC} FROM employee_certificates
       WHERE employee_id = :id
       ORDER BY issued_date DESC NULLS LAST`,
      { id: employeeId },
    );
  },

  add(employeeId, input) {
    const image = input.image ?? null; // { data: Buffer, mime, size }

    return sql.one(
      `INSERT INTO employee_certificates
         (employee_id, name, issuer, issued_date, expiry_date, image_data, image_mime, image_size)
       VALUES (:employee_id, :name, :issuer, :issued_date, :expiry_date, :image_data, :image_mime, :image_size)
       RETURNING ${CERT_PUBLIC}`,
      {
        employee_id: employeeId,
        name: input.name,
        issuer: input.issuer ?? null,
        issued_date: input.issued_date ?? null,
        expiry_date: input.expiry_date ?? null,
        image_data: image?.data ?? null,
        image_mime: image?.mime ?? null,
        image_size: image?.size ?? null,
      },
    );
  },

  /** ดึงไบนารีรูป — เรียกเฉพาะตอนหน้าเว็บขอรูปจริง */
  findImage(employeeId, certificateId) {
    return sql.one(
      `SELECT image_data, image_mime FROM employee_certificates
       WHERE certificate_id = :cert_id AND employee_id = :id AND image_data IS NOT NULL`,
      { cert_id: certificateId, id: employeeId },
    );
  },

  /** แนบรูปใหม่ทับของเดิม (ใบรับรองหนึ่งใบมีรูปได้หนึ่งรูป) */
  async setImage(employeeId, certificateId, image) {
    return sql.one(
      `UPDATE employee_certificates
       SET image_data = :image_data, image_mime = :image_mime, image_size = :image_size
       WHERE certificate_id = :cert_id AND employee_id = :id
       RETURNING ${CERT_PUBLIC}`,
      {
        cert_id: certificateId,
        id: employeeId,
        image_data: image?.data ?? null,
        image_mime: image?.mime ?? null,
        image_size: image?.size ?? null,
      },
    );
  },

  async remove(employeeId, certificateId) {
    const changes = await sql.run(
      'DELETE FROM employee_certificates WHERE certificate_id = :cert_id AND employee_id = :id',
      { cert_id: certificateId, id: employeeId },
    );
    return changes > 0;
  },
};

export const certificates = certificates_;

// ---------- ผลงาน (โปรไฟล์) ----------
// ไม่ส่ง image_data ออก API เช่นเดียวกับใบรับรอง — รูปดึงแยกผ่าน .../image
const PORTFOLIO_PUBLIC = `portfolio_id, employee_id, title, description, image_mime, image_size, created_at`;

const portfolio_ = {
  listFor(employeeId) {
    return sql.all(
      `SELECT ${PORTFOLIO_PUBLIC} FROM employee_portfolio
       WHERE employee_id = :id
       ORDER BY portfolio_id DESC`,
      { id: employeeId },
    );
  },

  add(employeeId, input) {
    return sql.one(
      `INSERT INTO employee_portfolio (employee_id, title, description, image_data, image_mime, image_size)
       VALUES (:employee_id, :title, :description, :image_data, :image_mime, :image_size)
       RETURNING ${PORTFOLIO_PUBLIC}`,
      {
        employee_id: employeeId,
        title: input.title,
        description: input.description ?? null,
        image_data: input.image.data,
        image_mime: input.image.mime,
        image_size: input.image.size,
      },
    );
  },

  /** แก้ได้เฉพาะชื่อกับคำอธิบาย — รูปไม่แตะ */
  update(employeeId, portfolioId, input) {
    return sql.one(
      `UPDATE employee_portfolio
       SET title = :title, description = :description
       WHERE portfolio_id = :pid AND employee_id = :id
       RETURNING ${PORTFOLIO_PUBLIC}`,
      {
        pid: portfolioId,
        id: employeeId,
        title: input.title,
        description: input.description ?? null,
      },
    );
  },

  findImage(employeeId, portfolioId) {
    return sql.one(
      `SELECT image_data, image_mime FROM employee_portfolio
       WHERE portfolio_id = :pid AND employee_id = :id`,
      { pid: portfolioId, id: employeeId },
    );
  },

  async remove(employeeId, portfolioId) {
    const changes = await sql.run(
      'DELETE FROM employee_portfolio WHERE portfolio_id = :pid AND employee_id = :id',
      { pid: portfolioId, id: employeeId },
    );
    return changes > 0;
  },
};

export const portfolio = portfolio_;
