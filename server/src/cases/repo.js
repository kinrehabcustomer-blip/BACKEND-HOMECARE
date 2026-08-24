import { sql, nextCaseId, transaction } from '../db/index.js';
/* รายการช่องของรายงานมาจาก schema.js ที่เดียว — ฟอร์มมี 80 กว่าช่อง การก๊อปรายชื่อมาไว้สองที่
   แปลว่าวันหนึ่งจะมีช่องที่ผ่าน validation แล้วแต่ไม่ถูกเขียนลงตาราง (บันทึกสำเร็จแต่ข้อมูลหาย)
   ต่างจากตาราง cases ที่ยังประกาศ COLUMNS เอง เพราะช่องน้อยและมีคอลัมน์ที่ระบบเติมเองปนอยู่ */
import { REPORT_CONTENT_FIELDS } from './schema.js';
import { decodeImage } from '../employees/schema.js';
import { ApiError } from '../lib/errors.js';

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
         /* คนอื่นในเคสนอกจากคนที่ assigned_to อ้างอยู่ — หน้ารายการต้องบอกได้ว่า "ใครดูแลเคสนี้บ้าง"
            ไม่ใช่โชว์ชื่อเดียวทั้งที่มีสองคน ทำเป็น subquery ไม่ใช่ JOIN + GROUP BY
            เพราะ SELECT นี้ถูกใช้ทั้งดึงทีละใบและดึงเป็นหน้า การ GROUP BY จะลามไปทุกคอลัมน์ */
         (SELECT string_agg(te.first_name || ' ' || te.last_name, ' · ' ORDER BY t.added_at, t.employee_id)
          FROM case_team t
          JOIN employees te ON te.employee_id = t.employee_id
          WHERE t.case_id = c.case_id) AS team_names,
         (SELECT COUNT(*)::int FROM case_team t WHERE t.case_id = c.case_id) AS team_count,
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
        OR EXISTS (SELECT 1 FROM case_team t WHERE t.case_id = c.case_id AND t.employee_id = :id)
        OR EXISTS (SELECT 1 FROM case_visits v WHERE v.case_id = c.case_id AND v.assigned_to = :id)
     ORDER BY c.case_id DESC`,
    { id: employeeId },
  );
}

/** พนักงานภาคสนามเข้าถึงเคสนี้ได้ไหม (ผู้รับผิดชอบหลัก / อยู่ในทีม / มีกะในเคส) — ใช้กันดูเคสคนอื่น */
export async function hasFieldAccess(employeeId, caseId) {
  const row = await sql.one(
    `SELECT 1 FROM cases c
     WHERE c.case_id = :cid
       AND (c.assigned_to = :eid
            OR EXISTS (SELECT 1 FROM case_team t WHERE t.case_id = c.case_id AND t.employee_id = :eid)
            /* กะที่ถูกยกเลิก = งานที่ไม่ได้เกิดขึ้น จึงไม่ควรเป็นใบเบิกทางให้อ่านประวัติการรักษา
               ที่อยู่ และข้อมูลสุขภาพของผู้ป่วยรายนั้นต่อไปตลอดกาล (เคสถูกยกเลิกทั้งใบก็เข้าข่ายเดียวกัน) */
            OR EXISTS (SELECT 1 FROM case_visits v
                       WHERE v.case_id = c.case_id AND v.assigned_to = :eid
                         AND v.status <> 'cancelled'))`,
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
async function payFromService(input, db = sql) {
  if (input.physio_package_id) {
    const p = await db.one(
      'SELECT staff_pay FROM physio_packages WHERE physio_package_id = :id',
      { id: input.physio_package_id },
    );
    return p?.staff_pay ?? null;
  }

  if (input.pkg_format_id && input.pkg_staff_tier) {
    const r = await db.one(
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

const PAY_SERVICE_FIELDS = [
  'service_kind',
  'pkg_grade_id',
  'pkg_format_id',
  'pkg_staff_tier',
  'physio_package_id',
];

/**
 * ตัดสินว่าตอน PATCH ต้องเก็บค่าจ้างเดิม ใช้ตัวเลขที่ manager ส่ง หรือดึงจากบริการใหม่
 *
 * หน้า HR ส่งฟอร์มเต็มแต่ไม่มี staff_pay จึงห้ามดูแค่ว่า payload มีคีย์บริการหรือไม่ —
 * ต้องเทียบกับแถวปัจจุบันจริง ไม่งั้นแก้หมายเหตุอย่างเดียวก็ทับค่าจ้างพิเศษของ manager ได้
 */
export function staffPayUpdateMode(current, input) {
  if (Object.prototype.hasOwnProperty.call(input, 'staff_pay')) {
    return input.staff_pay == null ? 'service' : 'explicit';
  }

  const serviceChanged = PAY_SERVICE_FIELDS.some(
    (field) =>
      Object.prototype.hasOwnProperty.call(input, field) &&
      String(current?.[field] ?? '') !== String(input[field] ?? ''),
  );
  return serviceChanged ? 'service' : 'preserve';
}

/**
 * ยอดค่าจ้างใหม่ต้องไม่ต่ำกว่าเงินที่ปล่อยออกจากเคสไปแล้ว
 * เทียบที่ความละเอียดสตางค์แบบเดียวกับ releasePay เพื่อไม่ให้ floating point ทำให้ยอดเท่ากันดูเหมือนต่ำกว่า
 */
export function assessStaffPayUpdate(targetStaffPay, releasedAmount) {
  const money = (n) => Math.round(Number(n) * 100) / 100;
  const released = money(releasedAmount ?? 0);
  // คืนค่าที่ normalize แล้วไปเขียนด้วย ไม่ใช่ใช้ค่าปัดตอนเทียบแต่ปล่อยค่าดิบที่ต่ำกว่า released ลง DB
  const staff_pay = targetStaffPay == null ? null : money(targetStaffPay);

  if (released > 0 && (staff_pay == null || staff_pay < released)) {
    return { reason: 'below_released', staff_pay, released };
  }
  return { staff_pay, released };
}

/**
 * เตรียม staff_pay สำหรับ PATCH ภายใต้ transaction เดียวกับ UPDATE
 *
 * ล็อกแถว cases ก่อนเสมอให้ใช้ลำดับเดียวกับ releasePay; จากนั้น SUM จะเห็น payout ที่คำขอก่อนหน้า
 * commit แล้ว และคำขอปล่อยเงินใหม่ของเคสเดียวกันต้องรอจน UPDATE นี้ commit/rollback ก่อน
 */
export async function staffPayUpdateForTransaction(tx, caseId, input) {
  const current = await tx.one('SELECT * FROM cases WHERE case_id = :id FOR UPDATE', { id: caseId });
  if (!current) throw new ApiError(404, `ไม่พบเคสรหัส ${caseId}`);

  const mode = staffPayUpdateMode(current, input);
  if (mode === 'preserve') return { current, mode, staff_pay: current.staff_pay };

  const targetStaffPay =
    mode === 'service'
      ? await payFromService({ ...current, ...input }, tx)
      : input.staff_pay;
  const { released } = await tx.one(
    'SELECT COALESCE(SUM(amount), 0) AS released FROM case_payouts WHERE case_id = :id',
    { id: caseId },
  );
  const assessment = assessStaffPayUpdate(targetStaffPay, released);
  if (assessment.reason === 'below_released') {
    throw new ApiError(
      409,
      `กำหนดค่าจ้างต่ำกว่ายอดที่ปล่อยไปแล้วไม่ได้ — ปล่อยไปแล้ว ${assessment.released.toLocaleString('th-TH')} บาท`,
    );
  }

  return { current, mode, ...assessment };
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
    if (values.staff_pay == null) values.staff_pay = await payFromService(input, tx);

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

  await transaction(async (tx) => {
    const payState = await staffPayUpdateForTransaction(tx, caseId, input);
    const { current, mode: payMode } = payState;

    // manager ส่ง null หรือมีการเปลี่ยนตัวเลือกบริการจริงโดยไม่ได้ส่งค่าจ้าง = ใช้ค่าจากบริการใหม่
    // note-only PATCH / ฟอร์มเต็มของ HR ที่ตัวเลือกเดิมไม่เปลี่ยน = preserve ค่าพิเศษเดิม
    if (payMode !== 'preserve') {
      if (!fields.includes('staff_pay')) fields.push('staff_pay');
      values.staff_pay = payState.staff_pay;
    }

    const changed = changedLabels(current, values, fields);

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

    /* คนที่ถูกตั้งเป็นผู้รับผิดชอบหลัก ต้องไม่ค้างอยู่ในทีมด้วย — ไม่งั้นชื่อเดียวโผล่สองที่บนหน้าจอ
       และตอนถอดคนหลักออก ระบบจะ "เลื่อนคนเดิมขึ้นมาแทนตัวเอง" วนอยู่แบบนั้น */
    await tx.run('DELETE FROM case_team WHERE case_id = :case_id AND employee_id = :employee_id', {
      case_id: caseId,
      employee_id: employeeId,
    });

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
    /* กะที่ยังไม่ได้ไปทำต้องถูกยกเลิกตามไปด้วย — ไม่งั้นมันค้างอยู่บนปฏิทินและในรายการงานของพนักงาน
       ทั้งที่เคสถูกยกเลิกไปแล้ว คนที่เปิดตารางงานดูจะเดินทางไปบ้านลูกค้าที่ยกเลิกไปแล้วจริงๆ

       ไม่แตะกะที่เช็คอินไปแล้ว: นั่นคือการทำงานที่เกิดขึ้นจริงและเป็นฐานค่าจ้าง ต้องคงไว้ตามเดิม */
    const { n } = await tx.one(
      `WITH cancelled AS (
         UPDATE case_visits
         SET status = 'cancelled', updated_at = ${NOW}
         WHERE case_id = :case_id AND status <> 'cancelled' AND check_in_at IS NULL
         RETURNING 1
       )
       SELECT COUNT(*) AS n FROM cancelled`,
      { case_id: caseId },
    );

    const dropped = Number(n) > 0 ? ` — ยกเลิกกะที่ยังไม่ได้ไป ${Number(n)} กะด้วย` : '';
    await logEvent(
      tx,
      caseId,
      'cancelled',
      (reason ? `ยกเลิกเคส — ${reason}` : 'ยกเลิกเคส') + dropped,
      actor,
    );
  });

  return findById(caseId);
}

// ---------- ทีมพนักงานของเคส (นอกเหนือจากผู้รับผิดชอบหลัก) ----------

/** คนในทีม พร้อมข้อมูลติดต่อ — เรียงตามลำดับที่ถูกเพิ่มเข้ามา */
export function listTeam(caseId) {
  return sql.all(
    `SELECT t.employee_id, t.added_at,
            e.first_name || ' ' || e.last_name AS name,
            e.nickname, e.position, e.phone
     FROM case_team t
     JOIN employees e ON e.employee_id = t.employee_id
     WHERE t.case_id = :id
     ORDER BY t.added_at, t.employee_id`,
    { id: caseId },
  );
}

/**
 * เพิ่มคนเข้าทีม — คนที่เป็นผู้รับผิดชอบหลักอยู่แล้วไม่ต้องเพิ่มซ้ำ (คืน false ให้ route ตอบ 409)
 * กดซ้ำ/สองคนกดพร้อมกันได้แถวเดียวเสมอ (PRIMARY KEY คุมไว้ + ON CONFLICT DO NOTHING)
 */
export async function addTeamMember(caseId, employeeId, actor) {
  return transaction(async (tx) => {
    const row = await tx.one('SELECT assigned_to FROM cases WHERE case_id = :id', { id: caseId });
    if (row?.assigned_to === employeeId) return false;

    const added = await tx.run(
      `INSERT INTO case_team (case_id, employee_id, added_by)
       VALUES (:case_id, :employee_id, :actor)
       ON CONFLICT DO NOTHING`,
      { case_id: caseId, employee_id: employeeId, actor: actor?.employee_id ?? null },
    );
    if (added === 0) return false; // อยู่ในทีมอยู่แล้ว

    await logEvent(tx, caseId, 'assigned', `เพิ่ม ${await staffLabel(tx, employeeId)} เข้าทีมดูแลเคส`, actor);
    return true;
  });
}

/** นำคนออกจากทีม — ไม่แตะผู้รับผิดชอบหลัก (คนหลักถอดด้วย unassign เท่านั้น) */
export async function removeTeamMember(caseId, employeeId, actor) {
  return transaction(async (tx) => {
    const removed = await tx.run(
      'DELETE FROM case_team WHERE case_id = :case_id AND employee_id = :employee_id',
      { case_id: caseId, employee_id: employeeId },
    );
    if (removed === 0) return false;

    await logEvent(tx, caseId, 'unassigned', `นำ ${await staffLabel(tx, employeeId)} ออกจากทีมดูแลเคส`, actor);
    return true;
  });
}

export async function unassign(caseId, actor) {
  await transaction(async (tx) => {
    const previous = await tx.one('SELECT assigned_to FROM cases WHERE case_id = :id', { id: caseId });

    /* ยังมีคนในทีมอยู่ = เคสนี้ยังมีคนดูแล ไม่ใช่เคสไร้คน — เลื่อนคนที่อยู่มานานที่สุดขึ้นเป็นหลัก
       ถ้าปล่อยให้ assigned_to ว่างทั้งที่ทีมยังอยู่ สถานะจะกลายเป็น "ยังไม่จับคู่พนักงาน"
       แล้วเคสจะไปโผล่ในคิวรอจับคู่ทั้งที่มีคนไปทำงานอยู่จริง */
    const next = await tx.one(
      'SELECT employee_id FROM case_team WHERE case_id = :id ORDER BY added_at, employee_id LIMIT 1',
      { id: caseId },
    );

    const from = previous?.assigned_to ? await staffLabel(tx, previous.assigned_to) : null;

    if (next) {
      await tx.run(
        `UPDATE cases SET assigned_to = :employee_id, assigned_at = ${NOW}, updated_at = ${NOW}
         WHERE case_id = :case_id`,
        { case_id: caseId, employee_id: next.employee_id },
      );
      await tx.run('DELETE FROM case_team WHERE case_id = :case_id AND employee_id = :employee_id', {
        case_id: caseId,
        employee_id: next.employee_id,
      });

      const to = await staffLabel(tx, next.employee_id);
      await logEvent(tx, caseId, 'assigned', `ถอด ${from} ออก และเลื่อน ${to} ขึ้นเป็นผู้รับผิดชอบหลัก`, actor);
      return;
    }

    await tx.run(
      `UPDATE cases
       SET assigned_to = NULL, status = 'unassigned', assigned_at = NULL, updated_at = ${NOW}
       WHERE case_id = :case_id`,
      { case_id: caseId },
    );
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
    /* เดิมตรงนี้ "ตรึงค่าจ้าง" ลงทุกกะที่เช็คอินแล้ว (staff_pay / จำนวนกะที่นัดไว้) เพราะยอดต่อกะ
       เป็นการเกลี่ยสดที่ขยับตามตัวหารได้ตลอด การปิดเคสจึงต้องล็อกตัวเลขไว้ก่อนที่ตัวหารจะเปลี่ยน
       ตอนนี้ไม่มีการเกลี่ยแล้ว — ค่าจ้างเป็นก้อนเดียวที่ผู้จัดการกดปล่อยเอง และยอดที่ปล่อยแล้ว
       เป็นตัวเลขตายตัวตั้งแต่วินาทีที่ปล่อย (ดู releasePay) จึงไม่มีอะไรให้ตรึงอีก */

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

    const note = dropped > 0 ? `ปิดเคส · ยกเลิกกะที่ยังไม่ถึงวัน ${dropped} กะ` : 'ปิดเคส';
    await logEvent(tx, caseId, 'closed', note, actor);
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
 * ค่าจ้างพนักงานไม่ผูกกับกะอีกต่อไป — เป็น "ก้อนเดียวต่อเคส" ที่ผู้จัดการกดปล่อย (ดู releasePay)
 *
 * เดิมมี VISIT_PAY = COALESCE(v.staff_pay, c.staff_pay / จำนวนกะที่นัดไว้) ซึ่งแปลว่า
 * เคส 20,000 นัด 10 ครั้ง = ครั้งละ 2,000 — ไม่ตรงกับวิธีตกลงงานจริง (ตกลงกันเป็นค่าจ้างของงานทั้งชิ้น)
 * และตัวหารขยับได้ตลอด ยอดของกะที่ทำไปแล้วจึงเปลี่ยนย้อนหลังทุกครั้งที่เพิ่ม/ยกเลิกกะ
 *
 * ตอนนี้กะทำหน้าที่เดียวคือบันทึกว่า "ใครไปทำงานวันไหน กี่ชั่วโมง" ซึ่งเป็นฐานของ
 * สัดส่วนการแบ่งตอนปล่อยค่าจ้าง ไม่ใช่ตัวคูณของเงิน
 */

/** กะที่ยังไม่ถูกยกเลิก — กะที่ยกเลิกไม่นับเป็นงานที่ทำจริงทั้งในรายงานและในการแบ่งค่าจ้าง */
export const NOT_CANCELLED = `v.status <> 'cancelled'`;

/** กะทั้งหมดของเคสหนึ่งใบ พร้อมชื่อพนักงานที่นัดไว้ + สถานะเช็คอิน (state คำนวณตอนอ่าน) — เรียงตามวัน/เวลานัด */
export function listVisits(caseId) {
  return sql
    .all(
      `SELECT v.visit_id, v.case_id, v.visit_date, v.status, v.note,
              v.assigned_to, v.planned_start, v.planned_end,
              v.check_in_at, v.check_out_at, v.check_in_distance_m, v.location_flagged,
              v.check_in_late_minutes, v.off_schedule,
              v.pay_status, v.pay_note, v.approved_by_name,
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
         (SELECT COUNT(*) FROM case_reports r WHERE r.visit_id = v.visit_id)::int AS report_count,
         c.status AS case_status, c.case_type, c.client_name, c.address, c.client_phone,
         c.service_kind, c.start_date, c.end_date,
         c.geo_lat AS case_geo_lat, c.geo_lng AS case_geo_lng, c.geofence_radius_m AS case_radius,
         c.medical_history, c.current_symptoms, c.medical_devices, c.care_goal,
         c.patient_gender, c.patient_age,
         f.name  AS format_name, g.name AS grade_name,
         c.physio_package_id,
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

