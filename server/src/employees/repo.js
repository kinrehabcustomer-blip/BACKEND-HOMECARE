import { db, nextEmployeeId, transaction } from '../db/index.js';

const COLUMNS = [
  'first_name',
  'last_name',
  'nickname',
  'national_id',
  'phone',
  'email',
  'gender',
  'birth_date',
  'address',
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

export function list({ q, status, position, page, per_page, sort, order }) {
  const where = [];
  const params = {};

  if (q) {
    // ค้นได้ทั้งรหัสพนักงาน ชื่อ นามสกุล ชื่อเล่น และเบอร์โทร
    where.push(`(
      employee_id LIKE :q OR first_name LIKE :q OR last_name LIKE :q
      OR nickname LIKE :q OR phone LIKE :q
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
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM employees ${clause}`).get(params);

  // sort/order ผ่าน enum ของ zod มาแล้ว จึงต่อ string ตรงนี้ได้ (SQLite ไม่ bind ชื่อคอลัมน์)
  const rows = db
    .prepare(
      `SELECT * FROM employees ${clause}
       ORDER BY ${sort} ${order.toUpperCase()}
       LIMIT :limit OFFSET :offset`,
    )
    .all({ ...params, limit: per_page, offset: (page - 1) * per_page });

  return {
    data: rows,
    pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) || 1 },
  };
}

export function findById(employeeId) {
  return db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(employeeId) ?? null;
}

/** ดึงพนักงานพร้อมข้อมูลที่ผูกกับ employee_id จากโมดูลอื่น */
export function findDetailById(employeeId) {
  const employee = findById(employeeId);
  if (!employee) return null;

  const certificates = db
    .prepare('SELECT * FROM employee_certificates WHERE employee_id = ? ORDER BY issued_date DESC')
    .all(employeeId);

  return { ...employee, certificates };
}

export function create(input) {
  return transaction(() => {
    const employeeId = nextEmployeeId();
    const values = { employee_id: employeeId };
    for (const col of COLUMNS) values[col] = input[col] ?? null;

    db.prepare(
      `INSERT INTO employees (employee_id, ${COLUMNS.join(', ')})
       VALUES (:employee_id, ${COLUMNS.map((c) => `:${c}`).join(', ')})`,
    ).run(values);

    return findById(employeeId);
  });
}

export function update(employeeId, input) {
  const fields = COLUMNS.filter((col) => col in input);
  if (fields.length === 0) return findById(employeeId);

  const values = { employee_id: employeeId };
  for (const col of fields) values[col] = input[col] ?? null;

  db.prepare(
    `UPDATE employees
     SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = datetime('now')
     WHERE employee_id = :employee_id`,
  ).run(values);

  return findById(employeeId);
}

/** ลาออก: เก็บประวัติไว้ ไม่ลบแถว เพราะ employee_id ยังถูกอ้างอิงจากโมดูลอื่น */
export function resign(employeeId, resignDate) {
  db.prepare(
    `UPDATE employees
     SET status = 'resigned', resign_date = :resign_date, updated_at = datetime('now')
     WHERE employee_id = :employee_id`,
  ).run({ employee_id: employeeId, resign_date: resignDate ?? null });

  return findById(employeeId);
}

export function remove(employeeId) {
  const { changes } = db.prepare('DELETE FROM employees WHERE employee_id = ?').run(employeeId);
  return changes > 0;
}

export function summary() {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS count FROM employees GROUP BY status').all();
  const byPosition = db.prepare('SELECT position, COUNT(*) AS count FROM employees GROUP BY position').all();
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM employees').get();

  return { total, by_status: byStatus, by_position: byPosition };
}

export const certificates = {
  listFor(employeeId) {
    return db
      .prepare('SELECT * FROM employee_certificates WHERE employee_id = ? ORDER BY issued_date DESC')
      .all(employeeId);
  },

  add(employeeId, input) {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO employee_certificates (employee_id, name, issuer, issued_date, expiry_date)
         VALUES (:employee_id, :name, :issuer, :issued_date, :expiry_date)`,
      )
      .run({
        employee_id: employeeId,
        name: input.name,
        issuer: input.issuer ?? null,
        issued_date: input.issued_date ?? null,
        expiry_date: input.expiry_date ?? null,
      });

    return db
      .prepare('SELECT * FROM employee_certificates WHERE certificate_id = ?')
      .get(lastInsertRowid);
  },

  remove(employeeId, certificateId) {
    const { changes } = db
      .prepare('DELETE FROM employee_certificates WHERE certificate_id = ? AND employee_id = ?')
      .run(certificateId, employeeId);
    return changes > 0;
  },
};
