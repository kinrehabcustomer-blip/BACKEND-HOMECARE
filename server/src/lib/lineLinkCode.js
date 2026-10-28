import { sql, transaction } from '../db/index.js';
import { ApiError } from './errors.js';
import { BLOCKED_STATUSES } from './auth.js';
import {
  ensureLineColumn,
  ensureLinkCodeTables,
  ensureTicketUsedTable,
  hashLinkCode,
  hashTicket,
  LINK_CODE_MAX_TRIES,
} from './lineBridge.js';

/**
 * ผูก LINE กับพนักงานด้วยรหัส 6 หลักที่แอดมินออกในหน้าพนักงาน (ดู lib/lineBridge.js)
 * ใช้ 2 ทาง: พิมพ์รหัสในแชท LINE @kinjobs (/api/integration/line-code) · กรอกในหน้าเข้าระบบที่เปิดจาก LINE (/api/auth/line-code)
 * → พนักงานที่ผูกแล้ว (แถวเต็ม) · รหัสผิด/หมดอายุ 400 · ลองผิดเกิน 5 ครั้ง/ชม. 429 · LINE ผูกคนอื่นอยู่ 409
 */
export async function linkLineByCode(lineUserId, code, { ticket = null } = {}) {
  await ensureLineColumn();
  await ensureLinkCodeTables();
  if (ticket) {
    await ensureTicketUsedTable();
    await sql.run(`DELETE FROM line_ticket_used WHERE used_at < now() - interval '1 day'`);
  }

  const tries = await sql.one(
    `SELECT count(*)::int AS n FROM line_link_tries WHERE line_user_id = :uid AND at > now() - interval '1 hour'`,
    { uid: lineUserId },
  );
  if (tries.n >= LINK_CODE_MAX_TRIES) throw new ApiError(429, 'ใส่รหัสผิดหลายครั้ง รอ 1 ชั่วโมงแล้วลองใหม่ หรือขอรหัสใหม่จากผู้ประสานงาน');

  const result = /^\d{6}$/.test(String(code ?? ''))
    ? await transaction(async (tx) => {
        // claim แบบใช้ครั้งเดียวจริง: DELETE ... RETURNING อยู่ transaction เดียวกับการผูกพนักงาน
        const claimed = await tx.one(
          'DELETE FROM line_link_codes WHERE code_hash = :h AND expires_at > now() RETURNING employee_id',
          { h: hashLinkCode(code) },
        );
        if (!claimed) return { reason: 'invalid' };
        const emp = await tx.one('SELECT * FROM employees WHERE employee_id = :id FOR UPDATE', { id: claimed.employee_id });
        if (!emp || BLOCKED_STATUSES[emp.status]) return { reason: 'invalid' };
        const owner = await tx.one('SELECT employee_id FROM employees WHERE line_user_id = :uid', { uid: lineUserId });
        if (owner && owner.employee_id !== emp.employee_id) return { reason: 'owner' };
        if (emp.line_user_id && emp.line_user_id !== lineUserId) return { reason: 'employee_linked' };
        if (ticket) {
          const fresh = await tx.run(
            `INSERT INTO line_ticket_used (token_hash, employee_id)
             VALUES (:h, :id) ON CONFLICT DO NOTHING`,
            { h: hashTicket(ticket), id: emp.employee_id },
          );
          // โยนเพื่อ rollback ทั้งการ DELETE รหัสและการ claim เมื่อเป็นตั๋วซ้ำ
          if (!fresh) throw new ApiError(409, 'ลิงก์จาก LINE นี้ถูกใช้แล้ว กรุณากดปุ่มใน LINE @kinjobs เพื่อเปิดลิงก์ใหม่');
        }
        const linked = await tx.one(
          `UPDATE employees SET line_user_id = :uid
            WHERE employee_id = :id AND (line_user_id IS NULL OR line_user_id = :uid)
            RETURNING *`,
          { uid: lineUserId, id: emp.employee_id },
        );
        if (!linked) return { reason: 'employee_linked' };
        await tx.run('DELETE FROM line_link_codes WHERE employee_id = :id', { id: emp.employee_id });
        await tx.run('DELETE FROM line_link_tries WHERE line_user_id = :uid', { uid: lineUserId });
        return { employee: linked };
      })
    : { reason: 'invalid' };
  if (result.reason === 'invalid') {
    await sql.run('INSERT INTO line_link_tries (line_user_id) VALUES (:uid)', { uid: lineUserId });
    await sql.run(`DELETE FROM line_link_tries WHERE at < now() - interval '1 day'`);
    throw new ApiError(400, 'รหัสไม่ถูกต้องหรือหมดอายุ — ตรวจตัวเลขอีกครั้ง หรือขอรหัสใหม่จากผู้ประสานงาน');
  }
  if (result.reason === 'owner') {
    throw new ApiError(409, 'LINE นี้ยืนยันตัวตนเป็นพนักงานคนอื่นอยู่แล้ว — ติดต่อผู้ประสานงานให้ยกเลิกที่บัญชีเดิมก่อน');
  }
  if (result.reason === 'employee_linked') {
    throw new ApiError(409, 'พนักงานนี้ยืนยันตัวตนด้วย LINE อื่นอยู่แล้ว — ติดต่อผู้ประสานงานให้ยกเลิกบัญชีเดิมก่อน');
  }
  return result.employee;
}
