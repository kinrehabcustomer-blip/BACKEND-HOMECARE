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
/* กุญแจสาธารณะของฝั่ง chat — ค่าปริยายคือกุญแจที่ใช้อยู่จริง ตั้ง env ทับได้
   ทำให้ตั้งทับได้ด้วยเหตุผลสองข้อ: (ก) วันที่ต้องหมุนกุญแจ จะสลับได้โดยไม่ต้อง deploy โค้ดใหม่พร้อมกันสองฝั่ง
   (ข) ชุดทดสอบสะพานเซ็นตั๋วเองด้วยกุญแจชั่วคราวได้ ไม่ต้องเอากุญแจลับตัวจริงมาไว้ในเครื่องที่รันเทส
   ไม่ตั้ง env = พฤติกรรมเดิมทุกประการ */
const PUBLIC_KEY = createPublicKey(process.env.STAFF_BRIDGE_PUBLIC_KEY ?? `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAw+qNWMf5eVMSLX/i3xWn1x24NWlGvJSEeDBdqrl+lQc=
-----END PUBLIC KEY-----`);

/** เพดานอายุตั๋วที่ยอมรับ — ตั๋วจริงยาวสุด 10 นาที (kin-staff) ที่เหลือ 1–5 นาที */
const MAX_TICKET_MS = 15 * 60 * 1000;

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
    if (p.a !== purpose || typeof p.e !== 'number' || p.e < Date.now()) return null;
    /* เพดานอายุตั๋วฝั่งผู้ตรวจ (ตรวจรอบ 19) — เดิมเชื่อค่า e ที่ผู้เซ็นใส่มาล้วน ๆ
       ตั๋วไปโผล่ใน URL ประวัติเบราว์เซอร์ ล็อก และห้องแชท LINE ได้ ยิ่งอายุยาวยิ่งเสี่ยง
       ถ้าวันหนึ่งโค้ดฝั่ง chat เผลอตั้ง 24 ชั่วโมง ฝั่งนี้ต้องไม่รับตามไปด้วย
       ตั๋วที่ฝั่ง chat ออกจริงยาวสุดคือ 10 นาที (kin-staff) ที่เหลือ 1–5 นาที — 15 นาทีจึงเหลือที่พอ */
    if (p.e - Date.now() > MAX_TICKET_MS) return null;
    return p;
  } catch {
    return null;
  }
}

export const isLineUserId = (u) => typeof u === 'string' && /^U[0-9a-f]{32}$/.test(u);

/*
 * ตั๋ว 'kin-staff' ใช้ออกคุกกี้ได้ครั้งเดียว (เหตุผลเดียวกับ admin_sso_used ใน auth/routes.js)
 *
 * ตั๋วเดินทางผ่าน LINE ไปถึงพนักงาน และไปโผล่เป็น URL ของหน้า /login?line=<ตั๋ว> ซึ่งเป็นหน้าที่
 * ไม่ต้องล็อกอิน — มันจึงค้างอยู่ในประวัติเบราว์เซอร์ ใน log ของ proxy และในแชทที่ถูกส่งต่อ
 * อายุตั๋ว 10 นาที (ยาวกว่า admin-sso 5 เท่า) คนที่เห็น URL ในช่วงนั้นเอาไปเข้าแทนเจ้าตัวได้ตลอด
 *
 * จองตอน "กำลังจะออกคุกกี้" เท่านั้น ไม่ใช่ตอนตรวจลายเซ็น — เพราะเส้นทางที่ LINE ยังไม่ผูกกับพนักงาน
 * ส่งตั๋วใบเดิมต่อไปให้ POST /auth/line-link และ POST /auth/line-code ใช้ยืนยันความเป็นเจ้าของ LINE อีกครั้ง
 * (ดู client/src/pages/LoginPage.jsx) ถ้าเผาตั๋วตั้งแต่ตอนตรวจ การผูกบัญชีครั้งแรกจะพังทั้งเส้น
 */
