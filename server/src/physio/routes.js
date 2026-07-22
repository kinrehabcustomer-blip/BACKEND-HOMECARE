import { Router } from 'express';
import * as repo from './repo.js';
import { physioPackageSchema, physioPackageUpdateSchema, reorderSchema } from './schema.js';
import { asyncRoute, notFound } from '../lib/errors.js';

export const physioRouter = Router();

physioRouter.get(
  '/packages',
  asyncRoute(async (req, res) => res.json(await repo.listPackages())),
);

physioRouter.post(
  '/packages',
  asyncRoute(async (req, res) =>
    res.status(201).json(await repo.createPackage(physioPackageSchema.parse(req.body))),
  ),
);

physioRouter.get(
  '/packages/:id',
  asyncRoute(async (req, res) => {
    const pkg = await repo.findPackage(req.params.id);
    if (!pkg) throw notFound(`ไม่พบแพ็คเกจรหัส ${req.params.id}`);
    res.json(pkg);
  }),
);

physioRouter.patch(
  '/packages/:id',
  asyncRoute(async (req, res) => {
    const pkg = await repo.findPackage(req.params.id);
    if (!pkg) throw notFound(`ไม่พบแพ็คเกจรหัส ${req.params.id}`);

    // ไม่ต้องเทียบราคาเดิม/ราคาพิเศษที่ชั้นนี้แล้ว — repo คิดราคาสุทธิจาก (ราคาเต็ม − ส่วนลด) ให้เสมอ
    // จึงเป็นไปไม่ได้ที่ราคาสุทธิจะแพงกว่าราคาเต็ม ไม่ว่าหน้าเว็บจะส่งอะไรมา
    res.json(await repo.updatePackage(req.params.id, physioPackageUpdateSchema.parse(req.body)));
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
    res.json(await repo.reorderPackages(order));
  }),
);
