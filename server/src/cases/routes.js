import { Router } from 'express';
import * as repo from './repo.js';
import * as employees from '../employees/repo.js';
import * as customers from '../customers/repo.js';
import * as invoices from '../invoices/repo.js';
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
  bulkVisitSchema,
  previewVisitsSchema,
  visitRangeSchema,
  geocodeSchema,
  mapLinkSchema,
  placeSearchSchema,
  adjustVisitSchema,
  decidePaySchema,
  attendanceQuerySchema,
  CASE_TYPES,
  CASE_STATUSES,
} from './schema.js';
import { geocode, reverseGeocode, searchPlaces } from '../lib/geocode.js';
import { resolveMapLink } from '../lib/maplink.js';
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

// ---------- ระบบเช็คอิน (ฝั่ง admin) — ต้องมาก่อน '/:id' ----------

/** รายการมาทำงานทั้งหมด (เช็คอินแล้ว) — กรองตามเดือน/พนักงาน */
casesRouter.get(
  '/attendance',
  asyncRoute(async (req, res) => {
    const query = attendanceQuerySchema.parse({
      month: req.query.month || undefined,
      employee_id: req.query.employee_id || undefined,
    });
    res.json(await repo.attendanceList(query));
  }),
);

/** รายการต้องตรวจ — ขาดงาน / ค้างเช็คเอาท์ / นอกพื้นที่ */
casesRouter.get(
  '/attendance/exceptions',
  asyncRoute(async (req, res) => res.json(await repo.attendanceExceptions())),
);

/** คิวกะที่ทำงานจบแล้วแต่ยังไม่ได้อนุมัติค่าจ้าง — ต้องมาก่อน '/:id' */
casesRouter.get(
  '/attendance/pending',
  asyncRoute(async (req, res) => {
    const query = attendanceQuerySchema.parse({
      month: req.query.month || undefined,
      employee_id: req.query.employee_id || undefined,
    });
    res.json(await repo.pendingApprovals(query));
  }),
);

/**
 * อนุมัติ/ไม่อนุมัติค่าจ้างของกะที่เลือก — เงินจะเข้าสรุปค่าตอบแทนของพนักงานก็ต่อเมื่อผ่านเส้นนี้
 * แตะเฉพาะกะที่ยังรออยู่ กดซ้ำหรือกดจากหน้าที่ข้อมูลเก่าจึงไม่ทับผลที่ตัดสินไปแล้ว
 */
casesRouter.post(
  '/attendance/decide',
  asyncRoute(async (req, res) => {
    const input = decidePaySchema.parse(req.body);
    res.json(await repo.decideVisitPay(input.visit_ids, input, req.user));
  }),
);

/** สรุปค่าตอบแทนรายเดือนต่อพนักงาน (payroll) — ไม่ส่งเดือน = เดือนปัจจุบัน (โซนไทย) */
casesRouter.get(
  '/attendance/report',
  asyncRoute(async (req, res) => {
    const { month } = attendanceQuerySchema.parse({ month: req.query.month || undefined });
    const ym = month ?? new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 7);
    res.json(await repo.attendanceReport(ym));
  }),
);

/** แปลงที่อยู่เป็นพิกัด (ผ่าน Google Geocoding ฝั่ง server) — ให้หน้าเคสตั้งพิกัด */
casesRouter.post(
  '/geocode',
  asyncRoute(async (req, res) => {
    const { address } = geocodeSchema.parse(req.body);
    const result = await geocode(address);
    if (!result) throw new ApiError(404, 'หาพิกัดจากที่อยู่นี้ไม่ได้ — ลองระบุที่อยู่ให้ชัดขึ้น หรือปักหมุด/กรอกพิกัดเอง');
    res.json(result);
  }),
);

