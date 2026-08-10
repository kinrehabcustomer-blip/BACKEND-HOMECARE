import { Router } from 'express';
import * as cases from '../cases/repo.js';
import { calendarQuerySchema } from '../cases/schema.js';
import { decodeImage } from '../employees/schema.js';
import { distanceMeters, DEFAULT_GEOFENCE_M } from '../lib/geo.js';
import { checkInSchema, checkOutSchema, attendanceQuerySchema } from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';

/**
 * ส่วนของ "พนักงานภาคสนาม" (field) — เห็น/แตะได้เฉพาะกะของตัวเอง
 *
 * ทุกเส้นกรองด้วย req.user.employee_id เสมอ (จาก session ไม่รับจาก query) — field จึงดู/เช็คอินของคนอื่นไม่ได้
 * ใช้ requireAuth อย่างเดียว (ไม่ requireAdmin) เพราะเป็นข้อมูลของผู้เรียกเอง (admin เรียกก็เห็นเฉพาะที่ตัวเองถือ)
 */
export const myRouter = Router();

// ค่าจ้างที่บริษัทได้ ไม่ให้พนักงานภาคสนามเห็น (ใช้กับ SELECT ของ listForEmployee ที่มี fee ติดมา)
const stripFinancial = ({ fee, ...rest }) => rest;

// เคสที่จบแล้ว เช็คอินไม่ได้
const CLOSED_CASE = ['closed', 'cancelled'];

// วันปัจจุบันโซนไทย 'YYYY-MM-DD'
const todayTH = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);

/** รูปไม่ถูกต้อง = ความผิดของผู้ส่ง (400) ไม่ใช่ระบบพัง (500) */
function toImage(dataUrl) {
  if (!dataUrl) return null;
  try {
    return decodeImage(dataUrl);
  } catch (err) {
    throw new ApiError(400, err.message);
  }
}

/** โหลดกะจาก :id แล้วยืนยันว่าเป็นกะของผู้เรียก — ไม่ใช่ก็คืน null (route ตอบ 404 เหมือนไม่มี ไม่บอกใบ้) */
async function myVisit(req) {
  const visit = await cases.findVisit(Number(req.params.id));
  if (!visit || visit.assigned_to !== req.user.employee_id) return null;
  return visit;
}

// ---------- เคสของฉัน (อ่านอย่างเดียว) ----------

/** เคสทั้งหมดที่ฉันรับผิดชอบ (assigned_to = ฉัน) — ใหม่ไปเก่า */
myRouter.get(
  '/cases',
  asyncRoute(async (req, res) => {
    const rows = await cases.listForEmployee(req.user.employee_id);
    res.json(rows.map(stripFinancial));
  }),
);

/**
 * รายละเอียดเคสของฉัน — ต้องเป็นเคสที่ฉันรับเท่านั้น ไม่งั้น 404
 * ตอบ "ไม่พบ" เหมือนกันทั้งกรณีไม่มีเคสและเป็นเคสคนอื่น — ไม่บอกใบ้ว่ามีเคสรหัสนี้อยู่จริง
 */
myRouter.get(
  '/cases/:id',
  asyncRoute(async (req, res, next) => {
    const caseRow = await cases.findById(req.params.id);
    if (!caseRow || !(await cases.hasFieldAccess(req.user.employee_id, req.params.id))) {
      return next(notFound('ไม่พบเคสนี้ หรือไม่ใช่เคสที่คุณรับผิดชอบ'));
    }
    const visits = await cases.listVisits(req.params.id);
    res.json({ ...stripFinancial(caseRow), visits });
  }),
);

// ---------- ตารางงาน ----------

/** ตารางงานของฉันวันนี้ (กะทั้งหมด พร้อมสถานะเช็คอิน) — หน้าหลักของพนักงานภาคสนาม */
myRouter.get(
  '/today',
  asyncRoute(async (req, res) => {
    res.json(await cases.visitsForEmployeeOn(req.user.employee_id, todayTH()));
  }),
);

