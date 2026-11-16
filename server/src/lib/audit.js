import { pool, sql } from '../db/index.js';
import { sessionEmployeeId } from './auth.js';
import { TOKEN_CHARS } from './errors.js';

/**
 * บันทึกการใช้งานระบบ (audit log) — ดร.ธงชัย 16 พ.ย. 2569 "ทำเลย เก็บอย่างน้อย 1 ปี ทุกระดับ"
 *
 * วางเป็น middleware ตัวเดียวหน้าทุก router (ดู app.js) แทนการไล่ใส่ทีละเส้น — เส้นที่เพิ่มทีหลังถูกบันทึกเอง
 * ไม่มีใครต้องจำ · เส้นไหนอยากเติมรายละเอียด (ผู้ทำตอน login ที่ยังไม่มี req.user) ใส่ res.locals.audit
 *
 * บันทึกอะไร (ระดับตามที่ตกลงกัน)
 *   1 ความปลอดภัย  — เข้า/ออกระบบ (ทั้งสำเร็จและไม่สำเร็จ) · รหัสผ่าน/OTP · ผูก LINE · สิทธิ์ · ถูกปฏิเสธสิทธิ์ (403)
 *   2 ข้อมูลบุคคล   — สร้าง/แก้/ลบ ลูกค้า ผู้รับบริการ พนักงาน ญาติ · การ "เปิดดู" แฟ้มที่มีข้อมูลสุขภาพ
 *   3 เงิน          — ใบแจ้งหนี้ รับเงิน สลิป ใบลดหนี้ ค่าจ้าง รอบจ่าย ราคาแพ็คเกจ · ส่งออกข้อมูล
 *   4 งานบริการ     — เคส นัด/กะ เช็คอิน-เอาท์ รายงานการดูแล คะแนนประเมิน
 *
 * ไม่บันทึก: รหัสผ่าน OTP token คุกกี้ · ค่าในช่องข้อมูลสุขภาพ/บุคคล (เก็บแค่ "ชื่อช่อง" ที่แก้)
 * ค่าที่เก็บได้จริงเฉพาะเรื่องเงิน สิทธิ์ และวัน/เวลา/คนของนัด — ตัดช่องที่หน้าตาเป็นเลขบัตร บัญชี รูป ไฟล์ทิ้งเสมอ
 *
 * เก็บอย่างน้อย 1 ปี: ลบได้เฉพาะแถวที่เก่ากว่า 1 ปี (trigger ในฐานกันไว้ — แอปแก้/ลบย้อนหลังไม่ได้)
 * งานตั้งเวลารายวันกวาดแถวที่เก่ากว่า AUDIT_RETENTION_DAYS ทิ้ง (ดู purgeAuditLogs)
 *
 * เขียนก่อนตอบกลับ (หน่วง res.end ไว้จนบันทึกเสร็จ ไม่เกิน WRITE_TIMEOUT_MS) ไม่ใช่หลังตอบ
 * เพราะบน Vercel ฟังก์ชันอาจถูกแช่แข็งทันทีที่ตอบกลับ งานที่ค้างหลังจากนั้นหายเงียบ
 * บันทึกไม่สำเร็จ = เขียนลง console แล้วตอบตามปกติ — log ล่มต้องไม่ทำให้งานจริงล่มตาม
 */

/** เก็บกี่วันก่อนกวาดทิ้ง — เกิน 1 ปีเผื่อไว้ (ข้อตกลงคือ "อย่างน้อย 1 ปี") */
export const AUDIT_RETENTION_DAYS = 400;
/** ลบได้เมื่อเก่ากว่านี้เท่านั้น — ตรงกับ trigger audit_logs_guard ใน schema.sql */
const AUDIT_MIN_KEEP = '365 days';
/** เปิดดูแฟ้มเดิมซ้ำภายในกี่นาทีนับเป็นครั้งเดียว — กันกดสลับแท็บไปมาจนตารางบวม */
const VIEW_DEDUPE_MINUTES = 15;
const WRITE_TIMEOUT_MS = 2000;

export const AUDIT_LEVELS = {
  1: 'ความปลอดภัย',
  2: 'ข้อมูลบุคคล/สุขภาพ',
  3: 'การเงิน',
  4: 'งานบริการ',
};

