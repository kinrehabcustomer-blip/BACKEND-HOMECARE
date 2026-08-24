import '../lib/env.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, sql } from './index.js';
import { hashPassword, generateTempPassword } from '../lib/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

await pool.query(schema);
console.log('สร้าง/อัปเดต schema บน Postgres เรียบร้อย');

// พนักงานที่มีอยู่ก่อนระบบ login เกิด ยังไม่มีรหัสผ่าน — ตั้งค่าเริ่มต้นเป็นรหัสพนักงานของตัวเอง
const pending = await sql.all('SELECT employee_id FROM employees WHERE password_hash IS NULL');

/* สุ่มรหัสชั่วคราวให้คนละใบ — เดิมตั้งเป็น "รหัสพนักงานของตัวเอง" ซึ่งเดาได้ทันทีจากภายนอก
   (รหัสเรียงเลขและโผล่อยู่ทุกหน้าจอ) รหัสที่สุ่มนี้ต้องจดไว้ตอนรัน เพราะฐานข้อมูลเก็บแต่ hash */
for (const { employee_id } of pending) {
  const temp = generateTempPassword();
  await sql.run('UPDATE employees SET password_hash = :hash WHERE employee_id = :id', {
    hash: await hashPassword(temp),
    id: employee_id,
  });
  console.log(`ตั้งรหัสผ่านชั่วคราวให้ ${employee_id} : ${temp}   <-- จดไว้แล้วส่งให้เจ้าตัว`);
}

console.log(pending.length ? `ตั้งรหัสผ่านให้ ${pending.length} คน` : 'ทุกคนมีรหัสผ่านแล้ว');
/* ---------- เติม "งวดที่" ย้อนหลังให้ค่าจ้างที่ปล่อยไปแล้ว ----------
 *
 * คอลัมน์ installment_no เพิ่งเกิด แถวเก่าทั้งหมดจึงเป็น 1 ตามค่าปริยาย ซึ่งอ่านแล้วผิด:
 * เคสที่ทยอยจ่ายมาสามครั้งจะขึ้นว่าเป็น "งวดที่ 1" ทั้งสามครั้ง แล้วตัวนับงวดที่เหลือก็เพี้ยนตาม
 *
 * หนึ่งงวด = การกดปล่อยหนึ่งครั้ง ซึ่งจับได้จาก released_at ที่ตรงกัน — releasePay ทำงานใน
 * transaction เดียว และ now() ของ Postgres คือเวลาเริ่ม transaction ทุกแถวที่ปล่อยพร้อมกัน
 * จึงมี released_at เท่ากันเป๊ะ (คนละคนแต่เป็นงวดเดียวกัน)
 *
 * DENSE_RANK ไล่ตามเวลาที่ปล่อยของแต่ละเคส — รันซ้ำได้ ผลลัพธ์เท่าเดิมเสมอ
 * และ WHERE บรรทัดท้ายทำให้รอบที่สองเป็น no-op จริงๆ ไม่ใช่แค่เขียนทับด้วยค่าเดิม
 */
const renumbered = await sql.run(
  `UPDATE case_payouts p
   SET installment_no = b.n
   FROM (
     SELECT payout_id,
            DENSE_RANK() OVER (PARTITION BY case_id ORDER BY released_at) AS n
     FROM case_payouts
   ) b
   WHERE b.payout_id = p.payout_id AND p.installment_no <> b.n`,
);

console.log(
  renumbered
    ? `เติมเลขงวดย้อนหลังให้ค่าจ้าง ${renumbered} ก้อน`
    : 'เลขงวดของค่าจ้างทุกก้อนถูกต้องอยู่แล้ว',
);

await pool.end();
