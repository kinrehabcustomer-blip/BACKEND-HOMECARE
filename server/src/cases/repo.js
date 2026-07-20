import { sql, nextCaseId, transaction } from '../db/index.js';

const COLUMNS = [
  'title',
  'case_type',
  'customer_id', // ผู้ว่าจ้าง (ข้อมูลผู้ป่วยด้านล่างถูกคัดลอกมาไว้ในเคส)
  'patient_id',  // ผู้รับการดูแล (แฟ้มถาวรใน patients) — ต่างจาก customer_id ที่เป็นผู้จ่ายเงิน

  // บริการที่เคสนี้เลือกใช้ (ค่าจ้าง fee คัดลอกจากราคาของสิ่งที่เลือก ไม่ใช่อ่านสดจากตารางราคา)
  'service_kind',   // 'homecare' = ใช้ตารางเรทด้านล่าง | 'physio' = ใช้แพ็คเกจกายภาพบำบัด
  'pkg_grade_id',   // [homecare] เกรดการดูแล (ว่างได้ถ้ารูปแบบไม่อิงเกรด เช่น รายวัน/สัปดาห์)
  'pkg_format_id',  // [homecare] รูปแบบบริการ
  'pkg_staff_tier', // [homecare] ระดับพนักงาน CG/NA/PN
  'physio_package_id', // [physio] แพ็คเกจกายภาพบำบัดที่ซื้อ

  // รายละเอียดผู้ป่วย
  'client_name',
  'patient_gender',
  'patient_age',
  'weight_kg',
  'height_cm',
  'medical_history',
  'current_symptoms',
  'medical_devices',
  'care_goal',

  // รายละเอียดการใช้บริการ
  'service_start_preference',
  'address',
  'client_phone',
  'nurse_call_preference',

  'start_date',
  'end_date',
  'fee',
  'note',
];

const NOW = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

// ดึงชื่อพนักงานที่รับเคสและชื่อลูกค้ามาด้วยเลย หน้าเว็บจะได้ไม่ต้องยิง API ซ้ำทีละแถว
const SELECT_CASE = `
  SELECT c.*,
         e.first_name || ' ' || e.last_name AS assigned_name,
         e.position                         AS assigned_position,
         e.phone                            AS assigned_phone,
         cu.name                            AS customer_name,
         g.name                             AS grade_name,
         f.name                             AS format_name,
         f.graded                           AS format_graded,
         pp.name                            AS physio_package_name,
         pp.sessions                        AS physio_sessions,
         pp.duration_months                 AS physio_duration_months
  FROM cases c
  LEFT JOIN employees e           ON e.employee_id  = c.assigned_to
  LEFT JOIN customers cu          ON cu.customer_id = c.customer_id
  LEFT JOIN pkg_grades g          ON g.grade_id     = c.pkg_grade_id
  LEFT JOIN pkg_service_formats f ON f.format_id    = c.pkg_format_id
  LEFT JOIN physio_packages pp    ON pp.physio_package_id = c.physio_package_id
`;

/**
 * ช่วงเวลาของเคส = เวลาที่เปิดเคส (created_at) — เกณฑ์เดียวที่ทำให้เคสหนึ่งใบอยู่ในเดือนเดียวเสมอ
 * created_at เก็บเป็น TEXT 'YYYY-MM-DD HH:MM:SS' จึงเทียบด้วย prefix ได้ตรงๆ
 * เลือกเดือนโดยไม่เลือกปีไม่มีความหมาย (เดือนพฤษภาคมของปีไหน?) จึงต้องมีปีก่อนเสมอ
 */
function periodFilter({ year, month } = {}, where, params) {
  if (!year) return;
  where.push('c.created_at LIKE :period');
  params.period = month ? `${year}-${month}%` : `${year}-%`;
}

