/**
 * QA รอบ 20 — หน้าประเมินจากญาติ + ตัวเลขบนแดชบอร์ด
 *
 * รันบน PostgreSQL ชั่วคราว + Express จริง + HTTP จริง:
 *   node test/_run_probe.mjs test/_qa_reviews_20261026.mjs
 *
 * ชุดนี้ไม่แก้ source ไม่ต่อฐานจริง และไม่เขียนรายงานบัคลงไฟล์
 * _run_probe.mjs เป็นผู้ตั้ง DATABASE_URL/JWT_SECRET/กุญแจสะพานชั่วคราวให้ทั้งหมด
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.RUN_DB_TESTS, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');
const { REVIEW_QUESTIONS } = await import('../src/reviews/schema.js');
const { ensureRatingsTable, employeeStars } = await import('../src/lib/ratings.js');
const { scoreText } = await import('../../client/src/lib/reviewQuestions.js');
// ใช้ตัวเซ็นจริงของสะพานกับกุญแจชั่วคราวที่ _run_probe สร้างให้ ไม่อ่านไฟล์กุญแจหรือ .env
const { sign } = await import('../../../kin-chatbot/src/lib/staffBridge.js');

const MANAGER = {
  employee_id: 'EMP-0001', position: 'manager', first_name: 'Test', last_name: 'Employee',
};
const HR = {
  employee_id: 'EMP-0007', position: 'hr', first_name: 'Test', last_name: 'Employee',
};
const FIELD = {
  employee_id: 'EMP-0003', position: 'caregiver', first_name: 'Test', last_name: 'Employee',
};
const ADMIN = {
  employee_id: 'EMP-9281', position: 'admin', first_name: 'Admin', last_name: 'ReviewQA',
};
const FINANCE = {
  employee_id: 'EMP-9282', position: 'finance', first_name: 'Finance', last_name: 'ReviewQA',
};
const REVIEW_A = {
  employee_id: 'EMP-9283', position: 'caregiver', first_name: 'สายดูแลเอ', last_name: 'นามสกุลเต็มลับเอ',
};
const REVIEW_B = {
  employee_id: 'EMP-9284', position: 'therapist', first_name: 'นักกายภาพบี', last_name: 'นามสกุลเต็มลับบี',
};
const RESIGNED = {
  employee_id: 'EMP-9285', position: 'caregiver', first_name: 'ลาออกแล้ว', last_name: 'ReviewQA',
};
const EMPTY_EMP = {
  employee_id: 'EMP-9286', position: 'caregiver', first_name: 'ยังไม่มีงาน', last_name: 'ReviewQA',
};
const LINE_EMPTY = `U${'9'.repeat(32)}`;
const CASE_CLOSED = 'VN699280001';
const CASE_CANCELLED = 'VN699280002';

await seedFixtures(pool, hashPassword);
for (const who of [ADMIN, FINANCE, REVIEW_A, REVIEW_B, RESIGNED, EMPTY_EMP]) {
  await sql.run(
    `INSERT INTO employees
       (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password, line_user_id)
     VALUES (:id, :first, :last, :position, :email, :status, 'x', false, :line)`,
    {
      id: who.employee_id,
      first: who.first_name,
      last: who.last_name,
      position: who.position,
      email: `${who.employee_id}@example.invalid`,
      status: who === RESIGNED ? 'resigned' : 'active',
      line: who === EMPTY_EMP ? LINE_EMPTY : null,
    },
  );
}

// บทเรียนจากรอบก่อน: actor ที่ใช้ยิงสิทธิ์ต้องผ่านด่านรหัสชั่วคราว ไม่งั้น 403 จะกลบผลจริง
await sql.run(
  `UPDATE employees SET must_change_password = false
   WHERE employee_id IN (:manager, :hr, :field, :admin, :finance, :a, :b, :resigned, :empty)`,
  {
    manager: MANAGER.employee_id,
    hr: HR.employee_id,
    field: FIELD.employee_id,
    admin: ADMIN.employee_id,
    finance: FINANCE.employee_id,
    a: REVIEW_A.employee_id,
    b: REVIEW_B.employee_id,
    resigned: RESIGNED.employee_id,
    empty: EMPTY_EMP.employee_id,
  },
);

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, { body, who = MANAGER, headers = {} } = {}) {
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
const get = (path, who) => call('GET', path, { who });
const post = (path, body, who) => call('POST', path, { body: body ?? {}, who });
const publicGet = (token, headers = {}) =>
  call('GET', `/api/reviews/form/${encodeURIComponent(token)}`, { who: null, headers });
const publicPost = (token, body, ip) =>
  call('POST', `/api/reviews/form/${encodeURIComponent(token)}`, {
    body,
    who: null,
    headers: ip ? { 'x-forwarded-for': ip } : {},
  });

function ticket(purpose, fields = {}, ttlMs = 60_000) {
  const value = sign({ ...fields, a: purpose }, ttlMs);
  assert.ok(value, 'ต้องมีกุญแจสะพานชั่วคราวจาก _run_probe');
  return value;
}
const postTicket = (path, purpose, fields = {}) =>
  call('POST', `/api/integration/${path}`, {
    body: { token: ticket(purpose, fields) },
    who: null,
  });

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
const isClosed = (response) => response.status >= 400 && response.status < 500;
const near = (actual, expected, epsilon = 1e-9) =>
  typeof actual === 'number' && Math.abs(actual - expected) <= epsilon;

const validReview = (score = 5, extra = {}) => ({
  ...Object.fromEntries(REVIEW_QUESTIONS.map((q) => [q, score])),
  ...extra,
});

async function resetPublicReviews() {
  await sql.run('DELETE FROM staff_reviews');
}

async function resetCaseRatings() {
  await ensureRatingsTable();
  await sql.run('DELETE FROM case_ratings');
}

async function reviewCount(employeeId) {
  return Number((await sql.one(
    'SELECT COUNT(*)::int AS n FROM staff_reviews WHERE employee_id = :id',
    { id: employeeId },
  )).n);
}

async function issueToken(employeeId, rotate = false) {
  const response = rotate
    ? await post(`/api/reviews/employees/${employeeId}/link`)
    : await get(`/api/reviews/employees/${employeeId}/link`);
  const body = mustStatus(response, 200, `${rotate ? 'หมุน' : 'ออก'} token ของ ${employeeId}`);
  assert.equal(typeof body.token, 'string');
  assert.ok(body.token.length >= 20);
  return body.token;
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

let tokenA;
let tokenB;
let tokenResigned;

try {
  // ---------------------------------------------------------------------------
  head('1 · token: ไม่มี/ว่าง/ขยะ/เพิกถอน/หมดอายุ/ใช้ซ้ำ');
  await resetPublicReviews();
  tokenA = await issueToken(REVIEW_A.employee_id);
  tokenB = await issueToken(REVIEW_B.employee_id);
  tokenResigned = await issueToken(RESIGNED.employee_id);
  {
    const badTokenResponses = await Promise.all([
      call('GET', '/api/reviews/form', { who: null }),
      call('GET', '/api/reviews/form/', { who: null }),
      publicGet(' '),
      publicGet('not-a-real-review-token'),
    ]);
    probe(
      badTokenResponses.every(isClosed) && await reviewCount(REVIEW_A.employee_id) === 0,
      'คำขอที่ไม่มี token/ว่าง/ขยะเปิดฟอร์มหรือสร้างคะแนนได้',
      `statuses=${badTokenResponses.map((r) => r.status).join(',')} rows=${await reviewCount(REVIEW_A.employee_id)}`,
      'ไม่มี token, token ว่าง และ token ขยะถูกปิดประตูโดยไม่สร้างคะแนน',
    );

    const formA = await publicGet(tokenA);
    probe(
      formA.status === 200 && formA.body?.first_name === REVIEW_A.first_name,
      'token ที่ถูกต้องเปิดฟอร์มสาธารณะไม่ได้หรือชี้ผิดคน',
      `${formA.status} ${brief(formA.body)}`,
      'token ที่ถูกต้องเปิดฟอร์มได้โดยไม่ต้อง login และชี้เจ้าของ token ถูกคน',
    );

    const resignedGet = await publicGet(tokenResigned);
    const resignedPost = await publicPost(tokenResigned, validReview(5), '198.51.100.10');
    probe(
      resignedGet.status === 404 && resignedPost.status === 404 && await reviewCount(RESIGNED.employee_id) === 0,
      'ลิงก์ของพนักงานที่ลาออกแล้วยังเปิดหรือรับคะแนนใหม่',
      `GET=${resignedGet.status} POST=${resignedPost.status} rows=${await reviewCount(RESIGNED.employee_id)}`,
      'พนักงานลาออกแล้วเปิดฟอร์มและส่งคะแนนใหม่ไม่ได้',
    );

    const oldToken = tokenA;
    tokenA = await issueToken(REVIEW_A.employee_id, true);
    const revokedGet = await publicGet(oldToken);
    const revokedPost = await publicPost(oldToken, validReview(5), '198.51.100.11');
    probe(
      revokedGet.status === 404 && revokedPost.status === 404,
      'หมุนลิงก์แล้ว token เดิมยังเปิดหรือเขียนคะแนนได้',
      `GET=${revokedGet.status} POST=${revokedPost.status}`,
      'หมุนลิงก์แล้ว token เดิมถูกเพิกถอนทันทีทั้ง GET และ POST',
    );

    /* ระบบไม่มีเวลาออก/หมดอายุของ review_token จึงจำลองแถวที่ถือ token เดิมมาตั้งแต่ปี 2020
       ถ้ายัง POST ได้ แปลว่าลิงก์ที่หลุดไปใช้บิดคะแนนได้ตลอดจนกว่าจะมีคนหมุนด้วยมือ */
    await sql.run(
      `UPDATE employees SET updated_at = '2020-01-01 00:00:00' WHERE employee_id = :id`,
      { id: REVIEW_A.employee_id },
    );
    const tokenColumns = await sql.all(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'employees' AND column_name LIKE 'review_token%'
       ORDER BY column_name`,
    );
    const oldLinkPost = await publicPost(tokenA, validReview(5), '198.51.100.12');
    probe(
      oldLinkPost.status !== 201,
      'ลิงก์ประเมินไม่มีวันหมดอายุ — ลิงก์ที่หลุดใช้เขียนคะแนนได้ตลอด',
      `คอลัมน์ token=${tokenColumns.map((r) => r.column_name).join(',')} · token บนแถวอายุเกิน 6 ปี POST=${oldLinkPost.status}`,
      'token เก่ามากถูกปฏิเสธ ไม่เปิดช่องให้ลิงก์ที่หลุดเขียนคะแนนได้ตลอด',
    );
    await resetPublicReviews();
    info('ลิงก์สาธารณะเป็น token รายพนักงาน ไม่ใช่ token รายเคส; เจ้าของคะแนนถูกตัดสินจาก token ใน URL เท่านั้น');
  }

  // ---------------------------------------------------------------------------
  head('2 · ไล่เดา token, กดซ้ำพร้อมกัน และเพดาน 30 ใบต่อวัน');
  await resetPublicReviews();
  {
    const guesses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => publicGet(`guess-${String(i).padStart(3, '0')}-xxxxxxxxxxxxxxxxxxxx`)),
    );
    const guessStatuses = Object.fromEntries(
      [...new Set(guesses.map((r) => r.status))].sort().map((status) => [status, guesses.filter((r) => r.status === status).length]),
    );
    info(
      guesses.some((r) => r.status === 429)
        ? `ยิง token ขยะ 50 ครั้งเจอเพดาน: ${brief(guessStatuses)}`
        : `ยิง token ขยะ 50 ครั้งไม่เจอ rate limit: ${brief(guessStatuses)} — token จริงสุ่ม 128 บิตและคำตอบไม่บอกใบ้เจ้าของ จึงบันทึกเป็นข้อสังเกต ไม่ตัดสินเป็นบัค`,
    );

    const first = await publicPost(tokenA, validReview(5), '198.51.100.20');
    const second = await publicPost(tokenA, validReview(1), '198.51.100.20');
    probe(
      first.status === 201 && second.status === 409 && await reviewCount(REVIEW_A.employee_id) === 1,
      'ส่งคะแนนซ้ำตามลำดับจาก IP เดิมภายใน 3 นาทีแล้วเกิดมากกว่าหนึ่งใบ',
      `HTTP=${first.status},${second.status} rows=${await reviewCount(REVIEW_A.employee_id)}`,
      'กดส่งซ้ำตามลำดับจาก IP เดิมภายใน 3 นาทีถูกกัน เหลือหนึ่งใบ',
    );

    await resetPublicReviews();
    const simultaneous = await Promise.all(
      Array.from({ length: 8 }, () => publicPost(tokenA, validReview(4), '198.51.100.21')),
    );
    const simultaneousRows = await reviewCount(REVIEW_A.employee_id);
    probe(
      simultaneousRows === 1 && simultaneous.filter((r) => r.status === 201).length === 1,
      'กดส่งพร้อมกันจาก IP เดิมลอดด่านซ้ำ เกิดหลายใบจริง',
      `HTTP=${simultaneous.map((r) => r.status).join(',')} rows=${simultaneousRows} — คะแนนชุดเดียวถูกให้น้ำหนักซ้ำบนแดชบอร์ด`,
      'คำขอพร้อมกันจาก IP เดิมสร้างได้เพียงหนึ่งใบ',
    );

    await resetPublicReviews();
    const capped = [];
    for (let i = 0; i < 31; i += 1) {
      capped.push(await publicPost(tokenA, validReview(5), `203.0.113.${i + 1}`));
    }
    const tokenBeforeCapRotate = tokenA;
    tokenA = await issueToken(REVIEW_A.employee_id, true);
    const rotatedAfterCap = await publicPost(tokenA, validReview(5), '203.0.113.200');
    const otherEmployee = await publicPost(tokenB, validReview(5), '203.0.113.1');
    probe(
      capped.slice(0, 30).every((r) => r.status === 201) && capped[30].status === 429 &&
        rotatedAfterCap.status === 429 && otherEmployee.status === 201 &&
        await reviewCount(REVIEW_A.employee_id) === 30 && await reviewCount(REVIEW_B.employee_id) === 1,
      'เพดาน 30 ใบไม่ทำงาน หรือผูกผิดกับ IP/token จนหมุนลิงก์ข้ามได้หรือคนอื่นถูกบล็อกตาม',
      `A=${capped.map((r) => r.status).join(',')} rotate=${rotatedAfterCap.status} B=${otherEmployee.status} ` +
        `rowsA=${await reviewCount(REVIEW_A.employee_id)} rowsB=${await reviewCount(REVIEW_B.employee_id)} oldToken=${tokenBeforeCapRotate.slice(0, 5)}...`,
      'เพดาน 30 ใบผูกกับพนักงานใน 24 ชม.: เปลี่ยน IP/หมุน token ก็ข้ามไม่ได้ และไม่บล็อกพนักงานคนอื่น',
    );

    await resetPublicReviews();
    const capRace = await Promise.all(
      Array.from({ length: 36 }, (_, i) => publicPost(tokenA, validReview(3), `198.18.0.${i + 1}`)),
    );
    const capRaceRows = await reviewCount(REVIEW_A.employee_id);
    probe(
      capRaceRows <= 30,
      'ยิงพร้อมกันข้ามเพดาน 30 ใบต่อพนักงานได้',
      `HTTP 201=${capRace.filter((r) => r.status === 201).length} 429=${capRace.filter((r) => r.status === 429).length} rows=${capRaceRows}`,
      'แม้ยิงพร้อมกัน จำนวนใบใน 24 ชม. ยังไม่เกินเพดาน 30',
    );
  }

  // ---------------------------------------------------------------------------
  head('3 · ค่าที่ส่งมา: ดาวสุดขอบ ชนิดผิด ข้อความยาว และฟิลด์แปลกปลอม');
  await resetPublicReviews();
  {
    const invalid = [
      ['ดาว 0', validReview(5, { q_overall: 0 })],
      ['ดาว 6', validReview(5, { q_overall: 6 })],
      ['ดาว -1', validReview(5, { q_overall: -1 })],
      ['ดาว 3.5', validReview(5, { q_overall: 3.5 })],
      ['ดาวเป็นข้อความ', validReview(5, { q_overall: '5' })],
      ['ดาวเป็น object', validReview(5, { q_overall: { score: 5 } })],
      ['ไม่ส่งดาวเลย', { patient_name: 'ไม่มีคะแนน' }],
      ['ขาดดาวหนึ่งข้อ', (() => { const b = validReview(5); delete b.q_manner; return b; })()],
      ['ข้อความยาวมาก', validReview(5, { impressed: 'ก'.repeat(2001), patient_name: 'ข'.repeat(101) })],
    ];
    const results = [];
    for (const [label, body] of invalid) {
      results.push([label, await publicPost(tokenA, body, '198.51.100.30')]);
    }
    probe(
      results.every(([, r]) => r.status === 400) && await reviewCount(REVIEW_A.employee_id) === 0,
      'ข้อมูลคะแนนผิดรูป/นอกช่วง/ไม่ครบหรือข้อความเกินเพดานถูกบันทึก',
      `${results.map(([label, r]) => `${label}=${r.status}`).join(' · ')} rows=${await reviewCount(REVIEW_A.employee_id)}`,
      'ดาว 0/6/-1/3.5/ข้อความ/object, คะแนนไม่ครบ และข้อความเกินเพดานถูกปฏิเสธก่อนเขียนฐาน',
    );

    const injected = await publicPost(
      tokenA,
      validReview(4, {
        employee_id: REVIEW_B.employee_id,
        review_id: 999999,
        ip_hash: 'attacker-controlled',
        submitted_at: '2000-01-01 00:00:00',
        case_id: CASE_CANCELLED,
      }),
      '198.51.100.31',
    );
    const stored = await sql.one(
      `SELECT employee_id, ip_hash, submitted_at FROM staff_reviews ORDER BY review_id DESC LIMIT 1`,
    );
    probe(
      injected.status === 201 && stored?.employee_id === REVIEW_A.employee_id &&
        stored.ip_hash !== 'attacker-controlled' && stored.submitted_at !== '2000-01-01 00:00:00' &&
        await reviewCount(REVIEW_B.employee_id) === 0,
      'ฟิลด์แปลกปลอมเปลี่ยนเจ้าของคะแนน/IP/เวลาในฐานได้',
      `${injected.status} ${brief(stored)} rowsB=${await reviewCount(REVIEW_B.employee_id)}`,
      'employee_id/case_id/ip_hash/review_id/เวลาแปลกปลอมถูกตัดทิ้ง เจ้าของคะแนนยึดจาก token เท่านั้น',
    );
  }

  // ---------------------------------------------------------------------------
  head('4 · ข้อมูลที่คนถือลิงก์สาธารณะมองเห็น');
  {
    const secrets = {
      national_id: '1101700203991',
      phone: '089-777-9911',
      email: 'private-review-a@example.invalid',
      address: 'ที่อยู่ลับ 99/1',
      emergency_contact_name: 'ผู้ติดต่อฉุกเฉินลับ',
      emergency_contact_phone: '0888889999',
      note: 'ค่าจ้างและบันทึกภายในลับ',
      password_hash: 'HASH-MUST-NOT-LEAK',
    };
    await sql.run(
      `UPDATE employees SET national_id = :national_id, phone = :phone, email = :email, address = :address,
         emergency_contact_name = :emergency_contact_name, emergency_contact_phone = :emergency_contact_phone,
         note = :note, password_hash = :password_hash
       WHERE employee_id = :id`,
      { ...secrets, id: REVIEW_A.employee_id },
    );
    const form = await publicGet(tokenA);
    const forbidden = new Set([
      'employee_id', 'national_id', 'phone', 'email', 'address', 'emergency_contact_name',
      'emergency_contact_phone', 'note', 'password_hash', 'temp_password_encrypted', 'review_token',
      'fee', 'staff_pay', 'salary', 'wage',
    ]);
    const leakedKeys = forbiddenKeys(form.body, forbidden);
    const raw = JSON.stringify(form.body);
    const leakedMarkers = Object.values(secrets).filter((v) => raw.includes(v));
    probe(
      form.status === 200 && leakedKeys.length === 0 && leakedMarkers.length === 0 &&
        Object.keys(form.body).sort().join(',') === 'first_name,last_name,position',
      'ฟอร์มสาธารณะเผยเบอร์/ที่อยู่/เลขบัตร/บัญชี/ค่าจ้างหรือข้อมูลภายใน',
      `HTTP=${form.status} keys=${leakedKeys.join(',') || '-'} markers=${leakedMarkers.join(',') || '-'} body=${brief(form.body)}`,
      'ฟอร์มสาธารณะไม่คืนรหัสพนักงาน เบอร์ ที่อยู่ เลขบัตร อีเมล รหัสผ่าน ราคา หรือค่าจ้าง',
    );
    probe(
      form.body?.last_name !== REVIEW_A.last_name,
      'ลิงก์สาธารณะเปิดเผยชื่อนามสกุลเต็มของพนักงาน',
      `ใครถือลิงก์เห็น first_name=${JSON.stringify(form.body?.first_name)} last_name=${JSON.stringify(form.body?.last_name)}`,
      'ฟอร์มสาธารณะไม่เปิดเผยนามสกุลเต็มของพนักงาน',
    );
    info(`ตำแหน่งพนักงานถูกส่งให้หน้าฟอร์มโดยตั้งใจเพื่อใช้คำเรียกให้ถูก: ${form.body?.position}`);
  }

  // ---------------------------------------------------------------------------
  head('5 · เคสปิดและเคสยกเลิก');
  await resetPublicReviews();
  {
    const closedCreated = await post('/api/cases', {
      case_id: CASE_CLOSED,
      client_name: 'ผู้รับบริการเคสปิด QA',
      assigned_to: REVIEW_A.employee_id,
      fee: 1000,
    });
    mustStatus(closedCreated, 201, 'สร้างเคสที่จะปิด');
    const cancelledCreated = await post('/api/cases', {
      case_id: CASE_CANCELLED,
      client_name: 'ผู้รับบริการเคสยกเลิก QA',
      assigned_to: REVIEW_A.employee_id,
      fee: 1000,
    });
    mustStatus(cancelledCreated, 201, 'สร้างเคสที่จะยกเลิก');
    mustStatus(await post(`/api/cases/${CASE_CLOSED}/close`, { force: true }), 200, 'ปิดเคส');
    mustStatus(await post(`/api/cases/${CASE_CANCELLED}/cancel`, { reason: 'ยกเลิกก่อนให้บริการสำหรับ QA' }), 200, 'ยกเลิกเคส');

    const afterClosed = await publicPost(
      tokenA,
      validReview(5, { patient_name: 'ผู้รับบริการเคสปิด QA', case_id: CASE_CLOSED }),
      '198.51.100.40',
    );
    const afterCancelled = await publicPost(
      tokenA,
      validReview(1, { patient_name: 'ผู้รับบริการเคสยกเลิก QA', case_id: CASE_CANCELLED }),
      '198.51.100.41',
    );
    const caseColumn = await sql.one(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'staff_reviews' AND column_name = 'case_id'`,
    );
    probe(
      afterClosed.status === 201 && afterCancelled.status === 201 &&
        await reviewCount(REVIEW_A.employee_id) === 2 && Number(caseColumn.n) === 0,
      'พฤติกรรมแบบประเมินหลังปิด/ยกเลิกเคสไม่ตรงกับโมเดลลิงก์รายพนักงาน',
      `closed=${afterClosed.status} cancelled=${afterCancelled.status} rows=${await reviewCount(REVIEW_A.employee_id)} case_id_columns=${caseColumn.n}`,
      'แบบประเมินรายพนักงานรับความเห็นหลังปิด/ยกเลิกเคสได้ และไม่เชื่อ case_id ที่ผู้ส่งแทรกมา',
    );
    info(
      'ฟอร์มนี้ผูกกับพนักงาน ไม่ผูกเคส/กะ จึงแยกไม่ได้ว่าใบใดมาจากเคสที่ให้บริการจบหรือเคสที่ยกเลิกก่อนเริ่ม — ' +
      'รอบนี้บันทึกเป็นข้อจำกัดตามการออกแบบ ไม่ตัดสินเป็นบัค',
    );
  }

  // ---------------------------------------------------------------------------
  head('6 · คะแนนเฉลี่ย จำนวนทศนิยม และค่าเมื่อยังไม่มีคะแนน');
  await resetPublicReviews();
  {
    for (const [i, score] of [5, 4, 3].entries()) {
      mustStatus(
        await publicPost(tokenA, validReview(score), `198.51.100.${50 + i}`),
        201,
        `ส่งคะแนน A=${score}`,
      );
    }
    for (const [i, score] of [5, 5, 4].entries()) {
      mustStatus(
        await publicPost(tokenB, validReview(score), `198.51.100.${60 + i}`),
        201,
        `ส่งคะแนน B=${score}`,
      );
    }

    const summary = mustStatus(await get('/api/reviews/summary'), 200, 'โหลดสรุปคะแนน');
    const rowA = summary.find((r) => r.employee_id === REVIEW_A.employee_id);
    const rowB = summary.find((r) => r.employee_id === REVIEW_B.employee_id);
    const rowEmpty = summary.find((r) => r.employee_id === EMPTY_EMP.employee_id);
    const detailA = mustStatus(
      await get(`/api/reviews/employees/${REVIEW_A.employee_id}`),
      200,
      'โหลดรายละเอียดคะแนน A',
    );
    const detailB = mustStatus(
      await get(`/api/reviews/employees/${REVIEW_B.employee_id}`),
      200,
      'โหลดรายละเอียดคะแนน B',
    );
    const detailEmpty = mustStatus(
      await get(`/api/reviews/employees/${EMPTY_EMP.employee_id}`),
      200,
      'โหลดรายละเอียดคนยังไม่มีคะแนน',
    );

    const starCountsA = Object.fromEntries(detailA.stars.map((r) => [r.star, r.count]));
    probe(
      rowA?.review_count === 3 && rowA.avg_score === 4 && rowA.avg_overall === 4 &&
        detailA.review_count === 3 && detailA.avg_score === 4 &&
        REVIEW_QUESTIONS.every((q) => detailA.questions[q] === 4) &&
        starCountsA[5] === 1 && starCountsA[4] === 1 && starCountsA[3] === 1 &&
        starCountsA[2] === 0 && starCountsA[1] === 0,
      'คะแนน 5,4,3 ไม่ได้ค่าเฉลี่ย 4 หรือ summary/detail/กราฟใช้ตัวเลขคนละชุด',
      `summary=${brief(rowA)} detail=${brief(detailA)} stars=${brief(starCountsA)}`,
      'คะแนน 5,4,3 ได้เฉลี่ย 4 ตรงกันทั้ง summary, รายบุคคล, รายหัวข้อ และการแจกแจงดาว',
    );

    const rawB = 14 / 3;
    probe(
      near(rowB?.avg_score, rawB) && near(detailB.avg_score, rawB) &&
        scoreText(rowA.avg_score) === '4.0' && scoreText(detailB.avg_score) === '4.7',
      'API ปัดค่าก่อนคำนวณหรือหน้าจอแสดงจำนวนทศนิยมไม่คงที่',
      `raw summary=${rowB?.avg_score} detail=${detailB.avg_score} displayA=${scoreText(rowA.avg_score)} displayB=${scoreText(detailB.avg_score)}`,
      'API คืนเลขดิบไว้คำนวณต่อ และหน้าจอปัดแสดง 1 ตำแหน่ง (4 → 4.0, 4.666… → 4.7)',
    );

    const rated = summary.filter((r) => r.review_count > 0);
    const totalReviews = rated.reduce((sum, r) => sum + r.review_count, 0);
    const teamAvg = rated.reduce((sum, r) => sum + r.avg_score * r.review_count, 0) / totalReviews;
    probe(
      totalReviews === 6 && near(teamAvg, 26 / 6) && scoreText(teamAvg) === '4.3',
      'คะแนนเฉลี่ยทั้งทีมไม่ถ่วงตามจำนวนใบหรือจำนวนใบรวมผิด',
      `total=${totalReviews} teamAvg=${teamAvg} display=${scoreText(teamAvg)} rows=${brief(rated)}`,
      'คะแนนเฉลี่ยทั้งทีมถ่วงตามจำนวนใบจริง 6 ใบ และแสดง 4.3',
    );

    probe(
      rowEmpty?.review_count === 0 && rowEmpty.avg_score === null && rowEmpty.avg_overall === null &&
        rowEmpty.last_review_at === null && detailEmpty.review_count === 0 && detailEmpty.avg_score === null &&
        REVIEW_QUESTIONS.every((q) => detailEmpty.questions[q] === null) &&
        detailEmpty.stars.every((r) => r.count === 0) && detailEmpty.reviews.length === 0 &&
        scoreText(detailEmpty.avg_score) === '—',
      'คนที่ยังไม่มีแบบประเมินได้ NaN/500/คะแนนปลอมแทนค่าว่าง',
      `summary=${brief(rowEmpty)} detail=${brief(detailEmpty)}`,
      'คนยังไม่มีคะแนนได้ count=0, avg=null, กราฟทุกดาว=0 และหน้าจอแสดงขีด ไม่ใช่ NaN/500',
    );
  }

  // ---------------------------------------------------------------------------
  head('7 · สิทธิ์เปิด /api/reviews และขอบเขตคะแนนของพนักงานภาคสนาม');
  {
    const access = {
      anonymous: await get('/api/reviews/summary', null),
      manager: await get('/api/reviews/summary', MANAGER),
      hr: await get('/api/reviews/summary', HR),
      admin: await get('/api/reviews/summary', ADMIN),
      finance: await get('/api/reviews/summary', FINANCE),
      field: await get('/api/reviews/summary', FIELD),
    };
    probe(
      access.anonymous.status === 401 && access.manager.status === 200 && access.hr.status === 200 &&
        access.admin.status === 200 && access.finance.status === 403 && access.field.status === 403,
      'หน้าคะแนนเปิดให้คนไม่มีสิทธิ์ หรือปิดกั้นผู้จัดการ/HR/Admin HC',
      Object.entries(access).map(([role, r]) => `${role}=${r.status}`).join(' · '),
      'เฉพาะผู้จัดการ, HR และ Admin HC เปิดคะแนนได้; ไม่ล็อกอิน/การเงิน/พนักงานภาคสนามถูกกั้น',
    );

    const fieldOwn = await get(`/api/reviews/employees/${FIELD.employee_id}`, FIELD);
    const fieldOther = await get(`/api/reviews/employees/${REVIEW_A.employee_id}`, FIELD);
    probe(
      fieldOwn.status === 403 && fieldOther.status === 403,
      'พนักงานภาคสนามเปิดคะแนนของคนอื่นได้ หรือด่านรายคนไม่คงที่',
      `own=${fieldOwn.status} other=${fieldOther.status}`,
      'พนักงานภาคสนามเปิด API คะแนนของคนอื่นไม่ได้',
    );
    info(`พนักงานภาคสนามเปิดคะแนนของตัวเองก็ไม่ได้เช่นกัน (HTTP ${fieldOwn.status}) — เป็นสิทธิ์ office ทั้งหน้า ไม่ใช่เส้น self-service`);
  }

  // ---------------------------------------------------------------------------
  head('8 · ไม่มีเคส/ไม่มีคะแนน/เดือนไม่มีข้อมูล และดาว case_ratings ที่ขึ้น badge');
  await resetPublicReviews();
  await resetCaseRatings();
  {
    const emptySummary = await get('/api/reviews/summary');
    const emptyRow = emptySummary.body?.find((r) => r.employee_id === EMPTY_EMP.employee_id);
    const directEmptyStars = await employeeStars(EMPTY_EMP.employee_id);
    const badgeEmpty = await postTicket('employees/badge', 'kin-emp-badge', { employee_id: EMPTY_EMP.employee_id });
    const mySummary = await postTicket('my-summary', 'kin-my', { u: LINE_EMPTY });
    const myEarnings = await postTicket('my-earnings', 'kin-my-earnings', { u: LINE_EMPTY });

    probe(
      emptySummary.status === 200 && emptyRow?.review_count === 0 && emptyRow.avg_score === null &&
        directEmptyStars.avg === null && directEmptyStars.n === 0 &&
        badgeEmpty.status === 200 && badgeEmpty.body?.stars?.avg === null && badgeEmpty.body?.stars?.n === 0 &&
        badgeEmpty.body?.shifts === 0,
      'ไม่มีแบบประเมิน/ดาวแล้ว summary หรือ badge คืน 500/NaN/คะแนนปลอม',
      `reviews=${brief(emptyRow)} direct=${brief(directEmptyStars)} badge=${badgeEmpty.status}/${brief(badgeEmpty.body)}`,
      'ไม่มีคะแนนทั้ง staff_reviews และ case_ratings คืน avg=null, n/count=0 และ badge ไม่ล้ม',
    );

    probe(
      mySummary.status === 200 && mySummary.body?.linked === true &&
        Array.isArray(mySummary.body.today) && mySummary.body.today.length === 0 &&
        Array.isArray(mySummary.body.tomorrow) && mySummary.body.tomorrow.length === 0 &&
        mySummary.body.last_slip === null &&
        myEarnings.status === 200 && myEarnings.body?.linked === true &&
        ['shifts', 'approved_shifts', 'pending_shifts', 'pay', 'paid_pay', 'unpaid_pay']
          .every((key) => myEarnings.body[key] === 0) &&
        myEarnings.body.last_slip === null && myEarnings.body.tier?.metrics?.stars === null &&
        myEarnings.body.tier?.metrics?.n_stars === 0,
      'พนักงานที่ยังไม่มีเคส/กะ/ข้อมูลเดือนนี้เจอ 500 หรือเลขว่างไม่เป็น 0/null',
      `my-summary=${mySummary.status}/${brief(mySummary.body)} my-earnings=${myEarnings.status}/${brief(myEarnings.body)}`,
      'ยังไม่มีเคสได้รายการวันนี้/พรุ่งนี้ว่าง และเดือนที่ไม่มีข้อมูลได้ตัวเลข 0, slip=null, stars=null โดยไม่เกิด 500',
    );

    await sql.run(
      `INSERT INTO case_ratings (case_id, round, rater_kind, rater_line, employee_id, stars)
       VALUES
         (:case_id, 'qa-1', 'family', :line1, :employee_id, 5),
         (:case_id, 'qa-2', 'family', :line2, :employee_id, 4),
         (:case_id, 'qa-3', 'family', :line3, :employee_id, 3)`,
      {
        case_id: CASE_CLOSED,
        employee_id: REVIEW_A.employee_id,
        line1: `U${'a'.repeat(32)}`,
        line2: `U${'b'.repeat(32)}`,
        line3: `U${'c'.repeat(32)}`,
      },
    );
    const directRated = await employeeStars(REVIEW_A.employee_id);
    const badgeRated = await postTicket('employees/badge', 'kin-emp-badge', { employee_id: REVIEW_A.employee_id });
    probe(
      directRated.avg === 4 && directRated.n === 3 && badgeRated.status === 200 &&
        badgeRated.body?.stars?.avg === 4 && badgeRated.body?.stars?.n === 3,
      'ดาว 5,4,3 ใน case_ratings ขึ้น badge/ตัวเลขพนักงานไม่เป็น 4.0 หรือจำนวนครั้งผิด',
      `direct=${brief(directRated)} badge=${badgeRated.status}/${brief(badgeRated.body)}`,
      'ดาว case_ratings 5,4,3 ได้เฉลี่ย 4 และจำนวน 3 ตรงกันทั้งฟังก์ชันคำนวณกับ API badge',
    );

    await resetCaseRatings();
    await sql.run(
      `INSERT INTO case_ratings (case_id, round, rater_kind, rater_line, employee_id, stars)
       VALUES
         (:case_id, 'qa-low-n-1', 'family', :line1, :employee_id, 5),
         (:case_id, 'qa-low-n-2', 'family', :line2, :employee_id, 1)`,
      {
        case_id: CASE_CLOSED,
        employee_id: REVIEW_A.employee_id,
        line1: `U${'d'.repeat(32)}`,
        line2: `U${'e'.repeat(32)}`,
      },
    );
    const belowMinimum = await employeeStars(REVIEW_A.employee_id);
    const badgeBelowMinimum = await postTicket('employees/badge', 'kin-emp-badge', { employee_id: REVIEW_A.employee_id });
    probe(
      belowMinimum.avg === null && belowMinimum.n === 2 && badgeBelowMinimum.status === 200 &&
        badgeBelowMinimum.body?.stars?.avg === null && badgeBelowMinimum.body?.stars?.n === 2,
      'มีดาวไม่ถึง 3 ครั้งแล้ว badge แสดงค่าเฉลี่ยที่ยังไม่นิ่ง หรือซ่อนจำนวนครั้งไปด้วย',
      `direct=${brief(belowMinimum)} badge=${badgeBelowMinimum.status}/${brief(badgeBelowMinimum.body)}`,
      'มีเพียง 2 ความเห็น badge ซ่อนค่าเฉลี่ยเป็น null แต่ยังคืน n=2 ตามจริง',
    );
  }

  console.log(`\n=== สรุป: ${checks} จุดใน 8 หัวข้อ · พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${passed.length} จุด ===`);
  found.forEach((item, i) => console.log(`${i + 1}. ${item.title}`));
  if (observations.length) {
    console.log(`INFO | พฤติกรรม/ข้อจำกัดที่บันทึกไว้ ${observations.length} จุด (ไม่ตัดสินเป็นบัค)`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
