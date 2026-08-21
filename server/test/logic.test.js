/**
 * เทสตรรกะล้วน — ไม่ต่อฐานข้อมูล ไม่ยิง query สักตัว
 *
 * รันด้วย `npm test` (จาก root หรือจาก server/) — ปลอดภัยเสมอ ใครกดก็ได้
 * ชุดที่ต้องใช้ฐานข้อมูลอยู่แยกที่ api.test.js และต้องสั่งเปิดเองถึงจะทำงาน
 *
 * ครอบเรื่องที่พังได้เงียบๆ และตรวจด้วยตาไม่เจอ: การเทียบเวลาเช็คอิน–เอาท์,
 * สิทธิ์ตามตำแหน่ง, การกันเลื่อนตำแหน่งตัวเอง, และการตัดข้อความ error ดิบ
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/* โหลด .env ถ้ามี แล้วเติมค่าหลอกให้ตัวแปรที่ยังขาด
   โมดูลที่เทสนี้เรียกใช้ (cases/repo.js -> db/index.js, lib/auth.js) โยน error ตั้งแต่ตอน import
   ถ้าไม่มี DATABASE_URL/JWT_SECRET — เติมให้จึงรันได้ทุกเครื่อง แม้เครื่องที่ยังไม่ได้ตั้ง .env
   ค่าหลอกนี้ไม่เคยถูกใช้ต่อ เพราะไม่มี query ไหนถูกยิงในไฟล์นี้ (Pool ของ pg ไม่ต่อจนกว่าจะ query) */
await import('../src/lib/env.js');
process.env.DATABASE_URL ||= 'postgresql://placeholder/placeholder';
process.env.JWT_SECRET ||= 'x'.repeat(48);

const { adjustVisitSchema, bulkVisitSchema, visitRangeSchema, createReportSchema, hasReportContent, REPORT_CONTENT_FIELDS } = await import('../src/cases/schema.js');
const { createRunSchema } = await import('../src/payroll/schema.js');
const { checkInSchema } = await import('../src/my/schema.js');
const { withVisitState, allocateShares, weightsFor, MAX_INSTALLMENTS } = await import('../src/cases/repo.js');
const { distanceMeters, DEFAULT_GEOFENCE_M } = await import('../src/lib/geo.js');
const { roleForPosition, canSeeStaffPay, stripPayFields, BLOCKED_STATUSES } = await import('../src/lib/auth.js');
const { errorHandler, ApiError } = await import('../src/lib/errors.js');
const guards = await import('../src/employees/routes.js');

// ---------- เวลาออกต้องมาหลังเวลาเข้า ----------
describe('adjustVisitSchema — กันเวลาออกมาก่อนเวลาเข้า', () => {
  const iso = (t) => `2026-08-10T${t}+07:00`;

  test('เวลาออกหลังเวลาเข้า = ผ่าน', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_in_at: iso('09:00:00'), check_out_at: iso('17:00:00') }).success, true);
  });

  test('เวลาออกก่อนเวลาเข้า = ถูกปฏิเสธ', () => {
    const r = adjustVisitSchema.safeParse({ check_in_at: iso('17:00:00'), check_out_at: iso('09:00:00') });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /เวลาออกต้องมาหลังเวลาเข้า/);
    assert.deepEqual(r.error.issues[0].path, ['check_out_at']);
  });

  test('เวลาเข้า = เวลาออก (ทำงาน 0 นาที) = ถูกปฏิเสธ', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_in_at: iso('17:13:00'), check_out_at: iso('17:13:00') }).success, false);
  });

  test('ส่งมาช่องเดียว = ผ่านที่ชั้น schema (ชั้น route เทียบกับค่าใน DB ต่อ)', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_out_at: iso('17:00:00') }).success, true);
    assert.equal(adjustVisitSchema.safeParse({ location_flagged: false }).success, true);
  });

  test('ล้างเวลาทิ้ง (null) ยังทำได้', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_in_at: null, check_out_at: null }).success, true);
  });
});

describe('การเทียบเวลาข้ามชนิด (Date object จาก DB กับ ISO string จาก client)', () => {
  test('Date.parse บน object ทิ้งมิลลิวินาที — จึงเทียบพลาดในวินาทีเดียวกัน', () => {
    const fromDb = new Date('2026-08-10T15:47:56.473+07:00');   // pg คืน TIMESTAMPTZ มาเป็น Date
    const fromClient = '2026-08-10T15:47:56.100+07:00';          // จริงๆ แล้ว "ก่อน" ค่าใน DB

    assert.equal(Date.parse(fromClient) <= Date.parse(fromDb), false, 'วิธีเดิมมองว่าเวลาออกมาทีหลัง (พลาด)');
    assert.equal(new Date(fromClient).getTime() <= new Date(fromDb).getTime(), true, 'วิธีที่ใช้จริงจับได้');
  });
});

// ---------- สถานะกะที่คำนวณตอนอ่าน ----------
describe('withVisitState', () => {
  const now = new Date('2026-08-10T12:00:00+07:00');
  const at = (t) => new Date(`2026-08-10T${t}+07:00`);

  test('ยกเลิก มาก่อนทุกอย่าง', () => {
    assert.equal(withVisitState({ status: 'cancelled', check_in_at: at('08:00:00') }, now).state, 'cancelled');
  });
  test('เช็คเอาท์แล้ว = done + นับนาทีถูก', () => {
    const v = withVisitState({ status: 'scheduled', check_in_at: at('08:00:00'), check_out_at: at('11:30:00') }, now);
    assert.equal(v.state, 'done');
    assert.equal(v.worked_minutes, 210);
  });
  test('เช็คอินแล้วยังไม่ออก = working', () => {
    assert.equal(withVisitState({ status: 'scheduled', check_in_at: at('08:00:00') }, now).state, 'working');
  });
  test('ค้างเกิน 16 ชม. = stale', () => {
    assert.equal(withVisitState({ status: 'scheduled', check_in_at: new Date('2026-08-09T10:00:00+07:00') }, now).state, 'stale');
  });
  test('เลยวันแล้วไม่เช็คอิน = missed', () => {
    assert.equal(withVisitState({ status: 'scheduled', visit_date: '2026-08-09' }, now).state, 'missed');
  });
  test('ยังไม่ถึงวัน = scheduled', () => {
    assert.equal(withVisitState({ status: 'scheduled', visit_date: '2026-08-11' }, now).state, 'scheduled');
  });
});

