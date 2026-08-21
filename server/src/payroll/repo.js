import { sql, transaction, nextPayrollId } from '../db/index.js';

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;

/**
 * วันที่ของยอด = วันที่ผู้จัดการกดปล่อยค่าจ้าง (เวลาไทย)
 * released_at เก็บเป็น TEXT 'YYYY-MM-DD HH:MM:SS' อยู่แล้ว จึงตัด 10 ตัวแรกมาเทียบได้ตรงๆ
 * เกณฑ์เดียวกับสรุปค่าตอบแทน (attendanceReport) — ตัวเลขสองหน้าจึงตกอยู่เดือนเดียวกันเสมอ
 */
const RELEASE_DATE = `substr(p.released_at, 1, 10)`;

/**
 * ยอดที่ "พร้อมจ่าย" ณ วันตัดรอบหนึ่ง — หัวใจของทั้งโมดูล
 *
 * ฐานคือ case_payouts (ค่าจ้างก้อนที่ผู้จัดการกดปล่อย) ไม่ใช่ case_visits รายกะอีกต่อไป
 * ยอดในแถวถูกตรึงตั้งแต่วินาทีที่ปล่อย โมดูลนี้จึงไม่มีการคิดเงินสดที่ไหนเลย —
 * แก้ค่าจ้างของเคส เพิ่ม/ยกเลิกกะ หรือปิดเคสทีหลัง ล้วนไม่ขยับยอดที่รออยู่ในรอบ
 * (ของเดิมคิดสดจาก staff_pay หารจำนวนกะ ยอดจึงเปลี่ยนได้ตลอดจนถึงวินาทีที่กดจ่าย)
 *
 * มีแต่เพดาน (<= วันตัดรอบ) ไม่มีขอบล่างโดยตั้งใจ: ยอดที่เพิ่งปล่อยหลังปิดรอบไปแล้ว
 * จะถูกกวาดเข้ารอบถัดไปเองเสมอ ถ้าใช้ช่วงวันตายตัวมันจะตกหล่นถาวรโดยไม่มีอะไรฟ้อง
 *
 * NOT EXISTS payroll_payout_lines = ยังไม่เคยถูกจ่าย — ตัวกันจ่ายซ้ำชั้นแรก
 * (ชั้นที่สองคือ payout_id ที่เป็น PRIMARY KEY ของตารางนั้น ซึ่งฐานข้อมูลกันให้เอง)
 *
 * employee_id IS NULL = คนรับถูกลบถาวรไปแล้ว ไม่มีสลิปให้ผูก จึงไม่ถูกกวาดเข้ารอบ
 */
const ELIGIBLE = `
  FROM case_payouts p
  WHERE p.employee_id IS NOT NULL
    AND ${RELEASE_DATE} <= :period_to
    AND NOT EXISTS (SELECT 1 FROM payroll_payout_lines pl WHERE pl.payout_id = p.payout_id)
`;

/** แถวดิบของยอดที่พร้อมจ่าย — subquery ที่ทั้งพรีวิวและการสร้างรอบใช้ร่วมกัน */
const ELIGIBLE_ROWS = `
  SELECT p.payout_id, p.case_id, p.employee_id, p.employee_name,
         p.shifts, p.minutes, p.amount, p.due_date,
         ${RELEASE_DATE} AS release_date
  ${ELIGIBLE}
`;

/**
 * ยอดรายสลิปที่คิดจากก้อนที่ผูกอยู่จริง — ใช้กับรอบที่ยังเป็นร่าง
 *
 * ต้องคิดจากแถวที่ผูกอยู่ ไม่ใช่อ่าน payroll_items ตรงๆ เพราะระหว่างที่ยังเป็นร่าง
 * ผู้จัดการถอนยอดที่ปล่อยผิดคืนได้ (ดู cancelPayout) แถวใน payroll_payout_lines หายตาม CASCADE
 * ถ้าอ่านตัวเลขที่ตรึงไว้ตอนเปิดรอบ สลิปจะยังโชว์ยอดของก้อนที่ถูกถอนไปแล้ว
 *
 * ไม่มี COALESCE หรือการคิดสดจากค่าจ้างของเคสอีกแล้ว — amount ของแต่ละแถวเป็นตัวเลขตายตัว
 */
