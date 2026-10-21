import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

    test('token บอกว่าเป็น manager แต่ DB บอกว่าเป็นพนักงานภาคสนาม = ยึดตาม DB (403)', async () => {
      assert.equal((await get('/api/cases', { ...FIELD, position: 'manager' })).status, 403);
    });

    test('บัญชีที่ใช้งานได้ เข้าได้ปกติ', async () => {
      assert.equal((await get('/api/cases', MANAGER)).status, 200);
      assert.equal((await get('/api/cases', HR)).status, 200);
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


  /* รหัสเคสเป็นเลขที่เจ้าหน้าที่กรอก (VN…) — เทสที่เปิดเคสโดยไม่ได้สนใจรหัส ได้รหัสไม่ซ้ำไปอัตโนมัติ
     เทสที่ส่ง case_id มาเอง (ตรวจรูปแบบ/ซ้ำ) ใช้ค่าที่ส่งมาตามเดิม */
  let vnSeq = 0;
  const nextVN = () => `VN69${String(++vnSeq).padStart(7, '0')}`;

  async function post(path, body, who = MANAGER, expected = 200) {
    if (path === '/api/cases' && body && !('case_id' in body)) body = { case_id: nextVN(), ...body };
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
      assert.deepEqual(me.permissions, ['billing', 'money']);
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

    test('รหัสผ่านชั่วคราวของบัญชีผู้จัดการ/การเงิน HR และ Admin HC มองไม่เห็น — ผู้จัดการเห็น', async () => {
      const fin = await post('/api/employees', { first_name: 'Temp', last_name: 'Finance', position: 'finance' }, MANAGER, 201);
      assert.ok(fin.temp_password);
      assert.equal((await get(`/api/employees/${fin.employee_id}`, HR)).body.temp_password, undefined);
      assert.equal((await get(`/api/employees/${fin.employee_id}`, HC)).body.temp_password, undefined);
      assert.equal((await get(`/api/employees/${fin.employee_id}`, MANAGER)).body.temp_password, fin.temp_password);
      // บัญชีทั่วไป HR ยังเห็นเหมือนเดิม (ไว้บอกพนักงานใหม่)
      const cg = await post('/api/employees', { first_name: 'Temp', last_name: 'Carer', position: 'caregiver' }, MANAGER, 201);
      assert.equal((await get(`/api/employees/${cg.employee_id}`, HR)).body.temp_password, cg.temp_password);
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
    test('temporary password is visible only to office roles and erased after password change', async () => {
      const created = await post('/api/employees', { first_name: 'Temporary', last_name: 'Employee', position: 'caregiver' }, MANAGER, 201);
      const id = created.employee_id;
      assert.ok(created.temp_password);
      const stored = await sql.one('SELECT temp_password_encrypted FROM employees WHERE employee_id = :id', { id });
      assert.ok(stored.temp_password_encrypted);
      assert.notEqual(stored.temp_password_encrypted, created.temp_password);
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
      await post('/api/auth/change-password', {
        current_password: created.temp_password, new_password: 'Changed-password-456!',
      }, emp(id, 'caregiver'));
      const detail = (await get(`/api/employees/${id}`, MANAGER)).body;
      assert.equal(detail.must_change_password, false);
      assert.equal('temp_password' in detail, false);
      assert.equal((await sql.one('SELECT temp_password_encrypted FROM employees WHERE employee_id = :id', { id })).temp_password_encrypted, null);
    });
    test('fresh employee must change password; suspended employee cannot access work', async () => {
      const fresh = await get('/api/my/today', emp('EMP-0004', 'caregiver'));
      assert.equal(fresh.status, 403);
      assert.match(fresh.body.error, /รหัสผ่าน/);
      assert.equal((await get('/api/my/today', emp('EMP-0005', 'caregiver'))).status, 401);
    });
    test('login succeeds with fixture credentials, wrong password returns 401', async () => {
      await post('/api/auth/login', { email: 'EMP-0001@example.invalid', password: 'wrong' }, MANAGER, 401);
      const user = await post('/api/auth/login', { email: 'EMP-0001@example.invalid', password: 'Fixture-password-123!' });
      assert.equal(user.employee_id, MANAGER.employee_id);
    });
    test('employee ID is a temporary username only while email is missing', async () => {
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
        await post('/api/auth/login', { email: FIELD.employee_id, password }, MANAGER, 401);
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

    test('รหัสเคส VN: กรอกเอง · ตรวจซ้ำ · เปลี่ยนรหัสเคสเดิมแล้วกะ/ใบแจ้งหนี้/ประวัติตามไป', async () => {
      const patch = async (path, body) => {
        const res = await fetch(`${base}${path}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };
      const c = await post('/api/cases', { case_id: 'VN690215209', client_name: 'รหัสเคส VN', fee: 1000 }, MANAGER, 201);
      assert.equal(c.case_id, 'VN690215209');
      const dup = await post('/api/cases', { case_id: 'VN690215209', client_name: 'ซ้ำ' }, MANAGER, 409);
      assert.match(dup.error, /มีอยู่แล้ว/);
      assert.ok(dup.details.some((d) => d.field === 'case_id'));
      await post('/api/cases', { case_id: 'CASE-9999', client_name: 'รูปแบบเก่า' }, MANAGER, 400);

      assert.deepEqual((await get('/api/cases/check-id?id=VN690215209', MANAGER)).body, { valid: true, available: false, taken_by: 'รหัสเคส VN' });
      assert.equal((await get('/api/cases/check-id?id=VN690215209&except=VN690215209', MANAGER)).body.available, true);
      assert.equal((await get('/api/cases/check-id?id=VN699999999', MANAGER)).body.available, true);
      assert.equal((await get('/api/cases/check-id?id=CASE-1', MANAGER)).body.valid, false);

      // เคสเก่าแบบ CASE-FIXTURE (มีกะและใบแจ้งหนี้ผูกอยู่) → เปลี่ยนเป็น VN แล้วทุกอย่างตามไป
      await post('/api/invoices', { case_id: 'CASE-FIXTURE' }, MANAGER, 201).catch(() => {});
      const before = (await get('/api/invoices?case_id=CASE-FIXTURE', MANAGER)).body.pagination.total;
      const renamed = await patch('/api/cases/CASE-FIXTURE', { case_id: 'VN680000001' });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(renamed.body.case_id, 'VN680000001');
      assert.equal((await get('/api/cases/CASE-FIXTURE', MANAGER)).status, 404);
      assert.ok((await get('/api/cases/VN680000001/visits', MANAGER)).body.length >= 1, 'กะตามไป');
      assert.equal((await get('/api/invoices?case_id=VN680000001', MANAGER)).body.pagination.total, before, 'ใบแจ้งหนี้ตามไป');
      const events = (await get('/api/cases/VN680000001/events', MANAGER)).body;
      assert.ok(events.some((e) => /เปลี่ยนรหัสเคส CASE-FIXTURE → VN680000001/.test(e.detail)));

      // ชนรหัสเคสอื่นไม่ได้
      assert.equal((await patch('/api/cases/VN680000001', { case_id: 'VN690215209' })).status, 409);
      // คืนรหัสเดิมให้เทสอื่นที่อ้าง CASE-FIXTURE
      await sql.run(`UPDATE cases SET case_id = 'CASE-FIXTURE' WHERE case_id = 'VN680000001'`);
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

    test('รายการในใบ: ไม่ซ้ำชื่อผู้ป่วยเมื่อหัวรายการเป็นชื่อผู้ป่วยอยู่แล้ว', async () => {
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

    test('เปิดเคสด้วยผู้ว่าจ้างอย่างเดียว (ยังไม่รู้ชื่อผู้ป่วย) ได้ — ไม่มีทั้งคู่ไม่ได้', async () => {
      const customer = await post('/api/customers', { name: 'ญาติโทรมาจอง', phone: '0812345678' }, MANAGER, 201);
      const c = await post('/api/cases', { case_type: 'other', customer_id: customer.customer_id, fee: 1500 }, MANAGER, 201);
      assert.equal(c.client_name, 'ยังไม่ระบุผู้ป่วย');
      assert.equal(c.patient_id, null);
      assert.equal(c.customer_id, customer.customer_id);

      const [draft] = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
      assert.equal(draft.bill_to_name, 'ญาติโทรมาจอง');
      assert.equal(draft.total, 1500);
      assert.doesNotMatch(draft.service_description, /ยังไม่ระบุผู้ป่วย/, 'ห้ามพิมพ์คำแทนชื่อลงใบที่ส่งลูกค้า');
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
      assert.equal((await res.json()).client_name, 'ยังไม่ระบุผู้ป่วย');

      const bad = await post('/api/cases', { case_type: 'other', fee: 1500 }, MANAGER, 400);
      assert.ok(bad.details.some((d) => d.field === 'client_name'));
    });

    test('รหัสผู้ป่วย KN: ต้องกรอกตอนสร้าง · รูปแบบผิด/ซ้ำถูกปฏิเสธ · เปลี่ยนรหัสเดิมแล้วเคสตาม', async () => {
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
      const p = await post('/api/patients', { patient_id: 'KN691111111', name: 'ผู้ป่วย KN' }, MANAGER, 201);
      assert.equal(p.patient_id, 'KN691111111');
      const dup = await post('/api/patients', { patient_id: 'KN691111111', name: 'ชื่ออื่น' }, MANAGER, 409);
      // ความสัมพันธ์ของผู้ว่าจ้างกับผู้ป่วย — คอลัมน์ใหม่ บันทึกและอ่านกลับได้
      const rel = await patch('/api/patients/KN691111111', { employer_relation: 'บุตร' });
      assert.equal(rel.body.employer_relation, 'บุตร');
      // ตรวจซ้ำระหว่างกรอก (ฟอร์มผู้ป่วย / เปิดเคส)
      assert.deepEqual((await get('/api/patients/check-id?id=KN691111111', MANAGER)).body, { valid: true, available: false, taken_by: 'ผู้ป่วย KN' });
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
      assert.equal((await get(`/api/cases/${c.case_id}`, MANAGER)).body.patient_id, 'KN680000001');
      // หัวใบแจ้งหนี้ของเคสนี้ขึ้นรหัส/ชื่อผู้ป่วย (ตามรหัสใหม่ด้วย)
      const [caseInvoice] = (await get(`/api/invoices?case_id=${c.case_id}`, MANAGER)).body.data;
      assert.equal(caseInvoice.patient_id, 'KN680000001');
      assert.equal(caseInvoice.patient_name, 'แฟ้มเก่า');
      assert.equal((await get('/api/patients/PAT-0901', MANAGER)).status, 404);

      // เปลี่ยนไปชนรหัสของคนอื่นไม่ได้
      assert.equal((await patch('/api/patients/KN680000001', { patient_id: 'KN691111111' })).status, 409);
      // แก้ช่องอื่นอย่างเดียว รหัสไม่ขยับ
      assert.equal((await patch('/api/patients/KN691111111', { nickname: 'น้อย' })).body.patient_id, 'KN691111111');
    });

    test('ใส่ชื่อผู้ป่วยย้อนหลังในหน้าแก้เคส → สร้างแฟ้มผู้ป่วยและผูกกับเคส (ครั้งเดียว)', async () => {
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
      const customer = await post('/api/customers', { name: 'ลูกชายผู้ป่วย' }, MANAGER, 201);
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
      assert.equal((await get(`/api/cases/${c.case_id}`, MANAGER)).body.client_name, 'ยังไม่ระบุผู้ป่วย');

      const named = await patchCase(c.case_id, {
        client_name: 'เจโค', patient_gender: 'male', patient_age: 81, medical_history: 'เบาหวาน', address: 'บางนา',
        patient_code: 'KN690202463',
      });
      assert.equal(named.patient_id, 'KN690202463');
      const patient = await sql.one('SELECT * FROM patients WHERE patient_id = :id', { id: named.patient_id });
      assert.equal(patient.name, 'เจโค');
      assert.equal(patient.gender, 'male');
      assert.equal(patient.age, 81);
      assert.equal(patient.medical_history, 'เบาหวาน');
      assert.equal(patient.customer_id, customer.customer_id);

      const events = (await get(`/api/cases/${c.case_id}/events`, MANAGER)).body;
      assert.match(events.find((e) => e.event === 'edited').detail, new RegExp(`สร้างแฟ้มผู้ป่วย ${named.patient_id}`));

      // แก้ชื่ออีกรอบ = แก้ snapshot ในเคสเฉยๆ ไม่สร้างแฟ้มซ้ำ
      const renamed = await patchCase(c.case_id, { client_name: 'เจโค ใจดี' });
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
      assert.match(edited[0].detail, /อุปกรณ์เสริม: 3,741 บาท → 3,500 บาท/);

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

      // เพิ่มอุปกรณ์หลังแบ่งงวด → ใบงวดไม่ซิงก์ แต่ต้องขึ้นป้ายทั้งคู่ (ฝั่งแถวกับตัวกรอง SQL ต้องตรงกัน)
      await patchCase(c.case_id, { addons: [bed, gloves] });
      const after = await invoicesOf(c.case_id);
      assert.equal(after.find((v) => v.billing_kind === 'balance').total, 8500);
      assert.ok(after.every((v) => v.service_stale));
      assert.equal((await get(`/api/invoices?case_id=${c.case_id}&stale=yes`, MANAGER)).body.data.length, 2);
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
      await post(`/api/cases/${c.case_id}/pay/release`, { amount: 1200 }, HR, 403);
      await post(`/api/cases/${c.case_id}/pay/release`, { amount: 1200 }, MANAGER, 201);
      assert.equal((await casesRepo.payStatus(c.case_id)).released, 1200);
      await post(`/api/cases/${c.case_id}/pay/release`, { amount: 1 }, MANAGER, 400);
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
      await post(`/api/cases/${c.case_id}/pay/release`, { amount: 900 }, MANAGER, 201);
      const { month } = await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM') AS month`);
      const res = await get(`/api/payroll/employee-cases?month=${month}&employee_id=${FIELD.employee_id}`, MANAGER);
      assert.equal(res.status, 200);
      const row = res.body.find((r) => r.case_id === c.case_id);
      assert.ok(row, 'case with pay released this month must be listed');
      assert.equal(row.pay, 900);
      assert.equal(row.shifts, 0);
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

    test('แก้เคส: ซิงก์เฉพาะตอนราคา/ผู้จ่ายเปลี่ยน · ใบที่แก้มือไม่ถูกทับ · รีเฟรชเองทับและล้างธง · ผู้จ่ายจากแฟ้มผู้ป่วย', async () => {
      const customer = await post('/api/customers', { name: 'ผู้จ่ายจากแฟ้มผู้ป่วย' }, MANAGER, 201);
      await sql.run(
        `INSERT INTO patients (patient_id, name, status, customer_id) VALUES ('KN690000951', 'ผู้ป่วยซิงก์', 'active', :cu)`,
        { cu: customer.customer_id },
      );
      const c = await post('/api/cases', { case_type: 'other', client_name: 'ผู้ป่วยซิงก์', patient_id: 'KN690000951', fee: 3000 }, MANAGER, 201);
      // เคสไม่มีผู้ว่าจ้างของตัวเอง — ผู้จ่ายต้องไล่ไปที่แฟ้มผู้ป่วย
      await sql.run('UPDATE cases SET customer_id = NULL WHERE case_id = :id', { id: c.case_id });

      // แก้ค่าบริการ → ใบร่างตาม และชื่อผู้จ่ายยังเป็นลูกค้าของผู้ป่วย (ของเดิมกลายเป็นชื่อผู้ป่วย)
      assert.equal((await send('PATCH', `/api/cases/${c.case_id}`, { fee: 3500 })).status, 200);
      let draft = await draftOf(c.case_id);
      assert.equal(draft.total, 3500);
      assert.equal(draft.bill_to_name, 'ผู้จ่ายจากแฟ้มผู้ป่วย');
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
      assert.equal(refreshed.bill_to_name, 'ผู้จ่ายจากแฟ้มผู้ป่วย');
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
      await post(`/api/invoices/${first.invoice_id}/cancel`, {});
      const reissued = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' }, MANAGER, 201);
      assert.equal(reissued.items.length, 2);
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

      await post(`/api/invoices/${draft.invoice_id}/cancel`, {});
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
      await post(`/api/invoices/${a.balance.invoice_id}/cancel`, {});
      assert.equal((await invoice(a.deposit.invoice_id)).status, 'cancelled');
      assert.equal((await invoice(a.balance.invoice_id)).status, 'cancelled');

      const b = await plan('Cancel plan B');
      await pay(b.balance.invoice_id, { amount: 1000 });
      const refused = await post(`/api/invoices/${b.deposit.invoice_id}/cancel`, {}, MANAGER, 409);
      assert.match(refused.error, new RegExp(b.balance.invoice_id));
      assert.notEqual((await invoice(b.deposit.invoice_id)).status, 'cancelled');
      // ยกเลิกใบที่รับเงินแล้วเอง = ใบมัดจำที่ยังไม่รับเงินตามไป
      await post(`/api/invoices/${b.balance.invoice_id}/cancel`, {});
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
      await post(`/api/cases/${c.case_id}/pay/release`, { amount: 100 }, MANAGER, 201);
      assert.match((await call('PATCH', futurePath, { status: 'cancelled' }, MANAGER, 409)).error, /ปล่อยค่าจ้าง/);
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

      const refused = await post(`/api/cases/${c.case_id}/pay/release`, { amount: 600 }, MANAGER, 400);
      assert.match(refused.error, /ระบุยอดของแต่ละคน/);

      await post(`/api/cases/${c.case_id}/pay/release`, {
        amount: 600,
        shares: [{ employee_id: FIELD.employee_id, amount: 600 }, { employee_id: LEAD_A.employee_id, amount: 0 }],
      }, MANAGER, 201);
      const payouts = await sql.all('SELECT employee_id, amount FROM case_payouts WHERE case_id = :id', { id: c.case_id });
      assert.deepEqual(payouts.map((p) => [p.employee_id, Number(p.amount)]), [[FIELD.employee_id, 600]]);

      // เคสคนเดียวยังปล่อยได้โดยไม่ต้องระบุ (ไม่มีอะไรให้แบ่ง)
      const solo = await newCase();
      await post(`/api/cases/${solo.case_id}/assign`, { employee_id: FIELD.employee_id });
      await post(`/api/cases/${solo.case_id}/pay/release`, { amount: 300 }, MANAGER, 201);
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
      await post(`/api/cases/${c.case_id}/pay/release`, { amount }, MANAGER, 201);
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
        `UPDATE employees SET temp_password_encrypted = 'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA'
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
        body: JSON.stringify({ current_password: created.temp_password, new_password: 'Same-second-789!' }),
      });
      assert.equal(changed.status, 200);
      const fresh = changed.headers.get('set-cookie').split(';')[0];
      assert.equal((await me(fresh)).status, 200, 'the session issued right after the change must survive');
    });
  });
}
