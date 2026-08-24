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
 * ข้อมูลของ payout ชุดที่ fill ล็อกและยืนยันแล้วว่าจะรับเข้ารอบนี้
 * ไม่มี NOT EXISTS ตรงนี้โดยตั้งใจ: หลัง re-check เราตรึงรายการ ID ไว้ชุดเดียว เพื่อให้ INSERT
 * payroll_items กับ payroll_payout_lines เห็นสมาชิกตรงกันแม้รอบอื่นถูกยกเลิกระหว่างสอง statement
 */
const LOCKED_PAYOUT_ROWS = `
  SELECT p.payout_id, p.case_id, p.employee_id, p.employee_name,
         p.shifts, p.minutes, p.amount, p.due_date,
         ${RELEASE_DATE} AS release_date
  FROM case_payouts p
  WHERE p.payout_id = ANY(:payout_ids::int[])
    AND p.employee_id IS NOT NULL
    AND ${RELEASE_DATE} <= :period_to
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

/** สถานะที่ยอมให้แต่ละคำสั่งทำงาน — ใช้กับ snapshot ที่อ่านหลังได้ row lock แล้วเท่านั้น */
const RUN_ACTION_STATES = {
  rebuild: ['draft'],
  remove_item: ['draft'],
  pay: ['draft'],
  cancel: ['draft', 'paid'],
  remove: ['draft'],
};

export function assessPayrollRunAction(action, status) {
  const allowed = RUN_ACTION_STATES[action];
  if (!allowed) throw new Error(`ไม่รู้จักคำสั่ง payroll: ${action}`);
  return allowed.includes(status) ? { status } : { reason: 'invalid_status', status };
}

/**
 * ล็อกรอบก่อนตรวจสถานะทุกครั้ง — route param เป็นเพียงข้อมูลสำหรับแสดงผลและอาจเก่าได้แล้ว
 * คำสั่งของรอบเดียวกันจึงต่อคิวกัน และคนที่ได้ lock ทีหลังจะตัดสินจากสถานะที่คำสั่งก่อนหน้า commit จริง
 */
export async function payrollRunForUpdate(tx, runId, action) {
  const run = await tx.one(
    `SELECT run_id, status, period_month, period_to
     FROM payroll_runs WHERE run_id = :id FOR UPDATE`,
    { id: runId },
  );
  if (!run) return { reason: 'not_found' };

  const assessment = assessPayrollRunAction(action, run.status);
  return assessment.reason ? { ...assessment, run } : { run };
}

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
  const lockParams = { period_to: periodTo };

  /* ล็อกก้อนเงินจริงก่อนผูกเข้ารอบ — cancelPayout ล็อกแถวเดียวกันก่อนลบ
     จึงไม่มีช่วงที่ก้อนถูกถอนพร้อมกับกำลังถูก fill เข้า payroll run คนละ transaction

     เก็บ ID จาก statement นี้ไว้ด้วย: ถ้า query สร้างสลิปกลับไปอ่าน ELIGIBLE ใหม่ ยอดที่เพิ่งถูกปล่อย
     หลัง statement lock จบจะหลุดเข้ารอบโดยไม่เคยถูกล็อก และชนกับการถอนยอดได้ */
  const locked = await tx.all(
    `SELECT p.payout_id
     ${ELIGIBLE}
     ORDER BY p.payout_id
     FOR UPDATE OF p`,
    lockParams,
  );
  if (locked.length === 0) return;

  /* SELECT FOR UPDATE อาจเริ่มด้วย snapshot ที่ payout ยังว่าง แล้วต้องรอ fill อื่นซึ่งผูกก้อนนั้น
     ไปก่อนเรา — อ่านใหม่หลังได้ lock เพื่อคัด snapshot เก่าทิ้ง จากนั้นใช้ ID ชุดนี้เหมือนกันทั้งสอง INSERT */
  const available = await tx.all(
    `SELECT p.payout_id
     FROM case_payouts p
     WHERE p.payout_id = ANY(:payout_ids::int[])
       AND p.employee_id IS NOT NULL
       AND ${RELEASE_DATE} <= :period_to
       AND NOT EXISTS (SELECT 1 FROM payroll_payout_lines pl WHERE pl.payout_id = p.payout_id)
     ORDER BY p.payout_id`,
    {
      period_to: periodTo,
      payout_ids: locked.map((row) => Number(row.payout_id)),
    },
  );
  if (available.length === 0) return;

  const params = {
    run: runId,
    period_to: periodTo,
    payout_ids: available.map((row) => Number(row.payout_id)),
  };

  /* จัดกลุ่มด้วย "รหัสพนักงาน" เท่านั้น ไม่รวมชื่อ — employee_name ในแต่ละก้อนเป็น snapshot
     ณ วันที่ปล่อย คนที่เปลี่ยนชื่อ/นามสกุลระหว่างทางจึงมีก้อนที่ชื่อไม่ตรงกันได้

     ถ้าจัดกลุ่มด้วยชื่อด้วย คนคนเดียวจะได้สลิปสองใบ แล้ว INSERT ถัดไป (ที่ผูกด้วย employee_id
     อย่างเดียว) จะผูกก้อนเดียวกันเข้าสองใบ ชน PRIMARY KEY ของ payroll_payout_lines.payout_id
     ผลคือ "เปิดรอบจ่ายไม่ได้ทั้งเดือน" โดยไม่มีอะไรบอกว่าเพราะมีคนเปลี่ยนชื่อ
     (ถ้าไม่ชน PK ก็จะกลายเป็นนับกะ/ยอดซ้ำสองเท่าแทน ซึ่งแย่กว่า)

     ชื่อบนสลิปใช้ของก้อนล่าสุด — เป็นชื่อที่ใกล้วันจ่ายที่สุด ตรงกับที่คนรับใช้อยู่จริงตอนนี้ */
  await tx.run(
    `INSERT INTO payroll_items (run_id, employee_id, employee_name, shifts, minutes, total_pay)
     SELECT :run, x.employee_id,
            (array_agg(x.employee_name ORDER BY x.payout_id DESC))[1],
            COALESCE(SUM(x.shifts), 0)::int,
            COALESCE(SUM(x.minutes), 0)::int,
            SUM(x.amount)
     FROM (${LOCKED_PAYOUT_ROWS}) x
     GROUP BY x.employee_id`,
    params,
  );

  await tx.run(
    `INSERT INTO payroll_payout_lines (payout_id, item_id, amount)
     SELECT x.payout_id, i.item_id, x.amount
     FROM (${LOCKED_PAYOUT_ROWS}) x
     JOIN payroll_items i ON i.run_id = :run AND i.employee_id = x.employee_id`,
    params,
  );
}

const MAX_ROUNDS_PER_MONTH = 3;

/** เลือกเลข 1–3 ตัวแรกที่ยังไม่มีรอบ active — COUNT + 1 ใช้ไม่ได้เมื่อรอบก่อนหน้าถูกยกเลิกจนเกิดช่องว่าง */
export function firstAvailablePayrollRound(activeRounds) {
  const used = new Set(activeRounds.map((row) => Number(row?.round_no ?? row)));
  for (let round = 1; round <= MAX_ROUNDS_PER_MONTH; round += 1) {
    if (!used.has(round)) return round;
  }
  return null;
}

export async function payrollMonthForUpdate(tx, periodMonth) {
  await tx.one(
    `SELECT pg_advisory_xact_lock(
       hashtext('homecare.payroll_runs'),
       hashtext(:month)
     ) AS locked`,
    { month: periodMonth },
  );
}

/**
 * จองสิทธิ์เลือกเลขรอบของเดือนนี้จน transaction จบ
 *
 * payroll_runs ไม่มีแถวแม่ประจำเดือนให้ SELECT FOR UPDATE ตอนที่ยังไม่เคยเปิดรอบ จึงใช้ transaction-level
 * advisory lock แยกตาม period_month แทน คำขอสร้างรอบเดือนเดียวกันจะต่อคิว ส่วนคนละเดือนยังทำพร้อมกันได้
 * hash ชนกันได้แค่ทำให้คนละเดือนรอกันเกินจำเป็น ไม่ทำให้เลือกเลขผิด เพราะ query ยังกรองเดือนจริงอีกครั้ง
 */
export async function payrollRoundSlotForUpdate(tx, periodMonth) {
  await payrollMonthForUpdate(tx, periodMonth);

  // อ่านหลังได้ lock ด้วย statement ใหม่ เพื่อเห็นรอบที่คำขอก่อนหน้าเพิ่ง commit
  const rows = await tx.all(
    `SELECT round_no FROM payroll_runs
     WHERE period_month = :month AND status <> 'cancelled'
     ORDER BY round_no`,
    { month: periodMonth },
  );
  const active_rounds = rows.map((row) => Number(row.round_no));
  const round_no = firstAvailablePayrollRound(active_rounds);

  return round_no == null
    ? { reason: 'round_limit', period_month: periodMonth, active_rounds }
    : { period_month: periodMonth, round_no, active_rounds };
}

/**
 * การยกเลิก/ลบรอบคือการคืนช่องเลข 1–3 จึงต้องใช้ lock เดือนเดียวกับ createRun ด้วย
 * อ่านเดือนได้ก่อนแต่ยังไม่ใช้สถานะตัดสิน จากนั้น lock ตามลำดับ month → run เสมอเพื่อไม่สร้างวงจร deadlock
 */
export async function payrollRunForRoundSlotUpdate(tx, runId, action) {
  const initial = await tx.one(
    'SELECT period_month FROM payroll_runs WHERE run_id = :id',
    { id: runId },
  );
  if (!initial) return { reason: 'not_found' };

  await payrollMonthForUpdate(tx, initial.period_month);
  const state = await payrollRunForUpdate(tx, runId, action);
  if (!state.reason && state.run.period_month !== initial.period_month) {
    return { reason: 'state_changed', run: state.run };
  }
  return state;
}

/**
 * เปิดรอบ — เดือนกับเลขรอบมาจากวันตัดรอบ ไม่ได้ให้กรอกเอง
 * ป้ายชื่อจึงตรงกับสิ่งที่รอบกวาดมาจริงเสมอ (ดูเหตุผลเต็มใน schema.js)
 */
export async function createRunForTransaction(tx, { period_to, note }, actor) {
  const period_month = period_to.slice(0, 7);
  const slot = await payrollRoundSlotForUpdate(tx, period_month);
  if (slot.reason) return slot;
  const { round_no } = slot;

  // ขอเลข PAY หลังยืนยันว่ามีช่องแล้วเท่านั้น — คำขอที่เต็มจึงไม่กินเลข counter ทิ้ง
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
  return { run_id: runId };
}

export async function createRun(input, actor) {
  const result = await transaction((tx) => createRunForTransaction(tx, input, actor));
  if (result.reason) return result;
  return (await findById(result.run_id)) ?? { reason: 'not_found' };
}

/** ดึงยอดใหม่ทั้งรอบ (ร่างเท่านั้น) — ล้างของเดิมทิ้งแล้วกวาดใหม่ คนที่ถูกเอาออกไปจะกลับมาด้วย */
export async function rebuild(runId) {
  const result = await transaction(async (tx) => {
    const state = await payrollRunForUpdate(tx, runId, 'rebuild');
    if (state.reason) return state;

    await tx.run(
      `DELETE FROM payroll_items i
       WHERE i.run_id = :id
         AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.run_id = i.run_id AND r.status = 'draft')`,
      { id: runId },
    );
    await fill(tx, runId, state.run.period_to);
    return { run_id: runId };
  });
  if (result.reason) return result;
  return (await findById(result.run_id)) ?? { reason: 'not_found' };
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
     /* ใหม่สุดอยู่บนสุดเสมอ — เรียงตามเวลาที่เปิดรอบ ไม่ใช่ตามเลขรอบ
        เลขรอบเลือกจากช่อง 1–3 ที่ยังว่าง (ดู payrollRoundSlotForUpdate) เดือนที่ยกเลิกไปแล้วสองรอบจึงมี "รอบที่ 1"
        ใบใหม่เกิดขึ้นได้อีก แล้วมันจะไปโผล่ท้ายรายการใต้รอบที่ยกเลิกซึ่งเก่ากว่ามาก
        run_id ปิดท้ายไว้เผื่อสองรอบเปิดในวินาทีเดียวกัน (created_at ละเอียดถึงแค่วินาที) */
     ORDER BY r.period_month DESC, r.created_at DESC, r.run_id DESC`,
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
export async function removeItem(runId, itemId) {
  const result = await transaction(async (tx) => {
    const state = await payrollRunForUpdate(tx, runId, 'remove_item');
    if (state.reason) return state;

    const removed = await tx.run(
      `DELETE FROM payroll_items i
       WHERE i.item_id = :item_id AND i.run_id = :run_id
         AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.run_id = i.run_id AND r.status = 'draft')`,
      { item_id: itemId, run_id: runId },
    );
    return removed > 0 ? { run_id: runId } : { reason: 'item_not_found' };
  });
  if (result.reason) return result;
  return (await findById(result.run_id)) ?? { reason: 'not_found' };
}

