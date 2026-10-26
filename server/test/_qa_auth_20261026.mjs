/**
 * QA รอบ 20 — ทางเข้าระบบ (server/src/auth)
 *
 * เกณฑ์ของชุดนี้คือความเสียหายต่อบัญชี ข้อมูล หรือคนใช้งานจริง ไม่ถือความต่างของ
 * HTTP status/ข้อความ error เป็นบัค ถ้าคำขออันตรายถูกปฏิเสธและไม่ทิ้งผลข้างเคียง
 *
 * ครอบคลุม 7 หัวข้อ:
 *   1. เดารหัสผ่านและขอบเขตของเพดาน
 *   2. ลืมรหัสผ่าน/OTP (อายุ เดา ใช้ซ้ำ ข้ามบัญชี และ race)
 *   3. รหัสผ่านชั่วคราวและผู้ที่มองเห็น/ออกบัญชีใหม่ได้
 *   4. เซสชัน (token ปลอม สถานะ/ตำแหน่งสด เปลี่ยนรหัส logout และ admin SSO)
 *   5. LINE login/link (purpose อายุ เจ้าของ replay และ race)
 *   6. ข้อมูลอ่อนไหวในคำตอบ
 *   7. ค่าเพี้ยนและ input ใหญ่
 *
 * รันบน PostgreSQL ชั่วคราว + Express จริง + HTTP จริงทุกข้อ:
 *   node test/_run_probe.mjs test/_qa_auth_20261026.mjs
 *
 * 🔴 ชุดนี้บังคับปิด SMTP ก่อน import แอป จึงไม่ส่งอีเมลจริง แม้เครื่องผู้รันมีค่า SMTP อยู่
 * 🔴 ไม่ต่อฐานจริง และ global fetch ถูกกั้นให้ออกได้เฉพาะ 127.0.0.1/localhost
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.RUN_DB_TESTS, '1');
const testDbUrl = new URL(process.env.DATABASE_URL);
assert.equal(testDbUrl.hostname, '127.0.0.1');
assert.equal(testDbUrl.pathname, '/kin_api_test');

// mailer อ่าน env ตอน import ครั้งแรก — ลบทิ้งก่อน import app เพื่อรับประกันว่าไม่มีอีเมลจริงออกจากชุด QA
for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[key];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`QA auth กั้นการยิงออกนอกเครื่อง: ${url.origin}`);
  }
  return realFetch(input, init);
};

const { createApp } = await import('../src/app.js');
const {
  COOKIE_NAME,
  hashPassword,
  signToken,
  verifyPassword,
} = await import('../src/lib/auth.js');
const { mailerReady } = await import('../src/lib/mailer.js');
const { ensureLineColumn, ensureTicketUsedTable, verifySigned } = await import('../src/lib/lineBridge.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');
// ใช้ตัวเซ็นจริงของฝั่ง chat กับกุญแจชั่วคราวที่ _run_probe สร้างให้ ไม่อ่าน secret/file ของจริง
const { sign } = await import('../../../kin-chatbot/src/lib/staffBridge.js');

assert.equal(mailerReady, false, 'QA auth ต้องอยู่ในโหมดไม่ส่งอีเมลจริง');

const FIXTURE_PASSWORD = 'Fixture-password-123!';
const SECOND_PASSWORD = 'Second-password-456!';
const NEW_PASSWORD = 'New-password-789!';

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', first_name: 'Manager', last_name: 'QA' };
const HR = { employee_id: 'EMP-0007', position: 'hr', first_name: 'HR', last_name: 'QA' };
const FIELD = { employee_id: 'EMP-0003', position: 'caregiver', first_name: 'Field', last_name: 'QA' };
const TEMP_FIXTURE = { employee_id: 'EMP-0004', position: 'caregiver', first_name: 'Temp', last_name: 'Fixture' };
const SUSPENDED_FIXTURE = { employee_id: 'EMP-0005', position: 'caregiver', first_name: 'Suspended', last_name: 'Fixture' };

const ACTORS = {
  authA: { employee_id: 'AUTH-A', position: 'caregiver', email: 'auth.a@example.invalid', first_name: 'Auth', last_name: 'A' },
  authB: { employee_id: 'AUTH-B', position: 'caregiver', email: 'auth.b@example.invalid', first_name: 'Auth', last_name: 'B' },
  otpA: { employee_id: 'OTP-A', position: 'caregiver', email: 'otp.a@example.invalid', first_name: 'Otp', last_name: 'A' },
  otpB: { employee_id: 'OTP-B', position: 'caregiver', email: 'otp.b@example.invalid', first_name: 'Otp', last_name: 'B' },
  otpReplay: { employee_id: 'OTP-REPLAY', position: 'caregiver', email: 'otp.replay@example.invalid', first_name: 'Otp', last_name: 'Replay' },
  otpReset: { employee_id: 'OTP-RESET', position: 'caregiver', email: 'otp.reset@example.invalid', first_name: 'Otp', last_name: 'Reset' },
  admin: { employee_id: 'AUTH-ADMIN', position: 'admin', email: 'admin.auth@example.invalid', first_name: 'Admin', last_name: 'QA' },
  finance: { employee_id: 'AUTH-FIN', position: 'finance', email: 'finance.auth@example.invalid', first_name: 'Finance', last_name: 'QA' },
  demote: { employee_id: 'AUTH-DEMOTE', position: 'manager', email: 'demote.auth@example.invalid', first_name: 'Demote', last_name: 'QA' },
  session: { employee_id: 'AUTH-SESSION', position: 'caregiver', email: 'session.auth@example.invalid', first_name: 'Session', last_name: 'QA' },
  resigned: { employee_id: 'AUTH-RESIGNED', position: 'caregiver', email: 'resigned.auth@example.invalid', first_name: 'Resigned', last_name: 'QA', status: 'resigned' },
  lineA: { employee_id: 'AUTH-LINE-A', position: 'caregiver', email: 'line.a@example.invalid', first_name: 'Line', last_name: 'A' },
  lineB: { employee_id: 'AUTH-LINE-B', position: 'caregiver', email: 'line.b@example.invalid', first_name: 'Line', last_name: 'B' },
  secret: { employee_id: 'AUTH-SECRET', position: 'caregiver', email: 'secret.auth@example.invalid', first_name: 'Secret', last_name: 'QA' },
};

await seedFixtures(pool, hashPassword);
await ensureLineColumn();
await ensureTicketUsedTable();
const fixtureHash = await hashPassword(FIXTURE_PASSWORD);
for (const actor of Object.values(ACTORS)) {
  await sql.run(
    `INSERT INTO employees
       (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
     VALUES (:id, :first, :last, :position, :email, :status, :hash, false)`,
    {
      id: actor.employee_id,
      first: actor.first_name,
      last: actor.last_name,
      position: actor.position,
      email: actor.email,
      status: actor.status ?? 'active',
      hash: fixtureHash,
    },
  );
}

// marker จริงสำหรับตรวจ response ว่ามีข้อมูลอ่อนไหวหลุดหรือไม่
const SECRET_NATIONAL_ID = '1101700203999';
const SECRET_TEMP_COPY = 'ENCRYPTED-TEMP-COPY-MUST-NOT-LEAK';
await sql.run(
  `UPDATE employees SET national_id = :nid, address = 'AUTH SECRET ADDRESS',
     temp_password_encrypted = :temp
   WHERE employee_id = :id`,
  { id: ACTORS.secret.employee_id, nid: SECRET_NATIONAL_ID, temp: SECRET_TEMP_COPY },
);

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const cookieFor = (who) => `${COOKIE_NAME}=${signToken(who)}`;
const firstCookie = (setCookie) => (setCookie ? setCookie.split(';')[0] : null);

async function call(method, path, { body, cookie, headers = {}, redirect = 'manual', signal } = {}) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    redirect,
    signal,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = text;
  if ((response.headers.get('content-type') || '').includes('json')) {
    try { data = JSON.parse(text); } catch { /* เก็บ text ดิบเพื่อให้ผลตรวจอธิบายได้ */ }
  }
  return {
    status: response.status,
    body: data,
    location: response.headers.get('location'),
    setCookie: response.headers.get('set-cookie'),
    elapsedMs: performance.now() - started,
  };
}

