import { Router } from 'express';
import * as repo from './repo.js';
import * as employees from '../employees/repo.js';
import {
  createCaseSchema,
  updateCaseSchema,
  assignSchema,
  cancelSchema,
  listQuerySchema,
  periodSchema,
  calendarQuerySchema,
  createVisitSchema,
  updateVisitSchema,
  CASE_TYPES,
  CASE_STATUSES,
} from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

export const casesRouter = Router();

// พนักงานที่ลาออก/พักงาน รับเคสใหม่ไม่ได้
const ASSIGNABLE_STATUSES = ['active', 'probation'];

// สถานะปลายทาง — เคสจบไปแล้ว ต้องกด "เปิดเคสใหม่" ก่อนถึงจะจับคู่/เริ่ม/ยกเลิกได้อีก
const TERMINAL_STATUSES = ['closed', 'cancelled'];
const isTerminal = (caseRow) => TERMINAL_STATUSES.includes(caseRow.status);

/** โหลดเคสจาก case_id (PK) ก่อนทุก route ที่มี :id — ไม่มีก็ 404 ตั้งแต่ตรงนี้ */
casesRouter.param('id', (req, res, next, id) => {
  repo
    .findById(id)
    .then((found) => {
      if (!found) return next(notFound(`ไม่พบเคสรหัส ${id}`));
      req.case = found;
      next();
    })
    .catch(next);
});

casesRouter.get('/meta', (req, res) => {
  res.json({ case_types: CASE_TYPES, statuses: CASE_STATUSES });
});

casesRouter.get(
  '/summary',
  asyncRoute(async (req, res) => {
    const period = periodSchema.parse({
      year: req.query.year || undefined,
      month: req.query.month || undefined,
    });
    res.json(await repo.summary(period));
  }),
);

/** ปี/เดือนที่มีเคสอยู่จริง — ให้หน้าเว็บเอาไปทำ dropdown เลือกช่วงเวลา */
casesRouter.get(
  '/periods',
  asyncRoute(async (req, res) => res.json(await repo.periods())),
);

/** ตารางงานรายเดือน — เคสที่ช่วงวันให้บริการคาบเกี่ยวเดือนที่ขอ (ต้องมาก่อน '/:id') */
casesRouter.get(
  '/calendar',
  asyncRoute(async (req, res) => {
    const period = calendarQuerySchema.parse({
      year: req.query.year,
      month: req.query.month,
      employee_id: req.query.employee_id || undefined,
    });
    res.json(await repo.calendar(period));
  }),
);

/** รายชื่อพนักงานที่รับเคสได้ พร้อมจำนวนเคสที่ถืออยู่ — ให้ dropdown จับคู่ใช้ */
casesRouter.get(
  '/assignable-employees',
  asyncRoute(async (req, res) => res.json(await repo.assignableEmployees())),
);

casesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await repo.list(query));
  }),
);

casesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createCaseSchema.parse(req.body);
    if (input.assigned_to) await ensureAssignable(input.assigned_to);

    res.status(201).json(await repo.create(input));
  }),
);

casesRouter.get('/:id', (req, res) => res.json(req.case));

casesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const input = updateCaseSchema.parse(req.body);
    res.json(await repo.update(req.params.id, input));
  }),
);

/** จับคู่พนักงานกับเคส */
casesRouter.post(
  '/:id/assign',
  asyncRoute(async (req, res) => {
    const { employee_id } = assignSchema.parse(req.body);

    if (isTerminal(req.case)) {
      throw new ApiError(409, 'เคสนี้จบไปแล้ว — ต้องเปิดเคสใหม่ก่อนจึงจะจับคู่พนักงานได้');
    }
    await ensureAssignable(employee_id);

    res.json(await repo.assign(req.params.id, employee_id));
  }),
);

/** ยกเลิกการจับคู่ — เคสกลับไปเป็น 'ยังไม่จับคู่พนักงาน' */
casesRouter.post(
  '/:id/unassign',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
    res.json(await repo.unassign(req.params.id));
  }),
);

/** เริ่มให้บริการ — ต้องจับคู่พนักงานแล้วเท่านั้น */
casesRouter.post(
  '/:id/start',
  asyncRoute(async (req, res) => {
    if (req.case.status === 'in_progress') throw new ApiError(409, 'เคสนี้กำลังให้บริการอยู่แล้ว');
    if (req.case.status !== 'assigned') {
      throw new ApiError(409, 'ต้องจับคู่พนักงานให้เรียบร้อยก่อนจึงจะเริ่มให้บริการได้');
    }
    res.json(await repo.start(req.params.id));
  }),
);

casesRouter.post(
  '/:id/close',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
    res.json(await repo.close(req.params.id, req.body?.end_date));
  }),
);

/** ยกเลิกเคส — ใช้กับเคสที่ไม่ได้เกิดขึ้นจริง/ญาติยกเลิก ต่างจากปิดเคสที่ให้บริการจบตามปกติ */
casesRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
    const { reason } = cancelSchema.parse(req.body ?? {});
    res.json(await repo.cancel(req.params.id, reason));
  }),
);

casesRouter.post(
  '/:id/reopen',
  asyncRoute(async (req, res) => {
    if (!isTerminal(req.case)) throw new ApiError(409, 'เคสนี้ยังไม่ได้ปิดหรือยกเลิก');
    res.json(await repo.reopen(req.params.id));
  }),
);

casesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    await repo.remove(req.params.id);
    res.status(204).end();
  }),
);

// ---------- วันนัดให้บริการของเคส (ลงตารางว่าจะไปวันไหนบ้าง) ----------

casesRouter.get(
  '/:id/visits',
  asyncRoute(async (req, res) => res.json(await repo.listVisits(req.params.id))),
);

casesRouter.post(
  '/:id/visits',
  asyncRoute(async (req, res) => {
    const input = createVisitSchema.parse(req.body);
    res.status(201).json(await repo.addVisit(req.params.id, input));
  }),
);

casesRouter.patch(
  '/:id/visits/:visitId',
  asyncRoute(async (req, res) => {
    const input = updateVisitSchema.parse(req.body);
    res.json(await repo.updateVisit(req.params.id, Number(req.params.visitId), input));
  }),
);

casesRouter.delete(
  '/:id/visits/:visitId',
  asyncRoute(async (req, res) => {
    res.json(await repo.removeVisit(req.params.id, Number(req.params.visitId)));
  }),
);

async function ensureAssignable(employeeId) {
  const employee = await employees.findById(employeeId);
  if (!employee) throw new ApiError(400, `ไม่พบพนักงานรหัส ${employeeId}`);

  if (!ASSIGNABLE_STATUSES.includes(employee.status)) {
    throw new ApiError(
      409,
      `${employee.first_name} ${employee.last_name} รับเคสไม่ได้ เพราะสถานะปัจจุบันคือ "${employee.status}"`,
    );
  }
}