/**
 * ปิดรอบเป็น "จ่ายแล้ว" — ตรึงตัวเลขทั้งรอบ ณ วินาทีนี้ แล้วล็อก
 *
 * ยอดรายก้อนไม่ต้องคิดใหม่แล้ว (amount ตายตัวตั้งแต่ตอนปล่อย) เหลือแค่รวมขึ้นเป็นยอดสลิป
 * ให้ตรงกับก้อนที่ผูกอยู่จริง ณ ตอนกดจ่าย — เผื่อมีการถอนยอดคืนระหว่างที่รอบยังเป็นร่าง
 */
export async function pay(runId, { pay_date, method, note }, actor) {
  const result = await transaction(async (tx) => {
    const state = await payrollRunForUpdate(tx, runId, 'pay');
    if (state.reason) return state;

    // อ่านหลังได้ lock ด้วย statement ใหม่ — remove/rebuild ที่ commit ก่อนหน้าจึงสะท้อนในจำนวนล่าสุด
    const counts = await tx.one(
      `SELECT COUNT(DISTINCT i.item_id) AS employees, COUNT(pl.payout_id) AS payouts
       FROM payroll_items i
       LEFT JOIN payroll_payout_lines pl ON pl.item_id = i.item_id
       WHERE i.run_id = :id`,
      { id: runId },
    );
    if (Number(counts.employees) === 0 || Number(counts.payouts) === 0) {
      return { reason: 'empty_run' };
    }

    // 1) ยอดบนสลิป = ผลรวมของก้อนที่ผูกอยู่ (ล้างเป็นศูนย์ก่อน เผื่อสลิปที่ไม่เหลือก้อนเงินแล้ว)
    await tx.run(
      `UPDATE payroll_items i SET shifts = 0, minutes = 0, total_pay = 0
       WHERE i.run_id = :id
         AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.run_id = i.run_id AND r.status = 'draft')`,
      { id: runId },
    );
    await tx.run(
      `UPDATE payroll_items i
       SET shifts = t.shifts, minutes = t.minutes, total_pay = t.total_pay
       FROM (${LIVE_ITEMS}) t
       WHERE i.item_id = t.item_id AND i.run_id = :id
         AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.run_id = i.run_id AND r.status = 'draft')`,
      { id: runId },
    );

    // 2) ปิดรอบ
    const transitioned = await tx.run(
      `UPDATE payroll_runs
       SET status = 'paid', pay_date = :pay_date, method = :method,
           note = COALESCE(:note, note),
           paid_by = :by, paid_by_name = :by_name, updated_at = ${NOW}
       WHERE run_id = :id AND status = 'draft'`,
      {
        id: runId,
        pay_date,
        method: method ?? null,
        note: note ?? null,
        by: actor?.employee_id ?? null,
        by_name: actor?.name ?? null,
      },
    );
    if (transitioned !== 1) throw new Error(`สถานะรอบ ${runId} เปลี่ยนหลังได้ row lock`);
    return { run_id: runId };
  });
  if (result.reason) return result;
  return (await findById(result.run_id)) ?? { reason: 'not_found' };
}

