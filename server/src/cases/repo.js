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

  // พิกัดสถานที่ดูแล (geofence)
  'geo_lat',
  'geo_lng',
  'geofence_radius_m',

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

/**
 * เพิ่งผูกผู้ว่าจ้างให้ผู้ป่วย -> เติมผู้ว่าจ้างคนนี้ให้เคสของผู้ป่วยรายนั้น "ที่ยังไม่มีผู้ว่าจ้าง"
 * แตะเฉพาะเคสที่ customer_id ว่าง — เคสที่มีผู้จ่ายของตัวเองอยู่แล้วไม่ทับ (ผู้จ่ายอาจเป็นคนละคน)
 * คืนเคส (แบบเต็ม พร้อม join บริการ) ที่ถูกแก้ ให้ผู้เรียกเอาไป sync ใบแจ้งหนี้ต่อ
 */
export async function backfillCustomerForPatient(patientId, customerId) {
  const rows = await sql.all(
    `UPDATE cases SET customer_id = :customer_id, updated_at = ${NOW}
     WHERE patient_id = :patient_id AND customer_id IS NULL
     RETURNING case_id`,
    { patient_id: patientId, customer_id: customerId },
  );
  return Promise.all(rows.map((r) => findById(r.case_id)));
}

/**
 * เคสของพนักงานภาคสนาม = เป็นผู้รับผิดชอบหลัก หรือมีกะ (case_visits.assigned_to) ในเคสนั้น
 * ครอบทั้งสองแบบเพราะระบบกะให้คนที่ไม่ใช่หัวหน้าเคสไปทำกะได้ ก็ต้องเห็นเคสนั้นด้วย
 */
export function listForEmployee(employeeId) {
  return sql.all(
    `${SELECT_CASE}
     WHERE c.assigned_to = :id
        OR EXISTS (SELECT 1 FROM case_visits v WHERE v.case_id = c.case_id AND v.assigned_to = :id)
     ORDER BY c.case_id DESC`,
    { id: employeeId },
  );
}