export async function list({ q, status, case_type, assigned_to, year, month, page, per_page, sort, order }) {
  const where = [];
  const params = {};

  periodFilter({ year, month }, where, params);

  if (q) {
    where.push(`(
      c.case_id ILIKE :q OR c.title ILIKE :q OR c.client_name ILIKE :q OR c.client_phone ILIKE :q
    )`);
    params.q = `%${q}%`;
  }
  if (status) {
    where.push('c.status = :status');
    params.status = status;
  }
  if (case_type) {
    where.push('c.case_type = :case_type');
    params.case_type = case_type;
  }
  if (assigned_to) {
    where.push('c.assigned_to = :assigned_to');
    params.assigned_to = assigned_to;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM cases c ${clause}`, params);

  const rows = await sql.all(
    `${SELECT_CASE} ${clause}
     ORDER BY c.${sort} ${order.toUpperCase()}
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return {
    data: rows,
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

export function findById(caseId) {
  return sql.one(`${SELECT_CASE} WHERE c.case_id = :id`, { id: caseId });
}

/** เคสทั้งหมดของพนักงานคนหนึ่ง — เรียกจากหน้าพนักงาน (ผูกด้วย employee_id) */
export function listForEmployee(employeeId) {
  return sql.all(
    `${SELECT_CASE} WHERE c.assigned_to = :id ORDER BY c.case_id DESC`,
    { id: employeeId },
  );
}

/**
 * เคสหนึ่งใบใช้ได้สายเดียว — เลือกสายไหนก็ล้างของอีกสายทิ้ง
 * ล้างให้แทนการปฏิเสธ เพราะการสลับสายคือการกระทำปกติของผู้ใช้ ไม่ใช่ความผิดพลาด
 * (ถ้าไม่ล้าง เคสที่เคยเป็น Homecare แล้วเปลี่ยนเป็นกายภาพ จะค้างเรทเก่าไว้แล้วโชว์บริการซ้อนกันสองอัน)
 * ไม่ส่ง service_kind มาเลย = ของเก่าก่อนมีสองสาย ปล่อยผ่านตามเดิม
 */
function clearUnusedKind(input) {
  if (!('service_kind' in input)) return input;

  const HOMECARE = { pkg_grade_id: null, pkg_format_id: null, pkg_staff_tier: null };
  if (input.service_kind === 'physio') return { ...input, ...HOMECARE };
  if (input.service_kind === 'homecare') return { ...input, physio_package_id: null };
  return { ...input, ...HOMECARE, physio_package_id: null }; // ไม่ระบุสาย = ล้างทั้งคู่
}

export function create(rawInput) {
  const input = clearUnusedKind(rawInput);
  return transaction(async (tx) => {
    const caseId = await nextCaseId(tx);
    const values = { case_id: caseId };
    for (const col of COLUMNS) values[col] = input[col] ?? null;

    // ไม่มีช่องกรอกชื่อเคสแล้ว — ปกติหน้าเว็บส่งชื่อที่ประกอบจากแพ็คเกจ+ผู้ป่วยมาให้
    // ถ้าเรียก API ตรงๆ โดยไม่ส่ง title มา ใช้ชื่อผู้ป่วยแทน เพื่อไม่ให้ชน NOT NULL
    if (!values.title) values.title = values.client_name;

    // จับคู่พนักงานมาตั้งแต่ต้นก็ได้ — สถานะต้องตรงกับความจริงเสมอ
    values.assigned_to = input.assigned_to || null;
    values.status = values.assigned_to ? 'assigned' : 'unassigned';

    // ตัดสินใจใน JS ไม่ใช้ CASE WHEN ใน SQL — Postgres เดาชนิดข้อมูลของพารามิเตอร์ที่อยู่ใน CASE ไม่ได้
    const assignedAt = values.assigned_to ? NOW : 'NULL';

    await tx.one(
      `INSERT INTO cases (case_id, status, assigned_to, assigned_at, ${COLUMNS.join(', ')})
       VALUES (:case_id, :status, :assigned_to, ${assignedAt},
               ${COLUMNS.map((c) => `:${c}`).join(', ')})
       RETURNING case_id`,
      values,
    );

    return caseId;
  }).then(findById);
}

export async function update(caseId, rawInput) {
  // สลับสายบริการตอนแก้เคส ต้องล้างของสายเดิมด้วย ไม่งั้นค้างเป็นเคสที่มีทั้งเรท Homecare และแพ็คเกจกายภาพบำบัด
  const input = clearUnusedKind(rawInput);
  const fields = COLUMNS.filter((col) => col in input);
  if (fields.length === 0) return findById(caseId);

  const values = { case_id: caseId };
  for (const col of fields) values[col] = input[col] ?? null;

  await sql.run(
    `UPDATE cases
     SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE case_id = :case_id`,
    values,
  );

  return findById(caseId);
}

/**
 * จับคู่พนักงาน — เคสที่ปิด/ยกเลิกแล้วต้องเปิดใหม่ก่อนถึงจะจับคู่ได้ (เช็คที่ชั้น route)
 * ถ้าเคสกำลังให้บริการอยู่แล้ว (in_progress) การเปลี่ยนพนักงานไม่ควรดึงสถานะถอยกลับไป 'assigned'
 */
export async function assign(caseId, employeeId) {
  await sql.run(
    `UPDATE cases
     SET assigned_to = :employee_id,
         status = CASE WHEN status = 'in_progress' THEN 'in_progress' ELSE 'assigned' END,
         assigned_at = ${NOW}, updated_at = ${NOW}
     WHERE case_id = :case_id`,
    { case_id: caseId, employee_id: employeeId },
  );

  return findById(caseId);
}

/**
 * เริ่มให้บริการ — เคสต้องอยู่สถานะ 'assigned' (มีพนักงานแล้ว) เท่านั้น (เช็คที่ชั้น route)
 * บันทึกเวลาเริ่มจริง และเติม start_date เป็นวันนี้ถ้ายังไม่เคยกรอกไว้
 */
export async function start(caseId) {
  await sql.run(
    `UPDATE cases
     SET status = 'in_progress',
         started_at = ${NOW},
         start_date = COALESCE(start_date, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD')),
         updated_at = ${NOW}
     WHERE case_id = :case_id`,
    { case_id: caseId },
  );

  return findById(caseId);
}

/** ยกเลิกเคส — เก็บพนักงานที่เคยรับและเหตุผลไว้เป็นประวัติ ไม่ล้างทิ้ง */
export async function cancel(caseId, reason) {
  await sql.run(
    `UPDATE cases
     SET status = 'cancelled',
         cancelled_at = ${NOW},
         cancel_reason = :reason,
         updated_at = ${NOW}
     WHERE case_id = :case_id`,
    { case_id: caseId, reason: reason ?? null },
  );

  return findById(caseId);
}

export async function unassign(caseId) {
  await sql.run(
    `UPDATE cases
     SET assigned_to = NULL, status = 'unassigned', assigned_at = NULL, updated_at = ${NOW}
     WHERE case_id = :case_id`,
    { case_id: caseId },
  );

  return findById(caseId);
}

/** ปิดเคส — เก็บพนักงานที่เคยรับไว้เป็นประวัติ ไม่ล้างทิ้ง */
export async function close(caseId, endDate) {
  await sql.run(
    `UPDATE cases
     SET status = 'closed',
         closed_at = ${NOW},
         end_date = COALESCE(:end_date, end_date),
         updated_at = ${NOW}
     WHERE case_id = :case_id`,
    { case_id: caseId, end_date: endDate ?? null },
  );

  return findById(caseId);
}

/**
 * เปิดเคสที่ปิด/ยกเลิกไปแล้วกลับมา — สถานะกลับไปตามว่ามีพนักงานอยู่หรือไม่
 * กลับไปได้แค่ 'assigned'/'unassigned' เท่านั้น (ต้องกดเริ่มให้บริการใหม่) และล้างร่องรอยการปิด/ยกเลิกทิ้ง
 */
export async function reopen(caseId) {
  await sql.run(
    `UPDATE cases
     SET status = CASE WHEN assigned_to IS NULL THEN 'unassigned' ELSE 'assigned' END,
         closed_at = NULL,
         cancelled_at = NULL,
         cancel_reason = NULL,
         updated_at = ${NOW}
     WHERE case_id = :case_id`,
    { case_id: caseId },
  );

  return findById(caseId);
}

export async function remove(caseId) {
  const changes = await sql.run('DELETE FROM cases WHERE case_id = :id', { id: caseId });
  return changes > 0;
}

/** สรุปเคส — ไม่ส่งปีมาคือรวมทุกปี, ส่งปีอย่างเดียวคือทั้งปีนั้น, ส่งปี+เดือนคือเดือนนั้น */
export async function summary(period) {
  const where = [];
  const params = {};
  periodFilter(period, where, params);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [byStatus, byType, totals] = await Promise.all([
    sql.all(`SELECT status, COUNT(*) AS count FROM cases c ${clause} GROUP BY status`, params),
    sql.all(`SELECT case_type, COUNT(*) AS count FROM cases c ${clause} GROUP BY case_type`, params),
    sql.one(`SELECT COUNT(*) AS total FROM cases c ${clause}`, params),
  ]);

  const toNumber = (rows) => rows.map((row) => ({ ...row, count: Number(row.count) }));

  return {
    year: period?.year ?? null,
    month: period?.month ?? null,
    total: Number(totals.total),
    by_status: toNumber(byStatus),
    by_type: toNumber(byType),
  };
}

/**
 * ปี/เดือนที่มีเคสอยู่จริง (ใหม่ไปเก่า) — ให้ dropdown แสดงเฉพาะช่วงที่มีข้อมูล ไม่ต้องไล่เดือนเปล่า
 * คืนเป็น [{ year, count, months: [{ month, count }] }]
 */
export async function periods() {
  const rows = await sql.all(
    `SELECT substr(created_at, 1, 4) AS year,
            substr(created_at, 6, 2) AS month,
            COUNT(*)                 AS count
     FROM cases
     GROUP BY 1, 2
     ORDER BY 1 DESC, 2 DESC`,
  );

  const years = new Map();
  for (const r of rows) {
    if (!years.has(r.year)) years.set(r.year, { year: r.year, count: 0, months: [] });
    const y = years.get(r.year);
    y.count += Number(r.count);
    y.months.push({ month: r.month, count: Number(r.count) });
  }

  return [...years.values()];
}

/** พนักงานที่รับเคสได้ (ยังทำงานอยู่) พร้อมจำนวนเคสที่ถืออยู่ ไว้ให้ dropdown จับคู่ */
export function assignableEmployees() {
  return sql.all(
    `SELECT e.employee_id, e.first_name, e.last_name, e.nickname, e.position, e.status,
            COUNT(c.case_id) FILTER (WHERE c.status = 'assigned') AS active_cases
     FROM employees e
     LEFT JOIN cases c ON c.assigned_to = e.employee_id
     WHERE e.status IN ('active', 'probation')
     GROUP BY e.employee_id
     ORDER BY e.employee_id`,
  ).then((rows) => rows.map((r) => ({ ...r, active_cases: Number(r.active_cases) })));
}
