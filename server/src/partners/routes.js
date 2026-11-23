import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { can, canSeeStaffPay, requirePermission } from '../lib/auth.js';
import { ensureAssignable } from '../cases/routes.js';
import { decodeImage, imageSchema } from '../employees/schema.js';
import * as repo from './repo.js';

/**
 * พาร์ทเนอร์ (ผู้รับเหมาช่วงรายครั้ง · 21 พ.ย. 2569) — repo.js อธิบายขั้นตอน
 *
 *   /api/partners  หลังบ้าน KIN (สิทธิ์ office): บริษัท · บัญชีหัวหน้า · ส่ง/ดึงกะ · กะที่ต้องดู · สรุปและบันทึกจ่าย
 *   /api/partner   หัวหน้าพาร์ทเนอร์ (requirePartnerLead): งานที่ส่งมา · เลือกคน/ปฏิเสธ · ทีม · สรุปรายเดือน
 *                  ทุกเส้นใช้ req.user.partner_id จาก session — ไม่รับรหัสบริษัทจากผู้เรียกเลย
 */

const month = z.string().regex(/^\d{4}-\d{2}$/, 'เดือนต้องเป็น YYYY-MM');
const thisMonth = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 7);
const text = (max) => z.string().trim().max(max);
const optText = (max) => text(max).optional().nullable().transform((v) => (v === '' ? null : v));
const intId = z.coerce.number().int().positive();

const partnerSchema = z.object({
  name: text(120).min(1, 'กรุณากรอกชื่อบริษัท'),
  contact_name: optText(120),
  phone: optText(30),
  rate_per_visit: z.coerce.number().min(0, 'เรทต้องไม่ติดลบ').max(1_000_000).optional(),
  note: optText(500),
});
const personSchema = z.object({
  first_name: text(80).min(1, 'กรุณากรอกชื่อ'),
  last_name: text(80).min(1, 'กรุณากรอกนามสกุล'),
  nickname: optText(40),
  phone: optText(30),
  // อีเมล = ชื่อเข้าระบบอีกทางนอกจากรหัสพนักงาน (หน้า login รับทั้งสองแบบ · ผู้ใช้ขอ 23 พ.ย. 2569) — ช่องว่าง = ไม่ใช้
  email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().toLowerCase().max(254, 'อีเมลยาวเกินไป').email('อีเมลไม่ถูกต้อง').nullable().optional()),
});
const personPatch = personSchema.partial().extend({
  position: z.string().optional(),
  status: z.enum(['active', 'resigned']).optional(),
});

// ============================================================================
// หลังบ้าน KIN — ด่านรายเส้น (ตรวจ 21 พ.ย. 2569):
//   งานพาร์ทเนอร์ (บริษัท · คน · ส่ง/ดึงกะ)  = สิทธิ์ office
//   ตัวเลขเงิน (เรท · ยอด · สรุป)             = ต้องเห็นค่าจ้างได้ (see_pay) — คนไม่มีสิทธิ์ไม่เห็นเรทในรายการ
//   บันทึกจ่าย                              = ค่าตอบแทน (payroll) + see_pay — การเงินที่ไม่มี office ก็ทำได้
// ============================================================================
export const adminPartnersRouter = Router();
const office = requirePermission('office', 'บัญชีของคุณไม่มีสิทธิ์จัดการพาร์ทเนอร์');
const seePay = requirePermission('see_pay', 'ตัวเลขเงินของพาร์ทเนอร์ดูได้เฉพาะคนที่มีสิทธิ์ดูค่าจ้าง');
/** สรุปรายเดือน: คนจัดการงาน (office) หรือการเงิน (payroll) — และต้องเห็นค่าจ้างได้ */
function officeOrPayroll(req, res, next) {
  const p = req.user?.position;
  if (can(p, 'office') || can(p, 'payroll')) return next();
  return next(new ApiError(403, 'บัญชีของคุณไม่มีสิทธิ์ดูสรุปพาร์ทเนอร์'));
}
/** ตัดเรทออกจากข้อมูลบริษัทสำหรับคนที่ไม่เห็นค่าจ้าง */
const withoutMoney = (req, p) => (canSeeStaffPay(req.user.position) ? p : { ...p, rate_per_visit: undefined });
/** คนไม่เห็นค่าจ้างตั้ง/แก้เรทไม่ได้ (ส่งมาก็ไม่รับ) */
const moneyInput = (req, input) => {
  if (canSeeStaffPay(req.user.position)) return input;
  const { rate_per_visit: _drop, ...rest } = input;
  return rest;
};

