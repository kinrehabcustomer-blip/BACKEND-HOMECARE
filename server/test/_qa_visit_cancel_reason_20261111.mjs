/** ยกเลิกนัดพร้อมหมายเหตุ → หมายเหตุลงกะ + ประวัติ + คิวแจ้ง LINE + กระดิ่งพนักงาน (11 พ.ย. 2569)
 *   node test/_run_probe.mjs test/_qa_visit_cancel_reason_20261111.mjs */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');
const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { claimVisitChanges } = await import('../src/notify/visitReminders.js');
const { seedFixtures } = await import('./fixtures.js');
await seedFixtures(pool, hashPassword);
const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const cookie = `${COOKIE_NAME}=${signToken({ employee_id: 'EMP-0001', position: 'manager', name: 'ผจก' })}`;
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { cookie, 'content-type': 'application/json' }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const day = (n) => new Date(Date.now() + 7 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
let bad = 0; const check = (c, msg, d) => { console.log(`${c ? 'PASS' : 'BUG '} | ${msg}${c ? '' : ` | ${JSON.stringify(d)}`}`); if (!c) bad++; };

const c = (await call('POST', '/api/cases', { case_id: 'VN900000555', case_type: 'other', client_name: 'คุณยกเลิก', service_kind: 'physio', fee: 15000, assigned_to: 'EMP-0003', start_date: day(-10) })).body;
await call('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [day(-3), day(2)], assigned_to: 'EMP-0003', planned_start: '09:00', planned_end: '10:00' });
const visits = (await call('GET', `/api/cases/${c.case_id}/visits`)).body;
const list = Array.isArray(visits) ? visits : visits.visits ?? visits.data;
const past = list.find((v) => v.visit_date === day(-3));
check(past?.state === 'missed', `นัดที่เลยวัน = ขาดงาน (${past?.state})`);

const r = await call('PATCH', `/api/cases/${c.case_id}/visits/${past.visit_id}`, { status: 'cancelled', cancel_reason: 'ผู้รับบริการไม่สบาย' });
check(r.status === 200, `ยกเลิกพร้อมหมายเหตุ → ${r.status}`, r.body);
const row = await sql.one('SELECT status, note FROM case_visits WHERE visit_id = :id', { id: past.visit_id });
check(row.status === 'cancelled' && row.note === 'ยกเลิก: ผู้รับบริการไม่สบาย', `หมายเหตุลงกะ: "${row.note}"`, row);
const ev = await sql.one(`SELECT detail FROM case_events WHERE case_id = :id AND detail LIKE '%เหตุผล%' ORDER BY 1 DESC LIMIT 1`, { id: c.case_id }).catch((e) => ({ detail: e.message }));
check(ev?.detail?.includes('ผู้รับบริการไม่สบาย'), `ประวัติเคส: ${ev?.detail}`, ev);
const inbox = await sql.one(`SELECT payload FROM staff_notifications WHERE visit_id = :id AND kind = 'visit_cancelled'`, { id: past.visit_id });
check(inbox?.payload?.reason === 'ผู้รับบริการไม่สบาย', 'กระดิ่งพนักงานมีหมายเหตุ', inbox);
await sql.run("UPDATE visit_change_outbox SET created_at = now() - interval '5 minutes'");
const changes = await claimVisitChanges();
const ch = changes.find((x) => x.visit_id === past.visit_id);
check(ch?.kind === 'cancelled' && ch?.reason === 'ผู้รับบริการไม่สบาย', `คิวแจ้ง LINE: kind=${ch?.kind} reason=${ch?.reason}`, changes);

// ยกเลิกแบบเดิม (ไม่มีหมายเหตุ) ของนัดในอดีต ยังไม่แจ้งเหมือนเดิม · นัดอนาคตแจ้งได้แม้ไม่มีหมายเหตุ
const fut = list.find((v) => v.visit_date === day(2));
await call('PATCH', `/api/cases/${c.case_id}/visits/${fut.visit_id}`, { status: 'cancelled' });
await sql.run("UPDATE visit_change_outbox SET created_at = now() - interval '5 minutes'");
const ch2 = (await claimVisitChanges()).find((x) => x.visit_id === fut.visit_id);
check(ch2?.kind === 'cancelled' && ch2.reason === null, 'นัดอนาคตไม่มีหมายเหตุ → แจ้งยกเลิก reason=null', ch2);
// ลบนัดที่ยังไม่ถึงวันพร้อมหมายเหตุ → แจ้งยกเลิกพร้อมเหตุผล + ประวัติเคส
await call('POST', `/api/cases/${c.case_id}/visits/bulk`, { dates: [day(5)], assigned_to: 'EMP-0003', planned_start: '09:00' });
const fut5 = ((await call('GET', `/api/cases/${c.case_id}/visits`)).body).find((v) => v.visit_date === day(5));
const del = await call('DELETE', `/api/cases/${c.case_id}/visits/${fut5.visit_id}`, { reason: 'ลูกค้าขอเลื่อนนัด' });
check(del.status === 200, `ลบนัดพร้อมหมายเหตุ → ${del.status}`, del.body);
await sql.run("UPDATE visit_change_outbox SET created_at = now() - interval '5 minutes'");
const ch3 = (await claimVisitChanges()).find((x) => x.visit_id === fut5.visit_id);
check(ch3?.kind === 'cancelled' && ch3.reason === 'ลูกค้าขอเลื่อนนัด', `ลบนัด → คิวแจ้ง LINE reason=${ch3?.reason}`, ch3);
const ev2 = await sql.one(`SELECT detail FROM case_events WHERE case_id = :id AND detail LIKE '%ลูกค้าขอเลื่อนนัด%'`, { id: c.case_id });
check(Boolean(ev2), `ประวัติเคสมีเหตุผลการลบ: ${ev2?.detail}`);
const long = await call('PATCH', `/api/cases/${c.case_id}/visits/${past.visit_id}`, { cancel_reason: 'x'.repeat(301) });
check(long.status === 400, `หมายเหตุยาวเกิน 300 ถูกกัน (${long.status})`);
console.log(`\nสรุป: พบปัญหา ${bad} ข้อ`);
server.close(); await pool.end();
