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

const { adjustVisitSchema, bulkVisitSchema, visitRangeSchema } = await import('../src/cases/schema.js');
const { withVisitState } = await import('../src/cases/repo.js');
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
