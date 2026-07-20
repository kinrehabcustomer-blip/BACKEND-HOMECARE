import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ApiError } from './errors.js';

const SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '8h'; // ประมาณหนึ่งกะทำงาน — หมดกะแล้วต้อง login ใหม่
export const COOKIE_NAME = 'kin_session';

if (!SECRET || SECRET.length < 32) {
  throw new Error('ไม่พบ JWT_SECRET ที่ยาวพอใน .env — สร้างด้วย `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`');
}

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash ?? '');

export function signToken(employee) {
  return jwt.sign(
    { sub: employee.employee_id, role: employee.role, name: `${employee.first_name} ${employee.last_name}` },
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
