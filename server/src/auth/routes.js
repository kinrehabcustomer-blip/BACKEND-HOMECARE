import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { sql, transaction } from '../db/index.js';
import { ApiError, asyncRoute } from '../lib/errors.js';
import {
  BLOCKED_STATUSES,
  COOKIE_NAME,
  clearCookieOptions,
  cookieOptions,
  hashPassword,
  requireAuth,
  revokeSession,
  roleForPosition,
  permissionsFor,
  sessionEmployeeId,
  signToken,
  verifyPassword,
} from '../lib/auth.js';
import { sendOtpEmail } from '../lib/mailer.js';
import { claimLineTicket, ensureLineColumn, verifyLineTicket, verifySigned } from '../lib/lineBridge.js';
import { linkLineByCode } from '../lib/lineLinkCode.js';

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
  /* จำกัดความยาว (ตรวจรอบ 20) — ชื่อบัญชีที่กรอกผิดถูกเก็บลง login_failures ทุกครั้ง
     เดิมไม่มีเพดาน คนนอกยิงอีเมลยาวแสนตัวรัว ๆ ให้ตารางบวมได้โดยไม่ต้องมีบัญชี (พิสูจน์แล้ว 100,016 ตัว)
     อีเมลจริงยาวสุดตามมาตรฐานคือ 254 ตัว */
  email: z.string().trim().min(1, 'กรุณากรอกอีเมลหรือรหัสพนักงาน').max(254, 'อีเมลหรือรหัสพนักงานยาวเกินไป'),
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

    /* นับตามชื่อที่ใช้เข้าสู่ระบบ แม้ไม่มีบัญชีนี้อยู่จริงก็โดนล็อกเหมือนกัน
       🔴 ด่านนี้กันคำขอที่มา "ทีละใบ" · คำขอที่ยิงพร้อมกันเป็นร้อยตัวเห็นตัวนับเท่ากันหมด
       จึงลอดไปได้ทั้งชุด (ตรวจรอบ 20) — ด่านจริงที่กันการยิงขนานอยู่หลัง bcrypt ด้านล่าง
       ซึ่งนับจากแถวที่เขียนลงไปแล้วจริง ไม่ใช่จากค่าที่อ่านมาก่อนหน้า */
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
      /* เทียบเพดาน "หลัง" เขียนแถวของตัวเองลงไปแล้ว — คำขอที่ยิงพร้อมกันจึงเห็นแถวของกันและกัน
         และตัวที่เกินโควตาได้ 429 แทนที่จะลอดไปหมดทุกตัว (ตรวจรอบ 20) */
      if ((await recentLoginFailures(email)) > LOGIN_MAX_FAILURES) {
        throw new ApiError(429, `กรอกรหัสผ่านผิดหลายครั้งเกินไป กรุณารอ ${LOGIN_LOCK_MINUTES} นาทีแล้วลองใหม่ หรือใช้ "ลืมรหัสผ่าน"`);
      }
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

// ---------- เข้าระบบด้วย LINE (ตั๋วจาก chat.kinorigin.com/me · ดู lib/lineBridge.js) ----------
// ผูกแล้ว = ออกคุกกี้เหมือน login ปกติแล้วพาเข้าหน้าแรกตามสิทธิ์ · ยังไม่ผูก = พาไปหน้า login พร้อมตั๋ว
// ให้ login ด้วยรหัสผ่านเดิม 1 ครั้ง หน้า login จะเรียก /line-link ต่อเอง
const LINE_LANDING = new Set(['/', '/my-today', '/my-cases', '/my-calendar', '/my-attendance']); // /my-attendance = ปุ่ม "รายได้ของฉัน" (25 ต.ค. 2569)