adminPartnersRouter.get('/', office, asyncRoute(async (req, res) => {
  res.json((await repo.listPartners()).map((p) => withoutMoney(req, p)));
}));

adminPartnersRouter.post('/', office, asyncRoute(async (req, res) => {
  res.status(201).json(withoutMoney(req, await repo.createPartner(moneyInput(req, partnerSchema.parse(req.body ?? {})), req.user)));
}));

adminPartnersRouter.get('/attention', office, asyncRoute(async (req, res) => res.json(await repo.attention())));

adminPartnersRouter.get('/summary', officeOrPayroll, seePay, asyncRoute(async (req, res) => {
  res.json(await repo.summaryAll(month.parse(req.query.month ?? thisMonth())));
}));

adminPartnersRouter.post('/visits/:visitId/send', office, asyncRoute(async (req, res) => {
  const { partner_id } = z.object({ partner_id: intId }).parse(req.body ?? {});
  await repo.sendVisit(intId.parse(req.params.visitId), partner_id, req.user);
  res.json({ ok: true });
}));

adminPartnersRouter.post('/visits/:visitId/pull', office, asyncRoute(async (req, res) => {
  const { assigned_to } = z.object({ assigned_to: z.string().min(1).nullable().optional() }).parse(req.body ?? {});
  if (assigned_to) await ensureAssignable(assigned_to); // คน KIN ที่รับต่อ — กติกาเดียวกับลงกะปกติ
  await repo.pullVisit(intId.parse(req.params.visitId), assigned_to ?? null, req.user);
  res.json({ ok: true });
}));

adminPartnersRouter.patch('/:id', office, asyncRoute(async (req, res) => {
  const input = partnerSchema.partial().extend({ status: z.enum(['active', 'inactive']).optional() }).parse(req.body ?? {});
  res.json(withoutMoney(req, await repo.updatePartner(intId.parse(req.params.id), moneyInput(req, input))));
}));

/** โลโก้บริษัท — ส่ง image: null = ลบ (หน้าเว็บย่อเป็น WebP ≤ 512px ก่อนส่ง) */
adminPartnersRouter.put('/:id/logo', office, asyncRoute(async (req, res) => {
  const { image } = z.object({ image: imageSchema.nullable() }).parse(req.body ?? {});
  let decoded = null;
  if (image) {
    try { decoded = decodeImage(image); } catch (err) { throw new ApiError(400, err.message); }
  }
  res.json(withoutMoney(req, await repo.setLogo(intId.parse(req.params.id), decoded)));
}));

