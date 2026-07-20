import '../lib/env.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, sql } from './index.js';
import { hashPassword } from '../lib/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

await pool.query(schema);
console.log('สร้าง/อัปเดต schema บน Postgres เรียบร้อย');

// พนักงานที่มีอยู่ก่อนระบบ login เกิด ยังไม่มีรหัสผ่าน — ตั้งค่าเริ่มต้นเป็นรหัสพนักงานของตัวเอง
const pending = await sql.all('SELECT employee_id FROM employees WHERE password_hash IS NULL');

for (const { employee_id } of pending) {
  await sql.run('UPDATE employees SET password_hash = :hash WHERE employee_id = :id', {
    hash: await hashPassword(employee_id),
    id: employee_id,
  });
  console.log(`ตั้งรหัสผ่านเริ่มต้นให้ ${employee_id}`);
}

console.log(pending.length ? `ตั้งรหัสผ่านให้ ${pending.length} คน` : 'ทุกคนมีรหัสผ่านแล้ว');
await pool.end();