/** พนักงานภาคสนามเข้าถึงเคสนี้ได้ไหม (เป็นหัวหน้าเคส หรือมีกะในเคส) — ใช้กันดูเคสคนอื่น */
export async function hasFieldAccess(employeeId, caseId) {
  const row = await sql.one(
    `SELECT 1 FROM cases c
     WHERE c.case_id = :cid
       AND (c.assigned_to = :eid
            OR EXISTS (SELECT 1 FROM case_visits v WHERE v.case_id = c.case_id AND v.assigned_to = :eid))`,
    { cid: caseId, eid: employeeId },
  );
  return Boolean(row);
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

// ---------- วันนัดให้บริการ (case_visits) ----------

/** กะทั้งหมดของเคสหนึ่งใบ พร้อมชื่อพนักงานที่นัดไว้ + สถานะเช็คอิน (state คำนวณตอนอ่าน) — เรียงตามวัน/เวลานัด */
export function listVisits(caseId) {
  return sql
    .all(
      `SELECT v.visit_id, v.case_id, v.visit_date, v.status, v.note,
              v.assigned_to, v.planned_start, v.planned_end,
              v.check_in_at, v.check_out_at, v.check_in_distance_m, v.location_flagged,
              e.first_name || ' ' || e.last_name AS assigned_name,
              e.nickname                          AS assigned_nickname
       FROM case_visits v
       LEFT JOIN employees e ON e.employee_id = v.assigned_to
       WHERE v.case_id = :id
       ORDER BY v.visit_date, v.planned_start NULLS FIRST, v.visit_id`,
      { id: caseId },
    )
    .then((rows) => rows.map((v) => withVisitState(v)));
}

/**
 * จองกะ — วันเดียวมีได้หลายกะ/หลายคน จึงไม่กันวันซ้ำแล้ว (unique index (case_id, visit_date) ถูกปลดในเฟส 2)
 * ไม่ระบุคนไป = ใช้ผู้รับผิดชอบหลักของเคส (COALESCE กับ cases.assigned_to) — ให้หน้าเดิมที่ส่งแค่ visit_date ยังทำงาน
 */
export async function addVisit(caseId, { visit_date, assigned_to, planned_start, planned_end, note }) {
  await sql.run(
    `INSERT INTO case_visits (case_id, visit_date, assigned_to, planned_start, planned_end, note)
     VALUES (:case_id, :visit_date,
             COALESCE(:assigned_to, (SELECT assigned_to FROM cases WHERE case_id = :case_id)),
             :planned_start, :planned_end, :note)`,
    {
      case_id: caseId,
      visit_date,
      assigned_to: assigned_to ?? null,
      planned_start: planned_start ?? null,
      planned_end: planned_end ?? null,
      note: note ?? null,
    },
  );
  return listVisits(caseId);
}

export async function updateVisit(caseId, visitId, input) {
  const fields = ['visit_date', 'assigned_to', 'planned_start', 'planned_end', 'status', 'note'].filter(
    (c) => c in input,
  );
  if (fields.length === 0) return listVisits(caseId);

  const values = { case_id: caseId, visit_id: visitId };
  for (const c of fields) values[c] = input[c] ?? null;

  await sql.run(
    `UPDATE case_visits
     SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
     WHERE visit_id = :visit_id AND case_id = :case_id`,
    values,
  );
  return listVisits(caseId);
}

export async function removeVisit(caseId, visitId) {
  await sql.run('DELETE FROM case_visits WHERE visit_id = :visit_id AND case_id = :case_id', {
    visit_id: visitId,
    case_id: caseId,
  });
  return listVisits(caseId);
}

// ---------- เช็คอิน/เอาท์ของพนักงานภาคสนาม (case_visits ระดับกะ) ----------
// SELECT นี้ไม่ดึง fee/ราคาใดๆ เลย — ฝั่ง field ไม่เห็นข้อมูลการเงิน (ไม่ต้อง strip ทีหลัง)
const MY_VISIT = `
  SELECT v.visit_id, v.case_id, v.visit_date, v.status AS visit_status, v.note,
         v.assigned_to, v.planned_start, v.planned_end,
         v.check_in_at, v.check_out_at, v.check_in_lat, v.check_in_lng,
         v.check_in_distance_m, v.location_flagged,
         (v.check_in_photo_data IS NOT NULL) AS has_photo,
         c.status AS case_status, c.case_type, c.client_name, c.address, c.client_phone,
         c.service_kind, c.start_date, c.end_date,
         c.geo_lat AS case_geo_lat, c.geo_lng AS case_geo_lng, c.geofence_radius_m AS case_radius,
         c.medical_history, c.current_symptoms, c.medical_devices, c.care_goal,
         c.patient_gender, c.patient_age,
         f.name  AS format_name, g.name AS grade_name,
         pp.name AS physio_package_name, pp.sessions AS physio_sessions
  FROM case_visits v
  JOIN cases c ON c.case_id = v.case_id
  LEFT JOIN pkg_service_formats f ON f.format_id = c.pkg_format_id
  LEFT JOIN pkg_grades g          ON g.grade_id  = c.pkg_grade_id
  LEFT JOIN physio_packages pp    ON pp.physio_package_id = c.physio_package_id
`;

// วันปัจจุบันโซนไทย 'YYYY-MM-DD' — พนักงานอยู่ไทย ปฏิทิน/ขาดงานต้องอิงวันไทย ไม่ใช่ UTC
const isoDateTH = (d) => new Date(d.getTime() + 7 * 3.6e6).toISOString().slice(0, 10);

/**
 * สถานะกะที่คำนวณตอนอ่าน (ไม่เก็บใน DB) — จาก timestamps เทียบกับตอนนี้
 * cancelled · done (เช็คเอาท์แล้ว) · working (เช็คอินแล้วยังไม่ออก) · stale (ค้างเช็คเอาท์เกิน 16 ชม.)
 * · missed (เลยวันแล้วไม่เช็คอิน) · scheduled (รอเช็คอิน)
 * worked_minutes = นาทีที่ทำงานจริง (มีค่าเมื่อเช็คเอาท์แล้วเท่านั้น)
 */
export function withVisitState(v, now = new Date()) {
  const vStatus = v.visit_status ?? v.status; // MY_VISIT ใช้ alias visit_status, listVisits ใช้ status
  let state;
  if (vStatus === 'cancelled') state = 'cancelled';
  else if (v.check_out_at) state = 'done';
  else if (v.check_in_at) state = (now - new Date(v.check_in_at)) / 3.6e6 > 16 ? 'stale' : 'working';
  else state = v.visit_date < isoDateTH(now) ? 'missed' : 'scheduled';

  const worked =
    v.check_in_at && v.check_out_at
      ? Math.round((new Date(v.check_out_at) - new Date(v.check_in_at)) / 60000)
      : null;

  return { ...v, state, worked_minutes: worked };
}

/** กะเดี่ยว + ข้อมูลเคส/พิกัดที่จำเป็นต่อการเช็คอิน (ownership เช็คที่ route จาก assigned_to) */
export const findVisit = (visitId) =>
  sql.one(`${MY_VISIT} WHERE v.visit_id = :id`, { id: visitId }).then((v) => (v ? withVisitState(v) : null));

/** กะของพนักงานคนหนึ่งในวันที่กำหนด — ตารางงาน "วันนี้" */
export const visitsForEmployeeOn = (employeeId, date) =>
  sql
    .all(
      `${MY_VISIT} WHERE v.assigned_to = :emp AND v.visit_date = :date
       ORDER BY v.planned_start NULLS FIRST, v.visit_id`,
      { emp: employeeId, date },
    )
    .then((rows) => rows.map((v) => withVisitState(v)));

/** กะของพนักงานทั้งเดือน (ym = 'YYYY-MM') — ประวัติการมาทำงาน */
export const attendanceForEmployee = (employeeId, ym) =>
  sql
    .all(
      `${MY_VISIT} WHERE v.assigned_to = :emp AND v.visit_date LIKE :ym
       ORDER BY v.visit_date DESC, v.planned_start NULLS FIRST`,
      { emp: employeeId, ym: `${ym}%` },
    )
    .then((rows) => rows.map((v) => withVisitState(v)));

/** ไบนารีรูปเซลฟี่ของกะ — ดึงเฉพาะตอนหน้าเว็บขอรูปจริง */
export const findVisitPhoto = (visitId) =>
  sql.one(
    `SELECT check_in_photo_data AS data, check_in_photo_mime AS mime
     FROM case_visits WHERE visit_id = :id AND check_in_photo_data IS NOT NULL`,
    { id: visitId },
  );

/**
 * เช็คอินกะ + ดันเคสเป็น in_progress ถ้าเป็นการเริ่มกะแรก — คืน null ถ้าเช็คอินไปแล้ว (กันซ้ำ/แข่งกด)
 * เวลาใช้ now() ของ DB เท่านั้น ไม่รับจาก client (กันปลอมเวลา)
 */
export function checkInVisit(visitId, { employee_id, lat, lng, accuracy, distance, flagged, photo }) {
  return transaction(async (tx) => {
    const updated = await tx.run(
      `UPDATE case_visits
       SET check_in_at = now(), checked_in_by = :emp,
           check_in_lat = :lat, check_in_lng = :lng, check_in_accuracy_m = :acc,
           check_in_distance_m = :dist, location_flagged = :flag,
           check_in_photo_data = :pdata, check_in_photo_mime = :pmime, check_in_photo_size = :psize,
           updated_at = ${NOW}
       WHERE visit_id = :id AND check_in_at IS NULL`,
      {
        id: visitId, emp: employee_id, lat, lng, acc: accuracy,
        dist: distance, flag: flagged,
        pdata: photo?.data ?? null, pmime: photo?.mime ?? null, psize: photo?.size ?? null,
      },
    );
    if (updated === 0) return false; // เช็คอินไปแล้ว

    // เช็คอินขณะเคสยัง 'assigned' = เริ่มให้บริการ (mirror start(): เติม start_date ถ้ายังว่าง)
    // เงื่อนไข status='assigned' รับประกันว่า cases.assigned_to ไม่เป็น null อยู่แล้ว (ตาม CHECK) จึงเข้า in_progress ได้ไม่ชน constraint
    await tx.run(
      `UPDATE cases
       SET status = 'in_progress',
           start_date = COALESCE(start_date, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD')),
           updated_at = ${NOW}
       WHERE case_id = (SELECT case_id FROM case_visits WHERE visit_id = :id) AND status = 'assigned'`,
      { id: visitId },
    );
    return true;
  }).then((ok) => (ok ? findVisit(visitId) : null));
}

/** เช็คเอาท์กะ — route เช็คเงื่อนไขก่อนแล้ว, WHERE กันแข่งกดอีกชั้น; คืน null ถ้าไม่เข้าเงื่อนไข */
export const checkOutVisit = (visitId, { lat, lng }) =>
  sql
    .run(
      `UPDATE case_visits
       SET check_out_at = now(), check_out_lat = :lat, check_out_lng = :lng,
           status = 'done', updated_at = ${NOW}
       WHERE visit_id = :id AND check_in_at IS NOT NULL AND check_out_at IS NULL`,
      { id: visitId, lat, lng },
    )
    .then((n) => (n > 0 ? findVisit(visitId) : null));

// ---------- การมาทำงาน (ฝั่ง admin) ----------
// SELECT สำหรับ admin — เห็นชื่อพนักงานที่เช็คอินจริง + ข้อมูลเคส (ตรงนี้เห็น fee ได้ แต่เราไม่ดึงมาเพราะไม่ใช้)
const ADMIN_VISIT = `
  SELECT v.visit_id, v.case_id, v.visit_date, v.status AS visit_status,
         v.assigned_to, v.checked_in_by, v.planned_start, v.planned_end,
         v.check_in_at, v.check_out_at, v.check_in_lat, v.check_in_lng,
         v.check_in_distance_m, v.check_in_accuracy_m, v.location_flagged, v.adjusted_by,
         (v.check_in_photo_data IS NOT NULL) AS has_photo,
         COALESCE(ci.first_name || ' ' || ci.last_name, ae.first_name || ' ' || ae.last_name) AS employee_name,
         c.client_name, c.case_type, c.geo_lat AS case_geo_lat, c.geo_lng AS case_geo_lng
  FROM case_visits v
  LEFT JOIN employees ci ON ci.employee_id = v.checked_in_by
  LEFT JOIN employees ae ON ae.employee_id = v.assigned_to
  JOIN cases c ON c.case_id = v.case_id
`;

/** รายการเช็คอินทั้งหมด (admin) — กรองตามเดือน (โซนไทย) และ/หรือพนักงาน */
export function attendanceList({ month, employee_id }) {
  const where = ['v.check_in_at IS NOT NULL'];
  const params = {};
  if (month) {
    where.push(`to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') = :month`);
    params.month = month;
  }
  if (employee_id) {
    where.push('v.checked_in_by = :emp');
    params.emp = employee_id;
  }
  return sql
    .all(`${ADMIN_VISIT} WHERE ${where.join(' AND ')} ORDER BY v.check_in_at DESC`, params)
    .then((rows) => rows.map((v) => withVisitState(v)));
}

/**
 * รายการที่ต้องตรวจ (admin) — ขาดงาน (เลยวันไม่เช็คอิน) · ค้างเช็คเอาท์ (stale) · นอกพื้นที่ (flagged)
 * ไม่รวมกะที่กำลังทำงานปกติ (working) เว้นแต่ถูก flag
 */
export function attendanceExceptions() {
  const today = isoDateTH(new Date());
  return sql
    .all(
      `${ADMIN_VISIT}
       WHERE v.status <> 'cancelled'
         AND (
           v.location_flagged = TRUE
           OR (v.check_in_at IS NOT NULL AND v.check_out_at IS NULL)
           OR (v.check_in_at IS NULL AND v.visit_date < :today)
         )
       ORDER BY v.visit_date DESC, v.check_in_at DESC`,
      { today },
    )
    .then((rows) =>
      rows
        .map((v) => withVisitState(v))
        .filter((v) => v.state === 'missed' || v.state === 'stale' || v.location_flagged),
    );
}

/**
 * admin แก้กะที่เช็คอินผิดพลาด — ปิดกะค้าง / แก้เวลา / เคลียร์ธง / เปลี่ยนสถานะ
 * เก็บ adjusted_by ไว้เสมอ ให้รู้ว่าใครแก้ (ตรวจสอบย้อนหลังได้)
 */
export async function adjustVisit(caseId, visitId, input, adminId) {
  const sets = ['adjusted_by = :admin', `updated_at = ${NOW}`];
  const values = { case_id: caseId, visit_id: visitId, admin: adminId };

  for (const col of ['check_in_at', 'check_out_at', 'status', 'location_flagged']) {
    if (col in input) {
      sets.push(`${col} = :${col}`);
      values[col] = input[col] ?? null;
    }
  }

  await sql.run(
    `UPDATE case_visits SET ${sets.join(', ')} WHERE visit_id = :visit_id AND case_id = :case_id`,
    values,
  );
  return findVisit(visitId);
}

/**
 * สรุปการมาทำงานรายเดือนต่อพนักงาน (payroll) — นับกะที่เช็คเอาท์แล้ว + รวมนาที
 * est_pay = ผลรวม staff_pay ของเรทที่เคสอ้างอิง (คิดต่อกะ) — เป็น "ประมาณการ" ตรงกับเรทรายวัน
 *   ส่วนเรทรายเดือน staff_pay เป็นต่อเดือน (ไม่ใช่ต่อกะ) จึงต้องปรับมือ — priced_shifts บอกว่าครอบกี่กะ
 * ชั่วโมงจริง (minutes) เป็นตัวเลขที่เชื่อได้เสมอ ต่างจาก est_pay ที่ขึ้นกับกติกาค่าจ้างของธุรกิจ
 */
export function attendanceReport(month) {
  return sql
    .all(
      `SELECT v.checked_in_by AS employee_id,
              e.first_name || ' ' || e.last_name AS employee_name,
              COUNT(*) FILTER (WHERE v.check_out_at IS NOT NULL) AS shifts,
              COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at)) / 60)
                       FILTER (WHERE v.check_out_at IS NOT NULL)), 0) AS minutes,
              COALESCE(SUM(r.staff_pay) FILTER (WHERE v.check_out_at IS NOT NULL AND r.staff_pay IS NOT NULL), 0) AS est_pay,
              COUNT(*) FILTER (WHERE v.check_out_at IS NOT NULL AND r.staff_pay IS NOT NULL) AS priced_shifts
       FROM case_visits v
       JOIN employees e ON e.employee_id = v.checked_in_by
       JOIN cases c     ON c.case_id     = v.case_id
       LEFT JOIN pkg_rates r ON r.format_id = c.pkg_format_id
            AND r.grade_id IS NOT DISTINCT FROM c.pkg_grade_id
            AND r.staff_tier = c.pkg_staff_tier
       WHERE v.check_in_at IS NOT NULL
         AND to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') = :month
       GROUP BY v.checked_in_by, e.first_name, e.last_name
       ORDER BY employee_name`,
      { month },
    )
    .then((rows) =>
      rows.map((r) => ({
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        shifts: Number(r.shifts),
        minutes: Number(r.minutes),
        est_pay: Number(r.est_pay),
        priced_shifts: Number(r.priced_shifts),
      })),
    );
}

/**
 * ตารางงานรายเดือน — ทุกเคส (ทั้ง Homecare และกายภาพบำบัด) ลงตาม"วันนัดจริง" ที่ลงไว้ในหน้าจัดการเคส
 *
 * เดิม Homecare ลากยาวทั้งช่วง start_date..end_date แต่เปลี่ยนมาใช้วันนัดเหมือนกายภาพ:
 * พนักงานไปเป็นวันๆ ตามที่นัด ไม่ใช่ทุกวันในช่วงสัญญา ปฏิทินจึงตรงกับงานจริงมากกว่า
 * ผลที่ตามมา: เคสที่ยังไม่ได้ลงวันนัดจะไม่ขึ้นบนปฏิทิน (ต้องลงวันนัดในหน้าจัดการเคสก่อน)
 *
 * ตัดวันที่ยกเลิกออก เพราะวันนั้นไม่ได้ไปทำงานจริง
 * วันที่เก็บเป็น TEXT 'YYYY-MM-DD' — เทียบแบบข้อความให้ลำดับตรงกับเวลาอยู่แล้ว ไม่ต้อง cast
 */
export async function calendar({ year, month, employee_id }) {
  const monthStart = `${year}-${month}-01`;
  // ต้นเดือนถัดไป — ใช้ '<' แทนการหาวันสุดท้ายของเดือน (ไม่ต้องสนใจ 28/29/30/31)
  const next = new Date(Number(year), Number(month), 1);
  const nextMonthStart = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`;
  const params = { month_start: monthStart, next_month: nextMonthStart };

  // กรองเฉพาะงานของพนักงานคนเดียว — ไม่ส่งมาคือดูตารางรวมทุกคน
  // ใส่พารามิเตอร์เฉพาะตอนใช้จริง เพราะตัวแปลง :name จะไล่หาชื่อจาก SQL ที่มีอยู่จริงเท่านั้น
  const staffFilter = employee_id ? 'AND c.assigned_to = :employee_id' : '';
  if (employee_id) params.employee_id = employee_id;

  const visits = await sql.all(
    `SELECT c.case_id, c.title, c.case_type, c.status, c.service_kind,
            c.client_name, c.assigned_to,
            e.first_name || ' ' || e.last_name AS assigned_name,
            e.position                         AS assigned_position,
            cu.name                            AS customer_name,
            v.visit_id, v.visit_date, v.status AS visit_status,
            v.check_in_at, v.check_out_at
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees e  ON e.employee_id  = c.assigned_to
     LEFT JOIN customers cu ON cu.customer_id = c.customer_id
     WHERE v.status <> 'cancelled'
       AND v.visit_date >= :month_start
       AND v.visit_date <  :next_month
       ${staffFilter}
     ORDER BY v.visit_date, v.visit_id`,
    params,
  );

  // แนบ state (รอเช็คอิน/กำลังทำงาน/เสร็จ/ขาดงาน) ให้ปฏิทินระบายสีตามการเช็คอินได้
  return visits.map((v) => ({ ...withVisitState(v), kind: 'visit' }));
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
