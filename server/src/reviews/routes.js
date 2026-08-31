import { Router } from 'express';
import { createHash } from 'node:crypto';
import * as repo from './repo.js';
import { reviewSubmitSchema } from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

/* กดส่งจากเครื่องเดิมให้คนเดิมซ้ำภายในกี่นาทีถือว่าเป็นการกดซ้ำ ไม่ใช่ใบใหม่
   สั้นๆ พอกันนิ้วลั่น/เน็ตช้าแล้วกดซ้ำ แต่ไม่ขวางญาติอีกคนในบ้านเดียวกันที่จะประเมินต่อ */
const DUPLICATE_WINDOW_MIN = 3;

/* เพดานต่อพนักงานหนึ่งคนต่อ 24 ชม. — นักกายภาพหนึ่งคนไม่ได้เจอญาติ 30 บ้านต่อวัน
   ถึงเพดานแปลว่ามีคนไล่ยิงใบเข้ามา ไม่ใช่ว่างานล้น */
const DAILY_CAP = 30;

/**
 * ลายนิ้วมือของผู้กรอก — ไม่เก็บ IP ดิบลงฐานข้อมูล
 *
 * IP เป็นข้อมูลส่วนบุคคลที่ไม่มีใครในระบบต้องใช้ ที่ต้องการจริงๆ คือ "ใช่เครื่องเดิมไหม"
 * ซึ่ง hash ตอบได้เท่ากัน · ใส่ JWT_SECRET เป็นเกลือ เพื่อไม่ให้ใครที่เห็นฐานข้อมูล
 * ไล่ hash ช่วง IP ทั้งหมดมาเทียบย้อนกลับได้ (ช่วง IPv4 ทั้งโลกไล่ครบได้ในเวลาไม่นาน)
 *
 * บน Vercel คำขอผ่าน proxy เสมอ req.ip จึงเป็น IP ของ proxy ไม่ใช่ของคนกรอก
 * — อ่าน x-forwarded-for ก่อน แล้วค่อยตกมาที่ req.ip ตอนรันบนเครื่องตัวเอง
 */
function fingerprint(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = forwarded || req.ip || 'unknown';
  return createHash('sha256').update(`${ip}|${process.env.JWT_SECRET}`).digest('hex').slice(0, 32);
}

// ==========================================================================
// หน้าฟอร์มสาธารณะ — ไม่ต้อง login ใครถือลิงก์ก็กรอกได้
// ต้องถูก mount ไว้ "ก่อน" reviewsRouter ใน app.js ไม่งั้นด่านสิทธิ์ของฝั่งหลังบ้านจะกินเส้นนี้ไปด้วย
// ==========================================================================
export const publicReviewsRouter = Router();

/** เปิดฟอร์มด้วยลิงก์ — คืนแค่ชื่อพนักงานไว้โชว์บนหัวฟอร์ม ไม่มีข้อมูลอื่นหลุดออกไป */
publicReviewsRouter.get(
  '/:token',
  asyncRoute(async (req, res) => {
    const employee = await repo.findByToken(req.params.token);
    if (!employee) throw notFound('ลิงก์แบบประเมินนี้ใช้ไม่ได้แล้ว — กรุณาขอลิงก์ใหม่จากเจ้าหน้าที่');
    /* ลาออกแล้วยังเปิดรับความเห็นใหม่ไม่ได้ — ค่าเฉลี่ยของคนที่ไม่ได้ทำงานแล้วขยับต่อไม่ได้
       ส่วนใบเก่ายังอยู่ครบ ผู้จัดการยังเปิดดูย้อนหลังได้ตามปกติ */
    if (employee.status === 'resigned') {
      throw notFound('ลิงก์แบบประเมินนี้ปิดรับแล้ว — กรุณาสอบถามเจ้าหน้าที่');
    }
    res.json({ first_name: employee.first_name, last_name: employee.last_name });
  }),
);