/**
 * ตารางงานรายเดือนของฉัน — บังคับดูของตัวเองเท่านั้น (employee_id จาก session ไม่รับจาก query)
 * ข้อมูลปฏิทินไม่มี fee อยู่แล้ว (ดู cases.calendar) จึงไม่ต้องกรองการเงินเพิ่ม
 */
myRouter.get(
  '/calendar',
  asyncRoute(async (req, res) => {
    const { year, month } = calendarQuerySchema.parse({ year: req.query.year, month: req.query.month });
    res.json(await cases.calendar({ year, month, employee_id: req.user.employee_id }));
  }),
);

/**
 * สรุปค่าตอบแทนของฉัน (รายเดือน) — ต้องมาก่อน '/attendance' ไม่ให้ path ชนกัน
 * ใช้ตัวคำนวณเดียวกับหน้า payroll ของ admin แต่บังคับกรองด้วย employee_id จาก session
 *
 * ยอดเงินมาจากกะที่เช็คอิน/เอาท์ครบในเดือนนั้น — ส่งรายการเคสไปด้วยเพื่อให้กางดูที่มาของยอดได้
 * ยังไม่มีข้อมูลในเดือนนั้น = ไม่มีแถวกลับมา ตอบเป็นศูนย์แทน null ให้หน้าเว็บแสดงได้เลย
 */
myRouter.get(
  '/attendance/report',
  asyncRoute(async (req, res) => {
    const { month } = attendanceQuerySchema.parse({ month: req.query.month || undefined });
    const ym = month ?? todayTH().slice(0, 7);
    const me = req.user.employee_id;

    const [[row], paidCases, openCases] = await Promise.all([
      cases.attendanceReport(ym, me),
      cases.payoutCases(ym, me),
      cases.openCaseCount(me),
    ]);

    res.json({
      ...(row ?? {
        employee_id: me,
        employee_name: req.user.name,
        shifts: 0,
        cases_worked: 0,
        minutes: 0,
        pay: 0,
        unpriced_shifts: 0,
      }),
      cases: paidCases,
      open_cases: openCases,
    });
  }),
);

/** ประวัติการมาทำงานของฉัน (รายเดือน) — ไม่ส่ง month = เดือนปัจจุบัน */
myRouter.get(
  '/attendance',
  asyncRoute(async (req, res) => {
    const { month } = attendanceQuerySchema.parse({ month: req.query.month || undefined });
    res.json(await cases.attendanceForEmployee(req.user.employee_id, month ?? todayTH().slice(0, 7)));
  }),
);

// ---------- เช็คอิน / เช็คเอาท์ ----------

/** นาทีระหว่างเวลานัดกับเวลาที่เช็คอินจริง ('HH:MM' ทั้งคู่) — ติดลบ = มาก่อนเวลา */
const minutesBetween = (from, to) => {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return th * 60 + tm - (fh * 60 + fm);
};

/**
 * เช็คอินกะ — เวลาใช้ now() ของ server (กันปลอมเวลา)
 * geofence: เกินรัศมี/ไม่มีพิกัด = flag ให้ admin ตรวจ ไม่บล็อกการเช็คอิน (GPS คลาดได้)
 * วันนัด: กะในอนาคตกดไม่ได้ · กะของวันที่ผ่านมาแล้วกดได้แต่ติดธง "นอกวันนัด" ให้ admin ตรวจ
 */
