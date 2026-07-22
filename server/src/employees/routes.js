import { Router } from 'express';
import * as repo from './repo.js';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  listQuerySchema,
  certificateSchema,
  certificateImageSchema,
  employeePhotoSchema,
  decodeImage,
  portfolioSchema,
  portfolioUpdateSchema,
  POSITIONS,
  EMPLOYMENT_TYPES,
  STATUSES,
} from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

export const employeesRouter = Router();

/** รูปไม่ถูกต้องคือความผิดของผู้ส่ง (400) ไม่ใช่ระบบพัง (500) */
function toImage(dataUrl) {
  if (!dataUrl) return null;
  try {
    return decodeImage(dataUrl);
  } catch (err) {
    throw new ApiError(400, err.message);
  }
}

/** ทุก route ที่มี :id จะโหลดพนักงานจาก employee_id (PK) มาก่อน — ไม่มีก็ 404 ตั้งแต่ตรงนี้ */
employeesRouter.param('id', (req, res, next, id) => {
  repo
    .findById(id)
    .then((employee) => {
      if (!employee) return next(notFound(`ไม่พบพนักงานรหัส ${id}`));
      req.employee = employee;
      next();
    })
    .catch(next);
});

/** ค่า enum สำหรับให้ฝั่ง React เอาไปทำ dropdown โดยไม่ต้อง hard-code */
employeesRouter.get('/meta', (req, res) => {
  res.json({ positions: POSITIONS, employment_types: EMPLOYMENT_TYPES, statuses: STATUSES });
});

employeesRouter.get(
  '/summary',
  asyncRoute(async (req, res) => {
    res.json(await repo.summary());
  }),
);

employeesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await repo.list(query));
  }),
);

employeesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createEmployeeSchema.parse(req.body);
    const employee = await repo.create(input);
    res.status(201).json(employee);
  }),
);

employeesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json(await repo.findDetailById(req.params.id));
  }),
);

employeesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const input = updateEmployeeSchema.parse(req.body);
    res.json(await repo.update(req.params.id, input));
  }),
);

/** ค่าเริ่มต้นคือบันทึกลาออก (เก็บประวัติไว้); ?hard=true ถึงจะลบแถวจริง */
employeesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    if (req.query.hard === 'true') {
      await repo.remove(req.params.id);
      return res.status(204).end();
    }
    res.json(await repo.resign(req.params.id, req.body?.resign_date));
  }),
);

// ---------- รูปพนักงาน ----------

/** แนบรูปทับของเดิม หรือส่ง image: null มาเพื่อลบรูปทิ้ง — คืนข้อมูลพนักงานที่อัปเดตแล้ว */
employeesRouter.put(
  '/:id/photo',
  asyncRoute(async (req, res) => {
    const { image } = employeePhotoSchema.parse(req.body);
    res.json(await repo.photo.set(req.params.id, toImage(image)));
  }),
);

/** ส่งไฟล์รูปออกไปตรงๆ — แท็ก <img> เรียกเส้นนี้ (คุกกี้ session ถูกส่งไปด้วยอัตโนมัติ) */
employeesRouter.get(
  '/:id/photo',
  asyncRoute(async (req, res, next) => {
    const row = await repo.photo.find(req.params.id);
    if (!row) return next(notFound('พนักงานคนนี้ยังไม่มีรูป'));

    res.setHeader('Content-Type', row.photo_mime);
    // เป็นข้อมูลส่วนบุคคล — แคชได้เฉพาะเครื่องผู้ใช้ (private)
    // เปลี่ยนรูปแล้วไม่ค้างรูปเก่า เพราะหน้าเว็บต่อ ?v=updated_at ท้าย URL (ดู api.employeePhotoUrl)
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.photo_data);
  }),
);

employeesRouter.get(
  '/:id/certificates',
  asyncRoute(async (req, res) => {
    res.json(await repo.certificates.listFor(req.params.id));
  }),
);

