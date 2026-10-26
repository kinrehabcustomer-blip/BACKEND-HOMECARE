import { createHash, randomBytes } from 'node:crypto';
import { sql, transaction } from '../db/index.js';
import { ensureCustomerLineColumns } from '../lib/customerLine.js';

/**
 * ส่งใบแจ้งหนี้/ใบเสร็จเข้า LINE ลูกค้าจากระบบงาน (ดร.ธงชัย 24 ต.ค. 2569 รวมหน้าหลังบ้าน ข้อ 4)
 *
 *   1. ทีมการเงินกด "ส่งเข้า LINE ลูกค้า" ในใบ (POST /api/invoices/:id/send-line)
 *      → ออกลิงก์ดูเอกสารแบบไม่ต้องล็อกอิน (/bill/<token> อายุ 90 วัน · เก็บแค่ hash ของ token)
 *      → ใส่คิว invoice_line_outbox
 *   2. ระบบแชท chat.kinorigin.com (cron ทุก 3 นาที) ดึงคิวผ่าน /api/integration/invoices/line-outbox
 *      ส่งออก OA Kin HomeCare ห้องเดียวกับที่ลูกค้าคุยอยู่ + บันทึกลงห้องแชทใน admin แล้วแจ้งผลกลับ
 *   ระบบงานไม่ถือโทเคน LINE — ข้อความออกจากระบบแชทเท่านั้น (แบบเดียวกับแชทเคสญาติ)
 */
export const SHARE_DAYS = 90;
export const PUBLIC_ORIGIN = process.env.PUBLIC_APP_URL || 'https://staff.kinorigin.com';
export const hashToken = (t) => createHash('sha256').update(`kin-bill:${t}`).digest('hex');

