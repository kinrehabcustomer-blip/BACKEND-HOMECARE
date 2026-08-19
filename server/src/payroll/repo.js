import { sql, transaction, nextPayrollId } from '../db/index.js';
import { VISIT_PAY, BOOKED_VISITS, NOT_CANCELLED, WORKER_NAME } from '../cases/repo.js';

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;

/**
 * วันที่ของกะ = วันที่เช็คอินตามเวลาไทย ไม่ใช่ visit_date ที่นัดไว้
 * เกณฑ์เดียวกับสรุปค่าตอบแทน (attendanceReport) — ไม่งั้นกะที่ไปทำจริงคนละวันกับที่นัด
 * จะถูกนับคนละรอบกับที่โชว์ในสรุป แล้วตัวเลขสองหน้าจะไม่ตรงกันโดยไม่มีใครอธิบายได้
 */
const SHIFT_DATE = `to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')`;

/**
 * กะที่ "พร้อมจ่าย" ณ วันตัดรอบหนึ่ง — หัวใจของทั้งโมดูล
 *
 * มีแต่เพดาน (<= วันตัดรอบ) ไม่มีขอบล่างโดยตั้งใจ: กะเก่าที่เพิ่งอนุมัติหลังปิดรอบไปแล้ว
 * จะถูกกวาดเข้ารอบถัดไปเองเสมอ ถ้าใช้ช่วงวันตายตัวมันจะตกหล่นถาวรโดยไม่มีอะไรฟ้อง
 *
 * NOT EXISTS payroll_lines = ยังไม่เคยถูกจ่าย — เป็นตัวกันจ่ายซ้ำชั้นแรก
 * (ชั้นที่สองคือ visit_id ที่เป็น PRIMARY KEY ของ payroll_lines ซึ่งฐานข้อมูลกันให้เอง)
 *
 * VISIT_PAY IS NOT NULL = กะที่ยังไม่รู้ว่าได้เท่าไหร่ ไม่ถูกกวาดเข้ารอบ (ดู unpricedShifts
 * ที่นับให้ต่างหาก เพื่อให้คนเปิดรอบเห็นว่ามีกะตกค้างเพราะยังไม่ได้ตั้งค่าจ้าง ไม่ใช่หายไปเฉยๆ)
 */
const ELIGIBLE = `
  FROM case_visits v
  JOIN cases c ON c.case_id = v.case_id
  LEFT JOIN employees e ON e.employee_id = v.checked_in_by
  LEFT JOIN ${BOOKED_VISITS} b ON b.case_id = v.case_id
  WHERE v.check_out_at IS NOT NULL
    AND ${NOT_CANCELLED}
    AND v.pay_status = 'approved'
    AND v.checked_in_by IS NOT NULL
    AND ${SHIFT_DATE} <= :period_to
    AND ${VISIT_PAY} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payroll_lines pl WHERE pl.visit_id = v.visit_id)
`;

/** ชั่วโมงทำงานของกะเป็นนาที — ใช้ทั้งตอนพรีวิวและตอนสร้างสลิป */
const SHIFT_MINUTES = `EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at)) / 60`;

/** แถวดิบของกะที่พร้อมจ่าย — subquery ที่ทั้งพรีวิวและการสร้างรอบใช้ร่วมกัน */
const ELIGIBLE_ROWS = `
  SELECT v.visit_id,
         v.checked_in_by AS employee_id,
         ${WORKER_NAME}  AS employee_name,
         ${SHIFT_MINUTES} AS minutes,
         ${VISIT_PAY}     AS amount,
         ${SHIFT_DATE}    AS shift_date
  ${ELIGIBLE}
`;

const num = (row, fields) => {
  const out = { ...row };
  for (const f of fields) out[f] = Number(out[f] ?? 0);
  return out;
};

/**
 * ใครจะได้เท่าไหร่ถ้าเปิดรอบด้วยวันตัดรอบนี้ — ดูก่อนกดสร้างจริง
 * oldest_shift_date บอกว่ามีกะค้างมาจากรอบก่อนไหม (เก่ากว่าเดือนของรอบ = ตกค้าง)
 */
export async function preview(periodTo) {
  const rows = await sql.all(
    `SELECT x.employee_id, x.employee_name,
            COUNT(*) AS shifts,
            COALESCE(ROUND(SUM(x.minutes)), 0) AS minutes,
            SUM(x.amount) AS total_pay,
            MIN(x.shift_date) AS oldest_shift_date
     FROM (${ELIGIBLE_ROWS}) x
     GROUP BY x.employee_id, x.employee_name
     ORDER BY x.employee_name`,
    { period_to: periodTo },
  );
  return rows.map((r) => num(r, ['shifts', 'minutes', 'total_pay']));
}

