/**
 * QA รอบใหญ่ — ผลกระทบจากการลบข้อมูล
 *
 * รันบน PostgreSQL ชั่วคราว + Express จริง + HTTP จริง:
 *   node test/_run_probe.mjs test/_qa_delete_20261026.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { ensureFamilyTable } = await import('../src/lib/family.js');
const { ensureShareTables } = await import('../src/invoices/share.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', first_name: 'Test', last_name: 'Employee' };
const HR = { employee_id: 'EMP-0007', position: 'hr', first_name: 'Test', last_name: 'Employee' };
const FIELD = { employee_id: 'EMP-0003', position: 'caregiver', first_name: 'Test', last_name: 'Employee' };
const ADMIN = { employee_id: 'EMP-9281', position: 'admin', first_name: 'Admin', last_name: 'DeleteQA' };
const FINANCE = { employee_id: 'EMP-9282', position: 'finance', first_name: 'Finance', last_name: 'DeleteQA' };

await seedFixtures(pool, hashPassword);

async function addEmployee(who) {
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

for (const who of [ADMIN, FINANCE]) await addEmployee(who);
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
const del = (path, who) => call('DELETE', path, { who });

let checks = 0;
const found = [];
const passed = [];
const head = (title) => console.log(`\n=== ${title} ===`);
const brief = (value) => {
  const valueText = typeof value === 'string' ? value : JSON.stringify(value);
  return valueText.length > 800 ? `${valueText.slice(0, 800)}...` : valueText;
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

let employeeNo = 9300;
let patientNo = 690500000;
let caseNo = 690600000;
const nextEmployee = (position = 'caregiver') => ({
  employee_id: `EMP-${++employeeNo}`,
  position,
  first_name: 'ลบทดสอบ',
  last_name: String(employeeNo),
});
const nextPatientId = () => `KN${++patientNo}`;
const nextCaseId = () => `VN${++caseNo}`;

async function createCustomer(input = {}) {
  const response = await post('/api/customers', { name: 'ผู้ว่าจ้างทดสอบการลบ', ...input });
  mustStatus(response, 201, 'สร้างลูกค้า');
  return response.body;
}

async function createPatient(input = {}) {
  const response = await post('/api/patients', {
    patient_id: nextPatientId(),
    name: 'ผู้รับบริการทดสอบการลบ',
    allergies: 'แพ้เพนิซิลลิน',
    ...input,
  });
  mustStatus(response, 201, 'สร้างผู้รับบริการ');
  return response.body;
}

async function createCase(input = {}) {
  const response = await post('/api/cases', {
    case_id: nextCaseId(),
    client_name: 'ผู้รับการดูแลทดสอบการลบ',
    fee: 2500,
    ...input,
  });
  mustStatus(response, 201, 'สร้างเคส');
  return response.body;
}

async function invoiceForCase(caseId) {
  const response = await get(`/api/invoices?case_id=${encodeURIComponent(caseId)}&per_page=100`);
  mustStatus(response, 200, `โหลดใบของเคส ${caseId}`);
  assert.equal(response.body.data.length, 1, `เคส ${caseId} ต้องมีใบร่างอัตโนมัติหนึ่งใบ`);
  return response.body.data[0];
}

async function issueFull(invoiceId) {
  mustStatus(await post(`/api/invoices/${invoiceId}/billing-plan`, { mode: 'full' }), 200, 'เลือกเก็บเต็ม');
  return mustStatus(await post(`/api/invoices/${invoiceId}/issue`), 200, 'ออกใบ');
}

async function scalar(query, params = {}) {
  const row = await sql.one(query, params);
  return Number(row?.n ?? 0);
}

try {
  head('1 · ลบพนักงานที่มีประวัติ');
  {
    const target = nextEmployee();
    await addEmployee(target);
    const caseRow = await createCase({ assigned_to: target.employee_id, staff_pay: 1200 });
    await sql.run(
      `INSERT INTO case_reports (case_id, report_date, pulse, reported_by, reported_by_name)
       VALUES (:case_id, '2026-10-26', 72, :employee_id, 'ลบทดสอบ ผู้ดูแล')`,
      { case_id: caseRow.case_id, employee_id: target.employee_id },
    );
    await sql.run(
      `INSERT INTO staff_reviews
         (employee_id, q_punctual, q_manner, q_professional, q_communication, q_overall)
       VALUES (:id, 5, 5, 5, 5, 5)`,
      { id: target.employee_id },
    );
    await sql.run(
      `INSERT INTO payroll_runs (run_id, period_month, round_no, period_to, status, pay_date)
       VALUES ('PAY-DELETE-QA', '2026-10', 3, '2026-10-26', 'paid', '2026-10-26')`,
    );
    await sql.run(
      `INSERT INTO payroll_items (run_id, employee_id, employee_name, total_pay)
       VALUES ('PAY-DELETE-QA', :id, 'ลบทดสอบ ผู้ดูแล', 1200)`,
      { id: target.employee_id },
    );

    const response = await del(`/api/employees/${target.employee_id}?hard=true`);
    const employeeLeft = await scalar('SELECT count(*) AS n FROM employees WHERE employee_id = :id', { id: target.employee_id });
    const reviewLeft = await scalar('SELECT count(*) AS n FROM staff_reviews WHERE employee_id = :id', { id: target.employee_id });
    const assignment = await sql.one('SELECT assigned_to, status FROM cases WHERE case_id = :id', { id: caseRow.case_id });
    const payrollItem = await sql.one(`SELECT employee_id FROM payroll_items WHERE run_id = 'PAY-DELETE-QA'`);
    probe(
      response.status === 409 && employeeLeft === 1 && reviewLeft === 1 && assignment?.assigned_to === target.employee_id && payrollItem?.employee_id === target.employee_id,
      'ลบพนักงานที่มีเคสเปิด คะแนน และสลิปจ่ายแล้ว ทำให้หลักฐานกับผู้รับผิดชอบหลุด',
      `HTTP=${response.status} employee=${employeeLeft} reviews=${reviewLeft} case_assignee=${assignment?.assigned_to ?? 'NULL'} payroll_employee=${payrollItem?.employee_id ?? 'NULL'}`,
      'ลบถาวรพนักงานที่มีประวัติไม่ได้ และทุกความเชื่อมโยงยังอยู่ครบ',
    );

    const unused = nextEmployee();
    await addEmployee(unused);
    const unusedDelete = await del(`/api/employees/${unused.employee_id}?hard=true`);
    probe(
      unusedDelete.status === 204 && (await scalar('SELECT count(*) AS n FROM employees WHERE employee_id = :id', { id: unused.employee_id })) === 0,
      'พนักงานที่เพิ่งสร้างผิดและยังไม่มีประวัติลบถาวรไม่ได้',
      `HTTP=${unusedDelete.status} body=${brief(unusedDelete.body)}`,
      'พนักงานที่ไม่มีประวัติลบถาวรได้',
    );
  }

  head('2 · ลบเคสที่มีรายงาน รูป และญาติ');
  {
    const caseRow = await createCase();
    const draft = await invoiceForCase(caseRow.case_id);
    mustStatus(await del(`/api/invoices/${draft.invoice_id}`), 200, 'ลบใบร่างเพื่อแยกผลของรายงาน');
    const report = await sql.one(
      `INSERT INTO case_reports
         (case_id, report_date, pulse, wound_photo_data, wound_photo_mime, wound_photo_size, reported_by_name)
       VALUES (:case_id, '2026-10-26', 74, decode('AQID', 'base64'), 'image/png', 3, 'ผู้ดูแลทดสอบ')
       RETURNING report_id`,
      { case_id: caseRow.case_id },
    );
    await ensureFamilyTable();
    await sql.run(
      `INSERT INTO case_family_links
         (case_id, code_hash, code_expires_at, invited_by, consent_by, can_invite)
       VALUES (:case_id, :hash, now() + interval '7 days', 'ผู้จัดการ', 'ผู้แทนผู้รับบริการ', true)`,
      { case_id: caseRow.case_id, hash: randomUUID() },
    );

    const response = await del(`/api/cases/${caseRow.case_id}`);
    const caseLeft = await scalar('SELECT count(*) AS n FROM cases WHERE case_id = :id', { id: caseRow.case_id });
    const reportLeft = await scalar('SELECT count(*) AS n FROM case_reports WHERE report_id = :id', { id: report.report_id });
    const familyLeft = await scalar('SELECT count(*) AS n FROM case_family_links WHERE case_id = :id', { id: caseRow.case_id });
    probe(
      response.status === 409 && caseLeft === 1 && reportLeft === 1 && familyLeft === 1,
      'ลบเคสที่มีบันทึกการดูแล รูปแผล และญาติได้โดยคำเตือนไม่บอก ทำให้ข้อมูลหายตาม',
      `HTTP=${response.status} case=${caseLeft} report_with_photo=${reportLeft} family_link=${familyLeft}`,
      'ต้องยืนยัน force เมื่อเคสมีรายงาน รูป หรือญาติ และข้อมูลยังอยู่ก่อนยืนยัน',
    );

    if (caseLeft === 1) {
      const forced = await del(`/api/cases/${caseRow.case_id}?force=true`);
      probe(
        forced.status === 204,
        'ยืนยันลบเคสที่ยังไม่มีหลักฐานการเงินไม่ได้',
        `HTTP=${forced.status} body=${brief(forced.body)}`,
        'หลังรับรู้ผลกระทบแล้ว ผู้จัดการยืนยันลบเคสที่ไม่มีค่าจ้างได้',
      );
    } else {
      checks += 1;
      ok('ข้ามการยืนยัน force เพราะก่อนแก้เคสถูกลบเงียบไปแล้ว (ผลบัคถูกบันทึกแล้ว)');
    }

    const payoutCase = await createCase({ assigned_to: FIELD.employee_id, staff_pay: 900 });
    await sql.run(
      `INSERT INTO case_payouts (case_id, employee_id, employee_name, amount, released_by_name)
       VALUES (:case_id, :employee_id, 'พนักงานภาคสนาม', 900, 'ผู้จัดการ')`,
      { case_id: payoutCase.case_id, employee_id: FIELD.employee_id },
    );
    const payoutDelete = await del(`/api/cases/${payoutCase.case_id}?force=true`);
    probe(
      payoutDelete.status === 409 && (await scalar('SELECT count(*) AS n FROM case_payouts WHERE case_id = :id', { id: payoutCase.case_id })) === 1,
      'force ลบเคสที่ปล่อยค่าจ้างแล้วได้',
      `HTTP=${payoutDelete.status} body=${brief(payoutDelete.body)}`,
      'แม้ force ก็ลบเคสที่ปล่อยค่าจ้างแล้วไม่ได้',
    );
  }

  head('3 · ลบลูกค้า/ผู้รับบริการที่ยังใช้งาน');
  {
    const customer = await createCustomer();
    const patient = await createPatient({ customer_id: customer.customer_id });
    // เคสจริงบางชุดหาผู้ชำระจาก patients.customer_id โดยไม่ได้ใส่ cases.customer_id โดยตรง
    const caseRow = await createCase({ customer_id: null, patient_id: patient.patient_id });
    const invoice = await invoiceForCase(caseRow.case_id);
    await issueFull(invoice.invoice_id);

    const customerDelete = await del(`/api/customers/${customer.customer_id}`);
    const afterCustomer = await sql.one('SELECT customer_id, patient_id FROM cases WHERE case_id = :id', { id: caseRow.case_id });
    const patientCustomer = await sql.one('SELECT customer_id FROM patients WHERE patient_id = :id', { id: patient.patient_id });
    const invoiceCustomer = await sql.one('SELECT customer_id FROM invoices WHERE invoice_id = :id', { id: invoice.invoice_id });
    probe(
      customerDelete.status === 409 && afterCustomer?.patient_id === patient.patient_id && patientCustomer?.customer_id === customer.customer_id && invoiceCustomer?.customer_id === customer.customer_id,
      'ลบผู้ว่าจ้างระหว่างเคสเปิดและยังเก็บเงินไม่ครบ ทำให้เคสกับใบหลุดจากคนจ่าย',
      `HTTP=${customerDelete.status} case_customer=${afterCustomer?.customer_id ?? 'NULL'} patient_customer=${patientCustomer?.customer_id ?? 'NULL'} invoice_customer=${invoiceCustomer?.customer_id ?? 'NULL'}`,
      'ลบผู้ว่าจ้างที่มีเคสเปิดหรือใบค้างรับไม่ได้',
    );

    const patientDelete = await del(`/api/patients/${patient.patient_id}`);
    const afterPatient = await sql.one('SELECT patient_id FROM cases WHERE case_id = :id', { id: caseRow.case_id });
    probe(
      patientDelete.status === 409 && afterPatient?.patient_id === patient.patient_id,
      'ลบแฟ้มผู้รับบริการระหว่างเคสเปิด ทำให้ข้อมูลแพ้ยาที่หน้างานอ่านสดหายไป',
      `HTTP=${patientDelete.status} case_patient=${afterPatient?.patient_id ?? 'NULL'}`,
      'ลบแฟ้มผู้รับบริการที่มีเคสเปิดไม่ได้ ข้อมูลความปลอดภัยยังผูกอยู่',
    );

    const unusedCustomer = await createCustomer({ name: 'ลูกค้าเพิ่งสร้างผิด' });
    const unusedPatient = await createPatient({ name: 'ผู้รับบริการเพิ่งสร้างผิด' });
    const unusedResults = await Promise.all([
      del(`/api/customers/${unusedCustomer.customer_id}`),
      del(`/api/patients/${unusedPatient.patient_id}`),
    ]);
    probe(
      unusedResults.every((r) => r.status === 204),
      'แฟ้มลูกค้า/ผู้รับบริการที่ไม่มีงานผูกอยู่ลบไม่ได้',
      `HTTP=${unusedResults.map((r) => r.status).join(',')}`,
      'แฟ้มที่เพิ่งสร้างผิดและไม่มีงานผูกอยู่ลบได้',
    );
  }

  head('4 · ลบใบแจ้งหนี้และแผนมัดจำ');
  {
    const paidCase = await createCase({ fee: 1800 });
    const paidInvoice = await invoiceForCase(paidCase.case_id);
    await issueFull(paidInvoice.invoice_id);
    mustStatus(
      await post(`/api/invoices/${paidInvoice.invoice_id}/pay`, { request_id: randomUUID(), amount: 1800 }),
      200,
      'รับชำระใบเต็ม',
    );
    const paidDelete = await del(`/api/invoices/${paidInvoice.invoice_id}`);
    probe(
      paidDelete.status === 409 && (await scalar('SELECT count(*) AS n FROM invoice_payments WHERE invoice_id = :id', { id: paidInvoice.invoice_id })) === 1,
      'ลบใบที่รับเงินแล้วทำให้รายการรับเงินจริงหาย',
      `HTTP=${paidDelete.status} body=${brief(paidDelete.body)}`,
      'ลบใบที่รับเงินจริงแล้วไม่ได้ และรายการรับเงินยังอยู่',
    );

    const planCase = await createCase({ fee: 2000 });
    const planRoot = await invoiceForCase(planCase.case_id);
    const planned = mustStatus(
      await post(`/api/invoices/${planRoot.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 500 }),
      200,
      'สร้างแผนมัดจำ',
    );
    const planRows = await sql.all(
      `SELECT invoice_id FROM invoices
       WHERE invoice_id = :id OR parent_invoice_id = :id
       ORDER BY invoice_id`,
      { id: planned.invoice_id },
    );
    const planIds = planRows.map((row) => row.invoice_id);
    assert.equal(planIds.length, 2, `แผนมัดจำต้องมี 2 ใบ: ${brief(planned)}`);
    const planDelete = await del(`/api/invoices/${planRoot.invoice_id}`);
    probe(
      planDelete.status === 200 && (await scalar('SELECT count(*) AS n FROM invoices WHERE invoice_id = ANY(:ids::text[])', { ids: planIds })) === 0,
      'ลบงวดหนึ่งของแผนมัดจำแล้วเหลืออีกงวดเป็นใบกำพร้า',
      `HTTP=${planDelete.status} deleted=${brief(planDelete.body)}`,
      'ลบแผนมัดจำที่ยังไม่รับเงินเป็นทั้งแผน ไม่เหลือใบกำพร้า',
    );

    const customer = await createCustomer({ name: 'ลูกค้ารับลิงก์ใบแจ้งหนี้' });
    const sharedCase = await createCase({ customer_id: customer.customer_id, fee: 3200 });
    const sharedInvoice = await invoiceForCase(sharedCase.case_id);
    await issueFull(sharedInvoice.invoice_id);
    // GET สร้างคอลัมน์ LINE แบบ lazy แล้วจึงจำลองลูกค้าที่เชื่อม OA ในฐานชั่วคราว
    mustStatus(await get(`/api/invoices/${sharedInvoice.invoice_id}/line`), 200, 'เตรียมตารางส่ง LINE');
    await sql.run(
      `UPDATE customers SET line_user_id = 'U-DELETE-QA', chat_conversation_id = 9282 WHERE customer_id = :id`,
      { id: customer.customer_id },
    );
    const sent = await post(`/api/invoices/${sharedInvoice.invoice_id}/line`, {});
    mustStatus(sent, 201, 'ส่งลิงก์ใบให้ลูกค้า');
    await ensureShareTables();
    const sharedDelete = await del(`/api/invoices/${sharedInvoice.invoice_id}`);
    const invoiceLeft = await scalar('SELECT count(*) AS n FROM invoices WHERE invoice_id = :id', { id: sharedInvoice.invoice_id });
    const shareLeft = await scalar('SELECT count(*) AS n FROM invoice_shares WHERE invoice_id = :id', { id: sharedInvoice.invoice_id });
    const outboxLeft = await scalar('SELECT count(*) AS n FROM invoice_line_outbox WHERE invoice_id = :id', { id: sharedInvoice.invoice_id });
    probe(
      sharedDelete.status === 409 && invoiceLeft === 1 && shareLeft > 0 && outboxLeft > 0,
      'ลบใบที่ส่งให้ลูกค้าแล้วทำให้ลิงก์เอกสารและคิวส่งหายทันที',
      `HTTP=${sharedDelete.status} invoice=${invoiceLeft} share=${shareLeft} outbox=${outboxLeft}`,
      'ใบที่ออกลิงก์ให้ลูกค้าแล้วลบถาวรไม่ได้ ลิงก์และคิวยังอยู่',
    );
  }

  head('5 · ยิงลบพร้อมกันและสิทธิ์');
  {
    const unused = await createCustomer({ name: 'ลูกค้ากดย้ำสองครั้ง' });
    const race = await Promise.all([
      del(`/api/customers/${unused.customer_id}`),
      del(`/api/customers/${unused.customer_id}`),
    ]);
    probe(
      race.every((r) => r.status < 500) && (await scalar('SELECT count(*) AS n FROM customers WHERE customer_id = :id', { id: unused.customer_id })) === 0,
      'ยิงลบของชิ้นเดียวพร้อมกันทำให้ระบบ 500 หรือเหลือข้อมูลครึ่งทาง',
      `HTTP=${race.map((r) => r.status).join(',')}`,
      'ยิงลบของชิ้นเดียวพร้อมกันไม่ 500 และเหลือผลลัพธ์เดียวคือลบแล้ว',
    );

    const parent = await createCustomer({ name: 'ผู้ว่าจ้างลบพร้อมแฟ้มผู้รับบริการ' });
    const child = await createPatient({ customer_id: parent.customer_id });
    const familyRace = await Promise.all([
      del(`/api/customers/${parent.customer_id}`),
      del(`/api/patients/${child.patient_id}`),
    ]);
    probe(
      familyRace.every((r) => r.status < 500) &&
        (await scalar('SELECT count(*) AS n FROM patients WHERE customer_id = :id', { id: parent.customer_id })) === 0,
      'ยิงลบข้อมูลแม่กับลูกพร้อมกันทำให้ 500 หรือเหลือ foreign key กำพร้า',
      `HTTP=${familyRace.map((r) => r.status).join(',')}`,
      'ยิงลบแฟ้มแม่กับลูกที่ไม่มีงานพร้อมกันไม่ 500 และไม่เหลือ foreign key กำพร้า',
    );

    const higher = nextEmployee('manager');
    await addEmployee(higher);
    const privilege = await Promise.all([
      del(`/api/employees/${higher.employee_id}?hard=true`, HR),
      del(`/api/employees/${higher.employee_id}?hard=true`, ADMIN),
      del(`/api/customers/CU-DOES-NOT-EXIST`, FIELD),
    ]);
    probe(
      privilege[0].status === 403 && privilege[1].status === 403 && privilege[2].status === 403,
      'HR/Admin HC ลบพนักงานระดับผู้จัดการ หรือภาคสนามเรียกเส้นลบหลังบ้านได้',
      `HTTP HR→manager=${privilege[0].status} Admin→manager=${privilege[1].status} field→customer=${privilege[2].status}`,
      'HR/Admin HC ลบผู้จัดการไม่ได้ และภาคสนามเข้าเส้นลบแฟ้มไม่ได้',
    );
  }

  console.log(`\n=== สรุป: ${checks} จุด · พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${passed.length} จุด ===`);
  for (const item of found) console.log(`- ${item.title}: ${item.detail}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