employeesRouter.post(
  '/:id/certificates',
  asyncRoute(async (req, res) => {
    const { image, ...input } = certificateSchema.parse(req.body);
    const created = await repo.certificates.add(req.params.id, {
      ...input,
      image: toImage(image),
    });
    res.status(201).json(created);
  }),
);

/** แนบรูปทับของเดิม หรือส่ง image: null มาเพื่อลบรูปทิ้ง (ตัวใบรับรองยังอยู่) */
employeesRouter.put(
  '/:id/certificates/:certificateId/image',
  asyncRoute(async (req, res, next) => {
    const { image } = certificateImageSchema.parse(req.body);
    const updated = await repo.certificates.setImage(
      req.params.id,
      Number(req.params.certificateId),
      toImage(image),
    );

    if (!updated) return next(notFound('ไม่พบใบรับรองนี้'));
    res.json(updated);
  }),
);

/** ส่งไฟล์รูปออกไปตรงๆ — แท็ก <img> เรียกเส้นนี้ (คุกกี้ session ถูกส่งไปด้วยอัตโนมัติ) */
employeesRouter.get(
  '/:id/certificates/:certificateId/image',
  asyncRoute(async (req, res, next) => {
    const row = await repo.certificates.findImage(req.params.id, Number(req.params.certificateId));
    if (!row) return next(notFound('ไม่พบรูปของใบรับรองนี้'));

    res.setHeader('Content-Type', row.image_mime);
    // รูปใบรับรองไม่เปลี่ยนบ่อย แต่เป็นข้อมูลส่วนบุคคล — ให้เบราว์เซอร์แคชได้เฉพาะเครื่องผู้ใช้ (private)
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.image_data);
  }),
);

employeesRouter.delete(
  '/:id/certificates/:certificateId',
  asyncRoute(async (req, res, next) => {
    const removed = await repo.certificates.remove(req.params.id, Number(req.params.certificateId));
    if (!removed) return next(notFound('ไม่พบใบรับรองนี้'));
    res.status(204).end();
  }),
);

// ---------- ผลงาน (โปรไฟล์พนักงาน) ----------
employeesRouter.get(
  '/:id/portfolio',
  asyncRoute(async (req, res) => {
    res.json(await repo.portfolio.listFor(req.params.id));
  }),
);

employeesRouter.post(
  '/:id/portfolio',
  asyncRoute(async (req, res) => {
    const { image, ...input } = portfolioSchema.parse(req.body);
    res.status(201).json(await repo.portfolio.add(req.params.id, { ...input, image: toImage(image) }));
  }),
);

/** แก้ชื่อ/คำอธิบายของผลงานที่บันทึกแล้ว (รูปเปลี่ยนไม่ได้ — ลบแล้วอัปโหลดใหม่) */
employeesRouter.patch(
  '/:id/portfolio/:portfolioId',
  asyncRoute(async (req, res, next) => {
    const input = portfolioUpdateSchema.parse(req.body);
    const updated = await repo.portfolio.update(req.params.id, Number(req.params.portfolioId), input);

    if (!updated) return next(notFound('ไม่พบผลงานนี้'));
    res.json(updated);
  }),
);

/** ส่งไฟล์รูปผลงานออกไปตรงๆ — แท็ก <img> เรียกเส้นนี้ */
employeesRouter.get(
  '/:id/portfolio/:portfolioId/image',
  asyncRoute(async (req, res, next) => {
    const row = await repo.portfolio.findImage(req.params.id, Number(req.params.portfolioId));
    if (!row) return next(notFound('ไม่พบรูปผลงานนี้'));

    res.setHeader('Content-Type', row.image_mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.image_data);
  }),
);

employeesRouter.delete(
  '/:id/portfolio/:portfolioId',
  asyncRoute(async (req, res, next) => {
    const removed = await repo.portfolio.remove(req.params.id, Number(req.params.portfolioId));
    if (!removed) return next(notFound('ไม่พบผลงานนี้'));
    res.status(204).end();
  }),
);