/**
 * ไบนารีรูปเซลฟี่ของกะ — ดึงเฉพาะตอนหน้าเว็บขอรูปจริง
 *
 * caseId = บังคับว่ากะต้องอยู่ในเคสนั้นจริง (เส้นของ admin ที่ path เป็น /cases/:id/visits/:visitId)
 * ไม่ส่งมา = ผู้เรียกตรวจสิทธิ์เองมาแล้ว (ฝั่งพนักงานภาคสนามเทียบ assigned_to ก่อนเรียก)
 * ต้องกันที่นี่ด้วย ไม่ใช่เชื่อว่า path ถูกเสมอ — เส้นพี่น้องกัน (/adjust) เทียบ case_id อยู่แล้ว
 * ปล่อยให้ต่างกันไว้ วันหนึ่งจะมีคนอ่านเส้นนี้แล้วเข้าใจว่า :id ถูกใช้กรองด้วย ซึ่งไม่จริง
 */
export const findVisitPhoto = (visitId, caseId = null) =>
  sql.one(
    `SELECT check_in_photo_data AS data, check_in_photo_mime AS mime
     FROM case_visits
     WHERE visit_id = :id AND check_in_photo_data IS NOT NULL
       AND (:case_id::text IS NULL OR case_id = :case_id)`,
    { id: visitId, case_id: caseId },
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
              ROUND(EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at)) / 60) AS worked_minutes,
              c.client_name, c.status AS case_status,
              v.checked_in_by AS employee_id,
              ${WORKER_NAME} AS employee_name
       FROM case_visits v
       JOIN cases c     ON c.case_id     = v.case_id
       LEFT JOIN employees e ON e.employee_id = v.checked_in_by
       WHERE ${where.join(' AND ')}
       ORDER BY v.visit_date DESC, v.check_in_at DESC`,
      params,
    )
    .then((rows) =>
      rows.map((r) => ({
        ...r,
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

  /* ช่องที่เป็น "ฐานของค่าจ้าง" — เวลาเข้า/ออกและสถานะกะ คือสิ่งที่คิวอนุมัติเอาไปตัดสิน
     ส่วนธงนอกพื้นที่เป็นเรื่องของการตรวจสอบ ไม่กระทบยอดเงิน จึงแก้ได้เสมอ */
  const touchesPayBasis = ['check_in_at', 'check_out_at', 'status'].some((col) => col in input);

  const outcome = await transaction(async (tx) => {
    /* ล็อกกะไว้ก่อนอ่านสถานะค่าจ้าง — ไม่งั้นการอนุมัติที่กำลังวิ่งอยู่คนละคำขออาจแทรกกลาง
       ระหว่าง "อ่านว่ายังไม่อนุมัติ" กับ "เขียนทับเวลา" แล้วกลายเป็นอนุมัติยอดที่ไม่มีใครเคยเห็น */
    const before = await tx.one(
      `SELECT v.pay_status,
              (SELECT COALESCE(SUM(p.amount), 0) FROM case_payouts p WHERE p.case_id = v.case_id) AS released
       FROM case_visits v
       WHERE v.visit_id = :visit_id AND v.case_id = :case_id
       FOR UPDATE OF v`,
      { visit_id: visitId, case_id: caseId },
    );
    if (!before) return { reason: 'not_found' };

    /* เงินออกไปแล้วห้ามขยับฐานที่ใช้คิดเงิน — ยอดที่ปล่อยไปถูกตรึงไว้ก็จริง แต่ตัวเลขชั่วโมง/กะ
       ที่เป็น "ที่มาของยอด" ต้องยังตรงกับของจริง ไม่งั้นสลิปที่จ่ายไปแล้วอธิบายตัวเองไม่ได้อีก
       (ถ้าลงเวลาผิดจริงและต้องแก้ ให้ถอนงวดที่ปล่อยคืนก่อน แล้วค่อยแก้เวลา) */
    if (touchesPayBasis && Number(before.released) > 0) {
      return { reason: 'pay_released', released: Number(before.released) };
    }

    /* อนุมัติไปแล้วแต่ยังไม่ปล่อยเงิน — แก้ได้ แต่การอนุมัติเดิมใช้ไม่ได้แล้ว
       เพราะมันคือการอนุมัติ "ตัวเลขชุดก่อนแก้" ดึงกลับเป็นรออนุมัติให้คนตรวจเห็นอีกรอบ
       (ปล่อยให้ค้างเป็น approved คือการอนุมัติย้อนหลังให้ตัวเองโดยไม่มีใครรู้) */
    const reopenApproval = touchesPayBasis && before.pay_status === 'approved';
    if (reopenApproval) sets.push(`pay_status = 'pending'`);

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
        `แก้กะวันที่ ${visit.visit_date}${touched.length ? ` — ${touched.join(', ')}` : ''}` +
          (reopenApproval ? ' (ดึงกลับเป็นรออนุมัติค่าจ้าง)' : ''),
        typeof admin === 'string' ? { employee_id: adminId, name: await staffName(tx, adminId) } : admin,
      );
    }
    return { reopened: reopenApproval };
  });

  if (outcome?.reason) return outcome;
  return { ...(await findVisit(visitId)), reopened_approval: outcome.reopened };
}

/**
 * กะที่ทำจบแล้ว (เช็คอินและเช็คเอาท์ครบ) ในเดือนที่ขอ — ฐานของทั้งชั่วโมงและค่าจ้าง
 * รวม join ชื่อบริการ (f/g/pp) ไว้ด้วย เพราะ WHERE อยู่ในก้อนนี้แล้ว ผู้เรียกจึงต่อ JOIN เพิ่มทีหลังไม่ได้
 */
const WORKED_SHIFT = `
  FROM case_visits v
  JOIN cases c     ON c.case_id     = v.case_id
  LEFT JOIN employees e ON e.employee_id = v.checked_in_by
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
export const WORKER_NAME = `COALESCE(e.first_name || ' ' || e.last_name, '(พนักงานที่ถูกลบแล้ว)')`;

