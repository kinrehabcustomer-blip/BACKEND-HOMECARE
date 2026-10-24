import { Router } from 'express';
import * as repo from './repo.js';
import { invoiceIdForToken, publicInvoice } from './share.js';
import { asyncRoute, notFound } from '../lib/errors.js';

/**
 * GET /api/public/bill/:token — ลิงก์ดูใบแจ้งหนี้/ใบเสร็จที่ส่งเข้า LINE ลูกค้า (ดร.ธงชัย 24 ต.ค. 2569 ข้อ 4)
 * ไม่มี login · token สุ่ม 24 ไบต์ (เก็บแค่ hash) อายุ 90 วัน · ใบที่ถูกยกเลิก/ลบภายหลัง = เปิดไม่ได้
 * เห็นเฉพาะเนื้อหาที่พิมพ์บนเอกสารของลูกค้าอยู่แล้ว (publicInvoice) — ไม่มีสลิป ข้อมูลเคส หรือข้อมูลภายใน
 */
export const publicBillRouter = Router();

const hits = new Map(); // เพดานกันไล่เดา token — 60 ครั้ง/นาที/IP
publicBillRouter.use((req, res, next) => {
  const ip = req.ip || 'x';
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60000) hits.set(ip, { t: now, n: 1 });
  else if (++h.n > 60) return res.status(429).json({ error: 'เรียกถี่เกินไป ลองใหม่ในอีกสักครู่' });
  if (hits.size > 5000) hits.clear();
  next();
});

publicBillRouter.get(
  '/:token',
  asyncRoute(async (req, res) => {
    const id = await invoiceIdForToken(req.params.token);
    const inv = id ? await repo.findById(id) : null;
    if (!inv || !['issued', 'paid'].includes(inv.status)) throw notFound('ลิงก์นี้หมดอายุหรือเอกสารถูกยกเลิกแล้ว — สอบถามทีม KIN HomeCare ในแชท LINE ได้เลยค่ะ');
    res.set('Cache-Control', 'no-store');
    res.json(publicInvoice(inv));
  }),
);
