// QA รอบ 16: แอปพนักงานภาคสนาม /api/my
// รัน: node test/_run_probe.mjs test/_qa_myapp_20261026.mjs
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
const FIELD_A = {
  employee_id: 'EMP-0003', position: 'caregiver',
  first_name: 'พนักงานเอ', last_name: 'ทดสอบ',
};
const FIELD_B = {
  employee_id: 'EMP-9101', position: 'caregiver',
  first_name: 'พนักงานบี', last_name: 'ทดสอบ',
};
const TEAM = {
  employee_id: 'EMP-9102', position: 'nurse',
  first_name: 'สมาชิกทีม', last_name: 'ทดสอบ',
};
const BLOCKED = {
  employee_id: 'EMP-9103', position: 'therapist',
  first_name: 'พนักงานสถานะ', last_name: 'ทดสอบ',
};
const FRESH = {
  employee_id: 'EMP-9104', position: 'caregiver',
  first_name: 'พนักงานใหม่', last_name: 'ทดสอบ',
};

await seedFixtures(pool, hashPassword);
for (const who of [FIELD_B, TEAM, BLOCKED, FRESH]) {
  await sql.run(
    `INSERT INTO employees
       (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
     VALUES (:id, :first, :last, :position, :email, 'active', 'x', :must_change)`,
    {
      id: who.employee_id,
      first: who.first_name,
      last: who.last_name,
      position: who.position,
      email: `${who.employee_id}@example.invalid`,
      must_change: who === FRESH,
    },
  );
}
// fixture ของ FIELD_A ปลดด่านนี้ไว้แล้ว แต่ย้ำให้ข้อมูลตั้งต้นของชุดนี้อ่านได้จากจุดเดียว
await sql.run(
  `UPDATE employees SET status = 'active', must_change_password = false
   WHERE employee_id = :id`,
  { id: FIELD_A.employee_id },
);

const clock = await sql.one(
  `SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS today,
          to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day', 'YYYY-MM-DD') AS yesterday,
          to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '1 day', 'YYYY-MM-DD') AS tomorrow,
          to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month`,
);

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, body, who = FIELD_A) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...jar(who) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.startsWith('image/')) {
    return {
      status: res.status,
      body: Buffer.from(await res.arrayBuffer()),
      contentType,
    };
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data, contentType };
}
const get = (path, who = FIELD_A) => call('GET', path, undefined, who);
const post = (path, body, who = FIELD_A) => call('POST', path, body ?? {}, who);
const patch = (path, body, who = FIELD_A) => call('PATCH', path, body ?? {}, who);

const VALID_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const NOT_AN_IMAGE = `data:image/png;base64,${Buffer.from('นี่ไม่ใช่รูป').toString('base64')}`;

let checks = 0;
const found = [];
const notes = [];
const hit = (title, detail) => {
  found.push({ title, detail });
  console.log(`\nBUG | ${title}\nRESULT | ${detail}`);
};
const ok = (what) => {
  notes.push(what);
  console.log(`PASS | ${what}`);
};
const head = (title) => console.log(`\n=== ${title} ===`);
const brief = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};
const probe = (condition, bugTitle, detail, passText) => {
  checks += 1;
  if (condition) ok(passText);
  else hit(bugTitle, detail);
};

const CASE_PREFIX = 'QA-MY-';
const PAY_PREFIX = 'QA-MY-PAY-';

async function resetTopic() {
  // แต่ละหัวข้อใช้ข้อมูลคนละชุด และล้างทั้งเคส/กะ/รายงาน/แชท/รอบจ่ายของหัวข้อก่อนหน้า
  // ก่อนเริ่มหัวข้อถัดไป เพื่อไม่ให้ยอดกะ นาที หรือสลิปปนกัน
  await sql.run(`DELETE FROM payroll_runs WHERE run_id LIKE :prefix`, { prefix: `${PAY_PREFIX}%` });
  await sql.run(`DELETE FROM cases WHERE case_id LIKE :prefix`, { prefix: `${CASE_PREFIX}%` });
  await sql.run(
    `UPDATE employees SET status = 'active', must_change_password = CASE WHEN employee_id = :fresh THEN true ELSE false END
     WHERE employee_id IN (:a, :b, :team, :blocked, :fresh)`,
    {
      a: FIELD_A.employee_id,
      b: FIELD_B.employee_id,
      team: TEAM.employee_id,
      blocked: BLOCKED.employee_id,
      fresh: FRESH.employee_id,
    },
  );
}

async function newCase(id, assignedTo, { staffPay = 4200, fee = 9000, status = 'assigned' } = {}) {
  return sql.one(
    `INSERT INTO cases (case_id, title, case_type, client_name, status, assigned_to, fee, staff_pay)
     VALUES (:id, :title, 'elderly_care', :client, :status, :assigned_to, :fee, :staff_pay)
     RETURNING *`,
    {
      id,
      title: `เคสทดสอบ ${id}`,
      client: `ผู้รับบริการ ${id}`,
      status,
      assigned_to: assignedTo,
      fee,
      staff_pay: staffPay,
    },
  );
}

async function addTeam(caseId, employeeId) {
  await sql.run(
    `INSERT INTO case_team (case_id, employee_id, added_by)
     VALUES (:case_id, :employee_id, :added_by)`,
    { case_id: caseId, employee_id: employeeId, added_by: MANAGER.employee_id },
  );
}

async function newVisit(caseId, assignedTo, visitDate = clock.today, { status = 'scheduled' } = {}) {
  return sql.one(
    `INSERT INTO case_visits (case_id, visit_date, assigned_to, status, planned_start, planned_end)
     VALUES (:case_id, :visit_date, :assigned_to, :status, '09:00', '11:00')
     RETURNING visit_id, case_id, visit_date, assigned_to, status`,
    { case_id: caseId, visit_date: visitDate, assigned_to: assignedTo, status },
  );
}

async function seedCheckedVisit(visitId, employeeId, { minutes = 60, photo = true, done = true } = {}) {
  await sql.run(
    `UPDATE case_visits
     SET checked_in_by = :employee_id,
         check_in_at = now() - make_interval(mins => :minutes),
         check_out_at = CASE WHEN :done THEN now() ELSE NULL END,
         status = CASE WHEN :done THEN 'done' ELSE status END,
         check_in_photo_data = CASE WHEN :photo THEN :data::bytea ELSE NULL END,
         check_in_photo_mime = CASE WHEN :photo THEN 'image/png' ELSE NULL END,
         check_in_photo_size = CASE WHEN :photo THEN :size::int ELSE NULL END
     WHERE visit_id = :visit_id`,
    {
      visit_id: visitId,
      employee_id: employeeId,
      minutes,
      done,
      photo,
      data: Buffer.from(VALID_PNG.split(',')[1], 'base64'),
      size: Buffer.from(VALID_PNG.split(',')[1], 'base64').length,
    },
  );
}

