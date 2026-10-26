// QA แพ็กเกจกายภาพบำบัด / จำนวนครั้งคงเหลือ
// รัน: node test/_run_probe.mjs test/_qa_packages_20261026.mjs
// ใช้ PostgreSQL ชั่วคราว + Express จริง + HTTP จริง
// ชุดนี้ไม่แก้ source และไม่ต่อฐานข้อมูลจริง
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = {
  employee_id: 'EMP-0001', position: 'manager',
  first_name: 'ผู้จัดการ', last_name: 'ทดสอบ',
};
const HR = {
  employee_id: 'EMP-0007', position: 'hr',
  first_name: 'ฝ่ายบุคคล', last_name: 'ทดสอบ',
};
const FIELD = {
  employee_id: 'EMP-0003', position: 'caregiver',
  first_name: 'พนักงาน', last_name: 'ทดสอบ',
};
const FINANCE = {
  employee_id: 'EMP-0091', position: 'finance',
  first_name: 'การเงิน', last_name: 'ทดสอบ',
};
const SUPER = {
  employee_id: 'EMP-0092', position: 'super_admin',
  first_name: 'ซูเปอร์แอดมิน', last_name: 'ทดสอบ',
};
const ADMIN = {
  employee_id: 'EMP-0093', position: 'admin',
  first_name: 'แอดมินโฮมแคร์', last_name: 'ทดสอบ',
};

await seedFixtures(pool, hashPassword);
for (const who of [FINANCE, SUPER, ADMIN]) {
  await sql.run(
    `INSERT INTO employees
       (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
     VALUES (:id, :first, :last, :position, :email, 'active', 'x', false)`,
    {
      id: who.employee_id,
      first: who.first_name,
      last: who.last_name,
      position: who.position,
      email: `${who.employee_id}@example.invalid`,
    },
  );
}

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, body, who = MANAGER) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...jar(who) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}
const get = (path, who = MANAGER) => call('GET', path, undefined, who);
const post = (path, body, who = MANAGER) => call('POST', path, body ?? {}, who);
const patch = (path, body, who = MANAGER) => call('PATCH', path, body ?? {}, who);
const del = (path, who = MANAGER) => call('DELETE', path, undefined, who);

let vn = 830000000;
let serial = 0;
const found = [];
const notes = [];
const topicCaseIds = new Set();
const topicPackageIds = new Set();
const hit = (title, detail) => {
  found.push({ title, detail });
  console.log(`\nBUG | ${title}\nRESULT | ${detail}`);
};
const ok = (what) => {
  notes.push(what);
  console.log(`PASS | ${what}`);
};
const head = (title) => console.log(`\n=== ${title} ===`);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
const leaksPay = (row) => ['staff_pay', 'margin', 'staff_share'].some((key) => own(row, key));

function rememberPackage(pkg) {
  if (pkg?.physio_package_id != null) topicPackageIds.add(Number(pkg.physio_package_id));
  return pkg;
}

function datesFrom(start, count) {
  const out = [];
  let cursor = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return out;
}

async function resetTopic() {
  // แต่ละหัวข้อใช้ข้อมูลคนละชุด และล้างชุดก่อนหน้าออกจากฐานชั่วคราวทั้งหมด
  // ป้องกันยอดกะ/ใบแจ้งหนี้/ชื่อแพ็กเกจจากหัวข้อก่อนปนกับหัวข้อถัดไป
  for (const caseId of topicCaseIds) {
    await sql.run('DELETE FROM invoices WHERE case_id = :id', { id: caseId });
    await sql.run('DELETE FROM cases WHERE case_id = :id', { id: caseId });
  }
  for (const id of topicPackageIds) {
    await sql.run('DELETE FROM physio_packages WHERE physio_package_id = :id', { id });
  }
  topicCaseIds.clear();
  topicPackageIds.clear();
}

