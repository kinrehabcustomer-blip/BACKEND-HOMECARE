import { z } from 'zod';

export const CASE_TYPES = [
  'elderly_care',
  'bedridden_care',
  'post_op_care',
  'physiotherapy',
  'wound_care',
  'hospital_watch',
  'medical_escort',
  'other',
];

export const CASE_STATUSES = ['unassigned', 'assigned', 'in_progress', 'closed', 'cancelled'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ต้องอยู่ในรูปแบบ YYYY-MM-DD');
const optionalText = z.string().trim().max(500).optional().nullable();
const optionalLongText = z.string().trim().max(2000).optional().nullable(); // อาการ/โรคประจำตัว เขียนยาวได้

export const SERVICE_KINDS = ['homecare', 'physio'];

export const createCaseSchema = z.object({
  // ชื่อเคสถูกสร้างอัตโนมัติจากแพ็คเกจ + ชื่อผู้ป่วย (ไม่มีช่องให้กรอกแล้ว) — รับค่าที่ส่งมาได้แต่ไม่บังคับ
  title: z.string().trim().max(200).optional().nullable(),
  case_type: z.enum(CASE_TYPES, { errorMap: () => ({ message: 'ประเภทเคสไม่ถูกต้อง' }) }),

  // ลูกค้าที่เคสนี้ให้บริการ — เลือกแล้วระบบเติมข้อมูลผู้ป่วยด้านล่างให้อัตโนมัติ (เว้นว่างได้)
  customer_id: z.string().trim().optional().nullable(),
  // ผู้รับการดูแล (แฟ้มถาวรใน patients) — ผูกเมื่อเปิดเคสจากหน้าผู้ป่วย (เว้นว่างได้)
  patient_id: z.string().trim().optional().nullable(),

  // สายบริการที่เลือก: 'homecare' ใช้ตารางเรท (เกรด+รูปแบบ+ระดับ) | 'physio' ใช้แพ็คเกจกายภาพบำบัด (เว้นว่างได้ = ไม่ระบุบริการ)
  service_kind: z.enum(SERVICE_KINDS, { errorMap: () => ({ message: 'สายบริการไม่ถูกต้อง' }) }).optional().nullable(),

  // [homecare] เลือกเกรด + รูปแบบ + ระดับพนักงาน แล้วระบบเติมค่าจ้างจากค่าบริการให้
  pkg_grade_id: z.number().int().optional().nullable(), // ว่างได้ถ้ารูปแบบไม่อิงเกรด
  pkg_format_id: z.number().int().optional().nullable(),
  pkg_staff_tier: z.enum(['CG', 'NA', 'PN', 'RN']).optional().nullable(),

  // [physio] แพ็คเกจกายภาพบำบัดที่ซื้อ — ระบบเติมค่าจ้างจากราคาพิเศษให้
  physio_package_id: z.number().int().optional().nullable(),

  // ---------- รายละเอียดผู้ป่วย ----------
  client_name: z.string().trim().min(1, 'กรุณากรอกชื่อผู้ป่วย').max(200),
  patient_gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  patient_age: z
    .number()
    .int('อายุต้องเป็นจำนวนเต็ม')
    .min(0, 'อายุต้องไม่ติดลบ')
    .max(130, 'อายุไม่ถูกต้อง')
    .optional()
    .nullable(),
  weight_kg: z.number().positive('น้ำหนักต้องมากกว่า 0').max(500).optional().nullable(),
  height_cm: z.number().positive('ส่วนสูงต้องมากกว่า 0').max(300).optional().nullable(),
  medical_history: optionalLongText,
  current_symptoms: optionalLongText,
  medical_devices: optionalLongText,
  care_goal: optionalLongText,

  // ---------- รายละเอียดการใช้บริการ ----------
  service_start_preference: optionalText,
  address: optionalText,
  client_phone: z
    .string()
    .regex(/^[0-9+\-\s]{8,20}$/, 'เบอร์โทรไม่ถูกต้อง')
    .optional()
    .nullable(),
  nurse_call_preference: optionalText,

  start_date: date.optional().nullable(),
  end_date: date.optional().nullable(),
  fee: z.number().nonnegative('ค่าจ้างต้องไม่ติดลบ').optional().nullable(),

  // พิกัดสถานที่ดูแล (สำหรับ geofence ตอนเช็คอิน) — ตั้งจาก geocode ที่อยู่ หรือกรอกมือ
  geo_lat: z.number().min(-90).max(90).optional().nullable(),
  geo_lng: z.number().min(-180).max(180).optional().nullable(),
  geofence_radius_m: z.number().int().positive().max(5000).optional().nullable(),

  note: optionalText,

  // จับคู่พนักงานตั้งแต่ตอนสร้างเคยได้ ถ้าเว้นว่างจะเป็น 'ยังไม่จับคู่พนักงาน'
  assigned_to: z.string().trim().optional().nullable(),
});

// สถานะเปลี่ยนผ่าน endpoint เฉพาะ (assign/unassign/close/reopen) เท่านั้น ไม่ให้แก้ตรงๆ
// เพื่อไม่ให้เกิดกรณี 'จับคู่แล้ว' แต่ไม่มีพนักงาน
export const updateCaseSchema = createCaseSchema.omit({ assigned_to: true }).partial();

export const assignSchema = z.object({
  employee_id: z.string().trim().min(1, 'กรุณาเลือกพนักงาน'),
});

// ยกเลิกเคส — เหตุผลไม่บังคับ แต่เก็บไว้ให้ไล่ประวัติได้ว่าทำไมถึงยกเลิก
export const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional().nullable(),
});