/**
 * อ่านพิกัด + ที่อยู่ จากลิงก์ Google Maps ที่ผู้ใช้วางมา (รองรับลิงก์ย่อจากปุ่มแชร์)
 * ดึงพิกัดจากลิงก์ก่อน แล้ว reverse-geocode เป็นที่อยู่อ่านออก (ถ้ามี server key)
 */
casesRouter.post(
  '/resolve-map-link',
  asyncRoute(async (req, res) => {
    const { url } = mapLinkSchema.parse(req.body);
    const loc = await resolveMapLink(url);
    if (!loc) {
      throw new ApiError(422, 'อ่านพิกัดจากลิงก์นี้ไม่ได้ — แนะนำใช้ลิงก์จากปุ่ม "แชร์" ในแอป Google Maps');
    }
    const address = await reverseGeocode(loc.lat, loc.lng);
    res.json({ lat: loc.lat, lng: loc.lng, address });
  }),
);

/** ค้นหาสถานที่จากการพิมพ์ชื่อ/ที่อยู่ — คืนหลายผลลัพธ์ให้ผู้ใช้เลือก */
casesRouter.post(
  '/search-place',
  asyncRoute(async (req, res) => {
    const { query, near_lat: lat, near_lng: lng } = placeSearchSchema.parse(req.body);
    // ต้องมาครบคู่ถึงจะใช้เอนเอียงได้ — มีแค่ค่าเดียวไม่ใช่พิกัด
    const near = lat != null && lng != null ? { lat, lng } : null;
    res.json({ results: await searchPlaces(query, { near }) });
  }),
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

    res.status(201).json(await repo.create(input, req.user));
  }),
);

casesRouter.get('/:id', (req, res) => res.json(req.case));

/** ประวัติการทำรายการของเคส — ใครจับคู่/ปิด/ยกเลิก เมื่อไหร่ (ดู case_events) */
casesRouter.get(
  '/:id/events',
  asyncRoute(async (req, res) => res.json(await repo.listEvents(req.params.id))),
);

/**
 * อนุมัติค่าจ้างของกะที่ทำจบแล้วทั้งเคสในครั้งเดียว — จังหวะที่ใช้บ่อยที่สุดคือตอนปิดเคส
 * (ไล่กดทีละกะจากคิวรวมก็ได้ แต่ตอนปิดเคสคือตอนที่ผู้จัดการกำลังดูงานทั้งก้อนนี้อยู่พอดี)
 */
casesRouter.post(
  '/:id/approve-pay',
  asyncRoute(async (req, res) => {
    const ids = await repo.pendingVisitIds(req.params.id);
    res.json(await repo.decideVisitPay(ids, { approve: true }, req.user));
  }),
);

casesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const input = updateCaseSchema.parse(req.body);
    const updated = await repo.update(req.params.id, input, req.user);

    // แก้เคสแล้วใบแจ้งหนี้ที่ยังแก้ได้ (ร่าง/ออกใบแล้ว) ต้องตามให้ทัน — ดู syncOpenFromCase
    const customer = updated.customer_id ? await customers.findById(updated.customer_id) : null;
    await invoices.syncOpenFromCase(updated, customer);

    res.json(updated);
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

    res.json(await repo.assign(req.params.id, employee_id, req.user));
  }),
);

/** ยกเลิกการจับคู่ — เคสกลับไปเป็น 'ยังไม่จับคู่พนักงาน' */
casesRouter.post(
  '/:id/unassign',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
    res.json(await repo.unassign(req.params.id, req.user));
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
    res.json(await repo.start(req.params.id, req.user));
  }),
);

/**
 * ปิดเคส — ถ้ายังมีกะค้างจะไม่ปิดให้ทันที ต้องยืนยันด้วย force
 * (ปิดแล้วกะที่ยังไม่ถึงวันจะถูกยกเลิก และกะที่ค้างเช็คเอาท์จะไม่มีชั่วโมง/ค่าจ้าง — ต้องรู้ก่อนกด)
 */
