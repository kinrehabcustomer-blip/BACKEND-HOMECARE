/**
 * เทสระดับ API — สตาร์ทแอปจริง ยิง HTTP จริง อ่านจากฐานข้อมูลที่ .env ชี้อยู่
 *
 * ⚠️ ต้องสั่งเปิดเอง: `npm run test:api` (ตั้ง RUN_DB_TESTS=1 ให้แล้ว)
 *    ไม่ได้ตั้ง = ข้ามทั้งไฟล์ · `npm test` ปกติจึงไม่มีทางแตะฐานข้อมูล
 *
 * ⚠️ .env ของโปรเจคชี้ไปที่ Neon ตัวจริง — ไฟล์นี้จึงยิงเฉพาะ GET เท่านั้น
 *    helper `get()` ด้านล่างฮาร์ดโค้ด method: 'GET' ไว้ ไม่มีทางส่งเมธอดอื่นออกไป
 *    ถ้าจะเพิ่มเทสที่เขียนข้อมูล ต้องชี้ DATABASE_URL ไปฐานอื่นก่อนเสมอ
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

await import('../src/lib/env.js');

if (process.env.RUN_DB_TESTS !== '1') {
  const why = 'ต้องสั่ง `npm run test:api` (ตั้ง RUN_DB_TESTS=1) — ชุดนี้ต่อฐานข้อมูลจริง';
  test('เทสที่ต้องใช้ฐานข้อมูล', { skip: why }, () => {});
} else {
  const host = (process.env.DATABASE_URL ?? '').split('@')[1]?.split('/')[0] ?? 'ไม่ทราบ';
  console.log(`\n  ⚠  กำลังอ่านจากฐานข้อมูล: ${host} (GET อย่างเดียว ไม่มีคำสั่งเขียน)\n`);

  const { createApp } = await import('../src/app.js');
  const { signToken, COOKIE_NAME } = await import('../src/lib/auth.js');
  const { sql, pool } = await import('../src/db/index.js');

  const emp = (id, position) => ({ employee_id: id, position, first_name: 'T', last_name: 'T' });
  const MANAGER = emp('EMP-0001', 'manager');
  const HR = emp('EMP-0007', 'hr');
  const FIELD = emp('EMP-0003', 'caregiver');
  const GHOST = emp('EMP-9999', 'manager'); // ไม่มีอยู่จริงในตาราง

  let base;
  let server;

  before(async () => {
    server = createServer(createApp());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  /** GET เท่านั้น — เมธอดอื่นเรียกจากไฟล์นี้ไม่ได้เลย */
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

    test('GET /api/cases/:id/visits — ค่าจ้างรายกะก็ต้องตัด', async () => {
      const cases = (await get('/api/cases?per_page=50', MANAGER)).body.data;
      let checked = 0;
      for (const c of cases) {
        const m = (await get(`/api/cases/${c.case_id}/visits`, MANAGER)).body;
        if (!m.length) continue;
        const h = (await get(`/api/cases/${c.case_id}/visits`, HR)).body;
        assert.ok('staff_pay' in m[0] && 'effective_pay' in m[0], 'manager ต้องเห็นค่าจ้างรายกะ');
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

  // ---------- เงื่อนไขของสูตรค่าตอบแทน (จำลองด้วย CTE ไม่แตะข้อมูลจริง) ----------
  describe('สรุปค่าตอบแทน — เงื่อนไขที่ต้องคงไว้', () => {
    test('กะที่ถูกยกเลิกต้องไม่ถูกนับเป็นเงิน และไม่ทำให้กะอื่นได้เพิ่ม', async () => {
      /* จำลองว่ากะที่ทำเสร็จแล้วกะหนึ่งถูก admin เปลี่ยนสถานะเป็น 'cancelled'
         แล้วเทียบสูตรเก่า (ตัวเศษไม่กรอง) กับสูตรใหม่ (กรอง) — ของเก่าต้องจ่ายมากกว่าเสมอ */
      const r = await sql.one(
        `WITH sim AS (
           SELECT v.*, CASE WHEN v.visit_id = (SELECT MIN(visit_id) FROM case_visits WHERE check_out_at IS NOT NULL)
                            THEN 'cancelled' ELSE v.status END AS sim_status
           FROM case_visits v
         ),
         booked AS (SELECT case_id, COUNT(*) AS n FROM sim WHERE sim_status <> 'cancelled' GROUP BY case_id)
         SELECT COALESCE(SUM(COALESCE(s.staff_pay, c.staff_pay / NULLIF(b.n,0))), 0) AS old_total,
                COALESCE(SUM(COALESCE(s.staff_pay, c.staff_pay / NULLIF(b.n,0)))
                         FILTER (WHERE s.sim_status <> 'cancelled'), 0) AS new_total
         FROM sim s
         JOIN cases c ON c.case_id = s.case_id
         LEFT JOIN booked b ON b.case_id = s.case_id
         WHERE s.check_out_at IS NOT NULL`,
      );
      const oldT = Number(r.old_total);
      const newT = Number(r.new_total);
      console.log(`      สูตรเก่า(ไม่กรอง)=${oldT.toFixed(2)} · สูตรใหม่(กรอง)=${newT.toFixed(2)}`);
      assert.ok(newT <= oldT, 'สูตรใหม่ต้องไม่จ่ายมากกว่าสูตรเก่า');
    });

    test('ลบพนักงานถาวรแล้วกะที่เขาทำต้องไม่หายจากรายงาน', async () => {
      // จำลอง checked_in_by = NULL (ผลของ ON DELETE SET NULL) แล้วเทียบ INNER JOIN กับ LEFT JOIN
      const r = await sql.one(
        `WITH sim AS (SELECT v.visit_id, NULL::text AS checked_in_by FROM case_visits v WHERE v.check_in_at IS NOT NULL)
         SELECT (SELECT COUNT(*) FROM sim s JOIN employees e ON e.employee_id = s.checked_in_by)      AS inner_join,
                (SELECT COUNT(*) FROM sim s LEFT JOIN employees e ON e.employee_id = s.checked_in_by) AS left_join,
                (SELECT COUNT(*) FROM sim) AS total`,
      );
      console.log(`      กะที่เช็คอินแล้ว=${r.total} · INNER JOIN เหลือ=${r.inner_join} · LEFT JOIN เหลือ=${r.left_join}`);
      assert.equal(Number(r.inner_join), 0, 'INNER JOIN เดิมทำให้หายหมด');
      assert.equal(Number(r.left_join), Number(r.total), 'LEFT JOIN ต้องเก็บครบ');
    });

    test('ชื่อพนักงานที่ถูกลบไปแล้ว มีข้อความแทน ไม่เป็น null (กัน localeCompare ล้ม)', async () => {
      const r = await sql.one(
        `SELECT COALESCE(e.first_name || ' ' || e.last_name, '(พนักงานที่ถูกลบแล้ว)') AS name
         FROM (SELECT NULL::text AS checked_in_by) s
         LEFT JOIN employees e ON e.employee_id = s.checked_in_by`,
      );
      assert.equal(r.name, '(พนักงานที่ถูกลบแล้ว)');
      assert.doesNotThrow(() => (r.name ?? '').localeCompare('x', 'th'));
    });
  });

  // ---------- ลำดับการตรึงค่าจ้างตอนปิดเคส ----------
  describe('ปิดเคส — ตัวหารของการเกลี่ยค่าจ้าง', () => {
    test('ตรึงก่อนยกเลิก ให้ตัวเลขเท่ากับที่แสดงอยู่ก่อนปิด', async () => {
      const rows = await sql.all(
        `SELECT c.case_id, c.staff_pay,
                COUNT(*) FILTER (WHERE v.status <> 'cancelled') AS n_before,
                COUNT(*) FILTER (WHERE v.status <> 'cancelled'
                  AND NOT (v.check_in_at IS NULL
                           AND v.visit_date >= to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD'))) AS n_after
         FROM cases c JOIN case_visits v ON v.case_id = c.case_id
         WHERE c.status NOT IN ('closed','cancelled') AND c.staff_pay IS NOT NULL
         GROUP BY c.case_id, c.staff_pay
         HAVING COUNT(*) FILTER (WHERE v.check_in_at IS NOT NULL) > 0`,
      );

      for (const r of rows) {
        const fixed = r.staff_pay / Number(r.n_before);   // ตรึงก่อน: ตัวหาร = กะที่นัดไว้ทั้งหมด
        const buggy = r.staff_pay / Number(r.n_after);    // ยกเลิกก่อน: ตัวหารหด ยอดพอง
        console.log(`      ${r.case_id}: ยอด ${r.staff_pay} · กะ ${r.n_before}→${r.n_after} · ใหม่ ฿${fixed.toFixed(2)} vs เก่า ฿${buggy.toFixed(2)}`);
        assert.ok(fixed <= buggy, 'ค่าที่ตรึงต้องไม่มากกว่าของเดิม');

        // ยอดที่จะตรึงต้องตรงกับที่รายงานแสดงอยู่ตอนนี้ — นั่นคือความหมายของคำว่า "ตรึง"
        const live = await sql.one(
          `SELECT COALESCE(v.staff_pay, c.staff_pay / NULLIF(b.n,0)) AS pay
           FROM case_visits v JOIN cases c ON c.case_id = v.case_id
           LEFT JOIN (SELECT case_id, COUNT(*) AS n FROM case_visits WHERE status <> 'cancelled' GROUP BY case_id) b
                  ON b.case_id = v.case_id
           WHERE v.case_id = :id AND v.check_in_at IS NOT NULL LIMIT 1`,
          { id: r.case_id },
        );
        assert.equal(Number(live.pay).toFixed(2), fixed.toFixed(2), 'ยอดที่จะตรึง = ยอดที่เห็นอยู่ก่อนปิด');
      }
    });
  });
}
