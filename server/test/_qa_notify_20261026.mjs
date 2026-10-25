// QA รอบ 17: สิ่งที่ระบบทำเองโดยไม่มีคนดู
// สรุปรายวันอัตโนมัติ · กระดิ่งแจ้งเตือน · ตัวเลขหน้าภาพรวม
// รัน: node test/_run_probe.mjs test/_qa_notify_20261026.mjs
// ใช้ PostgreSQL ชั่วคราว + Express จริง + HTTP จริง
// ชุดนี้ไม่แก้ source ไม่ต่อฐานจริง และบังคับปิด SMTP ก่อนโหลดแอปเพื่อไม่ส่งอีเมลจริง
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

// _run_probe ส่ง env ของ shell เข้ามาด้วย จึงต้องปิด SMTP ก่อน import app/mailer เสมอ
// ไม่เช่นนั้นเครื่องที่มี SMTP พร้อมอยู่แล้วจะส่งสรุปทดสอบออกจริง
for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
  delete process.env[key];
}
const CRON_SECRET = 'qa-notify-cron-secret-20261026';
process.env.CRON_SECRET = CRON_SECRET;

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { todayTh } = await import('../src/lib/dates.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');
const notifyRepo = await import('../src/notify/repo.js');
const caseRepo = await import('../src/cases/repo.js');
const invoiceRepo = await import('../src/invoices/repo.js');
const payrollRepo = await import('../src/payroll/repo.js');
const { ALERT_KEYS } = await import('../src/notify/alerts.js');

const MANAGER = {
  employee_id: 'EMP-0001', position: 'manager',
  first_name: 'Test', last_name: 'Employee',
};
const HR = {
  employee_id: 'EMP-0007', position: 'hr',
  first_name: 'Test', last_name: 'Employee',
};
const FIELD = {
  employee_id: 'EMP-0003', position: 'caregiver',
  first_name: 'Test', last_name: 'Employee',
};
const ADMIN = {
  employee_id: 'EMP-9171', position: 'admin',
  first_name: 'แอดมิน', last_name: 'ทดสอบ',
};
const FINANCE = {
  employee_id: 'EMP-9172', position: 'finance',
  first_name: 'การเงิน', last_name: 'ทดสอบ',
};
const FIELD_B = {
  employee_id: 'EMP-9173', position: 'caregiver',
  first_name: 'พนักงานบี', last_name: 'ทดสอบ',
};

await seedFixtures(pool, hashPassword);
for (const who of [ADMIN, FINANCE, FIELD_B]) {
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
// ย้ำบทเรียนจากรอบก่อน: actor ทุกคนต้องพ้นด่านรหัสชั่วคราวก่อนจึงทดสอบ route อื่นได้
await sql.run(
  `UPDATE employees SET status = 'active', must_change_password = false
   WHERE employee_id IN (:manager, :hr, :field, :admin, :finance, :field_b)`,
  {
    manager: MANAGER.employee_id,
    hr: HR.employee_id,
    field: FIELD.employee_id,
    admin: ADMIN.employee_id,
    finance: FINANCE.employee_id,
    field_b: FIELD_B.employee_id,
  },
);

const clock = await sql.one(
  `SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS today,
          to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day', 'YYYY-MM-DD') AS yesterday,
          to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '1 day', 'YYYY-MM-DD') AS tomorrow,
          to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '8 days', 'YYYY-MM-DD') AS old_day,
          to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month,
          to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY') AS year,
          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_today`,
);

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, { body, who, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...jar(who),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}
const get = (path, who, headers) => call('GET', path, { who, headers });
const post = (path, body, who, headers) => call('POST', path, { body: body ?? {}, who, headers });

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
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
};
const probe = (condition, bugTitle, detail, passText) => {
  checks += 1;
  if (condition) ok(passText);
  else hit(bugTitle, detail);
};

// mailer ในโหมดนี้ไม่ส่งออกนอกเครื่อง แต่พิมพ์ payload ลง console หนึ่งครั้งต่อการเรียก
// นับบรรทัดนี้เพื่อพิสูจน์ว่า cron ซ้ำเรียกตัวส่งกี่ครั้ง โดยไม่ต้องส่งเมลจริง
let fakeDigestCalls = 0;
const originalConsoleLog = console.log;
console.log = (...args) => {
  if (String(args[0] ?? '').includes('📧 [DEV] [KIN] สรุปของค้าง')) fakeDigestCalls += 1;
  originalConsoleLog(...args);
};

const CASE_PREFIX = 'QA-NOTIFY-';
const INVOICE_PREFIX = 'QA-NOTIFY-IV-';
const PAY_PREFIX = 'QA-NOTIFY-PAY-';
let invoiceNo = 0;

async function resetTopic() {
  // ล้างข้อมูลของหัวข้อก่อนหน้าให้หมด แต่เก็บบัญชี actor ที่ใช้ยิงสิทธิ์ไว้
  await sql.run('DELETE FROM payroll_runs');
  await sql.run('DELETE FROM invoices');
  await sql.run('DELETE FROM cases');
}

async function newCase(id, {
  status = 'assigned',
  assignedTo = FIELD.employee_id,
  clientName = `ผู้รับบริการ ${id}`,
  startDate = null,
  endDate = null,
  fee = null,
  staffPay = null,
  closedAt = null,
  cancelledAt = null,
  createdAt = `${clock.today} 09:00:00`,
} = {}) {
  const assignee = status === 'unassigned' ? null : assignedTo;
  return sql.one(
    `INSERT INTO cases
       (case_id, title, case_type, client_name, status, assigned_to,
        start_date, end_date, fee, staff_pay, closed_at, cancelled_at, created_at)
     VALUES
       (:id, :title, 'elderly_care', :client_name, :status, :assigned_to,
        :start_date, :end_date, :fee, :staff_pay, :closed_at, :cancelled_at, :created_at)
     RETURNING *`,
    {
      id,
      title: `เคสทดสอบ ${id}`,
      client_name: clientName,
      status,
      assigned_to: assignee,
      start_date: startDate,
      end_date: endDate,
      fee,
      staff_pay: staffPay,
      closed_at: closedAt,
      cancelled_at: cancelledAt,
      created_at: createdAt,
    },
  );
}

