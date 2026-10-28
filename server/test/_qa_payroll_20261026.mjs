/**
 * QA รอบจ่ายค่าตอบแทน — PostgreSQL ชั่วคราว + Express จริง + HTTP จริง
 *   node test/_run_probe.mjs test/_qa_payroll_20261026.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', first_name: 'ผู้จัดการ', last_name: 'ทดสอบ', name: 'ผู้จัดการ ทดสอบ' };
const HR = { employee_id: 'EMP-0007', position: 'hr', name: 'HR ทดสอบ' };
const FIELD = { employee_id: 'EMP-0003', position: 'caregiver', name: 'พนักงาน ทดสอบ' };
const FINANCE = { employee_id: 'EMP-0091', position: 'finance', name: 'การเงิน ทดสอบ' };
const SUPER = { employee_id: 'EMP-0092', position: 'super_admin', name: 'Super Admin ทดสอบ' };
const ADMIN = { employee_id: 'EMP-0093', position: 'admin', name: 'Admin HC ทดสอบ' };

await seedFixtures(pool, hashPassword);
for (const who of [FINANCE, SUPER, ADMIN]) {
  await sql.run(
    `INSERT INTO employees
       (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
     VALUES (:id, :first, 'ทดสอบ', :position, :email, 'active', 'x', false)`,
    { id: who.employee_id, first: who.name, position: who.position, email: `${who.employee_id}@example.invalid` },
  );
}

const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, body, who = MANAGER) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...jar(who) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}
const get = (p, who) => call('GET', p, undefined, who);
const post = (p, b, who) => call('POST', p, b ?? {}, who);
const patch = (p, b, who) => call('PATCH', p, b ?? {}, who);
const put = (p, b, who) => call('PUT', p, b ?? {}, who);
const del = (p, who) => call('DELETE', p, undefined, who);

let vn = 810000000;
const nextVN = () => `VN${++vn}`;
const testCaseIds = new Set();
const found = [];
const notes = [];
const hit = (title, detail) => { found.push({ title, detail }); console.log(`\nBUG | ${title}\nRESULT | ${detail}`); };
const ok = (what) => { notes.push(what); console.log(`PASS | ${what}`); };
const head = (t) => console.log(`\n=== ${t} ===`);

const { today, month } = await sql.one(
  `SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today,
          to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM') AS month`,
);

async function newEmployee(first = 'พนักงานใหม่') {
  const r = await post('/api/employees', { first_name: first, last_name: 'ทดสอบ', position: 'caregiver' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function newCase({ staffPay = 1200, employeeId = FIELD.employee_id, label = 'Payroll QA' } = {}) {
  const r = await post('/api/cases', {
    case_id: nextVN(), case_type: 'other', client_name: label, fee: Math.max(2000, staffPay), staff_pay: staffPay,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const assigned = await post(`/api/cases/${r.body.case_id}/assign`, { employee_id: employeeId });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  testCaseIds.add(r.body.case_id);
  return r.body;
}

async function release(kase, amount, who = MANAGER, extra = {}) {
  const body = { request_id: randomUUID(), ...extra };
  if (amount !== undefined) body.amount = amount;
  return post(`/api/cases/${kase.case_id}/pay/release`, body, who);
}

async function preview(periodTo = today, who = MANAGER) {
  return get(`/api/payroll/preview?period_to=${periodTo}`, who);
}

const previewIds = (p) => p.body.rows.flatMap((r) => r.payout_ids).map(Number).sort((a, b) => a - b);

// -----------------------------------------------------------------------------
/* ระบบจำกัด 3 รอบต่อเดือน (payroll/routes.js) — เป็นกติกาจริง ไม่ใช่บัค
   แต่ชุดตรวจนี้เปิดรอบหลายครั้งในเดือนเดียว จึงล้างรอบทิ้งระหว่างหัวข้อ
   ให้แต่ละหัวข้อเริ่มจากศูนย์ — ทำบนฐานชั่วคราวเท่านั้น ไม่ใช่พฤติกรรมของระบบ */