/**
 * ปิดเคส — end_date ลงเป็นวันสิ้นสุดบริการ · force = ยืนยันแล้วว่ารู้ว่ายังมีกะค้าง
 *
 * เดิมอ่านสองค่านี้จาก req.body ตรงๆ โดยไม่ผ่านตัวตรวจ (เส้นอื่นผ่านหมด) วันที่ผิดรูปจึงวิ่งไปตาย
 * ที่ฐานข้อมูลด้วยรหัส 22007 ซึ่งไม่มีในตารางแปลข้อความ กลายเป็น 500 "เกิดข้อผิดพลาดภายในระบบ"
 * ทั้งที่เป็นแค่ค่าที่กรอกผิด — ตรวจตรงนี้แล้วได้ 400 ที่บอกได้ว่าผิดช่องไหน
 */
export const closeCaseSchema = z.object({
  end_date: date.optional().nullable(),
  force: z.boolean().optional(),
});

// ช่วงเวลาที่เปิดเคส — ปีและเดือนแยกกัน (เดือนใช้ได้ต่อเมื่อระบุปีด้วย)
export const periodSchema = z.object({
  year: z.string().regex(/^\d{4}$/, 'ปีต้องเป็นตัวเลข 4 หลัก (ค.ศ.)').optional(),
  month: z.string().regex(/^(0[1-9]|1[0-2])$/, 'เดือนต้องเป็น 01–12').optional(),
});

// ---------- วันนัดให้บริการ = "กะงาน" (case_visits) ----------
export const VISIT_STATUSES = ['scheduled', 'done', 'cancelled'];

// เวลานัด 'HH:MM' แบบ 24 ชม. — ว่างได้ (บางเคสไม่กำหนดเวลาตายตัว)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'เวลาต้องอยู่ในรูปแบบ HH:MM (24 ชม.)');

// ค่าจ้างเฉพาะกะ — เว้นว่าง = เกลี่ยจากยอดเคสหารจำนวนกะที่นัดไว้ (ดู VISIT_PAY ใน repo)
const visitPay = z.number().nonnegative('ค่าจ้างต้องไม่ติดลบ');

export const createVisitSchema = z.object({
  visit_date: date,
  // พนักงานที่นัดให้ไปกะนี้ — เว้นว่าง = ใช้ผู้รับผิดชอบหลักของเคส (repo เติมให้)
  assigned_to: z.string().trim().min(1).optional().nullable(),
  planned_start: time.optional().nullable(),
  planned_end: time.optional().nullable(),
  staff_pay: visitPay.optional().nullable(),
  note: optionalText,
});

// จำนวนกะสูงสุดต่อการสร้างหนึ่งครั้ง — ตารางจริงของเคสหนึ่งเดือนอยู่ราว 30 กะ
// เผื่อไว้ถึง 200 สำหรับเคสยาวข้ามไตรมาส แต่ไม่ปล่อยไม่จำกัด กันกรอกปีผิดแล้วได้กะเป็นพัน
const MAX_BULK_VISITS = 200;

