/**
 * ตรวจรอบ 15 (เฉพาะจุด) — แพ็กเกจกายภาพ: นัดเกินจำนวนครั้งที่ลูกค้าซื้อได้ไหม
 *   node test/_run_probe.mjs test/_qa_physio_quota_20261026.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', first_name: 'ผู้จัดการ', last_name: 'ทดสอบ' };

await seedFixtures(pool, hashPassword);
const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body, who = MANAGER) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie: `${COOKIE_NAME}=${signToken(who)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b ?? {});

const found = [];
const hit = (t, d) => { found.push(t); console.log(`\nBUG | ${t}\nRESULT | ${d}`); };
const ok = (w) => console.log(`PASS | ${w}`);

// แพ็ก 10 ครั้ง ราคา 15,000 (ของจริงของ KIN: กายภาพที่บ้าน 10 ครั้ง 15,000)
const pkg = await sql.one(
  `INSERT INTO physio_packages (name, sessions, special_price, staff_pay)
   VALUES ('กายภาพที่บ้าน 10 ครั้ง', 10, 15000, 9000) RETURNING physio_package_id`,
);
const c = await post('/api/cases', {
  case_id: 'VN900000001', case_type: 'other', client_name: 'คุณทดสอบโควตา',
  service_kind: 'physio', physio_package_id: pkg.physio_package_id, fee: 15000,
});
assert.equal(c.status, 201, JSON.stringify(c.body));
const caseId = c.body.case_id;
await post(`/api/cases/${caseId}/assign`, { employee_id: 'EMP-0003' });

console.log('\n=== นัดครั้งที่ 1–10 (ในโควตา) ===');
const day = (n) => `2026-11-${String(n).padStart(2, '0')}`;
for (let i = 1; i <= 10; i++) {
  const r = await post(`/api/cases/${caseId}/visits`, { visit_date: day(i), assigned_to: 'EMP-0003' });
  assert.equal(r.status < 300, true, `ครั้งที่ ${i}: ${r.status} ${JSON.stringify(r.body)}`);
}
ok('นัดครบ 10 ครั้งตามที่ลูกค้าซื้อ');

console.log('\n=== นัดครั้งที่ 11–15 (เกินโควตา) ===');
const over = [];
for (let i = 11; i <= 15; i++) {
  const r = await post(`/api/cases/${caseId}/visits`, { visit_date: day(i), assigned_to: 'EMP-0003' });
  over.push(`${i}:${r.status}`);
}
const detail = await get(`/api/cases/${caseId}`);
const booked = Number((await sql.one('SELECT count(*)::int AS n FROM case_visits WHERE case_id = :id', { id: caseId })).n);
const warned = JSON.stringify(detail.body).includes('เกิน');

if (over.every((s) => s.endsWith(':201') || s.endsWith(':200'))) {
  /* 🔴 ดร.ธงชัย 26 ต.ค. 2569: *"เตือนอย่างเดียวพอครับ อย่าบล็อก"*
     นัดเกินโควตาได้โดยตั้งใจ (ลูกค้าซื้อเพิ่มกลางคอร์ส / ชดเชยนัดที่ยกเลิก เป็นเรื่องที่เกิดจริง)
     สิ่งที่ต้องมีคือคนเห็น — ป้ายแดง "เกินแพ็กที่ซื้อ N ครั้ง" ใน CaseModal.jsx (commit 2fc68c3)
     ห้ามเปลี่ยนกลับเป็นด่านกั้นการนัด */
  ok(
    `นัดเกินโควตาได้ตามที่ ดร. เคาะ (เตือน ไม่บล็อก) — แพ็ก 10 ครั้ง นัดครั้งที่ 11–15 ผ่าน ` +
      `(${over.join(' ')}) · เคสมี ${booked} นัด · หน้าเคสขึ้นป้าย "เกินแพ็กที่ซื้อ ${booked - 10} ครั้ง"`,
  );
} else ok(`นัดเกินโควตาถูกกัน (${over.join(' ')})`);

// ค่าบริการของเคสขยับตามจำนวนนัดไหม — ไม่ควรขยับ (ขายเป็นแพ็ก)
if (Number(detail.body.fee) !== 15000) {
  hit('ค่าบริการของเคสเปลี่ยนเองเมื่อนัดเกินโควตา', `fee = ${detail.body.fee}`);
} else ok('ค่าบริการยังเป็น 15,000 ตามแพ็ก ไม่ขยับตามจำนวนนัด');

console.log(`\n=== สรุป: พบที่ต้องตัดสินใจ ${found.length} ข้อ ===`);
await new Promise((r) => server.close(r));
await pool.end();