// ---------- สิทธิ์ตามตำแหน่ง ----------
describe('สิทธิ์ตามตำแหน่ง', () => {
  test('manager/hr = admin · ที่เหลือ = field', () => {
    assert.equal(roleForPosition('manager'), 'admin');
    assert.equal(roleForPosition('hr'), 'admin');
    for (const p of ['caregiver', 'assistant_nurse', 'practical_nurse', 'nurse', 'therapist']) {
      assert.equal(roleForPosition(p), 'field');
    }
  });

  test('เห็นค่าจ้าง/กำไร = manager เท่านั้น (แคบกว่า admin)', () => {
    assert.equal(canSeeStaffPay('manager'), true);
    assert.equal(canSeeStaffPay('hr'), false);
    assert.equal(canSeeStaffPay('nurse'), false);
    assert.equal(canSeeStaffPay(undefined), false);
  });

  test('stripPayFields ตัด staff_pay/margin/staff_share ทิ้ง แต่คงราคาลูกค้าไว้', () => {
    assert.deepEqual(
      stripPayFields({ customer_price: 15000, staff_pay: 9000, margin: 40, staff_share: 60, name: 'x' }),
      { customer_price: 15000, name: 'x' },
    );
  });

  test('BLOCKED_STATUSES ครอบ resigned/suspended และไม่บล็อกสถานะที่ยังทำงานอยู่', () => {
    assert.ok(BLOCKED_STATUSES.resigned);
    assert.ok(BLOCKED_STATUSES.suspended);
    for (const ok of ['active', 'probation', 'on_leave']) {
      assert.equal(BLOCKED_STATUSES[ok], undefined, `${ok} ต้องไม่ถูกบล็อก`);
    }
  });
});

// ---------- กันเลื่อนตำแหน่ง ----------
describe('ตัวกันเลื่อนตำแหน่ง (employees)', () => {
  const asHr = { user: { employee_id: 'EMP-0007', position: 'hr' } };
  const asManager = { user: { employee_id: 'EMP-0001', position: 'manager' } };
  const someone = { employee_id: 'EMP-0003', position: 'caregiver' };

  test('HR ตั้งตำแหน่ง manager ให้คนอื่นไม่ได้', () => {
    assert.throws(() => guards.ensureCanGrantManager(asHr, 'manager'), (e) => e.status === 403);
  });
  test('HR ตั้งตำแหน่งอื่นให้คนอื่นได้ตามปกติ', () => {
    assert.doesNotThrow(() => guards.ensureCanGrantManager(asHr, 'nurse'));
    assert.doesNotThrow(() => guards.ensureCanGrantManager(asHr, undefined));
  });
  test('ผู้จัดการตั้งตำแหน่ง manager ได้', () => {
    assert.doesNotThrow(() => guards.ensureCanGrantManager(asManager, 'manager'));
  });
  test('แก้ตำแหน่งของตัวเองไม่ได้ แม้เป็นผู้จัดการ', async () => {
    await assert.rejects(
      guards.ensurePositionChangeAllowed(asManager, { employee_id: 'EMP-0001', position: 'manager' }, 'hr'),
      (e) => e.status === 403,
    );
  });
  test('HR ยิงเลื่อนตัวเองเป็น manager = ถูกปฏิเสธ (ทางที่เคยหลุด)', async () => {
    await assert.rejects(
      guards.ensurePositionChangeAllowed(asHr, { employee_id: 'EMP-0007', position: 'hr' }, 'manager'),
      (e) => e.status === 403,
    );
  });
  test('ตำแหน่งไม่เปลี่ยน = ผ่านทันที ไม่ต้องแตะ DB', async () => {
    await guards.ensurePositionChangeAllowed(asHr, someone, 'caregiver');
    await guards.ensurePositionChangeAllowed(asHr, someone, undefined);
  });
});

// ---------- ข้อความ error ดิบ ----------
describe('errorHandler — technical เห็นเฉพาะ admin', () => {
  const fakeRes = () => {
    const r = { code: null, body: null };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };
  const req = (role) => ({ method: 'GET', originalUrl: '/api/x', user: role ? { role } : undefined });

  test('admin ได้ข้อความดิบไปส่งต่อให้คนแก้', () => {
    const res = fakeRes();
    errorHandler(new Error('column "foo" does not exist'), req('admin'), res, () => {});
    assert.equal(res.code, 500);
    assert.match(res.body.technical, /column "foo"/);
  });
  test('พนักงานภาคสนามไม่ได้ข้อความดิบ', () => {
    const res = fakeRes();
    errorHandler(new Error('column "foo" does not exist'), req('field'), res, () => {});
    assert.equal(res.code, 500);
    assert.equal(res.body.technical, undefined);
    assert.equal(res.body.error, 'เกิดข้อผิดพลาดภายในระบบ');
  });
  test('ยังไม่ผ่าน login ก็ไม่ได้ข้อความดิบ', () => {
    const res = fakeRes();
    errorHandler(new Error('boom'), req(null), res, () => {});
    assert.equal(res.body.technical, undefined);
  });
  test('ApiError ยังตอบ status/ข้อความของตัวเองตามเดิม', () => {
    const res = fakeRes();
    errorHandler(new ApiError(409, 'ซ้ำ'), req('admin'), res, () => {});
    assert.equal(res.code, 409);
    assert.equal(res.body.error, 'ซ้ำ');
  });
});

