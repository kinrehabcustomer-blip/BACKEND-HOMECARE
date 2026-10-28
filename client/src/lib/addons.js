/**
 * อุปกรณ์เสริม + หัตถการของเคส อยู่ในรายการ addons เดียวกัน (ดู server/src/lib/addons.js)
 * หัตถการ = kind 'procedure' จำนวน 1 เสมอ และมีเลข VN ของตัวเองที่ server ออกให้ตอนบันทึก
 */
export const PROCEDURE = 'procedure';
export const isProcedure = (a) => a?.kind === PROCEDURE;

/** ข้อความบรรทัดในใบแจ้งหนี้ — ต้องตรงกับ addonLabel ใน server/src/lib/addons.js */
export const addonLabel = (a) =>
  isProcedure(a) ? `หัตถการ: ${a.name}${a.vn ? ` (${a.vn})` : ''}` : `อุปกรณ์เสริม: ${a.name}`;