publicReviewsRouter.post(
  '/:token',
  asyncRoute(async (req, res) => {
    const employee = await repo.findByToken(req.params.token);
    if (!employee || employee.status === 'resigned') {
      throw notFound('ลิงก์แบบประเมินนี้ใช้ไม่ได้แล้ว — กรุณาขอลิงก์ใหม่จากเจ้าหน้าที่');
    }

    // ตรวจรูปแบบข้อมูลก่อนแตะเพดาน เพื่อให้คนที่กรอกไม่ครบได้ข้อความบอกช่องที่ขาดตามปกติ
    const input = reviewSubmitSchema.parse(req.body);
    const ipHash = fingerprint(req);

    if (await repo.recentDuplicate(employee.employee_id, ipHash, DUPLICATE_WINDOW_MIN)) {
      throw new ApiError(409, 'ระบบได้รับแบบประเมินจากเครื่องนี้แล้ว ขอบคุณมากค่ะ');
    }
    if ((await repo.countRecent(employee.employee_id)) >= DAILY_CAP) {
      throw new ApiError(429, 'วันนี้ระบบรับแบบประเมินของพนักงานท่านนี้ครบแล้ว — กรุณาลองใหม่พรุ่งนี้');
    }

    await repo.submit(employee.employee_id, input, ipHash);
    // ไม่คืนอะไรกลับไปนอกจาก "สำเร็จ" — หน้าสาธารณะไม่ควรได้เลขใบหรือข้อมูลของพนักงานติดมือไป
    res.status(201).json({ ok: true });
  }),
);

// ==========================================================================
// ฝั่งหลังบ้าน — ผู้จัดการ/HR (ด่านสิทธิ์อยู่ที่ app.js)
// ==========================================================================
export const reviewsRouter = Router();

/** คะแนนรวมของทุกคนที่เปิดรับประเมิน — คนที่ยังไม่มีใบก็อยู่ในรายการ (review_count = 0) */
reviewsRouter.get(
  '/summary',
  asyncRoute(async (req, res) => res.json(await repo.summary())),
);

reviewsRouter.get(
  '/employees/:id',
  asyncRoute(async (req, res) => {
    const detail = await repo.employeeDetail(req.params.id);
    if (!detail) throw notFound(`ไม่พบพนักงานรหัส ${req.params.id}`);
    res.json(detail);
  }),
);

/** ลิงก์ปัจจุบัน — ยังไม่เคยออกก็ออกให้ตอนกดดูครั้งแรก จึงไม่มีขั้นตอน "สร้างลิงก์" แยก */
reviewsRouter.get(
  '/employees/:id/link',
  asyncRoute(async (req, res) => {
    const employee = await repo.findEmployee(req.params.id);
    if (!employee) throw notFound(`ไม่พบพนักงานรหัส ${req.params.id}`);
    if (!repo.REVIEW_POSITIONS.includes(employee.position)) {
      throw new ApiError(400, 'ตำแหน่งนี้ยังไม่เปิดใช้แบบประเมินความพึงพอใจ');
    }
    res.json({ token: await repo.ensureToken(req.params.id) });
  }),
);

/** ออกลิงก์ใหม่ — ลิงก์/QR เดิมที่แจกไปแล้วใช้ไม่ได้ทันที */
reviewsRouter.post(
  '/employees/:id/link',
  asyncRoute(async (req, res) => {
    const token = await repo.rotateToken(req.params.id);
    if (!token) throw notFound(`ไม่พบพนักงานรหัส ${req.params.id}`);
    res.json({ token });
  }),
);

reviewsRouter.delete(
  '/entries/:reviewId',
  asyncRoute(async (req, res) => {
    const removed = await repo.removeReview(Number(req.params.reviewId));
    if (!removed) throw notFound('ไม่พบแบบประเมินใบนี้');
    res.status(204).end();
  }),
);