/** กะที่ทำจบแล้ว = ฐานของชั่วโมง · กะที่อนุมัติแล้ว = ฐานของสัดส่วนตอนแบ่งค่าจ้าง */
const DONE = `v.check_out_at IS NOT NULL`;
const PAYABLE = `${DONE} AND v.pay_status = 'approved'`;
const AWAITING = `${DONE} AND v.pay_status = 'pending'`;

/**
 * ยอดที่ปล่อยแล้วก้อนนี้ เงินออกไปจริงหรือยัง = อยู่ในรอบจ่าย "ที่ปิดจ่ายแล้ว" หรือเปล่า
 *
 * ต้องไล่ถึง payroll_runs.status ไม่ใช่ดูแค่ว่ามีแถวใน payroll_payout_lines ไหม — แถวนั้นเกิดตั้งแต่
 * ตอนเปิดรอบซึ่งยังเป็นร่าง ยังปรับรายชื่อ/ยกเลิกทั้งรอบได้อยู่ ถ้านับเป็นจ่ายแล้วตั้งแต่ตรงนั้น
 * หน้าของพนักงานจะขึ้นว่า "โอนแล้ว" ทันทีที่ผู้จัดการกดเปิดรอบ ทั้งที่ยังไม่มีเงินออกจากบริษัท
 */
const PAYOUT_SETTLED = `EXISTS (
  SELECT 1 FROM payroll_payout_lines pl
  JOIN payroll_items pi ON pi.item_id = pl.item_id
  JOIN payroll_runs  pr ON pr.run_id  = pi.run_id
  WHERE pl.payout_id = p.payout_id AND pr.status = 'paid'
)`;

/**
 * สรุปค่าตอบแทนรายเดือนต่อพนักงาน
 *
 * สองฐานคนละก้อน รวมกันตอนท้าย เพราะมันตอบคนละคำถาม:
 *   ชั่วโมง/กะ = case_visits ของเดือนที่ "เช็คอิน" (ไปทำงานวันไหนบ้าง กี่ชั่วโมง)
 *   เงิน       = case_payouts ของเดือนที่ "ปล่อยค่าจ้าง" (ได้เงินเท่าไหร่)
 *
 * เดิมสองอย่างนี้มาจาก query เดียวกันเพราะเงินผูกกับกะ (เกลี่ย staff_pay หารจำนวนกะ)
 * พอค่าจ้างเป็นก้อนเดียวต่อเคส มันไม่ผูกกันอีกแล้ว — เคสที่ทำข้ามเดือนแล้วปล่อยเงินเดือนถัดไป
 * จะมีชั่วโมงอยู่เดือนหนึ่งและเงินอยู่อีกเดือนหนึ่ง ซึ่งตรงกับความจริงมากกว่าการยัดให้อยู่เดือนเดียวกัน
 *
 * employeeId = ดูของคนเดียว (ฝั่งพนักงานภาคสนามที่เห็นได้เฉพาะของตัวเอง) — ไม่ส่ง = ทุกคน (admin)
 */
export async function attendanceReport(month, employeeId = null) {
  // ใส่เงื่อนไข (และพารามิเตอร์) เฉพาะตอนใช้จริง — ตัวแปลง :name ไล่หาชื่อจาก SQL ที่มีอยู่จริงเท่านั้น
  const shiftParams = { month };
  const payParams = { month };
  if (employeeId) {
    shiftParams.emp = employeeId;
    payParams.emp = employeeId;
  }

  const [shiftRows, payRows] = await Promise.all([
    sql.all(
      `SELECT v.checked_in_by AS employee_id,
              ${WORKER_NAME} AS employee_name,
              COUNT(*) FILTER (WHERE ${DONE})                    AS shifts,
              COUNT(DISTINCT v.case_id) FILTER (WHERE ${DONE})   AS cases_worked,
              COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at)) / 60)
                       FILTER (WHERE ${DONE})), 0)               AS minutes,
              COUNT(*) FILTER (WHERE ${PAYABLE})                 AS approved_shifts,
              COUNT(*) FILTER (WHERE ${AWAITING})                AS pending_shifts,
              COUNT(*) FILTER (WHERE ${DONE} AND v.pay_status = 'rejected') AS rejected_shifts
       ${WORKED_SHIFT}
         ${employeeId ? 'AND v.checked_in_by = :emp' : ''}
       GROUP BY v.checked_in_by, e.first_name, e.last_name`,
      shiftParams,
    ),
    sql.all(
      /* ปล่อยแล้วยังไม่ใช่ "ได้เงินแล้ว" — เงินออกจริงตอนรอบจ่ายถูกปิด (ดูโมดูล payroll)
         แยกสองตัวนี้ออกมาเพื่อให้ทั้งพนักงานและผู้จัดการตอบได้ว่ายังค้างจ่ายอยู่เท่าไหร่ */
      `SELECT p.employee_id,
              MAX(p.employee_name) AS employee_name,
              COALESCE(SUM(p.amount), 0) AS pay,
              COALESCE(SUM(p.amount) FILTER (WHERE ${PAYOUT_SETTLED}), 0)     AS paid_pay,
              COALESCE(SUM(p.amount) FILTER (WHERE NOT ${PAYOUT_SETTLED}), 0) AS unpaid_pay,
              COUNT(*)                                        AS payouts,
              COUNT(*) FILTER (WHERE ${PAYOUT_SETTLED})       AS paid_payouts,
              COALESCE(SUM(p.shifts), 0)  AS paid_shifts,
              COUNT(DISTINCT p.case_id)   AS cases_paid
       FROM case_payouts p
       WHERE substr(p.released_at, 1, 7) = :month
         ${employeeId ? 'AND p.employee_id = :emp' : ''}
       GROUP BY p.employee_id`,
      payParams,
    ),
  ]);

  /* รวมสองฝั่งด้วย employee_id — คนที่มีแต่ชั่วโมง (ยังไม่ปล่อยเงิน) หรือมีแต่เงิน
     (ปล่อยค่าจ้างของงานเดือนก่อน) ต้องขึ้นทั้งคู่ ไม่ใช่หายไปเพราะอีกฝั่งไม่มีแถว */
    const merged = new Map();
  const blank = (id, name) => ({
    employee_id: id,
    employee_name: name,
    shifts: 0,
    cases_worked: 0,
    minutes: 0,
    approved_shifts: 0,
    pending_shifts: 0,
    rejected_shifts: 0,
    pay: 0,
    paid_pay: 0,
    unpaid_pay: 0,
    payouts: 0,
    paid_payouts: 0,
    paid_shifts: 0,
    cases_paid: 0,
  });

  for (const r of shiftRows) {
    merged.set(r.employee_id, {
      ...blank(r.employee_id, r.employee_name),
      shifts: Number(r.shifts),
      cases_worked: Number(r.cases_worked),
      minutes: Number(r.minutes),
      approved_shifts: Number(r.approved_shifts),
      pending_shifts: Number(r.pending_shifts),
      rejected_shifts: Number(r.rejected_shifts),
    });
  }

  for (const r of payRows) {
    const row = merged.get(r.employee_id) ?? blank(r.employee_id, r.employee_name);
    merged.set(r.employee_id, {
      ...row,
      employee_name: row.employee_name ?? r.employee_name,
      pay: Number(r.pay),
      paid_pay: Number(r.paid_pay),
      unpaid_pay: Number(r.unpaid_pay),
      payouts: Number(r.payouts),
      paid_payouts: Number(r.paid_payouts),
      paid_shifts: Number(r.paid_shifts),
      cases_paid: Number(r.cases_paid),
    });
  }

  return (
    [...merged.values()]
      // employee_name ว่างได้ถ้าพนักงานถูกลบถาวร (LEFT JOIN) — กัน localeCompare ล้มทั้งรายงาน
      .sort((a, b) => (a.employee_name ?? '').localeCompare(b.employee_name ?? '', 'th'))
  );
}

/**
 * เคสที่พนักงานคนหนึ่งลงแรงในเดือนนั้น พร้อมยอดรวมของกะที่ทำในเคสนั้น — ที่มาของยอดในสรุปค่าตอบแทน
 * ให้กางดูได้ว่าเงินมาจากเคสไหน กี่กะ ไม่ใช่เห็นแค่ตัวเลขก้อนเดียว
 */
