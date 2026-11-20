import { AsyncLocalStorage } from 'node:async_hooks';
import webpush from 'web-push';
import { sql } from '../db/index.js';
import { todayTh } from '../lib/dates.js';
import { ensureStaffInbox } from './staffInbox.js';

/**
 * แจ้งเตือนบนมือถือ (Web Push · ผู้ใช้ขอ 20 พ.ย. 2569) — เด้งขึ้นที่เครื่องแม้ปิดแอปอยู่
 * เฉพาะพนักงานภาคสนาม: ส่งทุกอย่างที่เข้ากระดิ่งพนักงาน (notify/staffInbox.js)
 *   กะใหม่ · เลื่อน · ยกเลิก · ย้ายไปให้คนอื่น · เตือนวันก่อนนัด · เตือน 3 ชม.
 * คู่ขนานกับ LINE @kinjobs เหมือนกระดิ่ง ไม่ได้แทน
 *
 * ใช้ staff_notifications เป็นคิวเอง (คอลัมน์ pushed_at) — ไม่มีตารางคิวแยก
 *   1. เหตุการณ์ในคำขอ (ลงกะ/แก้กะ) → push() ของ staffInbox จดว่า "คำขอนี้มีแจ้งเตือนใหม่" (AsyncLocalStorage)
 *      → ก่อนตอบกลับ (res.json) ส่ง push ให้เลย — หลัง transaction commit แล้ว กะที่ rollback จึงไม่เด้ง
 *   2. เตือนก่อนนัด → cron 15 นาทีของ chat.kinorigin.com (/api/integration/visits/reminders) สร้างแถวเตือนของทุกคนแล้วส่ง
 * claim ก่อนส่ง (UPDATE … SET pushed_at RETURNING) — ส่งอย่างมากครั้งเดียว ไม่ซ้ำแม้ cron ซ้อน
 * ส่งไม่ทันใน 6 ชม. = ไม่ส่งแล้ว (ของเก่ามาเด้งทีหลังทำให้สับสน) แต่ยังอยู่ในกระดิ่งตามเดิม
 *
 * ต้องตั้งค่าใน .env / Vercel: VAPID_PUBLIC_KEY · VAPID_PRIVATE_KEY · VAPID_SUBJECT (mailto:… ของทีม)
 * สร้างคู่กุญแจ: npx web-push generate-vapid-keys · ไม่ตั้ง = ฟีเจอร์ปิดเงียบ (หน้าตั้งค่าบอกว่ายังไม่เปิดใช้)
 *
 * ข้อความบนจอล็อก: ชื่อผู้รับบริการ + วัน/เวลานัด เท่าที่กระดิ่งแสดงอยู่แล้ว — ไม่มีข้อมูลสุขภาพ/เงิน
 */

const env = () => ({
  publicKey: process.env.VAPID_PUBLIC_KEY?.trim() || null,
  privateKey: process.env.VAPID_PRIVATE_KEY?.trim() || null,
  subject: process.env.VAPID_SUBJECT?.trim() || null,
});

let configured = null;
/** ตั้งกุญแจให้ web-push ครั้งเดียว — คืน false ถ้ายังไม่ได้ตั้งค่า */
export function pushReady() {
  const { publicKey, privateKey, subject } = env();
  if (!publicKey || !privateKey || !subject) return false;
  if (configured !== publicKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = publicKey;
  }
  return true;
}
export const publicKey = () => (pushReady() ? env().publicKey : null);

