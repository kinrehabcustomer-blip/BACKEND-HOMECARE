import { randomBytes } from 'node:crypto';
import { sql } from '../db/index.js';
import { REVIEW_QUESTIONS } from './schema.js';

/**
 * ตำแหน่งที่เปิดให้ออกลิงก์ประเมินได้
 *
 * เริ่มที่นักกายภาพบำบัดก่อนตามที่ตกลงไว้ — หัวข้อทั้ง 10 ข้อเขียนด้วยคำของงานกายภาพ
 * ("การรักษา" / "ฝึกต่อเนื่องที่บ้าน") ซึ่งอ่านแล้วเพี้ยนถ้าเอาไปใช้กับผู้ช่วยพยาบาลตรงๆ
 * ขยายไปตำแหน่งอื่นทำได้โดยเติมในนี้ + แก้ป้ายคำถามฝั่งหน้าเว็บ ไม่ต้องแตะตาราง
 */
export const REVIEW_POSITIONS = ['therapist'];

/** ผลรวมคะแนน 10 ข้อของหนึ่งใบ — ใช้ทั้งค่าเฉลี่ยรวมและการแจกแจงจำนวนดาว */
const scoreSum = (prefix = '') => REVIEW_QUESTIONS.map((q) => `${prefix}${q}`).join(' + ');

/* ค่าเฉลี่ยของ "หนึ่งใบ" = ผลรวม 10 ข้อ ÷ 10 — คะแนนรวมของพนักงานคือค่าเฉลี่ยของทุกใบอีกที
   หาร 10.0 (ไม่ใช่ 10) เพื่อให้ Postgres คิดเป็นทศนิยม ไม่ใช่หารจำนวนเต็มแล้วปัดทิ้ง */
const perReviewAvg = (prefix = '') => `((${scoreSum(prefix)}) / 10.0)`;

// ---------- ลิงก์ประเมินรายบุคคล ----------

/** สุ่ม token ของลิงก์ — 16 ไบต์จาก CSPRNG เดาไม่ได้ และสั้นพอจะพิมพ์ตามได้ถ้าจำเป็น */
const newToken = () => randomBytes(16).toString('base64url');

/**
 * พนักงานเจ้าของลิงก์ — คืนเฉพาะข้อมูลที่หน้าฟอร์มสาธารณะต้องใช้จริง
 *
 * หน้านี้ไม่ต้อง login ใครถือลิงก์ก็เปิดได้ จึงไม่คืนอีเมล/เบอร์/รหัสพนักงานออกไป
 * (status ใช้ตัดสินว่ายังรับประเมินอยู่ไหม ไม่ได้ส่งต่อให้หน้าเว็บ)
 */
export const findByToken = (token) =>
  sql.one(
    `SELECT employee_id, first_name, last_name, position, status
     FROM employees WHERE review_token = :token`,
    { token },
  );

/**
 * ลิงก์ปัจจุบันของพนักงาน — ยังไม่เคยออกก็ออกให้เลยตอนเปิดดูครั้งแรก
 *
 * ทำให้ปุ่ม "คัดลอกลิงก์" ใช้ได้ทันทีโดยไม่ต้องมีขั้นตอน "สร้างลิงก์" แยกอีกจังหวะ
 * WHERE review_token IS NULL ทำให้เรียกซ้ำไม่เปลี่ยน token ที่แจกออกไปแล้ว
 */
export async function ensureToken(employeeId) {
  const row = await sql.one(
    `UPDATE employees SET review_token = :token
     WHERE employee_id = :id AND review_token IS NULL
     RETURNING review_token`,
    { token: newToken(), id: employeeId },
  );
  if (row) return row.review_token;

  const existing = await sql.one('SELECT review_token FROM employees WHERE employee_id = :id', {
    id: employeeId,
  });
  return existing?.review_token ?? null;
}

/** ออกลิงก์ใหม่ — ลิงก์/QR เดิมที่แจกไปแล้วใช้ไม่ได้ทันที (ใช้ตอนลิงก์หลุดไปที่ที่ไม่ควรอยู่) */
export const rotateToken = (employeeId) =>
  sql
    .one(
      `UPDATE employees SET review_token = :token WHERE employee_id = :id RETURNING review_token`,
      { token: newToken(), id: employeeId },
    )
    .then((r) => r?.review_token ?? null);