const LIVE_ITEMS = `
  SELECT pl.item_id,
         COALESCE(SUM(p.shifts), 0)::int  AS shifts,
         COALESCE(SUM(p.minutes), 0)::int AS minutes,
         COALESCE(SUM(pl.amount), 0)      AS total_pay,
         COUNT(DISTINCT p.case_id)::int   AS cases,
         COUNT(*)::int                    AS payouts
  FROM payroll_payout_lines pl
  JOIN case_payouts p ON p.payout_id = pl.payout_id
  GROUP BY pl.item_id
`;

const num = (row, fields) => {
  const out = { ...row };
  for (const f of fields) out[f] = Number(out[f] ?? 0);
  return out;
};

/**
 * ใครจะได้เท่าไหร่ถ้าเปิดรอบด้วยวันตัดรอบนี้ — ดูก่อนกดสร้างจริง
 * oldest_release_date บอกว่ามียอดค้างมาจากรอบก่อนไหม (เก่ากว่าเดือนของรอบ = ตกค้าง)
 */
export async function preview(periodTo) {
  const rows = await sql.all(
    `SELECT x.employee_id, x.employee_name,
            COUNT(*)                      AS payouts,
            COUNT(DISTINCT x.case_id)     AS cases,
            COALESCE(SUM(x.shifts), 0)    AS shifts,
            COALESCE(SUM(x.minutes), 0)   AS minutes,
            SUM(x.amount)                 AS total_pay,
            MIN(x.release_date)           AS oldest_release_date,
            MIN(x.due_date)               AS earliest_due_date
     FROM (${ELIGIBLE_ROWS}) x
     GROUP BY x.employee_id, x.employee_name
     ORDER BY x.employee_name`,
    { period_to: periodTo },
  );
  return rows.map((r) => num(r, ['payouts', 'cases', 'shifts', 'minutes', 'total_pay']));
}

/**
 * เคสที่ทำงานจบแล้วแต่ผู้จัดการยังไม่ได้กดปล่อยค่าจ้าง — เงินที่ยังไม่เข้ากองรอจ่าย
 *
 * แทนที่ unpricedShifts เดิม (กะที่ไม่มีราคา) เพราะตอนนี้ "กะไม่มีราคา" ไม่มีอยู่จริงแล้ว
 * สิ่งที่ทำให้เงินตกค้างคือการลืมกดปล่อย ซึ่งเงียบกว่าเดิมมาก — ไม่มีอะไรบนหน้าจอฟ้องเลย
 * ถ้าไม่นับให้ดู คนเปิดรอบจะไม่รู้ว่ามีงานที่ทำเสร็จแล้วแต่ยังไม่มีใครสั่งจ่าย
 */
export async function unreleasedCases(periodTo) {
  const row = await sql.one(
    /* เกณฑ์คือ "ปิดเคสแล้วแต่ยังไม่เคยปล่อยสักบาท"
       ปิดเคส = จังหวะที่ผู้จัดการยืนยันว่างานจบ จึงเป็นสัญญาณที่ตรงที่สุดว่าเงินก้อนนี้ควรออกได้แล้ว
       (เดิมใช้ "มีกะที่อนุมัติแล้ว" ซึ่งพลาดเคสที่พนักงานลืมเช็คอิน — เงียบสนิททั้งที่งานจบไปแล้ว)

       "ยังไม่เคยปล่อยเลยสักบาท" ไม่ใช่ "ปล่อยยังไม่ครบยอด" เพราะเคสที่ปิดก่อนกำหนดจะเหลือยอดค้าง
       เป็นเรื่องปกติและถูกต้อง (ผู้จัดการจงใจจ่ายไม่เต็ม) ถ้านับด้วยยอดคงเหลือ เคสพวกนั้นจะค้าง
       อยู่ในคำเตือนตลอดไปโดยไม่มีอะไรให้ทำ แล้วคำเตือนก็จะกลายเป็นตัวเลขที่ทุกคนเลิกอ่าน */
    `SELECT COUNT(*) AS n
     FROM cases c
     WHERE c.staff_pay IS NOT NULL
       AND c.status = 'closed'
       AND COALESCE(substr(c.closed_at, 1, 10), c.end_date) <= :period_to
       AND NOT EXISTS (SELECT 1 FROM case_payouts p WHERE p.case_id = c.case_id)`,
    { period_to: periodTo },
  );
  return Number(row?.n ?? 0);
}

