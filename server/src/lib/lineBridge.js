import { createHash, createPublicKey, verify } from 'node:crypto';
import { sql } from '../db/index.js';

/**
 * เข้าระบบด้วย LINE — ทางเข้าของพนักงานภาคสนาม/พาร์ทไทม์ (ดร.ธงชัย 22 ต.ค. 2569)
 *
 * พนักงานเปิดหน้า "งานของฉัน" จาก LINE OA สมัครงาน/PTOT (chat.kinorigin.com/me)
 * แล้วกดปุ่มระบบงาน → chat.kinorigin.com ออกตั๋วอายุสั้นที่ลงลายเซ็น Ed25519 ด้วยกุญแจลับฝั่งนั้น
 * → พามาที่ GET /api/auth/line?t=… ฝั่งนี้ตรวจด้วยกุญแจสาธารณะด้านล่าง
 *
 * ทำไมเป็นกุญแจคู่ ไม่ใช่รหัสลับร่วม: ฝั่งนี้เก็บแค่กุญแจสาธารณะ (อยู่ในโค้ดได้ ไม่ต้องตั้ง env)
 * ต่อให้ repo นี้เปิดสาธารณะ ใครก็ปลอมตั๋วไม่ได้ เพราะกุญแจที่ใช้เซ็นอยู่ฝั่ง chat เท่านั้น
 *
 * ตั๋ว = base64url(JSON {u: LINE userId, e: หมดอายุ ms, a: 'kin-staff'}) + '.' + base64url(ลายเซ็น)
 * ผูก LINE กับพนักงานครั้งแรกต้อง login ด้วยรหัสผ่านเดิม 1 ครั้ง (POST /api/auth/line-link)
 * — ตั๋วบอกแค่ว่า "เป็นเจ้าของ LINE นี้" ไม่ได้บอกว่าเป็นพนักงานคนไหน จึงห้ามจับคู่เองจากชื่อ/เบอร์
 */
const PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAw+qNWMf5eVMSLX/i3xWn1x24NWlGvJSEeDBdqrl+lQc=
-----END PUBLIC KEY-----`);

/**
 * ตรวจตั๋วลงลายเซ็นจาก chat.kinorigin.com — purpose แยกงานกันไม่ให้ตั๋วชนิดหนึ่งเอาไปใช้แทนอีกชนิด
 * ('kin-staff' = เข้าระบบด้วย LINE · 'kin-hire' = สร้างพนักงานจากใบสมัคร) · คืน payload หรือ null
 */
export function verifySigned(token, purpose) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  try {
    if (!verify(null, Buffer.from(body), PUBLIC_KEY, Buffer.from(sig, 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.a === purpose && typeof p.e === 'number' && p.e >= Date.now() ? p : null;
  } catch {
    return null;
  }
}

export const isLineUserId = (u) => typeof u === 'string' && /^U[0-9a-f]{32}$/.test(u);

export function verifyLineTicket(token) {
  const p = verifySigned(token, 'kin-staff');
  return p && isLineUserId(p.u) ? p.u : null;
}

/* คอลัมน์ใหม่ — ใส่ใน schema.sql แล้วด้วย แต่ production รัน migrate เองด้วยมือ
   จึงสร้างแบบ IF NOT EXISTS ตอนเรียกครั้งแรกของแต่ละ instance กันฟีเจอร์ล้มก่อนมีคนรัน migrate */
let ready = null;
export const ensureLineColumn = () =>
  (ready ??= sql
    .run('ALTER TABLE employees ADD COLUMN IF NOT EXISTS line_user_id TEXT')
    .then(() =>
      sql.run(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_line_user ON employees (line_user_id) WHERE line_user_id IS NOT NULL',
      ),
    )
    .catch((err) => {
      ready = null;
      throw err;
    }));

/*
 * รหัสผูก LINE 6 หลัก (ดร.ธงชัย 23 ต.ค. 2569 "อนุญาตให้แก้ระบบงาน staff ทำรหัสผูก LINE 6 หลักจากหน้าพนักงาน")
 * พนักงานเดิมที่ไม่อยากกรอกรหัสผ่าน: แอดมินกดออกรหัสในหน้าพนักงาน (POST /api/employees/:id/line-code)
 * → พนักงานพิมพ์รหัสใน LINE @kinjobs → chat ส่งตั๋ว 'kin-line-code' {u, c} มาที่ /api/integration/line-code
 * รหัสจากแอดมิน = ตัวยืนยันว่า LINE นี้คือพนักงานคนนี้ (แทนรหัสผ่าน) · เก็บแค่ hash · อายุ 24 ชม. · ใช้ครั้งเดียว
 * กันเดารหัส: LINE หนึ่งบัญชีลองผิดได้ 5 ครั้ง/ชม.
 */
export const LINK_CODE_TTL_HOURS = 24;
export const LINK_CODE_MAX_TRIES = 5;
export const hashLinkCode = (code) => createHash('sha256').update(`kin-line-code:${code}`).digest('hex');

let codesReady = null;
export const ensureLinkCodeTables = () =>
  (codesReady ??= sql
    .run(`CREATE TABLE IF NOT EXISTS line_link_codes (
            employee_id TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .then(() => sql.run(`CREATE TABLE IF NOT EXISTS line_link_tries (
            line_user_id TEXT NOT NULL,
            at TIMESTAMPTZ NOT NULL DEFAULT now())`))
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_line_link_tries ON line_link_tries (line_user_id, at)'))
    .catch((err) => {
      codesReady = null;
      throw err;
    }));