let usedReady = null;
export const ensureTicketUsedTable = () =>
  (usedReady ??= sql
    .run(`CREATE TABLE IF NOT EXISTS line_ticket_used (
            token_hash  TEXT PRIMARY KEY,
            employee_id TEXT,
            used_at     TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .catch((err) => {
      usedReady = null;
      throw err;
    }));

export const hashTicket = (token) => createHash('sha256').update(`kin-line-ticket:${String(token)}`).digest('hex');

/** จองตั๋วใบนี้ — true = ยังไม่เคยถูกใช้ ออกคุกกี้ได้ · false = เคยใช้ไปแล้ว ต้องกดปุ่มใน LINE ใหม่ */
export async function claimLineTicket(token, employeeId) {
  await ensureTicketUsedTable();
  // ตั๋วอายุ 10 นาที เก็บไว้ 1 วันก็เกินพอที่จะกันใช้ซ้ำ — ไม่ปล่อยให้ตารางโตไม่สิ้นสุด
  await sql.run(`DELETE FROM line_ticket_used WHERE used_at < now() - interval '1 day'`);
  return Boolean(
    await sql.run('INSERT INTO line_ticket_used (token_hash, employee_id) VALUES (:h, :id) ON CONFLICT DO NOTHING', {
      h: hashTicket(token),
      id: employeeId,
    }),
  );
}

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

/* ---------- ยิงตั๋วใบเดิมซ้ำ ต้องไม่เกิดของซ้ำ (ตรวจรอบ 19 · ดร.ธงชัยสั่งแก้ 26 ต.ค. 2569) ----------
 *
 * ปัญหา: ฝั่งแชทยิงซ้ำด้วยตั๋วใบเดิมได้เป็นเรื่องปกติ (เน็ตหลุดตอนรอคำตอบ · ผู้ใช้กดสองที ·
 * ตัวลองใหม่อัตโนมัติ) แล้วเกิดรายงานซ้ำ ข้อความซ้ำ รหัสเชิญญาติสองใบที่กินเพดาน 5 คนไปสองที่
 *
 * ทำไมใช้ "ตัวตั๋ว" เป็นกุญแจกันซ้ำ แทนที่จะให้ฝั่งแชทส่งรหัสคำขอมาใหม่:
 * ตั๋วทุกใบที่ออกไม่ซ้ำกันอยู่แล้ว (เวลาหมดอายุเป็นมิลลิวินาที อยู่ใน payload ที่ถูกเซ็น)
 * การลองใหม่ของจริงใช้ตั๋วใบเดิม ส่วนการส่งข้อความใหม่จริง ๆ ได้ตั๋วใบใหม่เสมอ
 * จึงแยกสองกรณีนี้ออกจากกันได้โดยไม่ต้องแก้ฝั่งแชทและไม่ต้อง deploy พร้อมกันสองระบบ
 *
 * ทำไมคืนคำตอบเดิมแทนที่จะตอบ error:
 * ถ้าปฏิเสธตั๋วซ้ำดื้อ ๆ คำขอที่ "ทำสำเร็จแล้วแต่คำตอบหายกลางทาง" จะกลายเป็นข้อความที่ส่งไม่ได้อีกเลย
 * เก็บคำตอบของครั้งแรกไว้แล้วคืนให้เหมือนเดิม ฝั่งแชทจึงเดินต่อได้ถูกไม่ว่าคำตอบจะหายหรือไม่
 *
 * งานที่ล้มกลางคันปล่อยกุญแจคืน — การลองใหม่หลังระบบพังต้องทำงานได้จริง ไม่ใช่ถูกกันเพราะเคยลองแล้ว
 */
const ticketKey = (token) => createHash('sha256').update(`kin-bridge:${token}`).digest('hex');

let ticketUseReady = null;
const ensureTicketUse = () =>
  (ticketUseReady ??= sql
    .run(`CREATE TABLE IF NOT EXISTS bridge_ticket_use (
      token_hash TEXT PRIMARY KEY,
      purpose    TEXT NOT NULL,
      status     INTEGER,
      response   JSONB,
      done_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    .catch((err) => { ticketUseReady = null; throw err; }));

/**
 * ทำงานครั้งเดียวต่อหนึ่งตั๋ว — ยิงซ้ำได้คำตอบเดิมโดยไม่ทำงานซ้ำ
 *   run() คืน { status, body } · คืนค่าออกไปเป็น { status, body, replayed }
 */
export async function onceByTicket(token, purpose, run) {
  await ensureTicketUse();
  const h = ticketKey(token);

  const claimed = await sql.one(
    `INSERT INTO bridge_ticket_use (token_hash, purpose) VALUES (:h, :p)
     ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash`,
    { h, p: purpose },
  );

  if (!claimed) {
    const prev = await sql.one('SELECT status, response, done_at FROM bridge_ticket_use WHERE token_hash = :h', { h });
    /* จองไว้แล้วแต่ยังไม่มีคำตอบ = คำขอแรกยังทำงานค้างอยู่ (สองคำขอมาพร้อมกันพอดี)
       ตอบ 409 ให้ฝั่งแชทลองใหม่อีกสักครู่ ดีกว่าทำซ้ำหรือคืนคำตอบเปล่า */
    if (!prev?.done_at) {
      return { status: 409, body: { error: 'คำขอเดิมกำลังทำงานอยู่ กรุณาลองใหม่อีกครั้ง' }, replayed: true };
    }
    return { status: prev.status ?? 200, body: prev.response ?? { ok: true }, replayed: true };
  }

  let result;
  try {
    result = await run();
  } catch (err) {
    // ล้มกลางคัน = ปล่อยกุญแจคืน ให้ลองใหม่ได้จริง
    await sql.run('DELETE FROM bridge_ticket_use WHERE token_hash = :h', { h }).catch(() => {});
    throw err;
  }

  await sql.run(
    `UPDATE bridge_ticket_use SET status = :s, response = :r::jsonb, done_at = now() WHERE token_hash = :h`,
    { h, s: result.status ?? 200, r: JSON.stringify(result.body ?? {}) },
  );
  /* เก็บไว้นานกว่าอายุตั๋วพอสมควรก็พอ — ตั๋วหมดอายุแล้วใช้ไม่ได้อีกอยู่แล้ว
     กวาดของเก่าทิ้งตอนเขียนแถวใหม่ จะได้ไม่ต้องมีงานตั้งเวลาเพิ่มอีกตัว */
  await sql.run(`DELETE FROM bridge_ticket_use WHERE created_at < now() - interval '2 days'`).catch(() => {});
  return { ...result, replayed: false };
}
