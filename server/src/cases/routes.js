import { Router } from 'express';
import * as repo from './repo.js';
import * as employees from '../employees/repo.js';
import * as customers from '../customers/repo.js';
import * as invoices from '../invoices/repo.js';
// ตัวสร้างใบร่างอยู่ที่ชั้น route ของใบแจ้งหนี้ เพราะต้องใช้ตรรกะหาผู้จ่ายชุดเดียวกับตอนกดออกใบเอง
import { createDraftForCase } from '../invoices/routes.js';
import {
  createCaseSchema,
  updateCaseSchema,
  assignSchema,
  releasePaySchema,
  payShareAgreementSchema,
  cancelSchema,
  closeCaseSchema,
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
  createReportSchema,
  updateReportSchema,
  reportQuerySchema,
  hasReportContent,
  attendanceQuerySchema,
  CASE_TYPES,
  CASE_STATUSES,
} from './schema.js';
import { geocode, reverseGeocode, searchPlaces } from '../lib/geocode.js';
import { resolveMapLink } from '../lib/maplink.js';
import { canSeeStaffPay } from '../lib/auth.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

export const casesRouter = Router();

// พนักงานที่ลาออก/พักงาน รับเคสใหม่ไม่ได้
const ASSIGNABLE_STATUSES = ['active', 'probation'];

// สถานะปลายทาง — เคสจบไปแล้ว ต้องกด "เปิดเคสใหม่" ก่อนถึงจะจับคู่/เริ่ม/ยกเลิกได้อีก
const TERMINAL_STATUSES = ['closed', 'cancelled'];
const isTerminal = (caseRow) => TERMINAL_STATUSES.includes(caseRow.status);

/**
 * ตัดต้นทุน/ค่าจ้างออกจากเคสก่อนส่งให้คนที่ไม่ใช่ผู้จัดการ (HR เปิดเคสได้ แต่ไม่เห็นตัวเลขนี้)
 *
 * หน้าแพ็คเกจกับกายภาพตัดฟิลด์พวกนี้ที่ payload มาตั้งแต่แรก แต่เส้นของเคสไม่เคยตัด —
 * SELECT ของเคสพ่วง staff_pay ของเรท/แพ็คเกจมาด้วย (ไว้เติมค่าจ้างให้อัตโนมัติฝั่ง server)
 * HR จึงเห็นค่าจ้างครบทุกใบผ่าน GET /api/cases ทั้งที่หน้าจอตั้งใจซ่อนไว้
 *
 * ตัดที่ชั้น route ไม่ใช่ที่ repo เพราะ repo ถูกเรียกจากฝั่ง server ด้วยกันเอง
 * (payFromService, syncOpenFromCase) ซึ่งต้องใช้ตัวเลขจริงเสมอไม่ว่าใครเป็นคนกดปุ่ม
 */
const PAY_FIELDS = ['staff_pay', 'rate_staff_pay', 'physio_staff_pay'];

function visible(req, caseRow) {
  if (!caseRow || canSeeStaffPay(req.user?.position)) return caseRow;
  const shown = { ...caseRow };
  for (const f of PAY_FIELDS) delete shown[f];
  return shown;
}

const visibleList = (req, rows) => rows.map((row) => visible(req, row));

/* กะไม่มีตัวเลขค่าจ้างติดมาแล้ว — ค่าจ้างเป็นก้อนเดียวต่อเคส (ดู PAY_FIELDS ด้านบน + releasePay)
   จึงไม่ต้องกรองรายการกะ และไม่ต้องกันค่าจ้างรายกะที่ส่งเข้ามา เพราะไม่มีช่องนั้นให้เขียนอีกแล้ว */

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

/** สรุปค่าตอบแทนรายเดือนต่อพนักงาน (payroll) — ไม่ส่งเดือน = เดือนปัจจุบัน (โซนไทย), ไม่ส่งพนักงาน = ทุกคน */
casesRouter.get(
  '/attendance/report',
  asyncRoute(async (req, res) => {
    const { month, employee_id } = attendanceQuerySchema.parse({
      month: req.query.month || undefined,
      employee_id: req.query.employee_id || undefined,
    });
    const ym = month ?? new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 7);
    res.json(await repo.attendanceReport(ym, employee_id ?? null));
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
    const page = await repo.list(query);
    res.json({ ...page, data: visibleList(req, page.data) });
  }),
);

casesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createCaseSchema.parse(req.body);
    if (input.assigned_to) await ensureAssignable(input.assigned_to);

    const created = await repo.create(input, req.user);

    /* เปิดเคสแล้วออกใบแจ้งหนี้ (ร่าง) ให้เลย — ทุกเคสจบด้วยการเก็บเงินอยู่แล้ว
       การต้องกลับมากดออกใบทีหลังคือขั้นตอนที่ลืมได้ และลืมเมื่อไหร่ก็ไม่มีอะไรเตือน
       เป็น "ร่าง" ไม่ใช่ใบที่ออกแล้ว จึงยังแก้/ลบได้ และซิงก์ตามเคสให้เองจนกว่าจะกดออกใบจริง

       ใบล้มไม่ควรทำให้การเปิดเคสล้มตาม — เคสถูกสร้างไปแล้ว ตอบ error กลับไปจะกลายเป็น
       "เปิดเคสไม่สำเร็จ" ทั้งที่เคสอยู่ในระบบแล้ว · ปุ่มออกใบเองในหน้าเคสยังใช้ได้ตามเดิม */
    try {
      await createDraftForCase(created, req.user);
    } catch (err) {
      console.error(`[POST /api/cases] ออกใบแจ้งหนี้อัตโนมัติให้ ${created.case_id} ไม่สำเร็จ:`, err.message);
    }

    res.status(201).json(visible(req, created));
  }),
);

casesRouter.get('/:id', (req, res) => res.json(visible(req, req.case)));

/** ประวัติการทำรายการของเคส — ใครจับคู่/ปิด/ยกเลิก เมื่อไหร่ (ดู case_events) */
casesRouter.get(
  '/:id/events',
  asyncRoute(async (req, res) => res.json(await repo.listEvents(req.params.id))),
);

// ---------- ค่าจ้างของเคส (ก้อนเดียว ผู้จัดการกดปล่อยเอง) ----------

/** ตัวเลขเงินในข้อความ error — อ่านง่ายกว่า 15000 ที่ต้องนับหลักเอง */
const baht = (n) => Number(n).toLocaleString('th-TH');

/** เฉพาะผู้จัดการเท่านั้นที่แตะเรื่องเงินค่าจ้างได้ — HR เห็นเคสได้แต่ไม่เห็นและไม่สั่งจ่ายตัวเลขนี้ */
function ensureCanPay(req) {
  if (!canSeeStaffPay(req.user?.position)) {
    throw new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่ปล่อยค่าจ้างได้');
  }
}

/** ค่าจ้างของเคสนี้: ยอดเหมา · ปล่อยไปแล้วเท่าไหร่ · เหลือเท่าไหร่ · ถ้าปล่อยตอนนี้ใครได้เท่าไหร่ */
casesRouter.get(
  '/:id/pay',
  asyncRoute(async (req, res) => {
    ensureCanPay(req);
    res.json(await repo.payStatus(req.params.id));
  }),
);

/**
 * ตั้งข้อตกลงส่วนแบ่งของเคส — "เคสนี้ ใครได้เท่าไหร่" ใช้กับทุกงวดที่ปล่อยหลังจากนี้
 *
 * ค่าปริยายของระบบคือหารเท่ากันทุกคนที่ลงแรงในเคส (สองคนคนละครึ่ง สามคนหารสาม)
 * เส้นนี้มีไว้สำหรับตอนที่ตกลงกันเป็นอย่างอื่น เช่น ค่าจ้าง 15,000 ที่คนลงแรงมากกว่ารับ 9,000
 * อีกคนรับ 6,000 — ตั้งครั้งเดียวแล้วทุกงวดแบ่งตามนี้เอง ไม่ต้องมานั่งคิดเลขทุกครั้งที่ปล่อย
 *
 * ผลรวมต้องเท่ากับค่าจ้างของเคสพอดี เพราะมันคือการ "แบ่งก้อนนั้น" ไม่ใช่ตั้งเป้าลอยๆ
 * ถ้าไม่บังคับ เคสจะจบลงด้วยเงินที่แบ่งไม่หมดหรือแบ่งเกินโดยไม่มีใครรู้จนถึงงวดสุดท้าย
 */