/**
 * ดึงยอดที่พร้อมจ่ายเข้ารอบ — สร้างสลิปรายคนก่อน แล้วค่อยผูกก้อนเงินเข้าสลิป
 *
 * ยอดบนสลิปถูกตรึงเป็นตัวเลขถาวรตรงนี้ เพราะเคส (และก้อนเงิน) อาจถูกลบทีหลัง
 * แต่สลิปที่จ่ายเงินออกไปแล้วต้องยังอ่านออกว่าจ่ายเท่าไหร่
 */
async function fill(tx, runId, periodTo) {
  const params = { run: runId, period_to: periodTo };

  await tx.run(
    `INSERT INTO payroll_items (run_id, employee_id, employee_name, shifts, minutes, total_pay)
     SELECT :run, x.employee_id, x.employee_name,
            COALESCE(SUM(x.shifts), 0)::int,
            COALESCE(SUM(x.minutes), 0)::int,
            SUM(x.amount)
     FROM (${ELIGIBLE_ROWS}) x
     GROUP BY x.employee_id, x.employee_name`,
    params,
  );

  await tx.run(
    `INSERT INTO payroll_payout_lines (payout_id, item_id, amount)
     SELECT x.payout_id, i.item_id, x.amount
     FROM (${ELIGIBLE_ROWS}) x
     JOIN payroll_items i ON i.run_id = :run AND i.employee_id = x.employee_id`,
    params,
  );
}

/** เดือนหนึ่งเปิดไปแล้วกี่รอบ (ไม่นับรอบที่ยกเลิก) — ตัวตั้งของเลข "รอบที่" ของรอบถัดไป */
export async function roundsInMonth(month) {
  const row = await sql.one(
    `SELECT COUNT(*) AS n FROM payroll_runs
     WHERE period_month = :month AND status <> 'cancelled'`,
    { month },
  );
  return Number(row?.n ?? 0);
}

/**
 * เปิดรอบ — เดือนกับเลขรอบมาจากวันตัดรอบ ไม่ได้ให้กรอกเอง
 * ป้ายชื่อจึงตรงกับสิ่งที่รอบกวาดมาจริงเสมอ (ดูเหตุผลเต็มใน schema.js)
 */
