import { sql } from '../db/index.js';
import * as customers from '../customers/repo.js';

/**
 * ลูกค้าที่ทักสอบถามทาง LINE OA Kin HomeCare (แชทอยู่ที่ chat.kinorigin.com) ↔ ลูกค้าในระบบงานนี้
 * ดร.ธงชัย 22 ต.ค. 2569 · แบบร่าง coordination/homecare-chat-to-staff-customer-design-20261022.md
 *   - ทีมกด "ส่งเข้าระบบงาน" ในหน้าแชท → หาด้วยเบอร์ก่อน เจอ = ผูกคนเดิม · ไม่เจอ = สร้างลูกค้าใหม่
 *   - ของเก่า: ระบบเสนอคู่ที่เบอร์ตรงกัน ให้ทีมกดยืนยันทีละคู่ (ไม่ผูกเอง)
 * ข้อความแชทไม่ถูกคัดลอกมา — เก็บแค่ LINE userId · ชื่อ LINE · รหัสแชท (ไว้ทำลิงก์เปิดแชท) · บริการที่สนใจ
 */
let ready = null;
export const ensureCustomerLineColumns = () =>
  (ready ??= ['line_user_id TEXT', 'line_display_name TEXT', 'chat_conversation_id INTEGER', 'chat_first_at TEXT', 'chat_interest TEXT']
    .reduce((p, col) => p.then(() => sql.run(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ${col}`)), Promise.resolve())
    .catch((err) => {
      ready = null;
      throw err;
    }));

export const digits = (s) => String(s ?? '').replace(/\D/g, '');
// เทียบ 9 หลักท้าย — 081-234-5678 · +66 81 234 5678 · 66812345678 เป็นเบอร์เดียวกัน
export const phoneKey = (s) => digits(s).slice(-9);

/**
 * ลูกค้าที่เบอร์ตรง (เทียบเฉพาะตัวเลข · ≥9 หลัก) — ใช้ทั้งตอนส่งเข้าระบบและตอนเสนอคู่ของเก่า
 * เบอร์ญาติในระบบนี้อยู่ 3 ที่: ลูกค้า (customers.phone) · เคส (cases.client_phone = เบอร์ติดต่อญาติ)
 * · ผู้รับบริการ (patients.emergency_contact_phone) — ค้นครบทั้ง 3 แล้วคืนเป็นลูกค้า (ผู้ว่าจ้าง) ที่ผูกอยู่
 * เคส/ผู้รับบริการที่ยังไม่ได้ผูกลูกค้า ข้ามไป (ไม่มีลูกค้าให้ผูก LINE) · source บอกว่าเจอจากที่ไหน
 */
export async function findByPhones(phones) {
  const list = [...new Set(phones.map(digits).filter((p) => p.length >= 9).map(phoneKey))];
  if (!list.length) return [];
  const d = (col) => `right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 9)`;
  return sql.all(
    `SELECT DISTINCT ON (m.phone_digits, cu.customer_id)
            cu.customer_id, cu.name, cu.phone, cu.line_user_id, m.phone_digits, m.source
     FROM (
       SELECT customer_id, ${d('phone')} AS phone_digits, 'ลูกค้า' AS source FROM customers
       UNION ALL
       SELECT customer_id, ${d('client_phone')}, 'เคส ' || regexp_replace(case_id, '-R[0-9]+$', '') FROM cases WHERE customer_id IS NOT NULL
       UNION ALL
       SELECT customer_id, ${d('emergency_contact_phone')}, 'ผู้รับบริการ ' || patient_id FROM patients WHERE customer_id IS NOT NULL
     ) m
     JOIN customers cu ON cu.customer_id = m.customer_id
     WHERE m.phone_digits = ANY(:phones::text[])
     ORDER BY m.phone_digits, cu.customer_id, m.source`,
    { phones: list },
  );
}

/**
 * ผูก/สร้างลูกค้าจากแชท · customerId = ทีมยืนยันคู่แล้ว (ข้ามการค้นด้วยเบอร์)
 * คืน { customer_id, name, created } หรือ { conflict } เมื่อลูกค้าคนนั้นผูก LINE คนอื่นไว้แล้ว
 */
export async function linkFromChat(d, customerId = null) {
  await ensureCustomerLineColumns();
  let customer = customerId ? await customers.findById(customerId) : (await findByPhones([d.phone]))[0] ?? null;
  if (customerId && !customer) return { error: 'not_found' };
  let created = false;
  if (!customer) {
    customer = await customers.create({
      /* ตัดความยาวที่นี่เป็น "กันของเสีย" ไม่ใช่ข้อความที่คนพิมพ์มาเพื่อให้ถึงปลายทาง (ตรวจรอบ 19)
         ชื่อโปรไฟล์ LINE ยาวไม่เกิน 20 ตัว · referral/note ฝั่งแชทประกอบเอง ไม่ใช่สิ่งที่ลูกค้าพิมพ์
         ต่างจากข้อความในไทม์ไลน์เคสที่เปลี่ยนเป็น "ตีกลับพร้อมบอกจำนวนตัวที่เกิน" แล้ว (lib/family.js) */
      name: String(d.name || d.line_name || 'ลูกค้า LINE').slice(0, 200),
      phone: d.phone ? String(d.phone).slice(0, 30) : null,
      referral_source: String(d.referral || 'LINE Kin HomeCare').slice(0, 200),
      note: d.note ? String(d.note).slice(0, 1000) : null,
    });
    created = true;
  }
  if (customer.line_user_id && d.line_user_id && customer.line_user_id !== d.line_user_id) {
    return { conflict: true, customer_id: customer.customer_id, name: customer.name };
  }
  await sql.run(
    `UPDATE customers SET line_user_id = coalesce(:uid, line_user_id), line_display_name = coalesce(:lname, line_display_name),
            chat_conversation_id = :conv, chat_first_at = coalesce(chat_first_at, :first), chat_interest = coalesce(:interest, chat_interest)
     WHERE customer_id = :id`,
    {
      uid: d.line_user_id || null, lname: d.line_name || null, conv: d.conversation_id ?? null,
      first: d.first_at || null, interest: d.interest || null, id: customer.customer_id,
    },
  );
  return { customer_id: customer.customer_id, name: customer.name, created };
}

/** LINE ของลูกค้าเจ้าของเคส — กล่อง "ช่องทางติดต่อ LINE" ในหน้าเคส */
export async function lineForCase(caseId) {
  await ensureCustomerLineColumns();
  return sql.one(
    `SELECT cu.customer_id, cu.name, cu.line_user_id IS NOT NULL AS has_line, cu.line_display_name,
            cu.chat_conversation_id, cu.chat_first_at, cu.chat_interest
     FROM cases c JOIN customers cu ON cu.customer_id = c.customer_id
     WHERE c.case_id = :id`,
    { id: caseId },
  );
}