// ---------- ลงกะหลายวัน ----------
describe('bulkVisitSchema / visitRangeSchema', () => {
  test('วันซ้ำถูกรวบและเรียงให้', () => {
    assert.deepEqual(
      bulkVisitSchema.parse({ dates: ['2026-08-03', '2026-08-01', '2026-08-03'] }).dates,
      ['2026-08-01', '2026-08-03'],
    );
  });
  test('ช่วงวัน + วันในสัปดาห์ (จ–ศ)', () => {
    const r = bulkVisitSchema.parse({ from: '2026-08-03', to: '2026-08-09', weekdays: [1, 2, 3, 4, 5] });
    assert.equal(r.dates.length, 5);
    assert.equal(r.dates[0], '2026-08-03');
    assert.equal(r.dates.at(-1), '2026-08-07');
  });
  test('วันสิ้นสุดมาก่อนวันเริ่ม = ปฏิเสธ', () => {
    assert.equal(bulkVisitSchema.safeParse({ from: '2026-08-09', to: '2026-08-01' }).success, false);
  });
  test('เกิน 200 กะต่อครั้ง = ปฏิเสธ (กันกรอกปีผิด)', () => {
    assert.equal(bulkVisitSchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success, false);
  });
  test('ไม่ระบุวันเลย = ปฏิเสธ', () => {
    assert.equal(bulkVisitSchema.safeParse({}).success, false);
  });
  test('ลบเป็นช่วงต้องมีทั้ง from และ to', () => {
    assert.equal(visitRangeSchema.safeParse({ from: '2026-08-01' }).success, false);
    assert.equal(visitRangeSchema.safeParse({ from: '2026-08-01', to: '2026-08-02' }).success, true);
  });
});

// ---------- geofence ----------
describe('geofence', () => {
  test('จุดเดียวกัน = 0 เมตร', () => {
    assert.equal(distanceMeters(13.7563, 100.5018, 13.7563, 100.5018), 0);
  });
  test('ระยะ ~1 กม. คำนวณได้ใกล้เคียง', () => {
    const d = distanceMeters(13.7563, 100.5018, 13.7653, 100.5018);
    assert.ok(d > 980 && d < 1020, `ได้ ${d} เมตร`);
  });
  test('รัศมีปริยาย 200 เมตร', () => {
    assert.equal(DEFAULT_GEOFENCE_M, 200);
  });
});

// ---------- รายงานอาการผู้ป่วย ----------
describe('createReportSchema — รายงานว่างเปล่าต้องบันทึกไม่ได้', () => {
  test('กรอกช่องเดียวก็พอ (วัดไม่ครบเป็นเรื่องปกติหน้างาน)', () => {
    assert.equal(createReportSchema.safeParse({ pulse: 78 }).success, true);
    assert.equal(createReportSchema.safeParse({ symptoms: 'มีไข้ต่ำๆ' }).success, true);
  });

  test('มีแต่วันที่/เวลา = ปฏิเสธ (แถวที่บอกว่ามีการบันทึกทั้งที่ไม่มีอะไรให้อ่าน)', () => {
    const r = createReportSchema.safeParse({ report_date: '2026-08-18', report_time: '09:00' });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /อย่างน้อยหนึ่งช่อง/);
  });

  test('ข้อความที่มีแต่ช่องว่าง ไม่นับว่ากรอกแล้ว', () => {
    assert.equal(createReportSchema.safeParse({ symptoms: '   ' }).success, false);
  });

  test('0 นับว่ากรอกแล้ว — ความเจ็บปวดระดับ 0 คือคำตอบ ไม่ใช่ช่องว่าง', () => {
    assert.equal(createReportSchema.safeParse({ pain_score: 0 }).success, true);
  });

  test('ค่าเกินช่วงต้องบอกได้ว่าผิดช่องไหน (ไม่ปล่อยไปตายที่ CHECK ของฐานข้อมูล)', () => {
    const r = createReportSchema.safeParse({ pulse: 780 });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['pulse']);
    assert.match(r.error.issues[0].message, /20–250/);
  });

  test('อุณหภูมิมีทศนิยมได้ แต่ชีพจรต้องเป็นจำนวนเต็ม', () => {
    assert.equal(createReportSchema.safeParse({ temperature_c: 36.8 }).success, true);
    assert.equal(createReportSchema.safeParse({ pulse: 78.5 }).success, false);
  });
});

describe('hasReportContent — ตอนแก้ต้องตรวจกับผลลัพธ์หลังรวมของเดิม', () => {
  const saved = { pulse: 78, symptoms: 'มีไข้' };

  test('ล้างข้อความทิ้งแต่ยังเหลือสัญญาณชีพ = ยังบันทึกได้', () => {
    assert.equal(hasReportContent({ ...saved, symptoms: null }), true);
  });

  test('ล้างจนไม่เหลืออะไรเลย = ต้องกันไว้ (zod มองไม่เห็นเพราะส่งมาช่องเดียว)', () => {
    assert.equal(hasReportContent({ ...saved, symptoms: null, pulse: null }), false);
  });
});

// ---------- แบบบันทึกการดูแลประจำวัน ----------
describe('createReportSchema — ฟอร์มเต็มของเคสดูแลต่อเนื่อง', () => {
  test('บันทึกที่มีแต่ช่องติ๊ก (ไม่มีตัวเลข/ข้อความ) ก็เป็นรายงานที่สมบูรณ์', () => {
    const r = createReportSchema.safeParse({ adl_bath: true, positioning_count: 6, shift: 'day' });
    assert.equal(r.success, true);
  });

  test('"ไม่ได้ทำ" (false) นับเป็นเนื้อหา — เป็นคำตอบ ไม่ใช่ช่องว่าง', () => {
    assert.equal(createReportSchema.safeParse({ adl_bath: false }).success, true);
  });

  test('มีแต่ช่องกำกับ (เวร/ประเภทรายงาน) = ยังไม่ได้บันทึกอะไร', () => {
    const r = createReportSchema.safeParse({ shift: 'night', report_type: 'routine' });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /อย่างน้อยหนึ่งช่อง/);
  });

  test('ตัวเลือกนอกรายการถูกปฏิเสธพร้อมบอกชื่อช่อง (ไม่หลุดไปชน CHECK ของฐานข้อมูล)', () => {
    const r = createReportSchema.safeParse({ sputum_color: 'ม่วง' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['sputum_color']);
    assert.match(r.error.issues[0].message, /สีเสมหะ/);
  });

  test('เหตุการณ์ผิดปกติเลือกได้หลายข้อพร้อมกัน', () => {
    const r = createReportSchema.safeParse({ incident_types: ['fall', 'bleeding'], incident_detail: 'ล้มข้างเตียง' });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.incident_types, ['fall', 'bleeding']);
  });

  test('ปริมาณติดลบถูกปฏิเสธ (ปัสสาวะ -50 ml ไม่มีทางเป็นของจริง)', () => {
    assert.equal(createReportSchema.safeParse({ urine_ml: -50 }).success, false);
  });

  test('Bristol scale รับเฉพาะ 1–7', () => {
    assert.equal(createReportSchema.safeParse({ stool_scale: 4 }).success, true);
    assert.equal(createReportSchema.safeParse({ stool_scale: 8 }).success, false);
  });
});