myRouter.post(
  '/visits/:id/check-in',
  asyncRoute(async (req, res, next) => {
    const visit = await myVisit(req);
    if (!visit) return next(notFound('ไม่พบกะนี้ หรือไม่ใช่กะที่คุณรับผิดชอบ'));
    if (CLOSED_CASE.includes(visit.case_status)) throw new ApiError(409, 'เคสนี้จบไปแล้ว เช็คอินไม่ได้');
    if (visit.check_in_at) throw new ApiError(409, 'คุณเช็คอินกะนี้ไปแล้ว');

    // เทียบกับนาฬิกาของฐานข้อมูล = ตัวเดียวกับที่จะถูกบันทึกเป็น check_in_at
    const now = await cases.serverNowTH();
    if (visit.visit_date > now.date) {
      throw new ApiError(409, 'ยังไม่ถึงวันนัดของกะนี้ — เช็คอินได้ตั้งแต่วันที่นัดไว้');
    }

    const offSchedule = visit.visit_date !== now.date;
    // สายเทียบได้เฉพาะกะที่ระบุเวลานัดและเช็คอินในวันนัดจริง
    // กะที่กดย้อนวันจะได้ตัวเลข "สาย" เป็นพันนาทีซึ่งไม่มีความหมาย ใช้ธงนอกวันนัดแทน
    const lateMinutes =
      visit.planned_start && !offSchedule
        ? Math.max(0, minutesBetween(visit.planned_start, now.time))
        : null;

    const input = checkInSchema.parse(req.body ?? {});
    const photo = toImage(input.photo);

    // ระยะจากพิกัดเคส — เทียบได้ต่อเมื่อเคสตั้งพิกัดไว้ + พนักงานส่งพิกัดมา
    let distance = null;
    let flagged = false;
    if (input.lat == null || input.lng == null) {
      flagged = true; // ไม่มีพิกัด (ปฏิเสธ GPS/ไม่มีสัญญาณ) = ต้องให้ admin ดู
    } else if (visit.case_geo_lat != null && visit.case_geo_lng != null) {
      distance = distanceMeters(input.lat, input.lng, visit.case_geo_lat, visit.case_geo_lng);
      flagged = distance > (visit.case_radius ?? DEFAULT_GEOFENCE_M);
    }

    const result = await cases.checkInVisit(visit.visit_id, {
      employee_id: req.user.employee_id,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      accuracy: input.accuracy ?? null,
      distance,
      flagged,
      photo,
      late_minutes: lateMinutes,
      off_schedule: offSchedule,
    });
    if (!result) throw new ApiError(409, 'คุณเช็คอินกะนี้ไปแล้ว'); // แข่งกดพร้อมกัน
    res.json(result);
  }),
);

/** เช็คเอาท์กะ — ต้องเช็คอินแล้วและยังไม่เคยออก */
myRouter.post(
  '/visits/:id/check-out',
  asyncRoute(async (req, res, next) => {
    const visit = await myVisit(req);
    if (!visit) return next(notFound('ไม่พบกะนี้ หรือไม่ใช่กะที่คุณรับผิดชอบ'));
    if (!visit.check_in_at) throw new ApiError(409, 'ยังไม่ได้เช็คอินกะนี้');
    if (visit.check_out_at) throw new ApiError(409, 'คุณเช็คเอาท์กะนี้ไปแล้ว');

    const input = checkOutSchema.parse(req.body ?? {});
    const result = await cases.checkOutVisit(visit.visit_id, { lat: input.lat ?? null, lng: input.lng ?? null });
    if (!result) throw new ApiError(409, 'เช็คเอาท์ไม่สำเร็จ');
    res.json(result);
  }),
);

/** ส่งไฟล์รูปเซลฟี่ตอนเช็คอินออกไปตรงๆ — แท็ก <img> เรียกเส้นนี้ (คุกกี้ session ไปด้วยอัตโนมัติ) */
myRouter.get(
  '/visits/:id/photo',
  asyncRoute(async (req, res, next) => {
    const visit = await myVisit(req);
    if (!visit) return next(notFound('ไม่พบกะนี้'));

    const row = await cases.findVisitPhoto(visit.visit_id);
    if (!row) return next(notFound('กะนี้ไม่มีรูปเช็คอิน'));

    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.data);
  }),
);
