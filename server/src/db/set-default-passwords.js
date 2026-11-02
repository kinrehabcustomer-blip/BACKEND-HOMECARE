import '../lib/env.js';
import { pool, sql } from './index.js';
import { hashPassword, DEFAULT_PASSWORD } from '../lib/auth.js';

/**
 * ตั้งรหัสผ่านของพนักงาน "ที่มีอยู่แล้วทุกคน" เป็นรหัสเริ่มต้น (DEFAULT_PASSWORD) และยกเลิกการบังคับเปลี่ยนรหัส
 * รันครั้งเดียวด้วยมือ: node src/db/set-default-passwords.js --yes
 *
 * ย้อนกลับไม่ได้ — รหัสเดิมของทุกคน (รวมที่เจ้าตัวตั้งเอง) จะหายไป
 * password_changed_at ถูกตั้งใหม่ด้วย เซสชันที่ login ค้างอยู่ทุกใบจึงถูกเด้งออกให้ login ใหม่ด้วยรหัสใหม่
 */
if (!process.argv.includes('--yes')) {
  const { n } = await sql.one('SELECT COUNT(*)::int AS n FROM employees');
  console.log(`จะตั้งรหัสผ่านของพนักงานทั้งหมด ${n} คนเป็นรหัสเริ่มต้น — ย้อนกลับไม่ได้`);
  console.log('ยืนยันด้วย: node src/db/set-default-passwords.js --yes');
  await pool.end();
  process.exit(0);
}

const updated = await sql.run(
  `UPDATE employees
      SET password_hash = :hash, must_change_password = FALSE, temp_password_encrypted = NULL,
          password_changed_at = now()`,
  { hash: await hashPassword(DEFAULT_PASSWORD) },
);
console.log(`ตั้งรหัสผ่านเริ่มต้นให้พนักงาน ${updated} คนแล้ว`);
await pool.end();