const get = (path, options = {}) => call('GET', path, options);
const post = (path, body, options = {}) => call('POST', path, { ...options, body: body ?? {} });
const patch = (path, body, options = {}) => call('PATCH', path, { ...options, body: body ?? {} });

async function login(email, password, options = {}) {
  return post('/api/auth/login', { email, password }, options);
}

const LINE = (hex) => `U${String(hex).repeat(32).slice(0, 32)}`;
function ticket(purpose, fields = {}, ttlMs = 60_000) {
  const value = sign({ ...fields, a: purpose }, ttlMs);
  assert.ok(value, 'ไม่มี STAFF_BRIDGE_PRIVATE_KEY ชั่วคราวจาก _run_probe');
  return value;
}

const signerProbe = ticket('kin-staff', { u: LINE('0') });
assert.ok(verifySigned(signerProbe, 'kin-staff'), 'กุญแจชั่วคราวของตัวเซ็นและตัวตรวจไม่เข้าคู่กัน');

async function captureConsole(run) {
  const original = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.map((x) => String(x)).join(' '));
  try {
    return { value: await run(), logs };
  } finally {
    console.log = original;
  }
}

const otpCodes = (logs) => [...logs.join('\n').matchAll(/คือ\s+(\d{6})/g)].map((m) => m[1]);

async function putOtp(employeeId, code, seconds = 600) {
  const row = await sql.one(
    `INSERT INTO password_reset_otps (employee_id, code_hash, expires_at)
     VALUES (:id, :hash, now() + make_interval(secs => :seconds)) RETURNING otp_id`,
    { id: employeeId, hash: await hashPassword(code), seconds },
  );
  return row.otp_id;
}

let checks = 0;
const found = [];
const passed = [];
const observations = [];
const head = (title) => console.log(`\n=== ${title} ===`);
const brief = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
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
const sameBody = (a, b) => JSON.stringify(a.body) === JSON.stringify(b.body);
const statusList = (rows) => rows.map((r) => r.status).sort((a, b) => a - b).join(',');
const rejected = (response) => response.status >= 400 && response.status < 500;