async function newPackage({
  name = `QA-PKG-20261026-${++serial}`,
  sessions = 10,
  specialPrice = 10000,
  staffPay = 6000,
  active = true,
  extra = {},
} = {}) {
  const created = await post('/api/physio/packages', {
    name,
    sessions,
    special_price: specialPrice,
    staff_pay: staffPay,
    active,
    ...extra,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return rememberPackage(created.body);
}

function caseBody(pkg, label, extra = {}) {
  return {
    case_id: `VN${++vn}`,
    service_kind: 'physio',
    physio_package_id: pkg.physio_package_id,
    client_name: label,
    fee: Number(pkg.special_price),
    assigned_to: FIELD.employee_id,
    ...extra,
  };
}

async function newPhysioCase(pkg, label, extra = {}) {
  const created = await post('/api/cases', caseBody(pkg, label, extra));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  topicCaseIds.add(created.body.case_id);
  return created.body;
}

async function visitsOf(caseId) {
  const result = await get(`/api/cases/${caseId}/visits`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function markDone(caseId, visits) {
  for (const visit of visits) {
    const changed = await patch(`/api/cases/${caseId}/visits/${visit.visit_id}`, { status: 'done' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }
}

async function invoiceForCase(caseId) {
  const listed = await get(`/api/invoices?case_id=${encodeURIComponent(caseId)}&per_page=100`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const row = listed.body.data.find((item) => item.status !== 'cancelled');
  assert.ok(row, `ไม่พบใบแจ้งหนี้ของ ${caseId}: ${JSON.stringify(listed.body)}`);
  const detail = await get(`/api/invoices/${row.invoice_id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  return detail.body;
}

// -----------------------------------------------------------------------------
await resetTopic();
head('1 · สิทธิ์ทุกเส้นของ /api/packages และ /api/physio + ไม่ให้ต้นทุนรั่ว');
{
  const protectedPkg = await newPackage({
    name: `QA-PKG-20261026-permission-${++serial}`,
    sessions: 10,
    specialPrice: 15000,
    staffPay: 9000,
  });

  const officeRoutes = [
    ['GET', '/api/packages/meta'],
    ['GET', '/api/packages/matrix'],
    ['POST', '/api/packages/grades', {}],
    ['PATCH', '/api/packages/grades/0', {}],
    ['DELETE', '/api/packages/grades/0'],
    ['POST', '/api/packages/formats', {}],
    ['PATCH', '/api/packages/formats/0', {}],
    ['DELETE', '/api/packages/formats/0'],
    ['PATCH', '/api/packages/rates', {}],
    ['GET', '/api/physio/packages'],
    ['POST', '/api/physio/packages', {}],
    ['GET', '/api/physio/packages/0'],
    ['PATCH', '/api/physio/packages/0', {}],
    ['DELETE', '/api/physio/packages/0'],
    ['PATCH', '/api/physio/reorder', {}],
  ];

  for (const who of [FINANCE, FIELD]) {
    const results = await Promise.all(
      officeRoutes.map(([method, path, body]) => call(method, path, body, who)),
    );
    const leaked = results
      .map((result, i) => ({ ...result, route: `${officeRoutes[i][0]} ${officeRoutes[i][1]}` }))
      .filter((result) => result.status !== 403);
    if (leaked.length > 0) {
      hit(
        `${who.position} เรียกเส้นแพ็กเกจหมวด office ได้`,
        leaked.map((result) => `${result.route} -> ${result.status}`).join(' · '),
      );
    } else {
      ok(`${who.position}: ทั้ง ${officeRoutes.length} เส้นถูกกัน 403 ก่อนแตะข้อมูล`);
    }
  }

  for (const who of [MANAGER, SUPER, HR, ADMIN]) {
    const [meta, physio] = await Promise.all([
      get('/api/packages/meta', who),
      get('/api/physio/packages', who),
    ]);
    if (meta.status !== 200 || physio.status !== 200) {
      hit(
        `${who.position} ที่มีสิทธิ์ office เข้าแพ็กเกจไม่ได้`,
        `/api/packages/meta=${meta.status}; /api/physio/packages=${physio.status}`,
      );
    } else {
      ok(`${who.position}: เข้า /api/packages และ /api/physio ได้ตาม POSITION_PERMISSIONS`);
    }
  }

  const [managerList, superList, hrList, adminSingle] = await Promise.all([
    get('/api/physio/packages', MANAGER),
    get('/api/physio/packages', SUPER),
    get('/api/physio/packages', HR),
    get(`/api/physio/packages/${protectedPkg.physio_package_id}`, ADMIN),
  ]);
  const managerPkg = managerList.body.find((p) => p.physio_package_id === protectedPkg.physio_package_id);
  const superPkg = superList.body.find((p) => p.physio_package_id === protectedPkg.physio_package_id);
  const hrPkg = hrList.body.find((p) => p.physio_package_id === protectedPkg.physio_package_id);
  if (
    managerList.status !== 200 || superList.status !== 200 || hrList.status !== 200 ||
    !managerPkg || !superPkg || !hrPkg || managerPkg.staff_pay !== 9000 || superPkg.staff_pay !== 9000 ||
    leaksPay(hrPkg) || adminSingle.status !== 200 || leaksPay(adminSingle.body)
  ) {
    hit(
      'ค่าจ้าง/กำไรรั่วหรือถูกซ่อนผิดกลุ่มในเส้นแพ็กเกจกายภาพ',
      `manager=${JSON.stringify(managerPkg)}; super=${JSON.stringify(superPkg)}; ` +
        `hr=${JSON.stringify(hrPkg)}; admin=${JSON.stringify(adminSingle.body)}`,
    );
  } else {
    ok('manager/super_admin เห็น staff_pay; HR/Admin HC ไม่ได้ staff_pay/margin/staff_share ทั้ง list และ detail');
  }

  const managerMatrix = await get('/api/packages/matrix', MANAGER);
  const hrMatrix = await get('/api/packages/matrix', HR);
  assert.equal(managerMatrix.status, 200, JSON.stringify(managerMatrix.body));
  assert.equal(hrMatrix.status, 200, JSON.stringify(hrMatrix.body));
  const seededRate = managerMatrix.body.rates.find((rate) => rate.staff_pay != null);
  assert.ok(seededRate, JSON.stringify(managerMatrix.body));
  if (hrMatrix.body.rates.some(leaksPay)) {
    hit('HR เห็น staff_pay/margin/staff_share ใน /api/packages/matrix', JSON.stringify(hrMatrix.body.rates));
  } else {
    ok('HR ไม่ได้ต้นทุน/กำไรใน /api/packages/matrix');
  }

  const hrRateWrite = await patch('/api/packages/rates', {
    rates: [{
      format_id: seededRate.format_id,
      grade_id: seededRate.grade_id ?? null,
      staff_tier: seededRate.staff_tier,
      customer_price: seededRate.customer_price,
      staff_pay: 999999,
      discount_percent: seededRate.discount_percent ?? null,
      discount_amount: seededRate.discount_amount ?? null,
      available: seededRate.available,
    }],
  }, HR);
  const matrixAfterHr = await get('/api/packages/matrix', MANAGER);
  const rateAfterHr = matrixAfterHr.body.rates.find((rate) => rate.rate_id === seededRate.rate_id);
  if (
    hrRateWrite.status !== 200 ||
    hrRateWrite.body.rates.some(leaksPay) ||
    Number(rateAfterHr?.staff_pay) !== Number(seededRate.staff_pay)
  ) {
    hit(
      'คนไม่มีหมวด money เขียนหรือเห็น staff_pay ผ่าน /api/packages/rates ได้',
      `PATCH=${hrRateWrite.status}/${JSON.stringify(hrRateWrite.body)}; after=${JSON.stringify(rateAfterHr)}`,
    );
  } else {
    ok('HR ส่ง staff_pay ปลอมเข้า /api/packages/rates แล้วถูกถอด; ค่าเดิมคงอยู่และ response ไม่รั่ว');
  }
  await sql.run(
    'UPDATE pkg_rates SET staff_pay = :pay WHERE rate_id = :id',
    { pay: seededRate.staff_pay, id: seededRate.rate_id },
  );

  const hrCreated = await post('/api/physio/packages', {
    name: `QA-PKG-20261026-hr-create-${++serial}`,
    sessions: 5,
    special_price: 5000,
    staff_pay: 4999,
  }, HR);
  assert.equal(hrCreated.status, 201, JSON.stringify(hrCreated.body));
  rememberPackage(hrCreated.body);
  const storedHrCreated = await get(`/api/physio/packages/${hrCreated.body.physio_package_id}`, MANAGER);
  if (leaksPay(hrCreated.body) || storedHrCreated.body.staff_pay != null) {
    hit(
      'HR สร้างแพ็กเกจแล้วลอบตั้ง/เห็น staff_pay ได้',
      `HR response=${JSON.stringify(hrCreated.body)}; manager sees=${JSON.stringify(storedHrCreated.body)}`,
    );
  } else {
    ok('HR สร้างแพ็กเกจได้แต่ staff_pay ที่ส่งมาถูกทิ้ง และ response ไม่มีต้นทุน');
  }

  const hrPatched = await patch(`/api/physio/packages/${protectedPkg.physio_package_id}`, {
    note: 'HR แก้หมายเหตุโดยห้ามแตะต้นทุน',
    staff_pay: 1,
  }, HR);
  const protectedAfter = await get(`/api/physio/packages/${protectedPkg.physio_package_id}`, MANAGER);
  if (hrPatched.status !== 200 || leaksPay(hrPatched.body) || Number(protectedAfter.body.staff_pay) !== 9000) {
    hit(
      'HR PATCH แพ็กเกจแล้วเขียนหรือเห็น staff_pay ได้',
      `HR response=${JSON.stringify(hrPatched.body)}; manager sees=${JSON.stringify(protectedAfter.body)}`,
    );
  } else {
    ok('HR PATCH แพ็กเกจได้เฉพาะข้อมูลขาย; staff_pay 9,000 บาทไม่ถูกทับ');
  }

  const leakCase = await newPhysioCase(protectedPkg, 'ตรวจต้นทุนในเคส');
  const hrCase = await get(`/api/cases/${leakCase.case_id}`, HR);
  if (
    hrCase.status !== 200 ||
    ['staff_pay', 'physio_staff_pay', 'rate_staff_pay'].some((key) => own(hrCase.body, key))
  ) {
    hit('ต้นทุนแพ็กเกจรั่วผ่าน GET /api/cases/:id ถึง HR', JSON.stringify(hrCase.body));
  } else {
    ok('GET /api/cases/:id ของ HR ไม่มี staff_pay/physio_staff_pay/rate_staff_pay');
  }
}

// -----------------------------------------------------------------------------
await resetTopic();
head('2 · ขอบเขตยอดเงินและจำนวนครั้ง');
{
  const invalidCreates = [
    ['ราคาติดลบ', { name: `QA-PKG-20261026-neg-price-${++serial}`, sessions: 10, special_price: -0.01 }],
    ['จำนวนครั้งเป็นศูนย์', { name: `QA-PKG-20261026-zero-session-${++serial}`, sessions: 0, special_price: 1000 }],
    ['จำนวนครั้งติดลบ', { name: `QA-PKG-20261026-neg-session-${++serial}`, sessions: -1, special_price: 1000 }],
    ['จำนวนครั้งเป็นทศนิยม', { name: `QA-PKG-20261026-dec-session-${++serial}`, sessions: 1.5, special_price: 1000 }],
    ['ค่าจ้างติดลบ', { name: `QA-PKG-20261026-neg-pay-${++serial}`, sessions: 1, special_price: 1000, staff_pay: -0.01 }],
  ];
  const invalidResults = [];
  for (const [label, body] of invalidCreates) {
    const result = await post('/api/physio/packages', body);
    invalidResults.push({ label, status: result.status, body: result.body });
    if (result.status === 201) rememberPackage(result.body);
  }

  const baseline = await newPackage({
    name: `QA-PKG-20261026-boundary-${++serial}`,
    sessions: 10,
    specialPrice: 10000,
    staffPay: 6000,
  });
  const invalidPatches = [
    ['PATCH ราคาติดลบ', { special_price: -0.01 }],
    ['PATCH จำนวนครั้งเป็นศูนย์', { sessions: 0 }],
    ['PATCH จำนวนครั้งติดลบ', { sessions: -1 }],
    ['PATCH จำนวนครั้งเป็นทศนิยม', { sessions: 2.5 }],
  ];
  for (const [label, body] of invalidPatches) {
    const result = await patch(`/api/physio/packages/${baseline.physio_package_id}`, body);
    invalidResults.push({ label, status: result.status, body: result.body });
  }

  const acceptedInvalid = invalidResults.filter((result) => result.status < 400);
  if (acceptedInvalid.length > 0) {
    hit(
      'รับราคาติดลบหรือจำนวนครั้งที่เป็นศูนย์/ติดลบ/ไม่ใช่จำนวนเต็ม',
      acceptedInvalid.map((result) => `${result.label}=${result.status}`).join(' · '),
    );
  } else {
    ok(`ค่าขอบเขตผิดถูกกันครบ ${invalidResults.length} จุด ทั้ง POST และ PATCH`);
  }

  const decimalCreate = await post('/api/physio/packages', {
    name: `QA-PKG-20261026-three-dec-create-${++serial}`,
    sessions: 10,
    special_price: 1000.001,
    staff_pay: 500.009,
  });
  if (decimalCreate.status === 201) rememberPackage(decimalCreate.body);

  const decimalPatch = await patch(`/api/physio/packages/${baseline.physio_package_id}`, {
    special_price: 1234.567,
    staff_pay: 700.009,
  });

  const rateBefore = (await get('/api/packages/matrix', MANAGER)).body.rates.find(
    (rate) => rate.customer_price != null && rate.staff_pay != null,
  );
  assert.ok(rateBefore);
  const decimalRate = await patch('/api/packages/rates', {
    rates: [{
      format_id: rateBefore.format_id,
      grade_id: rateBefore.grade_id ?? null,
      staff_tier: rateBefore.staff_tier,
      customer_price: 2000.001,
      staff_pay: 1200.009,
      discount_percent: rateBefore.discount_percent ?? null,
      discount_amount: rateBefore.discount_amount ?? null,
      available: rateBefore.available,
    }],
  });

  const decimalAccepted = [
    `physio POST=${decimalCreate.status}`,
    `physio PATCH=${decimalPatch.status}`,
    `packages PATCH rates=${decimalRate.status}`,
  ];
  if (decimalCreate.status < 400 || decimalPatch.status < 400 || decimalRate.status < 400) {
    hit('ยอดเงินทศนิยมเกิน 2 ตำแหน่งผ่าน API ได้', decimalAccepted.join(' · '));
  } else {
    ok('ราคาขายและค่าจ้างที่เกิน 2 ตำแหน่งถูกปฏิเสธทั้งแพ็กเกจกายภาพและตารางเรท');
  }
  await sql.run(
    `UPDATE pkg_rates
     SET customer_price = :customer_price, staff_pay = :staff_pay,
         discount_percent = :discount_percent, discount_amount = :discount_amount,
         available = :available
     WHERE rate_id = :id`,
    {
      id: rateBefore.rate_id,
      customer_price: rateBefore.customer_price,
      staff_pay: rateBefore.staff_pay,
      discount_percent: rateBefore.discount_percent ?? null,
      discount_amount: rateBefore.discount_amount ?? null,
      available: rateBefore.available,
    },
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('3 · ใช้เกินจำนวนครั้งที่ซื้อ และครั้งคงเหลือติดลบ');
{
  const pkg = await newPackage({
    name: `QA-PKG-20261026-quota-${++serial}`,
    sessions: 10,
    specialPrice: 10000,
    staffPay: 6000,
  });

  const bulkCase = await newPhysioCase(pkg, 'ลงนัด 11 ครั้งในคำขอเดียว');
  const bulkEleven = await post(`/api/cases/${bulkCase.case_id}/visits/bulk`, {
    dates: datesFrom('2027-01-01', 11),
  });
  const bulkVisits = await visitsOf(bulkCase.case_id);
  const bulkActive = bulkVisits.filter((visit) => visit.status !== 'cancelled').length;

  const usedCase = await newPhysioCase(pkg, 'ใช้ครบ 10 แล้วบันทึกครั้งที่ 11');
  const firstTen = await post(`/api/cases/${usedCase.case_id}/visits/bulk`, {
    dates: datesFrom('2027-02-01', 10),
  });
  assert.equal(firstTen.status, 201, JSON.stringify(firstTen.body));
  assert.equal(firstTen.body.added, 10, JSON.stringify(firstTen.body));
  await markDone(usedCase.case_id, firstTen.body.visits);

  const eleventh = await post(`/api/cases/${usedCase.case_id}/visits`, {
    visit_date: '2027-02-20',
  });
  const usedVisits = await visitsOf(usedCase.case_id);
  const usedActive = usedVisits.filter((visit) => visit.status !== 'cancelled').length;
  const done = usedVisits.filter((visit) => visit.status === 'done').length;
  const remaining = Number(pkg.sessions) - usedActive;

  if (
    (bulkEleven.status === 201 && bulkActive > Number(pkg.sessions)) ||
    (eleventh.status === 201 && usedActive > Number(pkg.sessions)) ||
    remaining < 0
  ) {
    /* 🔴 ดร.ธงชัย 26 ต.ค. 2569: *"เตือนอย่างเดียวพอครับ อย่าบล็อก"*
       นัดเกินโควตาได้โดยตั้งใจ (ลูกค้าซื้อเพิ่มกลางคอร์ส / ชดเชยนัดที่ยกเลิก เป็นเรื่องที่เกิดจริง)
       สิ่งที่ต้องมีคือ "คนเห็น" — ป้ายแดง "เกินแพ็กที่ซื้อ N ครั้ง" ใน CaseModal.jsx (commit 2fc68c3)
       ห้ามเปลี่ยนข้อนี้กลับเป็นบัค */
    ok(
      `นัดเกินโควตาได้ตามที่ ดร. เคาะ (เตือน ไม่บล็อก) — bulk11=${bulkEleven.status}, ` +
        `ครั้งที่11=${eleventh.status}, active=${usedActive}, เกินมา ${-remaining} ครั้ง`,
    );
  } else {
    ok(
      `แพ็ก 10 ครั้งกันทั้ง bulk 11 และครั้งที่ 11 หลังใช้ครบ; active=${usedActive}; remaining=${remaining}`,
    );
  }
}

// -----------------------------------------------------------------------------
await resetTopic();
head('4 · เปลี่ยนแพ็กกลางคันหลังใช้ไป 3 ครั้ง');
{
  const pkgA = await newPackage({
    name: `QA-PKG-20261026-switch-A-${++serial}`,
    sessions: 10,
    specialPrice: 10000,
    staffPay: 6000,
  });
  const pkgB = await newPackage({
    name: `QA-PKG-20261026-switch-B-${++serial}`,
    sessions: 20,
    specialPrice: 18000,
    staffPay: 11000,
  });
  const kase = await newPhysioCase(pkgA, 'เปลี่ยนแพ็กหลังใช้สามครั้ง');
  const firstThree = await post(`/api/cases/${kase.case_id}/visits/bulk`, {
    dates: datesFrom('2027-03-01', 3),
  });
  assert.equal(firstThree.status, 201, JSON.stringify(firstThree.body));
  await markDone(kase.case_id, firstThree.body.visits);
  const usedIds = (await visitsOf(kase.case_id)).map((visit) => visit.visit_id).sort((a, b) => a - b);
  const invoiceBefore = await invoiceForCase(kase.case_id);

  const switched = await patch(`/api/cases/${kase.case_id}`, {
    service_kind: 'physio',
    physio_package_id: pkgB.physio_package_id,
    fee: pkgB.special_price,
  });
  const caseAfter = await get(`/api/cases/${kase.case_id}`);
  const visitsAfter = await visitsOf(kase.case_id);
  const invoiceAfter = await invoiceForCase(kase.case_id);
  const idsAfter = visitsAfter.map((visit) => visit.visit_id).sort((a, b) => a - b);
  const doneAfter = visitsAfter.filter((visit) => visit.status === 'done').length;

  const correct =
    switched.status === 200 &&
    caseAfter.status === 200 &&
    Number(caseAfter.body.physio_package_id) === Number(pkgB.physio_package_id) &&
    Number(caseAfter.body.fee) === Number(pkgB.special_price) &&
    Number(caseAfter.body.staff_pay) === Number(pkgB.staff_pay) &&
    JSON.stringify(idsAfter) === JSON.stringify(usedIds) &&
    doneAfter === 3 &&
    invoiceAfter.invoice_id === invoiceBefore.invoice_id &&
    Number(invoiceAfter.total) === Number(pkgB.special_price) &&
    String(invoiceAfter.service_description).includes(pkgB.name);

  if (!correct) {
    hit(
      'เปลี่ยนแพ็กกลางคันแล้วครั้งที่ใช้ไปหรือยอดเคส/ใบแจ้งหนี้ตามไม่ครบ',
      `PATCH=${switched.status}; case=${JSON.stringify(caseAfter.body)}; ` +
        `used_before=${usedIds.join(',')}; used_after=${idsAfter.join(',')}/done=${doneAfter}; ` +
        `invoice_before=${invoiceBefore.invoice_id}/${invoiceBefore.total}; ` +
        `invoice_after=${invoiceAfter.invoice_id}/${invoiceAfter.total}/${invoiceAfter.service_description}`,
    );
  } else {
    ok('ใช้ไป 3 ครั้งแล้วยังอยู่ครบ; เคสย้ายไปแพ็กใหม่; fee/staff_pay และใบร่างใบเดิมขยับตามแพ็กใหม่');
  }
}

// -----------------------------------------------------------------------------
await resetTopic();
head('5 · แก้ราคา/จำนวนครั้งของแพ็กเกจต้นแบบต้องไม่ย้อนเคสเก่า');
{
  const pkg = await newPackage({
    name: `QA-PKG-20261026-snapshot-${++serial}`,
    sessions: 10,
    specialPrice: 12000,
    staffPay: 7000,
  });
  const kase = await newPhysioCase(pkg, 'เคสที่ซื้อแพ็กเดิมแล้ว');
  const two = await post(`/api/cases/${kase.case_id}/visits/bulk`, {
    dates: datesFrom('2027-04-01', 2),
  });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  await markDone(kase.case_id, two.body.visits);

  const caseBefore = (await get(`/api/cases/${kase.case_id}`)).body;
  const invoiceBefore = await invoiceForCase(kase.case_id);
  // แก้จำนวนครั้งของแพ็กที่มีเคสใช้อยู่ = ต้องถูกกั้น (แก้รอบ 15) · ราคายังแก้ได้ตามเดิม
  const changedSessions = await patch(`/api/physio/packages/${pkg.physio_package_id}`, { sessions: 20 });
  if (changedSessions.status !== 409) {
    hit('แก้จำนวนครั้งของแพ็กที่มีเคสใช้อยู่ได้', `PATCH sessions=20 -> ${changedSessions.status}`);
  } else ok('แก้จำนวนครั้งของแพ็กที่ขายไปแล้วถูกกัน 409 พร้อมบอกให้สร้างแพ็กใหม่');

  const changedTemplate = await patch(`/api/physio/packages/${pkg.physio_package_id}`, {
    special_price: 8000,
    staff_pay: 4000,
  });
  assert.equal(changedTemplate.status, 200, JSON.stringify(changedTemplate.body));
  const caseAfter = (await get(`/api/cases/${kase.case_id}`)).body;
  const invoiceAfter = await invoiceForCase(kase.case_id);

  const priceSnapshotSafe =
    Number(caseAfter.fee) === Number(caseBefore.fee) &&
    Number(caseAfter.staff_pay) === Number(caseBefore.staff_pay) &&
    Number(invoiceAfter.total) === Number(invoiceBefore.total);
  if (!priceSnapshotSafe) {
    hit(
      'แก้ราคาต้นแบบแล้วย้อนเปลี่ยนราคาที่เคสเก่าซื้อหรือยอดใบแจ้งหนี้',
      `case fee ${caseBefore.fee}->${caseAfter.fee}; staff_pay ${caseBefore.staff_pay}->${caseAfter.staff_pay}; ` +
        `invoice total ${invoiceBefore.total}->${invoiceAfter.total}`,
    );
  } else {
    ok('แก้ราคาต้นแบบ 12,000→8,000 และค่าจ้าง 7,000→4,000 แล้ว snapshot ของเคส/ใบเดิมยังคงราคาเก่า');
  }

  const beforeRemaining = Number(caseBefore.physio_sessions) - 2;
  const afterRemaining = Number(caseAfter.physio_sessions) - 2;
  if (Number(caseAfter.physio_sessions) !== Number(caseBefore.physio_sessions)) {
    hit(
      'แก้จำนวนครั้งต้นแบบแล้วย้อนเปลี่ยนสิทธิ์ของเคสเก่า',
      `เคสเดิม physio_sessions ${caseBefore.physio_sessions}->${caseAfter.physio_sessions}; ` +
        `ใช้ไป 2 ครั้ง คงเหลือ ${beforeRemaining}->${afterRemaining}`,
    );
  } else {
    ok(`แก้ต้นแบบแล้วเคสเก่ายังคง ${caseAfter.physio_sessions} ครั้ง; ใช้ไป 2 เหลือ ${afterRemaining}`);
  }
}

// -----------------------------------------------------------------------------
await resetTopic();
head('6 · ปิดขาย/ลบแพ็กเกจที่มีเคสใช้อยู่');
{
  const pkg = await newPackage({
    name: `QA-PKG-20261026-retire-${++serial}`,
    sessions: 10,
    specialPrice: 14000,
    staffPay: 8000,
  });
  const kase = await newPhysioCase(pkg, 'เคสที่ใช้แพ็กซึ่งกำลังปิดขาย');
  const firstTwo = await post(`/api/cases/${kase.case_id}/visits/bulk`, {
    dates: datesFrom('2027-05-01', 2),
  });
  assert.equal(firstTwo.status, 201, JSON.stringify(firstTwo.body));
  await markDone(kase.case_id, firstTwo.body.visits);
  const invoiceBefore = await invoiceForCase(kase.case_id);

  const disabled = await patch(`/api/physio/packages/${pkg.physio_package_id}`, { active: false });
  const existingAfterDisable = await get(`/api/cases/${kase.case_id}`);
  if (
    disabled.status !== 200 ||
    existingAfterDisable.status !== 200 ||
    Number(existingAfterDisable.body.physio_package_id) !== Number(pkg.physio_package_id) ||
    Number(existingAfterDisable.body.physio_sessions) !== 10 ||
    Number(existingAfterDisable.body.fee) !== 14000
  ) {
    hit(
      'ปิดขายแพ็กเกจแล้วเคสเดิมเสียข้อมูล',
      `disable=${disabled.status}; case=${JSON.stringify(existingAfterDisable.body)}`,
    );
  } else {
    ok('ตั้ง active=false แล้วเคสเดิมยังผูกแพ็ก 10 ครั้งและราคาเดิมครบ');
  }

  const inactiveSaleBody = caseBody(pkg, 'พยายามเปิดเคสใหม่ด้วยแพ็กปิดขาย');
  const inactiveSale = await post('/api/cases', inactiveSaleBody);
  if (inactiveSale.status === 201) {
    topicCaseIds.add(inactiveSale.body.case_id);
    hit(
      'แพ็กเกจที่ active=false ยังถูกใช้เปิดเคสใหม่ผ่าน API ได้',
      `POST /api/cases -> 201 case_id=${inactiveSale.body.case_id}`,
    );
  } else {
    ok(`เปิดเคสใหม่ด้วยแพ็กปิดขายถูกกัน ${inactiveSale.status}`);
  }

  const removed = await del(`/api/physio/packages/${pkg.physio_package_id}`);
  if (removed.status === 204) {
    const existingAfterDelete = await get(`/api/cases/${kase.case_id}`);
    const visitsAfterDelete = await visitsOf(kase.case_id);
    const invoiceAfterDelete = await invoiceForCase(kase.case_id);
    const moneyAndWorkSafe =
      existingAfterDelete.status === 200 &&
      Number(existingAfterDelete.body.fee) === 14000 &&
      Number(existingAfterDelete.body.staff_pay) === 8000 &&
      visitsAfterDelete.length === 2 &&
      Number(invoiceAfterDelete.total) === Number(invoiceBefore.total);

    if (!moneyAndWorkSafe) {
      hit(
        'ลบแพ็กเกจแล้วเคสเดิม/นัดเดิม/ยอดเดิมพัง',
        `case=${JSON.stringify(existingAfterDelete.body)}; visits=${visitsAfterDelete.length}; ` +
          `invoice=${invoiceBefore.total}->${invoiceAfterDelete.total}`,
      );
    } else {
      ok('ลบต้นแบบแล้วตัวเคส นัด 2 ครั้ง ราคา ค่าจ้าง และใบแจ้งหนี้ยังอยู่');
    }

    if (
      existingAfterDelete.body.physio_package_id == null &&
      existingAfterDelete.body.physio_sessions == null
    ) {
      hit(
        'ลบแพ็กเกจแล้วเคสเก่าหายจำนวนครั้งที่ซื้อ จึงคำนวณคงเหลือไม่ได้',
        `case=${kase.case_id}; physio_package_id=null; physio_sessions=null; ใช้ไป=${visitsAfterDelete.length}`,
      );
    } else {
      ok('หลังลบต้นแบบ เคสเก่ายังมีจำนวนครั้งที่ซื้อไว้สำหรับคำนวณคงเหลือ');
    }
  } else if (removed.status >= 400) {
    const stillThere = await get(`/api/physio/packages/${pkg.physio_package_id}`);
    if (stillThere.status === 200) {
      ok(`แพ็กเกจที่มีเคสใช้อยู่ถูกป้องกันการลบ (${removed.status}) และควรใช้ active=false แทน`);
    } else {
      hit('DELETE แพ็กเกจล้มแต่ต้นแบบหายไป', `DELETE=${removed.status}; GET=${stillThere.status}`);
    }
  } else {
    hit('DELETE แพ็กเกจคืนสถานะผิดคาด', `${removed.status}/${JSON.stringify(removed.body)}`);
  }
}

// -----------------------------------------------------------------------------
await resetTopic();
head('7 · สองหน้าจอพร้อมกัน: ชื่อซ้ำและใช้ครั้งสุดท้าย');
{
  const sameCreateName = `QA-PKG-20261026-concurrent-create-${++serial}`;
  const [createA, createB] = await Promise.all([
    post('/api/physio/packages', {
      name: sameCreateName, sessions: 10, special_price: 10000, staff_pay: 6000,
    }),
    post('/api/physio/packages', {
      name: sameCreateName, sessions: 10, special_price: 10000, staff_pay: 6000,
    }),
  ]);
  if (createA.status === 201) rememberPackage(createA.body);
  if (createB.status === 201) rememberPackage(createB.body);
  const createDuplicates = await sql.one(
    'SELECT count(*)::int AS n FROM physio_packages WHERE name = :name',
    { name: sameCreateName },
  );
  if (createDuplicates.n > 1) {
    hit(
      'สองหน้าจอสร้างแพ็กเกจชื่อเดียวกันพร้อมกันแล้วได้รายการซ้ำ',
      `HTTP=${createA.status},${createB.status}; rows=${createDuplicates.n}`,
    );
  } else {
    ok(`สร้างชื่อเดียวกันพร้อมกันเหลือ ${createDuplicates.n} แถว; HTTP=${createA.status},${createB.status}`);
  }

  const renameA = await newPackage({
    name: `QA-PKG-20261026-rename-A-${++serial}`,
    sessions: 5,
    specialPrice: 5000,
    staffPay: 3000,
  });
  const renameB = await newPackage({
    name: `QA-PKG-20261026-rename-B-${++serial}`,
    sessions: 5,
    specialPrice: 5000,
    staffPay: 3000,
  });
  const sameRenameName = `QA-PKG-20261026-concurrent-rename-${++serial}`;
  const [patchA, patchB] = await Promise.all([
    patch(`/api/physio/packages/${renameA.physio_package_id}`, { name: sameRenameName }),
    patch(`/api/physio/packages/${renameB.physio_package_id}`, { name: sameRenameName }),
  ]);
  const renameDuplicates = await sql.one(
    'SELECT count(*)::int AS n FROM physio_packages WHERE name = :name',
    { name: sameRenameName },
  );
  if (renameDuplicates.n > 1) {
    hit(
      'สองหน้าจอแก้แพ็กเกจคนละรายการให้เป็นชื่อเดียวกันพร้อมกันแล้วได้ชื่อซ้ำ',
      `HTTP=${patchA.status},${patchB.status}; rows=${renameDuplicates.n}`,
    );
  } else {
    ok(`แก้สองรายการเป็นชื่อเดียวกันพร้อมกันเหลือ ${renameDuplicates.n} แถว; HTTP=${patchA.status},${patchB.status}`);
  }

  const quotaPkg = await newPackage({
    name: `QA-PKG-20261026-concurrent-quota-${++serial}`,
    sessions: 10,
    specialPrice: 10000,
    staffPay: 6000,
  });
  const kase = await newPhysioCase(quotaPkg, 'สองหน้าจอบันทึกครั้งสุดท้าย');
  const nine = await post(`/api/cases/${kase.case_id}/visits/bulk`, {
    dates: datesFrom('2027-06-01', 9),
  });
  assert.equal(nine.status, 201, JSON.stringify(nine.body));
  assert.equal(nine.body.added, 9, JSON.stringify(nine.body));
  await markDone(kase.case_id, nine.body.visits);

  const [lastA, lastB] = await Promise.all([
    post(`/api/cases/${kase.case_id}/visits`, { visit_date: '2027-06-20' }),
    post(`/api/cases/${kase.case_id}/visits`, { visit_date: '2027-06-21' }),
  ]);
  const afterCreate = await visitsOf(kase.case_id);
  const newlyCreated = afterCreate.filter(
    (visit) => ['2027-06-20', '2027-06-21'].includes(visit.visit_date),
  );
  await markDone(kase.case_id, newlyCreated);
  const afterDone = await visitsOf(kase.case_id);
  const active = afterDone.filter((visit) => visit.status !== 'cancelled').length;
  const done = afterDone.filter((visit) => visit.status === 'done').length;
  const remaining = Number(quotaPkg.sessions) - active;

  if (active > Number(quotaPkg.sessions) || remaining < 0) {
    // เหตุผลเดียวกับหัวข้อ 3 — ไม่บล็อกตามที่ ดร. เคาะ
    ok(
      `สองหน้าจอบันทึกครั้งสุดท้ายพร้อมกันแล้วเกินโควตา — ไม่บล็อกตามที่ ดร. เคาะ; ` +
        `HTTP=${lastA.status},${lastB.status}; active=${active}; done=${done}`,
    );
  } else {
    ok(
      `สองหน้าจอบันทึกครั้งสุดท้ายพร้อมกันสำเร็จไม่เกินหนึ่งคำขอ; HTTP=${lastA.status},${lastB.status}; ` +
        `active=${active}; remaining=${remaining}`,
    );
  }
}

await resetTopic();
console.log(
  `\n=== สรุป: 7 หัวข้อ · พบบัคที่พิสูจน์ได้ ${found.length} ข้อ · ยิงแล้วกันได้ ${notes.length} จุด ===`,
);
found.forEach((item, i) => console.log(`FOUND ${i + 1} | ${item.title} | ${item.detail}`));

await new Promise((resolve) => server.close(resolve));
await pool.end();
