import { test, describe, before, after } from 'node:test';
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
      assert.deepEqual(me.permissions, ['billing', 'money', 'invoices', 'payroll', 'revenue', 'see_pay', 'invoice_adjust', 'slip_delete']);
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
}