async function seedReport(caseId, visitId, actor, { photo = true, symptoms = 'รายงานตั้งต้น' } = {}) {
  const bytes = photo ? Buffer.from(VALID_PNG.split(',')[1], 'base64') : null;
  return sql.one(
    `INSERT INTO case_reports
       (case_id, visit_id, report_date, symptoms, reported_by, reported_by_name,
        wound_photo_data, wound_photo_mime, wound_photo_size)
     VALUES (:case_id, :visit_id, :report_date, :symptoms, :employee_id, :employee_name,
             :photo_data, :photo_mime, :photo_size)
     RETURNING report_id`,
    {
      case_id: caseId,
      visit_id: visitId,
      report_date: clock.today,
      symptoms,
      employee_id: actor.employee_id,
      employee_name: `${actor.first_name} ${actor.last_name}`,
      photo_data: bytes,
      photo_mime: photo ? 'image/png' : null,
      photo_size: bytes?.length ?? null,
    },
  );
}

function idsIn(value, key) {
  if (Array.isArray(value)) return value.flatMap((v) => idsIn(v, key));
  if (!value || typeof value !== 'object') return [];
  const own = Object.prototype.hasOwnProperty.call(value, key) ? [value[key]] : [];
  return own.concat(Object.values(value).flatMap((v) => idsIn(v, key)));
}

function forbiddenKeys(value, names, path = '$') {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, names, `${path}[${i}]`));
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key.toLowerCase())) out.push(`${path}.${key}`);
    out.push(...forbiddenKeys(child, names, `${path}.${key}`));
  }
  return out;
}

const CASE_MONEY = new Set([
  'fee', 'staff_pay', 'rate_staff_pay', 'rate_customer_price',
  'physio_staff_pay', 'physio_original_price', 'margin', 'profit', 'cost',
]);