describe('createReportSchema — ฟอร์มกายภาพบำบัด', () => {
  test('ปวดก่อน/หลังเป็นคนละช่อง — คู่นี้คือผลของการรักษาครั้งนั้น ไม่ใช่ค่าเดียวทับกัน', () => {
    const r = createReportSchema.safeParse({ pain_score: 7, post_pain_score: 3 });
    assert.equal(r.success, true);
    assert.equal(r.data.pain_score, 7);
    assert.equal(r.data.post_pain_score, 3);
  });

  test('หัตถการเลือกได้หลายอย่างในครั้งเดียว (ยืด + ฝึกเดิน + ประคบร้อน เป็นเรื่องปกติ)', () => {
    const r = createReportSchema.safeParse({ physio_treatments: ['rom', 'gait', 'heat_cold'] });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.physio_treatments, ['rom', 'gait', 'heat_cold']);
  });

  test('ระดับการช่วยเหลือนอกรายการถูกปฏิเสธพร้อมบอกชื่อช่อง', () => {
    const r = createReportSchema.safeParse({ assist_level: 'ช่วยนิดหน่อย' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['assist_level']);
    assert.match(r.error.issues[0].message, /ระดับการช่วยเหลือ/);
  });

  test('สัญญาณชีพหลังทำใช้ช่วงเดียวกับก่อนทำ — ไม่งั้นค่าคู่กันจะเทียบกันไม่ได้', () => {
    for (const [pre, post] of [
      ['bp_systolic', 'post_bp_systolic'],
      ['bp_diastolic', 'post_bp_diastolic'],
      ['pulse', 'post_pulse'],
      ['spo2', 'post_spo2'],
      ['pain_score', 'post_pain_score'],
    ]) {
      for (const value of [-1, 1000]) {
        assert.equal(
          createReportSchema.safeParse({ [pre]: value }).success,
          createReportSchema.safeParse({ [post]: value }).success,
          `${pre} กับ ${post} รับค่าไม่เท่ากันที่ ${value}`,
        );
      }
    }
  });

  test('บันทึกที่มีแต่หัตถการกับระยะเวลา ก็เป็นรายงานที่สมบูรณ์', () => {
    assert.equal(createReportSchema.safeParse({ physio_treatments: ['rom'], rehab_minutes: 45 }).success, true);
  });
});

/* นิยามฟอร์มอยู่ฝั่งหน้าเว็บ (client/src/lib/dailyCare.js) ส่วนกฎการรับค่าอยู่ฝั่งนี้
   พิมพ์ชื่อช่องผิดที่ฝั่งใดฝั่งหนึ่ง = ช่องนั้นกรอกได้บนหน้าจอแต่หายไปเงียบๆ ตอนบันทึก
   ไม่มี error ให้เห็นเลยเพราะ zod ตัดคีย์ที่ไม่รู้จักทิ้ง — จับด้วยตาไม่ได้ ต้องให้เทสจับ */
describe('นิยามฟอร์มฝั่งหน้าเว็บต้องตรงกับ schema ฝั่ง server', () => {
  test('ทุกช่องในฟอร์มดูแลประจำวันและฟอร์มกายภาพ มีอยู่จริงใน createReportSchema', async () => {
    const { DAILY_SECTIONS, PHYSIO_SECTIONS } = await import('../../client/src/lib/dailyCare.js');
    const known = new Set([...REPORT_CONTENT_FIELDS, 'visit_id', 'report_date', 'report_time', 'shift', 'report_type']);

    for (const [name, sections] of [['ดูแลประจำวัน', DAILY_SECTIONS], ['กายภาพบำบัด', PHYSIO_SECTIONS]]) {
      for (const s of sections) {
        for (const f of s.fields) {
          assert.equal(known.has(f.key), true, `ฟอร์ม${name} มีช่อง ${f.key} ที่ schema ฝั่ง server ไม่รู้จัก`);
        }
      }
    }
  });

  test('ตัวเลือกของช่องแบบเลือกหนึ่ง ต้องเป็นค่าที่ schema ยอมรับ (ไม่หลุดไปชน CHECK ของฐานข้อมูล)', async () => {
    const { DAILY_SECTIONS, PHYSIO_SECTIONS } = await import('../../client/src/lib/dailyCare.js');

    for (const sections of [DAILY_SECTIONS, PHYSIO_SECTIONS]) {
      for (const s of sections) {
        for (const f of s.fields) {
          if (f.type !== 'choice') continue;
          for (const o of f.options) {
            assert.equal(
              // pulse เป็นตัวประกอบให้ใบไม่ว่าง (ช่องกำกับอย่าง shift อยู่คนเดียวจะถูกปฏิเสธเพราะใบเปล่า ไม่ใช่เพราะตัวเลือกผิด)
              createReportSchema.safeParse({ [f.key]: o.value, pulse: 80 }).success,
              true,
              `ช่อง ${f.key} มีตัวเลือก "${o.value}" ที่ schema ปฏิเสธ`,
            );
          }
        }
      }
    }
  });
});

