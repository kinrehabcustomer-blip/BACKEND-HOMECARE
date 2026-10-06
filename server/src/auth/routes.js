import { randomInt, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { ApiError, asyncRoute } from '../lib/errors.js';
import {
  BLOCKED_STATUSES,
  COOKIE_NAME,
  clearCookieOptions,
  cookieOptions,
  hashPassword,
  requireAuth,
  roleForPosition,
  signToken,
  verifyPassword,
} from '../lib/auth.js';
import { sendOtpEmail } from '../lib/mailer.js';

export const authRouter = Router();

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5; // เดารหัสผิดเกินนี้ OTP ใบนั้นตายทันที กัน brute-force 6 หลัก
const OTP_COOLDOWN_SECONDS = 60; // กันกดขอ OTP รัวๆ จนอีเมลถูกถล่ม

/* กันเดารหัสผ่านออนไลน์ — เก็บในฐานข้อมูล ไม่ใช่หน่วยความจำ เพราะบน Vercel แต่ละคำขออาจไปคนละ instance
   ตัวเลขตั้งให้คนพิมพ์ผิดจริงไม่โดน (10 ครั้งใน 15 นาที) แต่คนยิงเดาได้แค่ ~1,000 ครั้งต่อวันต่อบัญชี */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MINUTES = 15;

// hash ของค่าสุ่มที่ไม่มีใครรู้ — ใช้เทียบตอนไม่พบอีเมล ให้เวลาตอบเท่ากับกรณีรหัสผิด
const DUMMY_HASH = await hashPassword(randomUUID());

const recentLoginFailures = async (email) =>
  (
    await sql.one(
      `SELECT count(*)::int AS n FROM login_failures
       WHERE email_key = lower(:email) AND created_at > now() - make_interval(mins => :mins)`,
      { email, mins: LOGIN_LOCK_MINUTES },
    )
  ).n;

const clearLoginFailures = (email) =>
  sql.run('DELETE FROM login_failures WHERE email_key = lower(:email)', { email });

const loginSchema = z.object({
  email: z.string().trim().min(1, 'กรุณากรอกอีเมลหรือรหัสพนักงาน'),
  password: z.string().min(1, 'กรุณากรอกรหัสผ่าน'),
});

// รหัสผ่านใหม่ต้องไม่ใช่รหัสพนักงาน (ค่าเริ่มต้นที่ใครก็เดาได้) — เช็คในตัว handler เพราะต้องรู้ employee_id ก่อน
const newPassword = z
  .string()
  .min(8, 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร')
  .max(72, 'รหัสผ่านยาวเกินไป'); // bcrypt ตัดทิ้งหลังไบต์ที่ 72 อยู่แล้ว

const forgotSchema = z.object({ email: z.string().trim().min(1, 'กรุณากรอกอีเมล') });

const resetSchema = z.object({
  email: z.string().trim().min(1, 'กรุณากรอกอีเมล'),
  code: z.string().trim().regex(/^\d{6}$/, 'รหัสยืนยันต้องเป็นตัวเลข 6 หลัก'),
  new_password: newPassword,
});

const changeSchema = z.object({
  current_password: z.string().min(1, 'กรุณากรอกรหัสผ่านปัจจุบัน'),
  new_password: newPassword,
});

// พนักงานที่ลาออกหรือถูกพักงานเข้าระบบไม่ได้ แม้รหัสผ่านจะถูก
// นิยามอยู่ที่ lib/auth.js เพราะ requireAuth ใช้ตัวเดียวกันตรวจทุก request หลัง login ด้วย

authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    // นับตามชื่อที่ใช้เข้าสู่ระบบ แม้ไม่มีบัญชีนี้อยู่จริงก็โดนล็อกเหมือนกัน
    if ((await recentLoginFailures(email)) >= LOGIN_MAX_FAILURES) {
      throw new ApiError(429, `กรอกรหัสผ่านผิดหลายครั้งเกินไป กรุณารอ ${LOGIN_LOCK_MINUTES} นาทีแล้วลองใหม่ หรือใช้ "ลืมรหัสผ่าน"`);
    }

    const employee = await sql.one(
      `SELECT * FROM employees
       WHERE lower(email) = lower(:email)
          OR (NULLIF(btrim(email), '') IS NULL AND lower(employee_id) = lower(:email))`,
      { email },
    );

    /* ตอบข้อความเดียวกันทั้งกรณีไม่มีอีเมลนี้และรหัสผ่านผิด — ไม่บอกใบ้ว่าอีเมลไหนมีอยู่จริง
       และต้องเสียเวลา bcrypt เท่ากันด้วย ไม่งั้นอีเมลที่ไม่มีอยู่จริงตอบเร็วกว่า ~60ms จนแยกออกได้ */
    const ok = await verifyPassword(password, employee?.password_hash ?? DUMMY_HASH);
    if (!employee || !ok) {
      // ล้างแถวเก่าไปด้วย — อีเมลที่ไม่มีบัญชีไม่เคย login สำเร็จ แถวของมันจะไม่ถูกลบทางอื่น
      await sql.run(`DELETE FROM login_failures WHERE created_at < now() - interval '1 day'`);
      await sql.run('INSERT INTO login_failures (email_key) VALUES (lower(:email))', { email });
      throw new ApiError(401, 'อีเมล รหัสพนักงาน หรือรหัสผ่านไม่ถูกต้อง');
    }
    await clearLoginFailures(email);

    const blocked = BLOCKED_STATUSES[employee.status];
    if (blocked) throw new ApiError(403, `${blocked} — ติดต่อผู้ดูแลระบบ`);

    await sql.run(
      `UPDATE employees SET last_login_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
       WHERE employee_id = :id`,
      { id: employee.employee_id },
    );

    res.cookie(COOKIE_NAME, signToken(employee), cookieOptions);
    res.json(toSession(employee));
  }),
);

