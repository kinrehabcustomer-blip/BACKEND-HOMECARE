import { Router } from 'express';
import * as repo from './repo.js';
import {
  createRunSchema,
  payRunSchema,
  previewQuerySchema,
  listQuerySchema,
  employeeCasesQuerySchema,
  PAYROLL_STATUSES,
} from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';
import { canSeeStaffPay } from '../lib/auth.js';
import * as cases from '../cases/repo.js';

export const payrollRouter = Router();

/** วันนี้ตามเวลาไทย — เกณฑ์เดียวกับทั้งระบบ (ดูหมายเหตุเรื่อง UTC ใน db/schema.sql) */
const TODAY = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);

/** รอบที่ยังปรับได้ = ร่างเท่านั้น · จ่ายแล้ว/ยกเลิกแล้วต้องยกเลิกก่อนถึงจะแตะได้ */
const editable = (run) => run.status === 'draft';

payrollRouter.param('id', (req, res, next, id) => {
  repo
    .findById(id)
    .then((found) => {
      if (!found) return next(notFound(`ไม่พบรอบจ่ายรหัส ${id}`));
      req.run = found;
      next();
    })
    .catch(next);
});

payrollRouter.get('/meta', (req, res) => res.json({ statuses: PAYROLL_STATUSES }));

/**
 * คิวค่าจ้าง — เคสที่มีเงินให้จัดการ พร้อมสถานะการปล่อยของแต่ละใบ
 *
 * อยู่ที่โมดูล payroll ไม่ใช่ cases เพราะมันเป็นมุมมองของ "คนทำเรื่องเงิน" ไม่ใช่ของตัวเคสเอง —
 * เคสหนึ่งใบไม่รู้จักคิวนี้ แต่หน้ารอบจ่ายต้องเห็นทุกใบพร้อมกันเพื่อไล่ปล่อยทีเดียวจบ
 * (ต้องอยู่เหนือ '/:id' ไม่งั้นโดนจับเป็นรหัสรอบ — กติกาเดียวกับ '/preview')
 */
/**
 * เคสทั้งหมดที่พนักงานคนหนึ่งลงแรงในเดือนนั้น พร้อมค่าจ้างของแต่ละใบ
 *
 * ที่มาของยอดในแท็บสรุป — ตัวเลขรวมต่อคนตอบได้แค่ว่า "ได้เท่าไหร่" แต่คำถามถัดมาเสมอคือ
 * "มาจากเคสไหนบ้าง" ซึ่งเดิมตอบได้เฉพาะฝั่งพนักงาน (หน้าค่าตอบแทนของฉัน) ส่วนผู้จัดการ
 * ที่ต้องตอบคำถามนี้เวลาถูกถามจริงๆ กลับไม่มีที่ให้กาง
 *
 * ใช้ตัวคำนวณตัวเดียวกับฝั่งพนักงาน (payoutCases) ตัวเลขสองหน้าจึงตรงกันเสมอโดยไม่ต้องคอยไล่ให้ตรง
 */
payrollRouter.get(
  '/employee-cases',
  asyncRoute(async (req, res) => {
    if (!canSeeStaffPay(req.user?.position)) {
      throw new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่ดูค่าจ้างรายเคสได้');
    }
    const { month, employee_id } = employeeCasesQuerySchema.parse(req.query);
    res.json(await cases.payoutCases(month, employee_id));
  }),
);

payrollRouter.get(
  '/case-queue',
  asyncRoute(async (req, res) => {
    if (!canSeeStaffPay(req.user?.position)) {
      throw new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่ดูค่าจ้างของเคสได้');
    }
    res.json(await cases.payQueue());
  }),
);

/**
 * ดูก่อนเปิดรอบว่าจะได้ใครบ้าง เท่าไหร่ — ต้องอยู่เหนือ '/:id' ไม่งั้นโดนจับเป็นรหัสรอบ
 * unreleased_cases = เคสที่ทำงานจบและอนุมัติกะแล้ว แต่ผู้จัดการยังไม่กดปล่อยค่าจ้าง จึงไม่มีอะไรให้กวาด
 * (ต้องเห็นก่อนกดสร้าง ไม่ใช่มารู้ทีหลังว่าทำไมยอดของบางคนหายไป)
 */
payrollRouter.get(
  '/preview',
  asyncRoute(async (req, res) => {
    const { period_to } = previewQuerySchema.parse(req.query);
    const [rows, unreleased] = await Promise.all([
      repo.preview(period_to),
      repo.unreleasedCases(period_to),
    ]);
    res.json({ period_to, rows, unreleased_cases: unreleased });
  }),
);

payrollRouter.get(
  '/',
  asyncRoute(async (req, res) => res.json(await repo.list(listQuerySchema.parse(req.query)))),
);

/**
 * เปิดรอบจ่าย — กรอกแค่วันตัดรอบ ระบบตั้งชื่อรอบ (เดือน + รอบที่) ให้เอง
 * แล้วกวาดค่าจ้างทุกก้อนที่ปล่อยแล้วและยังไม่เคยถูกจ่ายเข้ามา
 */
payrollRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createRunSchema.parse(req.body);

    // ตัดรอบล่วงหน้าไม่ได้ — งานที่ยังไม่เกิดจ่ายไม่ได้ และกะในอนาคตยังไม่มีทางเช็คเอาท์
    if (input.period_to > TODAY()) {
      throw new ApiError(400, 'วันตัดรอบต้องไม่เกินวันนี้');
    }

    /* เดือนหนึ่งแบ่งจ่ายได้ไม่เกิน 3 รอบ (ไม่นับรอบที่ยกเลิก) — บอกให้ชัดว่าตอนนี้กี่รอบแล้ว
       ไม่ใช่แค่ปฏิเสธเฉยๆ ให้คนกดต้องไปนับเอง */
    const month = input.period_to.slice(0, 7);
    const used = await repo.roundsInMonth(month);
    if (used >= 3) {
      throw new ApiError(409, `เดือน ${month} เปิดครบ 3 รอบแล้ว — ถ้าจะเปิดเพิ่มต้องยกเลิกรอบใดรอบหนึ่งก่อน`);
    }

    res.status(201).json(await repo.createRun(input, req.user));
  }),
);

payrollRouter.get('/:id', (req, res) => res.json(req.run));

/** ค่าจ้างทุกก้อนที่อยู่ในสลิปใบหนึ่ง — ที่มาของยอด (หนึ่งบรรทัด = ค่าจ้างหนึ่งก้อนของหนึ่งเคส) */
payrollRouter.get(
  '/:id/items/:itemId/payouts',
  asyncRoute(async (req, res) => {
    const item = await repo.findItem(req.params.itemId);
    if (!item || item.run_id !== req.params.id) throw notFound('ไม่พบสลิปใบนี้ในรอบที่ระบุ');
    res.json(await repo.itemPayouts(req.params.itemId));
  }),
);

/**
 * ดึงยอดใหม่ทั้งรอบ — ใช้ตอนปล่อยค่าจ้างเพิ่มหลังเปิดรอบไปแล้ว
 * ล้างของเดิมทิ้งแล้วกวาดใหม่ทั้งหมด คนที่ถูกเอาออกจากรอบไปก่อนหน้านี้จะกลับมาด้วย
 */
payrollRouter.post(
  '/:id/rebuild',
  asyncRoute(async (req, res) => {
    if (!editable(req.run)) throw new ApiError(409, 'รอบที่จ่าย/ยกเลิกแล้วดึงยอดใหม่ไม่ได้');
    res.json(await repo.rebuild(req.params.id, req.run.period_to));
  }),
);

/**
 * เอาคนออกจากรอบนี้ (ยังไม่จ่ายให้รอบนี้) — ค่าจ้างของเขากลับเข้ากองรอจ่ายทันที
 * จึงไปโผล่ในรอบถัดไปเองโดยไม่ต้องจำ ไม่ใช่การตัดสิทธิ์
 */
payrollRouter.delete(
  '/:id/items/:itemId',
  asyncRoute(async (req, res) => {
    if (!editable(req.run)) throw new ApiError(409, 'รอบที่จ่าย/ยกเลิกแล้วแก้รายชื่อไม่ได้');

    const item = await repo.findItem(req.params.itemId);
    if (!item || item.run_id !== req.params.id) throw notFound('ไม่พบสลิปใบนี้ในรอบที่ระบุ');

    await repo.removeItem(req.params.itemId);
    res.json(await repo.findById(req.params.id));
  }),
);

/** ปิดรอบเป็น "จ่ายแล้ว" — หลังจากนี้ล็อกทั้งรอบ แก้ได้ทางเดียวคือยกเลิกรอบ */
payrollRouter.post(
  '/:id/pay',
  asyncRoute(async (req, res) => {
    if (req.run.status === 'paid') throw new ApiError(409, 'รอบนี้จ่ายไปแล้ว');
    if (req.run.status === 'cancelled') throw new ApiError(409, 'รอบนี้ถูกยกเลิกไปแล้ว');
    if (req.run.employees === 0) {
      throw new ApiError(409, 'รอบนี้ยังไม่มีใครอยู่ในรายการ — ไม่มีอะไรให้จ่าย');
    }

    const input = payRunSchema.parse(req.body ?? {});
    res.json(await repo.pay(req.params.id, { ...input, pay_date: input.pay_date ?? TODAY() }, req.user));
  }),
);

/**
 * ยกเลิกรอบ — รอบยังอยู่เป็นประวัติ แต่ค่าจ้างทุกก้อนกลับเข้ากองรอจ่าย
 * ใช้กับรอบที่จ่ายผิด/จ่ายไม่ครบด้วย: ก้อนที่ถูกปลดจะไปโผล่ในรอบถัดไปเอง ไม่มีทางตกหล่น
 */
payrollRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    if (req.run.status === 'cancelled') throw new ApiError(409, 'รอบนี้ถูกยกเลิกไปแล้ว');
    res.json(await repo.cancel(req.params.id));
  }),
);

/**
 * ลบรอบทิ้งถาวร — ได้เฉพาะรอบร่างที่ยังไม่เคยจ่าย
 * รอบที่จ่ายไปแล้วเป็นหลักฐานว่าเงินออกจากบริษัทจริง ต้อง "ยกเลิก" เพื่อให้เหลือประวัติไว้
 */
payrollRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    if (!editable(req.run)) {
      throw new ApiError(409, 'รอบที่จ่าย/ยกเลิกแล้วลบทิ้งไม่ได้ — ใช้ "ยกเลิกรอบ" แทน');
    }
    await repo.remove(req.params.id);
    res.status(204).end();
  }),
);
