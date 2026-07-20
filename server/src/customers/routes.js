import { Router } from 'express';
import * as repo from './repo.js';
import { createCustomerSchema, updateCustomerSchema, listQuerySchema } from './schema.js';
import { asyncRoute, notFound } from '../lib/errors.js';

export const customersRouter = Router();

/** ทุก route ที่มี :id โหลดลูกค้าจาก customer_id (PK) ก่อน — ไม่มีก็ 404 ตั้งแต่ตรงนี้ */
customersRouter.param('id', (req, res, next, id) => {
  repo
    .findById(id)
    .then((customer) => {
      if (!customer) return next(notFound(`ไม่พบลูกค้ารหัส ${id}`));
      req.customer = customer;
      next();
    })
    .catch(next);
});

customersRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await repo.list(query));
  }),
);

customersRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createCustomerSchema.parse(req.body);
    res.status(201).json(await repo.create(input));
  }),
);

customersRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json(await repo.findDetailById(req.params.id));
  }),
);

customersRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const input = updateCustomerSchema.parse(req.body);
    res.json(await repo.update(req.params.id, input));
  }),
);

/** ลบลูกค้า — เคสที่เคยให้บริการยังอยู่ครบ (ข้อมูลผู้ป่วยถูกคัดลอกไว้ในเคสแล้ว) */
customersRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    await repo.remove(req.params.id);
    res.status(204).end();
  }),
);