// ---------- รับแบบประเมิน ----------

/**
 * เครื่องเดิมเพิ่งส่งใบให้คนเดิมไปหรือยัง (ภายในกี่นาทีที่กำหนด)
 *
 * เป็นด่านกันกดส่งซ้ำ ไม่ใช่ด่านกันโหวตซ้ำ — ญาติหลายคนในบ้านเดียวกันใช้ไวไฟตัวเดียวกัน
 * และควรประเมินได้คนละใบ ช่วงเวลาจึงสั้น (นาที) ไม่ใช่ล็อกทั้งวัน
 */
export const recentDuplicate = (employeeId, ipHash, minutes) =>
  sql
    .one(
      `SELECT 1 AS hit FROM staff_reviews
       WHERE employee_id = :id AND ip_hash = :ip_hash
         AND submitted_at > to_char(
               (now() AT TIME ZONE 'Asia/Bangkok') - make_interval(mins => :minutes),
               'YYYY-MM-DD HH24:MI:SS')
       LIMIT 1`,
      { id: employeeId, ip_hash: ipHash, minutes },
    )
    .then(Boolean);

/** จำนวนใบที่พนักงานคนนี้ได้รับใน 24 ชม. ที่ผ่านมา — เพดานกันคนไล่ยิงใบปลอมรัวๆ */
export const countRecent = (employeeId) =>
  sql
    .one(
      `SELECT COUNT(*)::int AS n FROM staff_reviews
       WHERE employee_id = :id
         AND submitted_at > to_char(
               (now() AT TIME ZONE 'Asia/Bangkok') - interval '24 hours',
               'YYYY-MM-DD HH24:MI:SS')`,
      { id: employeeId },
    )
    .then((r) => r.n);

const INSERT_COLUMNS = [
  'patient_name',
  'service_date',
  ...REVIEW_QUESTIONS,
  'impressed',
  'improve',
  'want_again',
  'recommend',
];

export async function submit(employeeId, input, ipHash) {
  const columns = ['employee_id', ...INSERT_COLUMNS, 'ip_hash'];
  const values = { employee_id: employeeId, ip_hash: ipHash };
  for (const c of INSERT_COLUMNS) values[c] = input[c] ?? null;

  return sql.one(
    `INSERT INTO staff_reviews (${columns.join(', ')})
     VALUES (${columns.map((c) => `:${c}`).join(', ')})
     RETURNING review_id, submitted_at`,
    values,
  );
}

// ---------- รายงานฝั่งหลังบ้าน ----------

/**
 * คะแนนรวมของพนักงานทุกคนที่เปิดรับประเมิน — คนที่ยังไม่มีใบก็ต้องอยู่ในรายการ
 *
 * LEFT JOIN ไม่ใช่ JOIN: คนที่เพิ่งเข้ามาและยังไม่มีใครประเมินคือคนที่ผู้จัดการต้องเห็น
 * มากที่สุด (เพื่อจะได้ส่งลิงก์ให้) — ถ้าหายไปจากตารางก็ไม่มีอะไรบอกว่าเขาตกหล่น
 */
export const summary = () =>
  sql.all(
    `SELECT e.employee_id, e.first_name, e.last_name, e.position, e.status,
            e.review_token IS NOT NULL AS has_link,
            COUNT(r.review_id)::int          AS review_count,
            AVG(${perReviewAvg('r.')})::float8 AS avg_score,
            AVG(r.q_overall)::float8         AS avg_overall,
            MAX(r.submitted_at)              AS last_review_at
     FROM employees e
     LEFT JOIN staff_reviews r ON r.employee_id = e.employee_id
     -- cast ให้ชัดว่าเป็น text[] ไม่ปล่อยให้ Postgres เดาชนิดของอาร์เรย์ที่ส่งมาเอง
     WHERE e.position = ANY (:positions::text[])
     GROUP BY e.employee_id
     ORDER BY avg_score DESC NULLS LAST, review_count DESC, e.first_name`,
    { positions: REVIEW_POSITIONS },
  );

