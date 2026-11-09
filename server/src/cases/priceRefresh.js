import * as cases from './repo.js';
import * as invoices from '../invoices/repo.js';
import { resolvePayer } from '../invoices/routes.js';

/**
 * แก้ราคาแพ็กกายภาพ/ตารางเรท Homecare แล้ว — ปรับราคาเต็มของเคสที่เปิดอยู่และขายราคาเดียวกับแพ็ก
 * (cases.refreshListPriceSnapshots) แล้วซิงก์ใบแจ้งหนี้ร่างของเคสเหล่านั้นให้ส่วนลดบนใบตรงกับระบบ
 *
 * ทำหลังบันทึกราคาแล้ว — พังตรงนี้ = log ไว้ ไม่ทำให้การแก้ราคาที่สำเร็จไปแล้วกลายเป็น error
 * ใบที่ออก/ส่งลูกค้า/รับเงินแล้วไม่ถูกแตะ (syncOpenFromCase ซิงก์เฉพาะใบร่าง) — คืนจำนวนไว้บอกผู้ใช้
 */
export async function refreshCasePrices(scope, actor) {
  try {
    const ids = await cases.refreshListPriceSnapshots(scope, actor);
    let drafts = 0;
    for (const id of ids) {
      const row = await cases.findById(id);
      if (row) drafts += await invoices.syncOpenFromCase(row, await resolvePayer(row));
    }
    return { cases: ids.length, drafts };
  } catch (err) {
    console.error('[price-refresh]', err?.message ?? err);
    return { cases: 0, drafts: 0, error: err?.message ?? String(err) };
  }
}