describe('REPORT_CONTENT_FIELDS — เส้นแบ่ง "เนื้อหา" กับ "ข้อมูลกำกับ"', () => {
  test('ช่องกำกับต้องไม่ถูกนับเป็นเนื้อหา ไม่งั้นใบเปล่าจะผ่านไปได้', () => {
    for (const meta of ['visit_id', 'report_date', 'report_time', 'shift', 'report_type']) {
      assert.equal(REPORT_CONTENT_FIELDS.includes(meta), false, `${meta} ไม่ควรเป็นเนื้อหา`);
    }
  });

  test('ครอบทุกหมวดของฟอร์มเต็ม (สัญญาณชีพ ทางเดินหายใจ อาหาร ขับถ่าย ADL แผล อุปกรณ์ เหตุการณ์)', () => {
    for (const f of ['pulse', 'suction_status', 'feed_volume_ml', 'urine_ml', 'adl_bath', 'pressure_sore', 'dev_ng', 'incident_types']) {
      assert.equal(REPORT_CONTENT_FIELDS.includes(f), true, `${f} หายไปจากรายการเนื้อหา`);
    }
  });
});

describe('createRunSchema — รอบจ่ายค่าตอบแทน', () => {
  test('กรอกแค่วันตัดรอบก็เปิดรอบได้', () => {
    assert.equal(createRunSchema.safeParse({ period_to: '2026-08-31' }).success, true);
  });

  test('ไม่มีวันตัดรอบ = เปิดไม่ได้ — เป็นข้อมูลชิ้นเดียวที่รอบต้องมี', () => {
    assert.equal(createRunSchema.safeParse({}).success, false);
  });

  test('รูปแบบวันที่ผิดถูกปฏิเสธพร้อมบอกชื่อช่อง', () => {
    const r = createRunSchema.safeParse({ period_to: '2026-8-1' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['period_to']);
  });

  /* เดือนกับเลขรอบเป็นของที่ระบบตั้งเองจากวันตัดรอบ (ดู createRun) — ส่งมาก็ต้องไม่มีผล
     ถ้าวันหนึ่งมีใครเผลอเปิดช่องพวกนี้ให้กรอกอีก ป้ายชื่อรอบจะหลุดจากสิ่งที่รอบกวาดมาจริงทันที */
  test('เดือน/รอบที่ ที่ส่งมาเองถูกตัดทิ้ง ไม่ใช้เป็นค่าของรอบ', () => {
    const r = createRunSchema.parse({ period_to: '2026-08-31', period_month: '2026-01', round_no: 9 });
    assert.deepEqual(Object.keys(r).filter((k) => r[k] !== undefined), ['period_to']);
  });

  test('วันตัดรอบข้ามเดือนได้ — รอบกวาดกะตกค้างจากเดือนก่อนมาด้วยตามนิยาม', () => {
    assert.equal(createRunSchema.safeParse({ period_to: '2026-09-05' }).success, true);
  });
});

describe('checkInSchema — เช็คอินต้องมีรูปเซลฟี่', () => {
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=';

  /* รูปคือหลักฐานชิ้นเดียวที่พนักงานคุมเองได้และปลอมยากกว่าพิกัด — ถ้าเผลอเปิดให้เว้นว่างอีก
     กะที่น่าสงสัยจะเหลือแค่ GPS ให้ตรวจ ซึ่งคลาดเองได้หลายสิบเมตรจนธงนอกพื้นที่ไม่มีความหมาย */
  test('ไม่ส่งรูปมา = เช็คอินไม่ได้ พร้อมบอกว่าต้องทำอะไร', () => {
    const r = checkInSchema.safeParse({ lat: 13.7, lng: 100.5 });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues.at(-1).path, ['photo']);
    assert.match(r.error.issues.at(-1).message, /ถ่ายรูป/);
  });

  test('ส่ง null มาก็ไม่ผ่าน (ค่าว่างที่ตั้งใจ ไม่ใช่ข้อยกเว้น)', () => {
    assert.equal(checkInSchema.safeParse({ photo: null }).success, false);
  });

  test('ไฟล์ที่ไม่ใช่รูปถูกปฏิเสธด้วยข้อความคนละอันกับตอนไม่ส่งรูป', () => {
    const r = checkInSchema.safeParse({ photo: 'data:text/plain;base64,aGVsbG8=' });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /รูปภาพ/);
  });

  /* GPS ไม่บังคับโดยตั้งใจ — พนักงานคุมกล้องได้ แต่คุมสัญญาณ/สิทธิ์ตำแหน่งไม่ได้
     บล็อกเพราะ GPS = กันคนที่ไปทำงานจริงออกจากระบบ (กะแบบนั้นถูกติดธงให้ตรวจแทนอยู่แล้ว) */
  test('มีรูปแต่ไม่มีพิกัด = ยังเช็คอินได้', () => {
    assert.equal(checkInSchema.safeParse({ photo }).success, true);
  });
});