casesRouter.put(
  '/:id/pay/shares',
  asyncRoute(async (req, res) => {
    ensureCanPay(req);
    const { shares } = payShareAgreementSchema.parse(req.body ?? {});

    const status = await repo.payStatus(req.params.id);
    if (status.staff_pay == null) {
      throw new ApiError(409, 'เคสนี้ยังไม่ได้ตั้งค่าจ้างพนักงาน — ตั้งยอดของเคสก่อนจึงจะแบ่งส่วนได้');
    }

    if (shares.length > 0) {
      const known = new Set(status.shares.map((r) => r.employee_id));
      const stranger = shares.find((r) => !known.has(r.employee_id));
      if (stranger) {
        throw new ApiError(
          400,
          `${stranger.employee_id} ไม่ได้มีส่วนในเคสนี้ — ตั้งส่วนแบ่งได้เฉพาะคนที่มีกะที่อนุมัติแล้ว` +
            ' หรือเคยได้รับค่าจ้างของเคสนี้ไปก่อนหน้า',
        );
      }

      if (new Set(shares.map((r) => r.employee_id)).size !== shares.length) {
        throw new ApiError(400, 'มีชื่อพนักงานซ้ำในข้อตกลง — หนึ่งคนมีได้บรรทัดเดียว');
      }

      const sum = Math.round(shares.reduce((n, r) => n + r.share, 0) * 100) / 100;
      if (sum !== Math.round(status.staff_pay * 100) / 100) {
        throw new ApiError(
          400,
          `ผลรวมของส่วนแบ่งคือ ${baht(sum)} บาท แต่ค่าจ้างของเคสคือ ${baht(status.staff_pay)} บาท — ` +
            'ต้องเท่ากันพอดี ไม่งั้นจะมีเงินที่ไม่มีเจ้าของหรือแบ่งเกินก้อนที่มีอยู่',
        );
      }
    }

    res.json(await repo.setPayShares(req.params.id, shares, req.user));
  }),
);

/**
 * ปล่อยค่าจ้างของเคส — ทีละงวด แบ่งตามข้อตกลงส่วนแบ่ง (ปริยาย = หารเท่ากัน)
 *
 * ไม่ระบุยอด = ปล่อยยอดคงเหลือทั้งหมด (กรณีปกติ: งานจบแล้วจ่ายให้ครบ)
 * ระบุเอง = แบ่งจ่ายเป็นงวด เช่น เคส 20,000 ที่ตกลงกันไว้สองงวด → กรอก 7,000 แล้วที่เหลือ
 * 13,000 ค่อยปล่อยเป็นงวดที่สอง (ยอดที่กรอกถูกหักออกจากยอดเหมาทันที ไม่ต้องมานั่งลบเอง)
 *
 * เพดานคือ MAX_INSTALLMENTS งวดต่อเคส และนับแยกทุกเคส — เคสอื่นของพนักงานคนเดียวกัน
 * มีงวดของตัวเองครบชุด ไม่ใช่โควตารวมของคน
 *
 * ห้ามปล่อยเกินยอดเหมาของเคส — "เคสหนึ่งใบ = งานหนึ่งชิ้น = ค่าจ้างหนึ่งก้อน"
 * ถ้าตกลงเพิ่มกับพนักงานจริง ให้แก้ค่าจ้างของเคสก่อน จะได้เหลือร่องรอยว่ายอดที่ตกลงเปลี่ยนไปเท่าไหร่
 */
