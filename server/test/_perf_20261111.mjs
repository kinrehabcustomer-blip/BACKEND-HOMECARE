/**
 * วัดความเร็ว API ด้วยข้อมูลปริมาณใกล้ของจริง (11 พ.ย. 2569) — ฐานชั่วคราวเท่านั้น
 *   node test/_run_probe.mjs test/_perf_20261111.mjs [--explain]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const N_CASES = Number(process.env.PERF_CASES ?? 3000);
const MANAGER = { employee_id: 'EMP-0001', position: 'manager', name: 'ผู้จัดการ' };
await seedFixtures(pool, hashPassword);
const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const cookie = `${COOKIE_NAME}=${signToken(MANAGER)}`;
const pg = (await import('pg')).default;
let queries = 0;
for (const proto of [pg.Client.prototype, pg.Pool.prototype]) {
  const orig = proto.query;
  proto.query = function (...a) {
    if (proto === pg.Client.prototype) {
      queries += 1;
      const text = typeof a[0] === 'string' ? a[0] : a[0]?.text;
      if (text && (process.env.EXPLAIN_MATCH ? text.includes(process.env.EXPLAIN_MATCH) : /data_stale/.test(text))) globalThis.lastStale = { text, values: Array.isArray(a[1]) ? a[1] : a[0]?.values };
    }
    return orig.apply(this, a);
  };
}
const get = async (p) => {
  const t = performance.now();
  const r = await fetch(base + p, { headers: { cookie } });
  const body = await r.text();
  return { ms: performance.now() - t, status: r.status, size: body.length, body };
};

// อุ่นเครื่อง: ให้ ensure*() ทั้งหลายเติมคอลัมน์/ตารางก่อนเติมข้อมูล
for (const p of ['/api/cases', '/api/invoices', '/api/notify/alerts', '/api/cases/dashboard', '/api/payroll/case-queue', '/api/customers', '/api/patients', '/api/employees']) await get(p);
await fetch(`${base}/api/cases`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ case_id: 'VN100000001', case_type: 'other', client_name: 'warm', fee: 1000 }) });

console.log(`เติมข้อมูล: ${N_CASES} เคส …`);
const t0 = performance.now();
await sql.run(`INSERT INTO employees (employee_id, first_name, last_name, position, email, status, password_hash)
  SELECT 'EMP-' || lpad((100 + g)::text, 4, '0'), 'พนักงาน', g::text, 'caregiver', 'e' || g || '@x.invalid', 'active', 'x'
  FROM generate_series(1, 80) g`);
await sql.run(`INSERT INTO customers (customer_id, name, phone)
  SELECT 'CUS-P' || g, 'ลูกค้า ' || g, '08' || lpad(g::text, 8, '0') FROM generate_series(1, ${Math.round(N_CASES / 2)}) g`);
await sql.run(`INSERT INTO patients (patient_id, name, customer_id)
  SELECT 'PT-P' || g, 'ผู้ป่วย ' || g, 'CUS-P' || (1 + g % ${Math.round(N_CASES / 2)}) FROM generate_series(1, ${N_CASES}) g`);
await sql.run(`INSERT INTO cases (case_id, title, case_type, client_name, status, assigned_to, fee, staff_pay, customer_id, patient_id, start_date, end_date, created_at)
  SELECT 'VNP' || g, 'เคส ' || g, 'other', 'ผู้ป่วย ' || g,
         (ARRAY['assigned','in_progress','closed','closed','closed','cancelled'])[1 + g % 6],
         'EMP-' || lpad((101 + g % 80)::text, 4, '0'),
         20000 + (g % 10) * 1000, 12000, 'CUS-P' || (1 + g % ${Math.round(N_CASES / 2)}), 'PT-P' || g,
         to_char(current_date - (g % 360), 'YYYY-MM-DD'), to_char(current_date - (g % 360) + 30, 'YYYY-MM-DD'),
         to_char(now() - make_interval(days => g % 360), 'YYYY-MM-DD HH24:MI:SS')
  FROM generate_series(1, ${N_CASES}) g`);
await sql.run(`INSERT INTO case_visits (case_id, visit_date, assigned_to, status, check_in_at, check_out_at, pay_status, planned_start, planned_end)
  SELECT 'VNP' || g, to_char(d, 'YYYY-MM-DD'), 'EMP-' || lpad((101 + g % 80)::text, 4, '0'),
         CASE WHEN d < current_date THEN 'done' ELSE 'scheduled' END,
         CASE WHEN d < current_date THEN d + time '08:00' END,
         CASE WHEN d < current_date THEN d + time '16:00' END,
         CASE WHEN d < current_date THEN 'approved' ELSE 'pending' END, '08:00', '16:00'
  FROM generate_series(1, ${N_CASES}) g, LATERAL generate_series(current_date - (g % 360), current_date - (g % 360) + 19, interval '1 day') d`);
await sql.run(`INSERT INTO invoices (invoice_id, case_id, customer_id, issue_date, bill_to_name, service_description, amount, discount, total, status, billing_kind)
  SELECT 'HC-IVP' || g, 'VNP' || g, 'CUS-P' || (1 + g % ${Math.round(N_CASES / 2)}), to_char(current_date - (g % 360), 'YYYY-MM-DD'),
         'ลูกค้า ' || g, 'บริการ', 20000 + (g % 10) * 1000, 0, 20000 + (g % 10) * 1000,
         (ARRAY['draft','issued','paid','paid','paid','cancelled'])[1 + g % 6], 'full'
  FROM generate_series(1, ${N_CASES}) g`);
await sql.run(`INSERT INTO invoice_payments (invoice_id, request_id, amount, paid_at)
  SELECT invoice_id, gen_random_uuid(), total, issue_date FROM invoices WHERE status = 'paid' AND invoice_id LIKE 'HC-IVP%'`);
// เคสที่ปิดแล้ว 9 ใน 10 จ่ายค่าจ้างครบแล้ว — ใกล้ของจริงที่คิวค้างจ่ายสั้นกว่าประวัติทั้งหมดมาก
await sql.run(`INSERT INTO case_payouts (case_id, employee_id, employee_name, amount)
  SELECT case_id, assigned_to, 'พนักงาน', staff_pay FROM cases
  WHERE status = 'closed' AND case_id LIKE 'VNP%' AND substr(case_id, 4)::int % 10 <> 0`);
await sql.run('ANALYZE');
const counts = await sql.one(`SELECT (SELECT COUNT(*) FROM cases) c, (SELECT COUNT(*) FROM case_visits) v, (SELECT COUNT(*) FROM invoices) i`);
console.log(`เคส ${counts.c} · กะ ${counts.v} · ใบ ${counts.i} (${Math.round(performance.now() - t0)} ms)\n`);

const now = new Date(Date.now() + 7 * 3600e3);
const ym = { year: now.getUTCFullYear(), month: String(now.getUTCMonth() + 1).padStart(2, '0') };
const ROUTES = [
  '/api/notify/alerts',
  '/api/cases?page=1&per_page=20',
  '/api/cases?q=%E0%B8%9C%E0%B8%B9%E0%B9%89%E0%B8%9B%E0%B9%88%E0%B8%A7%E0%B8%A2%2012',
  '/api/cases/summary',
  '/api/cases/dashboard',
  '/api/cases/periods',
  `/api/cases/calendar?year=${ym.year}&month=${ym.month}`,
  `/api/cases/attendance?month=${ym.year}-${ym.month}`,
  '/api/cases/attendance/pending',
  '/api/cases/attendance/exceptions',
  '/api/cases/assignable-employees',
  '/api/cases/VNP10',
  '/api/cases/VNP10/visits',
  '/api/invoices?page=1&per_page=20',
  '/api/invoices?stale=yes',
  '/api/invoices/summary',
  '/api/invoices/revenue',
  '/api/invoices/cases-without-invoice',
  '/api/invoices/cases-with-extras',
  '/api/invoices/HC-IVP10',
  '/api/customers',
  '/api/customers/CUS-P10',
  '/api/patients',
  '/api/patients/PT-P10',
  '/api/employees',
  '/api/employees/EMP-0110',
  '/api/employees/summary',
  '/api/payroll/case-queue',
  '/api/payroll/case-queue?view=pending',
  '/api/payroll/employee-cases',
  '/api/payroll',
  '/api/reviews/summary',
];
const rows = [];
for (const p of ROUTES) {
  const runs = [];
  let last;
  let q = 0;
  for (let i = 0; i < 5; i += 1) { const before = queries; last = await get(p); runs.push(last.ms); q = queries - before; }
  runs.sort((a, b) => a - b);
  rows.push({ route: p, status: last.status, median: runs[2], kb: Math.round(last.size / 1024), q });
}
rows.sort((a, b) => b.median - a.median);
for (const r of rows) console.log(`${r.median.toFixed(0).padStart(6)} ms  ${String(r.q).padStart(3)} q  ${String(r.kb).padStart(5)} KB  ${r.status}  ${r.route}`);

console.log('\n— ส่วนประกอบของกระดิ่ง —');
const inv = await import('../src/invoices/repo.js');
const cs = await import('../src/cases/repo.js');
const pr = await import('../src/payroll/repo.js');
const todayStr = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const parts = {
  'invoices.alertCounts': () => inv.alertCounts(),
  'cases.alertCounts': () => cs.alertCounts(),
  'payroll.alertCounts': () => pr.alertCounts(todayStr),
  'cases.attendanceExceptions': () => cs.attendanceExceptions(),
  'cases.payQueue': () => cs.payQueue(),
};
for (const [name, fn] of Object.entries(parts)) {
  const runs = [];
  for (let i = 0; i < 5; i += 1) { const t = performance.now(); await fn(); runs.push(performance.now() - t); }
  runs.sort((a, b) => a - b);
  console.log(`${runs[2].toFixed(0).padStart(6)} ms  ${name}`);
}
if (process.argv.includes('--explain') && globalThis.lastStale) {
  const { text, values } = globalThis.lastStale;
  const c = await pool.connect();
  const plan = await c.query(`EXPLAIN (ANALYZE, COSTS OFF) ${text}`, values);
  console.log(plan.rows.map((r) => r['QUERY PLAN']).join('\n'));
  c.release();
}
if (false) {
  for (const q of (process.env.EXPLAIN_SQL ?? '').split(';;').filter(Boolean)) {
    const plan = await sql.all(`EXPLAIN (ANALYZE, BUFFERS) ${q}`);
    console.log(plan.map((r) => r['QUERY PLAN']).join('\n'));
  }
}
server.close();
await pool.end();
