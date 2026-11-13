/**
 * พิสูจน์ว่างานปรับความเร็ว "ไม่เปลี่ยนผลลัพธ์" (13 พ.ย. 2569) — ฐานชั่วคราวเท่านั้น
 *   node test/_run_probe.mjs test/_equiv_20261113.mjs [git-ref]
 *
 * เอาไฟล์ repo ฉบับเก่าจาก git (ค่าปริยาย HEAD) มาวางข้างฉบับใหม่ชั่วคราว แล้วเรียกฟังก์ชันเดียวกัน
 * ด้วยข้อมูลชุดเดียวกัน (ปริมาณใกล้ของจริง + กรณีขอบที่ตั้งใจใส่) แล้วเทียบผลแบบตรงทุกช่องทุกแถว
 * ต่างแม้แต่ช่องเดียว = ล้ม และพิมพ์แถวแรกที่ต่างให้ดู
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const REF = process.argv[2] ?? 'HEAD';
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');
const { createServer } = await import('node:http');

await seedFixtures(pool, hashPassword);
// อุ่นเครื่องผ่านแอปจริง ให้ ensure*() สร้างคอลัมน์/ตาราง lazy ให้ครบก่อนเติมข้อมูล
const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const { signToken, COOKIE_NAME } = await import('../src/lib/auth.js');
const cookie = `${COOKIE_NAME}=${signToken({ employee_id: 'EMP-0001', position: 'manager', first_name: 'M', last_name: 'M' })}`;
for (const p of ['/api/cases', '/api/invoices', '/api/notify/alerts', '/api/cases/dashboard', '/api/payroll/case-queue', '/api/customers', '/api/patients', '/api/employees', '/api/payroll']) {
  await fetch(base + p, { headers: { cookie } });
}

const N = Number(process.env.EQUIV_CASES ?? 1500);
const H = Math.round(N / 2);
await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash)
  SELECT 'EMP-' || lpad((100 + g)::text, 4, '0'), 'พนักงาน', g::text, 'caregiver', 'e' || g || '@x.invalid',
         (ARRAY['active','active','active','resigned'])[1 + g % 4], 'x'
  FROM generate_series(1, 60) g`);
await sql.run(`INSERT INTO customers (customer_id, name, phone)
  SELECT 'CUS-P' || g, 'ลูกค้า ' || g, '08' || lpad(g::text, 8, '0') FROM generate_series(1, ${H}) g`);
await sql.run(`INSERT INTO patients (patient_id, name, customer_id)
  SELECT 'PT-P' || g, 'ผู้ป่วย ' || g, 'CUS-P' || (1 + g % ${H}) FROM generate_series(1, ${N}) g`);
// สถานะครบทุกแบบ · บางเคสไม่มีค่าจ้าง · บางเคสยังไม่มีคน
await sql.run(`INSERT INTO cases (case_id, title, case_type, client_name, status, assigned_to, fee, staff_pay, customer_id, patient_id, start_date, end_date, created_at, closed_at, cancelled_at)
  SELECT 'VNP' || g, 'เคส ' || g, 'other', 'ผู้ป่วย ' || g, st,
         CASE WHEN st = 'unassigned' THEN NULL ELSE 'EMP-' || lpad((101 + g % 60)::text, 4, '0') END,
         20000 + (g % 10) * 1000, CASE WHEN g % 13 = 0 THEN NULL ELSE 12000 + (g % 3) * 500 END,
         'CUS-P' || (1 + g % ${H}), 'PT-P' || g,
         to_char(current_date - (g % 360), 'YYYY-MM-DD'), to_char(current_date - (g % 360) + 30, 'YYYY-MM-DD'),
         to_char(now() - make_interval(days => g % 360, secs => g), 'YYYY-MM-DD HH24:MI:SS'),
         CASE WHEN st = 'closed' THEN to_char(current_date - (g % 300), 'YYYY-MM-DD') || ' 10:00:00' END,
         CASE WHEN st = 'cancelled' THEN to_char(current_date - (g % 300), 'YYYY-MM-DD') || ' 11:00:00' END
  FROM generate_series(1, ${N}) g,
       LATERAL (SELECT (ARRAY['assigned','in_progress','closed','closed','cancelled','unassigned','cancelled'])[1 + g % 7] AS st) s`);
// กะ: เช็คอิน/ไม่เช็คอิน · ยกเลิกบางกะ · ปฏิเสธค่าจ้างบางกะ · คนเช็คอินต่างจากคนที่ถูกนัดบางกะ
await sql.run(`INSERT INTO case_visits (case_id, visit_date, assigned_to, checked_in_by, status, check_in_at, check_out_at, pay_status, planned_start, planned_end)
  SELECT 'VNP' || g, to_char(d, 'YYYY-MM-DD'),
         CASE WHEN (g + i) % 11 = 0 THEN NULL ELSE 'EMP-' || lpad((101 + (g + i % 3) % 60)::text, 4, '0') END,
         CASE WHEN d < current_date AND (g + i) % 5 <> 0 THEN 'EMP-' || lpad((101 + (g + i) % 60)::text, 4, '0') END,
         CASE WHEN (g + i) % 9 = 0 THEN 'cancelled' WHEN d < current_date THEN 'done' ELSE 'scheduled' END,
         CASE WHEN d < current_date AND (g + i) % 5 <> 0 THEN d + time '08:00' END,
         CASE WHEN d < current_date AND (g + i) % 5 <> 0 AND (g + i) % 7 <> 0 THEN d + time '16:00' END,
         CASE WHEN (g + i) % 17 = 0 THEN 'rejected' WHEN d < current_date THEN 'approved' ELSE 'pending' END,
         '08:00', '16:00'
  FROM generate_series(1, ${N}) g,
       LATERAL generate_series(0, (g % 25)) i,
       LATERAL (SELECT current_date - (g % 360) + i AS d) dd`);
// ทีม · ส่วนแบ่ง · งวดค่าจ้างหลายงวด · เคสยกเลิกที่มีงวดแต่ไม่มีกะเช็คอิน
await sql.run(`INSERT INTO case_team (case_id, employee_id)
  SELECT 'VNP' || g, 'EMP-' || lpad((101 + (g + 7) % 60)::text, 4, '0') FROM generate_series(1, ${N}, 4) g ON CONFLICT DO NOTHING`);
await sql.run(`INSERT INTO case_payouts (case_id, employee_id, employee_name, amount, installment_no)
  SELECT case_id, assigned_to, 'พนักงาน', staff_pay / 2, 1 FROM cases
  WHERE case_id LIKE 'VNP%' AND staff_pay IS NOT NULL AND assigned_to IS NOT NULL AND substr(case_id, 4)::int % 3 = 0`);
await sql.run(`INSERT INTO case_payouts (case_id, employee_id, employee_name, amount, installment_no)
  SELECT case_id, assigned_to, 'พนักงาน', staff_pay / 2, 2 FROM cases
  WHERE case_id LIKE 'VNP%' AND staff_pay IS NOT NULL AND assigned_to IS NOT NULL AND substr(case_id, 4)::int % 6 = 0`);
// ใบแจ้งหนี้ทุกสถานะ · ยอดไม่ตรงเคสบางใบ (stale) · รับเงินบางส่วน/ครบ · ใบลดหนี้/เพิ่มหนี้
await sql.run(`INSERT INTO invoices (invoice_id, case_id, customer_id, issue_date, due_date, bill_to_name, service_description, amount, discount, total, status, billing_kind, created_at)
  SELECT 'HC-IVP' || g, 'VNP' || g, 'CUS-P' || (1 + g % ${H}), to_char(current_date - (g % 360), 'YYYY-MM-DD'),
         CASE WHEN g % 4 = 0 THEN to_char(current_date - (g % 360) + 7, 'YYYY-MM-DD') END,
         CASE WHEN g % 10 = 0 THEN 'ชื่อเก่า ' || g ELSE 'ผู้ป่วย ' || g END, 'บริการ',
         20000 + (g % 10) * 1000 + CASE WHEN g % 8 = 0 THEN 500 ELSE 0 END, 0,
         20000 + (g % 10) * 1000 + CASE WHEN g % 8 = 0 THEN 500 ELSE 0 END,
         (ARRAY['draft','issued','paid','paid','issued','cancelled'])[1 + g % 6], 'full',
         to_char(now() - make_interval(days => g % 360, secs => g), 'YYYY-MM-DD HH24:MI:SS')
  FROM generate_series(1, ${N}) g`);
await sql.run(`INSERT INTO invoice_payments (invoice_id, request_id, amount, paid_at)
  SELECT invoice_id, gen_random_uuid(), CASE WHEN status = 'paid' THEN total ELSE total / 3 END, issue_date
  FROM invoices WHERE invoice_id LIKE 'HC-IVP%' AND (status = 'paid' OR (status = 'issued' AND substr(invoice_id, 7)::int % 5 = 0))`);
await sql.run(`INSERT INTO invoice_adjustments (note_id, invoice_id, kind, amount, reason, issue_date, total_before, total_after, bill_to_name)
  SELECT 'HC-CNP' || substr(invoice_id, 7), invoice_id, CASE WHEN substr(invoice_id, 7)::int % 2 = 0 THEN 'credit' ELSE 'debit' END,
         700, 'ทดสอบ', issue_date, total, total + 700, bill_to_name
  FROM invoices WHERE invoice_id LIKE 'HC-IVP%' AND status IN ('issued', 'paid') AND substr(invoice_id, 7)::int % 11 = 0`);
await sql.run('ANALYZE');
const counts = await sql.one(`SELECT (SELECT COUNT(*) FROM cases) c, (SELECT COUNT(*) FROM case_visits) v, (SELECT COUNT(*) FROM case_payouts) p, (SELECT COUNT(*) FROM invoices) i`);
console.log(`ข้อมูลทดสอบ: เคส ${counts.c} · กะ ${counts.v} · งวด ${counts.p} · ใบ ${counts.i}`);

/* ไฟล์ฉบับเก่าจาก git วางข้างฉบับใหม่ (import สัมพัทธ์ของมันจึงชี้ไฟล์ข้างเคียงเดิม) แล้วลบทิ้งตอนจบ */
const root = fileURLToPath(new URL('../..', import.meta.url));
const made = [];
async function oldVersion(rel) {
  const text = execFileSync('git', ['show', `${REF}:server/src/${rel}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const target = fileURLToPath(new URL(`../src/${rel.replace(/([^/]+)\.js$/, '__equiv_old_$1.js')}`, import.meta.url));
  writeFileSync(target, text);
  made.push(target);
  return import(`file://${target.replace(/\\/g, '/')}`);
}

const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const ym = today.slice(0, 7);
// แต่ละข้อ: ไฟล์ · ชื่อ · วิธีเรียก (ฉบับเก่า/ใหม่เรียกแบบเดียวกัน)
const CHECKS = (process.env.EQUIV_ONLY ? (x) => x.filter((c) => new RegExp(process.env.EQUIV_ONLY).test(c.name)) : (x) => x)([
  { file: 'cases/repo.js', name: 'payQueue', call: (m) => m.payQueue() },
  { file: 'cases/repo.js', name: 'summary(all)', call: (m) => m.summary({}) },
  { file: 'cases/repo.js', name: 'summary(month)', call: (m) => m.summary({ year: today.slice(0, 4), month: today.slice(5, 7) }) },
  { file: 'cases/repo.js', name: 'attendanceList(month)', call: (m) => m.attendanceList({ month: ym }) },
  { file: 'cases/repo.js', name: 'calendar(month)', call: (m) => m.calendar({ year: today.slice(0, 4), month: today.slice(5, 7) }) },
  { file: 'cases/repo.js', name: 'calendar(พนักงาน)', call: (m) => m.calendar({ year: today.slice(0, 4), month: today.slice(5, 7), employee_id: 'EMP-0105' }) },
  { file: 'cases/repo.js', name: 'list(page1)', call: (m) => m.list({ page: 1, per_page: 50, sort: 'created_at', order: 'desc' }) },
  { file: 'cases/repo.js', name: 'list(q)', call: (m) => m.list({ q: 'ผู้ป่วย 1', page: 2, per_page: 20, sort: 'start_date', order: 'asc' }) },
  { file: 'invoices/repo.js', name: 'invoices.list(page)', call: (m) => m.list({ page: 1, per_page: 50, sort: 'invoice_id', order: 'desc' }) },
  { file: 'invoices/repo.js', name: 'invoices.list(stale)', call: (m) => m.list({ stale: true, page: 1, per_page: 100, sort: 'total', order: 'desc' }) },
  { file: 'invoices/repo.js', name: 'invoices.list(overdue)', call: (m) => m.list({ overdue: true, page: 2, per_page: 20, sort: 'issue_date', order: 'asc' }) },
  { file: 'invoices/repo.js', name: 'invoices.summary', call: (m) => m.summary({}) },
  { file: 'invoices/repo.js', name: 'invoices.alertCounts', call: (m) => m.alertCounts() },
  { file: 'notify/alerts.js', name: 'กระดิ่ง (ผู้จัดการ)', call: (m) => m.collectAlerts({ employee_id: 'EMP-0001', position: 'manager' }) },
  { file: 'notify/alerts.js', name: 'กระดิ่ง (HR)', call: (m) => m.collectAlerts({ employee_id: 'EMP-0007', position: 'hr' }) },
  { file: 'notify/alerts.js', name: 'กระดิ่ง (การเงิน)', call: (m) => m.collectAlerts({ employee_id: 'EMP-0098', position: 'finance' }) },
  { file: 'customers/repo.js', name: 'ลูกค้า findDetailById', call: (m) => Promise.all(['CUS-P10', 'CUS-P11', 'CUS-NOPE'].map((id) => m.findDetailById(id))) },
  { file: 'patients/repo.js', name: 'ผู้รับบริการ findDetailById', call: (m) => Promise.all(['PT-P10', 'PT-P11', 'PT-NOPE'].map((id) => m.findDetailById(id))) },
  { file: 'employees/repo.js', name: 'พนักงาน findDetailById', call: (m) => Promise.all([['EMP-0110', false], ['EMP-0111', true], ['EMP-0001', true], ['EMP-NOPE', false]].map(([id, t]) => m.findDetailById(id, t))) },
  { file: 'invoices/repo.js', name: 'invoices.findById', call: async (m) => Promise.all(['HC-IVP11', 'HC-IVP22', 'HC-IVP33', 'HC-IVP6'].map((id) => m.findById(id))) },
]);

let failed = 0;
const stable = (v) => JSON.parse(JSON.stringify(v));
try {
  const mods = new Map();
  for (const c of CHECKS) {
    if (!mods.has(c.file)) {
      mods.set(c.file, { old: await oldVersion(c.file), now: await import(`../src/${c.file}`) });
    }
    const { old, now } = mods.get(c.file);
    const [a, b] = [stable(await c.call(old)), stable(await c.call(now))];
    try {
      assert.deepStrictEqual(b, a);
      console.log(`✔ ${c.name} — เหมือนเดิมทุกช่อง (${Array.isArray(a) ? `${a.length} แถว` : 'object'})`);
    } catch {
      failed += 1;
      const rows = Array.isArray(a) ? a : [a];
      const rowsB = Array.isArray(b) ? b : [b];
      const i = rows.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(rowsB[k]));
      console.log(`✖ ${c.name} — ต่างกัน (เก่า ${rows.length} / ใหม่ ${rowsB.length} แถว) แถวแรกที่ต่าง #${i}`);
      console.log('  เก่า:', JSON.stringify(rows[i])?.slice(0, 600));
      console.log('  ใหม่:', JSON.stringify(rowsB[i])?.slice(0, 600));
    }
  }
} finally {
  for (const f of made) rmSync(f, { force: true });
  server.close();
  await pool.end();
}
console.log(failed ? `\nล้ม ${failed} ข้อ` : '\nผ่านทุกข้อ — ผลลัพธ์เหมือนฉบับ ' + REF);
process.exitCode = failed ? 1 : 0;
