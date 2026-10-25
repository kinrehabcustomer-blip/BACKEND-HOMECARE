import { sql } from '../db/index.js';
import { BLOCKED_STATUSES } from './auth.js';
/* case_family_links เป็นของ lib/family.js และไม่มีใน db/schema.sql — ไม่เรียกตัวสร้างของเจ้าของก่อน
   คิวรีข้างล่างจะพังด้วย relation "case_family_links" does not exist บนฐานใหม่ (พิสูจน์แล้ว)
   family.js ไม่ import ไฟล์นี้กลับ จึงไม่มี circular import */
import { ensureFamilyTable } from './family.js';

/**
 * ดาวสองทาง (ดร.ธงชัย 25 ต.ค. 2569 "ดาวพนักงานกับดาวลูกค้า … ไม่เห็นซึ่งกันและกัน ทำให้รู้ว่าปัญหาคืออะไร")
 *   ญาติให้ดาวผู้ดูแล (rater_kind 'family') · ผู้ดูแลให้ดาวบ้าน/ครอบครัว (rater_kind 'staff')
 *   ต่างฝ่ายไม่เห็นคะแนนของกัน — ทีมเห็นทุกคะแนน · ญาติ/ผู้ดูแลเห็นแค่ดาวเฉลี่ยของผู้ดูแล (เมื่อมีอย่างน้อย MIN_SHOW รีวิว)
 *   ถามผ่าน LINE (ฝั่ง chat): ญาติทาง OA Kin HomeCare · ผู้ดูแลทาง @kinjobs — ที่นี่เก็บคะแนนและบอกว่าเคสไหนถึงรอบถาม
 * รอบ: d3 = เริ่มงานครบ 3 วัน · w<n> = ทุก 14 วัน · end = ปิดเคสภายใน 3 วัน
 */
export const MIN_SHOW = 3;

let ready = null;
export const ensureRatingsTable = () =>
  (ready ??= (async () => {
    await sql.run(`CREATE TABLE IF NOT EXISTS case_ratings (
      rating_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      case_id      TEXT NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE ON UPDATE CASCADE,
      round        TEXT NOT NULL,
      rater_kind   TEXT NOT NULL CHECK (rater_kind IN ('family', 'staff')),
      rater_line   TEXT NOT NULL,
      employee_id  TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
      stars        INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
      reason       TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (case_id, round, rater_kind, rater_line)
    )`);
    await sql.run('CREATE INDEX IF NOT EXISTS idx_case_ratings_emp ON case_ratings (employee_id, rater_kind)');
    await sql.run('CREATE INDEX IF NOT EXISTS idx_case_ratings_case ON case_ratings (case_id)');
  })().catch((err) => {
    ready = null;
    throw err;
  }));

/* สถานะที่ใช้ระบบไม่ได้ ในรูปที่ต่อท้าย NOT IN (...) ได้ — อ้างค่าคงที่ตัวเดียวกับ middleware (lib/auth.js)
   ค่าเป็นคำที่เราเขียนเองทั้งหมด ไม่ได้มาจากผู้ใช้ */
const BLOCKED_SQL = Object.keys(BLOCKED_STATUSES)
  .map((s) => `'${s}'`)
  .join(', ');
const ACTIVE_EMP = (alias) => `COALESCE(${alias}.status, '') NOT IN (${BLOCKED_SQL})`;

/**
 * คนที่ "ทำกะจริงล่าสุด" ของเคส — คนไปแทน/เวรดึกไม่ใช่ผู้รับผิดชอบหลักเสมอไป
 *
 * ใช้ทั้งตอนตั้งชื่อในคำถาม (dueRatings) และตอนลงคะแนน (submitRating) ด้วยตรรกะเดียวกันโดยตั้งใจ —
 * เดิมสองที่ไม่ตรงกัน (ถามถึงผู้รับผิดชอบหลัก แต่ดาวลงคนที่เช็คอินจริง) ดาวต่ำแล้วทีมโทรคุยผิดคน
 * ข้ามคนที่ลาออก/ถูกพักงาน — ไม่ยิงคำถามถึงเขา และไม่สะสมดาวเข้าบัญชีที่ปิดไปแล้ว
 */