casesRouter.post(
  '/:id/close',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');

    const pending = await repo.pendingShifts(req.params.id);
    if (!req.body?.force && (pending.upcoming > 0 || pending.open_shifts > 0)) {
      const parts = [
        pending.upcoming > 0 && `${pending.upcoming} กะที่ยังไม่ถึงวันนัด (จะถูกยกเลิก)`,
        pending.open_shifts > 0 && `${pending.open_shifts} กะที่เช็คอินแล้วแต่ยังไม่เช็คเอาท์`,
      ].filter(Boolean);
      throw new ApiError(409, `เคสนี้ยังมีกะค้าง: ${parts.join(' · ')} — ยืนยันอีกครั้งถ้าต้องการปิด`, { pending });
    }

    res.json(await repo.close(req.params.id, req.body?.end_date, req.user));
  }),
);

/** ยกเลิกเคส — ใช้กับเคสที่ไม่ได้เกิดขึ้นจริง/ญาติยกเลิก ต่างจากปิดเคสที่ให้บริการจบตามปกติ */
casesRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
    const { reason } = cancelSchema.parse(req.body ?? {});
    res.json(await repo.cancel(req.params.id, reason, req.user));
  }),
);

casesRouter.post(
  '/:id/reopen',
  asyncRoute(async (req, res) => {
    if (!isTerminal(req.case)) throw new ApiError(409, 'เคสนี้ยังไม่ได้ปิดหรือยกเลิก');
    res.json(await repo.reopen(req.params.id, req.user));
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

/** ลงกะหลายวันในครั้งเดียว (วันที่เลือกไว้ หรือทั้งช่วง) — คืนกะทั้งหมด + จำนวนที่เพิ่ม/ข้าม + กะที่ชนกัน */
casesRouter.post(
  '/:id/visits/bulk',
  asyncRoute(async (req, res) => {
    const input = bulkVisitSchema.parse(req.body);
    res.status(201).json(await repo.addVisits(req.params.id, input.dates, input));
  }),
);

/** ตรวจก่อนบันทึกว่าวันที่เลือกไว้ชนกับงานอื่นของคนนั้นไหม — ไม่เขียนอะไรลงฐานข้อมูล */
casesRouter.post(
  '/:id/visits/preview',
  asyncRoute(async (req, res) => {
    const input = previewVisitsSchema.parse(req.body);
    res.json(await repo.previewVisits(req.params.id, input));
  }),
);

/**
 * ลบกะหลายวัน — ?dates=YYYY-MM-DD,YYYY-MM-DD หรือ ?from=&to=
 * ข้ามกะที่เช็คอินไปแล้วเสมอ (เป็นบันทึกการทำงานจริง)
 */
casesRouter.delete(
  '/:id/visits',
  asyncRoute(async (req, res) => {
    const { dates } = visitRangeSchema.parse({
      dates: req.query.dates ? String(req.query.dates).split(',') : undefined,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(await repo.removeVisitsOn(req.params.id, dates));
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

/** admin แก้กะที่เช็คอินผิดพลาด (ปิดกะค้าง / แก้เวลา / เคลียร์ธงนอกพื้นที่) — บันทึกผู้แก้ */
casesRouter.patch(
  '/:id/visits/:visitId/adjust',
  asyncRoute(async (req, res) => {
    const input = adjustVisitSchema.parse(req.body);
    res.json(
      await repo.adjustVisit(req.params.id, Number(req.params.visitId), input, req.user),
    );
  }),
);

/** รูปเซลฟี่เช็คอินของกะ — ให้ admin เปิดดูยืนยันว่าพนักงานอยู่หน้างานจริง */
casesRouter.get(
  '/:id/visits/:visitId/photo',
  asyncRoute(async (req, res, next) => {
    const row = await repo.findVisitPhoto(Number(req.params.visitId));
    if (!row) return next(notFound('กะนี้ไม่มีรูปเช็คอิน'));
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.data);
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