let ready = null;
export const ensureShareTables = () =>
  (ready ??= (async () => {
    await sql.run(`CREATE TABLE IF NOT EXISTS invoice_shares (
      token_hash  TEXT PRIMARY KEY,
      invoice_id  TEXT NOT NULL REFERENCES invoices (invoice_id) ON DELETE CASCADE ON UPDATE CASCADE,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      opened_at   TIMESTAMPTZ
    )`);
    await sql.run(`CREATE TABLE IF NOT EXISTS invoice_line_outbox (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      invoice_id    TEXT NOT NULL REFERENCES invoices (invoice_id) ON DELETE CASCADE ON UPDATE CASCADE,
      customer_id   TEXT,
      line_user_id  TEXT NOT NULL,
      conversation_id INTEGER,
      payload       JSONB NOT NULL,
      created_by    TEXT,
      created_by_name TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempts      INTEGER NOT NULL DEFAULT 0,
      sent_at       TIMESTAMPTZ,
      error         TEXT
    )`);
    await sql.run(`CREATE INDEX IF NOT EXISTS idx_invoice_line_outbox_pending ON invoice_line_outbox (created_at) WHERE sent_at IS NULL`);
    await sql.run(`CREATE INDEX IF NOT EXISTS idx_invoice_line_outbox_invoice ON invoice_line_outbox (invoice_id, created_at DESC)`);
    // จองแถวตอนดึงคิว — ส่ง LINE แล้วแต่ ack ไม่ถึง (ระบบงาน deploy/timeout) หรือ cron ทับกัน = ไม่ส่งซ้ำทุก 3 นาที
    await sql.run(`ALTER TABLE invoice_line_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
  })().catch((err) => {
    ready = null;
    throw err;
  }));

/** ใบนี้ส่งเข้า LINE ได้ไหม + ไปหาใคร → { ok, reason?, customer } */
export async function lineTarget(invoice) {
  await ensureCustomerLineColumns();
  if (!['issued', 'paid'].includes(invoice.status)) return { ok: false, reason: 'ส่งได้เฉพาะใบที่ออกแล้วหรือชำระแล้ว (ใบร่าง/ยกเลิกส่งไม่ได้)' };
  if (!invoice.customer_id) return { ok: false, reason: 'ใบนี้ยังไม่ผูกลูกค้า' };
  const customer = await sql.one(
    `SELECT customer_id, name, line_user_id, chat_conversation_id FROM customers WHERE customer_id = :id`,
    { id: invoice.customer_id },
  );
  if (!customer?.line_user_id) {
    return { ok: false, reason: 'ลูกค้ารายนี้ยังไม่ได้เชื่อม LINE Kin HomeCare — ให้แอดมินกด "ส่งเข้าระบบงาน" ในห้องแชทของลูกค้าก่อน' };
  }
  return { ok: true, customer };
}

/** ออกลิงก์ + ใส่คิวส่ง · ใบเดิมที่ยังรอส่งอยู่ = ไม่ใส่ซ้ำ → { url, queued, pending_id } */
export async function queueLineSend(invoice, customer, user) {
  await ensureShareTables();
  return transaction(async (tx) => queueLineSendTx(tx, invoice, customer, user));
}

async function queueLineSendTx(sql, invoice, customer, user) {
  // ล็อกแถวใบ — 2 คนกดส่งพร้อมกัน = เข้าคิวครั้งเดียว
  await sql.one(`SELECT invoice_id FROM invoices WHERE invoice_id = :id FOR UPDATE`, { id: invoice.invoice_id });
  const pending = await sql.one(
    `SELECT id FROM invoice_line_outbox WHERE invoice_id = :id AND sent_at IS NULL AND attempts < 3 AND created_at > now() - interval '1 day'`,
    { id: invoice.invoice_id },
  );
  if (pending) return { queued: false, already: true, pending_id: pending.id };

  const token = randomBytes(24).toString('base64url');
  await sql.run(
    `INSERT INTO invoice_shares (token_hash, invoice_id, created_by, expires_at)
     VALUES (:h, :id, :by, now() + make_interval(days => :days))`,
    { h: hashToken(token), id: invoice.invoice_id, by: user?.employee_id ?? null, days: SHARE_DAYS },
  );
  const url = `${PUBLIC_ORIGIN}/bill/${token}`;
  const isReceipt = invoice.status === 'paid';
  const payload = {
    kind: isReceipt ? 'receipt' : 'invoice',
    invoice_id: invoice.invoice_id,
    patient_name: invoice.patient_name ?? null,
    total: Number(invoice.total),
    paid: Number(invoice.paid_amount ?? 0),
    balance: Number(invoice.balance ?? 0),
    due_date: invoice.due_date ?? null,
    issue_date: invoice.issue_date,
    url,
  };
  const row = await sql.one(
    `INSERT INTO invoice_line_outbox (invoice_id, customer_id, line_user_id, conversation_id, payload, created_by, created_by_name)
     VALUES (:id, :cid, :uid, :conv, :payload::jsonb, :by, :byName) RETURNING id`,
    {
      id: invoice.invoice_id, cid: customer.customer_id, uid: customer.line_user_id, conv: customer.chat_conversation_id ?? null,
      payload: JSON.stringify(payload), by: user?.employee_id ?? null,
      byName: [user?.first_name, user?.last_name].filter(Boolean).join(' ') || null,
    },
  );
  return { queued: true, pending_id: row.id, url };
}

/** ประวัติการส่งของใบ (โชว์ในใบ) */
export async function sendHistory(invoiceId) {
  await ensureShareTables();
  return sql.all(
    `SELECT id, created_by_name, created_at, sent_at, error, attempts FROM invoice_line_outbox
     WHERE invoice_id = :id ORDER BY created_at DESC LIMIT 5`,
    { id: invoiceId },
  );
}

/** ลิงก์ลูกค้า → รหัสใบ (หมดอายุ/ไม่มี = null) · จดเวลาเปิดครั้งแรก */
export async function invoiceIdForToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  await ensureShareTables();
  const row = await sql.one(
    `UPDATE invoice_shares SET opened_at = COALESCE(opened_at, now())
     WHERE token_hash = :h AND expires_at > now() RETURNING invoice_id`,
    { h: hashToken(token) },
  );
  return row?.invoice_id ?? null;
}

/** ข้อมูลเท่าที่ตัวเอกสารของลูกค้าใช้ (CustomerInvoiceDoc) — ไม่ส่งสลิป เคส ราคาเคส หรือข้อมูลภายใน */
export function publicInvoice(inv) {
  return {
    invoice_id: inv.invoice_id, status: inv.status, issue_date: inv.issue_date, due_date: inv.due_date, paid_at: inv.paid_at,
    patient_id: inv.patient_id ?? null, patient_name: inv.patient_name ?? null,
    bill_to_name: inv.bill_to_name, bill_to_tax_id: inv.bill_to_tax_id ?? null,
    service_description: inv.service_description, items: inv.items ?? [], addons: inv.addons ?? [],
    amount: inv.amount, discount: inv.discount, total: inv.total,
    paid_amount: inv.paid_amount ?? 0, balance: inv.balance ?? 0,
    payment_method: inv.payment_method ?? null,
    payments: (inv.payments ?? []).map((p) => ({ amount: p.amount, method: p.method, paid_at: p.paid_at })),
    note: inv.note ?? null,
    signer: (inv.status === 'paid' ? inv.paid_by_name : null) || inv.issued_by_name || '',
  };
}

/** คิวที่รอส่ง (ให้ระบบแชทดึง) + รับผลส่งกลับ */
export async function outboxPending(limit = 20) {
  await ensureShareTables();
  // ใบที่ถูกยกเลิกหลังกดส่ง = ไม่ส่ง (ลูกค้าจะได้ยอดผิด + ลิงก์ 404)
  await sql.run(
    `UPDATE invoice_line_outbox o SET error = 'ใบถูกยกเลิกก่อนส่ง', attempts = 3
     FROM invoices i
     WHERE i.invoice_id = o.invoice_id AND i.status = 'cancelled' AND o.sent_at IS NULL AND o.attempts < 3`,
  );
  // จองแถว (claimed_at + attempts) ก่อนส่งให้ระบบแชท — ack หาย/ cron ทับกัน = ไม่ส่งซ้ำ
  // หยิบใหม่เฉพาะแถวที่ไม่เคยจอง หรือระบบแชทแจ้งว่าส่งไม่สำเร็จ (ล้างจองแล้ว) · จองค้างโดยไม่มีผล = อาจถึงลูกค้าแล้ว ไม่ส่งซ้ำ
  return sql.all(
    `UPDATE invoice_line_outbox o SET claimed_at = now(), attempts = attempts + 1
     WHERE o.id IN (
       SELECT id FROM invoice_line_outbox
       WHERE sent_at IS NULL AND attempts < 3 AND created_at > now() - interval '1 day'
         AND claimed_at IS NULL
       ORDER BY id LIMIT :n FOR UPDATE SKIP LOCKED)
     RETURNING o.id, o.invoice_id, o.line_user_id, o.conversation_id, o.payload, o.created_by_name`,
    { n: limit },
  );
}

export async function outboxAck(results) {
  await ensureShareTables();
  let n = 0;
  for (const r of results.slice(0, 50)) {
    const id = Number(r?.id);
    if (!Number.isInteger(id)) continue;
    n += await sql.run(
      r.ok
        ? `UPDATE invoice_line_outbox SET sent_at = now(), error = NULL WHERE id = :id AND sent_at IS NULL`
        // ล้มเหลว = ปล่อยจองให้รอบหน้าลองใหม่ได้ทันที (attempts นับไปแล้วตอนจอง)
        : `UPDATE invoice_line_outbox SET error = :err, claimed_at = NULL WHERE id = :id AND sent_at IS NULL`,
      { id, err: String(r.error || 'ส่งไม่สำเร็จ').slice(0, 300) },
    );
  }
  return n;
}