/** ทุกวันในช่วง (รวมวันเริ่ม–วันจบ) ที่ตรงกับวันในสัปดาห์ที่เลือก — คิดบน UTC ให้วันไม่เลื่อนตามโซนเครื่อง */
function datesInRange(from, to, weekdays) {
  const out = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const d = new Date(t);
    if (weekdays?.length && !weekdays.includes(d.getUTCDay())) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * ลงกะหลายวันในครั้งเดียว — รับได้สองแบบ:
 *   dates: ['2026-08-10', ...]           = วันที่เลือกไว้บนปฏิทิน (หน้าเว็บใช้แบบนี้)
 *   from/to (+weekdays)                  = ทั้งช่วง เช่น จันทร์–ศุกร์ ทั้งเดือน
 * weekdays = วันในสัปดาห์ที่ให้ลง (0=อาทิตย์ … 6=เสาร์) · เว้นว่าง = ทุกวันในช่วง
 */
export const bulkVisitSchema = z
  .object({
    dates: z.array(date).optional(),
    from: date.optional(),
    to: date.optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    assigned_to: z.string().trim().min(1).optional().nullable(),
    planned_start: time.optional().nullable(),
    planned_end: time.optional().nullable(),
    staff_pay: visitPay.optional().nullable(),
    note: optionalText,
  })
  .superRefine((v, ctx) => {
    const listed = v.dates?.length ?? 0;
    if (listed === 0 && !(v.from && v.to)) {
      ctx.addIssue({ code: 'custom', path: ['dates'], message: 'กรุณาเลือกวันที่จะลงกะ' });
      return;
    }

    if (listed === 0) {
      if (v.to < v.from) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'วันสิ้นสุดต้องไม่มาก่อนวันเริ่ม' });
        return;
      }
      if (datesInRange(v.from, v.to, v.weekdays).length === 0) {
        ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'ช่วงที่เลือกไม่มีวันไหนตรงกับวันในสัปดาห์ที่ระบุ' });
      }
    }

    const n = listed || datesInRange(v.from, v.to, v.weekdays).length;
    if (n > MAX_BULK_VISITS) {
      ctx.addIssue({
        code: 'custom',
        path: listed ? ['dates'] : ['to'],
        message: `ครั้งนี้จะได้ ${n} กะ ซึ่งเกิน ${MAX_BULK_VISITS} กะต่อครั้ง — แบ่งเป็นช่วงย่อยก่อน`,
      });
    }
  })
  // ส่งวันซ้ำมาก็ลงครั้งเดียว และเรียงให้เสมอ ผลลัพธ์จะได้ไม่ขึ้นกับลำดับที่ผู้ใช้แตะปฏิทิน
  .transform((v) => ({
    ...v,
    dates: v.dates?.length ? [...new Set(v.dates)].sort() : datesInRange(v.from, v.to, v.weekdays),
  }));

/**
 * ตรวจก่อนบันทึกว่าวันที่เลือกไว้จะชนกับงานอื่นของคนคนนั้นไหม
 * แยกจาก bulk เพราะหน้าเว็บเรียกทุกครั้งที่ผู้ใช้เปลี่ยนวัน/คน/เวลา ซึ่งยังไม่ใช่การบันทึก
 */
export const previewVisitsSchema = z.object({
  dates: z.array(date).min(1, 'กรุณาเลือกวันที่จะลงกะ').max(MAX_BULK_VISITS),
  assigned_to: z.string().trim().min(1).optional().nullable(),
  planned_start: time.optional().nullable(),
  planned_end: time.optional().nullable(),
});

/**
 * ลบกะหลายวัน — ระบุเป็นช่วง (from/to) หรือรายวัน (dates) ก็ได้
 * กะที่เช็คอินไปแล้วระบบจะข้ามให้เองทั้งสองแบบ (ดู removeVisitsOn)
 */
export const visitRangeSchema = z
  .object({
    dates: z.array(date).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.dates?.length) return;
    if (!v.from || !v.to) {
      ctx.addIssue({ code: 'custom', path: ['dates'], message: 'ต้องระบุวันที่จะลบ (dates หรือ from/to)' });
      return;
    }
    if (v.to < v.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'วันสิ้นสุดต้องไม่มาก่อนวันเริ่ม' });
    }
  })
  .transform((v) => ({
    ...v,
    dates: v.dates?.length ? [...new Set(v.dates)].sort() : datesInRange(v.from, v.to),
  }));

// แก้ได้ทั้งเลื่อนวัน เปลี่ยนคนที่ไป เวลานัด ค่าจ้าง สถานะ (ไปมาแล้ว/ไม่ได้ไป) และหมายเหตุ
export const updateVisitSchema = z
  .object({
    visit_date: date,
    assigned_to: z.string().trim().min(1).nullable(),
    planned_start: time.nullable(),
    planned_end: time.nullable(),
    staff_pay: visitPay.nullable(),
    status: z.enum(VISIT_STATUSES, { errorMap: () => ({ message: 'สถานะวันนัดไม่ถูกต้อง' }) }),
    note: optionalText,
  })
  .partial();

// ---------- ระบบเช็คอิน (ฝั่ง admin) ----------

// geocode ที่อยู่เป็นพิกัด (ผ่าน server) — ตั้งพิกัดเคส
export const geocodeSchema = z.object({
  address: z.string().trim().min(1, 'กรุณากรอกที่อยู่'),
});