// ---------- แบ่งค่าจ้างของงวดให้ผู้รับ ----------
describe('allocateShares — เคสที่มีพนักงานคนเดียว', () => {
  /* เคสตัวอย่างของกติกานี้: ยอดเหมา 20,000 ตกลงจ่ายสองงวด 7,000 แล้ว 13,000
     ผู้รับคนเดียวจึงต้องได้เต็มยอดของงวดนั้นเป๊ะ ไม่ใช่ตัวเลขที่ถูกเกลี่ยจนเพี้ยน */
  test('ได้เต็มยอดของงวด', () => {
    const rows = allocateShares([{ employee_id: 'EMP-0001', shifts: 8, paid: 0 }], 7000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 7000);
  });

  test('งวดที่สองก็ยังได้เต็ม — ของที่ได้ไปแล้วไม่ถูกหักซ้ำ', () => {
    const rows = allocateShares([{ employee_id: 'EMP-0001', shifts: 10, paid: 7000 }], 13000);
    assert.equal(rows[0].amount, 13000);
  });

  /* กะไม่ใช่ประตูของเงินอีกแล้ว — คนที่ยังไม่เคยเช็คอินเลยก็รับค่าจ้างของเคสได้
     (พนักงานลืมเช็คอินทั้งเคสเกิดขึ้นจริง และไม่ควรแปลว่าเขาทำงานฟรี)
     สิ่งเดียวที่ทำให้แบ่งไม่ได้คือ "ไม่มีใครอยู่ในเคสเลย" ซึ่งแปลว่าไม่รู้จะจ่ายให้ใคร */
  test('ยังไม่เคยเช็คอินเลยก็ยังได้เต็มยอดของงวด', () => {
    const rows = allocateShares([{ employee_id: 'A', shifts: 0, paid: 0 }], 5000);
    assert.equal(rows[0].amount, 5000);
  });

  test('ไม่มีใครอยู่ในเคสเลย = ไม่แบ่งให้ใคร ไม่ใช่ NaN จากการหารศูนย์', () => {
    assert.deepEqual(allocateShares([], 5000), []);
  });

  test('ข้อมูลอื่นของผู้รับติดไปด้วย — ตอนบันทึกต้องรู้ชื่อและนาทีที่ทำ', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', employee_name: 'สมชาย', shifts: 2, minutes: 480, paid: 0 }],
      1000,
    );
    assert.equal(rows[0].employee_name, 'สมชาย');
    assert.equal(rows[0].minutes, 480);
  });
});

describe('allocateShares — เคสที่มีพนักงานหลายคน (ค่าปริยาย: หารเท่ากัน)', () => {
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const of = (rows, id) => rows.find((r) => r.employee_id === id).amount;

  /* หัวใจของกติกา: หารเท่ากันตามหัว ไม่ใช่ตามจำนวนกะ — คนที่ไปน้อยครั้งอาจรับกะที่หนักกว่า
     และเรื่องพวกนี้ตกลงกันด้วยปากเปล่า ไม่ได้อยู่ในตารางกะ ถ้าจะแบ่งไม่เท่ากันต้องเป็นการตัดสินใจ
     ของคน (ตั้งข้อตกลง) ไม่ใช่ผลข้างเคียงของตัวเลขที่ระบบบังเอิญมี */
  test('สองคน = คนละครึ่ง แม้จำนวนกะจะต่างกันมาก', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 8, paid: 0 }, { employee_id: 'B', shifts: 2, paid: 0 }],
      15000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [7500, 7500]);
  });

  test('สามคน = หารสาม', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 4, paid: 0 },
        { employee_id: 'B', shifts: 3, paid: 0 },
        { employee_id: 'C', shifts: 1, paid: 0 },
      ],
      15000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [5000, 5000, 5000]);
  });

  /* นับหัวจาก "ใครอยู่ในเคส" ไม่ใช่ "ใครมีกะที่ยืนยันแล้ว" — ถ้าจะไม่ให้ใครสักคน
     ต้องเป็นการตัดสินใจของผู้จัดการ (ตั้งส่วนแบ่งเป็น 0) ไม่ใช่ผลข้างเคียงของตารางกะ */
  test('คนที่ยังไม่เคยเช็คอินก็ถูกนับเป็นหัวในการหาร', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 0 }, { employee_id: 'B', shifts: 0, paid: 0 }],
      10000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [5000, 5000]);
  });

  /* งวดแรกถูกปล่อยตอนที่อีกคนยังไม่มีกะที่อนุมัติ ถ้าแบ่งเฉพาะเงินของงวดนั้น คนที่มาทีหลัง
     จะเสียส่วนแบ่งถาวรทั้งที่ตกลงกันว่าคนละครึ่ง — งวดหลังต้องแก้ความเอียงนั้นให้เอง */
  test('งวดหลังไล่ชดเชยงวดก่อน — จบเคสแล้วได้คนละครึ่งตามที่ตกลง', () => {
    // งวดที่ 1: ปล่อย 7,000 ตอนที่เคสยังมีชื่อ A คนเดียว (B เพิ่งมาเสริมทีหลัง)
    const first = allocateShares([{ employee_id: 'A', shifts: 5, paid: 0 }], 7000);
    assert.equal(of(first, 'A'), 7000);

    // งวดที่ 2: ปล่อย 8,000 ที่เหลือ ตอนที่ทั้งคู่พร้อมแล้ว
    const second = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 7000 }, { employee_id: 'B', shifts: 5, paid: 0 }],
      8000,
    );
    assert.equal(of(second, 'A'), 500);
    assert.equal(of(second, 'B'), 7500);
    assert.equal(7000 + of(second, 'A'), 7500);
  });

  /* ได้เกินส่วนของตัวเองไปแล้วเรียกคืนไม่ได้ (เงินออกไปแล้ว) ทำได้แค่หยุดจ่ายเพิ่มจนคนอื่นไล่ทัน
     ถ้าปล่อยให้ส่วนที่ขาดติดลบไปหารต่อ คนที่ยังไม่ได้เงินจะได้ยอดติดลบ ซึ่งลงฐานข้อมูลไม่ได้ */
  test('คนที่ได้ล่วงหน้าเกินส่วนของตัวเองแล้ว ได้ 0 ในงวดนี้ ไม่ใช่ยอดติดลบ', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 9000 }, { employee_id: 'B', shifts: 5, paid: 0 }],
      6000,
    );
    assert.equal(of(rows, 'A'), 0);
    assert.equal(of(rows, 'B'), 6000);
    assert.equal(sum(rows), 6000);
  });

  test('ยอดไม่พอให้ทุกคนถึงส่วนของตัวเอง = คนที่ยังขาดโดนหารลดตามส่วน ไม่ใช่คนแรกได้ก่อนจนหมด', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 0 }, { employee_id: 'B', shifts: 5, paid: 0 }],
      1000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [500, 500]);
  });

  /* จุดที่พังเงียบที่สุดของการแบ่งเงิน: 20,000 ÷ 3 = 6,666.666… ถ้าให้ทุกคนปัดเอง
     ผลรวมจะเป็น 20,000.01 คือจ่ายเกินที่ตกลงไปหนึ่งสตางค์ทุกครั้งที่แบ่งไม่ลงตัว */
  test('เศษการปัดตกที่คนสุดท้ายที่มีส่วนได้ — ผลรวมเท่ากับยอดของงวดเป๊ะ', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 1, paid: 0 },
        { employee_id: 'B', shifts: 1, paid: 0 },
        { employee_id: 'C', shifts: 1, paid: 0 },
      ],
      20000,
    );
    assert.equal(sum(rows), 20000);
    assert.deepEqual(rows.map((r) => r.amount), [6666.67, 6666.67, 6666.66]);
  });

  /* แถวสุดท้ายอาจเป็นคนที่ไม่ได้ส่วนแบ่งในงวดนี้ (ตกลงกันว่าไม่รับ) — โยนเศษให้เขา
     คือสร้างก้อนเงิน 1 สตางค์ที่อธิบายไม่ได้ และทำให้คนที่ควรได้ ได้ไม่ครบ */
  test('เศษไม่ตกใส่คนที่ตกลงว่าไม่รับ', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 1, paid: 0, share: 1 },
        { employee_id: 'B', shifts: 1, paid: 0, share: 1 },
        { employee_id: 'ZERO', shifts: 0, paid: 0, share: 0 },
      ],
      10000.01,
    );
    assert.equal(of(rows, 'ZERO'), 0);
    assert.equal(sum(rows), 10000.01);
  });

  test('จ่ายครบทุกงวดแล้ว ทุกคนได้เท่ากันพอดี ไม่ว่าจะซอยงวดยังไง', () => {
    const people = [{ employee_id: 'A', shifts: 7 }, { employee_id: 'B', shifts: 3 }, { employee_id: 'C', shifts: 5 }];
    const paid = { A: 0, B: 0, C: 0 };

    for (const amount of [4000, 5500.25, 5499.75]) {
      const rows = allocateShares(people.map((p) => ({ ...p, paid: paid[p.employee_id] })), amount);
      assert.equal(sum(rows), amount);
      for (const r of rows) paid[r.employee_id] = Math.round((paid[r.employee_id] + r.amount) * 100) / 100;
    }

    assert.equal(Math.round((paid.A + paid.B + paid.C) * 100) / 100, 15000);
    for (const p of people) assert.ok(Math.abs(paid[p.employee_id] - 5000) < 0.02);
  });
});

