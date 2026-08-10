import '../lib/env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, sql } from './index.js';

/**
 * ล้างข้อมูลให้กลับไปเป็น "ระบบใหม่ที่ยังไม่เคยใช้" — เก็บไว้แค่สองอย่าง
 *   1. ตารางราคา: เกรด / รูปแบบบริการ / เรท Homecare และแพ็คเกจกายภาพบำบัด
 *   2. พนักงานคนแรก (ปริยาย EMP-0001 = ผู้จัดการ) พร้อมรหัสผ่านและรูปของเขา
 *
 * แล้วตั้งตัวนับรหัสใหม่ ให้ของถัดไปเริ่มที่ 0001 (ยกเว้นพนักงานที่เริ่มนับต่อจากคนที่เก็บไว้)
 *
 * ใช้ตอน "ล้างข้อมูลทดสอบก่อนเปิดใช้จริง" เท่านั้น — ลบแล้วกู้จากระบบไม่ได้
 * จึงบังคับสองชั้น: ต้องใส่ --yes เอง และสำรองข้อมูลลงไฟล์ให้ก่อนเสมอ
 *
 *   node src/db/reset.js            ดูว่าจะลบอะไรบ้าง (ไม่แตะฐานข้อมูล)
 *   node src/db/reset.js --yes      ลบจริง
 *   node src/db/reset.js --yes --keep=EMP-0002    เก็บคนอื่นแทน
 */

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const keep = (args.find((a) => a.startsWith('--keep=')) ?? '--keep=EMP-0001').split('=')[1];

// ลำดับการลบไล่จากตารางที่ถูกอ้างถึงน้อยที่สุดขึ้นไป — ลูกของแต่ละตัวหายตามเองด้วย FK CASCADE
// (invoice_items ← invoices · case_visits, case_events ← cases · ใบรับรอง/ผลงาน/OTP ← employees)
const STEPS = [
  ['invoices', 'DELETE FROM invoices', 'ใบแจ้งหนี้ (+ รายการย่อย)'],
  ['cases', 'DELETE FROM cases', 'เคส (+ กะงาน + ประวัติการทำรายการ)'],
  ['patients', 'DELETE FROM patients', 'ผู้รับการดูแล'],
  ['customers', 'DELETE FROM customers', 'ลูกค้า/ผู้ว่าจ้าง'],
  ['employees', 'DELETE FROM employees WHERE employee_id <> :keep', 'พนักงาน (ยกเว้นคนที่เก็บไว้)'],
  ['password_reset_otps', 'DELETE FROM password_reset_otps', 'OTP รีเซ็ตรหัสผ่านที่ค้างอยู่'],
];

// ของถัดไปเริ่มที่ 0001 · พนักงานนับต่อจากคนที่เก็บไว้ ไม่งั้นคนถัดไปจะได้รหัสชนกับเขา
const COUNTERS = { customer: 0, patient: 0, case: 0, invoice: 0 };

/** สำรองทุกตารางลงไฟล์ JSON ก่อนลบ — ตัดคอลัมน์รูปออก (BYTEA ทำให้ไฟล์บวมเป็นสิบเมกะไบต์) */
async function backup() {
  const tables = await sql.all(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );

  const dump = { taken_at: new Date().toISOString(), note: 'ไม่รวมคอลัมน์รูปภาพ (BYTEA)', tables: {} };
  for (const { table_name: t } of tables) {
    const cols = await sql.all(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = :t AND data_type <> 'bytea'
       ORDER BY ordinal_position`,
      { t },
    );
    dump.tables[t] = await sql.all(`SELECT ${cols.map((c) => `"${c.column_name}"`).join(', ')} FROM ${t}`);
  }

  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
  return file;
}

const person = await sql.one(
  'SELECT employee_id, first_name, last_name, position FROM employees WHERE employee_id = :keep',
  { keep },
);
if (!person) {
  console.error(`✗ ไม่พบพนักงาน ${keep} — ยกเลิก (ล้างแล้วจะไม่เหลือใครเข้าระบบได้เลย)`);
  await pool.end();
  process.exit(1);
}

console.log(`เก็บไว้: ${person.employee_id} ${person.first_name} ${person.last_name} (${person.position})`);
console.log('เก็บไว้: ตารางราคา Homecare (เกรด/รูปแบบ/เรท) และแพ็คเกจกายภาพบำบัด\n');

console.log('จะลบ:');
for (const [table, , label] of STEPS) {
  const where = table === 'employees' ? 'WHERE employee_id <> :keep' : '';
  const { n } = await sql.one(`SELECT COUNT(*) AS n FROM ${table} ${where}`, { keep });
  console.log(`  ${String(n).padStart(4)}  ${label}`);
}

if (!confirmed) {
  console.log('\nยังไม่ได้ลบอะไร — ใส่ --yes ถ้าต้องการลบจริง');
  await pool.end();
  process.exit(0);
}

console.log(`\nสำรองข้อมูลก่อน…`);
console.log(`  → ${await backup()}`);

for (const [, statement, label] of STEPS) {
  const n = await sql.run(statement, { keep });
  console.log(`ลบ ${label}: ${n} แถว`);
}

for (const [name, value] of Object.entries(COUNTERS)) {
  await sql.run(
    `INSERT INTO id_counters (name, value) VALUES (:name, :value)
     ON CONFLICT (name) DO UPDATE SET value = :value`,
    { name, value },
  );
}
// พนักงานนับต่อจากเลขของคนที่เก็บไว้ (EMP-0001 → คนถัดไปเป็น EMP-0002)
const kept = Number(person.employee_id.split('-')[1]);
await sql.run(
  `INSERT INTO id_counters (name, value) VALUES ('employee', :value)
   ON CONFLICT (name) DO UPDATE SET value = :value`,
  { value: kept },
);

console.log('\nตั้งตัวนับรหัสใหม่แล้ว — ของถัดไปจะเป็น CUS-0001 · PAT-0001 · CASE-0001 · INV-0001');
console.log(`พนักงานคนถัดไปจะเป็น EMP-${String(kept + 1).padStart(4, '0')}`);
await pool.end();
