import { createHash } from 'node:crypto';
import { Router, raw } from 'express';
import * as repo from './repo.js';
import { invoiceIdForToken, publicInvoice } from './share.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

/**
 * GET /api/public/bill/:token — ลิงก์ดูใบแจ้งหนี้/ใบเสร็จที่ส่งเข้า LINE ลูกค้า (ดร.ธงชัย 24 ต.ค. 2569 ข้อ 4)
 * ไม่มี login · token สุ่ม 24 ไบต์ (เก็บแค่ hash) อายุ 6 เดือน · ใบที่ถูกยกเลิก/ลบภายหลัง = เปิดไม่ได้
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

const slipHits = new Map(); // เพดานแยกตาม token — ไม่ให้ผู้ถือ link ยิงรูปถี่เกิน 10 ครั้ง/วัน
const tokenKey = (token) => createHash('sha256').update(String(token)).digest('hex');
function limitSlipPerToken(req, res, next) {
  const key = tokenKey(req.params.token);
  const day = new Date().toISOString().slice(0, 10);
  const h = slipHits.get(key);
  if (!h || h.day !== day) slipHits.set(key, { day, n: 1 });
  else if (++h.n > 10) return res.status(429).json({ error: 'แนบสลิปครบ 10 ครั้งสำหรับวันนี้แล้ว กรุณาส่งในแชท LINE KIN HomeCare ค่ะ' });
  if (slipHits.size > 10000) slipHits.clear();
  next();
}

function validateImage(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ApiError(400, 'กรุณาเลือกรูปสลิป');
  if (buffer.length > 8 * 1024 * 1024) throw new ApiError(413, 'รูปสลิปต้องมีขนาดไม่เกิน 8 MB');
  const jpg = mime === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = mime === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = mime === 'image/webp' && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!jpg && !png && !webp) throw new ApiError(400, 'รับเฉพาะรูป JPG, PNG หรือ WEBP เท่านั้น');
  return { data: buffer, mime, size: buffer.length };
}

/** multipart ช่อง file เพียงช่องเดียว — ไม่เพิ่ม dependency และไม่เขียนไฟล์ชั่วคราวลงดิสก์ */
function multipartImage(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary || boundary.length > 200) throw new ApiError(400, 'ข้อมูลไฟล์ไม่ถูกรูปแบบ');
  const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd < 0) throw new ApiError(400, 'ข้อมูลไฟล์ไม่ถูกรูปแบบ');
  const headers = buffer.subarray(0, headerEnd).toString('utf8');
  if (!/content-disposition:[^\r\n]*name="file"/i.test(headers)) throw new ApiError(400, 'กรุณาเลือกรูปสลิป');
  const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
  const start = headerEnd + 4;
  const end = buffer.indexOf(Buffer.from(`\r\n--${boundary}`), start);
  if (end < start) throw new ApiError(400, 'ข้อมูลไฟล์ไม่ถูกรูปแบบ');
  return validateImage(buffer.subarray(start, end), mime);
}

publicBillRouter.get(
  '/:token',
  asyncRoute(async (req, res) => {
    const id = await invoiceIdForToken(req.params.token);
    const inv = id ? await repo.findById(id) : null;
    /* ใบที่ถูกยกเลิก "หลังจาก" ส่งลิงก์ไปแล้วยังเปิดได้ แต่หน้าเอกสารขึ้นว่ายกเลิกแล้ว (ตรวจรอบ 13)
       เดิมปิดตาย 404 — ลูกค้าที่โอนเงินมาจริงแล้วถือลิงก์ใบเสร็จไว้ พอทีมยกเลิกใบ
       (ออกใบผิด · ตกลงยอดใหม่ · คืนเงินบางส่วน) ลิงก์เดิมขึ้น "หมดอายุ" ทันที
       = ลูกค้าไม่เหลือหลักฐานการจ่ายสักอย่าง ทั้งที่เงินยังอยู่กับบริษัท
       ปิดบังไม่ได้ช่วยใคร — บอกตรง ๆ ว่ายกเลิกแล้วและให้เห็นงวดที่จ่ายมาดีกว่า
       (ใบร่างยังเปิดไม่ได้เหมือนเดิม — ไม่เคยมี token ของใบร่างอยู่แล้ว ส่งได้เฉพาะ issued/paid) */
    if (!inv || !['issued', 'paid', 'cancelled'].includes(inv.status)) {
      throw notFound('ลิงก์นี้หมดอายุแล้ว — สอบถามทีม KIN HomeCare ในแชท LINE ได้เลยค่ะ');
    }
    res.set('Cache-Control', 'no-store');
    res.json(publicInvoice(inv));
  }),
);

/** ลูกค้าแนบสลิปจากหน้าบิล — เก็บในตารางเดิมเป็น pending เท่านั้น ไม่มีการตัดยอดอัตโนมัติ */
/* ตรวจ token + สถานะใบ "ก่อน" รับไฟล์ 9 MB (ตรวจ Codex 30 ต.ค. 2569 ข้อ 9)
   เดิมอ่าน body ทั้งก้อนก่อนรู้ว่า token ปลอม — ยิง token มั่วพร้อมไฟล์ใหญ่ซ้ำ ๆ ก็กินหน่วยความจำได้ฟรี */
const loadSlipInvoice = asyncRoute(async (req, res, next) => {
  const id = await invoiceIdForToken(req.params.token);
  const inv = id ? await repo.findById(id) : null;
  if (!inv) throw notFound('ลิงก์นี้หมดอายุแล้ว — สอบถามทีม KIN HomeCare ในแชท LINE ได้เลยค่ะ');
  if (inv.status !== 'issued' || !(Number(inv.balance) > 0)) {
    throw new ApiError(409, 'ใบนี้ไม่มียอดค้างที่เปิดรับสลิปแล้วค่ะ');
  }
  req.slipInvoiceId = id;
  next();
});

publicBillRouter.post(
  '/:token/slip',
  limitSlipPerToken,
  loadSlipInvoice,
  raw({ type: 'multipart/form-data', limit: '9mb' }),
  asyncRoute(async (req, res) => {
    const id = req.slipInvoiceId;
    const image = multipartImage(req.body, String(req.headers['content-type'] || ''));
    await repo.addSlip(id, image, null, { status: 'pending', source: 'customer_page', notify: true });
    res.status(201).json({
      ok: true,
      message: 'ได้รับสลิปแล้ว ทีมการเงินจะตรวจและส่งใบเสร็จให้ทาง LINE',
    });
  }),
);