casesRouter.post(
  '/:id/pay/release',
  asyncRoute(async (req, res) => {
    ensureCanPay(req);
    const input = releasePaySchema.parse(req.body ?? {});

    const status = await repo.payStatus(req.params.id);
    if (status.staff_pay == null) {
      throw new ApiError(409, 'เคสนี้ยังไม่ได้ตั้งค่าจ้างพนักงาน — ตั้งยอดเหมาของเคสก่อนจึงจะปล่อยได้');
    }
    /* ด่านเดียวที่เหลือ: ต้องรู้ว่าจะจ่ายให้ใคร — ไม่ได้ดูว่ากะครบหรือถูกยืนยันแล้วหรือยัง */
    if (status.shares.length === 0) {
      throw new ApiError(
        409,
        'เคสนี้ยังไม่มีพนักงานเลย จึงไม่รู้ว่าจะจ่ายให้ใคร — มอบหมายพนักงานหรือลงกะให้เคสนี้ก่อน',
      );
    }

    /* บอกทางออกให้ด้วย ไม่ใช่แค่ปิดประตู — ยอดที่ยังค้างอยู่ต้องออกทางใดทางหนึ่งเสมอ
       (ถอนงวดที่ปล่อยผิดคืนแล้วปล่อยใหม่ให้เต็ม หรือลดยอดเหมาลงถ้าตกลงกันว่าจ่ายเท่านี้จริง) */
    if (status.installments_left === 0) {
      throw new ApiError(
        409,
        `เคสนี้แบ่งจ่ายครบ ${status.max_installments} งวดแล้ว (ปล่อยไปรวม ${baht(status.released)} บาท` +
          `${status.remaining > 0 ? `, ยังเหลือ ${baht(status.remaining)} บาท` : ''}) — ` +
          'ถ้ายังต้องจ่ายอีก ให้ถอนงวดที่ปล่อยผิดคืนก่อน แล้วปล่อยใหม่ให้เต็มยอดในงวดนั้น',
      );
    }

    const amount = input.amount ?? status.remaining;
    if (amount <= 0) {
      throw new ApiError(409, `เคสนี้ปล่อยค่าจ้างครบ ${baht(status.staff_pay)} บาทแล้ว ไม่เหลือยอดให้ปล่อย`);
    }
    if (amount > status.remaining) {
      throw new ApiError(
        400,
        `ปล่อยได้ไม่เกินยอดคงเหลือของเคส (${baht(status.remaining)} บาท จากยอดเหมา ${baht(status.staff_pay)})` +
          ' — ถ้าตกลงจ่ายเพิ่ม ให้แก้ค่าจ้างของเคสก่อน',
      );
    }

    /* ชั้นนี้กันกรณีที่สองหน้าจอกดพร้อมกันจนงวดเกินเพดาน — status ที่อ่านไว้ข้างบนเก่าไปแล้ว
       ตอนที่ repo นับจริงในทรานแซกชัน (ดูเหตุผลเต็มใน releasePay) */
    const result = await repo.releasePay(
      req.params.id,
      { amount, note: input.note, due_date: input.due_date, shares: input.shares },
      req.user,
    );

    if (result.reason === 'installment_limit') {
      throw new ApiError(409, `เคสนี้แบ่งจ่ายครบ ${repo.MAX_INSTALLMENTS} งวดแล้ว — มีคนปล่อยงวดสุดท้ายไปพร้อมกันพอดี`);
    }
    if (result.reason === 'unknown_employee') {
      throw new ApiError(
        400,
        `${result.employee_id} ไม่ได้มีส่วนในเคสนี้ — แบ่งค่าจ้างให้ได้เฉพาะคนที่มีกะที่อนุมัติแล้ว` +
          ' หรือเคยได้รับค่าจ้างของเคสนี้ไปก่อนหน้า',
      );
    }
    if (result.reason === 'duplicate_employee') {
      throw new ApiError(400, 'มีชื่อพนักงานซ้ำในรายการแบ่ง — หนึ่งคนมีได้บรรทัดเดียวต่อหนึ่งงวด');
    }
    if (result.reason === 'share_sum_mismatch') {
      throw new ApiError(
        400,
        `ผลรวมของส่วนแบ่งคือ ${baht(result.sum)} บาท แต่ยอดของงวดนี้คือ ${baht(amount)} บาท — ` +
          'ต้องเท่ากันพอดี ไม่งั้นยอดเหมาของเคสจะไม่ลงตัว',
      );
    }
    if (result.reason === 'no_one_in_case') {
      throw new ApiError(409, 'เคสนี้ยังไม่มีพนักงานเลย จึงไม่รู้ว่าจะจ่ายให้ใคร');
    }
    if (result.reason === 'nothing_to_pay') {
      throw new ApiError(400, 'ไม่มีใครได้ส่วนแบ่งในงวดนี้เลย — ต้องมีอย่างน้อยหนึ่งคนที่ได้มากกว่า 0');
    }

    res.status(201).json(await repo.payStatus(req.params.id));
  }),
);