describe('allocateShares — เคสที่ตกลงส่วนแบ่งกันไว้เป็นพิเศษ', () => {
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const of = (rows, id) => rows.find((r) => r.employee_id === id).amount;

  /* เคสตัวอย่างของกติกานี้: ค่าจ้าง 15,000 ที่ปกติหารครึ่ง (คนละ 7,500) แต่ตกลงกันแล้วว่า
     คนที่ลงแรงมากกว่ารับ 9,000 อีกคนรับ 6,000 — ข้อตกลงเป็นของทั้งเคส ไม่ใช่ของงวดใดงวดหนึ่ง */
  test('ทุกงวดแบ่งตามสัดส่วนที่ตกลง แล้วจบเคสได้ตรงตามที่ตกลงพอดี', () => {
    const first = allocateShares(
      [
        { employee_id: 'A', shifts: 6, paid: 0, share: 9000 },
        { employee_id: 'B', shifts: 4, paid: 0, share: 6000 },
      ],
      7000,
    );
    assert.deepEqual(first.map((r) => r.amount), [4200, 2800]); // 60:40 ของงวดนี้

    const second = allocateShares(
      [
        { employee_id: 'A', shifts: 6, paid: 4200, share: 9000 },
        { employee_id: 'B', shifts: 4, paid: 2800, share: 6000 },
      ],
      8000,
    );
    assert.equal(4200 + of(second, 'A'), 9000);
    assert.equal(2800 + of(second, 'B'), 6000);
  });

  test('ข้อตกลงชนะจำนวนกะ — คนที่ทำกะน้อยกว่ารับมากกว่าได้ถ้าตกลงกันแบบนั้น', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 1, paid: 0, share: 12000 },
        { employee_id: 'B', shifts: 9, paid: 0, share: 3000 },
      ],
      15000,
    );
    assert.equal(of(rows, 'A'), 12000);
    assert.equal(of(rows, 'B'), 3000);
  });

  /* ตั้ง 0 ให้ใคร = ตกลงกันว่าคนนั้นไม่รับค่าจ้างของเคสนี้ ซึ่งต่างจาก "ยังไม่ได้ตั้ง" (null)
     ถ้ายุบสองอย่างนี้เป็นค่าเดียวกัน การตกลงว่า "คนนี้ไม่รับ" จะสั่งไม่ได้เลย */
  test('ตั้งส่วนแบ่งเป็น 0 = ไม่รับค่าจ้างของเคสนี้ ทั้งที่มีกะอยู่', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 5, paid: 0, share: 15000 },
        { employee_id: 'B', shifts: 5, paid: 0, share: 0 },
      ],
      15000,
    );
    assert.equal(of(rows, 'A'), 15000);
    assert.equal(of(rows, 'B'), 0);
  });

  test('มีข้อตกลงแค่บางคน = คนที่ไม่มีถือว่าไม่รับ (ไม่กลับไปหารเท่ากันครึ่งทาง)', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 5, paid: 0, share: 15000 },
        { employee_id: 'B', shifts: 5, paid: 0 },
      ],
      15000,
    );
    assert.equal(of(rows, 'A'), 15000);
    assert.equal(of(rows, 'B'), 0);
  });

  test('ผลรวมข้อตกลงไม่ตรงกับค่าจ้างของเคส ก็ยังใช้เป็นสัดส่วนได้ (หน้าจอเป็นคนฟ้อง)', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 5, paid: 0, share: 6 },
        { employee_id: 'B', shifts: 5, paid: 0, share: 4 },
      ],
      15000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [9000, 6000]);
    assert.equal(sum(rows), 15000);
  });

  test('ข้อตกลงเป็น 0 ทุกคน = ไม่มีใครรับ จึงไม่แบ่งอะไรเลย', () => {
    assert.deepEqual(
      allocateShares(
        [{ employee_id: 'A', shifts: 5, paid: 0, share: 0 }, { employee_id: 'B', shifts: 5, paid: 0, share: 0 }],
        15000,
      ),
      [],
    );
  });
});