export function createRun({ period_to, note }, actor) {
  return transaction(async (tx) => {
    const period_month = period_to.slice(0, 7);
    const { n } = await tx.one(
      `SELECT COUNT(*) AS n FROM payroll_runs
       WHERE period_month = :month AND status <> 'cancelled'`,
      { month: period_month },
    );
    const round_no = Number(n) + 1;

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

/** ดึงยอดใหม่ทั้งรอบ (ร่างเท่านั้น) — ล้างของเดิมทิ้งแล้วกวาดใหม่ คนที่ถูกเอาออกไปจะกลับมาด้วย */
export function rebuild(runId, periodTo) {
  return transaction(async (tx) => {
    await tx.run('DELETE FROM payroll_items WHERE run_id = :id', { id: runId });
    await fill(tx, runId, periodTo);
    return runId;
  }).then(findById);
}

/* ยอดรวมของรอบ — ร่างคิดจากก้อนที่ผูกอยู่จริง ส่วนรอบที่จ่าย/ยกเลิกแล้วอ่านที่ตรึงไว้บนสลิป
   (รอบที่จ่ายไปแล้วต้องไม่ขยับตามการถอน/ปล่อยค่าจ้างทีหลัง — เงินออกไปเท่าไหร่ก็เท่านั้น) */
const RUN_TOTALS = `
  (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.run_id) AS employees,

  /* เงินในรอบมาจาก "งวดของเคส" ไม่ใช่จาก "กะ" อีกแล้ว — จำนวนเคสจึงเป็นตัวบอกว่ารอบนี้
     ประกอบด้วยงานกี่ชิ้น ซึ่งเป็นหน่วยที่คนอ่านเทียบกับความจริงได้ (กะเป็นแค่ที่มาของสัดส่วน)

     อ่านสดจากก้อนที่ผูกอยู่เสมอ ไม่แยกร่าง/จ่ายแล้วเหมือนตัวเงิน เพราะมันไม่ใช่ยอดเงิน
     ที่ต้องตรึง — และ payroll_items ก็ไม่มีช่องเก็บจำนวนเคสไว้ให้อ่านย้อนอยู่แล้ว
     (รอบที่ยกเลิกจะได้ 0 เพราะก้อนถูกปลดออกไปหมด ฝั่งหน้าจอจึงไม่แสดงตัวเลขนี้ให้รอบที่ยกเลิก) */
  (SELECT COUNT(DISTINCT p.case_id)
   FROM payroll_payout_lines pl
   JOIN payroll_items i  ON i.item_id  = pl.item_id
   JOIN case_payouts  p  ON p.payout_id = pl.payout_id
   WHERE i.run_id = r.run_id) AS cases,

  (SELECT COUNT(*)
   FROM payroll_payout_lines pl
   JOIN payroll_items i ON i.item_id = pl.item_id
   WHERE i.run_id = r.run_id) AS payouts,
  CASE WHEN r.status = 'draft'
    THEN (SELECT COALESCE(SUM(t.shifts), 0) FROM (${LIVE_ITEMS}) t
          JOIN payroll_items i ON i.item_id = t.item_id WHERE i.run_id = r.run_id)
    ELSE (SELECT COALESCE(SUM(i.shifts), 0) FROM payroll_items i WHERE i.run_id = r.run_id)
  END AS shifts,
  CASE WHEN r.status = 'draft'
    THEN (SELECT COALESCE(SUM(t.total_pay), 0) FROM (${LIVE_ITEMS}) t
          JOIN payroll_items i ON i.item_id = t.item_id WHERE i.run_id = r.run_id)
    ELSE (SELECT COALESCE(SUM(i.total_pay), 0) FROM payroll_items i WHERE i.run_id = r.run_id)
  END AS total_pay
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
  return rows.map((r) => num(r, ['round_no', 'employees', 'shifts', 'total_pay', 'cases', 'payouts']));
}

export async function findById(runId) {
  const run = await sql.one(`SELECT r.*, ${RUN_TOTALS} FROM payroll_runs r WHERE r.run_id = :id`, {
    id: runId,
  });
  if (!run) return null;

  /* ร่าง = คิดจากก้อนที่ผูกอยู่ · จ่าย/ยกเลิกแล้ว = อ่านที่ตรึงไว้
     COALESCE เผื่อสลิปที่ไม่เหลือก้อนเงินเลย (ถูกถอนคืนหมด) — ให้เป็นศูนย์ ไม่ใช่ null */
  const items = await sql.all(
    /* cases/payouts อ่านสดเสมอ (ไม่เข้า CASE WHEN :draft) — เป็นจำนวนชิ้นงาน ไม่ใช่ยอดเงินที่ต้องตรึง */
    `SELECT i.item_id, i.employee_id, i.employee_name,
            CASE WHEN :draft THEN COALESCE(t.shifts, 0)    ELSE i.shifts    END AS shifts,
            CASE WHEN :draft THEN COALESCE(t.minutes, 0)   ELSE i.minutes   END AS minutes,
            CASE WHEN :draft THEN COALESCE(t.total_pay, 0) ELSE i.total_pay END AS total_pay,
            COALESCE(t.cases, 0)   AS cases,
            COALESCE(t.payouts, 0) AS payouts
     FROM payroll_items i
     LEFT JOIN (${LIVE_ITEMS}) t ON t.item_id = i.item_id
     WHERE i.run_id = :id
     ORDER BY i.employee_name`,
    { id: runId, draft: run.status === 'draft' },
  );

  return {
    ...num(run, ['round_no', 'employees', 'shifts', 'total_pay', 'cases', 'payouts']),
    items: items.map((i) => num(i, ['shifts', 'minutes', 'total_pay', 'cases', 'payouts'])),
  };
}

/**
 * ก้อนเงินทั้งหมดที่อยู่ในสลิปใบหนึ่ง — ที่มาของยอด ให้กางดูได้ว่าเงินมาจากเคสไหน
 * (ชื่อเดิม itemVisits ตอนที่เงินยังผูกกับกะ — ตอนนี้หนึ่งบรรทัด = ค่าจ้างหนึ่งก้อนของหนึ่งเคส)
 */
export function itemPayouts(itemId) {
  return sql
    .all(
      `SELECT pl.payout_id, pl.amount, p.installment_no, p.shifts, p.minutes,
              p.due_date, p.released_at, p.released_by_name, p.note,
              p.case_id, c.title AS case_title, c.client_name,
              (SELECT MAX(p2.installment_no) FROM case_payouts p2 WHERE p2.case_id = p.case_id) AS case_installments
       FROM payroll_payout_lines pl
       JOIN case_payouts p ON p.payout_id = pl.payout_id
       LEFT JOIN cases c ON c.case_id = p.case_id
       WHERE pl.item_id = :id
       ORDER BY p.case_id, p.installment_no, pl.payout_id`,
      { id: itemId },
    )
    .then((rows) =>
      rows.map((r) => num(r, ['amount', 'shifts', 'minutes', 'installment_no', 'case_installments'])),
    );
}

export const findItem = (itemId) =>
  sql.one(
    `SELECT i.*, r.status AS run_status, r.run_id
     FROM payroll_items i JOIN payroll_runs r ON r.run_id = i.run_id
     WHERE i.item_id = :id`,
    { id: itemId },
  );

/** เอาคนออกจากรอบ — ก้อนเงินของเขากลับเข้ากองรอจ่ายทันที (payroll_payout_lines ถูกลบตาม) */
export const removeItem = (itemId) =>
  sql.run('DELETE FROM payroll_items WHERE item_id = :id', { id: itemId });

/**
 * ปิดรอบเป็น "จ่ายแล้ว" — ตรึงตัวเลขทั้งรอบ ณ วินาทีนี้ แล้วล็อก
 *
 * ยอดรายก้อนไม่ต้องคิดใหม่แล้ว (amount ตายตัวตั้งแต่ตอนปล่อย) เหลือแค่รวมขึ้นเป็นยอดสลิป
 * ให้ตรงกับก้อนที่ผูกอยู่จริง ณ ตอนกดจ่าย — เผื่อมีการถอนยอดคืนระหว่างที่รอบยังเป็นร่าง
 */
export async function pay(runId, { pay_date, method, note }, actor) {
  await transaction(async (tx) => {
    // 1) ยอดบนสลิป = ผลรวมของก้อนที่ผูกอยู่ (ล้างเป็นศูนย์ก่อน เผื่อสลิปที่ไม่เหลือก้อนเงินแล้ว)
    await tx.run(
      `UPDATE payroll_items SET shifts = 0, minutes = 0, total_pay = 0 WHERE run_id = :id`,
      { id: runId },
    );
    await tx.run(
      `UPDATE payroll_items i
       SET shifts = t.shifts, minutes = t.minutes, total_pay = t.total_pay
       FROM (${LIVE_ITEMS}) t
       WHERE i.item_id = t.item_id AND i.run_id = :id`,
      { id: runId },
    );

    // 2) ปิดรอบ
    await tx.run(
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
  });
  return findById(runId);
}

/**
 * ยกเลิกรอบ — รอบยังอยู่เป็นประวัติ แต่ก้อนเงินทั้งหมดกลับเข้ากองรอจ่าย
 * ลบเฉพาะ payroll_payout_lines ไม่ลบสลิป เพื่อให้ยังอ่านย้อนได้ว่ารอบที่ยกเลิกไปเคยจะจ่ายใครเท่าไหร่
 */
export async function cancel(runId) {
  await transaction(async (tx) => {
    await tx.run(
      `DELETE FROM payroll_payout_lines
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
export async function payslipsFor(employeeId) {
  const slips = await sql
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

  if (slips.length === 0) return [];

  const byItem = await payslipCases(slips.map((s) => s.item_id));
  return slips.map((s) => ({ ...s, cases: byItem.get(s.item_id) ?? [] }));
}

/**
 * ที่มาของยอดในสลิป แยกเป็นรายเคส — ยอดที่โอนเข้าบัญชีเป็นก้อนเดียวรวมทุกเคส
 * แต่พนักงานต้องกางดูได้ว่าก้อนนั้นมาจากเคสไหน งวดที่เท่าไหร่ เคสละเท่าไหร่
 *
 * ไม่งั้นตัวเลขบนสลิปจะเป็นก้อนที่ตรวจสอบไม่ได้: พนักงานที่จำได้ว่า "เคสคุณสมชายตกลงกันไว้
 * งวดแรก 7,000" ไม่มีทางรู้เลยว่ายอดนั้นรวมอยู่ในสลิปใบนี้หรือยัง — ได้แต่เดาหรือไปถาม
 *
 * รวมเป็นแถวเดียวต่อเคส ไม่ใช่ต่อก้อนเงิน เพราะสลิปใบหนึ่งกวาดได้หลายงวดของเคสเดียวกัน
 * (ปล่อยงวด 1 กับงวด 2 ห่างกันสามวันแล้วปิดรอบทีเดียว) — เลขงวดยังอ่านได้จาก installments
 */
async function payslipCases(itemIds) {
  /* แตกรายการรหัสเป็น :i0..:in เอง — ตัวแปลง :name ส่ง array เข้า IN (...) ไม่ได้
     (แนวเดียวกับ listSlots ใน cases/repo.js) */
  const params = {};
  const slots = itemIds
    .map((id, i) => {
      params[`i${i}`] = id;
      return `:i${i}`;
    })
    .join(', ');

  const rows = await sql.all(
    `SELECT pl.item_id, p.case_id, p.installment_no, pl.amount, p.shifts,
            c.title AS case_title, c.client_name
     FROM payroll_payout_lines pl
     JOIN case_payouts p ON p.payout_id = pl.payout_id
     LEFT JOIN cases c ON c.case_id = p.case_id
     WHERE pl.item_id IN (${slots})
     ORDER BY p.case_id, p.installment_no, pl.payout_id`,
    params,
  );

  /* ลบเคสทิ้ง = ก้อนเงินของเคสนั้นหายตาม (CASCADE) แถวรายเคสของสลิปเก่าจึงหายไปด้วย
     ขณะที่ยอดรวมบนสลิปถูกตรึงไว้แล้วและไม่ขยับ — ที่มาจึงรวมได้ไม่ถึงยอดรวมในกรณีนั้น
     ซึ่งถูกแล้ว: เงินออกไปเท่าเดิมจริง แค่หลักฐานว่ามาจากงานชิ้นไหนถูกลบไป */
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    const list = byItem.get(r.item_id);

    const found = list.find((x) => x.case_id === r.case_id);
    const line = found ?? {
      case_id: r.case_id,
      case_title: r.case_title,
      client_name: r.client_name,
      amount: 0,
      shifts: 0,
      installments: [],
    };
    line.amount = Math.round((line.amount + Number(r.amount)) * 100) / 100;
    line.shifts += Number(r.shifts);
    // สลิปใบเดียวกินหลายงวดของเคสเดียวกันได้ แต่หนึ่งงวดมีก้อนเดียวต่อคน — กันเลขงวดซ้ำไว้เผื่อ
    if (!line.installments.includes(Number(r.installment_no))) {
      line.installments.push(Number(r.installment_no));
    }
    if (!found) list.push(line);
  }
  return byItem;
}
