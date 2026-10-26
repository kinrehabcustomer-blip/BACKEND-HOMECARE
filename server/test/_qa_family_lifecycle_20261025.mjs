/**
 * ชุดทดสอบ SQL ของ family.lifecycleDue() — ข้อความปิดเคส + เตือนก่อนหมดสิทธิ์ 3 วัน (ดร.ธงชัย 25 ต.ค. 2569)
 * ยก PostgreSQL ชั่วคราวจาก src/db/schema.sql แล้วถามจริง ๆ ว่าเคสไหนเข้ากลุ่มไหน
 * 🔴 ไม่แตะฐานจริง ไม่ยิง LINE — คลัสเตอร์ชั่วคราวใน temp แล้วลบทิ้ง
 * รัน:  cd backend-homecare/server && node test/_qa_family_lifecycle_20261025.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const probe = createServer();
await new Promise((r, j) => { probe.once('error', j); probe.listen(0, '127.0.0.1', r); });
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const directory = await mkdtemp(join(resolve(tmpdir()), 'kin-lifecycle-test-'));
const password = randomBytes(24).toString('hex');
const pg = new EmbeddedPostgres({
  databaseDir: join(directory, 'data'), port, user: 'postgres', password, persistent: true,
  initdbFlags: ['--encoding=UTF8'], postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {},
});

const R = { pass: 0, fail: 0 };
const ok = (c, m, d) => { if (c) { R.pass++; console.log(`  OK  ${m}`); } else { R.fail++; console.log(`  XX  ${m}${d ? `\n        ${typeof d === 'string' ? d : JSON.stringify(d)}` : ''}`); } };
const head = (t) => console.log(`\n== ${t} ==`);

let started = false;
try {
  await pg.initialise();
  await pg.start();
  started = true;
  await pg.createDatabase('kin_lifecycle_test');
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:${password}@127.0.0.1:${port}/kin_lifecycle_test?sslmode=disable`;
  process.env.JWT_SECRET = randomBytes(48).toString('hex');

  const { sql, pool } = await import('../src/db/index.js');
  await pool.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  await pool.query(
    `INSERT INTO employees (employee_id,first_name,last_name,nickname,position,status,phone)
     VALUES ('EMP-0003','สมใจ','ใจดี','ตุ้ม','caregiver','active','0812345678')`);
  const family = await import('../src/lib/family.js');
  await family.ensureFamilyTable();

  head('0 · สูตรวันหมดสิทธิ์ต้องเป็นชิ้นเดียวกับด่าน 30 วันที่ใช้จริง');
  ok(family.WITHIN_GRACE.startsWith(family.CASE_ENDED_AT),
    'CASE_ENDED_AT เป็นหัวของ WITHIN_GRACE จริง (วันที่ที่บอกญาติตรงกับวันที่ระบบปิดประตู)');
  ok(family.withinDays('fresh').includes(':fresh') && !family.withinDays('fresh').includes(':grace'),
    'withinDays() เปลี่ยนชื่อพารามิเตอร์ครบทุกจุด');

  // เวลาที่เก็บใน cases.closed_at เป็นข้อความเวลาไทย (cases/repo.js: to_char(now() AT TIME ZONE 'Asia/Bangkok'))
  const agoText = async (days) =>
    (await sql.one(
      `SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok' - make_interval(days => :d), 'YYYY-MM-DD HH24:MI:SS') AS t`,
      { d: days })).t;

  let n = 0;
  /** เคสที่ปิด/ยกเลิกมาแล้ว agoDays วัน พร้อมญาติผูก LINE (เว้นแต่ withFamily=false) */
  const closedCase = async ({ agoDays, field = 'closed_at', status = 'closed', withFamily = true, client = 'สมศรี ทดสอบ' }) => {
    const id = `CASE-${String(++n).padStart(4, '0')}`;
    await sql.run(
      `INSERT INTO cases (case_id,title,case_type,client_name,status,assigned_to,fee,staff_pay)
       VALUES (:id,'ทดสอบ','other',:cn,'assigned','EMP-0003',2000,1200)`, { id, cn: client });
    await sql.run(`UPDATE cases SET status = :st, ${field} = :at WHERE case_id = :id`,
      { id, st: status, at: agoDays == null ? null : await agoText(agoDays) });
    if (withFamily) {
      const inv = await family.createInvite(id, 'แอดมินทดสอบ');
      // รับคำเชิญตรง ๆ ไม่ได้เมื่อเคสปิดไปแล้ว — ผูกญาติไว้ก่อนแล้วค่อยปิด ไม่ได้เพราะ createInvite ต้องมีเคสก่อน
      // จึงเขียน accepted_at ลงตารางตรง (จำลองญาติที่ผูกไว้ตั้งแต่เคสยังเปิด)
      await sql.run(
        `UPDATE case_family_links SET line_user_id = :uid, display_name = 'ลูกสาว', accepted_at = now()
         WHERE case_id = :id AND code_hash = :h`,
        { id, uid: `U${String(n).padStart(2, '0')}${'a'.repeat(30)}`, h: family.hashCode(inv.code) });
    }
    return id;
  };

  head('1 · เคสเพิ่งปิด → กลุ่ม closed');
  const fresh = await closedCase({ agoDays: 0 });
  const day1 = await closedCase({ agoDays: 1 });
  const day5 = await closedCase({ agoDays: 5 });
  let due = await family.lifecycleDue();
  ok(due.grace_days === family.CLOSED_GRACE_DAYS, `grace_days มาจาก CLOSED_GRACE_DAYS (${due.grace_days})`, due.grace_days);
  const closedIds = due.closed.map((c) => c.case_id);
  ok(closedIds.includes(fresh) && closedIds.includes(day1), 'ปิดวันนี้และเมื่อวาน = อยู่ในกลุ่ม closed', closedIds);
  ok(!closedIds.includes(day5), 'ปิดไป 5 วันแล้ว = ไม่อยู่ในกลุ่ม closed (กันยิงย้อนหลังรวดเดียวตอน deploy)', closedIds);
  ok(!due.expiring.some((c) => c.case_id === day5), 'ปิด 5 วัน ยังไม่ถึงคิวเตือน', due.expiring.map((c) => c.case_id));
  const f = due.closed.find((c) => c.case_id === fresh);
  ok(f?.client_first === 'สมศรี', 'ส่งแค่ชื่อต้น ไม่มีนามสกุล', f);
  ok(Array.isArray(f?.family) && f.family.length === 1, 'มี LINE ของญาติที่ผูกแล้ว', f?.family);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(f?.access_until || ''), 'มีวันสุดท้ายที่เปิดดูได้', f?.access_until);
  ok(f?.days_left >= family.CLOSED_GRACE_DAYS - 1 && f?.days_left <= family.CLOSED_GRACE_DAYS + 1,
    `เพิ่งปิด → เหลือสิทธิ์ราว ${family.CLOSED_GRACE_DAYS} วัน`, f?.days_left);

  head('2 · เหลือสิทธิ์ ≤3 วัน → กลุ่ม expiring');
  const g = family.CLOSED_GRACE_DAYS;
  const left2 = await closedCase({ agoDays: g - 2 });
  const left3 = await closedCase({ agoDays: g - 3 });
  const left4 = await closedCase({ agoDays: g - 4 });
  const over = await closedCase({ agoDays: g + 2 });
  due = await family.lifecycleDue();
  const exp = due.expiring.map((c) => c.case_id);
  ok(exp.includes(left2) && exp.includes(left3), 'เหลือ 2–3 วัน = เข้าคิวเตือน', exp);
  ok(!exp.includes(left4), 'เหลือ 4 วัน = ยังไม่เตือน (เตือนล่วงหน้า 3 วันพอดี)', exp);
  ok(!exp.includes(over) && !due.closed.some((c) => c.case_id === over),
    'เคสที่พ้น 30 วันแล้ว = ไม่อยู่ในคิวใด ๆ (สิทธิ์หมดแล้ว ไม่ตามไปรบกวน)', { exp, closed: due.closed.map((c) => c.case_id) });
  const e2 = due.expiring.find((c) => c.case_id === left2);
  ok(e2?.days_left >= 1 && e2.days_left <= 3, 'days_left อยู่ในช่วง 1–3 วัน', e2?.days_left);

  head('3 · เคสยกเลิก (cancelled_at) ต้องนับเหมือนปิด');
  const cancelled = await closedCase({ agoDays: 0, field: 'cancelled_at', status: 'cancelled' });
  due = await family.lifecycleDue();
  ok(due.closed.some((c) => c.case_id === cancelled), 'ยกเลิกเคส = ได้ข้อความปิดเคสเหมือนกัน', due.closed.map((c) => c.case_id));

  head('4 · เคสที่ต้องไม่อยู่ในคิว');
  const noFamily = await closedCase({ agoDays: 0, withFamily: false });
  const openCase = await closedCase({ agoDays: null, status: 'assigned' });
  const noDate = await closedCase({ agoDays: null, status: 'closed' });
  const revoked = await closedCase({ agoDays: 0 });
  await sql.run('UPDATE case_family_links SET revoked_at = now() WHERE case_id = :id', { id: revoked });
  due = await family.lifecycleDue();
  const all = [...due.closed, ...due.expiring].map((c) => c.case_id);
  ok(!all.includes(noFamily), 'เคสที่ไม่มีญาติผูก LINE = ไม่อยู่ในคิว', all);
  ok(!all.includes(openCase), 'เคสที่ยังเปิดอยู่ = ไม่อยู่ในคิว', all);
  ok(!all.includes(noDate), 'ปิดแล้วแต่ไม่มีวันปิดบันทึกไว้ = ไม่อยู่ในคิว (ถือว่าหมดอายุ เหมือน WITHIN_GRACE)', all);
  ok(!all.includes(revoked), 'ญาติถูกปลดสิทธิ์แล้ว = ไม่อยู่ในคิว', all);

  head('5 · เคสเดียวต้องไม่ได้สองใบในรอบเดียว');
  const both = await family.lifecycleDue({ closedWindowDays: 99, leadDays: 99 });
  const dup = both.closed.map((c) => c.case_id).filter((id) => both.expiring.some((e) => e.case_id === id));
  ok(dup.length === 0, 'ตั้งค่าให้ทับกันทั้งหมด ก็ยังไม่มีเคสไหนอยู่สองกลุ่มพร้อมกัน', dup);

  head('6 · ชื่อผู้ป่วยว่าง');
  await closedCase({ agoDays: 0, client: '' });
  due = await family.lifecycleDue();
  ok(due.closed.every((c) => c.client_first === null || (typeof c.client_first === 'string' && c.client_first.length > 0)),
    'ชื่อว่าง → คืน null ไม่ใช่สตริงว่าง (ฝั่ง chat จะได้เลือกคำแทนได้)', due.closed.map((c) => c.client_first));

  await pool.end();
} finally {
  if (started) await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n== สรุป: ผ่าน ${R.pass} · ไม่ผ่าน ${R.fail} ==`);
process.exitCode = R.fail ? 1 : 0;
