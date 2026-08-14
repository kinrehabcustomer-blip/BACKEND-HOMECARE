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
  'fee',       // ค่าบริการที่ลูกค้าจ่าย
  'staff_pay', // ค่าจ้างที่พนักงานได้ — คัดลอกจากแพ็คเกจ/เรทตอนเลือกบริการ (snapshot เหมือน fee)

  // พิกัดสถานที่ดูแล (geofence)
  'geo_lat',
  'geo_lng',
  'geofence_radius_m',

  'note',
];

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;

/**
 * ข้อมูลความปลอดภัยของผู้ป่วยที่ต้อง "อ่านสดจากแฟ้ม" ไม่ใช่ snapshot ของเคส
 *
 * เคสคัดลอกข้อมูลไว้ตอนเปิด ซึ่งถูกสำหรับราคา/ผู้จ่าย (ใบที่ปิดไปแล้วต้องไม่ขยับ)
 * แต่ผิดสำหรับ "แพ้ยา / โรคประจำตัว" — แก้แฟ้มผู้ป่วยแล้วคนที่ไปหน้างานยังเห็นของเก่า
 * แพ้ยาไม่เคยถูกคัดลอกลงเคสด้วยซ้ำ พนักงานภาคสนามจึงไม่เคยเห็นเลย
 *
 * medical_history_stale = แฟ้มผู้ป่วยกับ snapshot ในเคสไม่ตรงกันแล้ว → ขึ้นป้ายเตือนให้ไปดูของจริง
 * ต้องมี alias c (cases) และ pt (patients) ใน query ที่เอาไปใช้
 */
const PATIENT_LIVE = `
  pt.allergies       AS patient_allergies,
  pt.food_allergies  AS patient_food_allergies,
  pt.blood_type      AS patient_blood_type,
  pt.medical_history AS patient_medical_history,
  (c.patient_id IS NOT NULL AND pt.medical_history IS DISTINCT FROM c.medical_history) AS medical_history_stale
`;