authRouter.get(
  '/line',
  asyncRoute(async (req, res) => {
    const lineUserId = verifyLineTicket(req.query.t);
    /* ?to= พาไปหน้าที่ตั้งใจหลังเข้าระบบ (ดร.ธงชัย 23 ต.ค. 2569 ปุ่ม "ส่งรายงานวันนี้" ใน LINE @kinjobs → หน้างานวันนี้)
       รับเฉพาะหน้าในรายการ — กันลิงก์พาไปที่อื่น (open redirect) */
    // + /my-cases?case=<รหัสเคส> ลิงก์แจ้งเตือนแชทเคสจาก LINE (24 ต.ค. 2569) เปิดเคสนั้นให้เลย
    const to = LINE_LANDING.has(req.query.to) || /^\/my-cases\?case=[A-Za-z0-9-]{3,30}$/.test(String(req.query.to || '')) ? req.query.to : '/';
    if (!lineUserId) return res.redirect(302, '/login?line_error=expired');
    await ensureLineColumn();

    const employee = await sql.one('SELECT * FROM employees WHERE line_user_id = :uid', { uid: lineUserId });
    if (!employee) return res.redirect(302, `/login?line=${encodeURIComponent(req.query.t)}${to !== '/' ? `&to=${encodeURIComponent(to)}` : ''}`);
    if (BLOCKED_STATUSES[employee.status]) return res.redirect(302, '/login?line_error=blocked');

    /* ตั๋วใบนี้ออกคุกกี้ได้ครั้งเดียว (ดู claimLineTicket ใน lib/lineBridge.js) — URL ของตั๋วหลุดไปอยู่ใน
       ประวัติเบราว์เซอร์/log/แชทได้ตลอด 10 นาทีที่ตั๋วยังไม่หมดอายุ
       ยกเว้นคำขอที่ถือคุกกี้ของพนักงานคนเดียวกันอยู่แล้ว = เบราว์เซอร์เดิมที่เพิ่งเข้าไปสำเร็จ
       (กดย้อนกลับ · โหลดซ้ำ · prefetch) ปล่อยผ่านโดยไม่ต้องจองใหม่ ไม่งั้นคนทำถูกจะโดนเด้งออก */
    if (sessionEmployeeId(req) !== employee.employee_id && !(await claimLineTicket(req.query.t, employee.employee_id))) {
      return res.redirect(302, '/login?line_error=used');
    }

    await sql.run(
      `UPDATE employees SET last_login_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
       WHERE employee_id = :id`,
      { id: employee.employee_id },
    );
    res.cookie(COOKIE_NAME, signToken(employee), cookieOptions);
    res.redirect(302, to);
  }),
);

/**
 * เข้าระบบงานจากแดชบอร์ด admin (chat.kinorigin.com/admin) ไม่ต้องกรอกรหัสอีก
 * ดร.ธงชัย 24 ต.ค. 2569 อนุญาต: "โอเคครับ ทำได้เลย เพราะว่าเจ้าหน้าที่น่าจะเป็นเจ้าหน้าที่ home care อย่างเดียวที่ทำอย่างนี้ได้ ก็ส่วนฝ่ายบุคคล"
 * ฝั่ง admin ล็อกอินด้วย Clerk (อีเมล + OTP) แล้วออกตั๋ว 'kin-admin-sso' {email} อายุ 2 นาที ลงลายเซ็นด้วยกุญแจเดียวกับตั๋ว LINE (lib/lineBridge.js)
 * จับคู่ด้วยอีเมลในประวัติพนักงาน · เปิดเฉพาะ Super Admin · ผู้จัดการ · Admin HC · HR (ไม่รวมการเงิน และพนักงานภาคสนามที่เข้าทาง LINE)
 * ไม่เจอ/ตำแหน่งไม่อยู่ในรายการ/บัญชีถูกปิด = ไปหน้าเข้าระบบพร้อมเหตุผล
 */