/** ค่าเฉลี่ยรายหัวข้อของพนักงานคนเดียว — คืนคีย์ตามชื่อคอลัมน์ ให้หน้าเว็บจับคู่กับป้ายของตัวเอง */
const questionAverages = (employeeId) =>
  sql.one(
    `SELECT ${REVIEW_QUESTIONS.map((q) => `AVG(${q})::float8 AS ${q}`).join(', ')}
     FROM staff_reviews WHERE employee_id = :id`,
    { id: employeeId },
  );

/**
 * แจกแจงว่าได้ใบละกี่ดาว (ปัดค่าเฉลี่ยของใบนั้นเป็นจำนวนเต็ม)
 * คืนครบ 1–5 เสมอ ช่องที่ไม่มีใครให้เป็น 0 — กราฟแท่งจะได้ไม่ขาดแท่งหายไปเฉยๆ
 */
async function starDistribution(employeeId) {
  const rows = await sql.all(
    `SELECT ROUND(${perReviewAvg()})::int AS star, COUNT(*)::int AS n
     FROM staff_reviews WHERE employee_id = :id
     GROUP BY star`,
    { id: employeeId },
  );
  const found = Object.fromEntries(rows.map((r) => [r.star, r.n]));
  return [5, 4, 3, 2, 1].map((star) => ({ star, count: found[star] ?? 0 }));
}

/** นับคำตอบของคำถามปลายปิด (อยากให้กลับมาดูแลไหม / จะแนะนำ KIN ไหม) */
const choiceCounts = (employeeId, column) =>
  sql
    .all(
      `SELECT ${column} AS choice, COUNT(*)::int AS n
       FROM staff_reviews WHERE employee_id = :id AND ${column} IS NOT NULL
       GROUP BY choice`,
      { id: employeeId },
    )
    .then((rows) => Object.fromEntries(rows.map((r) => [r.choice, r.n])));

/**
 * ใบล่าสุดของพนักงานคนหนึ่ง — ใหม่สุดอยู่บน
 * ไม่คืน ip_hash ออกไปไหนทั้งสิ้น มันมีไว้ให้ recentDuplicate ใช้อย่างเดียว
 */
const listReviews = (employeeId, limit) =>
  sql.all(
    `SELECT review_id, patient_name, service_date, submitted_at,
            ${REVIEW_QUESTIONS.join(', ')},
            ${perReviewAvg()}::float8 AS avg_score,
            impressed, improve, want_again, recommend
     FROM staff_reviews WHERE employee_id = :id
     ORDER BY submitted_at DESC, review_id DESC
     LIMIT :limit`,
    { id: employeeId, limit },
  );

/** พนักงานหนึ่งคนเท่าที่ฝั่งรายงานต้องใช้ — ใช้ทั้งหน้ารายละเอียดและตอนออกลิงก์ */
export const findEmployee = (employeeId) =>
  sql.one(
    `SELECT employee_id, first_name, last_name, position, status, review_token
     FROM employees WHERE employee_id = :id`,
    { id: employeeId },
  );

/** หน้ารายละเอียดรายบุคคล: หัวคะแนน + ค่าเฉลี่ยรายหัวข้อ + การแจกแจง + ใบทั้งหมด */
export async function employeeDetail(employeeId, limit = 200) {
  const employee = await findEmployee(employeeId);
  if (!employee) return null;

  const [head, questions, stars, wantAgain, recommend, reviews] = await Promise.all([
    sql.one(
      `SELECT COUNT(*)::int AS review_count,
              AVG(${perReviewAvg()})::float8 AS avg_score,
              MAX(submitted_at) AS last_review_at
       FROM staff_reviews WHERE employee_id = :id`,
      { id: employeeId },
    ),
    questionAverages(employeeId),
    starDistribution(employeeId),
    choiceCounts(employeeId, 'want_again'),
    choiceCounts(employeeId, 'recommend'),
    listReviews(employeeId, limit),
  ]);

  return { employee, ...head, questions, stars, want_again: wantAgain, recommend, reviews };
}

/** ลบใบที่เห็นชัดว่าไม่ใช่ความเห็นจริง (กดทดสอบ/ยิงมั่ว) — ค่าเฉลี่ยคิดใหม่เองตอนอ่าน */
export const removeReview = (reviewId) =>
  sql.run('DELETE FROM staff_reviews WHERE review_id = :id', { id: reviewId }).then((n) => n > 0);