// อ่านพิกัดจากลิงก์ Google Maps ที่ผู้ใช้วางมา
export const mapLinkSchema = z.object({
  url: z.string().trim().min(1, 'กรุณาวางลิงก์ Google Maps'),
});

// ค้นหาสถานที่จากการพิมพ์ชื่อ/ที่อยู่
// near_lat/near_lng = พิกัดที่หน้าเว็บมีอยู่แล้ว ส่งมาเพื่อให้ผลใกล้จุดนั้นขึ้นก่อน (ไม่บังคับ)
// ส่งมาไม่ครบคู่ = ไม่เอนเอียง ไม่ใช่ error — เป็นแค่ตัวช่วย ไม่ควรทำให้ค้นหาไม่ได้
export const placeSearchSchema = z.object({
  query: z.string().trim().min(1, 'กรุณาพิมพ์ชื่อสถานที่ที่ต้องการค้นหา'),
  near_lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  near_lng: z.coerce.number().min(-180).max(180).optional().nullable(),
});

// admin แก้กะที่เช็คอินผิดพลาด — ปิดกะที่ค้าง / แก้เวลา / เคลียร์ธงนอกพื้นที่
// เวลาเป็น ISO timestamp เต็ม (มี timezone) เพราะเป็น TIMESTAMPTZ ในฐานข้อมูล
const isoDateTime = z.string().datetime({ offset: true, message: 'ต้องเป็นเวลา ISO (เช่น 2026-07-24T09:00:00+07:00)' });
export const adjustVisitSchema = z
  .object({
    check_in_at: isoDateTime.nullable(),
    check_out_at: isoDateTime.nullable(),
    status: z.enum(VISIT_STATUSES, { errorMap: () => ({ message: 'สถานะวันนัดไม่ถูกต้อง' }) }),
    location_flagged: z.boolean(),
  })
  .partial()
  .superRefine((v, ctx) => {
    /* เวลาออกต้องมาหลังเวลาเข้า — ไม่งั้นได้กะที่ทำงานติดลบ แล้วไปหักชั่วโมงของกะอื่น
       ในสรุปค่าตอบแทน (SUM(check_out_at - check_in_at) ของทั้งเดือนรวมกันเป็นก้อนเดียว)
       ตรวจได้ที่นี่เฉพาะตอนส่งมาครบคู่ — ส่งมาช่องเดียวต้องเทียบกับค่าที่มีอยู่ใน DB (ดู route) */
    if (v.check_in_at && v.check_out_at && Date.parse(v.check_out_at) <= Date.parse(v.check_in_at)) {
      ctx.addIssue({ code: 'custom', path: ['check_out_at'], message: 'เวลาออกต้องมาหลังเวลาเข้า' });
    }
  });

/**
 * อนุมัติ/ไม่อนุมัติค่าจ้างของกะ (ทีละหลายกะได้)
 * เหตุผลบังคับเฉพาะตอน "ไม่อนุมัติ" — เป็นสิ่งเดียวที่พนักงานจะได้รู้ว่าทำไมกะนั้นไม่ได้เงิน
 */
export const decidePaySchema = z
  .object({
    visit_ids: z.array(z.number().int().positive()).min(1, 'กรุณาเลือกกะที่จะอนุมัติ').max(500),
    approve: z.boolean(),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (!v.approve && !v.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'กรุณาระบุเหตุผลที่ไม่อนุมัติ' });
    }
  });

// รายการมาทำงาน (admin) — เดือน + กรองพนักงาน (เว้นได้ทั้งคู่)
export const attendanceQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนต้องอยู่ในรูปแบบ YYYY-MM').optional(),
  employee_id: z.string().trim().min(1).optional(),
});

// ปฏิทินตารางงาน — ต้องระบุทั้งปีและเดือน (ต่างจาก periodSchema ที่เว้นได้)
// employee_id เว้นว่าง = ดูตารางของทุกคนรวมกัน
export const calendarQuerySchema = z.object({
  year: z.string().regex(/^\d{4}$/, 'ปีต้องเป็นตัวเลข 4 หลัก (ค.ศ.)'),
  month: z.string().regex(/^(0[1-9]|1[0-2])$/, 'เดือนต้องเป็น 01–12'),
  employee_id: z.string().trim().min(1).optional(),
});

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(CASE_STATUSES).optional(),
  case_type: z.enum(CASE_TYPES).optional(),
  assigned_to: z.string().trim().optional(),
  year: z.string().regex(/^\d{4}$/).optional(),
  month: z.string().regex(/^(0[1-9]|1[0-2])$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['case_id', 'title', 'start_date', 'created_at']).default('case_id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
