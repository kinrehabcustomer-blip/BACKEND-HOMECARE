import { sql } from '../db/index.js';
import { ApiError } from './errors.js';
import { BLOCKED_STATUSES } from './auth.js';
import { ensureLineColumn, ensureLinkCodeTables, hashLinkCode, LINK_CODE_MAX_TRIES } from './lineBridge.js';

/**
 * ผูก LINE กับพนักงานด้วยรหัส 6 หลักที่แอดมินออกในหน้าพนักงาน (ดู lib/lineBridge.js)
 * ใช้ 2 ทาง: พิมพ์รหัสในแชท LINE @kinjobs (/api/integration/line-code) · กรอกในหน้าเข้าระบบที่เปิดจาก LINE (/api/auth/line-code)
 * → พนักงานที่ผูกแล้ว (แถวเต็ม) · รหัสผิด/หมดอายุ 400 · ลองผิดเกิน 5 ครั้ง/ชม. 429 · LINE ผูกคนอื่นอยู่ 409
 */
export async function linkLineByCode(lineUserId, code) {
  await ensureLineColumn();
  await ensureLinkCodeTables();

  const tries = await sql.one(
    `SELECT count(*)::int AS n FROM line_link_tries WHERE line_user_id = :uid AND at > now() - interval '1 hour'`,
    { uid: lineUserId },
  );
  if (tries.n >= LINK_CODE_MAX_TRIES) throw new ApiError(429, 'ใส่รหัสผิดหลายครั้ง รอ 1 ชั่วโมงแล้วลองใหม่ หรือขอรหัสใหม่จากผู้ประสานงาน');

  const row = /^\d{6}$/.test(String(code ?? ''))
    ? await sql.one('SELECT employee_id FROM line_link_codes WHERE code_hash = :h AND expires_at > now()', { h: hashLinkCode(code) })
    : null;
  const emp = row ? await sql.one('SELECT * FROM employees WHERE employee_id = :id', { id: row.employee_id }) : null;
  if (!emp || BLOCKED_STATUSES[emp.status]) {
    await sql.run('INSERT INTO line_link_tries (line_user_id) VALUES (:uid)', { uid: lineUserId });
    await sql.run(`DELETE FROM line_link_tries WHERE at < now() - interval '1 day'`);
    throw new ApiError(400, 'รหัสไม่ถูกต้องหรือหมดอายุ — ตรวจตัวเลขอีกครั้ง หรือขอรหัสใหม่จากผู้ประสานงาน');
  }

  const owner = await sql.one('SELECT employee_id FROM employees WHERE line_user_id = :uid', { uid: lineUserId });
  if (owner && owner.employee_id !== emp.employee_id) {
    throw new ApiError(409, 'LINE นี้ยืนยันตัวตนเป็นพนักงานคนอื่นอยู่แล้ว — ติดต่อผู้ประสานงานให้ยกเลิกที่บัญชีเดิมก่อน');
  }
  await sql.run('UPDATE employees SET line_user_id = :uid WHERE employee_id = :id', { uid: lineUserId, id: emp.employee_id });
  await sql.run('DELETE FROM line_link_codes WHERE employee_id = :id', { id: emp.employee_id });
  await sql.run('DELETE FROM line_link_tries WHERE line_user_id = :uid', { uid: lineUserId });
  return { ...emp, line_user_id: lineUserId };
}
