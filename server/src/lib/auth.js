import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';
import { sql } from '../db/index.js';
import { BACK_POSITIONS } from '../employees/schema.js';

const SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '8h'; // ประมาณหนึ่งกะทำงาน — หมดกะแล้วต้อง login ใหม่
export const COOKIE_NAME = 'kin_session';

// ---------- สิทธิ์การเข้าถึง (คิดจาก "ตำแหน่ง" ไม่ใช่คอลัมน์ role) ----------
// ผู้จัดการ/HR/แอดมิน = admin (เห็น/แก้ได้ทุกอย่าง) · ตำแหน่งที่เหลือ = field (พนักงานภาคสนาม สิทธิ์จำกัด)
// ผูกกับตำแหน่งเพื่อไม่ต้องมาตั้ง role แยกทีละคน — เปลี่ยนตำแหน่งเป็นสามตำแหน่งนี้ก็ได้สิทธิ์ทันที
//
// ระวังคำว่า admin ที่ซ้ำกันสองความหมาย: 'admin' ในรายการนี้คือ "ตำแหน่งงาน" (คอลัมน์ position)
// ส่วน 'admin' ที่ roleForPosition คืนออกไปคือ "ระดับสิทธิ์" ซึ่งผู้จัดการกับ HR ก็ได้เหมือนกัน
// — เช็ค req.user.role === 'admin' กับ req.user.position === 'admin' จึงไม่ใช่คำถามเดียวกัน
// = พนักงานกลุ่ม back (ประกาศที่ employees/schema.js ที่เดียว คู่กับกลุ่ม front)
export const ADMIN_POSITIONS = BACK_POSITIONS;
// role 'admin' = ใช้หน้าจอหลังบ้าน (ไม่ใช่แอปพนักงานภาคสนาม) — เข้าหน้าไหนได้บ้างดูที่ permissions ด้านล่าง
export const roleForPosition = (position) => (ADMIN_POSITIONS.includes(position) ? 'admin' : 'field');

/**
 * สิทธิ์รายหมวดของพนักงานกลุ่ม back — ส่งไปกับ session เป็น permissions ให้หน้าเว็บซ่อนเมนู
 * (ต้องตรงกับ NAV ใน client/src/App.jsx)
 *   office  = งานหลังบ้าน: ภาพรวม · เคส · ตารางงาน · การมาทำงาน · ลูกค้า · ผู้ป่วย · แพ็คเกจ · พนักงาน · ประเมิน
 *   billing = ใบแจ้งหนี้
 *   money   = ค่าจ้างพนักงาน/ต้นทุน/กำไร · ค่าตอบแทนพนักงาน (payroll) · รายได้บริษัท
 *
 * กลุ่ม front ไม่มีหมวดไหนเลย — ใช้แอปภาคสนาม (/api/my) ซึ่งเห็นเฉพาะงานของตัวเอง
 */
export const POSITION_PERMISSIONS = {
  super_admin: ['office', 'billing', 'money'], // Super Admin — ครบทุกหมวดเท่าผู้จัดการ (ต่างกันที่การแต่งตั้ง ดู employees/routes.js)
  manager: ['office', 'billing', 'money'],
  hr: ['office', 'billing'],
  admin: ['office', 'billing'],   // Admin HC
  finance: ['billing', 'money'],  // การเงิน — เฉพาะหน้าเรื่องเงิน ไม่เห็นเคส/ลูกค้า/ผู้ป่วย/พนักงาน
};
export const permissionsFor = (position) => POSITION_PERMISSIONS[position] ?? [];
export const can = (position, permission) => permissionsFor(position).includes(permission);

/**
 * เห็นค่าจ้างพนักงาน/ต้นทุน/กำไรได้ไหม = มีสิทธิ์หมวด money
 * (เดิมเป็นผู้จัดการคนเดียว — ตอนนี้รวมการเงินด้วย ซึ่งเข้าได้เฉพาะหน้าเรื่องเงินอยู่แล้ว)
 */
export const canSeeStaffPay = (position) => can(position, 'money');

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
    /* iat_ms = เวลาออก token ระดับมิลลิวินาที (iat มาตรฐานปัดเป็นวินาที) — ใช้เทียบกับ
       password_changed_at ใน requireAuth ให้ตัด token ที่ออกก่อนเปลี่ยนรหัสได้แม้อยู่ในวินาทีเดียวกัน */
    {
      sub: employee.employee_id,
      role: roleForPosition(employee.position),
      name: `${employee.first_name} ${employee.last_name}`,
      iat_ms: Date.now(),
    },
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

         เทียบระดับมิลลิวินาทีด้วย iat_ms — เดิมเทียบ iat (วินาทีถ้วน) กับ floor(changedAt)
         token ของคนร้ายที่ออกในวินาทีเดียวกับการเปลี่ยนรหัสจึงรอดไปได้
         password_changed_at ถูกเขียนด้วยนาฬิกาฝั่งแอป (ดู auth/routes.js) ก่อนออก token ใบใหม่เสมอ
         ใบใหม่ของคนที่เพิ่งเปลี่ยนรหัสจึงได้ iat_ms >= changedAt และผ่าน ไม่โดนเด้งออก

         token รุ่นเก่าที่ไม่มี iat_ms (ออกก่อนอัปเดตนี้) — ถือว่าวินาทีเดียวกันคือ "ก่อน" ไว้ก่อน
         (ฝั่งปลอดภัย: อย่างแย่ที่สุดต้อง login ใหม่หนึ่งครั้ง) */
      const changedAt = emp?.password_changed_epoch;
      const changedMs = changedAt == null ? null : Math.round(Number(changedAt) * 1000);
      const stale =
        changedMs != null &&
        (typeof payload.iat_ms === 'number'
          ? payload.iat_ms < changedMs
          : payload.iat != null && payload.iat < Math.ceil(changedMs / 1000));
      if (stale) {
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
 * employee_id ของเซสชันที่ติดมากับคำขอ ถ้ามีและยังไม่หมดอายุ — ไม่โยน error ไม่แตะ DB ไม่ล้างคุกกี้
 *
 * ใช้กับเส้นที่ "ไม่ต้องล็อกอินก็เรียกได้ แต่ต้องรู้ว่าเป็นเบราว์เซอร์เดิมหรือเปล่า"
 * ตอนนี้มีที่เดียวคือ GET /api/auth/line (ตั๋วใช้ครั้งเดียว แต่กดย้อนกลับ/โหลดซ้ำจากเครื่องเดิมต้องไม่พัง)
 * ไม่ใช้แทน requireAuth เด็ดขาด — ตัวนี้เชื่อ token อย่างเดียว ไม่ได้เช็คว่าบัญชีถูกปิดหรือเปลี่ยนรหัสไปแล้ว
 */
export function sessionEmployeeId(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET).sub ?? null;
  } catch {
    return null;
  }
}