let ready = null;
export const ensurePushTables = () =>
  (ready ??= (async () => {
    await sql.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      employee_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_ok_at TIMESTAMPTZ,
      fail_count INTEGER NOT NULL DEFAULT 0
    )`);
    await sql.run('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_employee ON push_subscriptions (employee_id)');
    // คอลัมน์ pushed_at ของ staff_notifications อยู่ที่ ensureStaffInbox (ตารางต้องมีก่อน)
  })().catch((err) => { ready = null; throw err; }));

/* ---------- เครื่องที่สมัครรับ ---------- */

export async function subscribe(employeeId, { endpoint, keys }, userAgent) {
  await ensurePushTables();
  /* endpoint เดียวกัน = เครื่อง/เบราว์เซอร์เดียวกัน — มีคนอื่นเคยล็อกอินเครื่องนี้ ย้ายมาเป็นของคนล่าสุด
     (ไม่งั้นแจ้งเตือนกะของคนเก่าจะเด้งบนเครื่องที่ตอนนี้คนอื่นถืออยู่) */
  await sql.run(
    `INSERT INTO push_subscriptions (employee_id, endpoint, p256dh, auth, user_agent)
     VALUES (:employeeId, :endpoint, :p256dh, :auth, :ua)
     ON CONFLICT (endpoint) DO UPDATE SET employee_id = EXCLUDED.employee_id, p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, fail_count = 0`,
    { employeeId, endpoint, p256dh: keys.p256dh, auth: keys.auth, ua: userAgent?.slice(0, 300) ?? null },
  );
}

/** endpoint = ปิดเฉพาะเครื่องนี้ · ไม่ส่ง = ปิดทุกเครื่องของคนนี้ (ออกจากระบบทุกเครื่อง) */
export async function unsubscribe(employeeId, endpoint = null) {
  await ensurePushTables();
  return sql.run(
    `DELETE FROM push_subscriptions WHERE employee_id = :employeeId ${endpoint ? 'AND endpoint = :endpoint' : ''}`,
    endpoint ? { employeeId, endpoint } : { employeeId },
  );
}

export async function isSubscribed(employeeId, endpoint) {
  await ensurePushTables();
  return Boolean(await sql.one(
    'SELECT 1 AS ok FROM push_subscriptions WHERE employee_id = :employeeId AND endpoint = :endpoint',
    { employeeId, endpoint },
  ));
}

/* ---------- ข้อความ ---------- */

const dayText = (d) =>
  d ? new Date(`${d}T00:00:00+07:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' }) : '';
const whenText = (d, start) => `${dayText(d)}${start ? ` ${start} น.` : ''}`;

/** ถ้อยคำเดียวกับกระดิ่ง (client/src/components/StaffBell.jsx describe/targetOf) — แก้ที่หนึ่งให้แก้อีกที่ด้วย */
export function describe(n) {
  const p = n.payload ?? {};
  const who = p.client ?? 'ผู้รับบริการ';
  const today = todayTh();
  const url = p.date === today && !['visit_cancelled', 'visit_removed'].includes(n.kind) ? '/my-today' : '/my-calendar';
  const msg = (() => {
    switch (n.kind) {
      case 'visits_added':
        return {
          title: p.total > 1 ? `กะใหม่ ${p.total} กะ` : 'กะใหม่',
          body: `${who} · ${whenText(p.date, p.start)}${p.total > 1 && p.last_date !== p.date ? ` ถึง ${dayText(p.last_date)}` : ''}`,
        };
      case 'visit_moved':
        return { title: 'กะถูกเลื่อน', body: `${who} · ${whenText(p.old_date, p.old_start)} → ${whenText(p.date, p.start)}` };
      case 'visit_cancelled':
        return { title: 'กะถูกยกเลิก', body: `${who} · ${whenText(p.date, p.start)}${p.reason ? ` · ${p.reason}` : ''}` };
      case 'visit_removed':
        return { title: 'กะถูกย้ายไปให้คนอื่น', body: `${who} · ${whenText(p.date, p.start)}` };
      case 'remind_day':
        return { title: 'พรุ่งนี้มีกะ', body: `${who} · ${whenText(p.date, p.start)}` };
      case 'remind_3h':
        return { title: 'ใกล้ถึงเวลากะ', body: `${who} · เริ่ม ${p.start} น.` };
      default:
        return { title: 'แจ้งเตือน', body: who };
    }
  })();
  return { ...msg, url, tag: `kin-${n.id ?? n.kind}` };
}

/* ---------- ส่ง ---------- */

/** ส่งถึงทุกเครื่องของคนนี้ — เครื่องที่เลิกรับแล้ว (404/410) ลบทิ้ง · ล้มติดกัน 5 ครั้งก็ลบ */
async function sendToSubs(subs, message) {
  let sent = 0;
  const body = JSON.stringify(message);
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 6 * 3600, urgency: 'high', timeout: 8000 },
      );
      sent += 1;
      await sql.run('UPDATE push_subscriptions SET last_ok_at = now(), fail_count = 0 WHERE id = :id', { id: s.id });
    } catch (err) {
      const gone = err?.statusCode === 404 || err?.statusCode === 410;
      if (gone) {
        await sql.run('DELETE FROM push_subscriptions WHERE id = :id', { id: s.id });
      } else {
        console.error('[web-push]', err?.statusCode ?? '', err?.body ?? err?.message ?? err);
        await sql.run('DELETE FROM push_subscriptions WHERE id = :id AND fail_count >= 4', { id: s.id }).catch(() => {});
        await sql.run('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = :id', { id: s.id }).catch(() => {});
      }
    }
  }
  return sent;
}