// -----------------------------------------------------------------------------
await resetTopic();
head('1 · ขอบเขตข้อมูลตัวเอง + คนในทีมเคส');
{
  const ownCase = await newCase(`${CASE_PREFIX}SCOPE-A`, FIELD_A.employee_id);
  const otherCase = await newCase(`${CASE_PREFIX}SCOPE-B`, FIELD_B.employee_id);
  const teamCase = await newCase(`${CASE_PREFIX}SCOPE-TEAM`, FIELD_B.employee_id);
  await addTeam(teamCase.case_id, TEAM.employee_id);

  const ownVisit = await newVisit(ownCase.case_id, FIELD_A.employee_id);
  const otherVisit = await newVisit(otherCase.case_id, FIELD_B.employee_id);
  const teamVisit = await newVisit(teamCase.case_id, FIELD_B.employee_id);
  await seedCheckedVisit(ownVisit.visit_id, FIELD_A.employee_id);
  await seedCheckedVisit(otherVisit.visit_id, FIELD_B.employee_id);
  await seedCheckedVisit(teamVisit.visit_id, FIELD_B.employee_id);
  const otherReport = await seedReport(otherCase.case_id, otherVisit.visit_id, FIELD_B);
  const teamReport = await seedReport(teamCase.case_id, teamVisit.visit_id, FIELD_B);

  // สร้างตารางแชทและข้อความพร้อมรูปผ่านเส้นจริง เพื่อได้ message_id สำหรับลองเดาข้ามเคส
  const postedOther = await post(
    `/api/my/cases/${otherCase.case_id}/family-messages`,
    { body: 'ข้อความของเคสบี', image: VALID_PNG },
    FIELD_B,
  );
  assert.equal(postedOther.status, 201, JSON.stringify(postedOther.body));

  const [caseList, caseDetail, today, calendar, attendance, report, slips] = await Promise.all([
    get('/api/my/cases?employee_id=EMP-9101', FIELD_A),
    get(`/api/my/cases/${ownCase.case_id}`, FIELD_A),
    get('/api/my/today?employee_id=EMP-9101', FIELD_A),
    get(`/api/my/calendar?year=${clock.today.slice(0, 4)}&month=${clock.today.slice(5, 7)}&employee_id=EMP-9101`, FIELD_A),
    get(`/api/my/attendance?month=${clock.month}&employee_id=EMP-9101`, FIELD_A),
    get(`/api/my/attendance/report?month=${clock.month}&employee_id=EMP-9101`, FIELD_A),
    get('/api/my/payslips?employee_id=EMP-9101', FIELD_A),
  ]);
  const collectionLeak = [caseList, today, calendar, attendance, report, slips].some(
    (r) => r.status !== 200 || idsIn(r.body, 'case_id').includes(otherCase.case_id) ||
      idsIn(r.body, 'employee_id').includes(FIELD_B.employee_id),
  );
  probe(
    !collectionLeak,
    'ส่ง query employee_id ของคนอื่นแล้วรายการ /api/my รั่วข้อมูลคนนั้น',
    `cases=${brief(caseList.body)}; today=${brief(today.body)}; calendar=${brief(calendar.body)}; ` +
      `attendance=${brief(attendance.body)}; report=${brief(report.body)}; slips=${brief(slips.body)}`,
    'รายการเคส/วันนี้/ปฏิทิน/ประวัติ/สรุป/สลิปยึด employee_id จาก session ไม่รับของคนอื่นจาก query',
  );

  const moneyLeaks = [...forbiddenKeys(caseList.body, CASE_MONEY), ...forbiddenKeys(caseDetail.body, CASE_MONEY)];
  probe(
    caseList.status === 200 && caseDetail.status === 200 && moneyLeaks.length === 0,
    'ข้อมูลเคสฝั่งพนักงานมีราคาขาย/ต้นทุน/กำไรหลุดออกมา',
    `status=${caseList.status}/${caseDetail.status}; fields=${moneyLeaks.join(', ')}`,
    'GET /my/cases และ /my/cases/:id ไม่ส่งราคาขาย ต้นทุน หรือกำไร',
  );

  const otherIdCalls = [
    ['GET case', await get(`/api/my/cases/${otherCase.case_id}`, FIELD_A)],
    ['GET case reports', await get(`/api/my/cases/${otherCase.case_id}/reports`, FIELD_A)],
    ['PATCH report', await patch(`/api/my/cases/${otherCase.case_id}/reports/${otherReport.report_id}`, { symptoms: 'แอบแก้' }, FIELD_A)],
    ['GET report photo', await get(`/api/my/cases/${otherCase.case_id}/reports/${otherReport.report_id}/photo`, FIELD_A)],
    ['GET visit reports', await get(`/api/my/visits/${otherVisit.visit_id}/reports`, FIELD_A)],
    ['POST visit report', await post(`/api/my/visits/${otherVisit.visit_id}/reports`, { report_type: 'routine', shift: 'day',  report_type: 'routine', shift: 'day', symptoms: 'แอบลงรายงาน' }, FIELD_A)],
    ['GET visit photo', await get(`/api/my/visits/${otherVisit.visit_id}/photo`, FIELD_A)],
    ['POST check-in', await post(`/api/my/visits/${otherVisit.visit_id}/check-in`, { photo: VALID_PNG }, FIELD_A)],
    ['POST check-out', await post(`/api/my/visits/${otherVisit.visit_id}/check-out`, {}, FIELD_A)],
    ['GET family messages', await get(`/api/my/cases/${otherCase.case_id}/family-messages`, FIELD_A)],
    ['POST family message', await post(`/api/my/cases/${otherCase.case_id}/family-messages`, { body: 'แอบส่ง' }, FIELD_A)],
    ['GET family photo', await get(`/api/my/cases/${otherCase.case_id}/family-messages/${postedOther.body.message_id}/photo`, FIELD_A)],
  ];
  const idLeaks = otherIdCalls.filter(([, result]) => result.status !== 404);
  probe(
    idLeaks.length === 0,
    'เดา case_id / visit_id / report_id / message_id ของพนักงานอื่นแล้วเข้าถึงได้',
    idLeaks.map(([name, r]) => `${name} -> ${r.status}/${brief(r.body)}`).join(' · '),
    `ID ของคนอื่นถูกซ่อนเป็น 404 ครบ ${otherIdCalls.length} คำขอ`,
  );

  const [teamList, teamDetail, teamReports, teamReportPhoto, teamChat] = await Promise.all([
    get('/api/my/cases', TEAM),
    get(`/api/my/cases/${teamCase.case_id}`, TEAM),
    get(`/api/my/cases/${teamCase.case_id}/reports`, TEAM),
    get(`/api/my/cases/${teamCase.case_id}/reports/${teamReport.report_id}/photo`, TEAM),
    get(`/api/my/cases/${teamCase.case_id}/family-messages`, TEAM),
  ]);
  const teamCanRead =
    teamList.status === 200 && idsIn(teamList.body, 'case_id').includes(teamCase.case_id) &&
    teamDetail.status === 200 && teamReports.status === 200 && teamReportPhoto.status === 200 &&
    teamChat.status === 200;
  probe(
    teamCanRead,
    'สมาชิกทีมเคสที่ไม่ใช่ผู้รับผิดชอบหลักอ่านข้อมูลร่วมของเคสไม่ได้',
    `list=${teamList.status}; detail=${teamDetail.status}; reports=${teamReports.status}; ` +
      `reportPhoto=${teamReportPhoto.status}; chat=${teamChat.status}`,
    'สมาชิก case_team อ่านรายละเอียด รายงาน รูปแผล และแชทของเคสได้',
  );

  const teamVisitCalls = await Promise.all([
    get(`/api/my/visits/${teamVisit.visit_id}/reports`, TEAM),
    post(`/api/my/visits/${teamVisit.visit_id}/reports`, { report_type: 'routine', shift: 'day',  report_type: 'routine', shift: 'day', symptoms: 'ไม่ใช่กะของฉัน' }, TEAM),
    get(`/api/my/visits/${teamVisit.visit_id}/photo`, TEAM),
    post(`/api/my/visits/${teamVisit.visit_id}/check-in`, { photo: VALID_PNG }, TEAM),
    post(`/api/my/visits/${teamVisit.visit_id}/check-out`, {}, TEAM),
    patch(`/api/my/cases/${teamCase.case_id}/reports/${teamReport.report_id}`, { symptoms: 'ไม่ใช่ใบของฉัน' }, TEAM),
  ]);
  probe(
    teamVisitCalls.every((r) => r.status === 404),
    'สมาชิกทีมเคสแตะกะหรือแก้รายงานของผู้รับผิดชอบคนอื่นได้',
    teamVisitCalls.map((r) => `${r.status}/${brief(r.body)}`).join(' · '),
    'สมาชิกทีมอ่านข้อมูลร่วมได้ แต่กะและสิทธิ์แก้รายงานยังเป็นของเจ้าของแต่ละคน',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('2 · เช็คอิน/เช็คเอาท์ + นาทีเข้าสรุปค่าตอบแทน');
{
  const kase = await newCase(`${CASE_PREFIX}CLOCK`, FIELD_A.employee_id);

  const noCheckIn = await newVisit(kase.case_id, FIELD_A.employee_id);
  const outWithoutIn = await post(`/api/my/visits/${noCheckIn.visit_id}/check-out`, {});
  probe(
    outWithoutIn.status === 409,
    'เช็คเอาท์ได้ทั้งที่ยังไม่เช็คอิน',
    `${outWithoutIn.status}/${brief(outWithoutIn.body)}`,
    'เช็คเอาท์ก่อนเช็คอินถูกกัน 409',
  );

  const duplicate = await newVisit(kase.case_id, FIELD_A.employee_id);
  const firstIn = await post(`/api/my/visits/${duplicate.visit_id}/check-in`, { photo: VALID_PNG });
  const secondIn = await post(`/api/my/visits/${duplicate.visit_id}/check-in`, { photo: VALID_PNG });
  probe(
    firstIn.status === 200 && secondIn.status === 409,
    'เช็คอินกะเดิมซ้ำสองครั้งได้',
    `ครั้งแรก=${firstIn.status}; ครั้งสอง=${secondIn.status}`,
    'เช็คอินครั้งแรกสำเร็จ และครั้งซ้ำถูกกัน 409',
  );

  const past = await newVisit(kase.case_id, FIELD_A.employee_id, clock.yesterday);
  const pastIn = await post(`/api/my/visits/${past.visit_id}/check-in`, { photo: VALID_PNG });
  const pastRow = await sql.one(
    'SELECT check_in_at, off_schedule FROM case_visits WHERE visit_id = :id',
    { id: past.visit_id },
  );
  probe(
    pastIn.status === 200 && pastRow?.check_in_at && pastRow.off_schedule === true,
    'เช็คอินย้อนหลังไม่ได้หรือลืมติดธงนอกวันนัด',
    `${pastIn.status}/${brief(pastIn.body)}; db=${brief(pastRow)}`,
    'เช็คอินย้อนหลังได้ตามกติกา และติด off_schedule=true ให้ผู้จัดการตรวจ',
  );

  const future = await newVisit(kase.case_id, FIELD_A.employee_id, clock.tomorrow);
  const futureIn = await post(`/api/my/visits/${future.visit_id}/check-in`, { photo: VALID_PNG });
  const futureRow = await sql.one('SELECT check_in_at FROM case_visits WHERE visit_id = :id', { id: future.visit_id });
  probe(
    futureIn.status === 409 && futureRow.check_in_at == null,
    'เช็คอินกะล่วงหน้าได้',
    `${futureIn.status}/${brief(futureIn.body)}; check_in_at=${futureRow.check_in_at}`,
    'กะวันพรุ่งนี้ถูกกัน 409 และไม่เขียนเวลาเช็คอิน',
  );

  const cancelled = await newVisit(kase.case_id, FIELD_A.employee_id, clock.today, { status: 'cancelled' });
  const cancelledIn = await post(`/api/my/visits/${cancelled.visit_id}/check-in`, { photo: VALID_PNG });
  probe(
    cancelledIn.status === 409,
    'เช็คอินกะที่ยกเลิกแล้วได้',
    `${cancelledIn.status}/${brief(cancelledIn.body)}`,
    'กะ cancelled ถูกกัน 409',
  );

  // จำลองข้อมูลผิดปกติที่เวลาเช็คอินอยู่ในอนาคต แล้วให้ endpoint เช็คเอาท์เป็นด่านสุดท้าย
  const reverse = await newVisit(kase.case_id, FIELD_A.employee_id);
  await sql.run(
    `UPDATE case_visits
     SET checked_in_by = :emp, check_in_at = now() + interval '1 hour',
         check_in_photo_data = :photo, check_in_photo_mime = 'image/png', check_in_photo_size = :size
     WHERE visit_id = :id`,
    {
      id: reverse.visit_id,
      emp: FIELD_A.employee_id,
      photo: Buffer.from(VALID_PNG.split(',')[1], 'base64'),
      size: Buffer.from(VALID_PNG.split(',')[1], 'base64').length,
    },
  );
  const reverseOut = await post(`/api/my/visits/${reverse.visit_id}/check-out`, {});
  const reverseRow = await sql.one(
    `SELECT check_in_at, check_out_at,
            CASE WHEN check_out_at IS NULL THEN NULL
                 ELSE ROUND(EXTRACT(EPOCH FROM (check_out_at - check_in_at)) / 60)::int END AS minutes
     FROM case_visits WHERE visit_id = :id`,
    { id: reverse.visit_id },
  );
  probe(
    reverseOut.status >= 400 && reverseRow.check_out_at == null,
    'เช็คเอาท์ก่อนเวลาเช็คอินแล้วเกิดนาทีติดลบ',
    `${reverseOut.status}/${brief(reverseOut.body)}; db=${brief(reverseRow)}`,
    'เวลาเช็คอินที่อยู่หลังเวลาปัจจุบันถูกกัน ไม่สร้างเวลาออกหรือนาทีติดลบ',
  );

  const race = await newVisit(kase.case_id, FIELD_A.employee_id);
  const inRace = await Promise.all([
    post(`/api/my/visits/${race.visit_id}/check-in`, { photo: VALID_PNG }),
    post(`/api/my/visits/${race.visit_id}/check-in`, { photo: VALID_PNG }),
  ]);
  probe(
    inRace.filter((r) => r.status === 200).length === 1 && inRace.filter((r) => r.status === 409).length === 1,
    'กดเช็คอินพร้อมกันสองคำขอแล้วสำเร็จมากกว่าหนึ่งครั้ง',
    `HTTP=${inRace.map((r) => r.status).join(',')}`,
    `เช็คอินพร้อมกันได้ 200 หนึ่งคำขอและ 409 หนึ่งคำขอ (${inRace.map((r) => r.status).join(',')})`,
  );

  // ทำให้ระยะเวลามากพอสำหรับตรวจเลขนาที ไม่ขึ้นกับความเร็วของเครื่องที่รันชุดทดสอบ
  await sql.run(
    `UPDATE case_visits SET check_in_at = now() - interval '91 minutes' WHERE visit_id = :id`,
    { id: race.visit_id },
  );
  const outRace = await Promise.all([
    post(`/api/my/visits/${race.visit_id}/check-out`, {}),
    post(`/api/my/visits/${race.visit_id}/check-out`, {}),
  ]);
  const raceRow = await sql.one(
    `SELECT check_in_at, check_out_at,
            ROUND(EXTRACT(EPOCH FROM (check_out_at - check_in_at)) / 60)::int AS minutes
     FROM case_visits WHERE visit_id = :id`,
    { id: race.visit_id },
  );
  probe(
    outRace.filter((r) => r.status === 200).length === 1 &&
      outRace.filter((r) => r.status === 409).length === 1 && Number(raceRow.minutes) === 91,
    'กดเช็คเอาท์พร้อมกันแล้วปิดกะซ้ำหรือนาทีทำงานเพี้ยน',
    `HTTP=${outRace.map((r) => r.status).join(',')}; db=${brief(raceRow)}`,
    `เช็คเอาท์พร้อมกันสำเร็จครั้งเดียว และกะได้ ${raceRow.minutes} นาที`,
  );

  const directTotal = await sql.one(
    `SELECT COUNT(*)::int AS shifts,
            COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (check_out_at - check_in_at)) / 60)), 0)::int AS minutes
     FROM case_visits
     WHERE checked_in_by = :emp AND check_in_at IS NOT NULL AND check_out_at IS NOT NULL
       AND status <> 'cancelled'
       AND to_char(check_in_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') = :month`,
    { emp: FIELD_A.employee_id, month: clock.month },
  );
  const summary = await get(`/api/my/attendance/report?month=${clock.month}`);
  probe(
    summary.status === 200 && Number(summary.body.shifts) === Number(directTotal.shifts) &&
      Number(summary.body.minutes) === Number(directTotal.minutes),
    'นาที/จำนวนกะจากเช็คเอาท์ไหลเข้าสรุปค่าตอบแทนไม่ตรงกับเวลาจริง',
    `summary=${brief(summary.body)}; direct=${brief(directTotal)}`,
    `สรุปค่าตอบแทนนับ ${summary.body.shifts} กะ ${summary.body.minutes} นาที ตรงกับ timestamps`,
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('3 · รายงานการดูแล: ก่อนเช็คอิน ซ้ำ เจ้าของใบ ค่าวัด และเวลาอนาคต');
{
  const kase = await newCase(`${CASE_PREFIX}REPORT`, FIELD_A.employee_id);
  await addTeam(kase.case_id, FIELD_B.employee_id);
  const visitA = await newVisit(kase.case_id, FIELD_A.employee_id);
  const visitB = await newVisit(kase.case_id, FIELD_B.employee_id);

  const beforeCheckIn = await post(`/api/my/visits/${visitA.visit_id}/reports`, { report_type: 'routine', shift: 'day',  report_type: 'routine', shift: 'day', symptoms: 'บันทึกแม้ลืมเช็คอิน' });
  const beforeRow = beforeCheckIn.status === 201
    ? await sql.one('SELECT visit_id FROM case_reports WHERE report_id = :id', { id: beforeCheckIn.body.report_id })
    : null;
  probe(
    beforeCheckIn.status === 201 && Number(beforeRow?.visit_id) === Number(visitA.visit_id),
    'รายงานของกะที่ยังไม่เช็คอินบันทึกไม่ได้หรือผูกผิดกะ',
    `${beforeCheckIn.status}/${brief(beforeCheckIn.body)}; db=${brief(beforeRow)}`,
    'รายงานก่อนเช็คอินได้ตามกติกา และระบบผูก visit_id จาก path ให้เอง',
  );

  const duplicate1 = await post(`/api/my/visits/${visitA.visit_id}/reports`, { report_type: 'routine', shift: 'day',  report_type: 'routine', shift: 'day', symptoms: 'อาการรอบเช้า' });
  const duplicate2 = await post(`/api/my/visits/${visitA.visit_id}/reports`, { report_type: 'routine', shift: 'day',  report_type: 'routine', shift: 'day', symptoms: 'อาการรอบเย็น' });
  probe(
    duplicate1.status === 201 && duplicate2.status === 201 && duplicate1.body.report_id !== duplicate2.body.report_id,
    'กะเดียวบันทึกรายงานหลายรอบไม่ได้',
    `${duplicate1.status}/${duplicate2.status}; ids=${duplicate1.body?.report_id},${duplicate2.body?.report_id}`,
    'กะเดียวบันทึกซ้ำได้โดยตั้งใจ (เช้า/เย็น) และได้คนละ report_id',
  );

  const reportB = await post(`/api/my/visits/${visitB.visit_id}/reports`, { report_type: 'routine', shift: 'day',  report_type: 'routine', shift: 'day', symptoms: 'รายงานของบี' }, FIELD_B);
  assert.equal(reportB.status, 201, JSON.stringify(reportB.body));
  const stealEdit = await patch(
    `/api/my/cases/${kase.case_id}/reports/${reportB.body.report_id}`,
    { symptoms: 'เอพยายามแก้ของบี' },
    FIELD_A,
  );
  const reportBAfter = await sql.one('SELECT symptoms FROM case_reports WHERE report_id = :id', { id: reportB.body.report_id });
  probe(
    stealEdit.status === 404 && reportBAfter.symptoms === 'รายงานของบี',
    'พนักงานที่อยู่ในเคสแก้รายงานของคนอื่นได้',
    `${stealEdit.status}/${brief(stealEdit.body)}; db=${brief(reportBAfter)}`,
    'สมาชิกเคสอ่านใบของกันได้ แต่แก้ใบของคนอื่นถูกซ่อนเป็น 404',
  );

  const invalidVitals = await Promise.all([
    post(`/api/my/visits/${visitA.visit_id}/reports`, { report_type: 'routine', shift: 'day', bp_systolic: 0 }),
    post(`/api/my/visits/${visitA.visit_id}/reports`, { report_type: 'routine', shift: 'day', bp_systolic: 9999 }),
    post(`/api/my/visits/${visitA.visit_id}/reports`, { report_type: 'routine', shift: 'day', temperature_c: 0 }),
  ]);
  probe(
    invalidVitals.every((r) => r.status === 400),
    'รายงานรับค่าวัดผิดช่วง (ความดัน 0/9999 หรืออุณหภูมิ 0)',
    invalidVitals.map((r) => `${r.status}/${brief(r.body)}`).join(' · '),
    'ค่าวัดผิดช่วงทั้ง 3 แบบถูก schema กันเป็น 400',
  );

  const futureCreate = await post(`/api/my/visits/${visitA.visit_id}/reports`, { report_type: 'routine', shift: 'day', report_date: clock.tomorrow,
    report_time: '00:01',
    symptoms: 'เวลาวัดในอนาคต',
  });
  probe(
    futureCreate.status === 400,
    'สร้างรายงานโดยระบุเวลาที่วัดเป็นอนาคตได้',
    `${futureCreate.status}/${brief(futureCreate.body)}; future=${clock.tomorrow} 00:01`,
    'สร้างรายงานด้วยวัน–เวลาวัดในอนาคตถูกกัน 400',
  );

  const futureEdit = await patch(
    `/api/my/cases/${kase.case_id}/reports/${beforeCheckIn.body.report_id}`,
    { report_date: clock.tomorrow, report_time: '00:01' },
  );
  probe(
    futureEdit.status === 400,
    'แก้รายงานเดิมให้เวลาที่วัดเป็นอนาคตได้',
    `${futureEdit.status}/${brief(futureEdit.body)}; future=${clock.tomorrow} 00:01`,
    'แก้วัน–เวลาวัดให้เป็นอนาคตถูกกัน 400 เช่นเดียวกับตอนสร้าง',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('4 · รูปภาพ: ข้ามกะ ไฟล์ปลอม เกิน 5 MB และสิทธิ์ดึงรูป');
{
  const ownCase = await newCase(`${CASE_PREFIX}IMAGE-A`, FIELD_A.employee_id);
  const otherCase = await newCase(`${CASE_PREFIX}IMAGE-B`, FIELD_B.employee_id);
  const ownVisit = await newVisit(ownCase.case_id, FIELD_A.employee_id);
  const invalidVisit = await newVisit(ownCase.case_id, FIELD_A.employee_id);
  const largeVisit = await newVisit(ownCase.case_id, FIELD_A.employee_id);
  const otherVisit = await newVisit(otherCase.case_id, FIELD_B.employee_id);
  await seedCheckedVisit(otherVisit.visit_id, FIELD_B.employee_id);
  const otherReport = await seedReport(otherCase.case_id, otherVisit.visit_id, FIELD_B);

  const otherUpload = await post(`/api/my/visits/${otherVisit.visit_id}/check-in`, { photo: VALID_PNG }, FIELD_A);
  const otherWoundUpload = await post(
    `/api/my/visits/${otherVisit.visit_id}/reports`, { report_type: 'routine', shift: 'day', symptoms: 'แอบแนบรูป', wound_photo: VALID_PNG },
    FIELD_A,
  );
  probe(
    otherUpload.status === 404 && otherWoundUpload.status === 404,
    'อัปรูปเช็คอินหรือรูปแผลเข้ากะของคนอื่นได้',
    `check-in=${otherUpload.status}/${brief(otherUpload.body)}; report=${otherWoundUpload.status}/${brief(otherWoundUpload.body)}`,
    'รูปเช็คอินและรูปแผลของกะคนอื่นถูกกัน 404 ก่อนเขียนข้อมูล',
  );

  const fake = await post(`/api/my/visits/${invalidVisit.visit_id}/check-in`, { photo: NOT_AN_IMAGE });
  const fakeRow = await sql.one(
    'SELECT check_in_at, check_in_photo_data IS NOT NULL AS has_photo FROM case_visits WHERE visit_id = :id',
    { id: invalidVisit.visit_id },
  );
  probe(
    fake.status === 400 && fakeRow.check_in_at == null && fakeRow.has_photo === false,
    'data URL ที่ไม่ใช่รูปจริงผ่านเช็คอินได้',
    `${fake.status}/${brief(fake.body)}; db=${brief(fakeRow)}`,
    'ไฟล์ปลอม MIME เป็น PNG ถูก magic-byte check กัน 400 และไม่เขียนเวลา/รูป',
  );

  const oversizedBytes = Buffer.alloc(5 * 1024 * 1024 + 1);
  oversizedBytes.set([0x89, 0x50, 0x4e, 0x47]);
  const oversized = `data:image/png;base64,${oversizedBytes.toString('base64')}`;
  const tooLarge = await post(`/api/my/visits/${largeVisit.visit_id}/check-in`, { photo: oversized });
  const largeRow = await sql.one(
    'SELECT check_in_at, check_in_photo_data IS NOT NULL AS has_photo FROM case_visits WHERE visit_id = :id',
    { id: largeVisit.visit_id },
  );
  probe(
    tooLarge.status === 400 && largeRow.check_in_at == null && largeRow.has_photo === false,
    'รูปใหญ่เกิน 5 MB ผ่านเช็คอินหรือทิ้งข้อมูลค้างไว้',
    `${tooLarge.status}/${brief(tooLarge.body)}; db=${brief(largeRow)}`,
    'รูปเกิน 5 MB ถูกกัน 400 และไม่เขียนเวลา/รูปลงกะ',
  );

  const ownReport = await post(`/api/my/visits/${ownVisit.visit_id}/reports`, { report_type: 'routine', shift: 'day', symptoms: 'รายงานพร้อมรูปแผล',
    wound_photo: VALID_PNG,
  });
  assert.equal(ownReport.status, 201, JSON.stringify(ownReport.body));
  const [ownPhoto, stealReportPhoto, stealVisitPhoto] = await Promise.all([
    get(`/api/my/cases/${ownCase.case_id}/reports/${ownReport.body.report_id}/photo`, FIELD_A),
    get(`/api/my/cases/${otherCase.case_id}/reports/${otherReport.report_id}/photo`, FIELD_A),
    get(`/api/my/visits/${otherVisit.visit_id}/photo`, FIELD_A),
  ]);
  probe(
    ownPhoto.status === 200 && ownPhoto.contentType.startsWith('image/png') && ownPhoto.body.length > 0,
    'เจ้าของเคสดึงรูปแผลของตัวเองไม่ได้หรือ MIME ผิด',
    `${ownPhoto.status}/${ownPhoto.contentType}/${ownPhoto.body.length}`,
    'รูปแผลของเคสตัวเองดึงผ่าน endpoint จริงได้ พร้อม Content-Type image/png',
  );
  probe(
    stealReportPhoto.status === 404 && stealVisitPhoto.status === 404,
    'เดา URL แล้วดึงรูปแผลหรือรูปเช็คอินของเคสคนอื่นได้',
    `report=${stealReportPhoto.status}/${brief(stealReportPhoto.body)}; ` +
      `visit=${stealVisitPhoto.status}/${brief(stealVisitPhoto.body)}`,
    'รูปแผลและรูปเช็คอินของเคสคนอื่นถูกซ่อนเป็น 404',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('5 · แชทกับญาติ: คนนอกเคส ข้อความว่าง และข้อความเกิน');
{
  const kase = await newCase(`${CASE_PREFIX}CHAT`, FIELD_A.employee_id);
  await addTeam(kase.case_id, TEAM.employee_id);

  const initial = await post(
    `/api/my/cases/${kase.case_id}/family-messages`,
    { body: 'ข้อความพร้อมรูปของทีม', image: VALID_PNG },
    FIELD_A,
  );
  assert.equal(initial.status, 201, JSON.stringify(initial.body));

  const outsider = await Promise.all([
    get(`/api/my/cases/${kase.case_id}/family-messages`, FIELD_B),
    post(`/api/my/cases/${kase.case_id}/family-messages`, { body: 'คนนอกเคส' }, FIELD_B),
    get(`/api/my/cases/${kase.case_id}/family-messages/${initial.body.message_id}/photo`, FIELD_B),
  ]);
  probe(
    outsider.every((r) => r.status === 404),
    'พนักงานที่ไม่ได้อยู่ในเคสอ่าน/ส่งข้อความหรือเปิดรูปแชทได้',
    outsider.map((r) => `${r.status}/${brief(r.body)}`).join(' · '),
    'คนนอกเคสถูกกัน 404 ทั้งอ่าน ส่ง และเปิดรูปแชท',
  );

  const [teamRead, teamSend] = await Promise.all([
    get(`/api/my/cases/${kase.case_id}/family-messages`, TEAM),
    post(`/api/my/cases/${kase.case_id}/family-messages`, { body: 'สมาชิกทีมตอบญาติ' }, TEAM),
  ]);
  probe(
    teamRead.status === 200 && teamSend.status === 201,
    'สมาชิก case_team อ่านหรือตอบแชทญาติไม่ได้',
    `read=${teamRead.status}/${brief(teamRead.body)}; send=${teamSend.status}/${brief(teamSend.body)}`,
    'สมาชิก case_team อ่านและตอบไทม์ไลน์เดียวกับผู้รับผิดชอบหลักได้',
  );

  const empty = await post(`/api/my/cases/${kase.case_id}/family-messages`, { body: '   ' }, FIELD_A);
  probe(
    empty.status === 400,
    'ส่งข้อความว่างเข้าแชทญาติได้',
    `${empty.status}/${brief(empty.body)}`,
    'ข้อความว่างและไม่มีรูปถูกกัน 400',
  );

  const longText = 'ก'.repeat(1001);
  const tooLong = await post(`/api/my/cases/${kase.case_id}/family-messages`, { body: longText }, FIELD_A);
  const savedLong = tooLong.status === 201
    ? await sql.one('SELECT length(body)::int AS n FROM case_family_messages WHERE message_id = :id', { id: tooLong.body.message_id })
    : null;
  probe(
    tooLong.status === 400,
    'ข้อความแชทยาวเกิน 1,000 ตัวอักษรถูกตัดเงียบแล้วบันทึกแทนการแจ้งผู้ใช้',
    `${tooLong.status}/${brief(tooLong.body)}; stored_length=${savedLong?.n ?? '-'}`,
    'ข้อความยาวเกิน 1,000 ตัวอักษรถูกกัน 400',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('6 · สลิปค่าตอบแทน: ของตัวเองเท่านั้น + ไม่รั่วต้นทุน/กำไร');
{
  const caseA = await newCase(`${CASE_PREFIX}SLIP-A`, FIELD_A.employee_id, { staffPay: 1111, fee: 9000 });
  const caseB = await newCase(`${CASE_PREFIX}SLIP-B`, FIELD_B.employee_id, { staffPay: 9999, fee: 50000 });

  await sql.run(
    `INSERT INTO payroll_runs
       (run_id, period_month, round_no, period_to, status, pay_date, method, created_by, created_by_name, paid_by, paid_by_name)
     VALUES (:id, :month, 1, :today, 'paid', :today, 'โอน', :manager, 'ผู้จัดการ ทดสอบ', :manager, 'ผู้จัดการ ทดสอบ')`,
    { id: `${PAY_PREFIX}PAID`, month: clock.month, today: clock.today, manager: MANAGER.employee_id },
  );
  const itemA = await sql.one(
    `INSERT INTO payroll_items (run_id, employee_id, employee_name, shifts, minutes, total_pay)
     VALUES (:run, :emp, :name, 1, 60, 1111) RETURNING item_id`,
    { run: `${PAY_PREFIX}PAID`, emp: FIELD_A.employee_id, name: `${FIELD_A.first_name} ${FIELD_A.last_name}` },
  );
  const itemB = await sql.one(
    `INSERT INTO payroll_items (run_id, employee_id, employee_name, shifts, minutes, total_pay)
     VALUES (:run, :emp, :name, 9, 999, 9999) RETURNING item_id`,
    { run: `${PAY_PREFIX}PAID`, emp: FIELD_B.employee_id, name: `${FIELD_B.first_name} ${FIELD_B.last_name}` },
  );
  const payoutA = await sql.one(
    `INSERT INTO case_payouts (case_id, employee_id, employee_name, amount, shifts, minutes, released_by, released_by_name)
     VALUES (:case_id, :emp, :name, 1111, 1, 60, :manager, 'ผู้จัดการ ทดสอบ') RETURNING payout_id`,
    {
      case_id: caseA.case_id,
      emp: FIELD_A.employee_id,
      name: `${FIELD_A.first_name} ${FIELD_A.last_name}`,
      manager: MANAGER.employee_id,
    },
  );
  const payoutB = await sql.one(
    `INSERT INTO case_payouts (case_id, employee_id, employee_name, amount, shifts, minutes, released_by, released_by_name)
     VALUES (:case_id, :emp, :name, 9999, 9, 999, :manager, 'ผู้จัดการ ทดสอบ') RETURNING payout_id`,
    {
      case_id: caseB.case_id,
      emp: FIELD_B.employee_id,
      name: `${FIELD_B.first_name} ${FIELD_B.last_name}`,
      manager: MANAGER.employee_id,
    },
  );
  await sql.run(
    `INSERT INTO payroll_payout_lines (payout_id, item_id, amount)
     VALUES (:payout, :item, 1111)`,
    { payout: payoutA.payout_id, item: itemA.item_id },
  );
  await sql.run(
    `INSERT INTO payroll_payout_lines (payout_id, item_id, amount)
     VALUES (:payout, :item, 9999)`,
    { payout: payoutB.payout_id, item: itemB.item_id },
  );

  await sql.run(
    `INSERT INTO payroll_runs (run_id, period_month, round_no, period_to, status, created_by, created_by_name)
     VALUES (:id, :month, 2, :today, 'draft', :manager, 'ผู้จัดการ ทดสอบ')`,
    { id: `${PAY_PREFIX}DRAFT`, month: clock.month, today: clock.today, manager: MANAGER.employee_id },
  );
  await sql.run(
    `INSERT INTO payroll_items (run_id, employee_id, employee_name, shifts, minutes, total_pay)
     VALUES (:run, :emp, :name, 7, 777, 7777)`,
    { run: `${PAY_PREFIX}DRAFT`, emp: FIELD_A.employee_id, name: `${FIELD_A.first_name} ${FIELD_A.last_name}` },
  );

  const [slipsA, slipsB] = await Promise.all([
    get(`/api/my/payslips?employee_id=${FIELD_B.employee_id}`, FIELD_A),
    get(`/api/my/payslips?employee_id=${FIELD_A.employee_id}`, FIELD_B),
  ]);
  const aTotals = idsIn(slipsA.body, 'total_pay').map(Number);
  const bTotals = idsIn(slipsB.body, 'total_pay').map(Number);
  probe(
    slipsA.status === 200 && slipsB.status === 200 &&
      aTotals.length === 1 && aTotals[0] === 1111 &&
      bTotals.length === 1 && bTotals[0] === 9999 &&
      !JSON.stringify(slipsA.body).includes(PAY_PREFIX + 'DRAFT'),
    'พนักงานเห็นสลิปของคนอื่นหรือเห็นรอบ draft ที่ยังไม่จ่าย',
    `A=${brief(slipsA.body)}; B=${brief(slipsB.body)}`,
    'query employee_id เปลี่ยนเจ้าของสลิปไม่ได้ และแต่ละคนเห็นเฉพาะรอบ paid ของตัวเอง',
  );

  const slipForbidden = new Set([
    'fee', 'staff_pay', 'rate_staff_pay', 'rate_customer_price',
    'physio_staff_pay', 'physio_original_price', 'margin', 'profit', 'cost',
  ]);
  const leaks = forbiddenKeys(slipsA.body, slipForbidden);
  probe(
    leaks.length === 0,
    'สลิปพนักงานส่งราคาขาย ต้นทุน หรือกำไรของบริษัทออกมาด้วย',
    `fields=${leaks.join(', ')}; payload=${brief(slipsA.body)}`,
    'สลิปมีค่าตอบแทนของเจ้าตัวและที่มารายเคส แต่ไม่มีราคาขาย ต้นทุน หรือกำไร',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('7 · สถานะพนักงาน: suspended / resigned + ด่านรหัสชั่วคราว');
{
  const kase = await newCase(`${CASE_PREFIX}STATUS`, BLOCKED.employee_id);
  const visit = await newVisit(kase.case_id, BLOCKED.employee_id);
  await seedCheckedVisit(visit.visit_id, BLOCKED.employee_id, { done: false });
  const report = await seedReport(kase.case_id, visit.visit_id, BLOCKED);
  const message = await post(
    `/api/my/cases/${kase.case_id}/family-messages`,
    { body: 'ข้อความสำหรับทดสอบสถานะ', image: VALID_PNG },
    BLOCKED,
  );
  assert.equal(message.status, 201, JSON.stringify(message.body));

  const myRoutes = [
    ['GET', '/api/my/cases'],
    ['GET', `/api/my/cases/${kase.case_id}`],
    ['GET', '/api/my/today'],
    ['GET', `/api/my/calendar?year=${clock.today.slice(0, 4)}&month=${clock.today.slice(5, 7)}`],
    ['GET', `/api/my/attendance/report?month=${clock.month}`],
    ['GET', '/api/my/payslips'],
    ['GET', `/api/my/attendance?month=${clock.month}`],
    ['POST', `/api/my/visits/${visit.visit_id}/check-in`, { photo: VALID_PNG }],
    ['POST', `/api/my/visits/${visit.visit_id}/check-out`, {}],
    ['GET', `/api/my/cases/${kase.case_id}/reports`],
    ['PATCH', `/api/my/cases/${kase.case_id}/reports/${report.report_id}`, { symptoms: 'แก้' }],
    ['GET', `/api/my/cases/${kase.case_id}/reports/${report.report_id}/photo`],
    ['GET', `/api/my/visits/${visit.visit_id}/reports`],
    ['POST', `/api/my/visits/${visit.visit_id}/reports`, { report_type: 'routine', shift: 'day',  report_type: 'routine', shift: 'day', symptoms: 'เพิ่ม' }],
    ['GET', `/api/my/visits/${visit.visit_id}/photo`],
    ['GET', `/api/my/cases/${kase.case_id}/family-messages`],
    ['POST', `/api/my/cases/${kase.case_id}/family-messages`, { body: 'เพิ่ม' }],
    ['GET', `/api/my/cases/${kase.case_id}/family-messages/${message.body.message_id}/photo`],
  ];
  assert.equal(myRoutes.length, 18);

  for (const status of ['suspended', 'resigned']) {
    await sql.run('UPDATE employees SET status = :status WHERE employee_id = :id', {
      status,
      id: BLOCKED.employee_id,
    });
    const results = await Promise.all(
      myRoutes.map(([method, path, body]) => call(method, path, body, BLOCKED)),
    );
    const escaped = results
      .map((result, i) => ({ result, route: `${myRoutes[i][0]} ${myRoutes[i][1]}` }))
      .filter(({ result }) => result.status !== 401);
    probe(
      escaped.length === 0,
      `พนักงานสถานะ ${status} ยังเรียก /api/my บางเส้นได้`,
      escaped.map(({ route, result }) => `${route} -> ${result.status}/${brief(result.body)}`).join(' · '),
      `${status}: ถูก requireAuth กัน 401 ครบทั้ง 18 เส้นจริง`,
    );
  }

  const freshResults = await Promise.all(
    myRoutes.map(([method, path, body]) => call(method, path, body, FRESH)),
  );
  const freshEscaped = freshResults
    .map((result, i) => ({ result, route: `${myRoutes[i][0]} ${myRoutes[i][1]}` }))
    .filter(({ result }) => result.status !== 403);
  probe(
    freshEscaped.length === 0,
    'บัญชีที่ยังใช้รหัสผ่านชั่วคราวข้าม requirePasswordChanged เข้า /api/my ได้',
    freshEscaped.map(({ route, result }) => `${route} -> ${result.status}/${brief(result.body)}`).join(' · '),
    'must_change_password=true ถูกกัน 403 ครบทั้ง 18 เส้นก่อนแตะข้อมูล',
  );
}

await resetTopic();
await sql.run(
  `DELETE FROM employees WHERE employee_id IN (:b, :team, :blocked, :fresh)`,
  {
    b: FIELD_B.employee_id,
    team: TEAM.employee_id,
    blocked: BLOCKED.employee_id,
    fresh: FRESH.employee_id,
  },
);

console.log(
  `\n=== สรุป: 7 หัวข้อ · ${checks} จุดตรวจ · พบบัคที่พิสูจน์ได้ ${found.length} ข้อ · ผ่าน ${notes.length} จุด ===`,
);
found.forEach((item, i) => console.log(`FOUND ${i + 1} | ${item.title} | ${item.detail}`));

await new Promise((resolve) => server.close(resolve));
await pool.end();