async function resetRuns() {
  await sql.run('DELETE FROM payroll_payout_lines');
  await sql.run('DELETE FROM payroll_lines');
  await sql.run('DELETE FROM payroll_items');
  await sql.run('DELETE FROM payroll_runs');
  // แยกข้อมูลแต่ละหัวข้อจริง: เคสที่ probe สร้างอาจยังมี case_payouts ค้างอยู่
  // แล้วรอบใหม่จะกวาดเงินของหัวข้อก่อนหน้าเข้ามา ทำให้ total_pay/สถานะจ่ายเพี้ยน
  for (const caseId of testCaseIds) {
    await sql.run('DELETE FROM case_payouts WHERE case_id = :id', { id: caseId });
    await sql.run('DELETE FROM cases WHERE case_id = :id', { id: caseId });
  }
  testCaseIds.clear();
}

head('1 · สิทธิ์ครบทั้ง 14 เส้นของ payroll');
{
  const routes = [
    ['GET', '/api/payroll/meta'],
    ['GET', `/api/payroll/employee-cases?month=${month}&employee_id=${FIELD.employee_id}`],
    ['GET', '/api/payroll/case-queue'],
    ['GET', `/api/payroll/preview?period_to=${today}`],
    ['GET', '/api/payroll'],
    ['POST', '/api/payroll'],
    ['POST', '/api/payroll/pay-now'],
    ['GET', '/api/payroll/PAY-NOT-REAL'],
    ['GET', '/api/payroll/PAY-NOT-REAL/items/999/payouts'],
    ['POST', '/api/payroll/PAY-NOT-REAL/rebuild'],
    ['DELETE', '/api/payroll/PAY-NOT-REAL/items/999'],
    ['POST', '/api/payroll/PAY-NOT-REAL/pay'],
    ['POST', '/api/payroll/PAY-NOT-REAL/cancel'],
    ['DELETE', '/api/payroll/PAY-NOT-REAL'],
  ];
  for (const who of [HR, ADMIN, FIELD]) {
    const results = await Promise.all(routes.map(([method, path]) => call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {}, who)));
    const leaked = results.map((r, i) => ({ ...r, route: routes[i].join(' ') })).filter((r) => r.status !== 403);
    if (leaked.length) hit(`${who.position} เรียกเส้น payroll ที่ไม่มีสิทธิ์ได้`, leaked.map((r) => `${r.route} -> ${r.status}`).join(' · '));
    else ok(`${who.position}: ทั้ง 14 เส้นถูกกัน 403 ก่อนแตะข้อมูล`);
  }
  for (const who of [MANAGER, FINANCE, SUPER]) {
    const r = await get('/api/payroll/meta', who);
    if (r.status !== 200) hit(`${who.position} ที่มีสิทธิ์ money เข้า payroll ไม่ได้`, `GET /api/payroll/meta -> ${r.status}`);
    else ok(`${who.position}: เข้า payroll ได้ตาม POSITION_PERMISSIONS`);
  }
}