const lastWorkerSql = (caseRef) => `
  SELECT w.employee_id, w.first_name, w.nickname
  FROM case_visits v JOIN employees w ON w.employee_id = v.checked_in_by
  WHERE v.case_id = ${caseRef} AND v.status <> 'cancelled' AND ${ACTIVE_EMP('w')}
  ORDER BY v.check_in_at DESC NULLS LAST LIMIT 1`;

/** ชื่อที่โชว์ให้ญาติ: ชื่อต้น + ชื่อเล่นในวงเล็บ */
const label = (first, nick) => (first ? `${first}${nick ? ` (${nick})` : ''}` : null);

const todayBkk = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** รอบที่ถึงกำหนดวันนี้ของเคสหนึ่ง (null = ยังไม่ถึง) */
export function roundFor(c, today = todayBkk()) {
  if (c.status === 'closed') return 'end';
  if (!c.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(c.start_date)) return null;
  const d = daysBetween(c.start_date, today);
  if (d < 3) return null;
  if (d < 14) return 'd3';
  return `w${Math.floor(d / 14)}`;
}

/** เคสที่ถึงรอบถามดาววันนี้ + LINE ของญาติ/ผู้ดูแล — ฝั่ง chat กันถามซ้ำเอง (รอบเดิม คนเดิม ถามครั้งเดียว) */
export async function dueRatings() {
  await Promise.all([ensureRatingsTable(), ensureFamilyTable()]);
  const today = todayBkk();
  const rows = await sql.all(
    `SELECT c.case_id, c.client_name, c.status, c.start_date, c.assigned_to,
            e.first_name AS emp_first, e.nickname AS emp_nick, e.line_user_id AS emp_line,
            w.employee_id AS worker_id, w.first_name AS worker_first, w.nickname AS worker_nick,
            (SELECT array_agg(DISTINCT l.line_user_id) FROM case_family_links l
              WHERE l.case_id = c.case_id AND l.accepted_at IS NOT NULL AND l.revoked_at IS NULL AND l.line_user_id IS NOT NULL) AS family
     FROM cases c
     /* กรองสถานะที่ตัวคั่น ไม่ใช่ที่ WHERE — WHERE ข้างล่างเป็น A OR B การเติม AND ต่อท้ายจะผูกผิดวงเล็บ
        คนที่ลาออก/ถูกพักงานต้องไม่ถูกยิงคำถามดาว และญาติต้องไม่ถูกถามถึงชื่อเขา */
     JOIN employees e ON e.employee_id = c.assigned_to AND ${ACTIVE_EMP('e')}
     LEFT JOIN LATERAL (${lastWorkerSql('c.case_id')}) w ON true
     WHERE c.status IN ('assigned', 'in_progress')
        OR (c.status = 'closed' AND COALESCE(NULLIF(c.end_date, ''), left(c.updated_at, 10)) >= :since)`,
    // วันปิดเคส = end_date (ถ้ามี) — ไม่ใช้ updated_at ตรง ๆ เพราะเคสที่ปิดนานแล้วแต่มีคนแก้ข้อมูลวันนี้จะถูกถามดาวย้อนหลัง
    { since: new Date(Date.now() + 7 * 3.6e6 - 3 * 864e5).toISOString().slice(0, 10) },
  );
  return rows
    .map((c) => ({ ...c, round: roundFor(c, today) }))
    .filter((c) => c.round && (c.family?.length || c.emp_line))
    .map((c) => ({
      case_id: c.case_id, round: c.round, client_first: String(c.client_name || '').split(' ')[0] || null,
      /* ดาวจากญาติลงที่ "คนทำกะจริงล่าสุด" (ดู submitRating) ชื่อที่ถามจึงต้องเป็นคนเดียวกัน
         ไม่ใช่ผู้รับผิดชอบหลัก — ไม่งั้นดาวต่ำแล้วทีมโทรคุยผิดคน */
      employee_id: c.worker_id || c.assigned_to,
      employee_name: c.worker_id ? label(c.worker_first, c.worker_nick) : label(c.emp_first, c.emp_nick),
      /* LINE ที่ใช้ถาม "ดาวฝั่งผู้ดูแล" ยังเป็นของผู้รับผิดชอบหลักเสมอ — submitRating ฝั่ง staff
         ตรวจสิทธิ์กับ cases.assigned_to ถ้าส่ง LINE ของคนไปแทนมา จะถูกปฏิเสธเป็น not_assignee */
      employee_line: c.emp_line || null, family: c.family || [],
    }));
}

