/**
 * QA รอบ 18 — แฟ้มลูกค้าและผู้ป่วย
 *
 * ตรวจสายผู้จ่ายทั้งเส้น: เคส -> ผู้ว่าจ้างของเคส -> ผู้ว่าจ้างในแฟ้มผู้ป่วย -> snapshot บนใบแจ้งหนี้
 * รันบน PostgreSQL ชั่วคราว + Express จริง + HTTP จริงทุกข้อ:
 *   node test/_run_probe.mjs test/_qa_people_20261026.mjs
 *
 * ชุดนี้ไม่แก้ source และไม่ต่อฐานจริง กระบวนการสร้าง actor เพิ่ม/ล้างข้อมูลแต่ละหัวข้อเกิดในฐานชั่วคราวเท่านั้น
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
  employee_id: 'EMP-9181', position: 'admin',
  first_name: 'Admin', last_name: 'PeopleQA',
};
const FINANCE = {
  employee_id: 'EMP-9182', position: 'finance',
  first_name: 'Finance', last_name: 'PeopleQA',
};
const FIELD_B = {
  employee_id: 'EMP-9183', position: 'caregiver',
  first_name: 'FieldB', last_name: 'PeopleQA',
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

// นักแสดงทุกคนต้องพ้นด่านรหัสชั่วคราวก่อน มิฉะนั้นทุกเส้นตอบ 403 แล้วกลบผลเรื่องสิทธิ์จริง
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

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, { body, who = MANAGER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...jar(who),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}
const get = (path, who) => call('GET', path, { who });
const post = (path, body, who) => call('POST', path, { body: body ?? {}, who });
const patch = (path, body, who) => call('PATCH', path, { body: body ?? {}, who });
const del = (path, who) => call('DELETE', path, { who });

let checks = 0;
const found = [];
const passed = [];
const observations = [];
const head = (title) => console.log(`\n=== ${title} ===`);
const brief = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 900 ? `${text.slice(0, 900)}...` : text;
};
const hit = (title, detail) => {
  found.push({ title, detail });
  console.log(`BUG | ${title}\nRESULT | ${detail}`);
};
const ok = (what) => {
  passed.push(what);
  console.log(`PASS | ${what}`);
};
const info = (what) => {
  observations.push(what);
  console.log(`INFO | ${what}`);
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

let patientNo = 690300000;
let caseNo = 690400000;
const nextPatientId = () => `KN${++patientNo}`;
const nextCaseId = () => `VN${++caseNo}`;

async function resetTopic() {
  // ล้างของหัวข้อก่อนหน้าให้หมดก่อนขึ้นหัวข้อใหม่ แต่เก็บ actor ที่ใช้ยิงสิทธิ์ไว้
  await sql.run('DELETE FROM invoices');
  await sql.run('DELETE FROM cases');
  await sql.run('DELETE FROM patients');
  await sql.run('DELETE FROM customers');
}

async function createCustomer(input = {}) {
  const response = await post('/api/customers', { name: 'ผู้ว่าจ้างทดสอบ', ...input });
  return { response, row: response.body };
}

async function createPatient(input = {}) {
  const response = await post('/api/patients', {
    patient_id: nextPatientId(),
    name: 'ผู้รับการดูแลทดสอบ',
    ...input,
  });
  return { response, row: response.body };
}

async function createCase(input = {}) {
  const response = await post('/api/cases', {
    case_id: nextCaseId(),
    client_name: 'ผู้รับการดูแลในเคส',
    fee: 2500,
    ...input,
  });
  return { response, row: response.body };
}

async function invoiceForCase(caseId) {
  const response = await get(`/api/invoices?case_id=${encodeURIComponent(caseId)}&per_page=100`);
  mustStatus(response, 200, `โหลดใบของเคส ${caseId}`);
  assert.equal(response.body.data.length, 1, `เคส ${caseId} ต้องมีใบร่างอัตโนมัติหนึ่งใบ: ${brief(response.body)}`);
  return response.body.data[0];
}

async function issueInvoice(invoiceId) {
  const plan = await post(`/api/invoices/${invoiceId}/billing-plan`, { mode: 'full' });
  mustStatus(plan, 200, `เลือกเก็บเต็มจำนวน ${invoiceId}`);
  const issued = await post(`/api/invoices/${invoiceId}/issue`);
  mustStatus(issued, 200, `ออกใบ ${invoiceId}`);
  return issued.body;
}

function forbiddenKeys(value, forbidden, path = '$') {
  const hits = [];
  if (!value || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...forbiddenKeys(item, forbidden, `${path}[${i}]`)));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) hits.push(`${path}.${key}`);
    hits.push(...forbiddenKeys(child, forbidden, `${path}.${key}`));
  }
  return hits;
}

const containsRow = (page, field, value) =>
  Array.isArray(page?.data) && page.data.some((row) => row?.[field] === value);

try {
  // ---------------------------------------------------------------------------
  head('1 · ข้อมูลซ้ำและสองหน้าจอสร้างพร้อมกัน');
  await resetTopic();
  {
    const indexes = await sql.all(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE indexname IN ('idx_customers_national_id', 'idx_patients_national_id')
       ORDER BY indexname`,
    );
    probe(
      indexes.length === 2 && indexes.every((row) => /UNIQUE/i.test(row.indexdef) && /WHERE \(national_id IS NOT NULL\)/i.test(row.indexdef)),
      'ฐานไม่มี unique index กันเลขบัตรซ้ำครบทั้งสองแฟ้ม',
      brief(indexes),
      'customers และ patients มี partial unique index กันเลขบัตรซ้ำเมื่อกรอกเลขบัตร',
    );

    // ชื่อและเบอร์ไม่ใช่ตัวระบุที่เชื่อถือได้ (คนในบ้านใช้เบอร์เดียวกันได้) จึงสำรวจไว้ แต่ไม่เสนอให้บล็อก
    const sameContact = await Promise.all([
      post('/api/customers', { name: 'สมชาย บ้านเดียวกัน', phone: '081-222-3333' }),
      post('/api/customers', { name: 'สมชาย บ้านเดียวกัน', phone: '081-222-3333' }),
    ]);
    info(
      sameContact.every((r) => r.status === 201)
        ? 'ชื่อ+เบอร์เดียวกันแต่ไม่มีเลขบัตรสร้างพร้อมกันได้ 2 แฟ้ม — ยังไม่จัดเป็นบัค; หากต้องช่วยกันกรอกซ้ำควร “เตือน” ไม่ควรบล็อก'
        : `ชื่อ+เบอร์ซ้ำได้สถานะ ${sameContact.map((r) => r.status).join(', ')}`,
    );

    const customerNationalId = '1101700203001';
    const customerRace = await Promise.all([
      post('/api/customers', { name: 'ลูกค้าซ้ำหน้าจอ A', phone: '0811111111', national_id: customerNationalId }),
      post('/api/customers', { name: 'ลูกค้าซ้ำหน้าจอ B', phone: '0811111111', national_id: customerNationalId }),
    ]);
    const customerStatuses = customerRace.map((r) => r.status).sort((a, b) => a - b);
    const customerCount = await sql.one(
      'SELECT COUNT(*) AS n FROM customers WHERE national_id = :national_id',
      { national_id: customerNationalId },
    );
    probe(
      customerStatuses.join(',') === '201,409' && Number(customerCount.n) === 1,
      'สองหน้าจอสร้างลูกค้าเลขบัตรเดียวกันผ่านมากกว่าหนึ่งแฟ้ม',
      `statuses=${customerStatuses.join(',')} rows=${customerCount.n}`,
      'คำขอสร้างลูกค้าเลขบัตรเดียวกันพร้อมกัน รอดหนึ่งคำขอและอีกคำขอได้ 409 เหลือจริงหนึ่งแถว',
    );

    const patientNationalId = '1101700203002';
    const patientRace = await Promise.all([
      post('/api/patients', { patient_id: nextPatientId(), name: 'ผู้ป่วยซ้ำ A', national_id: patientNationalId }),
      post('/api/patients', { patient_id: nextPatientId(), name: 'ผู้ป่วยซ้ำ B', national_id: patientNationalId }),
    ]);
    const patientStatuses = patientRace.map((r) => r.status).sort((a, b) => a - b);
    const patientCount = await sql.one(
      'SELECT COUNT(*) AS n FROM patients WHERE national_id = :national_id',
      { national_id: patientNationalId },
    );
    probe(
      patientStatuses.join(',') === '201,409' && Number(patientCount.n) === 1,
      'สองหน้าจอสร้างผู้ป่วยเลขบัตรเดียวกันผ่านมากกว่าหนึ่งแฟ้ม',
      `statuses=${patientStatuses.join(',')} rows=${patientCount.n}`,
      'คำขอสร้างผู้ป่วยเลขบัตรเดียวกันพร้อมกัน รอดหนึ่งคำขอและอีกคำขอได้ 409 เหลือจริงหนึ่งแถว',
    );

    const patientConflict = patientRace.find((r) => r.status === 409);
    probe(
      patientConflict && !/พนักงาน/.test(patientConflict.body?.error ?? ''),
      'ข้อความเลขบัตรผู้ป่วยซ้ำชี้ว่าไปชนกับพนักงาน',
      `POST /api/patients ตอบ ${brief(patientConflict?.body)}`,
      'ข้อความชนเลขบัตรของผู้ป่วยไม่ชี้ผิดไปเป็นแฟ้มพนักงาน',
    );

    const samePatientName = await Promise.all([
      post('/api/patients', { patient_id: nextPatientId(), name: 'ชื่อผู้ป่วยเหมือนกัน' }),
      post('/api/patients', { patient_id: nextPatientId(), name: 'ชื่อผู้ป่วยเหมือนกัน' }),
    ]);
    info(
      samePatientName.every((r) => r.status === 201)
        ? 'ชื่อผู้ป่วยเดียวกันแต่ไม่มีเลขบัตรสร้างพร้อมกันได้ 2 แฟ้ม — ชื่อไม่ใช่ตัวระบุเอกลักษณ์ จึงบันทึกเป็นพฤติกรรม ไม่ตัดสินเป็นบัค'
        : `ผู้ป่วยชื่อซ้ำได้สถานะ ${samePatientName.map((r) => r.status).join(', ')}`,
    );
  }

  // ---------------------------------------------------------------------------
  head('2 · แฟ้มที่กำลังใช้งานต้องลบไม่ได้; งานจบและเก็บเงินแล้วจึงลบแบบ SET NULL ได้');
  await resetTopic();
  {
    const customer = (await createCustomer({
      name: 'บริษัท ผู้จ่ายเดิม จำกัด',
      phone: '0813334444',
      national_id: '1101700203101',
      tax_id: '0105566000101',
      address: '11 ถนนหลัก',
      billing_address: '99 ที่อยู่ออกบิล',
    }));
    mustStatus(customer.response, 201, 'สร้างลูกค้าสำหรับทดสอบลบ');
    const patient = await createPatient({
      name: 'คุณผู้ป่วยที่ยังมีเคส',
      customer_id: customer.row.customer_id,
      national_id: '1101700203102',
    });
    mustStatus(patient.response, 201, 'สร้างผู้ป่วยสำหรับทดสอบลบ');
    const caseResult = await createCase({
      client_name: patient.row.name,
      customer_id: customer.row.customer_id,
      patient_id: patient.row.patient_id,
      fee: 7800,
    });
    mustStatus(caseResult.response, 201, 'เปิดเคสที่ผูกทั้งลูกค้าและผู้ป่วย');
    const invoice = await invoiceForCase(caseResult.row.case_id);
    const issued = await issueInvoice(invoice.invoice_id);
    const snapshot = {
      name: issued.bill_to_name,
      tax: issued.bill_to_tax_id,
      address: issued.bill_to_address,
      total: Number(issued.total),
    };

    const blockedCustomer = await del(`/api/customers/${customer.row.customer_id}`);
    const blockedPatient = await del(`/api/patients/${patient.row.patient_id}`);
    probe(
      blockedCustomer.status === 409 && blockedPatient.status === 409,
      'ลบลูกค้า/ผู้ป่วยระหว่างเคสเปิดหรือยังเก็บเงินไม่ครบได้ ทำให้ข้อมูลที่กำลังใช้หลุด',
      `customer=${blockedCustomer.status}/${brief(blockedCustomer.body)} patient=${blockedPatient.status}/${brief(blockedPatient.body)}`,
      'ระหว่างเคสเปิดและใบยังค้างรับ ลบทั้งผู้จ่ายและแฟ้มผู้ป่วยไม่ได้',
    );

    const paid = await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: randomUUID() });
    mustStatus(paid, 200, 'รับชำระใบให้ครบก่อนลบแฟ้มประวัติ');
    const closed = await post(`/api/cases/${caseResult.row.case_id}/close`, {});
    mustStatus(closed, 200, 'ปิดเคสก่อนลบแฟ้มประวัติ');

    const removedCustomer = await del(`/api/customers/${customer.row.customer_id}`);
    probe(
      removedCustomer.status === 204,
      'งานจบและเก็บเงินครบแล้ว แต่ลบแฟ้มลูกค้าเก่าไม่ได้',
      `DELETE /api/customers/:id -> ${removedCustomer.status} ${brief(removedCustomer.body)}`,
      'งานจบและเก็บเงินครบแล้ว ลบแฟ้มลูกค้าได้ โดยประวัติลูกยังอยู่ผ่าน FK SET NULL',
    );

    const patientAfterCustomerDelete = await get(`/api/patients/${patient.row.patient_id}`);
    const caseAfterCustomerDelete = await get(`/api/cases/${caseResult.row.case_id}`);
    const invoiceAfterCustomerDelete = await get(`/api/invoices/${invoice.invoice_id}`);
    probe(
      patientAfterCustomerDelete.status === 200 && patientAfterCustomerDelete.body.customer_id === null &&
        caseAfterCustomerDelete.status === 200 && caseAfterCustomerDelete.body.customer_id === null &&
        invoiceAfterCustomerDelete.status === 200 && invoiceAfterCustomerDelete.body.customer_id === null,
      'ลบลูกค้าแล้วมีแถวลูกค้างกำพร้าหรือ FK ไม่ถูกตัดครบ',
      `patient.customer_id=${patientAfterCustomerDelete.body?.customer_id} ` +
        `case.customer_id=${caseAfterCustomerDelete.body?.customer_id} ` +
        `invoice.customer_id=${invoiceAfterCustomerDelete.body?.customer_id}`,
      'ลบลูกค้าแล้ว patients.customer_id, cases.customer_id และ invoices.customer_id เป็น null โดยแถวลูกไม่หาย',
    );
    probe(
      invoiceAfterCustomerDelete.body?.bill_to_name === snapshot.name &&
        invoiceAfterCustomerDelete.body?.bill_to_tax_id === snapshot.tax &&
        invoiceAfterCustomerDelete.body?.bill_to_address === snapshot.address &&
        Number(invoiceAfterCustomerDelete.body?.total) === snapshot.total,
      'ลบแฟ้มลูกค้าแล้วข้อมูลบนใบที่ออกไปแล้วหายหรือเปลี่ยน',
      `ก่อน=${brief(snapshot)} หลัง=${brief(invoiceAfterCustomerDelete.body)}`,
      'ชื่อ/เลขผู้เสียภาษี/ที่อยู่/ยอดบนใบที่ออกแล้วเป็น snapshot และยังอยู่ครบหลังลบลูกค้า',
    );

    const removedPatient = await del(`/api/patients/${patient.row.patient_id}`);
    const caseAfterPatientDelete = await get(`/api/cases/${caseResult.row.case_id}`);
    const invoiceAfterPatientDelete = await get(`/api/invoices/${invoice.invoice_id}`);
    probe(
      removedPatient.status === 204 && caseAfterPatientDelete.body?.patient_id === null,
      'ลบผู้ป่วยที่มีเคสผูกอยู่ไม่ได้ หรือ cases.patient_id ไม่ถูก SET NULL',
      `DELETE=${removedPatient.status} case.patient_id=${caseAfterPatientDelete.body?.patient_id}`,
      'ลบแฟ้มผู้ป่วยได้ เคสเก่ายังอยู่และ cases.patient_id ถูก SET NULL',
    );
    probe(
      invoiceAfterPatientDelete.status === 200 && invoiceAfterPatientDelete.body?.bill_to_name === snapshot.name,
      'ลบแฟ้มผู้ป่วยแล้วใบการเงินเก่าหายหรือชื่อผู้จ่ายกลายเป็น null',
      brief(invoiceAfterPatientDelete.body),
      'ลบผู้ป่วยแล้วใบที่ออกไปแล้วยังเปิดได้และชื่อผู้จ่ายไม่หาย',
    );
  }

  // ---------------------------------------------------------------------------
  head('3 · เปลี่ยนผู้ว่าจ้างกลางคัน — ใบร่างต้องตาม ใบที่ออกแล้วต้องคง snapshot');
  await resetTopic();
  {
    const payerA = await createCustomer({
      name: 'ผู้ว่าจ้างบ้าน A', tax_id: '0105566000201', billing_address: 'บ้าน A',
    });
    const payerB = await createCustomer({
      name: 'ผู้ว่าจ้างบ้าน B', tax_id: '0105566000202', billing_address: 'บ้าน B',
    });
    mustStatus(payerA.response, 201, 'สร้างผู้จ่าย A');
    mustStatus(payerB.response, 201, 'สร้างผู้จ่าย B');

    const draftPatient = await createPatient({ name: 'ผู้ป่วยย้ายบ้านใบร่าง', customer_id: payerA.row.customer_id });
    mustStatus(draftPatient.response, 201, 'สร้างผู้ป่วยสำหรับใบร่าง');
    const draftCase = await createCase({
      client_name: draftPatient.row.name,
      patient_id: draftPatient.row.patient_id,
      customer_id: null,
      fee: 5000,
    });
    mustStatus(draftCase.response, 201, 'เปิดเคสที่หาผู้จ่ายผ่านแฟ้มผู้ป่วย');
    const draftInvoice = await invoiceForCase(draftCase.row.case_id);
    probe(
      draftInvoice.bill_to_name === payerA.row.name && draftInvoice.customer_id === payerA.row.customer_id,
      'เคสไม่มีผู้ว่าจ้างของตัวเองแล้วใบร่างไม่ไล่ไปหาผู้จ่ายจากแฟ้มผู้ป่วย',
      `bill_to=${draftInvoice.bill_to_name} customer_id=${draftInvoice.customer_id}`,
      'ใบร่างเริ่มต้นไล่ผู้จ่ายจากแฟ้มผู้ป่วยได้เป็นบ้าน A',
    );

    const moveDraft = await patch(`/api/patients/${draftPatient.row.patient_id}`, { customer_id: payerB.row.customer_id });
    mustStatus(moveDraft, 200, 'ย้ายผู้ป่วยใบร่างไปผู้จ่าย B');
    const movedDraftInvoice = await get(`/api/invoices/${draftInvoice.invoice_id}`);
    const movedDraftCase = await get(`/api/cases/${draftCase.row.case_id}`);
    probe(
      movedDraftInvoice.body?.bill_to_name === payerB.row.name &&
        movedDraftInvoice.body?.customer_id === payerB.row.customer_id &&
        movedDraftCase.body?.customer_id === payerB.row.customer_id,
      'ย้ายผู้ป่วยแล้วใบร่างยังชี้ผู้จ่ายบ้านเดิม',
      `case.customer_id=${movedDraftCase.body?.customer_id} ` +
        `invoice.customer_id=${movedDraftInvoice.body?.customer_id} bill_to=${movedDraftInvoice.body?.bill_to_name}`,
      'ย้ายผู้ป่วยแล้วเคสที่ยังไม่มีผู้จ่ายและใบร่างขยับไปผู้จ่ายใหม่พร้อมกัน',
    );

    const issuedPatient = await createPatient({ name: 'ผู้ป่วยย้ายบ้านใบออกแล้ว', customer_id: payerA.row.customer_id });
    mustStatus(issuedPatient.response, 201, 'สร้างผู้ป่วยสำหรับใบออกแล้ว');
    const issuedCase = await createCase({
      client_name: issuedPatient.row.name,
      patient_id: issuedPatient.row.patient_id,
      customer_id: null,
      fee: 6200,
    });
    mustStatus(issuedCase.response, 201, 'เปิดเคสสำหรับใบออกแล้ว');
    const issuedInvoice = await invoiceForCase(issuedCase.row.case_id);
    const issuedBeforeMove = await issueInvoice(issuedInvoice.invoice_id);
    probe(
      issuedBeforeMove.bill_to_name === payerA.row.name && issuedBeforeMove.customer_id === payerA.row.customer_id,
      'ใบที่ออกไม่ใช้ผู้จ่ายจากแฟ้มผู้ป่วยตั้งแต่ต้น',
      `bill_to=${issuedBeforeMove.bill_to_name} customer_id=${issuedBeforeMove.customer_id}`,
      'ก่อนย้ายผู้ป่วย ใบที่ออกใช้ snapshot ผู้จ่ายบ้าน A ถูกคน',
    );

    const moveIssued = await patch(`/api/patients/${issuedPatient.row.patient_id}`, { customer_id: payerB.row.customer_id });
    mustStatus(moveIssued, 200, 'ย้ายผู้ป่วยหลังออกใบ');
    const issuedAfterMove = await get(`/api/invoices/${issuedInvoice.invoice_id}`);
    probe(
      issuedAfterMove.body?.bill_to_name === payerA.row.name &&
        issuedAfterMove.body?.bill_to_tax_id === payerA.row.tax_id &&
        issuedAfterMove.body?.bill_to_address === payerA.row.billing_address,
      'เปลี่ยนผู้ว่าจ้างแล้วใบที่ออกไปแล้วเปลี่ยนชื่อ/ข้อมูลผู้จ่ายตาม',
      `ก่อนออกใบ=${payerA.row.name}/${payerA.row.tax_id}/${payerA.row.billing_address} ` +
        `หลังย้าย=${issuedAfterMove.body?.bill_to_name}/${issuedAfterMove.body?.bill_to_tax_id}/${issuedAfterMove.body?.bill_to_address} ` +
        `status=${issuedAfterMove.body?.status}`,
      'ใบที่ออกแล้วคง snapshot ผู้จ่ายเดิม แม้ย้ายผู้ป่วยไปผู้ว่าจ้างใหม่',
    );

    const paidPatient = await createPatient({ name: 'ผู้ป่วยย้ายบ้านใบจ่ายแล้ว', customer_id: payerA.row.customer_id });
    mustStatus(paidPatient.response, 201, 'สร้างผู้ป่วยสำหรับใบชำระแล้ว');
    const paidCase = await createCase({
      client_name: paidPatient.row.name,
      patient_id: paidPatient.row.patient_id,
      customer_id: null,
      fee: 4300,
    });
    mustStatus(paidCase.response, 201, 'เปิดเคสสำหรับใบชำระแล้ว');
    const paidInvoice = await invoiceForCase(paidCase.row.case_id);
    await issueInvoice(paidInvoice.invoice_id);
    const paid = await post(`/api/invoices/${paidInvoice.invoice_id}/pay`, { request_id: randomUUID() });
    mustStatus(paid, 200, 'รับชำระใบก่อนย้ายผู้จ่าย');
    const movePaid = await patch(`/api/patients/${paidPatient.row.patient_id}`, { customer_id: payerB.row.customer_id });
    mustStatus(movePaid, 200, 'ย้ายผู้ป่วยหลังชำระ');
    const paidAfterMove = await get(`/api/invoices/${paidInvoice.invoice_id}`);
    probe(
      paidAfterMove.body?.status === 'paid' && paidAfterMove.body?.bill_to_name === payerA.row.name,
      'ใบที่ชำระแล้วไหลตามผู้ว่าจ้างใหม่',
      brief(paidAfterMove.body),
      'ใบที่ชำระแล้วคงชื่อผู้จ่ายเดิมหลังย้ายผู้ป่วย',
    );
  }

  // ---------------------------------------------------------------------------
  head('4 · สิทธิ์และข้อมูลส่วนบุคคลรั่วข้ามบทบาท');
  await resetTopic();
  {
    const customer = await createCustomer({
      name: 'ผู้ว่าจ้างข้อมูลอ่อนไหว',
      phone: '081-987-6543',
      home_phone: '02-222-3333',
      email: 'private@example.invalid',
      national_id: '1101700203201',
      tax_id: '0105566000301',
      address: 'บ้านเลขที่ลับ 123',
      billing_address: 'ที่อยู่ออกบิลลับ 456',
    });
    mustStatus(customer.response, 201, 'สร้างลูกค้าข้อมูลอ่อนไหว');
    const patient = await createPatient({
      name: 'ผู้ป่วยข้อมูลอ่อนไหว',
      customer_id: customer.row.customer_id,
      national_id: '1101700203202',
      address: 'สถานที่ดูแล 789',
      medical_history: 'โรคประจำตัวทดสอบ',
      allergies: 'แพ้ยาทดสอบ',
      emergency_contact_phone: '089-111-2222',
    });
    mustStatus(patient.response, 201, 'สร้างผู้ป่วยข้อมูลอ่อนไหว');
    const caseResult = await createCase({
      client_name: patient.row.name,
      client_phone: customer.row.phone,
      address: patient.row.address,
      medical_history: patient.row.medical_history,
      customer_id: customer.row.customer_id,
      patient_id: patient.row.patient_id,
      assigned_to: FIELD.employee_id,
      fee: 9000,
    });
    mustStatus(caseResult.response, 201, 'เปิดเคสให้พนักงานภาคสนาม');
    const invoice = await invoiceForCase(caseResult.row.case_id);

    for (const [label, who] of [['การเงิน', FINANCE], ['พนักงานภาคสนาม', FIELD]]) {
      const customerList = await get('/api/customers?per_page=100', who);
      const patientList = await get('/api/patients?per_page=100', who);
      probe(
        customerList.status === 403 && patientList.status === 403,
        `${label}เปิดแฟ้มลูกค้า/ผู้ป่วยได้`,
        `customers=${customerList.status} patients=${patientList.status}`,
        `${label}ถูกกันจาก /api/customers และ /api/patients (403)`,
      );
    }

    const fieldCases = await get('/api/cases?per_page=100', FIELD);
    const fieldInvoices = await get('/api/invoices?per_page=100', FIELD);
    probe(
      fieldCases.status === 403 && fieldInvoices.status === 403,
      'พนักงานภาคสนามเปิดรายการเคสหลังบ้านหรือใบแจ้งหนี้ได้',
      `cases=${fieldCases.status} invoices=${fieldInvoices.status}`,
      'พนักงานภาคสนามถูกกันจากรายการเคสหลังบ้านและใบแจ้งหนี้ (403)',
    );

    const myCase = await get(`/api/my/cases/${caseResult.row.case_id}`, FIELD);
    mustStatus(myCase, 200, 'พนักงานเจ้าของงานเปิดเคสของตน');
    const sensitiveKeys = new Set([
      'national_id', 'tax_id', 'bill_to_tax_id', 'billing_address',
      'email', 'home_phone', 'emergency_contact_phone',
    ]);
    const leaked = forbiddenKeys(myCase.body, sensitiveKeys);
    probe(
      leaked.length === 0 && myCase.body?.client_phone === customer.row.phone && myCase.body?.address === patient.row.address,
      'เส้นภาคสนามส่งเลขบัตร/เลขภาษี/ข้อมูลติดต่อที่ไม่จำเป็นออกไป',
      `พบฟิลด์=${leaked.join(', ') || '-'} client_phone=${myCase.body?.client_phone} address=${myCase.body?.address}`,
      'พนักงานเจ้าของเคสเห็นเบอร์และสถานที่ดูแลที่ต้องใช้ทำงาน แต่ไม่เห็นเลขบัตร/เลขภาษี/อีเมล/ที่อยู่ออกบิล',
    );

    const otherField = await get(`/api/my/cases/${caseResult.row.case_id}`, FIELD_B);
    probe(
      otherField.status === 404,
      'พนักงานภาคสนามคนอื่นเปิดข้อมูลผู้ป่วยของเคสที่ไม่เกี่ยวข้องได้',
      `GET /api/my/cases/:id -> ${otherField.status} ${brief(otherField.body)}`,
      'พนักงานภาคสนามที่ไม่เกี่ยวข้องกับเคสได้ 404 และไม่รู้ว่าเคสมีอยู่จริง',
    );

    const financeInvoice = await get(`/api/invoices/${invoice.invoice_id}`, FINANCE);
    probe(
      financeInvoice.status === 200 && financeInvoice.body?.bill_to_tax_id === customer.row.tax_id &&
        financeInvoice.body?.bill_to_address === customer.row.billing_address,
      'การเงินเปิดข้อมูลผู้จ่ายที่จำเป็นบนใบแจ้งหนี้ไม่ได้',
      `${financeInvoice.status} ${brief(financeInvoice.body)}`,
      'การเงินเห็นเลขผู้เสียภาษีและที่อยู่ออกบิลผ่านใบแจ้งหนี้ แต่เปิดแฟ้มคนทั้งก้อนไม่ได้',
    );

    for (const [label, who] of [['HR', HR], ['Admin HC', ADMIN]]) {
      const customerDetail = await get(`/api/customers/${customer.row.customer_id}`, who);
      const patientDetail = await get(`/api/patients/${patient.row.patient_id}`, who);
      probe(
        customerDetail.status === 200 && patientDetail.status === 200 &&
          customerDetail.body?.national_id === customer.row.national_id &&
          patientDetail.body?.national_id === patient.row.national_id,
        `${label}อ่านแฟ้มที่บทบาท office ต้องดูแลไม่ได้`,
        `customer=${customerDetail.status} patient=${patientDetail.status}`,
        `${label} (สิทธิ์ office) เปิดรายละเอียดลูกค้าและผู้ป่วยได้ตามกติกาปัจจุบัน`,
      );
    }
    info('ขอบเขตปัจจุบันของ HR/Admin HC คือเห็นแฟ้มเต็ม รวมที่อยู่ เบอร์ และเลขบัตร; ชุดนี้บันทึกข้อเท็จจริง ไม่ลดสิทธิ์แทนธุรกิจ');
  }

  // ---------------------------------------------------------------------------
  head('5 · ค่าที่กรอกผิดรูปและวันเกิด');
  await resetTopic();
  {
    const invalidCustomerIds = await Promise.all([
      post('/api/customers', { name: 'เลขบัตรสั้น', national_id: '123456789012' }),
      post('/api/customers', { name: 'เลขบัตรมีอักษร', national_id: '123456789012A' }),
    ]);
    const invalidPatientIds = await Promise.all([
      post('/api/patients', { patient_id: nextPatientId(), name: 'เลขบัตรสั้น', national_id: '123456789012' }),
      post('/api/patients', { patient_id: nextPatientId(), name: 'เลขบัตรมีอักษร', national_id: '123456789012A' }),
    ]);
    probe(
      [...invalidCustomerIds, ...invalidPatientIds].every((r) => r.status === 400),
      'เลขบัตรไม่ครบ 13 หลักหรือมีตัวอักษรผ่านเข้าแฟ้มได้',
      `statuses=${[...invalidCustomerIds, ...invalidPatientIds].map((r) => r.status).join(',')}`,
      'เลขบัตรสั้นและเลขบัตรที่มีตัวอักษรถูกกั้นทั้ง customers และ patients (400)',
    );

    const badTax = await post('/api/customers', { name: 'เลขภาษีผิด', tax_id: '01055ABC' });
    const badEmail = await post('/api/customers', { name: 'อีเมลผิด', email: 'not-an-email' });
    probe(
      badTax.status === 400 && badEmail.status === 400,
      'เลขผู้เสียภาษีหรืออีเมลผิดรูปผ่านเข้าแฟ้มลูกค้าได้',
      `tax=${badTax.status} email=${badEmail.status}`,
      'เลขผู้เสียภาษีไม่ครบ 13 หลักและอีเมลผิดรูปถูกกั้น (400)',
    );

    const phonePlus66 = await post('/api/customers', { name: 'เบอร์สากล', phone: '+66 81-234-5678' });
    const phoneSpaces = await post('/api/customers', { name: 'เบอร์มีเว้นวรรค', phone: '081 234 5678' });
    probe(
      phonePlus66.status === 201 && phoneSpaces.status === 201,
      'เบอร์ +66 หรือเบอร์ที่เว้นวรรคตามรูปแบบใช้งานจริงถูกปฏิเสธ',
      `+66=${phonePlus66.status} spaces=${phoneSpaces.status}`,
      'เบอร์ +66 และเบอร์ที่คั่นด้วยเว้นวรรค/ขีดผ่านได้',
    );

    const thaiDigits = await post('/api/customers', { name: 'เบอร์เลขไทย', phone: '๐๘๑๒๓๔๕๖๗๘' });
    probe(
      thaiDigits.status === 400,
      'เบอร์ที่เป็นเลขไทยถูกเก็บลงฐานโดยไม่แปลงเป็นเลขอารบิก',
      `${thaiDigits.status} ${brief(thaiDigits.body)}`,
      'เลขไทยไม่หลุดลงฐานเป็นเบอร์ที่ระบบโทร/ค้นต่อไม่ได้ (400)',
    );

    const punctuationOnly = await post('/api/customers', { name: 'เบอร์มีแต่บวก', phone: '++++++++' });
    const whitespaceOnly = await post('/api/customers', { name: 'เบอร์มีแต่ช่องว่าง', phone: '        ' });
    probe(
      punctuationOnly.status === 400 && whitespaceOnly.status === 400,
      'ช่องเบอร์โทรที่ไม่มีตัวเลขเลยผ่าน validation',
      `++++++++ -> ${punctuationOnly.status}, 8 spaces -> ${whitespaceOnly.status}`,
      'ช่องเบอร์โทรต้องมีตัวเลขจริง ไม่รับเครื่องหมาย/ช่องว่างล้วน',
    );

    const futureCustomer = await post('/api/customers', { name: 'เกิดในอนาคต', birth_date: '2099-01-01' });
    const futurePatient = await post('/api/patients', {
      patient_id: nextPatientId(), name: 'ผู้ป่วยเกิดในอนาคต', birth_date: '2099-01-01',
    });
    probe(
      futureCustomer.status === 400 && futurePatient.status === 400,
      'วันเกิดในอนาคตผ่านเข้าแฟ้มคนได้',
      `customers=${futureCustomer.status} patients=${futurePatient.status}`,
      'วันเกิดในอนาคตถูกกั้นทั้งลูกค้าและผู้ป่วย',
    );

    const beCustomer = await post('/api/customers', { name: 'กรอกปี พ.ศ.', birth_date: '2569-10-26' });
    const bePatient = await post('/api/patients', {
      patient_id: nextPatientId(), name: 'ผู้ป่วยกรอกปี พ.ศ.', birth_date: '2569-10-26',
    });
    probe(
      beCustomer.status === 400 && bePatient.status === 400,
      'ปี พ.ศ. ที่พิมพ์ลงช่องวันเกิด ค.ศ. ยังผ่านได้',
      `customers=${beCustomer.status} patients=${bePatient.status}`,
      'กรอบปีใน lib/dates.js ปิดปี พ.ศ. 2569 ที่พิมพ์ลงช่อง ค.ศ. ได้จริงทั้งสองแฟ้ม',
    );
  }

  // ---------------------------------------------------------------------------
  head('6 · ค้นหาด้วย %, _, เครื่องหมายคำพูด และเบอร์มีขีด');
  await resetTopic();
  {
    const customerRows = [
      { name: 'ลูกค้าปกติ', phone: '0800000001' },
      { name: "O'Neil ลูกค้า", phone: '0800000002' },
      { name: 'ส่วนลด 10%', phone: '0800000003' },
      { name: 'รหัส_A', phone: '081-234-5678' },
    ];
    for (const row of customerRows) {
      const created = await post('/api/customers', row);
      mustStatus(created, 201, `สร้างข้อมูลค้นหา ${row.name}`);
    }
    const patientRows = [
      { patient_id: nextPatientId(), name: 'ผู้ป่วยปกติ' },
      { patient_id: nextPatientId(), name: "O'Neil ผู้ป่วย" },
      { patient_id: nextPatientId(), name: 'ผู้ป่วย 10%' },
      { patient_id: nextPatientId(), name: 'ผู้ป่วย_A' },
    ];
    for (const row of patientRows) {
      const created = await post('/api/patients', row);
      mustStatus(created, 201, `สร้างข้อมูลค้นหา ${row.name}`);
    }

    const customerPercent = await get(`/api/customers?q=${encodeURIComponent('%')}&per_page=100`);
    const patientPercent = await get(`/api/patients?q=${encodeURIComponent('%')}&per_page=100`);
    probe(
      customerPercent.status === 200 && patientPercent.status === 200 &&
        Number(customerPercent.body?.pagination?.total) === 1 &&
        Number(patientPercent.body?.pagination?.total) === 1,
      'ค้นหาเครื่องหมาย % แล้วคืนทั้งตารางแทนการค้นหาอักขระจริง',
      `customers=${customerPercent.body?.pagination?.total}/${customerRows.length} ` +
        `patients=${patientPercent.body?.pagination?.total}/${patientRows.length}`,
      'ค้นหา % แบบตัวอักษรจริง คืนเฉพาะแถวที่มี %',
    );

    const customerUnderscore = await get(`/api/customers?q=${encodeURIComponent('_')}&per_page=100`);
    const patientUnderscore = await get(`/api/patients?q=${encodeURIComponent('_')}&per_page=100`);
    probe(
      customerUnderscore.status === 200 && patientUnderscore.status === 200 &&
        Number(customerUnderscore.body?.pagination?.total) === 1 &&
        Number(patientUnderscore.body?.pagination?.total) === 1,
      'ค้นหาเครื่องหมาย _ แล้วคืนเกือบทั้งตารางแทนการค้นหาอักขระจริง',
      `customers=${customerUnderscore.body?.pagination?.total}/${customerRows.length} ` +
        `patients=${patientUnderscore.body?.pagination?.total}/${patientRows.length}`,
      'ค้นหา _ แบบตัวอักษรจริง คืนเฉพาะแถวที่มี _',
    );

    const customerQuote = await get(`/api/customers?q=${encodeURIComponent("'")}&per_page=100`);
    const patientQuote = await get(`/api/patients?q=${encodeURIComponent("'")}&per_page=100`);
    probe(
      customerQuote.status === 200 && patientQuote.status === 200 &&
        Number(customerQuote.body?.pagination?.total) === 1 &&
        Number(patientQuote.body?.pagination?.total) === 1 &&
        containsRow(customerQuote.body, 'name', "O'Neil ลูกค้า") &&
        containsRow(patientQuote.body, 'name', "O'Neil ผู้ป่วย"),
      "ค้นหาด้วย ' ทำให้ query พังหรือคืนข้อมูลผิดคน",
      `customers=${customerQuote.status}/${customerQuote.body?.pagination?.total} ` +
        `patients=${patientQuote.status}/${patientQuote.body?.pagination?.total}`,
      "เครื่องหมาย ' ถูกส่งเป็นพารามิเตอร์ ค้นได้โดยไม่ทำ SQL พังและไม่คืนทั้งตาราง",
    );

    const phoneWithHyphen = await get(`/api/customers?q=${encodeURIComponent('081-234-5678')}&per_page=100`);
    probe(
      phoneWithHyphen.status === 200 && Number(phoneWithHyphen.body?.pagination?.total) === 1 &&
        containsRow(phoneWithHyphen.body, 'phone', '081-234-5678'),
      'ค้นเบอร์ที่มีขีดแล้วไม่พบแฟ้ม',
      `${phoneWithHyphen.status} ${brief(phoneWithHyphen.body)}`,
      'ค้นด้วยเบอร์รูปแบบมีขีด พบแฟ้มที่เก็บเบอร์รูปเดียวกันหนึ่งแถว',
    );

    const phoneDigitsOnly = await get('/api/customers?q=0812345678&per_page=100');
    info(
      Number(phoneDigitsOnly.body?.pagination?.total) === 0
        ? 'เบอร์เดียวกันแต่ค้นแบบไม่ใส่ขีดไม่เจอแฟ้มที่เก็บแบบมีขีด — บันทึกเป็นข้อจำกัดการค้นหาปัจจุบัน'
        : 'ค้นเบอร์แบบไม่ใส่ขีดเจอแฟ้มที่เก็บแบบมีขีดแล้ว',
    );
  }

  // ---------------------------------------------------------------------------
  head('7 · แถวกำพร้าและชื่อผู้จ่ายบนใบ');
  await resetTopic();
  {
    const orphanPatient = await createPatient({ name: 'ผู้ป่วยยังไม่รู้ว่าใครจ่าย', customer_id: null });
    mustStatus(orphanPatient.response, 201, 'สร้างผู้ป่วยไม่มีผู้ว่าจ้าง');
    const orphanPatients = await get('/api/patients?has_customer=no&per_page=100');
    probe(
      orphanPatients.status === 200 &&
        containsRow(orphanPatients.body, 'patient_id', orphanPatient.row.patient_id),
      'ผู้ป่วยที่ยังไม่มีผู้ว่าจ้างสร้างได้แต่กรองหากลับมาไม่ได้',
      brief(orphanPatients.body),
      'ผู้ป่วยไม่มีผู้ว่าจ้างสร้างได้ และตัวกรอง has_customer=no แสดงแถวนั้นจริง',
    );

    const emptyIdentityCase = await post('/api/cases', { case_id: nextCaseId(), fee: 1000 });
    probe(
      emptyIdentityCase.status === 400,
      'เปิดเคสโดยไม่มีทั้งผู้ว่าจ้าง ผู้ป่วย และชื่อผู้รับบริการได้',
      `${emptyIdentityCase.status} ${brief(emptyIdentityCase.body)}`,
      'เคสที่ไม่มีตัวตนใดเลยถูกกั้น ต้องมีอย่างน้อยชื่อผู้รับบริการหรือผู้ว่าจ้าง',
    );

    const noLinksCase = await createCase({
      client_name: 'คุณกำพร้าแต่มีชื่อ', customer_id: null, patient_id: null, fee: 3100,
    });
    mustStatus(noLinksCase.response, 201, 'เปิดเคสไม่มี FK แต่มีชื่อผู้รับบริการ');
    const noLinksInvoice = await invoiceForCase(noLinksCase.row.case_id);
    await issueInvoice(noLinksInvoice.invoice_id);
    const noLinksIssued = await get(`/api/invoices/${noLinksInvoice.invoice_id}`);
    const noLinksText = `${noLinksIssued.body?.bill_to_name ?? ''} ${noLinksIssued.body?.service_description ?? ''}`;
    probe(
      noLinksIssued.status === 200 && noLinksIssued.body?.status === 'issued' &&
        noLinksIssued.body?.customer_id === null &&
        noLinksIssued.body?.bill_to_name === 'คุณกำพร้าแต่มีชื่อ' &&
        !/(null|undefined|ยังไม่ระบุผู้ป่วย)/i.test(noLinksText),
      'เคสไม่มีผู้ว่าจ้างและผู้ป่วยออกใบไม่ได้ หรือชื่อบนใบเป็นคำภายใน/null',
      brief(noLinksIssued.body),
      'เคสไม่มี customer_id/patient_id แต่ออกใบได้ด้วยชื่อที่กรอก และไม่พิมพ์ null/คำแทนภายในลงใบ',
    );

    const patientOnlyCase = await createCase({
      client_name: orphanPatient.row.name,
      customer_id: null,
      patient_id: orphanPatient.row.patient_id,
      fee: 4200,
    });
    mustStatus(patientOnlyCase.response, 201, 'เปิดเคสของผู้ป่วยที่ยังไม่มีผู้ว่าจ้าง');
    const patientOnlyInvoice = await invoiceForCase(patientOnlyCase.row.case_id);
    await issueInvoice(patientOnlyInvoice.invoice_id);
    const patientOnlyIssued = await get(`/api/invoices/${patientOnlyInvoice.invoice_id}`);
    const patientOnlyText = `${patientOnlyIssued.body?.bill_to_name ?? ''} ${patientOnlyIssued.body?.service_description ?? ''}`;
    probe(
      patientOnlyIssued.body?.status === 'issued' && patientOnlyIssued.body?.customer_id === null &&
        patientOnlyIssued.body?.bill_to_name === orphanPatient.row.name &&
        !/(null|undefined|ยังไม่ระบุผู้ป่วย)/i.test(patientOnlyText),
      'ผู้ป่วยไม่มีผู้ว่าจ้างแล้วชื่อบนใบเป็น null/คำภายใน หรือออกใบไม่ได้',
      brief(patientOnlyIssued.body),
      'ผู้ป่วยไม่มีผู้ว่าจ้างยังออกใบได้โดยใช้ชื่อผู้รับบริการ และไม่หลุดคำภายในลงเอกสาร',
    );
  }

  console.log(`\n=== สรุป: ${checks} จุดใน 7 หัวข้อ · พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${passed.length} จุด ===`);
  found.forEach((item, i) => console.log(`${i + 1}. ${item.title}`));
  if (observations.length) {
    console.log(`INFO | พฤติกรรม/ข้อจำกัดที่บันทึกไว้ ${observations.length} จุด (ไม่ตัดสินเป็นบัค)`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
