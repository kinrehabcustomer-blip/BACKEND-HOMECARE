import { Router } from 'express';
import * as repo from './repo.js';
import { createPatientSchema, updatePatientSchema, listQuerySchema } from './schema.js';
import { asyncRoute, notFound } from '../lib/errors.js';

export const patientsRouter = Router();

/** ทุก route ที่มี :id โหลดผู้ป่วยจาก patient_id (PK) ก่อน — ไม่มีก็ 404 ตั้งแต่ตรงนี้ */
patientsRouter.param('id', (req, res, next, id) => {
  repo
    .findById(id)
    .then((patient) => {
      if (!patient) return next(notFound(`ไม่พบผู้รับการดูแลรหัส ${id}`));
      req.patient = patient;
      next();
    })
    .catch(next);
});

patientsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await repo.list(query));
  }),
);

patientsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createPatientSchema.parse(req.body);
    res.status(201).json(await repo.create(input));
  }),
);

patientsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json(await repo.findDetailById(req.params.id));
  }),
);

patientsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const input = updatePatientSchema.parse(req.body);
    res.json(await repo.update(req.params.id, input));
  }),
);

/** ลบผู้ป่วย — เคสที่เคยให้บริการยังอยู่ครบ (ข้อมูลผู้ป่วยถูกคัดลอกไว้ในเคสแล้ว) */
patientsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    await repo.remove(req.params.id);
    res.status(204).end();
  }),
);
