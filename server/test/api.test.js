import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

// Reject direct execution against any inherited/shared database before importing the app.
if (process.env.RUN_DB_TESTS === '1') {
  const target = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/invalid');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.pathname, '/kin_api_test');
}


if (process.env.RUN_DB_TESTS !== '1') {
  const why = 'ใช้ npm run test:api เพื่อสร้างฐาน PostgreSQL ชั่วคราวและข้อมูลทดสอบ';
  test('เทสที่ต้องใช้ฐานข้อมูล', { skip: why }, () => {});
} else {
  const { createApp } = await import('../src/app.js');
  const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
  const { sql, pool } = await import('../src/db/index.js');
  const casesRepo = await import('../src/cases/repo.js');
  const { seedFixtures } = await import('./fixtures.js');

  const emp = (id, position) => ({ employee_id: id, position, first_name: 'T', last_name: 'T' });
  const MANAGER = emp('EMP-0001', 'manager');
  const HR = emp('EMP-0007', 'hr');
  const FIELD = emp('EMP-0003', 'caregiver');
  const GHOST = emp('EMP-9999', 'manager'); // ไม่มีอยู่จริงในตาราง

  let base;
  let server;

  before(async () => {
    const existing = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    assert.equal(existing.rows[0].n, 0, 'fixtures require an empty disposable database');
    await seedFixtures(pool, hashPassword);
    server = createServer(createApp());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
  });

  /** Read endpoints use the same real authentication middleware as mutations. */
  async function get(path, who) {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {},
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  // ---------- ตรวจบัญชีสดทุก request ----------
  describe('requireAuth — ตรวจบัญชีสดจาก DB ไม่ใช่เชื่อ token', () => {
    test('ไม่มีคุกกี้ = 401', async () => {
      assert.equal((await get('/api/cases')).status, 401);
    });

    test('token ปลอม/เสีย = 401', async () => {
      const res = await fetch(`${base}/api/cases`, { headers: { cookie: `${COOKIE_NAME}=not.a.jwt` } });
      assert.equal(res.status, 401);
    });

    test('token ถูกต้องแต่บัญชีไม่มีในระบบแล้ว = 401 (เดิมผ่านฉลุยเพราะเชื่อ token)', async () => {
      const r = await get('/api/cases', GHOST);
      assert.equal(r.status, 401);
      assert.match(r.body.error, /ใช้งานไม่ได้แล้ว/);
    });

    test('token ที่ออกก่อนบัญชีถูกสร้าง (รหัสพนักงานถูกเอาไปใช้ซ้ำ) = 401 (ตรวจ 13 พ.ย. 2569)', async () => {
      const reused = emp('EMP-0089', 'manager');
      const oldToken = signToken(reused); // คุกกี้ของคนเก่าที่เคยใช้รหัสนี้
      await new Promise((r) => setTimeout(r, 1100)); // created_at ละเอียดระดับวินาที
      await sql.run(
        `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
         VALUES ('EMP-0089', 'New', 'Hire', 'manager', 'emp-0089@example.invalid', 'active', 'x', false)`,
      );
      const res = await fetch(`${base}/api/cases`, { headers: { cookie: `${COOKIE_NAME}=${oldToken}` } });
      assert.equal(res.status, 401);
      assert.equal((await get('/api/cases', reused)).status, 200, 'token ใหม่ของบัญชีนี้ใช้ได้ตามปกติ');
    });

    test('token บอกว่าเป็น manager แต่ DB บอกว่าเป็นพนักงานภาคสนาม = ยึดตาม DB (403)', async () => {
      assert.equal((await get('/api/cases', { ...FIELD, position: 'manager' })).status, 403);
    });

    test('บัญชีที่ใช้งานได้ เข้าได้ปกติ', async () => {
      assert.equal((await get('/api/cases', MANAGER)).status, 200);
      assert.equal((await get('/api/cases', HR)).status, 200);
    });

    test('บังคับเปลี่ยนรหัสเริ่มต้น (21 พ.ย. 2569): เข้าด้วย 12345678 = ใช้อะไรไม่ได้จนตั้งรหัสใหม่ · เปลี่ยนแล้วไม่ถูกบังคับอีก', async () => {
      const { DEFAULT_PASSWORD, markDefaultPassword } = await import('../src/lib/auth.js');
      await sql.run(
        `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
         VALUES ('EMP-0391', 'Default', 'Pw', 'caregiver', 'emp-0391@example.invalid', 'active', :h, false),
                ('EMP-0392', 'Line', 'Only', 'caregiver', 'emp-0392@example.invalid', 'active', :h, false)`,
        { h: await hashPassword(DEFAULT_PASSWORD) },
      );
      const send = async (method, path, body, cookie, expected) => {
        const res = await fetch(`${base}${path}`, {
          method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (expected) assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
        const set = res.headers.get('set-cookie');
        return { status: res.status, data, cookie: set ? set.split(';')[0] : cookie };
      };

      // เข้าด้วยรหัสเริ่มต้น → session บอกให้เปลี่ยน · /api ทุกเส้นปิด · /auth/me ยังเรียกได้
      const login = await send('POST', '/api/auth/login', { email: 'EMP-0391', password: DEFAULT_PASSWORD }, null, 200);
      assert.equal(login.data.must_change_password, true);
      const c1 = login.cookie;
      assert.equal((await send('GET', '/api/my/today', undefined, c1)).status, 403);
      assert.equal((await send('GET', '/api/auth/me', undefined, c1, 200)).data.must_change_password, true);

      // ตั้งรหัสใหม่เป็นรหัสเริ่มต้นไม่ได้ · ไม่ส่งรหัสปัจจุบันได้ (server ใช้รหัสเริ่มต้นตรวจแทน)
      await send('POST', '/api/auth/change-password', { new_password: DEFAULT_PASSWORD }, c1, 400);
      const changed = await send('POST', '/api/auth/change-password', { new_password: 'my-own-pass-391' }, c1, 200);
      const c2 = changed.cookie;
      assert.notEqual(c2, c1, 'ออกคุกกี้ใบใหม่ให้หลังเปลี่ยนรหัส');
      assert.equal((await send('GET', '/api/auth/me', undefined, c2, 200)).data.must_change_password, false);
      assert.equal((await send('GET', '/api/my/today', undefined, c2)).status, 200);

      // ไม่ส่งรหัสปัจจุบัน ใช้ได้เฉพาะตอนรหัสยังเป็นค่าเริ่มต้น — เปลี่ยนไปแล้วต้องพิมพ์รหัสเดิม
      await send('POST', '/api/auth/change-password', { new_password: 'another-pass-391' }, c2, 400);

      // เข้าครั้งถัดไปด้วยรหัสใหม่ → ไม่ถูกบังคับ
      const again = await send('POST', '/api/auth/login', { email: 'EMP-0391', password: 'my-own-pass-391' }, null, 200);
      assert.equal(again.data.must_change_password, false);
      assert.equal((await send('GET', '/api/my/today', undefined, again.cookie)).status, 200);

      // เข้าทาง LINE/SSO (ไม่มีรหัสที่พิมพ์) — เทียบ hash: ยังเป็นรหัสเริ่มต้น = บังคับ · ไม่ใช่ = ไม่บังคับ
      const lineOnly = await sql.one('SELECT * FROM employees WHERE employee_id = :id', { id: 'EMP-0392' });
      assert.equal(await markDefaultPassword(lineOnly), true);
      assert.equal((await get('/api/my/today', emp('EMP-0392', 'caregiver'))).status, 403, 'เซสชันของคนที่ยังใช้รหัสเริ่มต้นถูกปิด');
      const done = await sql.one('SELECT * FROM employees WHERE employee_id = :id', { id: 'EMP-0391' });
      assert.equal(await markDefaultPassword(done), false);

      // ตรวจครั้งเดียวพอ (ผู้ใช้ขอ 21 พ.ย. 2569) — ตั้งรหัสเองแล้ว (FALSE) ไม่ตรวจอีก แม้รหัสจะกลับไปเป็นค่าเริ่มต้นทางอื่น
      await sql.run('UPDATE employees SET password_hash = :h WHERE employee_id = :id', { h: await hashPassword(DEFAULT_PASSWORD), id: 'EMP-0391' });
      const once = await send('POST', '/api/auth/login', { email: 'EMP-0391', password: DEFAULT_PASSWORD }, null, 200);
      assert.equal(once.data.must_change_password, false);
      // ยังไม่เคยตรวจ = NULL · ตรวจแล้วจดผล
      assert.equal((await sql.one(`SELECT uses_default_password AS v FROM employees WHERE employee_id = 'EMP-0392'`)).v, true);
      assert.equal((await sql.one(`SELECT uses_default_password AS v FROM employees WHERE employee_id = 'EMP-0391'`)).v, false);

      // ฐานที่เคยรันรุ่นแรก (NOT NULL DEFAULT FALSE · ทุกแถว FALSE) — แปลงครั้งเดียวแล้วคนที่ยังใช้รหัสเริ่มต้นถูกบังคับจริง (ตรวจ 21 พ.ย. 2569)
      const { normalizeDefaultPasswordColumn } = await import('../src/lib/auth.js');
      await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
                     VALUES ('EMP-0394', 'Legacy', 'Flag', 'caregiver', 'emp-0394@example.invalid', 'active', :h, false)`,
        { h: await hashPassword(DEFAULT_PASSWORD) });
      await sql.run('UPDATE employees SET uses_default_password = FALSE WHERE uses_default_password IS NULL');
      await sql.run('ALTER TABLE employees ALTER COLUMN uses_default_password SET DEFAULT FALSE');
      await sql.run('ALTER TABLE employees ALTER COLUMN uses_default_password SET NOT NULL');
      assert.equal((await send('POST', '/api/auth/login', { email: 'EMP-0394', password: DEFAULT_PASSWORD }, null, 200)).data.must_change_password, false,
        'รูปแบบเก่า: ไม่ถูกบังคับ (บั๊กที่เจอ)');
      assert.equal(await normalizeDefaultPasswordColumn(), true);
      assert.equal(await normalizeDefaultPasswordColumn(), false, 'แปลงครั้งเดียว');
      assert.equal((await send('POST', '/api/auth/login', { email: 'EMP-0394', password: DEFAULT_PASSWORD }, null, 200)).data.must_change_password, true);
      // คนที่ใช้รหัสของตัวเองอยู่ (hash ไม่ใช่รหัสเริ่มต้น) — ตรวจใหม่หลังแปลงก็ยังไม่ถูกบังคับ
      await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password, uses_default_password)
                     VALUES ('EMP-0395', 'Own', 'Pass', 'caregiver', 'emp-0395@example.invalid', 'active', :h, false, NULL)`,
        { h: await hashPassword('own-pass-0395') });
      assert.equal((await send('POST', '/api/auth/login', { email: 'EMP-0395', password: 'own-pass-0395' }, null, 200)).data.must_change_password, false);
    });
  });

  // ---------- สิทธิ์ field vs admin ----------
  describe('พนักงานภาคสนามเข้าหลังบ้านไม่ได้', () => {
    for (const path of ['/api/cases', '/api/employees', '/api/customers', '/api/patients',
      '/api/invoices', '/api/packages/matrix', '/api/physio/packages']) {
      test(`${path} = 403`, async () => {
        assert.equal((await get(path, FIELD)).status, 403);
      });
    }

    test('แต่เข้าเส้นของตัวเองได้', async () => {
      assert.equal((await get('/api/my/today', FIELD)).status, 200);
      assert.equal((await get('/api/my/cases', FIELD)).status, 200);
    });
  });

  // ---------- ค่าจ้างต้องไม่หลุดไปหาคนที่ไม่ใช่ผู้จัดการ ----------
  describe('ค่าจ้าง/ต้นทุน เห็นเฉพาะผู้จัดการ', () => {
    const PAY = ['staff_pay', 'rate_staff_pay', 'physio_staff_pay'];

    test('HR เข้า payroll ไม่ได้ทุกเส้น แม้เส้นรายละเอียดที่ไม่มีรหัสจริงก็ถูกกันก่อนค้น DB', async () => {
      for (const path of ['/api/payroll/meta', '/api/payroll', '/api/payroll/preview', '/api/payroll/PAY-NOT-REAL']) {
        assert.equal((await get(path, HR)).status, 403, path);
      }
      assert.equal((await get('/api/payroll/meta', FIELD)).status, 403);
      assert.equal((await get('/api/payroll/meta', MANAGER)).status, 200);
    });

    test('รายงานค่าตอบแทนรวมเป็น manager-only แต่รายงานของตัวเองยังเปิดตามเดิม', async () => {
      assert.equal((await get('/api/cases/attendance/report?month=2026-08', HR)).status, 403);
      assert.equal((await get('/api/cases/attendance/report?month=2026-08', MANAGER)).status, 200);
      assert.equal((await get('/api/my/attendance/report?month=2026-08', HR)).status, 200);
      assert.equal((await get('/api/my/attendance/report?month=2026-08', FIELD)).status, 200);
    });

    test('GET /api/cases — manager เห็นค่าจ้าง, HR ไม่เห็น', async () => {
      const m = await get('/api/cases?per_page=50', MANAGER);
      const h = await get('/api/cases?per_page=50', HR);
      assert.equal(m.status, 200);
      assert.equal(h.status, 200);
      assert.ok(m.body.data.some((c) => 'staff_pay' in c), 'manager ต้องได้ staff_pay ติดมาด้วย');

      for (const c of h.body.data) {
        for (const f of PAY) assert.equal(f in c, false, `HR ต้องไม่ได้ ${f} (เคส ${c.case_id})`);
      }
      // ข้อมูลอื่นต้องยังครบ ไม่ใช่ตัดจนใช้งานไม่ได้
      assert.equal(h.body.data.length, m.body.data.length);
      assert.ok(h.body.data.every((c) => 'fee' in c && 'client_name' in c));
    });

    test('GET /api/cases/:id — เส้นรายตัวก็ต้องตัดเหมือนกัน', async () => {
      const id = (await get('/api/cases?per_page=1', MANAGER)).body.data[0].case_id;
      assert.ok('staff_pay' in (await get(`/api/cases/${id}`, MANAGER)).body);
      const h = (await get(`/api/cases/${id}`, HR)).body;
      for (const f of PAY) assert.equal(f in h, false, `HR ต้องไม่ได้ ${f}`);
    });

    test('GET /api/cases/:id/visits — attendance is separate from case payouts', async () => {
      const cases = (await get('/api/cases?per_page=50', MANAGER)).body.data;
      let checked = 0;
      for (const c of cases) {
        const m = (await get(`/api/cases/${c.case_id}/visits`, MANAGER)).body;
        if (!m.length) continue;
        const h = (await get(`/api/cases/${c.case_id}/visits`, HR)).body;
        assert.ok(m.every((v) => !('staff_pay' in v) && !('effective_pay' in v)), 'visits no longer allocate case wages');
        for (const v of h) {
          assert.equal('staff_pay' in v, false, 'HR ต้องไม่ได้ staff_pay รายกะ');
          assert.equal('effective_pay' in v, false, 'HR ต้องไม่ได้ effective_pay');
        }
        assert.equal(h.length, m.length, 'จำนวนกะต้องเท่ากัน ตัดแค่ตัวเลขค่าจ้าง');
        assert.ok(h.every((v) => 'visit_date' in v && 'state' in v));
        checked++;
      }
      assert.ok(checked > 0, 'ต้องมีเคสที่มีกะอย่างน้อยหนึ่งเคสให้เทส');
    });

    test('GET /api/packages/matrix — HR ไม่เห็นค่าจ้าง/กำไร แต่เห็นราคาลูกค้า', async () => {
      const h = (await get('/api/packages/matrix', HR)).body;
      for (const r of h.rates) {
        assert.equal('staff_pay' in r, false);
        assert.equal('margin' in r, false);
        assert.ok('customer_price' in r);
      }
      assert.ok((await get('/api/packages/matrix', MANAGER)).body.rates.some((r) => 'staff_pay' in r));
    });

    test('GET /api/physio/packages — เกณฑ์เดียวกัน', async () => {
      for (const p of (await get('/api/physio/packages', HR)).body) {
        assert.equal('staff_pay' in p, false);
      }
    });
  });

  // ---------- รายการต้องตรวจถูกจำกัดช่วง ----------
  describe('รายการต้องตรวจ', () => {
    test('ไม่มีแถวที่เก่ากว่า 180 วัน', async () => {
      const rows = (await get('/api/cases/attendance/exceptions', MANAGER)).body;
      const cutoff = new Date(Date.now() + 7 * 3.6e6 - 180 * 86400000).toISOString().slice(0, 10);
      for (const v of rows) assert.ok(v.visit_date >= cutoff, `${v.visit_date} เก่ากว่ากรอบ ${cutoff}`);
    });
  });


  async function post(path, body, who = MANAGER, expected = 200) {
    /* ด่าน "เคสขาดที่อยู่/เบอร์ ห้ามจับคู่" (8 พ.ย. 2569) มาทีหลัง test ชุดนี้ — เคสทดสอบส่วนใหญ่ไม่มีที่อยู่ จึงล้มที่ /assign ทั้งชุด
       (ตรวจ 10 พ.ย. 2569: 27 test ล้มด้วยเหตุนี้ ทำให้ระบบจับคู่/กะ/ค่าจ้างไม่มี test คุ้มครองจริง)
       ใส่ force ให้เองเฉพาะ /assign ที่ไม่ได้ระบุ — ตัวด่านมี test ของตัวเอง ("จับคู่เคสที่ขาดที่อยู่/เบอร์") ที่ส่ง force เองชัดๆ */
    if (/\/api\/cases\/[^/]+\/assign$/.test(path) && body && !('force' in body)) body = { ...body, force: true };
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    assert.equal(res.status, expected, `${path}: ${JSON.stringify(data)}`);
    return data;
  }

  async function newCase() {
    return post('/api/cases', { case_type: 'other', client_name: 'Workflow patient', fee: 2000, staff_pay: 1200 }, MANAGER, 201);
  }

  test('จับคู่เคสที่ขาดที่อยู่/เบอร์: ไม่ยืนยัน = 409 บอกช่องที่ขาด · ยืนยัน (force) = จับคู่ได้ · กรอกครบ = ไม่ต้องยืนยัน', async () => {
    const bare = await newCase();
    const refused = await post(`/api/cases/${bare.case_id}/assign`, { employee_id: FIELD.employee_id, force: false }, MANAGER, 409);
    assert.deepEqual(refused.details.map((d) => d.field).sort(), ['address', 'client_phone']);
    await post(`/api/cases/${bare.case_id}/assign`, { employee_id: FIELD.employee_id, force: true }, MANAGER, 200);

    const full = await post('/api/cases', {
      case_type: 'other', client_name: 'Complete', address: '1 ถนนทดสอบ', client_phone: '0812345678',
    }, MANAGER, 201);
    await post(`/api/cases/${full.case_id}/assign`, { employee_id: FIELD.employee_id, force: false }, MANAGER, 200);
  });

  test('แก้ราคาแพ็ก: เคสที่เปิดอยู่และขายราคาเดียวกับแพ็กตามราคาเต็มใหม่ · ใบร่างไม่ขึ้นส่วนลดเก่า · เคสราคาอื่น/ยกเลิกแล้วไม่แตะ', async () => {
    const patch = async (path, body, expected = 200) => {
      const res = await fetch(`${base}${path}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      assert.equal(res.status, expected, JSON.stringify(data));
      return data;
    };
    const { physio_package_id: id } = await sql.one(
      `INSERT INTO physio_packages (name, sessions, original_price, discount_amount, special_price, staff_pay)
       VALUES ('Promo ended', 10, 18000, 3000, 15000, 9000) RETURNING physio_package_id`);
    const open = (name, fee) => post('/api/cases', { case_type: 'other', client_name: name, service_kind: 'physio',
      physio_package_id: id, fee }, MANAGER, 201);
    const same = await open('Same price', 15000);
    const deal = await open('Negotiated', 14000);
    const gone = await open('Cancelled one', 15000);
    await post(`/api/cases/${gone.case_id}/cancel`, { reason: 'test' });
    const draftOf = async (caseId) => (await get(`/api/invoices?case_id=${caseId}`, MANAGER)).body.data
      .find((i) => i.status === 'draft');
    let d = await draftOf(same.case_id);
    assert.equal(d.amount, 18000);
    assert.equal(d.discount, 3000);

    // เลิกโปร: ราคาเต็ม 15,000 ขาย 15,000
    const saved = await patch(`/api/physio/packages/${id}`, { original_price: 15000, special_price: 15000, discount_amount: null, discount_percent: null });
    assert.equal(saved.refreshed.cases, 1, JSON.stringify(saved.refreshed));
    assert.equal(saved.refreshed.drafts, 1);
    d = await draftOf(same.case_id);
    assert.equal(d.amount, 15000);
    assert.equal(d.discount, 0);
    assert.equal(d.total, 15000, 'ยอดที่ลูกค้าจ่ายเท่าเดิม');
    const row = await casesRepo.findById(same.case_id);
    assert.equal(row.fee, 15000);
    assert.equal(row.service_list_price_snapshot, 15000);
    const events = (await get(`/api/cases/${same.case_id}/events`, MANAGER)).body;
    assert.ok(events.some((e) => /18,000 → 15,000/.test(e.detail ?? '')), JSON.stringify(events.map((e) => e.detail)));

    // เคสที่ขายราคาอื่น และเคสที่ยกเลิกแล้ว คงราคาเต็มเดิม
    assert.equal((await casesRepo.findById(deal.case_id)).service_list_price_snapshot, 18000);
    assert.equal((await casesRepo.findById(gone.case_id)).service_list_price_snapshot, 18000);

    // แก้แพ็กแต่ไม่แตะราคา = ไม่ไล่ปรับเคส · บันทึกราคาเดิมซ้ำ = ไม่มีอะไรเปลี่ยน
    assert.equal((await patch(`/api/physio/packages/${id}`, { note: 'just a note' })).refreshed, undefined);
    assert.equal((await patch(`/api/physio/packages/${id}`, { original_price: 15000, special_price: 15000 })).refreshed.cases, 0);
  });

  test('รหัสแพ็คเกจ: ตั้งให้อัตโนมัติ · แก้ได้ (ตัวพิมพ์ใหญ่ให้เอง) · ห้ามซ้ำข้ามกายภาพ/Homecare · ว่าง = ตั้งใหม่ · เคสเห็นรหัส · ค้นเคสด้วยรหัสได้', async () => {
    const send = async (method, path, body, expected = 200) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify(body),
      });
      const data = res.status === 204 ? null : await res.json();
      assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    };
    const { formatAbbr, rateDefaultCode } = await import('../src/packages/codes.js');
    assert.equal(formatAbbr({ format_id: 1, name: 'รายวัน 12 ชม.', category: 'daily' }), 'D12');
    assert.equal(formatAbbr({ format_id: 3, name: 'รายสัปดาห์ 24 ชม.', category: 'weekly' }), 'W24');
    assert.equal(formatAbbr({ format_id: 5, name: 'รายเดือน 12 ชม. หยุด 4 วัน', category: 'monthly' }), 'M12H');
    assert.equal(formatAbbr({ format_id: 8, name: 'รายเดือน 24 ชม. ไม่มีวันหยุด', category: 'monthly' }), 'M24N');
    assert.equal(formatAbbr({ format_id: 9, name: 'แบบพิเศษ', category: 'monthly' }), 'F9');
    assert.equal(
      rateDefaultCode({ grade_id: 1, staff_tier: 'RN' }, { format_id: 8, name: 'รายเดือน 24 ชม. ไม่มีวันหยุด', category: 'monthly' }, { grade_id: 1, name: 'เกรด 1' }),
      'HC-M24N-G1-RN',
    );

    // ตั้งให้อัตโนมัติ — ทั้งแถวที่มีอยู่ก่อน (fixture) และแถวใหม่
    const matrix = (await get('/api/packages/matrix', MANAGER)).body;
    const rate = matrix.rates.find((r) => r.staff_tier === 'CG' && r.customer_price === 2000);
    assert.equal(rate.code, `HC-F${rate.format_id}-CG`);
    const fresh = await send('POST', '/api/physio/packages', { name: 'Code auto', sessions: 5, special_price: 5000 }, 201);
    assert.equal(fresh.code, `PT-${String(fresh.physio_package_id).padStart(3, '0')}`);

    // แก้ได้ · ตัวพิมพ์ใหญ่/ขีดให้เอง · รหัสผิดรูปแบบ = 400
    const saved = await send('PATCH', '/api/packages/rates', { rates: [{ format_id: rate.format_id, grade_id: null, staff_tier: 'CG',
      customer_price: 2000, available: true, code: ' hc daily cg ' }] });
    assert.equal(saved.rates.find((r) => r.rate_id === rate.rate_id).code, 'HC-DAILY-CG');
    await send('PATCH', `/api/physio/packages/${fresh.physio_package_id}`, { code: 'ab$c' }, 400);
    assert.equal((await send('PATCH', `/api/physio/packages/${fresh.physio_package_id}`, { code: 'pt five' })).code, 'PT-FIVE');

    // ห้ามซ้ำข้ามตาราง ไม่สนตัวพิมพ์ · ชนกันเองในชุดเดียว
    await send('PATCH', `/api/physio/packages/${fresh.physio_package_id}`, { code: 'hc-daily-cg' }, 409);
    await send('POST', '/api/physio/packages', { name: 'Code clash', sessions: 1, special_price: 100, code: 'PT-FIVE' }, 409);
    await send('PATCH', '/api/packages/rates', { rates: [
      { format_id: rate.format_id, grade_id: null, staff_tier: 'CG', customer_price: 2000, code: 'PT-FIVE' }] }, 409);
    await send('PATCH', '/api/packages/rates', { rates: [
      { format_id: rate.format_id, grade_id: null, staff_tier: 'CG', customer_price: 2000, code: 'SAME' },
      { format_id: rate.format_id, grade_id: null, staff_tier: 'NA', customer_price: 2500, code: 'SAME' }] }, 409);
    // บันทึกรหัสเดิมของตัวเองซ้ำ = ไม่นับว่าชน · ไม่ส่งคีย์ code = คงรหัสเดิม
    assert.equal((await send('PATCH', `/api/physio/packages/${fresh.physio_package_id}`, { code: 'PT-FIVE', note: 'x' })).code, 'PT-FIVE');
    assert.equal((await send('PATCH', `/api/physio/packages/${fresh.physio_package_id}`, { note: 'y' })).code, 'PT-FIVE');

    // ว่าง = กลับเป็นรหัสตั้งต้น
    assert.equal((await send('PATCH', `/api/physio/packages/${fresh.physio_package_id}`, { code: '' })).code,
      `PT-${String(fresh.physio_package_id).padStart(3, '0')}`);

    // เคสเห็นรหัส (ผูกด้วย id เดิม แก้รหัสแล้วเคสไม่หลุด) · ค้นรายการเคสด้วยรหัสได้
    const hc = await post('/api/cases', { case_type: 'other', client_name: 'Coded homecare', service_kind: 'homecare',
      pkg_format_id: rate.format_id, pkg_staff_tier: 'CG' }, MANAGER, 201);
    assert.equal((await casesRepo.findById(hc.case_id)).pkg_rate_code, 'HC-DAILY-CG');
    const pt = await post('/api/cases', { case_type: 'other', client_name: 'Coded physio', service_kind: 'physio',
      physio_package_id: fresh.physio_package_id }, MANAGER, 201);
    await send('PATCH', `/api/physio/packages/${fresh.physio_package_id}`, { code: 'PT-RENAMED' });
    const ptRow = await casesRepo.findById(pt.case_id);
    assert.equal(ptRow.physio_package_id, fresh.physio_package_id);
    assert.equal(ptRow.physio_package_code, 'PT-RENAMED');
    const found = (await get('/api/cases?q=pt-renamed', MANAGER)).body.data.map((c) => c.case_id);
    assert.ok(found.includes(pt.case_id), JSON.stringify(found));
    assert.ok(!found.includes(hc.case_id));
    assert.ok((await get('/api/cases?q=HC-DAILY', MANAGER)).body.data.some((c) => c.case_id === hc.case_id));
  });

  test('popup เพิ่มหัตถการ/อุปกรณ์เสริม: PATCH เฉพาะ addons ทีละรายการ · หัตถการได้ VN และคงเลขเดิมเมื่อเพิ่มรายการถัดไป', async () => {
    const patch = async (path, body, expected = 200) => {
      const res = await fetch(`${base}${path}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      assert.equal(res.status, expected, JSON.stringify(data));
      return data;
    };
    const c = await newCase();
    const one = await patch(`/api/cases/${c.case_id}`, { addons: [
      { kind: 'procedure', name: 'ค่าทำแผลขนาดเล็ก', quantity: 1, unit_price: 200, vn: null },
    ] });
    const vn = one.addons.find((a) => a.kind === 'procedure')?.vn;
    assert.ok(vn, JSON.stringify(one.addons));
    const two = await patch(`/api/cases/${c.case_id}`, { addons: [
      ...one.addons,
      { name: 'เตียงลม', kind: 'sale', quantity: 2, unit_price: 1500 },
    ] });
    assert.equal(two.addons.length, 2);
    assert.equal(two.addons.find((a) => a.kind === 'procedure').vn, vn, 'VN เดิมไม่เปลี่ยน');
    assert.equal(two.fee, 2000, 'ช่องอื่นของเคสไม่ถูกแตะ');
    const draft = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data.find((i) => i.status === 'draft');
    if (draft) assert.equal(draft.total, 2000 + 200 + 3000, 'ใบร่างรวมยอดรายการที่เพิ่ม');
  });

  test('legacy physio case (case_type only): unrelated edits keep it, switching to Homecare resets case_type', async () => {
    const patch = async (path, body) => {
      const res = await fetch(`${base}${path}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const c = await newCase();
    await sql.run(`UPDATE cases SET case_type = 'physiotherapy', service_kind = NULL, physio_package_id = NULL WHERE case_id = :id`, { id: c.case_id });
    await patch(`/api/cases/${c.case_id}`, { note: 'แก้ช่องอื่น' });
    assert.equal((await sql.one('SELECT case_type FROM cases WHERE case_id = :id', { id: c.case_id })).case_type, 'physiotherapy');
    const res = await patch(`/api/cases/${c.case_id}`, { service_kind: 'homecare' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await sql.one('SELECT case_type FROM cases WHERE case_id = :id', { id: c.case_id })).case_type, 'elderly_care');
  });

  describe('สิทธิ์ตามตำแหน่ง — การเงิน / Admin HC', () => {
    const FINANCE = emp('EMP-0091', 'finance');
    const HC = emp('EMP-0093', 'admin');

    before(async () => {
      for (const [id, position] of [['EMP-0091', 'finance'], ['EMP-0093', 'admin']]) {
        await sql.run(
          `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
           VALUES (:id, 'Perm', 'Test', :position, :id || '@example.invalid', 'active', 'x', false)`,
          { id, position },
        );
      }
    });

    test('การเงิน: เข้าได้เฉพาะใบแจ้งหนี้ · ค่าตอบแทน · รายได้ — งานหลังบ้านอื่น 403', async () => {
      for (const path of ['/api/invoices', '/api/invoices/revenue', '/api/payroll/case-queue', '/api/cases/attendance/pending',
        '/api/cases/assignable-employees', '/api/cases/CASE-FIXTURE/pay']) {
        assert.equal((await get(path, FINANCE)).status, 200, path);
      }
      for (const path of ['/api/cases', '/api/cases/CASE-FIXTURE', '/api/customers', '/api/patients', '/api/employees',
        '/api/packages/matrix', '/api/reviews/summary']) {
        assert.equal((await get(path, FINANCE)).status, 403, path);
      }
      const me = (await get('/api/auth/me', FINANCE)).body;
      // หมวดเดิม (คิดจากสิทธิ์รายเมนู) + สิทธิ์รายเมนู/งานของการเงินตามค่าตั้งต้น
      assert.deepEqual(me.permissions, ['billing', 'money', 'invoices', 'payroll', 'revenue', 'see_pay', 'invoice_adjust', 'slip_delete', 'finance_logs']);
      const alerts = (await get('/api/notify/alerts', FINANCE)).body;
      assert.deepEqual(Object.keys(alerts.groups).sort(), ['invoices', 'payroll']);
    });

    test('Admin IPD เลิกใช้แล้ว — ตั้งตำแหน่งนี้ไม่ได้ และ migrate ย้ายคนเดิมเป็น Admin HC', async () => {
      await post('/api/employees', { first_name: 'Ipd', last_name: 'Admin', position: 'admin_ipd' }, MANAGER, 400);
      // จำลองข้อมูลเก่า: ปลด CHECK ชั่วคราวแล้วใส่แถว admin_ipd จากนั้นรัน schema ซ้ำ
      await sql.run('ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_position_check');
      await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
                     VALUES ('EMP-0092', 'Old', 'Ipd', 'admin_ipd', 'ipd@example.invalid', 'active', 'x', false)`);
      const { readFile } = await import('node:fs/promises');
      await pool.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
      assert.equal((await sql.one(`SELECT position FROM employees WHERE employee_id = 'EMP-0092'`)).position, 'admin');
    });

    test('Admin HC: สิทธิ์เท่าแอดมินเดิม — งานหลังบ้าน + ใบแจ้งหนี้ ไม่มีเรื่องเงิน', async () => {
      assert.equal((await get('/api/cases', HC)).status, 200);
      assert.equal((await get('/api/invoices', HC)).status, 200);
      assert.equal((await get('/api/payroll/preview', HC)).status, 403);
      assert.equal((await get('/api/invoices/revenue', HC)).status, 403);
      const alerts = (await get('/api/notify/alerts', HC)).body;
      assert.deepEqual(Object.keys(alerts.groups).sort(), ['attendance', 'cases', 'invoices']);
    });

    /* ตั้งแต่ 2 พ.ย. 2569 (da606a5 · "ตั้งรหัสผ่านทุกคนเป็น 12345678") บัญชีใหม่ไม่มีรหัสชั่วคราวแล้ว
       ด่านซ่อนรหัสชั่วคราวยังต้องทำงานกับแถวเก่าที่ยังค้างรหัสชั่วคราว (must_change_password + สำเนาเข้ารหัส) */
    test('บัญชีใหม่ไม่มีรหัสชั่วคราว · รหัสชั่วคราวค้างของบัญชีผู้จัดการ/การเงิน HR และ Admin HC มองไม่เห็น — ผู้จัดการเห็น', async () => {
      const { encryptTempPassword } = await import('../src/lib/tempPassword.js');
      const legacy = async (employeeId, plain) => sql.run(
        `UPDATE employees SET must_change_password = TRUE, temp_password_encrypted = :enc WHERE employee_id = :id`,
        { id: employeeId, enc: encryptTempPassword(plain, employeeId) },
      );
      const fin = await post('/api/employees', { first_name: 'Temp', last_name: 'Finance', position: 'finance' }, MANAGER, 201);
      assert.equal(fin.temp_password, undefined, 'บัญชีใหม่ใช้รหัสเริ่มต้น ไม่ออกรหัสชั่วคราว');
      await legacy(fin.employee_id, 'Legacy-fin-1');
      assert.equal((await get(`/api/employees/${fin.employee_id}`, HR)).body.temp_password, undefined);
      assert.equal((await get(`/api/employees/${fin.employee_id}`, HC)).body.temp_password, undefined);
      assert.equal((await get(`/api/employees/${fin.employee_id}`, MANAGER)).body.temp_password, 'Legacy-fin-1');
      // บัญชีทั่วไป HR ยังเห็นเหมือนเดิม (ไว้บอกพนักงานใหม่)
      const cg = await post('/api/employees', { first_name: 'Temp', last_name: 'Carer', position: 'caregiver' }, MANAGER, 201);
      await legacy(cg.employee_id, 'Legacy-cg-1');
      assert.equal((await get(`/api/employees/${cg.employee_id}`, HR)).body.temp_password, 'Legacy-cg-1');
    });

    test('ประวัติเคส: เหตุการณ์ที่มียอดค่าจ้าง ซ่อนจากคนที่ไม่มีสิทธิ์ดูค่าจ้าง', async () => {
      const c = await newCase();
      await sql.run(`INSERT INTO case_events (case_id, event, detail) VALUES (:id, 'pay_released', 'งวดที่ 1 — 7,000 บาท')`, { id: c.case_id });
      assert.ok((await get(`/api/cases/${c.case_id}/events`, MANAGER)).body.some((e) => e.event === 'pay_released'));
      const hr = (await get(`/api/cases/${c.case_id}/events`, HR)).body;
      assert.ok(Array.isArray(hr) && hr.length > 0);
      assert.ok(!hr.some((e) => e.event === 'pay_released'));
    });

    test('HR แต่งตั้งตำแหน่งการเงินไม่ได้ (เป็นการเลื่อนสิทธิ์เรื่องเงิน) — ผู้จัดการทำได้', async () => {
      const denied = await post('/api/employees', { first_name: 'Fin', last_name: 'Ance', position: 'finance' }, HR, 403);
      assert.match(denied.error, /การเงิน/);
      await post('/api/employees', { first_name: 'Fin', last_name: 'Ance', position: 'finance' }, MANAGER, 201);
    });
  });

  describe('รหัสพนักงาน A', () => {
    test('ออกอัตโนมัติ · กรอกเองได้ · ตรวจซ้ำ · เปลี่ยนรหัสเดิมแล้วข้อมูลที่ผูกตามไป', async () => {
      const patch = async (path, body, who = MANAGER) => {
        const res = await fetch(`${base}${path}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };

      const auto = await post('/api/employees', { first_name: 'Auto', last_name: 'Code', position: 'caregiver' }, MANAGER, 201);
      assert.match(auto.employee_id, /^A\d{2}01\d{3}$/);

      const manual = await post('/api/employees', { employee_id: 'A6905123', first_name: 'Manual', last_name: 'Code', position: 'caregiver' }, MANAGER, 201);
      assert.equal(manual.employee_id, 'A6905123');
      const dup = await post('/api/employees', { employee_id: 'A6905123', first_name: 'Dup', last_name: 'Code', position: 'caregiver' }, MANAGER, 409);
      assert.match(dup.error, /มีอยู่แล้ว/);
      await post('/api/employees', { employee_id: 'B6905123', first_name: 'Bad', last_name: 'Code', position: 'caregiver' }, MANAGER, 400);

      // ตรวจระหว่างพิมพ์
      assert.deepEqual((await get('/api/employees/check-id?id=A6905123', MANAGER)).body, { valid: true, available: false, taken_by: 'Manual Code' });
      assert.equal((await get('/api/employees/check-id?id=A6905123&except=A6905123', MANAGER)).body.available, true);
      assert.equal((await get('/api/employees/check-id?id=A6909999', MANAGER)).body.available, true);
      assert.equal((await get('/api/employees/check-id?id=EMP-1', MANAGER)).body.valid, false);

      // เปลี่ยนรหัสเดิม (EMP-0003 มีเคสและกะผูกอยู่ใน fixture) — เคสตามไปเอง · รหัสผ่านชั่วคราวยังเปิดดูได้
      const renamed = await patch('/api/employees/EMP-0003', { employee_id: 'A6800003' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.employee_id, 'A6800003');
      const fixtureCase = (await get('/api/cases/CASE-FIXTURE', MANAGER)).body;
      assert.equal(fixtureCase.assigned_to, 'A6800003');
      assert.equal((await get('/api/employees/EMP-0003', MANAGER)).status, 404);

      const fresh = await post('/api/employees', { first_name: 'Temp', last_name: 'Pass', position: 'caregiver' }, MANAGER, 201);
      await patch(`/api/employees/${fresh.employee_id}`, { employee_id: 'A6800777' });
      assert.equal((await get('/api/employees/A6800777', MANAGER)).body.temp_password, fresh.temp_password,
        'รหัสผ่านชั่วคราวต้องถูกเข้ารหัสใหม่ตามรหัสพนักงานใหม่');

      // เปลี่ยนรหัสของตัวเองไม่ได้ · ชนรหัสคนอื่นไม่ได้
      assert.equal((await patch('/api/employees/EMP-0001', { employee_id: 'A6800001' })).status, 403);
      assert.equal((await patch('/api/employees/A6800003', { employee_id: 'A6905123' })).status, 409);
      // กลับเป็นรหัสเดิมให้เทสอื่นที่อ้าง EMP-0003 ใช้ได้ต่อ
      await sql.run(`UPDATE employees SET employee_id = 'EMP-0003' WHERE employee_id = 'A6800003'`);
    });
  });

  describe('Authentication fixture states', () => {
    test('legacy temporary password is visible only to office roles and erased after password change', async () => {
      const { encryptTempPassword } = await import('../src/lib/tempPassword.js');
      const { DEFAULT_PASSWORD } = await import('../src/lib/auth.js');
      const created = await post('/api/employees', { first_name: 'Temporary', last_name: 'Employee', position: 'caregiver' }, MANAGER, 201);
      const id = created.employee_id;
      // บัญชีใหม่: รหัสเริ่มต้น ไม่มีรหัสชั่วคราว/สำเนาเข้ารหัส (da606a5 · 2 พ.ย. 2569)
      assert.equal(created.temp_password, undefined);
      assert.equal((await sql.one('SELECT temp_password_encrypted FROM employees WHERE employee_id = :id', { id })).temp_password_encrypted, null);
      await post('/api/auth/login', { email: id, password: DEFAULT_PASSWORD });
      // แถวเก่าที่ยังค้างรหัสชั่วคราว — ด่านการมองเห็นยังต้องถูกต้อง
      created.temp_password = 'Legacy-temp-1';
      await sql.run(`UPDATE employees SET must_change_password = TRUE, temp_password_encrypted = :enc WHERE employee_id = :id`,
        { id, enc: encryptTempPassword(created.temp_password, id) });
      for (const who of [MANAGER, HR]) {
        const detail = await get(`/api/employees/${id}`, who);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.temp_password, created.temp_password);
        assert.equal('temp_password_encrypted' in detail.body, false);
      }
      await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, must_change_password)
                     VALUES ('EMP-9000', 'Test', 'Admin', 'admin', FALSE)`);
      const admin = emp('EMP-9000', 'admin');
      assert.equal((await get(`/api/employees/${id}`, admin)).body.temp_password, created.temp_password);
      assert.equal((await get(`/api/employees/${id}`, FIELD)).status, 403);
      const list = (await get('/api/employees', MANAGER)).body;
      assert.ok(list.data.every((row) => !('temp_password' in row) && !('temp_password_encrypted' in row)));
      // รหัสในฐานคือรหัสเริ่มต้น (สำเนาเข้ารหัสข้างบนเป็นแถวจำลอง) — เปลี่ยนรหัสแล้วสำเนาต้องถูกลบ
      await post('/api/auth/change-password', {
        current_password: DEFAULT_PASSWORD, new_password: 'Changed-password-456!',
      }, emp(id, 'caregiver'));
      const detail = (await get(`/api/employees/${id}`, MANAGER)).body;
      assert.equal(detail.must_change_password, false);
      assert.equal('temp_password' in detail, false);
      assert.equal((await sql.one('SELECT temp_password_encrypted FROM employees WHERE employee_id = :id', { id })).temp_password_encrypted, null);
    });
    // ยกเลิกการบังคับเปลี่ยนรหัสแล้ว (da606a5 · 2 พ.ย. 2569 — requirePasswordChanged ไม่บล็อก) · พักงานยังเข้าไม่ได้
    test('fresh employee is no longer forced to change password; suspended employee cannot access work', async () => {
      const fresh = await get('/api/my/today', emp('EMP-0004', 'caregiver'));
      assert.equal(fresh.status, 200);
      assert.equal((await get('/api/my/today', emp('EMP-0005', 'caregiver'))).status, 401);
    });
    test('login succeeds with fixture credentials, wrong password returns 401', async () => {
      await post('/api/auth/login', { email: 'EMP-0001@example.invalid', password: 'wrong' }, MANAGER, 401);
      const user = await post('/api/auth/login', { email: 'EMP-0001@example.invalid', password: 'Fixture-password-123!' });
      assert.equal(user.employee_id, MANAGER.employee_id);
    });
    // ตั้งแต่ da606a5 (2 พ.ย. 2569) รหัสพนักงานใช้เป็น username ได้ทุกคน แม้มีอีเมลแล้ว
    test('employee ID works as username with or without email; wrong password/unknown ID = 401', async () => {
      const password = 'Fixture-password-123!';
      const original = await sql.one('SELECT email FROM employees WHERE employee_id = :id', { id: FIELD.employee_id });
      try {
        for (const email of [null, '', '   ']) {
          await sql.run('UPDATE employees SET email = :email WHERE employee_id = :id', { email, id: FIELD.employee_id });
          const user = await post('/api/auth/login', { email: ' emp-0003 ', password });
          assert.equal(user.employee_id, FIELD.employee_id);
        }
        await post('/api/auth/login', { email: FIELD.employee_id, password: 'wrong' }, MANAGER, 401);
        await post('/api/auth/login', { email: 'EMP-9999', password }, MANAGER, 401);
        await sql.run('UPDATE employees SET email = :email WHERE employee_id = :id', { email: original.email, id: FIELD.employee_id });
        assert.equal((await post('/api/auth/login', { email: FIELD.employee_id, password })).employee_id, FIELD.employee_id);
        const user = await post('/api/auth/login', { email: original.email, password });
        assert.equal(user.employee_id, FIELD.employee_id);
      } finally {
        await sql.run('UPDATE employees SET email = :email WHERE employee_id = :id', { email: original.email, id: FIELD.employee_id });
      }
    });
  });

  describe('Case lifecycle and payout workflow', () => {
    test('package discounts reduce company income while employee pay stays fixed', async () => {
      const packages = await import('../src/packages/repo.js');
      const physio = await import('../src/physio/repo.js');
      const format = await packages.createFormat({ name: 'Discount test', category: 'daily', graded: false });
      const rate = { format_id: format.format_id, staff_tier: 'CG', customer_price: 2000, staff_pay: 1200 };
      await packages.upsertRates([rate]);
      const p = await physio.createPackage({ name: 'Discount test', sessions: 10, original_price: 18000, special_price: 18000, staff_pay: 12000 });
      for (const discount of [{ discount_percent: 10, discount_amount: null }, { discount_percent: null, discount_amount: 500 }]) {
        const { staff_pay, ...unchangedRate } = rate;
        const matrix = await packages.upsertRates([{ ...unchangedRate, ...discount }]);
        const r = matrix.rates.find((row) => row.format_id === format.format_id);
        const cut = discount.discount_percent ? 200 : 500;
        assert.equal(r.staff_pay, 1200);
        assert.equal(r.net_price, 2000 - cut);
        assert.equal(r.margin, Math.round((800 - cut) / (2000 - cut) * 100));
        const c = await post('/api/cases', { case_type: 'other', client_name: 'Discount patient', fee: r.net_price,
          pkg_format_id: format.format_id, pkg_staff_tier: 'CG' }, HR, 201);
        assert.equal((await casesRepo.findById(c.case_id)).staff_pay, 1200);
        const updated = await physio.updatePackage(p.physio_package_id, discount);
        const physioCut = discount.discount_percent ? 1800 : 500;
        assert.equal(updated.staff_pay, 12000);
        assert.equal(updated.special_price, 18000 - physioCut);
        assert.equal(updated.margin, Math.round((6000 - physioCut) / (18000 - physioCut) * 100));
        const pc = await post('/api/cases', { case_type: 'other', client_name: 'Physio discount patient', service_kind: 'physio',
          physio_package_id: p.physio_package_id, fee: updated.special_price }, HR, 201);
        assert.equal((await casesRepo.findById(pc.case_id)).staff_pay, 12000);
      }
    });
    test('create → assign → start → close → reopen; invalid transitions return 409', async () => {
      const c = await newCase();
      assert.equal(c.status, 'unassigned');
      await post(`/api/cases/${c.case_id}/start`, {}, MANAGER, 409);
      assert.equal((await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id })).status, 'assigned');
      assert.equal((await post(`/api/cases/${c.case_id}/start`, {})).status, 'in_progress');
      assert.equal((await post(`/api/cases/${c.case_id}/close`, {})).status, 'closed');
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id }, MANAGER, 409);
      await post(`/api/cases/${c.case_id}/start`, {}, MANAGER, 409);
      assert.equal((await post(`/api/cases/${c.case_id}/reopen`, {})).status, 'assigned');
      assert.equal((await post(`/api/cases/${c.case_id}/cancel`, { reason: 'Fixture cancellation' })).status, 'cancelled');
    });

    test('changing package: history keeps old → new, split invoices get flagged, closed cases are locked', async () => {
      const patchCase = async (id, body, expected = 200) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, expected, JSON.stringify(data));
        return data;
      };
      const pkg = async (name, price) => (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES (:name, 10, :price, 500) RETURNING physio_package_id`, { name, price })).physio_package_id;
      const oldPkg = await pkg('Pack old', 5000);
      const newPkg = await pkg('Pack new', 8000);

      const c = await post('/api/cases', { case_type: 'other', client_name: 'Package switch', service_kind: 'physio',
        physio_package_id: oldPkg, fee: 5000 }, MANAGER, 201);
      const draft = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data[0];
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 1000 });

      await patchCase(c.case_id, { service_kind: 'physio', physio_package_id: newPkg, fee: 8000 });

      const events = (await get(`/api/cases/${c.case_id}/events`, MANAGER)).body;
      const edited = events.find((e) => e.event === 'edited');
      assert.match(edited.detail, /Pack old \(10 ครั้ง\) → Pack new \(10 ครั้ง\)/);
      assert.match(edited.detail, /5,000 บาท → 8,000 บาท/);
      assert.doesNotMatch(edited.detail, /500/, 'staff pay figures must not leak into history HR can read');

      const invoices = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
      assert.equal(invoices.length, 2);
      assert.ok(invoices.every((v) => v.service_stale && v.is_stale), 'deposit and balance must both be flagged');
      const flagged = (await get(`/api/invoices?case_id=${c.case_id}&stale=yes`, MANAGER)).body.data;
      assert.equal(flagged.length, 2, 'SQL stale filter must agree with the row flag');

      const ack = await post(`/api/invoices/${invoices[0].invoice_id}/acknowledge-service`, {});
      assert.equal(ack.service_stale, false);

      await sql.run(`UPDATE cases SET status = 'closed' WHERE case_id = :id`, { id: c.case_id });
      await patchCase(c.case_id, { service_kind: 'physio', physio_package_id: oldPkg }, 409);
      await patchCase(c.case_id, { service_kind: 'physio', physio_package_id: newPkg, note: 'still editable' });
    });

    test('เลขใบแจ้งหนี้ HC-IV: รันต่อในวันเดียวกัน · รายการเรียงใบใหม่ขึ้นก่อนแม้มีเลขแบบเก่า INV ปน', async () => {
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const [y, m, d] = today.split('-');
      const day = `${String((Number(y) + 543) % 100).padStart(2, '0')}${m}${d}`;

      const a = await newCase();
      const b = await newCase();
      const [invA] = (await get(`/api/invoices?case_id=${a.case_id}`, MANAGER)).body.data;
      const [invB] = (await get(`/api/invoices?case_id=${b.case_id}`, MANAGER)).body.data;
      assert.match(invA.invoice_id, new RegExp(`^HC-IV${day}\\d{4}$`));
      assert.equal(Number(invB.invoice_id.slice(-4)), Number(invA.invoice_id.slice(-4)) + 1, 'ใบถัดไปของวันเดียวกันรัน +1');

      // ใบเก่าแบบ INV ที่ออกก่อนหน้า ต้องอยู่ใต้ใบใหม่เมื่อเรียงเลขที่ใบจากใหม่ไปเก่า
      await sql.run(`INSERT INTO invoices (invoice_id, issue_date, bill_to_name, service_description, created_at)
                     VALUES ('INV-0999', '2026-01-01', 'old', 'old', '2026-01-01 09:00:00')`);
      const ids = (await get('/api/invoices?sort=invoice_id&order=desc&per_page=100', MANAGER)).body.data.map((v) => v.invoice_id);
      assert.ok(ids.indexOf(invB.invoice_id) < ids.indexOf('INV-0999'));
      assert.ok(ids.indexOf(invB.invoice_id) < ids.indexOf(invA.invoice_id));
    });

    test('ไม่มีช่องประเภทเคสแล้ว: ระบบตั้งตามประเภทบริการ (เลือกแบบบันทึกถูก) · สรุปแยกตามบริการ', async () => {
      const patchCase = async (id, body) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        return res.json();
      };
      const physioPkg = (await sql.one('SELECT physio_package_id FROM physio_packages LIMIT 1')).physio_package_id;

      const home = await post('/api/cases', { client_name: 'No type homecare', service_kind: 'homecare' }, MANAGER, 201);
      assert.equal(home.case_type, 'elderly_care', 'Homecare = แบบบันทึกประจำวัน');
      const none = await post('/api/cases', { client_name: 'No service' }, MANAGER, 201);
      assert.equal(none.case_type, 'elderly_care');
      const physio = await post('/api/cases', { client_name: 'No type physio', service_kind: 'physio', physio_package_id: physioPkg }, MANAGER, 201);
      assert.equal(physio.case_type, 'physiotherapy', 'กายภาพ = แบบบันทึกกายภาพ');

      // สลับสายบริการ → ประเภทเคสตาม · ไม่ขึ้นในประวัติว่าแก้ประเภทเคส (ช่องนี้ไม่มีในหน้าเว็บ)
      const switched = await patchCase(home.case_id, { service_kind: 'physio', physio_package_id: physioPkg });
      assert.equal(switched.case_type, 'physiotherapy');
      const edited = (await get(`/api/cases/${home.case_id}/events`, MANAGER)).body.find((e) => e.event === 'edited');
      assert.doesNotMatch(edited.detail, /ประเภทเคส/);
      assert.equal((await patchCase(home.case_id, { service_kind: 'homecare' })).case_type, 'elderly_care');

      // เคสเก่าที่ตั้งประเภทพิเศษไว้ แก้ช่องอื่นแล้วประเภทเดิมต้องไม่หาย
      await sql.run(`UPDATE cases SET case_type = 'wound_care' WHERE case_id = :id`, { id: none.case_id });
      assert.equal((await patchCase(none.case_id, { note: 'แก้หมายเหตุ' })).case_type, 'wound_care');

      const summary = (await get('/api/cases/summary', MANAGER)).body;
      assert.ok(Array.isArray(summary.by_service));
      assert.ok(summary.by_service.every((r) => ['homecare', 'physio'].includes(r.service_kind)));
      assert.equal(summary.by_service.reduce((n, r) => n + r.count, 0), summary.total);
    });

    test('ตัวกรองประเภทบริการในรายการเคส นับตรงกับสรุปหน้าภาพรวม', async () => {
      const ids = async (kind) => (await get(`/api/cases?service_kind=${kind}&per_page=100`, MANAGER)).body;
      const physio = await ids('physio');
      const homecare = await ids('homecare');
      const all = (await get('/api/cases?per_page=100', MANAGER)).body;
      assert.equal(physio.pagination.total + homecare.pagination.total, all.pagination.total, 'สองกลุ่มรวมกันต้องครบทุกเคส ไม่มีเคสหลุด (รวมเคสที่ยังไม่ระบุบริการ)');
      assert.ok(physio.data.every((c) => c.service_kind === 'physio' || c.physio_package_id != null || c.case_type === 'physiotherapy'));
      const summary = (await get('/api/cases/summary', MANAGER)).body;
      const count = (k) => summary.by_service.find((r) => r.service_kind === k)?.count ?? 0;
      assert.equal(physio.pagination.total, count('physio'));
      assert.equal(homecare.pagination.total, count('homecare'));
      assert.equal((await get('/api/cases?service_kind=other', MANAGER)).status, 400);
    });

    test('รหัสเคส = รหัสผู้รับบริการ (KN): เคสแรกได้ KN · เคสถัดไป -R2 · ผูกแฟ้มแล้วเคสเดิมเปลี่ยนรหัสตาม', async () => {
      const patch = async (path, body) => {
        const res = await fetch(`${base}${path}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };
      await post('/api/patients', { patient_id: 'KN690215209', name: 'รหัสเคส KN' }, MANAGER, 201);

      // เปิดเคสให้ผู้รับบริการ = รหัสเคสคือ KN ของคนนั้น · case_id ที่ส่งมาเองไม่ถูกใช้
      const first = await post('/api/cases', { case_id: 'VN690000009', patient_id: 'KN690215209', client_name: 'รหัสเคส KN', fee: 1000 }, MANAGER, 201);
      assert.equal(first.case_id, 'KN690215209');
      const second = await post('/api/cases', { patient_id: 'KN690215209', client_name: 'รหัสเคส KN', fee: 1000 }, MANAGER, 201);
      assert.equal(second.case_id, 'KN690215209-R2');
      // ยังไม่มีแฟ้มผู้รับบริการ (รู้แค่ชื่อ) = รหัสชั่วคราว CASE-xxxx
      const loose = await post('/api/cases', { client_name: 'ยังไม่มีแฟ้ม', fee: 1000 }, MANAGER, 201);
      assert.match(loose.case_id, /^CASE-\d{4}$/);

      // เคสเก่า CASE-FIXTURE (มีกะและใบแจ้งหนี้ผูกอยู่) ผูกแฟ้ม KN แล้วรหัสเคสเปลี่ยนตาม ทุกอย่างตามไป
      await post('/api/invoices', { case_id: 'CASE-FIXTURE' }, MANAGER, 201).catch(() => {});
      const before = (await get('/api/invoices?case_id=CASE-FIXTURE', MANAGER)).body.pagination.total;
      const { patient_id: originalPatient } = (await get('/api/cases/CASE-FIXTURE', MANAGER)).body;
      const linked = await patch('/api/cases/CASE-FIXTURE', { patient_id: 'KN690215209' });
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      assert.equal(linked.body.case_id, 'KN690215209-R3');
      assert.equal((await get('/api/cases/CASE-FIXTURE', MANAGER)).status, 404);
      assert.ok((await get('/api/cases/KN690215209-R3/visits', MANAGER)).body.length >= 1, 'กะตามไป');
      assert.equal((await get('/api/invoices?case_id=KN690215209-R3', MANAGER)).body.pagination.total, before, 'ใบแจ้งหนี้ตามไป');
      const events = (await get('/api/cases/KN690215209-R3/events', MANAGER)).body;
      assert.ok(events.some((e) => /เปลี่ยนรหัสเคส CASE-FIXTURE → KN690215209/.test(e.detail)));

      // เปลี่ยนรหัสผู้รับบริการ = รหัสเคสทุกใบของคนนั้นเปลี่ยนตาม (คง -R เดิม)
      const renamed = await patch('/api/patients/KN690215209', { patient_id: 'KN690215210' });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal((await get('/api/cases/KN690215210', MANAGER)).status, 200);
      assert.equal((await get('/api/cases/KN690215210-R2', MANAGER)).status, 200);
      assert.equal((await get('/api/cases/KN690215209', MANAGER)).status, 404);

      // คืนสภาพให้เทสอื่นที่อ้าง CASE-FIXTURE
      await sql.run(`UPDATE cases SET case_id = 'CASE-FIXTURE', patient_id = :p WHERE case_id = 'KN690215210-R3'`, { p: originalPatient ?? null });
    });

    test('เลข VN: กายภาพหนึ่งนัดหนึ่ง VN · Homecare หนึ่งเคสหนึ่ง VN · หัตถการได้ VN แยกและบวกเข้าใบแจ้งหนี้', async () => {
      const patchCase = async (id, body) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, 200, JSON.stringify(data));
        return data;
      };
      const VN = /^VN\d{9}$/;

      // Homecare: ลงนัดกี่กะก็ได้ VN ของเคสแค่เลขเดียว (ออกตอนลงนัดครั้งแรก) กะไม่มี VN ของตัวเอง
      const home = await post('/api/cases', { case_type: 'other', client_name: 'VN Homecare', fee: 9000 }, MANAGER, 201);
      assert.equal(home.vn, null, 'ยังไม่ลงนัด = ยังไม่ออก VN');
      await post(`/api/cases/${home.case_id}/visits/bulk`, { dates: ['2026-11-02', '2026-11-03', '2026-11-04'] }, MANAGER, 201);
      const homeVn = (await get(`/api/cases/${home.case_id}`, MANAGER)).body.vn;
      assert.match(homeVn, VN);
      await post(`/api/cases/${home.case_id}/visits`, { visit_date: '2026-11-05' }, MANAGER, 201);
      assert.equal((await get(`/api/cases/${home.case_id}`, MANAGER)).body.vn, homeVn, 'ลงนัดเพิ่มแล้ว VN เคสเดิม');
      assert.ok((await get(`/api/cases/${home.case_id}/visits`, MANAGER)).body.every((v) => v.vn == null));

      // กายภาพ: ทุกนัดได้ VN ของตัวเอง ไม่ซ้ำกัน · เคสไม่มี VN
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('VN pack', 10, 5000, 500) RETURNING physio_package_id`)).physio_package_id;
      const physio = await post('/api/cases', { case_type: 'other', client_name: 'VN Physio', service_kind: 'physio',
        physio_package_id: pkgId, fee: 5000 }, MANAGER, 201);
      await post(`/api/cases/${physio.case_id}/visits/bulk`, { dates: ['2026-11-02', '2026-11-09'] }, MANAGER, 201);
      await post(`/api/cases/${physio.case_id}/visits`, { visit_date: '2026-11-16' }, MANAGER, 201);
      const vns = (await get(`/api/cases/${physio.case_id}/visits`, MANAGER)).body.map((v) => v.vn);
      assert.equal(vns.length, 3);
      assert.ok(vns.every((v) => VN.test(v)), JSON.stringify(vns));
      assert.equal(new Set([...vns, homeVn]).size, 4, 'VN ไม่ซ้ำกันทั้งระบบ');
      assert.equal((await get(`/api/cases/${physio.case_id}`, MANAGER)).body.vn, null);

      // หัตถการ: บันทึกแล้วได้ VN แยกรายการละเลข · ยอดบวกเข้าใบร่าง · บันทึกซ้ำคง VN เดิม
      const withProc = await patchCase(home.case_id, {
        addons: [
          { name: 'เตียงลม', quantity: 1, unit_price: 3500 },
          { kind: 'procedure', name: 'ทำแผล', quantity: 1, unit_price: 800 },
          { kind: 'procedure', name: 'เปลี่ยนสาย NG', quantity: 1, unit_price: 1200, vn: 'VN690000001' },
        ],
      });
      const procs = withProc.addons.filter((a) => a.kind === 'procedure');
      assert.equal(procs.length, 2);
      assert.ok(procs.every((a) => VN.test(a.vn)));
      assert.notEqual(procs[0].vn, procs[1].vn);
      assert.ok(!procs.some((a) => a.vn === 'VN690000001'), 'เลขที่ไม่ใช่ของเคสนี้ไม่ถูกใช้');
      assert.ok(![...vns, homeVn].some((v) => procs.some((a) => a.vn === v)));
      assert.equal(withProc.addons[0].vn, undefined, 'อุปกรณ์เสริมคงรูปเดิม ไม่มี VN');

      const again = await patchCase(home.case_id, { addons: withProc.addons, note: 'บันทึกซ้ำ' });
      assert.deepEqual(again.addons.map((a) => a.vn), withProc.addons.map((a) => a.vn));

      const draft = (await get(`/api/invoices?case_id=${home.case_id}`, MANAGER)).body.data[0];
      assert.equal(Number(draft.amount), 9000 + 3500 + 800 + 1200, 'ใบร่างซิงก์ยอดหัตถการ');
      assert.equal(draft.is_stale, false);
      assert.deepEqual(draft.addons.filter((a) => a.kind === 'procedure').map((a) => a.vn), procs.map((a) => a.vn));
    });

    test('สถานะตามวันที่: รอเริ่ม · กำลังให้บริการ · รอยืนยันปิดเคส (กรองในรายการเคสได้)', async () => {
      const day = (offset) => new Date(Date.now() + 7 * 3.6e6 + offset * 86_400_000).toISOString().slice(0, 10);
      const make = async (label, start, end, status = 'assigned') => {
        const c = await post('/api/cases', { case_type: 'other', client_name: label, start_date: start, end_date: end }, MANAGER, 201);
        await sql.run(`UPDATE cases SET status = :status, assigned_to = 'EMP-0003' WHERE case_id = :id`, { status, id: c.case_id });
        return c.case_id;
      };
      const future = await make('สถานะ รอเริ่ม', day(3), day(30));
      const noStart = await make('สถานะ ไม่มีวันเริ่ม', null, null);
      const running = await make('สถานะ กำลังให้บริการ', day(-3), day(10));
      const endsToday = await make('สถานะ ครบวันนี้', day(-30), day(0));
      const overdue = await make('สถานะ เลยกำหนด', day(-30), day(-2), 'in_progress');
      const checkedIn = await make('สถานะ เช็คอินแล้ว ไม่มีวันเริ่ม', null, null, 'in_progress');

      const ids = async (status) =>
        (await get(`/api/cases?status=${status}&q=${encodeURIComponent('สถานะ')}&per_page=100`, MANAGER)).body.data.map((c) => c.case_id).sort();
      assert.deepEqual(await ids('pending_start'), [future, noStart].sort());
      assert.deepEqual(await ids('active'), [running, checkedIn].sort());
      assert.deepEqual(await ids('awaiting_close'), [endsToday, overdue].sort());
      // สถานะใน DB ยังกรองได้ตามเดิม
      assert.ok((await ids('in_progress')).includes(overdue));
      assert.equal((await get('/api/cases?status=bogus', MANAGER)).status, 400);
    });

    test('ยกเลิกเคส: ใบร่างถูกยกเลิกตาม · ใบของเคสที่ยกเลิกแล้วออกใบไม่ได้', async () => {
      const c = await newCase();
      const draft = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data[0];
      assert.equal(draft.status, 'draft');
      await post(`/api/cases/${c.case_id}/cancel`, { reason: 'ลูกค้ายกเลิก' });
      assert.equal((await get(`/api/invoices/${draft.invoice_id}`, MANAGER)).body.status, 'cancelled');
      const events = (await get(`/api/cases/${c.case_id}/events`, MANAGER)).body;
      assert.ok(events.some((e) => /ยกเลิกใบแจ้งหนี้ร่าง 1 ใบ/.test(e.detail)));

      // ใบร่างที่หลุดรอด (เช่น ข้อมูลก่อนมีการยกเลิกตาม) — ด่านออกใบต้องกันไว้อีกชั้น
      const c2 = await newCase();
      const d2 = (await get(`/api/invoices?case_id=${c2.case_id}`, MANAGER)).body.data[0];
      await post(`/api/invoices/${d2.invoice_id}/billing-plan`, { mode: 'full' });
      await sql.run(`UPDATE cases SET status = 'cancelled' WHERE case_id = :id`, { id: c2.case_id });
      const issued = await post(`/api/invoices/${d2.invoice_id}/issue`, {}, MANAGER, 409);
      assert.match(issued.error, /ถูกยกเลิกแล้ว/);
    });

    test('รายการในใบ: ไม่ซ้ำชื่อผู้รับบริการเมื่อหัวรายการเป็นชื่อผู้รับบริการอยู่แล้ว', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Grandpa Later', title: 'Grandpa Later', fee: 1000, staff_pay: 500 }, MANAGER, 201);
      const inv = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data[0];
      const full = (await get(`/api/invoices/${inv.invoice_id}`, MANAGER)).body;
      assert.ok(!/Grandpa Later.*ผู้รับบริการ: Grandpa Later/.test(full.service_description), full.service_description);
    });

    test('deleted invoice: case shows up as missing an invoice and can be reissued', async () => {
      const c = await newCase();
      const draft = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data[0];
      const missingIds = async () =>
        (await get('/api/invoices/cases-without-invoice', MANAGER)).body.map((r) => r.case_id);
      assert.ok(!(await missingIds()).includes(c.case_id));

      const res = await fetch(`${base}/api/invoices/${draft.invoice_id}`, {
        method: 'DELETE', headers: { cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
      });
      assert.equal(res.status, 200);
      assert.ok((await missingIds()).includes(c.case_id));

      const created = await post('/api/invoices', { case_id: c.case_id }, MANAGER, 201);
      assert.equal(created.total, 2000);
      assert.ok(!(await missingIds()).includes(c.case_id));
      // กดซ้ำ = server ส่งรหัสใบร่างเดิมกลับมาให้หน้าเว็บเปิดแทน
      const dup = await post('/api/invoices', { case_id: c.case_id }, MANAGER, 409);
      assert.equal(dup.details.existing_invoice_id, created.invoice_id);
    });

    test('จับคู่เคส/เพิ่มทีม/ลงกะได้เฉพาะสายดูแลและสายบำบัด — สายสำนักงานถูกปฏิเสธ', async () => {
      const list = (await get('/api/cases/assignable-employees', MANAGER)).body;
      const office = list.find((e) => ['manager', 'hr', 'admin'].includes(e.position));
      const field = list.find((e) => e.employee_id === FIELD.employee_id);
      assert.ok(office, 'fixture ต้องมีพนักงานสายสำนักงานที่ยังทำงานอยู่');
      assert.equal(office.can_take_cases, false, 'ยังคืนสายสำนักงานมา (ใช้เป็นตัวกรองย้อนหลัง) แต่ติดธงว่าจับคู่ไม่ได้');
      assert.equal(field.can_take_cases, true);

      const c = await newCase();
      const assign = await post(`/api/cases/${c.case_id}/assign`, { employee_id: office.employee_id }, MANAGER, 409);
      assert.match(assign.error, /สายสำนักงาน/);
      await post(`/api/cases/${c.case_id}/team`, { employee_id: office.employee_id }, MANAGER, 409);
      await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: ['2026-03-01'], assigned_to: office.employee_id }, MANAGER, 409);
      await post('/api/cases', { case_type: 'other', client_name: 'x', assigned_to: office.employee_id }, MANAGER, 409);

      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
    });

    test('ต่อเคส: รอบใหม่เป็นเคสใหม่ ผูกกับรอบก่อน ทีมตามมา ใบแจ้งหนี้แยก และต่อซ้ำไม่ได้', async () => {
      const patchCase = async (id, body) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        return res.json();
      };
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const inDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

      const first = await post('/api/cases', {
        case_type: 'other', client_name: 'Renew patient', fee: 30000, start_date: inDays(-25), end_date: inDays(3),
        assigned_to: FIELD.employee_id,
      }, MANAGER, 201);
      assert.equal(first.round_no, 1);
      await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
                     VALUES ('EMP-0081', 'Team', 'Mate', 'caregiver', 'emp-0081@example.invalid', 'active', 'x', false)`);
      await post(`/api/cases/${first.case_id}/team`, { employee_id: 'EMP-0081' });

      // ใกล้ครบภายใน 7 วันและยังไม่ต่อ = ขึ้นกระดิ่ง + ตัวกรอง (เกณฑ์เดียวกัน)
      const soonIds = async () => (await get('/api/cases?ending_soon=yes&per_page=100', MANAGER)).body.data.map((c) => c.case_id);
      assert.ok((await soonIds()).includes(first.case_id));
      const before = (await get('/api/notify/alerts', MANAGER)).body.groups.cases.ending_soon;
      assert.ok(before >= 1);

      const second = await post('/api/cases', {
        case_type: 'other', client_name: 'Renew patient', fee: 32000, start_date: inDays(4), end_date: inDays(32),
        assigned_to: FIELD.employee_id, renewed_from: first.case_id,
      }, MANAGER, 201);
      assert.equal(second.round_no, 2);
      assert.equal(second.renewed_from, first.case_id);
      assert.equal(second.team_count, 1, 'ทีมดูแลรอบก่อนตามมา (ไม่รวมคนหลักซ้ำ)');

      const firstNow = (await get(`/api/cases/${first.case_id}`, MANAGER)).body;
      assert.equal(firstNow.renewed_to, second.case_id);
      assert.ok(!(await soonIds()).includes(first.case_id), 'ต่อแล้วต้องหลุดจากรายการใกล้ครบ');
      assert.equal((await get('/api/notify/alerts', MANAGER)).body.groups.cases.ending_soon, before - 1);

      // ใบแจ้งหนี้แยกรอบ — รอบใหม่ได้ใบร่างของตัวเอง ยอดตามราคารอบใหม่
      const [inv] = (await get(`/api/invoices?case_id=${second.case_id}`, MANAGER)).body.data;
      assert.equal(inv.total, 32000);

      const events = (await get(`/api/cases/${first.case_id}/events`, MANAGER)).body;
      assert.ok(events.some((e) => e.event === 'renewed' && e.detail.includes(second.case_id)));

      // ต่อซ้ำไม่ได้ — บอกรหัสรอบที่มีอยู่แล้วกลับไป
      const dup = await post('/api/cases', { case_type: 'other', client_name: 'x', renewed_from: first.case_id }, MANAGER, 409);
      assert.equal(dup.details.existing_case_id, second.case_id);

      // แก้เคสส่ง renewed_from มาก็ไม่มีผล (ตั้งได้ตอนสร้างเท่านั้น)
      const patched = await patchCase(second.case_id, { renewed_from: null, note: 'x' });
      assert.equal(patched.renewed_from, first.case_id);

      // ยกเลิกรอบใหม่แล้ว ต่อใหม่ได้ · เคสที่ยกเลิกเองต่อไม่ได้
      await post(`/api/cases/${second.case_id}/cancel`, { reason: 'ลูกค้าเปลี่ยนใจ' });
      const third = await post('/api/cases', { case_type: 'other', client_name: 'x', renewed_from: first.case_id }, MANAGER, 201);
      assert.equal(third.round_no, 2);
      await post('/api/cases', { case_type: 'other', client_name: 'x', renewed_from: second.case_id }, MANAGER, 409);
    });

    test('แพ็กกายภาพเสริม: เคส Homecare ซื้อแพ็กกายภาพเพิ่ม = เคสกายภาพแยกที่ผูก addon_of · ใบแจ้งหนี้แยก · ตรวจสาย/ผู้รับบริการ', async () => {
      const patchCase = async (id, body, expected = 200) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, expected, JSON.stringify(data));
        return data;
      };
      await post('/api/patients', { patient_id: 'KN690300001', name: 'แพ็กเสริม' }, MANAGER, 201);
      await post('/api/patients', { patient_id: 'KN690300002', name: 'คนอื่น' }, MANAGER, 201);
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('Addon pack', 10, 9000, 600) RETURNING physio_package_id`,
      )).physio_package_id;
      const me = { patient_id: 'KN690300001', client_name: 'แพ็กเสริม' };
      const home = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 30000 }, MANAGER, 201);
      const addonBody = { ...me, physio_package_id: pkgId, fee: 9000, addon_of: home.case_id };

      // ต้องเลือกแพ็กกายภาพ · ผู้รับบริการคนเดียวกัน · ทำคู่กับต่อเคสไม่ได้
      await post('/api/cases', { ...me, service_kind: 'homecare', addon_of: home.case_id }, MANAGER, 400);
      await post('/api/cases', { ...addonBody, patient_id: 'KN690300002', client_name: 'คนอื่น' }, MANAGER, 400);
      await post('/api/cases', { ...addonBody, renewed_from: home.case_id }, MANAGER, 400);

      const addon = await post('/api/cases', addonBody, MANAGER, 201);
      assert.equal(addon.addon_of, home.case_id);
      assert.equal(addon.service_kind, 'physio', 'ส่งมาแค่แพ็คเกจ ก็เป็นเคสกายภาพ');
      assert.equal(addon.case_type, 'physiotherapy', 'พนักงานได้แบบบันทึกกายภาพ');
      assert.equal(addon.case_id, 'KN690300001-R2');

      // เคส Homecare ไม่ถูกนับว่า "ต่อเคสแล้ว" และบริการไม่เปลี่ยน
      const homeNow = (await get(`/api/cases/${home.case_id}`, MANAGER)).body;
      assert.equal(homeNow.renewed_to, null);
      assert.equal(homeNow.service_kind, 'homecare');
      const list = (await get(`/api/cases/${home.case_id}/physio-addons`, MANAGER)).body;
      assert.deepEqual(list.map((a) => [a.case_id, a.physio_package_name, a.physio_sessions, a.booked]),
        [[addon.case_id, 'Addon pack', 10, 0]]);

      // ใบแจ้งหนี้ร่างของแพ็กเสริมแยกจากเคส Homecare
      const [inv] = (await get(`/api/invoices?case_id=${addon.case_id}`, MANAGER)).body.data;
      assert.equal(inv.total, 9000);
      const homeEvents = (await get(`/api/cases/${home.case_id}/events`, MANAGER)).body;
      assert.ok(homeEvents.some((e) => e.event === 'physio_addon' && e.detail.includes('Addon pack')));

      // เคสกายภาพเพิ่มแพ็กเสริมไม่ได้ (ซื้อเพิ่ม = ต่อเคส)
      await post('/api/cases', { ...addonBody, addon_of: addon.case_id }, MANAGER, 400);

      // แพ็กเสริม: สลับเป็น Homecare ไม่ได้ · ย้ายไปผู้รับบริการคนอื่นไม่ได้ · addon_of แก้ไม่ได้ · เปลี่ยนแพ็กได้
      await patchCase(addon.case_id, { service_kind: 'homecare' }, 409);
      await patchCase(addon.case_id, { patient_id: 'KN690300002' }, 400);
      const kept = await patchCase(addon.case_id, { addon_of: null, note: 'x' });
      assert.equal(kept.addon_of, home.case_id);

      // ต่อรอบแพ็กเสริม = รอบใหม่ยังผูกเคส Homecare เดิม
      const round2 = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 9000, renewed_from: addon.case_id }, MANAGER, 201);
      assert.equal(round2.addon_of, home.case_id);
      assert.equal(round2.round_no, 2);

      // รายการเคส: แพ็กเสริม (ใบแยกก็ตาม) อยู่ในแถวของเคส Homecare ไม่ขึ้นแถวของตัวเอง (10 พ.ย. 2569)
      const listIds = async (query) =>
        (await get(`/api/cases?q=KN690300001${query}`, MANAGER)).body.data.map((c) => c.case_id).sort();
      const merged = (await get('/api/cases?q=KN690300001', MANAGER)).body;
      assert.deepEqual(merged.data.map((c) => c.case_id), [home.case_id]);
      assert.equal(merged.pagination.total, 1, 'ตัวนับรวมหน้าตรงกับแถวที่เห็น');
      assert.deepEqual(
        merged.data[0].physio_addons.map((a) => [a.case_id, a.name, a.bill_with_parent]),
        [[addon.case_id, 'Addon pack', false], [round2.case_id, 'Addon pack', false]],
      );
      // ตัวกรองที่แถวแม่ไม่ผ่าน (สายกายภาพ) — แพ็กต้องยังขึ้นเป็นแถวของตัวเอง ไม่หายไปพร้อมแม่
      assert.deepEqual(await listIds('&service_kind=physio'), [addon.case_id, round2.case_id].sort());

      // เคส Homecare ยกเลิกแล้ว = เพิ่มไม่ได้ แต่รายการเดิมยังอยู่
      await post(`/api/cases/${home.case_id}/cancel`, { reason: 'ทดสอบ' });
      await post('/api/cases', addonBody, MANAGER, 409);
      assert.equal((await get(`/api/cases/${home.case_id}/physio-addons`, MANAGER)).body.length, 2);
      // แม่ยกเลิกแล้ว แพ็กที่ยังเดินอยู่กลับมาเป็นแถวของตัวเอง
      assert.deepEqual(await listIds(''), [home.case_id, addon.case_id, round2.case_id].sort());
    });

    test('แพ็กกายภาพเสริมรวมใบ: บรรทัดในใบ Homecare · ตามราคา/ยกเลิก · มัดจำหักจาก Homecare · ใบออกแล้ว = แยกใบ', async () => {
      const patchCase = async (id, body) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, 200, JSON.stringify(data));
        return data;
      };
      const invoicesOf = async (id) => (await get(`/api/invoices?case_id=${id}`, MANAGER)).body.data
        .filter((i) => i.status !== 'cancelled');
      await post('/api/patients', { patient_id: 'KN690300011', name: 'รวมใบ' }, MANAGER, 201);
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('10 ครั้ง 3 เดือน', 10, 15000, 600) RETURNING physio_package_id`,
      )).physio_package_id;
      const me = { patient_id: 'KN690300011', client_name: 'รวมใบ' };
      const home = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 45000 }, MANAGER, 201);
      const bundle = (extra) => post('/api/cases', {
        ...me, physio_package_id: pkgId, fee: 15000, addon_of: home.case_id, bill_with_parent: true, ...extra,
      }, MANAGER, 201);

      const physio = await bundle();
      assert.equal(physio.billed_with_parent, true);
      assert.equal(physio.bill_with_parent, true);
      assert.deepEqual(await invoicesOf(physio.case_id), [], 'แพ็กที่รวมใบไม่มีใบของตัวเอง');
      let [draft] = await invoicesOf(home.case_id);
      assert.equal(draft.total, 60000, 'ใบ Homecare = 45,000 + แพ็กกายภาพ 15,000');
      assert.deepEqual(draft.addons, [{ name: '10 ครั้ง 3 เดือน', quantity: 1, unit_price: 15000, kind: 'physio', ref: physio.case_id }]);
      assert.equal(draft.fee_stale, false, 'ยอดใบตรงกับเคส (ค่า Homecare + บรรทัดในใบ)');
      assert.equal(draft.service_stale ?? false, false);

      // ไม่ขึ้นในรายการ "เคสที่ยังไม่มีใบ" · ออกใบแยกซ้ำไม่ได้
      const missing = (await get('/api/invoices/cases-without-invoice', MANAGER)).body;
      assert.ok(!missing.some((c) => c.case_id === physio.case_id));
      await post('/api/invoices', { case_id: physio.case_id }, MANAGER, 409);

      // เปลี่ยนราคาที่เคสกายภาพ -> ใบร่างของ Homecare ตาม · แพ็กที่สองแล้วยกเลิก -> บรรทัดหาย
      await patchCase(physio.case_id, { fee: 16000 });
      [draft] = await invoicesOf(home.case_id);
      assert.equal(draft.total, 61000);
      const second = await bundle({ fee: 9000 });
      assert.equal((await invoicesOf(home.case_id))[0].total, 70000);
      await post(`/api/cases/${second.case_id}/cancel`, { reason: 'ลูกค้าไม่เอาแพ็กที่สอง' });
      [draft] = await invoicesOf(home.case_id);
      assert.equal(draft.total, 61000);
      assert.equal(draft.addons.length, 1);

      // มัดจำหักจากค่า Homecare เท่านั้น (≤ 45,000) — บรรทัดกายภาพไปอยู่ใบส่วนที่เหลือเต็มจำนวน
      const over = await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 50000 }, MANAGER, 400);
      assert.equal(over.details.max_deposit, 45000);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 10000 });
      const plan = await invoicesOf(home.case_id);
      const deposit = plan.find((i) => i.billing_kind === 'deposit');
      const balance = plan.find((i) => i.billing_kind === 'balance');
      assert.equal(deposit.total, 10000);
      assert.deepEqual(deposit.addons, []);
      assert.equal(balance.total, 51000, 'Homecare ที่เหลือ 35,000 + กายภาพ 16,000');
      assert.equal(balance.addons[0].ref, physio.case_id);
      // แก้ยอดมัดจำทีหลังก็ติดเพดานเดียวกัน
      const raise = await fetch(`${base}/api/invoices/${deposit.invoice_id}/deposit`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify({ deposit_amount: 46000 }),
      });
      assert.equal(raise.status, 400);

      // ใบ Homecare แบ่งงวดไปแล้ว รับบรรทัดเพิ่มไม่ได้ = แพ็กใหม่ออกใบของตัวเอง (ไม่หลุดไม่เก็บเงิน)
      const late = await bundle({ fee: 8000 });
      assert.equal(late.billed_with_parent, false);
      assert.equal(late.bill_with_parent, false);
      assert.equal((await invoicesOf(late.case_id))[0].total, 8000);
    });

    test('ผูกเคสกายภาพที่เปิดแยกไว้ก่อนเข้าเคส Homecare: เสนอได้ทั้งสองฝั่ง · ผูกแล้วรายการเหลือแถวเดียว · ใบยังแยก', async () => {
      const rows = async () => (await get('/api/cases?q=KN690300031&per_page=100', MANAGER)).body.data;
      await post('/api/patients', { patient_id: 'KN690300031', name: 'ผูกทีหลัง' }, MANAGER, 201);
      await post('/api/patients', { patient_id: 'KN690300032', name: 'อีกคน' }, MANAGER, 201);
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('ผูกทีหลัง 20 ครั้ง', 20, 29000, 600) RETURNING physio_package_id`,
      )).physio_package_id;
      const me = { patient_id: 'KN690300031', client_name: 'ผูกทีหลัง' };
      // แบบในเคสจริง KN690202502: เปิดเคสกายภาพก่อน (ได้รหัสฐาน) แล้วค่อยเปิด Homecare (-R2) — ไม่มี addon_of
      const physio = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 29000 }, MANAGER, 201);
      const home = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 41000 }, MANAGER, 201);
      const other = await post('/api/cases', { patient_id: 'KN690300032', client_name: 'อีกคน', service_kind: 'homecare' }, MANAGER, 201);
      assert.equal(physio.addon_of, null);
      assert.equal((await rows()).length, 2, 'ยังไม่ผูก = สองแถว');

      // เสนอได้ทั้งสองฝั่ง — เฉพาะคนเดียวกัน
      assert.deepEqual((await get(`/api/cases/${home.case_id}/linkable-addons`, MANAGER)).body.map((a) => a.case_id), [physio.case_id]);
      assert.deepEqual((await get(`/api/cases/${physio.case_id}/addon-parents`, MANAGER)).body.map((p) => p.case_id), [home.case_id]);
      assert.deepEqual((await get(`/api/cases/${other.case_id}/linkable-addons`, MANAGER)).body, []);

      // ผูกผิด: แม่เป็นคนอื่น · ผูก Homecare เข้า Homecare · ไม่ส่งแม่
      await post(`/api/cases/${physio.case_id}/link-addon`, { parent_id: other.case_id }, MANAGER, 400);
      await post(`/api/cases/${home.case_id}/link-addon`, { parent_id: other.case_id }, MANAGER, 400);
      await post(`/api/cases/${physio.case_id}/link-addon`, {}, MANAGER, 400);

      const linked = await post(`/api/cases/${physio.case_id}/link-addon`, { parent_id: home.case_id }, MANAGER, 200);
      assert.equal(linked.addon_of, home.case_id);
      assert.equal(linked.bill_with_parent, false, 'ใบแจ้งหนี้ยังแยก');
      await post(`/api/cases/${physio.case_id}/link-addon`, { parent_id: home.case_id }, MANAGER, 200); // กดซ้ำไม่ error

      const list = await rows();
      assert.deepEqual(list.map((c) => c.case_id), [home.case_id], 'ผูกแล้วเหลือแถวเดียว');
      assert.deepEqual(list[0].physio_addons.map((a) => [a.case_id, a.name, a.fee]), [[physio.case_id, 'ผูกทีหลัง 20 ครั้ง', 29000]]);
      // ตัวเลขปริมาณเคส: หน้าภาพรวม (summary) = รายการเคส — กติการวมแพ็กชุดเดียวกัน (ตรวจ 10 พ.ย. 2569)
      // ย้ายไปปี 2001 ที่ไม่มีเคสอื่น · แม่เปิด มี.ค. แพ็กเปิด เม.ย.
      await sql.run(`UPDATE cases SET created_at = '2001-03-05 10:00:00' WHERE case_id = :id`, { id: home.case_id });
      await sql.run(`UPDATE cases SET created_at = '2001-04-05 10:00:00' WHERE case_id = :id`, { id: physio.case_id });
      const totals = async (query) => [
        (await get(`/api/cases/summary?${query}`, MANAGER)).body.total,
        (await get(`/api/cases?${query}`, MANAGER)).body.pagination.total,
      ];
      assert.deepEqual(await totals('year=2001'), [1, 1], 'ทั้งปี: แพ็กรวมกับแม่');
      assert.deepEqual(await totals('year=2001&month=04'), [1, 1], 'เดือนของแพ็ก (แม่อยู่เดือนก่อน): แพ็กนับเป็นของตัวเอง');
      assert.deepEqual(await totals('year=2001&month=03'), [1, 1]);
      // "ยังไม่จับคู่พนักงาน" = คิวงานทีละเคส — แม่และแพ็กยังไม่จับคู่ทั้งคู่ → เห็นทั้งสองแถว (ตรงกับกระดิ่ง)
      const unassigned = (await get('/api/cases?q=KN690300031&status=unassigned', MANAGER)).body.data.map((c) => c.case_id);
      assert.deepEqual(unassigned.sort(), [home.case_id, physio.case_id].sort());

      // ผูกแล้วไม่ถูกเสนอซ้ำ และย้ายไปแม่อื่นไม่ได้
      assert.deepEqual((await get(`/api/cases/${home.case_id}/linkable-addons`, MANAGER)).body, []);
      assert.deepEqual((await get(`/api/cases/${physio.case_id}/addon-parents`, MANAGER)).body, []);
      const events = (await get(`/api/cases/${home.case_id}/events`, MANAGER)).body;
      assert.ok(events.some((e) => e.event === 'physio_addon' && e.detail.includes('ผูกเคสกายภาพที่เปิดแยกไว้')));

      // หน้าผู้รับบริการได้ addon_of + ชื่อแพ็ก — หน้าเว็บรวมแถวแพ็กเข้าเคส Homecare เอง (lib/caseAddons.js)
      const patientCases = (await get('/api/patients/KN690300031', MANAGER)).body.cases;
      const pack = patientCases.find((c) => c.case_id === physio.case_id);
      assert.equal(pack.addon_of, home.case_id);
      assert.equal(pack.physio_package_name, 'ผูกทีหลัง 20 ครั้ง');
      assert.equal(pack.bill_with_parent, false);

      // ---- ตรวจ 10 พ.ย. 2569 ----
      // 1) พนักงานภาคสนามไม่ได้ราคาแพ็ก (fee ใน physio_addons) — เดิม stripFinancial ตัดแค่ช่องระดับบน
      await sql.run(`UPDATE cases SET status = 'assigned', assigned_to = :emp WHERE case_id = :id`,
        { id: home.case_id, emp: FIELD.employee_id });
      const mineList = (await get('/api/my/cases', FIELD)).body.find((c) => c.case_id === home.case_id);
      assert.ok(mineList, 'เคสที่ถืออยู่ขึ้นใน /api/my/cases');
      assert.equal(mineList.physio_addons.length, 1);
      assert.ok(!('fee' in mineList.physio_addons[0]), 'ราคาแพ็กต้องไม่ถึงพนักงานภาคสนาม');
      const mineOne = (await get(`/api/my/cases/${home.case_id}`, FIELD)).body;
      assert.ok(mineOne.physio_addons.every((a) => !('fee' in a)));

      // 2) ตัวกรองของค้างจากกระดิ่ง = คิวงานทีละเคส ไม่รวมแถว (แม่กับแพ็กเลยกำหนดปิดทั้งคู่ → เห็นทั้งสองแถว)
      await sql.run(`UPDATE cases SET status = 'assigned', assigned_to = :emp, end_date = '2020-01-01' WHERE case_id IN (:a, :b)`,
        { a: home.case_id, b: physio.case_id, emp: FIELD.employee_id });
      const overdue = (await get('/api/cases?q=KN690300031&overdue_close=yes', MANAGER)).body;
      assert.deepEqual(overdue.data.map((c) => c.case_id).sort(), [home.case_id, physio.case_id].sort());
      assert.equal(overdue.pagination.total, 2);
      assert.deepEqual((await rows()).map((c) => c.case_id), [home.case_id], 'ไม่มีตัวกรองของค้าง = ยังรวมแถว');

      // 3) แม่ยกเลิกแล้ว — แพ็กกลับเป็นแถวของตัวเอง และไม่ซ้ำอยู่ในแถวแม่
      await sql.run(`UPDATE cases SET status = 'cancelled' WHERE case_id = :id`, { id: home.case_id });
      const afterCancel = await rows();
      assert.deepEqual(afterCancel.map((c) => c.case_id).sort(), [home.case_id, physio.case_id].sort());
      assert.deepEqual(afterCancel.find((c) => c.case_id === home.case_id).physio_addons, [], 'ไม่โชว์ซ้ำในแถวแม่ที่ยกเลิก');

      // 4) ผูกกับเคส Homecare ที่ไม่มีแฟ้มผู้รับบริการ = ไม่ได้ (ตรวจตัวตนไม่ได้)
      const loose = await post('/api/cases', { client_name: 'ไม่มีแฟ้ม', service_kind: 'homecare' }, MANAGER, 201);
      const lonePack = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 1000 }, MANAGER, 201);
      await post(`/api/cases/${lonePack.case_id}/link-addon`, { parent_id: loose.case_id }, MANAGER, 400);

      // 5) ยกเลิกการผูก (ผูกผิด) — ใบแยกยกเลิกได้ · กดซ้ำไม่ error · ลงประวัติทั้งสองเคส
      const unlinked = await post(`/api/cases/${physio.case_id}/unlink-addon`, {}, MANAGER, 200);
      assert.equal(unlinked.addon_of, null);
      await post(`/api/cases/${physio.case_id}/unlink-addon`, {}, MANAGER, 200);
      assert.ok((await get(`/api/cases/${physio.case_id}/events`, MANAGER)).body
        .some((e) => e.event === 'physio_addon' && e.detail.includes('ยกเลิกการผูก')));
    });

    test('แพ็กเสริมกับสถานะเคส: แม่ปิดแต่แพ็กยังเดิน = แถวแยก · ปิดทั้งคู่ = รวม · แพ็กยกเลิก = แถวแยก · แก้เคสแม่ผิดคน/ผิดสายไม่ได้', async () => {
      const patchCase = async (id, body, expected = 200) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, expected, JSON.stringify(data));
        return data;
      };
      const rows = async () => (await get('/api/cases?q=KN690300041&per_page=100', MANAGER)).body.data;
      const ids = async () => (await rows()).map((c) => c.case_id).sort();
      const setStatus = (id, status) => sql.run(
        `UPDATE cases SET status = :status, assigned_to = CASE WHEN :status = 'unassigned' THEN NULL ELSE :emp END WHERE case_id = :id`,
        { id, status, emp: FIELD.employee_id },
      );
      await post('/api/patients', { patient_id: 'KN690300041', name: 'สถานะแพ็ก' }, MANAGER, 201);
      await post('/api/patients', { patient_id: 'KN690300042', name: 'อีกคน2' }, MANAGER, 201);
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('สถานะแพ็ก 10 ครั้ง', 10, 9000, 600) RETURNING physio_package_id`,
      )).physio_package_id;
      const me = { patient_id: 'KN690300041', client_name: 'สถานะแพ็ก' };
      const home = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 30000 }, MANAGER, 201);
      const pack = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 9000, addon_of: home.case_id }, MANAGER, 201);
      const both = [home.case_id, pack.case_id].sort();
      assert.deepEqual(await ids(), [home.case_id], 'เดินอยู่ทั้งคู่ = แถวเดียว');

      // แม่ปิด (เช่น ต่อรอบรายเดือนแล้วรอบเก่าปิด) แต่แพ็กยังเดิน → แพ็กต้องเห็นเป็นแถวของตัวเอง ไม่ซ่อนในเคสที่ปิด
      await setStatus(home.case_id, 'closed');
      assert.deepEqual(await ids(), both);
      assert.deepEqual((await rows()).find((c) => c.case_id === home.case_id).physio_addons, [], 'ไม่โชว์ซ้ำในแถวแม่');
      // ปิดทั้งคู่ → รวมเป็นประวัติแถวเดียว
      await setStatus(pack.case_id, 'closed');
      assert.deepEqual(await ids(), [home.case_id]);
      assert.equal((await rows())[0].physio_addons.length, 1);

      // แพ็กยกเลิก (แม่ยังเดิน) → แถวของตัวเอง (เดิมหายไปทั้งสองที่)
      await setStatus(home.case_id, 'unassigned');
      await setStatus(pack.case_id, 'cancelled');
      assert.deepEqual(await ids(), both);
      assert.deepEqual((await rows()).find((c) => c.case_id === home.case_id).physio_addons, []);

      // เคสแม่ที่มีแพ็กผูกอยู่: เปลี่ยนผู้รับบริการ / สลับเป็นสายกายภาพไม่ได้ · แก้อย่างอื่นได้
      await setStatus(pack.case_id, 'unassigned');
      const wrongPerson = await patchCase(home.case_id, { patient_id: 'KN690300042' }, 409);
      assert.match(wrongPerson.error, /แพ็กกายภาพเสริม/);
      await patchCase(home.case_id, { service_kind: 'physio', physio_package_id: pkgId }, 409);
      await patchCase(home.case_id, { note: 'แก้หมายเหตุได้ปกติ' }, 200);
      // ยกเลิกการผูกแล้ว → แก้ได้
      await post(`/api/cases/${pack.case_id}/unlink-addon`, {}, MANAGER, 200);
      await patchCase(home.case_id, { service_kind: 'physio', physio_package_id: pkgId }, 200);
    });

    test('ต่อเคส Homecare: คอร์สกายภาพจองย้ายไปรอบใหม่ · ย้ายจริงเมื่อรอบใหม่เริ่ม/รอบเก่าปิด · รวมใบไม่ย้าย · ยกเลิกรอบใหม่ล้างการจอง', async () => {
      const one = async (id) => (await get(`/api/cases/${id}`, MANAGER)).body;
      const setStatus = (id, status) => sql.run(
        `UPDATE cases SET status = :status, assigned_to = CASE WHEN :status = 'unassigned' THEN NULL ELSE :emp END WHERE case_id = :id`,
        { id, status, emp: FIELD.employee_id },
      );
      await post('/api/patients', { patient_id: 'KN690300051', name: 'ต่อรอบ' }, MANAGER, 201);
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('ต่อรอบ 20 ครั้ง', 20, 29000, 600) RETURNING physio_package_id`,
      )).physio_package_id;
      const me = { patient_id: 'KN690300051', client_name: 'ต่อรอบ' };
      const r1 = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 41000, start_date: '2026-01-01' }, MANAGER, 201);
      const pack = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 29000, addon_of: r1.case_id }, MANAGER, 201);
      const bundled = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 5000, addon_of: r1.case_id, bill_with_parent: true }, MANAGER, 201);
      assert.equal(bundled.bill_with_parent, true);

      // ต่อเคสล่วงหน้า (รอบ 2 เริ่มอนาคต) → จองย้าย แต่ยังไม่ย้าย · แพ็กรวมใบไม่จอง
      const r2 = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 41000, renewed_from: r1.case_id, start_date: '2099-01-01' }, MANAGER, 201);
      let p = await one(pack.case_id);
      assert.equal(p.addon_of, r1.case_id, 'ยังอยู่กับรอบที่ให้บริการจริง');
      assert.equal(p.addon_next, r2.case_id);
      assert.equal(p.addon_next_round, 2);
      assert.equal((await one(bundled.case_id)).addon_next, null, 'แพ็กรวมใบไม่ย้าย (กันเก็บเงินซ้ำ)');
      assert.deepEqual((await one(r2.case_id)).physio_addons, [], 'รอบที่ยัง "รอเริ่ม" ยังไม่มีแพ็ก');

      // ③ ถึงวันเริ่มของรอบใหม่ → ย้าย · ลงประวัติทั้งสามเคส
      await sql.run(`UPDATE cases SET start_date = '2026-02-01' WHERE case_id = :id`, { id: r2.case_id });
      p = await one(pack.case_id);
      assert.equal(p.addon_of, r2.case_id);
      assert.equal(p.addon_next, null);
      assert.deepEqual((await one(r2.case_id)).physio_addons.map((a) => a.case_id), [pack.case_id]);
      for (const id of [pack.case_id, r1.case_id, r2.case_id]) {
        assert.ok((await get(`/api/cases/${id}/events`, MANAGER)).body
          .some((e) => e.event === 'physio_addon' && /ย้าย/.test(e.detail) && e.actor_name === 'ระบบ (ย้ายตามรอบ)'), id);
      }
      assert.equal((await one(bundled.case_id)).addon_of, r1.case_id, 'แพ็กรวมใบยังอยู่รอบเดิม');

      // ② รอบเก่าปิด (รอบใหม่ยังไม่ถึงวันเริ่ม) → ย้าย
      const r3 = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 41000, renewed_from: r2.case_id, start_date: '2099-02-01' }, MANAGER, 201);
      assert.equal((await one(pack.case_id)).addon_of, r2.case_id);
      await setStatus(r2.case_id, 'closed');
      assert.equal((await one(pack.case_id)).addon_of, r3.case_id);

      // ยกเลิกรอบใหม่ก่อนเริ่ม → ล้างการจอง แพ็กอยู่รอบเดิม
      const r4 = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 41000, renewed_from: r3.case_id, start_date: '2099-03-01' }, MANAGER, 201);
      assert.equal((await one(pack.case_id)).addon_next, r4.case_id);
      await setStatus(r4.case_id, 'cancelled');
      p = await one(pack.case_id);
      assert.equal(p.addon_of, r3.case_id);
      assert.equal(p.addon_next, null);

      // ฟอร์มติ๊กออก (carry_addons: []) → ไม่จอง
      const r5 = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 41000, renewed_from: r3.case_id, start_date: '2099-03-01', carry_addons: [] }, MANAGER, 201);
      assert.ok(r5.case_id);
      assert.equal((await one(pack.case_id)).addon_next, null);
    });

    test('ตรวจ 11 พ.ย. 2569: แพ็กรวมใบขึ้นกระดิ่ง/คิวงาน · แม่ปิด/ถูกลบแล้วแพ็กยังเห็นในรายการ · ต่อรอบแพ็กตามรอบ Homecare · ยกเลิกแพ็กหลังออกใบแล้วเตือน', async () => {
      const one = async (id) => (await get(`/api/cases/${id}`, MANAGER)).body;
      const ids = async (query = '') =>
        (await get(`/api/cases?q=KN690300061&per_page=100${query}`, MANAGER)).body.data.map((c) => c.case_id).sort();
      const caseAlerts = async () => (await get('/api/notify/alerts', MANAGER)).body.groups.cases;
      const setStatus = (id, status) => sql.run(
        `UPDATE cases SET status = :status, assigned_to = CASE WHEN :status = 'unassigned' THEN NULL ELSE :emp END WHERE case_id = :id`,
        { id, status, emp: FIELD.employee_id },
      );
      await post('/api/patients', { patient_id: 'KN690300061', name: 'ตรวจรอบสอง' }, MANAGER, 201);
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('ตรวจรอบสอง 10 ครั้ง', 10, 12000, 600) RETURNING physio_package_id`,
      )).physio_package_id;
      const me = { patient_id: 'KN690300061', client_name: 'ตรวจรอบสอง' };

      // ---- ข้อ 1: แพ็กรวมใบ (ยังไม่มีนักกายภาพ) ต้องขึ้นกระดิ่ง "ยังไม่จับคู่" และตัวกรองคิวงาน ----
      const home = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 30000, start_date: '2026-01-01' }, MANAGER, 201);
      await setStatus(home.case_id, 'assigned'); // แม่มีคนแล้ว — เหลือแค่แพ็กที่ยังไม่มีคน
      const before = (await caseAlerts()).unassigned;
      const bundled = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 12000, addon_of: home.case_id, bill_with_parent: true }, MANAGER, 201);
      assert.equal(bundled.bill_with_parent, true);
      assert.equal((await caseAlerts()).unassigned, before + 1, 'กระดิ่งนับแพ็กรวมใบที่ยังไม่มีนักกายภาพ');
      assert.deepEqual(await ids('&status=unassigned'), [bundled.case_id], 'คิว "ยังไม่จับคู่" เห็นแพ็ก');
      assert.deepEqual(await ids(), [home.case_id], 'รายการปกติยังรวมแพ็กไว้ในแถวแม่');

      // แพ็กรวมใบที่ปิดแล้ว แต่ใบ Homecare เก็บเงินแทนอยู่ = ไม่ใช่ "ปิดแล้วไม่มีใบ"
      await setStatus(bundled.case_id, 'closed');
      assert.deepEqual(await ids('&closed_no_invoice=yes'), [], 'ใบ Homecare เก็บเงินแพ็กนี้อยู่แล้ว');
      await setStatus(bundled.case_id, 'unassigned');

      // ---- ข้อ 2: แม่ปิดแล้วแต่แพ็กรวมใบยังเดิน → แพ็กต้องเป็นแถวของตัวเอง ไม่หายไป ----
      await setStatus(home.case_id, 'closed');
      assert.deepEqual(await ids(), [home.case_id, bundled.case_id].sort());
      assert.deepEqual(await ids('&status=unassigned'), [bundled.case_id]);
      await setStatus(home.case_id, 'assigned');

      // ---- ข้อ 3: ต่อรอบแพ็ก ตอนที่ Homecare ต่อรอบไว้แล้ว (รอเริ่ม) → แพ็กใหม่จองย้ายไปรอบนั้นด้วย ----
      const pack = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 12000, addon_of: home.case_id }, MANAGER, 201);
      const h2 = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 30000, renewed_from: home.case_id, start_date: '2099-01-01' }, MANAGER, 201);
      assert.equal((await one(pack.case_id)).addon_next, h2.case_id, 'แพ็กเดิมจองย้ายตามปกติ');
      const pack2 = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 12000, renewed_from: pack.case_id }, MANAGER, 201);
      assert.equal(pack2.addon_of, home.case_id, 'ยังอยู่กับรอบที่ให้บริการจริง');
      assert.equal(pack2.addon_next, h2.case_id, 'จองย้ายไปรอบใหม่ด้วย (เดิมไม่จอง = ค้างรอบเก่า)');
      // เปิดแพ็กใหม่จากเคส Homecare ที่ต่อรอบไว้แล้ว ก็จองเหมือนกัน
      const fresh = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 12000, addon_of: home.case_id }, MANAGER, 201);
      assert.equal(fresh.addon_next, h2.case_id);
      // รอบใหม่เริ่ม → ย้ายตามกันหมด
      await sql.run(`UPDATE cases SET start_date = '2026-02-01' WHERE case_id = :id`, { id: h2.case_id });
      assert.equal((await one(pack2.case_id)).addon_of, h2.case_id);
      assert.equal((await one(fresh.case_id)).addon_of, h2.case_id);

      // รอบเก่าปิดแล้ว รอบใหม่กำลังเดิน → ต่อรอบแพ็กที่ยังผูกรอบเก่า ต้องผูกกับรอบปัจจุบัน (เดิมหลุดเป็นเคสเดี่ยว)
      const stale = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 12000 }, MANAGER, 201);
      await sql.run('UPDATE cases SET addon_of = :old WHERE case_id = :id', { id: stale.case_id, old: home.case_id });
      await setStatus(home.case_id, 'closed');
      const stale2 = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 12000, renewed_from: stale.case_id }, MANAGER, 201);
      assert.equal(stale2.addon_of, h2.case_id);

      // ผูกเคสกายภาพที่เปิดแยกไว้ เข้ากับ Homecare ที่ต่อรอบไว้แล้ว → จองย้ายด้วย
      const h3 = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 30000, renewed_from: h2.case_id, start_date: '2099-03-01' }, MANAGER, 201);
      const loose = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 12000 }, MANAGER, 201);
      const linked = await post(`/api/cases/${loose.case_id}/link-addon`, { parent_id: h2.case_id }, MANAGER, 200);
      assert.equal(linked.addon_of, h2.case_id);
      assert.equal(linked.addon_next, h3.case_id);

      // ---- ข้อ 4: ยกเลิกแพ็กรวมใบหลังใบ Homecare ออกไปแล้ว → server ส่งรายชื่อใบให้หน้าเว็บเด้งเตือน ----
      await post('/api/patients', { patient_id: 'KN690300062', name: 'ตรวจใบลดหนี้' }, MANAGER, 201);
      const you = { patient_id: 'KN690300062', client_name: 'ตรวจใบลดหนี้' };
      const hc = await post('/api/cases', { ...you, service_kind: 'homecare', fee: 30000 }, MANAGER, 201);
      const inBill = await post('/api/cases', { ...you, physio_package_id: pkgId, fee: 12000, addon_of: hc.case_id, bill_with_parent: true }, MANAGER, 201);
      const [hcDraft] = (await get(`/api/invoices?case_id=${hc.case_id}`, MANAGER)).body.data;
      assert.equal(hcDraft.total, 42000);
      await post(`/api/invoices/${hcDraft.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${hcDraft.invoice_id}/issue`, {});
      const res = await post(`/api/cases/${inBill.case_id}/cancel`, { reason: 'ลูกค้ายกเลิกกายภาพ' });
      assert.deepEqual(res.bundle_invoices_to_credit.map((i) => i.invoice_id), [hcDraft.invoice_id]);
      // ใบร่างปกติ: ระบบเอาบรรทัดออกให้เอง → ไม่ต้องเตือน (bundled ของข้อ 1 ยังอยู่ในใบร่างของ home)
      const quiet = await post(`/api/cases/${bundled.case_id}/cancel`, { reason: 'x' });
      assert.deepEqual(quiet.bundle_invoices_to_credit, []);
      // แพ็กใบแยก ยกเลิกแล้วไม่ต้องเตือนเรื่องใบ Homecare
      const sep = await post('/api/cases', { ...you, physio_package_id: pkgId, fee: 5000, addon_of: hc.case_id }, MANAGER, 201);
      assert.deepEqual((await post(`/api/cases/${sep.case_id}/cancel`, { reason: 'x' })).bundle_invoices_to_credit, []);

      // ---- ข้อ 2 ต่อ: เคส Homecare ถูกลบทิ้ง → แพ็กรวมใบยังเห็นในรายการ (เดิมหายไปเลย) ----
      await post('/api/patients', { patient_id: 'KN690300063', name: 'ลบแม่' }, MANAGER, 201);
      const gone = await post('/api/cases', { patient_id: 'KN690300063', client_name: 'ลบแม่', service_kind: 'homecare', fee: 1000 }, MANAGER, 201);
      const orphan = await post('/api/cases', { patient_id: 'KN690300063', client_name: 'ลบแม่', physio_package_id: pkgId, fee: 12000, addon_of: gone.case_id, bill_with_parent: true }, MANAGER, 201);
      const del = await fetch(`${base}/api/cases/${gone.case_id}?force=true`, {
        method: 'DELETE', headers: { cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
      });
      assert.equal(del.status, 204);
      const left = (await get('/api/cases?q=KN690300063&per_page=100', MANAGER)).body.data.map((c) => c.case_id);
      assert.deepEqual(left, [orphan.case_id]);
    });

    test('ตรวจ 11 พ.ย. 2569 รอบสอง: กะ 24 ชม. · งวดค่าจ้าง · ลบกะเคสจบ · ยกเลิก-เปิดเคสคืนใบ · เปิดเคสที่ต่อรอบ · ย้ายคน · ปลดญาติ', async () => {
      const FIELD_B = emp('EMP-0004', 'caregiver');
      const day = async (n) => (await sql.one(
        `SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date + :n::int, 'YYYY-MM-DD') AS d`, { n },
      )).d;
      const send = async (method, path, expected) => {
        const res = await fetch(`${base}${path}`, { method, headers: { cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` } });
        assert.equal(res.status, expected, `${method} ${path}`);
      };
      const visitsOn = async (caseId, dates, who = FIELD) =>
        (await post(`/api/cases/${caseId}/visits/bulk`, { dates, assigned_to: who.employee_id }, MANAGER, 201)).visits;
      const visitRow = (id) => sql.one('SELECT status, assigned_to, remind_day_at FROM case_visits WHERE visit_id = :id', { id });

      // ---- ข้อ 6: กะ 24 ชม. ส่งเวรช้าไปไม่กี่นาที ยังกดเช็คเอาท์เองได้ · ไม่ขึ้น "ค้างผิดปกติ" ตั้งแต่ชั่วโมงที่ 16 ----
      const c24 = await newCase();
      await post(`/api/cases/${c24.case_id}/assign`, { employee_id: FIELD.employee_id });
      const [long] = await visitsOn(c24.case_id, [await day(-1)]);
      await sql.run(
        `UPDATE case_visits SET planned_start = '08:00', planned_end = '08:00', checked_in_by = :emp,
                check_in_at = now() - interval '24 hours 10 minutes' WHERE visit_id = :id`,
        { id: long.visit_id, emp: FIELD.employee_id },
      );
      await post(`/api/my/visits/${long.visit_id}/check-out`, {}, FIELD);
      const at = (h) => new Date(Date.now() - h * 3.6e6).toISOString();
      const state = (v) => casesRepo.withVisitState({ visit_status: 'scheduled', visit_date: '2026-01-01', ...v }).state;
      assert.equal(state({ planned_start: '08:00', planned_end: '08:00', check_in_at: at(20) }), 'working', 'กะ 24 ชม. ชั่วโมงที่ 20 ยังปกติ');
      assert.equal(state({ planned_start: '08:00', planned_end: '08:00', check_in_at: at(29) }), 'stale');
      assert.equal(state({ planned_start: '08:00', planned_end: '12:00', check_in_at: at(17) }), 'stale', 'กะสั้นยังใช้เกณฑ์ 16 ชม. เดิม');
      assert.equal(casesRepo.checkOutLimitHours({ planned_start: '08:00', planned_end: '12:00' }), 24);
      assert.equal(casesRepo.checkOutLimitHours({ planned_start: '20:00', planned_end: '20:00' }), 30);

      // ---- ข้อ 7: ถอนงวดกลาง (งวด 3 จาก 5) แล้วยังปล่อยเงินที่เหลือได้ ----
      const c7 = await newCase();
      await post(`/api/cases/${c7.case_id}/assign`, { employee_id: FIELD.employee_id });
      for (let i = 0; i < 5; i += 1) {
        await post(`/api/cases/${c7.case_id}/pay/release`, { request_id: randomUUID(), amount: 100 }, MANAGER, 201);
      }
      await post(`/api/cases/${c7.case_id}/pay/release`, { request_id: randomUUID(), amount: 100 }, MANAGER, 409);
      const third = (await casesRepo.payStatus(c7.case_id)).payouts.find((p) => p.installment_no === 3);
      await send('DELETE', `/api/cases/${c7.case_id}/pay/${third.payout_id}`, 200);
      let pay = await casesRepo.payStatus(c7.case_id);
      assert.equal(pay.installments_left, 1, 'งวดที่ถอนคืนได้ช่องคืน');
      assert.equal(pay.next_installment, 3);
      await post(`/api/cases/${c7.case_id}/pay/release`, { request_id: randomUUID(), amount: 100 }, MANAGER, 201);
      pay = await casesRepo.payStatus(c7.case_id);
      assert.deepEqual(pay.payouts.map((p) => p.installment_no).sort(), [1, 2, 3, 4, 5]);
      assert.equal(pay.installments_left, 0);

      // ---- ข้อ 8: เคสที่ยกเลิกแล้ว ลบกะไม่ได้ (กะที่เหลือคือฐานค่าจ้างตามสัดส่วน) ----
      const c8 = await newCase();
      await post(`/api/cases/${c8.case_id}/assign`, { employee_id: FIELD.employee_id });
      const [v8] = await visitsOn(c8.case_id, [await day(2), await day(3)]);
      await post(`/api/cases/${c8.case_id}/cancel`, { reason: 'ทดสอบ' });
      await send('DELETE', `/api/cases/${c8.case_id}/visits?from=${await day(2)}&to=${await day(3)}`, 409);
      await send('DELETE', `/api/cases/${c8.case_id}/visits/${v8.visit_id}`, 409);

      // ---- ข้อ 9: แผนมัดจำ — ยกเลิกเคสแล้วเปิดกลับ ใบร่างที่ระบบยกเลิกให้กลับมา ----
      const invoicesOf = async (id) => (await get(`/api/invoices?case_id=${id}`, MANAGER)).body.data;
      const live = async (id) => (await invoicesOf(id)).filter((i) => i.status !== 'cancelled')
        .map((i) => [i.billing_kind, i.status, i.total]).sort();
      const c9 = await newCase();
      const [d9] = await invoicesOf(c9.case_id);
      await post(`/api/invoices/${d9.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 500 });
      const plan9 = await live(c9.case_id);
      await post(`/api/cases/${c9.case_id}/cancel`, { reason: 'ทดสอบ' });
      assert.deepEqual(await live(c9.case_id), [], 'ใบร่างถูกยกเลิกตามเคส');
      await post(`/api/cases/${c9.case_id}/reopen`, {});
      assert.deepEqual(await live(c9.case_id), plan9, 'เปิดเคสกลับ = ใบร่างทั้งแผนกลับมา (ไม่หายเงียบ)');
      // มัดจำออกใบแล้ว → ยกเลิกเคสไม่ยกเลิกใบส่วนที่เหลือ (ไม่ทิ้งแผนไว้ครึ่งเดียว)
      const deposit9 = (await invoicesOf(c9.case_id)).find((i) => i.billing_kind === 'deposit');
      await post(`/api/invoices/${deposit9.invoice_id}/issue`, {});
      await post(`/api/cases/${c9.case_id}/cancel`, { reason: 'ทดสอบ' });
      assert.deepEqual((await live(c9.case_id)).map(([k, s]) => [k, s]), [['balance', 'draft'], ['deposit', 'issued']]);

      // ---- ข้อ 12: เปิดเคสที่ต่อรอบไปแล้ว — ไม่คืนกะที่ซ้ำกับรอบใหม่ ----
      const c12 = await newCase();
      await post(`/api/cases/${c12.case_id}/assign`, { employee_id: FIELD.employee_id });
      const v12 = await visitsOn(c12.case_id, [await day(2), await day(3)]);
      await post(`/api/cases/${c12.case_id}/close`, { force: true });
      const r12 = await post('/api/cases', { case_type: 'other', client_name: 'Workflow patient', renewed_from: c12.case_id }, MANAGER, 201);
      await post(`/api/cases/${c12.case_id}/reopen`, {});
      for (const v of v12) assert.equal((await visitRow(v.visit_id)).status, 'cancelled', 'ไม่คืนกะ — งานช่วงนั้นอยู่รอบใหม่แล้ว');

      // ---- ข้อ 13: เปลี่ยนคนหลัก → กะที่ย้ายล้างธง "เตือนแล้ว" คนใหม่จึงได้เตือน ----
      const c13 = await newCase();
      await post(`/api/cases/${c13.case_id}/assign`, { employee_id: FIELD.employee_id });
      const [v13] = await visitsOn(c13.case_id, [await day(1)]);
      await sql.run("UPDATE case_visits SET remind_day_at = 'sent' WHERE visit_id = :id", { id: v13.visit_id });
      await post(`/api/cases/${c13.case_id}/assign`, { employee_id: FIELD_B.employee_id });
      assert.deepEqual(await visitRow(v13.visit_id), { status: 'scheduled', assigned_to: FIELD_B.employee_id, remind_day_at: null });

      // ---- ข้อ 14: เปิดเคสกลับ — กะของคนที่ถูกถอด/รับงานไม่ได้แล้ว ไปที่คนหลัก ไม่คืนให้คนเดิม ----
      const c14 = await newCase();
      await post(`/api/cases/${c14.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${c14.case_id}/team`, { employee_id: FIELD_B.employee_id });
      const onDay = async (n, who = FIELD) => {
        const d = await day(n);
        return (await visitsOn(c14.case_id, [d], who)).find((v) => v.visit_date === d);
      };
      const mine = await onDay(2);
      const theirs = await onDay(3, FIELD_B);
      const resigned = await onDay(4);
      await post(`/api/cases/${c14.case_id}/close`, { force: true });
      // จำลองกะของคนที่ถูกพักงานไประหว่างที่เคสปิด
      await sql.run("UPDATE case_visits SET assigned_to = 'EMP-0005' WHERE visit_id = :id", { id: resigned.visit_id });
      await send('DELETE', `/api/cases/${c14.case_id}/team/${FIELD_B.employee_id}`, 200);
      await post(`/api/cases/${c14.case_id}/reopen`, {});
      assert.deepEqual(await visitRow(mine.visit_id), { status: 'scheduled', assigned_to: FIELD.employee_id, remind_day_at: null },
        'คนหลักได้กะของตัวเองคืน');
      assert.deepEqual(await visitRow(theirs.visit_id), { status: 'scheduled', assigned_to: FIELD.employee_id, remind_day_at: null },
        'คนที่ถูกถอดออกจากทีมไม่ได้กะคืน — ไปที่คนหลัก');
      assert.equal((await visitRow(resigned.visit_id)).assigned_to, FIELD.employee_id, 'คนที่ถูกพักงานไม่ได้กะคืน');

      // ---- ข้อ 15: ปลดญาติ → รหัสที่เขาชวนต่อไว้ใช้ไม่ได้ ----
      const familyLib = await import('../src/lib/family.js');
      const c15 = await newCase();
      const { code } = await familyLib.createInvite(c15.case_id, 'แอดมิน');
      assert.equal((await familyLib.accept(code, 'U-REVOKE-1', 'ญาติคนแรก')).ok, true);
      const first = await familyLib.memberLink('U-REVOKE-1', c15.case_id);
      const passOn = await familyLib.familyInvite('U-REVOKE-1', c15.case_id);
      assert.equal(passOn.ok, true);
      assert.equal(await familyLib.revoke(c15.case_id, first.link_id), 1);
      const late = await familyLib.accept(passOn.code, 'U-REVOKE-2', 'ญาติที่ถูกชวน');
      assert.equal(late.ok, false, 'รหัสที่ญาติที่ถูกปลดแจกไว้ ใช้ไม่ได้แล้ว');

      // เก็บกวาด — เทสต์ชุดหลังนับยอดรวมทั้งระบบ (ค่าจ้างที่ปล่อยค้าง · ภาระงานของพนักงาน) ห้ามติดข้อมูลของชุดนี้ไป
      for (const p of (await casesRepo.payStatus(c7.case_id)).payouts) {
        await send('DELETE', `/api/cases/${c7.case_id}/pay/${p.payout_id}`, 200);
      }
      for (const c of [r12, c24, c7, c8, c9, c12, c13, c14, c15]) await send('DELETE', `/api/cases/${c.case_id}?force=true`, 204);
    });

    test('รวมแพ็กที่เปิดแยกเข้าเคส Homecare: เหลือเคสเดียวในรายการ · ใบร่างแพ็กถูกลบ · ใบ Homecare ยอดรวม', async () => {
      const send = async (method, path, expected) => {
        const res = await fetch(`${base}${path}`, {
          method, headers: { cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        });
        assert.equal(res.status, expected, `${method} ${path}`);
      };
      const invoicesOf = async (id) => (await get(`/api/invoices?case_id=${id}`, MANAGER)).body.data
        .filter((i) => i.status !== 'cancelled');
      const rows = async () => (await get('/api/cases?q=KN690300021&per_page=100', MANAGER)).body.data;
      await post('/api/patients', { patient_id: 'KN690300021', name: 'รวมเคส' }, MANAGER, 201);
      const pkgId = (await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('รวมเคส 10 ครั้ง', 10, 15000, 600) RETURNING physio_package_id`,
      )).physio_package_id;
      const me = { patient_id: 'KN690300021', client_name: 'รวมเคส' };
      const home = await post('/api/cases', { ...me, service_kind: 'homecare', fee: 45000 }, MANAGER, 201);
      const physio = await post('/api/cases', { ...me, physio_package_id: pkgId, fee: 15000, addon_of: home.case_id }, MANAGER, 201);
      // เปิดแยก (ใบแยก) ก็ยังเป็นแถวเดียว — แพ็กอยู่ใน physio_addons ของแถว Homecare (10 พ.ย. 2569)
      const separate = await rows();
      assert.deepEqual(separate.map((c) => c.case_id), [home.case_id], 'เปิดแยกก็แถวเดียว');
      assert.deepEqual(separate[0].physio_addons.map((a) => [a.case_id, a.bill_with_parent]), [[physio.case_id, false]]);
      assert.equal((await invoicesOf(physio.case_id)).length, 1);

      const merged = await post(`/api/cases/${physio.case_id}/bundle`, {}, MANAGER, 200);
      assert.equal(merged.bill_with_parent, true);
      assert.deepEqual(await invoicesOf(physio.case_id), [], 'ใบร่างของแพ็กถูกลบ');
      const [draft] = await invoicesOf(home.case_id);
      assert.equal(draft.total, 60000);

      const list = await rows();
      assert.deepEqual(list.map((c) => c.case_id), [home.case_id], 'เหลือเคส Homecare แถวเดียว');
      assert.equal(list[0].bundled_physio.length, 1);
      assert.equal(list[0].bundled_physio[0].fee, 15000);
      // รวมใบแล้ว = ยกเลิกการผูกเฉยๆ ไม่ได้ (บรรทัดแพ็กในใบ Homecare จะค้าง)
      const refused = await post(`/api/cases/${physio.case_id}/unlink-addon`, {}, MANAGER, 409);
      assert.match(refused.error, /ใบแจ้งหนี้/);
      // เปิดดูแพ็กตรงๆ ยังได้ (นัด/รายละเอียด) แต่ออกใบแยกไม่ได้
      assert.equal((await get(`/api/cases/${physio.case_id}`, MANAGER)).body.addon_of, home.case_id);
      await post('/api/invoices', { case_id: physio.case_id }, MANAGER, 409);

      // ลบใบ Homecare = เคสเดียวขึ้นในรายการรอออกใบ ยอดรวมแพ็ก · ออกใหม่ได้บรรทัดแพ็กครบ
      await send('DELETE', `/api/invoices/${draft.invoice_id}`, 200);
      const missing = (await get('/api/invoices/cases-without-invoice', MANAGER)).body
        .filter((c) => [home.case_id, physio.case_id].includes(c.case_id));
      assert.deepEqual(missing.map((c) => [c.case_id, c.fee]), [[home.case_id, 60000]]);
      const again = await post('/api/invoices', { case_id: home.case_id }, MANAGER, 201);
      assert.equal(again.total, 60000);
      assert.equal(again.addons[0].ref, physio.case_id);
    });

    test('ต่อเคส: เลือกทีมที่ตามมาเองได้ ([] = ไม่เอาใคร) · คนที่รับงานไม่ได้ถูกกันทั้งคำขอ', async () => {
      for (const [id, status] of [['EMP-0084', 'active'], ['EMP-0085', 'active'], ['EMP-0086', 'on_leave']]) {
        await sql.run(
          `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
           VALUES (:id, 'Pick', :id, 'caregiver', :email, :status, 'x', false)`,
          { id, email: `${id.toLowerCase()}@example.invalid`, status },
        );
      }
      // เปิดเคสใหม่พร้อมทีมได้ด้วย (ไม่ใช่แค่ต่อเคส) — ทีมเข้าไปในทรานแซกชันเดียวกับเคส
      const first = await post('/api/cases', {
        case_type: 'other', client_name: 'Pick team', fee: 1000, assigned_to: FIELD.employee_id,
        team: ['EMP-0084', 'EMP-0085', FIELD.employee_id],
      }, MANAGER, 201);
      assert.equal(first.team_count, 2, 'คนหลักที่ส่งมาในทีมด้วยไม่ถูกใส่ซ้ำ');

      // คนที่ลาพักอยู่เข้าทีมไม่ได้ — ล้มทั้งคำขอ ไม่เกิดเคสครึ่งๆ
      const before = (await sql.one('SELECT COUNT(*)::int AS n FROM cases')).n;
      await post('/api/cases', {
        case_type: 'other', client_name: 'Pick team', renewed_from: first.case_id, team: ['EMP-0086'],
      }, MANAGER, 409);
      assert.equal((await sql.one('SELECT COUNT(*)::int AS n FROM cases')).n, before);

      // ติ๊กเอาไว้คนเดียว = ตามมาคนเดียว ไม่ใช่ทั้งทีมรอบก่อน
      const second = await post('/api/cases', {
        case_type: 'other', client_name: 'Pick team', assigned_to: FIELD.employee_id,
        renewed_from: first.case_id, team: ['EMP-0085'],
      }, MANAGER, 201);
      assert.deepEqual((await get(`/api/cases/${second.case_id}/team`, MANAGER)).body.map((t) => t.employee_id), ['EMP-0085']);
      const events = (await get(`/api/cases/${second.case_id}/events`, MANAGER)).body;
      assert.ok(events.some((e) => e.event === 'renewed'), 'ส่งทีมมาเองก็ยังจดว่าต่อจากรอบไหน');

      // ส่ง [] = ไม่เอาใครจากรอบก่อนเลย (ต่างจากไม่ส่ง ที่ทีมรอบก่อนตามมาทั้งหมด)
      await post(`/api/cases/${second.case_id}/cancel`, { reason: 'ทดสอบ' });
      const third = await post('/api/cases', {
        case_type: 'other', client_name: 'Pick team', renewed_from: first.case_id, team: [],
      }, MANAGER, 201);
      assert.equal(third.team_count, 0);
    });

    test('เปิดเคสด้วยผู้ว่าจ้างอย่างเดียว (ยังไม่รู้ชื่อผู้รับบริการ) ได้ — ไม่มีทั้งคู่ไม่ได้', async () => {
      const customer = await post('/api/customers', { name: 'ญาติโทรมาจอง', phone: '0812345678' }, MANAGER, 201);
      const c = await post('/api/cases', { case_type: 'other', customer_id: customer.customer_id, fee: 1500 }, MANAGER, 201);
      assert.equal(c.client_name, 'ยังไม่ระบุผู้รับบริการ');
      assert.equal(c.patient_id, null);
      assert.equal(c.customer_id, customer.customer_id);

      const [draft] = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
      assert.equal(draft.bill_to_name, 'ญาติโทรมาจอง');
      assert.equal(draft.total, 1500);
      assert.doesNotMatch(draft.service_description, /ยังไม่ระบุผู้รับบริการ/, 'ห้ามพิมพ์คำแทนชื่อลงใบที่ส่งลูกค้า');
      assert.equal(draft.patient_name, null, 'หัวใบโชว์ — ไม่ใช่คำแทนชื่อ');
      assert.equal(draft.patient_id, null);
      assert.equal(draft.is_stale, false);

      // ล้างชื่อตอนแก้เคส = กลับเป็นคำแทน (ไม่ชน NOT NULL) · ใส่ชื่อจริงทีหลังได้
      const res = await fetch(`${base}/api/cases/${c.case_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify({ client_name: null }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).client_name, 'ยังไม่ระบุผู้รับบริการ');

      const bad = await post('/api/cases', { case_type: 'other', fee: 1500 }, MANAGER, 400);
      assert.ok(bad.details.some((d) => d.field === 'client_name'));
    });

    test('รหัสผู้รับบริการ KN: ต้องกรอกตอนสร้าง · รูปแบบผิด/ซ้ำถูกปฏิเสธ · เปลี่ยนรหัสเดิมแล้วเคสตาม', async () => {
      const patch = async (path, body) => {
        const res = await fetch(`${base}${path}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };

      await post('/api/patients', { name: 'ไม่มีรหัส' }, MANAGER, 400);
      for (const bad of ['KN69020246', 'KN6902024630', 'kn690202463', 'PAT-0099', 'KN69O202463']) {
        await post('/api/patients', { patient_id: bad, name: 'รหัสผิด' }, MANAGER, 400);
      }
      const p = await post('/api/patients', { patient_id: 'KN691111111', name: 'ผู้รับบริการ KN' }, MANAGER, 201);
      assert.equal(p.patient_id, 'KN691111111');
      const dup = await post('/api/patients', { patient_id: 'KN691111111', name: 'ชื่ออื่น' }, MANAGER, 409);
      // ความสัมพันธ์ของผู้ว่าจ้างกับผู้รับบริการ — คอลัมน์ใหม่ บันทึกและอ่านกลับได้
      const rel = await patch('/api/patients/KN691111111', { employer_relation: 'บุตร' });
      assert.equal(rel.body.employer_relation, 'บุตร');
      // ตรวจซ้ำระหว่างกรอก (ฟอร์มผู้รับบริการ / เปิดเคส)
      assert.deepEqual((await get('/api/patients/check-id?id=KN691111111', MANAGER)).body, { valid: true, available: false, taken_by: 'ผู้รับบริการ KN' });
      assert.equal((await get('/api/patients/check-id?id=KN691111111&except=KN691111111', MANAGER)).body.available, true);
      assert.equal((await get('/api/patients/check-id?id=KN699999999', MANAGER)).body.available, true);
      assert.equal((await get('/api/patients/check-id?id=PAT-1', MANAGER)).body.valid, false);
      assert.match(dup.error, /มีอยู่แล้ว/);

      // แฟ้มเก่าแบบ PAT-xxxx: เปลี่ยนเป็นรหัส KN ได้ และเคสที่ผูกอยู่ตามรหัสใหม่ไปเอง
      await sql.run(`INSERT INTO patients (patient_id, name, status) VALUES ('PAT-0901', 'แฟ้มเก่า', 'active')`);
      const c = await post('/api/cases', { case_type: 'other', client_name: 'แฟ้มเก่า', patient_id: 'PAT-0901' }, MANAGER, 201);
      const renamed = await patch('/api/patients/PAT-0901', { patient_id: 'KN680000001', note: 'เปลี่ยนรหัส' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.patient_id, 'KN680000001');
      // รหัสเคส = รหัสผู้รับบริการ — เคสเดิม PAT-0901 ตามมาเป็น KN680000001
      assert.equal(c.case_id, 'PAT-0901');
      assert.equal((await get('/api/cases/PAT-0901', MANAGER)).status, 404);
      assert.equal((await get('/api/cases/KN680000001', MANAGER)).body.patient_id, 'KN680000001');
      // หัวใบแจ้งหนี้ของเคสนี้ขึ้นรหัส/ชื่อผู้รับบริการ (ตามรหัสใหม่ด้วย)
      const [caseInvoice] = (await get('/api/invoices?case_id=KN680000001', MANAGER)).body.data;
      assert.equal(caseInvoice.patient_id, 'KN680000001');
      assert.equal(caseInvoice.patient_name, 'แฟ้มเก่า');
      assert.equal((await get('/api/patients/PAT-0901', MANAGER)).status, 404);

      // เปลี่ยนไปชนรหัสของคนอื่นไม่ได้
      assert.equal((await patch('/api/patients/KN680000001', { patient_id: 'KN691111111' })).status, 409);
      // แก้ช่องอื่นอย่างเดียว รหัสไม่ขยับ
      assert.equal((await patch('/api/patients/KN691111111', { nickname: 'น้อย' })).body.patient_id, 'KN691111111');
    });

    test('ใส่ชื่อผู้รับบริการย้อนหลังในหน้าแก้เคส → สร้างแฟ้มผู้รับบริการและผูกกับเคส (ครั้งเดียว)', async () => {
      const patchCase = async (id, body) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, 200, JSON.stringify(data));
        return data;
      };
      const customer = await post('/api/customers', { name: 'ลูกชายผู้รับบริการ' }, MANAGER, 201);
      const c = await post('/api/cases', { case_type: 'other', customer_id: customer.customer_id }, MANAGER, 201);
      assert.equal(c.patient_id, null);

      // แก้อย่างอื่นโดยยังไม่ใส่ชื่อ = ยังไม่สร้างแฟ้ม
      assert.equal((await patchCase(c.case_id, { client_name: null, note: 'รอชื่อ' })).patient_id, null);

      // ได้ชื่อแต่ไม่มีรหัส KN = สร้างแฟ้มไม่ได้ (รหัสเป็นเลขที่เจ้าหน้าที่กรอก ระบบออกเองไม่ได้) และไม่บันทึกอะไรเลย
      const noCode = await fetch(`${base}/api/cases/${c.case_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify({ client_name: 'เจโค' }),
      });
      assert.equal(noCode.status, 400);
      assert.ok((await noCode.json()).details.some((d) => d.field === 'patient_code'));
      assert.equal((await get(`/api/cases/${c.case_id}`, MANAGER)).body.client_name, 'ยังไม่ระบุผู้รับบริการ');

      const named = await patchCase(c.case_id, {
        client_name: 'เจโค', patient_gender: 'male', patient_age: 81, medical_history: 'เบาหวาน', address: 'บางนา',
        patient_code: 'KN690202463',
      });
      assert.equal(named.patient_id, 'KN690202463');
      // ได้แฟ้มแล้ว รหัสเคสชั่วคราว CASE-xxxx เปลี่ยนเป็น KN ของผู้รับบริการ
      assert.equal(named.case_id, 'KN690202463');
      assert.equal((await get(`/api/cases/${c.case_id}`, MANAGER)).status, 404);
      const patient = await sql.one('SELECT * FROM patients WHERE patient_id = :id', { id: named.patient_id });
      assert.equal(patient.name, 'เจโค');
      assert.equal(patient.gender, 'male');
      assert.equal(patient.age, 81);
      assert.equal(patient.medical_history, 'เบาหวาน');
      assert.equal(patient.customer_id, customer.customer_id);

      const events = (await get(`/api/cases/${named.case_id}/events`, MANAGER)).body;
      assert.match(events.find((e) => e.event === 'edited').detail, new RegExp(`สร้างแฟ้มผู้รับบริการ ${named.patient_id}`));

      // แก้ชื่ออีกรอบ = แก้ snapshot ในเคสเฉยๆ ไม่สร้างแฟ้มซ้ำ
      const renamed = await patchCase(named.case_id, { client_name: 'เจโค ใจดี' });
      assert.equal(renamed.patient_id, named.patient_id);
      const { n } = await sql.one("SELECT COUNT(*)::int AS n FROM patients WHERE name LIKE 'เจโค%'");
      assert.equal(n, 1);
    });

    test('อุปกรณ์เสริม: บวกเข้าใบ ซิงก์ตามเคส ย้ายไปใบส่วนที่เหลือ และขึ้นป้ายเมื่อเปลี่ยนหลังแบ่งงวด', async () => {
      const patchCase = async (id, body) => {
        const res = await fetch(`${base}/api/cases/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, 200, JSON.stringify(data));
        return data;
      };
      const invoicesOf = async (id) => (await get(`/api/invoices?case_id=${id}`, MANAGER)).body.data;
      const bed = { name: 'เตียงลม', quantity: 1, unit_price: 3500 };
      const gloves = { name: 'ถุงมือ', quantity: 2, unit_price: 120.5 };

      const c = await post('/api/cases', { case_type: 'other', client_name: 'Addon patient', fee: 10000, addons: [bed, gloves] }, MANAGER, 201);
      assert.deepEqual(c.addons, [bed, gloves]);

      // ใบร่างที่ระบบออกให้ตอนเปิดเคส = ค่าบริการ + อุปกรณ์
      let [draft] = await invoicesOf(c.case_id);
      assert.equal(draft.total, 13741);
      assert.equal(draft.addons.length, 2);
      assert.equal(draft.is_stale, false);

      // แก้อุปกรณ์ → ใบร่างตาม + ประวัติบอกยอดเดิม → ใหม่
      await patchCase(c.case_id, { addons: [bed] });
      [draft] = await invoicesOf(c.case_id);
      assert.equal(draft.total, 13500);
      assert.deepEqual(draft.addons, [bed]);
      assert.equal(draft.is_stale, false);
      const edited = (await get(`/api/cases/${c.case_id}/events`, MANAGER)).body.filter((e) => e.event === 'edited');
      assert.match(edited[0].detail, /อุปกรณ์เสริม\/หัตถการ: 3,741 บาท → 3,500 บาท/);

      // ส่งรายการเดิมซ้ำ (ฟอร์มส่งมาทั้งชุด) ต้องไม่นับว่าแก้อุปกรณ์
      await patchCase(c.case_id, { addons: [bed], note: 'แก้แค่หมายเหตุ' });
      const edited2 = (await get(`/api/cases/${c.case_id}/events`, MANAGER)).body.filter((e) => e.event === 'edited');
      assert.equal(edited2.length, edited.length + 1);
      assert.doesNotMatch(edited2[0].detail, /อุปกรณ์เสริม/);

      // แบ่งมัดจำ → อุปกรณ์ย้ายไปอยู่ใบส่วนที่เหลือ ยอดรวมสองใบยังเท่าเดิม
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 5000 });
      const plan = await invoicesOf(c.case_id);
      const deposit = plan.find((v) => v.billing_kind === 'deposit');
      const balance = plan.find((v) => v.billing_kind === 'balance');
      assert.equal(deposit.total, 5000);
      assert.deepEqual(deposit.addons, []);
      assert.equal(balance.total, 8500);
      assert.deepEqual(balance.addons, [bed]);
      assert.ok(plan.every((v) => !v.is_stale));

      /* เพิ่มอุปกรณ์หลังแบ่งงวด → ใบงวดไม่ซิงก์และไม่ขึ้นป้าย "แพ็คเกจไม่ตรง" (ดร.ธงชัย 4 พ.ย. 2569)
         ของที่เพิ่มรอให้แอดมินออกเป็นใบค่าใช้จ่ายเพิ่มเติมแยก (ฝั่งแถวกับตัวกรอง SQL ต้องตรงกัน) */
      await patchCase(c.case_id, { addons: [bed, gloves] });
      const after = await invoicesOf(c.case_id);
      assert.equal(after.find((v) => v.billing_kind === 'balance').total, 8500);
      assert.ok(after.every((v) => !v.is_stale));
      assert.equal((await get(`/api/invoices?case_id=${c.case_id}&stale=yes`, MANAGER)).body.data.length, 0);

      const pending = (await get(`/api/invoices/extras?case_id=${c.case_id}`, MANAGER)).body;
      assert.deepEqual(pending.items, [gloves]);
      assert.equal(pending.total, 241);
      const listed = (await get('/api/invoices/cases-with-extras', MANAGER)).body;
      assert.ok(listed.some((x) => x.case_id === c.case_id));

      const extra = await post('/api/invoices/extras', { case_id: c.case_id }, MANAGER, 201);
      assert.equal(extra.billing_kind, 'extra');
      assert.equal(extra.status, 'draft');
      assert.equal(extra.total, 241);
      assert.deepEqual(extra.addons, [gloves]);
      assert.equal(extra.items.length, 1);
      assert.equal(extra.needs_plan, false);
      assert.equal(extra.is_stale, false);
      // ใบงวดเดิมไม่ถูกแตะ
      assert.equal((await invoicesOf(c.case_id)).find((v) => v.billing_kind === 'balance').total, 8500);

      // ออกไปแล้ว = ไม่มีรายการค้าง กดซ้ำได้ 409 ไม่ใช่ใบซ้ำ
      assert.deepEqual((await get(`/api/invoices/extras?case_id=${c.case_id}`, MANAGER)).body.items, []);
      await post('/api/invoices/extras', { case_id: c.case_id }, MANAGER, 409);

      // เพิ่มจำนวนถุงมือ → ค้างเก็บเฉพาะส่วนที่เพิ่ม
      await patchCase(c.case_id, { addons: [bed, { ...gloves, quantity: 3 }] });
      assert.deepEqual(
        (await get(`/api/invoices/extras?case_id=${c.case_id}`, MANAGER)).body.items,
        [{ ...gloves, quantity: 1 }],
      );

      // ลบใบค่าใช้จ่ายเพิ่มเติม (ยังเป็นร่าง) → รายการกลับมาค้างเก็บครบ
      const del = await fetch(`${base}/api/invoices/${extra.invoice_id}`, {
        method: 'DELETE', headers: { cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
      });
      assert.equal(del.status, 200);
      assert.deepEqual(
        (await get(`/api/invoices/extras?case_id=${c.case_id}`, MANAGER)).body.items,
        [{ ...gloves, quantity: 3 }],
      );
    });

    test('ใบค่าใช้จ่ายเพิ่มเติม: ใบแพ็คเกจที่ยังร่างไม่ดึงอุปกรณ์ที่ออกใบแยกไปแล้วกลับเข้ามาตอนรีเฟรช', async () => {
      const bed = { name: 'เตียงลม', quantity: 1, unit_price: 3500 };
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Extra refresh', fee: 10000 }, MANAGER, 201);
      const [draft] = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
      // ใบแพ็คเกจออกแล้ว — อุปกรณ์ที่เพิ่มทีหลังไม่เข้าใบนี้
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${draft.invoice_id}/issue`, {});

      const res = await fetch(`${base}/api/cases/${c.case_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify({ addons: [bed] }),
      });
      assert.equal(res.status, 200);

      const pkg = (await get(`/api/invoices/${draft.invoice_id}`, MANAGER)).body;
      assert.equal(pkg.total, 10000);
      assert.equal(pkg.is_stale, false, 'package invoice stays correct — the bed goes on its own invoice');

      const extra = await post('/api/invoices/extras', { case_id: c.case_id }, MANAGER, 201);
      assert.equal(extra.total, 3500);

      // ยกเลิกใบแพ็คเกจแล้วออกใหม่ → ใบใหม่มีแค่ค่าบริการ ไม่เก็บเตียงซ้ำกับใบค่าใช้จ่ายเพิ่มเติม
      await post(`/api/invoices/${draft.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' });
      const reissued = await post('/api/invoices', { case_id: c.case_id }, MANAGER, 201);
      assert.equal(reissued.total, 10000);
      assert.deepEqual(reissued.addons, []);
    });

    test('อุปกรณ์เสริม: เคสที่ไม่ตั้งค่าบริการ ยอดใบ = ค่าอุปกรณ์ล้วน และป้ายยอดไม่ตรงทำงาน', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Addon only',
        addons: [{ name: 'รถเข็น', quantity: 1, unit_price: 500 }] }, MANAGER, 201);
      const [draft] = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
      assert.equal(draft.total, 500);
      assert.equal(draft.is_stale, false);

      await sql.run('UPDATE invoices SET amount = 0, total = 0 WHERE invoice_id = :id', { id: draft.invoice_id });
      const row = (await get(`/api/invoices/${draft.invoice_id}`, MANAGER)).body;
      assert.equal(row.fee_stale, true);
      assert.equal(row.case_fee, 500);
      const flagged = (await get(`/api/invoices?case_id=${c.case_id}&stale=yes`, MANAGER)).body.data;
      assert.equal(flagged.length, 1, 'SQL stale filter must agree with the row flag');

      // เคสที่ไม่มีทั้งค่าบริการและอุปกรณ์ ยังไม่ขึ้นป้าย (เหมือนก่อนมีฟีเจอร์นี้)
      const bare = await post('/api/cases', { case_type: 'other', client_name: 'No price' }, MANAGER, 201);
      const [bareDraft] = (await get(`/api/invoices?case_id=${bare.case_id}`, MANAGER)).body.data;
      assert.equal(bareDraft.total, 0);
      assert.equal(bareDraft.is_stale, false);
    });

    test('อุปกรณ์เสริม: ใบตามกะใส่บรรทัดอุปกรณ์ครั้งเดียว ใบรอบถัดไปไม่เก็บซ้ำ', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Addon visits', fee: 2000,
        addons: [{ name: 'เตียงลม', quantity: 1, unit_price: 3500 }] }, MANAGER, 201);
      const [draft] = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
      const del = await fetch(`${base}/api/invoices/${draft.invoice_id}`, {
        method: 'DELETE', headers: { cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
      });
      assert.equal(del.status, 200);

      for (const d of ['2026-01-05', '2026-01-06']) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, 'done', (:d || ' 08:00:00+07')::timestamptz, (:d || ' 16:00:00+07')::timestamptz)`,
          { id: c.case_id, d },
        );
      }

      const first = await post('/api/invoices', { case_id: c.case_id, basis: 'visits', to: '2026-01-05' }, MANAGER, 201);
      assert.equal(first.items.length, 2);
      assert.equal(first.items[1].description, 'อุปกรณ์เสริม: เตียงลม');
      assert.equal(first.total, 1000 + 3500);
      assert.equal(first.addons.length, 1);

      await post(`/api/invoices/${first.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${first.invoice_id}/issue`, {});

      const second = await post('/api/invoices', { case_id: c.case_id, basis: 'visits', from: '2026-01-06' }, MANAGER, 201);
      assert.equal(second.items.length, 1, 'อุปกรณ์เก็บไปแล้วในใบแรก ห้ามเก็บซ้ำ');
      assert.equal(second.total, 1000);
      assert.deepEqual(second.addons, []);
    });

    test('case wages require release; attendance approval and closing do not create payouts', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const schedule = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [today], assigned_to: FIELD.employee_id }, MANAGER, 201);
      const visit = schedule.visits[0];
      await post(`/api/my/visits/${visit.visit_id}/check-in`, {}, FIELD, 400);
      const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';
      await post(`/api/my/visits/${visit.visit_id}/check-in`, { photo }, FIELD);
      assert.equal((await casesRepo.findById(c.case_id)).status, 'in_progress');
      await post(`/api/my/visits/${visit.visit_id}/check-in`, {}, FIELD, 409);
      await post(`/api/my/visits/${visit.visit_id}/check-out`, {}, FIELD);
      await post('/api/cases/attendance/decide', { visit_ids: [visit.visit_id], approve: true });
      assert.equal((await casesRepo.payStatus(c.case_id)).released, 0);
      await post(`/api/cases/${c.case_id}/close`, {});
      assert.equal((await casesRepo.payStatus(c.case_id)).released, 0);
      await post(`/api/cases/${c.case_id}/pay/release`, { request_id: randomUUID(), amount: 1200 }, HR, 403);
      const releaseRequestId = randomUUID();
      await post(`/api/cases/${c.case_id}/pay/release`, { request_id: releaseRequestId, amount: 1200 }, MANAGER, 201);
      await post(`/api/cases/${c.case_id}/pay/release`, { request_id: releaseRequestId, amount: 1200 }, MANAGER, 200);
      assert.equal((await casesRepo.payStatus(c.case_id)).released, 1200);
      await post(`/api/cases/${c.case_id}/pay/release`, { request_id: randomUUID(), amount: 1 }, MANAGER, 400);
      const run = await post('/api/payroll', { period_to: today }, MANAGER, 201);
      assert.equal(Number(run.total_pay), 1200);
      assert.equal((await post(`/api/payroll/${run.run_id}/pay`, {})).status, 'paid');
      await post(`/api/payroll/${run.run_id}/pay`, {}, MANAGER, 409);
      const next = await post('/api/payroll', { period_to: today }, MANAGER, 201);
      assert.equal(Number(next.total_pay), 0, 'paid wages must not be picked up twice');
    });

    test('employee-cases lists a case paid this month even without shifts this month', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${c.case_id}/pay/release`, { request_id: randomUUID(), amount: 900 }, MANAGER, 201);
      const { month } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM') AS month`);
      const res = await get(`/api/payroll/employee-cases?month=${month}&employee_id=${FIELD.employee_id}`, MANAGER);
      assert.equal(res.status, 200);
      const row = res.body.find((r) => r.case_id === c.case_id);
      assert.ok(row, 'case with pay released this month must be listed');
      assert.equal(row.pay, 900);
      assert.equal(row.shifts, 0);
    });
  });

  describe('ช่องโหว่ที่ปิดแล้ว (6 พ.ย. 2569): ข้อมูลภาคสนาม · ลบกะย้อนหลัง · แก้เคสที่จบ · ตรวจตำแหน่ง', () => {
    const MATE = 'EMP-0097';
    const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';
    const dayTH = async (offset) =>
      (await sql.one(
        `SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date + :offset::int, 'YYYY-MM-DD') AS d`,
        { offset },
      )).d;
    async function send(method, path, body, who = MANAGER) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    before(async () => {
      await sql.run(
        `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
         VALUES (:id, 'Mate', 'Field', 'caregiver', 'emp-0097@example.invalid', 'active', 'x', false)
         ON CONFLICT (employee_id) DO NOTHING`,
        { id: MATE },
      );
    });

    test('พนักงานภาคสนามไม่เห็นราคาอุปกรณ์/ราคาบริการ และไม่เห็นค่าจ้าง-เวลาสายของเพื่อนร่วมเคส', async () => {
      const c = await post('/api/cases', {
        case_type: 'other', client_name: 'Field privacy', fee: 3000,
        addons: [{ name: 'เตียงลม', quantity: 1, unit_price: 1500 }],
      }, MANAGER, 201);
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      const today = await dayTH(0);
      const mine = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [today], assigned_to: FIELD.employee_id }, MANAGER, 201);
      const theirs = await post(`/api/cases/${c.case_id}/visits/bulk`, {
        dates: [today], assigned_to: MATE, planned_start: '20:00', planned_end: '23:00',
      }, MANAGER, 201);
      const mateVisit = theirs.visits.find((v) => v.assigned_to === MATE);
      await sql.run(
        `UPDATE case_visits SET pay_status = 'rejected', pay_note = 'มาสาย', check_in_late_minutes = 45 WHERE visit_id = :id`,
        { id: mateVisit.visit_id },
      );
      await sql.run(`UPDATE case_visits SET pay_status = 'rejected', pay_note = 'ของฉัน' WHERE visit_id = :id`,
        { id: mine.visits.find((v) => v.assigned_to === FIELD.employee_id).visit_id });

      const res = await get(`/api/my/cases/${c.case_id}`, FIELD);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.addons.length, 1);
      assert.equal(res.body.addons[0].name, 'เตียงลม');
      assert.ok(!('unit_price' in res.body.addons[0]), 'ราคาอุปกรณ์ต้องไม่ถึงพนักงาน');
      assert.ok(!('service_list_price_snapshot' in res.body));
      assert.ok(!('service_customer_price_snapshot' in res.body));
      assert.ok(!('fee' in res.body));

      const other = res.body.visits.find((v) => v.visit_id === mateVisit.visit_id);
      assert.ok(other, 'ยังเห็นว่าเพื่อนเข้ากะไหน');
      for (const f of ['pay_status', 'pay_note', 'approved_by_name', 'check_in_late_minutes', 'location_flagged', 'location_note']) {
        assert.ok(!(f in other), `${f} ของเพื่อนต้องไม่ถูกส่งมา`);
      }
      const own = res.body.visits.find((v) => v.assigned_to === FIELD.employee_id);
      assert.equal(own.pay_note, 'ของฉัน', 'กะของตัวเองยังเห็นครบ');
    });

    test('กะที่ผ่านมาแล้วลบไม่ได้ (ให้ยกเลิกแทน) · ลบกะที่ยังไม่ถึงได้และบันทึกว่าใครลบ', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      const [yesterday, tomorrow] = [await dayTH(-1), await dayTH(1)];
      const added = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [yesterday, tomorrow], assigned_to: FIELD.employee_id }, MANAGER, 201);
      const past = added.visits.find((v) => v.visit_date === yesterday);
      const future = added.visits.find((v) => v.visit_date === tomorrow);

      const blocked = await send('DELETE', `/api/cases/${c.case_id}/visits/${past.visit_id}`);
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      const bulk = await send('DELETE', `/api/cases/${c.case_id}/visits?dates=${yesterday}`);
      assert.equal(bulk.status, 200);
      assert.equal(bulk.body.deleted, 0);
      assert.equal(bulk.body.past, 1);
      assert.ok(await sql.one('SELECT 1 FROM case_visits WHERE visit_id = :id', { id: past.visit_id }), 'กะที่ขาดงานยังอยู่');

      const cancelled = await send('PATCH', `/api/cases/${c.case_id}/visits/${past.visit_id}`, { status: 'cancelled' });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

      const removed = await send('DELETE', `/api/cases/${c.case_id}/visits/${future.visit_id}`);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      const ev = await sql.one(
        `SELECT actor_id, detail FROM case_events WHERE case_id = :id AND event = 'visit_removed'`,
        { id: c.case_id },
      );
      assert.equal(ev.actor_id, MANAGER.employee_id);
      assert.match(ev.detail, new RegExp(tomorrow));
    });

    test('ยกเลิกนัดทั้งหมด: ลบเฉพาะนัดที่ยังไม่ถึงวันและยังไม่เช็คอิน · ต้องมีเหตุผล · แจ้ง LINE รายนัดพร้อมเหตุผล', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      const [yesterday, today, d1, d2] = [await dayTH(-1), await dayTH(0), await dayTH(1), await dayTH(2)];
      const added = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [yesterday, today, d1, d2], assigned_to: FIELD.employee_id }, MANAGER, 201);
      const onToday = added.visits.find((v) => v.visit_date === today);
      await sql.run('UPDATE case_visits SET check_in_at = now() WHERE visit_id = :id', { id: onToday.visit_id });

      const noReason = await send('POST', `/api/cases/${c.case_id}/visits/cancel-upcoming`, {});
      assert.equal(noReason.status, 400, JSON.stringify(noReason.body));

      const res = await send('POST', `/api/cases/${c.case_id}/visits/cancel-upcoming`, { reason: 'เข้าโรงพยาบาล' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.deleted, 2, 'พรุ่งนี้ + มะรืน');
      assert.equal(res.body.kept, 1, 'วันนี้เช็คอินแล้ว เก็บไว้');
      assert.deepEqual(res.body.visits.map((v) => v.visit_date).sort(), [yesterday, today], 'นัดที่ผ่านมาแล้ว (ขาดงาน) ยังอยู่');

      const outbox = await sql.all(
        `SELECT kind, old_date, reason FROM visit_change_outbox WHERE case_id = :id ORDER BY old_date`,
        { id: c.case_id },
      );
      assert.deepEqual(outbox.map((o) => [o.kind, o.old_date, o.reason]), [
        ['cancelled', d1, 'เข้าโรงพยาบาล'], ['cancelled', d2, 'เข้าโรงพยาบาล'],
      ]);
      const ev = await sql.one(
        `SELECT detail FROM case_events WHERE case_id = :id AND event = 'visit_removed'`,
        { id: c.case_id },
      );
      assert.match(ev.detail, /ยกเลิกนัดทั้งหมด/);
      assert.match(ev.detail, /เข้าโรงพยาบาล/);
    });

    test('เคสที่ปิดแล้ว: แก้ค่าบริการ/ค่าจ้าง/วันที่/อุปกรณ์ไม่ได้ · แก้หมายเหตุได้', async () => {
      const c = await post('/api/cases', {
        case_type: 'other', client_name: 'Closed lock', fee: 2000, staff_pay: 1200,
        start_date: '2026-01-01', end_date: '2026-01-31',
        addons: [{ name: 'รถเข็น', quantity: 1, unit_price: 500 }],
      }, MANAGER, 201);
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${c.case_id}/close`, { force: true });
      const closed = await casesRepo.findById(c.case_id);
      assert.equal(closed.status, 'closed');

      for (const body of [
        { fee: 2500 },
        { staff_pay: 1500 },
        { end_date: '2026-02-28' },
        { addons: [{ name: 'รถเข็น', quantity: 1, unit_price: 900 }] },
      ]) {
        const r = await send('PATCH', `/api/cases/${c.case_id}`, body);
        assert.equal(r.status, 409, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      }
      // ฟอร์มเต็มส่งค่าเดิมกลับมา (ไม่ได้เปลี่ยนจริง) + แก้หมายเหตุ = ผ่าน
      const ok = await send('PATCH', `/api/cases/${c.case_id}`, {
        note: 'บันทึกหลังปิดเคส', fee: closed.fee, end_date: closed.end_date,
        addons: [{ name: 'รถเข็น', quantity: 1, unit_price: 500 }],
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await casesRepo.findById(c.case_id)).note, 'บันทึกหลังปิดเคส');
    });

    test('ตรวจตำแหน่ง: เคสไม่มีพิกัด/GPS คลาดกว้าง/ออกนอกพื้นที่ ขึ้นธงพร้อมเหตุผล · กะค้างเกิน 24 ชม. เช็คเอาท์เองไม่ได้', async () => {
      const today = await dayTH(0);
      const shift = async (geo) => {
        const c = await newCase();
        await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
        if (geo) {
          await sql.run(
            'UPDATE cases SET geo_lat = 13.8, geo_lng = 100.6, geofence_radius_m = 200 WHERE case_id = :id',
            { id: c.case_id },
          );
        }
        const s = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [today], assigned_to: FIELD.employee_id }, MANAGER, 201);
        return s.visits[0].visit_id;
      };
      const row = (id) => sql.one('SELECT location_flagged, location_note, check_out_distance_m FROM case_visits WHERE visit_id = :id', { id });

      const noGeo = await shift(false);
      await post(`/api/my/visits/${noGeo}/check-in`, { photo, lat: 13.8, lng: 100.6, accuracy: 10 }, FIELD);
      assert.deepEqual(await row(noGeo), { location_flagged: true, location_note: 'เข้า: เคสยังไม่ตั้งพิกัด', check_out_distance_m: null });

      const fuzzy = await shift(true);
      await post(`/api/my/visits/${fuzzy}/check-in`, { photo, lat: 13.8, lng: 100.6, accuracy: 1500 }, FIELD);
      assert.match((await row(fuzzy)).location_note, /^เข้า: GPS คลาด/);

      const leftEarly = await shift(true);
      await post(`/api/my/visits/${leftEarly}/check-in`, { photo, lat: 13.8, lng: 100.6, accuracy: 10 }, FIELD);
      assert.equal((await row(leftEarly)).location_flagged, false, 'เข้าในพื้นที่ GPS แม่น = ไม่ขึ้นธง');
      await sql.run("UPDATE case_visits SET check_in_at = now() - interval '1 minute' WHERE visit_id = :id", { id: leftEarly });
      await post(`/api/my/visits/${leftEarly}/check-out`, { lat: 13.82, lng: 100.6, accuracy: 10 }, FIELD);
      const out = await row(leftEarly);
      assert.equal(out.location_flagged, true);
      assert.match(out.location_note, /^ออก: ห่าง/);
      assert.ok(out.check_out_distance_m > 2000);

      const stale = await shift(true);
      await post(`/api/my/visits/${stale}/check-in`, { photo, lat: 13.8, lng: 100.6, accuracy: 10 }, FIELD);
      await sql.run("UPDATE case_visits SET check_in_at = now() - interval '25 hours' WHERE visit_id = :id", { id: stale });
      await post(`/api/my/visits/${stale}/check-out`, {}, FIELD, 409);
    });
  });

  describe('ตรวจรอบ 6 พ.ย. 2569 ชุดสอง: แพ็กเกจ · สิทธิ์หลังปิดเคส · แก้กะ · รอบจ่าย · วันที่เคส', () => {
    const dayTH = async (offset = 0) =>
      (await sql.one(
        `SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date + :offset::int, 'YYYY-MM-DD') AS d`,
        { offset },
      )).d;
    async function send(method, path, body, who = MANAGER) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    test('ลบเกรด/รูปแบบที่มีเคสใช้อยู่ไม่ได้ · ที่ไม่มีเคสใช้ลบได้', async () => {
      const grade = await post('/api/packages/grades', { name: `เกรดทดสอบ ${randomUUID().slice(0, 6)}` }, MANAGER, 201);
      const format = await post('/api/packages/formats', { name: `รูปแบบทดสอบ ${randomUUID().slice(0, 6)}` }, MANAGER, 201);
      const c = await newCase();
      await sql.run('UPDATE cases SET pkg_grade_id = :g, pkg_format_id = :f WHERE case_id = :id',
        { g: grade.grade_id, f: format.format_id, id: c.case_id });

      const g = await send('DELETE', `/api/packages/grades/${grade.grade_id}`);
      assert.equal(g.status, 409, JSON.stringify(g.body));
      assert.match(g.body.error, /มีเคสใช้อยู่ 1 เคส/);
      assert.equal((await send('DELETE', `/api/packages/formats/${format.format_id}`)).status, 409);

      await sql.run('UPDATE cases SET pkg_grade_id = NULL, pkg_format_id = NULL WHERE case_id = :id', { id: c.case_id });
      assert.equal((await send('DELETE', `/api/packages/grades/${grade.grade_id}`)).status, 204);
      assert.equal((await send('DELETE', `/api/packages/formats/${format.format_id}`)).status, 204);
    });

    test('ผู้รับผิดชอบหลักเปิดเคสที่ปิดแล้วได้ 30 วัน · หน้าประวัติการมาทำงานไม่มีข้อมูลสุขภาพ', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await sql.run(
        `UPDATE cases SET medical_history = 'เบาหวาน', address = '99 ถนนทดสอบ', client_phone = '0812345678' WHERE case_id = :id`,
        { id: c.case_id },
      );
      const today = await dayTH(0);
      await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [today], assigned_to: FIELD.employee_id }, MANAGER, 201);

      const att = await get(`/api/my/attendance?month=${today.slice(0, 7)}`, FIELD);
      const row = att.body.find((v) => v.case_id === c.case_id);
      assert.ok(row, 'กะของตัวเองยังอยู่ในประวัติ');
      assert.equal(row.client_name, 'Workflow patient');
      for (const f of ['medical_history', 'address', 'client_phone', 'current_symptoms', 'case_geo_lat']) {
        assert.ok(!(f in row), `${f} ต้องไม่อยู่ในประวัติการมาทำงาน`);
      }

      await post(`/api/cases/${c.case_id}/close`, { force: true });
      assert.equal((await get(`/api/my/cases/${c.case_id}`, FIELD)).status, 200, 'เพิ่งปิด = ยังเปิดได้');
      // ย้อนวันปิด/กะออกไปเกิน 30 วัน — ทั้งทางผู้รับผิดชอบหลักและทางกะต้องหมดสิทธิ์
      await sql.run(
        `UPDATE cases SET closed_at = '2020-01-01 00:00:00' WHERE case_id = :id`, { id: c.case_id });
      await sql.run(`UPDATE case_visits SET visit_date = '2020-01-01' WHERE case_id = :id`, { id: c.case_id });
      assert.equal((await get(`/api/my/cases/${c.case_id}`, FIELD)).status, 404);
      assert.ok(!(await get('/api/my/cases', FIELD)).body.some((x) => x.case_id === c.case_id));
    });

    test('มาสาย → บันทึกเวลามาถึงจริง: แก้แค่เวลาเข้า ระบบคิดนาทีที่สายใหม่ · เวลาออกไม่ถูกแตะ', async () => {
      const c = await newCase();
      const yesterday = await dayTH(-1);
      const s = await post(`/api/cases/${c.case_id}/visits/bulk`,
        { dates: [yesterday], assigned_to: FIELD.employee_id, planned_start: '09:00', planned_end: '17:00' }, MANAGER, 201);
      const v = s.visits[0];
      const path = `/api/cases/${c.case_id}/visits/${v.visit_id}/adjust`;
      // เช็คอินช้า 95 นาที + เช็คเอาท์แล้ว
      await sql.run(`UPDATE case_visits SET check_in_at = :in, checked_in_by = :emp, check_in_late_minutes = 95, off_schedule = FALSE,
                     check_out_at = :out, status = 'done' WHERE visit_id = :id`,
        { in: `${yesterday}T10:35:00+07:00`, out: `${yesterday}T17:00:00+07:00`, emp: FIELD.employee_id, id: v.visit_id });
      const row = () => sql.one('SELECT check_in_late_minutes AS late, off_schedule, check_out_at FROM case_visits WHERE visit_id = :id', { id: v.visit_id });
      const outBefore = (await row()).check_out_at;

      const r1 = await send('PATCH', path, { check_in_at: `${yesterday}T09:05:00+07:00`, reason: 'มาถึงตรงเวลา แต่กดเช็คอินช้า' }, MANAGER);
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal((await row()).late, 5);
      assert.equal(String((await row()).check_out_at), String(outBefore), 'เวลาออกเดิม');

      await send('PATCH', path, { check_in_at: `${yesterday}T08:50:00+07:00`, reason: 'มาก่อนเวลา' }, MANAGER);
      assert.equal((await row()).late, 0);
      assert.ok(!(await get('/api/cases/attendance/exceptions', MANAGER)).body?.some?.((x) => x.visit_id === v.visit_id),
        'ไม่สายแล้ว = ไม่อยู่ในรายการต้องตรวจ');

      // เวลาเข้าหลังเวลาออก = ปฏิเสธ
      assert.equal((await send('PATCH', path, { check_in_at: `${yesterday}T18:00:00+07:00`, reason: 'ทดสอบ' }, MANAGER)).status, 400);
    });

    test('แก้เวลากะต้องมีเหตุผล และประวัติเก็บค่าเดิม → ค่าใหม่', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      const yesterday = await dayTH(-1);
      const s = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [yesterday], assigned_to: FIELD.employee_id }, MANAGER, 201);
      const v = s.visits[0];
      const times = {
        check_in_at: `${yesterday}T09:00:00+07:00`,
        check_out_at: `${yesterday}T17:00:00+07:00`,
        status: 'done',
      };
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}/visits/${v.visit_id}/adjust`, times, HR)).status, 400);
      const ok = await send('PATCH', `/api/cases/${c.case_id}/visits/${v.visit_id}/adjust`, { ...times, reason: 'ลืมเช็คอิน' }, HR);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const ev = await sql.one(
        `SELECT detail, actor_id FROM case_events WHERE case_id = :id AND event = 'visit_adjusted' ORDER BY event_id DESC LIMIT 1`,
        { id: c.case_id },
      );
      assert.equal(ev.actor_id, HR.employee_id, 'HR ยังแก้ได้');
      assert.match(ev.detail, /เวลาเข้า — → \d{4}-\d{2}-\d{2} 09:00/);
      assert.match(ev.detail, /เหตุผล: ลืมเช็คอิน/);
      // เคลียร์ธงอย่างเดียวไม่ต้องใส่เหตุผล
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}/visits/${v.visit_id}/adjust`, { location_flagged: false }, HR)).status, 200);
    });

    test('บันทึกจ่ายรอบ: ยอดเปลี่ยนจากที่เห็น = 409 · ยอดตรง = จ่ายได้ · ยกเลิกรอบเก็บชื่อคนยกเลิก', async () => {
      const today = await dayTH(0);
      for (const d of (await get('/api/payroll?status=draft', MANAGER)).body) {
        await post(`/api/payroll/${d.run_id}/cancel`, {});
      }
      const release = async (amount) => {
        const c = await newCase();
        await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
        await post(`/api/cases/${c.case_id}/pay/release`, { request_id: randomUUID(), amount }, MANAGER, 201);
      };
      await release(700);
      const first = await post('/api/payroll', { period_to: today }, MANAGER, 201);
      const cancelled = await post(`/api/payroll/${first.run_id}/cancel`, {});
      assert.equal(cancelled.status, 'cancelled');
      const row = await sql.one('SELECT cancelled_by, cancelled_at FROM payroll_runs WHERE run_id = :id', { id: first.run_id });
      assert.equal(row.cancelled_by, MANAGER.employee_id);
      assert.ok(row.cancelled_at);

      const run = await post('/api/payroll', { period_to: today }, MANAGER, 201);
      const seen = Number(run.total_pay);
      await release(300);
      await post(`/api/payroll/${run.run_id}/rebuild`, {});
      const stale = await post(`/api/payroll/${run.run_id}/pay`, { expected_total: seen }, MANAGER, 409);
      assert.match(stale.error, /ยอดของรอบนี้เปลี่ยน/);
      const fresh = (await get(`/api/payroll/${run.run_id}`, MANAGER)).body;
      assert.equal(Number(fresh.total_pay), seen + 300);
      assert.equal((await post(`/api/payroll/${run.run_id}/pay`, { expected_total: Number(fresh.total_pay) })).status, 'paid');

      // คืนช่องรอบของเดือนนี้ (เดือนหนึ่งเปิดได้ 3 รอบ) ให้เทสต์รอบจ่ายชุดอื่นที่รันต่อจากนี้
      for (const id of [run.run_id, first.run_id]) {
        await sql.run('DELETE FROM payroll_payout_lines WHERE item_id IN (SELECT item_id FROM payroll_items WHERE run_id = :id)', { id });
        await sql.run('DELETE FROM payroll_items WHERE run_id = :id', { id });
        await sql.run('DELETE FROM payroll_runs WHERE run_id = :id', { id });
      }
    });

    test('วันสิ้นสุดก่อนวันเริ่ม = ไม่รับ ทั้งตอนเปิดเคสและตอนแก้', async () => {
      await post('/api/cases', {
        case_type: 'other', client_name: 'Bad dates', start_date: '2026-03-10', end_date: '2026-03-01',
      }, MANAGER, 400);
      const c = await post('/api/cases', {
        case_type: 'other', client_name: 'Good dates', start_date: '2026-03-01', end_date: '2026-03-31',
      }, MANAGER, 201);
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}`, { end_date: '2026-02-15' })).status, 400);
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}`, { end_date: '2026-04-15' })).status, 200);
    });
  });

  describe('จัดการสิทธิ์รายตำแหน่ง (/api/permissions)', () => {
    const FIN = emp('EMP-0098', 'finance');
    async function send(method, path, body, who = MANAGER) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }
    before(async () => {
      await sql.run(
        `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
         VALUES ('EMP-0098', 'Fin', 'Perm', 'finance', 'emp-0098@example.invalid', 'active', 'x', false)
         ON CONFLICT (employee_id) DO NOTHING`,
      );
    });

    test('เปิดได้เฉพาะ Super Admin/ผู้จัดการ · แก้ Super Admin ไม่ได้ · สิทธิ์ที่ไม่รู้จัก = 400', async () => {
      assert.equal((await send('GET', '/api/permissions', undefined, HR)).status, 403);
      const res = await send('GET', '/api/permissions');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.positions.map((p) => p.position).sort(), ['admin', 'finance', 'hr', 'manager', 'nurse_lead', 'super_admin']); // nurse_lead เพิ่ม 8 พ.ย. 2569 (c851870)
      const hr = res.body.positions.find((p) => p.position === 'hr');
      assert.ok(hr.permissions.includes('cases') && !hr.permissions.includes('payroll'), 'ค่าตั้งต้นเท่าสิทธิ์เดิม');
      assert.equal((await send('PUT', '/api/permissions/super_admin', { permissions: [] })).status, 403);
      assert.equal((await send('PUT', '/api/permissions/hr', { permissions: ['nope'] })).status, 400);
    });

    test('ตั้งแล้วมีผลกับด่าน API ทันที · คืนค่าตั้งต้นได้', async () => {
      assert.equal((await send('GET', '/api/payroll', undefined, FIN)).status, 200);
      assert.equal((await send('GET', '/api/invoices/revenue?bucket=day&points=2', undefined, HR)).status, 403);

      // เอาเมนูค่าตอบแทนออกจากการเงิน · ให้ HR เห็นรายได้
      const fin = (await send('GET', '/api/permissions')).body.positions.find((p) => p.position === 'finance');
      assert.equal((await send('PUT', '/api/permissions/finance', { permissions: fin.permissions.filter((k) => k !== 'payroll') })).status, 200);
      const hr = (await send('GET', '/api/permissions')).body.positions.find((p) => p.position === 'hr');
      assert.equal((await send('PUT', '/api/permissions/hr', { permissions: [...hr.permissions, 'revenue'] })).status, 200);

      assert.equal((await send('GET', '/api/payroll', undefined, FIN)).status, 403);
      assert.equal((await send('GET', '/api/invoices/revenue?bucket=day&points=2', undefined, HR)).status, 200);
      const me = await send('GET', '/api/auth/me', undefined, HR);
      assert.ok(me.body.permissions.includes('revenue') && me.body.permissions.includes('money'), 'session ได้สิทธิ์ใหม่ + หมวดที่คิดต่อ');

      // คืนค่าตั้งต้น
      assert.equal((await send('DELETE', '/api/permissions/finance')).status, 200);
      assert.equal((await send('DELETE', '/api/permissions/hr')).status, 200);
      assert.equal((await send('GET', '/api/payroll', undefined, FIN)).status, 200);
      assert.equal((await send('GET', '/api/invoices/revenue?bucket=day&points=2', undefined, HR)).status, 403);
    });
  });

  describe('ใบแจ้งหนี้: ซิงก์ตามเคส · ใบรายครั้ง · รายได้เงินสด · ยกเลิกแผนมัดจำ · สิทธิ์ยอดสรุป', () => {
    const HC = emp('EMP-0095', 'admin');

    before(async () => {
      await sql.run(
        `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
         VALUES ('EMP-0095', 'Billing', 'Admin', 'admin', 'emp-0095@example.invalid', 'active', 'x', false)
         ON CONFLICT (employee_id) DO NOTHING`,
      );
    });

    async function send(method, path, body, who = MANAGER) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }
    const draftOf = async (caseId) =>
      (await get(`/api/invoices?case_id=${caseId}`, MANAGER)).body.data.find((v) => v.status === 'draft');
    const invoice = async (id) => (await get(`/api/invoices/${id}`, MANAGER)).body;
    const pay = (id, body) => post(`/api/invoices/${id}/pay`, { request_id: crypto.randomUUID(), ...body });

    test('ออกใบจริงลงวันที่วันนี้ และไม่ยอมให้วันครบกำหนดก่อนวันออกใบ', async () => {
      const c = await newCase();
      const draft = await draftOf(c.case_id);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await sql.run(
        `UPDATE invoices SET issue_date = '2000-01-01', due_date = '2000-01-02' WHERE invoice_id = :id`,
        { id: draft.invoice_id },
      );
      const blocked = await send('POST', `/api/invoices/${draft.invoice_id}/issue`, {});
      assert.equal(blocked.status, 400);
      assert.match(blocked.body.error, /วันครบกำหนด/);

      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      await send('PATCH', `/api/invoices/${draft.invoice_id}`, { due_date: today });
      assert.equal((await send('POST', `/api/invoices/${draft.invoice_id}/issue`, {})).status, 200);
      assert.equal((await invoice(draft.invoice_id)).issue_date, today);
    });

    test('แก้เคส: ซิงก์เฉพาะตอนราคา/ผู้จ่ายเปลี่ยน · ใบที่แก้มือไม่ถูกทับ · รีเฟรชเองทับและล้างธง · ผู้จ่ายจากแฟ้มผู้รับบริการ', async () => {
      const customer = await post('/api/customers', { name: 'ผู้จ่ายจากแฟ้มผู้รับบริการ' }, MANAGER, 201);
      await sql.run(
        `INSERT INTO patients (patient_id, name, status, customer_id) VALUES ('KN690000951', 'ผู้รับบริการซิงก์', 'active', :cu)`,
        { cu: customer.customer_id },
      );
      const c = await post('/api/cases', { case_type: 'other', client_name: 'ผู้รับบริการซิงก์', patient_id: 'KN690000951', fee: 3000 }, MANAGER, 201);
      // เคสไม่มีผู้ว่าจ้างของตัวเอง — ผู้จ่ายต้องไล่ไปที่แฟ้มผู้รับบริการ
      await sql.run('UPDATE cases SET customer_id = NULL WHERE case_id = :id', { id: c.case_id });

      // แก้ค่าบริการ → ใบร่างตาม และชื่อผู้จ่ายยังเป็นลูกค้าของผู้รับบริการ (ของเดิมกลายเป็นชื่อผู้รับบริการ)
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}`, { fee: 3500 })).status, 200);
      let draft = await draftOf(c.case_id);
      assert.equal(draft.total, 3500);
      assert.equal(draft.bill_to_name, 'ผู้จ่ายจากแฟ้มผู้รับบริการ');
      assert.equal(draft.payer_stale, false);

      // ฝ่ายบัญชีให้ส่วนลดในใบเอง
      const edited = await send('PATCH', `/api/invoices/${draft.invoice_id}`, { discount: 500, note: 'ลดพิเศษ' });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.total, 3000);

      // แก้แค่หมายเหตุของเคส = ไม่แตะใบ
      await send('PATCH', `/api/cases/${c.case_id}`, { note: 'แก้หมายเหตุอย่างเดียว' });
      assert.equal((await invoice(draft.invoice_id)).discount, 500);

      // แก้ราคาเคส = ใบที่แก้มือไว้ต้องไม่ถูกทับ แต่ขึ้นป้ายไม่ตรงกับเคสให้คนตัดสินใจ
      await send('PATCH', `/api/cases/${c.case_id}`, { fee: 4000 });
      draft = await invoice(draft.invoice_id);
      assert.equal(draft.discount, 500);
      assert.equal(draft.total, 3000);
      assert.equal(draft.fee_stale, true);

      // กดดึงข้อมูลจากเคสเอง = ยอมให้เคสทับ และใบกลับมาซิงก์อัตโนมัติได้อีก
      const refreshed = await post(`/api/invoices/${draft.invoice_id}/refresh`, {});
      assert.equal(refreshed.total, 4000);
      assert.equal(refreshed.discount, 0);
      assert.equal(refreshed.bill_to_name, 'ผู้จ่ายจากแฟ้มผู้รับบริการ');
      assert.equal(refreshed.manual_edit, false);
      await send('PATCH', `/api/cases/${c.case_id}`, { fee: 4200 });
      assert.equal((await invoice(draft.invoice_id)).total, 4200);

      // บันทึกฟอร์มใบโดยส่งค่าเดิมกลับมาทั้งชุด ไม่นับเป็นการแก้มือ
      const same = await invoice(draft.invoice_id);
      await send('PATCH', `/api/invoices/${draft.invoice_id}`, {
        amount: same.amount, discount: same.discount, bill_to_name: same.bill_to_name, note: 'แก้โน้ตใบ',
      });
      assert.equal((await invoice(draft.invoice_id)).manual_edit, false);
    });

    test('ใบรายครั้ง: แบ่งมัดจำไม่ได้ · กะที่อยู่ในใบอื่นแล้วไม่ถูกเก็บซ้ำ · ยกเลิกใบแล้วออกกะเดิมได้อีก', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Visit billing', fee: 2000 }, MANAGER, 201);
      const auto = await draftOf(c.case_id);
      assert.equal((await send('DELETE', `/api/invoices/${auto.invoice_id}`)).status, 200);
      for (const d of ['2026-02-02', '2026-02-03']) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, 'done', (:d || ' 08:00:00+07')::timestamptz, (:d || ' 16:00:00+07')::timestamptz)`,
          { id: c.case_id, d },
        );
      }

      const first = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(first.items.length, 2);
      assert.equal(first.total, 2000);

      const split = await post(`/api/invoices/${first.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 500 }, MANAGER, 409);
      assert.match(split.error, /รายครั้ง/);
      assert.equal((await invoice(first.invoice_id)).billing_kind, null, 'ปฏิเสธแล้วใบต้องไม่ถูกแตะ');
      assert.equal((await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data.length, 1, 'ต้องไม่เกิดใบส่วนที่เหลือ');

      await post(`/api/invoices/${first.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${first.invoice_id}/issue`, {});

      // ช่วงวันซ้อนกับใบแรกทั้งหมด = ไม่มีกะเหลือให้เก็บ
      const again = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 409);
      assert.match(again.error, /ยังไม่ได้ออกใบ/);

      // ใบแรกยกเลิก = กะกลับมาเก็บเงินได้
      await post(`/api/invoices/${first.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' });
      const reissued = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(reissued.items.length, 2);
    });

    test('ใบรายครั้ง: กะที่ยกเลิกแล้วไม่ถูกเก็บเงิน และยอดรวมไม่ทะลุค่าบริการของเคส', async () => {
      // พนักงานเช็คอิน-เอาท์ครบทั้ง 4 วัน แล้วผู้จัดการยกเลิกกะ 2 วันทีหลัง (ลงวันผิด/ลูกค้าไม่อยู่บ้าน)
      // ตัวหารของราคาต่อครั้งนับเฉพาะกะที่ไม่ยกเลิก กะที่ยกเลิกจึงต้องไม่กลายเป็นบรรทัดในใบด้วย
      // ไม่งั้นได้ 4 บรรทัด × (2000/2) = 4,000 = เก็บลูกค้าเป็นสองเท่าของค่าบริการที่ตกลงไว้
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Cancelled visit billing', fee: 2000 }, MANAGER, 201);
      const auto = await draftOf(c.case_id);
      assert.equal((await send('DELETE', `/api/invoices/${auto.invoice_id}`)).status, 200);
      for (const [d, status] of [['2026-04-01', 'done'], ['2026-04-02', 'done'], ['2026-04-03', 'cancelled'], ['2026-04-04', 'cancelled']]) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, :st, (:d || ' 08:00:00+07')::timestamptz, (:d || ' 16:00:00+07')::timestamptz)`,
          { id: c.case_id, d, st: status },
        );
      }

      const billed = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(billed.items.length, 2, JSON.stringify(billed.items.map((i) => i.description)));
      assert.equal(billed.total, 2000);
      assert.ok(
        billed.items.every((i) => !i.description.includes('2026-04-03') && !i.description.includes('2026-04-04')),
        JSON.stringify(billed.items.map((i) => i.description)),
      );
    });

    test('ใบแพ็คเกจกับใบรายครั้งของเคสเดียวกันห้ามซ้อน — กันเก็บเงินลูกค้าซ้ำ (ตรวจ 13 พ.ย. 2569)', async () => {
      const addDone = (caseId, d) => sql.run(
        `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
         VALUES (:id, :d, 'done', (:d || ' 08:00:00+07')::timestamptz, (:d || ' 16:00:00+07')::timestamptz)`,
        { id: caseId, d },
      );

      // ทางที่ 1: ใบแพ็คเกจออกแล้ว → ออกใบตามกะต่อไม่ได้ (เดิมได้ใบยอดเต็มซ้ำอีกใบ)
      const a = await post('/api/cases', { case_type: 'other', client_name: 'Package then visits', fee: 2000 }, MANAGER, 201);
      const pkg = await draftOf(a.case_id);
      await post(`/api/invoices/${pkg.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${pkg.invoice_id}/issue`, {});
      await addDone(a.case_id, '2026-05-01');
      const byVisits = await post('/api/invoices', { case_id: a.case_id, basis: 'visits' }, MANAGER, 409);
      assert.equal(byVisits.existing_invoice_id ?? byVisits.details?.existing_invoice_id ?? pkg.invoice_id, pkg.invoice_id);

      // ทางที่ 2: เก็บตามกะไปแล้ว → ออกใบแพ็คเกจยอดเต็มไม่ได้
      const b = await post('/api/cases', { case_type: 'other', client_name: 'Visits then package', fee: 2000 }, MANAGER, 201);
      const auto = await draftOf(b.case_id);
      assert.equal((await send('DELETE', `/api/invoices/${auto.invoice_id}`)).status, 200);
      await addDone(b.case_id, '2026-05-01');
      await addDone(b.case_id, '2026-05-02');
      const v = await post('/api/invoices', { case_id: b.case_id, basis: 'visits', to: '2026-05-01' }, MANAGER, 201);
      await post(`/api/invoices/${v.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${v.invoice_id}/issue`, {});
      const full = await post('/api/invoices', { case_id: b.case_id }, MANAGER, 409);
      assert.match(full.error, /ออกใบตามกะไปแล้ว/);
      // ใบตามกะรอบถัดไปยังออกได้ตามปกติ
      await post('/api/invoices', { case_id: b.case_id, basis: 'visits' }, MANAGER, 201);
    });

    test('ใบรายครั้งชุดสุดท้ายที่ยอดค้างน้อยกว่าราคาต่อครั้ง — ไม่มีบรรทัดติดลบ ไม่ตอบ 500 (ตรวจ 13 พ.ย. 2569)', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Fee lowered', fee: 3000 }, MANAGER, 201);
      const auto = await draftOf(c.case_id);
      assert.equal((await send('DELETE', `/api/invoices/${auto.invoice_id}`)).status, 200);
      for (const d of ['2026-06-01', '2026-06-02', '2026-06-03']) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, 'done', (:d || ' 08:00:00+07')::timestamptz, (:d || ' 16:00:00+07')::timestamptz)`,
          { id: c.case_id, d },
        );
      }
      const first = await post('/api/invoices', { case_id: c.case_id, basis: 'visits', to: '2026-06-01' }, MANAGER, 201);
      assert.equal(first.total, 1000);
      await post(`/api/invoices/${first.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${first.invoice_id}/issue`, {});
      // ลดค่าบริการหลังออกใบรอบแรก: ค้าง 1,200 − 1,000 = 200 แต่ราคาต่อครั้ง 400 × 2 กะ
      await sql.run(
        'UPDATE cases SET fee = 1200, service_customer_price_snapshot = NULL WHERE case_id = :id',
        { id: c.case_id },
      );
      const last = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(last.total, 200);
      assert.ok(last.items.every((i) => i.amount >= 0), JSON.stringify(last.items));
      assert.equal(Math.round(last.items.reduce((s, i) => s + i.amount, 0) * 100) / 100, 200);
    });

    test('ใบรายครั้งของเคสที่ไม่มี fee แต่มีราคาที่จดไว้ — ราคาต่อครั้งไม่เป็น 0 (ตรวจ 13 พ.ย. 2569)', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Snapshot only', fee: 2000 }, MANAGER, 201);
      const auto = await draftOf(c.case_id);
      assert.equal((await send('DELETE', `/api/invoices/${auto.invoice_id}`)).status, 200);
      await sql.run(
        'UPDATE cases SET fee = NULL, service_customer_price_snapshot = 1800 WHERE case_id = :id',
        { id: c.case_id },
      );
      for (const d of ['2026-07-01', '2026-07-02']) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, 'done', (:d || ' 08:00:00+07')::timestamptz, (:d || ' 16:00:00+07')::timestamptz)`,
          { id: c.case_id, d },
        );
      }
      const billed = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(billed.total, 1800);
      assert.deepEqual(billed.items.map((i) => i.amount), [900, 900]);
    });

    test('รับเงินเข้าใบร่างของเคสที่ยกเลิกแล้วไม่ได้ (ตรวจ 13 พ.ย. 2569)', async () => {
      const c = await newCase();
      const draft = await draftOf(c.case_id);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      // ใบร่างที่หลุดรอดการยกเลิกตามเคส (เช่น เป็นงวดของแผน) — จำลองด้วยการยกเลิกเคสตรงที่ฐาน
      await sql.run("UPDATE cases SET status = 'cancelled' WHERE case_id = :id", { id: c.case_id });
      const res = await send('POST', `/api/invoices/${draft.invoice_id}/pay`, { request_id: crypto.randomUUID() });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.match(res.body.error, /ยกเลิกแล้ว/);
      assert.equal((await invoice(draft.invoice_id)).status, 'draft');
    });

    test('ปลดผู้รับผิดชอบของเคสที่ยังไม่จับคู่แต่มีทีม = เลื่อนคนในทีมขึ้นเป็นหลัก ไม่ตอบ 500 (ตรวจ 13 พ.ย. 2569)', async () => {
      const c = await newCase();
      assert.equal(c.status, 'unassigned');
      await post(`/api/cases/${c.case_id}/team`, { employee_id: FIELD.employee_id });
      const after = await post(`/api/cases/${c.case_id}/unassign`, {});
      assert.equal(after.assigned_to, FIELD.employee_id);
      assert.equal(after.status, 'assigned');
    });

    test('ออกใบพร้อมกันสองคำขอ = ใบร่างใบเดียว', async () => {
      const c = await newCase();
      const auto = await draftOf(c.case_id);
      await send('DELETE', `/api/invoices/${auto.invoice_id}`);
      const results = await Promise.all([
        send('POST', '/api/invoices', { case_id: c.case_id }),
        send('POST', '/api/invoices', { case_id: c.case_id }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      const drafts = (await get(`/api/invoices?case_id=${c.case_id}&status=draft`, MANAGER)).body.data;
      assert.equal(drafts.length, 1);
    });

    test('รายได้เกณฑ์เงินสด: นับงวดที่รับจริงตามวันรับ · ใบยกเลิกไม่นับ · request_id ซ้ำข้ามใบ = 409', async () => {
      const todayRevenue = async () => {
        const r = (await get('/api/invoices/revenue?bucket=day&points=2', MANAGER)).body;
        return r.data[r.data.length - 1].revenue;
      };
      const before = await todayRevenue();

      const c = await post('/api/cases', { case_type: 'other', client_name: 'Cash basis', fee: 10000 }, MANAGER, 201);
      const draft = await draftOf(c.case_id);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      const requestId = crypto.randomUUID();
      await post(`/api/invoices/${draft.invoice_id}/pay`, { request_id: requestId, amount: 3000 });
      // ยังไม่ครบยอดก็เป็นเงินที่เข้าแล้ว (ของเดิมนับ 0 จนกว่าใบจะปิด)
      assert.equal(await todayRevenue(), before + 3000);

      // ใช้ request_id เดิมกับใบอื่น = คำขอขัดกัน ไม่ใช่ 500
      const other = await post('/api/cases', { case_type: 'other', client_name: 'Cash basis 2', fee: 500 }, MANAGER, 201);
      const otherDraft = await draftOf(other.case_id);
      await post(`/api/invoices/${otherDraft.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${otherDraft.invoice_id}/pay`, { request_id: requestId, amount: 100 }, MANAGER, 409);

      // ใบที่ถือเงินอยู่ยกเลิกตรง ๆ ไม่ได้ — ลดหนี้เต็มยอดพร้อมคืนเงินก่อน (4 พ.ย. 2569)
      await post(`/api/invoices/${draft.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' }, MANAGER, 409);
      await post(`/api/invoices/${draft.invoice_id}/adjustments`, {
        kind: 'credit', amount: 10000, reason: 'ลูกค้ายกเลิกบริการ', refund: { method: 'โอน' },
      }, MANAGER, 201);
      assert.equal(await todayRevenue(), before, 'คืนเงินวันนี้หักรายได้วันนี้');
      await post(`/api/invoices/${draft.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' });
      assert.equal(await todayRevenue(), before);
    });

    test('ยกเลิกงวดหนึ่งของแผนมัดจำ: ใบคู่ที่ยังไม่รับเงินถูกยกเลิกตาม · ใบคู่รับเงินแล้ว = 409', async () => {
      const plan = async (name) => {
        const c = await post('/api/cases', { case_type: 'other', client_name: name, fee: 10000 }, MANAGER, 201);
        const draft = await draftOf(c.case_id);
        await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 4000 });
        const rows = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
        return {
          deposit: rows.find((v) => v.billing_kind === 'deposit'),
          balance: rows.find((v) => v.billing_kind === 'balance'),
        };
      };

      const a = await plan('Cancel plan A');
      await post(`/api/invoices/${a.balance.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' });
      assert.equal((await invoice(a.deposit.invoice_id)).status, 'cancelled');
      assert.equal((await invoice(a.balance.invoice_id)).status, 'cancelled');

      const b = await plan('Cancel plan B');
      await pay(b.balance.invoice_id, { amount: 1000 });
      const refused = await post(`/api/invoices/${b.deposit.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' }, MANAGER, 409);
      assert.match(refused.error, new RegExp(b.balance.invoice_id));
      assert.notEqual((await invoice(b.deposit.invoice_id)).status, 'cancelled');
      // ใบที่รับเงินแล้ว: ลดหนี้เต็มยอดพร้อมคืนเงิน แล้วยกเลิกเอง = ใบมัดจำที่ยังไม่รับเงินตามไป
      await post(`/api/invoices/${b.balance.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' }, MANAGER, 409);
      await post(`/api/invoices/${b.balance.invoice_id}/adjustments`, {
        kind: 'credit', amount: 6000, reason: 'ยกเลิกทั้งแผน', refund: {},
      }, MANAGER, 201);
      await post(`/api/invoices/${b.balance.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' });
      assert.equal((await invoice(b.deposit.invoice_id)).status, 'cancelled');
    });

    test('ยอดสรุป: ยอดเงินของใบชำระแล้วเห็นเฉพาะหมวด money — Admin HC เห็นแค่จำนวนใบ', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Summary paid', fee: 1000 }, MANAGER, 201);
      const draft = await draftOf(c.case_id);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await pay(draft.invoice_id, {});

      const m = (await get('/api/invoices/summary', MANAGER)).body.find((r) => r.status === 'paid');
      assert.ok(m.amount >= 1000);
      const h = await get('/api/invoices/summary', HC);
      assert.equal(h.status, 200);
      const paid = h.body.find((r) => r.status === 'paid');
      assert.equal(paid.count, m.count);
      assert.equal('amount' in paid, false);
      assert.equal('outstanding' in paid, false);
      // แถวที่ยังไม่ชำระยังมียอดค้างให้ตามเก็บ
      assert.ok(h.body.filter((r) => r.status !== 'paid').every((r) => 'outstanding' in r));
    });

    // ---------- ใบเสร็จ · ใบลดหนี้/เพิ่มหนี้ · คืนเงิน (4 พ.ย. 2569 · invoices/ledger.js) ----------
    const fullPlan = async (name, fee) => {
      const c = await post('/api/cases', { case_type: 'other', client_name: name, fee }, MANAGER, 201);
      const draft = await draftOf(c.case_id);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      return draft.invoice_id;
    };
    const seq = (docId) => Number(docId.slice(-4));

    test('ใบเสร็จ: รับเงินแต่ละครั้งได้ใบเสร็จของตัวเอง · เลขรันต่อ · ยกเลิกรายการรับเงิน = ใบเสร็จขึ้นยกเลิก', async () => {
      const id = await fullPlan('Receipt per payment', 10000);
      await pay(id, { amount: 4000 });
      let inv = await invoice(id);
      assert.equal(inv.receipts.length, 1);
      assert.match(inv.receipts[0].receipt_id, /^HC-RC\d{10,}$/);
      assert.equal(inv.receipts[0].amount, 4000);
      assert.equal(inv.receipts[0].balance_after, 6000);
      assert.equal(inv.status, 'issued');

      await pay(id, {});
      inv = await invoice(id);
      assert.equal(inv.status, 'paid');
      assert.equal(inv.receipts.length, 2);
      assert.equal(inv.receipts[1].balance_after, 0);
      assert.ok(seq(inv.receipts[1].receipt_id) > seq(inv.receipts[0].receipt_id));

      const first = inv.payments[0];
      await post(`/api/invoices/${id}/payments/${first.payment_id}/void`, { reason: 'กรอกยอดผิด' });
      inv = await invoice(id);
      assert.equal(inv.receipts.length, 2, 'ใบเสร็จไม่หาย');
      assert.equal(inv.receipts[0].status, 'voided');
      assert.equal(inv.receipts[0].void_reason, 'กรอกยอดผิด');
      assert.equal(inv.receipts[1].status, 'issued');
      assert.equal(inv.status, 'issued');
      assert.equal(inv.balance, 4000);
    });

    test('ใบที่ออกแล้วแก้ยอดตรง ๆ ไม่ได้ · ใบร่างแก้ได้ · ส่งยอดเดิมกลับมาไม่ติด · ลบได้เฉพาะใบร่าง', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Amount lock', fee: 5000 }, MANAGER, 201);
      const draft = await draftOf(c.case_id);
      assert.equal((await send('PATCH', `/api/invoices/${draft.invoice_id}`, { discount: 100 })).status, 200);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${draft.invoice_id}/issue`, {});

      const same = await send('PATCH', `/api/invoices/${draft.invoice_id}`, { discount: 100, amount: 5000, note: 'แก้โน้ต' });
      assert.equal(same.status, 200, JSON.stringify(same.body));
      assert.equal(same.body.note, 'แก้โน้ต');
      const changed = await send('PATCH', `/api/invoices/${draft.invoice_id}`, { discount: 300 });
      assert.equal(changed.status, 409);
      assert.match(changed.body.error, /ใบลดหนี้/);
      assert.equal((await invoice(draft.invoice_id)).total, 4900);

      const del = await send('DELETE', `/api/invoices/${draft.invoice_id}`);
      assert.equal(del.status, 409);
      assert.match(del.body.error, /ใบร่าง/);
      const cn = await send('POST', `/api/invoices/${draft.invoice_id}/adjustments`, { kind: 'credit', amount: 100, reason: 'ส่วนลดเพิ่ม' });
      assert.equal(cn.status, 201, JSON.stringify(cn.body));

      // ใบร่างไม่ต้องใช้ CN/DN
      const other = await post('/api/cases', { case_type: 'other', client_name: 'Draft adjust', fee: 1000 }, MANAGER, 201);
      const otherDraft = await draftOf(other.case_id);
      const refused = await send('POST', `/api/invoices/${otherDraft.invoice_id}/adjustments`, { kind: 'debit', amount: 100, reason: 'ทดสอบใบร่าง' });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /ร่าง/);
    });

    test('ใบลดหนี้+คืนเงิน กดซ้ำด้วยรหัสคำขอเดิม = เอกสารเดิม ไม่ออกใบที่สอง (ตรวจ 13 พ.ย. 2569)', async () => {
      const id = await fullPlan('Credit retry', 10000);
      await pay(id, {});
      const body = {
        kind: 'credit', amount: 2000, reason: 'ยกเลิกกะ 1 วัน', refund: { method: 'โอนคืน' }, request_id: crypto.randomUUID(),
      };
      const first = await send('POST', `/api/invoices/${id}/adjustments`, body);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const again = await send('POST', `/api/invoices/${id}/adjustments`, body);
      assert.equal(again.status, 201, JSON.stringify(again.body));
      assert.equal(again.body.created_note_id, first.body.created_note_id);
      const inv = await invoice(id);
      assert.equal(inv.adjustments.length, 1);
      assert.equal(inv.refunds.length, 1);
      assert.equal(inv.net_total, 8000);
    });

    test('ใบเพิ่มหนี้/ลดหนี้: ยอดสุทธิ · สถานะถอยกลับ · ลดหนี้จนรับเกินต้องคืนเงิน · สิทธิ์ · ยกเลิกเอกสาร', async () => {
      const id = await fullPlan('Credit debit flow', 30000);
      await pay(id, { amount: 10000 });
      await pay(id, {});
      assert.equal((await invoice(id)).status, 'paid');

      // ใบลดหนี้เฉพาะหมวด money · ใบเพิ่มหนี้ Admin HC ออกได้
      assert.equal((await send('POST', `/api/invoices/${id}/adjustments`, { kind: 'credit', amount: 100, reason: 'ลองลด' }, HC)).status, 403);
      const dn = await send('POST', `/api/invoices/${id}/adjustments`, { kind: 'debit', amount: 200, reason: 'เพิ่มหัตถการ PR0008' }, HC);
      assert.equal(dn.status, 201, JSON.stringify(dn.body));
      assert.match(dn.body.created_note_id, /^HC-DN\d{10,}$/);
      assert.equal(dn.body.total, 30000, 'ยอดหน้าใบไม่เปลี่ยน');
      assert.equal(dn.body.net_total, 30200);
      assert.equal(dn.body.balance, 200);
      assert.equal(dn.body.status, 'issued', 'ใบที่ชำระแล้วถอยกลับเมื่อมียอดเพิ่ม');

      await pay(id, {});
      let inv = await invoice(id);
      assert.equal(inv.status, 'paid');
      assert.equal(inv.receipts.length, 3);

      // ลดหนี้ใบที่จ่ายครบ = เงินเกิน ต้องบันทึกคืนเงินพร้อมกัน
      const needRefund = await send('POST', `/api/invoices/${id}/adjustments`, { kind: 'credit', amount: 3000, reason: 'ยกเลิกกะ 2 วัน' });
      assert.equal(needRefund.status, 409);
      assert.equal(needRefund.body.details.refund_amount, 3000);
      assert.equal((await send('POST', `/api/invoices/${id}/adjustments`, { kind: 'credit', amount: 99999, reason: 'เกินยอด' })).status, 400);

      const cn = await send('POST', `/api/invoices/${id}/adjustments`, {
        kind: 'credit', amount: 3000, reason: 'ยกเลิกกะ 2 วัน', refund: { method: 'โอนคืน' },
      });
      assert.equal(cn.status, 201, JSON.stringify(cn.body));
      assert.match(cn.body.created_note_id, /^HC-CN\d{10,}$/);
      assert.equal(cn.body.net_total, 27200);
      assert.equal(cn.body.paid_amount, 27200);
      assert.equal(cn.body.refunded_amount, 3000);
      assert.equal(cn.body.balance, 0);
      assert.equal(cn.body.status, 'paid');
      assert.equal(cn.body.refunds.length, 1);
      assert.equal(cn.body.refunds[0].note_id, cn.body.created_note_id);
      const cnNote = cn.body.adjustments.find((a) => a.note_id === cn.body.created_note_id);
      assert.equal(cnNote.total_before, 30200);
      assert.equal(cnNote.total_after, 27200);

      // ยกเลิกเอกสาร: ใบเพิ่มหนี้ที่ทำให้ยอดต่ำกว่าเงินที่รับไม่ได้ (ยกเลิกใบลดหนี้ที่มีเงินคืน — ดูเทสต์ชุด A ด้านล่าง)
      const cancelDn = await send('POST', `/api/invoices/${id}/adjustments/${dn.body.created_note_id}/cancel`, { reason: 'ทดสอบ' });
      assert.equal(cancelDn.status, 409);

      // ใบเพิ่มหนี้ที่ยังไม่รับเงิน ยกเลิกได้ และใบกลับเป็นชำระแล้ว
      const extra = await send('POST', `/api/invoices/${id}/adjustments`, { kind: 'debit', amount: 500, reason: 'ออกผิด' });
      assert.equal(extra.body.status, 'issued');
      assert.equal((await send('POST', `/api/invoices/${id}/adjustments/${extra.body.created_note_id}/cancel`, { reason: 'ออกผิดใบ' }, HC)).status, 403);
      const undone = await send('POST', `/api/invoices/${id}/adjustments/${extra.body.created_note_id}/cancel`, { reason: 'ออกผิดใบ' });
      assert.equal(undone.status, 200, JSON.stringify(undone.body));
      assert.equal(undone.body.status, 'paid');
      assert.equal(undone.body.net_total, 27200);
      inv = await invoice(id);
      assert.equal(inv.adjustments.find((a) => a.note_id === extra.body.created_note_id).status, 'cancelled');

      // ยังถือเงินอยู่ = ยกเลิกใบไม่ได้
      assert.equal((await send('POST', `/api/invoices/${id}/cancel`, { reason: 'ทดสอบยกเลิก' })).status, 409);
    });

    test('กรองใบแจ้งหนี้ตามประเภทบริการ: Homecare / กายภาพบำบัด', async () => {
      const home = await fullPlan('Service filter homecare', 2000);
      const physio = await fullPlan('Service filter physio', 3000);
      const physioCase = (await invoice(physio)).case_id;
      await sql.run(`UPDATE cases SET service_kind = 'physio' WHERE case_id = :id`, { id: physioCase });

      const ids = async (kind) =>
        (await get(`/api/invoices?service_kind=${kind}&per_page=100&q=Service filter`, MANAGER)).body.data.map((v) => v.invoice_id);
      const p = await ids('physio');
      const h = await ids('homecare');
      assert.ok(p.includes(physio) && !p.includes(home), 'กายภาพเห็นเฉพาะใบของเคสกายภาพ');
      assert.ok(h.includes(home) && !h.includes(physio), 'Homecare ไม่มีใบของเคสกายภาพ');
      assert.equal((await get('/api/invoices?service_kind=other', MANAGER)).status, 400);
    });

    test('ยกเลิกใบ: ต้องมีสิทธิ์เงินและเหตุผล · เก็บชื่อคนยกเลิก · ลบสลิปได้เฉพาะตำแหน่งที่กำหนด', async () => {
      const id = await fullPlan('Cancel audit', 4000);
      await post(`/api/invoices/${id}/issue`, {});
      assert.equal((await send('POST', `/api/invoices/${id}/cancel`, { reason: 'ลูกค้ายกเลิก' }, HC)).status, 403);
      assert.equal((await send('POST', `/api/invoices/${id}/cancel`, { reason: 'ลูกค้ายกเลิก' }, HR)).status, 403);
      assert.equal((await send('POST', `/api/invoices/${id}/cancel`, {})).status, 400, 'ไม่มีเหตุผล = ไม่ให้ยกเลิก');

      const slip = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';
      // แนบสลิปได้เฉพาะใบที่รับเงินแล้ว — ใช้อีกใบ
      const paidId = await fullPlan('Slip delete', 1000);
      await pay(paidId, {});
      const withSlip = await send('POST', `/api/invoices/${paidId}/slips`, { image: slip }, HC);
      assert.ok([200, 201].includes(withSlip.status), JSON.stringify(withSlip.body));
      const slipId = withSlip.body.slips.at(-1).slip_id;
      assert.equal((await send('DELETE', `/api/invoices/${paidId}/slips/${slipId}`, undefined, HR)).status, 403, 'HR ลบสลิปไม่ได้');
      assert.equal((await send('DELETE', `/api/invoices/${paidId}/slips/${slipId}`, undefined, HC)).status, 200, 'Admin HC ลบได้');

      const done = await send('POST', `/api/invoices/${id}/cancel`, { reason: 'ลูกค้ายกเลิกบริการ' });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const inv = await invoice(id);
      assert.equal(inv.status, 'cancelled');
      assert.equal(inv.cancel_reason, 'ลูกค้ายกเลิกบริการ');
      assert.equal(inv.cancelled_by, MANAGER.employee_id);
      assert.ok(inv.cancelled_at);
    });

    // ---------- ชุด A แผนแก้ระบบการเงิน (4 พ.ย. 2569) ----------
    test('เงินคืน: เลข HC-PV · แก้วันที่/ช่องทางได้ ยอดไม่เปลี่ยน · ยกเลิกใบลดหนี้ = เงินคืนถูกยกเลิกด้วย', async () => {
      const revenueToday = async () => {
        const r = (await get('/api/invoices/revenue?bucket=day&points=2', MANAGER)).body;
        return r.data[r.data.length - 1].revenue;
      };
      const id = await fullPlan('Refund voucher', 10000);
      await pay(id, {});
      const before = await revenueToday();

      const cn = await send('POST', `/api/invoices/${id}/adjustments`, {
        kind: 'credit', reason_code: 'not_rendered', amount: 2000, reason: 'ไม่ได้เข้ากะ 1 วัน', refund: { method: 'โอน' },
      });
      assert.equal(cn.status, 201, JSON.stringify(cn.body));
      const refund = cn.body.refunds[0];
      assert.match(refund.refund_doc_id, /^HC-PV\d{10,}$/);
      assert.equal(refund.status, 'active');
      assert.equal(cn.body.adjustments[0].reason_code, 'not_rendered');
      assert.equal(await revenueToday(), before - 2000);

      // แก้ข้อมูลเงินคืน: หมวด money เท่านั้น · ค่าเดิมเก็บใน edit_log · ยอดไม่ขยับ
      const path = `/api/invoices/${id}/refunds/${refund.refund_id}`;
      assert.equal((await send('PATCH', path, { method: 'เงินสด' }, HC)).status, 403);
      const edited = await send('PATCH', path, { method: 'เงินสด', note: 'คืนที่บ้านลูกค้า' });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const after = edited.body.refunds[0];
      assert.equal(after.method, 'เงินสด');
      assert.equal(after.amount, 2000);
      assert.equal(after.edit_log.length, 1);
      assert.equal(after.edit_log[0].before.method, 'โอน');

      // ยกเลิกใบลดหนี้ที่มีเงินคืน = ย้อนทั้งคู่ ยอดกลับเท่าเดิม ไม่มีทางรับเกินยอด
      const undone = await send('POST', `/api/invoices/${id}/adjustments/${cn.body.created_note_id}/cancel`, { reason: 'ไม่ได้โอนคืนจริง' });
      assert.equal(undone.status, 200, JSON.stringify(undone.body));
      assert.equal(undone.body.net_total, 10000);
      assert.equal(undone.body.paid_amount, 10000);
      assert.equal(undone.body.refunded_amount, 0);
      assert.equal(undone.body.balance, 0);
      assert.equal(undone.body.status, 'paid');
      assert.equal(undone.body.refunds[0].status, 'voided');
      assert.match(undone.body.refunds[0].void_reason, /ไม่ได้โอนคืนจริง/);
      assert.equal(await revenueToday(), before, 'เงินคืนที่ยกเลิกไม่หักรายได้แล้ว');
      assert.equal((await send('PATCH', path, { note: 'แก้หลังยกเลิก' })).status, 409);
    });

    test('รายได้ตาม BU (ชุดใหม่): แบ่ง BU · เป้า · รับรู้ตามบริการ · กำไร · ลูกหนี้แยกอายุ · ลูกค้า · ราคาจริง · สิทธิ์', async () => {
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const r2 = (n) => Math.round(n * 100) / 100;
      const q = `from=${today}&to=${today}`;
      const overview = async () => (await get(`/api/invoices/revenue-bu/overview?${q}`, MANAGER)).body;
      const before = await overview();

      // ---- แบ่ง BU: ใบ 14,500 = ค่าบริการ 10,000 + เตียงเช่า 2×1,500 + ขาย 1,000 + หัตถการ 500 · รับครึ่งใบ
      const c = await post('/api/cases', {
        case_type: 'other', client_name: 'BU split', fee: 10000,
        addons: [
          { name: 'เตียงลม BU', kind: 'rent', quantity: 2, unit_price: 1500 },
          { name: 'ชุดตรวจ BU', kind: 'sale', quantity: 1, unit_price: 1000 },
          { kind: 'procedure', name: 'ทำแผล BU', quantity: 1, unit_price: 500 },
        ],
      }, MANAGER, 201);
      const draft = await draftOf(c.case_id);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      assert.equal((await invoice(draft.invoice_id)).total, 14500);
      await pay(draft.invoice_id, { amount: 7250 });

      // ---- CSV รายบรรทัด (export-lines · 24 พ.ย. 2569): ใบเดียวกันแตกเป็นบรรทัดตามกติกาเดียวกับ BU
      //      เคสไม่มีช่วงสัญญา = ช่วงบริการคือวันที่ออกใบ · ไม่จด VAT = ยอดในช่วงอยู่ช่อง "ไม่มี VAT" ทั้งหมด
      {
        const lines = (await get(`/api/invoices/export-lines?${q}`, MANAGER)).body.data
          .filter((l) => l.invoice_id === draft.invoice_id);
        const by = Object.fromEntries(lines.map((l) => [l.category, l]));
        assert.equal(r2(lines.reduce((s, l) => s + l.amount, 0)), 14500, 'บรรทัดรวมกัน = ยอดสุทธิของใบ');
        assert.equal(by['ค่าเช่าอุปกรณ์'].amount, 3000);
        assert.equal(by['ค่าเช่าอุปกรณ์'].quantity, 2);
        assert.equal(by['ค่าอุปกรณ์ (ขาย)'].amount, 1000);
        assert.equal(by['ค่าหัตถการ'].amount, 500);
        assert.equal(r2(lines.reduce((s, l) => s + l.paid, 0)), 7250, 'เงินที่รับแบ่งลงบรรทัดครบทุกสตางค์');
        assert.equal(r2(lines.reduce((s, l) => s + l.outstanding, 0)), 7250);
        for (const l of lines) {
          assert.equal(l.days_in_range, l.total_days);
          assert.equal(l.non_vat, l.amount);
          assert.equal(l.in_range_total, l.amount);
          assert.equal(l.vat, 0);
          assert.equal(l.vat_base, 0);
        }
        const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
        const later = (await get(`/api/invoices/export-lines?from=${tomorrow}&to=${tomorrow}`, MANAGER)).body.data;
        assert.ok(!later.some((l) => l.invoice_id === draft.invoice_id), 'ช่วงบริการไม่คาบเกี่ยว = ไม่อยู่ในไฟล์');
        assert.equal((await send('GET', `/api/invoices/export-lines?from=${tomorrow}&to=${today}`)).status, 400);

        // ---- รายงานภาษีขาย (24 พ.ย. 2569): ใบเสร็จของการรับเงินนี้อยู่ในเดือนนี้ · ไม่จด VAT = ภาษี 0
        const tax = (await get(`/api/invoices/sales-tax?month=${today.slice(0, 7)}`, MANAGER)).body;
        const mine = tax.data.filter((r) => r.invoice_id === draft.invoice_id);
        assert.equal(mine.length, 1);
        assert.equal(mine[0].doc_type, 'receipt');
        assert.equal(mine[0].total, 7250);
        assert.equal(mine[0].base, 7250);
        assert.equal(mine[0].vat, 0);
        assert.equal(tax.totals.vat, 0);
        assert.equal(tax.totals.total, r2(tax.data.reduce((s, r) => s + r.total, 0)));
        assert.equal((await send('GET', '/api/invoices/sales-tax?month=2026-13')).status, 400);
        // ช่วงวันที่ที่เลือกเอง (from/to) — วันนี้วันเดียวก็ต้องเจอใบเสร็จเดียวกัน · วันพรุ่งนี้ไม่เจอ · กลับด้าน = 400
        const day = (await get(`/api/invoices/sales-tax?from=${today}&to=${today}`, MANAGER)).body;
        assert.equal(day.month, null);
        assert.equal(day.from, today);
        assert.ok(day.data.some((r) => r.invoice_id === draft.invoice_id && r.total === 7250));
        const next = (await get(`/api/invoices/sales-tax?from=${tomorrow}&to=${tomorrow}`, MANAGER)).body;
        assert.ok(!next.data.some((r) => r.invoice_id === draft.invoice_id));
        assert.equal((await send('GET', `/api/invoices/sales-tax?from=${tomorrow}&to=${today}`)).status, 400);
      }

      let ov = await overview();
      const delta = (k) => r2(ov.current[k] - before.current[k]);
      assert.equal(delta('homecare'), 5000);
      assert.equal(delta('rent'), 1500);
      assert.equal(delta('sale'), 500);
      assert.equal(delta('procedure'), 250);
      // รวมทุก BU = กราฟรายได้หน้าภาพรวมของวันเดียวกัน · แนวโน้ม 12 เดือนจบที่เดือนนี้
      const sumCur = r2(Object.values(ov.current).reduce((a, b) => a + b, 0));
      assert.equal((await get('/api/invoices/revenue?bucket=day&points=2', MANAGER)).body.data.at(-1).revenue, sumCur);
      assert.equal(ov.trend.length, 12);
      assert.equal(ov.trend.at(-1).month, today.slice(0, 7));
      assert.ok(ov.last_year.from.startsWith(String(Number(today.slice(0, 4)) - 1)));

      // ---- เป้า: ตั้งได้เฉพาะ Super Admin/ผู้จัดการ · เฉลี่ยตามจำนวนวันของช่วง · ช่องว่าง = ลบ
      const ym = today.slice(0, 7);
      const dim = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
      const year = Number(today.slice(0, 4));
      assert.equal((await send('PUT', '/api/invoices/revenue-bu/targets', { year, rows: [{ month: ym, bu: 'homecare', amount: 31000 }] }, HR)).status, 403);
      assert.equal((await send('PUT', '/api/invoices/revenue-bu/targets', { year, rows: [{ month: `${year + 1}-01`, bu: 'homecare', amount: 1 }] })).status, 400);
      const saved = await send('PUT', '/api/invoices/revenue-bu/targets', {
        year, rows: [{ month: ym, bu: 'homecare', amount: 31000 }, { month: ym, bu: 'rent', amount: 9300 }],
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.rows.length, 2);
      ov = await overview();
      assert.equal(ov.targets.homecare, r2(31000 / dim));
      assert.equal(ov.targets.physio, null, 'BU ที่ไม่ได้ตั้งเป้า = null');
      assert.equal(ov.trend.at(-1).target_total, 40300);
      await send('PUT', '/api/invoices/revenue-bu/targets', { year, rows: [{ month: ym, bu: 'rent', amount: null }] });
      assert.equal((await get(`/api/invoices/revenue-bu/targets?year=${year}`, MANAGER)).body.rows.length, 1);

      // ---- รับรู้ตามบริการ: แพ็กกายภาพ 10 ครั้ง ราคา 10,000 (ราคาตั้ง 12,000) จ่ายครบ · ไปแล้ว 3 ครั้ง (วันนี้ 2 · เมื่อวาน 1)
      const pp = await sql.one(
        `INSERT INTO physio_packages (name, sessions, original_price, special_price, code)
         VALUES ('แพ็ก BU 10 ครั้ง', 10, 12000, 10000, 'PT-BU10') RETURNING physio_package_id AS id`,
      );
      const pc = await post('/api/cases', { case_type: 'physiotherapy', client_name: 'BU physio pkg', fee: 10000 }, MANAGER, 201);
      await sql.run(
        `UPDATE cases SET service_kind = 'physio', physio_package_id = :pp, service_customer_price_snapshot = 10000,
                service_list_price_snapshot = 12000, assigned_to = :emp, status = 'assigned' WHERE case_id = :id`,
        { pp: pp.id, emp: FIELD.employee_id, id: pc.case_id },
      );
      const pInv = await draftOf(pc.case_id);
      await post(`/api/invoices/${pInv.invoice_id}/billing-plan`, { mode: 'full' });
      await pay(pInv.invoice_id, {});
      const { yesterday } = await sql.one(`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day','YYYY-MM-DD') AS yesterday`);
      for (const d of [yesterday, today, today]) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, 'done', (:d || ' 08:00:00+07')::timestamptz, (:d || ' 09:00:00+07')::timestamptz)`,
          { id: pc.case_id, d },
        );
      }
      const rec = (await get(`/api/invoices/revenue-bu/recognition?${q}`, MANAGER)).body;
      const row = rec.cases.find((x) => x.case_id === pc.case_id);
      assert.ok(row, 'เคสแพ็กขึ้นตารางรับรู้รายได้');
      assert.equal(row.unit_price, 1000);
      assert.equal(row.units_in_period, 2);
      assert.equal(row.recognized_in_period, 2000);
      assert.equal(row.recognized_to_date, 3000);
      assert.equal(row.paid_to_date, 10000);
      assert.equal(row.balance, 7000, 'รับเงินล่วงหน้า 7 ครั้งที่ยังไม่ได้ให้บริการ');
      const physioRec = rec.by_bu.find((b) => b.bu === 'physio');
      assert.ok(physioRec.deferred >= 7000 && physioRec.from_delivery >= 2000);
      // อุปกรณ์/หัตถการรับรู้วันที่ออกใบ (เต็มยอด ไม่ใช่ตามเงินที่รับ)
      assert.ok(rec.by_bu.find((b) => b.bu === 'rent').from_invoice >= 3000);

      // ---- กำไร: ต้นทุน = ค่าจ้างที่ปล่อยในช่วง · นับให้เคส (แพ็ก · พนักงานหลัก) · ต้องมี see_pay
      await sql.run(
        `INSERT INTO case_payouts (case_id, employee_id, employee_name, amount) VALUES (:id, :emp, 'T T', 1500)`,
        { id: pc.case_id, emp: FIELD.employee_id },
      );
      const m = (await get(`/api/invoices/revenue-bu/margin?${q}`, MANAGER)).body;
      const pkgRow = m.package.find((x) => x.key === `pp:${pp.id}`);
      assert.deepEqual([pkgRow.cash, pkgRow.recognized, pkgRow.cost, pkgRow.code], [10000, 2000, 1500, 'PT-BU10']);
      const staffRow = m.staff.find((x) => x.key === FIELD.employee_id);
      assert.ok(staffRow.cost >= 1500 && staffRow.recognized >= 2000);
      assert.equal(m.totals.cost, r2(m.bu.reduce((s, x) => s + x.cost, 0)));
      assert.equal((await send('GET', `/api/invoices/revenue-bu/margin?${q}`, undefined, HR)).status, 403);

      // ---- ลูกหนี้: ใบแรกค้าง 7,250 เกินกำหนด 45 วัน → ช่อง 31–60 · แบ่ง BU ตามสัดส่วนใบ
      await sql.run(
        `UPDATE invoices SET due_date = to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '45 day','YYYY-MM-DD') WHERE invoice_id = :id`,
        { id: draft.invoice_id },
      );
      const ar = (await get('/api/invoices/revenue-bu/receivables', MANAGER)).body;
      const arInv = ar.invoices.find((x) => x.invoice_id === draft.invoice_id);
      assert.equal(arInv.bucket, 'd31_60');
      assert.equal(arInv.days_overdue, 45);
      assert.equal(arInv.balance, 7250);
      assert.deepEqual(arInv.parts, { homecare: 5000, rent: 1500, sale: 500, procedure: 250 });
      assert.ok(ar.by_bu.find((b) => b.bu === 'rent').d31_60 >= 1500);

      // ---- ลูกค้า: ต่อเคส · ยกเลิกพร้อมเหตุผล · การกระจุกตัว
      const closed = await post('/api/cases', { case_type: 'other', client_name: 'BU renew A', fee: 1000 }, MANAGER, 201);
      await sql.run(`UPDATE cases SET status = 'closed', closed_at = to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') WHERE case_id = :id`, { id: closed.case_id });
      const next = await post('/api/cases', { case_type: 'other', client_name: 'BU renew B', fee: 1000 }, MANAGER, 201);
      await sql.run('UPDATE cases SET renewed_from = :a, round_no = 2 WHERE case_id = :b', { a: closed.case_id, b: next.case_id });
      const gone = await post('/api/cases', { case_type: 'other', client_name: 'BU cancel', fee: 1000 }, MANAGER, 201);
      await sql.run(
        `UPDATE cases SET status = 'cancelled', cancel_reason = 'ทดสอบเหตุผล BU',
                cancelled_at = to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') WHERE case_id = :id`,
        { id: gone.case_id },
      );
      const cu = (await get(`/api/invoices/revenue-bu/customers?${q}`, MANAGER)).body;
      const hc = cu.lifecycle.find((x) => x.bu === 'homecare');
      assert.ok(hc.closed >= 1 && hc.renewed >= 1 && hc.cancelled >= 1 && hc.started_renew >= 1);
      assert.equal(cu.reasons.find((x) => x.reason === 'ทดสอบเหตุผล BU').count, 1);
      assert.ok(cu.top.length > 0 && cu.top.length <= 10);
      assert.ok(cu.concentration.top10 <= cu.concentration.total + 0.01);

      // ---- ราคาจริงเทียบราคาตั้ง ต่อแพ็ก · ส่วนลด/เงินคืนต่อ BU
      const pr = (await get(`/api/invoices/revenue-bu/pricing?${q}`, MANAGER)).body;
      const pRow = pr.packages.find((x) => x.key === `pp:${pp.id}`);
      assert.deepEqual([pRow.cases, pRow.list_total, pRow.actual_total], [1, 12000, 10000]);
      assert.ok(pr.by_bu.find((b) => b.bu === 'rent').billed >= 3000);

      // ---- ช่วงผิด = 400 · ไม่มีสิทธิ์ revenue = 403
      assert.equal((await send('GET', `/api/invoices/revenue-bu/overview?from=${today}&to=2000-01-01`)).status, 400);
      for (const p of ['overview', 'recognition', 'customers', 'pricing']) {
        assert.equal((await send('GET', `/api/invoices/revenue-bu/${p}?${q}`, undefined, HR)).status, 403, p);
      }
      assert.equal((await send('GET', '/api/invoices/revenue-bu/receivables', undefined, HR)).status, 403);
    });

    test('บันทึกการเงิน: ยอดวันนี้ (เงินเข้า · ลูกหนี้ · เกินกำหนด) · สมุดรายการเงินเก็บรายการที่ยกเลิก · ยอดของวันที่ผ่านไปแล้วแก้ไม่ได้ · สิทธิ์', async () => {
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const figs = async () => (await get('/api/finance-log/today', MANAGER)).body;
      const diff = (a, b, k) => Math.round((a[k] - b[k]) * 100) / 100;
      const before = await figs();

      // ใบ 9,000 ออกแล้ว เกินกำหนดชำระ
      const id = await fullPlan('Finance log', 9000);
      if ((await invoice(id)).status === 'draft') await post(`/api/invoices/${id}/issue`, {});
      await sql.run(`UPDATE invoices SET issue_date = '2000-01-01', due_date = '2000-01-02' WHERE invoice_id = :id`, { id });
      let now = await figs();
      assert.equal(diff(now, before, 'ar_outstanding'), 9000);
      assert.equal(diff(now, before, 'ar_overdue'), 9000);
      assert.equal(now.ar_count - before.ar_count, 1);

      // รับ 4,000 → เงินเข้าวันนี้ +4,000 · ลูกหนี้เหลือ 5,000
      await pay(id, { amount: 4000 });
      now = await figs();
      assert.equal(diff(now, before, 'cash_in'), 4000);
      assert.equal(diff(now, before, 'ar_outstanding'), 5000);
      assert.equal(now.snap_date, today);

      // ยกเลิกรายการรับเงิน → ตัวเลขวันนี้กลับ · สมุดยังเห็นทั้งรายการรับเงินเดิมและรายการยกเลิก
      const payment = (await invoice(id)).payments[0];
      await post(`/api/invoices/${id}/payments/${payment.payment_id}/void`, { reason: 'กรอกยอดผิด' });
      now = await figs();
      assert.equal(diff(now, before, 'cash_in'), 0);
      assert.equal(diff(now, before, 'ar_outstanding'), 9000);
      const ev = (await get(`/api/finance-log/events?from=${today}&to=${today}&q=${id}`, MANAGER)).body;
      const kinds = ev.rows.map((r) => r.kind).sort();
      assert.deepEqual(kinds, ['invoice_issued', 'payment', 'payment_void']);
      assert.equal(ev.rows.find((r) => r.kind === 'payment').amount, 4000);
      assert.equal(ev.rows.find((r) => r.kind === 'payment_void').amount, -4000);
      assert.equal(ev.rows.find((r) => r.kind === 'payment_void').note, 'กรอกยอดผิด');
      assert.equal(ev.summary.net_cash, 0);
      const cashOnly = (await get(`/api/finance-log/events?from=${today}&to=${today}&q=${id}&grp=cash`, MANAGER)).body;
      assert.ok(cashOnly.rows.every((r) => r.grp === 'cash'));

      // ยอดประจำวัน: แถวของวันนี้ = ตัวเลขล่าสุด
      const snaps = (await get(`/api/finance-log/snapshots?from=${today}&to=${today}`, MANAGER)).body.rows;
      assert.equal(snaps.length, 1);
      assert.equal(snaps[0].ar_outstanding, now.ar_outstanding);

      // วันที่ผ่านไปแล้ว: เพิ่มได้ (ย้ายข้อมูล) แต่แก้/ลบไม่ได้ในระดับฐานข้อมูล
      await sql.run(`INSERT INTO finance_snapshots (snap_date, cash_in) VALUES ('2001-01-01', 100) ON CONFLICT DO NOTHING`);
      await assert.rejects(sql.run(`UPDATE finance_snapshots SET cash_in = 0 WHERE snap_date = '2001-01-01'`), /แก้ไขหรือลบไม่ได้/);
      await assert.rejects(sql.run(`DELETE FROM finance_snapshots WHERE snap_date = '2001-01-01'`), /แก้ไขหรือลบไม่ได้/);

      // ช่วงวันที่ผิด / ยาวเกิน 1 ปี = 400 · ไม่มีสิทธิ์ finance_logs = 403
      assert.equal((await send('GET', `/api/finance-log/events?from=${today}&to=2000-01-01`)).status, 400);
      assert.equal((await send('GET', `/api/finance-log/events?from=2020-01-01&to=${today}`)).status, 400);
      assert.equal((await send('GET', '/api/finance-log/today', undefined, HR)).status, 403);
    });

    test('ลดหนี้จนเหลือ 0 ก่อนรับเงิน = ให้ยกเลิกใบแทน · ตัดหนี้สูญได้ไม่เกินยอดค้าง และขึ้นยอดหนี้สูญ', async () => {
      const id = await fullPlan('Bad debt', 8000);
      await post(`/api/invoices/${id}/issue`, {});
      assert.ok((await invoice(id)).issued_at, 'ออกใบแล้วมีเวลาที่ออก');

      const instead = await send('POST', `/api/invoices/${id}/adjustments`, { kind: 'credit', amount: 8000, reason: 'ลูกค้าไม่เอาแล้ว' });
      assert.equal(instead.status, 409);
      assert.match(instead.body.error, /ยกเลิกใบ/);
      // ประเภทต้องเข้ากับชนิดเอกสาร
      assert.equal(
        (await send('POST', `/api/invoices/${id}/adjustments`, { kind: 'debit', reason_code: 'bad_debt', amount: 10, reason: 'ผิดชนิด' })).status,
        400,
      );

      await pay(id, { amount: 3000 });
      const over = await send('POST', `/api/invoices/${id}/adjustments`, {
        kind: 'credit', reason_code: 'bad_debt', amount: 5001, reason: 'ตามไม่ได้',
      });
      assert.equal(over.status, 400);
      assert.match(over.body.error, /ยอดค้าง/);
      const bad = await send('POST', `/api/invoices/${id}/adjustments`, {
        kind: 'credit', reason_code: 'bad_debt', amount: 5000, reason: 'ลูกค้าไม่ชำระส่วนที่เหลือ ติดต่อไม่ได้',
      });
      assert.equal(bad.status, 201, JSON.stringify(bad.body));
      assert.equal(bad.body.status, 'paid');
      assert.equal(bad.body.bad_debt_amount, 5000);
      assert.equal(bad.body.refunded_amount, 0);
      assert.equal(bad.body.net_total, 3000);
    });

    test('ซ่อนใบยกเลิกจากรายการเมื่อขอ · เลือกสถานะยกเลิกตรง ๆ ยังเห็น · ลิงก์ลูกค้าเห็นใบเสร็จรายครั้ง', async () => {
      const c = await post('/api/cases', { case_type: 'other', client_name: 'Hide cancelled', fee: 4000 }, MANAGER, 201);
      const draft = await draftOf(c.case_id);
      await post(`/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${draft.invoice_id}/cancel`, { reason: 'ทดสอบยกเลิก' });
      const ids = async (qs) => (await get(`/api/invoices?case_id=${c.case_id}${qs}`, MANAGER)).body.data.map((v) => v.invoice_id);
      assert.ok((await ids('')).includes(draft.invoice_id));
      assert.ok(!(await ids('&hide_cancelled=yes')).includes(draft.invoice_id));
      assert.ok((await ids('&hide_cancelled=yes&status=cancelled')).includes(draft.invoice_id));
      assert.equal((await invoice(draft.invoice_id)).issued_at, null, 'ใบร่างที่ยกเลิกโดยไม่เคยออก ไม่มีเวลาออก');

      const id = await fullPlan('Public receipts', 6000);
      await pay(id, { amount: 2000 });
      const link = await post(`/api/invoices/${id}/share-link`, {}, MANAGER, 201);
      assert.match(link.latest_receipt_id, /^HC-RC/);
      const token = link.url.split('/bill/')[1];
      const pub = await get(`/api/public/bill/${token}`, MANAGER);
      assert.equal(pub.status, 200);
      assert.equal(pub.body.receipts.length, 1);
      assert.equal(pub.body.receipts[0].receipt_id, link.latest_receipt_id);
      assert.equal(pub.body.receipts[0].balance_after, 4000);
    });

    test('ใบเสร็จย้อนหลัง: รับเงินเก่าที่ไม่มีใบเสร็จได้คนละใบ · ยอดค้างไล่ตามลำดับ · รันซ้ำไม่ออกซ้ำ', async () => {
      const { backfillReceipts } = await import('../src/invoices/ledger.js');
      const id = await fullPlan('Legacy payments', 9000);
      await post(`/api/invoices/${id}/issue`, {});
      // รับเงินแบบก่อนมีระบบใบเสร็จ = แถวรับเงินที่ไม่มีใบเสร็จคู่
      for (const [amount, day] of [[2000, '2026-10-01'], [3000, '2026-10-05']]) {
        await sql.run(
          `INSERT INTO invoice_payments (invoice_id, amount, paid_at, method, created_at)
           VALUES (:id, :amount, :day, 'โอน', :day || ' 10:00:00')`,
          { id, amount, day },
        );
      }
      assert.ok((await backfillReceipts()) >= 2);
      const receipts = (await invoice(id)).receipts;
      assert.equal(receipts.length, 2);
      assert.match(receipts[0].receipt_id, /^HC-RC691001\d{4,}$/, 'วันที่ในเลขที่ = วันที่บันทึกรับเงิน');
      assert.deepEqual(receipts.map((r) => r.balance_after), [7000, 4000]);
      assert.equal(await backfillReceipts(), 0);
    });
  });

  describe('ความเร็ว: ผลต้องเหมือนเดิม (ปรับความเร็ว 13 พ.ย. 2569)', () => {
    test('การมาทำงานรายเดือนนับตามเวลาไทย — เช็คอิน 23:30 น. วันสิ้นเดือนอยู่เดือนนั้น · 00:10 น. วันที่ 1 อยู่เดือนถัดไป', async () => {
      const c = await newCase();
      const rows = await sql.all(
        `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
         VALUES (:id, '2025-10-31', 'done', '2025-10-31 23:30:00+07', '2025-11-01 07:00:00+07'),
                (:id, '2025-11-01', 'done', '2025-11-01 00:10:00+07', '2025-11-01 08:00:00+07')
         RETURNING visit_id`,
        { id: c.case_id },
      );
      const [lateOct, earlyNov] = rows.map((r) => r.visit_id);
      const oct = (await get('/api/cases/attendance?month=2025-10', MANAGER)).body.map((v) => v.visit_id);
      const nov = (await get('/api/cases/attendance?month=2025-11', MANAGER)).body.map((v) => v.visit_id);
      assert.ok(oct.includes(lateOct) && !oct.includes(earlyNov), JSON.stringify(oct));
      assert.ok(nov.includes(earlyNov) && !nov.includes(lateOct), JSON.stringify(nov));
    });

    test('สรุปเคส — ยอดรวม = ผลรวมตามสถานะ = ผลรวมตามบริการ', async () => {
      const s = (await get('/api/cases/summary', MANAGER)).body;
      const sum = (rows) => rows.reduce((n, r) => n + r.count, 0);
      assert.ok(s.total > 0);
      assert.equal(sum(s.by_status), s.total);
      assert.equal(sum(s.by_service), s.total);
      assert.ok(s.by_status.every((r) => typeof r.status === 'string'));
      assert.ok(s.by_service.every((r) => ['physio', 'homecare'].includes(r.service_kind)));
    });

    test('ปฏิทินส่งช่องที่หน้าจอใช้ครบ และไม่มีกะที่ยกเลิก', async () => {
      const c = await newCase();
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [today], planned_start: '09:00', planned_end: '12:00' }, MANAGER, 201);
      const cal = (await get(`/api/cases/calendar?year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`, MANAGER)).body;
      const mine = cal.find((v) => v.case_id === c.case_id);
      // ช่องครบตามรูปแบบเดิม — ผู้ใช้ API นี้นอกหน้าปฏิทินอ่าน visit_status/kind/check_in_at อยู่
      for (const k of ['case_id', 'title', 'case_type', 'status', 'client_name', 'customer_name', 'visit_id', 'visit_date',
        'visit_status', 'planned_start', 'planned_end', 'check_in_at', 'check_out_at', 'assigned_position', 'state', 'kind']) {
        assert.ok(k in mine, `ขาด ${k}`);
      }
      assert.equal(mine.state, 'scheduled');
      assert.ok(cal.every((v) => v.state !== 'cancelled'));
    });
  });

  describe('พาร์ทเนอร์ (ผู้รับเหมาช่วงรายครั้ง · 21 พ.ย. 2569)', () => {
    async function call(method, path, body, who = MANAGER, expected = 200) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      assert.equal(res.status, expected, `${method} ${path}: ${text}`);
      return data;
    }
    const day = async (n) => (await sql.one(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date + :n::int, 'YYYY-MM-DD') AS d`, { n },
    )).d;
    const visitRow = (id) => sql.one('SELECT * FROM case_visits WHERE visit_id = :id', { id });

    test('ส่งกะ → หัวหน้าเลือกคน/ปฏิเสธ · KIN ดึงคืน · กันข้อมูลข้ามบริษัท · ค่าจ้าง/ต้นทุน', async () => {
      // ---- บริษัท + บัญชีหัวหน้า (หลังบ้าน KIN) ----
      const A = await call('POST', '/api/partners', { name: 'เอ แคร์', rate_per_visit: 600 }, MANAGER, 201);
      const B = await call('POST', '/api/partners', { name: 'บี เฮลธ์', rate_per_visit: 500 }, MANAGER, 201);
      await call('POST', '/api/partners', { name: 'x', rate_per_visit: 1 }, FIELD, 403);
      const leadARow = await call('POST', `/api/partners/${A.partner_id}/leads`, { first_name: 'หัวหน้า', last_name: 'เอ' }, MANAGER, 201);
      const leadBRow = await call('POST', `/api/partners/${B.partner_id}/leads`, { first_name: 'หัวหน้า', last_name: 'บี' }, MANAGER, 201);
      const leadA = emp(leadARow.employee_id, 'partner_lead');
      const leadB = emp(leadBRow.employee_id, 'partner_lead');
      const me = (await get('/api/auth/me', leadA)).body;
      assert.equal(me.role, 'partner');
      assert.equal(me.partner_id, A.partner_id);

      // ---- ทีม (หัวหน้าเพิ่มเอง) ----
      await call('POST', '/api/partner/team', { first_name: 'x', last_name: 'y', position: 'manager' }, leadA, 400);
      const a1Row = await call('POST', '/api/partner/team', { first_name: 'กภ', last_name: 'เอหนึ่ง', position: 'therapist' }, leadA, 201);
      const b1Row = await call('POST', '/api/partner/team', { first_name: 'กภ', last_name: 'บีหนึ่ง', position: 'therapist' }, leadB, 201);
      const staffA1 = emp(a1Row.employee_id, 'therapist');
      const team = await call('GET', '/api/partner/team', undefined, leadA);
      assert.deepEqual(team.people.map((p) => p.employee_id).sort(), [leadARow.employee_id, a1Row.employee_id].sort());
      await call('PATCH', `/api/partner/team/${b1Row.employee_id}`, { phone: '0800000000' }, leadA, 404); // คนของบริษัทอื่น
      await call('GET', `/api/partner/team/${b1Row.employee_id}`, undefined, leadA, 404);
      const a1Detail = await call('GET', `/api/partner/team/${a1Row.employee_id}`, undefined, leadA);
      assert.equal(a1Detail.employee_id, a1Row.employee_id);
      assert.ok(Array.isArray(a1Detail.visits) && typeof a1Detail.done_total === 'number');
      assert.ok(!('password_hash' in a1Detail));
      await call('PATCH', `/api/partner/team/${leadARow.employee_id}`, { phone: '0800000000' }, leadA, 403); // แก้หัวหน้าเองไม่ได้
      // หัวหน้าแก้ข้อมูลคนในทีมได้ (ฟอร์มแก้ไขส่งครบทุกช่อง) · ตำแหน่งนอกหน้างานไม่ได้
      const edited = await call('PATCH', `/api/partner/team/${a1Row.employee_id}`,
        { first_name: 'กภ', last_name: 'เอหนึ่ง', nickname: 'เอ', phone: '0812345678', position: 'therapist' }, leadA);
      assert.equal(edited.nickname, 'เอ');
      assert.equal(edited.employee_id, a1Row.employee_id);
      await call('PATCH', `/api/partner/team/${a1Row.employee_id}`, { position: 'manager' }, leadA, 400);
      // อีเมลเป็นชื่อเข้าระบบอีกทาง: ตั้งได้ · ผิดรูปแบบไม่ได้ · ซ้ำบัญชีอื่นไม่ได้ · ล็อกอินด้วยอีเมลได้ · ช่องว่าง = ลบ
      await call('PATCH', `/api/partner/team/${a1Row.employee_id}`, { email: 'not-an-email' }, leadA, 400);
      await call('PATCH', `/api/partner/team/${b1Row.employee_id}`, { email: 'b1-partner@example.invalid' }, leadB);
      assert.match((await call('PATCH', `/api/partner/team/${a1Row.employee_id}`, { email: 'B1-Partner@example.invalid' }, leadA, 409)).error, /อีเมลนี้/);
      const withMail = await call('PATCH', `/api/partner/team/${a1Row.employee_id}`, { email: ' A1-Partner@Example.invalid ' }, leadA);
      assert.equal(withMail.email, 'a1-partner@example.invalid');
      assert.equal((await call('GET', '/api/partner/team', undefined, leadA)).people.find((x) => x.employee_id === a1Row.employee_id).email, 'a1-partner@example.invalid');
      const { DEFAULT_PASSWORD: PW } = await import('../src/lib/auth.js');
      const byMail = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a1-partner@example.invalid', password: PW }) });
      // พนักงานพาร์ทเนอร์ไม่ต้องเข้าระบบแล้ว (27 พ.ย. 2569) — รหัสถูกก็เข้าไม่ได้ · เซสชันเก่าก็ใช้ต่อไม่ได้
      assert.equal(byMail.status, 403, 'พนักงานพาร์ทเนอร์เข้าระบบไม่ได้');
      assert.match((await byMail.json()).error, /ไม่ต้องเข้าระบบ/);
      const byId = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: a1Row.employee_id, password: PW }) });
      assert.equal(byId.status, 403);
      assert.equal((await get('/api/my/today', staffA1)).status, 401);
      assert.equal((await call('PATCH', `/api/partner/team/${b1Row.employee_id}`, { email: '' }, leadB)).email, null);
      const c1Row = await call('POST', '/api/partner/team', { first_name: 'ค', last_name: 'อีเมล', position: 'therapist', email: 'a1-partner@example.invalid' }, leadA, 409);
      assert.match(c1Row.error, /อีเมลนี้/);

      // ---- คนของพาร์ทเนอร์ไม่อยู่ในหน้าพนักงาน/ตัวเลือกจับคู่ของ KIN · จับคู่ตรงไม่ได้ ----
      for (const q of [a1Row.employee_id, leadARow.employee_id]) {
        assert.deepEqual((await get(`/api/employees?q=${q}`, MANAGER)).body.data, [], `${q} ไม่ควรอยู่ในรายชื่อพนักงาน KIN`);
      }
      const assignable = (await get('/api/cases/assignable-employees', MANAGER)).body.map((e) => e.employee_id);
      assert.ok(!assignable.includes(a1Row.employee_id));
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await call('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [await day(2)], assigned_to: a1Row.employee_id }, MANAGER, 409);
      const sched = await call('POST', `/api/cases/${c.case_id}/visits/bulk`,
        { dates: [await day(2), await day(3), await day(4)], assigned_to: FIELD.employee_id, planned_start: '10:00', planned_end: '11:00' }, MANAGER, 201);
      const [v1, v2, v3] = sched.visits.sort((x, y) => x.visit_date.localeCompare(y.visit_date)).map((v) => v.visit_id);

      // ---- ส่งกะให้ A ----
      await call('POST', `/api/partners/visits/${v1}/send`, { partner_id: A.partner_id });
      let row = await visitRow(v1);
      assert.equal(row.assigned_to, null);
      assert.equal(row.partner_id, A.partner_id);
      assert.equal(row.partner_status, 'pending');
      assert.equal(Number(row.partner_rate), 600);
      assert.ok((await get('/api/my/notifications', leadA)).body.items.some((n) => n.kind === 'partner_job' && n.visit_id === v1));
      // ปฏิทินของคนดูแลเคสไม่เห็นกะที่ส่งไปแล้ว (ไม่ตกกลับเป็นของผู้รับผิดชอบเคส)
      const d1 = await day(2);
      const cal = (await get(`/api/cases/calendar?year=${d1.slice(0, 4)}&month=${d1.slice(5, 7)}&employee_id=${FIELD.employee_id}`, MANAGER)).body;
      assert.ok(!cal.some((v) => v.visit_id === v1));

      // ---- บริษัท B มองไม่เห็น/แตะไม่ได้ ----
      assert.ok(!(await call('GET', '/api/partner/visits?tab=pending', undefined, leadB)).some((v) => v.visit_id === v1));
      await call('GET', `/api/partner/visits/${v1}/candidates`, undefined, leadB, 404);
      await call('GET', `/api/partner/visits/${v1}`, undefined, leadB, 404);
      await call('POST', `/api/partner/visits/${v1}/accept`, { employee_id: b1Row.employee_id }, leadB, 404);
      await call('POST', `/api/partner/visits/${v1}/reject`, {}, leadB, 404);
      // หัวหน้าพาร์ทเนอร์เข้าหลังบ้าน KIN ไม่ได้ · พนักงานพาร์ทเนอร์เข้าหน้าหัวหน้าไม่ได้
      assert.equal((await get('/api/cases', leadA)).status, 403);
      assert.equal((await get('/api/employees', leadA)).status, 403);
      assert.equal((await get('/api/partners', leadA)).status, 403);
      assert.equal((await get('/api/partner/me', staffA1)).status, 401); // เข้าระบบไม่ได้เลยแล้ว (27 พ.ย. 2569)

      // ---- A เห็นงาน: ไม่มีราคา/ค่าจ้าง ----
      const pending = await call('GET', '/api/partner/visits?tab=pending', undefined, leadA);
      const job = pending.find((v) => v.visit_id === v1);
      assert.equal(job.client_name, 'Workflow patient');
      for (const k of ['fee', 'staff_pay', 'partner_rate', 'medical_history', 'current_symptoms']) assert.ok(!(k in job), `ไม่ควรมี ${k}`);
      // รายละเอียดเคสคร่าวๆ: มีลำดับครั้ง · ไม่มีอาการ/โรค/เบอร์/ราคา
      const detail = await call('GET', `/api/partner/visits/${v1}`, undefined, leadA);
      assert.equal(detail.client_name, 'Workflow patient');
      assert.ok(detail.visit_no >= 1 && detail.visit_total >= detail.visit_no);
      assert.ok(Array.isArray(detail.others));
      // รายละเอียดผู้รับบริการมาด้วย (ผู้ใช้ขอ 23 พ.ย. 2569) แต่ยังไม่มีเงิน/เบอร์ญาติ/หมายเหตุภายใน
      for (const k of ['current_symptoms', 'medical_history', 'care_goal', 'patient_allergies']) assert.ok(k in detail, `ควรมี ${k}`);
      for (const k of ['fee', 'staff_pay', 'partner_rate', 'client_phone', 'note', 'case_id']) assert.ok(!(k in detail), `ไม่ควรมี ${k}`);
      assert.equal((await get(`/api/partner/visits/${v1}`, staffA1)).status, 401);
      const cands = await call('GET', `/api/partner/visits/${v1}/candidates`, undefined, leadA);
      assert.deepEqual(cands.map((x) => x.employee_id), [a1Row.employee_id]);

      // ---- รับงาน: เลือกคนของบริษัทอื่นไม่ได้ · เลือกคนของตัวเองได้ ----
      await call('POST', `/api/partner/visits/${v1}/accept`, { employee_id: b1Row.employee_id }, leadA, 400);
      await call('POST', `/api/partner/visits/${v1}/accept`, { employee_id: a1Row.employee_id }, leadA);
      row = await visitRow(v1);
      assert.equal(row.assigned_to, a1Row.employee_id);
      assert.equal(row.partner_status, 'accepted');
      assert.ok((await call('GET', `/api/partner/team/${a1Row.employee_id}`, undefined, leadA)).visits.some((x) => x.visit_id === v1));
      // ญาติ/ลูกค้าได้ LINE ว่าใครจะไป — ชื่อพนักงานของพาร์ทเนอร์ที่หัวหน้าเลือก (ตรวจ 27 พ.ย. 2569)
      {
        const { ensureFamilyTable } = await import('../src/lib/family.js');
        const { claimVisitChanges } = await import('../src/notify/visitReminders.js');
        await ensureFamilyTable();
        await sql.run(`INSERT INTO case_family_links (case_id, line_user_id, invited_by, consent_by, accepted_at)
                       VALUES (:id, 'U-family-partner-test', 'EMP-0001', 'EMP-0001', now())`, { id: c.case_id });
        // ตอนส่งกะให้พาร์ทเนอร์ (คน KIN → ยังไม่มีคน) cron รอบ 15 นาทีหยิบไปแล้ว — จำลองว่าหยิบแล้ว เหลือแค่ตอนหัวหน้าเลือกคน
        // (ถ้าสองจังหวะอยู่ในรอบเดียวกัน ระบบรวมเป็น "เปลี่ยนจากคน KIN → คนของพาร์ทเนอร์" ซึ่งก็ถูกต้อง)
        await sql.run(`UPDATE visit_change_outbox SET claimed_at = now() WHERE visit_id = :v AND new_assignee IS NULL`, { v: v1 });
        await sql.run(`UPDATE visit_change_outbox SET created_at = now() - interval '5 minutes' WHERE case_id = :id`, { id: c.case_id });
        const change = (await claimVisitChanges()).find((x) => x.visit_id === v1 && x.new?.staff?.employee_id === a1Row.employee_id);
        assert.ok(change, 'มีข้อความเปลี่ยนคนของกะที่พาร์ทเนอร์รับ');
        assert.ok(change.family.includes('U-family-partner-test'), 'แจ้งญาติ');
        assert.equal(change.new.staff.name, 'เอ', 'ชื่อที่ญาติเห็น = ชื่อเล่นพนักงานพาร์ทเนอร์');
        // กะที่ยังไม่มีคนแล้วได้คนครั้งแรก = "แจ้งนักกายภาพบำบัดที่จะไป" ไม่ใช่ "แจ้งเปลี่ยน… จาก เจ้าหน้าที่" (27 พ.ย. 2569)
        assert.match(change.family_message, /^👤 แจ้งนักกายภาพบำบัดที่จะไปค่ะ/);
        assert.match(change.family_message, /คุณเอ จะไปถึงบ้าน/);
        assert.doesNotMatch(change.family_message, /เปลี่ยน|เจ้าหน้าที่/);
        assert.equal(change.family_title, 'แจ้งนักกายภาพบำบัดที่จะไป');
        assert.equal(change.new.staff.position, 'therapist');
        await sql.run('DELETE FROM case_family_links WHERE line_user_id = :u', { u: 'U-family-partner-test' });
      }
      // พนักงานพาร์ทเนอร์ไม่ได้เข้าระบบ = ไม่สร้างแจ้งเตือนในแอปให้ (27 พ.ย. 2569) · หัวหน้ายังได้ partner_job
      assert.equal((await sql.one('SELECT count(*)::int AS n FROM staff_notifications WHERE employee_id = :id', { id: a1Row.employee_id })).n, 0);
      assert.ok((await sql.one(`SELECT count(*)::int AS n FROM staff_notifications WHERE employee_id = :id AND kind = 'partner_job'`, { id: leadARow.employee_id })).n >= 1);

      // ---- พนักงานพาร์ทเนอร์ใช้หน้าภาคสนามไม่ได้แล้ว (ไม่มีเช็คอิน/ลงรายงานเอง · 27 พ.ย. 2569) ----
      for (const path of ['/api/my/cases', `/api/my/cases/${c.case_id}`, '/api/my/payslips']) {
        assert.equal((await get(path, staffA1)).status, 401, path);
      }

      // ---- เปลี่ยนคนดูแลเคส: กะของพาร์ทเนอร์ไม่ถูกย้ายตาม ----
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: 'EMP-0004' });
      assert.equal((await visitRow(v1)).assigned_to, a1Row.employee_id);
      assert.equal((await visitRow(v2)).assigned_to, 'EMP-0004');

      // ---- ค่าจ้างของเคส: คนของพาร์ทเนอร์ไม่อยู่ในการแบ่ง ----
      const pay = (await get(`/api/cases/${c.case_id}/pay`, MANAGER)).body;
      assert.ok(!pay.shares.some((x) => x.employee_id === a1Row.employee_id), JSON.stringify(pay.shares));

      // ---- ปิดบัญชีคนที่ยังถือกะข้างหน้าไม่ได้ ----
      await call('PATCH', `/api/partner/team/${a1Row.employee_id}`, { status: 'resigned' }, leadA, 409);

      // ---- ปฏิเสธ: กะกลับมาหา KIN + กระดิ่งหลังบ้าน ----
      await call('POST', `/api/partner/visits/${v1}/reject`, { reason: 'คนไม่พอ' }, leadA);
      row = await visitRow(v1);
      assert.equal(row.assigned_to, null);
      assert.equal(row.partner_id, null);
      assert.equal(row.partner_reject_reason, 'คนไม่พอ');
      assert.ok((await call('GET', '/api/partners/attention')).some((x) => x.visit_id === v1 && x.reason === 'rejected'));
      assert.ok((await get('/api/notify/alerts', MANAGER)).body.groups.attendance.partner_attention >= 1);

      // ---- ส่งอีกกะแล้ว KIN ดึงคืนให้คนของ KIN · ดึงคืนให้คนของพาร์ทเนอร์ไม่ได้ ----
      await call('POST', `/api/partners/visits/${v2}/send`, { partner_id: B.partner_id });
      await call('POST', `/api/partners/visits/${v2}/pull`, { assigned_to: b1Row.employee_id }, MANAGER, 409);
      await call('POST', `/api/partners/visits/${v2}/pull`, { assigned_to: FIELD.employee_id });
      row = await visitRow(v2);
      assert.equal(row.partner_id, null);
      assert.equal(row.assigned_to, FIELD.employee_id);
      // หลังบ้านเปลี่ยนคนเองในตารางนัด = ดึงคืนเหมือนกัน
      await call('POST', `/api/partners/visits/${v3}/send`, { partner_id: A.partner_id });
      await call('PATCH', `/api/cases/${c.case_id}/visits/${v3}`, { assigned_to: FIELD.employee_id });
      assert.equal((await visitRow(v3)).partner_id, null);

      // ---- เงิน: กะที่ไปจริง × เรท · ต้นทุนในรายงานกำไร · บันทึกจ่ายเดือนที่จบแล้ว ----
      const last = await sql.one(`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - interval '1 month', 'YYYY-MM') AS m`);
      const doneRow = await sql.one(
        `INSERT INTO case_visits (case_id, visit_date, status, assigned_to, checked_in_by, check_in_at, check_out_at,
                                  partner_id, partner_status, partner_rate, planned_start, planned_end)
         VALUES (:cid, :d, 'done', :e, :e, (:ts_in)::timestamptz, (:ts_out)::timestamptz, :pid, 'accepted', 600, '10:00', '11:00')
         RETURNING visit_id`,
        { cid: c.case_id, d: `${last.m}-15`, ts_in: `${last.m}-15 10:00+07`, ts_out: `${last.m}-15 11:00+07`,
          e: a1Row.employee_id, pid: A.partner_id },
      );
      const sumA = await call('GET', `/api/partner/summary?month=${last.m}`, undefined, leadA);
      assert.equal(sumA.done, 1);
      assert.equal(sumA.amount, 600);
      assert.equal(sumA.by_staff[0].employee_id, a1Row.employee_id);
      assert.equal((await call('GET', `/api/partner/summary?month=${last.m}`, undefined, leadB)).done, 0);
      const margin = (await get(`/api/invoices/revenue-bu/margin?from=${last.m}-01&to=${last.m}-28`, MANAGER)).body;
      assert.ok(margin.totals.cost >= 600, JSON.stringify(margin.totals));
      const thisMonth = (await day(0)).slice(0, 7);
      await call('POST', `/api/partners/${A.partner_id}/payments`, { month: thisMonth }, MANAGER, 409);
      const paid = await call('POST', `/api/partners/${A.partner_id}/payments`, { month: last.m }, MANAGER, 201);
      assert.equal(Number(paid.amount), 600);
      await call('POST', `/api/partners/${A.partner_id}/payments`, { month: last.m }, MANAGER, 409);
      assert.ok(doneRow.visit_id);

      // ---- หัวหน้าพาร์ทเนอร์ลงรายงาน + เวลาเริ่ม–จบ = กะไปจริง (แทนเช็คอินของพนักงาน · 27 พ.ย. 2569) ----
      const yday = await day(-1);
      const repVisit = await sql.one(
        `INSERT INTO case_visits (case_id, visit_date, status, assigned_to, partner_id, partner_status, partner_rate, planned_start, planned_end)
         VALUES (:cid, :d, 'scheduled', :e, :pid, 'accepted', 600, '10:00', '11:00') RETURNING visit_id`,
        { cid: c.case_id, d: yday, e: a1Row.employee_id, pid: A.partner_id },
      );
      const rid = repVisit.visit_id;
      const reportBody = { start: '10:15', end: '11:20', report_type: 'routine', note: 'ทำกายภาพครบตามแผน', pulse: 78 };
      await call('POST', `/api/partner/visits/${rid}/report`, reportBody, leadB, 404);
      await call('POST', `/api/partner/visits/${rid}/report`, { ...reportBody, start: '25:00' }, leadA, 400);
      // รายงานบันทึกไม่ผ่าน (ขาดช่องบังคับ) = เวลาที่ลงไว้ถูกถอนคืน กะไม่นับเงินโดยไม่มีรายงาน
      await call('POST', `/api/partner/visits/${rid}/report`, { start: '10:15', end: '11:20', pulse: 78 }, leadA, 409);
      assert.equal((await visitRow(rid)).check_in_at, null);
      const made = await call('POST', `/api/partner/visits/${rid}/report`, reportBody, leadA, 201);
      assert.equal(made.visit_id, rid);
      assert.equal(made.reported_by, leadARow.employee_id);
      const rv = await visitRow(rid);
      assert.equal(rv.status, 'done');
      assert.equal(rv.checked_in_by, a1Row.employee_id);
      assert.equal(rv.location_flagged, false);
      const mins = await sql.one(
        `SELECT to_char(check_in_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS i, to_char(check_out_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS o,
                check_in_late_minutes AS late FROM case_visits WHERE visit_id = :id`, { id: rid });
      assert.deepEqual([mins.i, mins.o, Number(mins.late)], ['10:15', '11:20', 15]);
      await call('POST', `/api/partner/visits/${rid}/report`, reportBody, leadA, 409);
      // ยังไม่ถึงวันนัด / ยังไม่เลือกคน = ลงไม่ได้
      const future = await sql.one(
        `INSERT INTO case_visits (case_id, visit_date, status, assigned_to, partner_id, partner_status, partner_rate)
         VALUES (:cid, :d, 'scheduled', :e, :pid, 'accepted', 600) RETURNING visit_id`,
        { cid: c.case_id, d: await day(12), e: a1Row.employee_id, pid: A.partner_id },
      );
      assert.match((await call('POST', `/api/partner/visits/${future.visit_id}/report`, reportBody, leadA, 409)).error, /ยังไม่ถึงวันนัด/);
      await sql.run('DELETE FROM case_visits WHERE visit_id = :id', { id: future.visit_id });

      // ---- ลงนัดแล้วส่งให้พาร์ทเนอร์เลย (แผงลงนัด) — ไม่มีคน · ไม่เติมผู้รับผิดชอบเคส · แจ้งหัวหน้าครั้งเดียว ----
      await call('POST', `/api/cases/${c.case_id}/visits/bulk`,
        { dates: [await day(5)], partner_id: A.partner_id, assigned_to: FIELD.employee_id }, MANAGER, 400);
      const beforeN = (await get('/api/my/notifications', leadA)).body.items.filter((n) => n.kind === 'partner_job').length;
      const bulk = await call('POST', `/api/cases/${c.case_id}/visits/bulk`,
        { dates: [await day(5), await day(6), await day(7)], partner_id: A.partner_id, planned_start: '13:00', planned_end: '14:00' }, MANAGER, 201);
      assert.equal(bulk.added, 3);
      for (const id of bulk.inserted_ids) {
        const r = await visitRow(id);
        assert.equal(r.assigned_to, null);
        assert.equal(r.partner_id, A.partner_id);
        assert.equal(r.partner_status, 'pending');
        assert.equal(Number(r.partner_rate), 600);
        assert.equal(r.partner_english, null, 'เคสปกติไม่บวกค่าภาษา');
      }
      const jobs = (await get('/api/my/notifications', leadA)).body.items.filter((n) => n.kind === 'partner_job');
      assert.equal(jobs.length, beforeN + 1, 'แจ้งหัวหน้าครั้งเดียวสำหรับทั้งชุด');
      assert.equal(jobs[0].payload.total, 3);
      assert.ok((await call('GET', '/api/partner/visits?tab=pending', undefined, leadA)).filter((v) => bulk.inserted_ids.includes(v.visit_id)).length === 3);
      // ---- ค่าภาษาอังกฤษต่อครั้ง (25 พ.ย. 2569): เคสที่ขอภาษาอังกฤษ = เรท + ค่าภาษา · จดไว้ ณ ตอนส่ง ทั้งลงนัดแล้วส่งและส่งทีละกะ ----
      await call('PATCH', `/api/partners/${A.partner_id}`, { english_rate: 150 });
      await sql.run('UPDATE cases SET pkg_english = TRUE WHERE case_id = :id', { id: c.case_id });
      const enBulk = await call('POST', `/api/cases/${c.case_id}/visits/bulk`,
        { dates: [await day(8)], partner_id: A.partner_id, planned_start: '13:00', planned_end: '14:00' }, MANAGER, 201);
      const enRow = await visitRow(enBulk.inserted_ids[0]);
      assert.equal(Number(enRow.partner_rate), 750);
      assert.equal(Number(enRow.partner_english), 150);
      await call('POST', `/api/partners/visits/${v3}/send`, { partner_id: A.partner_id });
      assert.equal(Number((await visitRow(v3)).partner_rate), 750, 'ส่งทีละกะก็บวกค่าภาษา');
      await sql.run('UPDATE cases SET pkg_english = FALSE WHERE case_id = :id', { id: c.case_id });
      await call('PATCH', `/api/partners/${A.partner_id}`, { english_rate: 0 });
      // ---- ลบพาร์ทเนอร์ (25 พ.ย. 2569): มีงานที่ไปจริง/บันทึกจ่าย = ลบไม่ได้ · บริษัทว่าง = ลบพร้อมบัญชีของบริษัท ----
      assert.match((await call('DELETE', `/api/partners/${A.partner_id}`, undefined, MANAGER, 409)).error, /ลบไม่ได้/);
      await call('DELETE', `/api/partners/${A.partner_id}`, undefined, FIELD, 403);
      const Z = await call('POST', '/api/partners', { name: 'ซี ทดลอง', rate_per_visit: 100 }, MANAGER, 201);
      const leadZ = await call('POST', `/api/partners/${Z.partner_id}/leads`, { first_name: 'หัวหน้า', last_name: 'ซี' }, MANAGER, 201);
      const zVisit = (await call('POST', `/api/cases/${c.case_id}/visits/bulk`,
        { dates: [await day(9)], partner_id: Z.partner_id }, MANAGER, 201)).inserted_ids[0];
      assert.match((await call('DELETE', `/api/partners/${Z.partner_id}`, undefined, MANAGER, 409)).error, /ดึงคืนก่อน/);
      await call('POST', `/api/partners/visits/${zVisit}/pull`, { assigned_to: FIELD.employee_id });
      assert.equal((await call('DELETE', `/api/partners/${Z.partner_id}`, undefined, MANAGER, 200)).removed, true);
      assert.equal(await sql.one('SELECT 1 AS x FROM partners WHERE partner_id = :id', { id: Z.partner_id }), null);
      assert.equal(await sql.one('SELECT 1 AS x FROM employees WHERE employee_id = :id', { id: leadZ.employee_id }), null);
      assert.equal((await visitRow(zVisit)).partner_id, null);
      // ---- ฝั่งงานของบริษัท (26 พ.ย. 2569): ไม่ระบุ = Homecare · บริษัทกายภาพส่งงาน Homecare ไม่ได้ ----
      assert.equal((await call('GET', '/api/partners', undefined, MANAGER)).find((p) => p.partner_id === A.partner_id).service_kind, 'homecare');
      await call('POST', '/api/partners', { name: 'ผิดประเภท', rate_per_visit: 1, service_kind: 'both' }, MANAGER, 400);
      const P = await call('POST', '/api/partners', { name: 'พี กายภาพ', rate_per_visit: 300, service_kind: 'physio' }, MANAGER, 201);
      assert.equal(P.service_kind, 'physio');
      await call('POST', `/api/partners/${P.partner_id}/leads`, { first_name: 'หัวหน้า', last_name: 'พี' }, MANAGER, 201);
      assert.match((await call('POST', `/api/cases/${c.case_id}/visits/bulk`,
        { dates: [await day(10)], partner_id: P.partner_id }, MANAGER, 409)).error, /ไม่ได้รับงานHomecare/);
      assert.match((await call('POST', `/api/partners/visits/${v1}/send`, { partner_id: P.partner_id }, MANAGER, 409)).error, /ไม่ได้รับงาน/);
      assert.equal((await call('PATCH', `/api/partners/${P.partner_id}`, { service_kind: 'homecare' })).service_kind, 'homecare');
      assert.equal((await call('DELETE', `/api/partners/${P.partner_id}`, undefined, MANAGER, 200)).removed, true);
      // ---- โลโก้: หลังบ้านอัปโหลด · หัวหน้าพาร์ทเนอร์โหลดรูปได้ · รายการไม่ส่งไบนารีออกไป ----
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      await call('PUT', `/api/partners/${A.partner_id}/logo`, { image: 'data:text/html;base64,PHNjcmlwdD4=' }, MANAGER, 400);
      await call('PUT', `/api/partners/${A.partner_id}/logo`, { image: png }, leadA, 403);
      const withLogo = await call('PUT', `/api/partners/${A.partner_id}/logo`, { image: png });
      assert.equal(withLogo.has_logo, true);
      assert.ok(Number(withLogo.logo_version) > 0);
      assert.ok(!('logo_data' in withLogo));
      assert.ok(!('logo_data' in (await call('GET', '/api/partners')).find((x) => x.partner_id === A.partner_id)));
      const img = await fetch(`${base}/api/partner-logos/${A.partner_id}`, { headers: { cookie: `${COOKIE_NAME}=${signToken(leadA)}` } });
      assert.equal(img.status, 200);
      assert.equal(img.headers.get('content-type'), 'image/png');
      assert.equal((await call('GET', '/api/partner/me', undefined, leadA)).has_logo, true);
      await call('PUT', `/api/partners/${A.partner_id}/logo`, { image: null });
      assert.equal((await fetch(`${base}/api/partner-logos/${A.partner_id}`, { headers: { cookie: `${COOKIE_NAME}=${signToken(leadA)}` } })).status, 404);

      // บริษัทที่ไม่มีหัวหน้า ส่งไม่ได้
      const lonely = await call('POST', '/api/partners', { name: 'ไม่มีหัวหน้า', rate_per_visit: 1 }, MANAGER, 201);
      await call('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [await day(8)], partner_id: lonely.partner_id }, MANAGER, 409);

      // ---- ตรวจ 21 พ.ย. 2569 ----
      // server กันการเลือกคนที่ชนเวลา (ไม่พึ่งปุ่มบนหน้าเว็บ)
      const [jobA, jobB] = bulk.inserted_ids;
      await call('POST', `/api/partner/visits/${jobA}/accept`, { employee_id: a1Row.employee_id }, leadA);
      await sql.run(`UPDATE case_visits SET visit_date = (SELECT visit_date FROM case_visits WHERE visit_id = :a) WHERE visit_id = :b`, { a: jobA, b: jobB });
      assert.match((await call('POST', `/api/partner/visits/${jobB}/accept`, { employee_id: a1Row.employee_id }, leadA, 409)).error, /ชนเวลา/);
      // กะดึกข้ามคืน (ตรวจ 23 พ.ย. 2569): 20:00–08:00 คืนนี้ ชนกับ 06:00 เช้าพรุ่งนี้ · ต่อกันพอดี 08:00 ไม่ชน
      await sql.run(`UPDATE case_visits SET planned_start = '20:00', planned_end = '08:00' WHERE visit_id = :a`, { a: jobA });
      await sql.run(`UPDATE case_visits SET visit_date = to_char(visit_date::date + 1, 'YYYY-MM-DD'), planned_start = '06:00', planned_end = '10:00'
                     WHERE visit_id = :b`, { b: jobB });
      assert.match((await call('POST', `/api/partner/visits/${jobB}/accept`, { employee_id: a1Row.employee_id }, leadA, 409)).error, /ชนเวลา/);
      assert.equal((await call('GET', `/api/partner/visits/${jobB}/candidates`, undefined, leadA)).find((x) => x.employee_id === a1Row.employee_id).conflict, true);
      await sql.run(`UPDATE case_visits SET planned_start = '08:00', planned_end = '20:00' WHERE visit_id = :b`, { b: jobB });
      assert.equal((await call('GET', `/api/partner/visits/${jobB}/candidates`, undefined, leadA)).find((x) => x.employee_id === a1Row.employee_id).conflict, false);
      // HR เปิด/แก้บัญชีคนของพาร์ทเนอร์ผ่านหน้าพนักงาน KIN ไม่ได้
      assert.equal((await get(`/api/employees/${a1Row.employee_id}`, HR)).status, 404);
      await call('PATCH', `/api/employees/${a1Row.employee_id}`, { position: 'manager' }, HR, 404);
      // ตัวเลขเงิน: HR (ไม่เห็นค่าจ้าง) ไม่เห็นเรท/สรุป · การเงิน (ไม่มี office) ดูสรุปได้แต่จัดการงานไม่ได้
      assert.equal((await call('GET', '/api/partners', undefined, HR)).find((x) => x.partner_id === A.partner_id).rate_per_visit, undefined);
      assert.equal((await get(`/api/partners/summary?month=${last.m}`, HR)).status, 403);
      await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
                     VALUES ('EMP-0393', 'Fin', 'Partner', 'finance', 'emp-0393@example.invalid', 'active', 'x', false)`);
      const FIN = emp('EMP-0393', 'finance');
      assert.equal((await get(`/api/partners/summary?month=${last.m}`, FIN)).status, 200);
      assert.equal((await get('/api/partners', FIN)).status, 403);
      // KIN ปิดบัญชีคนของพาร์ทเนอร์ = ระงับ · หัวหน้าเปิดคืนเองไม่ได้ · KIN เปิดคืนได้ (ตรวจ 23 พ.ย. 2569)
      const x1 = await call('POST', '/api/partner/team', { first_name: 'ระงับ', last_name: 'ทดสอบ', position: 'therapist' }, leadA, 201);
      assert.equal((await call('PATCH', `/api/partners/${A.partner_id}/people/${x1.employee_id}`, { status: 'resigned' })).status, 'suspended');
      assert.match((await call('PATCH', `/api/partner/team/${x1.employee_id}`, { status: 'active' }, leadA, 403)).error, /KIN/);
      assert.equal((await call('PATCH', `/api/partners/${A.partner_id}/people/${x1.employee_id}`, { status: 'active' })).status, 'active');
      // หัวหน้าปิดเอง → เปิดคืนเองได้
      await call('PATCH', `/api/partner/team/${x1.employee_id}`, { status: 'resigned' }, leadA);
      assert.equal((await call('PATCH', `/api/partner/team/${x1.employee_id}`, { status: 'active' }, leadA)).status, 'active');
      // ปิดคนที่เช็คอินอยู่ (ยังไม่เช็คเอาท์) ไม่ได้
      await sql.run(`UPDATE case_visits SET check_in_at = now(), checked_in_by = :e WHERE visit_id = :v`, { e: a1Row.employee_id, v: jobA });
      await call('PATCH', `/api/partner/team/${a1Row.employee_id}`, { status: 'resigned' }, leadA, 409);
      await sql.run(`UPDATE case_visits SET check_in_at = NULL, checked_in_by = NULL WHERE visit_id = :v`, { v: jobA });
      // ปิดบริษัทที่ยังมีงานค้างไม่ได้ → ดึงคืนก่อน
      assert.match((await call('PATCH', `/api/partners/${A.partner_id}`, { status: 'inactive' }, MANAGER, 409)).error, /ดึงคืน/);
      const open = await sql.all(`SELECT visit_id FROM case_visits WHERE partner_id = :p AND status <> 'cancelled' AND check_out_at IS NULL`, { p: A.partner_id });
      for (const o of open) await call('POST', `/api/partners/visits/${o.visit_id}/pull`, {});
      // เก็บกวาด: กะที่ดึงคืนไปตกที่ผู้รับผิดชอบเคส — ยกเลิกทิ้ง ไม่ให้ไปเพิ่มภาระงานในเทสหน้าภาพรวม
      await sql.run(`UPDATE case_visits SET status = 'cancelled' WHERE visit_id = ANY(:ids::int[])`, { ids: open.map((o) => o.visit_id) });
      // ปิดใช้งานบริษัท → ทุกบัญชีของบริษัท (หัวหน้า + พนักงาน) ใช้ระบบไม่ได้
      await call('PATCH', `/api/partners/${A.partner_id}`, { status: 'inactive' });
      assert.equal((await get('/api/partner/visits?tab=pending', leadA)).status, 401);
      await call('POST', `/api/partner/visits/${jobB}/reject`, {}, leadA, 401);
      assert.equal((await get('/api/my/cases', staffA1)).status, 401);
      assert.equal((await get('/api/auth/me', staffA1)).status, 401);
    });
  });

  describe('กะของเคส — แก้นัดหมาย / ย้ายตามคนดูแล / ส่วนแบ่งทีม / เปิดเคสคืนกะ / กะข้ามเที่ยงคืน', () => {
    const LEAD_A = emp('EMP-0082', 'caregiver');
    const LEAD_B = emp('EMP-0083', 'caregiver');
    let today;
    const inDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

    async function call(method, path, body, who = MANAGER, expected = 200) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      assert.equal(res.status, expected, `${method} ${path}: ${text}`);
      return data;
    }
    const visitRow = (id) => sql.one('SELECT * FROM case_visits WHERE visit_id = :id', { id });
    const assignees = async (caseId) => Object.fromEntries(
      (await sql.all('SELECT visit_date, assigned_to FROM case_visits WHERE case_id = :id', { id: caseId }))
        .map((r) => [r.visit_date, r.assigned_to]),
    );
    const statuses = async (caseId) => Object.fromEntries(
      (await sql.all('SELECT visit_date, status, auto_cancelled_at FROM case_visits WHERE case_id = :id', { id: caseId }))
        .map((r) => [r.visit_date, r]),
    );

    before(async () => {
      ({ today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`));
      for (const id of [LEAD_A.employee_id, LEAD_B.employee_id]) {
        await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
                       VALUES (:id, 'Visit', :id, 'caregiver', :email, 'active', 'x', false)
                       ON CONFLICT (employee_id) DO NOTHING`, { id, email: `${id.toLowerCase()}@example.invalid` });
      }
    });

    test('PATCH กะ: กะที่เช็คอินแล้วแก้ได้แค่หมายเหตุ · ย้ายวันลงประวัติ · เคสจบ/ปล่อยเงินแล้วเปลี่ยนสถานะไม่ได้', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      const sched = await post(`/api/cases/${c.case_id}/visits/bulk`,
        { dates: [today, inDays(3)], assigned_to: FIELD.employee_id }, MANAGER, 201);
      const attended = sched.visits.find((v) => v.visit_date === today);
      const future = sched.visits.find((v) => v.visit_date === inDays(3));
      assert.ok(await casesRepo.checkInVisit(attended.visit_id, { employee_id: FIELD.employee_id, lat: null, lng: null,
        accuracy: null, distance: null, flagged: true, photo: null }));

      // หน้าเว็บส่งทั้งฟอร์ม — ค่าเดิมของช่องที่ล็อกติดมาด้วยต้องไม่ถูกปฏิเสธ แก้หมายเหตุได้ตามปกติ
      const row = await visitRow(attended.visit_id);
      const form = { visit_date: row.visit_date, assigned_to: row.assigned_to, planned_start: row.planned_start,
        planned_end: row.planned_end, status: row.status, note: 'แก้หมายเหตุได้' };
      const path = `/api/cases/${c.case_id}/visits/${attended.visit_id}`;
      await call('PATCH', path, form);
      assert.equal((await visitRow(attended.visit_id)).note, 'แก้หมายเหตุได้');
      assert.match((await call('PATCH', path, { ...form, visit_date: inDays(1) }, MANAGER, 409)).error, /เช็คอินไปแล้ว/);
      await call('PATCH', path, { ...form, status: 'cancelled' }, MANAGER, 409);
      await call('PATCH', path, { ...form, assigned_to: LEAD_A.employee_id }, MANAGER, 409);
      await call('PATCH', path, { ...form, planned_start: '09:00' }, MANAGER, 409);
      assert.equal((await visitRow(attended.visit_id)).visit_date, today);

      // กะที่ยังไม่มีใครไป ย้ายวันได้ และลงประวัติว่าเปลี่ยนจากอะไรเป็นอะไร
      const futurePath = `/api/cases/${c.case_id}/visits/${future.visit_id}`;
      await call('PATCH', futurePath, { visit_date: inDays(4), planned_start: '09:00', planned_end: '12:00' });
      assert.equal((await visitRow(future.visit_id)).visit_date, inDays(4));
      const events = (await get(`/api/cases/${c.case_id}/events`, MANAGER)).body;
      const edited = events.find((e) => e.event === 'visit_edited' && e.detail.includes(`วันนัด ${inDays(3)} → ${inDays(4)}`));
      assert.ok(edited, JSON.stringify(events.map((e) => e.detail)));
      assert.match(edited.detail, /เวลาเริ่ม - → 09:00/);

      // เคสจบแล้ว: เปิดกะกลับมา/ย้ายวันไม่ได้ แต่ยังแก้หมายเหตุได้
      await post(`/api/cases/${c.case_id}/close`, { force: true });
      assert.equal((await visitRow(future.visit_id)).status, 'cancelled');
      assert.match((await call('PATCH', futurePath, { status: 'scheduled' }, MANAGER, 409)).error, /เปิดเคสใหม่/);
      await call('PATCH', futurePath, { visit_date: inDays(5) }, MANAGER, 409);
      await call('PATCH', futurePath, { note: 'ยังจดได้' });

      // ปล่อยเงินแล้ว: เปลี่ยนสถานะกะไม่ได้ (กติกาเดียวกับ /adjust)
      await post(`/api/cases/${c.case_id}/reopen`, {});
      await post(`/api/cases/${c.case_id}/pay/release`, { request_id: randomUUID(), amount: 100 }, MANAGER, 201);
      assert.match((await call('PATCH', futurePath, { status: 'cancelled' }, MANAGER, 409)).error, /ปล่อยค่าจ้าง/);
    });

    test('กระดิ่งพนักงาน: กะใหม่ / เลื่อน / ย้ายคน / ยกเลิก / เตือนก่อนถึงกะ · กดอ่านได้เฉพาะของตัวเอง', async () => {
      const mine = async (who, caseId) => (await get('/api/my/notifications', who)).body.items.filter((n) => n.case_id === caseId);
      const c = await newCase();
      const before = (await mine(LEAD_A, c.case_id)).length;
      const sched = await post(`/api/cases/${c.case_id}/visits/bulk`,
        { dates: [inDays(1), inDays(5)], assigned_to: LEAD_A.employee_id }, MANAGER, 201);
      let a = await mine(LEAD_A, c.case_id);
      const added = a.find((n) => n.kind === 'visits_added');
      assert.ok(added, JSON.stringify(a));
      assert.equal(added.payload.total, 2);
      assert.equal(added.payload.date, inDays(1));
      assert.equal(added.payload.last_date, inDays(5));
      assert.ok(a.length > before);

      const near = sched.visits.find((v) => v.visit_date === inDays(1));
      const far = sched.visits.find((v) => v.visit_date === inDays(5));
      const farPath = `/api/cases/${c.case_id}/visits/${far.visit_id}`;

      // เลื่อนวัน → คนเดิมได้ "กะถูกเลื่อน" พร้อมวันเก่า/ใหม่
      await call('PATCH', farPath, { visit_date: inDays(6) });
      a = await mine(LEAD_A, c.case_id);
      const moved = a.find((n) => n.kind === 'visit_moved');
      assert.equal(moved?.payload.old_date, inDays(5));
      assert.equal(moved?.payload.date, inDays(6));

      // ย้ายกะไปให้อีกคน → คนเก่า "ถูกย้ายไปให้คนอื่น" · คนใหม่ "กะใหม่"
      await call('PATCH', farPath, { assigned_to: LEAD_B.employee_id });
      assert.ok((await mine(LEAD_A, c.case_id)).some((n) => n.kind === 'visit_removed' && n.visit_id === far.visit_id));
      const b = await mine(LEAD_B, c.case_id);
      assert.ok(b.some((n) => n.kind === 'visits_added' && n.visit_id === far.visit_id && n.payload.date === inDays(6)), JSON.stringify(b));

      // ยกเลิกกะ → "กะถูกยกเลิก"
      await call('PATCH', `/api/cases/${c.case_id}/visits/${near.visit_id}`, { status: 'cancelled' });
      assert.ok((await mine(LEAD_A, c.case_id)).some((n) => n.kind === 'visit_cancelled' && n.visit_id === near.visit_id));

      // เตือน 3 ชม. ก่อนกะ — สร้างตอนดึงรายการ (ไม่ต้องมี cron) และไม่ซ้ำเมื่อดึงอีกรอบ
      const { soon } = await sql.one(`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '1 hour', 'HH24:MI') AS soon`);
      if (soon > '01:00') { // ข้ามช่วงใกล้เที่ยงคืน (เวลา +1 ชม. ข้ามไปวันพรุ่งนี้)
        const s2 = await post(`/api/cases/${c.case_id}/visits/bulk`,
          { dates: [today], assigned_to: LEAD_A.employee_id, planned_start: soon }, MANAGER, 201);
        const v = s2.visits.find((x) => x.visit_date === today);
        await get('/api/my/notifications', LEAD_A);
        const r = (await mine(LEAD_A, c.case_id)).filter((n) => n.kind === 'remind_3h' && n.visit_id === v.visit_id);
        assert.equal(r.length, 1, 'เตือนหนึ่งครั้ง ดึงซ้ำไม่สร้างเพิ่ม');
        assert.equal(r[0].payload.start, soon);
      }

      // อ่านแล้ว: คนอื่นกดแทนไม่ได้ · ของตัวเองกดแล้วเลขแดงเป็น 0
      const ids = (await mine(LEAD_A, c.case_id)).map((n) => n.id);
      assert.equal((await call('POST', '/api/my/notifications/read', { ids }, LEAD_B)).updated, 0);
      assert.ok((await get('/api/my/notifications', LEAD_A)).body.unread > 0);
      await call('POST', '/api/my/notifications/read', {}, LEAD_A);
      assert.equal((await get('/api/my/notifications', LEAD_A)).body.unread, 0);
      await call('POST', '/api/my/notifications/read', { ids: 'x' }, LEAD_A, 400);
    });

    test('แจ้งเตือนบนมือถือ (Web Push): สมัครต่อเครื่อง · ส่งก่อนตอบคำขอ · ไม่ส่งซ้ำ · เครื่องที่เลิกรับถูกลบ · ย้ายเครื่องตามคนล็อกอิน', async () => {
      const webpush = (await import('web-push')).default;
      const push = await import('../src/notify/webPush.js');
      const saved = { ...process.env };
      const realSend = webpush.sendNotification;
      const sent = [];
      let gone = new Set();
      // ไม่ยิงออกเน็ตจริง — ดักที่ตัวส่งของ web-push แล้วเก็บข้อความไว้ตรวจ
      webpush.sendNotification = async (sub, body) => {
        if (gone.has(sub.endpoint)) { const e = new Error('gone'); e.statusCode = 410; throw e; }
        sent.push({ endpoint: sub.endpoint, msg: JSON.parse(body) });
        return { statusCode: 201 };
      };
      const ep = (n) => `https://push.example.test/${LEAD_A.employee_id}/${n}`;
      const q = (n) => `/api/my/push?endpoint=${encodeURIComponent(ep(n))}`;
      const key = { p256dh: 'BOr-test-p256dh-key-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJK', auth: 'auth-secret-0123' };
      try {
        // ยังไม่ตั้งกุญแจ → ปิดเงียบ (หน้าตั้งค่าบอกว่ายังไม่เปิดใช้) · สมัครไม่ได้
        delete process.env.VAPID_PUBLIC_KEY;
        assert.equal((await get('/api/my/push', LEAD_A)).body.enabled, false);
        await call('POST', '/api/my/push', { endpoint: ep(1), keys: key }, LEAD_A, 503);

        const vapid = webpush.generateVAPIDKeys();
        Object.assign(process.env, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.test' });
        const st = (await get('/api/my/push', LEAD_A)).body;
        assert.equal(st.enabled, true);
        assert.equal(st.public_key, vapid.publicKey);
        await call('POST', '/api/my/push', { endpoint: 'http://insecure.test/x', keys: key }, LEAD_A, 400);
        await call('POST', '/api/my/push', { endpoint: ep(1), keys: key }, LEAD_A);
        await call('POST', '/api/my/push', { endpoint: ep(2), keys: key }, LEAD_A);
        assert.equal((await get(q(1), LEAD_A)).body.subscribed, true);
        assert.equal((await get(q(1), LEAD_B)).body.subscribed, false);

        // ลงกะใหม่ให้ LEAD_A → push ถึงทั้งสองเครื่องก่อนคำขอตอบกลับ (ไม่ต้องรอ cron)
        await push.flushPending(); // ของค้างจากเทสก่อน ๆ
        sent.length = 0;
        const c = await newCase();
        const sched = await call('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [inDays(2)], assigned_to: LEAD_A.employee_id }, MANAGER, 201);
        assert.deepEqual(sent.map((x) => x.endpoint).sort(), [ep(1), ep(2)]);
        assert.equal(sent[0].msg.title, 'กะใหม่');
        assert.match(sent[0].msg.body, /Workflow patient/);
        assert.equal(sent[0].msg.url, '/my-calendar');
        assert.doesNotMatch(JSON.stringify(sent[0].msg), /฿|บาท|2000|1200/, 'ไม่มีเงินบนจอล็อก');

        // ไม่ส่งซ้ำ: flush อีกรอบไม่มีอะไรออก
        sent.length = 0;
        assert.equal((await push.flushPending()).claimed, 0);
        assert.equal(sent.length, 0);

        // เลื่อนกะ — เครื่องที่ 2 เลิกรับไปแล้ว (410) → ถูกลบ · เครื่องที่ 1 ยังได้
        gone = new Set([ep(2)]);
        const vPath = `/api/cases/${c.case_id}/visits/${sched.visits[0].visit_id}`;
        await call('PATCH', vPath, { visit_date: inDays(3) });
        assert.deepEqual(sent.map((x) => [x.endpoint, x.msg.title]), [[ep(1), 'กะถูกเลื่อน']]);
        assert.equal((await get(q(2), LEAD_A)).body.subscribed, false);

        // คำขอที่ล้มไม่ส่ง
        sent.length = 0;
        await call('PATCH', vPath, { visit_date: 'x' }, MANAGER, 400);
        assert.equal(sent.length, 0);

        // เครื่องเดียวกันมีคนอื่นล็อกอิน → ย้ายเป็นของคนล่าสุด กะของ A ไม่เด้งบนเครื่องที่ B ถืออยู่
        await call('POST', '/api/my/push', { endpoint: ep(1), keys: key }, LEAD_B);
        assert.equal((await get(q(1), LEAD_A)).body.subscribed, false);
        assert.equal((await get(q(1), LEAD_B)).body.subscribed, true);
        sent.length = 0;
        await call('PATCH', vPath, { visit_date: inDays(4) });
        assert.equal(sent.length, 0);

        // ปุ่มทดสอบ · เลิกรับ
        assert.equal((await call('POST', '/api/my/push/test', { endpoint: ep(1) }, LEAD_B)).sent, 1);
        assert.equal(sent[0].msg.tag, 'kin-test');
        await call('POST', '/api/my/push/test', { endpoint: ep(1) }, LEAD_A, 409); // ไม่ใช่เครื่องของ A แล้ว
        await call('DELETE', '/api/my/push', { endpoint: ep(1) }, LEAD_B);
        assert.equal((await get(q(1), LEAD_B)).body.subscribed, false);

        // เตือนก่อนนัดจากรอบ cron 15 นาที (สร้างของทุกคน) แล้วส่ง push
        await call('POST', '/api/my/push', { endpoint: ep(3), keys: key }, LEAD_A);
        const inbox = await import('../src/notify/staffInbox.js');
        // ปรับนาฬิกาไม่ได้ จึงตรวจด้วยกะของวันนี้ที่เริ่มอีก 1 ชม. (เข้ารอบเตือน 3 ชม. ทันที)
        const { soon } = await sql.one(`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '1 hour', 'HH24:MI') AS soon`);
        if (soon > '01:00') {
          const s2 = await call('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [today], assigned_to: LEAD_A.employee_id, planned_start: soon }, MANAGER, 201);
          sent.length = 0;
          await inbox.materializeReminders(null);
          await push.flushPending();
          const r = sent.filter((x) => x.msg.title === 'ใกล้ถึงเวลากะ');
          assert.equal(r.length, 1, JSON.stringify(sent));
          assert.equal(r[0].msg.url, '/my-today');
          assert.ok(s2.visits.length >= 1);
        }

        // ข้อความ: ถ้อยคำตรงกับกระดิ่ง
        assert.deepEqual(push.describe({ id: 9, kind: 'remind_3h', payload: { client: 'คุณเอ', date: today, start: '13:00' } }),
          { title: 'ใกล้ถึงเวลากะ', body: 'คุณเอ · เริ่ม 13:00 น.', url: '/my-today', tag: 'kin-9' });
        assert.equal(push.describe({ id: 1, kind: 'visit_cancelled', payload: { client: 'คุณบี', date: today } }).url, '/my-calendar');
      } finally {
        webpush.sendNotification = realSend;
        for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
          if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
      }
    });

    test('เปลี่ยนคนดูแลเคส: กะข้างหน้าย้ายตาม · กะที่ลงตอนยังไม่มีคนได้เจ้าของ · ถอดคนแล้วไม่ค้างชื่อ', async () => {
      const c = await newCase();
      const sched = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [inDays(-1), today, inDays(2)] }, MANAGER, 201);
      assert.ok(sched.visits.every((v) => v.assigned_to === null), 'เคสยังไม่มีคน กะจึงยังว่าง');

      await post(`/api/cases/${c.case_id}/assign`, { employee_id: LEAD_B.employee_id });
      let w = await assignees(c.case_id);
      assert.equal(w[inDays(-1)], null, 'กะที่ผ่านไปแล้วไม่แตะ');
      assert.equal(w[today], LEAD_B.employee_id);
      assert.equal(w[inDays(2)], LEAD_B.employee_id);
      const mine = (await get('/api/my/today', LEAD_B)).body;
      assert.ok(mine.some((v) => v.case_id === c.case_id), 'งานวันนี้ของคนใหม่ต้องเห็นกะที่เพิ่งได้รับ');

      // เปลี่ยนคนหลัก → กะข้างหน้าของคนเดิมตามไปเป็นของคนใหม่
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: LEAD_A.employee_id });
      w = await assignees(c.case_id);
      assert.equal(w[today], LEAD_A.employee_id);
      assert.equal(w[inDays(2)], LEAD_A.employee_id);
      assert.ok(!(await get('/api/my/today', LEAD_B)).body.some((v) => v.case_id === c.case_id));

      // คนในทีมที่ถูกนำออก — กะของเขาคืนให้คนหลัก
      await post(`/api/cases/${c.case_id}/team`, { employee_id: FIELD.employee_id });
      const later = sched.visits.find((v) => v.visit_date === inDays(2));
      await call('PATCH', `/api/cases/${c.case_id}/visits/${later.visit_id}`, { assigned_to: FIELD.employee_id });
      await call('DELETE', `/api/cases/${c.case_id}/team/${FIELD.employee_id}`);
      assert.equal((await visitRow(later.visit_id)).assigned_to, LEAD_A.employee_id);

      // ถอดคนหลักโดยไม่มีใครรับต่อ → กะข้างหน้ากลายเป็นกะว่าง ไม่ค้างชื่อคนที่ถูกถอด
      await post(`/api/cases/${c.case_id}/unassign`, {});
      w = await assignees(c.case_id);
      assert.equal(w[today], null);
      assert.equal(w[inDays(2)], null);

      // คนหลักที่ถูกพักงาน — ลงกะโดยไม่ระบุคน (= ใช้คนหลัก) ต้องถูกปฏิเสธพร้อมบอกทางออก
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: LEAD_B.employee_id });
      await sql.run(`UPDATE employees SET status = 'suspended' WHERE employee_id = :id`, { id: LEAD_B.employee_id });
      try {
        const refused = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [inDays(6)] }, MANAGER, 409);
        assert.match(refused.error, /ผู้รับผิดชอบหลัก/);
        await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [inDays(6)], assigned_to: LEAD_A.employee_id }, MANAGER, 201);
      } finally {
        await sql.run(`UPDATE employees SET status = 'active' WHERE employee_id = :id`, { id: LEAD_B.employee_id });
      }
    });

    test('ส่วนแบ่งค่าจ้าง: คนในทีมดูแลเคสเลือกเป็นผู้รับได้ แม้ยังไม่มีกะ', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${c.case_id}/team`, { employee_id: LEAD_A.employee_id });

      const pay = (await get(`/api/cases/${c.case_id}/pay`, MANAGER)).body;
      assert.deepEqual(pay.shares.map((r) => r.employee_id).sort(), [FIELD.employee_id, LEAD_A.employee_id].sort());

      await call('PUT', `/api/cases/${c.case_id}/pay/shares`, {
        shares: [{ employee_id: FIELD.employee_id, share: 700 }, { employee_id: LEAD_A.employee_id, share: 500 }],
      });
      const released = await post(`/api/cases/${c.case_id}/pay/release`, {
        request_id: randomUUID(),
        amount: 500, shares: [{ employee_id: LEAD_A.employee_id, amount: 500 }],
      }, MANAGER, 201);
      assert.ok(released);
      const payouts = await sql.all('SELECT employee_id, amount FROM case_payouts WHERE case_id = :id', { id: c.case_id });
      assert.deepEqual(payouts.map((p) => [p.employee_id, Number(p.amount)]), [[LEAD_A.employee_id, 500]]);
    });

    test('ส่วนแบ่งค่าจ้าง: เคสหลายคนที่ยังไม่ตกลงส่วนแบ่ง ต้องระบุยอดรายคน ไม่หารเท่ากันให้เอง', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${c.case_id}/team`, { employee_id: LEAD_A.employee_id });

      const refused = await post(`/api/cases/${c.case_id}/pay/release`, { request_id: randomUUID(), amount: 600 }, MANAGER, 400);
      assert.match(refused.error, /ระบุยอดของแต่ละคน/);

      await post(`/api/cases/${c.case_id}/pay/release`, {
        request_id: randomUUID(),
        amount: 600,
        shares: [{ employee_id: FIELD.employee_id, amount: 600 }, { employee_id: LEAD_A.employee_id, amount: 0 }],
      }, MANAGER, 201);
      const payouts = await sql.all('SELECT employee_id, amount FROM case_payouts WHERE case_id = :id', { id: c.case_id });
      assert.deepEqual(payouts.map((p) => [p.employee_id, Number(p.amount)]), [[FIELD.employee_id, 600]]);

      // เคสคนเดียวยังปล่อยได้โดยไม่ต้องระบุ (ไม่มีอะไรให้แบ่ง)
      const solo = await newCase();
      await post(`/api/cases/${solo.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${solo.case_id}/pay/release`, { request_id: randomUUID(), amount: 300 }, MANAGER, 201);
    });

    test('ส่วนแบ่งที่กรอกเองมีเศษย่อยกว่าสตางค์: ยอดที่ลงฐานรวมแล้วต้องเท่ายอดของงวดเป๊ะ ไม่ปล่อยเกิน', async () => {
      /* ผู้จัดการกรอก 450.125 กับ 449.875 (รวม 900 พอดี) — ด่านเดิมตรวจผลรวม "ก่อนปัด" อย่างเดียว
         แต่สิ่งที่ลงฐานคือยอดรายคนที่ปัดแล้วทีละบรรทัด (450.13 + 449.88 = 900.01)
         ส่วนเกินสตางค์นั้นเป็นเงินจริง ทำให้ยอดปล่อยสะสมทะลุค่าจ้างของเคสและยอดคงเหลือติดลบ */
      const c = await newCase(); // staff_pay 1200
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${c.case_id}/team`, { employee_id: LEAD_A.employee_id });
      await post(`/api/cases/${c.case_id}/pay/release`, {
        request_id: randomUUID(),
        amount: 900,
        shares: [
          { employee_id: FIELD.employee_id, amount: 450.125 },
          { employee_id: LEAD_A.employee_id, amount: 449.875 },
        ],
      }, MANAGER, 201);

      const { released } = await sql.one(
        'SELECT COALESCE(SUM(amount), 0)::float AS released FROM case_payouts WHERE case_id = :id', { id: c.case_id },
      );
      assert.equal(Math.round(Number(released) * 100) / 100, 900);
      const status = (await get(`/api/cases/${c.case_id}/pay`, MANAGER)).body;
      assert.equal(status.released, 900);
      assert.equal(status.remaining, 300);
    });

    test('เปิดเคสใหม่: คืนกะข้างหน้าที่ระบบยกเลิกตอนปิด/ยกเลิกเคส แต่ไม่คืนกะที่คนกดยกเลิกเอง', async () => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      const sched = await post(`/api/cases/${c.case_id}/visits/bulk`,
        { dates: [inDays(1), inDays(2), inDays(3)], assigned_to: FIELD.employee_id }, MANAGER, 201);
      const manual = sched.visits.find((v) => v.visit_date === inDays(3));
      await call('PATCH', `/api/cases/${c.case_id}/visits/${manual.visit_id}`, { status: 'cancelled' });

      await post(`/api/cases/${c.case_id}/close`, { force: true });
      let s = await statuses(c.case_id);
      assert.ok(Object.values(s).every((v) => v.status === 'cancelled'));
      assert.equal(s[inDays(3)].auto_cancelled_at, null, 'กะที่คนยกเลิกเองไม่ถูกติดธงของระบบ');

      await post(`/api/cases/${c.case_id}/reopen`, {});
      s = await statuses(c.case_id);
      assert.equal(s[inDays(1)].status, 'scheduled');
      assert.equal(s[inDays(2)].status, 'scheduled');
      assert.equal(s[inDays(3)].status, 'cancelled');
      assert.ok(Object.values(s).every((v) => v.auto_cancelled_at === null), 'ธงถูกล้างหลังเปิดเคส');
      const events = (await get(`/api/cases/${c.case_id}/events`, MANAGER)).body;
      assert.ok(events.some((e) => e.event === 'reopened' && /คืนกะ.*2 กะ/.test(e.detail)));

      // ยกเลิกเคสแล้วเปิดใหม่ก็คืนแบบเดียวกัน
      await post(`/api/cases/${c.case_id}/cancel`, { reason: 'ทดสอบ' });
      await post(`/api/cases/${c.case_id}/reopen`, {});
      s = await statuses(c.case_id);
      assert.deepEqual([s[inDays(1)].status, s[inDays(2)].status, s[inDays(3)].status], ['scheduled', 'scheduled', 'cancelled']);
    });

    test('กะข้ามเที่ยงคืน (20:00–08:00) ชนกับกะดึกวันเดียวกันและกะเช้าวันถัดไป', async () => {
      const D = '2027-03-10';
      const D1 = '2027-03-11';
      const a = await newCase();
      const b = await newCase();
      const who = LEAD_A.employee_id;
      const night = await post(`/api/cases/${a.case_id}/visits/bulk`,
        { dates: [D], assigned_to: who, planned_start: '20:00', planned_end: '08:00' }, MANAGER, 201);
      assert.equal(night.conflicts.length, 0);

      // กะเช้าวันถัดไปทับช่วงท้ายของกะดึก (07:00–08:00)
      const morning = await post(`/api/cases/${b.case_id}/visits/bulk`,
        { dates: [D1], assigned_to: who, planned_start: '07:00', planned_end: '10:00' }, MANAGER, 201);
      assert.equal(morning.conflicts.length, 1, JSON.stringify(morning.conflicts));
      assert.equal(morning.conflicts[0].other_case_id, a.case_id);

      const preview = (body) => post(`/api/cases/${b.case_id}/visits/preview`, { assigned_to: who, ...body });
      // วันเดียวกัน ช่วงดึก — ของเดิมเทียบ '22:00' < '08:00' เป็นข้อความแล้วไม่ชน
      const late = await preview({ dates: [D], planned_start: '22:00', planned_end: '23:00' });
      assert.ok(late.conflicts.some((c) => c.other_case_id === a.case_id && c.visit_date === D), JSON.stringify(late));
      // กะดึกที่กำลังจะลง ทับกะเช้าของวันถัดไป — visit_date คือวันที่กำลังจะลง
      const overnight = await preview({ dates: [D], planned_start: '23:30', planned_end: '07:30' });
      assert.ok(overnight.conflicts.some((c) => c.other_case_id === b.case_id && c.visit_date === D && c.other_date === D1));
      // ชิดขอบพอดีไม่นับว่าชน
      assert.equal((await preview({ dates: [D], planned_start: '18:00', planned_end: '20:00' })).conflicts.length, 0);
      assert.equal((await preview({ dates: [D1], planned_start: '10:00', planned_end: '12:00' })).conflicts.length, 0);
    });

    test('เวรดึกที่ยังไม่เช็คเอาท์ตามข้ามเที่ยงคืนมาที่ "งานวันนี้" · ของเก่า/ที่ยกเลิก/ของพรุ่งนี้ไม่ตาม', async () => {
      /* ผู้ดูแลเข้าเวร 20:00 ของเมื่อวาน ถึง 08:00 ของวันนี้ — พอเลยเที่ยงคืน กะเป็นของ "เมื่อวาน"
         ถ้าหน้างานวันนี้ไม่แสดง เขาจะหาปุ่มเช็คเอาท์ไม่เจอ กะค้างเป็นเช็คอินแล้วไม่เช็คเอาท์
         ซึ่งไม่ถูกนับเป็นชั่วโมง/จำนวนกะในสรุปค่าตอบแทนและในระดับพนักงานเลย */
      const who = LEAD_B.employee_id;
      const FIELD_B = emp(who, 'caregiver');
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: who });

      const openShift = async (date, hoursAgo, status = 'scheduled') =>
        (await sql.one(
          `INSERT INTO case_visits (case_id, visit_date, assigned_to, status, checked_in_by, check_in_at, planned_start, planned_end)
           VALUES (:id, :d, :emp, :st, :emp, now() - make_interval(hours => :h), '20:00', '08:00')
           RETURNING visit_id`,
          { id: c.case_id, d: date, emp: who, st: status, h: hoursAgo },
        )).visit_id;

      const lastNight = await openShift(inDays(-1), 12);                  // เวรดึกที่ยังอยู่หน้างาน
      const longStale = await openShift(inDays(-3), 60);                  // ลืมกดออกมาหลายวัน — ให้ผู้จัดการแก้เวลาให้แทน
      const cancelled = await openShift(inDays(-1), 12, 'cancelled');     // กะที่ยกเลิกไปแล้ว ไม่ใช่งานที่ต้องปิด
      const closed = (await sql.one(
        `INSERT INTO case_visits (case_id, visit_date, assigned_to, status, checked_in_by, check_in_at, check_out_at)
         VALUES (:id, :d, :emp, 'done', :emp, now() - make_interval(hours => 30), now() - make_interval(hours => 22))
         RETURNING visit_id`,
        { id: c.case_id, d: inDays(-1), emp: who },
      )).visit_id;

      const ids = (rows) => rows.map((v) => v.visit_id);
      const today = (await get('/api/my/today', FIELD_B)).body;
      assert.ok(ids(today).includes(lastNight), `เวรดึกต้องตามมา: ${JSON.stringify(ids(today))}`);
      for (const [id, why] of [[longStale, 'ค้างเกิน 24 ชม.'], [cancelled, 'กะที่ยกเลิก'], [closed, 'กะที่ปิดแล้ว']]) {
        assert.ok(!ids(today).includes(id), `${why} ต้องไม่ตามมา: ${JSON.stringify(ids(today))}`);
      }
      // ยังกดเช็คเอาท์เองได้ (สถานะต้องเป็น working/stale ไม่ใช่หายไปจากรายการ)
      assert.ok(['working', 'stale'].includes(today.find((v) => v.visit_id === lastNight).state));

      /* ตารางของ "พรุ่งนี้" (LINE งานของฉัน) ใช้ตัวเดียวกันแต่ห้ามลากกะค้างของวันนี้ไปด้วย
         ไม่งั้นพนักงานจะเห็นงานที่ทำไปแล้วโผล่ในวันพรุ่งนี้ */
      const tomorrow = await casesRepo.visitsForEmployeeOn(who, inDays(1));
      assert.equal(ids(tomorrow).filter((id) => id === lastNight).length, 0);
    });
  });

  describe('Concurrent case transitions use the state after acquiring the lock', () => {
    for (const [name, initial, committed, action] of [
      ['start', 'assigned', 'closed', (id) => casesRepo.start(id, MANAGER)],
      ['assign', 'assigned', 'closed', (id) => casesRepo.assign(id, FIELD.employee_id, MANAGER)],
      ['unassign', 'assigned', 'cancelled', (id) => casesRepo.unassign(id, MANAGER)],
      ['close', 'assigned', 'cancelled', (id) => casesRepo.close(id, null, MANAGER)],
      ['cancel', 'assigned', 'closed', (id) => casesRepo.cancel(id, 'test', MANAGER)],
      ['reopen', 'closed', 'assigned', (id) => casesRepo.reopen(id, MANAGER)],
      ['add team member', 'assigned', 'closed', (id) => casesRepo.addTeamMember(id, 'EMP-0004', MANAGER)],
      ['check-in', 'assigned', 'closed', async (id) => {
        const v = await sql.one('SELECT visit_id FROM case_visits WHERE case_id = :id', { id });
        return casesRepo.checkInVisit(v.visit_id, { employee_id: FIELD.employee_id, lat: null, lng: null,
          accuracy: null, distance: null, flagged: true, photo: null });
      }],
    ]) {
      test(`${name} rejects stale state and creates no history entry`, { timeout: 10000 }, async () => {
        const c = await newCase();
        await sql.run('UPDATE cases SET assigned_to = :emp, status = :status WHERE case_id = :id',
          { id: c.case_id, emp: FIELD.employee_id, status: initial });
        await sql.run(`INSERT INTO case_visits (case_id,visit_date,assigned_to)
          VALUES (:id,to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD'),:emp)`, { id: c.case_id, emp: FIELD.employee_id });
        const before = await sql.one('SELECT count(*)::int AS n FROM case_events WHERE case_id = :id', { id: c.case_id });
        const blocker = await pool.connect();
        let result;
        try {
          await blocker.query('BEGIN');
          await blocker.query('UPDATE cases SET status = $1 WHERE case_id = $2', [committed, c.case_id]);
          result = action(c.case_id).then((value) => ({ value }), (error) => ({ error }));
          // Wait for a real PostgreSQL lock wait, not an assumed timing delay.
          const deadline = Date.now() + 3000;
          let waiting = false;
          while (Date.now() < deadline) {
            const row = await sql.one(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting`);
            if (row.waiting) { waiting = true; break; }
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.ok(waiting, 'operation must wait for the concurrent transaction');
          await blocker.query('COMMIT');
          const outcome = await result;
          assert.equal(outcome.error?.status, 409, JSON.stringify(outcome));
          assert.equal((await casesRepo.findById(c.case_id)).status, committed);
          assert.equal((await sql.one('SELECT count(*)::int AS n FROM case_events WHERE case_id = :id', { id: c.case_id })).n, before.n);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          if (result) await result;
        }
      });
    }

    test('two starts produce one success and one started event', async () => {
      const c = await newCase();
      await casesRepo.assign(c.case_id, FIELD.employee_id, MANAGER);
      const results = await Promise.allSettled([casesRepo.start(c.case_id, MANAGER), casesRepo.start(c.case_id, MANAGER)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
      const row = await sql.one(`SELECT count(*)::int AS n FROM case_events WHERE case_id = :id AND event = 'started'`, { id: c.case_id });
      assert.equal(row.n, 1);
    });
  });

  // ---------- รอบจ่าย: กันจ่ายซ้ำ ----------
  describe('Payroll — paid runs are final and pay-now pays exactly the preview', () => {
    const todayTH = async () =>
      (await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`)).today;
    const releaseFor = async (amount) => {
      const c = await newCase();
      await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${c.case_id}/pay/release`, { request_id: randomUUID(), amount }, MANAGER, 201);
      return c;
    };
    const previewIds = async (today) =>
      (await get(`/api/payroll/preview?period_to=${today}`, MANAGER)).body.rows.flatMap((r) => r.payout_ids);
    const runCount = async () => (await sql.one('SELECT count(*)::int AS n FROM payroll_runs')).n;

    test('cancelling a draft still works; cancelling a paid run is refused and keeps its payouts', async () => {
      const today = await todayTH();
      // ร่างที่ค้างจากเทสก่อนหน้า — ยกเลิกได้ปกติ (และคืนช่องรอบของเดือนนี้)
      const drafts = (await get('/api/payroll?status=draft', MANAGER)).body;
      for (const d of drafts) {
        assert.equal((await post(`/api/payroll/${d.run_id}/cancel`, {})).status, 'cancelled');
      }

      await releaseFor(500);
      const ids = await previewIds(today);
      assert.ok(ids.length > 0);
      const paid = await post('/api/payroll/pay-now', { period_to: today, payout_ids: ids }, MANAGER, 201);
      assert.equal(paid.status, 'paid');
      assert.equal(Number(paid.payouts), ids.length);

      const refused = await post(`/api/payroll/${paid.run_id}/cancel`, {}, MANAGER, 409);
      assert.match(refused.error, /จ่ายไปแล้ว ยกเลิกไม่ได้/);
      const after = (await get(`/api/payroll/${paid.run_id}`, MANAGER)).body;
      assert.equal(after.status, 'paid');
      assert.equal(Number(after.payouts), ids.length, 'payout lines must stay bound to the paid run');
      assert.deepEqual(await previewIds(today), [], 'paid wages must not become payable again');
    });

    test('pay-now refuses (409, no run left behind) when payouts changed after the preview', async () => {
      const today = await todayTH();
      await releaseFor(400);
      const seen = await previewIds(today);

      // ร่างแล้วยกเลิก — ก้อนกลับเข้ากองรอจ่ายครบ
      const draft = await post('/api/payroll', { period_to: today }, MANAGER, 201);
      assert.equal((await post(`/api/payroll/${draft.run_id}/cancel`, {})).status, 'cancelled');
      assert.deepEqual(await previewIds(today), seen);

      await releaseFor(300); // ปล่อยเพิ่มหลังผู้ใช้เปิดพรีวิว
      const before = await runCount();
      const stale = await post('/api/payroll/pay-now', { period_to: today, payout_ids: seen }, MANAGER, 409);
      assert.match(stale.error, /โหลดพรีวิวใหม่/);
      assert.equal(await runCount(), before, 'a refused pay-now must not leave a draft run');
      assert.equal((await previewIds(today)).length, seen.length + 1);

      const fresh = await previewIds(today);
      const paid = await post('/api/payroll/pay-now', { period_to: today, payout_ids: fresh }, MANAGER, 201);
      assert.equal(paid.status, 'paid');
      assert.equal(Number(paid.payouts), fresh.length);
      assert.equal(Number(paid.total_pay), 700);
    });
  });

  // ---------- schema.sql รันซ้ำทุกครั้งที่ migrate ----------
  describe('schema.sql re-run', () => {
    test('staff_pay backfill fills open cases only — closed/cancelled cases keep NULL', async () => {
      const { readFile } = await import('node:fs/promises');
      const pkg = await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price) VALUES ('Backfill pkg', 1, 1000)
         RETURNING physio_package_id`,
      );
      const ids = {};
      for (const status of ['unassigned', 'closed', 'cancelled']) {
        const c = await newCase();
        await sql.run(
          `UPDATE cases SET staff_pay = NULL, status = :status, physio_package_id = :pkg WHERE case_id = :id`,
          { status, pkg: pkg.physio_package_id, id: c.case_id },
        );
        ids[status] = c.case_id;
      }
      // ตั้งค่าจ้างให้แพ็คเกจทีหลัง แล้ว migrate ซ้ำสองครั้ง
      await sql.run('UPDATE physio_packages SET staff_pay = 650 WHERE physio_package_id = :id', { id: pkg.physio_package_id });
      const schema = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
      await pool.query(schema);
      await pool.query(schema);

      const pay = async (id) => (await sql.one('SELECT staff_pay FROM cases WHERE case_id = :id', { id })).staff_pay;
      assert.equal(await pay(ids.unassigned), 650);
      assert.equal(await pay(ids.closed), null, 'closed case must not get staff pay backfilled');
      assert.equal(await pay(ids.cancelled), null);
    });
  });

  // ---------- หมุน JWT_SECRET แล้วสำเนารหัสชั่วคราวถอดไม่ออก ----------
  describe('Unreadable temp password (JWT_SECRET rotated)', () => {
    test('employee detail and rename keep working; unreadable copy is flagged then cleared', async () => {
      const created = await post('/api/employees', { first_name: 'Rotated', last_name: 'Secret', position: 'caregiver' }, MANAGER, 201);
      // ค่าที่เข้ารหัสด้วยกุญแจอื่น — auth tag ไม่ผ่าน เหมือนหลังหมุน secret
      await sql.run(
        // must_change_password = TRUE — สำเนาถูกอ่านเฉพาะแถวที่ยังค้างรหัสชั่วคราว (บัญชีใหม่ตั้ง FALSE ตั้งแต่ da606a5)
        `UPDATE employees SET must_change_password = TRUE,
           temp_password_encrypted = 'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA'
         WHERE employee_id = :id`,
        { id: created.employee_id },
      );
      const detail = await get(`/api/employees/${created.employee_id}`, MANAGER);
      assert.equal(detail.status, 200);
      assert.equal('temp_password' in detail.body, false);
      assert.equal(detail.body.temp_password_unreadable, true);

      const res = await fetch(`${base}/api/employees/${created.employee_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
        body: JSON.stringify({ employee_id: 'A6800888' }),
      });
      assert.equal(res.status, 200);
      const stored = await sql.one(`SELECT temp_password_encrypted FROM employees WHERE employee_id = 'A6800888'`);
      assert.equal(stored.temp_password_encrypted, null);
      assert.equal((await get('/api/employees/A6800888', MANAGER)).status, 200);
    });
  });

  // ---------- ไฟล์: ใครเปิดรูปได้ และใบที่มีแต่รูปยังแก้ได้ (ตรวจรอบ 10A) ----------
  describe('รูปในระบบ — เจ้าของรูปคือคนที่ถ่าย ไม่ใช่คนที่ถือกะอยู่ตอนนี้', () => {
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);

    test('สลับกะให้คนใหม่แล้ว คนใหม่ต้องเปิดเซลฟี่ของคนเดิมไม่ได้ (เจ้าของรูปยังเปิดได้)', async () => {
      const other = await post('/api/employees', { first_name: 'Shift', last_name: 'Taker', position: 'caregiver' }, MANAGER, 201);
      // บัญชีใหม่ติดด่าน "ต้องตั้งรหัสก่อน" (403) ซึ่งจะกลบผลของด่านที่ต้องการวัด
      await sql.run('UPDATE employees SET must_change_password = FALSE WHERE employee_id = :id', { id: other.employee_id });
      const kase = await newCase();
      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: FIELD.employee_id }, MANAGER);
      const { visit_id } = await sql.one(
        `INSERT INTO case_visits (case_id, visit_date, assigned_to, status, checked_in_by, check_in_at,
           check_in_photo_data, check_in_photo_mime, check_in_photo_size)
         VALUES (:cid, to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD'), :me, 'scheduled', :me, now(),
                 :data, 'image/jpeg', :size)
         RETURNING visit_id`,
        { cid: kase.case_id, me: FIELD.employee_id, data: JPEG, size: JPEG.length },
      );

      assert.equal((await get(`/api/my/visits/${visit_id}/photo`, FIELD)).status, 200, 'เจ้าของรูปต้องยังเปิดได้');

      // แอดมินสลับกะไปให้คนอื่นหลังคนแรกเช็คอินไปแล้ว — รูปยังเป็นหน้าของคนแรก
      await sql.run('UPDATE case_visits SET assigned_to = :who WHERE visit_id = :id', { who: other.employee_id, id: visit_id });
      const taker = emp(other.employee_id, 'caregiver');
      assert.equal((await get(`/api/my/visits/${visit_id}/photo`, taker)).status, 404);
      // ฝ่ายหลังบ้านยังเปิดตรวจได้ตามเดิม
      assert.equal((await get(`/api/cases/${kase.case_id}/visits/${visit_id}/photo`, MANAGER)).status, 200);
    });

    test('รายงานที่มีแต่รูปแผล แก้ช่องอื่นได้ แต่สั่งลบรูปทิ้งจนใบว่างไม่ได้', async () => {
      const kase = await newCase();
      const { report_id } = await sql.one(
        `INSERT INTO case_reports (case_id, report_date, report_type, wound_photo_data, wound_photo_mime, wound_photo_size)
         VALUES (:cid, to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD'), 'routine', :data, 'image/jpeg', :size)
         RETURNING report_id`,
        { cid: kase.case_id, data: JPEG, size: JPEG.length },
      );
      const patch = (body) =>
        fetch(`${base}/api/cases/${kase.case_id}/reports/${report_id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });

      // รูปที่เก็บไว้แล้วอยู่คอลัมน์ wound_photo_data — ถ้านับไม่เป็นเนื้อหา ใบนี้จะแก้อะไรไม่ได้เลย
      assert.equal((await patch({ report_type: 'change' })).status, 200);
      assert.equal((await patch({ wound_photo: null })).status, 400, 'ลบรูปเดียวที่มี = ใบว่าง ต้องไม่ให้ผ่าน');

      // ตอบกลับต้องไม่มีไบต์รูปปนมา แม้เป็น PATCH ที่ไม่มีช่องไหนเปลี่ยนเลย
      const noop = await (await patch({})).json();
      assert.equal('wound_photo_data' in noop, false);
      assert.equal(noop.has_wound_photo, true);
    });
  });

  // ---------- ญาติ: เคสที่ปิดเกินช่วงผ่อนผันต้องเปิดอะไรไม่ได้อีก ----------
  describe('สิทธิ์ญาติหมดพร้อมกันทุกเส้น (รวมเส้นที่ส่งไบต์ของรูป)', () => {
    test('เคสปิดเกิน 30 วัน memberLink ต้องคืน null — ไม่ใช่แค่ซ่อนจากหน้าสรุป', async () => {
      const family = await import('../src/lib/family.js');
      await family.ensureFamilyTable();
      const kase = await newCase();
      const uid = `U${'b'.repeat(32)}`;
      await sql.run(
        `INSERT INTO case_family_links (case_id, line_user_id, display_name, invited_by, consent_by, accepted_at, can_invite)
         VALUES (:cid, :uid, 'ญาติ', 'test', 'test', now(), true)`,
        { cid: kase.case_id, uid },
      );
      assert.ok(await family.memberLink(uid, kase.case_id), 'เคสเปิดอยู่ต้องผ่าน');

      const close = (days) =>
        sql.run(
          `UPDATE cases SET status = 'closed', closed_at = to_char(now() - make_interval(days => :d), 'YYYY-MM-DD')
           WHERE case_id = :cid`,
          { d: days, cid: kase.case_id },
        );
      await close(5);
      assert.ok(await family.memberLink(uid, kase.case_id), 'ยังอยู่ในช่วงผ่อนผัน 30 วัน ต้องผ่าน');
      await close(90);
      assert.equal(await family.memberLink(uid, kase.case_id), null, 'พ้นช่วงผ่อนผันแล้วต้องเปิดรูป/โพสต์ไม่ได้');
    });
  });

  // ---------- ของที่ถูกย้อน แก้ หรือทำซ้ำ (ตรวจรอบ 11A) ----------
  describe('วงจรที่ไม่ได้เดินเป็นเส้นตรง — ยกเลิกกลางคัน · เปิดรอบที่ยกเลิกกลับ · แก้ดาวรอบเดิม', () => {
    test('ยกเลิกเคสที่พนักงานไปทำมาแล้ว — เงินยังต้องอยู่ในคิวปล่อยค่าจ้างและในตัวนับเตือน', async () => {
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const worked = await newCase();
      await post(`/api/cases/${worked.case_id}/assign`, { employee_id: FIELD.employee_id });
      const sched = await post(`/api/cases/${worked.case_id}/visits/bulk`,
        { dates: [today], assigned_to: FIELD.employee_id }, MANAGER, 201);
      await sql.run(
        `UPDATE case_visits SET checked_in_by = :emp, check_in_at = now() - interval '3 hours',
         check_out_at = now() - interval '1 hour', status = 'done' WHERE visit_id = :id`,
        { emp: FIELD.employee_id, id: sched.visits[0].visit_id },
      );

      // เคสที่ยกเลิก "ก่อนเริ่มงาน" ต้องไม่โผล่ในคิว — ตัวเทียบว่าด่านยังแคบอยู่
      const untouched = await newCase();
      await post(`/api/cases/${untouched.case_id}/assign`, { employee_id: FIELD.employee_id });

      const inQueue = async (id) => (await get('/api/payroll/case-queue', MANAGER)).body.some((r) => r.case_id === id);
      const unreleased = async () =>
        (await get(`/api/payroll/preview?period_to=${today}`, MANAGER)).body.unreleased_cases;

      assert.ok(await inQueue(worked.case_id), 'ก่อนยกเลิกต้องอยู่ในคิว');
      const before = await unreleased();

      await post(`/api/cases/${worked.case_id}/cancel`, { reason: 'ลูกค้ายกเลิกกลางคัน' });
      await post(`/api/cases/${untouched.case_id}/cancel`, { reason: 'ยกเลิกก่อนเริ่ม' });

      assert.ok(await inQueue(worked.case_id), 'ยกเลิกแล้วแต่มีกะที่ทำจริง เงินต้องยังอยู่ในคิว');
      assert.equal(await inQueue(untouched.case_id), false, 'ยกเลิกก่อนเริ่มงาน ต้องไม่รกคิว');
      assert.equal(await unreleased(), before + 1, 'กระดิ่งต้องนับเคสที่ยกเลิกทั้งที่มีคนไปทำมาแล้ว');
    });

    /* ดร.ธงชัย 25 ต.ค. 2569: "จ่ายบางส่วนแต่ก็คืนไม่ครบครับ เคสยกเลิก · ยกเลิกได้ครับ
       กะที่ยังอยู่ไม่ต้องจ่าย" — เคสยกเลิกกลางคันต้องเสนอยอดตามกะที่ไปจริง ไม่ใช่ยอดเหมาเต็ม */
    test('ยกเลิกกลางคัน: ลงกะ 10 วัน ไปจริง 3 วัน → ระบบเสนอ 3 ใน 10 ของยอดเหมา กะที่เหลือไม่เป็นเงิน', async () => {
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const day = (i) => {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        return d.toISOString().slice(0, 10);
      };
      const tenDays = Array.from({ length: 10 }, (_, i) => day(i));

      /* เคสควบคุม: ลงกะและทำงานเท่ากันเป๊ะ แต่ "ปิด" ไม่ใช่ "ยกเลิก" — ต้องได้ยอดเหมาเต็มเหมือนเดิม
         (ตัวพิสูจน์ว่าสัดส่วนไม่หลุดไปโดนเคสปกติ) */
      const build = async () => {
        const c = await post('/api/cases',
          { case_type: 'other', client_name: 'ยกเลิกกลางคัน', fee: 30000, staff_pay: 20000 }, MANAGER, 201);
        await post(`/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id });
        const sched = await post(`/api/cases/${c.case_id}/visits/bulk`,
          { dates: tenDays, assigned_to: FIELD.employee_id }, MANAGER, 201);
        assert.equal(sched.visits.length, 10, 'ต้องลงกะได้ครบ 10 วัน');
        for (const v of sched.visits.slice(0, 3)) {
          await sql.run(
            `UPDATE case_visits SET checked_in_by = :emp, check_in_at = now() - interval '3 hours',
             check_out_at = now() - interval '1 hour', status = 'done' WHERE visit_id = :id`,
            { emp: FIELD.employee_id, id: v.visit_id },
          );
        }
        return c.case_id;
      };

      const cancelled = await build();
      const closed = await build();

      const payOf = async (id) => (await get(`/api/cases/${id}/pay`, MANAGER)).body;
      const queueRow = async (id) =>
        (await get('/api/payroll/case-queue', MANAGER)).body.find((r) => r.case_id === id);

      // ก่อนยกเลิก ทั้งคู่ยังเป็นเคสเดินอยู่ = เสนอยอดเหมาเต็ม
      assert.equal((await payOf(cancelled)).suggested_remaining, 20000, 'เคสที่ยังเดินอยู่ต้องเสนอเต็มยอด');
      assert.equal((await payOf(cancelled)).prorated, false);

      await post(`/api/cases/${cancelled}/cancel`, { reason: 'ลูกค้ายกเลิกกลางคัน' });
      await post(`/api/cases/${closed}/close`, { force: true });

      const pay = await payOf(cancelled);
      assert.equal(pay.worked_shifts, 3, 'กะที่ไปจริง');
      assert.equal(pay.planned_shifts, 10, 'กะที่วางไว้ทั้งหมด (กะที่ยกเลิกตามเคสต้องยังอยู่ในตัวหาร)');
      assert.equal(pay.suggested_pay, 6000, '20,000 × 3/10');
      assert.equal(pay.suggested_remaining, 6000);
      assert.equal(pay.prorated, true);
      assert.equal(pay.staff_pay, 20000, 'ยอดเหมาไม่ถูกแก้ — สัดส่วนเป็นข้อเสนอ ไม่ใช่การเขียนทับยอด');
      assert.equal(pay.remaining, 20000, 'เพดานที่พิมพ์เองได้ยังเป็นยอดเหมาเต็ม');

      // เคสที่ "ปิด" ด้วยตารางกะชุดเดียวกัน ต้องไม่ถูกแตะเลยสักบาท
      const normal = await payOf(closed);
      assert.equal(normal.suggested_pay, 20000, 'เคสปิดตามปกติ = ยอดเหมาเต็มเท่าเดิมเป๊ะ');
      assert.equal(normal.suggested_remaining, 20000);
      assert.equal(normal.prorated, false);

      // คิวปล่อยค่าจ้างต้องบอกที่มาของยอด ไม่ใช่โชว์ยอดเหมาเต็มให้ผู้จัดการคิดสัดส่วนเอง
      const row = await queueRow(cancelled);
      assert.equal(row.worked_shifts, 3);
      assert.equal(row.planned_shifts, 10);
      assert.equal(row.suggested_remaining, 6000);
      assert.equal(row.prorated, true);
      assert.equal((await queueRow(closed)).suggested_remaining, 20000);

      // กด "ปล่อยที่เหลือ" โดยไม่พิมพ์ยอด = ได้ยอดตามสัดส่วน ไม่ใช่ 20,000
      await post(`/api/cases/${cancelled}/pay/release`, { request_id: randomUUID() }, MANAGER, 201);
      const after = await payOf(cancelled);
      assert.equal(after.released, 6000, 'กะที่ไม่มีใครไปต้องไม่ถูกเทออกมาเป็นเงิน');
      assert.equal(after.suggested_remaining, 0);
      assert.equal(after.remaining, 14000, 'ยอดเหมาคงเหลือยังรายงานตามจริง');

      /* จ่ายครบตามสัดส่วนแล้วต้องตกไปกลุ่ม "จ่ายครบ" ของคิว — ถ้าสูตรฝั่ง SQL (PAY_BASIS)
         กับฝั่ง JS (suggestedPay) เริ่มเพี้ยนจากกัน บรรทัดนี้จะล้มทันที */
      assert.equal((await queueRow(cancelled)).pay_priority, 6, 'ต้องไม่ค้างหัวคิวด้วยยอดที่จะไม่มีวันจ่าย');

      // กดซ้ำแบบไม่ระบุยอด = ปฏิเสธพร้อมบอกเหตุผล ไม่ใช่เงียบๆ ปล่อยอีก 14,000
      const blocked = await post(`/api/cases/${cancelled}/pay/release`, { request_id: randomUUID() }, MANAGER, 409);
      assert.match(blocked.error ?? JSON.stringify(blocked), /ยกเลิกกลางคัน/);

      // แต่ผู้จัดการยังพิมพ์ยอดเองได้ (ข้อเสนอ ไม่ใช่เพดาน) และเพดานยอดเหมายังกันอยู่
      await post(`/api/cases/${cancelled}/pay/release`, { request_id: randomUUID(), amount: 1000 }, MANAGER, 201);
      assert.equal((await payOf(cancelled)).released, 7000);
      await post(`/api/cases/${cancelled}/pay/release`, { request_id: randomUUID(), amount: 99999 }, MANAGER, 400);
    });

    test('เปิดเคสรอบที่ยกเลิกกลับมา ไม่ได้ถ้าสายต่อเคสนั้นมีรอบใหม่เดินอยู่แล้ว', async () => {
      const first = await newCase();
      const second = await post('/api/cases',
        { case_type: 'other', client_name: 'ต่อรอบสอง', fee: 2000, staff_pay: 1200, renewed_from: first.case_id },
        MANAGER, 201);
      assert.equal(second.round_no, 2);

      await post(`/api/cases/${second.case_id}/cancel`, { reason: 'ลูกค้าบอกไม่ต่อ' });
      const third = await post('/api/cases',
        { case_type: 'other', client_name: 'ต่อรอบสองใหม่', fee: 2000, staff_pay: 1200, renewed_from: first.case_id },
        MANAGER, 201);

      await post(`/api/cases/${second.case_id}/reopen`, {}, MANAGER, 409);
      assert.equal(
        (await sql.one('SELECT status FROM cases WHERE case_id = :id', { id: second.case_id })).status,
        'cancelled',
      );
      // ยกเลิกรอบที่เดินอยู่แล้วค่อยเปิดใบเดิมกลับ ยังทำได้ตามเดิม
      await post(`/api/cases/${third.case_id}/cancel`, { reason: 'สลับกลับไปใช้ใบเดิม' });
      await post(`/api/cases/${second.case_id}/reopen`, {}, MANAGER, 200);
    });

    test('ญาติแก้ดาวรอบเดิมหลังเปลี่ยนคนดูแล — ชื่อที่ส่งกลับต้องเป็นคนที่ดาวลงจริง · เคสปิดนานแล้วให้ดาวไม่ได้', async () => {
      const ratings = await import('../src/lib/ratings.js');
      const family = await import('../src/lib/family.js');
      await family.ensureFamilyTable();

      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const kase = await newCase();
      const uid = `U${'c'.repeat(32)}`;
      await sql.run(
        `INSERT INTO case_family_links (case_id, line_user_id, display_name, invited_by, consent_by, accepted_at, can_invite)
         VALUES (:cid, :uid, 'ญาติ', 'test', 'test', now(), true)`,
        { cid: kase.case_id, uid },
      );
      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: FIELD.employee_id });
      const first = await post(`/api/cases/${kase.case_id}/visits/bulk`,
        { dates: [today], assigned_to: FIELD.employee_id }, MANAGER, 201);
      await sql.run(
        `UPDATE case_visits SET checked_in_by = :emp, check_in_at = now() - interval '5 hours',
         check_out_at = now() - interval '4 hours', status = 'done' WHERE visit_id = :id`,
        { emp: FIELD.employee_id, id: first.visits[0].visit_id },
      );

      const one = await ratings.submitRating({ caseId: kase.case_id, round: 'w1', kind: 'family', line: uid, stars: 5 });
      assert.equal(one.employee_id, FIELD.employee_id);

      // เปลี่ยนคนดูแลกลางรอบ แล้วคนใหม่เข้าเวร
      const other = await post('/api/employees', { first_name: 'คนใหม่', last_name: 'เข้าเวร', position: 'caregiver' }, MANAGER, 201);
      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: other.employee_id });
      const second = await post(`/api/cases/${kase.case_id}/visits/bulk`,
        { dates: [today], assigned_to: other.employee_id, planned_start: '20:00' }, MANAGER, 201);
      const night = second.visits.find((v) => v.planned_start === '20:00');
      await sql.run(
        `UPDATE case_visits SET checked_in_by = :emp, check_in_at = now() - interval '1 hour',
         check_out_at = now(), status = 'done' WHERE visit_id = :id`,
        { emp: other.employee_id, id: night.visit_id },
      );

      const again = await ratings.submitRating({ caseId: kase.case_id, round: 'w1', kind: 'family', line: uid, stars: 1 });
      const stored = await sql.one(
        `SELECT employee_id, stars FROM case_ratings WHERE case_id = :cid AND round = 'w1'`,
        { cid: kase.case_id },
      );
      assert.equal(stored.stars, 1);
      assert.equal(again.employee_id, stored.employee_id, 'ชื่อที่แจ้งทีมตอนดาวต่ำต้องเป็นคนที่ดาวลงจริง');

      await sql.run(
        `UPDATE cases SET status = 'closed', closed_at = to_char(now() - interval '200 days', 'YYYY-MM-DD') WHERE case_id = :cid`,
        { cid: kase.case_id },
      );
      assert.deepEqual(
        await ratings.submitRating({ caseId: kase.case_id, round: 'w9', kind: 'family', line: uid, stars: 1 }),
        { error: 'not_family' },
        'เคสปิดเกิน 30 วัน ญาติต้องยิงดาวเข้าบัญชีพนักงานไม่ได้อีก',
      );
    });
  });

  // ---------- token ที่ออกในวินาทีเดียวกับการเปลี่ยนรหัส ----------
  describe('Password change revokes same-second tokens', () => {
    test('older token from the same second is rejected; the new session cookie keeps working', async () => {
      const created = await post('/api/employees', { first_name: 'Same', last_name: 'Second', position: 'caregiver' }, MANAGER, 201);
      const who = emp(created.employee_id, 'caregiver');
      const me = (cookie) => fetch(`${base}/api/auth/me`, { headers: { cookie } });

      const old = signToken(who);
      const { iat_ms } = JSON.parse(Buffer.from(old.split('.')[1], 'base64url').toString('utf8'));
      // เปลี่ยนรหัส 1 ms หลังออก token — วินาทีเดียวกันแทบทุกครั้ง (ของเดิมปล่อยผ่าน)
      await sql.run(
        `UPDATE employees SET password_changed_at = to_timestamp((:t)::double precision / 1000) WHERE employee_id = :id`,
        { t: iat_ms + 1, id: created.employee_id },
      );
      assert.equal((await me(`${COOKIE_NAME}=${old}`)).status, 401);

      await new Promise((r) => setTimeout(r, 5));
      const changed = await fetch(`${base}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        // บัญชีใหม่ใช้รหัสเริ่มต้น (da606a5) — ไม่มี temp_password ให้ใช้แล้ว
        body: JSON.stringify({ current_password: (await import('../src/lib/auth.js')).DEFAULT_PASSWORD, new_password: 'Same-second-789!' }),
      });
      assert.equal(changed.status, 200);
      const fresh = changed.headers.get('set-cookie').split(';')[0];
      assert.equal((await me(fresh)).status, 200, 'the session issued right after the change must survive');
    });
  });

  describe('แจ้ง LINE เมื่อเคส/ปฏิทินเปลี่ยน (notify/caseEvents.js)', () => {
    test('จับคู่ · ลงกะ · เปลี่ยนคน · เช็คอิน-เอาท์ เข้าคิว case_event_outbox ถูกคน และไม่ปนคิวเดิม', async () => {
      const caseEvents = await import('../src/notify/caseEvents.js');
      const family = await import('../src/lib/family.js');
      await family.ensureFamilyTable();

      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const kase = await newCase();
      await sql.run(`UPDATE cases SET case_type = 'physiotherapy' WHERE case_id = :id`, { id: kase.case_id });
      const relative = `U${'e'.repeat(32)}`;
      await sql.run(
        `INSERT INTO case_family_links (case_id, line_user_id, display_name, invited_by, consent_by, accepted_at, can_invite)
         VALUES (:cid, :uid, 'ญาติ', 'test', 'test', now(), true)`,
        { cid: kase.case_id, uid: relative },
      );
      const staff = async (tag) => {
        const e = await post('/api/employees', { first_name: `กภ.${tag}`, last_name: 'แจ้งเตือน', position: 'therapist' }, MANAGER, 201);
        const line = `U${tag.repeat(32)}`;
        await sql.run('UPDATE employees SET line_user_id = :line, must_change_password = false WHERE employee_id = :id', { line, id: e.employee_id });
        return { ...emp(e.employee_id, 'therapist'), line };
      };
      const a = await staff('a');
      const b = await staff('b');
      const queued = () =>
        sql.all('SELECT recipient_line_user_id AS to, event_kind AS kind, payload FROM case_event_outbox WHERE case_id = :id ORDER BY id', { id: kase.case_id });
      const kinds = async (to) => (await queued()).filter((r) => r.to === to).map((r) => r.kind);

      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: a.employee_id });
      assert.deepEqual(await kinds(a.line), ['case_assigned']);
      assert.deepEqual(await kinds(relative), ['case_staff']);

      await post(`/api/cases/${kase.case_id}/visits/bulk`, { dates: [today, tomorrow], planned_start: '23:59' }, MANAGER, 201);
      const added = (await queued()).find((r) => r.kind === 'visits_added');
      assert.equal(added.to, a.line);
      assert.equal(added.payload.data.total, 2);
      // ลงวันเดิมซ้ำ = addVisits ข้ามทั้งหมด → ไม่มีข้อความใหม่
      await post(`/api/cases/${kase.case_id}/visits/bulk`, { dates: [today, tomorrow], planned_start: '23:59' }, MANAGER, 201);
      assert.equal((await kinds(a.line)).filter((k) => k === 'visits_added').length, 1);

      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: b.employee_id });
      assert.deepEqual(await kinds(a.line), ['case_assigned', 'visits_added', 'case_unassigned']);
      const toB = (await queued()).find((r) => r.to === b.line && r.kind === 'case_assigned');
      assert.equal(toB.payload.data.upcoming_visits.length, 2, 'กะข้างหน้าย้ายตามมาเป็นของคนใหม่');
      assert.deepEqual(await kinds(relative), ['case_staff', 'case_staff']);

      const visit = (await sql.one('SELECT visit_id FROM case_visits WHERE case_id = :id AND visit_date = :d', { id: kase.case_id, d: today }));
      const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';
      await post(`/api/my/visits/${visit.visit_id}/check-in`, { photo }, b);
      await post(`/api/my/visits/${visit.visit_id}/check-out`, {}, b);
      assert.deepEqual(await kinds(relative), ['case_staff', 'case_staff', 'visit_checkin', 'visit_checkout']);
      const checkin = (await queued()).find((r) => r.kind === 'visit_checkin');
      assert.match(checkin.payload.data.check_in_time, /^\d{2}:\d{2}$/);
      assert.equal(checkin.payload.data.session_no, 1);

      // คิวเดิมที่ตัวส่งปัจจุบันดึงอยู่ ต้องไม่เห็นชนิดข้อความใหม่
      const leaked = await sql.one(
        `SELECT COUNT(*)::int AS n FROM visit_notification_outbox
          WHERE event_kind IN ('case_assigned','case_unassigned','case_staff','visits_added','visit_checkin','visit_checkout')`,
      ).catch(() => ({ n: 0 }));
      assert.equal(leaked.n, 0);

      // รับ/ack แบบเดียวกับคิวเดิม — ack แล้วไม่ถูกหยิบซ้ำ
      const pending = (await caseEvents.claimCaseEventOutbox(500)).filter((r) => r.case_id === kase.case_id);
      assert.equal(pending.length, (await queued()).length);
      assert.equal(await caseEvents.ackCaseEventOutbox(pending.map((r) => ({ id: r.id, ok: true }))), pending.length);
      const left = await sql.one('SELECT COUNT(*)::int AS n FROM case_event_outbox WHERE case_id = :id AND sent_at IS NULL', { id: kase.case_id });
      assert.equal(left.n, 0);
    });

    test('แอดมินกดส่งเตือนกะเอง — เข้าคิวพนักงาน+ญาติ · กันกดซ้ำ · พนักงานภาคสนามกดไม่ได้ · กะที่จบแล้วส่งไม่ได้', async () => {
      const family = await import('../src/lib/family.js');
      await family.ensureFamilyTable();
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const kase = await newCase();
      const relative = `U${'f'.repeat(32)}`;
      await sql.run(
        `INSERT INTO case_family_links (case_id, line_user_id, display_name, invited_by, consent_by, accepted_at, can_invite)
         VALUES (:cid, :uid, 'ญาติ', 'test', 'test', now(), true)`,
        { cid: kase.case_id, uid: relative },
      );
      const e = await post('/api/employees', { first_name: 'ผู้ดูแล', last_name: 'เตือนเอง', position: 'caregiver' }, MANAGER, 201);
      const line = `U${'d'.repeat(32)}`;
      await sql.run('UPDATE employees SET line_user_id = :line WHERE employee_id = :id', { line, id: e.employee_id });
      await sql.run('UPDATE cases SET geo_lat = 13.766892, geo_lng = 100.697079 WHERE case_id = :id', { id: kase.case_id });
      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: e.employee_id });
      const assigned = await sql.one(
        `SELECT payload FROM case_event_outbox WHERE case_id = :id AND event_kind = 'case_assigned'`, { id: kase.case_id });
      assert.equal(assigned.payload.data.map_url, 'https://www.google.com/maps/dir/?api=1&destination=13.766892,100.697079');
      const sched = await post(`/api/cases/${kase.case_id}/visits/bulk`, { dates: [tomorrow], planned_start: '09:00' }, MANAGER, 201);
      const visit = sched.visits[0];
      const path = `/api/cases/${kase.case_id}/visits/${visit.visit_id}/remind`;

      await post(path, {}, FIELD, 403);
      assert.deepEqual(await post(path, {}, HR), { staff: 1, family: 1, duplicate: false });
      const rows = await sql.all(
        `SELECT recipient_line_user_id AS to, payload FROM case_event_outbox WHERE visit_id = :id AND event_kind = 'manual_reminder' ORDER BY id`,
        { id: visit.visit_id },
      );
      assert.deepEqual(rows.map((r) => r.to), [line, relative]);
      assert.equal(rows[0].payload.data.planned_start, '09:00');
      assert.equal(rows[0].payload.data.map_url, 'https://www.google.com/maps/dir/?api=1&destination=13.766892,100.697079');
      assert.equal(rows[1].payload.data.address, undefined, 'ญาติไม่ต้องได้ที่อยู่/พิกัด');
      assert.equal(rows[1].payload.data.map_url, undefined);
      await post(path, {}, HR, 429);

      await sql.run(`UPDATE case_visits SET status = 'cancelled' WHERE visit_id = :id`, { id: visit.visit_id });
      await post(path, {}, MANAGER, 409);
      await post(`/api/cases/${kase.case_id}/visits/999999/remind`, {}, MANAGER, 404);
    });

    test('ย้ายกะจากปฏิทิน — ย้ายได้เฉพาะกะรอเช็คอินไปวันนี้/อนาคต · บันทึกประวัติ · เข้าคิวแจ้งเลื่อนนัด · บอกงานที่ชน', async () => {
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const inDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      const e = await post('/api/employees', { first_name: 'ย้าย', last_name: 'วันนัด', position: 'caregiver' }, MANAGER, 201);
      const kase = await newCase();
      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: e.employee_id });
      const other = await newCase();
      await post(`/api/cases/${other.case_id}/visits/bulk`, { dates: [inDays(5)], assigned_to: e.employee_id, planned_start: '09:00', planned_end: '10:00' }, MANAGER, 201);
      const sched = await post(`/api/cases/${kase.case_id}/visits/bulk`,
        { dates: [inDays(-2), inDays(2)], planned_start: '09:00', planned_end: '10:00' }, MANAGER, 201);
      const past = sched.visits.find((v) => v.visit_date === inDays(-2));
      const future = sched.visits.find((v) => v.visit_date === inDays(2));
      const move = (v, to, who = MANAGER, code = 200) =>
        post(`/api/cases/${kase.case_id}/visits/${v.visit_id}/move`, { visit_date: to }, who, code);

      await move(future, inDays(3), FIELD, 403);
      await move(future, inDays(-1), MANAGER, 409); // ไปอดีตไม่ได้
      await move(past, inDays(3), MANAGER, 409); // กะขาดงาน (เลยวันแล้ว) ย้ายไม่ได้
      await post(`/api/cases/${other.case_id}/visits/${future.visit_id}/move`, { visit_date: inDays(3) }, MANAGER, 404);

      const res = await move(future, inDays(5));
      assert.equal(res.visit_date, inDays(5));
      assert.equal(res.conflicts.length, 1, 'ชนกับกะ 09:00 ของอีกเคสในวันเดียวกัน');
      const row = await sql.one('SELECT visit_date, planned_start, assigned_to FROM case_visits WHERE visit_id = :id', { id: future.visit_id });
      assert.deepEqual(row, { visit_date: inDays(5), planned_start: '09:00', assigned_to: e.employee_id }, 'ย้ายแค่วัน');
      const ev = await sql.one(
        `SELECT detail FROM case_events WHERE case_id = :id AND event = 'visit_edited' ORDER BY 1 DESC LIMIT 1`, { id: kase.case_id });
      assert.match(ev.detail, new RegExp(`${inDays(2)} → ${inDays(5)}`));
      const change = await sql.one('SELECT kind FROM visit_change_outbox WHERE visit_id = :id', { id: future.visit_id });
      assert.equal(change.kind, 'moved');

      assert.deepEqual(await move({ visit_id: future.visit_id }, inDays(5)), { visit_id: future.visit_id, visit_date: inDays(5), conflicts: [] });

      // ลงช่องเวลา (มุมมองสัปดาห์): เปลี่ยนวันและเวลาพร้อมกัน ความยาวกะเท่าเดิม · ไม่ชนกับกะ 09:00 แล้ว
      const timed = await post(`/api/cases/${kase.case_id}/visits/${future.visit_id}/move`,
        { visit_date: inDays(5), planned_start: '14:00', planned_end: '15:00' }, MANAGER);
      assert.deepEqual(timed.conflicts, []);
      const moved = await sql.one('SELECT visit_date, planned_start, planned_end FROM case_visits WHERE visit_id = :id', { id: future.visit_id });
      assert.deepEqual(moved, { visit_date: inDays(5), planned_start: '14:00', planned_end: '15:00' });
      const timeEv = await sql.one(
        `SELECT detail FROM case_events WHERE case_id = :id AND event = 'visit_edited' ORDER BY 1 DESC LIMIT 1`, { id: kase.case_id });
      assert.match(timeEv.detail, /09:00 → 14:00/);
      // เวลาของวันนี้ที่ผ่านไปแล้ว (00:00) ย้ายไปไม่ได้ · เวลารูปแบบผิด = 400
      await post(`/api/cases/${kase.case_id}/visits/${future.visit_id}/move`, { visit_date: today, planned_start: '00:00' }, MANAGER, 409);
      await post(`/api/cases/${kase.case_id}/visits/${future.visit_id}/move`, { visit_date: inDays(5), planned_start: '25:00' }, MANAGER, 400);
      await sql.run(`UPDATE case_visits SET check_in_at = now() WHERE visit_id = :id`, { id: future.visit_id });
      await move(future, inDays(6), MANAGER, 409); // เช็คอินแล้วย้ายไม่ได้
    });

    test('กราฟหน้าภาพรวม — กะ 21 วันครบทุกวัน · สถานะกะถูกนับ · เคสรายเดือน 12 เดือน · ภาระงานรวมคนในทีม · พนักงานภาคสนามเปิดไม่ได้', async () => {
      const { today } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS today`);
      const inDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      const before = (await get('/api/cases/dashboard', MANAGER)).body;
      assert.equal(before.visits.length, 21);
      assert.equal(before.visits[13].date, today);
      assert.equal(before.monthly.length, 12);
      assert.equal(before.monthly.at(-1).month, today.slice(0, 7));

      const a = await post('/api/employees', { first_name: 'แดช', last_name: 'บอร์ด', position: 'caregiver' }, MANAGER, 201);
      const b = await post('/api/employees', { first_name: 'ทีม', last_name: 'แดช', position: 'caregiver' }, MANAGER, 201);
      const kase = await newCase();
      await post(`/api/cases/${kase.case_id}/assign`, { employee_id: a.employee_id });
      await post(`/api/cases/${kase.case_id}/team`, { employee_id: b.employee_id });
      await post(`/api/cases/${kase.case_id}/visits/bulk`, { dates: [inDays(-2), inDays(-1), inDays(3)] }, MANAGER, 201);
      await sql.run(`UPDATE case_visits SET check_in_at = now() - interval '30 hours', check_out_at = now() - interval '25 hours'
                      WHERE case_id = :id AND visit_date = :d`, { id: kase.case_id, d: inDays(-1) });

      const after = await get('/api/cases/dashboard', HR);
      assert.equal(after.status, 200, 'HR เห็นหน้าภาพรวม — ไม่มีตัวเลขเงินในเส้นนี้');
      const day = (d) => after.body.visits.find((v) => v.date === d);
      const delta = (d, s) => day(d)[s] - before.visits.find((v) => v.date === d)[s];
      assert.equal(delta(inDays(-2), 'missed'), 1);
      assert.equal(delta(inDays(-1), 'done'), 1);
      assert.equal(delta(inDays(3), 'scheduled'), 1);
      const sumMonth = (r) => r.homecare + r.physio;
      assert.equal(sumMonth(after.body.monthly.at(-1)) - sumMonth(before.monthly.at(-1)), 1);
      const lead = after.body.workload.find((w) => w.employee_id === a.employee_id);
      const team = after.body.workload.find((w) => w.employee_id === b.employee_id);
      assert.equal(lead?.lead_cases, 1);
      assert.equal(team?.cases, 1, 'คนในทีมนับภาระงานด้วย');
      assert.equal(team?.lead_cases, 0);
      assert.equal(lead.upcoming_visits, 1);

      assert.equal((await get('/api/cases/dashboard', FIELD)).status, 403);
    });

    test('เส้นรับคิวของ chat ต้องมีตั๋วที่ลงลายเซ็น', async () => {
      const res = await fetch(`${base}/api/integration/cases/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'forged.token' }),
      });
      assert.equal(res.status, 401);
    });

    test('แจ้งเตือนพัง ไม่ทำให้งานหลักพัง', async () => {
      const { notifySafely } = await import('../src/notify/caseEvents.js');
      const original = console.error;
      console.error = () => {};
      try {
        await assert.doesNotReject(notifySafely('test', async () => { throw new Error('boom'); }));
      } finally {
        console.error = original;
      }
    });
  });

  // ---------- บันทึกการใช้งาน (audit log · เก็บอย่างน้อย 1 ปี · 16 พ.ย. 2569) ----------
  describe('บันทึกการใช้งาน (audit_logs)', () => {
    const SUPER = emp('EMP-0090', 'super_admin');
    /* ทั้งไฟล์ใช้ฐานเดียวกัน — เทสก่อนหน้าทิ้งบันทึกไว้เยอะแล้ว ดูเฉพาะแถวที่เกิดในเทสนี้ (log_id > since) */
    let since = 0;
    beforeEach(async () => {
      since = Number((await sql.one('SELECT coalesce(max(log_id), 0) AS n FROM audit_logs')).n);
    });
    const logs = (where, params = {}) =>
      sql.all(`SELECT * FROM audit_logs WHERE log_id > :since AND ${where} ORDER BY log_id`, { ...params, since });

    async function send(method, path, body, who, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, body: data };
    }

    before(async () => {
      await sql.run(
        `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
         VALUES ('EMP-0090', 'Super', 'Admin', 'super_admin', 'emp-0090@example.invalid', 'active', 'x', false)
         ON CONFLICT DO NOTHING`,
      );
    });

    test('login ผิด = บันทึกว่าไม่สำเร็จ พร้อมบัญชีที่ถูกลอง · ไม่มีรหัสผ่านในบันทึก', async () => {
      const r = await send('POST', '/api/auth/login', { email: 'EMP-0007@example.invalid', password: 'wrong-pass-xyz' });
      assert.equal(r.status, 401);
      const [row] = await logs(`action = 'auth.login' AND ok = false AND target_id = 'EMP-0007'`);
      assert.ok(row, 'ต้องมีแถว login ไม่สำเร็จ');
      assert.equal(row.level, 1);
      assert.equal(row.actor_id, null);
      assert.equal(row.detail.login, 'EMP-0007@example.invalid');
      assert.equal(JSON.stringify(row).includes('wrong-pass-xyz'), false, 'ห้ามมีรหัสผ่านในบันทึก');
    });

    test('login สำเร็จ = บันทึกผู้ทำ ชื่อ ตำแหน่ง IP', async () => {
      const r = await send('POST', '/api/auth/login', { email: 'EMP-0007@example.invalid', password: 'Fixture-password-123!' });
      assert.equal(r.status, 200);
      const rows = await logs(`action = 'auth.login' AND ok = true AND actor_id = 'EMP-0007'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].actor_name, 'Test Employee');
      assert.equal(rows[0].actor_position, 'hr');
      assert.ok(rows[0].ip);
      assert.equal(JSON.stringify(rows[0]).includes('Fixture-password-123!'), false);
    });

    test('แก้สิทธิ์ = เก็บค่าที่ตั้ง (ระดับ 1) · คืนค่าตั้งต้นก็บันทึก', async () => {
      const r = await send('PUT', '/api/permissions/hr', { permissions: ['cases', 'customers'] }, MANAGER);
      assert.equal(r.status, 200);
      const [row] = await logs(`action = 'permissions.update' AND target_id = 'hr'`);
      assert.equal(row.actor_id, 'EMP-0001');
      assert.equal(row.target_type, 'positions');
      assert.deepEqual(row.detail.values.permissions, ['cases', 'customers']);
      assert.equal((await send('DELETE', '/api/permissions/hr', null, MANAGER)).status, 200);
      assert.equal((await logs(`action = 'permissions.delete' AND target_id = 'hr'`)).length, 1);
    });

    test('ถูกปฏิเสธสิทธิ์ (403) = บันทึก access.denied · เส้นเดิมซ้ำใน 15 นาทีนับครั้งเดียว แต่ต่างเส้นนับแยก', async () => {
      // เส้นที่เทสอื่นยังไม่เคยให้พนักงานภาคสนามเรียก (ถูกนับรวมกับของเดิมใน 15 นาที)
      assert.equal((await send('GET', '/api/packages/meta', null, FIELD)).status, 403);
      assert.equal((await send('GET', '/api/packages/meta', null, FIELD)).status, 403);
      assert.equal((await send('GET', '/api/reviews/summary', null, FIELD)).status, 403);
      const rows = await logs(`action = 'access.denied' AND actor_id = 'EMP-0003'`);
      assert.deepEqual(rows.map((r) => r.path), ['/api/packages/meta', '/api/reviews/summary']);
      assert.ok(rows.every((r) => r.ok === false && r.status === 403 && r.level === 1));
    });

    test('เปิดดูแฟ้มเคส = บันทึกครั้งเดียวใน 15 นาที พร้อมชื่อผู้รับบริการ · GET รายการทั่วไปไม่บันทึก', async () => {
      // Super Admin — ผู้จัดการเปิดเคสนี้ไปแล้วในเทสก่อน ๆ (ภายใน 15 นาที จะถูกนับรวมเป็นครั้งเดิม)
      assert.equal((await send('GET', '/api/cases/CASE-FIXTURE', null, SUPER)).status, 200);
      assert.equal((await send('GET', '/api/cases/CASE-FIXTURE', null, SUPER)).status, 200);
      const rows = await logs(`action = 'cases.view' AND actor_id = 'EMP-0090' AND target_id = 'CASE-FIXTURE'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].level, 2);
      assert.equal(rows[0].target_label, 'Test patient');
      assert.equal((await send('GET', '/api/cases/meta', null, SUPER)).status, 200);
      assert.equal((await logs(`path = '/api/cases/meta'`)).length, 0, '/cases/meta ไม่ใช่การเปิดแฟ้ม');
    });

    test('แก้ข้อมูลเคส = เก็บแค่ชื่อช่อง ไม่เก็บค่า (ข้อมูลสุขภาพ)', async () => {
      const r = await send('PATCH', '/api/cases/CASE-FIXTURE', { medical_history: 'เบาหวาน-ลับ' }, MANAGER);
      const [row] = await logs(`action = 'cases.update' AND target_id = 'CASE-FIXTURE'`);
      assert.ok(row, `ต้องบันทึก (status ${r.status})`);
      assert.deepEqual(row.detail.fields, ['medical_history']);
      assert.equal(row.detail.values, undefined);
      assert.equal(JSON.stringify(row).includes('เบาหวาน-ลับ'), false);
    });

    test('แก้หรือลบบันทึกย้อนหลังไม่ได้ (trigger) — ลบได้เฉพาะที่เก่ากว่า 1 ปี', async () => {
      const row = await sql.one(`SELECT log_id FROM audit_logs WHERE action = 'auth.login' LIMIT 1`);
      await assert.rejects(sql.run(`UPDATE audit_logs SET ok = NOT ok WHERE log_id = :id`, { id: row.log_id }), /แก้ไขไม่ได้/);
      await assert.rejects(sql.run(`DELETE FROM audit_logs WHERE log_id = :id`, { id: row.log_id }), /แก้ไขไม่ได้/);
      const { purgeAuditLogs } = await import('../src/lib/audit.js');
      assert.equal(await purgeAuditLogs(), 0, 'ของใหม่ต้องไม่ถูกกวาด');
    });

    test('หน้าดูบันทึก: ค่าตั้งต้น Super Admin เท่านั้น · กรองตามคน/ระดับได้ · การเปิดดูก็ถูกบันทึก', async () => {
      assert.equal((await send('GET', '/api/audit-logs', null, MANAGER)).status, 403, 'ผู้จัดการไม่ได้โดยปริยาย');
      const r = await send('GET', '/api/audit-logs?actor=EMP-0007&level=1', null, SUPER);
      assert.equal(r.status, 200);
      assert.ok(r.body.rows.length >= 2);
      assert.ok(r.body.rows.every((x) => x.actor_id === 'EMP-0007' && x.level === 1));
      assert.equal(r.body.rows[0].label, 'เข้าสู่ระบบ (รหัสผ่าน)');
      const meta = await send('GET', '/api/audit-logs/meta', null, SUPER);
      assert.equal(meta.status, 200);
      assert.equal(meta.body.retention_days >= 365, true);
      assert.equal((await logs(`action = 'audit-logs.view' AND actor_id = 'EMP-0090'`)).length, 1);
      assert.equal((await send('GET', '/api/audit-logs/export', null, SUPER)).status, 400, 'ส่งออกต้องระบุช่วงวัน');
    });

    test('คนนอก (ไม่มีเซสชัน) ยิงเส้นมั่ว/ไม่ผ่าน = ไม่เกิดแถว · login ผิดซ้ำจาก IP เดิมนับครั้งเดียวต่อผลลัพธ์', async () => {
      const junk = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`.repeat(50), 'x'.repeat(1000)]));
      assert.equal((await send('POST', '/api/does-not-exist-123', junk)).status, 404);
      assert.equal((await send('POST', '/api/patients', junk)).status, 401);
      assert.equal((await send('GET', '/api/public/bill/abcdefghijklmnopqrstuvwxyz0123456789')).status >= 400, true);
      assert.equal((await logs('true')).length, 0, 'ต้องไม่มีแถวจากคำขอที่ไม่รู้ตัวตนและไม่สำเร็จ');

      for (let i = 0; i < 3; i++) {
        assert.equal((await send('POST', '/api/auth/login', { email: 'EMP-0004@example.invalid', password: `nope-${i}` })).status, 401);
      }
      assert.equal((await logs(`action = 'auth.login' AND target_id = 'EMP-0004'`)).length, 1);
    });

    test('พิมพ์รหัสผ่านลงช่องอีเมล (ไม่ตรงบัญชีไหน) = ไม่เก็บข้อความที่พิมพ์', async () => {
      // IP ใหม่ — login ผิดที่ไม่ตรงบัญชีจาก IP เดิมถูกนับรวมเป็นครั้งเดียวใน 15 นาที (เทสก่อน ๆ ใช้ 127.0.0.1 ไปแล้ว)
      const ip = { 'x-forwarded-for': '203.0.113.77' };
      assert.equal((await send('POST', '/api/auth/login', { email: 'MySecretPw99', password: 'x' }, null, ip)).status, 401);
      const [row] = await logs(`action = 'auth.login' AND ok = false AND target_id IS NULL AND ip = '203.0.113.77'`);
      assert.ok(row);
      assert.equal(JSON.stringify(row).includes('MySecretPw99'), false);
      assert.match(row.detail.login, /ไม่พบบัญชี/);
    });

    test('action ที่เก็บค่า: ข้อความอิสระ (เหตุผล) เก็บแค่ความยาว · สถานะ/วันที่/ตัวเลขเก็บค่า', async () => {
      await send('POST', '/api/cases/CASE-FIXTURE/cancel', { reason: 'ผู้ป่วยแผลกดทับระดับ 3', status: 'cancelled', amount: 500 }, MANAGER);
      const [row] = await logs(`action = 'cases.cancel' AND target_id = 'CASE-FIXTURE'`);
      assert.ok(row);
      assert.equal(JSON.stringify(row).includes('แผลกดทับ'), false);
      assert.match(row.detail.values.reason, /^\[ข้อความ \d+ ตัวอักษร\]$/);
      assert.equal(row.detail.values.status, 'cancelled');
      assert.equal(row.detail.values.amount, 500);
    });

    test('สิทธิ์ดูบันทึกตั้งได้ที่หน้าจัดการสิทธิ์ — เปิดให้ HR แล้วเข้าได้ · คืนค่าตั้งต้นแล้วเข้าไม่ได้', async () => {
      const matrix = (await send('GET', '/api/permissions', null, MANAGER)).body;
      assert.ok(matrix.catalog.some((c) => c.key === 'audit_logs'), 'ต้องมีสวิตช์ในหน้าจัดการสิทธิ์');
      assert.equal(matrix.positions.find((p) => p.position === 'manager').permissions.includes('audit_logs'), false);
      assert.equal((await send('GET', '/api/audit-logs', null, HR)).status, 403);

      const hrNow = matrix.positions.find((p) => p.position === 'hr').permissions;
      // เปิด/ปิด audit_logs ได้เฉพาะ Super Admin (ตรวจรอบ 2 · 16 พ.ย. 2569)
      assert.equal((await send('PUT', '/api/permissions/hr', { permissions: [...hrNow, 'audit_logs'] }, SUPER)).status, 200);
      try {
        assert.equal((await send('GET', '/api/audit-logs', null, HR)).status, 200);
        const me = (await send('GET', '/api/auth/me', null, HR)).body;
        assert.ok(me.permissions.includes('audit_logs'), 'หน้าเว็บต้องรู้สิทธิ์ใหม่ (เมนูขึ้น)');
      } finally {
        assert.equal((await send('DELETE', '/api/permissions/hr', null, SUPER)).status, 200);
      }
      assert.equal((await send('GET', '/api/audit-logs', null, HR)).status, 403);
    });

    test('แปลงเส้นทางเป็น action ถูกต้อง', async () => {
      const { describeRequest } = await import('../src/lib/audit.js');
      const d = (m, p) => describeRequest(m, p);
      assert.equal(d('POST', '/api/patients').action, 'patients.create');
      assert.equal(d('PATCH', '/api/patients/KN690202463').targetId, 'KN690202463');
      assert.equal(d('POST', '/api/cases/KN690202463/visits/12/move').action, 'cases.visits.move');
      assert.deepEqual(d('POST', '/api/cases/KN690202463/visits/12/move').sub, { visits: '12' });
      assert.equal(d('DELETE', '/api/invoices/INV-6911-0001/slips/3').level, 3);
      assert.equal(d('POST', '/api/integration/visits/reminders'), null, 'คิวของระบบแชทไม่บันทึก');
      assert.equal(d('POST', '/api/integration/hire').action, 'integration.hire');
      assert.equal(d('GET', '/api/auth/me'), null);
      const bill = d('GET', '/api/public/bill/abcdef1234567890abcdef1234567890');
      assert.equal(bill.action, 'public.bill.view');
      assert.equal(bill.path.includes('abcdef1234567890abcdef1234567890'), false, 'ห้ามเก็บโทเคนลิงก์บิลเต็ม ๆ');
      // เส้นใหม่ที่ไม่มีใครรู้จักก็ปิดโทเคนเหมือนกัน (กติกาเดียวกับ logUrl)
      const other = d('POST', '/api/share/Zx9AbCdEfGhIjKlMnOpQrStUvWxYz/accept');
      assert.equal(other.path, '/api/share/Zx9AbC…/accept');
      assert.equal(other.targetId, 'Zx9AbC…');
    });
  });

  // ---------- หมวดหมู่ (cat / sub cat · 16 พ.ย. 2569 เฟสแรก) ----------
  describe('หมวดหมู่ (categories) + เหตุผลยกเลิก', () => {
    async function call(method, path, body, who) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, body: data };
    }
    const leaf = async (code) => sql.one('SELECT category_id, name_th FROM categories WHERE code = :code', { code });

    test('อ่านได้ทุกคนที่ login · หมวดตั้งต้นครบ 2 ชั้น · หัตถการ/เหตุการณ์มีรายการผูกไว้', async () => {
      const r = await call('GET', '/api/categories?domain=cancel_case', null, FIELD);
      assert.equal(r.status, 200);
      const rows = r.body.categories;
      assert.ok(rows.some((c) => c.code === 'RCS-CUS' && c.parent_id == null));
      assert.ok(rows.some((c) => c.code === 'RCS-CUS-03' && c.parent_id != null));
      assert.ok(rows.every((c) => c.domain === 'cancel_case'));
      assert.equal((await call('GET', '/api/categories?all=1', null, FIELD)).status, 403, 'หมวดที่ปิดแล้วเห็นได้เฉพาะคนจัดการ');

      const all = (await call('GET', '/api/categories', null, MANAGER)).body.categories;
      const procItems = all.filter((c) => c.domain === 'procedure').flatMap((c) => c.item_keys);
      for (let i = 1; i <= 29; i++) assert.ok(procItems.includes(`PR${String(i).padStart(4, '0')}`), `PR${i} ต้องอยู่ในหมวด`);
      assert.equal(new Set(procItems).size, procItems.length, 'หัตถการหนึ่งรายการอยู่ได้หมวดเดียว');
      assert.ok(all.some((c) => c.domain === 'incident' && c.item_keys.includes('fall')));
    });

    test('เพิ่มหมวด: หมวดหลักตั้งรหัส 3 ตัว · หมวดย่อยได้เลขถัดไปเอง · โดเมนรายการในระบบเพิ่มไม่ได้ · ไม่มีสิทธิ์ = 403', async () => {
      const main = await call('POST', '/api/categories', { domain: 'cancel_case', code: 'tst', name_th: 'ทดสอบ' }, MANAGER);
      assert.equal(main.status, 201);
      assert.equal(main.body.code, 'RCS-TST');
      assert.equal((await call('POST', '/api/categories', { domain: 'cancel_case', code: 'TST', name_th: 'ซ้ำ' }, MANAGER)).status, 409);
      assert.equal((await call('POST', '/api/categories', { domain: 'cancel_case', code: 'T1', name_th: 'x' }, MANAGER)).status, 400);

      const s1 = await call('POST', '/api/categories', { domain: 'cancel_case', parent_id: main.body.category_id, name_th: 'ย่อย 1' }, MANAGER);
      const s2 = await call('POST', '/api/categories', { domain: 'cancel_case', parent_id: main.body.category_id, name_th: 'ย่อย 2' }, MANAGER);
      assert.equal(s1.body.code, 'RCS-TST-01');
      assert.equal(s2.body.code, 'RCS-TST-02');
      // ลึกเกิน 2 ชั้นไม่ได้
      assert.equal((await call('POST', '/api/categories', { domain: 'cancel_case', parent_id: s1.body.category_id, name_th: 'หลาน' }, MANAGER)).status, 400);
      assert.equal((await call('POST', '/api/categories', { domain: 'incident', code: 'NEW', name_th: 'x' }, MANAGER)).status, 400);
      assert.equal((await call('POST', '/api/categories', { domain: 'cancel_case', code: 'HRX', name_th: 'x' }, HR)).status, 403);

      const renamed = await call('PATCH', `/api/categories/${s2.body.category_id}`, { name_th: 'ย่อย 2 (แก้)', active: false }, MANAGER);
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.code, 'RCS-TST-02', 'รหัสไม่เปลี่ยนตามชื่อ');
      assert.equal(renamed.body.active, false);
      await assert.rejects(sql.run(`UPDATE categories SET code = 'RCS-XXX' WHERE category_id = :id`, { id: main.body.category_id }), /เปลี่ยนไม่ได้/);
    });

    test('แคตตาล็อก: เพิ่มหมวดหัตถการ/อุปกรณ์ · จัดรายการเข้าหมวดย่อย · ย้ายแล้วหลุดจากหมวดเดิม · หมวดแพ็กเกจไม่มีแล้ว', async () => {
      const { domains } = (await call('GET', '/api/categories', null, FIELD)).body;
      for (const d of ['procedure', 'equipment']) assert.ok(domains[d]?.items, `${d} ต้องเป็นแคตตาล็อก`);
      // หมวดแพ็กเกจ Homecare/กายภาพ เอาออกแล้ว — แพ็กจัดการที่หน้าแพ็คเกจที่เดียว
      for (const d of ['physio_package', 'homecare_package']) assert.equal(domains[d], undefined, d);
      assert.equal((await call('POST', '/api/categories', { domain: 'physio_package', code: 'NEU', name_th: 'x' }, MANAGER)).status, 400);

      const mk = async (body) => {
        const r = await call('POST', '/api/categories', body, MANAGER);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return r.body;
      };
      // หัตถการ — เพิ่มหมวดได้ · ย้าย PR0003 จากหมวดตั้งต้นมาหมวดใหม่ · ตัดตัวซ้ำ
      const pMain = await mk({ domain: 'procedure', code: 'NEW', name_th: 'หมวดใหม่' });
      const pSub = await mk({ domain: 'procedure', parent_id: pMain.category_id, name_th: 'ย่อยใหม่' });
      const pSub2 = await mk({ domain: 'procedure', parent_id: pMain.category_id, name_th: 'ย่อยใหม่ 2' });
      assert.equal(pSub.code, 'PRC-NEW-01');
      let r = await call('PUT', `/api/categories/${pSub.category_id}/items`, { item_keys: ['PR0003', 'PR0026', 'PR0003'] }, MANAGER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.categories.find((c) => c.category_id === pSub.category_id).item_keys, ['PR0003', 'PR0026'], 'ตัดตัวซ้ำ');
      const holders = r.body.categories.filter((c) => c.item_keys.includes('PR0003'));
      assert.deepEqual(holders.map((c) => c.category_id), [pSub.category_id], 'หัตถการหนึ่งรายการอยู่ได้หมวดเดียว');
      r = await call('PUT', `/api/categories/${pSub2.category_id}/items`, { item_keys: ['PR0026'] }, MANAGER);
      assert.deepEqual(r.body.categories.find((c) => c.category_id === pSub.category_id).item_keys, ['PR0003'], 'ย้ายแล้วหลุดจากหมวดเดิม');

      // รหัสผิด / หมวดหลัก / ไม่มีสิทธิ์ / โดเมนที่ไม่ใช่แคตตาล็อก
      assert.equal((await call('PUT', `/api/categories/${pSub.category_id}/items`, { item_keys: ['XX01'] }, MANAGER)).status, 400);
      assert.equal((await call('PUT', `/api/categories/${pMain.category_id}/items`, { item_keys: ['PR0003'] }, MANAGER)).status, 400);
      assert.equal((await call('PUT', `/api/categories/${pSub.category_id}/items`, { item_keys: [] }, HR)).status, 403);
      const reason = await leaf('RCS-CUS-02');
      assert.equal((await call('PUT', `/api/categories/${reason.category_id}/items`, { item_keys: ['x'] }, MANAGER)).status, 400);

      // อุปกรณ์ — ชื่อพิมพ์เอง
      const eMain = await mk({ domain: 'equipment', code: 'RES', name_th: 'ทางเดินหายใจ' });
      assert.equal(eMain.code, 'EQP-RES');
      const eSub = await mk({ domain: 'equipment', parent_id: eMain.category_id, name_th: 'ออกซิเจน' });
      r = await call('PUT', `/api/categories/${eSub.category_id}/items`, { item_keys: ['  เครื่องผลิตออกซิเจน 5 ลิตร ', 'ถังออกซิเจน'] }, MANAGER);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.categories.find((c) => c.category_id === eSub.category_id).item_keys, ['เครื่องผลิตออกซิเจน 5 ลิตร', 'ถังออกซิเจน']);
      assert.equal((await call('PUT', `/api/categories/${eSub.category_id}/items`, { item_keys: ['x'.repeat(121)] }, MANAGER)).status, 400);

      // คนทั่วไปอ่านหมวดแคตตาล็อกได้ (ช่องเลือกในฟอร์มเคส)
      const field = (await call('GET', '/api/categories?domain=equipment', null, FIELD)).body.categories;
      assert.ok(field.some((c) => c.item_keys.includes('ถังออกซิเจน')));
    });

    test('ราคาแคตตาล็อก: หัตถการ ครั้ง/วัน/เดือน · อุปกรณ์ เช่า/ขาย · ทุกคนอ่านได้ · ตั้งได้เฉพาะสิทธิ์ categories', async () => {
      let r = await call('PUT', '/api/categories/prices', { domain: 'procedure', item_key: 'PR0003', price_visit: '180', price_month: 9500 }, MANAGER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.price_visit, 180);
      assert.equal(r.body.price_day, null);
      assert.equal(r.body.price_month, 9500);
      // ส่งใหม่ = แทนทั้งชุด · ช่องของโดเมนอื่นถูกตัดทิ้ง
      r = await call('PUT', '/api/categories/prices', { domain: 'procedure', item_key: 'PR0003', price_visit: 200, price_rent: 5 }, MANAGER);
      assert.equal(r.body.price_visit, 200);
      assert.equal(r.body.price_month, null);
      assert.equal(r.body.price_rent, null);

      r = await call('PUT', '/api/categories/prices', { domain: 'equipment', item_key: ' เตียงลม ', price_rent: 3000, price_sale: '25,000' }, MANAGER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.item_key, 'เตียงลม');
      assert.equal(r.body.price_sale, 25000);

      // ผิดรูปแบบ / โดเมนไม่มีราคา / ราคาติดลบ / ไม่มีสิทธิ์
      assert.equal((await call('PUT', '/api/categories/prices', { domain: 'procedure', item_key: 'X1', price_visit: 1 }, MANAGER)).status, 400);
      assert.equal((await call('PUT', '/api/categories/prices', { domain: 'cancel_case', item_key: '1', price_visit: 1 }, MANAGER)).status, 400);
      assert.equal((await call('PUT', '/api/categories/prices', { domain: 'equipment', item_key: 'x', price_rent: -1 }, MANAGER)).status, 400);
      assert.equal((await call('PUT', '/api/categories/prices', { domain: 'equipment', item_key: 'x', price_rent: 1 }, HR)).status, 403);

      // พนักงานทั่วไปอ่านราคาได้ (ฟอร์มเคสใช้เติมราคา)
      const all = (await call('GET', '/api/categories', null, FIELD)).body;
      assert.ok(all.prices.some((p) => p.domain === 'equipment' && p.item_key === 'เตียงลม' && p.price_rent === 3000));
      assert.deepEqual(all.price_fields.procedure, ['price_visit', 'price_day', 'price_month']);
      // รายการอุปกรณ์ตั้งต้น (ผู้ใช้ส่งมา 19 พ.ย. 2569): ตรวจสุขภาพ = ราคาขาย · ที่เหลือ = ค่าเช่า · 6 หมวดหลัก 39 รายการ
      const atk = all.prices.find((p) => p.domain === 'equipment' && p.item_key === 'ATK โควิด-19 EuroGen');
      assert.equal(atk.price_sale, 30);
      assert.equal(atk.price_rent, null);
      const bed = all.prices.find((p) => p.domain === 'equipment' && p.item_key === 'ชุดเตียง ALLWELL KS-828b');
      assert.equal(bed.price_rent, 4500);
      assert.equal(bed.price_sale, null);
      const eqCats = all.categories.filter((c) => c.domain === 'equipment' && /^EQP-(HCK|OXY|BED|WCH|MOB|MAT)/.test(c.code));
      assert.equal(eqCats.filter((c) => c.parent_id == null).length, 6);
      assert.equal(eqCats.flatMap((c) => c.item_keys).length, 39);
      assert.ok(eqCats.find((c) => c.code === 'EQP-OXY-01').item_keys.includes('Yuwell 9F-5BW (5 ลิตร)'));
      const eqOnly = (await call('GET', '/api/categories?domain=equipment', null, FIELD)).body.prices;
      assert.ok(eqOnly.every((p) => p.domain === 'equipment'));
      assert.deepEqual((await call('GET', '/api/categories?domain=cancel_case', null, FIELD)).body.prices, []);
    });

    test('เหตุผลยกเลิก/เหตุการณ์ = Super Admin + ผู้จัดการเท่านั้น แม้มีสิทธิ์ categories · แคตตาล็อกใช้สิทธิ์ categories', async () => {
      const { domains } = (await call('GET', '/api/categories', null, FIELD)).body;
      for (const d of ['cancel_case', 'cancel_visit', 'cancel_invoice', 'incident']) assert.equal(domains[d].settings, true, d);
      for (const d of ['procedure', 'equipment']) assert.ok(!domains[d].settings, d);

      const hrNow = (await call('GET', '/api/permissions', null, MANAGER)).body.positions?.find?.((p) => p.position === 'hr')?.permissions;
      const base = Array.isArray(hrNow) ? hrNow : [];
      assert.equal((await call('PUT', '/api/permissions/hr', { permissions: [...new Set([...base, 'categories'])] }, MANAGER)).status, 200);
      try {
        // HR ที่ได้สิทธิ์ categories: จัดแคตตาล็อกได้ · เหตุผลยกเลิก/เหตุการณ์ไม่ได้
        const eq = await call('POST', '/api/categories', { domain: 'equipment', code: 'HRE', name_th: 'ของ HR' }, HR);
        assert.equal(eq.status, 201, JSON.stringify(eq.body));
        assert.equal((await call('PATCH', `/api/categories/${eq.body.category_id}`, { name_th: 'ของ HR (แก้)' }, HR)).status, 200);
        assert.equal((await call('POST', '/api/categories', { domain: 'cancel_case', code: 'HRR', name_th: 'x' }, HR)).status, 403);
        const reason = await leaf('RCS-CUS-01');
        assert.equal((await call('PATCH', `/api/categories/${reason.category_id}`, { name_th: 'x' }, HR)).status, 403);
        const inc = await sql.one(`SELECT category_id FROM categories WHERE domain = 'incident' AND parent_id IS NULL LIMIT 1`);
        assert.equal((await call('PATCH', `/api/categories/${inc.category_id}`, { sort_order: 5 }, HR)).status, 403);
      } finally {
        assert.equal((await call('DELETE', '/api/permissions/hr', null, MANAGER)).status, 200);
      }
      // ปิดหมวดหลัก = หมวดย่อยปิดตามทั้งหมด · เปิดหมวดย่อยเดี่ยวๆ ใต้หมวดที่ปิดไม่ได้ · เปิดหมวดหลัก = เปิดตามทั้งหมด
      const m = await call('POST', '/api/categories', { domain: 'cancel_visit', code: 'CSC', name_th: 'ทดสอบปิดตาม' }, MANAGER);
      const k1 = await call('POST', '/api/categories', { domain: 'cancel_visit', parent_id: m.body.category_id, name_th: 'ก' }, MANAGER);
      await call('POST', '/api/categories', { domain: 'cancel_visit', parent_id: m.body.category_id, name_th: 'ข' }, MANAGER);
      const kids = async () => sql.all('SELECT active FROM categories WHERE parent_id = :id', { id: m.body.category_id });
      assert.equal((await call('PATCH', `/api/categories/${m.body.category_id}`, { active: false }, MANAGER)).status, 200);
      assert.ok((await kids()).every((r) => r.active === false), 'หมวดย่อยต้องปิดตาม');
      assert.equal((await call('PATCH', `/api/categories/${k1.body.category_id}`, { active: true }, MANAGER)).status, 400);
      assert.equal((await call('PATCH', `/api/categories/${m.body.category_id}`, { active: true }, MANAGER)).status, 200);
      assert.ok((await kids()).every((r) => r.active === true), 'เปิดหมวดหลักแล้วหมวดย่อยเปิดตาม');

      // ผู้จัดการแก้เหตุผลได้ · ไม่พบหมวด = 404
      const reason = await leaf('RCS-CUS-01');
      assert.equal((await call('PATCH', `/api/categories/${reason.category_id}`, { name_th: reason.name_th }, MANAGER)).status, 200);
      assert.equal((await call('PATCH', '/api/categories/99999999', { name_th: 'x' }, MANAGER)).status, 404);
    });

    test('ยกเลิกเคสพร้อมหมวดเหตุผล = เก็บรหัส + ชื่อนำหน้ารายละเอียด · หมวดผิดโดเมน/หมวดหลัก/ปิดแล้ว = 400', async () => {
      const reason = await leaf('RCS-CUS-02');
      const wrongDomain = await leaf('RIV-ERR-01');
      const mainCat = await leaf('RCS-CUS');
      const c1 = await newCase();
      assert.equal((await call('POST', `/api/cases/${c1.case_id}/cancel`, { reason_id: wrongDomain.category_id }, MANAGER)).status, 400);
      assert.equal((await call('POST', `/api/cases/${c1.case_id}/cancel`, { reason_id: mainCat.category_id }, MANAGER)).status, 400);
      const off = await sql.one(`SELECT category_id FROM categories WHERE code = 'RCS-TST-02'`);
      assert.equal((await call('POST', `/api/cases/${c1.case_id}/cancel`, { reason_id: off.category_id }, MANAGER)).status, 400);

      const ok = await call('POST', `/api/cases/${c1.case_id}/cancel`, { reason_id: reason.category_id, reason: 'แอดมิทที่ รพ.ศิริราช' }, MANAGER);
      assert.equal(ok.status, 200);
      const row = await sql.one('SELECT cancel_reason, cancel_reason_id FROM cases WHERE case_id = :id', { id: c1.case_id });
      assert.equal(row.cancel_reason_id, reason.category_id);
      assert.equal(row.cancel_reason, `${reason.name_th} — แอดมิทที่ รพ.ศิริราช`);

      // ไม่เลือกหมวด (แบบเดิม) ยังใช้ได้
      const c2 = await newCase();
      assert.equal((await call('POST', `/api/cases/${c2.case_id}/cancel`, { reason: 'เหตุผลแบบเดิม' }, MANAGER)).status, 200);
      const row2 = await sql.one('SELECT cancel_reason, cancel_reason_id FROM cases WHERE case_id = :id', { id: c2.case_id });
      assert.equal(row2.cancel_reason, 'เหตุผลแบบเดิม');
      assert.equal(row2.cancel_reason_id, null);

      // เปิดเคสกลับ = ล้างเหตุผลทั้งข้อความและรหัส
      assert.equal((await call('POST', `/api/cases/${c1.case_id}/reopen`, {}, MANAGER)).status, 200);
      const back = await sql.one('SELECT cancel_reason, cancel_reason_id FROM cases WHERE case_id = :id', { id: c1.case_id });
      assert.equal(back.cancel_reason_id, null);
      assert.equal(back.cancel_reason, null);
    });

    test('ยกเลิกนัดพร้อมหมวดเหตุผล = รหัสอยู่ในกะ + ชื่อเหตุผลต่อท้ายหมายเหตุ · กลับเป็นนัดปกติ = ล้างรหัส', async () => {
      const reason = await leaf('RVS-STF-01');
      const c = await newCase();
      const v = await post(`/api/cases/${c.case_id}/visits`, { visit_date: '2026-12-20' }, MANAGER, 201);
      const visitId = v.visit_id ?? v.visits?.[0]?.visit_id ?? (await sql.one('SELECT visit_id FROM case_visits WHERE case_id = :id', { id: c.case_id })).visit_id;
      const r = await call('PATCH', `/api/cases/${c.case_id}/visits/${visitId}`, { status: 'cancelled', cancel_reason_id: reason.category_id, cancel_reason: 'แจ้งตอนเช้า' }, MANAGER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await sql.one('SELECT note, cancel_reason_id FROM case_visits WHERE visit_id = :id', { id: visitId });
      assert.equal(row.cancel_reason_id, reason.category_id);
      assert.match(row.note, new RegExp(`ยกเลิก: ${reason.name_th} — แจ้งตอนเช้า`));
      assert.equal((await call('PATCH', `/api/cases/${c.case_id}/visits/${visitId}`, { status: 'scheduled' }, MANAGER)).status, 200);
      assert.equal((await sql.one('SELECT cancel_reason_id FROM case_visits WHERE visit_id = :id', { id: visitId })).cancel_reason_id, null);
    });

    test('ยกเลิกใบแจ้งหนี้: เลือกหมวดแล้วรายละเอียดไม่บังคับ · ไม่เลือกหมวดยังต้องพิมพ์ ≥ 3 ตัวอักษร', async () => {
      const { cancelInvoiceSchema } = await import('../src/invoices/schema.js');
      assert.equal(cancelInvoiceSchema.safeParse({ reason_id: 5 }).success, true);
      assert.equal(cancelInvoiceSchema.safeParse({ reason: 'ab' }).success, false);
      assert.equal(cancelInvoiceSchema.safeParse({}).success, false);
      assert.equal(cancelInvoiceSchema.safeParse({ reason: 'ออกใบผิด' }).success, true);
    });
  });

  // ---------- ตรวจรอบ 2 (16 พ.ย. 2569): สิทธิ์ superOnly · สิทธิ์ใหม่บนแถวเก่า · บันทึกไม่เก็บเลขผู้เสียภาษี · คนนอกยิงซ้ำ ----------
  describe('ตรวจรอบ 2 — บันทึกการใช้งาน/สิทธิ์/หมวดหมู่', () => {
    const SA = emp('EMP-0790', 'super_admin');
    async function call(method, path, body, who, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, body: data };
    }
    before(async () => {
      await sql.run(
        `INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
         VALUES ('EMP-0790', 'Super', 'Two', 'super_admin', 'emp-0790@example.invalid', 'active', 'x', false)
         ON CONFLICT DO NOTHING`,
      );
    });

    test('ผู้จัดการเปิดสิทธิ์ดูบันทึกให้ตำแหน่งตัวเอง/คนอื่นไม่ได้ · Super Admin ทำได้ · ผู้จัดการถอนคืนก็ไม่ได้', async () => {
      const keys = (await call('GET', '/api/permissions', null, MANAGER)).body.positions.find((p) => p.position === 'manager').permissions;
      assert.equal((await call('PUT', '/api/permissions/manager', { permissions: [...keys, 'audit_logs'] }, MANAGER)).status, 403);
      const hrKeys = (await call('GET', '/api/permissions', null, MANAGER)).body.positions.find((p) => p.position === 'hr').permissions;
      assert.equal((await call('PUT', '/api/permissions/hr', { permissions: [...hrKeys, 'audit_logs'] }, MANAGER)).status, 403);

      const granted = await call('PUT', '/api/permissions/hr', { permissions: [...hrKeys, 'audit_logs'] }, SA);
      assert.equal(granted.status, 200, JSON.stringify(granted.body));
      try {
        // ผู้จัดการแก้สิทธิ์อื่นของ HR ได้ตามปกติ ตราบที่ไม่แตะ audit_logs
        assert.equal((await call('PUT', '/api/permissions/hr', { permissions: [...hrKeys, 'audit_logs', 'reviews'].filter((v, i, a) => a.indexOf(v) === i) }, MANAGER)).status, 200);
        assert.equal((await call('DELETE', '/api/permissions/hr', null, MANAGER)).status, 403, 'คืนค่าตั้งต้น = ถอน audit_logs');
      } finally {
        assert.equal((await call('DELETE', '/api/permissions/hr', null, SA)).status, 200);
      }
    });

    test('แถวสิทธิ์ที่บันทึกก่อนมีสิทธิ์ "หมวดหมู่" — ผู้จัดการยังได้ตามค่าตั้งต้น', async () => {
      const { PERMISSION_KEYS, loadPermissions, keysFor } = await import('../src/lib/permissions.js');
      const legacy = PERMISSION_KEYS.filter((k) => !['audit_logs', 'categories'].includes(k));
      await sql.run(`INSERT INTO role_permissions (position, permissions) VALUES ('manager', :p::text[])
                     ON CONFLICT (position) DO UPDATE SET permissions = EXCLUDED.permissions, known_keys = NULL`, { p: legacy });
      try {
        await loadPermissions({ force: true });
        assert.ok(keysFor('manager').includes('categories'));
        assert.equal(keysFor('manager').includes('audit_logs'), false);
        assert.equal((await call('GET', '/api/categories?all=1', null, MANAGER)).status, 200);
      } finally {
        await sql.run(`DELETE FROM role_permissions WHERE position = 'manager'`);
        await loadPermissions({ force: true });
      }
    });

    test('บันทึกการใช้งานไม่เก็บเลขผู้เสียภาษี/เบอร์/อีเมล แม้อยู่ใน action ที่เก็บค่า', async () => {
      const since = Number((await sql.one('SELECT coalesce(max(log_id), 0) AS n FROM audit_logs')).n);
      await call('PATCH', '/api/invoices/HC-IV0000000000', { bill_to_tax_id: '1103700123456', bill_to_phone: '0812345678', status: 'issued' }, MANAGER);
      const row = await sql.one(`SELECT * FROM audit_logs WHERE log_id > :s AND action = 'invoices.update' ORDER BY log_id DESC LIMIT 1`, { s: since });
      assert.ok(row);
      const text = JSON.stringify(row);
      assert.equal(text.includes('1103700123456'), false);
      assert.equal(text.includes('0812345678'), false);
      assert.equal(row.detail.values.status, 'issued', 'ช่องที่ไม่ใช่ข้อมูลบุคคลยังเก็บค่าได้');
    });

    test('คนนอกขอ OTP ซ้ำ ๆ (ตอบ 200 เสมอ) จาก IP เดียว = นับครั้งเดียวใน 15 นาที', async () => {
      const since = Number((await sql.one('SELECT coalesce(max(log_id), 0) AS n FROM audit_logs')).n);
      const ip = { 'x-forwarded-for': '198.51.100.23' };
      for (let i = 0; i < 4; i++) {
        assert.equal((await call('POST', '/api/auth/forgot-password', { email: `nobody${i}@example.invalid` }, null, ip)).status, 200);
      }
      const rows = await sql.all(`SELECT log_id FROM audit_logs WHERE log_id > :s AND action = 'auth.forgot-password' AND ip = '198.51.100.23'`, { s: since });
      assert.equal(rows.length, 1);
    });

    test('แพ็กกายภาพ: ลงนัดเกินจำนวนครั้งไม่ได้ (16 พ.ย. 2569) · นัดที่ยกเลิกไม่นับ', async () => {
      const { physio_package_id: pkg } = await sql.one(
        `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
         VALUES ('Quota lock 3', 3, 4500, 1500) RETURNING physio_package_id`);
      const c = await call('POST', '/api/cases', { case_type: 'other', client_name: 'Quota lock', service_kind: 'physio',
        physio_package_id: pkg, fee: 4500 }, MANAGER);
      assert.equal(c.status, 201);
      const id = c.body.case_id;
      await sql.run(`UPDATE cases SET assigned_to = 'EMP-0003', status = 'assigned' WHERE case_id = :id`, { id });
      const day = (n) => { const d = new Date(Date.now() + 7 * 3600e3); d.setUTCDate(d.getUTCDate() + 10 + n); return d.toISOString().slice(0, 10); };

      const tooMany = await call('POST', `/api/cases/${id}/visits/bulk`, { dates: [day(1), day(2), day(3), day(4)] }, MANAGER);
      assert.equal(tooMany.status, 409);
      assert.match(tooMany.body.error, /3 ครั้ง/);
      assert.equal((await sql.one(`SELECT COUNT(*)::int AS n FROM case_visits WHERE case_id = :id`, { id })).n, 0, 'ปฏิเสธทั้งชุด ไม่ลงบางส่วน');

      const ok = await call('POST', `/api/cases/${id}/visits/bulk`, { dates: [day(1), day(2), day(3)] }, MANAGER);
      assert.equal(ok.status, 201);
      assert.equal(ok.body.added, 3);
      assert.equal((await call('POST', `/api/cases/${id}/visits`, { visit_date: day(5) }, MANAGER)).status, 409, 'ครบแล้ว ลงทีละวันก็ไม่ได้');
      // ลงวันเดิมซ้ำ (ถูกข้าม) ไม่นับเป็นนัดเพิ่ม
      assert.equal((await call('POST', `/api/cases/${id}/visits/bulk`, { dates: [day(1)] }, MANAGER)).status, 201);

      const first = ok.body.visits[0];
      assert.equal((await call('PATCH', `/api/cases/${id}/visits/${first.visit_id}`, { status: 'cancelled', cancel_reason: 'ทดสอบ' }, MANAGER)).status, 200);
      assert.equal((await call('POST', `/api/cases/${id}/visits`, { visit_date: day(6) }, MANAGER)).status, 201, 'ยกเลิกแล้วลงชดเชยได้');
      const reopen = await call('PATCH', `/api/cases/${id}/visits/${first.visit_id}`, { status: 'scheduled' }, MANAGER);
      assert.equal(reopen.status, 409, 'เปิดนัดที่ยกเลิกกลับมาตอนแพ็กเต็ม = เกินแพ็ก');
    });

    test('เปลี่ยนคน / แก้แค่เวลาจบ = แจ้งทั้งพนักงานและญาติ (16 พ.ย. 2569)', async () => {
      const { ensureFamilyTable } = await import('../src/lib/family.js');
      const { claimVisitChanges } = await import('../src/notify/visitReminders.js');
      await ensureFamilyTable();
      const c = await call('POST', '/api/cases', { case_type: 'other', client_name: 'Notify both' }, MANAGER);
      assert.equal(c.status, 201);
      const id = c.body.case_id;
      await sql.run(`UPDATE cases SET assigned_to = 'EMP-0003', status = 'assigned' WHERE case_id = :id`, { id });
      await sql.run(`INSERT INTO case_family_links (case_id, line_user_id, invited_by, consent_by, accepted_at)
                     VALUES (:id, 'U-family-notify-test', 'EMP-0001', 'EMP-0001', now())`, { id });
      const day = (n) => { const d = new Date(Date.now() + 7 * 3600e3); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      const added = await call('POST', `/api/cases/${id}/visits/bulk`, { dates: [day(3), day(4)], planned_start: '09:00', planned_end: '10:00' }, MANAGER);
      assert.equal(added.status, 201);
      const [v1, v2] = added.body.visits;

      assert.equal((await call('PATCH', `/api/cases/${id}/visits/${v1.visit_id}`, { assigned_to: 'EMP-0004' }, MANAGER)).status, 200);
      assert.equal((await call('PATCH', `/api/cases/${id}/visits/${v2.visit_id}`, { planned_end: '11:00' }, MANAGER)).status, 200);
      // คิวรอ 2 นาทีหลังแก้ครั้งสุดท้าย (กันแก้ต่อเนื่องได้หลายข้อความ) — ถอยเวลาให้พร้อมส่ง
      await sql.run(`UPDATE visit_change_outbox SET created_at = now() - interval '5 minutes' WHERE case_id = :id`, { id });
      const changes = (await claimVisitChanges()).filter((x) => x.case_id === id);

      const swap = changes.find((x) => x.visit_id === v1.visit_id);
      assert.equal(swap?.kind, 'reassigned');
      assert.deepEqual(swap.family, ['U-family-notify-test'], 'เปลี่ยนคนแจ้งญาติด้วย');
      assert.equal(swap.new.staff?.employee_id, 'EMP-0004');
      assert.match(swap.family_message, /แจ้งเปลี่ยน/, 'ข้อความเปลี่ยนคนต้องไม่ใช่ข้อความเลื่อนนัด');
      assert.doesNotMatch(swap.family_message, /เลื่อนนัด/);
      const endOnly = changes.find((x) => x.visit_id === v2.visit_id);
      assert.equal(endOnly?.kind, 'moved', 'แก้แค่เวลาจบนับเป็นเลื่อนเวลานัด');
      assert.equal(endOnly.new.end, '11:00');
      assert.match(endOnly.family_message, /แจ้งเลื่อนนัด/);
      assert.deepEqual(endOnly.family, ['U-family-notify-test']);

      const queued = await sql.all(`SELECT visit_id, channel FROM visit_notification_outbox WHERE visit_id IN (:a, :b) AND channel = 'family'`,
        { a: v1.visit_id, b: v2.visit_id });
      assert.equal(queued.length, 2, 'เข้าคิวส่ง LINE ญาติทั้งสองนัด');
    });

    test('Homecare: ลงกะได้ไม่เกินจำนวนวันของรูปแบบบริการ · นับเป็นวัน (16 พ.ย. 2569)', async () => {
      const { ensureFormatDays, defaultFormatDays } = await import('../src/packages/formatDays.js');
      await ensureFormatDays();
      assert.equal(defaultFormatDays({ name: 'รายเดือน 24 ชม. หยุด 4 วัน', category: 'monthly' }), 26);
      assert.equal(defaultFormatDays({ name: 'รายเดือน 24 ชม. ไม่มีวันหยุด', category: 'monthly' }), 30);
      assert.equal(defaultFormatDays({ name: 'รายวัน 12 ชม.', category: 'daily' }), null);

      // รูปแบบใหม่ที่สร้างผ่าน API ได้จำนวนวันจากชื่อ — แล้วตั้งเป็น 3 วันให้ทดสอบเร็ว
      const fmt = await call('POST', '/api/packages/formats', { name: 'ทดสอบรายเดือน หยุด 4 วัน', category: 'monthly', graded: true }, MANAGER);
      assert.equal(fmt.status, 201);
      assert.equal(fmt.body.days, 26);
      const patched = await call('PATCH', `/api/packages/formats/${fmt.body.format_id}`, { days: 3 }, MANAGER);
      assert.equal(patched.status, 200);
      assert.equal(patched.body.days, 3);

      const c = await call('POST', '/api/cases', { case_type: 'other', client_name: 'HC days lock' }, MANAGER);
      const id = c.body.case_id;
      await sql.run(`UPDATE cases SET assigned_to = 'EMP-0003', status = 'assigned', pkg_format_id = :f WHERE case_id = :id`,
        { id, f: fmt.body.format_id });
      const day = (n) => { const d = new Date(Date.now() + 7 * 3600e3); d.setUTCDate(d.getUTCDate() + 20 + n); return d.toISOString().slice(0, 10); };

      const over = await call('POST', `/api/cases/${id}/visits/bulk`, { dates: [day(1), day(2), day(3), day(4)] }, MANAGER);
      assert.equal(over.status, 409);
      assert.match(over.body.error, /3 วัน/);
      const ok = await call('POST', `/api/cases/${id}/visits/bulk`, { dates: [day(1), day(2), day(3)], planned_start: '08:00', planned_end: '20:00' }, MANAGER);
      assert.equal(ok.status, 201);
      // 24 ชม. แบ่งสองกะ: กะที่สองของวันเดิม (คนละเวลา) ไม่ใช่วันใหม่ — ลงได้
      const night = await call('POST', `/api/cases/${id}/visits/bulk`, { dates: [day(1)], planned_start: '20:00', planned_end: '08:00' }, MANAGER);
      assert.equal(night.status, 201);
      assert.equal(night.body.added, 1);
      assert.equal((await call('POST', `/api/cases/${id}/visits`, { visit_date: day(5) }, MANAGER)).status, 409, 'วันใหม่เกินแพ็ก');

      // ย้ายกะกลางคืนของวันที่ 1 (วันนั้นยังมีกะกลางวันอยู่) ไปวันใหม่ = วันเพิ่ม → ไม่ได้
      const nightVisit = night.body.visits.find((v) => v.planned_start === '20:00');
      assert.equal((await call('POST', `/api/cases/${id}/visits/${nightVisit.visit_id}/move`, { visit_date: day(6) }, MANAGER)).status, 409);
      // ย้ายกะของวันที่มีกะเดียว ไปวันใหม่ = จำนวนวันเท่าเดิม → ได้
      const dayThree = ok.body.visits.find((v) => v.visit_date === day(3));
      assert.equal((await call('POST', `/api/cases/${id}/visits/${dayThree.visit_id}/move`, { visit_date: day(7) }, MANAGER)).status, 200);

      const quota = await call('GET', `/api/cases/${id}/physio-quota`, null, MANAGER);
      assert.equal(quota.body.unit, 'วัน');
      assert.equal(quota.body.sessions, 3);
      assert.equal(quota.body.booked, 3);

      // ตั้งเป็นไม่จำกัด = ลงต่อได้
      assert.equal((await call('PATCH', `/api/packages/formats/${fmt.body.format_id}`, { days: null }, MANAGER)).status, 200);
      assert.equal((await call('POST', `/api/cases/${id}/visits`, { visit_date: day(5) }, MANAGER)).status, 201);
    });

    test('ซื้อหลายแพ็ก (pkg_quantity): ราคาเต็ม/ค่าจ้าง/จำนวนครั้ง-วัน/อายุแพ็ก คูณตาม · ใบแจ้งหนี้เขียน × N (17 พ.ย. 2569)', async () => {
      const { physio_package_id: pkgId } = await sql.one(
        `INSERT INTO physio_packages (name, sessions, duration_months, original_price, special_price, staff_pay)
         VALUES ('Qty pack', 2, 3, 12000, 10000, 4000) RETURNING physio_package_id`);
      // หน้าเว็บส่ง fee ที่คูณจำนวนแล้ว · ค่าจ้างไม่ส่ง = server ดึงจากแพ็ก × จำนวน
      const c = await call('POST', '/api/cases', { case_type: 'other', client_name: 'Qty physio', service_kind: 'physio',
        physio_package_id: pkgId, pkg_quantity: 2, fee: 20000 }, MANAGER);
      assert.equal(c.status, 201, JSON.stringify(c.body));
      assert.equal(c.body.pkg_quantity, 2);
      assert.equal(Number(c.body.staff_pay), 8000);
      assert.equal(Number(c.body.service_list_price_snapshot), 24000);
      assert.equal(Number(c.body.service_customer_price_snapshot), 20000);
      assert.equal(Number(c.body.physio_sessions), 4, 'จำนวนครั้งรวมทุกแพ็ก');
      assert.equal(Number(c.body.physio_package_sessions), 2);
      assert.equal(Number(c.body.physio_duration_months), 6);

      const quota = (await call('GET', `/api/cases/${c.body.case_id}/physio-quota`, null, MANAGER)).body;
      assert.equal(quota.sessions, 4);
      assert.equal(quota.duration_months, 6);

      // ลงนัดได้ 4 ครั้ง (แพ็กเดียวได้แค่ 2)
      await sql.run(`UPDATE cases SET assigned_to = 'EMP-0003', status = 'assigned' WHERE case_id = :id`, { id: c.body.case_id });
      const day = (n) => { const d = new Date(Date.now() + 7 * 3600e3); d.setUTCDate(d.getUTCDate() + 40 + n); return d.toISOString().slice(0, 10); };
      assert.equal((await call('POST', `/api/cases/${c.body.case_id}/visits/bulk`, { dates: [day(1), day(2), day(3), day(4)] }, MANAGER)).status, 201);
      assert.equal((await call('POST', `/api/cases/${c.body.case_id}/visits`, { visit_date: day(5) }, MANAGER)).status, 409);

      // ใบแจ้งหนี้: ยอดก่อนลด 24,000 ส่วนลด 4,000 · รายการบอกจำนวนแพ็ก
      const draft = (await call('GET', `/api/invoices?case_id=${c.body.case_id}`, null, MANAGER)).body.data.find((i) => i.status === 'draft');
      assert.equal(draft.amount, 24000);
      assert.equal(draft.discount, 4000);
      assert.match(draft.service_description, /× 2 แพ็ก \(รวม 4 ครั้ง\)/);

      // ลดเหลือแพ็กเดียว: ค่าจ้างตามแพ็กลดตาม · ประวัติบอกจำนวนแพ็ก
      const patched = await call('PATCH', `/api/cases/${c.body.case_id}`, { pkg_quantity: 1, fee: 10000 }, MANAGER);
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(Number(patched.body.staff_pay), 4000);
      assert.equal(Number(patched.body.service_list_price_snapshot), 12000);
      const events = (await call('GET', `/api/cases/${c.body.case_id}/events`, null, MANAGER)).body;
      assert.ok(events.some((e) => /จำนวนแพ็ก: 2 → 1/.test(e.detail ?? '')));
      // ใบร่างซิงก์ตาม: ยอดก่อนลด 12,000 ส่วนลด 2,000 · รายการไม่มี × แล้ว · ไม่ขึ้นป้ายแพ็คเกจไม่ตรง
      const synced = (await call('GET', `/api/invoices?case_id=${c.body.case_id}`, null, MANAGER)).body.data.find((i) => i.status === 'draft');
      assert.equal(synced.amount, 12000);
      assert.equal(synced.discount, 2000);
      assert.doesNotMatch(synced.service_description, /×/);
      assert.equal(synced.service_stale, false);

      // ใบที่ซิงก์ไม่ได้ (แบ่งมัดจำแล้ว) + แก้แค่จำนวนแพ็ก (ราคาเท่าเดิม) = ขึ้นป้ายแพ็คเกจไม่ตรง
      await call('POST', `/api/invoices/${synced.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 1000 }, MANAGER);
      assert.equal((await call('PATCH', `/api/cases/${c.body.case_id}`, { pkg_quantity: 2 }, MANAGER)).status, 200);
      const parts = (await call('GET', `/api/invoices?case_id=${c.body.case_id}`, null, MANAGER)).body.data.filter((i) => i.status !== 'cancelled');
      assert.ok(parts.length >= 1 && parts.every((i) => i.service_stale), 'ใบงวดต้องขึ้นแพ็คเกจไม่ตรงเมื่อจำนวนแพ็กเปลี่ยน');

      // ไม่ส่งจำนวนมา = 1 · เกินเพดาน = 400
      const one = await call('POST', '/api/cases', { case_type: 'other', client_name: 'Qty default', service_kind: 'physio', physio_package_id: pkgId }, MANAGER);
      assert.equal(one.body.pkg_quantity, 1);
      assert.equal(Number(one.body.staff_pay), 4000);
      assert.equal((await call('POST', '/api/cases', { case_type: 'other', client_name: 'Qty over', pkg_quantity: 25 }, MANAGER)).status, 400);

      // Homecare: เพดานวันของรูปแบบ × จำนวน
      const fmt = await call('POST', '/api/packages/formats', { name: 'ทดสอบรายสัปดาห์ qty', category: 'weekly', graded: false }, MANAGER);
      await call('PATCH', `/api/packages/formats/${fmt.body.format_id}`, { days: 2 }, MANAGER);
      const hc = await call('POST', '/api/cases', { case_type: 'other', client_name: 'Qty homecare', pkg_quantity: 2 }, MANAGER);
      await sql.run(`UPDATE cases SET assigned_to = 'EMP-0003', status = 'assigned', pkg_format_id = :f WHERE case_id = :id`,
        { id: hc.body.case_id, f: fmt.body.format_id });
      const hq = (await call('GET', `/api/cases/${hc.body.case_id}/physio-quota`, null, MANAGER)).body;
      assert.equal(hq.unit, 'วัน');
      assert.equal(hq.sessions, 4);
      assert.equal((await call('POST', `/api/cases/${hc.body.case_id}/visits/bulk`, { dates: [day(1), day(2), day(3), day(4)] }, MANAGER)).status, 201);
      assert.equal((await call('POST', `/api/cases/${hc.body.case_id}/visits`, { visit_date: day(5) }, MANAGER)).status, 409);
    });
  });

  /* ---------- การเงินของเคสที่ซื้อหลายแพ็ก (cases.pkg_quantity · 17 พ.ย. 2569) ----------
     ไล่ทุกจุดที่เงินไหลผ่าน: เปิดเคส (ราคา/ค่าจ้างคิดจากตาราง) · ใบแจ้งหนี้ (เต็ม/มัดจำ/รายครั้ง/รวมใบ) · รับเงิน
     ใบลดหนี้ · ปล่อยค่าจ้าง · แก้จำนวนหลังออกใบ/หลังปล่อยค่าจ้าง/หลังปิดเคส · แก้ราคาแพ็กทีหลัง · สิทธิ์ HR */
  describe('การเงิน: ซื้อหลายแพ็ก — เปิดเคส · ใบแจ้งหนี้ · รับเงิน · ค่าจ้าง', () => {
    async function send(method, path, body, who = MANAGER) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(who)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, body: data };
    }
    const ok = async (method, path, body, who = MANAGER, expected = 200) => {
      const r = await send(method, path, body, who);
      assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const openCase = (body, who = MANAGER) => ok('POST', '/api/cases', { case_type: 'other', ...body }, who, 201);
    const invoicesOf = async (caseId) =>
      (await ok('GET', `/api/invoices?case_id=${caseId}`)).data.filter((v) => v.status !== 'cancelled');
    const draftOf = async (caseId) => (await invoicesOf(caseId)).find((v) => v.status === 'draft');
    const invoice = (id) => ok('GET', `/api/invoices/${id}`);
    const pay = (id, body = {}) => ok('POST', `/api/invoices/${id}/pay`, { request_id: randomUUID(), ...body });
    const release = (caseId, amount, expected = 201) =>
      ok('POST', `/api/cases/${caseId}/pay/release`, { request_id: randomUUID(), amount }, MANAGER, expected);
    const physioPack = async (fields) => (await sql.one(
      `INSERT INTO physio_packages (name, sessions, duration_months, original_price, special_price, staff_pay, english_fee)
       VALUES (:name, :sessions, :months, :original, :special, :pay, :english) RETURNING physio_package_id`,
      { months: null, original: null, english: null, ...fields },
    )).physio_package_id;
    const money = (n) => Math.round(Number(n) * 100) / 100;

    let monthly; // รูปแบบรายเดือนทดสอบ + เรท CG 30,000 ลด 2,000 ค่าจ้าง 18,000
    before(async () => {
      const fmt = await ok('POST', '/api/packages/formats', { name: 'ทดสอบเงิน รายเดือน', category: 'monthly', graded: false }, MANAGER, 201);
      monthly = fmt.format_id;
      await sql.run(
        `INSERT INTO pkg_rates (format_id, grade_id, staff_tier, customer_price, discount_amount, staff_pay)
         VALUES (:f, NULL, 'CG', 30000, 2000, 18000)`,
        { f: monthly },
      );
    });

    test('Homecare รายเดือน × 2 ไม่กรอกราคา: ราคา/ส่วนลด/ค่าจ้างคิดจากเรท × 2 · เก็บเต็มจำนวน · ปล่อยค่าจ้างได้ไม่เกินยอดรวม', async () => {
      const c = await openCase({ client_name: 'Fin HC x2', service_kind: 'homecare', pkg_format_id: monthly, pkg_staff_tier: 'CG', pkg_quantity: 2 });
      assert.equal(c.pkg_quantity, 2);
      assert.equal(money(c.service_list_price_snapshot), 60000);
      assert.equal(money(c.service_customer_price_snapshot), 56000, '(30,000 − 2,000) × 2');
      assert.equal(money(c.staff_pay), 36000, 'ค่าจ้าง 18,000 × 2');

      const draft = await draftOf(c.case_id);
      assert.equal(draft.amount, 60000);
      assert.equal(draft.discount, 4000);
      assert.equal(draft.total, 56000);
      assert.match(draft.service_description, /CG · × 2 เดือน/);
      assert.equal(draft.fee_stale, false);

      await ok('POST', `/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await ok('POST', `/api/invoices/${draft.invoice_id}/issue`, {});
      await pay(draft.invoice_id, { amount: 56000 });
      assert.equal((await invoice(draft.invoice_id)).status, 'paid');

      await ok('POST', `/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id, force: true });
      await release(c.case_id, 20000);
      await release(c.case_id, 16000);
      assert.equal((await casesRepo.payStatus(c.case_id)).released, 36000);
      await release(c.case_id, 1, 400); // เกินยอดค่าจ้างรวมของสองเดือน
    });

    test('ราคาต่อรองเอง: fee ที่ส่งมาไม่ถูกคูณซ้ำ · ส่วนลดบนใบ = ราคาเต็ม × 2 − ราคาที่ตกลง', async () => {
      const c = await openCase({ client_name: 'Fin HC deal', service_kind: 'homecare', pkg_format_id: monthly, pkg_staff_tier: 'CG',
        pkg_quantity: 2, fee: 50000, staff_pay: 30000 });
      assert.equal(money(c.fee), 50000);
      assert.equal(money(c.service_customer_price_snapshot), 50000);
      assert.equal(money(c.staff_pay), 30000, 'ค่าจ้างที่ผู้จัดการกรอกเองไม่ถูกคูณ');
      const draft = await draftOf(c.case_id);
      assert.equal(draft.amount, 60000);
      assert.equal(draft.discount, 10000);
      assert.equal(draft.total, 50000);
    });

    test('แพ็กกายภาพ × 2 พร้อมค่าภาษาอังกฤษ: ค่าภาษาคิดต่อแพ็ก · ราคาเต็ม/ราคาขายรวมค่าภาษา × 2', async () => {
      const pkg = await physioPack({ name: 'Fin EN pack', sessions: 5, original: 12000, special: 10000, pay: 4000, english: 500 });
      const c = await openCase({ client_name: 'Fin EN', service_kind: 'physio', physio_package_id: pkg, pkg_english: true, pkg_quantity: 2 });
      assert.equal(money(c.service_list_price_snapshot), 25000, '(12,000 + 500) × 2');
      assert.equal(money(c.service_customer_price_snapshot), 21000, '(10,000 + 500) × 2');
      assert.equal(money(c.staff_pay), 8000);
      const draft = await draftOf(c.case_id);
      assert.equal(draft.total, 21000);
      assert.equal(draft.discount, 4000);
      assert.match(draft.service_description, /× 2 แพ็ก \(รวม 10 ครั้ง\) · ภาษาอังกฤษ/);
    });

    test('แบ่งมัดจำแล้วแก้จำนวนแพ็ก: ใบงวดไม่ถูกแก้ยอดเอง แต่ขึ้นป้ายยอดไม่ตรง + แพ็คเกจไม่ตรง', async () => {
      const c = await openCase({ client_name: 'Fin deposit', service_kind: 'homecare', pkg_format_id: monthly, pkg_staff_tier: 'CG',
        pkg_quantity: 3, fee: 84000 });
      const draft = await draftOf(c.case_id);
      await ok('POST', `/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 20000 });
      const plan = await invoicesOf(c.case_id);
      const deposit = plan.find((v) => v.billing_kind === 'deposit');
      const balance = plan.find((v) => v.billing_kind === 'balance');
      assert.equal(deposit.total + balance.total, 84000);
      await pay(deposit.invoice_id, { amount: 20000 });

      // ลูกค้าขอเพิ่มเป็น 4 เดือน
      await ok('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 4, fee: 112000 });
      const after = await invoicesOf(c.case_id);
      const dep2 = after.find((v) => v.invoice_id === deposit.invoice_id);
      const bal2 = after.find((v) => v.invoice_id === balance.invoice_id);
      assert.equal(dep2.total, deposit.total, 'ใบมัดจำที่รับเงินแล้วไม่ถูกแก้ยอด');
      assert.equal(bal2.total, balance.total, 'ใบงวดไม่ซิงก์ตามเคสเอง');
      for (const v of [dep2, bal2]) {
        assert.equal(v.fee_stale, true, `${v.billing_kind}: ยอดทั้งแผนไม่ตรงกับเคสแล้ว`);
        assert.equal(v.service_stale, true, `${v.billing_kind}: จำนวนแพ็กเปลี่ยนหลังออกใบ`);
      }
    });

    test('ใบชำระแล้ว + แก้แค่จำนวนแพ็ก (ราคาเท่าเดิม = แถมเดือน): ป้ายแพ็คเกจไม่ตรงขึ้น · รับทราบแล้วหาย · ยอดเงินไม่ขยับ', async () => {
      const c = await openCase({ client_name: 'Fin free month', service_kind: 'homecare', pkg_format_id: monthly, pkg_staff_tier: 'CG',
        pkg_quantity: 1, fee: 28000 });
      const draft = await draftOf(c.case_id);
      await ok('POST', `/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await pay(draft.invoice_id, { amount: 28000 });

      await ok('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 2, fee: 28000 });
      let v = await invoice(draft.invoice_id);
      assert.equal(v.status, 'paid');
      assert.equal(v.total, 28000);
      assert.equal(v.fee_stale, false, 'ยอดเงินยังตรงกับเคส');
      assert.equal(v.service_stale, true);
      await ok('POST', `/api/invoices/${draft.invoice_id}/acknowledge-service`, {});
      v = await invoice(draft.invoice_id);
      assert.equal(v.service_stale, false);
    });

    test('ลูกค้ายกเลิกหนึ่งในสองแพ็กหลังจ่ายแล้ว: ลดหนี้ครึ่งหนึ่งพร้อมคืนเงิน · ยอดสุทธิของใบลดตาม', async () => {
      const pkg = await physioPack({ name: 'Fin refund pack', sessions: 4, special: 8000, pay: 3000 });
      const c = await openCase({ client_name: 'Fin refund', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 2, fee: 16000 });
      const draft = await draftOf(c.case_id);
      await ok('POST', `/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await ok('POST', `/api/invoices/${draft.invoice_id}/issue`, {});
      await pay(draft.invoice_id, { amount: 16000 });
      await ok('POST', `/api/invoices/${draft.invoice_id}/adjustments`, {
        kind: 'credit', amount: 8000, reason: 'ยกเลิกแพ็กที่สอง', refund: { method: 'โอนคืน' },
      }, MANAGER, 201);
      const v = await invoice(draft.invoice_id);
      assert.equal(v.net_total, 8000);

      // ลดเหลือแพ็กเดียวในเคส: ค่าจ้างตามแพ็กลดเป็น 3,000 · โควตาเหลือ 4 ครั้ง
      const patched = await ok('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 1, fee: 8000 });
      assert.equal(money(patched.staff_pay), 3000);
      assert.equal((await ok('GET', `/api/cases/${c.case_id}/physio-quota`)).sessions, 4);
    });

    test('ปล่อยค่าจ้างไปแล้ว: ลดจำนวนแพ็กจนค่าจ้างต่ำกว่ายอดที่ปล่อย = ไม่ได้ · เคสปิดแล้วแก้จำนวนไม่ได้', async () => {
      const pkg = await physioPack({ name: 'Fin paid pack', sessions: 4, special: 8000, pay: 3000 });
      const c = await openCase({ client_name: 'Fin released', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 2, fee: 16000 });
      assert.equal(money(c.staff_pay), 6000);
      await ok('POST', `/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id, force: true });
      await release(c.case_id, 4000);

      const refused = await send('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 1, fee: 8000 });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /ต่ำกว่ายอดที่ปล่อยไปแล้ว/);
      const still = await casesRepo.findById(c.case_id);
      assert.equal(still.pkg_quantity, 2, 'ถูกปฏิเสธทั้งคำขอ จำนวนแพ็กไม่เปลี่ยน');
      assert.equal(money(still.fee), 16000);

      // ระบุค่าจ้างเองให้ไม่ต่ำกว่าที่ปล่อย = ลดได้
      const reduced = await ok('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 1, fee: 8000, staff_pay: 4000 });
      assert.equal(reduced.pkg_quantity, 1);
      assert.equal(money(reduced.staff_pay), 4000);

      await ok('POST', `/api/cases/${c.case_id}/close`, {});
      const locked = await send('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 2 });
      assert.equal(locked.status, 409);
      assert.match(locked.body.error, /จำนวนแพ็ก/);
      // ฟอร์มเต็มที่ส่งจำนวนเดิมกลับมา (แก้แค่หมายเหตุ) ยังผ่าน
      await ok('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 1, note: 'หลังปิด' });
    });

    test('ค่าจ้างพิเศษของผู้จัดการ: HR แก้หมายเหตุไม่แตะ · HR แก้จำนวนแพ็ก = คิดใหม่ตามแพ็ก × จำนวน (กติกาเดียวกับเปลี่ยนแพ็ก)', async () => {
      const pkg = await physioPack({ name: 'Fin HR pack', sessions: 4, special: 8000, pay: 3000 });
      const c = await openCase({ client_name: 'Fin HR', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 2, fee: 16000, staff_pay: 7000 });
      assert.equal(money(c.staff_pay), 7000);
      await ok('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 2, note: 'HR แก้หมายเหตุ' }, HR);
      assert.equal(money((await casesRepo.findById(c.case_id)).staff_pay), 7000, 'จำนวนเท่าเดิม = ค่าจ้างพิเศษคงอยู่');
      const hrView = await ok('PATCH', `/api/cases/${c.case_id}`, { pkg_quantity: 3, fee: 24000 }, HR);
      assert.equal(hrView.staff_pay, undefined, 'HR ไม่เห็นค่าจ้าง');
      assert.equal(money((await casesRepo.findById(c.case_id)).staff_pay), 9000, '3,000 × 3');
    });

    test('ใบรายครั้ง (แตกตามกะ) ของแพ็ก × 2: ราคาต่อครั้ง = ยอดรวม ÷ นัดทั้งหมด · สองใบรวมกันเท่ายอดเคสพอดี', async () => {
      const pkg = await physioPack({ name: 'Fin visits pack', sessions: 3, special: 6000, pay: 2000 });
      const c = await openCase({ client_name: 'Fin visits', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 2, fee: 12000 });
      const draft = await draftOf(c.case_id);
      assert.equal((await send('DELETE', `/api/invoices/${draft.invoice_id}`)).status, 200);
      const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'];
      for (const d of days) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, 'done', (:d || ' 09:00:00+07')::timestamptz, (:d || ' 10:00:00+07')::timestamptz)`,
          { id: c.case_id, d },
        );
      }
      const first = await ok('POST', '/api/invoices', { case_id: c.case_id, basis: 'visits', to: '2026-03-03' }, MANAGER, 201);
      assert.equal(first.items.length, 2);
      assert.equal(first.items[0].unit_price, 2000, '12,000 ÷ 6 นัด');
      assert.equal(first.total, 4000);
      await ok('POST', `/api/invoices/${first.invoice_id}/billing-plan`, { mode: 'full' });
      await ok('POST', `/api/invoices/${first.invoice_id}/issue`, {});
      const rest = await ok('POST', '/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(rest.items.length, 4);
      assert.equal(first.total + rest.total, 12000);
    });

    test('แพ็กกายภาพ × 2 รวมในใบ Homecare: บรรทัดในใบเป็นราคารวมสองแพ็ก พร้อมบอกจำนวน · ยอดใบ = Homecare + กายภาพ', async () => {
      await ok('POST', '/api/patients', { patient_id: 'KN690399101', name: 'การเงินรวมใบ' }, MANAGER, 201);
      const me = { patient_id: 'KN690399101', client_name: 'การเงินรวมใบ' };
      const pkg = await physioPack({ name: 'คอร์สเสริม', sessions: 5, special: 9000, pay: 3000 });
      const home = await openCase({ ...me, service_kind: 'homecare', fee: 30000 });
      const addon = await openCase({ ...me, physio_package_id: pkg, pkg_quantity: 2, fee: 18000, addon_of: home.case_id, bill_with_parent: true });
      assert.equal(money(addon.staff_pay), 6000);
      const draft = await draftOf(home.case_id);
      assert.equal(draft.total, 48000);
      const line = draft.addons.find((a) => a.ref === addon.case_id);
      assert.equal(line.unit_price, 18000);
      assert.match(line.name, /คอร์สเสริม · 5 ครั้ง × 2 แพ็ก \(รวม 10 ครั้ง\)/);
      assert.equal(draft.fee_stale, false);

      // ลดแพ็กเสริมเหลือหนึ่ง → ใบร่างของ Homecare ตาม
      await ok('PATCH', `/api/cases/${addon.case_id}`, { pkg_quantity: 1, fee: 9000 });
      const after = await draftOf(home.case_id);
      assert.equal(after.total, 39000);
      assert.doesNotMatch(after.addons.find((a) => a.ref === addon.case_id).name, /×/);
    });

    test('แก้ราคาแพ็กทีหลัง: เคสหลายแพ็กที่ขายราคาตามแพ็กปรับราคาเต็ม × จำนวน · ยอดที่ลูกค้าจ่ายเท่าเดิม · เคสต่อรองราคาไม่แตะ', async () => {
      const pkg = await physioPack({ name: 'Fin reprice', sessions: 4, original: 12000, special: 10000, pay: 3000 });
      const same = await openCase({ client_name: 'Fin reprice same', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 2, fee: 20000 });
      const deal = await openCase({ client_name: 'Fin reprice deal', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 2, fee: 19000 });
      assert.equal((await draftOf(same.case_id)).discount, 4000);

      // เลิกโปร: ราคาเต็ม 10,000 = ราคาขาย
      await ok('PATCH', `/api/physio/packages/${pkg}`, { original_price: 10000, special_price: 10000, discount_amount: null, discount_percent: null });
      const s = await casesRepo.findById(same.case_id);
      assert.equal(money(s.service_list_price_snapshot), 20000, '10,000 × 2');
      assert.equal(money(s.service_customer_price_snapshot), 20000);
      const sd = await draftOf(same.case_id);
      assert.equal(sd.total, 20000);
      assert.equal(sd.discount, 0, 'ไม่มีส่วนลดค้างจากโปรเก่า');
      const d = await casesRepo.findById(deal.case_id);
      assert.equal(money(d.service_list_price_snapshot), 24000, 'เคสราคาต่อรองคงราคาเต็มเดิม');
    });

    test('ต่อเคสรอบใหม่แบบหลายแพ็ก: รอบใหม่คิดเงิน/โควตาของตัวเอง ไม่ปนรอบก่อน', async () => {
      const pkg = await physioPack({ name: 'Fin renew', sessions: 4, special: 8000, pay: 3000 });
      const r1 = await openCase({ client_name: 'Fin renew', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 1, fee: 8000 });
      const r2 = await openCase({ client_name: 'Fin renew', service_kind: 'physio', physio_package_id: pkg, pkg_quantity: 3, fee: 24000, renewed_from: r1.case_id });
      assert.equal(r2.round_no, 2);
      assert.equal(money(r2.staff_pay), 9000);
      assert.equal((await draftOf(r2.case_id)).total, 24000);
      assert.equal((await draftOf(r1.case_id)).total, 8000);
      assert.equal((await ok('GET', `/api/cases/${r2.case_id}/physio-quota`)).sessions, 12);
      assert.equal((await ok('GET', `/api/cases/${r1.case_id}/physio-quota`)).sessions, 4);
    });

    /* ---------- เคสที่เข้าระบบกลางทาง (ยอดยกมา · 19 พ.ย. 2569) ---------- */

    test('กลางทาง กายภาพ: แพ็กปิดขายแล้วเลือกได้ · ใช้ไป 5/10 ลงได้อีก 5 · จ่ายครบนอกระบบ = ไม่มีใบ · ค่าจ้างนอกระบบหักจากที่ปล่อยได้', async () => {
      const pkg = await physioPack({ name: 'Fin legacy 10', sessions: 10, months: 3, special: 15000, pay: 6000 });
      await sql.run('UPDATE physio_packages SET active = FALSE WHERE physio_package_id = :id', { id: pkg });
      // เคสปกติยังใช้แพ็กปิดขายไม่ได้
      assert.equal((await send('POST', '/api/cases', { case_type: 'other', client_name: 'Fin legacy no', service_kind: 'physio', physio_package_id: pkg, fee: 15000 })).status, 409);

      const c = await openCase({ client_name: 'Fin legacy', service_kind: 'physio', physio_package_id: pkg, fee: 15000,
        start_date: '2026-10-01', joined_midway: true, carried_used: 5, carried_paid: 15000, carried_staff_paid: 3000 });
      assert.equal(c.joined_midway, true);
      assert.equal(c.carried_used, 5);
      assert.equal(money(c.carried_paid), 15000);
      assert.equal(money(c.staff_pay), 6000);

      const quota = await ok('GET', `/api/cases/${c.case_id}/physio-quota`);
      assert.equal(quota.sessions, 10);
      assert.equal(quota.carried, 5);
      assert.equal(quota.booked, 5);
      assert.equal(quota.attended, 5);
      assert.equal(quota.remaining, 5);
      assert.equal(quota.starts_on, '2026-10-01');

      // จ่ายครบนอกระบบ: ไม่มีใบร่าง · ไม่ขึ้นใน "เคสที่ยังไม่มีใบ"
      assert.deepEqual(await invoicesOf(c.case_id), []);
      const missing = await ok('GET', '/api/invoices/cases-without-invoice');
      assert.ok(!missing.some((x) => x.case_id === c.case_id));

      await ok('POST', `/api/cases/${c.case_id}/assign`, { employee_id: FIELD.employee_id, force: true });
      const day = (n) => { const d = new Date(Date.now() + 7 * 3600e3); d.setUTCDate(d.getUTCDate() + 60 + n); return d.toISOString().slice(0, 10); };
      assert.equal((await send('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [1, 2, 3, 4, 5, 6].map(day) })).status, 409, 'เหลือ 5 ครั้ง ลง 6 ไม่ได้');
      assert.equal((await send('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [1, 2, 3, 4, 5].map(day) })).status, 201);

      // ค่าจ้าง 6,000 จ่ายนอกระบบแล้ว 3,000 → ปล่อยในระบบได้อีก 3,000
      const pay = await ok('GET', `/api/cases/${c.case_id}/pay`);
      assert.equal(pay.paid_outside, 3000);
      assert.equal(pay.remaining, 3000);
      await release(c.case_id, 3001, 400);
      await release(c.case_id, 3000);
      await release(c.case_id, 1, 400);
      assert.equal((await casesRepo.payStatus(c.case_id)).released, 3000, 'ระบบปล่อยจริงแค่ส่วนที่เหลือ (ยอดนอกระบบไม่เป็นรายการปล่อย)');

      // ลดค่าจ้างต่ำกว่า ปล่อยแล้ว + จ่ายนอกระบบ ไม่ได้
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}`, { staff_pay: 5000 })).status, 409);

      const events = await ok('GET', `/api/cases/${c.case_id}/events`);
      const log = events.find((e) => /เข้าระบบกลางทาง/.test(e.detail ?? ''));
      assert.ok(log);
      assert.match(log.detail, /ใช้ไปแล้ว 5 \/ 10 ครั้ง/);
      assert.doesNotMatch(log.detail, /3,000/, 'ตัวเลขค่าจ้างไม่ลงประวัติที่ HR อ่านได้');

      // ปิดเคส (ยืนยันทิ้งนัดข้างหน้า): ไม่ขึ้นเป็น "ปิดแล้วไม่มีใบ"
      await ok('POST', `/api/cases/${c.case_id}/close`, { force: true });
      const closedNoInv = await ok('GET', '/api/cases?closed_no_invoice=yes&per_page=100');
      assert.ok(!(closedNoInv.data ?? closedNoInv).some((x) => x.case_id === c.case_id));
      // เคสปิดแล้วแก้ยอดยกมาไม่ได้
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}`, { carried_used: 4 })).status, 409);
    });

    test('กลางทาง Homecare: ชำระบางส่วน = ใบเก็บเฉพาะส่วนที่เหลือ พร้อมบอกที่มา · ไม่ขึ้นส่วนลด · โควตาวันนับยอดยกมา', async () => {
      const c = await openCase({ client_name: 'Fin HC midway', service_kind: 'homecare', pkg_format_id: monthly, pkg_staff_tier: 'CG',
        fee: 28000, start_date: '2026-11-08', joined_midway: true, carried_used: 10, carried_paid: 10000 });
      const draft = await draftOf(c.case_id);
      assert.equal(draft.total, 18000);
      assert.equal(draft.discount, 0, 'ส่วนต่างคือเงินที่จ่ายแล้ว ไม่ใช่ส่วนลด');
      assert.match(draft.service_description, /ชำระแล้วก่อนเข้าระบบ 10,000 บาท จากราคา 28,000 บาท/);
      assert.equal(draft.fee_stale, false);
      await ok('POST', `/api/invoices/${draft.invoice_id}/billing-plan`, { mode: 'full' });
      await pay(draft.invoice_id, { amount: 18000 });
      assert.equal((await invoice(draft.invoice_id)).status, 'paid');

      const q = await ok('GET', `/api/cases/${c.case_id}/physio-quota`);
      assert.equal(q.unit, 'วัน');
      assert.equal(q.sessions, 30);
      assert.equal(q.carried, 10);
      assert.equal(q.remaining, 20);
    });

    test('กลางทาง: ยอดยกมาเกินของที่ซื้อไม่ได้ · ไม่ติ๊กกลางทาง = ยอดยกมาถูกล้าง · เอาติ๊กออกทีหลัง = ล้างและโควตากลับเต็ม', async () => {
      const pkg = await physioPack({ name: 'Fin guard', sessions: 4, special: 8000, pay: 3000 });
      const base = { case_type: 'other', service_kind: 'physio', physio_package_id: pkg, fee: 8000, joined_midway: true };
      const bad = async (body, field) => {
        const r = await send('POST', '/api/cases', { ...base, client_name: `Fin guard ${field}`, ...body });
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body.details?.[0]?.field, field);
      };
      await bad({ carried_used: 5 }, 'carried_used');
      await bad({ carried_paid: 8001 }, 'carried_paid');
      await bad({ carried_staff_paid: 3001 }, 'carried_staff_paid');
      // × 2 แพ็ก = เพดาน 8 ครั้ง
      await openCase({ ...base, client_name: 'Fin guard qty', pkg_quantity: 2, fee: 16000, carried_used: 6 });

      const plain = await openCase({ client_name: 'Fin guard plain', service_kind: 'physio', physio_package_id: pkg, fee: 8000,
        carried_used: 3, carried_paid: 8000 });
      assert.equal(plain.joined_midway, false);
      assert.equal(plain.carried_used, 0);
      assert.equal(money(plain.carried_paid), 0);
      assert.equal((await draftOf(plain.case_id)).total, 8000);

      const mid = await openCase({ ...base, client_name: 'Fin guard undo', carried_used: 3, carried_paid: 2000 });
      assert.equal((await draftOf(mid.case_id)).total, 6000);
      const undone = await ok('PATCH', `/api/cases/${mid.case_id}`, { joined_midway: false });
      assert.equal(undone.joined_midway, false);
      assert.equal(undone.carried_used, 0);
      assert.equal(money(undone.carried_paid), 0);
      assert.equal((await ok('GET', `/api/cases/${mid.case_id}/physio-quota`)).remaining, 4);
      assert.equal((await draftOf(mid.case_id)).total, 8000, 'ใบร่างซิงก์กลับเต็มราคา');
      const events = await ok('GET', `/api/cases/${mid.case_id}/events`);
      assert.ok(events.some((e) => /ยกเลิกการเป็นเคสกลางทาง/.test(e.detail ?? '')));
    });

    test('กลางทาง: HR ไม่เห็นและตั้งค่าจ้างนอกระบบไม่ได้ · แก้ยอดอื่นได้และค่าจ้างนอกระบบเดิมคงอยู่', async () => {
      const pkg = await physioPack({ name: 'Fin HR midway', sessions: 10, special: 15000, pay: 6000 });
      const c = await openCase({ client_name: 'Fin HR midway', service_kind: 'physio', physio_package_id: pkg, fee: 15000,
        joined_midway: true, carried_used: 2, carried_paid: 5000, carried_staff_paid: 1000 });
      const hrView = await ok('GET', `/api/cases/${c.case_id}`, undefined, HR);
      assert.equal(hrView.carried_staff_paid, undefined);
      assert.equal(hrView.carried_used, 2);
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}`, { carried_staff_paid: 0 }, HR)).status, 403);
      await ok('PATCH', `/api/cases/${c.case_id}`, { joined_midway: true, carried_used: 3, carried_paid: 6000 }, HR);
      const after = await casesRepo.findById(c.case_id);
      assert.equal(after.carried_used, 3);
      assert.equal(money(after.carried_paid), 6000);
      assert.equal(money(after.carried_staff_paid), 1000);
    });

    test('กลางทาง: ใบรายครั้ง — ราคาต่อครั้งหารรวมครั้งที่ยกมา · ยอดค้างหักที่จ่ายแล้วนอกระบบ', async () => {
      const pkg = await physioPack({ name: 'Fin midway visits', sessions: 8, special: 8000, pay: 3000 });
      const c = await openCase({ client_name: 'Fin midway visits', service_kind: 'physio', physio_package_id: pkg, fee: 8000,
        joined_midway: true, carried_used: 4, carried_paid: 4000 });
      const draft = await draftOf(c.case_id);
      assert.equal(draft.total, 4000);
      assert.equal((await send('DELETE', `/api/invoices/${draft.invoice_id}`)).status, 200);
      for (const d of ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04']) {
        await sql.run(
          `INSERT INTO case_visits (case_id, visit_date, status, check_in_at, check_out_at)
           VALUES (:id, :d, 'done', (:d || ' 09:00:00+07')::timestamptz, (:d || ' 10:00:00+07')::timestamptz)`,
          { id: c.case_id, d },
        );
      }
      const first = await ok('POST', '/api/invoices', { case_id: c.case_id, basis: 'visits', to: '2026-04-02' }, MANAGER, 201);
      assert.equal(first.items[0].unit_price, 1000, '8,000 ÷ (4 นัดในระบบ + 4 ครั้งที่ยกมา)');
      assert.equal(first.total, 2000);
      await ok('POST', `/api/invoices/${first.invoice_id}/billing-plan`, { mode: 'full' });
      await ok('POST', `/api/invoices/${first.invoice_id}/issue`, {});
      const rest = await ok('POST', '/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(rest.total, 2000, 'ยอดค้าง = 8,000 − 4,000 (จ่ายนอกระบบ) − 2,000 (ใบแรก)');
    });
  });
}