/** ถอนยอดที่ปล่อยผิดคืน — ได้เฉพาะก้อนที่ยังไม่ถูกจ่ายออกไปจริง */
casesRouter.delete(
  '/:id/pay/:payoutId',
  asyncRoute(async (req, res) => {
    ensureCanPay(req);
    const result = await repo.cancelPayout(req.params.id, Number(req.params.payoutId), req.user);

    if (result.reason === 'not_found') throw notFound('ไม่พบรายการค่าจ้างนี้ในเคสนี้');
    if (result.reason === 'already_paid') {
      throw new ApiError(409, 'ก้อนนี้จ่ายออกไปแล้ว ถอนคืนไม่ได้ — ต้องยกเลิกรอบจ่ายนั้นก่อน');
    }
    res.json(await repo.payStatus(req.params.id));
  }),
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
    // ส่ง updated ตัวเต็มเข้าไป ไม่ใช่ตัวที่ตัดค่าจ้างแล้ว — การซิงก์ใบต้องใช้ราคาจริงเสมอ
    const customer = updated.customer_id ? await customers.findById(updated.customer_id) : null;
    await invoices.syncOpenFromCase(updated, customer);

    res.json(visible(req, updated));
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

    res.json(visible(req, await repo.assign(req.params.id, employee_id, req.user)));
  }),
);

// ---------- ทีมพนักงานของเคส (เพิ่มคนดูแลได้มากกว่าหนึ่งคน) ----------

/** คนในทีม (ไม่รวมผู้รับผิดชอบหลัก ซึ่งอยู่ในตัวเคสเอง) */
casesRouter.get(
  '/:id/team',
  asyncRoute(async (req, res) => res.json(await repo.listTeam(req.params.id))),
);

/**
 * เพิ่มคนเข้าทีมดูแลเคส — ใช้กติกาเดียวกับการจับคู่คนหลัก (ลาออก/พักงานรับเคสใหม่ไม่ได้)
 * ต่างกันที่ไม่แตะสถานะเคสและไม่เปลี่ยนผู้รับผิดชอบหลัก
 */
casesRouter.post(
  '/:id/team',
  asyncRoute(async (req, res) => {
    const { employee_id } = assignSchema.parse(req.body);

    if (isTerminal(req.case)) {
      throw new ApiError(409, 'เคสนี้จบไปแล้ว — ต้องเปิดเคสใหม่ก่อนจึงจะเพิ่มพนักงานได้');
    }
    await ensureAssignable(employee_id);

    const added = await repo.addTeamMember(req.params.id, employee_id, req.user);
    if (!added) throw new ApiError(409, 'พนักงานคนนี้อยู่ในเคสนี้อยู่แล้ว');

    res.json(await repo.listTeam(req.params.id));
  }),
);

/** นำคนออกจากทีม — ผู้รับผิดชอบหลักถอดด้วยปุ่ม "ยกเลิกการจับคู่" เท่านั้น (คนละเส้นกัน) */
casesRouter.delete(
  '/:id/team/:employeeId',
  asyncRoute(async (req, res) => {
    const removed = await repo.removeTeamMember(req.params.id, req.params.employeeId, req.user);
    if (!removed) throw notFound('ไม่พบพนักงานคนนี้ในทีมของเคส');
    res.json(await repo.listTeam(req.params.id));
  }),
);

/** ยกเลิกการจับคู่ — เคสกลับไปเป็น 'ยังไม่จับคู่พนักงาน' */
casesRouter.post(
  '/:id/unassign',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
    res.json(visible(req, await repo.unassign(req.params.id, req.user)));
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
    res.json(visible(req, await repo.start(req.params.id, req.user)));
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

    const { end_date, force } = closeCaseSchema.parse(req.body ?? {});

    const pending = await repo.pendingShifts(req.params.id);
    if (!force && (pending.upcoming > 0 || pending.open_shifts > 0)) {
      const parts = [
        pending.upcoming > 0 && `${pending.upcoming} กะที่ยังไม่ถึงวันนัด (จะถูกยกเลิก)`,
        pending.open_shifts > 0 && `${pending.open_shifts} กะที่เช็คอินแล้วแต่ยังไม่เช็คเอาท์`,
      ].filter(Boolean);
      throw new ApiError(409, `เคสนี้ยังมีกะค้าง: ${parts.join(' · ')} — ยืนยันอีกครั้งถ้าต้องการปิด`, { pending });
    }

    res.json(visible(req, await repo.close(req.params.id, end_date, req.user)));
  }),
);

