/**
 * แก้จุดเสี่ยงระบบนัดกายภาพ 4 ข้อ (ดร.ธงชัย 2 พ.ย. 2569 "แก้ 4 ข้อแรกเลย")
 *   1 ลบนัด = แจ้งเหมือนยกเลิก · 2 ข้อความเตือนเก่า (นัดเปลี่ยน/ลบ/เลยเวลา) ถูกข้ามก่อนส่ง + ack ไม่ประทับตรานัดใหม่
 *   3 รายการส่งไม่สำเร็จจนหมดรอบขึ้นสรุป (failedVisitNotifications)
 *   node test/_run_probe.mjs test/_qa_visit_notify_fix_20261102.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');
const V = await import('../src/notify/visitReminders.js');

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
const del = (p) => call('DELETE', p);
let pass = 0;
const ok = (c, m, d) => { assert.ok(c, `${m} ${d ? JSON.stringify(d) : ''}`); pass++; console.log('PASS |', m); };
const age = () => sql.run(`UPDATE visit_change_outbox SET created_at = created_at - interval '5 minutes' WHERE claimed_at IS NULL`);
const bkk = (h) => new Date(Date.now() + 7 * 3600e3 + h * 3600e3).toISOString();
const dateAt = (h) => bkk(h).slice(0, 10);

const c = await post('/api/cases', { case_id: 'VN900000888', case_type: 'other', client_name: 'คุณทดสอบลบนัด', service_kind: 'physio', fee: 15000 });
ok(c.status === 201, 'เปิดเคสทดสอบ', c.body);
const id = c.body.case_id;
await post(`/api/cases/${id}/assign`, { employee_id: 'EMP-0003' });
await sql.run(`UPDATE employees SET line_user_id = 'Utestline0003' WHERE employee_id = 'EMP-0003'`);
const add = async (h, start) => {
  const r = await post(`/api/cases/${id}/visits`, { visit_date: dateAt(h), planned_start: start, assigned_to: 'EMP-0003' });
  return r.body.visits.find((v) => v.visit_date === dateAt(h) && v.planned_start === start).visit_id;
};
await V.claimVisitChanges(); // ล้างคิวเก่า

// ---- ข้อ 1: ลบนัด = แจ้งเหมือนยกเลิก ----
const v1 = await add(48, '10:00');
const d1 = await del(`/api/cases/${id}/visits/${v1}`);
ok(d1.status < 300, 'ลบนัดทีละใบสำเร็จ', d1.body);
await age();
let ch = await V.claimVisitChanges();
ok(ch.some((x) => x.visit_id === v1 && x.kind === 'cancelled' && x.old.staff?.line_user_id === 'Utestline0003'), 'ลบนัดใบเดียว → แจ้งพนักงานว่ายกเลิก', ch);
const q1 = await sql.one(`SELECT count(*)::int n FROM visit_notification_outbox WHERE visit_id = :v AND event_kind = 'cancelled'`, { v: v1 });
ok(q1.n >= 1, 'ข้อความแจ้งยกเลิกเข้าคิวส่ง LINE แล้ว', q1);

const v2 = await add(72, '11:00');
const d2 = await call('DELETE', `/api/cases/${id}/visits?dates=${dateAt(72)}`);
ok(d2.status < 300 && d2.body.deleted >= 1, 'ลบนัดทั้งวันสำเร็จ', d2.body);
await age();
ch = await V.claimVisitChanges();
ok(ch.some((x) => x.visit_id === v2 && x.kind === 'cancelled'), 'ลบนัดทั้งวัน → แจ้งยกเลิก', ch);

const vPast = (await post(`/api/cases/${id}/visits`, { visit_date: '2026-01-05', assigned_to: 'EMP-0003' })).body.visits.find((v) => v.visit_date === '2026-01-05').visit_id;
await del(`/api/cases/${id}/visits/${vPast}`);
await age();
ok(!(await V.claimVisitChanges()).some((x) => x.visit_id === vPast), 'ลบนัดในอดีต → ไม่แจ้งใคร (แก้บันทึกย้อนหลัง)');

// ---- ข้อ 2: ข้อความเตือนเก่าถูกข้ามก่อนส่ง ----
const v3 = await add(30, '14:00');
const ins = async (key, data, kind = 'day') => (await sql.one(
  `INSERT INTO visit_notification_outbox (dedupe_key, channel, recipient_line_user_id, event_kind, visit_id, payload)
   VALUES (:key, 'staff', 'Utestline0003', :kind, :v, :p::jsonb) RETURNING id`,
  { key, kind, v: v3, p: JSON.stringify({ type: 'staff_reminder', data }) })).id;
const good = await ins('qa-good', { visit_date: dateAt(30), planned_start: '14:00', client_name: 'คุณทดสอบลบนัด' });
const stale = await ins('qa-stale', { visit_date: dateAt(30), planned_start: '09:00', client_name: 'คุณทดสอบลบนัด' });
let got = await V.claimVisitNotificationOutbox();
ok(got.some((r) => r.id === good), 'ข้อความที่ตรงกับนัดจริง → ส่งตามปกติ', got);
ok(!got.some((r) => r.id === stale), 'ข้อความของเวลานัดเดิม (ถูกย้ายแล้ว) → ไม่ส่ง');
const st = await sql.one(`SELECT attempts, error FROM visit_notification_outbox WHERE id = :id`, { id: stale });
ok(st.attempts === 99 && st.error.startsWith(V.SKIPPED_PREFIX), 'ข้อความเก่าถูกติดป้าย "ข้าม:" ไม่นับเป็นส่งพลาด', st);

// ack ของนัดเดิมที่ส่งช้า ต้องไม่ประทับตรานัดใหม่
await patch(`/api/cases/${id}/visits/${v3}`, { visit_date: dateAt(54) });
await V.ackVisitNotificationOutbox([{ id: good, ok: true }]);
const stamp = await sql.one(`SELECT remind_day_at FROM case_visits WHERE visit_id = :v`, { v: v3 });
ok(stamp.remind_day_at === null, 'ข้อความนัดเดิมส่งช้า → ไม่บังการเตือนของวันนัดใหม่', stamp);

// นัดถูกยกเลิกระหว่างรอส่งซ้ำ → ไม่ส่ง
const after = await ins('qa-cancel', { visit_date: dateAt(54), planned_start: '14:00' });
await patch(`/api/cases/${id}/visits/${v3}`, { status: 'cancelled' });
got = await V.claimVisitNotificationOutbox();
ok(!got.some((r) => r.id === after), 'นัดถูกยกเลิกระหว่างรอส่ง → "พรุ่งนี้มีนัด" ไม่ถูกส่ง');

// ---- ข้อ 3: ส่งไม่สำเร็จจนหมดรอบขึ้นสรุป ----
await sql.run(`INSERT INTO visit_notification_outbox (dedupe_key, channel, recipient_line_user_id, event_kind, visit_id, payload, attempts, error)
  VALUES ('qa-failed', 'family', 'Ufam', 'family', :v, :p::jsonb, 5, 'LINE push failed 403: blocked')`,
  { v: v3, p: JSON.stringify({ type: 'family_reminder', data: { visit_date: dateAt(54), client_name: 'คุณทดสอบลบนัด' } }) });
const failed = await V.failedVisitNotifications(24);
ok(failed.some((f) => f.error.includes('403') && f.client_name === 'คุณทดสอบลบนัด'), 'ส่งพลาดครบ 5 รอบ → ขึ้นรายการสรุป', failed);
ok(!failed.some((f) => f.error.startsWith(V.SKIPPED_PREFIX)), 'ข้อความที่ตั้งใจข้าม ไม่ขึ้นเป็นส่งพลาด');

console.log(`\nผ่าน ${pass} ข้อ`);
await new Promise((r) => server.close(r));
await pool.end();
