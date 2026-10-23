import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { ensureLineColumn, isLineUserId, verifySigned } from '../lib/lineBridge.js';
import { createEmployeeSchema, decodeImage } from '../employees/schema.js';
import * as repo from '../employees/repo.js';
import * as cases from '../cases/repo.js';
import { BLOCKED_STATUSES } from '../lib/auth.js';
import * as family from '../lib/family.js';
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

const hireSchema = z.object({ token: z.string().min(1) });

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
    if (!p || !isLineUserId(p.u) || typeof p.text !== 'string') throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();

    const emp = await sql.one(
      `SELECT employee_id, first_name, last_name, status FROM employees WHERE line_user_id = :uid`,
      { uid: p.u },
    );
    if (!emp || BLOCKED_STATUSES[emp.status]) return res.json({ linked: false });

    const all = (await cases.visitsForEmployeeOn(emp.employee_id, thDate(0))).filter(
      (v) => v.state !== 'cancelled' && !['closed', 'cancelled'].includes(v.case_status),
    );
    const wanted = p.case_id ? all.filter((v) => v.case_id === p.case_id) : all;
    const working = wanted.filter((v) => v.state === 'working');
    const visit = wanted.length === 1 ? wanted[0] : working.length === 1 ? working[0] : null;
    if (!visit) {
      return res.json({ linked: true, saved: false, choices: [...new Set(all.map((v) => v.case_id))] });
    }

    const report = await cases.addReport(
      visit.case_id,
      { visit_id: visit.visit_id, report_type: 'routine', note: p.text.trim().slice(0, 2000) },
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
    res.status(201).json({
      linked: true, saved: true, case_id: visit.case_id, report_id: report.report_id,
      family_line_ids: relatives.map((r) => r.line_user_id), caregiver_first_name: emp.first_name,
    });
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
    res.json(await family.familyInvite(p.u, p.case_id));
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
    const row = await family.postMessage(p.case_id, {
      kind: 'family', name: me.display_name || 'ญาติ', lineUserId: p.u, body, photo,
    });
    res.status(201).json({ ok: true, message_id: row.message_id, name: me.display_name || 'ญาติ' });
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
    res.json({ matches: await findByPhones(p.phones.slice(0, 500)) });
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

    const lineUserId = isLineUserId(p.d.line_user_id) ? p.d.line_user_id : null;
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

    const created = await repo.create(input);
    if (lineUserId) {
      await sql.run('UPDATE employees SET line_user_id = :uid WHERE employee_id = :id', {
        uid: lineUserId,
        id: created.employee_id,
      });
    }
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
      `SELECT r.report_id, r.case_id, r.report_date, r.report_time,
              r.bp_systolic, r.bp_diastolic, r.pulse, r.respiratory_rate, r.spo2, r.temperature_c, r.blood_sugar,
              left(r.symptoms, 200) AS symptoms, left(r.care_given, 200) AS care_given, left(r.intake_output, 200) AS intake_output,
              -- รายงานกายภาพ (ดร. 23 ต.ค. 2569 "รายงานของนักกายภาพก็ลักษณะเดียวกัน") — ฝั่ง chat จัดข้อความแบบกายภาพเมื่อ is_physio
              (c.service_kind = 'physio' OR c.physio_package_id IS NOT NULL OR c.case_type = 'physiotherapy') AS is_physio,
              r.physio_treatments, r.rehab_minutes, r.assist_level, r.walk_aid, r.walk_distance_m,
              r.pain_score, r.post_pain_score, r.post_bp_systolic, r.post_bp_diastolic, r.post_pulse, r.rehab_after,
              split_part(COALESCE(r.reported_by_name, ''), ' ', 1) AS by_first,
              (SELECT array_agg(DISTINCT l.line_user_id) FROM case_family_links l
                WHERE l.case_id = r.case_id AND l.accepted_at IS NOT NULL AND l.revoked_at IS NULL AND l.line_user_id IS NOT NULL) AS family
       FROM case_reports r JOIN cases c ON c.case_id = r.case_id
       WHERE r.report_id > :since AND COALESCE(r.reported_by_name, '') NOT LIKE '%(LINE)'
       ORDER BY r.report_id LIMIT 50`,
      { since: p.since },
    );
    const cursor = rows.length ? rows[rows.length - 1].report_id : p.since;
    res.json({ cursor, reports: rows.filter((r) => r.family?.length) });
  }),
);
