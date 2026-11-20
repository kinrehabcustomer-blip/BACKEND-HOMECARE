import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { can } from '../lib/auth.js';
import { todayTh } from '../lib/dates.js';
import { EVENT_GROUPS, EVENT_KINDS, captureSnapshot, listEvents, listSnapshots } from './log.js';

/**
 * บันทึกการเงิน (finance/log.js) — สิทธิ์ finance_logs ตั้งรายตำแหน่งได้ที่หน้าจัดการสิทธิ์
 * ค่าตั้งต้น: Super Admin · ผู้จัดการ · ฝ่ายการเงิน (ข้อมูลเงินทั้งบริษัท รวมค่าจ้างพนักงานรวม)
 */
export const financeRouter = Router();

financeRouter.use((req, res, next) =>
  req.user && can(req.user.position, 'finance_logs')
    ? next()
    : next(new ApiError(403, 'บัญชีของคุณไม่มีสิทธิ์ดูบันทึกการเงิน — ตั้งได้ที่หน้าจัดการสิทธิ์')),
);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const span = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5;
const rangeSchema = z.object({
  from: z.string().regex(DATE, 'วันที่ไม่ถูกต้อง'),
  to: z.string().regex(DATE, 'วันที่ไม่ถูกต้อง'),
}).refine((r) => r.from <= r.to, 'วันเริ่มต้องไม่เกินวันสิ้นสุด')
  .refine((r) => span(r.from, r.to) <= MAX_DAYS, 'ดูได้ครั้งละไม่เกิน 1 ปี');

/** ตัวเลข ณ ตอนนี้ — และจดลงยอดประจำวันของวันนี้ไปด้วย (เปิดหน้าครั้งสุดท้ายของวัน ≈ ยอดปิดวัน) */
financeRouter.get(
  '/today',
  asyncRoute(async (req, res) => {
    res.json(await captureSnapshot());
  }),
);

financeRouter.get(
  '/snapshots',
  asyncRoute(async (req, res) => {
    const { from, to } = rangeSchema.parse(req.query);
    res.json({ from, to, today: todayTh(), rows: await listSnapshots({ from, to }) });
  }),
);

const eventsSchema = z.object({
  grp: z.enum(EVENT_GROUPS).optional(),
  kind: z.enum(EVENT_KINDS).optional(),
  q: z.string().trim().max(80).optional(),
});

financeRouter.get(
  '/events',
  asyncRoute(async (req, res) => {
    const range = rangeSchema.parse(req.query);
    const filters = eventsSchema.parse(req.query);
    res.json(await listEvents({ ...range, grp: filters.grp ?? null, kind: filters.kind ?? null, q: filters.q || null }));
  }),
);