async function newVisit(caseId, {
  visitDate = clock.today,
  assignedTo = FIELD.employee_id,
  status = 'scheduled',
  plannedStart = '09:00',
  plannedEnd = '11:00',
} = {}) {
  return sql.one(
    `INSERT INTO case_visits
       (case_id, visit_date, assigned_to, status, planned_start, planned_end)
     VALUES (:case_id, :visit_date, :assigned_to, :status, :planned_start, :planned_end)
     RETURNING visit_id, case_id, visit_date, assigned_to, status`,
    {
      case_id: caseId,
      visit_date: visitDate,
      assigned_to: assignedTo,
      status,
      planned_start: plannedStart,
      planned_end: plannedEnd,
    },
  );
}

async function newInvoice({
  id = `${INVOICE_PREFIX}${String(++invoiceNo).padStart(3, '0')}`,
  caseId = null,
  issueDate = clock.today,
  dueDate = null,
  status = 'draft',
  billTo = 'ผู้จ่ายทดสอบ',
  total = 1000,
  billingKind = null,
} = {}) {
  return sql.one(
    `INSERT INTO invoices
       (invoice_id, case_id, issue_date, due_date, paid_at, status,
        bill_to_name, service_description, amount, discount, total, billing_kind)
     VALUES
       (:id, :case_id, :issue_date, :due_date,
        CASE WHEN :status = 'paid' THEN :issue_date ELSE NULL END,
        :status, :bill_to, 'บริการทดสอบ', :total, 0, :total, :billing_kind)
     RETURNING *`,
    {
      id,
      case_id: caseId,
      issue_date: issueDate,
      due_date: dueDate,
      status,
      bill_to: billTo,
      total,
      billing_kind: billingKind,
    },
  );
}

async function coverCaseWithInvoice(caseRow) {
  // ใบปัจจุบันที่ผูกเคส ป้องกันเคสปิดไปเพิ่ม closed_no_invoice
  // billing_kind=deposit ทำให้ยอดเหมาต่างจากเคสได้โดยไม่ถูกนับ data_stale
  return newInvoice({
    caseId: caseRow.case_id,
    issueDate: clock.today,
    dueDate: clock.tomorrow,
    status: 'draft',
    billTo: caseRow.client_name,
    total: Number(caseRow.fee ?? 0),
    billingKind: 'deposit',
  });
}

async function newPayout(caseId, employee, amount = 1000) {
  return sql.one(
    `INSERT INTO case_payouts
       (case_id, employee_id, employee_name, amount, shifts, minutes,
        released_at, released_by, released_by_name)
     VALUES
       (:case_id, :employee_id, :employee_name, :amount, 1, 60,
        :released_at, :manager, :manager_name)
     RETURNING payout_id`,
    {
      case_id: caseId,
      employee_id: employee.employee_id,
      employee_name: `${employee.first_name} ${employee.last_name}`,
      amount,
      released_at: `${clock.today} 10:00:00`,
      manager: MANAGER.employee_id,
      manager_name: `${MANAGER.first_name} ${MANAGER.last_name}`,
    },
  );
}

const countOf = (response) => Number(response.body?.pagination?.total ?? NaN);
const sumAlertGroups = (groups) => Object.values(groups ?? {})
  .flatMap((group) => Object.values(group ?? {}))
  .reduce((sum, n) => sum + Number(n), 0);
const sectionCounts = (body) => Object.fromEntries(
  (body?.sections ?? []).map((section) => [section.key, section.lines.length]),
);
const sortedKeys = (value) => Object.keys(value ?? {}).sort();
const sameCounts = (actual, expected) => {
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') {
    return Number(actual) === Number(expected);
  }
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(actual, key) &&
      (typeof expected[key] === 'object'
        ? sameCounts(actual[key], expected[key])
        : Number(actual[key]) === Number(expected[key])));
};

function forbiddenKeys(value, names, path = '$') {
  if (Array.isArray(value)) return value.flatMap((item, i) => forbiddenKeys(item, names, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key.toLowerCase())) out.push(`${path}.${key}`);
    out.push(...forbiddenKeys(child, names, `${path}.${key}`));
  }
  return out;
}

const MONEY_KEYS = new Set([
  'fee', 'staff_pay', 'rate_staff_pay', 'physio_staff_pay', 'total_pay',
  'revenue', 'cost', 'profit', 'margin', 'gross_profit', 'net_profit',
]);

