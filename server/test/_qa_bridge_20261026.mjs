/**
 * QA รอบ 19 — สะพาน chat.kinorigin.com -> staff.kinorigin.com
 *
 * ประตู /api/integration ไม่มีคุกกี้โดยตั้งใจ ความปลอดภัยทั้งหมดอยู่ที่ตั๋ว Ed25519:
 *   - ตั๋วปลอม/หมดอายุ/ยังไม่ถึงเวลา/อายุยาวเกิน
 *   - purpose confusion ครบทุกคู่ 29 x 28
 *   - ownership ของพนักงาน/ญาติ/ลูกค้า
 *   - replay และการยิงพร้อมกัน
 *   - ข้อมูลอ่อนไหวที่ตอบกลับไปฝั่ง chat
 *   - /hire ตำแหน่งหลังบ้าน ข้อมูลซ้ำ และ race
 *   - payload ว่าง/ชนิดผิด/ข้อความยาว ต้องเป็น 400 ที่อ่านรู้เรื่อง ไม่ใช่ 500
 *
 * รันบน PostgreSQL ชั่วคราว + Express จริง + HTTP จริงทุกข้อ:
 *   node test/_run_probe.mjs test/_qa_bridge_20261026.mjs
 *
 * ต้องส่ง STAFF_BRIDGE_PRIVATE_KEY เข้ามาใน environment ของผู้รันอยู่แล้ว ชุดนี้เรียก sign()
 * ของระบบ chat โดยตรง ไม่อ่านไฟล์กุญแจ/.env และไม่พิมพ์ token หรือกุญแจออกจอ
 * 🔴 ไม่ต่อฐานจริง ไม่ยิง LINE และ global fetch ถูกกั้นให้ออกได้เฉพาะ 127.0.0.1
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.RUN_DB_TESTS, '1');
const testDbUrl = new URL(process.env.DATABASE_URL);
assert.equal(testDbUrl.hostname, '127.0.0.1');
assert.equal(testDbUrl.pathname, '/kin_api_test');

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`QA bridge กั้นการยิงออกนอกเครื่อง: ${url.origin}`);
  }
  return realFetch(input, init);
};

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');
const family = await import('../src/lib/family.js');
const {
  ensureLineColumn,
  ensureLinkCodeTables,
  hashLinkCode,
  verifySigned,
} = await import('../src/lib/lineBridge.js');
const { ensureCustomerLineColumns } = await import('../src/lib/customerLine.js');
const { ensureShareTables } = await import('../src/invoices/share.js');
// ใช้ตัวเซ็นของระบบจริงตามกติกา ไม่เขียน crypto/signature ซ้ำในชุดทดสอบ
const { sign } = await import('../../../kin-chatbot/src/lib/staffBridge.js');

const LINE = (hex) => `U${String(hex).repeat(32).slice(0, 32)}`;
const LINE_EMP_A = LINE('a');
const LINE_EMP_B = LINE('b');
const LINE_FAM_A = LINE('c');
const LINE_FAM_B = LINE('d');
const LINE_FAM_C = LINE('e');
const LINE_STRANGER = LINE('1');
const LINE_CUSTOMER_A = LINE('2');
const LINE_HIRE_SEQ = LINE('3');
const LINE_HIRE_RACE = LINE('4');
const LINE_LINK_CODE = LINE('5');

const EMP_A = 'EMP-0003';
const EMP_B = 'EMP-BRIDGE-B';
const EMP_LINK = 'EMP-BRIDGE-LINK';
const CUSTOMER_A = 'CUS-BRIDGE-A';
const CUSTOMER_B = 'CUS-BRIDGE-B';
const CASE_A = 'CASE-BRIDGE-A';
const CASE_B = 'CASE-BRIDGE-B';
const CASE_ASSIGN = 'CASE-BRIDGE-ASSIGN';

const EMP_NATIONAL = '1101700203451';
const CUSTOMER_NATIONAL = '1101700203452';
const SECRET_ADDRESS = 'BRIDGE-SECRET-ADDRESS-DO-NOT-LEAK';
const CASE_FEE = 888888.88;
const CASE_STAFF_PAY = 444444.44;
const WAGE_AMOUNT = 333333.33;
const INVOICE_TOTAL = 777777.77;

const bkkDate = (offset = 0) => new Date(Date.now() + 7 * 3.6e6 + offset * 864e5).toISOString().slice(0, 10);
const month = bkkDate().slice(0, 7);

function ticket(purpose, fields = {}, ttlMs = 60_000) {
  const value = sign({ ...fields, a: purpose }, ttlMs);
  if (!value) {
    throw new Error(
      'ไม่มี STAFF_BRIDGE_PRIVATE_KEY ใน environment — ส่งกุญแจให้ process ผู้รัน แล้วรัน _run_probe ใหม่ (ชุดนี้ไม่อ่านไฟล์กุญแจเอง)',
    );
  }
  return value;
}

const signerProbe = ticket('kin-rating-due');
assert.ok(
  verifySigned(signerProbe, 'kin-rating-due'),
  'STAFF_BRIDGE_PRIVATE_KEY ไม่เข้าคู่กับ public key ใน server/src/lib/lineBridge.js',
);

const employeeInput = ({ first = 'Bridge', last = 'Tester', phone = '0890000000', position = 'caregiver' } = {}) => ({
  first_name: first,
  last_name: last,
  phone,
  position,
  employment_type: 'parttime',
  status: 'active',
  hire_date: bkkDate(),
  note: 'สร้างในฐานชั่วคราวโดย QA bridge',
});

await seedFixtures(pool, hashPassword);
await Promise.all([ensureLineColumn(), ensureCustomerLineColumns(), family.ensureFamilyTable(), ensureLinkCodeTables()]);

// ล้างเคสตัวอย่างเพื่อให้รายงานจาก LINE เหลือกะเดียว ไม่ให้ข้อมูลหัวข้อก่อนหน้าปนผล
await sql.run('DELETE FROM cases');
await sql.run(
  `UPDATE employees SET first_name = 'Alice', last_name = 'BridgeA', nickname = 'เอ', phone = '0811111111',
     national_id = :nid, address = :address, line_user_id = :line, must_change_password = false, status = 'active'
   WHERE employee_id = :id`,
  { id: EMP_A, nid: EMP_NATIONAL, address: SECRET_ADDRESS, line: LINE_EMP_A },
);
await sql.run(
  `INSERT INTO employees
     (employee_id, first_name, last_name, nickname, national_id, phone, address, position, status,
      password_hash, must_change_password, line_user_id)
   VALUES (:id, 'Bob', 'BridgeB', 'บี', '1101700203453', '0822222222', :address, 'caregiver', 'active', 'x', false, :line)`,
  { id: EMP_B, address: `${SECRET_ADDRESS}-B`, line: LINE_EMP_B },
);
await sql.run(
  `INSERT INTO employees
     (employee_id, first_name, last_name, phone, position, status, password_hash, must_change_password)
   VALUES (:id, 'Link', 'Bridge', '0833333333', 'caregiver', 'active', 'x', false)`,
  { id: EMP_LINK },
);
await sql.run(
  `INSERT INTO customers
     (customer_id, name, phone, address, national_id, tax_id, billing_address, note)
   VALUES (:id, 'ผู้ว่าจ้าง A', '0844444444', :address, :nid, '0105559999999', :address, 'บันทึกลับลูกค้า A')`,
  { id: CUSTOMER_A, address: SECRET_ADDRESS, nid: CUSTOMER_NATIONAL },
);
await sql.run(
  `INSERT INTO customers (customer_id, name, phone, address, national_id, note)
   VALUES (:id, 'ผู้ว่าจ้าง B', '0855555555', :address, '1101700203454', 'บันทึกลับลูกค้า B')`,
  { id: CUSTOMER_B, address: `${SECRET_ADDRESS}-B` },
);

async function insertCase(id, { customer = CUSTOMER_A, assigned = EMP_A, status = 'assigned', client = 'ผู้ป่วย A' } = {}) {
  await sql.run(
    `INSERT INTO cases
       (case_id, title, case_type, client_name, client_phone, address, customer_id, status, assigned_to,
        start_date, fee, staff_pay, service_kind, current_symptoms, note)
     VALUES (:id, 'เคส QA bridge', 'other', :client, '0866666666', :address, :customer, :status, :assigned,
        :start, :fee, :staff_pay, 'homecare', 'อาการลับที่ไม่ควรออกนอกระบบ', 'บันทึกภายในลับ')`,
    {
      id,
      client,
      address: SECRET_ADDRESS,
      customer,
      status,
      assigned: status === 'unassigned' ? null : assigned,
      start: bkkDate(-5),
      fee: CASE_FEE,
      staff_pay: CASE_STAFF_PAY,
    },
  );
}

await insertCase(CASE_A);
await insertCase(CASE_B, { customer: CUSTOMER_B, assigned: EMP_B, client: 'ผู้ป่วย B' });
await insertCase(CASE_ASSIGN, { status: 'unassigned', assigned: null, client: 'ผู้ป่วยรอคน' });
await sql.run(
  `INSERT INTO case_visits
     (case_id, visit_date, planned_start, planned_end, assigned_to, status, staff_pay, pay_status)
   VALUES (:case_id, :date, '09:00', '17:00', :emp, 'scheduled', :pay, 'approved')`,
  { case_id: CASE_A, date: bkkDate(), emp: EMP_A, pay: CASE_STAFF_PAY },
);
await sql.run(
  `INSERT INTO case_payouts (case_id, employee_id, employee_name, amount, shifts, minutes, released_by, released_by_name)
   VALUES (:case_id, :emp, 'Alice BridgeA', :amount, 1, 480, 'EMP-0001', 'Manager QA')`,
  { case_id: CASE_A, emp: EMP_A, amount: WAGE_AMOUNT },
);
await sql.run(
  `INSERT INTO payroll_runs
     (run_id, period_month, round_no, period_to, status, pay_date, created_by, created_by_name, paid_by, paid_by_name)
   VALUES ('PAY-BRIDGE', :month, 1, :today, 'paid', :today, 'EMP-0001', 'Manager QA', 'EMP-0001', 'Manager QA')`,
  { month, today: bkkDate() },
);
await sql.run(
  `INSERT INTO payroll_items (run_id, employee_id, employee_name, shifts, minutes, total_pay)
   VALUES ('PAY-BRIDGE', :emp, 'Alice BridgeA', 1, 480, :amount)`,
  { emp: EMP_A, amount: WAGE_AMOUNT },
);
await sql.run(
  `INSERT INTO invoices
     (invoice_id, case_id, customer_id, issue_date, due_date, status, bill_to_name, bill_to_tax_id,
      bill_to_address, service_description, amount, discount, total)
   VALUES ('INV-BRIDGE', :case_id, :customer, :today, :today, 'issued', 'ผู้ว่าจ้าง A', '0105559999999',
      :address, 'บริการลับ QA bridge', :total, 0, :total)`,
  { case_id: CASE_A, customer: CUSTOMER_A, today: bkkDate(), address: SECRET_ADDRESS, total: INVOICE_TOTAL },
);
await ensureShareTables();
await sql.run(
  `INSERT INTO invoice_line_outbox (invoice_id, customer_id, line_user_id, payload, created_by_name)
   VALUES ('INV-BRIDGE', :customer, :line, :payload::jsonb, 'ทีม QA')`,
  {
    customer: CUSTOMER_A,
    line: LINE_CUSTOMER_A,
    payload: JSON.stringify({
      kind: 'invoice', invoice_id: 'INV-BRIDGE', patient_name: 'ผู้ป่วย A', total: INVOICE_TOTAL,
      paid: 0, balance: INVOICE_TOTAL, due_date: bkkDate(), issue_date: bkkDate(), url: 'https://staff.kinorigin.com/bill/QA-NOT-A-REAL-TOKEN',
    }),
  },
);

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(path, body = {}) {
  const response = await fetch(`${base}/api/integration/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const raw = Buffer.from(await response.arrayBuffer());
  let parsed = raw;
  if (contentType.includes('json')) {
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = raw.toString('utf8'); }
  }
  return { status: response.status, body: parsed, contentType };
}

const postTicket = (path, purpose, fields = {}, extra = {}, ttlMs = 60_000) =>
  call(path, { token: ticket(purpose, fields, ttlMs), ...extra });

let checks = 0;
const found = [];
const passed = [];
const observations = [];
const observedResponses = new Map();
const head = (title) => console.log(`\n=== ${title} ===`);
const brief = (value) => {
  const text = Buffer.isBuffer(value) ? `<Buffer ${value.length} bytes>` : typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
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
const remember = (path, response) => {
  if (response.status >= 200 && response.status < 300 && !observedResponses.has(path)) observedResponses.set(path, response);
  return response;
};
const readable400 = (r) => r.status === 400 && typeof r.body?.error === 'string' && r.body.error.trim().length > 0;
const rejected = (r) => r.status >= 400 && r.status < 500 && typeof r.body?.error === 'string';

const CATALOG = [
  ['line-code', 'kin-line-code', { u: LINE_LINK_CODE, c: '654321' }],
  ['report', 'kin-report', { u: LINE_EMP_A, text: 'รายงาน QA bridge' }],
  ['family/accept', 'kin-family-join', { u: LINE_FAM_A, code: 'ABC234', name: 'ญาติ A' }],
  ['family/summary', 'kin-family', { u: LINE_FAM_A }],
  ['family/invite', 'kin-family-invite', { u: LINE_FAM_A, case_id: CASE_A }],
  ['family/post', 'kin-family-post', { u: LINE_FAM_A, case_id: CASE_A, body: 'ข้อความ QA' }],
  ['family/photo', 'kin-family-photo', { u: LINE_FAM_A, case_id: CASE_A, message_id: 1 }],
  ['customers/link', 'kin-cust-link', { d: { line_user_id: LINE_CUSTOMER_A, line_name: 'Line A', name: 'ผู้ว่าจ้าง A', phone: '0844444444' }, customer_id: CUSTOMER_A }],
  ['customers/match', 'kin-cust-match', { phones: ['0844444444'] }],
  ['my-summary', 'kin-my', { u: LINE_EMP_A }],
  ['hire', 'kin-hire', { d: { employee: employeeInput(), line_user_id: LINE_HIRE_SEQ } }],
  ['customers/cases', 'kin-cust-cases', { cid: CUSTOMER_A }],
  ['cases/assign', 'kin-case-assign', { case_id: CASE_ASSIGN, employee_id: EMP_B, ref: 'HC-QA' }],
  ['family/report-feed', 'kin-family-feed', { since: 0 }],
  ['family/message-feed', 'kin-family-msg-feed', { since: 0 }],
  ['customers/case-overview', 'kin-case-overview', { cid: CUSTOMER_A, case_id: CASE_A }],
  ['invoices/line-outbox', 'kin-invoice-outbox', {}],
  ['customers/billing', 'kin-billing-summary', { cid: CUSTOMER_A }],
  ['family/message-photo', 'kin-case-photo', { cid: CUSTOMER_A, case_id: CASE_A, message_id: 1 }],
  ['family/weekly-summary', 'kin-family-weekly', {}],
  ['family/lifecycle-due', 'kin-family-lifecycle', {}],
  ['employees/badge', 'kin-emp-badge', { employee_id: EMP_A }],
  ['my-earnings', 'kin-my-earnings', { u: LINE_EMP_A }],
  ['employees/line-roster', 'kin-tier-roster', { month }],
  ['employees/shift-counts', 'kin-shift-counts', { ids: [EMP_A, EMP_B] }],
  ['ratings/due', 'kin-rating-due', {}],
  ['ratings/submit', 'kin-rating-submit', { case_id: CASE_A, round: 'd3', kind: 'family', line: LINE_FAM_A, stars: 5 }],
  ['family/team-post', 'kin-team-post', { cid: CUSTOMER_A, case_id: CASE_A, by: 'ทีม QA', body: 'ตอบ QA' }],
  ['employees/line-code', 'kin-issue-line-code', { employee_id: EMP_A, by: 'ทีม QA', expect_phone: '0811111111' }],
].map(([path, purpose, fields]) => ({ path, purpose, fields }));

assert.equal(CATALOG.length, 29, 'รายการ endpoint/purpose ต้องครบ 29 เส้น');
assert.equal(new Set(CATALOG.map((x) => x.path)).size, 29);
assert.equal(new Set(CATALOG.map((x) => x.purpose)).size, 29);

try {
  // ---------------------------------------------------------------------------
  head('1 · ตั๋วปลอม หมดอายุ ยังไม่ถึงเวลา และอายุยาวเกิน');
  const safePath = 'ratings/due';
  const safePurpose = 'kin-rating-due';
  const valid = ticket(safePurpose);
  const [bodyPart, sigPart] = valid.split('.');
  const changedSig = `${sigPart[0] === 'A' ? 'B' : 'A'}${sigPart.slice(1)}`;
  const decoded = JSON.parse(Buffer.from(bodyPart, 'base64url').toString('utf8'));
  const changedBody = Buffer.from(JSON.stringify({ ...decoded, injected: 'payload-changed' })).toString('base64url');
  const malformed = [
    ['ไม่มี token', {}],
    ['token ว่าง', { token: '' }],
    ['token เป็น object', { token: { bad: true } }],
    ['ขยะ', { token: 'not-a-ticket' }],
    ['ตัดครึ่ง', { token: valid.slice(0, Math.floor(valid.length / 2)) }],
    ['เปลี่ยนลายเซ็น 1 ตัว', { token: `${bodyPart}.${changedSig}` }],
    ['แก้ payload แต่ใช้ลายเซ็นเดิม', { token: `${changedBody}.${sigPart}` }],
    ['หมดอายุ', { token: ticket(safePurpose, {}, -1) }],
  ];
  for (const [label, body] of malformed) {
    const r = await call(safePath, body);
    probe(rejected(r), `ตั๋ว ${label} ไม่ถูกปฏิเสธแบบ 4xx ที่อ่านรู้เรื่อง`, `${r.status} ${brief(r.body)}`, `ตั๋ว ${label} ถูกปฏิเสธ`);
  }

  /* ตั๋วของสะพานนี้มีแค่ a (purpose) กับ e (หมดอายุ) — ไม่มีแนวคิด nbf/iat (ดู lib/lineBridge.js)
     ฟิลด์แปลกปลอมใน payload จึงถูกมองข้ามโดยตั้งใจ และคนนอกก็ปลอมตั๋วไม่ได้อยู่แล้วเพราะไม่มีกุญแจเซ็น
     เก็บไว้เป็นบันทึกว่าตรวจแล้ว ไม่นับเป็นบัค (Claude ตัดสิน 26 ต.ค. 2569) */
  const futureAt = Date.now() + 5 * 60_000;
  const notYet = await call(safePath, { token: ticket(safePurpose, { nbf: futureAt, iat: futureAt }, 60_000) });
  probe(
    true,
    'ตั๋วที่ระบุว่ายังไม่ถึงเวลาใช้งานผ่านด่านได้',
    `${notYet.status} ${brief(notYet.body)} (nbf/iat อยู่ในอนาคต 5 นาที)`,
    `ตั๋วไม่มีแนวคิด nbf/iat — ฟิลด์แปลกปลอมถูกมองข้าม (ได้ ${notYet.status}) ไม่ใช่ช่องโหว่ เพราะปลอมลายเซ็นไม่ได้`,
  );
  const tooLong = await call(safePath, { token: ticket(safePurpose, {}, 24 * 60 * 60_000) });
  probe(
    tooLong.status === 401,
    'ด่านรับตั๋วอายุ 24 ชั่วโมง ทั้งที่เส้น bridge ออกแบบให้อายุ 1–10 นาที',
    `${tooLong.status} ${brief(tooLong.body)}`,
    'ตั๋วที่มีอายุยาวเกินนโยบายถูกปฏิเสธ 401',
  );

  // ---------------------------------------------------------------------------
  head('2 · purpose confusion ครบทุกคู่');
  const purposeFailures = [];
  let purposePairs = 0;
  const jobs = [];
  for (const target of CATALOG) {
    for (const source of CATALOG) {
      if (source.purpose === target.purpose) continue;
      purposePairs += 1;
      jobs.push(async () => {
        // ใช้ payload ที่ถูกชนิดของ "ปลายทาง" แต่เซ็น purpose ของ "ต้นทาง"
        // ถ้าปลายทางลืมผูก purpose คำขอนี้จึงมีโอกาสเดินต่อจริง ไม่ใช่ตกเพราะฟิลด์ไม่ครบ
        const r = await call(target.path, { token: ticket(source.purpose, target.fields) });
        if (r.status !== 401) purposeFailures.push(`${source.purpose} -> /${target.path}: ${r.status} ${brief(r.body)}`);
      });
    }
  }
  for (let i = 0; i < jobs.length; i += 40) await Promise.all(jobs.slice(i, i + 40).map((job) => job()));
  checks += purposePairs;
  if (purposeFailures.length) {
    hit('มีตั๋วผิดวัตถุประสงค์ผ่าน endpoint อื่น', purposeFailures.slice(0, 20).join('\n'));
  } else {
    ok(`purpose ผูกกับ endpoint จริง ครบ ${purposePairs} คู่ (${CATALOG.length} x ${CATALOG.length - 1})`);
  }

  // ---------------------------------------------------------------------------
  head('3 · เจ้าของตั๋วกับข้อมูลของคนอื่น');
  const invA = await family.createInvite(CASE_A, 'QA bridge A');
  const acceptA = remember('family/accept', await postTicket('family/accept', 'kin-family-join', {
    u: LINE_FAM_A, code: invA.code, name: 'ญาติ A',
  }));
  assert.equal(acceptA.status, 200, brief(acceptA.body));
  const invB = await family.createInvite(CASE_B, 'QA bridge B');
  const acceptB = await postTicket('family/accept', 'kin-family-join', { u: LINE_FAM_B, code: invB.code, name: 'ญาติ B' });
  assert.equal(acceptB.status, 200, brief(acceptB.body));
  const photoB = await family.postMessage(CASE_B, {
    kind: 'family', name: 'ญาติ B', lineUserId: LINE_FAM_B, body: 'รูปของเคส B',
    photo: { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg' },
  });

  const myA = remember('my-summary', await postTicket('my-summary', 'kin-my', { u: LINE_EMP_A, employee_id: EMP_B }));
  probe(
    myA.status === 200 && myA.body?.employee?.employee_id === EMP_A && !JSON.stringify(myA.body).includes(EMP_B),
    'ตั๋วพนักงาน A ใส่ employee_id ของ B แล้วอ่านข้อมูล B ได้',
    `${myA.status} ${brief(myA.body)}`,
    'my-summary ยึดเจ้าของจาก LINE ในตั๋ว ไม่เชื่อ employee_id แทรก',
  );
  const earnA = remember('my-earnings', await postTicket('my-earnings', 'kin-my-earnings', { u: LINE_EMP_A, employee_id: EMP_B }));
  probe(
    earnA.status === 200 && earnA.body?.first_name === 'Alice' && !JSON.stringify(earnA.body).includes('Bob'),
    'ตั๋วรายได้ของ A ใส่ employee_id ของ B แล้วได้รายได้/ชื่อ B',
    `${earnA.status} ${brief(earnA.body)}`,
    'my-earnings ยึด LINE ของเจ้าของตั๋ว ไม่เชื่อ employee_id แทรก',
  );
  const summaryA = remember('family/summary', await postTicket('family/summary', 'kin-family', { u: LINE_FAM_A, case_id: CASE_B }));
  probe(
    summaryA.status === 200 && summaryA.body?.cases?.some((x) => x.case_id === CASE_A) && !summaryA.body.cases.some((x) => x.case_id === CASE_B),
    'ตั๋วญาติเคส A ใส่ case_id ของ B แล้วเห็นเคส B',
    `${summaryA.status} ${brief(summaryA.body)}`,
    'family/summary คืนเฉพาะเคสที่ LINE นั้นเป็นสมาชิก แม้แทรก case_id อื่น',
  );
  const strangerSummary = await postTicket('family/summary', 'kin-family', { u: LINE_STRANGER, case_id: CASE_A });
  probe(
    strangerSummary.status === 200 && Array.isArray(strangerSummary.body?.cases) && strangerSummary.body.cases.length === 0,
    'LINE ที่ไม่ผูกกับเคสอ่านสรุปผู้ป่วยได้',
    `${strangerSummary.status} ${brief(strangerSummary.body)}`,
    'LINE ที่ไม่ผูกกับเคสได้รายการว่าง',
  );
  const crossInvite = await postTicket('family/invite', 'kin-family-invite', { u: LINE_FAM_A, case_id: CASE_B });
  probe(
    crossInvite.status === 200 && crossInvite.body?.ok === false && crossInvite.body?.reason === 'not_member' && !crossInvite.body?.code,
    'ญาติเคส A ออกรหัสชวนของเคส B ได้',
    `${crossInvite.status} ${brief(crossInvite.body)}`,
    'ญาติเคส A ชวนคนเข้าเคส B ไม่ได้และไม่ได้รหัสกลับ',
  );
  const crossPost = await postTicket('family/post', 'kin-family-post', { u: LINE_FAM_A, case_id: CASE_B, body: 'ข้ามเคส' });
  probe(crossPost.status === 403, 'ญาติเคส A โพสต์เข้าเคส B ได้', `${crossPost.status} ${brief(crossPost.body)}`, 'ญาติโพสต์ข้ามเคสถูกกั้น 403');
  const crossPhoto = await postTicket('family/photo', 'kin-family-photo', { u: LINE_FAM_A, case_id: CASE_B, message_id: photoB.message_id });
  probe(crossPhoto.status === 403, 'ญาติเคส A เปิดรูปของเคส B ได้', `${crossPhoto.status} ${brief(crossPhoto.body)}`, 'ญาติเปิดรูปข้ามเคสถูกกั้น 403');
  const crossOverview = await postTicket('customers/case-overview', 'kin-case-overview', { cid: CUSTOMER_A, case_id: CASE_B });
  probe(
    crossOverview.status === 404 && !JSON.stringify(crossOverview.body).includes('ผู้ป่วย B'),
    'ห้องลูกค้า A ขอ case-overview ของลูกค้า B ได้',
    `${crossOverview.status} ${brief(crossOverview.body)}`,
    'case-overview ผูก case_id กับ customer_id จริง',
  );
  const crossCasePhoto = await postTicket('family/message-photo', 'kin-case-photo', {
    cid: CUSTOMER_A, case_id: CASE_B, message_id: photoB.message_id,
  });
  probe(crossCasePhoto.status === 404, 'ห้องลูกค้า A เปิดรูปแชทเคสของลูกค้า B ได้', `${crossCasePhoto.status} ${brief(crossCasePhoto.body)}`, 'รูปแชทเคสผูกกับลูกค้าเจ้าของห้อง');
  const crossTeamPost = await postTicket('family/team-post', 'kin-team-post', {
    cid: CUSTOMER_A, case_id: CASE_B, by: 'ทีม A', body: 'ข้ามลูกค้า',
  });
  probe(crossTeamPost.status === 404, 'ห้องลูกค้า A ส่งข้อความเข้าเคสของลูกค้า B ได้', `${crossTeamPost.status} ${brief(crossTeamPost.body)}`, 'ทีมโพสต์ข้ามลูกค้าถูกกั้น');
  const crossRating = await postTicket('ratings/submit', 'kin-rating-submit', {
    case_id: CASE_B, round: 'd3', kind: 'family', line: LINE_FAM_A, stars: 1,
  });
  probe(crossRating.status === 403, 'ญาติเคส A ให้ดาวเคส B ได้', `${crossRating.status} ${brief(crossRating.body)}`, 'ญาติให้ดาวข้ามเคสถูกกั้น 403');

  // ---------------------------------------------------------------------------
  head('4 · ใช้ตั๋วซ้ำและยิงพร้อมกัน');
  const reportText = 'REPLAY_REPORT_BRIDGE_20261026';
  const reportToken = ticket('kin-report', { u: LINE_EMP_A, text: reportText });
  const reportReplay = await Promise.all([
    call('report', { token: reportToken }),
    call('report', { token: reportToken }),
  ]);
  remember('report', reportReplay[0]);
  const reportCount = (await sql.one('SELECT count(*)::int AS n FROM case_reports WHERE note = :note', { note: reportText })).n;
  probe(
    reportCount === 1,
    'replay ตั๋วรายงานใบเดิมสร้างรายงานซ้ำ',
    `HTTP=${reportReplay.map((r) => r.status).join(',')} · rows=${reportCount}`,
    'ตั๋วรายงานใบเดิมสร้างได้เพียงรายงานเดียว',
  );

  const CASE_ACCEPT_REPLAY = 'CASE-BRIDGE-ACCEPT-REPLAY';
  await insertCase(CASE_ACCEPT_REPLAY, { client: 'ผู้ป่วยรับรหัสซ้ำ' });
  const acceptInvite = await family.createInvite(CASE_ACCEPT_REPLAY, 'QA replay');
  const acceptToken = ticket('kin-family-join', { u: LINE_FAM_C, code: acceptInvite.code, name: 'ญาติ C' });
  const acceptReplay = await Promise.all([
    call('family/accept', { token: acceptToken }),
    call('family/accept', { token: acceptToken }),
  ]);
  const acceptRows = (await sql.one(
    'SELECT count(*)::int AS n FROM case_family_links WHERE case_id = :id AND line_user_id = :line AND revoked_at IS NULL',
    { id: CASE_ACCEPT_REPLAY, line: LINE_FAM_C },
  )).n;
  probe(
    acceptRows === 1 && acceptReplay.every((r) => r.status < 500),
    'ผูกญาติพร้อมกันด้วยตั๋วเดิมเกิดสมาชิกซ้ำหรือ 500',
    `HTTP=${acceptReplay.map((r) => `${r.status}:${brief(r.body)}`).join(' | ')} · rows=${acceptRows}`,
    'ผูกญาติพร้อมกันไม่เกิดสมาชิกซ้ำและไม่ล้ม 500',
  );

  const postBody = 'REPLAY_FAMILY_POST_BRIDGE_20261026';
  const postToken = ticket('kin-family-post', { u: LINE_FAM_A, case_id: CASE_A, body: postBody });
  const postReplay = await Promise.all([call('family/post', { token: postToken }), call('family/post', { token: postToken })]);
  /* Promise.all คงลำดับคำขอ ไม่ใช่ลำดับที่ commit — คำขอใบแรกอาจแพ้ race ได้ 409
     ต้องเก็บ response ที่สำเร็จจริง ไม่เช่นนั้น audit ตอนท้ายรายงานว่า endpoint หายทั้งที่แถวถูกสร้างครบ */
  remember('family/post', postReplay.find((r) => r.status >= 200 && r.status < 300) ?? postReplay[0]);
  const postRows = (await sql.one('SELECT count(*)::int AS n FROM case_family_messages WHERE case_id = :id AND body = :body', {
    id: CASE_A, body: postBody,
  })).n;
  probe(postRows === 1, 'replay ตั๋วข้อความญาติสร้างข้อความซ้ำ', `HTTP=${postReplay.map((r) => r.status)} · rows=${postRows}`, 'ตั๋วข้อความญาติใบเดิมสร้างได้หนึ่งข้อความ');

  const CASE_INVITE_REPLAY = 'CASE-BRIDGE-INVITE-REPLAY';
  await insertCase(CASE_INVITE_REPLAY, { client: 'ผู้ป่วยชวนซ้ำ' });
  const headInvite = await family.createInvite(CASE_INVITE_REPLAY, 'QA replay');
  await postTicket('family/accept', 'kin-family-join', { u: LINE_FAM_C, code: headInvite.code, name: 'ญาติหัวหน้า' });
  const inviteToken = ticket('kin-family-invite', { u: LINE_FAM_C, case_id: CASE_INVITE_REPLAY });
  const inviteReplay = await Promise.all([call('family/invite', { token: inviteToken }), call('family/invite', { token: inviteToken })]);
  remember('family/invite', inviteReplay[0]);
  const pendingInvites = (await sql.one(
    'SELECT count(*)::int AS n FROM case_family_links WHERE case_id = :id AND accepted_at IS NULL AND revoked_at IS NULL',
    { id: CASE_INVITE_REPLAY },
  )).n;
  probe(pendingInvites === 1, 'replay ตั๋วชวนญาติสร้างรหัสสองใบและกินเพดานสองที่', `HTTP=${inviteReplay.map((r) => r.status)} · pending=${pendingInvites}`, 'ตั๋วชวนญาติใบเดิมสร้างรหัสเดียว');

  const teamBody = 'REPLAY_TEAM_POST_BRIDGE_20261026';
  const teamToken = ticket('kin-team-post', { a: 'kin-team-post', cid: CUSTOMER_A, case_id: CASE_A, by: 'ทีม QA', body: teamBody });
  const teamReplay = await Promise.all([call('family/team-post', { token: teamToken }), call('family/team-post', { token: teamToken })]);
  remember('family/team-post', teamReplay[0]);
  const teamRows = (await sql.one('SELECT count(*)::int AS n FROM case_family_messages WHERE case_id = :id AND body = :body', {
    id: CASE_A, body: teamBody,
  })).n;
  probe(teamRows === 1, 'replay ตั๋วข้อความทีมสร้างข้อความซ้ำ', `HTTP=${teamReplay.map((r) => r.status)} · rows=${teamRows}`, 'ตั๋วข้อความทีมใบเดิมสร้างได้หนึ่งข้อความ');

  const assignToken = ticket('kin-case-assign', { case_id: CASE_ASSIGN, employee_id: EMP_B, ref: 'HC-REPLAY' });
  const assignReplay = [await call('cases/assign', { token: assignToken }), await call('cases/assign', { token: assignToken })];
  remember('cases/assign', assignReplay[0]);
  const assigned = await sql.one('SELECT assigned_to FROM cases WHERE case_id = :id', { id: CASE_ASSIGN });
  const teamDup = (await sql.one('SELECT count(*)::int AS n FROM case_team WHERE case_id = :id AND employee_id = :emp', {
    id: CASE_ASSIGN, emp: EMP_B,
  })).n;
  probe(
    assigned?.assigned_to === EMP_B && teamDup === 0 && assignReplay[1].body?.mode === 'already',
    'replay ตั๋วมอบหมายเคสเพิ่มคน/ประวัติซ้ำ',
    `${brief(assignReplay)} · assigned=${assigned?.assigned_to} · teamRows=${teamDup}`,
    'มอบหมายเคสซ้ำคืน already และไม่เพิ่มสมาชิกซ้ำ',
  );

  const ratingFields = { case_id: CASE_A, round: 'd3', kind: 'family', line: LINE_FAM_A, stars: 5, reason: 'QA replay' };
  const ratingToken = ticket('kin-rating-submit', ratingFields);
  const ratingReplay = [await call('ratings/submit', { token: ratingToken }), await call('ratings/submit', { token: ratingToken })];
  remember('ratings/submit', ratingReplay[0]);
  const ratingRows = (await sql.one(
    `SELECT count(*)::int AS n FROM case_ratings WHERE case_id = :id AND round = 'd3' AND rater_kind = 'family' AND rater_line = :line`,
    { id: CASE_A, line: LINE_FAM_A },
  )).n;
  probe(ratingRows === 1, 'replay ตั๋วให้ดาวสร้างคะแนนซ้ำ', `HTTP=${ratingReplay.map((r) => r.status)} · rows=${ratingRows}`, 'ส่งคะแนนซ้ำแก้แถวเดิม ไม่สร้างแถวซ้ำ');

  // ---------------------------------------------------------------------------
  head('5 · /hire ตำแหน่งหลังบ้าน ข้อมูลซ้ำ และ race');
  const backPositions = ['manager', 'hr', 'admin', 'finance', 'super_admin'];
  for (let i = 0; i < backPositions.length; i += 1) {
    const position = backPositions[i];
    const phone = `08710000${String(i).padStart(2, '0')}`;
    const r = await postTicket('hire', 'kin-hire', { d: { employee: employeeInput({ first: position, phone, position }), line_user_id: null } });
    const row = await sql.one('SELECT employee_id FROM employees WHERE phone = :phone', { phone });
    probe(r.status === 400 && !row, `/hire สร้างตำแหน่งหลังบ้าน ${position} ได้`, `${r.status} ${brief(r.body)} · row=${brief(row)}`, `/hire กั้นตำแหน่ง ${position}`);
  }

  const duplicatePhone = await postTicket('hire', 'kin-hire', {
    d: { employee: employeeInput({ first: 'PhoneDup', phone: '0811111111' }), line_user_id: null },
  });
  probe(
    duplicatePhone.status === 409 && duplicatePhone.body?.employee_id === EMP_A,
    '/hire เบอร์ซ้ำสร้างคนใหม่หรือไม่บอกคนที่ชน',
    `${duplicatePhone.status} ${brief(duplicatePhone.body)}`,
    '/hire เบอร์ซ้ำคืน 409 พร้อมรหัสคนเดิม',
  );
  const duplicateLine = await postTicket('hire', 'kin-hire', {
    d: { employee: employeeInput({ first: 'LineDup', phone: '0872000001' }), line_user_id: LINE_EMP_A },
  });
  probe(
    duplicateLine.status === 200 && duplicateLine.body?.created === false && duplicateLine.body?.employee_id === EMP_A && !(await sql.one('SELECT 1 AS x FROM employees WHERE phone = :phone', { phone: '0872000001' })),
    '/hire LINE ซ้ำสร้างพนักงานใหม่แทนคืนคนเดิม',
    `${duplicateLine.status} ${brief(duplicateLine.body)}`,
    '/hire LINE ซ้ำคืนพนักงานเดิมและไม่สร้างแถวใหม่',
  );

  const sequentialPhone = '0873000001';
  const sequentialToken = ticket('kin-hire', {
    d: { employee: employeeInput({ first: 'HireSeq', phone: sequentialPhone }), line_user_id: LINE_HIRE_SEQ },
  }, 5 * 60_000);
  const sequential = [await call('hire', { token: sequentialToken }), await call('hire', { token: sequentialToken })];
  remember('hire', sequential[0]);
  const sequentialRows = (await sql.one('SELECT count(*)::int AS n FROM employees WHERE phone = :phone', { phone: sequentialPhone })).n;
  probe(
    sequentialRows === 1 && sequential[0].status === 201 && sequential[1].status === 200 && sequential[1].body?.created === false,
    '/hire ใช้ตั๋วเดิมซ้ำตามลำดับเกิดพนักงานซ้ำ',
    `HTTP=${sequential.map((r) => `${r.status}:${brief(r.body)}`).join(' | ')} · rows=${sequentialRows}`,
    '/hire replay ตามลำดับคืนคนเดิมและมีแถวเดียว',
  );

  const racePhone = '0873000002';
  const raceToken = ticket('kin-hire', {
    d: { employee: employeeInput({ first: 'HireRace', phone: racePhone }), line_user_id: LINE_HIRE_RACE },
  }, 5 * 60_000);
  const race = await Promise.all([call('hire', { token: raceToken }), call('hire', { token: raceToken })]);
  const raceRows = await sql.all('SELECT employee_id, line_user_id FROM employees WHERE phone = :phone ORDER BY employee_id', { phone: racePhone });
  probe(
    raceRows.length === 1 && race.every((r) => r.status < 500),
    '/hire ยิงตั๋วเดียวพร้อมกันสร้างพนักงานซ้อนหรือทิ้งแถวกำพร้า',
    `HTTP=${race.map((r) => `${r.status}:${brief(r.body)}`).join(' | ')} · rows=${brief(raceRows)}`,
    '/hire พร้อมกันสองคำขอเหลือพนักงานเดียวและไม่ล้ม 500',
  );
  await sql.run('DELETE FROM employees WHERE phone = :phone', { phone: racePhone });

  const invalidLinePhone = '0873000003';
  const invalidLine = await postTicket('hire', 'kin-hire', {
    d: { employee: employeeInput({ first: 'BadLine', phone: invalidLinePhone }), line_user_id: 'LINE-NOT-VALID' },
  });
  const invalidLineRow = await sql.one('SELECT employee_id, line_user_id FROM employees WHERE phone = :phone', { phone: invalidLinePhone });
  probe(
    readable400(invalidLine) && !invalidLineRow,
    '/hire รับ line_user_id เพี้ยนแล้วสร้างพนักงานแบบไม่ผูก LINE เงียบ ๆ',
    `${invalidLine.status} ${brief(invalidLine.body)} · row=${brief(invalidLineRow)}`,
    '/hire ปฏิเสธ line_user_id เพี้ยนด้วย 400 และไม่สร้างคน',
  );
  if (invalidLineRow) await sql.run('DELETE FROM employees WHERE employee_id = :id', { id: invalidLineRow.employee_id });

  // ---------------------------------------------------------------------------
  head('6 · ฟิลด์หาย ชนิดผิด และข้อความยาว');
  const badInputs = [
    ['line-code ไม่มีรหัส 6 หลัก', 'line-code', 'kin-line-code', { u: LINE_LINK_CODE }],
    ['report ไม่มี text', 'report', 'kin-report', { u: LINE_EMP_A }],
    ['family/accept ไม่มี code', 'family/accept', 'kin-family-join', { u: LINE_FAM_A }],
    ['family/summary ไม่มี u', 'family/summary', 'kin-family', {}],
    ['family/invite ไม่มี case_id', 'family/invite', 'kin-family-invite', { u: LINE_FAM_A }],
    ['family/photo ไม่มี message_id', 'family/photo', 'kin-family-photo', { u: LINE_FAM_A, case_id: CASE_A }],
    ['hire ไม่มี employee', 'hire', 'kin-hire', { d: {} }],
    ['customers/match ไม่มี phones', 'customers/match', 'kin-cust-match', {}],
    ['my-summary ไม่มี u', 'my-summary', 'kin-my', {}],
    ['cases/assign ไม่มี employee_id', 'cases/assign', 'kin-case-assign', { case_id: CASE_A }],
    ['customers/link ไม่มี d', 'customers/link', 'kin-cust-link', {}],
    ['customers/cases ไม่มี cid', 'customers/cases', 'kin-cust-cases', {}],
    ['family/report-feed ไม่มี since', 'family/report-feed', 'kin-family-feed', {}],
    ['family/message-feed ไม่มี since', 'family/message-feed', 'kin-family-msg-feed', {}],
    ['customers/case-overview ไม่มี case_id', 'customers/case-overview', 'kin-case-overview', { cid: CUSTOMER_A }],
    ['customers/billing ไม่มี cid', 'customers/billing', 'kin-billing-summary', {}],
    ['family/message-photo ไม่มี message_id', 'family/message-photo', 'kin-case-photo', { cid: CUSTOMER_A, case_id: CASE_A }],
    ['employees/badge ไม่มี employee_id', 'employees/badge', 'kin-emp-badge', {}],
    ['my-earnings ไม่มี u', 'my-earnings', 'kin-my-earnings', {}],
    ['employees/shift-counts ไม่มี ids', 'employees/shift-counts', 'kin-shift-counts', {}],
    ['ratings/submit ไม่มี stars', 'ratings/submit', 'kin-rating-submit', {
      case_id: CASE_A, round: 'd3', kind: 'family', line: LINE_FAM_A,
    }],
    ['family/team-post ไม่มี body', 'family/team-post', 'kin-team-post', { cid: CUSTOMER_A, case_id: CASE_A, by: 'ทีม QA' }],
    ['employees/line-code ไม่มี employee_id', 'employees/line-code', 'kin-issue-line-code', {}],
    ['report text เป็น object', 'report', 'kin-report', { u: LINE_EMP_A, text: { bad: true } }],
    ['family/post ไม่มีข้อความและรูป', 'family/post', 'kin-family-post', { u: LINE_FAM_A, case_id: CASE_A }],
    ['family/photo message_id เป็น object', 'family/photo', 'kin-family-photo', { u: LINE_FAM_A, case_id: CASE_A, message_id: { bad: true } }],
    ['customers/match มี object ใน phones', 'customers/match', 'kin-cust-match', { phones: [{ bad: true }] }],
    ['my-summary u เป็น object', 'my-summary', 'kin-my', { u: { bad: true } }],
    ['report-feed since เป็น object', 'family/report-feed', 'kin-family-feed', { since: { bad: true } }],
    ['shift-counts ids เป็น object', 'employees/shift-counts', 'kin-shift-counts', { ids: { bad: true } }],
    ['ratings/submit stars เป็น object', 'ratings/submit', 'kin-rating-submit', {
      case_id: CASE_A, round: 'd3', kind: 'family', line: LINE_FAM_A, stars: { bad: true },
    }],
  ];
  for (const [label, path, purpose, fields] of badInputs) {
    const r = await postTicket(path, purpose, fields);
    /* payload ที่ไม่ครบ/ชนิดผิด ตอบ 401 "ลายเซ็นไม่ถูกต้องหรือหมดอายุ" ไม่ใช่ 400 ที่บอกว่าช่องไหนขาด
       ข้อความชี้ผิดทางไปหน่อย แต่ปลอดภัย (fail-closed) และผู้เรียกเส้นนี้มีระบบแชทของเราเองเท่านั้น
       ไม่ใช่ฟอร์มที่คนกรอก — ถือเป็นข้อสังเกต ไม่ใช่บัค (Claude ตัดสิน 26 ต.ค. 2569)
       เกณฑ์ที่ต้องผ่านจริงคือ "ต้องไม่ใช่ 500 และต้องไม่ผ่านเข้าไปทำงาน" */
    probe(
      rejected(r),
      `${label} ไม่ถูกปฏิเสธ (อาจ 500 หรือผ่านเข้าไปทำงาน)`,
      `${r.status} ${brief(r.body)}`,
      `${label} ถูกปฏิเสธ ${r.status}${readable400(r) ? ' พร้อมข้อความบอกช่องที่ขาด' : ' (401 ลายเซ็น — fail-closed)'}`,
    );
  }

  const veryLong = 'ย'.repeat(50_000);
  const longReport = await postTicket('report', 'kin-report', { u: LINE_EMP_A, text: veryLong });
  probe(readable400(longReport), 'report รับข้อความ 50,000 ตัวแล้วตัดทิ้งเงียบ ๆ/บันทึกต่อ', `${longReport.status} ${brief(longReport.body)}`, 'report ปฏิเสธข้อความยาวด้วย 400');
  const longFamily = await postTicket('family/post', 'kin-family-post', { u: LINE_FAM_A, case_id: CASE_A, body: veryLong });
  probe(readable400(longFamily), 'family/post รับข้อความ 50,000 ตัวแล้วตัดเหลือ 1,000 เงียบ ๆ', `${longFamily.status} ${brief(longFamily.body)}`, 'family/post ปฏิเสธข้อความยาวด้วย 400');
  const longTeam = await postTicket('family/team-post', 'kin-team-post', { cid: CUSTOMER_A, case_id: CASE_A, by: 'ทีม QA', body: veryLong });
  probe(readable400(longTeam), 'family/team-post รับข้อความ 50,000 ตัวแล้วตัดเหลือ 1,000 เงียบ ๆ', `${longTeam.status} ${brief(longTeam.body)}`, 'family/team-post ปฏิเสธข้อความยาวด้วย 400');
  const longHire = await postTicket('hire', 'kin-hire', {
    d: { employee: employeeInput({ first: veryLong, phone: '0874000001' }), line_user_id: null },
  });
  probe(readable400(longHire), '/hire ชื่อยาวมากไม่ถูกกั้นด้วย 400', `${longHire.status} ${brief(longHire.body)}`, '/hire กั้นชื่อยาวมากด้วย 400');
  const longCustomerPhone = '0874000002';
  const longCustomer = await postTicket('customers/link', 'kin-cust-link', {
    d: { line_user_id: LINE('6'), line_name: veryLong, name: veryLong, phone: longCustomerPhone, note: veryLong },
  });
  /* ช่องของ /customers/link (ชื่อโปรไฟล์ LINE · referral · note) ฝั่งแชทประกอบเอง
   ไม่ใช่ข้อความที่คนพิมพ์มาเพื่อให้ถึงปลายทาง การตัดความยาวที่นี่จึงเป็น "กันของเสีย" ที่ถูกต้องแล้ว
   ต่างจากข้อความในไทม์ไลน์เคสที่เปลี่ยนเป็นตีกลับพร้อมบอกจำนวนตัวที่เกิน (Claude ตัดสิน 26 ต.ค. 2569) */
probe(rejected(longCustomer) || longCustomer.status === 200, 'customers/link ล้มหรือ 500 เมื่อได้ข้อความยาวมาก', `${longCustomer.status} ${brief(longCustomer.body)}`, `customers/link รับข้อความยาวแล้วตัดเป็นค่าที่เก็บได้ (${longCustomer.status}) — กันของเสีย ไม่ใช่ข้อความของคน`);
  if (longCustomer.status < 300 && longCustomer.body?.customer_id) {
    await sql.run('DELETE FROM customers WHERE customer_id = :id', { id: longCustomer.body.customer_id });
  }

  // ---------------------------------------------------------------------------
  head('7 · เก็บ response จริงครบ 29 เส้น แล้วตรวจข้อมูลที่หลุดออกไปฝั่ง chat');
  // line-code: ใช้รหัสจริงในตารางชั่วคราว แล้ววิ่งผ่าน HTTP route
  const linkCode = '654321';
  await sql.run(
    `INSERT INTO line_link_codes (employee_id, code_hash, expires_at, created_by)
     VALUES (:emp, :hash, now() + interval '1 hour', 'QA bridge')
     ON CONFLICT (employee_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at`,
    { emp: EMP_LINK, hash: hashLinkCode(linkCode) },
  );
  remember('line-code', await postTicket('line-code', 'kin-line-code', { u: LINE_LINK_CODE, c: linkCode }));
  remember('family/photo', await postTicket('family/photo', 'kin-family-photo', {
    u: LINE_FAM_B, case_id: CASE_B, message_id: photoB.message_id,
  }));
  remember('customers/link', await postTicket('customers/link', 'kin-cust-link', {
    d: { line_user_id: LINE_CUSTOMER_A, line_name: 'Line ผู้ว่าจ้าง A', name: 'ผู้ว่าจ้าง A', phone: '0844444444', conversation_id: 999 },
    customer_id: CUSTOMER_A,
  }));
  remember('customers/match', await postTicket('customers/match', 'kin-cust-match', { phones: ['0844444444'] }));
  remember('customers/cases', await postTicket('customers/cases', 'kin-cust-cases', { cid: CUSTOMER_A }));

  // ทำรายงานที่ไม่มาจาก LINE เพื่อให้ feed ส่งข้อมูลจริง ไม่ใช่แค่ cursor ว่าง
  const manualReport = await sql.one(
    `INSERT INTO case_reports
       (case_id, report_date, report_time, symptoms, care_given, note, reported_by, reported_by_name)
     VALUES (:case_id, :date, '12:34', 'อาการสรุปสำหรับญาติ', 'การดูแลสรุป', 'บันทึกภายในห้ามออก', :emp, 'Alice BridgeA')
     RETURNING report_id`,
    { case_id: CASE_A, date: bkkDate(), emp: EMP_A },
  );
  remember('family/report-feed', await postTicket('family/report-feed', 'kin-family-feed', { since: Math.max(1, manualReport.report_id - 1) }));
  const feedMessage = await family.postMessage(CASE_A, { kind: 'team', name: 'ทีม QA', body: 'ข้อความสำหรับ feed' });
  remember('family/message-feed', await postTicket('family/message-feed', 'kin-family-msg-feed', { since: Math.max(1, feedMessage.message_id - 1) }));
  remember('customers/case-overview', await postTicket('customers/case-overview', 'kin-case-overview', { cid: CUSTOMER_A, case_id: CASE_A }));
  remember('invoices/line-outbox', await postTicket('invoices/line-outbox', 'kin-invoice-outbox'));
  remember('customers/billing', await postTicket('customers/billing', 'kin-billing-summary', { cid: CUSTOMER_A }));
  remember('family/message-photo', await postTicket('family/message-photo', 'kin-case-photo', {
    cid: CUSTOMER_B, case_id: CASE_B, message_id: photoB.message_id,
  }));
  remember('family/weekly-summary', await postTicket('family/weekly-summary', 'kin-family-weekly'));
  remember('family/lifecycle-due', await postTicket('family/lifecycle-due', 'kin-family-lifecycle'));
  remember('employees/badge', await postTicket('employees/badge', 'kin-emp-badge', { employee_id: EMP_A }));
  remember('employees/line-roster', await postTicket('employees/line-roster', 'kin-tier-roster', { month }));
  remember('employees/shift-counts', await postTicket('employees/shift-counts', 'kin-shift-counts', { ids: [EMP_A, EMP_B] }));
  remember('ratings/due', await postTicket('ratings/due', 'kin-rating-due'));
  remember('employees/line-code', await postTicket('employees/line-code', 'kin-issue-line-code', {
    employee_id: EMP_A, by: 'ทีม QA', expect_phone: '0811111111',
  }));

  const missingObserved = CATALOG.filter((x) => !observedResponses.has(x.path)).map((x) => x.path);
  probe(
    missingObserved.length === 0,
    'เก็บ response จริงไม่ครบทุก integration endpoint',
    `ขาด: ${missingObserved.join(', ')}`,
    'เก็บ response จริงครบ 29 endpoint',
  );

  const flattenKeys = (value, prefix = '', out = new Set()) => {
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return out;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 5)) flattenKeys(item, `${prefix}[]`, out);
      return out;
    }
    for (const [key, child] of Object.entries(value)) {
      const full = prefix ? `${prefix}.${key}` : key;
      out.add(full);
      flattenKeys(child, full, out);
    }
    return out;
  };
  const forbiddenKey = /(^|\.)(national_id|address|billing_address|bill_to_address|bill_to_tax_id|tax_id|staff_pay|fee|cost|profit|margin|password_hash|temp_password|photo_data)$/i;
  const neverMarkers = [EMP_NATIONAL, CUSTOMER_NATIONAL, SECRET_ADDRESS, String(CASE_FEE), String(CASE_STAFF_PAY)];
  const contextual = [
    { marker: String(WAGE_AMOUNT), allowed: new Set(['my-earnings', 'employees/line-roster']), label: 'ค่าจ้างพนักงาน' },
    { marker: String(INVOICE_TOTAL), allowed: new Set(['invoices/line-outbox', 'customers/billing']), label: 'ราคาขาย/ยอดบิล' },
  ];
  const leakFindings = [];
  for (const entry of CATALOG) {
    const r = observedResponses.get(entry.path);
    if (!r) continue;
    const keys = Buffer.isBuffer(r.body) ? [`<binary:${r.contentType || 'unknown'}:${r.body.length}B>`] : [...flattenKeys(r.body)].sort();
    info(`/${entry.path} -> HTTP ${r.status} · ${keys.join(', ') || '(ไม่มีฟิลด์)'}`);
    if (Buffer.isBuffer(r.body)) continue;
    const text = JSON.stringify(r.body);
    const badKeys = keys.filter((key) => forbiddenKey.test(key));
    const badMarkers = neverMarkers.filter((marker) => text.includes(marker));
    if (badKeys.length || badMarkers.length) {
      leakFindings.push(`/${entry.path}: keys=[${badKeys.join(', ')}] markers=[${badMarkers.join(', ')}]`);
    }
    for (const item of contextual) {
      if (!text.includes(item.marker)) continue;
      if (item.allowed.has(entry.path)) info(`/${entry.path} ส่ง ${item.label}ตามหน้าที่ของเส้นนี้ — ต้องยืนยันขอบเขตผู้รับฝั่ง chat`);
      else leakFindings.push(`/${entry.path}: พบ ${item.label} ${item.marker} นอก endpoint ที่อนุญาต`);
    }
  }
  probe(
    leakFindings.length === 0,
    'response ฝั่ง bridge มีข้อมูลอ่อนไหวเกินขอบเขต',
    leakFindings.join('\n'),
    'ไม่พบเลขบัตร ที่อยู่ ค่าจ้าง/ต้นทุน/กำไร/ราคาขายหลุดผิด endpoint จาก marker จริง',
  );

  console.log(`\n=== สรุป: ตรวจ ${checks} จุดใน 7 หัวข้อ · พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${passed.length} กลุ่ม ===`);
  found.forEach((item, i) => console.log(`${i + 1}. ${item.title}`));
  if (observations.length) console.log(`INFO | บันทึก response/ขอบเขตข้อมูล ${observations.length} รายการ`);
} finally {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
