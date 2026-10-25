/**
 * QA ตารางงาน/กะ — PostgreSQL ชั่วคราว + Express จริง + HTTP จริง
 *   node test/_run_probe.mjs test/_qa_visits_20261026.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', name: 'ผู้จัดการ ทดสอบ' };
const FIELD = { employee_id: 'EMP-0003', position: 'caregiver', name: 'พนักงาน ทดสอบ' };
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';

await seedFixtures(pool, hashPassword);

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => ({ cookie: `${COOKIE_NAME}=${signToken(who)}` });
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

let vn = 820000000;
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

async function newCase(label) {
  const created = await post('/api/cases', {
    case_id: `VN${++vn}`,
    case_type: 'other',
    client_name: label,
    fee: 2000,
    staff_pay: 1200,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assigned = await post(`/api/cases/${created.body.case_id}/assign`, { employee_id: FIELD.employee_id });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  return created.body;
}

const visitRow = (visitId) => sql.one(
  `SELECT visit_id, case_id, visit_date, assigned_to, planned_start, planned_end,
          check_in_at, check_out_at, status
   FROM case_visits WHERE visit_id = :id`,
  { id: visitId },
);

head('1 · คนเดียวลงกะซ้อนเวลา — ต้องเตือนทั้งก่อนและหลังบันทึก');
{
  const firstCase = await newCase('กะหลัก 08:00–12:00');
  const secondCase = await newCase('กะซ้อน 10:00–14:00');
  const date = '2027-02-10';

  const first = await post(`/api/cases/${firstCase.case_id}/visits/bulk`, {
    dates: [date], assigned_to: FIELD.employee_id, planned_start: '08:00', planned_end: '12:00',
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.added, 1);

  const preview = await post(`/api/cases/${secondCase.case_id}/visits/preview`, {
    dates: [date], assigned_to: FIELD.employee_id, planned_start: '10:00', planned_end: '14:00',
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const previewWarned = preview.body.conflicts?.some((c) => c.other_case_id === firstCase.case_id);

  const created = await post(`/api/cases/${secondCase.case_id}/visits/bulk`, {
    dates: [date], assigned_to: FIELD.employee_id, planned_start: '10:00', planned_end: '14:00',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const saveWarned = created.body.conflicts?.some((c) => c.other_case_id === firstCase.case_id);

  if (!previewWarned || !saveWarned) {
    hit(
      'กะของคนเดียวกันซ้อนเวลาแล้วไม่มีคำเตือนครบสองด่าน',
      `preview_conflicts=${JSON.stringify(preview.body.conflicts)}; save_conflicts=${JSON.stringify(created.body.conflicts)}`,
    );
  } else {
    ok('กะ 08:00–12:00 ชน 10:00–14:00: พรีวิวเตือน และผลบันทึกคืน conflict ของเคสเดิม');
  }
}

head('2 · ลบกะที่เช็คอินแล้ว — ทั้งลบทีละใบและลบเป็นช่วงต้องเก็บหลักฐานไว้');
{
  const kase = await newCase('กะที่เช็คอินแล้ว');
  const { today } = await sql.one(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS today`,
  );
  const scheduled = await post(`/api/cases/${kase.case_id}/visits/bulk`, {
    dates: [today], assigned_to: FIELD.employee_id,
  });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  const visit = scheduled.body.visits.find((v) => v.visit_date === today);
  assert.ok(visit, JSON.stringify(scheduled.body));

  const checkedIn = await post(`/api/my/visits/${visit.visit_id}/check-in`, { photo: PHOTO }, FIELD);
  assert.equal(checkedIn.status, 200, JSON.stringify(checkedIn.body));

  const one = await del(`/api/cases/${kase.case_id}/visits/${visit.visit_id}`);
  const range = await del(`/api/cases/${kase.case_id}/visits?dates=${today}`);
  const remains = await visitRow(visit.visit_id);

  if (one.status !== 409 || range.status !== 200 || range.body.deleted !== 0 || range.body.kept !== 1 || !remains?.check_in_at) {
    hit(
      'กะที่เช็คอินแล้วถูกลบหรือผลการกันลบไม่ตรง',
      `single=${one.status}; range=${range.status}/${JSON.stringify(range.body)}; remains=${JSON.stringify(remains)}`,
    );
  } else {
    ok('ลบทีละใบถูกกัน 409; ลบตามวันรายงาน deleted=0/kept=1; แถวและเวลาเช็คอินยังอยู่');
  }
}

head('3 · ใช้ visit_id ผ่านอีกเคสเพื่อย้าย/ลบกะไม่ได้');
{
  const owner = await newCase('เจ้าของกะจริง');
  const other = await newCase('เคสอื่นที่ห้ามรับกะ');
  const originalDate = '2027-02-20';
  const movedDate = '2027-02-21';
  const scheduled = await post(`/api/cases/${owner.case_id}/visits/bulk`, {
    dates: [originalDate], assigned_to: FIELD.employee_id, planned_start: '09:00', planned_end: '12:00',
  });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  const visit = scheduled.body.visits.find((v) => v.visit_date === originalDate);
  assert.ok(visit, JSON.stringify(scheduled.body));

  const wrongPatch = await patch(`/api/cases/${other.case_id}/visits/${visit.visit_id}`, { visit_date: movedDate });
  const wrongDelete = await del(`/api/cases/${other.case_id}/visits/${visit.visit_id}`);
  const stored = await visitRow(visit.visit_id);
  const otherVisits = await get(`/api/cases/${other.case_id}/visits`);

  if (
    wrongPatch.status !== 404 ||
    wrongDelete.status !== 404 ||
    stored?.case_id !== owner.case_id ||
    stored?.visit_date !== originalDate ||
    otherVisits.status !== 200 ||
    otherVisits.body.some((v) => v.visit_id === visit.visit_id)
  ) {
    hit(
      'อ้าง visit_id ผ่านรหัสเคสอื่นแล้วย้ายหรือลบกะข้ามเคสได้',
      `PATCH=${wrongPatch.status}; DELETE=${wrongDelete.status}; stored=${JSON.stringify(stored)}; other=${JSON.stringify(otherVisits.body)}`,
    );
  } else {
    ok('PATCH/DELETE visit_id ผ่านเคสอื่นถูกกัน 404 และกะยังอยู่กับเคสเดิมวันเดิม');
  }
}

head('4 · กะข้ามเดือน — สร้าง/ลบช่วงไม่ตกวัน และเวรดึกชนเช้าวันถัดไป');
{
  const rangeCase = await newCase('ช่วงข้ามเดือน');
  const range = await post(`/api/cases/${rangeCase.case_id}/visits/bulk`, {
    from: '2027-03-30',
    to: '2027-04-02',
    assigned_to: FIELD.employee_id,
    planned_start: '09:00',
    planned_end: '12:00',
  });
  assert.equal(range.status, 201, JSON.stringify(range.body));
  const before = range.body.visits.map((v) => v.visit_date);
  const expected = ['2027-03-30', '2027-03-31', '2027-04-01', '2027-04-02'];

  const removedMarch = await del(
    `/api/cases/${rangeCase.case_id}/visits?from=2027-03-30&to=2027-03-31`,
  );
  const remaining = await get(`/api/cases/${rangeCase.case_id}/visits`);
  const after = remaining.body.map((v) => v.visit_date);

  const nightCase = await newCase('เวรดึกคืนสิ้นเดือน');
  const morningCase = await newCase('เวรเช้าวันต้นเดือน');
  const night = await post(`/api/cases/${nightCase.case_id}/visits/bulk`, {
    dates: ['2027-03-31'], assigned_to: FIELD.employee_id, planned_start: '20:00', planned_end: '08:00',
  });
  assert.equal(night.status, 201, JSON.stringify(night.body));
  const morning = await post(`/api/cases/${morningCase.case_id}/visits/preview`, {
    dates: ['2027-04-01'], assigned_to: FIELD.employee_id, planned_start: '07:00', planned_end: '10:00',
  });
  assert.equal(morning.status, 200, JSON.stringify(morning.body));
  const crossesMonth = morning.body.conflicts?.some(
    (c) => c.other_case_id === nightCase.case_id && c.other_date === '2027-03-31',
  );

  if (
    JSON.stringify(before) !== JSON.stringify(expected) ||
    removedMarch.status !== 200 ||
    removedMarch.body.deleted !== 2 ||
    JSON.stringify(after) !== JSON.stringify(['2027-04-01', '2027-04-02']) ||
    !crossesMonth
  ) {
    hit(
      'จัดช่วงหรือเทียบกะตรงขอบเดือนไม่ครบ',
      `before=${JSON.stringify(before)}; delete=${removedMarch.status}/${JSON.stringify(removedMarch.body)}; after=${JSON.stringify(after)}; conflicts=${JSON.stringify(morning.body.conflicts)}`,
    );
  } else {
    ok('สร้าง 30 มี.ค.–2 เม.ย. ครบ 4 วัน; ลบเฉพาะมีนาคมเหลือ 1–2 เม.ย.; เวร 20:00–08:00 เตือนชนกะ 07:00 ต้นเดือน');
  }
}

console.log(`\n=== สรุป: พบบัคที่พิสูจน์ได้ ${found.length} ข้อ · ยิงแล้วกันได้ ${notes.length} จุด ===`);
found.forEach((item, i) => console.log(`FOUND ${i + 1} | ${item.title} | ${item.detail}`));

await new Promise((resolve) => server.close(resolve));
await pool.end();