export function payoutCases(month, employeeId) {
  return sql
    .all(
      /* LEFT JOIN case_payouts — เคสที่ลงแรงแล้วแต่ผู้จัดการยังไม่ปล่อยค่าจ้าง ต้องขึ้นด้วย
         (ยอดเป็น 0 พร้อมป้ายว่ายังไม่ปล่อย) ไม่ใช่หายไปจนพนักงานนึกว่าไม่ได้ถูกนับ
         นับเฉพาะยอดที่ปล่อยในเดือนที่ขอ ให้ตรงกับ pay ของ attendanceReport เดือนเดียวกัน */
      `SELECT c.case_id, c.title, c.client_name, c.case_type, c.service_kind, c.status,
              c.closed_at, c.start_date, c.end_date,
              COUNT(*) FILTER (WHERE ${DONE}) AS shifts,
              COUNT(*) FILTER (WHERE ${AWAITING}) AS pending_shifts,
              MAX(v.visit_date) AS last_visit_date,
              f.name  AS format_name, g.name AS grade_name,
              pp.name AS physio_package_name, pp.sessions AS physio_sessions,
              COALESCE((SELECT SUM(p.amount) FROM case_payouts p
                        WHERE p.case_id = c.case_id AND p.employee_id = :emp
                          AND substr(p.released_at, 1, 7) = :month), 0) AS pay,
              COALESCE((SELECT SUM(p.amount) FROM case_payouts p
                        WHERE p.case_id = c.case_id AND p.employee_id = :emp), 0) AS pay_all_time,
              /* ยอดของเดือนนี้เป็นงวดที่เท่าไหร่ของเคส (เดือนเดียวอาจได้สองงวดถ้าปล่อยถี่)
                 พนักงานที่ตกลงไว้ว่า "เคสนี้แบ่งสองงวด" ต้องอ่านออกว่าที่ได้ไปคืองวดไหน
                 ไม่ใช่เห็นแค่ตัวเลขก้อนหนึ่งแล้วต้องเดาเองว่าครบหรือยัง */
              (SELECT string_agg(x.no::text, ', ' ORDER BY x.no)
                 FROM (SELECT DISTINCT p.installment_no AS no FROM case_payouts p
                       WHERE p.case_id = c.case_id AND p.employee_id = :emp
                         AND substr(p.released_at, 1, 7) = :month) x) AS installments,
              COALESCE((SELECT MAX(p.installment_no) FROM case_payouts p
                        WHERE p.case_id = c.case_id), 0) AS case_installments
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
        pending_shifts: Number(r.pending_shifts),
        pay: Number(r.pay),
        pay_all_time: Number(r.pay_all_time),
        case_installments: Number(r.case_installments),
      })),
    );
}

// ---------- ปล่อยค่าจ้างของเคส (case_payouts) ----------

/**
 * คิวค่าจ้าง — เคสทุกใบที่มีเงินให้จัดการ พร้อมสถานะว่าปล่อยไปแล้วเท่าไหร่ เหลือกี่งวด
 *
 * มีไว้ให้หน้ารอบจ่ายทำงานเรื่องเงินได้จบในหน้าเดียว โดยไม่ต้องเด้งไปเปิดเคสทีละใบ —
 * เดิมการ "ปล่อยค่าจ้าง" ซ่อนอยู่ในหน้าเคส ซึ่งเป็นหน้าที่เปิดเพื่อดูเรื่องงาน (ตารางกะ รายงานอาการ)
 * คนที่กำลังทำเรื่องเงินจึงต้องสลับหน้าไปมาทีละเคส และไม่มีที่ไหนเลยที่เห็นภาพรวมว่า
 * "ตอนนี้มีเงินค้างต้องปล่อยกี่เคส รวมเท่าไหร่"
 *
 * เกณฑ์: ตั้งค่าจ้างไว้แล้ว + มีกะที่อนุมัติแล้วอย่างน้อยหนึ่งกะ (ไม่งั้นยังไม่รู้ว่าจะแบ่งให้ใคร)
 * pending = ยังปล่อยไม่ครบยอด · ส่งมาทั้งสองกลุ่มเพื่อให้ฝั่งหน้าจอสลับดู "ที่จ่ายครบแล้ว" ได้
 * โดยไม่ต้องยิงใหม่ (เคสทั้งระบบมีหลักร้อย ไม่ใช่หลักแสน — แบ่งหน้ายังไม่คุ้มความซับซ้อน)
 */
export function payQueue() {
  return sql
    .all(
      `SELECT c.case_id, c.title, c.client_name, c.status, c.staff_pay, c.fee,
              c.case_type, c.service_kind, c.closed_at, c.end_date,
              COALESCE(p.released, 0)     AS released,
              COALESCE(p.installments, 0) AS installments_used,
              COALESCE(w.workers, 0)      AS workers,
              w.worker_names,
              lv.last_visit_date
       FROM cases c
       LEFT JOIN (
         SELECT case_id, SUM(amount) AS released, MAX(installment_no) AS installments
         FROM case_payouts GROUP BY case_id
       ) p ON p.case_id = c.case_id

       /* คนที่จะได้เงินของเคสนี้ ต้องเป็นชุดเดียวกับที่แบ่งเงินจริง (ดู payShares) —
          ถ้านับแต่คนที่เช็คอิน เคสที่มอบหมายไว้แล้วแต่ยังไม่มีใครเช็คอินจะขึ้นว่า "0 คน"
          ทั้งที่กดปล่อยเงินได้และมีคนรับอยู่จริง ซึ่งอ่านแล้วเหมือนระบบพัง

          เอาชื่อมาด้วย ไม่ใช่แค่จำนวน — หน้านี้คือหน้าจ่ายเงิน คำถามแรกคือ "จ่ายให้ใคร"
          ส่วนเคสไหนนั้นรหัสเคสบอกอยู่แล้ว · UNION ตัดคนซ้ำให้ตั้งแต่ในตัวมันเอง */
       LEFT JOIN (
         SELECT u.case_id,
                COUNT(*)::int AS workers,
                string_agg(
                  COALESCE(e.first_name || ' ' || e.last_name, '(พนักงานที่ถูกลบแล้ว)'),
                  ' · ' ORDER BY e.first_name, e.last_name
                ) AS worker_names
         FROM (
           SELECT v.case_id, v.checked_in_by AS employee_id FROM case_visits v
           WHERE ${NOT_CANCELLED} AND v.checked_in_by IS NOT NULL
           UNION
           SELECT v.case_id, v.assigned_to FROM case_visits v
           WHERE ${NOT_CANCELLED} AND v.assigned_to IS NOT NULL
           UNION
           SELECT c2.case_id, c2.assigned_to FROM cases c2 WHERE c2.assigned_to IS NOT NULL
         ) u
         LEFT JOIN employees e ON e.employee_id = u.employee_id
         GROUP BY u.case_id
       ) w ON w.case_id = c.case_id

       LEFT JOIN (
         SELECT v.case_id, MAX(v.visit_date) AS last_visit_date
         FROM case_visits v WHERE ${NOT_CANCELLED}
         GROUP BY v.case_id
       ) lv ON lv.case_id = c.case_id

       WHERE c.staff_pay IS NOT NULL
         /* สามสถานะนี้เท่านั้น = เคสที่มีคนทำงานอยู่จริงหรือทำจบแล้ว
            ตัด unassigned ทิ้งเพราะยังไม่มีใครรับงาน จ่ายไปก็ไม่รู้จะจ่ายให้ใคร
            และตัด cancelled เพราะงานไม่ได้เกิดขึ้น */
         AND c.status IN ('assigned', 'in_progress', 'closed')
       /* เรียงเคสใหม่ไปเก่าตามวันที่สร้างเคส — ลำดับเดียวกับที่คนใช้งานคิดถึงรายการนี้
          ("เคสที่เพิ่งทำไปเมื่อกี้อยู่ไหน") และเป็นลำดับที่เดาได้โดยไม่ต้องรู้กติกาอะไรเลย

          ของเดิมเรียงตาม "ความเร่ง" (ปิดเคสแล้วยังค้างเงินขึ้นก่อน แล้วไล่ตามวันปิด/วันกะล่าสุด)
          ซึ่งอ่านออกยากเวลาไล่ทีละสิบแถว เพราะลำดับขึ้นกับสามเงื่อนไขที่มองไม่เห็นจากหน้าจอ
          และเคสที่เพิ่งสร้างจะไปโผล่กลางรายการ — สัญญาณความเร่งย้ายไปอยู่ที่ป้ายสถานะเงิน
          (ตามจ่ายอยู่ / จ่ายครบแล้ว) กับสวิตช์ซ่อนเคสที่จ่ายครบแล้วแทน ซึ่งเห็นได้ทีละแถวจริงๆ */
       ORDER BY c.created_at DESC, c.case_id DESC`,
    )
    .then((rows) =>
      rows.map((r) => {
        const total = Number(r.staff_pay);
        const released = Math.round(Number(r.released) * 100) / 100;
        return {
          ...r,
          staff_pay: total,
          fee: r.fee == null ? null : Number(r.fee),
          released,
          remaining: Math.round((total - released) * 100) / 100,
          installments_used: Number(r.installments_used),
          workers: Number(r.workers),
        };
      }),
    );
}

/**
 * หนึ่งเคสแบ่งจ่ายได้กี่งวด — เพดานอยู่ที่ชั้นนี้ ไม่ใช่ที่ฐานข้อมูล (ดูเหตุผลใน db/schema.sql)
 *
 * ค่าปริยายของการจ่ายคือ "ทีเดียวจบ" — เพดานนี้คือขอบบนของกรณีที่ตกลงกันว่าจะซอย
 * ไม่ใช่จำนวนงวดที่ทุกเคสต้องมี · เกินห้างวดคือการทยอยจ่ายทีละนิดจนทั้งพนักงานและผู้จัดการ
 * ไล่ไม่ทันว่าเคสหนึ่งจ่ายไปแล้วเท่าไหร่ เหลือเท่าไหร่
 */
export const MAX_INSTALLMENTS = 5;

/** ปัดเป็นสตางค์ — เงินไม่มีทศนิยมที่สาม และ 0.1 + 0.2 ของ JS ก็ไม่ควรโผล่มาในสลิป */
const round = (n) => Math.round(n * 100) / 100;

/**
 * น้ำหนักของแต่ละคนในการแบ่งค่าจ้างของเคส
 *
 * ค่าปริยาย = หารเท่ากันทุกคนที่อยู่ในเคสนี้ (สองคนคนละครึ่ง สามคนหารสาม)
 * ไม่ผูกกับจำนวนกะและไม่ผูกกับว่ากะถูกยืนยันหรือยัง — งานหนึ่งเคสไม่ได้แบ่งกันเป็นกะๆ
 * เท่าๆ กันอยู่แล้ว คนที่ไปน้อยครั้งอาจรับกะที่หนักกว่า และเรื่องพวกนี้ตกลงกันด้วยปากเปล่า
 * ไม่ได้อยู่ในตารางกะ · ตารางกะจึงเป็นเรื่องของ "การมาทำงาน" ไม่ใช่ตัวหารเงิน
 *
 * ถ้าตกลงกันไว้เป็นอย่างอื่น (case_pay_shares) ใช้ยอดที่ตกลงเป็นน้ำหนักแทน —
 * ตกลงกันว่า 9,000 กับ 6,000 ทุกงวดก็แบ่งกัน 60:40 ไม่ว่างวดนั้นจะปล่อยเท่าไหร่
 *
 * "มีข้อตกลง" ดูที่มีแถวไหม ไม่ใช่ดูว่ายอดมากกว่าศูนย์ไหม — ตั้ง 0 ให้ใครคือการตกลงว่า
 * คนนั้นไม่รับค่าจ้างของเคสนี้ ซึ่งต่างจากยังไม่เคยตั้ง
 */
export function weightsFor(shares) {
  const agreed = shares.some((r) => r.share != null);
  return shares.map((r) => (agreed ? (r.share ?? 0) : 1));
}

/**
 * แบ่งเงินของงวดหนึ่งให้ผู้รับหลายคน — "เกลี่ยให้ไล่ทันเป้าหมาย" ไม่ใช่แบ่งเฉพาะเงินก้อนนี้
 *
 * เคสที่มีพนักงานคนเดียวไม่มีอะไรต้องคิด แต่พอมีหลายคนแล้วแบ่งจ่ายหลายงวด การแบ่งเงิน
 * ทีละงวดโดยดูแค่งวดนั้นให้ผลที่ผิดถาวร เพราะรายชื่อคนที่ "พร้อมรับ" ของแต่ละงวดไม่เท่ากัน:
 *
 *   เคสค่าจ้าง 15,000 · สมชายกับสมหญิงตกลงหารครึ่ง (คนละ 7,500)
 *   งวดที่ 1 ปล่อย 7,000 ตอนที่สมหญิงยังไม่มีกะที่อนุมัติ → สมชายได้ 7,000 คนเดียว
 *   งวดที่ 2 ปล่อย 8,000 ตอนที่ทั้งคู่พร้อมแล้ว
 *     → ถ้าหารครึ่งเฉพาะงวดนี้: คนละ 4,000 · รวมทั้งเคส สมชาย 11,000 · สมหญิง 4,000
 *   ทั้งที่ตกลงกันว่าคนละครึ่ง และไม่มีใครเลือกให้เป็นแบบนั้น — มันเป็นผลข้างเคียงของ
 *   "วันที่กดปล่อยงวดแรก" ล้วนๆ ซึ่งไม่ควรมีผลกับใครได้เท่าไหร่
 *
 * ตัวนี้คิดจากปลายทางแทน: ถ้าเงินที่ปล่อยไปแล้วบวกงวดนี้คือ T แต่ละคนควรมีสะสม T×(น้ำหนักของตัวเอง/น้ำหนักรวม)
 * ส่วนที่ยังขาดของแต่ละคนคือสิทธิ์ในงวดนี้ แล้วเอาเงินของงวดมาแบ่งตามส่วนที่ขาดนั้น
 *   → งวดที่ 2 ข้างบน: เป้าหมายคนละ 7,500 · สมชายขาด 500 สมหญิงขาด 7,500
 *     ได้ 500 กับ 7,500 · รวมทั้งเคสคนละ 7,500 พอดี — งวดหลังแก้ความเอียงของงวดก่อนให้เอง
 *
 * ใครที่ได้เกินส่วนของตัวเองไปแล้ว (ส่วนที่ขาดติดลบ) ถูกตัดเป็น 0 ไม่ใช่ให้เขาคืนเงิน —
 * เงินที่ออกไปแล้วเรียกคืนผ่านระบบไม่ได้ ทำได้แค่ไม่จ่ายเพิ่มจนกว่าคนอื่นจะไล่ทัน
 * (ถ้ายอดที่เหลือไม่พอให้ทุกคนถึงเป้า ทุกคนที่ยังขาดจะโดนหารลดตามส่วนเท่าๆ กัน)
 *
 * เศษการปัดตกที่ "คนสุดท้ายที่ยังมีส่วนได้" ไม่ใช่แถวสุดท้ายเฉยๆ — แถวสุดท้ายอาจเป็นคนที่ได้ 0
 * ในงวดนี้ การโยนเศษให้เขาคือการสร้างก้อนเงิน 1 สตางค์ที่ไม่มีเหตุผลจะอธิบาย
 */
export function allocateShares(shares, amount) {
  const weights = weightsFor(shares);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return [];

  // เป้าหมาย = เงินทั้งหมดของเคสที่จะปล่อยไปแล้วหลังจบงวดนี้ (ของเดิม + ของงวดนี้)
  const target = shares.reduce((s, r) => s + (r.paid ?? 0), 0) + amount;

  const rows = shares.map((r, i) => ({
    ...r,
    owed: Math.max(0, round((target * weights[i]) / totalWeight - (r.paid ?? 0))),
  }));

  /* ผลรวมของส่วนที่ขาดมากกว่า amount เสมอเมื่อ amount > 0 (พิสูจน์: ผลรวมก่อนตัดลบ = amount พอดี
     การตัดลบเป็นศูนย์มีแต่จะทำให้มากขึ้น) — เช็คไว้กัน amount = 0 ที่หลุดมาถึงตรงนี้ ไม่ให้หารศูนย์ */
  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);
  if (totalOwed === 0) return [];

  for (const r of rows) r.amount = round((amount * r.owed) / totalOwed);

  const receivers = rows.filter((r) => r.owed > 0);
  const allocated = receivers.slice(0, -1).reduce((s, r) => s + r.amount, 0);
  receivers[receivers.length - 1].amount = round(amount - allocated);

  return rows;
}

/**
 * สถานะค่าจ้างของเคสหนึ่งใบ — ผู้จัดการต้องเห็นก่อนกดปล่อยว่าเหลือเท่าไหร่ และจะแบ่งให้ใครบ้าง
 *
 * released = ปล่อยไปแล้วรวมเท่าไหร่ · remaining = ยอดเหมาลบที่ปล่อยไปแล้ว
 * split    = ถ้ากดปล่อยยอดคงเหลือตอนนี้ ใครจะได้เท่าไหร่ (สัดส่วนตามกะที่อนุมัติแล้ว)
 *
 * ตัวเลขชุด installment_* คือกติกา "แบ่งจ่ายได้ไม่เกิน 3 งวดต่อเคส" ที่ต้องเห็นก่อนกด
 * ไม่ใช่ไปเจอตอนถูกปฏิเสธ — เพราะงวดสุดท้ายคือจุดที่ตัดสินใจกลับไม่ได้: กรอกน้อยกว่ายอดคงเหลือ
 * แล้วเงินส่วนที่เหลือจะปล่อยไม่ได้อีกเลย ต้องถอนงวดที่ปล่อยผิดคืนก่อนถึงจะแก้ได้
 */
export async function payStatus(caseId) {
  const [row, split, payouts] = await Promise.all([
    sql.one(
      /* นับงวดจาก MAX ไม่ใช่ COUNT — ถอนงวดกลางคืนแล้วเลขงวดของงวดหลังต้องไม่เลื่อนตาม
         (ถ้านับจำนวนแถว งวดที่ 3 จะกลายเป็นงวดที่ 2 ทั้งที่บนสลิปที่ปล่อยไปแล้วเขียนว่า 3) */
      `SELECT c.staff_pay, c.fee,
              COALESCE((SELECT SUM(p.amount) FROM case_payouts p WHERE p.case_id = c.case_id), 0) AS released,
              COALESCE((SELECT MAX(p.installment_no) FROM case_payouts p WHERE p.case_id = c.case_id), 0) AS last_installment
       FROM cases c WHERE c.case_id = :id`,
      { id: caseId },
    ),
    payShares(sql, caseId),
    listPayouts(caseId),
  ]);
  if (!row) return null;

  const total = row.staff_pay == null ? null : Number(row.staff_pay);
  const fee = row.fee == null ? null : Number(row.fee);
  const released = round(Number(row.released));
  const last = Number(row.last_installment);

  /* ข้อตกลงส่วนแบ่ง: มีแถวไหม และรวมแล้วเท่ากับค่าจ้างของเคสหรือเปล่า
     ไม่ตรงได้จริงเมื่อค่าจ้างของเคสถูกแก้ทีหลัง หรือคนที่ตกลงไว้ถูกลบออกจากทะเบียน —
     ปล่อยต่อได้ (สัดส่วนยังใช้ได้) แต่ต้องฟ้อง ไม่ใช่เกลี่ยเงียบๆ ตามตัวเลขที่ไม่มีใครยืนยันแล้ว */
  const agreedRows = split.filter((r) => r.share != null);
  const agreedTotal = agreedRows.length ? round(agreedRows.reduce((n, r) => n + r.share, 0)) : null;

  return {
    staff_pay: total,

    /* ค่าบริการที่เก็บลูกค้า กับส่วนที่เหลืออยู่ที่บริษัท — ไม่ได้เก็บเป็นช่องของตัวเอง
       คำนวณจาก fee - staff_pay ตอนอ่าน จึงไม่มีวันขัดกันเอง (ดูเหตุผลใน db/schema.sql)
       ต้องเห็นตรงนี้เพราะคนตั้งยอดคิดเป็น "เคส 20,000 บริษัทเอา 5,000 พนักงานได้ 15,000"
       ไม่ใช่ "staff_pay = 15,000" ลอยๆ ที่ไม่รู้ว่าเทียบกับอะไร */
    fee,
    company_share: fee == null || total == null ? null : round(fee - total),

    has_agreement: agreedRows.length > 0,
    agreed_total: agreedTotal,
    agreement_matches: agreedTotal == null || total == null ? true : agreedTotal === round(total),

    released,
    remaining: total == null ? null : round(total - released),
    shares: split,
    payouts,

    max_installments: MAX_INSTALLMENTS,
    installments_used: last,
    // เคสเก่าที่ปล่อยเกิน 3 งวดมาก่อนกติกานี้มีอยู่จริง — คุมไม่ให้เหลือติดลบ
    installments_left: Math.max(0, MAX_INSTALLMENTS - last),
    next_installment: last + 1,
    is_final_installment: last + 1 === MAX_INSTALLMENTS,
  };
}

/**
 * ผู้มีส่วนได้ของเคสนี้ = ทุกคนที่อยู่ในเคส ไม่ว่ากะจะครบหรือถูกยืนยันแล้วหรือยัง
 *
 * รวมสี่ทาง: คนที่เคยเช็คอิน · คนที่ถูกนัดกะไว้ · คนที่ถูกมอบหมายทั้งเคส · คนที่เคยได้เงินของเคสนี้
 * (บวกคนที่ตั้งส่วนแบ่งไว้) — เกณฑ์เดิมคือ "ต้องมีกะที่อนุมัติแล้ว" ซึ่งแปลว่าเคสที่พนักงาน
 * ลืมเช็คอินทั้งเคส จ่ายเงินไม่ได้เลยทั้งที่งานเกิดขึ้นจริงและเคสปิดไปแล้ว
 *
 * ตารางกะเป็นเรื่องของ "การมาทำงาน" — มีไว้ตรวจว่าใครมาสาย/ขาด ไม่ใช่ประตูของเงิน
 * ประตูของเงินคือคนกดปล่อย ซึ่งเป็นการตัดสินใจของผู้จัดการที่เห็นงานจริงอยู่แล้ว
 *
 * ต้องรวมคนที่เคยได้เงินไปแล้วเสมอ แม้ตอนนี้จะไม่มีกะเหลืออยู่ (กะถูกยกเลิกทีหลัง) —
 * ไม่งั้นเงินที่จ่ายให้เขาไปแล้วจะหายจากฐานการเกลี่ย แล้วงวดถัดไปจะคิดเป้าหมายของคนอื่นต่ำกว่าจริง
 *
 * paid = ได้ไปแล้วเท่าไหร่จากเคสนี้ (ทุกงวดรวมกัน) คือฐานของการเกลี่ยใน allocateShares
 */
function payShares(tx, caseId) {
  return tx
    .all(
      /* รวมรายชื่อจากสามทางก่อน แล้วค่อยดึงตัวเลขของแต่ละทางมาแปะ — เขียนเป็น FULL OUTER JOIN
         ซ้อนกันสามชั้นได้เหมือนกัน แต่ COALESCE ของ employee_id จะยาวจนอ่านไม่ออกว่าใครคือใคร */
      `WITH people AS (
         SELECT v.checked_in_by AS employee_id FROM case_visits v
         WHERE v.case_id = :id AND ${NOT_CANCELLED} AND v.checked_in_by IS NOT NULL
         UNION
         SELECT v.assigned_to FROM case_visits v
         WHERE v.case_id = :id AND ${NOT_CANCELLED} AND v.assigned_to IS NOT NULL
         UNION
         SELECT c.assigned_to FROM cases c
         WHERE c.case_id = :id AND c.assigned_to IS NOT NULL
         UNION
         SELECT p.employee_id FROM case_payouts p
         WHERE p.case_id = :id AND p.employee_id IS NOT NULL
         UNION
         SELECT sh.employee_id FROM case_pay_shares sh WHERE sh.case_id = :id
       ),
       /* จำนวนกะที่ทำจบแล้วจริง — เก็บไว้เป็นข้อมูลประกอบเท่านั้น ไม่ได้เอาไปคิดเงิน
          (ไม่กรองด้วย pay_status แล้ว เพราะการยืนยันกะไม่ใช่ประตูของเงินอีกต่อไป) */
       worked AS (
         SELECT v.checked_in_by AS employee_id,
                COUNT(*)::int   AS shifts,
                GREATEST(0, COALESCE(ROUND(SUM(
                  EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at)) / 60)), 0))::int AS minutes
         FROM case_visits v
         WHERE v.case_id = :id
           AND v.check_out_at IS NOT NULL
           AND ${NOT_CANCELLED}
           AND v.checked_in_by IS NOT NULL
         GROUP BY v.checked_in_by
       ),
       received AS (
         SELECT p.employee_id,
                MAX(p.employee_name) AS employee_name,
                SUM(p.amount)        AS paid
         FROM case_payouts p
         WHERE p.case_id = :id AND p.employee_id IS NOT NULL
         GROUP BY p.employee_id
       )
       SELECT pe.employee_id,
              /* ไล่จากชื่อในทะเบียนก่อน แล้วค่อยชื่อ ณ ตอนที่ปล่อยเงิน — ใช้ WORKER_NAME ตรงๆ ไม่ได้
                 เพราะมันมีตัวสำรองเป็น "(พนักงานที่ถูกลบแล้ว)" อยู่ในตัวแล้ว ชื่อจริงที่เก็บไว้บนก้อนเงิน
                 จึงไม่มีวันได้ใช้ ทั้งที่มันคือสิ่งเดียวที่บอกได้ว่าเงินก้อนนั้นเคยจ่ายให้ใคร */
              COALESCE(e.first_name || ' ' || e.last_name, r.employee_name, '(พนักงานที่ถูกลบแล้ว)') AS employee_name,
              COALESCE(w.shifts, 0)  AS shifts,
              COALESCE(w.minutes, 0) AS minutes,
              COALESCE(r.paid, 0)    AS paid,
              sh.share               AS share
       FROM people pe
       LEFT JOIN worked   w  ON w.employee_id  = pe.employee_id
       LEFT JOIN received r  ON r.employee_id  = pe.employee_id
       LEFT JOIN case_pay_shares sh ON sh.case_id = :id AND sh.employee_id = pe.employee_id
       LEFT JOIN employees e ON e.employee_id = pe.employee_id
       ORDER BY COALESCE(w.shifts, 0) DESC, pe.employee_id`,
      { id: caseId },
    )
    .then((rows) =>
      rows.map((r) => ({
        ...r,
        shifts: Number(r.shifts),
        minutes: Number(r.minutes),
        paid: round(Number(r.paid)),
        // null = ยังไม่เคยตั้งข้อตกลงให้คนนี้ · 0 = ตกลงว่าไม่รับ — สองอย่างนี้ต้องไม่ยุบเป็นค่าเดียวกัน
        share: r.share == null ? null : round(Number(r.share)),
      })),
    );
}

/**
 * ตั้ง (หรือล้าง) ข้อตกลงส่วนแบ่งของเคส — ส่งรายการว่างมา = กลับไปหารเท่ากันตามปกติ
 *
 * เขียนทับทั้งชุดเสมอ ไม่ใช่แก้ทีละคน เพราะส่วนแบ่งเป็นของที่ต้องมองพร้อมกันทั้งเคส:
 * แก้ของคนหนึ่งโดยไม่แตะคนอื่น = ผลรวมไม่ตรงกับค่าจ้างของเคสทันที
 */
export function setPayShares(caseId, rows, actor) {
  return transaction(async (tx) => {
    const people = await payShares(tx, caseId);
    const nameOf = (id) => people.find((r) => r.employee_id === id)?.employee_name ?? id;

    await tx.run('DELETE FROM case_pay_shares WHERE case_id = :id', { id: caseId });

    for (const r of rows) {
      await tx.run(
        `INSERT INTO case_pay_shares (case_id, employee_id, share, updated_by, updated_by_name)
         VALUES (:case_id, :emp, :share, :by, :by_name)`,
        {
          case_id: caseId,
          emp: r.employee_id,
          share: round(r.share),
          by: actor?.employee_id ?? null,
          by_name: actor?.name ?? null,
        },
      );
    }

    await logEvent(
      tx,
      caseId,
      'pay_shares',
      rows.length === 0
        ? 'ล้างข้อตกลงส่วนแบ่ง — กลับไปหารเท่ากันทุกคน'
        : `ตั้งส่วนแบ่งค่าจ้าง — ${rows
            .map((r) => `${nameOf(r.employee_id)} ${round(r.share).toLocaleString('th-TH')}`)
            .join(' · ')}`,
      actor,
    );
  }).then(() => payStatus(caseId));
}

/** ยอดที่ปล่อยไปแล้วของเคส พร้อมสถานะว่าเข้ารอบจ่ายไปหรือยัง */
export function listPayouts(caseId) {
  return sql
    .all(
      `SELECT p.payout_id, p.installment_no, p.employee_id, p.employee_name, p.amount, p.shifts, p.minutes,
              p.due_date, p.released_at, p.released_by_name, p.note,
              pi.run_id, pr.status AS run_status
       FROM case_payouts p
       LEFT JOIN payroll_payout_lines pl ON pl.payout_id = p.payout_id
       LEFT JOIN payroll_items pi ON pi.item_id = pl.item_id
       LEFT JOIN payroll_runs  pr ON pr.run_id  = pi.run_id
       WHERE p.case_id = :id
       ORDER BY p.payout_id DESC`,
      { id: caseId },
    )
    .then((rows) =>
      rows.map((r) => ({ ...r, amount: Number(r.amount), installment_no: Number(r.installment_no) })),
    );
}

/**
 * ปล่อยค่าจ้างของเคสหนึ่งงวด แล้วแบ่งตามสัดส่วนกะที่แต่ละคนทำจริง
 *
 * ยอดที่ปล่อยกลายเป็นตัวเลขตายตัวทันที ไม่คิดสดจากอะไรอีกเลย — แก้ค่าจ้างของเคสทีหลัง
 * หรือเพิ่ม/ลบกะทีหลัง ก็ไม่กระทบยอดที่ปล่อยไปแล้ว (ต่างจากของเดิมที่ทุกอย่างขยับตลอดเวลา)
 *
 * หนึ่งครั้งที่กด = หนึ่งงวดของเคส (ไม่เกิน MAX_INSTALLMENTS งวด) ต่อให้แตกเป็นหลายแถวเพราะมี
 * ผู้รับหลายคน ทุกแถวก็ถือเลขงวดเดียวกัน — เคส 20,000 ที่ตกลงจ่ายสองงวดจึงอ่านได้ว่า
 * "งวดที่ 1 = 7,000 · งวดที่ 2 = 13,000" ไม่ใช่กองก้อนเงินที่ต้องมานั่งไล่จับคู่เอง
 *
 * เพดานงวดตรวจ "ในทรานแซกชันเดียวกับที่นับ" ไม่ใช่ตรวจที่ route แล้วค่อยมาเขียน:
 * ผู้จัดการสองคนกดปล่อยพร้อมกันคนละหน้าจอ ทั้งคู่จะอ่านเจอว่าเหลืออีกหนึ่งงวดเหมือนกัน
 * แล้วเคสก็จะมี 4 งวดโดยไม่มีอะไรฟ้อง (route ยังตรวจอยู่ ไว้ตอบข้อความที่อ่านรู้เรื่อง —
 * ชั้นนี้คือชั้นที่กันของจริง)
 *
 * shares (ไม่บังคับ) = ผู้จัดการกำหนดเองว่าใครได้เท่าไหร่ในงวดนี้ ไม่ส่งมา = ให้ระบบเกลี่ยให้
 * (ดู allocateShares) การเกลี่ยของระบบเป็น "ข้อเสนอ" เสมอ เพราะเงินที่ตกลงกับพนักงานแต่ละคน
 * เป็นเรื่องที่คุยกันเป็นรายกรณี — คนที่รับกะกลางคืนหรือเคสยาก อาจได้มากกว่าสัดส่วนกะของตัวเอง
 * ซึ่งไม่มีทางอนุมานจากข้อมูลในระบบได้เลย
 *
 * ผลรวมของ shares ต้องเท่ากับ amount เป๊ะ ไม่ใช่ "เอา amount ไปเกลี่ยตาม shares อีกที" —
 * ตัวเลขที่ผู้จัดการเห็นบนหน้าจอตอนกด ต้องเป็นตัวเลขเดียวกับที่ลงฐานข้อมูล ไม่มีการคิดใหม่ระหว่างทาง
 */
/**
 * ตรวจส่วนแบ่งที่ผู้จัดการกรอกเอง แล้วแปะข้อมูลผู้รับ (ชื่อ/กะ/นาที) กลับเข้าไป
 *
 * ตรวจสามอย่างที่พังแล้วเงียบ: จ่ายให้คนที่ไม่เกี่ยวกับเคสนี้ · ใส่ชื่อคนเดิมซ้ำสองบรรทัด
 * (สองแถวคนเดียวกันในงวดเดียว อ่านยังไงก็เหมือนจ่ายซ้ำ) · ผลรวมไม่ตรงกับยอดของงวด
 * ซึ่งอันสุดท้ายคืออันที่อันตรายที่สุด — ยอดเหมาของเคสจะไม่มีทางลงตัวอีกเลยถ้าปล่อยผ่าน
 */
function applyChosenShares(shares, chosen, amount) {
  const known = new Map(shares.map((r) => [r.employee_id, r]));

  const stranger = chosen.find((c) => !known.has(c.employee_id));
  if (stranger) return { reason: 'unknown_employee', employee_id: stranger.employee_id };

  const ids = new Set(chosen.map((c) => c.employee_id));
  if (ids.size !== chosen.length) return { reason: 'duplicate_employee' };

  const sum = round(chosen.reduce((n, c) => n + c.amount, 0));
  if (sum !== round(amount)) return { reason: 'share_sum_mismatch', sum };

  return { rows: chosen.map((c) => ({ ...known.get(c.employee_id), amount: round(c.amount) })) };
}

/**
 * ตรวจยอดที่กำลังจะปล่อยกับ snapshot ล่าสุดภายใน transaction
 *
 * ต้องเรียกหลังล็อกแถว cases แล้วเท่านั้น: คำขอปล่อยเงินทุกคำขอของเคสเดียวกันจึงต่อคิวกัน
 * และอ่าน SUM(case_payouts) หลังคำขอก่อนหน้า commit แล้ว ไม่ใช้ remaining เก่าจากหน้าเว็บ
 */
export function assessReleaseCapacity(staffPay, releasedAmount, requestedAmount) {
  const released = round(Number(releasedAmount ?? 0));
  if (staffPay == null) return { reason: 'staff_pay_not_set', staff_pay: null, released, remaining: null };

  const staff_pay = round(Number(staffPay));
  const remaining = round(staff_pay - released);
  if (remaining <= 0) return { reason: 'fully_released', staff_pay, released, remaining };

  // ไม่ส่งยอดมา = ปล่อยยอดคงเหลือ "ล่าสุด" ที่เพิ่งอ่านภายใต้ lock ไม่ใช่ค่าจาก request ก่อนเข้า transaction
  const amount = requestedAmount == null ? remaining : round(Number(requestedAmount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { reason: 'invalid_amount', staff_pay, released, remaining, amount };
  }
  if (amount > remaining) {
    return { reason: 'amount_exceeds_remaining', staff_pay, released, remaining, amount };
  }

  return { staff_pay, released, remaining, amount };
}

export async function releasePay(caseId, { amount: requestedAmount, note, due_date, shares: chosen }, actor) {
  return transaction(async (tx) => {
    /* จองแถวเคสก่อนอ่านทั้งยอดและเลขงวด — case_payouts เป็น "แถวที่ยังไม่มี" จึงล็อกตรงๆ ไม่ได้
       คำขอของเคสเดียวกันทุกคำขอต้องผ่าน lock นี้ แล้ว statement ถัดไปจึงเห็น payout ที่คำขอก่อนหน้า commit */
    const lockedCase = await tx.one(
      'SELECT case_id, staff_pay FROM cases WHERE case_id = :id FOR UPDATE',
      { id: caseId },
    );
    if (!lockedCase) return { released: [], reason: 'not_found' };

    const { last, released: releasedAmount } = await tx.one(
      `SELECT COALESCE(MAX(installment_no), 0) AS last,
              COALESCE(SUM(amount), 0) AS released
       FROM case_payouts WHERE case_id = :id`,
      { id: caseId },
    );

    const capacity = assessReleaseCapacity(lockedCase.staff_pay, releasedAmount, requestedAmount);
    if (capacity.reason) return { released: [], ...capacity };
    const { amount } = capacity;

    const installment = Number(last) + 1;
    if (installment > MAX_INSTALLMENTS) {
      return { released: [], reason: 'installment_limit', installments_used: Number(last) };
    }

    /* เหลือด่านเดียว: ต้องรู้ว่าจะจ่ายให้ใคร — เคสที่ไม่มีทั้งคนเช็คอิน ไม่มีคนถูกนัด
       และไม่มีคนถูกมอบหมาย คือเคสที่ยังไม่มีใครทำ จ่ายไม่ได้เพราะไม่รู้จะจ่ายให้ใคร
       (ไม่ได้เช็ค "กะอนุมัติแล้ว" อีกแล้ว — ดูเหตุผลใน payShares) */
    const shares = await payShares(tx, caseId);
    if (shares.length === 0) return { released: [], reason: 'no_one_in_case' };

    const split = chosen ? applyChosenShares(shares, chosen, amount) : { rows: allocateShares(shares, amount) };
    if (split.reason) return { released: [], amount, ...split };

    /* ก้อน 0 บาทไม่ต้องบันทึก — คนที่ไม่ได้ส่วนแบ่งในงวดนี้ (ยังไม่มีกะ หรือได้ล่วงหน้าไปแล้ว)
       ไม่ใช่ "ได้ศูนย์บาท" แต่คือ "ไม่มีรายการในงวดนี้" ซึ่งอ่านต่างกันมากบนสลิปและในประวัติ */
    const rows = split.rows.filter((r) => r.amount > 0);
    if (rows.length === 0) return { released: [], reason: 'nothing_to_pay' };

    const released = [];
    for (const r of rows) {
      const { payout_id } = await tx.one(
        `INSERT INTO case_payouts
           (case_id, installment_no, employee_id, employee_name, amount, shifts, minutes,
            due_date, released_by, released_by_name, note)
         VALUES (:case_id, :installment, :employee_id, :employee_name, :amount, :shifts, :minutes,
                 :due_date, :by, :by_name, :note)
         RETURNING payout_id`,
        {
          case_id: caseId,
          installment,
          due_date: due_date ?? null,
          employee_id: r.employee_id,
          employee_name: r.employee_name,
          amount: r.amount,
          shifts: r.shifts,
          minutes: r.minutes,
          by: actor?.employee_id ?? null,
          by_name: actor?.name ?? null,
          note: note ?? null,
        },
      );
      released.push({ ...r, payout_id, installment_no: installment });
    }

    /* ประวัติต้องบอกว่าใครได้เท่าไหร่ ไม่ใช่แค่ยอดรวมของงวด — เคสที่มีหลายคนแล้วมีคนทักทีหลังว่า
       "ทำไมได้ไม่เท่ากัน" คำตอบต้องอยู่ในบรรทัดเดียวนี้ ไม่ใช่ต้องไปไล่ทีละก้อน
       และต้องแยกด้วยว่าเป็นการเกลี่ยของระบบหรือผู้จัดการกำหนดเอง — คนละเรื่องกันเวลาย้อนกลับมาดู */
    const who = rows.map((r) => `${r.employee_name} ${r.amount.toLocaleString('th-TH')}`).join(' · ');
    await logEvent(
      tx,
      caseId,
      'pay_released',
      `ปล่อยค่าจ้างงวดที่ ${installment}/${MAX_INSTALLMENTS} จำนวน ${amount.toLocaleString('th-TH')} บาท` +
        `${due_date ? ` (นัดจ่าย ${due_date})` : ''}${chosen ? ' · กำหนดส่วนแบ่งเอง' : ''} — ${who}`,
      actor,
    );

    return { released, installment_no: installment };
  });
}

/**
 * ถอนยอดที่ปล่อยไปแล้วคืน — ได้เฉพาะก้อนที่ยังไม่เข้ารอบจ่ายที่ปิดแล้ว
 * (เข้ารอบร่างอยู่ก็ถอนได้ แถวใน payroll_payout_lines หายตาม CASCADE ยอดของรอบจึงลดลงเอง)
 */
export async function payoutCancellationForUpdate(tx, caseId, payoutId) {
  /* อ่านแค่ run_id เพื่อรู้ว่าจะต้องเข้าคิว lock แถวไหนก่อน — ยังไม่ใช้ status จาก snapshot นี้ตัดสิน */
  const initial = await tx.one(
    `SELECT p.payout_id, pi.run_id
     FROM case_payouts p
     LEFT JOIN payroll_payout_lines pl ON pl.payout_id = p.payout_id
     LEFT JOIN payroll_items pi ON pi.item_id = pl.item_id
     WHERE p.payout_id = :id AND p.case_id = :case_id`,
    { id: payoutId, case_id: caseId },
  );
  if (!initial) return { reason: 'not_found' };

  const expectedRunId = initial.run_id ?? null;
  let lockedRun = null;
  if (expectedRunId) {
    // lock order เดียวกับ payroll repo: run ก่อน แล้วค่อย case/payout
    lockedRun = await tx.one(
      'SELECT run_id, status FROM payroll_runs WHERE run_id = :id FOR UPDATE',
      { id: expectedRunId },
    );
  }

  /* releasePay ล็อก cases ก่อนเพิ่ม payout งวดใหม่ — การถอนใช้ lock เดียวกันเพื่อให้ยอดรวมของเคสไม่ขยับครึ่งทาง */
  await tx.one('SELECT case_id FROM cases WHERE case_id = :id FOR UPDATE', { id: caseId });

  const row = await tx.one(
    `SELECT payout_id, installment_no, employee_name, amount
     FROM case_payouts
     WHERE payout_id = :id AND case_id = :case_id
     FOR UPDATE`,
    { id: payoutId, case_id: caseId },
  );
  if (!row) return { reason: 'not_found' };

  /* re-read หลังได้ lock ทั้งหมดแล้ว — rebuild/remove/cancel อาจเปลี่ยน binding ระหว่าง initial lookup กับตรงนี้ */
  const linked = await tx.one(
    `SELECT pi.run_id, pr.status AS run_status
     FROM payroll_payout_lines pl
     JOIN payroll_items pi ON pi.item_id = pl.item_id
     JOIN payroll_runs pr ON pr.run_id = pi.run_id
     WHERE pl.payout_id = :id`,
    { id: payoutId },
  );
  const currentRunId = linked?.run_id ?? null;

  // ห้ามไล่ไป lock รอบใหม่หลังจับ case/payout แล้ว เพราะจะกลับลำดับ lock และเสี่ยง deadlock — ให้ client retry
  if (currentRunId !== expectedRunId || (expectedRunId && !lockedRun)) {
    return { reason: 'state_changed' };
  }
  if (linked?.run_status === 'paid' || lockedRun?.status === 'paid') {
    return { reason: 'already_paid' };
  }
  if (linked && linked.run_status !== 'draft') return { reason: 'state_changed' };

  return { row };
}

export async function cancelPayout(caseId, payoutId, actor) {
  return transaction(async (tx) => {
    const state = await payoutCancellationForUpdate(tx, caseId, payoutId);
    if (state.reason) return { ok: false, reason: state.reason };
    const { row } = state;

    const removed = await tx.run(
      'DELETE FROM case_payouts WHERE payout_id = :id AND case_id = :case_id',
      { id: payoutId, case_id: caseId },
    );
    if (removed !== 1) throw new Error(`รายการค่าจ้าง ${payoutId} หายไปหลังได้ row lock`);
    await logEvent(
      tx,
      caseId,
      'pay_released',
      `ถอนค่าจ้างงวดที่ ${row.installment_no} ที่ปล่อยไว้คืน ${Number(row.amount).toLocaleString('th-TH')} บาท (${row.employee_name})`,
      actor,
    );
    return { ok: true };
  });
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

// ============================================================================
// รายงานอาการผู้ป่วย (case_reports) — บันทึกทีละครั้งของเคสหนึ่งใบ
//
// ต่างจาก cases.current_symptoms ที่เป็น "อาการ ณ วันเปิดเคส" ช่องเดียวซึ่งแก้ทับไปเรื่อยๆ
// ตารางนี้เก็บทุกครั้งที่บันทึกไว้ทั้งหมด — ย้อนดูแนวโน้มได้ว่าอาทิตย์ที่แล้วความดันเท่าไหร่
// ============================================================================

// ชื่อคอลัมน์ที่ให้แก้ได้ — ประกาศที่นี่ (ไม่ใช่ยืมจาก schema.js) ตามแบบเดียวกับ COLUMNS ของเคส
// zod ตรวจ "ค่าที่รับได้" ส่วนที่นี่ตัดสิน "คอลัมน์ที่จะเขียนลงตาราง" คนละหน้าที่กัน
/* ช่องกำกับ (ไม่ใช่เนื้อหา) + ทุกช่องเนื้อหาจาก schema — ยกเว้นรูปแผลที่ไม่ได้ลงคอลัมน์เดียว
   (wound_photo เป็น data URL ขาเข้า ต้องแตกเป็น data/mime/size สามคอลัมน์ ดู photoColumns) */
const REPORT_META = ['visit_id', 'report_date', 'report_time', 'shift', 'report_type'];
const REPORT_COLUMNS = [...REPORT_META, ...REPORT_CONTENT_FIELDS.filter((f) => f !== 'wound_photo')];

/**
 * รูปแผล — รับมาเป็น data URL แล้วเก็บเป็นไบนารีในฐานข้อมูล (แบบเดียวกับรูปเช็คอิน/ใบรับรอง)
 * ส่ง wound_photo: null มา = ลบรูปเดิมทิ้ง · ไม่ส่งคีย์นี้มาเลย = ไม่แตะรูปเดิม
 * คืน object ว่างเมื่อไม่ต้องแตะ เพื่อให้ผู้เรียกเอาไป spread รวมกับค่าอื่นได้เลย
 */
function photoColumns(input) {
  if (!('wound_photo' in input)) return {};
  if (!input.wound_photo) return { wound_photo_data: null, wound_photo_mime: null, wound_photo_size: null };

  try {
    const img = decodeImage(input.wound_photo);
    return { wound_photo_data: img.data, wound_photo_mime: img.mime, wound_photo_size: img.size };
  } catch (err) {
    // ไฟล์ไม่ใช่รูป/ใหญ่เกิน = ผู้ส่งแก้เองได้ ต้องได้ข้อความบอก ไม่ใช่ "เกิดข้อผิดพลาดภายในระบบ"
    throw new ApiError(400, err.message);
  }
}

// วันที่ของฐานข้อมูล (โซนไทย) — ใช้เป็นค่าปริยายของ report_date ซึ่ง NOT NULL
// ไม่ให้หน้าเว็บส่งวันนี้มาเอง เพราะนาฬิกาเครื่องพนักงานเชื่อไม่ได้ (เหตุผลเดียวกับเวลาเช็คอิน)
const TODAY_TH = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')`;