authRouter.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, clearCookieOptions);
  res.status(204).end();
});

/** หน้าเว็บเรียกตอนโหลดเพื่อดูว่ายัง login อยู่ไหม (คุกกี้เป็น httpOnly จึงอ่านเองไม่ได้) */
authRouter.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const employee = await sql.one('SELECT * FROM employees WHERE employee_id = :id', {
      id: req.user.employee_id,
    });

    // บัญชีอาจถูกลบหรือให้ลาออกไปหลังจากออก token — เช็คซ้ำทุกครั้ง ไม่เชื่อ token อย่างเดียว
    if (!employee || BLOCKED_STATUSES[employee.status]) {
      res.clearCookie(COOKIE_NAME, clearCookieOptions);
      throw new ApiError(401, 'บัญชีนี้ใช้งานไม่ได้แล้ว');
    }

    res.json(toSession(employee));
  }),
);

// ---------- ลืมรหัสผ่าน: ขอ OTP ----------
authRouter.post(
  '/forgot-password',
  asyncRoute(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);

    const employee = await sql.one(
      'SELECT employee_id, first_name, last_name, email, status FROM employees WHERE lower(email) = lower(:email)',
      { email },
    );

    // ตอบสำเร็จเสมอ ไม่ว่าอีเมลจะมีอยู่จริงหรือไม่ — ไม่ให้คนนอกใช้หน้านี้ไล่เดาว่าใครมีบัญชี
    const generic = { message: `ถ้าอีเมลนี้มีอยู่ในระบบ เราได้ส่งรหัสยืนยันไปให้แล้ว (ใช้ได้ภายใน ${OTP_TTL_MINUTES} นาที)` };
    if (!employee || BLOCKED_STATUSES[employee.status]) return res.json(generic);

    const recent = await sql.one(
      `SELECT created_at FROM password_reset_otps
       WHERE employee_id = :id AND created_at > now() - make_interval(secs => :cooldown)
       ORDER BY created_at DESC LIMIT 1`,
      { id: employee.employee_id, cooldown: OTP_COOLDOWN_SECONDS },
    );
    if (recent) throw new ApiError(429, `เพิ่งส่งรหัสไปเมื่อครู่ กรุณารอ ${OTP_COOLDOWN_SECONDS} วินาทีก่อนขอใหม่`);

    // ยกเลิกใบเก่าที่ยังไม่ได้ใช้ เพื่อให้มี OTP ที่ใช้ได้เพียงใบเดียวเสมอ
    await sql.run(
      `UPDATE password_reset_otps SET used_at = now()
       WHERE employee_id = :id AND used_at IS NULL`,
      { id: employee.employee_id },
    );

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); // randomInt = CSPRNG ไม่ใช่ Math.random
    await sql.run(
      `INSERT INTO password_reset_otps (employee_id, code_hash, expires_at)
       VALUES (:id, :hash, now() + make_interval(mins => :ttl))`,
      { id: employee.employee_id, hash: await hashPassword(code), ttl: OTP_TTL_MINUTES },
    );

    await sendOtpEmail({
      to: employee.email,
      name: `${employee.first_name} ${employee.last_name}`,
      code,
      minutes: OTP_TTL_MINUTES,
    });

    res.json(generic);
  }),
);

