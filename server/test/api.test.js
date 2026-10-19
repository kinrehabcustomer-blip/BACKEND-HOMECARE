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

  describe('สิทธิ์ตามตำแหน่ง — การเงิน / Admin IPD / Admin HC', () => {
    const FINANCE = emp('EMP-0091', 'finance');
    const IPD = emp('EMP-0092', 'admin_ipd');
    const HC = emp('EMP-0093', 'admin');

    before(async () => {
      for (const [id, position] of [['EMP-0091', 'finance'], ['EMP-0092', 'admin_ipd'], ['EMP-0093', 'admin']]) {
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

    test('Admin IPD: ยังไม่มีสิทธิ์หน้าไหนเลย', async () => {
      for (const path of ['/api/cases', '/api/invoices', '/api/payroll/preview', '/api/notify/alerts', '/api/employees']) {
        assert.equal((await get(path, IPD)).status, 403, path);
      }
      assert.deepEqual((await get('/api/auth/me', IPD)).body.permissions, []);
    });

    test('Admin HC: สิทธิ์เท่าแอดมินเดิม — งานหลังบ้าน + ใบแจ้งหนี้ ไม่มีเรื่องเงิน', async () => {
      assert.equal((await get('/api/cases', HC)).status, 200);
      assert.equal((await get('/api/invoices', HC)).status, 200);
      assert.equal((await get('/api/payroll/preview', HC)).status, 403);
      assert.equal((await get('/api/invoices/revenue', HC)).status, 403);
      const alerts = (await get('/api/notify/alerts', HC)).body;
      assert.deepEqual(Object.keys(alerts.groups).sort(), ['attendance', 'cases', 'invoices']);
    });

    test('HR แต่งตั้งตำแหน่งการเงินไม่ได้ (เป็นการเลื่อนสิทธิ์เรื่องเงิน) — ผู้จัดการทำได้', async () => {
      const denied = await post('/api/employees', { first_name: 'Fin', last_name: 'Ance', position: 'finance' }, HR, 403);
      assert.match(denied.error, /การเงิน/);
      await post('/api/employees', { first_name: 'Fin', last_name: 'Ance', position: 'finance' }, MANAGER, 201);
      await post('/api/employees', { first_name: 'Ipd', last_name: 'Admin', position: 'admin_ipd' }, HR, 201);
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
}
