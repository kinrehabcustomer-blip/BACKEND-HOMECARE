import { Router } from 'express';
import * as repo from './repo.js';
import {
  gradeSchema,
  gradeUpdateSchema,
  formatSchema,
  formatUpdateSchema,
  ratesSchema,
  STAFF_TIERS,
  FORMAT_CATEGORIES,
} from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

/* ลบเกรด/รูปแบบที่มีเคสใช้อยู่ไม่ได้ (ตรวจรอบ 6 พ.ย. 2569) — กติกาเดียวกับแพ็กกายภาพ (physio/routes.js)
   เปลี่ยนชื่อ/ราคา/ลำดับยังทำได้ตามปกติ เพราะเคสเก็บราคาไว้ที่ตัวเองแล้ว */
const inUse = (what, n) =>
  new ApiError(
    409,
    `${what}มีเคสใช้อยู่ ${n} เคส (นับรวมเคสที่ปิดแล้ว) ลบไม่ได้ — ลบแล้วเคสเก่าจะไม่เหลือข้อมูลบริการ` +
      ' และใบแจ้งหนี้ของเคสเหล่านั้นจะขึ้นว่าไม่ตรงทั้งหมด · ถ้าเลิกขายแล้ว ให้คงไว้แล้วเปลี่ยนชื่อแทน (เช่น เติม "(เลิกขาย)" ท้ายชื่อ)',
  );
import { canSeeStaffPay, stripPayFields } from '../lib/auth.js';
import { refreshCasePrices } from '../cases/priceRefresh.js';

export const packagesRouter = Router();

packagesRouter.get('/meta', (req, res) => {
  res.json({ staff_tiers: STAFF_TIERS, categories: FORMAT_CATEGORIES });
});

/**
 * ตารางเรททั้งหมด (เกรด + รูปแบบ + ราคา) — หน้าเว็บดึงชุดเดียวไปประกอบตาราง
 *
 * ไม่ใช่ผู้จัดการ = ได้ราคาลูกค้าครบ แต่ไม่มีค่าจ้าง/กำไรติดไปด้วย
 * การเปิดเคสไม่พังเพราะไม่มีค่าจ้างในชุดนี้ — repo ของเคสเติม staff_pay เองจาก pkg_rates ฝั่ง server
 * เมื่อหน้าเว็บไม่ได้ส่งมา (ดู payFromService ใน cases/repo.js)
 */
packagesRouter.get(
  '/matrix',
  asyncRoute(async (req, res) => {
    const matrix = await repo.getMatrix();
    if (canSeeStaffPay(req.user?.position)) return res.json(matrix);
    res.json({ ...matrix, rates: matrix.rates.map(stripPayFields) });
  }),
);

// ---------- เกรด ----------
packagesRouter.post(
  '/grades',
  asyncRoute(async (req, res) => res.status(201).json(await repo.createGrade(gradeSchema.parse(req.body)))),
);

packagesRouter.patch(
  '/grades/:id',
  asyncRoute(async (req, res) => {
    const grade = await repo.findGrade(req.params.id);
    if (!grade) throw notFound(`ไม่พบเกรดรหัส ${req.params.id}`);
    res.json(await repo.updateGrade(req.params.id, gradeUpdateSchema.parse(req.body)));
  }),
);

packagesRouter.delete(
  '/grades/:id',
  asyncRoute(async (req, res) => {
    const n = await repo.casesUsingGrade(req.params.id);
    if (n > 0) throw inUse('เกรดนี้', n);
    await repo.removeGrade(req.params.id);
    res.status(204).end();
  }),
);

// ---------- รูปแบบบริการ ----------
packagesRouter.post(
  '/formats',
  asyncRoute(async (req, res) => res.status(201).json(await repo.createFormat(formatSchema.parse(req.body)))),
);

packagesRouter.patch(
  '/formats/:id',
  asyncRoute(async (req, res) => {
    const format = await repo.findFormat(req.params.id);
    if (!format) throw notFound(`ไม่พบรูปแบบบริการรหัส ${req.params.id}`);
    res.json(await repo.updateFormat(req.params.id, formatUpdateSchema.parse(req.body)));
  }),
);

packagesRouter.delete(
  '/formats/:id',
  asyncRoute(async (req, res) => {
    const n = await repo.casesUsingFormat(req.params.id);
    if (n > 0) throw inUse('รูปแบบบริการนี้', n);
    await repo.removeFormat(req.params.id);
    res.status(204).end();
  }),
);

// ---------- ราคา (bulk upsert) — คืนตารางเรทใหม่ทั้งชุด ----------
packagesRouter.patch(
  '/rates',
  asyncRoute(async (req, res) => {
    const { rates } = ratesSchema.parse(req.body);
    const seePay = canSeeStaffPay(req.user?.position);

    /* คนที่ไม่เห็นค่าจ้างต้องแก้ค่าจ้างไม่ได้ด้วย — ถอดคีย์ทิ้งก่อนส่งเข้า repo
       ไม่ใช่แค่กันเจตนาไม่ดี แต่กันอุบัติเหตุตรงๆ: หน้าเว็บของคนกลุ่มนี้ไม่มีช่องค่าจ้าง
       ถ้าปล่อยผ่าน ค่าที่ส่งมาจะเป็นว่างเปล่าแล้วไปล้างค่าจ้างเดิมที่ผู้จัดการตั้งไว้ทิ้งทั้งแถว */
    const safe = seePay ? rates : rates.map(({ staff_pay, ...r }) => r);
    const updated = await repo.upsertRates(safe);
    // แก้ราคา → เคส Homecare ที่เปิดอยู่และขายราคาเดียวกับเรทตามราคาตั้งใหม่ (ดู cases/priceRefresh.js)
    const refreshed = await refreshCasePrices({ homecareRates: true }, req.user);
    res.json({ ...(seePay ? updated : { ...updated, rates: updated.rates.map(stripPayFields) }), refreshed });
  }),
);
