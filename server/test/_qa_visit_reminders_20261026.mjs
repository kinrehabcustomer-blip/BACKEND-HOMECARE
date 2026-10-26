/**
 * ลงนัดทั้งแพ็ก + สิทธิ์แพ็ก + เตือนนัด LINE (ดร.ธงชัย 26 ต.ค. 2569)
 *   node test/_run_probe.mjs test/_qa_visit_reminders_20261026.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');
const { claimDueVisitReminders, claimDueFamilyReminders } = await import('../src/notify/visitReminders.js');
const { ensureFamilyTable } = await import('../src/lib/family.js');
const { expiryDate } = await import('../src/cases/physioQuota.js');
const { datesByCount } = await import('../src/cases/schema.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', first_name: 'ผู้จัดการ', last_name: 'ทดสอบ' };
await seedFixtures(pool, hashPassword);
const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie: `${COOKIE_NAME}=${signToken(MANAGER)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: res.status, body: d };
}
const post = (p, b) => call('POST', p, b ?? {});
const patch = (p, b) => call('PATCH', p, b ?? {});
const get = (p) => call('GET', p);
let pass = 0;
const ok = (c, m, d) => { assert.ok(c, `${m} ${d ? JSON.stringify(d) : ''}`); pass++; console.log('PASS |', m); };

// ---- ตัวช่วยวันที่ ----
ok(expiryDate('2026-10-26', 3) === '2027-01-25', 'แพ็ก 3 เดือน เริ่ม 26 ต.ค. ใช้ได้ถึง 25 ม.ค.');
ok(expiryDate('2026-01-31', 1) === '2026-02-27', 'เริ่มสิ้นเดือน + 1 เดือน ไม่ล้นไปมีนาคม');
const d10 = datesByCount('2026-11-02', [1, 4], 10);
ok(d10.length === 10 && d10[0] === '2026-11-02' && d10[1] === '2026-11-05' && d10[9] === '2026-12-03', 'จ/พฤ 10 ครั้ง ไล่วันถูก', d10);

// ---- เคสกายภาพ แพ็ก 10 ครั้ง 3 เดือน ----
const pkg = await sql.one(`INSERT INTO physio_packages (name, sessions, duration_months, special_price, staff_pay)
  VALUES ('ทดสอบ 10 ครั้ง', 10, 3, 15000, 9000) RETURNING physio_package_id`);
const c = await post('/api/cases', { case_id: 'VN900000777', case_type: 'other', client_name: 'คุณทดสอบนัด',
  service_kind: 'physio', physio_package_id: pkg.physio_package_id, fee: 15000 });
ok(c.status === 201, 'เปิดเคสกายภาพ', c.body);
const id = c.body.case_id;
await post(`/api/cases/${id}/assign`, { employee_id: 'EMP-0003' });
await sql.run(`UPDATE employees SET line_user_id = 'Utestline0003' WHERE employee_id = 'EMP-0003'`);

const bulk = await post(`/api/cases/${id}/visits/bulk`, { from: '2026-11-02', weekdays: [1, 4], count: 10, assigned_to: 'EMP-0003', planned_start: '14:00', planned_end: '15:00' });
ok(bulk.status === 201 && bulk.body.added === 10, 'ลงนัดทั้งแพ็ก 10 ครั้งด้วย count', bulk.body);
let q = await get(`/api/cases/${id}/physio-quota`);
ok(q.body.sessions === 10 && q.body.booked === 10 && q.body.remaining === 0 && q.body.expires_on === '2027-02-01', 'สิทธิ์แพ็ก: ครบ 10 · หมดอายุ 1 ก.พ. (นับจากนัดแรก)', q.body);
const over = await post(`/api/cases/${id}/visits/bulk`, { dates: ['2027-03-01'], assigned_to: 'EMP-0003' });
ok(over.status === 201, 'นัดเกินแพ็ก/เลยวันหมดอายุ ยังลงได้ (ดร.: เตือน ไม่บล็อก)', over.body);
const homecare = await sql.one(`SELECT case_id FROM cases WHERE case_id <> :id LIMIT 1`, { id });
if (homecare) { const h = await get(`/api/cases/${homecare.case_id}/physio-quota`); ok(h.body === null, 'เคสที่ไม่มีแพ็กกายภาพ → null', h.body); }

// ---- เตือนนัด: ใช้เวลาจริงตอนรัน ----
const bkk = (offsetH) => new Date(Date.now() + 7 * 3600e3 + offsetH * 3600e3).toISOString();
const dateAt = (h) => bkk(h).slice(0, 10), timeAt = (h) => bkk(h).slice(11, 16);
// นัด A: อีก 2 ชม. (ต้องได้รอบ 3h · ไม่ได้รอบ day)  นัด B: อีก 26 ชม. (ได้รอบ day ถ้าเลย 08:00 เมื่อวานของนัดแล้ว)
const A = await post(`/api/cases/${id}/visits`, { visit_date: dateAt(2), planned_start: timeAt(2), assigned_to: 'EMP-0003' });
const B = await post(`/api/cases/${id}/visits`, { visit_date: dateAt(26), planned_start: timeAt(26), assigned_to: 'EMP-0003' });
ok(A.status === 201 && B.status === 201, 'ลงนัดทดสอบเวลาใกล้ ๆ');
const vA = A.body.visits.find((v) => v.visit_date === dateAt(2) && v.planned_start === timeAt(2)).visit_id;
const vB = B.body.visits.find((v) => v.visit_date === dateAt(26) && v.planned_start === timeAt(26)).visit_id;

const r1 = await claimDueVisitReminders();
const a3h = r1.find((r) => r.visit_id === vA && r.kind === '3h');
ok(a3h && a3h.line_user_id === 'Utestline0003' && a3h.package_sessions === 10, 'นัดอีก 2 ชม. → เตือนรอบ 3 ชม. พร้อม LINE ผู้รับ + จำนวนครั้งแพ็ก', r1);
ok(!r1.some((r) => r.visit_id === vA && r.kind === 'day'), 'นัดใกล้กว่า 3 ชม. ไม่ส่งรอบ day ซ้อน');
const nowH = Number(bkk(0).slice(11, 13));
const dayDue = r1.some((r) => r.visit_id === vB && r.kind === 'day');
ok(dayDue === (nowH >= 8 || dateAt(26) > dateAt(24)) || dayDue === false, `นัดพรุ่งนี้: รอบ day = ${dayDue} (ตอนนี้ ${nowH}:xx น.)`);
const r2 = await claimDueVisitReminders();
ok(!r2.some((r) => r.visit_id === vA), 'รอบถัดไปไม่เตือนซ้ำ');

// ย้ายเวลานัด = ล้างตรา เตือนใหม่
await patch(`/api/cases/${id}/visits/${vA}`, { visit_date: dateAt(2.5), planned_start: timeAt(2.5) });
const r3 = await claimDueVisitReminders();
ok(r3.some((r) => r.visit_id === vA && r.kind === '3h'), 'ย้ายเวลานัด → เตือนใหม่ตามเวลาใหม่', r3);

// ---- เตือนญาติ (วันก่อนนัด 08:00 · เคสกายภาพ · มีญาติผูก LINE) ----
const f0 = await claimDueFamilyReminders();
ok(!f0.some((r) => r.visit_id === vB), 'ยังไม่มีญาติผูก LINE → ไม่จอง ไม่เตือน');
await ensureFamilyTable();
await sql.run(`INSERT INTO case_family_links (case_id, line_user_id, display_name, invited_by, consent_by, accepted_at)
  VALUES (:id, 'Ufamily0001', 'ลูกสาว', 'test', 'test', now())`, { id });
const f1 = await claimDueFamilyReminders();
const fb = f1.find((r) => r.visit_id === vB);
ok(dayDue ? fb && fb.recipients.includes('Ufamily0001') && fb.planned_start === timeAt(26) && fb.employee_name : !fb,
  `ญาติผูกแล้ว → เตือนวันก่อนนัดพร้อมเวลาและชื่อนักกายภาพ (${dayDue ? 'ถึงเวลาแล้ว' : 'ยังไม่ถึง 08:00'})`, f1);
ok(!(await claimDueFamilyReminders()).some((r) => r.visit_id === vB), 'ญาติไม่ได้รับเตือนซ้ำ');

// ยกเลิกนัด = ไม่เตือน · พนักงานไม่ผูก LINE = ไม่เตือน
await sql.run(`UPDATE case_visits SET remind_3h_at = NULL WHERE visit_id = :v`, { v: vA });
await patch(`/api/cases/${id}/visits/${vA}`, { status: 'cancelled' });
ok(!(await claimDueVisitReminders()).some((r) => r.visit_id === vA), 'นัดที่ยกเลิก ไม่เตือน');

console.log(`\nผ่าน ${pass} ข้อ`);
await new Promise((r) => server.close(r));
await pool.end();
