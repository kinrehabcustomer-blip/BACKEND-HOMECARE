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
import { asyncRoute, notFound } from '../lib/errors.js';

export const packagesRouter = Router();

packagesRouter.get('/meta', (req, res) => {
  res.json({ staff_tiers: STAFF_TIERS, categories: FORMAT_CATEGORIES });
});

/** ตารางเรททั้งหมด (เกรด + รูปแบบ + ราคา) — หน้าเว็บดึงชุดเดียวไปประกอบตาราง */
packagesRouter.get(
  '/matrix',
  asyncRoute(async (req, res) => res.json(await repo.getMatrix())),
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
    await repo.removeFormat(req.params.id);
    res.status(204).end();
  }),
);

// ---------- ราคา (bulk upsert) — คืนตารางเรทใหม่ทั้งชุด ----------
packagesRouter.patch(
  '/rates',
  asyncRoute(async (req, res) => {
    const { rates } = ratesSchema.parse(req.body);
    res.json(await repo.upsertRates(rates));
  }),
);
