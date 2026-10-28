import { Router } from 'express';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';
import * as family from '../lib/family.js';
import { lineForCase } from '../lib/customerLine.js';
import { decodeImage, imageSchema } from '../employees/schema.js';

/**
 * แอดมินจัดการญาติที่ดูการดูแลผ่าน LINE ของเคส (หน้าเคส → "ญาติที่ดูผ่าน LINE") — ดูหัวไฟล์ lib/family.js
 * อยู่หลังด่าน requireAdmin (หมวด office) ที่ app.js
 */
export const familyRouter = Router();

// @KINHOMECARE = LINE OA KIN HomeCare หลัก (ช่อง line-homecare ในระบบแชท chat.kinorigin.com)
const OA_ID = '@kinhomecare';

familyRouter.param('caseId', (req, res, next, id) => {
  sql
    .one('SELECT case_id, status FROM cases WHERE case_id = :id', { id })
    .then((row) => {
      if (!row) return next(notFound(`ไม่พบเคส ${id}`));
      req.caseRow = row;
      next();
    })
    .catch(next);
});

familyRouter.get(
  '/cases/:caseId',
  asyncRoute(async (req, res) => {
    await family.ensureFamilyTable();
    res.set('Cache-Control', 'no-store');
    res.json({ items: await family.listForCase(req.params.caseId), max: family.FAMILY_MAX_PER_CASE });
  }),
);

const inviteSchema = z.object({
  consent: z.literal(true, { errorMap: () => ({ message: 'ต้องยืนยันว่าได้รับความยินยอมจากผู้รับบริการหรือผู้แทนแล้ว' }) }),
});

/** ออกรหัสเชิญ — คืนรหัสครั้งเดียว (ในฐานข้อมูลเก็บแค่ hash) พร้อมลิงก์เปิดแชท OA ที่พิมพ์ข้อความไว้ให้แล้ว */
familyRouter.post(
  '/cases/:caseId/invites',
  asyncRoute(async (req, res) => {
    inviteSchema.parse(req.body ?? {});
    if (req.caseRow.status === 'cancelled') throw new ApiError(409, 'เคสนี้ถูกยกเลิกแล้ว');
    await family.ensureFamilyTable();
    if ((await family.activeCount(req.params.caseId)) >= family.FAMILY_MAX_PER_CASE) {
      throw new ApiError(409, `เชิญได้สูงสุด ${family.FAMILY_MAX_PER_CASE} คนต่อเคส — ปลดคนเดิมก่อน`);
    }
    const { code, days } = await family.createInvite(req.params.caseId, req.user.name);
    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      code,
      days,
      oa: OA_ID,
      link: `https://line.me/R/oaMessage/${OA_ID}/?${encodeURIComponent(`ญาติ ${code}`)}`,
    });
  }),
);

// ---------- ช่องทางติดต่อ LINE ของลูกค้าเจ้าของเคส (แชทสอบถามทาง OA Kin HomeCare · lib/customerLine.js) ----------

const CHAT_ADMIN = 'https://chat.kinorigin.com/admin/conversations';

familyRouter.get(
  '/cases/:caseId/customer-line',
  asyncRoute(async (req, res) => {
    await family.ensureFamilyTable();
    const row = await lineForCase(req.params.caseId);
    res.set('Cache-Control', 'no-store');
    res.json(
      row
        ? { ...row, chat_url: row.chat_conversation_id ? `${CHAT_ADMIN}/${row.chat_conversation_id}` : null }
        : { has_line: false },
    );
  }),
);

/** ผูก LINE ลูกค้าเป็นญาติคนแรก (ไม่ต้องส่งรหัส) — ต้องติ๊กยินยอมเหมือนการเชิญ */
familyRouter.post(
  '/cases/:caseId/customer-line',
  asyncRoute(async (req, res) => {
    inviteSchema.parse(req.body ?? {});
    await family.ensureFamilyTable();
    const r = await family.linkCustomerLine(req.params.caseId, req.user.name);
    if (!r.ok) {
      const msg = { no_line: 'ลูกค้าเคสนี้ยังไม่ได้ผูก LINE', already: 'LINE นี้ดูการดูแลเคสนี้อยู่แล้ว', full: `ครบ ${family.FAMILY_MAX_PER_CASE} คนแล้ว` };
      throw new ApiError(409, msg[r.reason]);
    }
    res.status(201).json(r);
  }),
);

// ---------- ไทม์ไลน์เคส (แบบ 3) — ทีมอ่าน/ตอบ/ซ่อนข้อความของญาติ ----------

familyRouter.get(
  '/cases/:caseId/messages',
  asyncRoute(async (req, res) => {
    await family.ensureFamilyTable();
    res.set('Cache-Control', 'no-store');
    res.json(await family.messagesFor(req.params.caseId, 100));
  }),
);

const teamPostSchema = z.object({
  body: z.string().trim().max(1000).optional().nullable(),
  image: imageSchema.optional().nullable(),
});

/** ทีมโพสต์ข้อความ/รูปถึงญาติทุกคนของเคส — ขึ้นชื่อผู้โพสต์ + "ทีม KIN HomeCare" */
familyRouter.post(
  '/cases/:caseId/messages',
  asyncRoute(async (req, res) => {
    const { body, image } = teamPostSchema.parse(req.body ?? {});
    let photo = null;
    if (image) {
      try {
        photo = decodeImage(image);
      } catch (err) {
        throw new ApiError(400, err.message);
      }
    }
    if (!body && !photo) throw new ApiError(400, 'กรุณาพิมพ์ข้อความหรือแนบรูป');
    await family.ensureFamilyTable();
    const row = await family.postMessage(req.params.caseId, {
      kind: 'team', name: `${req.user.name} · ทีม KIN HomeCare`, employeeId: req.user.employee_id, body, photo,
    });
    res.status(201).json(row);
  }),
);

familyRouter.delete(
  '/cases/:caseId/messages/:messageId',
  asyncRoute(async (req, res) => {
    await family.ensureFamilyTable();
    if (!(await family.hideMessage(req.params.caseId, Number(req.params.messageId)))) throw notFound('ไม่พบข้อความนี้');
    res.json({ ok: true });
  }),
);

familyRouter.get(
  '/cases/:caseId/messages/:messageId/photo',
  asyncRoute(async (req, res, next) => {
    // เส้นเดียวในกลุ่มนี้ที่ลืมเรียก ensureFamilyTable — บนฐานใหม่/หลังล้างข้อมูล รูปแรกที่กดเปิด
    // จะได้ 500 "relation case_family_messages does not exist" แทน 404 (ตรวจรอบ 10A)
    await family.ensureFamilyTable();
    const row = await family.messagePhoto(req.params.caseId, Number(req.params.messageId));
    if (!row) return next(notFound('ไม่พบรูป'));
    res.setHeader('Content-Type', row.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.data);
  }),
);

familyRouter.delete(
  '/cases/:caseId/links/:linkId',
  asyncRoute(async (req, res) => {
    await family.ensureFamilyTable();
    const n = await family.revoke(req.params.caseId, Number(req.params.linkId));
    if (!n) throw notFound('ไม่พบรายการนี้');
    res.json({ ok: true });
  }),
);