// -----------------------------------------------------------------------------
head('2 · สองหน้าจอปิดรอบเดียวกันพร้อมกัน');
await resetRuns();
{
  const kase = await newCase({ staffPay: 4321, label: 'กดปิดพร้อมกัน' });
  assert.equal((await release(kase, 4321)).status, 201);
  const draft = await post('/api/payroll', { period_to: today });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const [a, b] = await Promise.all([
    post(`/api/payroll/${draft.body.run_id}/pay`, { method: 'โอน' }),
    post(`/api/payroll/${draft.body.run_id}/pay`, { method: 'โอน' }),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  const row = await get(`/api/payroll/${draft.body.run_id}`);
  const linked = await sql.one(
    `SELECT count(*)::int AS n FROM payroll_payout_lines pl
     JOIN payroll_items i ON i.item_id = pl.item_id WHERE i.run_id = :id`,
    { id: draft.body.run_id },
  );
  if (statuses.join(',') !== '200,409' || row.body.status !== 'paid' || linked.n !== 1) {
    hit('สองหน้าจอปิดรอบพร้อมกันแล้วสถานะ/ก้อนเงินไม่เป็นเอกเทศ', `HTTP=${statuses.join(',')} status=${row.body.status} payout_lines=${linked.n}`);
  } else ok(`ปิดพร้อมกันได้ 200 หนึ่งครั้ง + 409 หนึ่งครั้ง; รอบ=${row.body.status}; ก้อนเงิน=${linked.n}`);
}

// -----------------------------------------------------------------------------
head('3 · สองหน้าจอกดจ่ายเลยจากพรีวิวเดียวกัน');
await resetRuns();
{
  const kase = await newCase({ staffPay: 777.77, label: 'pay-now พร้อมกัน' });
  assert.equal((await release(kase, 777.77)).status, 201);
  const seen = await preview();
  const ids = previewIds(seen);
  assert.ok(ids.length > 0);
  const before = Number((await sql.one(`SELECT count(*) AS n FROM payroll_runs WHERE status='paid'`)).n);
  const [a, b] = await Promise.all([
    post('/api/payroll/pay-now', { period_to: today, payout_ids: ids }),
    post('/api/payroll/pay-now', { period_to: today, payout_ids: ids }),
  ]);
  const after = Number((await sql.one(`SELECT count(*) AS n FROM payroll_runs WHERE status='paid'`)).n);
  const successes = [a, b].filter((r) => r.status === 201).length;
  if (successes !== 1 || after - before !== 1) {
    hit('สองหน้าจอกดจ่ายเลยจากพรีวิวเดียวกันแล้วเงินออกมากกว่าหนึ่งรอบ', `HTTP=${a.status},${b.status}; paid_runs เพิ่ม ${after - before}`);
  } else ok(`pay-now พร้อมกัน: สำเร็จ 1 คำขอ; อีกคำขอ=${[a, b].find((r) => r.status !== 201).status}; paid_runs เพิ่ม 1`);
}

// -----------------------------------------------------------------------------
head('4 · ยอดที่ปล่อยหลังปิดรอบ / พนักงานเข้าใหม่กลางรอบ');
await resetRuns();
{
  const first = await newCase({ staffPay: 500, label: 'ฐานก่อนเปิดรอบ' });
  assert.equal((await release(first, 500)).status, 201);
  const draft = await post('/api/payroll', { period_to: today });
  assert.equal(draft.status, 201);

  const newcomer = await newEmployee('เข้าใหม่กลางรอบ');
  // บัญชีที่เพิ่งสร้างต้องเปลี่ยนรหัสผ่านก่อนใช้จริง ด่านนี้ไม่ใช่สิ่งที่หัวข้อนี้ทดสอบ
  // ปลดเฉพาะฐานชั่วคราว เพื่อให้ request ไปถึง /api/my/payslips และวัดสลิปได้ตรงประเด็น
  await sql.run(
    'UPDATE employees SET must_change_password = false WHERE employee_id = :id',
    { id: newcomer.employee_id },
  );
  const late = await newCase({ staffPay: 650, employeeId: newcomer.employee_id, label: 'ยอดหลังเปิดรอบ' });
  const lateRelease = await release(late, 650);
  assert.equal(lateRelease.status, 201, JSON.stringify(lateRelease.body));

  const paid = await post(`/api/payroll/${draft.body.run_id}/pay`, {});
  assert.equal(paid.status, 200);
  const next = await preview();
  const latePayout = await sql.one('SELECT payout_id FROM case_payouts WHERE case_id = :id', { id: late.case_id });
  if (!previewIds(next).includes(Number(latePayout.payout_id))) {
    hit('ยอดที่ปล่อยหลังเปิดรอบหาย ไม่เข้ารอบเดิมและไม่โผล่รอบถัดไป', `payout_id=${latePayout.payout_id}; next_preview=${previewIds(next).join(',')}`);
  } else ok(`ยอดหลังเปิดรอบ payout_id=${latePayout.payout_id} ไม่ถูกยัดเข้ารอบเก่า และโผล่พรีวิวรอบถัดไป`);

  const nextPaid = await post('/api/payroll/pay-now', { period_to: today, payout_ids: previewIds(next) });
  assert.equal(nextPaid.status, 201, JSON.stringify(nextPaid.body));
  const slip = await get('/api/my/payslips', { employee_id: newcomer.employee_id, position: 'caregiver', name: 'เข้าใหม่กลางรอบ ทดสอบ' });
  if (slip.status !== 200 || !slip.body.some((s) => s.run_id === nextPaid.body.run_id && Number(s.total_pay) === 650)) {
    hit('พนักงานเข้าใหม่กลางรอบไม่ได้สลิปในรอบถัดไป', `GET /api/my/payslips -> ${slip.status} ${JSON.stringify(slip.body)}`);
  } else ok('พนักงานเข้าใหม่กลางรอบได้รับ 650 บาทในสลิปรอบถัดไป');
}

// -----------------------------------------------------------------------------
head('5 · ลาออกกลางรอบแต่เงินที่ทำไว้ต้องไม่หาย');
await resetRuns();
{
  const employee = await newEmployee('ลาออกกลางรอบ');
  const kase = await newCase({ staffPay: 888, employeeId: employee.employee_id, label: 'เงินคนลาออก' });
  assert.equal((await release(kase, 888)).status, 201);
  const resigned = await del(`/api/employees/${employee.employee_id}`);
  assert.equal(resigned.status, 200, JSON.stringify(resigned.body));
  const p = await preview();
  const payout = await sql.one('SELECT payout_id FROM case_payouts WHERE case_id = :id', { id: kase.case_id });
  if (!previewIds(p).includes(Number(payout.payout_id))) {
    hit('บันทึกพนักงานลาออกแล้วค่าจ้างที่ปล่อยไว้หายจากรอบจ่าย', `payout_id=${payout.payout_id}; preview=${previewIds(p).join(',')}`);
  } else ok(`พนักงานลาออกแล้ว payout_id=${payout.payout_id} ยังอยู่ในรอบจ่าย`);
  const paid = await post('/api/payroll/pay-now', { period_to: today, payout_ids: previewIds(p) });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
}

// -----------------------------------------------------------------------------
head('6 · ยอดติดลบ เกินคงเหลือ และสตางค์');
await resetRuns();
{
  const kase = await newCase({ staffPay: 100.01, label: 'ขอบเขตยอดเงิน' });
  const negative = await release(kase, -1);
  const zero = await release(kase, 0);
  const over = await release(kase, 100.02);
  const first = await release(kase, 33.335);
  const status1 = await get(`/api/cases/${kase.case_id}/pay`);
  const second = await release(kase, 66.67);
  const status2 = await get(`/api/cases/${kase.case_id}/pay`);
  const sums = await sql.one('SELECT COALESCE(SUM(amount),0)::float AS n FROM case_payouts WHERE case_id=:id', { id: kase.case_id });
  if (negative.status < 400 || zero.status < 400 || over.status < 400) {
    hit('ปล่อยยอดติดลบ/ศูนย์/เกินยอดคงเหลือได้', `negative=${negative.status} zero=${zero.status} over=${over.status}`);
  } else ok(`ยอดผิดถูกกัน: ติดลบ=${negative.status}, ศูนย์=${zero.status}, เกินยอด=${over.status}`);
  if (first.status !== 201 || Number(status1.body.released) !== 33.34 || second.status !== 201 || Number(sums.n) !== 100.01 || Number(status2.body.remaining) !== 0) {
    hit('ปัดสตางค์แล้วผลรวมค่าจ้างไม่ลงยอดเหมา', `first=${first.status}/${status1.body.released}; second=${second.status}; sum=${sums.n}; remaining=${status2.body.remaining}`);
  } else ok('33.335 ปัดเป็น 33.34; ปล่อยยอดคงเหลือ 66.67; รวมตรง 100.01 บาท');
}

// -----------------------------------------------------------------------------
head('7 · ถอนก้อนหลังเปิดรอบ และหลังจ่ายแล้ว');
await resetRuns();
{
  const kase = await newCase({ staffPay: 901, label: 'ถอนค่าจ้าง' });
  assert.equal((await release(kase, 901)).status, 201);
  const payout = await sql.one('SELECT payout_id FROM case_payouts WHERE case_id=:id', { id: kase.case_id });
  const draft = await post('/api/payroll', { period_to: today });
  assert.equal(draft.status, 201);
  const withdrawn = await del(`/api/cases/${kase.case_id}/pay/${payout.payout_id}`);
  const afterWithdraw = await get(`/api/payroll/${draft.body.run_id}`);
  if (withdrawn.status !== 200 || Number(afterWithdraw.body.total_pay) !== 0) {
    hit('ถอนก้อนในรอบร่างแล้วรอบยังคงยอดเดิม', `DELETE=${withdrawn.status}; draft_total=${afterWithdraw.body.total_pay}`);
  } else ok('ถอนก้อนจากรอบร่างแล้ว total_pay ของรอบลดเป็น 0');
  assert.equal((await post(`/api/payroll/${draft.body.run_id}/pay`, {})).status, 409);
  assert.equal((await post(`/api/payroll/${draft.body.run_id}/cancel`, {})).status, 200);

  assert.equal((await release(kase, 901)).status, 201);
  const latest = await sql.one('SELECT payout_id FROM case_payouts WHERE case_id=:id ORDER BY payout_id DESC LIMIT 1', { id: kase.case_id });
  const p = await preview();
  const paid = await post('/api/payroll/pay-now', { period_to: today, payout_ids: previewIds(p) });
  assert.equal(paid.status, 201);
  const refused = await del(`/api/cases/${kase.case_id}/pay/${latest.payout_id}`);
  if (refused.status !== 409) hit('ถอนก้อนค่าจ้างหลังเงินออกแล้วได้', `DELETE payout ${latest.payout_id} -> ${refused.status}`);
  else ok(`ถอน payout_id=${latest.payout_id} หลังปิดจ่ายถูกกัน 409`);
}

// -----------------------------------------------------------------------------
head('8 · เขตวันไทยตรงขอบสิ้นเดือน');
await resetRuns();
{
  const sep = await newCase({ staffPay: 111, label: '30 ก.ย. 23:59:59' });
  const oct = await newCase({ staffPay: 222, label: '1 ต.ค. 00:00:00' });
  assert.equal((await release(sep, 111)).status, 201);
  assert.equal((await release(oct, 222)).status, 201);
  const sepRow = await sql.one('SELECT payout_id FROM case_payouts WHERE case_id=:id', { id: sep.case_id });
  const octRow = await sql.one('SELECT payout_id FROM case_payouts WHERE case_id=:id', { id: oct.case_id });
  await sql.run(`UPDATE case_payouts SET released_at='2026-09-30 23:59:59' WHERE payout_id=:id`, { id: sepRow.payout_id });
  await sql.run(`UPDATE case_payouts SET released_at='2026-10-01 00:00:00' WHERE payout_id=:id`, { id: octRow.payout_id });
  const p = await preview('2026-09-30');
  const ids = previewIds(p);
  if (!ids.includes(Number(sepRow.payout_id)) || ids.includes(Number(octRow.payout_id))) {
    hit('รอบสิ้นเดือนแบ่งเขตวันไทยผิด', `preview 2026-09-30 = ${ids.join(',')}; sep=${sepRow.payout_id}; oct=${octRow.payout_id}`);
  } else ok(`พรีวิว 2026-09-30 รับ 23:59:59 และไม่รับ 2026-10-01 00:00:00 ตามวันไทย`);
}

// -----------------------------------------------------------------------------
head('9 · วันที่จ่ายจริงในอนาคต/ปี พ.ศ.');
await resetRuns();
{
  // pay_date ใช้ schema เดียวกัน แต่มีสองเส้นทาง: จ่ายเลย และเปิดร่างแล้วปิดจ่าย
  // ต้องยิงทั้งคู่ ไม่ให้แก้ด่านหนึ่งแล้วอีกด่านยังรับวันที่ผิดอยู่
  async function exercisePayDate(payDate, mode, amount, label) {
    await resetRuns();
    const kase = await newCase({ staffPay: amount, label });
    assert.equal((await release(kase, amount)).status, 201);

    if (mode === 'pay-now') {
      const p = await preview(today);
      return post('/api/payroll/pay-now', {
        period_to: today,
        pay_date: payDate,
        method: 'โอน',
        payout_ids: previewIds(p),
      });
    }

    const draft = await post('/api/payroll', { period_to: today });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    return post(`/api/payroll/${draft.body.run_id}/pay`, { pay_date: payDate, method: 'โอน' });
  }

  const futureNow = await exercisePayDate('2099-12-31', 'pay-now', 2468, 'อนาคตผ่าน pay-now');
  const futureDraft = await exercisePayDate('2099-12-31', 'draft', 2469, 'อนาคตผ่านรอบร่าง');
  if (futureNow.status === 201 || futureDraft.status === 200) {
    hit(
      'บันทึกรอบว่าโอนเงินแล้วด้วยวันที่อนาคตได้',
      `pay-now=${futureNow.status}/${JSON.stringify(futureNow.body)}; draft-pay=${futureDraft.status}/${JSON.stringify(futureDraft.body)}`,
    );
  } else {
    ok(`วันที่จ่ายอนาคตถูกกันทั้ง pay-now=${futureNow.status} และ draft-pay=${futureDraft.status}`);
  }

  const buddhistNow = await exercisePayDate('2569-10-26', 'pay-now', 1357, 'ปี พ.ศ. ผ่าน pay-now');
  const buddhistDraft = await exercisePayDate('2569-10-26', 'draft', 1358, 'ปี พ.ศ. ผ่านรอบร่าง');
  if (buddhistNow.status === 201 || buddhistDraft.status === 200) {
    hit(
      'กรอกปี พ.ศ. ลงช่องวันที่จ่ายแล้วระบบรับเป็นปี ค.ศ. 2569',
      `pay-now=${buddhistNow.status}/${JSON.stringify(buddhistNow.body)}; draft-pay=${buddhistDraft.status}/${JSON.stringify(buddhistDraft.body)}`,
    );
  } else {
    ok(`ปี 2569 ใน pay_date ถูกกันทั้ง pay-now=${buddhistNow.status} และ draft-pay=${buddhistDraft.status}`);
  }
}

// -----------------------------------------------------------------------------
head('10 · เปิดรอบซ้ำสองหน้าจอ');
await resetRuns();
{
  const kase = await newCase({ staffPay: 314.15, label: 'เปิดรอบพร้อมกัน' });
  assert.equal((await release(kase, 314.15)).status, 201);
  const [a, b] = await Promise.all([
    post('/api/payroll', { period_to: today }),
    post('/api/payroll', { period_to: today }),
  ]);
  const runs = [a, b].filter((r) => r.status === 201);
  const totals = runs.map((r) => Number(r.body.total_pay)).sort((x, y) => x - y);
  const payout = await sql.one('SELECT payout_id FROM case_payouts WHERE case_id=:id', { id: kase.case_id });
  const links = await sql.one('SELECT count(*)::int AS n FROM payroll_payout_lines WHERE payout_id=:id', { id: payout.payout_id });
  if (links.n !== 1 || totals.filter((n) => n === 314.15).length !== 1) {
    hit('เปิดรอบพร้อมกันแล้วก้อนเงินเดียวเข้าเกินหนึ่งรอบ', `HTTP=${a.status},${b.status}; totals=${totals.join(',')}; payout_links=${links.n}`);
  } else ok(`เปิดรอบพร้อมกัน: ก้อน 314.15 บาทผูกเพียงรอบเดียว; อีกรอบยอด 0; payout_links=${links.n}`);
  for (const r of runs) {
    if (r.body.status === 'draft') await post(`/api/payroll/${r.body.run_id}/cancel`, {});
  }
}

console.log(`\n=== สรุป: พบบัคที่พิสูจน์ได้ ${found.length} ข้อ · ยิงแล้วกันได้ ${notes.length} จุด ===`);
found.forEach((f, i) => console.log(`FOUND ${i + 1} | ${f.title} | ${f.detail}`));

await new Promise((r) => server.close(r));
await pool.end();
