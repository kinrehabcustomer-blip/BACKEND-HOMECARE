/**
 * รอบตรวจ 12A — "ฝั่งครอบครัวของผู้ป่วย" (25 ต.ค. 2569)
 * ยก PostgreSQL ชั่วคราวจาก src/db/schema.sql แล้วเดินเส้นทางของญาติจริง ๆ
 *   รับรหัสเชิญ · ส่งซ้ำ · รหัสคนอื่น · หมดอายุ · เคสปิด · เพดาน 5 คน · หน้าสรุป · โพสต์/รูป · ปลดสิทธิ์
 * 🔴 ไม่แตะฐานจริง ไม่ยิง LINE — คลัสเตอร์ชั่วคราวใน temp แล้วลบทิ้ง
 * รัน:  cd backend-homecare/server && node test/_qa_family_20261025.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { randomBytes } from 'node:crypto';

const probe = createServer();
await new Promise((r, j) => { probe.once('error', j); probe.listen(0, '127.0.0.1', r); });
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const root = resolve(tmpdir());
const directory = await mkdtemp(join(root, 'kin-api-test-'));
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
  await pg.createDatabase('kin_api_test');
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:${password}@127.0.0.1:${port}/kin_api_test?sslmode=disable`;
  process.env.JWT_SECRET = randomBytes(48).toString('hex');

  const { sql, pool } = await import('../src/db/index.js');
  await pool.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  await pool.query(
    `INSERT INTO employees (employee_id,first_name,last_name,nickname,position,status,phone)
     VALUES ('EMP-0003','สมใจ','ใจดี','ตุ้ม','caregiver','active','0812345678')`);
  const family = await import('../src/lib/family.js');
  await family.ensureFamilyTable();

  let n = 0;
  const newCase = async (client = 'สมศรี ทดสอบ') => {
    const id = `CASE-${String(++n).padStart(4, '0')}`;
    await sql.run(
      `INSERT INTO cases (case_id,title,case_type,client_name,status,assigned_to,fee,staff_pay)
       VALUES (:id,'ทดสอบ','other',:cn,'assigned','EMP-0003',2000,1200)`, { id, cn: client });
    return id;
  };
  const U = (k) => `U${String(k).repeat(32).slice(0, 32)}`;
  const DAUGHTER = U('a'), SON = U('b'), AUNT = U('c'), STRANGER = U('d');

  // ---------------------------------------------------------------- รับรหัสเชิญ
  head('1 · ญาติรับรหัสเชิญในแชท OA');
  const c1 = await newCase();
  const inv1 = await family.createInvite(c1, 'แอดมินทดสอบ');
  const first = await family.accept(inv1.code, DAUGHTER, 'ลูกสาว');
  ok(first.ok && first.first, 'ลูกสาวพิมพ์รหัสครั้งแรก = ผูกสำเร็จ', first);

  const again = await family.accept(inv1.code, DAUGHTER, 'ลูกสาว');
  ok(again.ok, 'ลูกสาวกดส่งรหัสเดิมซ้ำ (เน็ตกระตุก) ต้องถือว่าสำเร็จตามที่คอมเมนต์เขียนไว้', again);

  const stolen = await family.accept(inv1.code, SON, 'ลูกชาย');
  ok(stolen.reason === 'used', 'ลูกชายเอารหัสเดิมจากกลุ่มไลน์มาใช้ = "used" (ไม่ใช่ not_found)', stolen);
  ok(!stolen.client_name, 'คนที่ใช้รหัสซ้ำต้องไม่ได้ชื่อผู้ป่วยติดไปด้วย', stolen);

  ok((await family.accept('ZZZZZZ', STRANGER, 'คนแปลกหน้า')).reason === 'not_found', 'รหัสมั่ว = not_found');

  const expInv = await family.createInvite(c1, 'แอดมิน');
  let collision = null;
  try {
    await sql.run(
      `INSERT INTO case_family_links (case_id, code_hash, code_expires_at, invited_by, consent_by)
       VALUES (:id, :hash, now() + interval '7 days', 'ทดสอบชน', 'ทดสอบชน')`,
      { id: c1, hash: family.hashCode(expInv.code) },
    );
  } catch (error) {
    collision = error;
  }
  ok(collision?.code === '23505', 'รหัสเชิญที่ยังใช้ได้ต้องมี unique index กันชนที่ฐานข้อมูล', collision?.message);
  await sql.run(`UPDATE case_family_links SET code_expires_at = now() - interval '1 day' WHERE code_hash = :h`,
    { h: family.hashCode(expInv.code) });
  ok((await family.accept(expInv.code, SON, 'ลูกชาย')).reason === 'expired', 'รหัสเกิน 7 วัน = expired');

  // ญาติที่ผูกแล้ว ได้รหัสใบใหม่ของ "เคสเดิม" (ทีมออกให้ใหม่เพราะคิดว่ายังไม่ได้ผูก)
  const dupInv = await family.createInvite(c1, 'แอดมิน');
  let dupRes, dupErr = null;
  try { dupRes = await family.accept(dupInv.code, DAUGHTER, 'ลูกสาว'); } catch (e) { dupErr = e; }
  ok(!dupErr && dupRes?.ok, 'ญาติที่ผูกอยู่แล้วพิมพ์รหัสใบใหม่ของเคสเดิม = ถือว่าสำเร็จ (ไม่ใช่ 500)', dupErr?.message || dupRes);
  ok((await family.activeCount(c1)) <= 5 && (await sql.one(
    `SELECT count(*)::int AS n FROM case_family_links WHERE case_id = :id AND line_user_id = :u AND revoked_at IS NULL`,
    { id: c1, u: DAUGHTER })).n === 1, 'ไม่เกิดแถวซ้ำของญาติคนเดิมในเคสเดียวกัน');
  ok(!(await sql.one(`SELECT accepted_at FROM case_family_links WHERE code_hash = :h`, { h: family.hashCode(dupInv.code) }))?.accepted_at,
    'รหัสใบใหม่ไม่ถูกเผาทิ้ง — ญาติคนอื่นยังใช้ได้');

  // ---------------------------------------------------------------- เพดาน 5 คน
  head('2 · เพดาน 5 คนต่อเคส');
  const c2 = await newCase('ประเสริฐ ทดสอบ');
  const head1 = await family.createInvite(c2, 'แอดมิน');
  await family.accept(head1.code, DAUGHTER, 'ลูกสาว');
  for (let i = 0; i < 4; i += 1) {
    const r = await family.familyInvite(DAUGHTER, c2);
    ok(r.ok, `ลูกสาวชวนญาติคนที่ ${i + 2} ได้`, r);
  }
  const over = await family.familyInvite(DAUGHTER, c2);
  ok(over.reason === 'full', 'คนที่ 6 ต้องถูกปฏิเสธด้วยเหตุผล full', over);
  const sum2 = (await family.summaryFor(DAUGHTER)).find((x) => x.case_id === c2);
  ok(sum2, 'หน้า /family เห็นเคสนี้');
  const shown = sum2.family.length + (sum2.family_pending || 0);
  console.log(`        หน้าจอขึ้นว่า "ญาติที่ดูเคสนี้ (${shown}/${sum2.family_max})" · can_invite=${sum2.can_invite} · ของจริง activeCount=${await family.activeCount(c2)}`);
  ok(shown === (await family.activeCount(c2)),
    'ตัวเลขบนจอต้องตรงกับที่ระบบใช้ตัดสินเพดาน (รวมคำเชิญที่ยังไม่มีใครกดรับ)', { shown, real: await family.activeCount(c2) });
  ok(!(shown < sum2.family_max && over.reason === 'full'), 'จอไม่โชว์ว่ายังว่าง ทั้งที่กดชวนแล้วได้ full');

  // ---------------------------------------------------------------- หน้าสรุป
  head('3 · ข้อมูลที่ญาติเห็นในหน้า /family');
  const c3 = await newCase('มานี ทดสอบ');
  const i3 = await family.createInvite(c3, 'แอดมิน');
  await family.accept(i3.code, AUNT, 'ป้า');
  const today = (await sql.one(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') AS d`)).d;
  await sql.run(
    `INSERT INTO case_visits (case_id,visit_date,assigned_to,status,checked_in_by,check_in_at,check_out_at)
     VALUES (:id,:d,'EMP-0003','done','EMP-0003',now() - interval '4 hours',now() - interval '2 hours')`, { id: c3, d: today });
  await sql.run(
    `INSERT INTO case_visits (case_id,visit_date,assigned_to,status) VALUES (:id,:d,'EMP-0003','cancelled')`,
    { id: c3, d: today });
  // รายงาน 2 ใบในวันเดียว: ใบเช้ากรอกเวลา · ใบเย็นไม่ได้กรอกเวลา (ช่องนี้เว้นได้)
  await sql.run(
    `INSERT INTO case_reports (case_id,report_date,report_time,symptoms,reported_by,reported_by_name,created_at)
     VALUES (:id,:d,'08:30','เช้า: สบายดี','EMP-0003','สมใจ ใจดี', :d || ' 08:35:00')`, { id: c3, d: today });
  await sql.run(
    `INSERT INTO case_reports (case_id,report_date,symptoms,reported_by,reported_by_name,created_at)
     VALUES (:id,:d,'เย็น: ไข้ขึ้น 38.5','EMP-0003','สมใจ ใจดี', :d || ' 19:10:00')`, { id: c3, d: today });
  const s3 = (await family.summaryFor(AUNT))[0];
  ok(s3.visits.length === 1, 'กะที่ถูกยกเลิกต้องไม่โผล่ในรายการเข้าเยี่ยม', s3.visits);
  ok(s3.visits[0].staff === 'สมใจ (ตุ้ม)', 'ชื่อผู้ดูแลเป็นชื่อต้น+ชื่อเล่น ไม่มีนามสกุล/เบอร์', s3.visits[0]);
  ok(!JSON.stringify(s3).includes('0812345678') && !JSON.stringify(s3).includes('ใจดี'),
    'ไม่มีเบอร์/นามสกุลพนักงาน และไม่มีค่าจ้างหลุดไปหน้าญาติ');
  ok(!JSON.stringify(s3).includes('1200') && !JSON.stringify(s3).includes('2000'), 'ไม่มีค่าจ้าง/ค่าบริการหลุด');
  console.log('        รายงานที่ส่งถึงจอญาติ:', JSON.stringify(s3.reports.map((r) => ({ date: r.date, time: r.time, s: r.summary }))));
  const evening = s3.reports.find((r) => r.summary.startsWith('เย็น'));
  ok(evening && evening.time, 'รายงานที่ผู้ดูแลไม่ได้กรอก "เวลาที่วัด" ต้องยังมีเวลาให้หน้าญาติเรียง (ไม่งั้นจมไปอยู่ 00:00 ของวันนั้น)', evening);
  ok(s3.reports[0]?.summary?.startsWith('เย็น'), 'รายงานใบล่าสุดของวันต้องมาก่อน', s3.reports.map((r) => r.summary));

  // ---------------------------------------------------------------- เคสจบแล้ว
  head('4 · เคสปิดแล้ว (เขตผ่อนผัน 30 วัน)');
  const closeAt = (id, days, col = 'closed_at', st = 'closed') =>
    sql.run(`UPDATE cases SET status = :st, ${col} = to_char(now() - make_interval(days => :d),'YYYY-MM-DD') WHERE case_id = :id`,
      { id, d: days, st });
  await closeAt(c3, 5);
  ok((await family.summaryFor(AUNT)).length === 1, 'ปิดมา 5 วัน ญาติยังเปิดดูได้');
  await closeAt(c3, 40);
  ok((await family.summaryFor(AUNT)).length === 0, 'ปิดมา 40 วัน หน้าสรุปต้องว่าง');
  ok(!(await family.memberLink(AUNT, c3)), 'ปิดมา 40 วัน โพสต์/เปิดรูปไม่ได้');
  const lateInv = await family.createInvite(c3, 'แอดมิน');
  ok((await family.accept(lateInv.code, STRANGER, 'หลาน')).reason === 'case_closed', 'รับคำเชิญเคสที่ปิดนานแล้วไม่ได้');

  const c4 = await newCase('ยกเลิก ทดสอบ');
  const i4 = await family.createInvite(c4, 'แอดมิน');
  await family.accept(i4.code, AUNT, 'ป้า');
  await closeAt(c4, 40, 'cancelled_at', 'cancelled');
  ok(!(await family.memberLink(AUNT, c4)), 'เคสที่ "ยกเลิก" (ไม่ใช่ปิด) เกิน 30 วัน ต้องหมดสิทธิ์เหมือนกัน');

  // ---------------------------------------------------------------- ปลดสิทธิ์ + ข้อความ
  head('5 · ปลดสิทธิ์ · ข้อความในไทม์ไลน์');
  const c5 = await newCase('สมพร ทดสอบ');
  const i5 = await family.createInvite(c5, 'แอดมิน');
  await family.accept(i5.code, DAUGHTER, 'ลูกสาว');
  const m1 = await family.postMessage(c5, { kind: 'family', name: 'ลูกสาว', lineUserId: DAUGHTER, body: 'คุณแม่กินข้าวได้ไหมคะ' });
  await family.postMessage(c5, { kind: 'team', name: 'พยาบาล · ทีม KIN HomeCare', employeeId: 'EMP-0003', body: 'กินได้ปกติค่ะ' });
  ok((await family.messagesFor(c5)).length === 2, 'ไทม์ไลน์มี 2 ข้อความ');
  await family.hideMessage(c5, m1.message_id);
  ok((await family.messagesFor(c5)).length === 1, 'ข้อความที่ทีมลบ ต้องหายจากจอญาติ');
  const rows = await sql.one('SELECT count(*)::int AS n FROM case_family_messages WHERE case_id = :id', { id: c5 });
  ok(rows.n === 2, 'ลบ = ซ่อนแถว (ดร. เคาะ 25 ต.ค.) — แถวยังอยู่ในฐาน');

  const links = await family.listForCase(c5);
  await family.revoke(c5, links[0].link_id);
  ok((await family.summaryFor(DAUGHTER)).every((x) => x.case_id !== c5), 'ถูกปลดแล้ว เปิดลิงก์เก่าไม่เห็นเคสนี้อีก');
  ok(!(await family.memberLink(DAUGHTER, c5)), 'ถูกปลดแล้ว โพสต์/เปิดรูปไม่ได้');
  const reInv = await family.createInvite(c5, 'แอดมิน');
  let reErr = null;
  try { await family.accept(reInv.code, DAUGHTER, 'ลูกสาว'); } catch (e) { reErr = e; }
  ok(!reErr, 'ปลดแล้วเชิญกลับเข้ามาใหม่ได้ (ดัชนี unique ต้องไม่ขวาง)', reErr?.message);

  // ---------------------------------------------------------------- ญาติที่ผูกหลายเคส
  head('6 · ญาติที่ดูทั้งพ่อและแม่');
  const cDad = await newCase('พ่อ ทดสอบ'), cMom = await newCase('แม่ ทดสอบ');
  for (const cid of [cDad, cMom]) {
    const iv = await family.createInvite(cid, 'แอดมิน');
    await family.accept(iv.code, SON, 'ลูกชาย');
  }
  const both = await family.summaryFor(SON);
  ok(both.length >= 2, 'หน้า /family แสดงทั้งสองเคส', both.map((x) => x.client_name));
  ok(new Set(both.map((x) => x.case_id)).size === both.length, 'ไม่มีเคสซ้ำ');

  console.log(`\nสรุป: ผ่าน ${R.pass} · ไม่ผ่าน ${R.fail}`);
  await pool.end();
  process.exitCode = R.fail ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (started) await pg.stop();
  const childPath = relative(root, resolve(directory));
  if (!childPath.startsWith('kin-api-test-') || childPath.includes('..') || childPath.includes('/') || childPath.includes('\\')) {
    throw new Error('Refusing to remove a directory outside the test temp root');
  }
  await rm(directory, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
