import { sql } from '../db/index.js';

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
  await ensureRatingsTable();
  const today = todayBkk();
  const rows = await sql.all(
    `SELECT c.case_id, c.client_name, c.status, c.start_date, c.assigned_to,
            e.first_name AS emp_first, e.nickname AS emp_nick, e.line_user_id AS emp_line,
            (SELECT array_agg(DISTINCT l.line_user_id) FROM case_family_links l
              WHERE l.case_id = c.case_id AND l.accepted_at IS NOT NULL AND l.revoked_at IS NULL AND l.line_user_id IS NOT NULL) AS family
     FROM cases c JOIN employees e ON e.employee_id = c.assigned_to
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
      employee_id: c.assigned_to, employee_name: c.emp_first ? `${c.emp_first}${c.emp_nick ? ` (${c.emp_nick})` : ''}` : null,
      employee_line: c.emp_line || null, family: c.family || [],
    }));
}

/**
 * บันทึกดาว (ส่งซ้ำ = แก้ดาว/เติมเหตุผล) · ตรวจว่าคนให้ดาวเป็นญาติที่ผูกเคส หรือเป็นผู้ดูแลของเคสจริง
 * คืน { ok, low } หรือ { error }
 */
export async function submitRating({ caseId, round, kind, line, stars, reason }) {
  await ensureRatingsTable();
  const c = await sql.one('SELECT case_id, assigned_to FROM cases WHERE case_id = :id', { id: caseId });
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
  const worker = kind === 'family'
    ? (await sql.one(
      `SELECT checked_in_by FROM case_visits WHERE case_id = :id AND checked_in_by IS NOT NULL AND status <> 'cancelled'
       ORDER BY check_in_at DESC NULLS LAST LIMIT 1`, { id: caseId }))?.checked_in_by
    : null;
  await sql.run(
    `INSERT INTO case_ratings (case_id, round, rater_kind, rater_line, employee_id, stars, reason)
     VALUES (:id, :round, :kind, :line, :emp, :stars, :reason)
     ON CONFLICT (case_id, round, rater_kind, rater_line)
     DO UPDATE SET stars = EXCLUDED.stars, reason = COALESCE(EXCLUDED.reason, case_ratings.reason), updated_at = now()`,
    { id: caseId, round, kind, line, emp: worker || c.assigned_to, stars, reason: reason ? String(reason).slice(0, 200) : null },
  );
  return { ok: true, low: stars <= 2 };
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