/**
 * กะที่อนุมัติแล้วแต่ยังไม่มีค่าจ้าง — ไม่ถูกกวาดเข้ารอบ ต้องบอกให้รู้ ไม่ใช่ปล่อยให้หายเงียบ
 * (เกณฑ์เดียวกับ ELIGIBLE ทุกข้อ ยกเว้นสลับเป็น VISIT_PAY IS NULL)
 */
export async function unpricedShifts(periodTo) {
  const row = await sql.one(
    `SELECT COUNT(*) AS n
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN ${BOOKED_VISITS} b ON b.case_id = v.case_id
     WHERE v.check_out_at IS NOT NULL
       AND ${NOT_CANCELLED}
       AND v.pay_status = 'approved'
       AND v.checked_in_by IS NOT NULL
       AND ${SHIFT_DATE} <= :period_to
       AND ${VISIT_PAY} IS NULL
       AND NOT EXISTS (SELECT 1 FROM payroll_lines pl WHERE pl.visit_id = v.visit_id)`,
    { period_to: periodTo },
  );
  return Number(row?.n ?? 0);
}

/**
 * ดึงกะที่พร้อมจ่ายเข้ารอบ — สร้างสลิปรายคนก่อน แล้วค่อยผูกกะเข้าสลิป
 *
 * ยอดบนสลิป (total_pay/shifts/minutes) ถูกตรึงเป็นตัวเลขถาวรตรงนี้ ไม่ได้คิดสดตอนเปิดดู
 * เพราะกะอาจถูกลบทีหลัง (ลบเคส) แต่สลิปที่จ่ายเงินออกไปแล้วต้องยังอ่านออกว่าจ่ายเท่าไหร่
 */
async function fill(tx, runId, periodTo) {
  const params = { run: runId, period_to: periodTo };

  await tx.run(
    `INSERT INTO payroll_items (run_id, employee_id, employee_name, shifts, minutes, total_pay)
     SELECT :run, x.employee_id, x.employee_name,
            COUNT(*),
            /* ปัดเป็นจำนวนเต็มและกันค่าติดลบให้ตรงกับ CHECK ของคอลัมน์ —
               ข้อมูลเช็คเอาท์ก่อนเช็คอิน (แก้เวลาย้อนหลังผิด) ไม่ควรทำให้ทั้งรอบสร้างไม่ได้ */
            GREATEST(0, COALESCE(ROUND(SUM(x.minutes)), 0))::int,
            SUM(x.amount)
     FROM (${ELIGIBLE_ROWS}) x
     GROUP BY x.employee_id, x.employee_name`,
    params,
  );

  await tx.run(
    `INSERT INTO payroll_lines (visit_id, item_id, amount)
     SELECT x.visit_id, i.item_id, x.amount
     FROM (${ELIGIBLE_ROWS}) x
     JOIN payroll_items i ON i.run_id = :run AND i.employee_id = x.employee_id`,
    params,
  );
}

export function createRun({ period_month, round_no, period_to, note }, actor) {
  return transaction(async (tx) => {
    const runId = await nextPayrollId(tx);
    await tx.run(
      `INSERT INTO payroll_runs
         (run_id, period_month, round_no, period_to, note, created_by, created_by_name)
       VALUES (:run_id, :period_month, :round_no, :period_to, :note, :by, :by_name)`,
      {
        run_id: runId,
        period_month,
        round_no,
        period_to,
        note: note ?? null,
        by: actor?.employee_id ?? null,
        by_name: actor?.name ?? null,
      },
    );
    await fill(tx, runId, period_to);
    return runId;
  }).then(findById);
}

/** ดึงกะใหม่ทั้งรอบ (ร่างเท่านั้น) — ล้างของเดิมทิ้งแล้วกวาดใหม่ กะที่ถูกเอาออกไปจะกลับมาด้วย */
export function rebuild(runId, periodTo) {
  return transaction(async (tx) => {
    await tx.run('DELETE FROM payroll_items WHERE run_id = :id', { id: runId });
    await fill(tx, runId, periodTo);
    return runId;
  }).then(findById);
}

const RUN_TOTALS = `
  (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.run_id)                 AS employees,
  (SELECT COALESCE(SUM(i.shifts), 0) FROM payroll_items i WHERE i.run_id = r.run_id)    AS shifts,
  (SELECT COALESCE(SUM(i.total_pay), 0) FROM payroll_items i WHERE i.run_id = r.run_id) AS total_pay
`;

export async function list({ month, status } = {}) {
  const where = [];
  const params = {};
  if (month) {
    where.push('r.period_month = :month');
    params.month = month;
  }
  if (status) {
    where.push('r.status = :status');
    params.status = status;
  }

  const rows = await sql.all(
    `SELECT r.*, ${RUN_TOTALS}
     FROM payroll_runs r
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.period_month DESC, r.round_no DESC`,
    params,
  );
  return rows.map((r) => num(r, ['round_no', 'employees', 'shifts', 'total_pay']));
}