/**
 * ยกเลิกรอบ — รอบยังอยู่เป็นประวัติ แต่ก้อนเงินทั้งหมดกลับเข้ากองรอจ่าย
 * ลบเฉพาะ payroll_payout_lines ไม่ลบสลิป เพื่อให้ยังอ่านย้อนได้ว่ารอบที่ยกเลิกไปเคยจะจ่ายใครเท่าไหร่
 */
export async function cancel(runId) {
  const result = await transaction(async (tx) => {
    const state = await payrollRunForRoundSlotUpdate(tx, runId, 'cancel');
    if (state.reason) return state;

    await tx.run(
      `DELETE FROM payroll_payout_lines
       WHERE item_id IN (SELECT item_id FROM payroll_items WHERE run_id = :id)
         AND EXISTS (SELECT 1 FROM payroll_runs WHERE run_id = :id AND status IN ('draft', 'paid'))`,
      { id: runId },
    );
    const transitioned = await tx.run(
      `UPDATE payroll_runs SET status = 'cancelled', updated_at = ${NOW}
       WHERE run_id = :id AND status IN ('draft', 'paid')`,
      { id: runId },
    );
    if (transitioned !== 1) throw new Error(`สถานะรอบ ${runId} เปลี่ยนหลังได้ row lock`);
    return { run_id: runId };
  });
  if (result.reason) return result;
  return (await findById(result.run_id)) ?? { reason: 'not_found' };
}

export function remove(runId) {
  return transaction(async (tx) => {
    const state = await payrollRunForRoundSlotUpdate(tx, runId, 'remove');
    if (state.reason) return state;

    const removed = await tx.run(
      `DELETE FROM payroll_runs WHERE run_id = :id AND status = 'draft'`,
      { id: runId },
    );
    if (removed !== 1) throw new Error(`สถานะรอบ ${runId} เปลี่ยนหลังได้ row lock`);
    return { ok: true };
  });
}

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