// ---------- ลืมรหัสผ่าน: ยืนยัน OTP แล้วตั้งรหัสใหม่ ----------
authRouter.post(
  '/reset-password',
  asyncRoute(async (req, res) => {
    const { email, code, new_password } = resetSchema.parse(req.body);

    const employee = await sql.one(
      'SELECT employee_id, status FROM employees WHERE lower(email) = lower(:email)',
      { email },
    );
    const invalid = new ApiError(400, 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว');
    if (!employee || BLOCKED_STATUSES[employee.status]) throw invalid;

    const otp = await sql.one(
      `SELECT * FROM password_reset_otps
       WHERE employee_id = :id AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      { id: employee.employee_id },
    );
    if (!otp) throw invalid;

    /* จองสิทธิ์เดาหนึ่งครั้งแบบ atomic "ก่อน" เทียบรหัส — เดิมอ่าน attempts แล้วค่อยบวกหลัง bcrypt (~60ms)
       ยิงคำขอพร้อมกันหลายร้อยตัว ทุกตัวเห็น attempts = 0 แล้วได้เดาหมด เพดาน 5 ครั้งจึงไม่มีผล
       เงื่อนไข attempts < MAX อยู่ใน UPDATE เดียวกัน Postgres ล็อกแถวให้ จึงผ่านได้ไม่เกิน MAX ตัวเสมอ */
    const claimed = await sql.one(
      `UPDATE password_reset_otps SET attempts = attempts + 1
       WHERE otp_id = :otp AND used_at IS NULL AND attempts < :max
       RETURNING attempts`,
      { otp: otp.otp_id, max: OTP_MAX_ATTEMPTS },
    );
    if (!claimed) {
      await sql.run('UPDATE password_reset_otps SET used_at = now() WHERE otp_id = :otp AND used_at IS NULL', {
        otp: otp.otp_id,
      });
      throw new ApiError(429, 'กรอกรหัสผิดหลายครั้งเกินไป กรุณาขอรหัสใหม่');
    }

    if (!(await verifyPassword(code, otp.code_hash))) throw invalid;

    if (new_password === employee.employee_id) {
      throw new ApiError(400, 'ห้ามใช้รหัสพนักงานเป็นรหัสผ่าน เพราะเป็นค่าที่คนอื่นเดาได้');
    }

    // ปิด OTP ใบนี้ก่อนเขียนรหัสใหม่ — สองคำขอที่ถือรหัสถูกพร้อมกันจะผ่านได้ตัวเดียว
    const consumed = await sql.run(
      'UPDATE password_reset_otps SET used_at = now() WHERE otp_id = :otp AND used_at IS NULL',
      { otp: otp.otp_id },
    );
    if (!consumed) throw invalid;

    /* password_changed_at = ตัวตัดเซสชันเก่าทั้งหมด (ดู requireAuth) — ตั้งรหัสใหม่ด้วย OTP
       มักเกิดตอน "เข้าไม่ได้เพราะมีคนอื่นเข้าไปแล้ว" เซสชันของคนนั้นต้องตายพร้อมกัน */
    await sql.run(
      `UPDATE employees
       SET password_hash = :hash, must_change_password = FALSE, temp_password_encrypted = NULL, password_changed_at = now()
       WHERE employee_id = :id`,
      { hash: await hashPassword(new_password), id: employee.employee_id },
    );
    await clearLoginFailures(email);

    // ตั้งรหัสใหม่แล้วให้ login ใหม่เอง — เซสชันเก่าที่ค้างอยู่ (ถ้ามี) จะไม่ถูกใช้ต่อ
    res.clearCookie(COOKIE_NAME, clearCookieOptions);
    res.json({ message: 'ตั้งรหัสผ่านใหม่เรียบร้อย กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่' });
  }),
);

// ---------- เปลี่ยนรหัสผ่าน (ต้อง login อยู่ + ยืนยันด้วยรหัสเดิม) ----------
authRouter.post(
  '/change-password',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { current_password, new_password } = changeSchema.parse(req.body);
    const id = req.user.employee_id;

    const employee = await sql.one('SELECT * FROM employees WHERE employee_id = :id', { id });
    if (!employee || !(await verifyPassword(current_password, employee.password_hash))) {
      throw new ApiError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    }

    if (new_password === current_password) {
      throw new ApiError(400, 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');
    }
    if (new_password === id) {
      throw new ApiError(400, 'ห้ามใช้รหัสพนักงานเป็นรหัสผ่าน เพราะเป็นค่าที่คนอื่นเดาได้');
    }

    await sql.run(
      `UPDATE employees
       SET password_hash = :hash, must_change_password = FALSE, temp_password_encrypted = NULL, password_changed_at = now()
       WHERE employee_id = :id`,
      { hash: await hashPassword(new_password), id },
    );

    /* เซสชันเก่าถูกเพิกถอนไปแล้วรวมถึงใบที่กำลังใช้อยู่นี้ — ออกใบใหม่ให้ทันที
       ไม่งั้นคนที่เพิ่งเปลี่ยนรหัสจะโดนเด้งออกจากระบบทั้งที่ทำถูกทุกอย่าง */
    const updated = await sql.one('SELECT * FROM employees WHERE employee_id = :id', { id });
    res.cookie(COOKIE_NAME, signToken(updated), cookieOptions);
    res.json({ message: 'เปลี่ยนรหัสผ่านเรียบร้อย' });
  }),
);

const toSession = (e) => ({
  employee_id: e.employee_id,
  first_name: e.first_name,
  last_name: e.last_name,
  email: e.email,
  position: e.position,
  role: roleForPosition(e.position), // สิทธิ์คิดจากตำแหน่ง (ผู้จัดการ/HR = admin, ที่เหลือ = field)
  must_change_password: e.must_change_password,
});