/* ---------- ตาราง ----------
 * แหล่งเดียวของโครงสร้าง audit_logs — migrate.js รันทั้งก้อนทุกครั้ง (คำสั่งทุกตัวรันซ้ำได้)
 * ensureAuditTable รันเฉพาะตอนยังไม่มีตาราง · schema.sql ไม่มีสำเนา (เคยมีสองที่ แก้ที่หนึ่งแล้วอีกที่ไม่ตาม) */
export const AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS audit_logs (
  log_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id       TEXT,
  actor_name     TEXT,
  actor_position TEXT,
  action         TEXT NOT NULL,
  level          SMALLINT NOT NULL,
  method         TEXT,
  path           TEXT,
  target_type    TEXT,
  target_id      TEXT,
  target_label   TEXT,
  status         INTEGER,
  ok             BOOLEAN NOT NULL,
  ip             TEXT,
  user_agent     TEXT,
  detail         JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_at     ON audit_logs (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor  ON audit_logs (actor_id, log_id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs (target_id, log_id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_level  ON audit_logs (level, log_id DESC);
CREATE OR REPLACE FUNCTION audit_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.at < now() - interval '${AUDIT_MIN_KEEP}' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'บันทึกการใช้งาน (audit_logs) แก้ไขไม่ได้ และลบได้เฉพาะรายการที่เก่ากว่า 1 ปี';
END
$fn$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_logs_guard') THEN
    CREATE TRIGGER audit_logs_guard BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_guard();
  END IF;
END
$do$;
`;

let ready = null;
/** สร้างตารางครั้งแรกของแต่ละ instance ถ้ายังไม่มี (ของจริงสร้างตอน migrate อยู่แล้ว · ดู db/migrate.js) */
export const ensureAuditTable = () =>
  (ready ??= (async () => {
    const { rows } = await pool.query(`SELECT to_regclass('audit_logs') IS NOT NULL AS ok`);
    if (!rows[0].ok) await pool.query(AUDIT_DDL);
  })().catch((err) => {
    ready = null;
    throw err;
  }));

/** กวาดของเก่ากว่า AUDIT_RETENTION_DAYS — งานตั้งเวลารายวัน (notify/routes.js) และหน้าดูบันทึกเรียก
 *  ครั้งละไม่เกิน PURGE_BATCH แถว (trigger ทำงานทีละแถว) — งานตั้งเวลาต้องเหลือเวลาส่งสรุปรายวัน
 *  ของที่เกินก้อนค้างไว้รอบถัดไป ซึ่งไม่ผิดข้อตกลง "อย่างน้อย 1 ปี" */
const PURGE_BATCH = 20_000;
export async function purgeAuditLogs() {
  await ensureAuditTable();
  return sql.run(
    `DELETE FROM audit_logs WHERE log_id IN (
       SELECT log_id FROM audit_logs WHERE at < now() - make_interval(days => :days)
        ORDER BY log_id LIMIT :batch)`,
    { days: AUDIT_RETENTION_DAYS, batch: PURGE_BATCH },
  );
}

/* ---------- แปลงคำขอเป็น "การกระทำ" ----------
 * action = <หมวด>.<คำในเส้นทาง>[.update|.delete|.view] — เช่น
 *   POST   /api/patients                  → patients.create
 *   PATCH  /api/patients/KN690202463      → patients.update
 *   POST   /api/cases/KN…/visits/12/move  → cases.visits.move
 *   DELETE /api/invoices/INV-…/slips/3    → invoices.slips.delete
 * ท่อนที่มีตัวเลข/ตัวพิมพ์ใหญ่ = รหัส (KN… EMP-0003 INV-… 12 โทเคน) ไม่ใช่คำ — รหัสแรกคือ "เป้าหมาย" ของรายการ
 * ชื่อภาษาไทยของแต่ละ action อยู่ที่ audit/labels.js
 */
const SKIP = [
  /^GET \/health$/,
  /^GET \/auth\/me$/,
  /^[A-Z]+ \/notify(\/|$)/, // งานตั้งเวลา/กระดิ่ง — ไม่ใช่การกระทำของคน
  /^POST \/my\/notifications\/read$/,
  /^POST \/cases\/(geocode|resolve-map-link|search-place)$/, // แค่ค้นแผนที่ ไม่เขียนอะไร
  /^POST \/cases\/[^/]+\/visits\/preview$/,
  /^GET \/audit-logs\/meta$/,
];

/* ระบบแชท (chat.kinorigin.com) ยิงเข้ามาทุกไม่กี่นาทีเพื่อดึงคิว/สรุป — บันทึกเฉพาะเส้นที่ "เปลี่ยนข้อมูล" จริง */
const INTEGRATION_WRITES = new Set([
  'line-code', 'employees/line-code', 'report', 'hire', 'cases/assign', 'customers/link',
  'family/accept', 'family/invite', 'family/post', 'family/team-post', 'family/forward-customer',
  'ratings/submit', 'invoices/pending-slip',
]);

/* GET ที่ต้องบันทึก — เปิดดูแฟ้มที่มีข้อมูลสุขภาพ/บุคคล และการส่งออกข้อมูล (dedupe = นับครั้งเดียวใน 15 นาที) */
// ID = ท่อนที่มีตัวเลขหรือตัวพิมพ์ใหญ่ (คำในเส้นทาง API เป็นตัวเล็กล้วนเสมอ) — /cases/meta · /employees/check-id ไม่ใช่การเปิดแฟ้ม
const ID = '[^/]*[0-9A-Z][^/]*';
const VIEWS = [
  { re: new RegExp(`^/patients/${ID}$`), dedupe: true },
  { re: new RegExp(`^/customers/${ID}$`), dedupe: true },
  { re: new RegExp(`^/employees/${ID}$`), dedupe: true },
  { re: new RegExp(`^/cases/${ID}$`), dedupe: true },
  { re: new RegExp(`^/cases/${ID}/reports$`), dedupe: true },
  { re: new RegExp(`^/my/cases/${ID}$`), dedupe: true },
  { re: new RegExp(`^/my/cases/${ID}/patient-reports$`), dedupe: true },
  { re: new RegExp(`^/public/bill/${ID}$`), dedupe: true },
  { re: /^\/invoices\/export$/, dedupe: false },
  { re: /^\/audit-logs$/, dedupe: true },
  { re: /^\/audit-logs\/export$/, dedupe: false },
];
// รหัส = มีตัวเลขหรือตัวพิมพ์ใหญ่ (KN… EMP-0003 INV-… 12 โทเคน) · ยกเว้นที่ไม่มีทั้งสองอย่าง: /permissions/<ตำแหน่ง>
const isId = (seg, i, segs) => /[0-9A-Z]/.test(seg) || (segs[0] === 'permissions' && i === 1);
/* ท่อนที่หน้าตาเป็นโทเคน (ลิงก์บิล · แบบประเมิน · เส้นที่เพิ่มทีหลัง) — กติกาเดียวกับ logUrl ใน lib/errors.js
   ใช้กับทุกเส้น ไม่ใช่แค่เส้นที่รู้จัก · รหัสจริงของระบบยาวไม่ถึง 24 ตัว (KN690202463-R2 · HC-IV6911160155)
   เก็บ 6 ตัวแรกพอให้แยกได้ว่าเป็นลิงก์ใบเดียวกันไหม */
const TOKEN_SEG = new RegExp(`^${TOKEN_CHARS}$`);
const maskSecret = (s) => (TOKEN_SEG.test(s) ? `${s.slice(0, 6)}…` : s);

/** แยกคำขอเป็น action/เป้าหมาย — null = ไม่ต้องบันทึก (export ไว้ให้เทสตรวจได้) */
export function describeRequest(method, rawPath) {
  const path = rawPath.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const key = `${method} ${path}`;
  if (SKIP.some((re) => re.test(key))) return null;

  const segs = path.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (segs.length === 0) return null;
  const resource = segs[0];

  if (resource === 'integration' && !INTEGRATION_WRITES.has(segs.slice(1).join('/'))) return null;

  let view = null;
  let denyOnly = false;
  if (method === 'GET') {
    // GET ของ auth (เข้าทาง LINE/SSO) ตัดสินที่ปลายทาง (ดู finalize) — ที่เหลือบันทึกเฉพาะรายการ VIEWS
    // GET อื่นทั้งหมด = บันทึกเฉพาะตอนถูกปฏิเสธสิทธิ์ (403)
    if (resource === 'auth') view = { dedupe: false };
    else view = VIEWS.find((v) => v.re.test(path)) ?? null;
    if (!view) denyOnly = true;
  }

  const words = [];
  let targetType = resource;
  let targetId = null;
  const sub = {};
  segs.slice(1).forEach((seg, j) => {
    const i = j + 1;
    if (isId(seg, i, segs)) {
      const prev = segs[i - 1];
      const value = maskSecret(seg).slice(0, 200);
      if (targetId == null) {
        targetId = value;
        if (prev !== resource && i > 1) targetType = prev;
      } else {
        sub[prev] = value;
      }
    } else {
      words.push(seg);
    }
  });
  if (targetType === 'cases' || resource === 'family') targetType = 'cases';
  if (resource === 'my' && (words[0] === 'visits' || words[0] === 'cases')) targetType = words[0];
  if (resource === 'permissions') targetType = 'positions';
  if (resource === 'reviews' && words[0] === 'form') targetType = 'reviews';

  let action = [resource, ...words].join('.');
  if (resource === 'auth') {
    /* auth ใช้ชื่อเส้นตรง ๆ: auth.login · auth.logout · auth.line (GET) · … */
  } else if (method === 'GET') {
    action += words.length ? (words.at(-1) === 'export' ? '' : '.view') : '.view';
  } else if (words.length === 0 || resource === 'permissions') {
    action += { POST: '.create', PUT: '.update', PATCH: '.update', DELETE: '.delete' }[method] ?? `.${method.toLowerCase()}`;
  } else if (method === 'PATCH' || method === 'PUT') {
    action += '.update';
  } else if (method === 'DELETE') {
    action += '.delete';
  }

  return {
    action,
    level: levelFor(action),
    targetType: targetId != null || words.length === 0 ? targetType : null,
    targetId,
    sub,
    view,
    denyOnly,
    path: `/api/${segs.map(maskSecret).join('/')}`.slice(0, 300),
  };
}

function levelFor(action) {
  if (/^(auth|permissions|audit-logs|access)\b/.test(action)) return 1;
  if (/line-code|^employees\.line\.delete$/.test(action)) return 1;
  if (/^(invoices|payroll|packages|physio|public)\b/.test(action)) return 3;
  if (/^cases\.(pay|approve-pay|attendance)/.test(action) || action === 'integration.invoices.pending-slip') return 3;
  if (/^(customers|patients|employees|family)\b/.test(action)) return 2;
  if (action === 'integration.hire' || action === 'integration.customers.link') return 2;
  if (/\.view$/.test(action) || /patient-reports/.test(action)) return 2; // เปิดดูแฟ้มเคส/รายงาน = ข้อมูลสุขภาพ
  return 4;
}

/* ---------- รายละเอียดที่เก็บ ---------- */
/** ช่องที่ห้ามเก็บค่าเด็ดขาด (เก็บแค่ชื่อช่อง) */
const SECRET_KEY = /pass|otp|^code$|code_hash|token|secret|^t$|national_id|id_card|citizen|tax_?(id|no|number)|passport|phone|mobile|email|address|line_?(user_)?id|bank|account|image|photo|slip_data|file|data_?url|base64|signature|^data$/i;
/** action ที่เก็บ "ค่า" ได้ — เงิน สิทธิ์ และวัน/เวลา/คนของนัด · ที่เหลือ (ข้อมูลบุคคล/สุขภาพ/รายงาน) เก็บแค่ชื่อช่อง
 *  แม้ใน action เหล่านี้ ข้อความก็เก็บค่าเฉพาะช่องใน SAFE_TEXT_KEY (ดู safeField) */
const VALUE_ACTION =
  /^(permissions|invoices|payroll|packages|physio|categories)\.|^cases\.(pay|approve-pay|attendance\.decide|assign|unassign|team|start|close|cancel|reopen|bundle|link-addon|unlink-addon|visits(?!.*reports))/;

/* ข้อความเก็บค่าได้เฉพาะช่องที่เป็น "โครงสร้าง" (รหัส สถานะ ชนิด วัน เวลา ตำแหน่ง สิทธิ์) — รายชื่อแบบอนุญาต ไม่ใช่แบบห้าม
   ช่องข้อความอิสระ (reason · note · cancel_reason · ชื่อ/ที่อยู่/เลขผู้เสียภาษีในใบแจ้งหนี้ · คำบรรยาย) เก็บแค่ความยาว
   เพราะคนพิมพ์อาการ/ข้อมูลส่วนตัวลงไปได้เสมอ และบันทึกนี้ลบไม่ได้ทั้งปี (ตรวจ 16 พ.ย. 2569) */
const SAFE_TEXT_KEY =
  /(^|_)(id|ids|status|kind|type|mode|basis|bucket|method|tier|month|year|date|dates|time|start|end|from|to|weekdays|position|permissions|category|decision|reason_code|sort|order|name_th|name_en)$/;
// ตัวเลขที่เป็นค่าสุขภาพ — ไม่เก็บแม้เป็นตัวเลข
const HEALTH_NUMBER_KEY = /weight|height|bmi|pressure|pulse|temp|sugar|spo2|glucose/i;
const textLen = (s) => `[ข้อความ ${s.length} ตัวอักษร]`;

function safeField(key, v) {
  if (SECRET_KEY.test(key)) return '[ซ่อน]';
  if (v == null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return HEALTH_NUMBER_KEY.test(key) ? '[ซ่อน]' : v;
  const safeText = SAFE_TEXT_KEY.test(key);
  if (typeof v === 'string') return safeText ? v.slice(0, 80) : textLen(v);
  if (Array.isArray(v)) {
    if (v.length > 30) return `[รายการ ${v.length} ชิ้น]`;
    if (v.every((x) => x == null || typeof x === 'number' || typeof x === 'boolean')) return v;
    if (safeText && v.every((x) => typeof x === 'string')) return v.map((x) => x.slice(0, 40));
    return `[รายการ ${v.length} ชิ้น]`;
  }
  return '[ข้อมูลชุด]';
}

function bodyDetail(action, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  if (action.startsWith('auth.')) return {}; // body ของ auth มีแต่รหัสผ่าน/OTP/ตั๋ว
  // ชื่อช่องก็ตัดความยาว — body มาจากผู้เรียก (สูงสุด 8 MB) ชื่อช่องยาวผิดปกติต้องไม่ทำให้แถวบวม
  const all = Object.keys(body).slice(0, 60);
  if (all.length === 0) return {};
  const fields = all.map((k) => k.slice(0, 60));
  if (!VALUE_ACTION.test(action)) return { fields };
  const values = {};
  for (const k of all) values[k.slice(0, 60)] = safeField(k, body[k]);
  return { fields, values };
}

function queryDetail(query) {
  const out = {};
  for (const [k, v] of Object.entries(query ?? {})) {
    if (SECRET_KEY.test(k)) continue;
    // คำค้น (q) เก็บตามที่พิมพ์ — บอกได้ว่าส่งออก/ค้นหาอะไรไป · ช่องอื่นใช้กติกาเดียวกับ body
    out[k.slice(0, 60)] = k === 'q' && typeof v === 'string' ? v.slice(0, 80) : safeField(k, v);
    if (Object.keys(out).length >= 20) break;
  }
  return Object.keys(out).length ? out : null;
}

/** รหัสของสิ่งที่เพิ่งสร้าง — POST /api/patients ไม่มีรหัสใน URL ต้องอ่านจากคำตอบ */
const ID_KEYS = {
  customers: 'customer_id',
  patients: 'patient_id',
  employees: 'employee_id',
  cases: 'case_id',
  invoices: 'invoice_id',
  payroll: 'run_id',
};
function idFromBody(type, body) {
  const key = ID_KEYS[type];
  if (!key || !body || typeof body !== 'object') return null;
  if (body[key] != null) return String(body[key]);
  for (const v of Object.values(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v[key] != null) return String(v[key]);
  }
  return null;
}

/** ชื่อที่อ่านออกของเป้าหมาย (ชื่อผู้รับบริการ/ลูกค้า/พนักงาน) — SQL ชิ้นเดียวใช้ทั้งตอนบันทึกและก่อนลบ */
const LABEL_SQL = `CASE :target_type::text
  WHEN 'patients'  THEN (SELECT name FROM patients WHERE patient_id = :target_id::text)
  WHEN 'customers' THEN (SELECT name FROM customers WHERE customer_id = :target_id::text)
  WHEN 'employees' THEN (SELECT first_name || ' ' || last_name FROM employees WHERE employee_id = :target_id::text)
  WHEN 'cases'     THEN (SELECT client_name FROM cases WHERE case_id = :target_id::text)
  WHEN 'invoices'  THEN (SELECT c.name FROM invoices i LEFT JOIN customers c ON c.customer_id = i.customer_id
                          WHERE i.invoice_id = :target_id::text)
END`;

async function lookupLabel(type, id) {
  if (!id || !['patients', 'customers', 'employees', 'cases', 'invoices'].includes(type)) return null;
  const row = await sql.one(`SELECT ${LABEL_SQL} AS label`, { target_type: type, target_id: id });
  return row?.label ?? null;
}

/* ---------- เขียน ---------- */
async function writeEntry(e) {
  await ensureAuditTable();
  await sql.run(
    /* ทุกพารามิเตอร์แคสต์ชนิดเอง — INSERT … SELECT ไม่ส่งชนิดของคอลัมน์ปลายทางย้อนมาให้ Postgres เดา */
    `INSERT INTO audit_logs (actor_id, actor_name, actor_position, action, level, method, path,
                             target_type, target_id, target_label, status, ok, ip, user_agent, detail)
     SELECT :actor_id::text,
            COALESCE(:actor_name::text, (SELECT first_name || ' ' || last_name FROM employees WHERE employee_id = :actor_id::text)),
            COALESCE(:actor_position::text, (SELECT position FROM employees WHERE employee_id = :actor_id::text)),
            :action::text, :level::smallint, :method::text, :path::text,
            :target_type::text, :target_id::text, COALESCE(:target_label::text, ${LABEL_SQL}),
            :status::int, :ok::boolean, :ip::text, :user_agent::text, :detail::jsonb
     WHERE NOT :dedupe::boolean OR NOT EXISTS (
       SELECT 1 FROM audit_logs
        WHERE action = :action::text AND at > now() - make_interval(mins => :dedupe_mins::int)
          AND actor_id IS NOT DISTINCT FROM :actor_id::text
          AND target_id IS NOT DISTINCT FROM :target_id::text
          AND path IS NOT DISTINCT FROM :path::text
          AND status IS NOT DISTINCT FROM :status::int
          AND (:actor_id::text IS NOT NULL OR ip IS NOT DISTINCT FROM :ip::text))`,
    { ...e, dedupe_mins: VIEW_DEDUPE_MINUTES },
  );
}

/** บันทึกเองนอก middleware (เช่น งานในระบบที่ไม่ได้มาจากคำขอ) — ล้มก็ไม่โยนต่อ */
export async function recordAudit(entry) {
  try {
    await writeEntry({
      actor_id: null, actor_name: null, actor_position: null, method: null, path: null,
      target_type: null, target_id: null, target_label: null, status: null, ok: true,
      ip: null, user_agent: null, dedupe: false, ...entry,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
    });
  } catch (err) {
    console.error('[audit] บันทึกไม่สำเร็จ:', err.message);
  }
}

function withTimeout(p, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`เกิน ${ms}ms`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/**
 * middleware — วางที่ app.use('/api', auditTrail) ก่อนทุก router
 * ตัดสินใจตอนจะตอบกลับ (รู้แล้วว่าใครทำ ผลเป็นอย่างไร) โดยหน่วง res.end ไว้จนบันทึกเสร็จ
 */
export function auditTrail(req, res, next) {
  if (req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  const rawPath = String(req.originalUrl || '').split('?')[0];
  const info = describeRequest(req.method, rawPath);
  if (!info) return next();

  // คำตอบ JSON — ใช้อ่านรหัสของที่เพิ่งสร้าง และข้อความ error
  let responseBody;
  const origJson = res.json;
  res.json = function json(body) {
    responseBody = body;
    return origJson.call(this, body);
  };

  const origEnd = res.end;
  let ended = false;
  res.end = function end(...args) {
    if (ended) return origEnd.apply(this, args);
    ended = true;
    let entry = null;
    try {
      entry = finalize(req, res, info, responseBody);
    } catch (err) {
      console.error('[audit] เตรียมบันทึกไม่สำเร็จ:', err.message);
    }
    if (!entry) return origEnd.apply(this, args);
    withTimeout(writeEntry(entry), WRITE_TIMEOUT_MS)
      .catch((err) => console.error(`[audit] บันทึก ${entry.action} ไม่สำเร็จ:`, err.message))
      .finally(() => origEnd.apply(res, args));
    return res;
  };

  /* ลบแฟ้ม = ชื่อหายไปพร้อมแถว — อ่านชื่อไว้ก่อนให้บันทึกยังบอกได้ว่าลบใคร
     ลบเคส = ประวัติการทำรายการของเคส (case_events) ถูกลบตาม (ON DELETE CASCADE) — เก็บสำเนาไว้ในบันทึกนี้ */
  // เฉพาะคำขอที่มีเซสชันลายเซ็นถูก — คนนอกยิง DELETE มั่ว ๆ (แม้แนบคุกกี้ปลอม) ต้องไม่ได้ทำให้ฐานต้องอ่านอะไรเพิ่ม
  if (req.method === 'DELETE' && info.targetId && sessionEmployeeId(req)
      && rawPath.split('/').filter(Boolean).length === 3) {
    const pre = (async () => {
      info.preLabel = await lookupLabel(info.targetType, info.targetId);
      if (info.action === 'cases.delete') {
        info.caseEvents = await sql.all(
          `SELECT event, left(detail, 200) AS detail, actor_id, actor_name, created_at FROM case_events
            WHERE case_id = :id ORDER BY event_id LIMIT 300`,
          { id: info.targetId },
        );
      }
    })();
    return withTimeout(pre, WRITE_TIMEOUT_MS)
      .catch((err) => console.error('[audit] อ่านข้อมูลก่อนลบไม่สำเร็จ:', err.message))
      .finally(() => next());
  }
  next();
}

function finalize(req, res, info, responseBody) {
  const status = res.statusCode;
  const ok = status < 400;
  const extra = res.locals.audit ?? {};

  let action = info.action;
  let level = info.level;
  let dedupe = Boolean(info.view?.dedupe);

  if (info.denyOnly) {
    // GET ทั่วไปไม่บันทึก — ยกเว้นถูกปฏิเสธสิทธิ์ ซึ่งเป็นสัญญาณว่ามีคนลองเข้าส่วนที่ไม่มีสิทธิ์
    if (status !== 403) return null;
    action = 'access.denied';
    level = 1;
    dedupe = true;
  }

  /* เข้าระบบทาง LINE / SSO เป็น GET ที่ตอบด้วย redirect — บันทึกเมื่อเข้าได้จริง หรือถูกปฏิเสธ
     (redirect ไปหน้า login พร้อม ?line=… = ยังไม่ผูก LINE ไม่ใช่ความล้มเหลว ไม่บันทึก) */
  let failedByRedirect = false;
  if (req.method === 'GET' && action.startsWith('auth.')) {
    const loc = String(res.get('Location') ?? '');
    failedByRedirect = /[?&](line_error|sso_error)=/.test(loc);
    if (!extra.actor && !failedByRedirect && ok) return null;
    if (failedByRedirect) extra.detail = { ...extra.detail, reason: loc.match(/(?:line_error|sso_error)=([a-z]+)/)?.[1] };
  }

  const actor = extra.actor ?? req.user ?? null;
  let actorId = actor?.employee_id ?? null;
  // ออกจากระบบไม่ผ่าน requireAuth — อ่านเจ้าของจากคุกกี้ (เชื่อแค่ลายเซ็น พอสำหรับการบันทึก)
  if (!actorId && action === 'auth.logout') actorId = sessionEmployeeId(req);
  const actorName = actor?.name ?? (actor?.first_name ? `${actor.first_name} ${actor.last_name ?? ''}`.trim() : null);

  const detail = {};
  if (!info.denyOnly) Object.assign(detail, bodyDetail(action, req.body));
  if (req.method === 'GET') {
    const q = queryDetail(req.query);
    if (q && !action.startsWith('auth.')) detail.query = q;
  }
  if (['auth.login', 'auth.forgot-password', 'auth.reset-password'].includes(action) && typeof req.body?.email === 'string') {
    detail.login = loginText(req.body.email.trim(), Boolean(extra.target_id));
  }
  if (Object.keys(info.sub).length) detail.sub = info.sub;
  if (resource(info) === 'integration') detail.source = 'chat.kinorigin.com';
  if (!ok && responseBody && typeof responseBody.error === 'string') detail.error = responseBody.error.slice(0, 300);
  if (info.caseEvents?.length && ok) detail.case_events = info.caseEvents;
  Object.assign(detail, extra.detail ?? {});

  const targetType = extra.target_type ?? info.targetType;
  let targetId = extra.target_id ?? info.targetId;
  if (!targetId && ok && req.method === 'POST') targetId = idFromBody(targetType, responseBody);

  /* คำขอที่ไม่รู้ตัวตนและไม่สำเร็จ = ใครก็ยิงได้ไม่จำกัด แต่แถวบันทึกลบไม่ได้ทั้งปี (ตรวจ 16 พ.ย. 2569)
     · เส้นที่ต้อง login / เส้นสาธารณะ / ระบบแชท ที่ล้ม (401 404 โทเคนผิด ลายเซ็นผิด) → ไม่บันทึก
     · เข้าระบบ/OTP ที่ล้ม → บันทึก (สัญญาณถูกเดารหัส) แต่นับครั้งเดียวต่อ บัญชี+IP+ผลลัพธ์ ใน 15 นาที
       รายละเอียดจำนวนครั้งที่ผิดอยู่ที่ login_failures (ตัวล็อกบัญชี) อยู่แล้ว */
  if (!actorId && !ok && !info.denyOnly) {
    if (!action.startsWith('auth.')) return null;
    dedupe = true;
  }
  /* ไม่รู้ตัวตนแต่ "สำเร็จ" ก็ยิงได้ไม่จำกัดเหมือนกัน (ขอ OTP ตอบ 200 เสมอ · เปิดลิงก์บิล · ส่งแบบประเมิน)
     นับครั้งเดียวต่อ IP + เส้นทาง + เป้าหมาย + ผลลัพธ์ ใน 15 นาที (ตรวจ 16 พ.ย. 2569)
     ยกเว้นระบบแชท (integration) — ลงลายเซ็นมาแล้ว และยิงจาก IP เดียวทุกรายการ ถ้านับรวมจะทิ้งเหตุการณ์จริง */
  if (!actorId && resource(info) !== 'integration') dedupe = true;

  let detailJson = Object.keys(detail).length ? JSON.stringify(detail) : null;
  if (detailJson && detailJson.length > DETAIL_MAX) {
    detailJson = JSON.stringify({ truncated: true, size: detailJson.length, fields: detail.fields?.slice(0, 60) });
  }

  return {
    actor_id: actorId,
    actor_name: actorName,
    actor_position: actor?.position ?? null,
    action,
    level,
    method: req.method,
    path: info.path,
    target_type: targetId != null ? targetType : null,
    target_id: targetId != null ? String(targetId).slice(0, 200) : null,
    target_label: info.preLabel ?? extra.target_label ?? null,
    status,
    ok: ok && !failedByRedirect,
    ip: String(req.ip ?? '').slice(0, 64) || null,
    user_agent: String(req.get('user-agent') ?? '').slice(0, 300) || null,
    detail: detailJson,
    dedupe,
  };
}

const resource = (info) => info.path.split('/')[2];

/** รายละเอียดยาวสุดต่อแถว (ไบต์ของ JSON) — สำเนาประวัติเคส 300 รายการยังพอดี */
const DETAIL_MAX = 100_000;

/* ชื่อที่พิมพ์ช่องอีเมล/รหัสพนักงานตอนเข้าระบบ — คนพิมพ์รหัสผ่านผิดช่องเป็นเรื่องปกติ
   เก็บตามที่พิมพ์ได้เฉพาะเมื่อ "ตรงกับบัญชีจริง" (คือชื่อบัญชีแน่นอน) หรือหน้าตาเป็นอีเมล
   ที่เหลือเก็บแค่ความยาว — รหัสผ่านที่หลุดลงบันทึกที่ลบไม่ได้ทั้งปีคือของที่เอาคืนไม่ได้ */
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
function loginText(s, matchedAccount) {
  if (matchedAccount || EMAIL_SHAPE.test(s)) return s.slice(0, 254);
  return `[ไม่พบบัญชี · ${s.length} ตัวอักษร]`;
}
