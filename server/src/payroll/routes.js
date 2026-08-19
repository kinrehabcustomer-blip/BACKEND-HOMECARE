import { Router } from 'express';
import * as repo from './repo.js';
import {
  createRunSchema,
  payRunSchema,
  previewQuerySchema,
  listQuerySchema,
  PAYROLL_STATUSES,
} from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

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
 * ดูก่อนเปิดรอบว่าจะได้ใครบ้าง เท่าไหร่ — ต้องอยู่เหนือ '/:id' ไม่งั้นโดนจับเป็นรหัสรอบ
 * unpriced = กะที่อนุมัติแล้วแต่ยังไม่มีค่าจ้าง จึงไม่ถูกกวาดเข้ารอบ (ต้องเห็นก่อนกดสร้าง
 * ไม่ใช่มารู้ทีหลังว่าทำไมยอดของบางคนหายไป)
 */
payrollRouter.get(
  '/preview',
  asyncRoute(async (req, res) => {
    const { period_to } = previewQuerySchema.parse(req.query);
    const [rows, unpriced] = await Promise.all([
      repo.preview(period_to),
      repo.unpricedShifts(period_to),
    ]);
    res.json({ period_to, rows, unpriced_shifts: unpriced });
  }),
);

payrollRouter.get(
  '/',
  asyncRoute(async (req, res) => res.json(await repo.list(listQuerySchema.parse(req.query)))),
);

/**
 * เปิดรอบจ่าย — ระบบกวาดกะที่อนุมัติแล้วและยังไม่เคยถูกจ่ายเข้ามาให้เอง
 *
 * กันรอบซ้ำที่นี่ด้วย ไม่ปล่อยให้ไปชน UNIQUE index แล้วได้ข้อความ "ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว"
 * ซึ่งไม่บอกว่าไปซ้ำกับรอบไหน คนกดต้องไล่หาเอง
 */
payrollRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createRunSchema.parse(req.body);

    const existing = await repo.list({ month: input.period_month });
    const clash = existing.find((r) => r.round_no === input.round_no && r.status !== 'cancelled');
    if (clash) {
      throw new ApiError(
        409,
        `เดือน ${input.period_month} มีรอบที่ ${input.round_no} อยู่แล้ว (${clash.run_id})`,
        { existing_run_id: clash.run_id },
      );
    }

    res.status(201).json(await repo.createRun(input, req.user));
  }),
);

payrollRouter.get('/:id', (req, res) => res.json(req.run));

/** กะทั้งหมดที่อยู่ในสลิปใบหนึ่ง — ที่มาของยอด */
payrollRouter.get(
  '/:id/items/:itemId/visits',
  asyncRoute(async (req, res) => {
    const item = await repo.findItem(req.params.itemId);
    if (!item || item.run_id !== req.params.id) throw notFound('ไม่พบสลิปใบนี้ในรอบที่ระบุ');
    res.json(await repo.itemVisits(req.params.itemId));
  }),
);

/**
 * ดึงกะใหม่ทั้งรอบ — ใช้ตอนอนุมัติกะเพิ่มหลังเปิดรอบไปแล้ว
 * ล้างของเดิมทิ้งแล้วกวาดใหม่ทั้งหมด คนที่ถูกเอาออกจากรอบไปก่อนหน้านี้จะกลับมาด้วย
 */
payrollRouter.post(
  '/:id/rebuild',
  asyncRoute(async (req, res) => {
    if (!editable(req.run)) throw new ApiError(409, 'รอบที่จ่าย/ยกเลิกแล้วดึงกะใหม่ไม่ได้');
    res.json(await repo.rebuild(req.params.id, req.run.period_to));
  }),
);

/**
 * เอาคนออกจากรอบนี้ (ยังไม่จ่ายให้รอบนี้) — กะของเขากลับเข้ากองรอจ่ายทันที
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
 * ยกเลิกรอบ — รอบยังอยู่เป็นประวัติ แต่กะทั้งหมดกลับเข้ากองรอจ่าย
 * ใช้กับรอบที่จ่ายผิด/จ่ายไม่ครบด้วย: กะที่ถูกปลดจะไปโผล่ในรอบถัดไปเอง ไม่มีทางตกหล่น
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