/**
 * report_date เป็น NOT NULL — ส่งมาว่างถือว่า "วันนี้" ไม่ใช่ค่าที่ผิด
 * ใช้ร่วมกันทั้งตอนเพิ่มและตอนแก้ ค่าปริยายจึงมาจากที่เดียว
 */
const slot = (c) => (c === 'report_date' ? `COALESCE(:report_date, ${TODAY_TH})` : `:${c}`);

/** ช่องที่เว้นว่างต้องลงเป็น NULL ไม่ใช่ '' — ไม่งั้นหน้าเว็บต้องมาแยกเองว่า "ว่าง" คือแบบไหน */
const blank = (v) => (typeof v === 'string' && v.trim() === '' ? null : v ?? null);

/* กะที่รายงานผูกอยู่ — เอาไปแสดงว่าเป็นบันทึกของนัดวันไหน
   ไม่คิดเลข "ครั้งที่เท่าไหร่" ให้ เพราะระบบไม่ได้ไล่ว่าต้องครบกี่ครั้ง แค่แนบรายงานกับนัดที่ไปทำ */
const REPORT_VISIT = `
  LEFT JOIN case_visits v ON v.visit_id = r.visit_id
`;
/* ไล่ชื่อคอลัมน์เองแทน r.* — r.* จะลากไบนารีรูปแผล (หลักแสนไบต์ต่อใบ) มาทุกแถวที่โหลดรายการ
   ประกอบจาก REPORT_COLUMNS ที่มาจาก schema อยู่แล้ว เพิ่มช่องใหม่จึงไม่ต้องมาต่อรายการที่นี่ซ้ำ */