export async function findById(runId) {
  const run = await sql.one(`SELECT r.*, ${RUN_TOTALS} FROM payroll_runs r WHERE r.run_id = :id`, {
    id: runId,
  });
  if (!run) return null;

  const items = await sql.all(
    `SELECT item_id, employee_id, employee_name, shifts, minutes, total_pay
     FROM payroll_items WHERE run_id = :id ORDER BY employee_name`,
    { id: runId },
  );

  return {
    ...num(run, ['round_no', 'employees', 'shifts', 'total_pay']),
    items: items.map((i) => num(i, ['shifts', 'minutes', 'total_pay'])),
  };
}

/** กะทั้งหมดที่อยู่ในสลิปหนึ่งใบ — ที่มาของยอด ให้กางดูได้ว่าเงินมาจากงานวันไหน เคสไหน */
export function itemVisits(itemId) {
  return sql
    .all(
      `SELECT pl.visit_id, pl.amount,
              to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS shift_date,
              v.check_in_at, v.check_out_at,
              c.case_id, c.title AS case_title, c.client_name
       FROM payroll_lines pl
       LEFT JOIN case_visits v ON v.visit_id = pl.visit_id
       LEFT JOIN cases c ON c.case_id = v.case_id
       WHERE pl.item_id = :id
       ORDER BY shift_date, pl.visit_id`,
      { id: itemId },
    )
    .then((rows) => rows.map((r) => num(r, ['amount'])));
}

export const findItem = (itemId) =>
  sql.one(
    `SELECT i.*, r.status AS run_status, r.run_id
     FROM payroll_items i JOIN payroll_runs r ON r.run_id = i.run_id
     WHERE i.item_id = :id`,
    { id: itemId },
  );

/** เอาคนออกจากรอบ — กะของเขากลับเข้ากองรอจ่ายทันที (payroll_lines ถูกลบตาม) */
export const removeItem = (itemId) =>
  sql.run('DELETE FROM payroll_items WHERE item_id = :id', { id: itemId });

export async function pay(runId, { pay_date, method, note }, actor) {
  await sql.run(
    `UPDATE payroll_runs
     SET status = 'paid', pay_date = :pay_date, method = :method,
         note = COALESCE(:note, note),
         paid_by = :by, paid_by_name = :by_name, updated_at = ${NOW}
     WHERE run_id = :id`,
    {
      id: runId,
      pay_date,
      method: method ?? null,
      note: note ?? null,
      by: actor?.employee_id ?? null,
      by_name: actor?.name ?? null,
    },
  );
  return findById(runId);
}

/**
 * ยกเลิกรอบ — รอบยังอยู่เป็นประวัติ แต่กะทั้งหมดกลับเข้ากองรอจ่าย
 * ลบเฉพาะ payroll_lines ไม่ลบสลิป เพื่อให้ยังอ่านย้อนได้ว่ารอบที่ยกเลิกไปเคยจะจ่ายใครเท่าไหร่
 */
export async function cancel(runId) {
  await transaction(async (tx) => {
    await tx.run(
      `DELETE FROM payroll_lines
       WHERE item_id IN (SELECT item_id FROM payroll_items WHERE run_id = :id)`,
      { id: runId },
    );
    await tx.run(
      `UPDATE payroll_runs SET status = 'cancelled', updated_at = ${NOW} WHERE run_id = :id`,
      { id: runId },
    );
  });
  return findById(runId);
}

export const remove = (runId) =>
  sql.run('DELETE FROM payroll_runs WHERE run_id = :id', { id: runId }).then((n) => n > 0);

/**
 * สลิปของพนักงานคนหนึ่งทุกรอบที่จ่ายแล้ว — ฝั่งพนักงานเห็นเฉพาะรอบที่จ่ายจริงแล้วเท่านั้น
 * รอบที่ยังเป็นร่างคือตัวเลขที่ผู้จัดการยังปรับได้ ส่งให้พนักงานเห็นก่อนจะกลายเป็นการสัญญาเงินที่ยังไม่แน่
 */
export function payslipsFor(employeeId) {
  return sql
    .all(
      `SELECT i.item_id, i.shifts, i.minutes, i.total_pay,
              r.run_id, r.period_month, r.round_no, r.period_to, r.pay_date, r.method
       FROM payroll_items i
       JOIN payroll_runs r ON r.run_id = i.run_id
       WHERE i.employee_id = :emp AND r.status = 'paid'
       ORDER BY r.pay_date DESC, r.run_id DESC`,
      { emp: employeeId },
    )
    .then((rows) => rows.map((r) => num(r, ['shifts', 'minutes', 'total_pay', 'round_no'])));
}