/**
 * ส่งแจ้งเตือนที่ยังไม่ได้ส่ง — employeeIds ว่าง = ทุกคน
 * claim ทีละไม่เกิน 200 แถว · แถวของคนที่ไม่มีเครื่องสมัครไว้ก็ถูก claim ด้วย (ไม่งั้นค้างให้ query ทุกรอบ)
 */
export async function flushPending({ limit = 200 } = {}) {
  if (!pushReady()) return { claimed: 0, sent: 0 };
  await ensurePushTables();
  await ensureStaffInbox();
  const rows = await sql.all(
    `UPDATE staff_notifications SET pushed_at = now()
     WHERE id IN (
       SELECT id FROM staff_notifications
       WHERE pushed_at IS NULL AND created_at > now() - interval '6 hours'
       ORDER BY created_at LIMIT :limit
       FOR UPDATE SKIP LOCKED)
     RETURNING id, employee_id, kind, payload`,
    { limit },
  );
  if (!rows.length) return { claimed: 0, sent: 0 };
  const subs = await sql.all(
    'SELECT id, employee_id, endpoint, p256dh, auth FROM push_subscriptions WHERE employee_id = ANY(:ids::text[])',
    { ids: [...new Set(rows.map((r) => r.employee_id))] },
  );
  let sent = 0;
  for (const r of rows) {
    const mine = subs.filter((s) => s.employee_id === r.employee_id);
    if (mine.length) sent += await sendToSubs(mine, describe(r));
  }
  return { claimed: rows.length, sent };
}

/** ปุ่ม "ทดสอบ" ในหน้าตั้งค่า — ส่งเฉพาะเครื่องที่กด */
export async function sendTest(employeeId, endpoint) {
  if (!pushReady()) return 0;
  await ensurePushTables();
  const subs = await sql.all(
    'SELECT id, employee_id, endpoint, p256dh, auth FROM push_subscriptions WHERE employee_id = :employeeId AND endpoint = :endpoint',
    { employeeId, endpoint },
  );
  return sendToSubs(subs, { title: 'ทดสอบแจ้งเตือน', body: 'เครื่องนี้รับแจ้งเตือนกะงานจาก KIN Homecare ได้แล้ว', url: '/my-today', tag: 'kin-test' });
}

/* ---------- ส่งท้ายคำขอ ---------- */

const requestStore = new AsyncLocalStorage();

/** staffInbox.push เรียก — คำขอนี้มีแจ้งเตือนใหม่ ให้ส่งก่อนตอบกลับ */
export function markPushPending() {
  const store = requestStore.getStore();
  if (store) store.pending = true;
}

/**
 * middleware ของคำขอที่แก้ข้อมูล — ถ้าระหว่างคำขอมีแจ้งเตือนใหม่ ส่ง push ก่อนตอบกลับ
 * ต้องส่งก่อนตอบ: บน Vercel พอตอบไปแล้ว function อาจถูกแช่แข็ง งานที่ค้างไว้ไม่ได้ทำ
 * ส่งพังไม่ทำให้คำขอพัง — แถวที่ claim แล้วยังอยู่ในกระดิ่งตามเดิม
 */
export function pushAfterRequest(req, res, next) {
  if (req.method === 'GET' || !pushReady()) return next();
  const store = { pending: false };
  const json = res.json.bind(res);
  res.json = (body) => {
    if (!store.pending || res.statusCode >= 400) return json(body);
    store.pending = false;
    flushPending()
      .catch((err) => console.error('[web-push] flush:', err?.message ?? err))
      .finally(() => json(body));
    return res;
  };
  return requestStore.run(store, next);
}