/**
 * บันทึกดาว (ส่งซ้ำ = แก้ดาว/เติมเหตุผล) · ตรวจว่าคนให้ดาวเป็นญาติที่ผูกเคส หรือเป็นผู้ดูแลของเคสจริง
 * คืน { ok, low } หรือ { error }
 */
export async function submitRating({ caseId, round, kind, line, stars, reason }) {
  await Promise.all([ensureRatingsTable(), ensureFamilyTable()]);
  const c = await sql.one(
    `SELECT c.case_id, c.assigned_to, a.first_name AS emp_first, a.nickname AS emp_nick
     FROM cases c LEFT JOIN employees a ON a.employee_id = c.assigned_to
     WHERE c.case_id = :id`,
    { id: caseId },
  );
  if (!c) return { error: 'not_found' };
  if (kind === 'family') {
    const ok = await sql.one(
      `SELECT 1 AS ok FROM case_family_links WHERE case_id = :id AND line_user_id = :line AND accepted_at IS NOT NULL AND revoked_at IS NULL`,
      { id: caseId, line });
    if (!ok) return { error: 'not_family' };
  } else {
    const ok = await sql.one('SELECT 1 AS ok FROM employees WHERE employee_id = :emp AND line_user_id = :line', { emp: c.assigned_to, line });
    if (!ok) return { error: 'not_assignee' };
  }
  // ดาวจากญาติ = ของคนที่ทำกะจริงล่าสุดของเคส (คนแทน/เวรดึกคนละคน) · ยังไม่มีกะ = ผู้ดูแลหลัก
  // ใช้ lastWorkerSql ตัวเดียวกับ dueRatings — คนที่ถูกถามถึงกับคนที่ดาวลงต้องเป็นคนเดียวกันเสมอ
  const worker = kind === 'family' ? await sql.one(lastWorkerSql(':id'), { id: caseId }) : null;
  const ratedId = worker?.employee_id || c.assigned_to;
  await sql.run(
    `INSERT INTO case_ratings (case_id, round, rater_kind, rater_line, employee_id, stars, reason)
     VALUES (:id, :round, :kind, :line, :emp, :stars, :reason)
     ON CONFLICT (case_id, round, rater_kind, rater_line)
     DO UPDATE SET stars = EXCLUDED.stars, reason = COALESCE(EXCLUDED.reason, case_ratings.reason), updated_at = now()`,
    { id: caseId, round, kind, line, emp: ratedId, stars, reason: reason ? String(reason).slice(0, 200) : null },
  );
  /* คืนคนที่ดาวลงจริงไปด้วย — ฝั่ง chat เอาไปใส่ในข้อความแจ้งทีมตอนดาวต่ำ
     ไม่งั้นข้อความจะระบุผู้รับผิดชอบหลัก ทั้งที่คนที่ไปบ้านคืนนั้นเป็นอีกคน */
  return {
    ok: true,
    low: stars <= 2,
    employee_id: ratedId || null,
    employee_name: worker ? label(worker.first_name, worker.nickname) : label(c.emp_first, c.emp_nick),
  };
}

/** ดาวเฉลี่ยของผู้ดูแลจากญาติ → { avg, n } (n < MIN_SHOW = ไม่โชว์ avg) · days = นับเฉพาะช่วงล่าสุด (ระดับพนักงานใช้ 90 วัน) */
export async function employeeStars(employeeId, days = null) {
  if (!employeeId) return { avg: null, n: 0 };
  await ensureRatingsTable();
  const r = await sql.one(
    `SELECT round(avg(stars)::numeric, 1)::float AS avg, count(*)::int AS n FROM case_ratings
     WHERE employee_id = :emp AND rater_kind = 'family'${days ? ` AND COALESCE(updated_at, created_at) > now() - make_interval(days => ${Number(days) | 0})` : ''}`,
    { emp: employeeId });
  return { avg: r.n >= MIN_SHOW ? r.avg : null, n: r.n };
}

/** ดาวทั้งหมดของเคส (ทีมเท่านั้น) */
export async function caseRatings(caseId) {
  await ensureRatingsTable();
  return sql.all(
    `SELECT round, rater_kind, stars, reason, created_at, updated_at FROM case_ratings WHERE case_id = :id ORDER BY created_at DESC`,
    { id: caseId });
}
