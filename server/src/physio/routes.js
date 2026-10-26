import { Router } from 'express';
import * as repo from './repo.js';
import { physioPackageSchema, physioPackageUpdateSchema, reorderSchema } from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';
import { canSeeStaffPay, stripPayFields } from '../lib/auth.js';

export const physioRouter = Router();

/* ชื่อแพ็กซ้ำ — บอกให้ชัดว่าซ้ำกับของเดิม ไม่ใช่ 500 (ตรวจรอบ 15 · ดู ensureUniquePackageName)
   ชื่อซ้ำทำให้เจ้าหน้าที่เลือกจาก dropdown ไม่ออกว่าตัวไหนราคาไหน แล้วขายผิดราคา */
const DUP_NAME = (name) => `มีแพ็กชื่อ "${name}" อยู่แล้ว — ตั้งชื่อให้ต่างกันเพื่อไม่ให้เลือกผิดตอนเปิดเคส`;

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
    await repo.ensureUniquePackageName();
    try {
      res.status(201).json(visible(req, await repo.createPackage(input)));
    } catch (err) {
      if (repo.isDuplicateNameError(err)) throw new ApiError(409, DUP_NAME(input.name));
      throw err;
    }
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

    /* "จำนวนครั้ง" ของแพ็กที่ขายไปแล้วแก้ไม่ได้ (ตรวจรอบ 15) — ดู casesUsingPackage ใน repo
       ราคา/ชื่อ/ส่วนลด/ปิดขาย ยังแก้ได้ตามเดิม เพราะราคา snapshot อยู่ที่เคสแล้ว */
    if ('sessions' in input && Number(input.sessions) !== Number(pkg.sessions)) {
      const n = await repo.casesUsingPackage(req.params.id);
      if (n > 0) {
        throw new ApiError(
          409,
          `แพ็กนี้มีเคสใช้อยู่ ${n} เคส — แก้จำนวนครั้งไม่ได้ เพราะลูกค้าที่ซื้อ ${pkg.sessions} ครั้งไปแล้ว` +
            ` จะกลายเป็นมีสิทธิ์ ${input.sessions} ครั้งย้อนหลังทุกราย` +
            ' · ถ้าเงื่อนไขใหม่ ให้สร้างแพ็กใหม่แล้วปิดขายแพ็กเดิม',
        );
      }
    }
    await repo.ensureUniquePackageName();
    try {
      res.json(visible(req, await repo.updatePackage(req.params.id, input)));
    } catch (err) {
      if (repo.isDuplicateNameError(err)) throw new ApiError(409, DUP_NAME(input.name));
      throw err;
    }
  }),
);

physioRouter.delete(
  '/packages/:id',
  asyncRoute(async (req, res) => {
    /* ลบแพ็กที่มีเคสใช้อยู่ไม่ได้ — คอลัมน์เป็น ON DELETE SET NULL เคสเก่าจะไม่เหลือจำนวนครั้ง
       หน้าเคสขึ้น "นัดแล้ว 2 / — ครั้ง" คำนวณคงเหลือไม่ได้อีกเลย (ตรวจรอบ 15) */
    const n = await repo.casesUsingPackage(req.params.id);
    if (n > 0) {
      throw new ApiError(
        409,
        `แพ็กนี้มีเคสใช้อยู่ ${n} เคส ลบไม่ได้ — เคสเก่าจะไม่เหลือจำนวนครั้งที่ลูกค้าซื้อ` +
          ' · ถ้าเลิกขายแล้ว ให้ปิดขาย (เอาเครื่องหมาย "เปิดขาย" ออก) แทนการลบ',
      );
    }
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