/** ยกเลิกเคส — ใช้กับเคสที่ไม่ได้เกิดขึ้นจริง/ญาติยกเลิก ต่างจากปิดเคสที่ให้บริการจบตามปกติ */
casesRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    if (isTerminal(req.case)) throw new ApiError(409, 'เคสนี้จบไปแล้ว');
    const { reason } = cancelSchema.parse(req.body ?? {});
    res.json(visible(req, await repo.cancel(req.params.id, reason, req.user)));
  }),
);

casesRouter.post(
  '/:id/reopen',
  asyncRoute(async (req, res) => {
    if (!isTerminal(req.case)) throw new ApiError(409, 'เคสนี้ยังไม่ได้ปิดหรือยกเลิก');
    res.json(visible(req, await repo.reopen(req.params.id, req.user)));
  }),
);

/**
 * ลบเคสถาวร — ของที่หายไปด้วยไม่ได้อยู่แค่ในตาราง cases
 *
 * case_visits เป็น ON DELETE CASCADE: เวลาเข้า–ออก รูปเซลฟี่ และค่าจ้างที่อนุมัติไปแล้วหายตามทั้งหมด
 * ส่วนใบแจ้งหนี้เป็น SET NULL: ใบยังอยู่แต่ขาดต้นทาง กดรีเฟรชไม่ได้อีกเลย
 * ทั้งสองอย่างเป็นหลักฐาน ไม่ใช่ข้อมูลชั่วคราว — ต้องให้คนกดรู้ตัวก่อน ไม่ใช่ลบเงียบๆ
 *
 * ใช้กติกาเดียวกับปิดเคส: เตือนพร้อมบอกว่าติดอะไรบ้าง แล้วยืนยันด้วย ?force=true ถ้ายังจะลบจริง
 * (ปกติควรใช้ "ยกเลิกเคส" แทน — เคสยังอยู่เป็นประวัติและกะที่ทำไปแล้วยังนับค่าจ้างตามเดิม)
 */
casesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    if (req.query.force !== 'true') {
      const [attended, bills] = await Promise.all([
        repo.attendedVisitCount(req.params.id),
        invoices.listForCase(req.params.id),
      ]);
      const live = bills.filter((b) => b.status !== 'cancelled');

      const blockers = [
        attended > 0 && `${attended} กะที่เช็คอินไปแล้ว (เวลาทำงาน รูปเช็คอิน และค่าจ้างจะหายไปด้วย)`,
        live.length > 0 && `ใบแจ้งหนี้ ${live.length} ใบที่ผูกกับเคสนี้`,
      ].filter(Boolean);

      if (blockers.length > 0) {
        throw new ApiError(
          409,
          `เคสนี้มีข้อมูลที่จะหายไปด้วย: ${blockers.join(' · ')} — แนะนำให้ "ยกเลิกเคส" แทน หรือยืนยันอีกครั้งถ้าต้องการลบจริง`,
          { attended_visits: attended, invoices: live.length },
        );
      }
    }

    await repo.remove(req.params.id);
    res.status(204).end();
  }),
);

// ---------- วันนัดให้บริการของเคส (ลงตารางว่าจะไปวันไหนบ้าง) ----------

/** เคสที่ปิด/ยกเลิกไปแล้วลงกะเพิ่มไม่ได้ — กะที่ลงไปจะไม่มีใครไปทำ และไปโผล่บนปฏิทินของพนักงาน */
function ensureSchedulable(caseRow) {
  if (isTerminal(caseRow)) {
    throw new ApiError(409, 'เคสนี้จบไปแล้ว — ต้องเปิดเคสใหม่ก่อนจึงจะลงกะเพิ่มได้');
  }
}

casesRouter.get(
  '/:id/visits',
  asyncRoute(async (req, res) => res.json(await repo.listVisits(req.params.id))),
);

casesRouter.post(
  '/:id/visits',
  asyncRoute(async (req, res) => {
    ensureSchedulable(req.case);
    const input = createVisitSchema.parse(req.body);
    res.status(201).json(await repo.addVisit(req.params.id, input));
  }),
);