// -----------------------------------------------------------------------------
await resetTopic();
head('1 · ประตู cron + เรียกซ้ำวันเดียวกัน');
{
  const cronCase = await newCase(`${CASE_PREFIX}CRON`, { status: 'unassigned' });
  await newVisit(cronCase.case_id, { assignedTo: null });

  const vercel = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const configuredCron = vercel.crons?.find((item) => item.path === '/api/notify/daily-digest');
  probe(
    configuredCron?.schedule === '0 1 * * *',
    'ตาราง Vercel ไม่ได้ชี้เส้นสรุปรายวันเวลา 08:00 น. ไทย',
    `crons=${brief(vercel.crons)}`,
    'vercel.json ชี้ GET /api/notify/daily-digest เวลา 01:00 UTC = 08:00 น. ไทย',
  );

  // POST เป็นทางของคนตาม routes.js: Bearer อย่างเดียวต้องใช้แทน session ไม่ได้
  const postWithoutSession = await Promise.all([
    post('/api/notify/daily-digest', {}, null, { authorization: 'Bearer wrong' }),
    post('/api/notify/daily-digest', {}, null),
    post('/api/notify/daily-digest', {}, null, { authorization: 'Bearer ' }),
  ]);
  probe(
    postWithoutSession.every((r) => r.status === 401),
    'Bearer หรือคำขอเปล่าเข้าทาง POST ส่งสรุปเองได้โดยไม่มี session',
    postWithoutSession.map((r) => `${r.status}/${brief(r.body)}`).join(' · '),
    'POST เป็นทางของคนจริง: Bearer ผิด/ไม่มี/ว่าง ข้าม requireAuth ไม่ได้',
  );

  const [fieldPost, financePost, hrPost, managerPost] = await Promise.all([
    post('/api/notify/daily-digest', {}, FIELD),
    post('/api/notify/daily-digest', {}, FINANCE),
    post('/api/notify/daily-digest', {}, HR),
    post('/api/notify/daily-digest', {}, MANAGER),
  ]);
  probe(
    fieldPost.status === 403 && financePost.status === 403 &&
      hrPost.status === 200 && managerPost.status === 200,
    'สิทธิ์ POST ส่งสรุปเองไม่ตรงกับหมวด office',
    `field=${fieldPost.status} finance=${financePost.status} HR=${hrPost.status} manager=${managerPost.status}`,
    'POST ส่งเอง: field/การเงินถูกกัน 403; HR/ผู้จัดการใช้ได้ตามสิทธิ์ office',
  );

  // GET คือทาง cron จริง: ไม่รับ session เป็นทางสำรอง
  const cronDenied = await Promise.all([
    get('/api/notify/daily-digest', null, { authorization: 'Bearer wrong' }),
    get('/api/notify/daily-digest'),
    get('/api/notify/daily-digest', null, { authorization: 'Bearer ' }),
    get('/api/notify/daily-digest', MANAGER),
  ]);
  probe(
    cronDenied.every((r) => r.status === 401),
    'GET cron รับ Bearer ผิด/ว่าง หรือรับคุกกี้ผู้จัดการเป็นทางสำรอง',
    cronDenied.map((r) => `${r.status}/${brief(r.body)}`).join(' · '),
    'GET cron ปิด Bearer ผิด/ไม่มี/ว่าง และไม่รับ session ผู้จัดการแทน secret',
  );

  delete process.env.CRON_SECRET;
  const unsetSecret = await get('/api/notify/daily-digest', MANAGER, {
    authorization: `Bearer ${CRON_SECRET}`,
  });
  process.env.CRON_SECRET = CRON_SECRET;
  probe(
    unsetSecret.status === 401,
    'ไม่ตั้ง CRON_SECRET แล้วเส้น cron เปิดให้เรียกได้',
    `status=${unsetSecret.status} body=${brief(unsetSecret.body)}`,
    'ไม่ตั้ง CRON_SECRET = ปิดเส้น cron แม้แนบ Bearer และคุกกี้ผู้จัดการ',
  );

  const validCron = await get('/api/notify/daily-digest', null, {
    authorization: `Bearer ${CRON_SECRET}`,
  });
  probe(
    validCron.status === 200 && validCron.body?.date === clock.today,
    'Bearer ที่ถูกต้องเรียก cron ไม่สำเร็จหรือใช้วันที่ผิด',
    `status=${validCron.status} body=${brief(validCron.body)}`,
    'Bearer ที่ถูกต้องเรียก GET cron ได้ และ payload ลงวันที่ไทยวันนี้',
  );

  const callsBeforeRepeat = fakeDigestCalls;
  const repeatA = await get('/api/notify/daily-digest', null, {
    authorization: `Bearer ${CRON_SECRET}`,
  });
  const repeatB = await get('/api/notify/daily-digest', null, {
    authorization: `Bearer ${CRON_SECRET}`,
  });
  const repeatedCalls = fakeDigestCalls - callsBeforeRepeat;
  probe(
    repeatA.status === 200 && repeatB.status === 200 && repeatedCalls <= 1,
    'cron วันเดียวกันถูกเรียกซ้ำแล้วตัวส่งทำงานซ้ำ',
    `HTTP=${repeatA.status}/${repeatB.status}; ตัวส่งจำลองถูกเรียก ${repeatedCalls} ครั้ง — ไม่มีหลักฐานตัวกันซ้ำรายวัน`,
    'เรียก cron ซ้ำสองครั้งในวันเดียว ตัวส่งทำงานไม่เกินหนึ่งครั้ง',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('2 · ตัวเลขกระดิ่งตรงกับ repo และจำนวนแถวหน้าปลายทาง');
{
  // การมาทำงาน: ขาดงาน 4 กะ + วันนี้ยังไม่มีคนรับ 4 กะ
  const missedCase = await newCase(`${CASE_PREFIX}MISSED`, {
    staffPay: 1000,
    endDate: '2099-12-31',
  });
  for (let i = 0; i < 4; i += 1) {
    await newVisit(missedCase.case_id, {
      visitDate: clock.yesterday,
      plannedStart: `${String(8 + i).padStart(2, '0')}:00`,
    });
  }

  const unstaffedCase = await newCase(`${CASE_PREFIX}UNSTAFFED`, { status: 'unassigned' });
  for (let i = 0; i < 4; i += 1) {
    await newVisit(unstaffedCase.case_id, {
      visitDate: clock.today,
      assignedTo: null,
      plannedStart: `${String(12 + i).padStart(2, '0')}:00`,
    });
  }

  // เคส: อย่างละ 1 ตามคีย์กระดิ่ง และใส่ใบปัจจุบันให้เคสปิดที่ไม่ใช่ closed_no_invoice
  const overdueCase = await newCase(`${CASE_PREFIX}OVERDUE-CLOSE`, {
    endDate: clock.yesterday,
    staffPay: 1000,
  });
  await coverCaseWithInvoice(overdueCase);

  const soonCase = await newCase(`${CASE_PREFIX}ENDING-SOON`, {
    endDate: clock.tomorrow,
    staffPay: 1000,
  });
  await coverCaseWithInvoice(soonCase);

  const noPayCase = await newCase(`${CASE_PREFIX}NO-PAY`, { staffPay: null });
  await newVisit(noPayCase.case_id, { assignedTo: FIELD.employee_id });
  await coverCaseWithInvoice(noPayCase);

  await newCase(`${CASE_PREFIX}CLOSED-NO-IV`, {
    status: 'closed',
    staffPay: null,
    closedAt: `${clock.today} 09:00:00`,
  });

  // payroll: ปิดแล้วยังไม่ปล่อย 1 เคส · ยอดรอเข้ารอบ 2 คน · รอบ draft 1 รอบ
  const unreleasedCase = await newCase(`${CASE_PREFIX}UNRELEASED`, {
    status: 'closed',
    staffPay: 1500,
    closedAt: `${clock.today} 09:00:00`,
  });
  await coverCaseWithInvoice(unreleasedCase);

  const payoutCaseA = await newCase(`${CASE_PREFIX}PAYOUT-A`, {
    status: 'closed', staffPay: 1200, closedAt: `${clock.today} 09:00:00`,
  });
  const payoutCaseB = await newCase(`${CASE_PREFIX}PAYOUT-B`, {
    status: 'closed', assignedTo: FIELD_B.employee_id,
    staffPay: 1300, closedAt: `${clock.today} 09:00:00`,
  });
  await coverCaseWithInvoice(payoutCaseA);
  await coverCaseWithInvoice(payoutCaseB);
  await newPayout(payoutCaseA.case_id, FIELD, 1200);
  await newPayout(payoutCaseB.case_id, FIELD_B, 1300);
  await sql.run(
    `INSERT INTO payroll_runs
       (run_id, period_month, round_no, period_to, status, created_by, created_by_name)
     VALUES (:id, :month, 1, :today, 'draft', :manager, :manager_name)`,
    {
      id: `${PAY_PREFIX}DRAFT`,
      month: clock.month,
      today: clock.today,
      manager: MANAGER.employee_id,
      manager_name: `${MANAGER.first_name} ${MANAGER.last_name}`,
    },
  );

  // ใบแจ้งหนี้: เลยกำหนด 3 · ร่างค้าง 2 พร้อมตัวควบคุมที่ต้องไม่นับ
  for (let i = 0; i < 3; i += 1) {
    await newInvoice({ status: 'issued', issueDate: clock.old_day, dueDate: clock.yesterday });
  }
  for (let i = 0; i < 2; i += 1) {
    await newInvoice({ status: 'draft', issueDate: clock.old_day, dueDate: clock.tomorrow });
  }
  await newInvoice({ status: 'issued', issueDate: clock.today, dueDate: clock.today });
  await newInvoice({ status: 'paid', issueDate: clock.old_day, dueDate: clock.yesterday });
  await newInvoice({ status: 'draft', issueDate: clock.today, dueDate: clock.tomorrow });
  await newInvoice({ status: 'cancelled', issueDate: clock.old_day, dueDate: clock.yesterday });

  const expected = {
    attendance: { exceptions: 4, unstaffed_today: 4 },
    payroll: { unreleased: 1, unbatched: 2, draft_runs: 1 },
    cases: {
      unassigned: 1,
      overdue_close: 1,
      ending_soon: 1,
      no_staff_pay: 1,
      closed_no_invoice: 1,
    },
    invoices: { overdue: 3, draft_stale: 2, data_stale: 0 },
  };

  const [caseCounts, invoiceCounts, payrollCounts, alerts] = await Promise.all([
    caseRepo.alertCounts(),
    invoiceRepo.alertCounts(),
    payrollRepo.alertCounts(clock.today),
    get('/api/notify/alerts', MANAGER),
  ]);
  probe(
    alerts.status === 200 &&
      sameCounts(caseCounts, expected.cases) &&
      sameCounts(invoiceCounts, expected.invoices) &&
      sameCounts(payrollCounts, expected.payroll) &&
      sameCounts(alerts.body?.groups, expected) &&
      alerts.body?.total === sumAlertGroups(expected),
    'alertCounts() กับ /api/notify/alerts คืนตัวเลขไม่ตรงกับข้อมูลที่รู้คำตอบ',
    `caseRepo=${brief(caseCounts)} invoiceRepo=${brief(invoiceCounts)} payrollRepo=${brief(payrollCounts)} ` +
      `alerts=${brief(alerts.body)} expected=${brief(expected)}`,
    'repo ทั้งสามและ /notify/alerts ตรงกับข้อมูลตั้งต้นทุกคีย์ รวม total ฝั่ง server',
  );

  const [exceptions, calendar, payrollPreview, caseQueue, draftRuns] = await Promise.all([
    get('/api/cases/attendance/exceptions', MANAGER),
    get(`/api/cases/calendar?year=${clock.year}&month=${clock.month.slice(5, 7)}`, MANAGER),
    get(`/api/payroll/preview?period_to=${clock.today}`, MANAGER),
    get('/api/payroll/case-queue', MANAGER),
    get('/api/payroll?status=draft', MANAGER),
  ]);
  const unstaffedRows = Array.isArray(calendar.body)
    ? calendar.body.filter((row) => row.visit_date === clock.today && row.assigned_to == null && row.visit_status === 'scheduled')
    : [];
  const unreleasedRows = Array.isArray(caseQueue.body)
    ? caseQueue.body.filter((row) => row.status === 'closed' && Number(row.released) === 0 && Number(row.staff_pay) > 0)
    : [];
  probe(
    exceptions.status === 200 && exceptions.body.length === expected.attendance.exceptions &&
      calendar.status === 200 && unstaffedRows.length === expected.attendance.unstaffed_today &&
      payrollPreview.status === 200 && payrollPreview.body?.unreleased_cases === expected.payroll.unreleased &&
      payrollPreview.body?.rows?.length === expected.payroll.unbatched &&
      caseQueue.status === 200 && unreleasedRows.length === expected.payroll.unreleased &&
      draftRuns.status === 200 && draftRuns.body?.length === expected.payroll.draft_runs,
    'ตัวเลข attendance/payroll บนกระดิ่งไม่ตรงกับแถวที่หน้าปลายทางคืนจริง',
    `exceptions=${exceptions.body?.length} unstaffed=${unstaffedRows.length} ` +
      `preview=${brief(payrollPreview.body)} unreleasedRows=${unreleasedRows.length} draftRuns=${draftRuns.body?.length}`,
    'attendance และ payroll ตรงกับรายการจริงที่หน้า exceptions/calendar/case-queue/preview/runs',
  );

  const caseFilters = {
    unassigned: '/api/cases?status=unassigned&per_page=100',
    overdue_close: '/api/cases?overdue_close=yes&per_page=100',
    ending_soon: '/api/cases?ending_soon=yes&per_page=100',
    no_staff_pay: '/api/cases?no_staff_pay=yes&per_page=100',
    closed_no_invoice: '/api/cases?closed_no_invoice=yes&per_page=100',
  };
  const caseRows = Object.fromEntries(await Promise.all(
    Object.entries(caseFilters).map(async ([key, path]) => [key, await get(path, MANAGER)]),
  ));
  probe(
    Object.entries(expected.cases).every(([key, count]) =>
      caseRows[key]?.status === 200 && countOf(caseRows[key]) === count),
    'ตัวเลขกลุ่มเคสบนกระดิ่งไม่ตรงกับ pagination.total ของลิงก์จริง',
    Object.entries(caseRows).map(([key, r]) => `${key}=${r.status}/${countOf(r)}`).join(' · '),
    'กระดิ่งเคสทั้ง 5 คีย์ตรงกับจำนวนแถวของตัวกรองปลายทางจริง',
  );

  const invoiceFilters = {
    overdue: '/api/invoices?overdue=yes&per_page=100',
    draft_stale: '/api/invoices?draft_stale=yes&per_page=100',
    data_stale: '/api/invoices?stale=yes&per_page=100',
  };
  const invoiceRows = Object.fromEntries(await Promise.all(
    Object.entries(invoiceFilters).map(async ([key, path]) => [key, await get(path, MANAGER)]),
  ));
  probe(
    Object.entries(expected.invoices).every(([key, count]) =>
      invoiceRows[key]?.status === 200 && countOf(invoiceRows[key]) === count),
    'ตัวเลขใบแจ้งหนี้บนกระดิ่งไม่ตรงกับ pagination.total ของลิงก์จริง',
    Object.entries(invoiceRows).map(([key, r]) => `${key}=${r.status}/${countOf(r)}`).join(' · '),
    'กระดิ่งใบแจ้งหนี้ overdue/draft_stale/data_stale ตรงกับรายการที่กดเข้าไปเห็นจริง',
  );

  const preview = await get('/api/notify/digest-preview', MANAGER);
  const digestExpected = { unstaffed: 4, missed: 4, overdue: 3 };
  probe(
    preview.status === 200 &&
      sameCounts(sectionCounts(preview.body), digestExpected),
    'สรุปรายวันนับกะหรือใบเกินกำหนดไม่ตรงกับข้อมูลเดียวกับกระดิ่ง',
    `sections=${brief(sectionCounts(preview.body))} expected=${brief(digestExpected)}`,
    'digest-preview มี unstaffed 4 · missed 4 · overdue 3 และไม่สร้างหัวข้อว่าง',
  );
}

// -----------------------------------------------------------------------------
head('3 · สิทธิ์กระดิ่ง/พรีวิว + ข้อมูลเงินไม่หลุด');
{
  const [managerAlerts, hrAlerts, adminAlerts, financeAlerts, fieldAlerts] = await Promise.all([
    get('/api/notify/alerts', MANAGER),
    get('/api/notify/alerts', HR),
    get('/api/notify/alerts', ADMIN),
    get('/api/notify/alerts', FINANCE),
    get('/api/notify/alerts', FIELD),
  ]);
  probe(
    managerAlerts.status === 200 &&
      JSON.stringify(sortedKeys(managerAlerts.body?.groups)) === JSON.stringify(['attendance', 'cases', 'invoices', 'payroll']) &&
      hrAlerts.status === 200 &&
      JSON.stringify(sortedKeys(hrAlerts.body?.groups)) === JSON.stringify(['attendance', 'cases', 'invoices']) &&
      adminAlerts.status === 200 &&
      JSON.stringify(sortedKeys(adminAlerts.body?.groups)) === JSON.stringify(['attendance', 'cases', 'invoices']) &&
      financeAlerts.status === 200 &&
      JSON.stringify(sortedKeys(financeAlerts.body?.groups)) === JSON.stringify(['invoices', 'payroll']) &&
      fieldAlerts.status === 403,
    'กระดิ่งส่งกลุ่มที่ตำแหน่งนั้นเปิดหน้าไม่ได้ หรือกันตำแหน่งผิด',
    `manager=${brief(managerAlerts.body)} HR=${brief(hrAlerts.body)} admin=${brief(adminAlerts.body)} ` +
      `finance=${brief(financeAlerts.body)} field=${fieldAlerts.status}/${brief(fieldAlerts.body)}`,
    'manager เห็นครบ · HR/Admin HC ไม่เห็น payroll · การเงินเห็น invoices/payroll · field ถูกกัน 403',
  );

  const nonMoneyAlertLeaks = [
    ['HR', hrAlerts],
    ['Admin HC', adminAlerts],
  ].flatMap(([label, response]) =>
    forbiddenKeys(response.body, MONEY_KEYS).map((path) => `${label}:${path}`));
  probe(
    nonMoneyAlertLeaks.length === 0 &&
      !('payroll' in (hrAlerts.body?.groups ?? {})) &&
      !('payroll' in (adminAlerts.body?.groups ?? {})),
    'กระดิ่งของคนไม่มีหมวด money มีข้อมูลค่าจ้าง/ต้นทุน/กำไรหลุดมา',
    `fields=${nonMoneyAlertLeaks.join(', ')} HR=${brief(hrAlerts.body)} admin=${brief(adminAlerts.body)}`,
    'payload /alerts ของ HR/Admin HC ตัดทั้งกลุ่ม payroll และไม่มีฟิลด์เงินภายใน',
  );

  const [managerPreview, hrPreview, adminPreview, financePreview, fieldPreview] = await Promise.all([
    get('/api/notify/digest-preview', MANAGER),
    get('/api/notify/digest-preview', HR),
    get('/api/notify/digest-preview', ADMIN),
    get('/api/notify/digest-preview', FINANCE),
    get('/api/notify/digest-preview', FIELD),
  ]);
  probe(
    managerPreview.status === 200 && hrPreview.status === 200 && adminPreview.status === 200 &&
      financePreview.status === 403 && fieldPreview.status === 403,
    'สิทธิ์ /digest-preview ไม่ตรงกับหมวด office',
    `manager=${managerPreview.status} HR=${hrPreview.status} admin=${adminPreview.status} ` +
      `finance=${financePreview.status} field=${fieldPreview.status}`,
    '/digest-preview เปิดให้ manager/HR/Admin HC และกันการเงิน/field ที่ไม่มี office',
  );

  const previewLeaks = [
    ...forbiddenKeys(hrPreview.body, MONEY_KEYS),
    ...forbiddenKeys(adminPreview.body, MONEY_KEYS),
  ];
  const previewText = `${JSON.stringify(hrPreview.body)} ${JSON.stringify(adminPreview.body)}`;
  probe(
    previewLeaks.length === 0 && !/(รายได้|ต้นทุน|กำไร|ค่าจ้างพนักงาน)/.test(previewText),
    'digest-preview ของคนไม่มีหมวด money หลุดรายได้/ต้นทุน/กำไร/ค่าจ้าง',
    `fields=${previewLeaks.join(', ')} payload=${brief(previewText)}`,
    'digest-preview ของ HR/Admin HC มีแต่งานค้าง ไม่มีรายได้ ต้นทุน กำไร หรือค่าจ้างพนักงาน',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('4 · ระบบว่าง · มีแต่รายการยกเลิก · เดือนที่ไม่มีข้อมูล');
{
  const beforeEmptySend = fakeDigestCalls;
  const [alerts, preview, cron, caseSummary, calendar, payrollPreview] = await Promise.all([
    get('/api/notify/alerts', MANAGER),
    get('/api/notify/digest-preview', MANAGER),
    get('/api/notify/daily-digest', null, { authorization: `Bearer ${CRON_SECRET}` }),
    get('/api/cases/summary?year=2099&month=12', MANAGER),
    get('/api/cases/calendar?year=2099&month=12', MANAGER),
    get('/api/payroll/preview?period_to=2000-01-31', MANAGER),
  ]);
  const everyAlertKeyPresentAndZero = Object.entries(ALERT_KEYS).every(([group, keys]) =>
    keys.every((key) => Object.prototype.hasOwnProperty.call(alerts.body?.groups?.[group] ?? {}, key) &&
      alerts.body.groups[group][key] === 0));
  probe(
    alerts.status === 200 && alerts.body?.total === 0 && everyAlertKeyPresentAndZero &&
      preview.status === 200 && preview.body?.sections?.length === 0 &&
      cron.status === 200 && cron.body?.sent === false && cron.body?.sections?.length === 0 &&
      fakeDigestCalls === beforeEmptySend,
    'ฐานว่างแล้วแจ้งเตือนหาย/เป็น null หรือ cron ยังเรียกตัวส่ง',
    `alerts=${brief(alerts.body)} preview=${brief(preview.body)} cron=${brief(cron.body)}`,
    'ฐานว่างคืนคีย์กระดิ่งครบเป็น 0 · preview ว่าง · cron ไม่เรียกตัวส่ง',
  );
  probe(
    caseSummary.status === 200 && caseSummary.body?.total === 0 &&
      Array.isArray(caseSummary.body?.by_status) && caseSummary.body.by_status.length === 0 &&
      Array.isArray(caseSummary.body?.by_service) && caseSummary.body.by_service.length === 0 &&
      calendar.status === 200 && Array.isArray(calendar.body) && calendar.body.length === 0 &&
      payrollPreview.status === 200 && payrollPreview.body?.unreleased_cases === 0 &&
      Array.isArray(payrollPreview.body?.rows) && payrollPreview.body.rows.length === 0,
    'เดือนที่ไม่มีข้อมูลคืน null/NaN/คีย์หาย หรือ 500',
    `caseSummary=${brief(caseSummary)} calendar=${brief(calendar)} payroll=${brief(payrollPreview)}`,
    'เดือนว่าง: case total=0 · calendar=[] · payroll rows=[]/unreleased_cases=0',
  );

  const cancelledCase = await newCase(`${CASE_PREFIX}CANCELLED`, {
    status: 'cancelled',
    assignedTo: FIELD.employee_id,
    staffPay: null,
    cancelledAt: `${clock.today} 09:00:00`,
  });
  await newVisit(cancelledCase.case_id, {
    visitDate: clock.yesterday,
    assignedTo: null,
    status: 'cancelled',
  });
  await newInvoice({
    caseId: null,
    status: 'cancelled',
    issueDate: clock.old_day,
    dueDate: clock.yesterday,
  });
  const [cancelAlerts, cancelPreview, cancelSummary, cancelCalendar] = await Promise.all([
    get('/api/notify/alerts', MANAGER),
    get('/api/notify/digest-preview', MANAGER),
    get(`/api/cases/summary?year=${clock.year}&month=${clock.month.slice(5, 7)}`, MANAGER),
    get(`/api/cases/calendar?year=${clock.year}&month=${clock.month.slice(5, 7)}`, MANAGER),
  ]);
  probe(
    cancelAlerts.status === 200 && cancelAlerts.body?.total === 0 &&
      cancelPreview.status === 200 && cancelPreview.body?.sections?.length === 0 &&
      cancelSummary.status === 200 && cancelSummary.body?.total === 1 &&
      cancelSummary.body?.by_status?.some((row) => row.status === 'cancelled' && row.count === 1) &&
      cancelCalendar.status === 200 && cancelCalendar.body?.length === 0,
    'มีแต่ข้อมูลยกเลิกแล้วกระดิ่ง/digest ยังนับเป็นของค้าง หรือสรุป/ปฏิทินพัง',
    `alerts=${brief(cancelAlerts.body)} preview=${brief(cancelPreview.body)} ` +
      `summary=${brief(cancelSummary.body)} calendar=${brief(cancelCalendar.body)}`,
    'รายการยกเลิกยังอยู่ในสรุปประวัติ แต่ไม่ขึ้นกระดิ่ง/digest และกะยกเลิกไม่ขึ้นปฏิทิน',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('5 · แถวอ้างอิงหายหนึ่งแถวไม่ทำให้ทั้งรอบล้ม');
{
  // ทั้งสามสถานะนี้ฐานอนุญาตโดยตั้งใจและเกิดจากงานปกติได้:
  // cases.customer_id ว่างได้, invoices.case_id ON DELETE SET NULL,
  // case_visits.assigned_to/checked_in_by ON DELETE SET NULL
  const noCustomer = await newCase(`${CASE_PREFIX}NO-CUSTOMER`, {
    status: 'unassigned',
    clientName: 'เคสไม่มีผู้ว่าจ้าง',
  });
  await newVisit(noCustomer.case_id, { assignedTo: null, visitDate: clock.today });

  await newInvoice({
    id: `${INVOICE_PREFIX}NO-CASE`,
    caseId: null,
    status: 'issued',
    issueDate: clock.old_day,
    dueDate: clock.yesterday,
    billTo: 'ใบที่เคสถูกลบแล้ว',
  });

  const noEmployee = await newCase(`${CASE_PREFIX}NO-EMPLOYEE`, {
    status: 'assigned',
    assignedTo: FIELD.employee_id,
    clientName: 'กะที่พนักงานถูกลบแล้ว',
  });
  await newVisit(noEmployee.case_id, {
    visitDate: clock.yesterday,
    assignedTo: null,
  });
  const stale = await newVisit(noEmployee.case_id, {
    visitDate: clock.today,
    assignedTo: null,
    plannedStart: '05:00',
  });
  await sql.run(
    `UPDATE case_visits
     SET check_in_at = now() - interval '17 hours', checked_in_by = NULL
     WHERE visit_id = :visit_id`,
    { visit_id: stale.visit_id },
  );

  const [preview, alerts] = await Promise.all([
    get('/api/notify/digest-preview', MANAGER),
    get('/api/notify/alerts', MANAGER),
  ]);
  const digestText = (preview.body?.sections ?? []).flatMap((section) => section.lines).join('\n');
  probe(
    preview.status === 200 && alerts.status === 200 &&
      digestText.includes(noCustomer.case_id) &&
      digestText.includes(`${INVOICE_PREFIX}NO-CASE`) &&
      digestText.includes(noEmployee.case_id) &&
      digestText.includes('ไม่ระบุคน'),
    'เคสไม่มีผู้ว่าจ้าง/ใบไม่มีเคส/กะไม่มีพนักงาน ทำให้ digest ทั้งฉบับล้มหรือแถวหาย',
    `preview=${preview.status}/${brief(preview.body)} alerts=${alerts.status}/${brief(alerts.body)}`,
    'แถวอ้างอิงหายยังได้ 200 และแต่ละแถวอยู่ครบ; ชื่อพนักงานที่หายใช้ข้อความแทน',
  );
}

// -----------------------------------------------------------------------------
await resetTopic();
head('6 · เขตวันไทย: เมื่อวาน/วันนี้ + เที่ยงคืนและสิ้นเดือน');
{
  const thaiPeriod = await notifyRepo.todayTH();
  probe(
    thaiPeriod.today === clock.today,
    'notify.todayTH ใช้วันไม่ตรงกับ Asia/Bangkok',
    `notify=${brief(thaiPeriod)} DB-thai=${clock.today} DB-utc=${clock.utc_today}`,
    `notify.todayTH ตรงกับวันไทย ${clock.today} (วัน UTC ขณะรันคือ ${clock.utc_today})`,
  );

  const dayCase = await newCase(`${CASE_PREFIX}DAY-EDGE`, { status: 'unassigned' });
  await newVisit(dayCase.case_id, { visitDate: clock.yesterday, assignedTo: null, plannedStart: '08:00' });
  await newVisit(dayCase.case_id, { visitDate: clock.today, assignedTo: null, plannedStart: '09:00' });
  await newVisit(dayCase.case_id, { visitDate: clock.tomorrow, assignedTo: null, plannedStart: '10:00' });
  const dayPreview = await get('/api/notify/digest-preview', MANAGER);
  const dayCounts = sectionCounts(dayPreview.body);
  const dayText = JSON.stringify(dayPreview.body?.sections ?? []);
  probe(
    dayPreview.status === 200 && dayCounts.missed === 1 && dayCounts.unstaffed === 1 &&
      !dayText.includes(`${clock.tomorrow} ·`),
    'digest แบ่งเมื่อวาน/วันนี้/พรุ่งนี้เหลื่อมเขตวัน',
    `dates=${clock.yesterday}/${clock.today}/${clock.tomorrow} sections=${brief(dayPreview.body?.sections)}`,
    'กะเมื่อวานเข้า missed · กะวันนี้เข้า unstaffed · กะพรุ่งนี้ยังไม่ถูกเตือน',
  );

  // helper ฝั่ง JS ที่ invoices/payroll ใช้: 17:00 UTC คือเที่ยงคืนไทยและเป็นขอบเดือนพอดี
  const realDateNow = Date.now;
  let justBefore;
  let atMidnight;
  try {
    Date.now = () => Date.parse('2026-01-31T16:59:59.999Z');
    justBefore = todayTh();
    Date.now = () => Date.parse('2026-01-31T17:00:00.000Z');
    atMidnight = todayTh();
  } finally {
    Date.now = realDateNow;
  }
  probe(
    justBefore === '2026-01-31' && atMidnight === '2026-02-01',
    'ตัวคำนวณวันไทยฝั่ง JS เปลี่ยนวันที่ตาม UTC หรือข้ามเดือนผิด',
    `16:59:59.999Z=${justBefore}; 17:00:00.000Z=${atMidnight}`,
    'ขอบเที่ยงคืนไทย/สิ้นเดือน: 16:59:59Z ยัง 31 ม.ค.; 17:00:00Z เป็น 1 ก.พ.',
  );

  const fixedZones = await sql.all(
    `SELECT label,
            to_char(moment AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') AS thai,
            to_char(moment AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS utc
     FROM (VALUES
       ('before', TIMESTAMPTZ '2026-01-31 16:59:59.999+00'),
       ('after',  TIMESTAMPTZ '2026-01-31 17:00:00.000+00')
     ) AS edge(label, moment)
     ORDER BY label`,
  );
  const before = fixedZones.find((row) => row.label === 'before');
  const after = fixedZones.find((row) => row.label === 'after');
  probe(
    before?.thai.startsWith('2026-01-31') && before?.utc.startsWith('2026-01-31') &&
      after?.thai.startsWith('2026-02-01') && after?.utc.startsWith('2026-01-31'),
    'นิพจน์ PostgreSQL ที่ digest ใช้ไม่เปลี่ยนวันตอนเที่ยงคืนไทย',
    `rows=${brief(fixedZones)}`,
    'PostgreSQL เห็น 17:00 UTC เป็น 1 ก.พ. ตามไทย ขณะที่ UTC ยังเป็น 31 ม.ค.',
  );

  const janCase = await newCase(`${CASE_PREFIX}JAN`, {
    status: 'unassigned',
    createdAt: '2026-01-31 23:59:59',
  });
  const febCase = await newCase(`${CASE_PREFIX}FEB`, {
    status: 'unassigned',
    createdAt: '2026-02-01 00:00:00',
  });
  await newVisit(janCase.case_id, { visitDate: '2026-01-31', assignedTo: null });
  await newVisit(febCase.case_id, { visitDate: '2026-02-01', assignedTo: null });
  await newVisit(janCase.case_id, {
    visitDate: '2026-01-31', assignedTo: null, status: 'cancelled', plannedStart: '13:00',
  });
  const [janSummary, febSummary, janCalendar, febCalendar] = await Promise.all([
    get('/api/cases/summary?year=2026&month=01', MANAGER),
    get('/api/cases/summary?year=2026&month=02', MANAGER),
    get('/api/cases/calendar?year=2026&month=01', MANAGER),
    get('/api/cases/calendar?year=2026&month=02', MANAGER),
  ]);
  probe(
    janSummary.status === 200 && janSummary.body?.total === 1 &&
      febSummary.status === 200 && febSummary.body?.total === 1 &&
      janCalendar.status === 200 && janCalendar.body?.length === 1 && janCalendar.body[0]?.case_id === janCase.case_id &&
      febCalendar.status === 200 && febCalendar.body?.length === 1 && febCalendar.body[0]?.case_id === febCase.case_id,
    'สรุป/ปฏิทินคาบสิ้นเดือนเอาแถวข้ามเดือนไปนับหรือรวมกะยกเลิก',
    `janSummary=${brief(janSummary.body)} febSummary=${brief(febSummary.body)} ` +
      `janCalendar=${brief(janCalendar.body)} febCalendar=${brief(febCalendar.body)}`,
    'summary และ calendar แยก 31 ม.ค./1 ก.พ. ถูกเดือน และตัดกะยกเลิกออก',
  );
}

await resetTopic();
await sql.run(
  `DELETE FROM employees WHERE employee_id IN (:admin, :finance, :field_b)`,
  { admin: ADMIN.employee_id, finance: FINANCE.employee_id, field_b: FIELD_B.employee_id },
);

console.log(
  `\n=== สรุป: 6 หัวข้อ · ${checks} จุดตรวจ · พบบัคที่พิสูจน์ได้ ${found.length} ข้อ · ผ่าน ${notes.length} จุด ===`,
);
found.forEach((item, i) => console.log(`FOUND ${i + 1} | ${item.title} | ${item.detail}`));

console.log = originalConsoleLog;
await new Promise((resolve) => server.close(resolve));
await pool.end();