/** ไฟล์โลโก้ — ทุกคนที่ล็อกอินเห็นได้ (โลโก้บริษัทไม่ใช่ข้อมูลลับ · หัวหน้าพาร์ทเนอร์ก็ใช้) · app.js mount ไว้ที่ /api/partner-logos */
export const partnerLogoRoute = asyncRoute(async (req, res) => {
  const row = await repo.getLogo(intId.parse(req.params.id));
  if (!row) throw new ApiError(404, 'บริษัทนี้ยังไม่มีโลโก้');
  res.setHeader('Content-Type', row.logo_mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // หน้าเว็บต่อ ?v=logo_version ท้าย URL — เปลี่ยนโลโก้แล้วได้ไฟล์ใหม่ทันที แคชนานได้
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(row.logo_data);
});

adminPartnersRouter.get('/:id/people', office, asyncRoute(async (req, res) => {
  res.json(await repo.people(intId.parse(req.params.id)));
}));

/** บัญชีหัวหน้าพาร์ทเนอร์ — สร้างจากหลังบ้าน KIN เท่านั้น */
adminPartnersRouter.post('/:id/leads', office, asyncRoute(async (req, res) => {
  res.status(201).json(await repo.createPerson(intId.parse(req.params.id), personSchema.parse(req.body ?? {}), { asLead: true }));
}));

adminPartnersRouter.patch('/:id/people/:employeeId', office, asyncRoute(async (req, res) => {
  res.json(await repo.updatePerson(intId.parse(req.params.id), req.params.employeeId, personPatch.parse(req.body ?? {}), { allowLead: true }));
}));

adminPartnersRouter.get('/:id/summary', officeOrPayroll, seePay, asyncRoute(async (req, res) => {
  res.json(await repo.summary(intId.parse(req.params.id), month.parse(req.query.month ?? thisMonth())));
}));

/** บันทึกจ่ายยอดเดือน — เรื่องเงิน ต้องมีสิทธิ์ค่าตอบแทน */
adminPartnersRouter.post('/:id/payments', requirePermission('payroll', 'บันทึกจ่ายพาร์ทเนอร์ได้เฉพาะคนที่มีสิทธิ์ค่าตอบแทน'), seePay,
  asyncRoute(async (req, res) => {
    const input = z.object({ month, note: optText(300) }).parse(req.body ?? {});
    res.status(201).json(await repo.markPaid(intId.parse(req.params.id), input.month, { note: input.note }, req.user));
  }));

// ============================================================================
// หัวหน้าพาร์ทเนอร์
// ============================================================================
export const partnerRouter = Router();
const mine = (req) => req.user.partner_id;

/* บริษัทที่ KIN ปิดใช้งานแล้ว = หัวหน้าทำอะไรไม่ได้ทุกเส้น (ตรวจ 21 พ.ย. 2569 — เดิมกันแค่ /me ยิง API ตรงรับงานต่อได้) */
partnerRouter.use(asyncRoute(async (req, res, next) => {
  const p = await repo.findPartner(mine(req));
  if (!p || p.status !== 'active') throw new ApiError(403, 'บริษัทของคุณปิดใช้งานอยู่ — ติดต่อ KIN');
  next();
}));

partnerRouter.get('/me', asyncRoute(async (req, res) => {
  const p = await repo.findPartner(mine(req));
  if (!p || p.status !== 'active') throw new ApiError(403, 'บริษัทของคุณปิดใช้งานอยู่ — ติดต่อ KIN');
  res.json({ partner_id: p.partner_id, name: p.name, rate_per_visit: p.rate_per_visit, has_logo: p.has_logo,
    logo_version: p.logo_version, counts: await repo.partnerCounts(p.partner_id) });
}));

partnerRouter.get('/visits', asyncRoute(async (req, res) => {
  const tab = z.enum(['pending', 'accepted', 'past']).default('pending').parse(req.query.tab ?? undefined);
  res.json(await repo.partnerVisits(mine(req), tab));
}));

partnerRouter.get('/visits/:id', asyncRoute(async (req, res) => {
  res.json(await repo.partnerVisitDetail(mine(req), intId.parse(req.params.id)));
}));

partnerRouter.get('/visits/:id/candidates', asyncRoute(async (req, res) => {
  res.json(await repo.candidates(mine(req), intId.parse(req.params.id)));
}));

partnerRouter.post('/visits/:id/accept', asyncRoute(async (req, res) => {
  const { employee_id } = z.object({ employee_id: z.string().min(1, 'เลือกคนที่จะไป') }).parse(req.body ?? {});
  await repo.acceptVisit(mine(req), intId.parse(req.params.id), employee_id, req.user);
  res.json({ ok: true });
}));

partnerRouter.post('/visits/:id/reject', asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: optText(300) }).parse(req.body ?? {});
  await repo.rejectVisit(mine(req), intId.parse(req.params.id), reason, req.user);
  res.json({ ok: true });
}));

partnerRouter.get('/team', asyncRoute(async (req, res) => {
  res.json({ people: await repo.people(mine(req)), positions: repo.TEAM_POSITIONS });
}));

partnerRouter.post('/team', asyncRoute(async (req, res) => {
  const input = personSchema.extend({ position: z.string().min(1, 'เลือกตำแหน่ง') }).parse(req.body ?? {});
  res.status(201).json(await repo.createPerson(mine(req), input));
}));

partnerRouter.get('/team/:employeeId', asyncRoute(async (req, res) => {
  res.json(await repo.personDetail(mine(req), req.params.employeeId));
}));

partnerRouter.patch('/team/:employeeId', asyncRoute(async (req, res) => {
  res.json(await repo.updatePerson(mine(req), req.params.employeeId, personPatch.parse(req.body ?? {})));
}));

partnerRouter.get('/summary', asyncRoute(async (req, res) => {
  const s = await repo.summary(mine(req), month.parse(req.query.month ?? thisMonth()));
  res.json(s);
}));