/**
 * ด่านตามหมวดสิทธิ์ — วางต่อจาก requireAuth เสมอ (ต้องมี req.user ก่อน)
 * ตำแหน่งถูกอ่านสดมาแล้วใน requireAuth จึงไม่ต้อง query ซ้ำ และลดสิทธิ์ระหว่าง session ได้ทันที
 */
export const requirePermission = (permission, message) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));
  if (!can(req.user.position, permission)) {
    return next(new ApiError(403, message ?? 'บัญชีของคุณไม่มีสิทธิ์เข้าถึงส่วนนี้'));
  }
  next();
};

/** งานหลังบ้าน (เคส/ลูกค้า/ผู้ป่วย/พนักงาน/แพ็คเกจ/ประเมิน) — ผู้จัดการ · HR · Admin HC */
export const requireAdmin = requirePermission('office', 'บัญชีของคุณไม่มีสิทธิ์เข้าถึงงานหลังบ้านส่วนนี้');

/** ใบแจ้งหนี้ — ผู้จัดการ · HR · Admin HC · การเงิน */
export const requireBilling = requirePermission('billing', 'บัญชีของคุณไม่มีสิทธิ์เข้าถึงใบแจ้งหนี้');

/** ใช้หน้าจอหลังบ้านได้ (มีสิทธิ์อย่างน้อยหนึ่งหมวด) — ใช้กับของรวมอย่างกระดิ่งแจ้งเตือน */
export function requireBackOffice(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));
  if (permissionsFor(req.user.position).length === 0) {
    return next(new ApiError(403, 'บัญชีของคุณยังไม่ได้กำหนดสิทธิ์การใช้งาน'));
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
 * หมวด money — ข้อมูลเงินที่ไม่ใช่เรื่องของทุกคนในทีม:
 * ค่าจ้าง/กำไร, คำสั่งที่ทำให้เงินออกจากบริษัท, และรายได้รวมของบริษัท (ผู้จัดการ · การเงิน)
 * ชื่อเดิมคงไว้เพราะถูกเรียกหลายที่ — ความหมายคือ "มีสิทธิ์เรื่องเงิน" ไม่ใช่ตำแหน่งผู้จัดการ
 */
export const requireManager = requirePermission('money', 'เฉพาะผู้จัดการหรือฝ่ายการเงินเท่านั้นที่เข้าถึงข้อมูลส่วนนี้ได้');

/**
 * เส้นของ /api/cases ที่หน้าค่าตอบแทนพนักงานต้องใช้ — การเงินไม่มีสิทธิ์ office แต่ต้องอนุมัติกะ
 * ปล่อยค่าจ้าง และดูสรุปได้ จึงเปิดเฉพาะเส้นเหล่านี้ให้หมวด money (เส้นอื่นของเคสยังต้องเป็น office)
 * ตัวเส้นเองยังมีด่านเงินของตัวเองซ้ำอีกชั้น (ensureCanPay / requireManager)
 */
const MONEY_CASE_ROUTES = [
  /^\/assignable-employees$/,
  // exceptions = แถว "ยืนยันครบแล้ว แต่ยังมีกะขาด/ค้างเช็คเอาท์อีก n" บนหน้า /payroll
  // เดิมไม่อยู่ในชุดนี้ ฝ่ายการเงินจึงได้ 403 แล้วหน้าจอกลืนทิ้งเงียบ ๆ เห็นแค่ "ยืนยันครบแล้ว"
  // ซึ่งเป็นภาพที่ชวนให้ปิดรอบจ่ายทั้งที่ยังมีกะค้าง (ตรวจรอบ 9)
  /^\/attendance\/(pending|decide|report|exceptions)$/,
  /^\/[^/]+\/pay(\/[^/]+)?$/,
  /^\/[^/]+\/approve-pay$/,
];
export function requireCaseAccess(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'กรุณาเข้าสู่ระบบ'));
  if (can(req.user.position, 'office')) return next();
  if (can(req.user.position, 'money') && MONEY_CASE_ROUTES.some((re) => re.test(req.path))) return next();
  return next(new ApiError(403, 'บัญชีของคุณไม่มีสิทธิ์เข้าถึงข้อมูลเคส'));
}