// ดึงชื่อพนักงานที่รับเคสและชื่อลูกค้ามาด้วยเลย หน้าเว็บจะได้ไม่ต้องยิง API ซ้ำทีละแถว
//
// ราคาเต็มก่อนลดของทั้งสองสาย (physio_original_price / rate_customer_price) ดึงมาด้วย
// เพราะ fee ของเคสเป็น "ราคาสุทธิหลังลด" — ใบแจ้งหนี้ต้องรู้ราคาเต็มถึงจะแยกบรรทัดส่วนลดออกมาได้
// (ดู invoices/repo.js → priceParts) ส่วนตัวเลขที่ใช้จริงบนใบถูกคัดลอกไว้ในใบตั้งแต่ตอนออก จึงไม่ไหลตามทีหลัง
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
         pp.duration_months                 AS physio_duration_months,
         pp.original_price                  AS physio_original_price,
         pp.staff_pay                       AS physio_staff_pay,
         r.customer_price                   AS rate_customer_price,
         r.staff_pay                        AS rate_staff_pay,
         ${PATIENT_LIVE}
  FROM cases c
  LEFT JOIN employees e           ON e.employee_id  = c.assigned_to
  LEFT JOIN customers cu          ON cu.customer_id = c.customer_id
  LEFT JOIN patients pt           ON pt.patient_id  = c.patient_id
  LEFT JOIN pkg_grades g          ON g.grade_id     = c.pkg_grade_id
  LEFT JOIN pkg_service_formats f ON f.format_id    = c.pkg_format_id
  LEFT JOIN physio_packages pp    ON pp.physio_package_id = c.physio_package_id
  LEFT JOIN pkg_rates r           ON r.format_id  = c.pkg_format_id
       AND r.grade_id IS NOT DISTINCT FROM c.pkg_grade_id
       AND r.staff_tier = c.pkg_staff_tier
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

  // NULLS LAST — start_date/title ว่างได้ ถ้าไม่ใส่ การเรียงจากใหม่ไปเก่าจะเอาเคสที่ยังไม่ได้ระบุวันเริ่ม
  // ขึ้นก่อนเคสที่เริ่มจริง (ค่าปริยายของ Postgres คือ NULLS FIRST เมื่อเรียงจากมากไปน้อย)
  const rows = await sql.all(
    `${SELECT_CASE} ${clause}
     ORDER BY c.${sort} ${order.toUpperCase()} NULLS LAST
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

/**
 * ค่าจ้างพนักงานตามแพ็คเกจ/เรทที่เคสเลือกไว้ — คืน null ถ้าไม่ได้เลือกบริการ หรือบริการนั้นยังไม่ตั้งค่าจ้าง
 *
 * หาที่ server ไม่รอให้หน้าเว็บส่งมา เพราะเป็นตัวเลขที่กลายเป็นรายได้ของพนักงาน
 * ปล่อยให้ client เป็นคนคัดลอก แล้ววันหนึ่งหน้าเว็บเวอร์ชันเก่า/หน้าอื่นเรียก API ตรงๆ เคสจะไม่มีค่าจ้างเงียบๆ
 */
async function payFromService(input) {
  if (input.physio_package_id) {
    const p = await sql.one(
      'SELECT staff_pay FROM physio_packages WHERE physio_package_id = :id',
      { id: input.physio_package_id },
    );
    return p?.staff_pay ?? null;
  }

  if (input.pkg_format_id && input.pkg_staff_tier) {
    const r = await sql.one(
      `SELECT staff_pay FROM pkg_rates
       WHERE format_id = :format_id
         AND grade_id IS NOT DISTINCT FROM :grade_id
         AND staff_tier = :staff_tier`,
      {
        format_id: input.pkg_format_id,
        grade_id: input.pkg_grade_id ?? null,
        staff_tier: input.pkg_staff_tier,
      },
    );
    return r?.staff_pay ?? null;
  }

  return null;
}

// ---------- ประวัติการทำรายการ (case_events) ----------

/**
 * บันทึกหนึ่งบรรทัดลงประวัติของเคส — เรียกใน transaction เดียวกับการเปลี่ยนแปลงเสมอ
 * ไม่งั้นจะเกิดเคสที่เปลี่ยนสถานะสำเร็จแต่ประวัติหาย (หรือกลับกัน) แล้วไล่ย้อนไม่ได้
 *
 * actor = req.user จาก session — ไม่รับชื่อผู้ทำรายการจาก body เด็ดขาด
 * ไม่มี actor (เช่นงานที่ระบบทำเอง) ก็บันทึกได้ ช่องผู้ทำรายการจะว่าง
 */
function logEvent(tx, caseId, event, detail, actor) {
  return tx.run(
    `INSERT INTO case_events (case_id, event, detail, actor_id, actor_name)
     VALUES (:case_id, :event, :detail, :actor_id, :actor_name)`,
    {
      case_id: caseId,
      event,
      detail: detail ?? null,
      actor_id: actor?.employee_id ?? null,
      actor_name: actor?.name ?? null,
    },
  );
}

/** ประวัติของเคสหนึ่งใบ — ใหม่สุดอยู่บน (คนเปิดดูอยากรู้ว่าเพิ่งเกิดอะไร) */
export function listEvents(caseId) {
  return sql.all(
    `SELECT event_id, event, detail, actor_id, actor_name, created_at
     FROM case_events WHERE case_id = :id
     ORDER BY event_id DESC`,
    { id: caseId },
  );
}

/** ชื่อเต็มของพนักงาน (null ถ้าหาไม่เจอ/ถูกลบไปแล้ว) */
async function staffName(tx, employeeId) {
  if (!employeeId) return null;
  const e = await tx.one(
    'SELECT first_name, last_name FROM employees WHERE employee_id = :id',
    { id: employeeId },
  );
  return e ? `${e.first_name} ${e.last_name}` : null;
}

/** ชื่อเต็ม + รหัส ไว้เขียนลงข้อความประวัติให้อ่านรู้เรื่องโดยไม่ต้อง join ตอนอ่าน */
async function staffLabel(tx, employeeId) {
  if (!employeeId) return null;
  const name = await staffName(tx, employeeId);
  return name ? `${name} (${employeeId})` : employeeId;
}

export function create(rawInput, actor) {
  const input = clearUnusedKind(rawInput);
  return transaction(async (tx) => {
    const caseId = await nextCaseId(tx);
    const values = { case_id: caseId };
    for (const col of COLUMNS) values[col] = input[col] ?? null;

    // ไม่ได้ส่งค่าจ้างมา = ใช้ของแพ็คเกจ · ส่งตัวเลขมาเอง (รวม 0) = เคารพตามนั้น
    if (values.staff_pay == null) values.staff_pay = await payFromService(input);

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

    await logEvent(tx, caseId, 'created', `เปิดเคสให้ ${values.client_name}`, actor);
    if (values.assigned_to) {
      await logEvent(tx, caseId, 'assigned', `มอบหมายให้ ${await staffLabel(tx, values.assigned_to)}`, actor);
    }

    return caseId;
  }).then(findById);
}

/** ชื่อช่องที่เอาไปเขียนลงประวัติ — ช่องที่ไม่มีในนี้ใช้ชื่อคอลัมน์ไปตรงๆ (ดีกว่าไม่บอกเลย) */
const FIELD_LABELS = {
  title: 'ชื่อเคส', case_type: 'ประเภทเคส', customer_id: 'ผู้ว่าจ้าง', patient_id: 'ผู้รับการดูแล',
  service_kind: 'สายบริการ', pkg_grade_id: 'เกรด', pkg_format_id: 'รูปแบบบริการ',
  pkg_staff_tier: 'ระดับพนักงาน', physio_package_id: 'แพ็คเกจกายภาพบำบัด',
  client_name: 'ชื่อผู้ป่วย', patient_gender: 'เพศ', patient_age: 'อายุ',
  weight_kg: 'น้ำหนัก', height_cm: 'ส่วนสูง', medical_history: 'โรคประจำตัว',
  current_symptoms: 'อาการปัจจุบัน', medical_devices: 'อุปกรณ์การแพทย์', care_goal: 'เป้าหมายการดูแล',
  service_start_preference: 'ความสะดวกเริ่มบริการ', address: 'ที่อยู่', client_phone: 'เบอร์ติดต่อ',
  nurse_call_preference: 'ความต้องการผู้ดูแล', start_date: 'วันเริ่ม', end_date: 'วันสิ้นสุด',
  fee: 'ค่าบริการ', staff_pay: 'ค่าจ้างพนักงาน',
  geo_lat: 'พิกัด', geo_lng: 'พิกัด', geofence_radius_m: 'รัศมีเช็คอิน', note: 'หมายเหตุ',
};

/**
 * ช่องที่ค่าเปลี่ยนจริงเทียบกับของเดิม — PATCH จากหน้าเว็บส่งมาทั้งฟอร์ม
 * ถ้าไม่กรอง ประวัติจะบอกว่า "แก้ทุกช่อง" ทุกครั้งที่กดบันทึก จนอ่านไม่ได้ความ
 * เทียบเป็นข้อความเพราะ Postgres คืนตัวเลข/วันที่มาคนละชนิดกับที่หน้าเว็บส่งมา
 */
function changedLabels(current, values, fields) {
  const labels = [];
  for (const f of fields) {
    if (String(current?.[f] ?? '') === String(values[f] ?? '')) continue;
    const label = FIELD_LABELS[f] ?? f;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

export async function update(caseId, rawInput, actor) {
  // สลับสายบริการตอนแก้เคส ต้องล้างของสายเดิมด้วย ไม่งั้นค้างเป็นเคสที่มีทั้งเรท Homecare และแพ็คเกจกายภาพบำบัด
  const input = clearUnusedKind(rawInput);
  const fields = COLUMNS.filter((col) => col in input);
  if (fields.length === 0) return findById(caseId);

  const values = { case_id: caseId };
  for (const col of fields) values[col] = input[col] ?? null;

  const current = await findById(caseId);

  // ส่งช่องค่าจ้างมาเป็นค่าว่างทั้งที่เลือกบริการไว้ = ให้ใช้ของแพ็คเกจ (เหมือนตอนสร้างเคส)
  // ดูจากสิ่งที่เลือกไว้ "หลังแก้" เพราะ PATCH ส่งมาบางฟิลด์ได้ (เช่น แก้แค่หมายเหตุ)
  if (fields.includes('staff_pay') && values.staff_pay == null) {
    values.staff_pay = await payFromService({ ...current, ...input });
  }

  const changed = changedLabels(current, values, fields);

  await transaction(async (tx) => {
    await tx.run(
      `UPDATE cases
       SET ${fields.map((c) => `${c} = :${c}`).join(', ')}, updated_at = ${NOW}
       WHERE case_id = :case_id`,
      values,
    );

    // ไม่มีอะไรเปลี่ยน = ไม่บันทึก (กดบันทึกโดยไม่แก้อะไรไม่ควรมีบรรทัดขึ้นในประวัติ)
    if (changed.length > 0) {
      const shown = changed.slice(0, 8).join(', ');
      const more = changed.length > 8 ? ` และอีก ${changed.length - 8} ช่อง` : '';
      await logEvent(tx, caseId, 'edited', `แก้ ${shown}${more}`, actor);
    }
  });

  return findById(caseId);
}

/**
 * จับคู่พนักงาน — เคสที่ปิด/ยกเลิกแล้วต้องเปิดใหม่ก่อนถึงจะจับคู่ได้ (เช็คที่ชั้น route)
 * ถ้าเคสกำลังให้บริการอยู่แล้ว (in_progress) การเปลี่ยนพนักงานไม่ควรดึงสถานะถอยกลับไป 'assigned'
 */
export async function assign(caseId, employeeId, actor) {
  await transaction(async (tx) => {
    const previous = await tx.one('SELECT assigned_to FROM cases WHERE case_id = :id', { id: caseId });

    await tx.run(
      `UPDATE cases
       SET assigned_to = :employee_id,
           status = CASE WHEN status = 'in_progress' THEN 'in_progress' ELSE 'assigned' END,
           assigned_at = ${NOW}, updated_at = ${NOW}
       WHERE case_id = :case_id`,
      { case_id: caseId, employee_id: employeeId },
    );

    // สลับคนกลางคันคือจังหวะที่ต้องไล่ย้อนได้มากที่สุด — บันทึกทั้งคนเก่าและคนใหม่ในบรรทัดเดียว
    const to = await staffLabel(tx, employeeId);
    const from = previous?.assigned_to ? await staffLabel(tx, previous.assigned_to) : null;
    const detail = from && from !== to ? `เปลี่ยนผู้รับผิดชอบจาก ${from} เป็น ${to}` : `มอบหมายให้ ${to}`;
    await logEvent(tx, caseId, 'assigned', detail, actor);
  });

  return findById(caseId);
}

/**
 * เริ่มให้บริการ — เคสต้องอยู่สถานะ 'assigned' (มีพนักงานแล้ว) เท่านั้น (เช็คที่ชั้น route)
 * บันทึกเวลาเริ่มจริง และเติม start_date เป็นวันนี้ถ้ายังไม่เคยกรอกไว้
 */
export async function start(caseId, actor) {
  await transaction(async (tx) => {
    await tx.run(
      `UPDATE cases
       SET status = 'in_progress',
           started_at = ${NOW},
           start_date = COALESCE(start_date, to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')),
           updated_at = ${NOW}
       WHERE case_id = :case_id`,
      { case_id: caseId },
    );
    await logEvent(tx, caseId, 'started', 'เริ่มให้บริการ', actor);
  });

  return findById(caseId);
}

/** ยกเลิกเคส — เก็บพนักงานที่เคยรับและเหตุผลไว้เป็นประวัติ ไม่ล้างทิ้ง */
export async function cancel(caseId, reason, actor) {
  await transaction(async (tx) => {
    await tx.run(
      `UPDATE cases
       SET status = 'cancelled',
           cancelled_at = ${NOW},
           cancel_reason = :reason,
           updated_at = ${NOW}
       WHERE case_id = :case_id`,
      { case_id: caseId, reason: reason ?? null },
    );
    await logEvent(tx, caseId, 'cancelled', reason ? `ยกเลิกเคส — ${reason}` : 'ยกเลิกเคส', actor);
  });

  return findById(caseId);
}

export async function unassign(caseId, actor) {
  await transaction(async (tx) => {
    const previous = await tx.one('SELECT assigned_to FROM cases WHERE case_id = :id', { id: caseId });

    await tx.run(
      `UPDATE cases
       SET assigned_to = NULL, status = 'unassigned', assigned_at = NULL, updated_at = ${NOW}
       WHERE case_id = :case_id`,
      { case_id: caseId },
    );

    const from = previous?.assigned_to ? await staffLabel(tx, previous.assigned_to) : null;
    await logEvent(tx, caseId, 'unassigned', from ? `ถอด ${from} ออกจากเคส` : 'ยกเลิกการจับคู่', actor);
  });

  return findById(caseId);
}

/**
 * ปิดเคส — เก็บพนักงานที่เคยรับไว้เป็นประวัติ ไม่ล้างทิ้ง
 *
 * ตรึงค่าจ้างของกะที่ทำไปแล้วลงในแถวกะด้วย: ตอนเคสยังเปิด ยอดต่อกะเป็นการเกลี่ยสดจากยอดเคส
 * (เพิ่ม/ลบกะแล้วตัวหารขยับ ยอดเดือนที่ปิดงบไปแล้วก็ขยับตาม) ปิดเคส = ยืนยันยอด จึงเขียนตัวเลขค้างไว้
 * แตะเฉพาะกะที่เช็คอินแล้วและยังไม่เคยตั้งค่าจ้างเอง — กะที่ admin ระบุยอดไว้เองไม่ถูกทับ
 */
/**
 * ของค้างที่ต้องเตือนก่อนปิดเคส
 * upcoming = กะที่นัดไว้ตั้งแต่วันนี้เป็นต้นไปแต่ยังไม่มีใครไป (ปิดเคสแล้วกะพวกนี้จะถูกยกเลิก)
 * open_shifts = กะที่เช็คอินแล้วแต่ยังไม่เช็คเอาท์ (ชั่วโมงและค่าจ้างของกะนั้นจะหายไปจากรายงาน)
 */
export async function pendingShifts(caseId) {
  const row = await sql.one(
    `SELECT COUNT(*) FILTER (WHERE check_in_at IS NULL AND visit_date >= :today) AS upcoming,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL AND check_out_at IS NULL) AS open_shifts
     FROM case_visits
     WHERE case_id = :id AND status = 'scheduled'`,
    { id: caseId, today: isoDateTH(new Date()) },
  );
  return { upcoming: Number(row.upcoming), open_shifts: Number(row.open_shifts) };
}

export async function close(caseId, endDate, actor) {
  await transaction(async (tx) => {
    /* ตรึงค่าจ้าง "ก่อน" ยกเลิกกะที่ยังไม่ถึงวัน — ลำดับนี้สำคัญมาก
       BOOKED_VISITS นับเฉพาะกะที่ยังไม่ยกเลิก และอยู่ใน transaction เดียวกัน จึงเห็นผลของ UPDATE ก่อนหน้า
       ถ้ายกเลิกก่อน ตัวหารจะหดลงเหลือเฉพาะกะที่ทำไปแล้ว ยอดต่อกะจึงพองขึ้นทันทีตอนปิดเคส
       (เคส 30 กะ ทำจริง 10 แล้วปิดก่อนกำหนด: จาก staff_pay/30 กลายเป็น staff_pay/10)
       ซึ่งกลับหัวกับเจตนาของการตรึง คือ "ล็อกตัวเลขที่เห็นอยู่ก่อนปิด" ไม่ใช่คิดใหม่
       สองคำสั่งนี้แตะคนละชุดกันอยู่แล้ว (ตรึง = เช็คอินแล้ว · ยกเลิก = ยังไม่เช็คอิน) สลับลำดับได้ปลอดภัย */
    const frozen = await tx.run(
      `UPDATE case_visits v
       SET staff_pay = c.staff_pay / NULLIF(b.n, 0), updated_at = ${NOW}
       FROM cases c, ${BOOKED_VISITS} b
       WHERE v.case_id = :case_id AND c.case_id = :case_id AND b.case_id = :case_id
         AND v.staff_pay IS NULL AND v.check_in_at IS NOT NULL AND c.staff_pay IS NOT NULL`,
      { case_id: caseId },
    );

    // กะที่ยังไม่ถึงวันและไม่มีใครไป = งานที่จะไม่เกิดขึ้นแล้ว ยกเลิกทิ้งไปพร้อมกับการปิดเคส
    // ไม่งั้นปฏิทินเดือนหน้ายังขึ้นกะของเคสที่ปิดไปแล้ว และพนักงานยังเห็นในตารางงานของตัวเอง
    // กะของวันที่ผ่านมาแล้วไม่แตะ — ปล่อยให้ยังเป็น "ขาดงาน" ตามความจริง
    const dropped = await tx.run(
      `UPDATE case_visits
       SET status = 'cancelled', updated_at = ${NOW}
       WHERE case_id = :case_id AND status = 'scheduled'
         AND check_in_at IS NULL AND visit_date >= :today`,
      { case_id: caseId, today: isoDateTH(new Date()) },
    );

    await tx.run(
      `UPDATE cases
       SET status = 'closed',
           closed_at = ${NOW},
           end_date = COALESCE(:end_date, end_date),
           updated_at = ${NOW}
       WHERE case_id = :case_id`,
      { case_id: caseId, end_date: endDate ?? null },
    );

    const notes = [
      frozen > 0 && `ตรึงค่าจ้าง ${frozen} กะ`,
      dropped > 0 && `ยกเลิกกะที่ยังไม่ถึงวัน ${dropped} กะ`,
    ].filter(Boolean);
    await logEvent(tx, caseId, 'closed', notes.length ? `ปิดเคส · ${notes.join(' · ')}` : 'ปิดเคส', actor);
  });

  return findById(caseId);
}

/**
 * เปิดเคสที่ปิด/ยกเลิกไปแล้วกลับมา — สถานะกลับไปตามว่ามีพนักงานอยู่หรือไม่
 * กลับไปได้แค่ 'assigned'/'unassigned' เท่านั้น (ต้องกดเริ่มให้บริการใหม่) และล้างร่องรอยการปิด/ยกเลิกทิ้ง
 */
export async function reopen(caseId, actor) {
  await transaction(async (tx) => {
    await tx.run(
      `UPDATE cases
       SET status = CASE WHEN assigned_to IS NULL THEN 'unassigned' ELSE 'assigned' END,
           closed_at = NULL,
           cancelled_at = NULL,
           cancel_reason = NULL,
           updated_at = ${NOW}
       WHERE case_id = :case_id`,
      { case_id: caseId },
    );
    await logEvent(tx, caseId, 'reopened', 'เปิดเคสใหม่', actor);
  });

  return findById(caseId);
}

/**
 * กะที่มีการเช็คอินจริงในเคสนี้ — ของที่จะหายไปพร้อมกับการลบเคส (case_visits เป็น ON DELETE CASCADE)
 * ใช้เตือนก่อนลบ: เวลาทำงาน รูปเซลฟี่ และค่าจ้างที่อนุมัติไปแล้วอยู่ในแถวพวกนี้ทั้งหมด
 */
export async function attendedVisitCount(caseId) {
  const row = await sql.one(
    'SELECT COUNT(*) AS n FROM case_visits WHERE case_id = :id AND check_in_at IS NOT NULL',
    { id: caseId },
  );
  return Number(row.n);
}

export async function remove(caseId) {
  const changes = await sql.run('DELETE FROM cases WHERE case_id = :id', { id: caseId });
  return changes > 0;
}

// ---------- วันนัดให้บริการ (case_visits) ----------

/**
 * ค่าจ้างของกะหนึ่งกะ — ตั้งไว้ที่กะเองก่อน ไม่ได้ตั้งก็เกลี่ยยอดของเคสตามจำนวนกะที่นัดไว้
 * ต้องมี alias v (case_visits), c (cases) และ b (จำนวนกะที่นัดไว้ต่อเคส) อยู่ใน query ที่เอาไปใช้
 *
 * เกลี่ยแทนที่จะบังคับให้กรอกทีละกะ เพราะราคาที่ตกลงกับลูกค้าเป็นราคาต่อ "แพ็คเกจ" ไม่ใช่ต่อครั้ง
 * กะที่ทำไปแล้วจะถูกตรึงยอดตอนปิดเคส (ดู close) ยอดย้อนหลังจึงไม่ขยับตามการเพิ่ม/ลดกะทีหลัง
 */
const VISIT_PAY = 'COALESCE(v.staff_pay, c.staff_pay / NULLIF(b.n, 0))';

/** จำนวนกะที่นัดไว้ต่อเคส (ไม่นับกะที่ยกเลิก) = ตัวหารของการเกลี่ยค่าจ้าง */
const BOOKED_VISITS = `
  (SELECT case_id, COUNT(*) AS n FROM case_visits WHERE status <> 'cancelled' GROUP BY case_id)
`;

/**
 * กะที่ยังไม่ถูกยกเลิก — ต้องใช้คู่กับ BOOKED_VISITS เสมอ
 *
 * ตัวหาร (BOOKED_VISITS) ตัดกะที่ยกเลิกออกอยู่แล้ว ถ้าตัวเศษไม่ตัดด้วยจะได้สองผลพร้อมกัน:
 * กะที่ถูกยกเลิกทั้งที่เช็คอิน–เอาท์ไปแล้ว "ยังได้เงิน" และ "หายจากตัวหาร" ทำให้กะที่เหลือได้เพิ่มไปด้วย
 * ผลรวมที่จ่ายออกจึงเกิน cases.staff_pay ได้ ทั้งที่เคสหนึ่งใบ = แพ็คเกจหนึ่งชุด
 */
const NOT_CANCELLED = `v.status <> 'cancelled'`;

/** กะทั้งหมดของเคสหนึ่งใบ พร้อมชื่อพนักงานที่นัดไว้ + สถานะเช็คอิน (state คำนวณตอนอ่าน) — เรียงตามวัน/เวลานัด */
export function listVisits(caseId) {
  return sql
    .all(
      `SELECT v.visit_id, v.case_id, v.visit_date, v.status, v.note,
              v.assigned_to, v.planned_start, v.planned_end,
              v.check_in_at, v.check_out_at, v.check_in_distance_m, v.location_flagged,
              v.check_in_late_minutes, v.off_schedule, v.staff_pay,
              v.pay_status, v.pay_note, v.approved_by_name,
              ${VISIT_PAY} AS effective_pay,
              e.first_name || ' ' || e.last_name AS assigned_name,
              e.nickname                          AS assigned_nickname
       FROM case_visits v
       JOIN cases c ON c.case_id = v.case_id
       LEFT JOIN ${BOOKED_VISITS} b ON b.case_id = v.case_id
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
export async function addVisit(caseId, input) {
  return addVisits(caseId, [input.visit_date], input);
}

/**
 * ช่วงเวลาของกะสำหรับเทียบว่าชนกันไหม — ไม่ระบุเวลา = ถือว่ากินทั้งวัน
 * ตั้งใจให้เตือนเกินไว้ดีกว่าเตือนขาด: กะที่ไม่ระบุเวลาสองกะในวันเดียวกันของคนเดียวกัน
 * คือสิ่งที่ต้องให้คนดูอีกที ไม่ใช่สิ่งที่ระบบควรเงียบไว้
 */
const SPAN = (t) => `COALESCE(${t}.planned_start, '00:00')`;
const SPAN_END = (t) => `COALESCE(${t}.planned_end, '23:59')`;

/**
 * กะที่เพิ่งลงไป ชนกับกะอื่นของพนักงานคนเดียวกันหรือเปล่า (รวมข้ามเคส)
 * คืนรายการคู่ที่ชน ไม่ได้บล็อกการบันทึก — บางครั้งจงใจซ้อน (เช่นแวะสองบ้านติดกัน คนละครึ่งชั่วโมง)
 * แต่คนลงตารางต้องรู้ตัว ไม่ใช่มารู้ตอนพนักงานโทรมาบอกว่าไปสองที่พร้อมกันไม่ได้
 */
export function visitConflicts(visitIds) {
  if (visitIds.length === 0) return Promise.resolve([]);

  const slots = visitIds.map((_, i) => `:v${i}`).join(', ');
  const params = Object.fromEntries(visitIds.map((id, i) => [`v${i}`, id]));

  return sql.all(
    `SELECT v.visit_id, v.visit_date, v.planned_start, v.planned_end,
            o.case_id       AS other_case_id,
            o.planned_start AS other_start,
            o.planned_end   AS other_end,
            oc.client_name  AS other_client_name,
            e.first_name || ' ' || e.last_name AS employee_name
     FROM case_visits v
     JOIN case_visits o ON o.assigned_to = v.assigned_to
                       AND o.visit_date  = v.visit_date
                       AND o.visit_id   <> v.visit_id
                       AND o.status <> 'cancelled'
     JOIN cases oc     ON oc.case_id = o.case_id
     LEFT JOIN employees e ON e.employee_id = v.assigned_to
     WHERE v.visit_id IN (${slots})
       AND v.status <> 'cancelled'
       AND ${SPAN('v')} < ${SPAN_END('o')}
       AND ${SPAN('o')} < ${SPAN_END('v')}
     ORDER BY v.visit_date, v.visit_id`,
    params,
  );
}

/**
 * ลงกะหลายวันในครั้งเดียว — ตัวหลักของทั้งการกดวันเดียวบนปฏิทินและการสร้างเป็นช่วง
 *
 * ข้ามวันที่มีกะ "เหมือนกันเป๊ะ" อยู่แล้ว (คนเดียวกัน เวลาเดียวกัน) เพราะการกดสร้างช่วงซ้ำ
 * เป็นเรื่องปกติเวลาต่อตารางเดือนถัดไป ไม่ควรได้กะซ้อนสองใบโดยไม่รู้ตัว
 * ส่วนกะคนละเวลา/คนละคนในวันเดียวกันยังลงได้ตามปกติ (ตั้งใจให้ทำได้ตั้งแต่ระบบกะเฟส 2)
 */
export async function addVisits(caseId, dates, { assigned_to, planned_start, planned_end, staff_pay, note } = {}) {
  const existing = await sql.all(
    `SELECT visit_date, assigned_to, planned_start FROM case_visits WHERE case_id = :id AND status <> 'cancelled'`,
    { id: caseId },
  );
  // ไม่ระบุคน = ผู้รับผิดชอบหลักของเคส ต้องเทียบด้วยคนคนนั้น ไม่งั้นกดซ้ำแล้วได้กะซ้อน
  const fallback = assigned_to
    ? null
    : (await sql.one('SELECT assigned_to FROM cases WHERE case_id = :id', { id: caseId }))?.assigned_to ?? null;
  const who = assigned_to ?? fallback;
  const seen = new Set(existing.map((v) => `${v.visit_date}|${v.assigned_to ?? ''}|${v.planned_start ?? ''}`));

  const fresh = dates.filter((d) => !seen.has(`${d}|${who ?? ''}|${planned_start ?? ''}`));
  if (fresh.length === 0) {
    return { visits: await listVisits(caseId), added: 0, skipped: dates.length, conflicts: [] };
  }

  const params = {
    case_id: caseId,
    assigned_to: assigned_to ?? null,
    planned_start: planned_start ?? null,
    planned_end: planned_end ?? null,
    staff_pay: staff_pay ?? null,
    note: note ?? null,
  };
  const values = fresh.map((d, i) => {
    params[`d${i}`] = d;
    return `(:case_id, :d${i},
             COALESCE(:assigned_to, (SELECT assigned_to FROM cases WHERE case_id = :case_id)),
             :planned_start, :planned_end, :staff_pay, :note)`;
  });

  const inserted = await sql.all(
    `INSERT INTO case_visits (case_id, visit_date, assigned_to, planned_start, planned_end, staff_pay, note)
     VALUES ${values.join(', ')}
     RETURNING visit_id`,
    params,
  );

  return {
    visits: await listVisits(caseId),
    added: inserted.length,
    skipped: dates.length - fresh.length,
    conflicts: await visitConflicts(inserted.map((r) => r.visit_id)),
  };
}

/** แปลงรายการค่า (วัน/รหัสกะ) เป็นพารามิเตอร์ :d0..:dn สำหรับ IN (...) — ตัวแปลง :name ไม่รองรับ array */
function listSlots(values, params = {}) {
  const slots = values.map((v, i) => {
    params[`d${i}`] = v;
    return `:d${i}`;
  });
  return { slots: slots.join(', '), params };
}

/**
 * ลบกะของวันที่ระบุ — ใช้ตอนลงตารางผิด หรือลูกค้าเลื่อนบริการ
 * กะที่เช็คอินไปแล้วไม่ลบให้ (เป็นบันทึกการทำงานจริงและเป็นฐานค่าจ้าง) — คืนจำนวนที่ข้ามไปให้บอกผู้ใช้
 */
export async function removeVisitsOn(caseId, dates) {
  if (dates.length === 0) return { visits: await listVisits(caseId), deleted: 0, kept: 0 };

  const { slots, params } = listSlots(dates, { id: caseId });
  const deleted = await sql.run(
    `DELETE FROM case_visits
     WHERE case_id = :id AND visit_date IN (${slots}) AND check_in_at IS NULL`,
    params,
  );
  const kept = await sql.one(
    `SELECT COUNT(*) AS n FROM case_visits
     WHERE case_id = :id AND visit_date IN (${slots}) AND check_in_at IS NOT NULL`,
    params,
  );

  return { visits: await listVisits(caseId), deleted, kept: Number(kept.n) };
}

/**
 * ตรวจล่วงหน้าว่าวันที่เลือกไว้จะชนกับงานอื่นของพนักงานคนนั้นไหม — เรียกก่อนบันทึก
 *
 * ของเดิมรู้ว่าชนก็ต่อเมื่อกดบันทึกไปแล้ว ซึ่งเป็นจังหวะที่แก้ยากที่สุด
 * ไม่ระบุคน = เทียบกับผู้รับผิดชอบหลักของเคส (ตรงกับที่ addVisits จะเติมให้ตอนบันทึกจริง)
 *
 * duplicates = วันที่มีกะ "เหมือนกันเป๊ะ" อยู่แล้ว (คนเดียวกัน เวลาเดียวกัน) — บันทึกไปก็ถูกข้าม
 */
export async function previewVisits(caseId, { dates, assigned_to, planned_start, planned_end }) {
  const who =
    assigned_to ??
    (await sql.one('SELECT assigned_to FROM cases WHERE case_id = :id', { id: caseId }))?.assigned_to ??
    null;
  if (!who || dates.length === 0) return { conflicts: [], duplicates: [] };

  const { slots, params } = listSlots(dates, {
    emp: who,
    start: planned_start ?? '00:00',
    end: planned_end ?? '23:59',
    self: caseId,
  });

  const [conflicts, duplicates] = await Promise.all([
    sql.all(
      `SELECT o.visit_date, o.case_id AS other_case_id,
              o.planned_start AS other_start, o.planned_end AS other_end,
              oc.client_name  AS other_client_name,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM case_visits o
       JOIN cases oc ON oc.case_id = o.case_id
       LEFT JOIN employees e ON e.employee_id = o.assigned_to
       WHERE o.assigned_to = :emp
         AND o.status <> 'cancelled'
         AND o.visit_date IN (${slots})
         AND ${SPAN('o')} < :end
         AND :start < ${SPAN_END('o')}
       ORDER BY o.visit_date`,
      params,
    ),
    sql.all(
      `SELECT visit_date FROM case_visits
       WHERE case_id = :self AND status <> 'cancelled'
         AND assigned_to = :emp
         AND planned_start IS NOT DISTINCT FROM :nullable_start
         AND visit_date IN (${slots})`,
      { ...params, nullable_start: planned_start ?? null },
    ),
  ]);

  const dupDates = new Set(duplicates.map((r) => r.visit_date));

  /* กะที่ "เหมือนกันเป๊ะ" ในเคสเดียวกัน ถูกรายงานเป็น duplicate ไปแล้วและตอนบันทึกจะถูกข้าม
     ถ้าปล่อยให้ขึ้นในรายการชนด้วย จะกลายเป็นเตือนว่า "ชนกับเคสตัวเอง" ซึ่งอ่านแล้วงงและไม่ต้องทำอะไรต่อ
     กะคนละเวลาในเคสเดียวกันยังเตือนตามปกติ (คนเดียวไปสองรอบทับเวลากันไม่ได้จริง) */
  const meaningful = conflicts.filter(
    (c) =>
      !(
        c.other_case_id === caseId &&
        dupDates.has(c.visit_date) &&
        (c.other_start ?? null) === (planned_start ?? null)
      ),
  );

  return { conflicts: meaningful, duplicates: [...dupDates] };
}

export async function updateVisit(caseId, visitId, input) {
  const fields = [
    'visit_date', 'assigned_to', 'planned_start', 'planned_end', 'status', 'note',
    'staff_pay', // ตั้งค่าจ้างเฉพาะกะนี้ — ส่ง null = กลับไปเกลี่ยจากยอดเคสตามปกติ
  ].filter((c) => c in input);
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

/**
 * ลบกะทีละใบ — กะที่เช็คอินไปแล้วลบไม่ได้ เงื่อนไขเดียวกับ removeVisitsOn
 * (เป็นบันทึกการทำงานจริง เป็นฐานค่าจ้าง และมีรูปเซลฟี่เป็นหลักฐานติดอยู่)
 * คืน false เมื่อไม่ได้ลบ ให้ชั้น route ตอบ 409 พร้อมบอกเหตุผล
 */
export async function removeVisit(caseId, visitId) {
  const deleted = await sql.run(
    `DELETE FROM case_visits
     WHERE visit_id = :visit_id AND case_id = :case_id AND check_in_at IS NULL`,
    { visit_id: visitId, case_id: caseId },
  );
  return deleted > 0;
}

// ---------- เช็คอิน/เอาท์ของพนักงานภาคสนาม (case_visits ระดับกะ) ----------
// SELECT นี้ไม่ดึง fee/ราคาใดๆ เลย — ฝั่ง field ไม่เห็นข้อมูลการเงิน (ไม่ต้อง strip ทีหลัง)
const MY_VISIT = `
  SELECT v.visit_id, v.case_id, v.visit_date, v.status AS visit_status, v.note,
         v.assigned_to, v.planned_start, v.planned_end,
         v.check_in_at, v.check_out_at, v.check_in_lat, v.check_in_lng,
         v.check_in_distance_m, v.location_flagged,
         v.check_in_late_minutes, v.off_schedule,
         v.pay_status, v.pay_note,
         (v.check_in_photo_data IS NOT NULL) AS has_photo,
         c.status AS case_status, c.case_type, c.client_name, c.address, c.client_phone,
         c.service_kind, c.start_date, c.end_date,
         c.geo_lat AS case_geo_lat, c.geo_lng AS case_geo_lng, c.geofence_radius_m AS case_radius,
         c.medical_history, c.current_symptoms, c.medical_devices, c.care_goal,
         c.patient_gender, c.patient_age,
         f.name  AS format_name, g.name AS grade_name,
         pp.name AS physio_package_name, pp.sessions AS physio_sessions,
         ${PATIENT_LIVE}
  FROM case_visits v
  JOIN cases c ON c.case_id = v.case_id
  LEFT JOIN patients pt           ON pt.patient_id = c.patient_id
  LEFT JOIN pkg_service_formats f ON f.format_id = c.pkg_format_id
  LEFT JOIN pkg_grades g          ON g.grade_id  = c.pkg_grade_id
  LEFT JOIN physio_packages pp    ON pp.physio_package_id = c.physio_package_id
`;

// วันปัจจุบันโซนไทย 'YYYY-MM-DD' — พนักงานอยู่ไทย ปฏิทิน/ขาดงานต้องอิงวันไทย ไม่ใช่ UTC
const isoDateTH = (d) => new Date(d.getTime() + 7 * 3.6e6).toISOString().slice(0, 10);

/**
 * วัน–เวลาปัจจุบันโซนไทยจากนาฬิกาของฐานข้อมูล
 * ใช้ตัวนี้ตัดสินเรื่องเช็คอิน (ถึงวันนัดหรือยัง / สายกี่นาที) เพราะ check_in_at ก็มาจาก now() ของ DB
 * ถ้าไปใช้นาฬิกาของ Node แล้วสองเครื่องเหลื่อมกัน จะได้กะที่ "สายติดลบ" หรือกันเช็คอินผิดวัน
 */
export const serverNowTH = () =>
  sql.one(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS date,
            to_char(now() AT TIME ZONE 'Asia/Bangkok', 'HH24:MI')    AS time`,
  );

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
export function checkInVisit(
  visitId,
  { employee_id, lat, lng, accuracy, distance, flagged, photo, late_minutes, off_schedule },
) {
  return transaction(async (tx) => {
    const updated = await tx.run(
      `UPDATE case_visits
       SET check_in_at = now(), checked_in_by = :emp,
           check_in_lat = :lat, check_in_lng = :lng, check_in_accuracy_m = :acc,
           check_in_distance_m = :dist, location_flagged = :flag,
           check_in_late_minutes = :late, off_schedule = :off,
           check_in_photo_data = :pdata, check_in_photo_mime = :pmime, check_in_photo_size = :psize,
           updated_at = ${NOW}
       WHERE visit_id = :id AND check_in_at IS NULL`,
      {
        id: visitId, emp: employee_id, lat, lng, acc: accuracy,
        dist: distance, flag: flagged,
        late: late_minutes ?? null, off: off_schedule ?? false,
        pdata: photo?.data ?? null, pmime: photo?.mime ?? null, psize: photo?.size ?? null,
      },
    );
    if (updated === 0) return false; // เช็คอินไปแล้ว

    // เช็คอินขณะเคสยัง 'assigned' = เริ่มให้บริการ (mirror start(): เติม start_date ถ้ายังว่าง)
    // เงื่อนไข status='assigned' รับประกันว่า cases.assigned_to ไม่เป็น null อยู่แล้ว (ตาม CHECK) จึงเข้า in_progress ได้ไม่ชน constraint
    const started = await tx.run(
      `UPDATE cases
       SET status = 'in_progress',
           start_date = COALESCE(start_date, to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')),
           updated_at = ${NOW}
       WHERE case_id = (SELECT case_id FROM case_visits WHERE visit_id = :id) AND status = 'assigned'`,
      { id: visitId },
    );

    // เคสเข้าสถานะ "กำลังให้บริการ" โดยไม่มีใครกดปุ่ม — ต้องมีบรรทัดในประวัติเหมือนกัน
    // ไม่งั้นสถานะเปลี่ยนเองแล้วไล่ไม่ได้ว่าเปลี่ยนตอนไหน เพราะอะไร
    if (started > 0) {
      const row = await tx.one('SELECT case_id FROM case_visits WHERE visit_id = :id', { id: visitId });
      await logEvent(tx, row.case_id, 'started', 'เริ่มให้บริการ (จากการเช็คอินกะแรก)', {
        employee_id,
        name: await staffName(tx, employee_id),
      });
    }
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
         v.check_in_late_minutes, v.off_schedule,
         (v.check_in_photo_data IS NOT NULL) AS has_photo,
         -- รหัสของคนที่ employee_name อ้างถึง — ลำดับ COALESCE ต้องตรงกับบรรทัดล่างเป๊ะ
         -- ไม่งั้นหน้าเว็บจะกรองด้วยรหัสของคนหนึ่งแต่เห็นชื่ออีกคน
         COALESCE(v.checked_in_by, v.assigned_to) AS employee_id,
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
/**
 * สายเกินกี่นาทีถึงเรียกว่าต้องให้ผู้จัดการดู
 * 30 นาที — ต่ำกว่านี้มักเป็นรถติด/หาบ้านไม่เจอ ซึ่งเกิดเป็นปกติและไม่ต้องทำอะไรต่อ
 * เกินครึ่งชั่วโมงคือเริ่มกระทบงานจริง (ญาติรอ, กะถัดไปเลื่อน)
 */
export const LATE_THRESHOLD_MINUTES = 30;

/**
 * ย้อนหลังได้ไกลสุดกี่วันในรายการต้องตรวจ
 *
 * เดิมกวาดทั้งตารางทุกครั้งที่เปิดหน้า และรายการโตขึ้นเรื่อยๆ ไม่มีเพดาน — ของค้างจากปีที่แล้ว
 * ที่ไม่มีใครตามแล้วจะดันของใหม่ตกหน้าจอ และตัวเลขบนแท็บก็สูงจนเลิกมีความหมาย
 * ใช้หลักเดียวกับอีเมลสรุปที่จำกัดขาดงานไว้ 14 วัน แต่กว้างกว่าเพราะหน้านี้ใช้ตามงานย้อนหลังจริง
 * ประวัติทั้งหมดยังดูได้ที่แท็บ "ประวัติเช็คอิน" ซึ่งเลือกเดือนได้อยู่แล้ว
 */
const EXCEPTION_LOOKBACK_DAYS = 180;

export function attendanceExceptions() {
  const now = new Date();
  const today = isoDateTH(now);
  const since = isoDateTH(new Date(now.getTime() - EXCEPTION_LOOKBACK_DAYS * 86_400_000));
  return sql
    .all(
      `${ADMIN_VISIT}
       WHERE v.status <> 'cancelled'
         AND v.visit_date >= :since
         AND (
           v.location_flagged = TRUE
           OR v.off_schedule = TRUE
           OR v.check_in_late_minutes > :late
           OR (v.check_in_at IS NOT NULL AND v.check_out_at IS NULL)
           OR (v.check_in_at IS NULL AND v.visit_date < :today)
         )
       ORDER BY v.visit_date DESC, v.check_in_at DESC`,
      { today, since, late: LATE_THRESHOLD_MINUTES },
    )
    .then((rows) =>
      rows
        .map((v) => withVisitState(v))
        .filter(
          (v) =>
            v.state === 'missed' ||
            v.state === 'stale' ||
            v.location_flagged ||
            v.off_schedule ||
            v.check_in_late_minutes > LATE_THRESHOLD_MINUTES,
        ),
    );
}

// ---------- อนุมัติค่าจ้างรายกะ ----------

/**
 * กะที่ทำงานจบแล้วแต่ยังไม่ได้อนุมัติ — คิวที่ผู้จัดการต้องไล่ดูก่อนเงินเข้าพนักงาน
 *
 * ส่งยอดของแต่ละกะไปด้วย (เกลี่ยจากเคสถ้าไม่ได้ตั้งรายกะ) เพราะคนอนุมัติต้องเห็นว่ากำลังอนุมัติเงินเท่าไหร่
 * พร้อมธงที่ทำให้กะนั้นน่าสงสัย (นอกพื้นที่ / นอกวันนัด / สาย / ทำงาน 0 นาที) — เรียงของที่ต้องดูก่อนขึ้นบน
 */
export function pendingApprovals({ month, employee_id } = {}) {
  const where = [`${DONE}`, NOT_CANCELLED, `v.pay_status = 'pending'`];
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
    .all(
      `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end,
              v.check_in_at, v.check_out_at, v.check_in_distance_m,
              v.location_flagged, v.off_schedule, v.check_in_late_minutes,
              v.status AS visit_status,
              ${VISIT_PAY} AS pay,
              ROUND(EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at)) / 60) AS worked_minutes,
              c.client_name, c.status AS case_status,
              v.checked_in_by AS employee_id,
              ${WORKER_NAME} AS employee_name
       FROM case_visits v
       JOIN cases c     ON c.case_id     = v.case_id
       LEFT JOIN employees e ON e.employee_id = v.checked_in_by
       LEFT JOIN ${BOOKED_VISITS} b ON b.case_id = v.case_id
       WHERE ${where.join(' AND ')}
       ORDER BY v.visit_date DESC, v.check_in_at DESC`,
      params,
    )
    .then((rows) =>
      rows.map((r) => ({
        ...r,
        pay: r.pay == null ? null : Number(r.pay),
        worked_minutes: r.worked_minutes == null ? null : Number(r.worked_minutes),
      })),
    );
}

/**
 * อนุมัติ/ไม่อนุมัติค่าจ้างของกะ (ทีละหลายกะได้) — คืนจำนวนที่เปลี่ยนจริง
 *
 * แตะเฉพาะกะที่ "ทำจบแล้วและยังรออยู่" เท่านั้น — กะที่ตัดสินไปแล้วต้องไม่ถูกทับด้วยการกดซ้ำ
 * หรือด้วยการกด "อนุมัติทั้งหมด" จากอีกหน้าที่เห็นข้อมูลเก่า
 * ลงประวัติของเคสด้วย เพราะเป็นการตัดสินใจเรื่องเงินที่ต้องไล่ย้อนได้ว่าใครเป็นคนกด
 */
export async function decideVisitPay(visitIds, { approve, reason }, actor) {
  if (visitIds.length === 0) return { changed: 0 };

  const { slots, params } = listSlots(visitIds, {
    status: approve ? 'approved' : 'rejected',
    note: approve ? null : reason ?? null,
    by: actor?.employee_id ?? null,
    by_name: actor?.name ?? null,
  });

  return transaction(async (tx) => {
    const rows = await tx.all(
      `UPDATE case_visits v
       SET pay_status = :status,
           pay_note = :note,
           approved_at = ${NOW},
           approved_by = :by,
           approved_by_name = :by_name,
           updated_at = ${NOW}
       WHERE v.visit_id IN (${slots})
         AND v.check_out_at IS NOT NULL
         AND v.pay_status = 'pending'
       RETURNING v.case_id, v.visit_date`,
      params,
    );

    // รวมเป็นบรรทัดเดียวต่อเคส — อนุมัติทีละ 30 กะแล้วได้ประวัติ 30 บรรทัดคือไล่อ่านไม่ไหว
    const byCase = new Map();
    for (const r of rows) byCase.set(r.case_id, (byCase.get(r.case_id) ?? 0) + 1);

    for (const [caseId, n] of byCase) {
      await logEvent(
        tx,
        caseId,
        approve ? 'pay_approved' : 'pay_rejected',
        approve
          ? `อนุมัติค่าจ้าง ${n} กะ`
          : `ไม่อนุมัติค่าจ้าง ${n} กะ${reason ? ` — ${reason}` : ''}`,
        actor,
      );
    }

    return { changed: rows.length };
  });
}

/** กะของเคสหนึ่งที่ยังรออนุมัติ — ใช้ตอนกด "อนุมัติทั้งเคส" จากหน้าจัดการเคส */
export function pendingVisitIds(caseId) {
  return sql
    .all(
      `SELECT visit_id FROM case_visits
       WHERE case_id = :id AND check_out_at IS NOT NULL AND pay_status = 'pending'`,
      { id: caseId },
    )
    .then((rows) => rows.map((r) => r.visit_id));
}

/** สิ่งที่ admin แก้ในกะ เขียนเป็นข้อความสั้นๆ ลงประวัติ — ไล่ย้อนได้ว่าตัวเลขถูกแตะตรงไหน */
const ADJUST_LABELS = {
  check_in_at: 'เวลาเข้า',
  check_out_at: 'เวลาออก',
  status: 'สถานะกะ',
  location_flagged: 'ธงนอกพื้นที่',
};

/**
 * admin แก้กะที่เช็คอินผิดพลาด — ปิดกะค้าง / แก้เวลา / เคลียร์ธง / เปลี่ยนสถานะ
 * เก็บ adjusted_by ไว้เสมอ ให้รู้ว่าใครแก้ และลงประวัติของเคสด้วย (การแก้เวลาเข้า–ออกกระทบค่าจ้าง)
 */
export async function adjustVisit(caseId, visitId, input, admin) {
  const adminId = typeof admin === 'string' ? admin : admin?.employee_id ?? null;
  const sets = ['adjusted_by = :admin', `updated_at = ${NOW}`];
  const values = { case_id: caseId, visit_id: visitId, admin: adminId };
  const touched = [];

  for (const col of ['check_in_at', 'check_out_at', 'status', 'location_flagged']) {
    if (col in input) {
      sets.push(`${col} = :${col}`);
      values[col] = input[col] ?? null;
      touched.push(ADJUST_LABELS[col]);
    }
  }

  /* ลงเวลาเข้าให้กะที่ไม่เคยเช็คอิน (พนักงานไปทำงานจริงแต่ลืมกดเช็คอิน) ต้องลง "คนที่ทำ" ให้ด้วย
     สรุปค่าตอบแทนทั้งระบบนับจาก checked_in_by (ดู WORKED_SHIFT ที่ JOIN employees ด้วยคอลัมน์นี้)
     ถ้าลงแต่เวลา กะจะขึ้นว่าเสร็จแล้วบนหน้าจอ แต่หายไปจากค่าจ้างเงียบๆ — พนักงานทำงานฟรี

     COALESCE จึงไม่ทับของเดิม: กะที่พนักงานเช็คอินเองแล้วผู้จัดการมาแก้เวลาทีหลัง
     ต้องยังเป็นชื่อคนที่ไปจริง ไม่ใช่ถูกเปลี่ยนเป็นคนที่ถูกจัดให้ในภายหลัง
     ส่วนล้างเวลาเข้าทิ้ง = กะนั้นไม่มีใครไป ชื่อคนเช็คอินต้องหายตามไปด้วย ไม่งั้นค้างเป็นข้อมูลผี */
  if ('check_in_at' in input) {
    sets.push(
      input.check_in_at == null
        ? 'checked_in_by = NULL'
        : 'checked_in_by = COALESCE(checked_in_by, assigned_to)',
    );
  }

  await transaction(async (tx) => {
    await tx.run(
      `UPDATE case_visits SET ${sets.join(', ')} WHERE visit_id = :visit_id AND case_id = :case_id`,
      values,
    );

    const visit = await tx.one(
      'SELECT visit_date FROM case_visits WHERE visit_id = :id AND case_id = :case_id',
      { id: visitId, case_id: caseId },
    );
    if (visit) {
      await logEvent(
        tx,
        caseId,
        'visit_adjusted',
        `แก้กะวันที่ ${visit.visit_date}${touched.length ? ` — ${touched.join(', ')}` : ''}`,
        typeof admin === 'string' ? { employee_id: adminId, name: await staffName(tx, adminId) } : admin,
      );
    }
  });

  return findVisit(visitId);
}

/**
 * กะที่ทำจบแล้ว (เช็คอินและเช็คเอาท์ครบ) ในเดือนที่ขอ — ฐานของทั้งชั่วโมงและค่าจ้าง
 * รวม join ชื่อบริการ (f/g/pp) ไว้ด้วย เพราะ WHERE อยู่ในก้อนนี้แล้ว ผู้เรียกจึงต่อ JOIN เพิ่มทีหลังไม่ได้
 */
const WORKED_SHIFT = `
  FROM case_visits v
  JOIN cases c     ON c.case_id     = v.case_id
  LEFT JOIN employees e ON e.employee_id = v.checked_in_by
  LEFT JOIN ${BOOKED_VISITS} b    ON b.case_id   = v.case_id
  LEFT JOIN pkg_service_formats f ON f.format_id = c.pkg_format_id
  LEFT JOIN pkg_grades g          ON g.grade_id  = c.pkg_grade_id
  LEFT JOIN physio_packages pp    ON pp.physio_package_id = c.physio_package_id
  WHERE v.check_in_at IS NOT NULL
    AND ${NOT_CANCELLED}
    AND to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') = :month
`;

/**
 * ชื่อพนักงานที่เช็คอิน — LEFT JOIN เพราะ checked_in_by เป็น ON DELETE SET NULL
 * ลบพนักงานถาวรแล้วกะที่เขาทำไปจริงต้องไม่หายจากรายงาน (INNER JOIN เดิมทำให้ยอดเดือนที่ปิดไปแล้วเปลี่ยนย้อนหลัง)
 */
const WORKER_NAME = `COALESCE(e.first_name || ' ' || e.last_name, '(พนักงานที่ถูกลบแล้ว)')`;

/**
 * สรุปค่าตอบแทนรายเดือนต่อพนักงาน (payroll)
 *
 * ค่าจ้างและชั่วโมงนับจากฐานเดียวกัน = "กะที่เช็คอินจริง" ของ "คนที่เช็คอินจริง" (checked_in_by)
 * ในเดือนที่เช็คอิน — ไม่ใช่ยอดของเคสที่ปิดในเดือนนั้นเหมือนเดิม
 * ของเดิมจ่ายให้ผู้รับผิดชอบเคส ณ ตอนปิด: เปลี่ยนคนกลางคันแล้วคนที่ไปทำจริงได้ศูนย์
 * และเคสที่ลากข้ามเดือนจะเทเงินทั้งก้อนลงเดือนที่ปิด
 *
 * ยอดต่อกะดู VISIT_PAY (ค่าจ้างของกะเอง ไม่มีก็เกลี่ยจากยอดเคส) — ตรึงเป็นตัวเลขถาวรตอนปิดเคส
 * ค่าจ้างที่ใช้เป็น snapshot ที่คัดลอกไว้ในเคส ไม่ได้อ่านสดจากตารางเรท ยอดย้อนหลังจึงไม่ขยับตามการปรับราคา
 *
 * employeeId = ดูของคนเดียว (ฝั่งพนักงานภาคสนามที่เห็นได้เฉพาะของตัวเอง) — ไม่ส่ง = ทุกคน (admin)
 */
/** กะที่ทำจบแล้ว = ฐานของชั่วโมง · กะที่อนุมัติแล้วเท่านั้น = ฐานของเงิน */
const DONE = `v.check_out_at IS NOT NULL`;
const PAYABLE = `${DONE} AND v.pay_status = 'approved'`;
const AWAITING = `${DONE} AND v.pay_status = 'pending'`;

export async function attendanceReport(month, employeeId = null) {
  // ใส่เงื่อนไข (และพารามิเตอร์) เฉพาะตอนใช้จริง — ตัวแปลง :name ไล่หาชื่อจาก SQL ที่มีอยู่จริงเท่านั้น
  const params = { month };
  if (employeeId) params.emp = employeeId;

  const rows = await sql.all(
    `SELECT v.checked_in_by AS employee_id,
            ${WORKER_NAME} AS employee_name,
            COUNT(*) FILTER (WHERE ${DONE})                    AS shifts,
            COUNT(DISTINCT v.case_id) FILTER (WHERE ${DONE})   AS cases_worked,
            COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at)) / 60)
                     FILTER (WHERE ${DONE})), 0)               AS minutes,
            COALESCE(SUM(${VISIT_PAY}) FILTER (WHERE ${PAYABLE}), 0)  AS pay,
            COUNT(*) FILTER (WHERE ${PAYABLE})                        AS approved_shifts,
            COALESCE(SUM(${VISIT_PAY}) FILTER (WHERE ${AWAITING}), 0) AS pending_pay,
            COUNT(*) FILTER (WHERE ${AWAITING})                       AS pending_shifts,
            COUNT(*) FILTER (WHERE ${DONE} AND v.pay_status = 'rejected') AS rejected_shifts,
            COUNT(*) FILTER (WHERE ${DONE} AND ${VISIT_PAY} IS NULL)  AS unpriced_shifts
     ${WORKED_SHIFT}
       ${employeeId ? 'AND v.checked_in_by = :emp' : ''}
     GROUP BY v.checked_in_by, e.first_name, e.last_name`,
    params,
  );

  return rows
    .map((r) => ({
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      shifts: Number(r.shifts),
      cases_worked: Number(r.cases_worked),
      minutes: Number(r.minutes),
      pay: Number(r.pay),
      approved_shifts: Number(r.approved_shifts),
      pending_pay: Number(r.pending_pay),
      pending_shifts: Number(r.pending_shifts),
      rejected_shifts: Number(r.rejected_shifts),
      unpriced_shifts: Number(r.unpriced_shifts),
    }))
    // employee_name ว่างได้ถ้าพนักงานถูกลบถาวร (LEFT JOIN) — กัน localeCompare ล้มทั้งรายงาน
    .sort((a, b) => (a.employee_name ?? '').localeCompare(b.employee_name ?? '', 'th'));
}

/**
 * เคสที่พนักงานคนหนึ่งลงแรงในเดือนนั้น พร้อมยอดรวมของกะที่ทำในเคสนั้น — ที่มาของยอดในสรุปค่าตอบแทน
 * ให้กางดูได้ว่าเงินมาจากเคสไหน กี่กะ ไม่ใช่เห็นแค่ตัวเลขก้อนเดียว
 */
export function payoutCases(month, employeeId) {
  return sql
    .all(
      `SELECT c.case_id, c.title, c.client_name, c.case_type, c.service_kind, c.status,
              c.closed_at, c.start_date, c.end_date,
              COUNT(*) FILTER (WHERE ${DONE}) AS shifts,
              COALESCE(SUM(${VISIT_PAY}) FILTER (WHERE ${PAYABLE}), 0) AS pay,
              COUNT(*) FILTER (WHERE ${AWAITING}) AS pending_shifts,
              COALESCE(SUM(${VISIT_PAY}) FILTER (WHERE ${AWAITING}), 0) AS pending_pay,
              COUNT(*) FILTER (WHERE ${DONE} AND ${VISIT_PAY} IS NULL) AS unpriced_shifts,
              MAX(v.visit_date) AS last_visit_date,
              f.name  AS format_name, g.name AS grade_name,
              pp.name AS physio_package_name, pp.sessions AS physio_sessions
       ${WORKED_SHIFT}
         AND v.checked_in_by = :emp
       GROUP BY c.case_id, c.title, c.client_name, c.case_type, c.service_kind, c.status,
                c.closed_at, c.start_date, c.end_date,
                f.name, g.name, pp.name, pp.sessions
       ORDER BY last_visit_date DESC`,
      { emp: employeeId, month },
    )
    .then((rows) =>
      rows.map((r) => ({
        ...r,
        shifts: Number(r.shifts),
        pay: Number(r.pay),
        unpriced_shifts: Number(r.unpriced_shifts),
      })),
    );
}

/** เคสที่ยังทำอยู่ของพนักงานคนหนึ่ง (ยังไม่ปิด/ยกเลิก) — โชว์เป็นจำนวนงานที่ถืออยู่ ไม่ใช่ยอดเงิน */
export function openCaseCount(employeeId) {
  return sql
    .one(
      `SELECT COUNT(*) AS n FROM cases
       WHERE assigned_to = :emp AND status IN ('assigned', 'in_progress')`,
      { emp: employeeId },
    )
    .then((r) => Number(r.n));
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

  /*
   * กรองเฉพาะงานของพนักงานคนเดียว — ไม่ส่งมาคือดูตารางรวมทุกคน
   * ต้องดูทั้งคนที่ถูกนัดในกะ (v.assigned_to) และผู้รับผิดชอบของเคส (c.assigned_to)
   * เพราะกะหนึ่งมอบให้คนอื่นแทนได้ ถ้ากรองแค่ระดับเคสจะไม่เห็นกะที่คนนี้ถูกฝากไปทำจริง
   * ใส่พารามิเตอร์เฉพาะตอนใช้จริง เพราะตัวแปลง :name จะไล่หาชื่อจาก SQL ที่มีอยู่จริงเท่านั้น
   */
  const staffFilter = employee_id ? 'AND COALESCE(v.assigned_to, c.assigned_to) = :employee_id' : '';
  if (employee_id) params.employee_id = employee_id;

  const visits = await sql.all(
    `SELECT c.case_id, c.title, c.case_type, c.status, c.service_kind, c.physio_package_id,
            c.client_name,
            cu.name AS customer_name,
            v.visit_id, v.visit_date, v.status AS visit_status,
            v.planned_start, v.planned_end,
            v.check_in_at, v.check_out_at,
            -- คนที่ไปทำงานกะนี้จริง = คนที่ถูกนัดในกะ ถ้าไม่ได้ระบุก็ใช้ผู้รับผิดชอบของเคส
            -- (ต้องตรงกับเงื่อนไขกรองด้านบน ไม่งั้นกรองชื่อหนึ่งแต่เห็นอีกชื่อ)
            COALESCE(v.assigned_to, c.assigned_to)   AS assigned_to,
            COALESCE(ve.first_name || ' ' || ve.last_name, ce.first_name || ' ' || ce.last_name) AS assigned_name,
            COALESCE(ve.position, ce.position)       AS assigned_position
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees ve ON ve.employee_id = v.assigned_to
     LEFT JOIN employees ce ON ce.employee_id = c.assigned_to
     LEFT JOIN customers cu ON cu.customer_id = c.customer_id
     WHERE v.status <> 'cancelled'
       AND v.visit_date >= :month_start
       AND v.visit_date <  :next_month
       ${staffFilter}
     ORDER BY v.visit_date, v.planned_start NULLS LAST, v.visit_id`,
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
