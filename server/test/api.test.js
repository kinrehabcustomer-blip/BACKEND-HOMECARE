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


  async function post(path, body, who = MANAGER, expected = 200) {
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

  describe('Authentication fixture states', () => {
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
  });

  describe('Case lifecycle and payout workflow', () => {
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
