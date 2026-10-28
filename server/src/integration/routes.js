import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { ensureLineColumn, ensureLinkCodeTables, hashLinkCode, isLineUserId, LINK_CODE_TTL_HOURS, verifySigned, onceByTicket } from '../lib/lineBridge.js';
import { randomInt } from 'node:crypto';
import { FRONT_POSITIONS } from '../employees/schema.js';
import { linkLineByCode } from '../lib/lineLinkCode.js';
import { outboxAck, outboxPending } from '../invoices/share.js';
import * as invoiceRepo from '../invoices/repo.js';
import { caseRatings, dueRatings, employeeStars, submitRating } from '../lib/ratings.js';
import { employeeTier } from '../lib/tiers.js';
import { createEmployeeSchema, decodeImage } from '../employees/schema.js';
import * as repo from '../employees/repo.js';
import * as cases from '../cases/repo.js';
import { BLOCKED_STATUSES } from '../lib/auth.js';
import * as family from '../lib/family.js';
import { claimDueVisitReminders, claimDueFamilyReminders, claimVisitChanges } from '../notify/visitReminders.js';
import { ensureCustomerLineColumns as ensureCustomerLineColumnsSafe, findByPhones, linkFromChat } from '../lib/customerLine.js';

/**
 * ทางเข้าจากระบบสมัครงาน chat.kinorigin.com (ดร.ธงชัย 22 ต.ค. 2569 "ได้งาน → สร้างพนักงานใน staff ในคลิกเดียว")
 *
 * ไม่ใช้คุกกี้ — คำขอทุกใบลงลายเซ็น Ed25519 จากฝั่ง chat (purpose 'kin-hire' อายุ 5 นาที · ดู lib/lineBridge.js)
 * ฝั่ง chat ยิงหลังแอดมินที่ล็อกอินแล้วกดปุ่มที่ใบสมัคร จึงไม่มีคนนอกเรียกเส้นนี้ได้โดยไม่มีกุญแจลับ
 *
 * กันซ้ำ: LINE นี้ผูกกับพนักงานอยู่แล้ว = คืนคนเดิม (กดซ้ำได้ไม่เกิดคนซ้อน)
 *         เบอร์โทรตรงกับพนักงานที่มีอยู่ = ไม่สร้าง ตอบ 409 พร้อมรหัสคนนั้น ให้ทีมตัดสินเอง
 *         (ไม่ผูก LINE ให้คนเดิมเองจากเบอร์ — ผูกผิดคน = เข้าบัญชีคนอื่นได้)
 * รหัสผ่านชั่วคราวไม่ส่งกลับ — ฝ่ายบุคคลดูได้ที่หน้าพนักงานตามเดิม เจ้าตัวเข้าจาก LINE ได้เลยเพราะผูกให้แล้ว
 */
export const integrationRouter = Router();

/* สถานะที่ใช้ระบบไม่ได้ ในรูปที่เอาไปต่อท้าย NOT IN (...) ของ SQL ได้ — มาจากค่าคงที่ตัวเดียวกับที่ middleware ใช้
   (lib/auth.js) จะได้ไม่มีวันหลุดจากกัน · ค่าเป็นคำที่เราเขียนเองทั้งหมด ไม่ได้มาจากผู้ใช้ */
const BLOCKED_SQL = Object.keys(BLOCKED_STATUSES)
  .map((s) => `'${s}'`)
  .join(', ');

const hireSchema = z.object({ token: z.string().min(1) });