describe('ตัวแบ่งค่าจ้างฝั่งหน้าเว็บต้องให้ผลตรงกับฝั่ง server', () => {
  /* หน้าจอโชว์ส่วนแบ่งให้ดูก่อนกด แล้วส่งตัวเลขชุดนั้นไปบันทึกเลย ส่วน server คิดเองได้ด้วย
     เมื่อไม่มีใครส่งมา — สองสูตรนี้ต่างกันเมื่อไหร่ ตัวเลขที่ผู้จัดการเห็นกับที่ลงจริงจะไม่ใช่ตัวเดียวกัน
     โปรเจคนี้ไม่มีโค้ดที่ใช้ร่วมกันสองฝั่ง จึงพินกันด้วยเทสนี้แทน */
  const CASES = [
    [[{ employee_id: 'A', shifts: 5, paid: 0 }], 7000],
    [[{ employee_id: 'A', shifts: 5, paid: 0 }, { employee_id: 'B', shifts: 5, paid: 0 }], 13000],
    [[{ employee_id: 'A', shifts: 5, paid: 7000 }, { employee_id: 'B', shifts: 5, paid: 0 }], 8000],
    [[{ employee_id: 'A', shifts: 5, paid: 9000 }, { employee_id: 'B', shifts: 15, paid: 0 }], 6000],
    [[{ employee_id: 'A', shifts: 1, paid: 0 }, { employee_id: 'B', shifts: 1, paid: 0 }, { employee_id: 'C', shifts: 1, paid: 0 }], 20000],
    [[{ employee_id: 'A', shifts: 3, paid: 120.5 }, { employee_id: 'B', shifts: 4, paid: 0 }], 7000.55],
    [[{ employee_id: 'A', shifts: 0, paid: 0 }], 5000],
    [[{ employee_id: 'A', shifts: 2, paid: 0 }, { employee_id: 'Z', shifts: 0, paid: 900 }], 3000],
    // มีข้อตกลง — สองฝั่งต้องตีความ share = null / 0 เหมือนกันเป๊ะ ไม่งั้นคนที่ "ตกลงว่าไม่รับ" จะได้เงิน
    [[{ employee_id: 'A', shifts: 6, paid: 0, share: 9000 }, { employee_id: 'B', shifts: 4, paid: 0, share: 6000 }], 7000],
    [[{ employee_id: 'A', shifts: 5, paid: 0, share: 15000 }, { employee_id: 'B', shifts: 5, paid: 0, share: 0 }], 15000],
    [[{ employee_id: 'A', shifts: 5, paid: 0, share: 15000 }, { employee_id: 'B', shifts: 5, paid: 0 }], 15000],
  ];

  test('แบ่งเงินของงวดได้ผลเท่ากันทุกกรณีที่ไล่เทียบ', async () => {
    const { allocateShares: onClient } = await import('../../client/src/lib/payShare.js');

    for (const [shares, amount] of CASES) {
      assert.deepEqual(
        onClient(shares, amount).map((r) => [r.employee_id, r.amount]),
        allocateShares(shares, amount).map((r) => [r.employee_id, r.amount]),
        `ผลต่างกันที่ ${JSON.stringify(shares)} ยอด ${amount}`,
      );
    }
  });

  /* น้ำหนักคือกฎ "หารเท่ากันหรือตามข้อตกลง" ตัวจริง — ผลลัพธ์สุดท้ายอาจบังเอิญเท่ากัน
     ทั้งที่กฎต่างกัน (เช่นตอนที่ทุกคนได้ 0 อยู่ดี) จึงเทียบตัวกฎเองด้วย */
  test('น้ำหนักของแต่ละคนตีความเหมือนกัน', async () => {
    const { weightsFor: onClient } = await import('../../client/src/lib/payShare.js');
    for (const [shares] of CASES) {
      assert.deepEqual(onClient(shares), weightsFor(shares), `น้ำหนักต่างกันที่ ${JSON.stringify(shares)}`);
    }
  });

  /* entitlements อยู่ฝั่งหน้าเว็บอย่างเดียว (ใช้โชว์ว่าใครควรได้เท่าไหร่ทั้งเคส) แต่มันต่อยอดจาก
     weightsFor เดียวกัน — ผลรวมจึงต้องเท่ากับค่าจ้างของเคสเป๊ะ ไม่งั้นตัวเลขบนหน้าจอไม่ลงตัว */
  test('ส่วนของทั้งเคสรวมกันแล้วเท่ากับค่าจ้างของเคสเสมอ', async () => {
    const { entitlements } = await import('../../client/src/lib/payShare.js');

    for (const [shares] of CASES) {
      const out = entitlements(shares, 15000);
      const total = Math.round(out.reduce((s, v) => s + v, 0) * 100) / 100;
      // ไม่มีใครมีน้ำหนักเลย (ยังไม่มีกะที่อนุมัติ) = ไม่มีส่วนของใครให้แสดง
      const anyWeight = weightsFor(shares).some((w) => w > 0);
      assert.equal(total, anyWeight ? 15000 : 0, `ผลรวมไม่ลงตัวที่ ${JSON.stringify(shares)}`);
    }
  });
});

describe('เพดานงวดของเคส', () => {
  /* ค่าปริยายของการจ่ายคือทีเดียวจบ — ตัวเลขนี้คือขอบบนของกรณีที่ตกลงกันว่าจะซอย
     ไม่ใช่จำนวนงวดที่ทุกเคสต้องมี (หน้าจอจึงไม่โชว์ "งวดที่ 1 จาก 5" ให้เข้าใจผิด) */
  test('แบ่งจ่ายได้สูงสุด 5 งวดต่อเคส', () => {
    assert.equal(MAX_INSTALLMENTS, 5);
  });
});
