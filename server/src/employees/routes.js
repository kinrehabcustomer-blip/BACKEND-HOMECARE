import { Router } from 'express';
import * as repo from './repo.js';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  listQuerySchema,
  certificateSchema,
  POSITIONS,
  EMPLOYMENT_TYPES,
  STATUSES,
} from './schema.js';
import { asyncRoute, notFound } from '../lib/errors.js';

export const employeesRouter = Router();

/** ทุก route ที่มี :id จะโหลดพนักงานจาก employee_id (PK) มาก่อน — ไม่มีก็ 404 ตั้งแต่ตรงนี้ */
employeesRouter.param('id', (req, res, next, id) => {
  const employee = repo.findById(id);
  if (!employee) return next(notFound(`ไม่พบพนักงานรหัส ${id}`));
  req.employee = employee;
  next();
});

/** ค่า enum สำหรับให้ฝั่ง React เอาไปทำ dropdown โดยไม่ต้อง hard-code */
employeesRouter.get('/meta', (req, res) => {
  res.json({ positions: POSITIONS, employment_types: EMPLOYMENT_TYPES, statuses: STATUSES });
});

employeesRouter.get('/summary', (req, res) => {
  res.json(repo.summary());
});

employeesRouter.get(
  '/',
  asyncRoute((req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(repo.list(query));
  }),
);

employeesRouter.post(
  '/',
  asyncRoute((req, res) => {
    const input = createEmployeeSchema.parse(req.body);
    const employee = repo.create(input);
    res.status(201).json(employee);
  }),
);

employeesRouter.get('/:id', (req, res) => {
  res.json(repo.findDetailById(req.params.id));
});

employeesRouter.patch(
  '/:id',
  asyncRoute((req, res) => {
    const input = updateEmployeeSchema.parse(req.body);
    res.json(repo.update(req.params.id, input));
  }),
);

/** ค่าเริ่มต้นคือบันทึกลาออก (เก็บประวัติไว้); ?hard=true ถึงจะลบแถวจริง */
employeesRouter.delete(
  '/:id',
  asyncRoute((req, res) => {
    if (req.query.hard === 'true') {
      repo.remove(req.params.id);
      return res.status(204).end();
    }
    res.json(repo.resign(req.params.id, req.body?.resign_date));
  }),
);

employeesRouter.get('/:id/certificates', (req, res) => {
  res.json(repo.certificates.listFor(req.params.id));
});

employeesRouter.post(
  '/:id/certificates',
  asyncRoute((req, res) => {
    const input = certificateSchema.parse(req.body);
    res.status(201).json(repo.certificates.add(req.params.id, input));
  }),
);

employeesRouter.delete(
  '/:id/certificates/:certificateId',
  asyncRoute((req, res, next) => {
    const removed = repo.certificates.remove(req.params.id, Number(req.params.certificateId));
    if (!removed) return next(notFound('ไม่พบใบรับรองนี้'));
    res.status(204).end();
  }),
);