/** ลงกะหลายวันในครั้งเดียว (วันที่เลือกไว้ หรือทั้งช่วง) — คืนกะทั้งหมด + จำนวนที่เพิ่ม/ข้าม + กะที่ชนกัน */
casesRouter.post(
  '/:id/visits/bulk',
  asyncRoute(async (req, res) => {
    ensureSchedulable(req.case);
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

/**
 * ลบกะทีละใบ — กะที่เช็คอินไปแล้วลบไม่ได้ (กติกาเดียวกับการลบเป็นช่วงใน removeVisitsOn)
 * ถ้าลงเวลาผิดให้ใช้ /adjust แก้เวลา หรือเปลี่ยนสถานะกะเป็น "ยกเลิก" แทนการลบทิ้ง
 */
casesRouter.delete(
  '/:id/visits/:visitId',
  asyncRoute(async (req, res) => {
    const visitId = Number(req.params.visitId);
    const deleted = await repo.removeVisit(req.params.id, visitId);

    if (!deleted) {
      const visit = await repo.findVisit(visitId);
      if (!visit || visit.case_id !== req.params.id) throw notFound('ไม่พบกะนี้');
      throw new ApiError(
        409,
        'กะนี้เช็คอินไปแล้ว ลบไม่ได้ — เป็นบันทึกการทำงานจริงและเป็นฐานค่าจ้าง (ถ้าลงผิดให้แก้เวลา หรือเปลี่ยนสถานะเป็นยกเลิก)',
      );
    }

    res.json(await repo.listVisits(req.params.id));
  }),
);

/** admin แก้กะที่เช็คอินผิดพลาด (ปิดกะค้าง / แก้เวลา / เคลียร์ธงนอกพื้นที่) — บันทึกผู้แก้ */
casesRouter.patch(
  '/:id/visits/:visitId/adjust',
  asyncRoute(async (req, res) => {
    const visitId = Number(req.params.visitId);
    const input = adjustVisitSchema.parse(req.body);

    /* schema ตรวจได้เฉพาะตอนส่งเวลามาครบคู่ — ส่งมาช่องเดียว (เช่น ปิดกะค้างโดยลงแค่เวลาออก)
       ต้องเทียบกับค่าที่มีอยู่จริง ไม่งั้นยังลงเวลาออกก่อนเวลาเข้าได้อยู่ดี
       กะที่ทำงานติดลบจะไปหักชั่วโมงของกะอื่นในเดือนเดียวกัน เพราะสรุปค่าตอบแทนรวมเป็นก้อนเดียว */
    const current = await repo.findVisit(visitId);
    if (!current || current.case_id !== req.params.id) throw notFound('ไม่พบกะนี้');

    const nextIn = 'check_in_at' in input ? input.check_in_at : current.check_in_at;
    const nextOut = 'check_out_at' in input ? input.check_out_at : current.check_out_at;

    /* new Date(x).getTime() ไม่ใช่ Date.parse(x) — ค่าที่มาจาก DB เป็น object Date อยู่แล้ว
       ส่ง object เข้า Date.parse มันจะแปลงเป็นข้อความก่อน ซึ่งทิ้งมิลลิวินาที
       เทียบข้ามชนิด (ของใหม่เป็นข้อความเต็มความละเอียด ของเดิมถูกปัด) จึงพลาดได้ในช่วงวินาทีเดียวกัน */
    const ms = (t) => new Date(t).getTime();
    if (nextIn && nextOut && ms(nextOut) <= ms(nextIn)) {
      throw new ApiError(400, 'เวลาออกต้องมาหลังเวลาเข้า');
    }

    res.json(await repo.adjustVisit(req.params.id, visitId, input, req.user));
  }),
);

/** รูปเซลฟี่เช็คอินของกะ — ให้ admin เปิดดูยืนยันว่าพนักงานอยู่หน้างานจริง */
casesRouter.get(
  '/:id/visits/:visitId/photo',
  asyncRoute(async (req, res, next) => {
    // ส่ง :id ไปกรองด้วย — กะของเคสอื่นต้องไม่หลุดออกทาง path ของเคสนี้
    const row = await repo.findVisitPhoto(Number(req.params.visitId), req.params.id);
    if (!row) return next(notFound('กะนี้ไม่มีรูปเช็คอิน'));
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.data);
  }),
);

// ---------- รายงานอาการผู้ป่วย (case_reports) ----------

/**
 * แก้รายงานหนึ่งใบ — ใช้ร่วมกับเส้นของพนักงานภาคสนาม (my/routes.js)
 * กติกา "ต้องเหลือเนื้อหาอย่างน้อยหนึ่งช่อง" ต้องเป็นชุดเดียวกันทั้งสองทาง ไม่งั้นทางหนึ่งจะรอด
 *
 * ตรวจกับผลลัพธ์หลังรวมของเดิม ไม่ใช่กับเฉพาะช่องที่ส่งมา — ส่ง symptoms: null มาช่องเดียว
 * เพื่อล้างข้อความทิ้ง ก็ทำให้รายงานทั้งใบว่างได้เหมือนกัน (zod มองไม่เห็นเพราะไม่รู้ของเดิม)
 */
/**
 * กะที่รายงานอ้างถึงต้องอยู่ในเคสเดียวกัน — ใช้ร่วมกับเส้นของพนักงานภาคสนาม
 * zod ตรวจให้ไม่ได้เพราะต้องถามฐานข้อมูล และถ้าไม่ตรวจ รายงานจะไปเกาะกะของเคสอื่นได้
 * (แล้วหน้าเคสนั้นจะขึ้น "ครั้งที่ 3" ของนัดที่ไม่เกี่ยวอะไรกันเลย)
 */
export async function ensureVisitInCase(caseId, visitId) {
  if (visitId == null) return;
  const visit = await repo.findVisit(visitId);
  if (!visit || visit.case_id !== caseId) {
    throw new ApiError(400, 'กะที่ระบุไม่ได้อยู่ในเคสนี้');
  }
}

export async function editReport(caseId, report, input) {
  if (!hasReportContent({ ...report, ...input })) {
    throw new ApiError(400, 'รายงานต้องมีข้อมูลอย่างน้อยหนึ่งช่อง — ถ้าต้องการลบทั้งใบให้กดลบรายงาน');
  }
  return repo.updateReport(caseId, report.report_id, input);
}

casesRouter.get(
  '/:id/reports',
  asyncRoute(async (req, res) => {
    const query = reportQuerySchema.parse(req.query);
    // ส่งรายการเดือนไปด้วยทุกครั้ง — เป็น GROUP BY เล็กๆ ที่ทำให้หน้าเว็บไม่ต้องยิงเส้นที่สอง
    const [pageData, months] = await Promise.all([
      repo.listReports(req.params.id, query),
      repo.reportMonths(req.params.id),
    ]);
    res.json({ ...pageData, months });
  }),
);

casesRouter.post(
  '/:id/reports',
  asyncRoute(async (req, res) => {
    const input = createReportSchema.parse(req.body ?? {});
    await ensureVisitInCase(req.params.id, input.visit_id);
    res.status(201).json(await repo.addReport(req.params.id, input, req.user));
  }),
);

casesRouter.patch(
  '/:id/reports/:reportId',
  asyncRoute(async (req, res) => {
    const report = await repo.findReport(req.params.id, Number(req.params.reportId));
    if (!report) throw notFound('ไม่พบรายงานนี้');

    const input = updateReportSchema.parse(req.body ?? {});
    await ensureVisitInCase(req.params.id, input.visit_id);
    res.json(await editReport(req.params.id, report, input));
  }),
);

/** รูปแผลที่แนบมากับรายงาน — ส่งไฟล์ออกไปตรงๆ ให้แท็ก <img> เรียกได้ (คุกกี้ session ไปเอง) */
casesRouter.get(
  '/:id/reports/:reportId/photo',
  asyncRoute(async (req, res, next) => {
    // กรอง :id ด้วยเสมอ — รูปของเคสอื่นต้องไม่หลุดออกทาง path ของเคสนี้
    const row = await repo.findReportPhoto(Number(req.params.reportId), req.params.id);
    if (!row) return next(notFound('รายงานนี้ไม่มีรูปแผล'));
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.data);
  }),
);

/**
 * ลบรายงานถาวร — เป็นบันทึกทางการแพทย์ จึงเปิดให้เฉพาะฝั่งหลังบ้าน (พนักงานภาคสนามลบของตัวเองไม่ได้)
 * กรอกผิดให้แก้ที่ใบเดิม ซึ่งเหลือ updated_at ไว้ให้เห็นว่าถูกแก้เมื่อไหร่
 */
casesRouter.delete(
  '/:id/reports/:reportId',
  asyncRoute(async (req, res) => {
    const deleted = await repo.removeReport(req.params.id, Number(req.params.reportId));
    if (!deleted) throw notFound('ไม่พบรายงานนี้');
    res.status(204).end();
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