try {
  // ---------------------------------------------------------------------------
  head('1 · เดารหัสผ่าน — เพดาน บัญชี/IP การปลดล็อก และการยิงพร้อมกัน');
  await sql.run('DELETE FROM login_failures');

  const knownWrong = await login(ACTORS.authA.email, 'wrong-password');
  const unknownWrong = await login('nobody.auth@example.invalid', 'wrong-password');
  probe(
    knownWrong.status === 401 && unknownWrong.status === 401 && sameBody(knownWrong, unknownWrong),
    'ล็อกอินผิดบอกใบ้ว่าอีเมลใดมีบัญชีอยู่จริง',
    `known=${knownWrong.status} ${brief(knownWrong.body)} | unknown=${unknownWrong.status} ${brief(unknownWrong.body)}`,
    'อีเมลที่มีจริงและไม่มีจริงตอบเหมือนกันเมื่อรหัสผิด',
  );

  await sql.run('DELETE FROM login_failures');
  const sequential = [];
  for (let i = 0; i < 10; i++) {
    sequential.push(await login(
      i % 2 ? `  ${ACTORS.authA.email.toUpperCase()}  ` : ACTORS.authA.email,
      `wrong-${i}`,
      { headers: { 'x-forwarded-for': i % 2 ? '198.51.100.10' : '203.0.113.20' } },
    ));
  }
  const lockedCorrect = await login(ACTORS.authA.email, FIXTURE_PASSWORD, {
    headers: { 'x-forwarded-for': '192.0.2.30' },
  });
  const otherSameIp = await login(ACTORS.authB.email, FIXTURE_PASSWORD, {
    headers: { 'x-forwarded-for': '192.0.2.30' },
  });
  probe(
    sequential.every((r) => r.status === 401) && lockedCorrect.status === 429 && otherSameIp.status === 200,
    'เพดานเดารหัสไม่ล็อกบัญชีหลังผิด 10 ครั้ง หรือพาล็อกบัญชีอื่นจาก IP เดียวกัน',
    `wrong=[${statusList(sequential)}] locked=${lockedCorrect.status} other=${otherSameIp.status}`,
    'ผิด 10 ครั้งล็อกชื่อบัญชีเดียวกันข้ามตัวพิมพ์/IP แต่บัญชีอื่นจาก IP เดิมยังเข้าได้',
  );
  info('เพดานล็อกอินผูกกับชื่อบัญชีที่ normalize เป็นตัวพิมพ์เล็ก ไม่ได้มีเพดานรวมต่อ IP (password spraying ยังไม่ถูกจำกัด)');

  await sql.run(
    `UPDATE login_failures SET created_at = now() - interval '16 minutes'
     WHERE email_key = lower(:email)`,
    { email: ACTORS.authA.email },
  );
  const unlocked = await login(ACTORS.authA.email, FIXTURE_PASSWORD);
  const failuresAfterSuccess = await sql.one(
    'SELECT count(*)::int AS n FROM login_failures WHERE email_key = lower(:email)',
    { email: ACTORS.authA.email },
  );
  probe(
    unlocked.status === 200 && failuresAfterSuccess.n === 0,
    'ครบเวลาล็อกแล้วบัญชียังเข้าไม่ได้ หรือประวัติผิดไม่ถูกล้างเมื่อเข้าได้',
    `${unlocked.status} failures=${failuresAfterSuccess.n} ${brief(unlocked.body)}`,
    'ครบ 15 นาทีแล้วเข้าได้ และ login สำเร็จล้างประวัติผิดของบัญชีนั้น',
  );

  // เพดานต้องคุมจำนวนคำขอจริง ไม่ใช่แค่คำขอทีละตัว — burst คือรูปแบบของ brute force จริง
  await sql.run('DELETE FROM login_failures');
  const burst = await Promise.all(
    Array.from({ length: 25 }, (_, i) => login(ACTORS.authA.email, `burst-wrong-${i}`, {
      headers: { 'x-forwarded-for': `198.51.100.${(i % 4) + 1}` },
    })),
  );
  const burst401 = burst.filter((r) => r.status === 401).length;
  const burst429 = burst.filter((r) => r.status === 429).length;
  const burst500 = burst.filter((r) => r.status >= 500).length;
  probe(
    burst401 <= 10 && burst429 >= 15 && burst500 === 0,
    'ยิงรหัสผิดพร้อมกันทะลุเพดาน 10 ครั้งของบัญชีเดียว',
    `25 คำขอพร้อมกัน -> 401=${burst401}, 429=${burst429}, 5xx=${burst500}`,
    'burst บัญชีเดียวถูกปล่อยให้เทียบรหัสไม่เกิน 10 ครั้ง ที่เหลือโดน 429',
  );

  // ---------------------------------------------------------------------------
  head('2 · ลืมรหัสผ่าน/OTP — enumeration, cooldown, อายุ, เดา, ข้ามบัญชี และ replay');
  await sql.run('DELETE FROM password_reset_otps');
  await sql.run('DELETE FROM login_failures');

  const knownForgot = await captureConsole(() => post('/api/auth/forgot-password', { email: ACTORS.otpA.email }));
  const unknownForgot = await post('/api/auth/forgot-password', { email: 'missing.otp@example.invalid' });
  const issuedCode = otpCodes(knownForgot.logs)[0];
  probe(
    knownForgot.value.status === 200 && unknownForgot.status === 200 && sameBody(knownForgot.value, unknownForgot) && /^\d{6}$/.test(issuedCode ?? ''),
    'คำขอ OTP ครั้งแรกบอกใบ้อีเมลที่มีจริง หรือโหมดทดสอบไม่ได้สร้าง OTP',
    `known=${knownForgot.value.status} unknown=${unknownForgot.status} codes=${otpCodes(knownForgot.logs).length}`,
    'คำขอ OTP ครั้งแรกตอบเหมือนกัน และจับ OTP จาก dev log ได้โดยไม่ส่งอีเมลจริง',
  );

  const knownAgain = await post('/api/auth/forgot-password', { email: ACTORS.otpA.email });
  const unknownAgain = await post('/api/auth/forgot-password', { email: 'missing.otp@example.invalid' });
  probe(
    knownAgain.status === unknownAgain.status && sameBody(knownAgain, unknownAgain),
    'กดขอ OTP ซ้ำทันทีใช้แยกได้ว่าอีเมลใดเป็นพนักงานจริง',
    `อีเมลจริง=${knownAgain.status} ${brief(knownAgain.body)} | ไม่มีจริง=${unknownAgain.status} ${brief(unknownAgain.body)}`,
    'ขอ OTP ซ้ำทันทีไม่ทำให้คำตอบของอีเมลจริงต่างจากอีเมลที่ไม่มี',
  );

  // ขอพร้อมกันหลายใบ: ต้องไม่ส่งหลายรหัสและเหลือหลายใบที่ใช้ได้จนผู้ใช้สับสนว่าใบไหนคือใบล่าสุด
  await sql.run('DELETE FROM password_reset_otps WHERE employee_id = :id', { id: ACTORS.otpA.employee_id });
  const forgotBurst = await captureConsole(() => Promise.all(
    Array.from({ length: 12 }, () => post('/api/auth/forgot-password', { email: ACTORS.otpA.email })),
  ));
  const forgotBurstCodes = otpCodes(forgotBurst.logs);
  const otpBurstRows = await sql.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE used_at IS NULL AND expires_at > now())::int AS active
     FROM password_reset_otps WHERE employee_id = :id`,
    { id: ACTORS.otpA.employee_id },
  );
  const forgotBurst200 = forgotBurst.value.filter((r) => r.status === 200).length;
  probe(
    forgotBurstCodes.length === 1 && otpBurstRows.active === 1
      && forgotBurst.value.every((r) => r.status < 500),
    'ขอ OTP พร้อมกันแล้วส่งหลายรหัส/เหลือหลายใบที่ใช้ได้',
    `12 คำขอ -> 200=${forgotBurst200}, dev-mail=${forgotBurstCodes.length}, rows=${otpBurstRows.total}, active=${otpBurstRows.active}, statuses=[${statusList(forgotBurst.value)}]`,
    'คำขอ OTP พร้อมกันส่งเพียงหนึ่งรหัสและเหลือใบที่ใช้ได้ใบเดียว',
  );

  await sql.run('DELETE FROM password_reset_otps');
  const supersededCode = '111111';
  const supersededId = await putOtp(ACTORS.otpB.employee_id, supersededCode);
  await sql.run(
    `UPDATE password_reset_otps SET created_at = now() - interval '2 minutes'
     WHERE otp_id = :otp`,
    { otp: supersededId },
  );
  const replacementForgot = await captureConsole(() => post('/api/auth/forgot-password', { email: ACTORS.otpB.email }));
  const replacementCode = otpCodes(replacementForgot.logs)[0];
  const useSuperseded = await post('/api/auth/reset-password', {
    email: ACTORS.otpB.email,
    code: supersededCode,
    new_password: SECOND_PASSWORD,
  });
  const useReplacement = await post('/api/auth/reset-password', {
    email: ACTORS.otpB.email,
    code: replacementCode,
    new_password: SECOND_PASSWORD,
  });
  const supersededRow = await sql.one(
    'SELECT used_at FROM password_reset_otps WHERE otp_id = :otp',
    { otp: supersededId },
  );
  probe(
    replacementForgot.value.status === 200 && /^\d{6}$/.test(replacementCode ?? '')
      && rejected(useSuperseded) && useReplacement.status === 200 && supersededRow.used_at != null,
    'ขอ OTP ใหม่แล้วใบเก่ายังใช้เปลี่ยนรหัสได้ หรือใบใหม่กลับใช้ไม่ได้',
    `forgot=${replacementForgot.value.status}, old=${useSuperseded.status}, new=${useReplacement.status}, oldUsed=${supersededRow.used_at != null}`,
    'ออก OTP ใหม่ยกเลิกใบเก่าทันที และมีเพียงรหัสใหม่ที่เปลี่ยนรหัสได้',
  );

  await sql.run('DELETE FROM password_reset_otps');
  const expiredCode = '101010';
  await putOtp(ACTORS.otpA.employee_id, expiredCode, -1);
  const expiredBefore = await sql.one('SELECT password_hash FROM employees WHERE employee_id = :id', { id: ACTORS.otpA.employee_id });
  const expired = await post('/api/auth/reset-password', {
    email: ACTORS.otpA.email,
    code: expiredCode,
    new_password: NEW_PASSWORD,
  });
  const expiredAfter = await sql.one('SELECT password_hash FROM employees WHERE employee_id = :id', { id: ACTORS.otpA.employee_id });
  probe(
    expired.status >= 400 && expired.status < 500 && expiredBefore.password_hash === expiredAfter.password_hash,
    'OTP หมดอายุยังเปลี่ยนรหัสผ่านได้หรือทำให้ credential เปลี่ยน',
    `${expired.status} ${brief(expired.body)}`,
    'OTP หมดอายุถูกปฏิเสธและไม่แตะรหัสผ่าน',
  );

  await sql.run('DELETE FROM password_reset_otps');
  const crossCode = '202020';
  await putOtp(ACTORS.otpA.employee_id, crossCode);
  const cross = await post('/api/auth/reset-password', {
    email: ACTORS.otpB.email,
    code: crossCode,
    new_password: NEW_PASSWORD,
  });
  const crossOwner = await sql.one(
    'SELECT attempts, used_at FROM password_reset_otps WHERE employee_id = :id ORDER BY otp_id DESC LIMIT 1',
    { id: ACTORS.otpA.employee_id },
  );
  probe(
    cross.status >= 400 && cross.status < 500 && crossOwner.attempts === 0 && crossOwner.used_at == null,
    'OTP ของพนักงานคนหนึ่งใช้หรือเผา OTP ผ่านอีเมลของอีกคนได้',
    `${cross.status} ownerOtp=${brief(crossOwner)}`,
    'OTP ผูกกับ employee ของอีเมลนั้น ใช้ข้ามบัญชีไม่ได้และไม่กินสิทธิ์เดาของเจ้าของเดิม',
  );

  await sql.run('DELETE FROM password_reset_otps');
  const guessCode = '303030';
  await putOtp(ACTORS.otpA.employee_id, guessCode);
  const wrongGuesses = [];
  for (let i = 0; i < 6; i++) {
    wrongGuesses.push(await post('/api/auth/reset-password', {
      email: ACTORS.otpA.email,
      code: String(700000 + i),
      new_password: NEW_PASSWORD,
    }));
  }
  const guessedOtp = await sql.one(
    'SELECT attempts, used_at FROM password_reset_otps WHERE employee_id = :id ORDER BY otp_id DESC LIMIT 1',
    { id: ACTORS.otpA.employee_id },
  );
  probe(
    wrongGuesses.slice(0, 5).every((r) => r.status === 400) && wrongGuesses[5].status === 429
      && guessedOtp.attempts === 5 && guessedOtp.used_at != null,
    'OTP ยังเดาเกิน 5 ครั้งได้ หรือครบเพดานแล้วใบเดิมยังไม่ตาย',
    `statuses=[${statusList(wrongGuesses)}] row=${brief(guessedOtp)}`,
    'เดา OTP ผิดได้ไม่เกิน 5 ครั้ง จากนั้นใบเดิมตายและตอบ 429',
  );

  await sql.run('DELETE FROM password_reset_otps');
  await putOtp(ACTORS.otpA.employee_id, '404040');
  const guessBurst = await Promise.all(
    Array.from({ length: 20 }, (_, i) => post('/api/auth/reset-password', {
      email: ACTORS.otpA.email,
      code: String(800000 + i),
      new_password: NEW_PASSWORD,
    })),
  );
  const guessBurstRow = await sql.one(
    'SELECT attempts, used_at FROM password_reset_otps WHERE employee_id = :id ORDER BY otp_id DESC LIMIT 1',
    { id: ACTORS.otpA.employee_id },
  );
  probe(
    guessBurst.filter((r) => r.status === 400).length <= 5
      && guessBurst.every((r) => r.status === 400 || r.status === 429)
      && guessBurstRow.attempts <= 5 && guessBurstRow.used_at != null,
    'ยิงเดา OTP พร้อมกันทะลุเพดาน 5 ครั้ง',
    `400=${guessBurst.filter((r) => r.status === 400).length}, 429=${guessBurst.filter((r) => r.status === 429).length}, row=${brief(guessBurstRow)}`,
    'เพดานเดา OTP เป็น atomic แม้ยิงพร้อมกัน และไม่มีคำขอใดผ่าน/ล้มเป็น 500',
  );

  await sql.run('DELETE FROM password_reset_otps');
  const replayCode = '505050';
  await putOtp(ACTORS.otpReplay.employee_id, replayCode);
  const replayReset = await Promise.all([
    post('/api/auth/reset-password', { email: ACTORS.otpReplay.email, code: replayCode, new_password: SECOND_PASSWORD }),
    post('/api/auth/reset-password', { email: ACTORS.otpReplay.email, code: replayCode, new_password: SECOND_PASSWORD }),
  ]);
  const replayRow = await sql.one(
    'SELECT used_at FROM password_reset_otps WHERE employee_id = :id ORDER BY otp_id DESC LIMIT 1',
    { id: ACTORS.otpReplay.employee_id },
  );
  probe(
    replayReset.filter((r) => r.status === 200).length === 1
      && replayReset.filter(rejected).length === 1 && replayRow.used_at != null,
    'OTP ถูกใบเดียวใช้เปลี่ยนรหัสสำเร็จซ้ำได้เมื่อยิงพร้อมกัน',
    `statuses=[${statusList(replayReset)}] row=${brief(replayRow)}`,
    'OTP ถูกใช้พร้อมกันสำเร็จเพียงคำขอเดียว อีกคำขอถูกปฏิเสธ',
  );

  await sql.run('DELETE FROM password_reset_otps');
  const resetCode = '606060';
  const oldResetCookie = cookieFor(ACTORS.otpReset);
  await putOtp(ACTORS.otpReset.employee_id, resetCode);
  const resetOk = await post('/api/auth/reset-password', {
    email: ACTORS.otpReset.email,
    code: resetCode,
    new_password: NEW_PASSWORD,
  });
  const oldSessionAfterReset = await get('/api/auth/me', { cookie: oldResetCookie });
  const oldPasswordAfterReset = await login(ACTORS.otpReset.email, FIXTURE_PASSWORD);
  const newPasswordAfterReset = await login(ACTORS.otpReset.email, NEW_PASSWORD);
  probe(
    resetOk.status === 200 && oldSessionAfterReset.status === 401
      && oldPasswordAfterReset.status === 401 && newPasswordAfterReset.status === 200,
    'รีเซ็ตรหัสแล้วเซสชัน/รหัสเก่ายังใช้เข้าบัญชีได้ หรือรหัสใหม่ใช้ไม่ได้',
    `reset=${resetOk.status} oldSession=${oldSessionAfterReset.status} oldPassword=${oldPasswordAfterReset.status} newPassword=${newPasswordAfterReset.status}`,
    'รีเซ็ตสำเร็จตัดเซสชันและรหัสเก่าทันที แล้วเข้าได้ด้วยรหัสใหม่',
  );

  // ---------------------------------------------------------------------------
  head('3 · รหัสผ่านชั่วคราว — ทำอะไรได้ ใครเห็น/ออกบัญชีได้ และการเปลี่ยนรหัส');
  const managerCookie = cookieFor(MANAGER);
  const hrCookie = cookieFor(HR);
  const adminCookie = cookieFor(ACTORS.admin);
  const financeCookie = cookieFor(ACTORS.finance);
  const fieldCookie = cookieFor(FIELD);

  const createdTemp = await post('/api/employees', {
    first_name: 'Temporary', last_name: 'AuthQA', email: 'temporary.auth@example.invalid', position: 'caregiver',
  }, { cookie: managerCookie });
  assert.equal(createdTemp.status, 201, `สร้างพนักงานชั่วคราวไม่สำเร็จ: ${brief(createdTemp.body)}`);
  assert.equal(typeof createdTemp.body.temp_password, 'string');
  const tempId = createdTemp.body.employee_id;
  const tempPassword = createdTemp.body.temp_password;
  const tempLogin = await login('  TEMPORARY.AUTH@EXAMPLE.INVALID  ', tempPassword);
  const tempCookie = firstCookie(tempLogin.setCookie);
  assert.ok(tempCookie, `login รหัสชั่วคราวไม่ได้: ${brief(tempLogin.body)}`);

  const tempMe = await get('/api/auth/me', { cookie: tempCookie });
  const tempWork = await get('/api/my/today', { cookie: tempCookie });
  const tempAdminWork = await get('/api/employees', { cookie: tempCookie });
  probe(
    tempMe.status === 200 && tempMe.body.must_change_password === true
      && rejected(tempWork) && rejected(tempAdminWork),
    'บัญชีที่ยังใช้รหัสชั่วคราวทำงานจริงในระบบได้',
    `me=${tempMe.status} my/today=${tempWork.status} employees=${tempAdminWork.status}`,
    'รหัสชั่วคราวเข้าได้เฉพาะ auth/me แต่ทุกเส้นงานถูกด่านเปลี่ยนรหัสปิดไว้',
  );

  // LINE link อยู่ใต้ /api/auth โดยตั้งใจสำหรับ onboarding; บันทึกขอบเขตไว้ แต่ไม่ถือเป็นบัคถ้างานจริงยังถูกปิด
  const tempLine = LINE('a1');
  const tempLineLink = await post('/api/auth/line-link', { t: ticket('kin-staff', { u: tempLine }) }, { cookie: tempCookie });
  const tempLineStored = await sql.one('SELECT line_user_id FROM employees WHERE employee_id = :id', { id: tempId });
  info(`บัญชีรหัสชั่วคราวผูก LINE ระหว่าง onboarding ได้ (${tempLineLink.status}, stored=${tempLineStored.line_user_id === tempLine}) แต่เส้นงานยังตอบ ${tempWork.status}`);

  const tempDetailManager = await get(`/api/employees/${tempId}`, { cookie: managerCookie });
  const tempDetailHr = await get(`/api/employees/${tempId}`, { cookie: hrCookie });
  const tempDetailAdmin = await get(`/api/employees/${tempId}`, { cookie: adminCookie });
  const tempDetailFinance = await get(`/api/employees/${tempId}`, { cookie: financeCookie });
  const tempDetailField = await get(`/api/employees/${tempId}`, { cookie: fieldCookie });
  probe(
    [tempDetailManager, tempDetailHr, tempDetailAdmin].every((r) => r.status === 200 && r.body.temp_password === tempPassword)
      && tempDetailFinance.status === 403 && tempDetailField.status === 403,
    'รหัสชั่วคราวหลุดให้ตำแหน่งนอกฝ่ายที่จัดการพนักงาน หรือผู้ดูแลที่ต้องส่งรหัสกลับมองไม่เห็น',
    `manager=${tempDetailManager.status}, hr=${tempDetailHr.status}, admin=${tempDetailAdmin.status}, finance=${tempDetailFinance.status}, field=${tempDetailField.status}`,
    'เฉพาะ Manager/HR/Admin HC มองเห็นรหัสชั่วคราวของพนักงานทั่วไป; การเงิน/ภาคสนามเข้าไม่ได้',
  );

  const createByHr = await post('/api/employees', {
    first_name: 'Made', last_name: 'ByHR', email: 'made.by.hr@example.invalid', position: 'caregiver',
  }, { cookie: hrCookie });
  const createByAdmin = await post('/api/employees', {
    first_name: 'Made', last_name: 'ByAdmin', email: 'made.by.admin@example.invalid', position: 'caregiver',
  }, { cookie: adminCookie });
  const createByFinance = await post('/api/employees', {
    first_name: 'Made', last_name: 'ByFinance', email: 'made.by.finance@example.invalid', position: 'caregiver',
  }, { cookie: financeCookie });
  const createByField = await post('/api/employees', {
    first_name: 'Made', last_name: 'ByField', email: 'made.by.field@example.invalid', position: 'caregiver',
  }, { cookie: fieldCookie });
  const hrCreatesManager = await post('/api/employees', {
    first_name: 'Manager', last_name: 'ByHR', email: 'manager.by.hr@example.invalid', position: 'manager',
  }, { cookie: hrCookie });
  const adminCreatesFinance = await post('/api/employees', {
    first_name: 'Finance', last_name: 'ByAdmin', email: 'finance.by.admin@example.invalid', position: 'finance',
  }, { cookie: adminCookie });
  probe(
    createByHr.status === 201 && typeof createByHr.body.temp_password === 'string'
      && createByAdmin.status === 201 && typeof createByAdmin.body.temp_password === 'string'
      && createByFinance.status === 403 && createByField.status === 403
      && hrCreatesManager.status === 403 && adminCreatesFinance.status === 403,
    'ตำแหน่งที่ไม่ควรออกบัญชี/สิทธิ์สูงสามารถสร้างบัญชีพร้อมรหัสชั่วคราวได้',
    `HR-worker=${createByHr.status}, Admin-worker=${createByAdmin.status}, Finance-worker=${createByFinance.status}, Field-worker=${createByField.status}, HR-manager=${hrCreatesManager.status}, Admin-finance=${adminCreatesFinance.status}`,
    'Manager/HR/Admin HC ออกบัญชีพนักงานทั่วไปได้; Finance/Field ไม่ได้ และ HR/Admin แต่งตั้งสิทธิ์เงินไม่ได้',
  );

  const beforeCredentialPatch = await sql.one(
    'SELECT password_hash, must_change_password, temp_password_encrypted FROM employees WHERE employee_id = :id',
    { id: ACTORS.authB.employee_id },
  );
  const fakeReissue = await patch(`/api/employees/${ACTORS.authB.employee_id}`, {
    password: 'forced', password_hash: 'forced', temp_password: 'forced', must_change_password: true,
  }, { cookie: hrCookie });
  const afterCredentialPatch = await sql.one(
    'SELECT password_hash, must_change_password, temp_password_encrypted FROM employees WHERE employee_id = :id',
    { id: ACTORS.authB.employee_id },
  );
  probe(
    fakeReissue.status < 500 && JSON.stringify(beforeCredentialPatch) === JSON.stringify(afterCredentialPatch),
    'แก้แฟ้มพนักงานทั่วไปแล้วแอบเขียน credential/ออกรหัสชั่วคราวใหม่ให้คนอื่นได้',
    `${fakeReissue.status} before=${brief(beforeCredentialPatch)} after=${brief(afterCredentialPatch)}`,
    'PATCH แฟ้มพนักงานไม่รับช่อง credential จึงใช้เป็นทางออกรหัสใหม่/ยึดบัญชีไม่ได้',
  );

  const oldTempCookie = tempCookie;
  const changedTemp = await post('/api/auth/change-password', {
    current_password: tempPassword,
    new_password: SECOND_PASSWORD,
  }, { cookie: tempCookie });
  const freshTempCookie = firstCookie(changedTemp.setCookie);
  const oldTempSession = await get('/api/auth/me', { cookie: oldTempCookie });
  const freshTempSession = await get('/api/auth/me', { cookie: freshTempCookie });
  const tempWorkAfterChange = await get('/api/my/today', { cookie: freshTempCookie });
  const tempCredentialAfter = await sql.one(
    'SELECT must_change_password, temp_password_encrypted FROM employees WHERE employee_id = :id',
    { id: tempId },
  );
  const detailAfterChange = await get(`/api/employees/${tempId}`, { cookie: managerCookie });
  probe(
    changedTemp.status === 200 && oldTempSession.status === 401 && freshTempSession.status === 200
      && tempWorkAfterChange.status === 200
      && tempCredentialAfter.must_change_password === false && tempCredentialAfter.temp_password_encrypted == null
      && !('temp_password' in detailAfterChange.body),
    'เปลี่ยนรหัสชั่วคราวแล้ว token/สำเนารหัสเก่ายังคงใช้หรือเปิดดูได้',
    `change=${changedTemp.status}, old=${oldTempSession.status}, fresh=${freshTempSession.status}, work=${tempWorkAfterChange.status}, row=${brief(tempCredentialAfter)}`,
    'เปลี่ยนรหัสแล้วออก session ใหม่ ตัด session เก่า ล้างสำเนารหัสชั่วคราว และเปิดงานได้',
  );

  // ---------------------------------------------------------------------------
  head('4 · เซสชัน — token ปลอม สถานะ/ตำแหน่งสด เปลี่ยนรหัส logout และ admin SSO');
  const validSessionToken = signToken(ACTORS.session);
  const fakeCookie = `${COOKIE_NAME}=abc.def.ghi`;
  const tamperedToken = `${validSessionToken.slice(0, -8)}AAAAAAAA`;
  const fakeSession = await get('/api/auth/me', { cookie: fakeCookie });
  const tamperedSession = await get('/api/auth/me', { cookie: `${COOKIE_NAME}=${tamperedToken}` });
  probe(
    rejected(fakeSession) && rejected(tamperedSession)
      && fakeSession.setCookie?.includes(`${COOKIE_NAME}=`) && tamperedSession.setCookie?.includes(`${COOKIE_NAME}=`),
    'คุกกี้ปลอมหรือ token ที่ถูกแก้ยังผ่าน หรือของเสียไม่ถูกล้างจากเบราว์เซอร์',
    `fake=${fakeSession.status} tampered=${tamperedSession.status}`,
    'คุกกี้ปลอม/แก้ลายเซ็นถูกปฏิเสธและมีคำสั่งล้างคุกกี้',
  );

  const sessionCookie = `${COOKIE_NAME}=${validSessionToken}`;
  await sql.run("UPDATE employees SET status = 'suspended' WHERE employee_id = :id", { id: ACTORS.session.employee_id });
  const suspendedToken = await get('/api/auth/me', { cookie: sessionCookie });
  const resignedToken = await get('/api/auth/me', { cookie: cookieFor(ACTORS.resigned) });
  probe(
    rejected(suspendedToken) && rejected(resignedToken),
    'token ของคนถูกพักงาน/ลาออกยังเรียก API ได้จนหมดอายุ',
    `suspended=${suspendedToken.status} resigned=${resignedToken.status}`,
    'สถานะพักงาน/ลาออกถูกอ่านสดและตัด token เดิมทันที',
  );
  await sql.run("UPDATE employees SET status = 'active' WHERE employee_id = :id", { id: ACTORS.session.employee_id });

  const demoteCookie = cookieFor(ACTORS.demote);
  const beforeDemote = await get('/api/employees/meta', { cookie: demoteCookie });
  await sql.run("UPDATE employees SET position = 'caregiver' WHERE employee_id = :id", { id: ACTORS.demote.employee_id });
  const afterDemote = await get('/api/employees/meta', { cookie: demoteCookie });
  const meAfterDemote = await get('/api/auth/me', { cookie: demoteCookie });
  probe(
    beforeDemote.status === 200 && rejected(afterDemote)
      && meAfterDemote.status === 200 && meAfterDemote.body.role === 'field'
      && Array.isArray(meAfterDemote.body.permissions) && meAfterDemote.body.permissions.length === 0,
    'ลดตำแหน่งแล้ว token เก่ายังถือสิทธิ์ผู้จัดการ',
    `before=${beforeDemote.status}, after=${afterDemote.status}, me=${brief(meAfterDemote.body)}`,
    'ตำแหน่ง/สิทธิ์อ่านสดจาก DB — ลดตำแหน่งแล้วสิทธิ์หายในการยิงครั้งถัดไป',
  );

  await sql.run('DELETE FROM login_failures');
  const logoutLogin = await login(ACTORS.authB.email, FIXTURE_PASSWORD);
  const logoutCookie = firstCookie(logoutLogin.setCookie);
  assert.ok(logoutCookie, `เตรียม session สำหรับ logout ไม่ได้: ${brief(logoutLogin.body)}`);
  const logout = await post('/api/auth/logout', {}, { cookie: logoutCookie });
  const withoutCookieAfterLogout = await get('/api/auth/me');
  const replayAfterLogout = await get('/api/auth/me', { cookie: logoutCookie });
  probe(
    logout.status === 204 && withoutCookieAfterLogout.status === 401 && replayAfterLogout.status === 401,
    'logout ล้างเฉพาะคุกกี้ฝั่งเบราว์เซอร์ แต่ token ใบเดิมที่คัดลอกไว้ยังใช้ได้',
    `logout=${logout.status}, noCookie=${withoutCookieAfterLogout.status}, replayOldToken=${replayAfterLogout.status}, set-cookie=${logout.setCookie}`,
    'logout ทำให้ token ใบเดิมใช้ซ้ำไม่ได้ ไม่ใช่เพียงสั่งเบราว์เซอร์ล้างคุกกี้',
  );

  // admin SSO เป็นประตู auth อีกบานใน routes.js — ตรวจ purpose/role/replay/race และ open redirect
  const ssoTicket = ticket('kin-admin-sso', { email: MANAGER.employee_id + '@example.invalid' });
  const ssoFirst = await get(`/api/auth/admin-sso?t=${encodeURIComponent(ssoTicket)}&to=${encodeURIComponent('/employees')}`);
  const ssoReplay = await get(`/api/auth/admin-sso?t=${encodeURIComponent(ssoTicket)}&to=${encodeURIComponent('/employees')}`);
  const ssoWrongPurpose = await get(`/api/auth/admin-sso?t=${encodeURIComponent(ticket('kin-staff', { u: LINE('f') }))}`);
  const ssoField = await get(`/api/auth/admin-sso?t=${encodeURIComponent(ticket('kin-admin-sso', { email: ACTORS.authA.email }))}`);
  const ssoOpenRedirect = await get(`/api/auth/admin-sso?t=${encodeURIComponent(ticket('kin-admin-sso', { email: MANAGER.employee_id + '@example.invalid' }))}&to=${encodeURIComponent('//evil.example/path')}`);
  probe(
    ssoFirst.status === 302 && ssoFirst.location === '/employees' && firstCookie(ssoFirst.setCookie)
      && ssoReplay.status === 302 && /sso_error=expired/.test(ssoReplay.location ?? '') && !ssoReplay.setCookie
      && /sso_error=expired/.test(ssoWrongPurpose.location ?? '') && !ssoWrongPurpose.setCookie
      && /sso_error=nomatch/.test(ssoField.location ?? '') && !ssoField.setCookie
      && ssoOpenRedirect.location === '/',
    'admin SSO รับ purpose/ตำแหน่งผิด ใช้ตั๋วซ้ำ หรือเปิด redirect ออกนอกเว็บได้',
    `first=${ssoFirst.status}:${ssoFirst.location}, replay=${ssoReplay.location}, wrong=${ssoWrongPurpose.location}, field=${ssoField.location}, redirect=${ssoOpenRedirect.location}`,
    'admin SSO จำกัด purpose/ตำแหน่ง ใช้ครั้งเดียว และกัน open redirect',
  );

  const ssoRaceTicket = ticket('kin-admin-sso', { email: MANAGER.employee_id + '@example.invalid' });
  const ssoRace = await Promise.all([
    get(`/api/auth/admin-sso?t=${encodeURIComponent(ssoRaceTicket)}`),
    get(`/api/auth/admin-sso?t=${encodeURIComponent(ssoRaceTicket)}`),
  ]);
  probe(
    ssoRace.filter((r) => Boolean(firstCookie(r.setCookie))).length === 1
      && ssoRace.filter((r) => /sso_error=expired/.test(r.location ?? '')).length === 1,
    'ตั๋ว admin SSO ใบเดียวออกสอง session ได้เมื่อยิงพร้อมกัน',
    ssoRace.map((r) => `${r.status}:${r.location}:cookie=${Boolean(firstCookie(r.setCookie))}`).join(' | '),
    'ตั๋ว admin SSO ถูกจองแบบ atomic ออก session ได้เพียงคำขอเดียว',
  );

  // ---------------------------------------------------------------------------
  head('5 · LINE login/link — purpose, อายุ, เจ้าของ, ผูกซ้ำ, replay และ race');
  await sql.run('UPDATE employees SET line_user_id = NULL WHERE employee_id IN (:a, :b)', {
    a: ACTORS.lineA.employee_id, b: ACTORS.lineB.employee_id,
  });
  await sql.run('DELETE FROM line_ticket_used');

  const wrongPurposeLine = await get(`/api/auth/line?t=${encodeURIComponent(ticket('kin-hire', { u: LINE('1') }))}`);
  const expiredLine = await get(`/api/auth/line?t=${encodeURIComponent(ticket('kin-staff', { u: LINE('2') }, -1))}`);
  const tooLongLine = await get(`/api/auth/line?t=${encodeURIComponent(ticket('kin-staff', { u: LINE('3') }, 20 * 60_000))}`);
  const malformedLine = await get(`/api/auth/line?t=${encodeURIComponent(ticket('kin-staff', { u: 'not-a-line-user-id' }))}`);
  probe(
    [wrongPurposeLine, expiredLine, tooLongLine, malformedLine].every((r) => r.status === 302 && /line_error=expired/.test(r.location ?? '') && !r.setCookie),
    'ตั๋ว LINE purpose ผิด/หมดอายุ/อายุยาวเกิน/รูป userId ผิดยังออก session ได้',
    [wrongPurposeLine, expiredLine, tooLongLine, malformedLine].map((r) => `${r.status}:${r.location}:cookie=${Boolean(r.setCookie)}`).join(' | '),
    'LINE login ปฏิเสธ purpose ผิด ตั๋วหมดอายุ อายุเกินเพดาน และ LINE userId ผิดรูป',
  );

  const unlinkedTicket = ticket('kin-staff', { u: LINE('4') });
  const unlinkedLine = await get(`/api/auth/line?t=${encodeURIComponent(unlinkedTicket)}&to=${encodeURIComponent('/my-today')}`);
  probe(
    unlinkedLine.status === 302 && /^\/login\?line=/.test(unlinkedLine.location ?? '') && !unlinkedLine.setCookie,
    'LINE ที่ยังไม่ผูกได้ session โดยไม่ยืนยันรหัสผ่าน',
    `${unlinkedLine.status} ${unlinkedLine.location} cookie=${Boolean(unlinkedLine.setCookie)}`,
    'LINE ที่ยังไม่ผูกถูกส่งไปหน้า login พร้อมตั๋ว และยังไม่ออก session',
  );

  const lineAValue = LINE('5');
  const lineATicket = ticket('kin-staff', { u: lineAValue });
  const noAuthLink = await post('/api/auth/line-link', { t: lineATicket });
  const linkA = await post('/api/auth/line-link', { t: lineATicket }, { cookie: cookieFor(ACTORS.lineA) });
  const linkARepeat = await post('/api/auth/line-link', { t: lineATicket }, { cookie: cookieFor(ACTORS.lineA) });
  const stealByB = await post('/api/auth/line-link', { t: lineATicket }, { cookie: cookieFor(ACTORS.lineB) });
  const lineOwner = await sql.one('SELECT employee_id FROM employees WHERE line_user_id = :uid', { uid: lineAValue });
  probe(
    rejected(noAuthLink) && linkA.status === 200 && linkARepeat.status === 200
      && rejected(stealByB) && lineOwner.employee_id === ACTORS.lineA.employee_id,
    'ผูก LINE โดยไม่ login/ย้าย LINE ที่มีเจ้าของไปบัญชีอื่นได้ หรือการลองซ้ำของเจ้าของพัง',
    `noAuth=${noAuthLink.status}, first=${linkA.status}, same=${linkARepeat.status}, other=${stealByB.status}, owner=${lineOwner.employee_id}`,
    'line-link ต้องมี session, เจ้าของเดิมลองซ้ำได้ และบัญชีอื่นย้าย LINE ไปไม่ได้',
  );

  const wrongPurposeLink = await post('/api/auth/line-link', {
    t: ticket('kin-admin-sso', { email: ACTORS.lineA.email }),
  }, { cookie: cookieFor(ACTORS.lineA) });
  const expiredLink = await post('/api/auth/line-link', {
    t: ticket('kin-staff', { u: LINE('6') }, -1),
  }, { cookie: cookieFor(ACTORS.lineA) });
  probe(
    rejected(wrongPurposeLink) && rejected(expiredLink),
    'line-link รับตั๋วผิด purpose หรือหมดอายุ',
    `wrongPurpose=${wrongPurposeLink.status} expired=${expiredLink.status}`,
    'line-link ปฏิเสธตั๋วผิด purpose และหมดอายุ',
  );

  const replacementLine = LINE('7');
  const replaceLink = await post('/api/auth/line-link', {
    t: ticket('kin-staff', { u: replacementLine }),
  }, { cookie: cookieFor(ACTORS.lineA) });
  const replacementOwner = await sql.one('SELECT line_user_id FROM employees WHERE employee_id = :id', { id: ACTORS.lineA.employee_id });
  info(`พนักงานที่ยืนยันรหัสผ่านแล้วเปลี่ยน LINE ของตัวเองได้โดยตรง (${replaceLink.status}, replaced=${replacementOwner.line_user_id === replacementLine}); LINE เดิมถูกปล่อยว่าง`);

  await sql.run('UPDATE employees SET line_user_id = NULL WHERE employee_id IN (:a, :b)', {
    a: ACTORS.lineA.employee_id, b: ACTORS.lineB.employee_id,
  });
  const raceLine = LINE('8');
  const raceTicket = ticket('kin-staff', { u: raceLine });
  const lineRace = await Promise.all([
    post('/api/auth/line-link', { t: raceTicket }, { cookie: cookieFor(ACTORS.lineA) }),
    post('/api/auth/line-link', { t: raceTicket }, { cookie: cookieFor(ACTORS.lineB) }),
  ]);
  const raceOwners = await sql.one('SELECT count(*)::int AS n FROM employees WHERE line_user_id = :uid', { uid: raceLine });
  probe(
    lineRace.filter((r) => r.status === 200).length === 1
      && lineRace.filter(rejected).length === 1 && raceOwners.n === 1,
    'LINE เดียวผูกสองพนักงานได้เมื่อกดพร้อมกัน',
    `statuses=[${statusList(lineRace)}], owners=${raceOwners.n}, bodies=${brief(lineRace.map((r) => r.body))}`,
    'unique index กัน LINE เดียวผูกสองคนแม้ยิงพร้อมกัน',
  );

  await sql.run('UPDATE employees SET line_user_id = :uid WHERE employee_id = :id', {
    uid: LINE('9'), id: ACTORS.lineA.employee_id,
  });
  await sql.run('DELETE FROM line_ticket_used');
  const loginLineTicket = ticket('kin-staff', { u: LINE('9') });
  const lineFirst = await get(`/api/auth/line?t=${encodeURIComponent(loginLineTicket)}&to=${encodeURIComponent('/my-today')}`);
  const lineReplayOtherBrowser = await get(`/api/auth/line?t=${encodeURIComponent(loginLineTicket)}&to=${encodeURIComponent('/my-today')}`);
  const lineReloadSameBrowser = await get(`/api/auth/line?t=${encodeURIComponent(loginLineTicket)}&to=${encodeURIComponent('/my-today')}`, {
    cookie: firstCookie(lineFirst.setCookie),
  });
  probe(
    lineFirst.status === 302 && lineFirst.location === '/my-today' && firstCookie(lineFirst.setCookie)
      && /line_error=used/.test(lineReplayOtherBrowser.location ?? '') && !lineReplayOtherBrowser.setCookie
      && lineReloadSameBrowser.location === '/my-today' && firstCookie(lineReloadSameBrowser.setCookie),
    'ตั๋ว LINE ใบเดิมออก session ให้อีกเบราว์เซอร์ได้ หรือ reload เบราว์เซอร์เดิมพัง',
    `first=${lineFirst.location}:cookie=${Boolean(lineFirst.setCookie)}, other=${lineReplayOtherBrowser.location}:cookie=${Boolean(lineReplayOtherBrowser.setCookie)}, same=${lineReloadSameBrowser.location}`,
    'ตั๋ว LINE ออก session ครั้งเดียว; replay คนละเบราว์เซอร์ถูกกัน แต่ reload เครื่องเดิมยังทำงาน',
  );

  const lineRedirectTicket = ticket('kin-staff', { u: LINE('9') });
  const lineOpenRedirect = await get(`/api/auth/line?t=${encodeURIComponent(lineRedirectTicket)}&to=${encodeURIComponent('//evil.example')}`);
  probe(
    lineOpenRedirect.location === '/',
    'LINE login เปิด redirect ออกนอกเว็บได้',
    `${lineOpenRedirect.status} location=${lineOpenRedirect.location}`,
    'LINE login รับปลายทางเฉพาะ allowlist และกัน open redirect',
  );

  await sql.run("UPDATE employees SET status = 'suspended' WHERE employee_id = :id", { id: ACTORS.lineA.employee_id });
  const blockedLine = await get(`/api/auth/line?t=${encodeURIComponent(ticket('kin-staff', { u: LINE('9') }))}`);
  probe(
    blockedLine.status === 302 && /line_error=blocked/.test(blockedLine.location ?? '') && !blockedLine.setCookie,
    'พนักงานที่ถูกพักงานยังเข้าใหม่ด้วย LINE ได้',
    `${blockedLine.status} ${blockedLine.location} cookie=${Boolean(blockedLine.setCookie)}`,
    'LINE login อ่านสถานะสดและไม่ออก session ให้บัญชีที่ถูกพักงาน',
  );
  await sql.run("UPDATE employees SET status = 'active' WHERE employee_id = :id", { id: ACTORS.lineA.employee_id });

  // ---------------------------------------------------------------------------
  head('6 · ข้อมูลรั่วจากคำตอบ — login/me/token/error/forgot/reset');
  await sql.run('DELETE FROM login_failures');
  await sql.run('DELETE FROM password_reset_otps');
  const secretLogin = await login(`  ${ACTORS.secret.email.toUpperCase()}  `, FIXTURE_PASSWORD);
  const secretCookie = firstCookie(secretLogin.setCookie);
  const secretMe = await get('/api/auth/me', { cookie: secretCookie });
  const forbiddenKeys = new Set([
    'password', 'password_hash', 'national_id', 'address', 'temp_password', 'temp_password_encrypted',
    'line_user_id', 'phone', 'note', 'role_column',
  ]);
  const leakedKeys = (value, path = '$', out = []) => {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
      value.forEach((x, i) => leakedKeys(x, `${path}[${i}]`, out));
      return out;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) out.push(`${path}.${key}`);
      leakedKeys(child, `${path}.${key}`, out);
    }
    return out;
  };
  const loginText = JSON.stringify(secretLogin.body);
  const meText = JSON.stringify(secretMe.body);
  const tokenPayload = secretCookie
    ? JSON.parse(Buffer.from(secretCookie.split('=')[1].split('.')[1], 'base64url').toString('utf8'))
    : {};
  const tokenText = JSON.stringify(tokenPayload);
  const allowedSessionKeys = ['employee_id', 'email', 'first_name', 'last_name', 'must_change_password', 'permissions', 'position', 'role'];
  probe(
    secretLogin.status === 200 && secretMe.status === 200
      && leakedKeys(secretLogin.body).length === 0 && leakedKeys(secretMe.body).length === 0
      && ![loginText, meText, tokenText, secretLogin.setCookie ?? ''].some((text) =>
        text.includes(SECRET_NATIONAL_ID) || text.includes(SECRET_TEMP_COPY) || text.includes(fixtureHash))
      && Object.keys(secretLogin.body).sort().join(',') === allowedSessionKeys.sort().join(',')
      && Object.keys(tokenPayload).every((key) => ['sub', 'role', 'name', 'iat_ms', 'iat', 'exp'].includes(key)),
    'login/me/JWT ส่ง hash รหัสผ่าน เลขบัตร สำเนารหัสชั่วคราว หรือข้อมูลเกิน session',
    `loginKeys=${Object.keys(secretLogin.body).sort()} meKeys=${Object.keys(secretMe.body).sort()} tokenKeys=${Object.keys(tokenPayload).sort()} leaked=${[...leakedKeys(secretLogin.body), ...leakedKeys(secretMe.body)]}`,
    'login และ me ส่งเฉพาะ session fields; JWT ไม่มี hash/เลขบัตร/รหัสชั่วคราว',
  );

  const leakKnownWrong = await login(ACTORS.secret.email, 'wrong-secret');
  const leakUnknownWrong = await login('unknown.secret@example.invalid', 'wrong-secret');
  const errorText = JSON.stringify([leakKnownWrong.body, leakUnknownWrong.body]);
  probe(
    leakKnownWrong.status === 401 && leakUnknownWrong.status === 401 && sameBody(leakKnownWrong, leakUnknownWrong)
      && !errorText.includes(ACTORS.secret.employee_id) && !errorText.includes(SECRET_NATIONAL_ID),
    'login error บอกบัญชี/ข้อมูลภายในต่างกันระหว่างอีเมลจริงกับอีเมลปลอม',
    `known=${brief(leakKnownWrong.body)} unknown=${brief(leakUnknownWrong.body)}`,
    'login error เป็นข้อความเดียวกันและไม่มีรหัสพนักงาน/ข้อมูลอ่อนไหว',
  );

  const forgotLeakKnown = await captureConsole(() => post('/api/auth/forgot-password', { email: ACTORS.secret.email }));
  const forgotLeakUnknown = await post('/api/auth/forgot-password', { email: 'unknown.forgot@example.invalid' });
  probe(
    forgotLeakKnown.value.status === 200 && forgotLeakUnknown.status === 200 && sameBody(forgotLeakKnown.value, forgotLeakUnknown),
    'forgot-password ครั้งแรกบอกว่าอีเมลใดมีบัญชี',
    `known=${brief(forgotLeakKnown.value.body)} unknown=${brief(forgotLeakUnknown.body)}`,
    'forgot-password ครั้งแรกตอบ generic เหมือนกันทั้งอีเมลจริงและไม่มีจริง',
  );

  await sql.run('DELETE FROM password_reset_otps');
  const resetKnownNoOtp = await post('/api/auth/reset-password', {
    email: ACTORS.secret.email, code: '999999', new_password: NEW_PASSWORD,
  });
  const resetUnknown = await post('/api/auth/reset-password', {
    email: 'unknown.reset@example.invalid', code: '999999', new_password: NEW_PASSWORD,
  });
  probe(
    resetKnownNoOtp.status === 400 && resetUnknown.status === 400 && sameBody(resetKnownNoOtp, resetUnknown),
    'reset-password ที่ไม่มี OTP บอกใบ้ว่าอีเมลใดมีบัญชี',
    `known=${brief(resetKnownNoOtp.body)} unknown=${brief(resetUnknown.body)}`,
    'reset-password ใช้ข้อความเดียวกันเมื่อไม่มี OTP ทั้งบัญชีจริงและบัญชีปลอม',
  );

  // ---------------------------------------------------------------------------
  head('7 · ค่าเพี้ยน — object, รหัส 100,000 ตัว, อีเมลยาว และตัวพิมพ์/ช่องว่าง');
  await sql.run('DELETE FROM login_failures');
  await sql.run('DELETE FROM password_reset_otps');
  const objectEmail = await post('/api/auth/login', { email: { bad: true }, password: 'whatever' });
  const objectPassword = await post('/api/auth/login', { email: ACTORS.authA.email, password: { bad: true } });
  const objectForgot = await post('/api/auth/forgot-password', { email: { bad: true } });
  const objectReset = await post('/api/auth/reset-password', {
    email: { bad: true }, code: '123456', new_password: NEW_PASSWORD,
  });
  const failuresAfterObjects = await sql.one('SELECT count(*)::int AS n FROM login_failures');
  const otpsAfterObjects = await sql.one('SELECT count(*)::int AS n FROM password_reset_otps');
  probe(
    rejected(objectEmail) && rejected(objectPassword) && rejected(objectForgot) && rejected(objectReset)
      && failuresAfterObjects.n === 0 && otpsAfterObjects.n === 0,
    'email/password แบบ object ทำ route ล้ม หรือทิ้ง login failure/OTP ไว้',
    `login-email=${objectEmail.status}, login-password=${objectPassword.status}, forgot=${objectForgot.status}, reset=${objectReset.status}, failures=${failuresAfterObjects.n}, otps=${otpsAfterObjects.n}`,
    'object ถูก schema ปฏิเสธครบ login/forgot/reset ก่อนแตะการนับรหัสผิดหรือ OTP',
  );

  const normalizedLogin = await login(`  ${ACTORS.authA.email.toUpperCase()}  `, FIXTURE_PASSWORD);
  probe(
    normalizedLogin.status === 200 && normalizedLogin.body.employee_id === ACTORS.authA.employee_id,
    'อีเมลตัวพิมพ์ใหญ่หรือมีช่องว่างหัวท้ายเข้าไม่ได้',
    `${normalizedLogin.status} ${brief(normalizedLogin.body)}`,
    'อีเมลไม่สนตัวพิมพ์ใหญ่เล็กและ trim ช่องว่างก่อน login',
  );

  await sql.run('DELETE FROM login_failures');
  const hugePassword = 'x'.repeat(100_000);
  let hugePasswordResult;
  try {
    hugePasswordResult = await login(ACTORS.authA.email, hugePassword, { signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    hugePasswordResult = { status: 0, elapsedMs: 8_000, body: { error: `${error.name}: ${error.message}` } };
  }
  const healthAfterHugePassword = await get('/api/health');
  probe(
    rejected(hugePasswordResult) && hugePasswordResult.elapsedMs < 5_000 && healthAfterHugePassword.status === 200,
    'รหัสผ่านยาว 100,000 ตัวทำ auth ค้าง/ล้ม หรือกระทบ server ต่อเนื่อง',
    `login=${hugePasswordResult.status}, elapsed=${Math.round(hugePasswordResult.elapsedMs)}ms, health=${healthAfterHugePassword.status}, body=${brief(hugePasswordResult.body)}`,
    `รหัส 100,000 ตัวถูกปฏิเสธใน ${Math.round(hugePasswordResult.elapsedMs)}ms และ server ยังตอบ health`,
  );

  // email_key ถูกเก็บลง DB เมื่อ login ผิด — string ไร้เพดานจึงเป็น storage amplification ไม่ใช่แค่ error wording
  await sql.run('DELETE FROM login_failures');
  const hugeEmailValue = `${'e'.repeat(100_000)}@example.invalid`;
  const hugeEmail = await login(hugeEmailValue, 'wrong-password');
  const hugeEmailStored = await sql.one(
    'SELECT count(*)::int AS n, coalesce(max(length(email_key)), 0)::int AS max_len FROM login_failures',
  );
  probe(
    rejected(hugeEmail) && hugeEmailStored.n === 0,
    'ช่องชื่อบัญชีไร้เพดาน ทำให้คนนอกยัดข้อความใหญ่มากลง login_failures ได้',
    `HTTP ${hugeEmail.status}, storedRows=${hugeEmailStored.n}, maxEmailLength=${hugeEmailStored.max_len}`,
    'ชื่อบัญชียาวผิดปกติถูกปฏิเสธก่อน query/bcrypt/เขียนฐาน',
  );

  console.log(`\n=== สรุป: ตรวจ ${checks} จุดใน 7 หัวข้อ · พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${passed.length} กลุ่ม ===`);
  found.forEach((item, i) => console.log(`${i + 1}. ${item.title}`));
  if (observations.length) console.log(`INFO | บันทึกขอบเขตพฤติกรรมที่ตั้งใจ ${observations.length} รายการ`);
} finally {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