const REPORT_COLS = [
  'r.report_id',
  'r.case_id',
  ...REPORT_COLUMNS.map((c) => `r.${c}`),
  'r.wound_photo_mime',
  'r.wound_photo_size',
  '(r.wound_photo_data IS NOT NULL) AS has_wound_photo',
  'r.reported_by',
  'r.reported_by_name',
  'r.created_at',
  'r.updated_at',
  'v.visit_date',
  'v.planned_start',
  'v.planned_end',
].join(', ');

/**
 * รูปแผลเป็นไบนารีหลักแสนไบต์ ส่งกลับไปกับ JSON ทุกครั้งที่โหลดรายการไม่ไหว
 * ตัดออกแล้วบอกแค่ว่ามีรูปไหม — หน้าเว็บไปดึงรูปจริงจาก endpoint รูปทีละใบเอง
 */
const withoutPhotoBytes = (row) => {
  if (!row) return row;
  const { wound_photo_data, ...rest } = row;
  return { ...rest, has_wound_photo: wound_photo_data != null };
};

/**
 * คลังรายงานของเคส — ล่าสุดอยู่บน แบ่งหน้า + กรองตามเดือน/ประเภท
 * (เคสดูแลต่อเนื่องบันทึกวันละหลายครั้ง ดึงทั้งหมดทุกครั้งที่เปิดดูไม่ไหว)
 */
