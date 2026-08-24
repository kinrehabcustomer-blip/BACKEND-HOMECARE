import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';
import { sql } from '../db/index.js';

const SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '8h'; // ประมาณหนึ่งกะทำงาน — หมดกะแล้วต้อง login ใหม่
export const COOKIE_NAME = 'kin_session';

// ---------- สิทธิ์การเข้าถึง (คิดจาก "ตำแหน่ง" ไม่ใช่คอลัมน์ role) ----------
// ผู้จัดการ/HR = admin (เห็น/แก้ได้ทุกอย่าง) · ตำแหน่งที่เหลือ = field (พนักงานภาคสนาม สิทธิ์จำกัด)
// ผูกกับตำแหน่งเพื่อไม่ต้องมาตั้ง role แยกทีละคน — เปลี่ยนตำแหน่งเป็นผู้จัดการ/HR ก็ได้สิทธิ์ทันที
export const ADMIN_POSITIONS = ['manager', 'hr'];
export const roleForPosition = (position) => (ADMIN_POSITIONS.includes(position) ? 'admin' : 'field');

/**
 * ต้นทุน/กำไรของแพ็คเกจ = เฉพาะผู้จัดการ — แคบกว่า admin หนึ่งขั้น (HR เข้าหน้าแพ็คเกจได้ แต่ไม่เห็นตัวเลขนี้)
 *
 * แยกจาก roleForPosition โดยตั้งใจ ไม่ใช่เพิ่มค่า role ใหม่ — ถ้าเอาไปรวมเป็น role
 * ทุกจุดที่เช็ค admin อยู่ต้องมานั่งไล่ว่าหมายถึงอันไหน สิทธิ์ย่อยแบบนี้จึงถามเป็นคำถามของตัวเอง
 */
export const canSeeStaffPay = (position) => position === 'manager';

/**
 * ลบตัวเลขต้นทุน/กำไรออกจากแถวก่อนส่งให้คนที่ไม่ใช่ผู้จัดการ
 *
 * ตัดที่ payload จริง ไม่ใช่ซ่อนด้วย CSS — ไม่งั้นเปิด DevTools แท็บ Network ก็เห็นครบ
 * ใช้ได้ทั้งเรท Homecare และแพ็คเกจกายภาพ เพราะสองที่ตั้งชื่อฟิลด์เหมือนกัน
 */
export function stripPayFields(row) {
  const { staff_pay, margin, staff_share, ...rest } = row;
  return rest;
}

if (!SECRET || SECRET.length < 32) {
  throw new Error('ไม่พบ JWT_SECRET ที่ยาวพอใน .env — สร้างด้วย `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`');
}

export const hashPassword = (plain) => bcrypt.hash(plain, 10);

/* ตัวอักษรของรหัสชั่วคราว — ตัด 0/O/1/I/l ออก เพราะรหัสนี้ถูกอ่านออกเสียง/จดใส่กระดาษส่งต่อกัน
   สลับตัวผิดแล้วจะกลายเป็น "เข้าไม่ได้" ที่หาสาเหตุไม่เจอ */
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * รหัสผ่านชั่วคราวของพนักงานใหม่ — สุ่มจาก CSPRNG ทุกครั้ง
 *
 * เดิมใช้ "รหัสพนักงานของตัวเอง" (EMP-0007) ซึ่งเดาได้ทันทีจากภายนอก: รหัสเรียงเลข
 * และโผล่อยู่ในทุกหน้าจอ/ทุกไฟล์ที่ส่งออก ใครก็ตามที่รู้อีเมลของพนักงานคนหนึ่ง
 * จึงลองเดาได้ในครั้งเดียวถ้าคนนั้นยังไม่ได้เปลี่ยนรหัส (ซึ่งเป็นสถานะปริยายของทุกคน)
 *
 * คืนค่าเป็น plain text ครั้งเดียวให้คนที่กดสร้างเอาไปส่งต่อ — ในฐานข้อมูลเก็บแต่ hash
 */