const ADMIN_SSO_POSITIONS = ['super_admin', 'manager', 'admin', 'hr'];
authRouter.get(
  '/admin-sso',
  asyncRoute(async (req, res) => {
    const p = verifySigned(req.query.t, 'kin-admin-sso');
    const email = typeof p?.email === 'string' ? p.email.trim().toLowerCase() : '';
    if (!email) return res.redirect(302, '/login?sso_error=expired');
    // ตั๋วใช้ได้ครั้งเดียว — URL หลุดไปในประวัติเบราว์เซอร์/log ภายใน 2 นาที เอามาเข้าซ้ำไม่ได้
    await sql.run(`CREATE TABLE IF NOT EXISTS admin_sso_used (token_hash TEXT PRIMARY KEY, used_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await sql.run(`DELETE FROM admin_sso_used WHERE used_at < now() - interval '1 day'`);
    const fresh = await sql.run(
      `INSERT INTO admin_sso_used (token_hash) VALUES (:h) ON CONFLICT DO NOTHING`,
      { h: createHash('sha256').update(String(req.query.t)).digest('hex') },
    );
    if (!fresh) return res.redirect(302, '/login?sso_error=expired');
    const to = typeof req.query.to === 'string' && /^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/.test(req.query.to) ? req.query.to : '/';
    const employee = await sql.one('SELECT * FROM employees WHERE lower(email) = :email LIMIT 1', { email });
    if (!employee || !ADMIN_SSO_POSITIONS.includes(employee.position)) return res.redirect(302, '/login?sso_error=nomatch');
    if (BLOCKED_STATUSES[employee.status]) return res.redirect(302, '/login?sso_error=blocked');
    await sql.run(
      `UPDATE employees SET last_login_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
       WHERE employee_id = :id`,
      { id: employee.employee_id },
    );
    res.cookie(COOKIE_NAME, signToken(employee), cookieOptions);
    res.redirect(302, to);
  }),
);

/**
 * กรอกรหัสผูก LINE 6 หลักในหน้าเข้าระบบที่เปิดจากปุ่มใน LINE (ดร.ธงชัย 23 ต.ค. 2569 "พิมพ์ในแชทเขาไม่เข้าใจ")
 * ตั๋ว LINE จาก ?line= + รหัสจากแอดมิน → ผูกแล้วเข้าระบบทันที (ไม่ต้องใช้รหัสผ่าน) · ตรรกะร่วมกับการพิมพ์ในแชท อยู่ใน lib/lineLinkCode.js
 */
const lineCodeSchema = z.object({ t: z.string().min(1), code: z.string().trim().regex(/^\d{6}$/, 'รหัสต้องเป็นตัวเลข 6 หลัก') });
authRouter.post(
  '/line-code',
  asyncRoute(async (req, res) => {
    const { t, code } = lineCodeSchema.parse(req.body);
    const lineUserId = verifyLineTicket(t);
    if (!lineUserId) throw new ApiError(400, 'ลิงก์จาก LINE หมดอายุแล้ว กลับไปกดปุ่มในเมนู LINE @kinjobs ใหม่อีกครั้ง');
    const employee = await linkLineByCode(lineUserId, code);
    await sql.run(
      `UPDATE employees SET last_login_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
       WHERE employee_id = :id`,
      { id: employee.employee_id },
    );
    res.cookie(COOKIE_NAME, signToken(employee), cookieOptions);
    res.json(toSession(employee));
  }),
);

const lineLinkSchema = z.object({ t: z.string().min(1) });

/** ผูก LINE กับบัญชีที่เพิ่ง login ด้วยรหัสผ่าน — LINE หนึ่งบัญชีผูกได้พนักงานคนเดียว (ผูกใหม่ = ย้ายมาคนนี้ไม่ได้ ต้องให้แอดมินปลด) */
authRouter.post(
  '/line-link',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { t } = lineLinkSchema.parse(req.body);
    const lineUserId = verifyLineTicket(t);
    if (!lineUserId) throw new ApiError(400, 'ลิงก์จาก LINE หมดอายุแล้ว กรุณากดปุ่มในหน้า "งานของฉัน" ใหม่อีกครั้ง');
    await ensureLineColumn();

    const owner = await sql.one('SELECT employee_id FROM employees WHERE line_user_id = :uid', { uid: lineUserId });
    if (owner && owner.employee_id !== req.user.employee_id) {
      throw new ApiError(409, 'LINE นี้ยืนยันตัวตนเป็นพนักงานคนอื่นอยู่แล้ว — ติดต่อผู้ประสานงานให้ยกเลิกที่บัญชีเดิมก่อน');
    }
    await sql.run('UPDATE employees SET line_user_id = :uid WHERE employee_id = :id', {
      uid: lineUserId,
      id: req.user.employee_id,
    });
    res.json({ ok: true });
  }),
);

/* ออกจากระบบ = ตัดใบนี้ที่เซิร์ฟเวอร์ด้วย ไม่ใช่แค่ล้างคุกกี้ (ตรวจรอบ 20)
   ตัดเฉพาะใบของเครื่องที่กด — มือถือกับคอมของคนเดียวกันเป็นคนละใบ อีกเครื่องยังใช้ต่อได้
   ตัดไม่สำเร็จ (ฐานสะดุด) ก็ยังล้างคุกกี้และตอบ 204 — คนกดออกจากระบบต้องออกได้เสมอ
   อย่างแย่ที่สุดคือกลับไปเป็นพฤติกรรมเดิม ไม่ใช่ค้างอยู่ในระบบ */
authRouter.post('/logout', async (req, res) => {
  await revokeSession(req.cookies?.[COOKIE_NAME]).catch(() => {});
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

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); // randomInt = CSPRNG ไม่ใช่ Math.random
    const codeHash = await hashPassword(code);

    /* ล็อกแถวพนักงานก่อนทั้งก้อน (ตรวจรอบ 20) — เดิมเช็คคูลดาวน์ · ยกเลิกใบเก่า · ออกใบใหม่
       เป็นสามคำสั่งแยกกัน คำขอที่ยิงพร้อมกันผ่านคูลดาวน์พร้อมกันแล้วออก OTP หลายใบที่ใช้ได้จริง
       = คนเดาได้หลายรหัสพร้อมกันและเจ้าตัวได้อีเมลหลายฉบับ */
    const issued = await transaction(async (tx) => {
      await tx.one('SELECT employee_id FROM employees WHERE employee_id = :id FOR UPDATE', { id: employee.employee_id });
      const recent = await tx.one(
        `SELECT created_at FROM password_reset_otps
         WHERE employee_id = :id AND created_at > now() - make_interval(secs => :cooldown)
         ORDER BY created_at DESC LIMIT 1`,
        { id: employee.employee_id, cooldown: OTP_COOLDOWN_SECONDS },
      );
      if (recent) return false;

      // ยกเลิกใบเก่าที่ยังไม่ได้ใช้ เพื่อให้มี OTP ที่ใช้ได้เพียงใบเดียวเสมอ
      await tx.run(
        `UPDATE password_reset_otps SET used_at = now() WHERE employee_id = :id AND used_at IS NULL`,
        { id: employee.employee_id },
      );
      await tx.run(
        `INSERT INTO password_reset_otps (employee_id, code_hash, expires_at)
         VALUES (:id, :hash, now() + make_interval(mins => :ttl))`,
        { id: employee.employee_id, hash: codeHash, ttl: OTP_TTL_MINUTES },
      );
      return true;
    });

    /* อยู่ในช่วงคูลดาวน์ = ตอบข้อความกลางเหมือนเดิมทุกตัวอักษร ไม่ใช่ 429 (ตรวจรอบ 20)
       เดิมอีเมลที่มีอยู่จริงได้ 429 ส่วนอีเมลที่ไม่มีได้ 200 เสมอ
       กดขอซ้ำสองครั้งจึงแยกออกทันทีว่าอีเมลไหนเป็นพนักงานของเรา */
    if (!issued) return res.json(generic);

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
       SET password_hash = :hash, must_change_password = FALSE, temp_password_encrypted = NULL, password_changed_at = :changed_at
       WHERE employee_id = :id`,
      // นาฬิกาฝั่งแอป ไม่ใช่ now() ของ DB — ต้องเป็นนาฬิกาเดียวกับ iat_ms ใน token (ดู requireAuth)
      { hash: await hashPassword(new_password), id: employee.employee_id, changed_at: new Date() },
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
       SET password_hash = :hash, must_change_password = FALSE, temp_password_encrypted = NULL, password_changed_at = :changed_at
       WHERE employee_id = :id`,
      /* นาฬิกาฝั่งแอป ไม่ใช่ now() ของ DB — token ใบใหม่ข้างล่างออกหลังบรรทัดนี้ด้วยนาฬิกาเดียวกัน
         iat_ms จึง >= password_changed_at เสมอแม้ DB กับแอปเวลาเหลื่อมกัน (ดู requireAuth) */
      { hash: await hashPassword(new_password), id, changed_at: new Date() },
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
  role: roleForPosition(e.position), // สิทธิ์คิดจากตำแหน่ง (กลุ่ม back = admin, ที่เหลือ = field)
  // หมวดที่เข้าได้ (office/billing/money) — หน้าเว็บใช้ซ่อนเมนู ตัวจริงที่กันคือด่านของแต่ละเส้น
  permissions: permissionsFor(e.position),
  must_change_password: e.must_change_password,
});