/** รับเฉพาะรูปที่ระบบแชทเพิ่งเก็บใน Vercel Blob — ปิดทาง SSRF ไป host ภายใน/URL อื่น */
async function fetchChatImage(url, maxBytes = 8 * 1024 * 1024) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new ApiError(400, 'ที่อยู่รูปไม่ถูกต้อง'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.public.blob.vercel-storage.com')) {
    throw new ApiError(400, 'รับรูปได้เฉพาะคลังรูปของระบบแชท');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`image ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new ApiError(413, 'รูปมีขนาดเกิน 8 MB');
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > maxBytes) throw new ApiError(413, 'รูปมีขนาดเกิน 8 MB');
    const mime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const jpg = mime === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const png = mime === 'image/png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = mime === 'image/webp' && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!jpg && !png && !webp) throw new ApiError(400, 'รูปต้องเป็น JPG, PNG หรือ WEBP');
    return { data, mime, size: data.length };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'ดึงรูปจากระบบแชทไม่สำเร็จ');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ผูก LINE ด้วยรหัส 6 หลักที่แอดมินออกในหน้าพนักงาน (ดร.ธงชัย 23 ต.ค. 2569 · ดู lib/lineBridge.js)
 * ตั๋ว 'kin-line-code' {u: LINE userId, c: รหัส} ยิงจาก webhook @kinjobs ตอนพนักงานพิมพ์รหัส
 * → { linked: true, name } · รหัสผิด/หมดอายุ 400 · ลองผิดเกิน 5 ครั้ง/ชม. 429 · LINE ผูกคนอื่นอยู่ 409
 */
integrationRouter.post(
  '/line-code',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-line-code');
    if (!p || !isLineUserId(p.u) || !/^\d{6}$/.test(String(p.c ?? ''))) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const emp = await linkLineByCode(p.u, p.c);
    res.json({ linked: true, employee_id: emp.employee_id, name: emp.first_name });
  }),
);

/**
 * สรุปงานของฉันให้หน้า "งานของฉัน" ใน LINE (chat.kinorigin.com/me) — ตั๋ว purpose 'kin-my' อายุ 1 นาที ยิงจากเซิร์ฟเวอร์ chat
 * ส่งแค่ที่จำเป็นต่อการเห็นภาพรวม: วันที่ เวลา รหัสเคส ชนิดบริการ สถานะกะ · ไม่ส่งชื่อ/ที่อยู่/เบอร์ผู้ป่วย และไม่ส่งยอดเงิน
 * เพราะลิงก์หน้า /me ส่งต่อกันได้ — รายละเอียดเต็มดูในระบบงานนี้ (เข้าด้วยตั๋ว LINE อายุสั้น + ผูกด้วยรหัสผ่าน)
 */
const thDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3.6e6 + offsetDays * 864e5).toISOString().slice(0, 10);
const shiftBrief = (v) => ({
  case_id: v.case_id,
  date: v.visit_date,
  start: v.planned_start,
  end: v.planned_end,
  state: v.state,
  service: v.physio_package_name || v.format_name || null,
  reports: v.report_count,
});

/**
 * รายงานเยี่ยมที่พนักงานพิมพ์ในแชท LINE OA สมัครงาน/PTOT ("รายงาน ..." · ดร. 22 ต.ค. 2569 ข้อ 5)
 * ตั๋ว 'kin-report' ยิงจาก webhook ฝั่ง chat — ข้อความมาจาก LINE ของเจ้าตัวจริง (LINE ลงลายเซ็น webhook)
 * ลงรายงานเข้ากะของวันนี้ของคนนั้นเท่านั้น (เกณฑ์เดียวกับ POST /my/visits/:id/reports) ข้อความทั้งก้อนลงช่อง "บันทึก"
 * วันนี้มีหลายกะ = ใช้กะที่กำลังทำงานอยู่ · ยังเลือกไม่ได้ = ส่งรายการรหัสเคสกลับไปให้พิมพ์ระบุ
 */
integrationRouter.post(
  '/report',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-report');
    /* ยาวเกินให้ตีกลับ ไม่ใช่ตัดทิ้งเงียบ ๆ (ตรวจรอบ 19 — เดิม slice(0, 2000) แล้วบันทึกต่อ)
       พนักงานพิมพ์รายงานยาวใน LINE แล้วท้ายข้อความหาย โดยฝั่งแชทได้ ok กลับไป */
    if (typeof p?.text === 'string' && p.text.trim().length > 2000) {
      throw new ApiError(400, `รายงานยาว ${p.text.trim().length.toLocaleString('th-TH')} ตัวอักษร เกินที่บันทึกได้ 2,000 ตัว — แบ่งส่งเป็นสองใบได้ค่ะ`);
    }
    if (!p || !isLineUserId(p.u) || typeof p.text !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();

    const emp = await sql.one(
      `SELECT employee_id, first_name, last_name, status FROM employees WHERE line_user_id = :uid`,
      { uid: p.u },
    );
    if (!emp || BLOCKED_STATUSES[emp.status]) return res.json({ linked: false });

    const usable = (rows) => rows.filter((v) => v.state !== 'cancelled' && !['closed', 'cancelled'].includes(v.case_status));
    let all = usable(await cases.visitsForWorkerOn(emp.employee_id, thDate(0)));
    /* เวรดึกพิมพ์รายงานหลังเที่ยงคืน = วันที่เปลี่ยนไปแล้ว แต่กะยังเป็นของ "เมื่อวาน" (visit_date ของวันที่เริ่มกะ)
       เดิมหาแค่กะของวันนี้ จึงตอบ "วันนี้ไม่พบกะของคุณ" แล้วรายงานหายไปทั้งใบ ญาติไม่ได้รับอะไรเลย
       ถอยไปดูเมื่อวานเฉพาะกะที่ยังค้างอยู่จริง: ยังไม่เช็คเอาต์ และ (เช็คอินแล้ว หรือเป็นกะข้ามคืนตามแผน
       คือเวลาจบ ≤ เวลาเริ่ม เช่น 20:00–08:00) — กะเมื่อวานที่จบไปแล้วไม่ถูกดึงกลับมารับรายงานย้อนหลัง */
    if (!all.length) {
      all = usable(await cases.visitsForWorkerOn(emp.employee_id, thDate(-1))).filter(
        (v) => !v.check_out_at && (v.check_in_at || (v.planned_start && v.planned_end && v.planned_end <= v.planned_start)),
      );
    }
    const wanted = p.case_id ? all.filter((v) => v.case_id === p.case_id) : all;
    const working = wanted.filter((v) => v.state === 'working');
    const visit = wanted.length === 1 ? wanted[0] : working.length === 1 ? working[0] : null;
    if (!visit) {
      return res.json({ linked: true, saved: false, choices: [...new Set(all.map((v) => v.case_id))] });
    }

    /* ยิงซ้ำด้วยตั๋วใบเดิมต้องไม่ได้รายงานสองใบ — คืนคำตอบของครั้งแรก (ดู onceByTicket) */
    const out = await onceByTicket(token, 'kin-report', async () => {
      const report = await cases.addReport(
        visit.case_id,
        { visit_id: visit.visit_id, report_type: 'routine', note: p.text.trim() },
        { employee_id: emp.employee_id, name: `${emp.first_name} ${emp.last_name} (LINE)` },
      );
      /* ข้อ 4 (ดร.ธงชัย 23 ต.ค. 2569 "รายงานของผู้ดูแลเด้งเข้า LINE ญาติ"): ส่งรายชื่อ LINE ญาติที่ผูกเคสนี้แล้ว (ยังไม่ถูกปลด)
         กลับไปให้ฝั่ง chat ส่งสรุปเข้า OA KIN HomeCare — ที่นี่ไม่ยิง LINE เอง (โทเคน OA อยู่ฝั่ง chat ที่เดียว)
         ส่งแค่ชื่อต้นของผู้ดูแล (ไม่ส่งนามสกุล/เบอร์) ตามหลักเดียวกับหน้า /family */
      await family.ensureFamilyTable();
      const relatives = await sql.all(
        `SELECT DISTINCT line_user_id FROM case_family_links
         WHERE case_id = :id AND accepted_at IS NOT NULL AND revoked_at IS NULL AND line_user_id IS NOT NULL`,
        { id: visit.case_id },
      );
        return { status: 201, body: {
        linked: true, saved: true, case_id: visit.case_id, report_id: report.report_id,
        family_line_ids: relatives.map((r) => r.line_user_id), caregiver_first_name: emp.first_name,
      } };
    });
    res.status(out.status).json(out.body);
  }),
);

/**
 * ญาติดูการดูแลผ่าน LINE OA KIN HomeCare หลัก (ข้อ 6 · ดูหัวไฟล์ lib/family.js)
 *   /family/accept  ตั๋ว 'kin-family-join' {u, code, name} — ญาติส่ง "ญาติ <รหัส>" ในแชท OA
 *   /family/summary ตั๋ว 'kin-family' {u} — หน้า /family ฝั่ง chat
 */
integrationRouter.post(
  '/family/accept',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-family-join');
    if (!p || !isLineUserId(p.u) || typeof p.code !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    res.json(await family.accept(p.code, p.u, p.name));
  }),
);

integrationRouter.post(
  '/family/summary',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-family');
    if (!p || !isLineUserId(p.u)) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    res.json({ cases: await family.summaryFor(p.u) });
  }),
);

/** ญาติคนแรกชวนญาติอีกคน (แบบ ข · ≤5 คนต่อเคส) — ตั๋ว 'kin-family-invite' {u, case_id} */
integrationRouter.post(
  '/family/invite',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-family-invite');
    if (!p || !isLineUserId(p.u) || typeof p.case_id !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    // ยิงตั๋วใบเดิมซ้ำต้องไม่ได้รหัสเชิญสองใบ (กินเพดาน 5 คนไปสองที่) — ดู onceByTicket
    const out = await onceByTicket(token, 'kin-family-invite', async () => ({
      status: 200, body: await family.familyInvite(p.u, p.case_id),
    }));
    res.status(out.status).json(out.body);
  }),
);

/**
 * ญาติโพสต์ลงไทม์ไลน์เคส (แบบ 3) — ตั๋ว 'kin-family-post' {u, case_id, body, photo_sha}
 * รูปส่งมาในตัวคำขอเป็น data URL (ย่อจากเบราว์เซอร์แล้ว) · photo_sha ในตั๋วผูกรูปกับลายเซ็น สลับรูปทีหลังไม่ได้
 */
const postSchema = z.object({ token: z.string().min(1), image: z.string().optional().nullable() });

integrationRouter.post(
  '/family/post',
  asyncRoute(async (req, res) => {
    const { token, image } = postSchema.parse(req.body);
    const p = verifySigned(token, 'kin-family-post');
    if (!p || !isLineUserId(p.u) || typeof p.case_id !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    const me = await family.memberLink(p.u, p.case_id);
    if (!me) throw new ApiError(403, 'ไม่ได้เป็นญาติที่ได้รับเชิญของเคสนี้');

    let photo = null;
    if (image) {
      if (createHash('sha256').update(image).digest('hex') !== p.photo_sha) throw new ApiError(400, 'รูปไม่ตรงกับลายเซ็น');
      try {
        photo = decodeImage(image);
      } catch (err) {
        throw new ApiError(400, err.message);
      }
    }
    const body = typeof p.body === 'string' ? p.body.trim() : '';
    if (!body && !photo) throw new ApiError(400, 'ไม่มีข้อความหรือรูป');
    // ยิงซ้ำด้วยตั๋วใบเดิมต้องไม่ได้ข้อความสองอัน — คืนคำตอบของครั้งแรก
    const out = await onceByTicket(token, 'kin-family-post', async () => {
      const row = await family.postMessage(p.case_id, {
        kind: 'family', name: me.display_name || 'ญาติ', lineUserId: p.u, body, photo,
      });
      return { status: 201, body: { ok: true, message_id: row.message_id, name: me.display_name || 'ญาติ' } };
    });
    res.status(out.status).json(out.body);
  }),
);

/** รูปในไทม์ไลน์ให้หน้าญาติ — ตั๋ว 'kin-family-photo' {u, case_id, message_id} (ตรวจว่าเป็นญาติของเคสนั้น) */
integrationRouter.post(
  '/family/photo',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-family-photo');
    if (!p || !isLineUserId(p.u) || typeof p.case_id !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    if (!(await family.memberLink(p.u, p.case_id))) throw new ApiError(403, 'ไม่มีสิทธิ์');
    const row = await family.messagePhoto(p.case_id, Number(p.message_id));
    if (!row) throw new ApiError(404, 'ไม่พบรูป');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(row.data);
  }),
);

/**
 * แชทลูกค้า LINE Kin HomeCare → ลูกค้าในระบบงาน (lib/customerLine.js)
 *   /customers/link  ตั๋ว 'kin-cust-link' {d: {line_user_id, line_name, name, phone, note, referral, interest, first_at, conversation_id}, customer_id?}
 *   /customers/match ตั๋ว 'kin-cust-match' {phones: [...]} → ลูกค้าที่เบอร์ตรง (ไว้เสนอคู่ให้ทีมยืนยัน)
 */
integrationRouter.post(
  '/customers/link',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-cust-link');
    if (!p?.d) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    if (p.d.line_user_id && !isLineUserId(p.d.line_user_id)) throw new ApiError(400, 'LINE userId ไม่ถูกต้อง');
    const r = await linkFromChat(p.d, typeof p.customer_id === 'string' ? p.customer_id : null);
    if (r.error) throw new ApiError(404, 'ไม่พบลูกค้ารายนี้ในระบบงาน');
    if (r.conflict) return res.status(409).json({ error: `ลูกค้า ${r.customer_id} ${r.name} ผูก LINE คนอื่นไว้แล้ว`, ...r });
    res.json(r);
  }),
);

integrationRouter.post(
  '/customers/match',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-cust-match');
    if (!p || !Array.isArray(p.phones)) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureCustomerLineColumnsSafe();
    /* รับเฉพาะเบอร์ที่เป็นข้อความจริง (ตรวจรอบ 19) — เดิมส่ง object ปนมาในอาร์เรย์ได้
       แล้วไหลลงไปถึงชั้นคิวรีเป็น [object Object] ซึ่งไม่มีวันตรงกับใคร แต่ก็ไม่มีอะไรฟ้องว่าข้อมูลเพี้ยน */
    if (!p.phones.every((x) => typeof x === 'string')) {
      throw new ApiError(400, 'phones ต้องเป็นรายการข้อความเบอร์โทรเท่านั้น');
    }
    const phones = p.phones.filter((x) => x.trim()).slice(0, 500);
    res.json({ matches: await findByPhones(phones) });
  }),
);

integrationRouter.post(
  '/my-summary',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-my');
    if (!p || !isLineUserId(p.u)) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();

    const emp = await sql.one(
      `SELECT employee_id, first_name, last_name, position, status FROM employees WHERE line_user_id = :uid`,
      { uid: p.u },
    );
    if (!emp || BLOCKED_STATUSES[emp.status]) return res.json({ linked: false });

    const [today, tomorrow, slip] = await Promise.all([
      cases.visitsForEmployeeOn(emp.employee_id, thDate(0)),
      cases.visitsForEmployeeOn(emp.employee_id, thDate(1)),
      sql.one(
        `SELECT r.period_month, r.round_no, r.pay_date
         FROM payroll_items i JOIN payroll_runs r ON r.run_id = i.run_id
         WHERE i.employee_id = :emp AND r.status = 'paid'
         ORDER BY r.pay_date DESC, r.run_id DESC LIMIT 1`,
        { emp: emp.employee_id },
      ),
    ]);
    res.json({
      linked: true,
      employee: { employee_id: emp.employee_id, name: `${emp.first_name} ${emp.last_name}`, position: emp.position },
      today: today.filter((v) => v.state !== 'cancelled').map(shiftBrief),
      tomorrow: tomorrow.filter((v) => v.state !== 'cancelled').map(shiftBrief),
      last_slip: slip ?? null,
    });
  }),
);


const digits = (s) => String(s ?? '').replace(/\D/g, '');

integrationRouter.post(
  '/hire',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-hire');
    if (!p || !p.d) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();

    /* line_user_id ที่รูปไม่ถูกต้องเคยถูกปัดเป็น null เงียบ ๆ แล้วสร้างพนักงานต่อ (ตรวจรอบ 19)
       คนใหม่เข้าแอปจาก LINE ไม่ได้ และไม่มีใครรู้ว่าทำไม เพราะฝั่งแชทได้ 201 ว่าสำเร็จ
       ส่งมาแล้วต้องถูกรูป ไม่ส่งมาเลยยังสร้างได้ตามเดิม (บางคนสมัครทางอื่น) */
    const rawLine = p.d.line_user_id;
    if (rawLine != null && rawLine !== '' && !isLineUserId(rawLine)) {
      throw new ApiError(400, 'line_user_id ไม่ถูกรูปแบบ — สร้างพนักงานไม่สำเร็จ');
    }
    const lineUserId = isLineUserId(rawLine) ? rawLine : null;
    if (lineUserId) {
      const linked = await sql.one(
        `SELECT employee_id, first_name || ' ' || last_name AS name FROM employees WHERE line_user_id = :uid`,
        { uid: lineUserId },
      );
      if (linked) return res.json({ employee_id: linked.employee_id, name: linked.name, created: false });
    }

    const input = createEmployeeSchema.parse(p.d.employee);
    const phone = digits(input.phone);
    if (phone.length >= 9) {
      const same = await sql.one(
        `SELECT employee_id, first_name || ' ' || last_name AS name FROM employees
         WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = :phone LIMIT 1`,
        { phone },
      );
      if (same) {
        return res.status(409).json({
          error: `เบอร์นี้มีในระบบแล้ว: ${same.employee_id} ${same.name} — ตรวจว่าเป็นคนเดียวกันไหมก่อน`,
          employee_id: same.employee_id,
          name: same.name,
        });
      }
    }

    // ตำแหน่งหลังบ้าน (ผู้จัดการ/HR/แอดมิน/การเงิน) ห้ามสร้างจากทางนี้ — ใบสมัครเป็นงานภาคสนามเท่านั้น
    if (!['caregiver', 'assistant_nurse', 'practical_nurse', 'nurse', 'therapist', 'occupational_therapist', 'speech_therapist'].includes(input.position)) {
      throw new ApiError(400, 'สร้างได้เฉพาะตำแหน่งภาคสนาม');
    }

    // ผูก LINE ใน INSERT เดียวกัน — ยิงพร้อมกันสองครั้งแล้วเหลือพนักงานใบเดียว ไม่ทิ้งแถวกำพร้า
    const created = await repo.create(input, { lineUserId });
    res.status(201).json({
      employee_id: created.employee_id,
      name: `${created.first_name} ${created.last_name}`,
      created: true,
    });
  }),
);

/**
 * เชื่อมลูกค้า LINE Kin HomeCare ↔ คนดูแลจาก LINE @kinjobs ผ่านเคสในระบบงานนี้ (ดร.ธงชัย 23 ต.ค. 2569 ข้อ 1–2)
 *   ไม่ให้สอง OA คุยกันตรง · ฝั่ง chat ผูกประกาศหาคน (job_posts) เข้ากับรหัสเคสที่นี่ แล้วตอนกด "ได้งาน" ส่งคนเข้าเคส
 *
 *   /customers/cases  ตั๋ว 'kin-cust-cases' {cid} — เคสที่ยังเปิดอยู่ของลูกค้าคนนี้ (ให้แอดมินเลือกตอนลงประกาศ)
 *                     ส่งแค่ รหัส · ชื่อเคส · ชนิด · สถานะ · วันเริ่ม · ชื่อคนดูแล — ไม่ส่งที่อยู่/เบอร์/อาการ
 *   /cases/assign     ตั๋ว 'kin-case-assign' {case_id, employee_id, ref} — เคสยังไม่มีคน = ตั้งเป็นผู้รับผิดชอบหลัก
 *                     (กะที่ลงไว้ตอนยังไม่มีคนตามไปเป็นของคนนี้ · ดู cases.assign) · มีคนหลักแล้ว = เพิ่มเข้าทีม
 *                     ปิด/ยกเลิกแล้ว = 409 ไม่แตะ · ประวัติเคสบันทึกว่ามาจากประกาศรหัสไหน
 */
const CASE_OPEN = ['unassigned', 'assigned', 'in_progress'];

integrationRouter.post(
  '/customers/cases',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-cust-cases');
    if (!p || typeof p.cid !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const rows = await sql.all(
      `SELECT c.case_id, c.title, c.case_type, c.status, c.start_date,
              CASE WHEN e.employee_id IS NULL THEN NULL ELSE e.first_name || ' ' || e.last_name END AS assigned_name
       FROM cases c LEFT JOIN employees e ON e.employee_id = c.assigned_to
       WHERE c.customer_id = :cid AND c.status IN ('unassigned', 'assigned', 'in_progress')
       ORDER BY c.created_at DESC LIMIT 20`,
      { cid: p.cid },
    );
    res.json({ cases: rows });
  }),
);

integrationRouter.post(
  '/cases/assign',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-case-assign');
    if (!p || typeof p.case_id !== 'string' || typeof p.employee_id !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const c = await sql.one('SELECT case_id, status, assigned_to FROM cases WHERE case_id = :id', { id: p.case_id });
    if (!c) throw new ApiError(404, 'ไม่พบเคสนี้ในระบบงาน');
    if (!CASE_OPEN.includes(c.status)) throw new ApiError(409, 'เคสนี้ปิดหรือยกเลิกแล้ว');
    const emp = await sql.one(`SELECT employee_id, status FROM employees WHERE employee_id = :id`, { id: p.employee_id });
    if (!emp || BLOCKED_STATUSES[emp.status]) throw new ApiError(409, 'พนักงานนี้ไม่พร้อมรับงาน');
    const actor = { employee_id: null, name: `ระบบสมัครงาน${p.ref ? ` (ประกาศ ${String(p.ref).slice(0, 20)})` : ''}` };
    if (c.assigned_to === emp.employee_id) return res.json({ case_id: c.case_id, mode: 'already' });
    if (!c.assigned_to) {
      await cases.assign(c.case_id, emp.employee_id, actor);
      return res.json({ case_id: c.case_id, mode: 'assigned' });
    }
    const added = await cases.addTeamMember(c.case_id, emp.employee_id, actor);
    res.json({ case_id: c.case_id, mode: added ? 'team' : 'already' });
  }),
);

/**
 * ข้อ 4 ต่อ (ดร.ธงชัย 23 ต.ค. 2569 ทาง ก "ปุ่มส่งรายงานวันนี้ → ฟอร์มเดิมในระบบงาน"):
 * รายงานอาการที่ผู้ดูแลบันทึกผ่านฟอร์มในระบบงาน → ฝั่ง chat ดึงไปส่งสรุปเข้า LINE OA Kin HomeCare ของญาติ
 *   ตั๋ว 'kin-family-feed' {since} — ฝั่ง chat (cron) ดึงรายงานใหม่กว่า report_id ที่ส่งไปแล้ว · ที่นี่ไม่ยิง LINE เอง
 *   ส่งเฉพาะเคสที่มีญาติผูกแล้ว · ข้ามรายงานที่มาจากแชท LINE ("(LINE)" — ฝั่ง chat ส่งไปแล้วตอนรับรายงาน)
 *   ส่งแค่สัญญาณชีพหลัก + อาการ/การดูแล/อาหาร-ขับถ่ายแบบสั้น + ชื่อต้นผู้บันทึก — ไม่ส่งบันทึกภายใน/ติดตามต่อ/GPS
 */
integrationRouter.post(
  '/family/report-feed',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-family-feed');
    if (!p || !Number.isInteger(p.since) || p.since < 0) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    // ครั้งแรก (since = 0) ไม่ไล่ส่งย้อนหลัง — คืนแค่ตัวชี้ล่าสุดให้ฝั่ง chat เริ่มนับจากตรงนี้
    if (p.since === 0) {
      const last = await sql.one('SELECT COALESCE(MAX(report_id), 0)::int AS id FROM case_reports');
      return res.json({ cursor: last.id, reports: [] });
    }
    const rows = await sql.all(
      `SELECT r.report_id, r.case_id, r.report_date, r.report_time, split_part(COALESCE(c.client_name, ''), ' ', 1) AS client_first,
              r.bp_systolic, r.bp_diastolic, r.pulse, r.respiratory_rate, r.spo2, r.temperature_c, r.blood_sugar,
              left(r.symptoms, 200) AS symptoms, left(r.care_given, 200) AS care_given, left(r.intake_output, 200) AS intake_output,
              -- รายงานกายภาพ (ดร. 23 ต.ค. 2569 "รายงานของนักกายภาพก็ลักษณะเดียวกัน") — ฝั่ง chat จัดข้อความแบบกายภาพเมื่อ is_physio
              (c.service_kind = 'physio' OR c.physio_package_id IS NOT NULL OR c.case_type = 'physiotherapy') AS is_physio,
              r.physio_treatments, r.rehab_minutes, r.assist_level, r.walk_aid, r.walk_distance_m,
              r.pain_score, r.post_pain_score, r.post_bp_systolic, r.post_bp_diastolic, r.post_pulse, r.rehab_after,
              split_part(COALESCE(r.reported_by_name, ''), ' ', 1) AS by_first, r.reported_by,
              /* เคสปิด/ยกเลิกเกินช่วงผ่อนผัน 30 วัน = ไม่มีญาติให้ส่งแล้ว (กติกาเดียวกับหน้า /family · lib/family.js)
                 ตัดที่ "รายชื่อผู้รับ" ไม่ใช่ตัดทั้งแถว เพราะแถวนี้ยังต้องเดินทางไปให้ฝั่ง chat ตรวจค่าผิดปกติ
                 แจ้งทีมพยาบาลอยู่ (เคสไม่มีญาติ = family ว่าง ฝั่ง chat ไม่ส่งหาใคร) และตัวชี้ cursor ต้องเดินต่อ */
              (CASE WHEN ${family.FAMILY_CASE_OPEN} THEN
                (SELECT array_agg(DISTINCT l.line_user_id) FROM case_family_links l
                  WHERE l.case_id = r.case_id AND l.accepted_at IS NOT NULL AND l.revoked_at IS NULL AND l.line_user_id IS NOT NULL)
              END) AS family
       FROM case_reports r JOIN cases c ON c.case_id = r.case_id
       WHERE r.report_id > :since AND COALESCE(r.reported_by_name, '') NOT LIKE '%(LINE)'
       ORDER BY r.report_id LIMIT 50`,
      { since: p.since, grace: family.CLOSED_GRACE_DAYS },
    );
    const cursor = rows.length ? rows[rows.length - 1].report_id : p.since;
    // ดาวสองทาง (25 ต.ค. 2569): ดาวเฉลี่ยของผู้บันทึกจากญาติ แนบไปกับรายงาน (โชว์เมื่อมี ≥3 รีวิว · lib/ratings.js)
    // แจ้งเตือนค่าผิดปกติ (25 ต.ค. 2569 ลูกค้า ข้อ 3): ส่งรายงานทุกเคส ไม่ใช่เฉพาะเคสที่มีญาติผูก — ฝั่ง chat ตรวจค่าแล้วแจ้งทีมพยาบาลได้ทุกเคส
    //   เคสไม่มีญาติ (family ว่าง) ฝั่ง chat ไม่ส่งรายงานถึงใคร ใช้แค่ตรวจค่าผิดปกติ
    const out = rows;
    // ดาวเป็นของประดับ — รายงานใบเดียวดึงดาวไม่ได้ ต้องไม่ทำให้ feed ทั้งก้อนล้ม 500
    // (ฝั่ง chat ดึงทุก 10 นาที · feed ล้ม = cursor ไม่ขยับ ญาติ "ทุกเคส" ไม่ได้รับรายงานเลย)
    for (const r of out) {
      r.stars = r.family?.length ? await employeeStars(r.reported_by).catch(() => null) : null;
    }
    res.json({ cursor, reports: out });
  }),
);

/**
 * แชทเคส ญาติ ↔ ผู้ดูแล/นักกายภาพ ↔ ทีม (ดร.ธงชัย 24 ต.ค. 2569 แบบ ก "หน้าเว็บที่แตะจาก LINE")
 * ข้อความอยู่ที่ case_family_messages ที่เดียว ทุกฝ่ายเห็นเหมือนกัน — ที่นี่แค่บอกฝั่ง chat ว่ามีข้อความใหม่ถึงใคร ให้ไปแจ้งเตือนใน LINE
 *   ตั๋ว 'kin-family-msg-feed' {since} → { cursor, messages: [{message_id, case_id, client_name, author_kind, author_name, preview,
 *     family: [LINE ญาติ ไม่รวมคนเขียน], staff: [LINE ผู้ดูแลของเคส ไม่รวมคนเขียน]}] }
 *   ข้อความจากญาติ → แจ้งผู้ดูแล + ญาติคนอื่น · จากผู้ดูแล/ทีม → แจ้งญาติ + ผู้ดูแลคนอื่นของเคส · ทีมเห็นในหน้าเคสอยู่แล้ว
 *   ครั้งแรก (since = 0) ไม่ไล่ย้อนหลัง
 */
integrationRouter.post(
  '/family/message-feed',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-family-msg-feed');
    if (!p || !Number.isInteger(p.since) || p.since < 0) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    await ensureLineColumn();
    if (p.since === 0) {
      const last = await sql.one('SELECT COALESCE(MAX(message_id), 0)::int AS id FROM case_family_messages');
      return res.json({ cursor: last.id, messages: [] });
    }
    const rows = await sql.all(
      `SELECT m.message_id, m.case_id, c.client_name, m.author_kind, m.author_name, m.line_user_id AS author_line, m.employee_id AS author_emp,
              left(COALESCE(m.body, ''), 120) AS preview, (m.photo_data IS NOT NULL) AS has_photo,
              (SELECT array_agg(DISTINCT l.line_user_id) FROM case_family_links l
                WHERE l.case_id = m.case_id AND l.accepted_at IS NOT NULL AND l.revoked_at IS NULL AND l.line_user_id IS NOT NULL) AS family,
              (SELECT array_agg(DISTINCT e.line_user_id) FROM employees e
                WHERE e.line_user_id IS NOT NULL AND e.employee_id IS DISTINCT FROM m.employee_id
                  -- คนที่ลาออก/ถูกพักงานต้องไม่ได้รับแจ้งเตือนข้อความของครอบครัวผู้ป่วยต่อ (ดู BLOCKED_STATUSES)
                  AND COALESCE(e.status, '') NOT IN (${BLOCKED_SQL})
                  AND (e.employee_id = c.assigned_to
                       OR EXISTS (SELECT 1 FROM case_team t WHERE t.case_id = c.case_id AND t.employee_id = e.employee_id)
                       OR EXISTS (SELECT 1 FROM case_visits v WHERE v.case_id = c.case_id AND v.assigned_to = e.employee_id
                                    AND v.status <> 'cancelled' AND v.visit_date >= to_char(now() AT TIME ZONE 'Asia/Bangkok' - interval '14 days', 'YYYY-MM-DD')))) AS staff
       FROM case_family_messages m JOIN cases c ON c.case_id = m.case_id
       /* เดิมกันแค่ 'cancelled' — เคสที่ปิดไปนานแล้วยังแจ้งเตือนญาติได้อยู่ ทั้งที่เปิดหน้า /family ไม่ได้แล้ว
          ใช้กติกาเดียวกับทุกเส้นของญาติ: ปิด/ยกเลิกแล้วส่งต่อได้อีก 30 วัน (ตรวจรอบ 7)
          แถวที่ถูกกรองออกไม่ทำให้ cursor ค้าง — cursor เดินตามแถวที่ส่งจริง แถวที่เก่ากว่านั้นถูกข้ามถาวร */
       WHERE m.message_id > :since AND m.deleted_at IS NULL AND ${family.FAMILY_CASE_OPEN}
       ORDER BY m.message_id LIMIT 50`,
      { since: p.since, grace: family.CLOSED_GRACE_DAYS },
    );
    const cursor = rows.length ? rows[rows.length - 1].message_id : p.since;
    res.json({
      cursor,
      messages: rows.map((r) => ({
        message_id: r.message_id, case_id: r.case_id, client_name: r.client_name, author_kind: r.author_kind,
        author_name: r.author_name, preview: r.preview || (r.has_photo ? '(ส่งรูป)' : ''),
        family: (r.family || []).filter((u) => u !== r.author_line),
        staff: r.staff || [],
      })).filter((m) => m.family.length || m.staff.length),
    });
  }),
);

/**
 * รวมหน้าหลังบ้าน ข้อ 2 (ดร.ธงชัย 24 ต.ค. 2569 "ข้อสองข้อสามได้เลยครับ") — ห้องแชทลูกค้าในแดชบอร์ด admin เห็นงานของเคสได้เลย ไม่ต้องสลับมา staff
 *   /customers/case-overview ตั๋ว 'kin-case-overview' {cid, case_id} → ผู้ดูแล · กะวันนี้ + เช็คอิน/ออก · รายงานล่าสุด · ญาติที่เชื่อม · แชทเคส
 *   /family/team-post        ตั๋ว 'kin-team-post' {cid, case_id, by, body} → ทีมตอบแชทเคสจากห้องแชท admin (ขึ้นชื่อ "<ชื่อ> · ทีม KIN HomeCare")
 *   ตรวจว่าเคสเป็นของลูกค้า cid (ที่ห้องแชทนั้นผูกไว้) ทุกครั้ง · ไม่ส่งค่าจ้าง/ราคา/GPS/เซลฟี่
 */
async function customerCaseOr404(cid, caseId) {
  const c = await sql.one(
    `SELECT c.case_id, c.client_name, c.status, c.service_kind, c.start_date, c.assigned_to,
            e.first_name AS a_first, e.last_name AS a_last, e.nickname AS a_nick, e.phone AS a_phone, e.position AS a_pos
     FROM cases c LEFT JOIN employees e ON e.employee_id = c.assigned_to
     WHERE c.case_id = :id AND c.customer_id = :cid`,
    { id: caseId, cid },
  );
  if (!c) throw new ApiError(404, 'ไม่พบเคสนี้ของลูกค้ารายนี้');
  return c;
}
const nameOf = (first, nick) => (first ? `${first}${nick ? ` (${nick})` : ''}` : null);

integrationRouter.post(
  '/customers/case-overview',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-case-overview');
    if (!p || typeof p.cid !== 'string' || typeof p.case_id !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const c = await customerCaseOr404(p.cid, p.case_id);
    await family.ensureFamilyTable();
    const today = new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);
    const [team, visits, reports, fam, messages] = await Promise.all([
      sql.all(
        `SELECT e.first_name, e.nickname, e.position FROM case_team t JOIN employees e ON e.employee_id = t.employee_id
         WHERE t.case_id = :id ORDER BY e.first_name`, { id: c.case_id }),
      sql.all(
        `SELECT v.visit_date, v.planned_start, v.planned_end, v.status,
                to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_in,
                to_char(v.check_out_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_out,
                e.first_name AS s_first, e.nickname AS s_nick
         FROM case_visits v LEFT JOIN employees e ON e.employee_id = v.assigned_to
         WHERE v.case_id = :id AND v.status <> 'cancelled' AND v.visit_date BETWEEN :d0 AND :d1
         ORDER BY v.visit_date, v.planned_start NULLS LAST`,
        { id: c.case_id, d0: today, d1: new Date(Date.now() + 7 * 3.6e6 + 864e5).toISOString().slice(0, 10) }),
      sql.all(
        `SELECT r.report_date, r.report_time, r.bp_systolic, r.bp_diastolic, r.pulse, r.spo2, r.temperature_c,
                left(r.symptoms, 160) AS symptoms, left(r.care_given, 160) AS care_given,
                split_part(COALESCE(r.reported_by_name, ''), ' ', 1) AS by_first
         FROM case_reports r WHERE r.case_id = :id
         ORDER BY r.report_date DESC, r.report_id DESC LIMIT 3`, { id: c.case_id }),
      sql.one(
        `SELECT count(*)::int AS n FROM case_family_links
         WHERE case_id = :id AND accepted_at IS NOT NULL AND revoked_at IS NULL`, { id: c.case_id }),
      family.messagesFor(c.case_id, 20),
    ]);
    res.json({
      case_id: c.case_id, client_name: c.client_name, status: c.status, service_kind: c.service_kind, start_date: c.start_date,
      assigned: c.a_first ? { name: nameOf(c.a_first, c.a_nick), last: c.a_last, phone: c.a_phone, position: c.a_pos } : null,
      team: team.map((t) => ({ name: nameOf(t.first_name, t.nickname), position: t.position })),
      today, visits: visits.map((v) => ({
        date: v.visit_date, start: v.planned_start, end: v.planned_end, status: v.status,
        check_in: v.check_in, check_out: v.check_out, staff: nameOf(v.s_first, v.s_nick),
      })),
      reports, family_count: fam?.n || 0, messages,
      // ดาวสองทาง (25 ต.ค. 2569) — ห้องแชท admin เป็นของทีม จึงเห็นคะแนนทั้งสองฝั่ง
      assigned_stars: await employeeStars(c.assigned_to), ratings: await caseRatings(c.case_id),
    });
  }),
);

/**
 * รวมหน้าหลังบ้าน ข้อ 4 — คิวส่งใบแจ้งหนี้/ใบเสร็จเข้า LINE ลูกค้า (invoices/share.js)
 *   /invoices/line-outbox ตั๋ว 'kin-invoice-outbox' {ack?: [{id, ok, error}]} → จดผลส่งรอบก่อน แล้วคืนคิวที่ยังรอส่ง
 */
/**
 * เตือนนัดพนักงานทาง LINE (ดร.ธงชัย 26 ต.ค. 2569 · notify/visitReminders.js)
 *   /visits/reminders ตั๋ว 'kin-visit-remind' → จองแล้วคืนรายการที่ถึงเวลาเตือน (วันก่อน 08:00 · ก่อนนัด 3 ชม.)
 * chat.kinorigin.com เรียกทุก 15 นาทีแล้วส่งเข้า @kinjobs เอง · จองแล้วไม่คืนซ้ำ ส่งไม่ผ่านก็ไม่วนส่งอีก
 */
integrationRouter.post(
  '/visits/reminders',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    if (!verifySigned(token, 'kin-visit-remind')) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    res.json({ reminders: await claimDueVisitReminders(), family: await claimDueFamilyReminders(), changes: await claimVisitChanges() });
  }),
);

integrationRouter.post(
  '/invoices/line-outbox',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-invoice-outbox');
    if (!p) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const acked = Array.isArray(p.ack) ? await outboxAck(p.ack) : 0;
    res.json({ acked, pending: p.ack?.length ? [] : await outboxPending() });
  }),
);

/** คิวแจ้งทีมเมื่อมีสลิปลูกค้ารอตรวจ — ใช้สะพานลงลายเซ็นแบบเดียวกับคิวส่งบิล */
integrationRouter.post(
  '/invoices/slip-outbox',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-slip-outbox');
    if (!p) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const acked = Array.isArray(p.ack) ? await invoiceRepo.slipOutboxAck(p.ack) : 0;
    res.json({ acked, pending: p.ack?.length ? [] : await invoiceRepo.slipOutboxPending() });
  }),
);

/** รูปสลิปที่ Gemini ตรวจจาก LINE HomeCare — เลือกใบยอดตรงก่อน ไม่ตรงใช้ใบครบกำหนดก่อนสุด */
integrationRouter.post(
  '/invoices/pending-slip',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-pending-slip');
    if (!p || typeof p.cid !== 'string' || typeof p.image_url !== 'string' || typeof p.ref !== 'string') {
      throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    }
    await invoiceRepo.ensureSlipSchema();
    const amount = Number.isFinite(Number(p.amount)) && Number(p.amount) > 0 ? Math.round(Number(p.amount) * 100) / 100 : null;
    const invoice = await sql.one(
      `WITH open_bill AS (
         SELECT i.invoice_id, i.due_date, i.issue_date,
                GREATEST(i.total - COALESCE(SUM(x.amount), 0), 0) AS balance
           FROM invoices i LEFT JOIN invoice_payments x ON x.invoice_id = i.invoice_id
          WHERE i.customer_id = :cid AND i.status = 'issued'
          GROUP BY i.invoice_id
       )
       SELECT invoice_id, balance FROM open_bill WHERE balance > 0
       ORDER BY CASE WHEN :amount IS NOT NULL AND abs(balance - :amount) <= 0.01 THEN 0 ELSE 1 END,
                due_date ASC NULLS LAST, issue_date ASC NULLS LAST, invoice_id ASC
       LIMIT 1`,
      { cid: p.cid, amount },
    );
    if (!invoice) return res.json({ attached: false, reason: 'no_open_invoice' });
    const image = await fetchChatImage(p.image_url);
    const row = await invoiceRepo.addSlip(invoice.invoice_id, image, { name: 'ลูกค้าจาก LINE' }, {
      status: 'pending', source: 'line_auto', sourceRef: `line-slip:${p.ref}`,
      extracted: {
        amount,
        date: typeof p.date === 'string' ? p.date.slice(0, 30) : null,
        ref: typeof p.transfer_ref === 'string' ? p.transfer_ref.slice(0, 100) : null,
        bank: typeof p.bank === 'string' ? p.bank.slice(0, 100) : null,
      },
      notify: true,
    });
    res.status(201).json({ attached: true, invoice_id: row.invoice_id, slip_id: row.slip_id });
  }),
);

/**
 * รวมหน้าหลังบ้าน ข้อ 3 (ดร.ธงชัย 24 ต.ค. 2569) — ป้ายสถานะบิลในห้องแชทลูกค้า admin (ดูอย่างเดียว · ออกบิล/รับเงินยังทำใน staff)
 *   /customers/billing ตั๋ว 'kin-billing-summary' {cid} → ยอดค้าง · เกินกำหนด · ใบที่ยังค้าง ≤5 ใบ · รับเงินล่าสุด
 *   ไม่ส่งเลขผู้เสียภาษี/ที่อยู่ออกบิล/รายการย่อย · ร่าง (draft) กับยกเลิกไม่นับ
 */
integrationRouter.post(
  '/customers/billing',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-billing-summary');
    if (!p || typeof p.cid !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const today = new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);
    const money = (n) => Math.round(Number(n || 0) * 100) / 100;
    await invoiceRepo.ensureSlipSchema();
    const summary = await sql.one(
      `WITH billed AS (
         SELECT i.due_date,
                CASE WHEN i.status = 'paid' THEN 0
                     ELSE GREATEST(i.total - COALESCE(SUM(x.amount), 0), 0) END AS balance
           FROM invoices i
           LEFT JOIN invoice_payments x ON x.invoice_id = i.invoice_id
          WHERE i.customer_id = :cid AND i.status IN ('issued', 'paid')
          GROUP BY i.invoice_id
       )
       SELECT COUNT(*)::int AS invoice_count,
              COALESCE(SUM(balance), 0) AS outstanding,
              COALESCE(SUM(balance) FILTER (WHERE due_date IS NOT NULL AND due_date < :today), 0) AS overdue,
              COUNT(*) FILTER (WHERE balance > 0)::int AS open_count
         FROM billed`,
      { cid: p.cid, today },
    );
    const open = await sql.all(
      `WITH billed AS (
         SELECT i.invoice_id, i.case_id, i.issue_date, i.due_date, i.total,
                COALESCE(SUM(x.amount), 0) AS paid,
                GREATEST(i.total - COALESCE(SUM(x.amount), 0), 0) AS balance
           FROM invoices i
           LEFT JOIN invoice_payments x ON x.invoice_id = i.invoice_id
          WHERE i.customer_id = :cid AND i.status = 'issued'
          GROUP BY i.invoice_id
       )
       SELECT invoice_id, case_id, issue_date, due_date, total, paid, balance,
              (due_date IS NOT NULL AND due_date < :today) AS overdue
         FROM billed WHERE balance > 0
        ORDER BY issue_date DESC, invoice_id DESC LIMIT 5`,
      { cid: p.cid, today },
    );
    const lastPaid = await sql.one(
      `SELECT x.invoice_id, x.amount, x.paid_at
       FROM invoice_payments x JOIN invoices i ON i.invoice_id = x.invoice_id
       WHERE i.customer_id = :cid AND i.status <> 'cancelled'
       ORDER BY x.paid_at DESC, x.payment_id DESC LIMIT 1`,
      { cid: p.cid },
    );
    res.json({
      today,
      invoice_count: summary.invoice_count,
      outstanding: money(summary.outstanding),
      overdue: money(summary.overdue),
      open: open.map((r) => ({ ...r, total: money(r.total), paid: money(r.paid), balance: money(r.balance) })),
      open_count: summary.open_count,
      last_paid: lastPaid ? { invoice_id: lastPaid.invoice_id, amount: money(lastPaid.amount), paid_at: lastPaid.paid_at } : null,
      pending_slip_count: Number((await sql.one(
        `SELECT COUNT(*)::int AS n FROM invoice_slips s JOIN invoices i ON i.invoice_id = s.invoice_id
         WHERE i.customer_id = :cid AND s.status = 'pending'`,
        { cid: p.cid },
      )).n || 0),
    });
  }),
);

/** ทีมกดส่งข้อความ/รูปของลูกค้าเข้า feed เคสในนามญาติ โดยมีป้ายผู้ส่งต่อและกันซ้ำด้วย source_ref */
integrationRouter.post(
  '/family/forward-customer',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-forward-customer');
    if (!p || typeof p.cid !== 'string' || typeof p.case_id !== 'string' || typeof p.ref !== 'string') {
      throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    }
    const c = await customerCaseOr404(p.cid, p.case_id);
    if (['closed', 'cancelled'].includes(c.status)) throw new ApiError(409, 'เคสนี้ปิดแล้ว จึงส่งต่อข้อความไม่ได้');
    const body = typeof p.body === 'string' && p.body.trim() ? p.body.trim() : null;
    const photo = typeof p.image_url === 'string' && p.image_url ? await fetchChatImage(p.image_url) : null;
    if (!body && !photo) throw new ApiError(400, 'ข้อความนี้ไม่มีเนื้อหาหรือรูปให้ส่งต่อ');
    await family.ensureFamilyTable();
    const customerName = String(p.line_name || 'ญาติ/ลูกค้า').slice(0, 50);
    const adminName = String(p.by || 'ทีม').slice(0, 50);
    const message = await family.postMessage(p.case_id, {
      kind: 'family',
      name: `${customerName} · ส่งต่อโดยทีม ${adminName}`,
      lineUserId: isLineUserId(p.line_user_id) ? p.line_user_id : null,
      body,
      photo,
      sourceRef: `chat-forward:${p.ref}`,
    });
    res.status(201).json({ forwarded: true, message_id: message.message_id, case_id: p.case_id });
  }),
);

/**
 * รวมหน้าหลังบ้าน ข้อ 5 (24 ต.ค. 2569) — รูปในแชทเคสกับญาติ เปิดดูในห้องแชท admin ได้ ไม่ต้องสลับมา staff
 *   /family/message-photo ตั๋ว 'kin-case-photo' {cid, case_id, message_id} → ไฟล์รูป (ตรวจว่าเคสเป็นของลูกค้า cid)
 */
integrationRouter.post(
  '/family/message-photo',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-case-photo');
    if (!p || typeof p.cid !== 'string' || typeof p.case_id !== 'string' || !Number.isInteger(p.message_id)) {
      throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    }
    await customerCaseOr404(p.cid, p.case_id);
    const row = await family.messagePhoto(p.case_id, p.message_id);
    if (!row) throw new ApiError(404, 'ไม่พบรูป');
    res.setHeader('Content-Type', row.mime || 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(row.data);
  }),
);

/**
 * ดาวสองทาง (ดร.ธงชัย 25 ต.ค. 2569 · lib/ratings.js) — ฝั่ง chat ถามดาวทาง LINE แล้วส่งคะแนนกลับมาเก็บที่นี่
 *   /ratings/due    ตั๋ว 'kin-rating-due' {} → เคสที่ถึงรอบถามวันนี้ + LINE ญาติ/ผู้ดูแล
 *   /ratings/submit ตั๋ว 'kin-rating-submit' {case_id, round, kind: family|staff, line, stars, reason?} → { ok, low }
 */
const ROUND_RE = /^(d3|w\d{1,3}|end)$/;

/**
 * สรุปสุขภาพรายสัปดาห์ถึงญาติ (ดร.ธงชัย 25 ต.ค. 2569 ลูกค้า ข้อ 2) — ฝั่ง chat ส่งเข้า LINE Kin HomeCare ทุกวันอาทิตย์
 *   ตั๋ว 'kin-family-weekly' {} → { week_from, week_to, cases: [{case_id, client_first, family, reports, shifts, this:{…}, prev:{…}}] }
 *   เฉพาะเคสที่มีญาติผูก LINE และมีรายงานใน 7 วันล่าสุด · ส่งแค่ค่าเฉลี่ย/ต่ำสุด/สูงสุด ไม่ส่งข้อความอาการรายครั้ง
 */
integrationRouter.post(
  '/family/weekly-summary',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    if (!verifySigned(token, 'kin-family-weekly')) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await family.ensureFamilyTable();
    const d = (off) => thDate(off);
    const from = d(-6), to = d(0), pFrom = d(-13), pTo = d(-7);
    const agg = (alias) => `
      count(*)::int AS ${alias}_reports,
      round(avg(NULLIF(r.bp_systolic, 0)))::int AS ${alias}_sys, round(avg(NULLIF(r.bp_diastolic, 0)))::int AS ${alias}_dia,
      max(NULLIF(r.bp_systolic, 0))::int AS ${alias}_sys_max, min(NULLIF(r.bp_systolic, 0))::int AS ${alias}_sys_min,
      round(avg(NULLIF(r.spo2, 0)))::int AS ${alias}_spo2, min(NULLIF(r.spo2, 0))::int AS ${alias}_spo2_min,
      round(avg(NULLIF(r.pulse, 0)))::int AS ${alias}_pulse, max(NULLIF(r.temperature_c, 0))::float AS ${alias}_temp_max,
      max(r.walk_distance_m)::float AS ${alias}_walk_max, round(avg(r.pain_score)::numeric, 1)::float AS ${alias}_pain`;
    const rows = await sql.all(
      `WITH fam AS (
         SELECT case_id, array_agg(DISTINCT line_user_id) AS family FROM case_family_links
         WHERE accepted_at IS NOT NULL AND revoked_at IS NULL AND line_user_id IS NOT NULL GROUP BY case_id),
       w AS (SELECT r.case_id, ${agg('t')} FROM case_reports r WHERE r.report_date BETWEEN :from AND :to GROUP BY r.case_id),
       p AS (SELECT r.case_id, ${agg('p')} FROM case_reports r WHERE r.report_date BETWEEN :pFrom AND :pTo GROUP BY r.case_id),
       v AS (SELECT case_id, count(*)::int AS shifts FROM case_visits
             WHERE visit_date BETWEEN :from AND :to AND check_out_at IS NOT NULL AND status <> 'cancelled' AND checked_in_by IS NOT NULL
             GROUP BY case_id)
       -- w.* / p.* มีคอลัมน์ case_id ซ้ำ (pg เอาตัวหลังทับ → p ไม่มีแถว = case_id null) จึงวาง c.case_id ไว้หลังสุด
       SELECT w.*, p.*, split_part(COALESCE(c.client_name, ''), ' ', 1) AS client_first, fam.family, COALESCE(v.shifts, 0) AS shifts, c.case_id
       -- เคสปิด/ยกเลิกเกินช่วงผ่อนผัน 30 วัน ไม่ส่งสรุปรายสัปดาห์ถึงญาติอีก (กติกาเดียวกับหน้า /family · ตรวจรอบ 7)
       FROM w JOIN fam ON fam.case_id = w.case_id JOIN cases c ON c.case_id = w.case_id AND ${family.FAMILY_CASE_OPEN}
       LEFT JOIN p ON p.case_id = w.case_id LEFT JOIN v ON v.case_id = w.case_id`,
      { from, to, pFrom, pTo, grace: family.CLOSED_GRACE_DAYS },
    );
    const pick = (r, a) => ({
      reports: r[`${a}_reports`] || 0, sys: r[`${a}_sys`], dia: r[`${a}_dia`], sys_max: r[`${a}_sys_max`], sys_min: r[`${a}_sys_min`],
      spo2: r[`${a}_spo2`], spo2_min: r[`${a}_spo2_min`], pulse: r[`${a}_pulse`], temp_max: r[`${a}_temp_max`],
      walk_max: r[`${a}_walk_max`], pain: r[`${a}_pain`],
    });
    res.json({
      week_from: from, week_to: to,
      cases: rows.map((r) => ({ case_id: r.case_id, client_first: r.client_first, family: r.family, shifts: r.shifts, this: pick(r, 't'), prev: pick(r, 'p') })),
    });
  }),
);

/**
 * ปิดเคส + เตือนก่อนหมดสิทธิ์ดูย้อนหลัง (ดร.ธงชัย 25 ต.ค. 2569 "ส่งข้อความปิดเคส เตือนก่อนหมดอีก 3 วัน")
 *
 * ที่มา: เคสจบแล้วญาติไม่ได้รับแจ้งอะไรเลย เงียบไป 30 วัน แล้ววันหนึ่งกดลิงก์ "ดูการดูแล" ขึ้นว่า
 * "ยังไม่มีเคสที่เชื่อมกับ LINE นี้ หรือทีมปลดการเชื่อมแล้ว" ซึ่งอ่านแล้วเหมือนระบบพังหรือถูกตัดทิ้ง (ตรวจรอบ 12A)
 *
 *   ตั๋ว 'kin-family-lifecycle' {} → { grace_days, lead_days, closed_window_days, closed: [...], expiring: [...] }
 *   closed   = เคสที่เพิ่งปิด/ยกเลิกภายใน 2 วัน → ข้อความขอบคุณ + บอกว่ายังเปิดดูย้อนหลังได้อีกกี่วัน
 *   expiring = เคสที่สิทธิ์เปิดดูเหลือ ≤3 วัน   → ข้อความเตือนให้เปิดดู/บันทึกไว้ก่อน
 *   เพดาน 30 วันมาจาก family.CLOSED_GRACE_DAYS ที่เดียว (ฝั่ง chat ห้าม hardcode) · ส่งแค่ชื่อต้นของผู้ป่วย
 *   ไม่ส่งชื่อโรค/อาการ/ชื่อสกุล — ข้อความนี้ขึ้นบนหน้าจอล็อกของญาติ คนข้าง ๆ เห็นได้
 *
 * 🔴 หน้าต่าง 2 วันของ closed มีไว้กันรอบแรกหลัง deploy ยิงย้อนหลังรวดเดียว
 *    ถ้าเอา "ปิดแล้วและยังอยู่ในผ่อนผัน" ตรง ๆ เคสที่ปิดไป 29 วันแล้วจะได้ข้อความขอบคุณพร้อมกันทั้งก้อน
 *    2 วัน = cron รายวันมีโอกาสลองใหม่ 1 รอบเมื่อส่งไม่ออกชั่วคราว (ฝั่ง chat กันส่งซ้ำด้วยตารางของตัวเอง)
 */
const FAMILY_CLOSED_WINDOW_DAYS = 2;
const FAMILY_EXPIRY_LEAD_DAYS = 3;

integrationRouter.post(
  '/family/lifecycle-due',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    if (!verifySigned(token, 'kin-family-lifecycle')) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    res.json(await family.lifecycleDue({ closedWindowDays: FAMILY_CLOSED_WINDOW_DAYS, leadDays: FAMILY_EXPIRY_LEAD_DAYS }));
  }),
);

/**
 * ป้ายผู้ดูแลบนการ์ดแนะนำตัวที่ส่งให้ญาติ (ดร.ธงชัย 25 ต.ค. 2569 ลูกค้า ข้อ 1) — ดาวเฉลี่ยจากครอบครัว + ระดับ + จำนวนกะ 90 วัน
 *   ตั๋ว 'kin-emp-badge' {employee_id} → { stars: {avg, n}, tier: {key, label}, shifts } · ไม่ส่งชื่อจริง/เบอร์/ข้อมูลอื่น
 */
integrationRouter.post(
  '/employees/badge',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-emp-badge');
    if (!p || typeof p.employee_id !== 'string' || !/^[A-Z0-9-]{3,20}$/i.test(p.employee_id)) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const t = await employeeTier(p.employee_id);
    res.json({ stars: { avg: t.metrics.stars, n: t.metrics.n_stars }, tier: { key: t.key, label: t.label }, shifts: t.metrics.shifts });
  }),
);

/**
 * รายได้ของฉัน + ระดับพนักงาน ใน LINE @kinjobs (ดร.ธงชัย 25 ต.ค. 2569 ข้อ 1 + ข้อ 3)
 *   ตั๋ว 'kin-my-earnings' {u} → เดือนนี้: กะ · ค่าตอบแทน (จ่ายแล้ว/ยังไม่จ่าย) · กะรออนุมัติ · สลิปล่าสุด · ระดับ + สิ่งที่ขาดถึงระดับถัดไป
 *   ตัวเลขชุดเดียวกับหน้า "ค่าตอบแทนของฉัน" (/my/attendance/report) — ไม่ส่งของคนอื่น
 */
integrationRouter.post(
  '/my-earnings',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-my-earnings');
    if (!p || !isLineUserId(p.u)) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();
    const emp = await sql.one('SELECT employee_id, first_name, status FROM employees WHERE line_user_id = :uid', { uid: p.u });
    if (!emp || BLOCKED_STATUSES[emp.status]) return res.json({ linked: false });
    const ym = thDate(0).slice(0, 7);
    const [[row], slip, tier] = await Promise.all([
      cases.attendanceReport(ym, emp.employee_id),
      sql.one(
        `SELECT r.period_month, r.pay_date, i.total_pay FROM payroll_items i JOIN payroll_runs r ON r.run_id = i.run_id
         WHERE i.employee_id = :emp AND r.status = 'paid' ORDER BY r.pay_date DESC, r.run_id DESC LIMIT 1`,
        { emp: emp.employee_id }),
      employeeTier(emp.employee_id),
    ]);
    const n = (x) => Number(x || 0);
    res.json({
      linked: true, first_name: emp.first_name, month: ym,
      shifts: n(row?.shifts), approved_shifts: n(row?.approved_shifts), pending_shifts: n(row?.pending_shifts),
      pay: n(row?.pay), paid_pay: n(row?.paid_pay), unpaid_pay: n(row?.unpaid_pay),
      last_slip: slip ? { period_month: slip.period_month, pay_date: slip.pay_date, total_pay: n(slip.total_pay) } : null,
      tier,
    });
  }),
);

/**
 * แจ้งพนักงานทาง LINE เมื่อระดับเปลี่ยน + สรุปรายเดือน (ดร.ธงชัย 25 ต.ค. 2569 "ต่อทั้งหมดเลย" — แจ้ง 3 จังหวะ: รับเข้าทำงาน · ระดับเปลี่ยน · สรุปรายเดือน)
 *   ตั๋ว 'kin-tier-roster' {month?: 'YYYY-MM'} → { employees: [{ employee_id, u, first_name, tier: {key,label,next}, month?: {shifts, pay, paid_pay, unpaid_pay} }] }
 *   เฉพาะพนักงานที่ผูก LINE แล้วและไม่ถูกระงับ · ส่งชื่อเล่น/ชื่อต้นเท่านั้น ไม่ส่งเบอร์หรือข้อมูลอื่น
 */
integrationRouter.post(
  '/employees/line-roster',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-tier-roster');
    if (!p) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    const month = typeof p.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p.month) ? p.month : null;
    await ensureLineColumn();
    const emps = (await sql.all(
      `SELECT employee_id, first_name, status, line_user_id FROM employees WHERE line_user_id IS NOT NULL ORDER BY employee_id`,
    )).filter((e) => !BLOCKED_STATUSES[e.status] && isLineUserId(e.line_user_id));
    const report = month ? new Map((await cases.attendanceReport(month)).map((r) => [r.employee_id, r])) : null;
    const out = [];
    for (let i = 0; i < emps.length; i += 8) {
      const part = emps.slice(i, i + 8);
      const tiers = await Promise.all(part.map((e) => employeeTier(e.employee_id)));
      part.forEach((e, k) => {
        const t = tiers[k];
        const r = report?.get(e.employee_id);
        const n = (x) => Number(x || 0);
        out.push({
          employee_id: e.employee_id, u: e.line_user_id, first_name: e.first_name,
          tier: { key: t.key, label: t.label, next: t.next },
          ...(month ? { month: { shifts: n(r?.shifts), pay: n(r?.pay), paid_pay: n(r?.paid_pay), unpaid_pay: n(r?.unpaid_pay) } } : {}),
        });
      });
    }
    res.json({ employees: out });
  }),
);

/**
 * ชวนเพื่อนแบบแต้มสะสม (ดร.ธงชัย 25 ต.ค. 2569) — ฝั่ง chat ถามว่าเพื่อนที่ถูกชวนทำงานไปแล้วกี่กะ เพื่อให้แต้ม (กะแรก / ครบ 10 กะ)
 *   ตั๋ว 'kin-shift-counts' {ids: [employee_id ≤200]} → { counts: { [employee_id]: จำนวนกะที่เสร็จแล้ว } }
 *   นับกะที่เช็คเอาต์แล้วหรือสถานะเสร็จ (คนเช็คอินหรือคนที่ถูกจัดกะ) · ไม่ส่งข้อมูลอื่นของพนักงาน
 */
integrationRouter.post(
  '/employees/shift-counts',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-shift-counts');
    // dedup รหัสซ้ำ — unnest+JOIN จะนับกะซ้ำถ้ามี employee_id ซ้ำในรายการ
    const ids = Array.isArray(p?.ids) ? [...new Set(p.ids.filter((x) => typeof x === 'string' && /^[A-Z0-9-]{3,20}$/i.test(x)))].slice(0, 200) : null;
    if (!ids) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    if (!ids.length) return res.json({ counts: {} });
    // since {employee_id: 'YYYY-MM-DD'} = นับเฉพาะกะตั้งแต่วันสมัครผ่านลิงก์ชวน (พนักงานเดิมสมัครซ้ำ ห้ามได้แต้มจากกะเก่า)
    const sinceOf = (id) => (typeof p.since?.[id] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.since[id]) ? p.since[id] : '0000-00-00');
    const rows = await sql.all(
      // นิยามเดียวกับกะที่จ่ายค่าจ้าง (cases/repo.js WORKED_SHIFT): เช็คอิน-เอาต์จริง ไม่นับกะที่ยกเลิก นับให้คนที่เช็คอิน
      `SELECT q.emp, count(v.visit_id)::int AS n
       FROM unnest(:ids::text[], :sinces::text[]) AS q(emp, since)
       JOIN case_visits v ON v.checked_in_by = q.emp AND v.visit_date >= q.since
         AND v.check_out_at IS NOT NULL AND v.status <> 'cancelled'
       GROUP BY q.emp`,
      { ids, sinces: ids.map(sinceOf) },
    );
    res.json({ counts: Object.fromEntries(rows.map((r) => [r.emp, r.n])) });
  }),
);
integrationRouter.post(
  '/ratings/due',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    if (!verifySigned(token, 'kin-rating-due')) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    res.json({ due: await dueRatings() });
  }),
);

integrationRouter.post(
  '/ratings/submit',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-rating-submit');
    if (!p || typeof p.case_id !== 'string' || !ROUND_RE.test(String(p.round)) || !['family', 'staff'].includes(p.kind)
      || !isLineUserId(p.line) || !Number.isInteger(p.stars) || p.stars < 1 || p.stars > 5) {
      throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือข้อมูลไม่ครบ');
    }
    const r = await submitRating({ caseId: p.case_id, round: p.round, kind: p.kind, line: p.line, stars: p.stars, reason: p.reason });
    if (r.error) throw new ApiError(r.error === 'not_found' ? 404 : 403, r.error);
    res.json(r);
  }),
);

integrationRouter.post(
  '/family/team-post',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-team-post');
    if (!p || typeof p.cid !== 'string' || typeof p.case_id !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    // ยาวเกินให้ postMessage ตีกลับพร้อมบอกจำนวนตัวที่เกิน (ตรวจรอบ 19) ไม่ตัดทิ้งที่นี่
    const body = typeof p.body === 'string' ? p.body.trim() : '';
    if (!body) throw new ApiError(400, 'กรุณาพิมพ์ข้อความ');
    const c = await customerCaseOr404(p.cid, p.case_id);
    if (['closed', 'cancelled'].includes(c.status)) throw new ApiError(409, 'เคสนี้ปิดแล้ว');
    await family.ensureFamilyTable();
    const by = String(p.by || 'ทีม').slice(0, 60);
    // ยิงซ้ำด้วยตั๋วใบเดิมต้องไม่ได้ข้อความสองอัน — คืนคำตอบของครั้งแรก
    const out = await onceByTicket(token, 'kin-team-post', async () => ({
      status: 201,
      body: await family.postMessage(c.case_id, { kind: 'team', name: `${by} · ทีม KIN HomeCare`, body }),
    }));
    res.status(out.status).json(out.body);
  }),
);

/**
 * ส่งรหัสยืนยันตัวตนพนักงานเข้า LINE จากการ์ดผู้สมัครในแดชบอร์ด admin (ดร.ธงชัย 24 ต.ค. 2569
 * "ทำปุ่ม ส่งรหัสยืนยันตัวตนทาง LINE ที่การ์ดผู้สมัครในหน้า Admin ได้เลย" · "เข้า LINE ให้อัตโนมัติ ไม่ต้องไป copy ส่ง")
 *   ตั๋ว 'kin-issue-line-code' {employee_id, by} → { code, expires_at, first_name } · ฝั่ง chat ส่งรหัสเข้า LINE @kinjobs ของผู้สมัครเอง
 *   ออกให้เฉพาะพนักงานภาคสนาม (FRONT_POSITIONS) ที่ยังใช้งานอยู่ — บัญชีสำนักงาน/แอดมินออกจากทางนี้ไม่ได้ (กันยึดบัญชีหลังบ้าน)
 *   ยืนยันตัวตนแล้ว → { linked: true } ไม่ออกรหัสใหม่ · รหัสเดิมของคนนั้นถูกแทนที่ (ใช้ได้ครั้งเดียว 24 ชม. เหมือนออกจากหน้าพนักงาน)
 */
integrationRouter.post(
  '/employees/line-code',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-issue-line-code');
    if (!p || typeof p.employee_id !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();
    await ensureLinkCodeTables();
    const emp = await sql.one(
      'SELECT employee_id, first_name, position, status, line_user_id, phone FROM employees WHERE upper(employee_id) = upper(:id)',
      { id: p.employee_id.trim() },
    );
    if (!emp) throw new ApiError(404, `ไม่พบพนักงานรหัส ${p.employee_id} ในระบบงาน`);
    // แอดมินพิมพ์รหัสพนักงานเอง → ต้องเป็นคนเดียวกับผู้สมัคร (เบอร์ 9 หลักท้ายตรงกัน) ก่อนออกรหัส
    // กันพิมพ์ผิดเป็นรหัสคนอื่น แล้วรหัสของคนนั้นถูกส่งเข้า LINE ผู้สมัคร = ผูก LINE ผิดคน เห็นเคสคนอื่น (PDPA)
    if (p.expect_phone) {
      const tail = (x) => String(x || '').replace(/\D/g, '').slice(-9);
      if (!tail(emp.phone)) {
        throw new ApiError(409, `พนักงานรหัส ${emp.employee_id} (คุณ${emp.first_name}) ยังไม่มีเบอร์ในระบบงาน จึงยืนยันไม่ได้ว่าเป็นคนเดียวกับผู้สมัคร — ใส่เบอร์ในหน้าพนักงานก่อน แล้วลองใหม่`);
      }
      if (tail(emp.phone) !== tail(p.expect_phone)) {
        throw new ApiError(409, `รหัส ${emp.employee_id} เป็นของคุณ${emp.first_name} ซึ่งเบอร์ไม่ตรงกับผู้สมัครคนนี้ — ตรวจรหัสพนักงานอีกครั้ง`);
      }
    }
    if (BLOCKED_STATUSES[emp.status]) throw new ApiError(409, 'บัญชีพนักงานนี้ถูกปิดอยู่');
    if (!FRONT_POSITIONS.includes(emp.position)) throw new ApiError(403, 'ส่งรหัสทางนี้ได้เฉพาะพนักงานภาคสนาม — บัญชีสำนักงานออกรหัสที่หน้าพนักงานในระบบงาน');
    if (emp.line_user_id) return res.json({ linked: true, employee_id: emp.employee_id, first_name: emp.first_name });
    await sql.run('DELETE FROM line_link_codes WHERE expires_at < now()');
    for (let i = 0; i < 5; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (await sql.one('SELECT 1 AS x FROM line_link_codes WHERE code_hash = :h AND employee_id <> :id', { h: hashLinkCode(code), id: emp.employee_id })) continue;
      const row = await sql.one(
        `INSERT INTO line_link_codes (employee_id, code_hash, expires_at, created_by)
         VALUES (:id, :h, now() + make_interval(hours => :ttl), :by)
         ON CONFLICT (employee_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
           created_by = EXCLUDED.created_by, created_at = now()
         RETURNING to_char(expires_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS expires_at`,
        { id: emp.employee_id, h: hashLinkCode(code), ttl: LINK_CODE_TTL_HOURS, by: `admin: ${String(p.by || '').slice(0, 60)}` },
      );
      return res.json({ code, expires_at: row.expires_at, employee_id: emp.employee_id, first_name: emp.first_name });
    }
    throw new ApiError(500, 'ออกรหัสไม่สำเร็จ ลองกดใหม่อีกครั้ง');
  }),
);