export function generateTempPassword(length = 12) {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += TEMP_ALPHABET[b % TEMP_ALPHABET.length];
  return out;
}
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash ?? '');

export function signToken(employee) {
  return jwt.sign(
    // role ใน token เป็นแค่ข้อมูลประกอบ — การตัดสินสิทธิ์จริงเช็คตำแหน่งสดจาก DB (ดู requireAdmin)
    { sub: employee.employee_id, role: roleForPosition(employee.position), name: `${employee.first_name} ${employee.last_name}` },
    SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

export const cookieOptions = {
  httpOnly: true, // JavaScript ในหน้าเว็บอ่านไม่ได้ — กัน token หลุดถ้าโดน XSS
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 8 * 60 * 60 * 1000,
  path: '/',
};

/**
 * ตัวเลือกสำหรับ "ลบ" คุกกี้ — ต้องไม่มี maxAge
 * express เตือน deprecated ถ้าส่ง maxAge เข้า clearCookie (v5 จะเมินค่านี้ทิ้ง)
 * ที่เหลือต้องตรงกับตอนตั้งคุกกี้เป๊ะ ไม่งั้นเบราว์เซอร์จะไม่ถือว่าเป็นคุกกี้ใบเดียวกันแล้วลบไม่ออก
 */
export const { maxAge: _maxAge, ...clearCookieOptions } = cookieOptions;

/**
 * สถานะที่ใช้ระบบไม่ได้ — ตรวจทั้งตอน login และทุก request หลังจากนั้น
 * อยู่ที่นี่ไม่ใช่ที่ auth/routes.js เพราะ middleware ต้องใช้ตัวเดียวกัน ไม่งั้นสองที่หลุดจากกันได้
 */
export const BLOCKED_STATUSES = { resigned: 'บัญชีนี้ลาออกแล้ว', suspended: 'บัญชีนี้ถูกพักงานอยู่' };

/**
 * ทุก request ที่ผ่าน middleware นี้ต้องมี session ที่ยังไม่หมดอายุ "และบัญชียังใช้งานได้อยู่"
 *
 * ไม่เชื่อ token อย่างเดียว เพราะ token อายุ 8 ชม. — พนักงานที่เพิ่งถูกกดลาออก/พักงาน
 * จะยังยิง API ได้ต่อไปอีกเกือบทั้งกะถ้าคุกกี้ยังอยู่ในเครื่อง (รวมถึงเช็คอิน–เช็คเอาท์)
 * เดิมมีแค่ /auth/me ที่ตรวจ ซึ่งกันได้แค่ตอนเปิดหน้าเว็บใหม่ ไม่ได้กันที่ API จริง
 *
 * ตำแหน่งที่อ่านมาถูกเก็บไว้ใน req.user ให้ requireAdmin กับสิทธิ์ย่อย (canSeeStaffPay) ใช้ต่อ
 * จึงเหลือ query เดียวต่อ request เท่าเดิม ไม่ใช่สองครั้ง
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    // token หมดอายุหรือถูกแก้ไข — ล้างคุกกี้ทิ้งเพื่อไม่ให้เบราว์เซอร์ส่งของเสียมาซ้ำๆ
    res.clearCookie(COOKIE_NAME, clearCookieOptions);
    return next(new ApiError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'));
  }

  sql
    .one(
      `SELECT position, status, must_change_password,
              EXTRACT(EPOCH FROM password_changed_at) AS password_changed_epoch
       FROM employees WHERE employee_id = :id`,
      { id: payload.sub },
    )
    .then((emp) => {
      /* เปลี่ยนรหัสผ่านแล้ว = เซสชันเก่าทุกตัวต้องตาย ไม่ใช่รอหมดอายุอีก 8 ชม.
         เหตุผลที่คนกดเปลี่ยนรหัสส่วนใหญ่คือ "สงสัยว่ามีคนอื่นเข้าถึงบัญชีอยู่" —
         ถ้าเซสชันของคนนั้นยังใช้ได้ต่อ การเปลี่ยนรหัสก็ไม่ได้แก้อะไรเลยในช่วงเวลาที่อันตรายที่สุด

         เทียบที่ความละเอียดวินาที เพราะ iat ของ JWT เป็นวินาทีถ้วน — token ที่ออกในวินาทีเดียว
         กับที่เปลี่ยนรหัส (เช่น login ใหม่ทันทีหลังเปลี่ยน) จึงต้องผ่าน ไม่ใช่โดนตัดทิ้ง */
      const changedAt = emp?.password_changed_epoch;
      if (changedAt != null && payload.iat != null && payload.iat < Math.floor(Number(changedAt))) {
        res.clearCookie(COOKIE_NAME, clearCookieOptions);
        return next(new ApiError(401, 'รหัสผ่านถูกเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่'));
      }

      if (!emp || BLOCKED_STATUSES[emp.status]) {
        res.clearCookie(COOKIE_NAME, clearCookieOptions);
        return next(new ApiError(401, emp ? `${BLOCKED_STATUSES[emp.status]} — ติดต่อผู้ดูแลระบบ` : 'บัญชีนี้ใช้งานไม่ได้แล้ว'));
      }

      req.user = {
        employee_id: payload.sub,
        name: payload.name,
        // ตำแหน่ง/สิทธิ์อ่านสดจาก DB ไม่ใช่จาก token — เลื่อนหรือลดตำแหน่งแล้วมีผลทันที
        position: emp.position,
        role: roleForPosition(emp.position),
        must_change_password: emp.must_change_password,
      };
      next();
    })
    .catch(next);
}

