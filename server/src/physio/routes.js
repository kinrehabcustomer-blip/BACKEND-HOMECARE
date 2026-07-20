import { Router } from 'express';
import * as repo from './repo.js';
import { physioPackageSchema, physioPackageUpdateSchema, reorderSchema } from './schema.js';
import { asyncRoute, badRequest, notFound } from '../lib/errors.js';

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

    // แก้ราคามาแค่ช่องเดียวก็ยังต้องเทียบกับอีกช่องที่อยู่ใน DB
    // (refine ใน schema เห็นแค่ payload จึงจับกรณีนี้ไม่ได้ เช่น ส่งมาแต่ special_price ที่แพงกว่าราคาเดิมเดิม)
    const patch = physioPackageUpdateSchema.parse(req.body);
    const merged = { ...pkg, ...patch };
    if (merged.original_price != null && merged.original_price < merged.special_price) {
      throw badRequest('ราคารวมเดิมต้องไม่น้อยกว่าราคาพิเศษ', [
        { field: 'original_price', message: `ราคาเดิม ${merged.original_price} < ราคาพิเศษ ${merged.special_price}` },
      ]);
    }
    res.json(await repo.updatePackage(req.params.id, patch));
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
