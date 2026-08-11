import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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

/** ทุก request ที่ผ่าน middleware นี้ต้องมี session ที่ยังไม่หมดอายุ */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));

  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { employee_id: payload.sub, role: payload.role, name: payload.name };
    next();
  } catch {
    // token หมดอายุหรือถูกแก้ไข — ล้างคุกกี้ทิ้งเพื่อไม่ให้เบราว์เซอร์ส่งของเสียมาซ้ำๆ
    res.clearCookie(COOKIE_NAME, cookieOptions);
    next(new ApiError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'));
  }
}

/**
 * เฉพาะผู้ดูแลระบบ (ตำแหน่งผู้จัดการ/HR) — วางต่อจาก requireAuth เสมอ (ต้องมี req.user ก่อน)
 *
 * เช็ค "ตำแหน่งสดจาก DB" ไม่เชื่อ role ใน token เพราะ token อายุ 8 ชม. อาจถือค่าเก่าอยู่
 * (เช่น เพิ่งเลื่อนตำแหน่งเป็นผู้จัดการ หรือกลับกันเพิ่งถูกลด) — เช็คสดจึงถูกเสมอและมีผลทันที
 */
export function requireAdmin(req, res, next) {
  sql
    .one('SELECT position FROM employees WHERE employee_id = :id', { id: req.user?.employee_id })
    .then((emp) => {
      if (!emp) return next(new ApiError(401, 'บัญชีนี้ใช้งานไม่ได้แล้ว'));
      if (roleForPosition(emp.position) !== 'admin') {
        return next(new ApiError(403, 'เฉพาะผู้จัดการหรือ HR เท่านั้นที่เข้าถึงส่วนนี้ได้'));
      }
      // เก็บตำแหน่งสดที่เพิ่งอ่านมาไว้ให้เส้นที่ต้องแยกสิทธิ์ย่อย (เช่น เห็นค่าจ้าง/กำไรไหม)
      // ใช้ต่อได้เลยโดยไม่ต้อง query ซ้ำ และเป็นค่าสดเสมอเหมือนกับที่ใช้ตัดสิน admin
      req.user.position = emp.position;
      next();
    })
    .catch(next);
}
