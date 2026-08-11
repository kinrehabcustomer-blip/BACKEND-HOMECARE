import { Router } from 'express';
import * as repo from './repo.js';
import { physioPackageSchema, physioPackageUpdateSchema, reorderSchema } from './schema.js';
import { asyncRoute, notFound } from '../lib/errors.js';
import { canSeeStaffPay, stripPayFields } from '../lib/auth.js';

export const physioRouter = Router();

/* ค่าจ้างพนักงาน/กำไร = เฉพาะผู้จัดการ (HR เข้าหน้านี้ได้แต่เห็นเฉพาะราคาที่ขายลูกค้า)
   ตัดที่ payload ทุกเส้นที่คืนแพ็คเกจ ไม่ใช่แค่เส้นที่หน้ารายการเรียก — เส้นเดียวที่ลืมคือรูรั่ว */
const seePay = (req) => canSeeStaffPay(req.user?.position);
const visible = (req, pkg) => (seePay(req) ? pkg : stripPayFields(pkg));
const visibleAll = (req, list) => (seePay(req) ? list : list.map(stripPayFields));

/** ค่าจ้างที่ส่งมาจากคนที่ไม่มีสิทธิ์เห็น ต้องไม่ถูกเขียนลงไป — ถอดคีย์ทิ้ง ของเดิมจึงอยู่ครบ */
const guardPay = (req, input) => {
  if (seePay(req)) return input;
  const { staff_pay, ...rest } = input;
  return rest;
};

physioRouter.get(
  '/packages',
  asyncRoute(async (req, res) => res.json(visibleAll(req, await repo.listPackages()))),
);

physioRouter.post(
  '/packages',
  asyncRoute(async (req, res) => {
    const input = guardPay(req, physioPackageSchema.parse(req.body));
    res.status(201).json(visible(req, await repo.createPackage(input)));
  }),
);

physioRouter.get(
  '/packages/:id',
  asyncRoute(async (req, res) => {
    const pkg = await repo.findPackage(req.params.id);
    if (!pkg) throw notFound(`ไม่พบแพ็คเกจรหัส ${req.params.id}`);
    res.json(visible(req, pkg));
  }),
);

physioRouter.patch(
  '/packages/:id',
  asyncRoute(async (req, res) => {
    const pkg = await repo.findPackage(req.params.id);
    if (!pkg) throw notFound(`ไม่พบแพ็คเกจรหัส ${req.params.id}`);

    // ไม่ต้องเทียบราคาเดิม/ราคาพิเศษที่ชั้นนี้แล้ว — repo คิดราคาสุทธิจาก (ราคาเต็ม − ส่วนลด) ให้เสมอ
    // จึงเป็นไปไม่ได้ที่ราคาสุทธิจะแพงกว่าราคาเต็ม ไม่ว่าหน้าเว็บจะส่งอะไรมา
    const input = guardPay(req, physioPackageUpdateSchema.parse(req.body));
    res.json(visible(req, await repo.updatePackage(req.params.id, input)));
  }),
);

physioRouter.delete(
  '/packages/:id',
  asyncRoute(async (req, res) => {
    await repo.removePackage(req.params.id);
    res.status(204).end();
  }),
);

// จัดลำดับใหม่ — คืนรายการทั้งชุดที่เรียงแล้ว
physioRouter.patch(
  '/reorder',
  asyncRoute(async (req, res) => {
    const { order } = reorderSchema.parse(req.body);
    res.json(visibleAll(req, await repo.reorderPackages(order)));
  }),
);