export async function listReports(caseId, { month, type, page = 1, per_page = 20 } = {}) {
  const where = ['r.case_id = :id'];
  const params = { id: caseId };

  if (month) {
    // report_date เก็บเป็นข้อความ 'YYYY-MM-DD' จึงเทียบ prefix ได้ตรงๆ (เกณฑ์เดียวกับตัวกรองช่วงเวลาของเคส)
    where.push('r.report_date LIKE :month');
    params.month = `${month}%`;
  }
  if (type === 'abnormal') where.push("r.report_type <> 'routine'");
  else if (type) {
    where.push('r.report_type = :type');
    params.type = type;
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM case_reports r ${clause}`, params);

  const rows = await sql.all(
    `SELECT ${REPORT_COLS} FROM case_reports r ${REPORT_VISIT}
     ${clause}
     /* ในวันเดียวกันเรียงตามเวลาจริงเสมอ — ใบที่ไม่ได้ระบุ "เวลาที่วัด" ใช้เวลาที่กดบันทึกแทน
        (NULLS LAST ทำให้ใบพวกนี้ไปกองท้ายวันทั้งที่อาจเป็นใบล่าสุด แล้วรายการดูเหมือนไม่ได้เรียง)
        created_at เก็บเป็น 'YYYY-MM-DD HH:MM:SS' เวลาไทย จึงตัดเอา 'HH:MM' มาเทียบกับ report_time ได้ตรงๆ */
     ORDER BY r.report_date DESC,
              COALESCE(r.report_time, substr(r.created_at, 12, 5)) DESC,
              r.report_id DESC
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return { data: rows, page, per_page, total: count, has_more: page * per_page < count };
}

/**
 * เดือนที่มีรายงานอยู่จริง + จำนวนของแต่ละเดือน — ให้หน้าเว็บทำตัวเลือก "ดูย้อนหลังเดือนไหน"
 * นับใบที่ไม่ใช่รอบปกติแยกไว้ด้วย เพื่อให้เห็นตั้งแต่ยังไม่กดว่าเดือนไหนมีเรื่องต้องตามอ่าน
 */
export function reportMonths(caseId) {
  return sql.all(
    `SELECT substr(report_date, 1, 7) AS month,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE report_type <> 'routine')::int AS abnormal
     FROM case_reports
     WHERE case_id = :id
     GROUP BY 1
     ORDER BY 1 DESC`,
    { id: caseId },
  );
}

/** รายงานของกะเดียว — หน้างานวันนี้ของพนักงานเปิดดู/บันทึกจากตรงนี้ */
export function listReportsForVisit(visitId) {
  return sql.all(
    `SELECT ${REPORT_COLS} FROM case_reports r ${REPORT_VISIT}
     WHERE r.visit_id = :id
     ORDER BY r.report_id DESC`,
    { id: visitId },
  );
}

/** รายงานใบเดียว — กรองด้วย case_id ด้วยเสมอ ใบของเคสอื่นต้องไม่หลุดออกทาง path ของเคสนี้ */
export function findReport(caseId, reportId) {
  return sql.one(
    'SELECT * FROM case_reports WHERE report_id = :rid AND case_id = :cid',
    { rid: reportId, cid: caseId },
  );
}

/**
 * บันทึกรายงานใหม่ — ผู้บันทึกมาจาก session (req.user) ไม่รับจาก body
 * เก็บชื่อ ณ ตอนนั้นคู่กับรหัส เพราะคนบันทึกอาจเปลี่ยนชื่อ/ลาออกทีหลัง แต่บันทึกต้องยังอ่านออก
 */
export async function addReport(caseId, input, actor) {
  const photo = photoColumns(input);
  const columns = [...REPORT_COLUMNS, ...Object.keys(photo)];

  const values = {
    case_id: caseId,
    reported_by: actor?.employee_id ?? null,
    reported_by_name: actor?.name ?? null,
    ...photo,
  };
  for (const c of REPORT_COLUMNS) values[c] = blank(input[c]);

  const row = await sql.one(
    `INSERT INTO case_reports (case_id, reported_by, reported_by_name, ${columns.join(', ')})
     VALUES (:case_id, :reported_by, :reported_by_name, ${columns.map(slot).join(', ')})
     RETURNING *`,
    values,
  );
  return withoutPhotoBytes(row);
}

/**
 * แก้รายงาน — เขียนเฉพาะช่องที่ส่งมา (ช่องที่ไม่ส่งมาคงของเดิมไว้)
 * report_date ล้างเป็นค่าว่างไม่ได้ (NOT NULL) — ส่ง null มาถือว่า "ใช้วันนี้"
 * ไม่แตะ reported_by: เจ้าของบันทึกคือคนที่เขียนครั้งแรก การแก้ไม่ใช่การเปลี่ยนผู้บันทึก
 */
export async function updateReport(caseId, reportId, input) {
  const photo = photoColumns(input);
  const fields = [...REPORT_COLUMNS.filter((c) => c in input), ...Object.keys(photo)];
  if (fields.length === 0) return findReport(caseId, reportId);

  const values = { cid: caseId, rid: reportId, ...photo };
  for (const c of REPORT_COLUMNS) if (c in input) values[c] = blank(input[c]);

  const set = fields.map((c) => `${c} = ${slot(c)}`);

  const row = await sql.one(
    `UPDATE case_reports SET ${set.join(', ')}, updated_at = ${NOW}
     WHERE report_id = :rid AND case_id = :cid
     RETURNING *`,
    values,
  );
  return withoutPhotoBytes(row);
}

/** รูปแผลของรายงาน — ส่งเป็นไฟล์ผ่าน endpoint แยก ไม่ยัดกลับไปใน JSON */
export const findReportPhoto = (reportId, caseId = null) =>
  sql.one(
    `SELECT wound_photo_data AS data, wound_photo_mime AS mime
     FROM case_reports
     WHERE report_id = :id AND wound_photo_data IS NOT NULL
       AND (:case_id::text IS NULL OR case_id = :case_id)`,
    { id: reportId, case_id: caseId },
  );

/** ลบรายงาน — คืน false ถ้าไม่มีใบนี้ในเคสนี้ (ให้ route ตอบ 404 แทนที่จะเงียบ) */
export async function removeReport(caseId, reportId) {
  const deleted = await sql.run(
    'DELETE FROM case_reports WHERE report_id = :rid AND case_id = :cid',
    { rid: reportId, cid: caseId },
  );
  return deleted > 0;
}
