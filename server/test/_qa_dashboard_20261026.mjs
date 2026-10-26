/**
 * QA รอบใหญ่ — ตัวเลขหน้าภาพรวม กราฟรายได้ ตัวกรอง และสิทธิ์
 *
 * รันบน PostgreSQL ชั่วคราว + Express จริง + HTTP จริง:
 *   node test/_run_probe.mjs test/_qa_dashboard_20261026.mjs
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

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', first_name: 'Test', last_name: 'Employee' };
const HR = { employee_id: 'EMP-0007', position: 'hr', first_name: 'Test', last_name: 'Employee' };
const FIELD = { employee_id: 'EMP-0003', position: 'caregiver', first_name: 'Test', last_name: 'Employee' };
const ADMIN = { employee_id: 'EMP-9381', position: 'admin', first_name: 'Admin', last_name: 'DashboardQA' };
const FINANCE = { employee_id: 'EMP-9382', position: 'finance', first_name: 'Finance', last_name: 'DashboardQA' };

await seedFixtures(pool, hashPassword);
for (const who of [ADMIN, FINANCE]) {
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
await sql.run(
  `UPDATE employees SET status = 'active', must_change_password = false
   WHERE employee_id IN (:manager, :hr, :field, :admin, :finance)`,
  {
    manager: MANAGER.employee_id,
    hr: HR.employee_id,
    field: FIELD.employee_id,
    admin: ADMIN.employee_id,
    finance: FINANCE.employee_id,
  },
);
await sql.run('DELETE FROM invoices');
await sql.run('DELETE FROM cases');
await sql.run('DELETE FROM patients');
await sql.run('DELETE FROM customers');

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, { body, who = MANAGER } = {}) {
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
const get = (path, who) => call('GET', path, { who });
const post = (path, body, who) => call('POST', path, { body: body ?? {}, who });

let checks = 0;
const found = [];
const passed = [];
const head = (title) => console.log(`\n=== ${title} ===`);
const brief = (value) => {
  const valueText = typeof value === 'string' ? value : JSON.stringify(value);
  return valueText.length > 900 ? `${valueText.slice(0, 900)}...` : valueText;
};
const hit = (title, detail) => {
  found.push({ title, detail });
  console.log(`BUG | ${title}\nRESULT | ${detail}`);
};
const ok = (what) => {
  passed.push(what);
  console.log(`PASS | ${what}`);
};
const probe = (condition, bugTitle, detail, passText) => {
  checks += 1;
  if (condition) ok(passText);
  else hit(bugTitle, detail);
};
function mustStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label}: ${brief(response.body)}`);
  return response.body;
}

let caseNo = 690700000;
const nextCaseId = () => `VN${++caseNo}`;
async function createCase(fee, input = {}) {
  const response = await post('/api/cases', {
    case_id: nextCaseId(),
    client_name: `เคสแดชบอร์ด ${caseNo}`,
    fee,
    staff_pay: Math.round(fee * 0.6),
    ...input,
  });
  mustStatus(response, 201, 'สร้างเคส');
  return response.body;
}
async function invoiceForCase(caseId) {
  const response = await get(`/api/invoices?case_id=${encodeURIComponent(caseId)}&per_page=10`);
  mustStatus(response, 200, 'โหลดใบของเคส');
  assert.equal(response.body.data.length, 1, `ต้องมีใบร่างอัตโนมัติหนึ่งใบ: ${brief(response.body)}`);
  return response.body.data[0];
}
async function issueFull(invoiceId) {
  mustStatus(await post(`/api/invoices/${invoiceId}/billing-plan`, { mode: 'full' }), 200, 'เลือกเก็บเต็ม');
  mustStatus(await post(`/api/invoices/${invoiceId}/issue`), 200, 'ออกใบ');
}
const dateTH = (offsetDays = 0) => new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

function statusCount(summary, status) {
  return Number(summary?.by_status?.find((row) => row.status === status)?.count ?? 0);
}
function serviceCount(summary, kind) {
  return Number(summary?.by_service?.find((row) => row.service_kind === kind)?.count ?? 0);
}
function invalidNumbers(value, path = '$') {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...invalidNumbers(item, `${path}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) hits.push(...invalidNumbers(child, `${path}.${key}`));
  } else if (typeof value === 'number' && !Number.isFinite(value)) {
    hits.push(path);
  }
  return hits;
}

try {
  head('1 · ระบบว่างต้องได้ศูนย์');
  {
    const [summary, revenue, invoiceSummary] = await Promise.all([
      get('/api/cases/summary'),
      get('/api/invoices/revenue?bucket=day&points=3'),
      get('/api/invoices/summary', HR),
    ]);
    probe(
      summary.status === 200 && summary.body.total === 0 && Array.isArray(summary.body.by_status) && Array.isArray(summary.body.by_service),
      'ฐานที่ยังไม่มีเคสทำให้ภาพรวมได้ null/500 แทนศูนย์',
      `HTTP=${summary.status} body=${brief(summary.body)}`,
      'ฐานว่างคืน total=0 และรายการสถานะ/บริการเป็น array',
    );
    probe(
      revenue.status === 200 && revenue.body.total === 0 && revenue.body.invoices === 0 &&
        revenue.body.data.length === 3 && revenue.body.data.every((row) => row.revenue === 0 && row.invoices === 0),
      'ฐานที่ยังไม่มีเงินทำให้กราฟหาย/null/500',
      `HTTP=${revenue.status} body=${brief(revenue.body)}`,
      'ฐานว่างกางกราฟครบทุกวันและใส่ศูนย์ทุกช่อง',
    );
    probe(
      invoiceSummary.status === 200 && Array.isArray(invoiceSummary.body) && invoiceSummary.body.length === 0,
      'ฐานที่ยังไม่มีใบทำให้สรุปใบเป็น null/500',
      `HTTP=${invoiceSummary.status} body=${brief(invoiceSummary.body)}`,
      'ฐานว่างคืนสรุปใบเป็น array ว่าง',
    );
  }

  head('2 · ตัวเลขเคสที่รู้คำตอบแน่นอน');
  const cases = [];
  cases.push(await createCase(1000));
  cases.push(await createCase(500));
  cases.push(await createCase(700));
  cases.push(await createCase(2000));
  await sql.run('UPDATE cases SET service_kind = \'physio\' WHERE case_id = :id', { id: cases[3].case_id });
  for (const row of cases) {
    mustStatus(await post(`/api/cases/${row.case_id}/assign`, { employee_id: FIELD.employee_id }), 200, 'จับคู่พนักงาน');
  }
  mustStatus(await post(`/api/cases/${cases[3].case_id}/start`), 200, 'เริ่มเคสที่สี่');

  {
    const response = await get('/api/cases/summary');
    const s = mustStatus(response, 200, 'โหลดสรุปเคส');
    probe(
      s.total === 4 && statusCount(s, 'assigned') === 3 && statusCount(s, 'in_progress') === 1 &&
        statusCount(s, 'unassigned') === 0 && statusCount(s, 'closed') === 0,
      'ตัวเลขสถานะบนภาพรวมไม่ตรงกับเคสจริง',
      `total=${s.total} assigned=${statusCount(s, 'assigned')} in_progress=${statusCount(s, 'in_progress')} unassigned=${statusCount(s, 'unassigned')} closed=${statusCount(s, 'closed')}`,
      'เคส 4 ใบแสดงจับคู่แล้ว 3 และกำลังให้บริการ 1 ตรงฐาน',
    );
    probe(
      serviceCount(s, 'homecare') === 3 && serviceCount(s, 'physio') === 1,
      'กราฟประเภทบริการรวมเคสผิดกลุ่มหรือจำนวนไม่ครบ',
      `homecare=${serviceCount(s, 'homecare')} physio=${serviceCount(s, 'physio')}`,
      'กราฟประเภทบริการแสดง Homecare 3 และกายภาพ 1 ตรงฐาน',
    );
  }

  head('3 · กราฟรายได้จากเงินรับจริง');
  {
    const invoices = [];
    for (const row of cases) invoices.push(await invoiceForCase(row.case_id));
    for (const invoice of invoices.slice(0, 3)) await issueFull(invoice.invoice_id);

    mustStatus(await post(`/api/invoices/${invoices[0].invoice_id}/pay`, {
      request_id: randomUUID(), amount: 400, paid_at: dateTH(0),
    }), 200, 'รับงวดแรกวันนี้');
    mustStatus(await post(`/api/invoices/${invoices[0].invoice_id}/pay`, {
      request_id: randomUUID(), amount: 600, paid_at: dateTH(0),
    }), 200, 'รับงวดสองวันนี้');
    mustStatus(await post(`/api/invoices/${invoices[1].invoice_id}/pay`, {
      request_id: randomUUID(), amount: 500, paid_at: dateTH(-1),
    }), 200, 'รับเงินเมื่อวาน');
    mustStatus(await post(`/api/invoices/${invoices[2].invoice_id}/pay`, {
      request_id: randomUUID(), amount: 700, paid_at: dateTH(0),
    }), 200, 'รับเงินของใบที่จะยกเลิก');
    mustStatus(await post(`/api/invoices/${invoices[2].invoice_id}/cancel`), 200, 'ยกเลิกใบที่ไม่ควรนับรายได้');

    const response = await get('/api/invoices/revenue?bucket=day&points=3');
    const revenue = mustStatus(response, 200, 'โหลดกราฟรายได้');
    const today = revenue.data.find((row) => row.period === dateTH(0));
    const yesterday = revenue.data.find((row) => row.period === dateTH(-1));
    const empty = revenue.data.find((row) => row.period === dateTH(-2));
    probe(
      revenue.total === 1500 && revenue.invoices === 2 &&
        today?.revenue === 1000 && today?.invoices === 1 &&
        yesterday?.revenue === 500 && yesterday?.invoices === 1,
      'กราฟรายได้บวกยอดเต็ม/นับหลายงวดผิด หรือเอาใบยกเลิกมารวม',
      `total=${revenue.total} invoices=${revenue.invoices} today=${brief(today)} yesterday=${brief(yesterday)}`,
      'หลายงวดวันเดียวรวม 1,000 บาทในใบเดียว เมื่อวาน 500 บาท และใบยกเลิกไม่นับ',
    );
    probe(
      empty?.revenue === 0 && empty?.invoices === 0 && revenue.data.length === 3,
      'วันที่ไม่มีเงินเข้าหายจากกราฟแทนที่จะเป็นศูนย์',
      `data=${brief(revenue.data)}`,
      'กราฟกางครบ 3 วันและวันที่ไม่มีเงินเข้าเป็น 0',
    );
    probe(
      revenue.data.at(-1)?.period === dateTH(0),
      'ขอบวันของกราฟอิง UTC ทำให้วันนี้ตามเวลาไทยไปอยู่วันก่อน',
      `last_period=${revenue.data.at(-1)?.period} expected_thai=${dateTH(0)}`,
      'ช่องล่าสุดของกราฟตรงกับวันที่ปัจจุบันตามเวลาไทย',
    );
  }

  head('4 · ตัวกรองปี/เดือน');
  {
    const year = dateTH(0).slice(0, 4);
    const month = dateTH(0).slice(5, 7);
    const [monthResult, future, all, periods] = await Promise.all([
      get(`/api/cases/summary?year=${year}&month=${month}`),
      get('/api/cases/summary?year=2099&month=01'),
      get('/api/cases/summary'),
      get('/api/cases/periods'),
    ]);
    probe(
      monthResult.status === 200 && monthResult.body.total === 4 && monthResult.body.year === year && monthResult.body.month === month,
      'เลือกปี/เดือนที่มีข้อมูลแล้วจำนวนไม่ตรง',
      `HTTP=${monthResult.status} body=${brief(monthResult.body)}`,
      'ตัวกรองเดือนปัจจุบันได้เคสครบ 4 ใบ',
    );
    probe(
      future.status === 200 && future.body.total === 0 && future.body.by_status.length === 0 && future.body.by_service.length === 0,
      'เลือกเดือนว่างหรือปีอนาคตแล้วได้ null/500/ข้อมูลเดือนอื่น',
      `HTTP=${future.status} body=${brief(future.body)}`,
      'เดือนว่างและปีอนาคตคืนศูนย์โดยไม่ปนข้อมูลช่วงอื่น',
    );
    probe(
      all.status === 200 && all.body.total === 4 && all.body.year === null && all.body.month === null &&
        periods.status === 200 && periods.body.some((row) => row.year === year && row.count === 4),
      'ไม่ส่งตัวกรองหรือรายการช่วงเวลาทำให้จำนวนเคสไม่ครบ',
      `all=${brief(all.body)} periods=${brief(periods.body)}`,
      'ไม่ส่งตัวกรองได้ทุกปีครบ 4 ใบ และ dropdown นับช่วงเวลาตรงกัน',
    );
  }

  head('5 · สิทธิ์และการไม่รั่วตัวเลขเงิน');
  {
    const [managerRevenue, financeRevenue, hrRevenue, adminRevenue, fieldRevenue] = await Promise.all([
      get('/api/invoices/revenue?bucket=day&points=2', MANAGER),
      get('/api/invoices/revenue?bucket=day&points=2', FINANCE),
      get('/api/invoices/revenue?bucket=day&points=2', HR),
      get('/api/invoices/revenue?bucket=day&points=2', ADMIN),
      get('/api/invoices/revenue?bucket=day&points=2', FIELD),
    ]);
    probe(
      managerRevenue.status === 200 && financeRevenue.status === 200 &&
        hrRevenue.status === 403 && adminRevenue.status === 403 && fieldRevenue.status === 403,
      'รายได้บริษัทรั่วถึง HR/Admin HC/พนักงานภาคสนาม หรือฝ่ายการเงินเข้าไม่ได้',
      `manager=${managerRevenue.status} finance=${financeRevenue.status} HR=${hrRevenue.status} admin=${adminRevenue.status} field=${fieldRevenue.status}`,
      'เฉพาะผู้จัดการและการเงินเห็นกราฟรายได้; HR/Admin HC/ภาคสนามถูกกัน 403',
    );

    const [hrInvoices, adminInvoices, financeInvoices, fieldInvoices] = await Promise.all([
      get('/api/invoices/summary', HR),
      get('/api/invoices/summary', ADMIN),
      get('/api/invoices/summary', FINANCE),
      get('/api/invoices/summary', FIELD),
    ]);
    const hrPaid = hrInvoices.body?.find?.((row) => row.status === 'paid');
    const adminPaid = adminInvoices.body?.find?.((row) => row.status === 'paid');
    const financePaid = financeInvoices.body?.find?.((row) => row.status === 'paid');
    probe(
      hrInvoices.status === 200 && adminInvoices.status === 200 && financeInvoices.status === 200 && fieldInvoices.status === 403 &&
        hrPaid?.count === 2 && !('amount' in hrPaid) && !('outstanding' in hrPaid) &&
        adminPaid?.count === 2 && !('amount' in adminPaid) &&
        financePaid?.amount === 1500,
      'ยอดรายได้ในสรุปใบหลุดถึงคนไม่มีสิทธิ์ money หรือฝ่ายการเงินได้ข้อมูลไม่ครบ',
      `HR=${brief(hrPaid)} admin=${brief(adminPaid)} finance=${brief(financePaid)} fieldHTTP=${fieldInvoices.status}`,
      'HR/Admin HC เห็นจำนวนใบแต่ไม่เห็นยอด paid; การเงินเห็นยอด; ภาคสนามถูกกัน',
    );

    const [managerCases, hrCases, adminCases, financeCases, fieldCases] = await Promise.all([
      get('/api/cases?per_page=10', MANAGER),
      get('/api/cases?per_page=10', HR),
      get('/api/cases?per_page=10', ADMIN),
      get('/api/cases/summary', FINANCE),
      get('/api/cases/summary', FIELD),
    ]);
    const forbiddenPay = (response) => response.body?.data?.some?.((row) =>
      ['staff_pay', 'rate_staff_pay', 'physio_staff_pay'].some((key) => Object.prototype.hasOwnProperty.call(row, key)));
    probe(
      managerCases.status === 200 && managerCases.body.data.some((row) => Object.prototype.hasOwnProperty.call(row, 'staff_pay')) &&
        hrCases.status === 200 && adminCases.status === 200 && !forbiddenPay(hrCases) && !forbiddenPay(adminCases) &&
        financeCases.status === 403 && fieldCases.status === 403,
      'ค่าจ้าง/ต้นทุนเคสรั่วถึง HR/Admin HC/ภาคสนาม หรือผู้จัดการไม่เห็นข้อมูลที่ต้องใช้',
      `manager=${managerCases.status} HRpay=${forbiddenPay(hrCases)} adminPay=${forbiddenPay(adminCases)} financeSummary=${financeCases.status} fieldSummary=${fieldCases.status}`,
      'ผู้จัดการเห็นค่าจ้าง; HR/Admin HC ไม่ได้รับช่องต้นทุน; การเงิน/ภาคสนามเข้า dashboard เคสไม่ได้',
    );

    const numericHits = [managerRevenue.body, financeRevenue.body, hrInvoices.body, financeInvoices.body, managerCases.body]
      .flatMap((value) => invalidNumbers(value));
    probe(
      numericHits.length === 0,
      'API หน้าภาพรวมส่ง NaN/Infinity ทำให้หน้าเว็บแสดงตัวเลขเสีย',
      `invalid_paths=${numericHits.join(',')}`,
      'payload หน้าภาพรวมทุกชุดเป็นตัวเลข finite ไม่มี NaN/Infinity',
    );
  }

  console.log(`\n=== สรุป: ${checks} จุด · พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${passed.length} จุด ===`);
  for (const item of found) console.log(`- ${item.title}: ${item.detail}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