/**
 * เฉพาะผู้ดูแลระบบ (ตำแหน่งผู้จัดการ/HR) — วางต่อจาก requireAuth เสมอ (ต้องมี req.user ก่อน)
 * ตำแหน่งถูกอ่านสดมาแล้วใน requireAuth จึงไม่ต้อง query ซ้ำที่นี่
 */
export function requireAdmin(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));
  if (roleForPosition(req.user.position) !== 'admin') {
    return next(new ApiError(403, 'เฉพาะผู้จัดการหรือ HR เท่านั้นที่เข้าถึงส่วนนี้ได้'));
  }
  next();
}

/**
 * บัญชีที่ยังใช้รหัสผ่านชั่วคราวอยู่ ทำอะไรในระบบไม่ได้จนกว่าจะตั้งรหัสของตัวเอง
 *
 * เดิมบังคับที่หน้าเว็บอย่างเดียว (must_change_password ถูกส่งไปกับ /auth/me แล้วให้หน้าเว็บเด้งเอง)
 * ซึ่งกันได้เฉพาะคนที่ใช้ผ่านหน้าเว็บ — ยิง API ตรงด้วยคุกกี้เดียวกันก็ข้ามด่านไปได้ทั้งหมด
 * และรหัสชั่วคราวคือรหัสที่ผู้ออกให้ (HR/ผู้จัดการ) รู้ด้วย จึงไม่ควรใช้ทำอะไรได้นอกจากตั้งรหัสใหม่
 */
export function requirePasswordChanged(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));
  if (req.user.must_change_password) {
    return next(new ApiError(403, 'กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งานระบบ'));
  }
  next();
}

/**
 * เฉพาะผู้จัดการ — ใช้กับข้อมูลค่าจ้าง/กำไรและคำสั่งที่ทำให้เงินออกจากบริษัท
 *
 * จงใจแคบกว่า requireAdmin ซึ่งรวม HR ด้วย และอ่านตำแหน่งสดที่ requireAuth ใส่ไว้ใน req.user
 * จึงลดสิทธิ์พนักงานระหว่างที่ session ยังไม่หมดอายุได้ทันทีเหมือนด่านอื่นในระบบ
 */
export function requireManager(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));
  if (!canSeeStaffPay(req.user.position)) {
    return next(new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่เข้าถึงข้อมูลค่าตอบแทนพนักงานได้'));
  }
  next();
}
