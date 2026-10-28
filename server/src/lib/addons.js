/**
 * อุปกรณ์เสริม + หัตถการของเคส — รายการที่คิดเงินเพิ่มจากค่าบริการ [{ name, quantity, unit_price, kind?, vn? }]
 *
 * ยอดของแต่ละบรรทัดปัดสองตำแหน่งก่อนรวม ให้ตรงกับ addonsTotalSql ทุกสตางค์
 * (ป้าย "ไม่ตรงกับเคส" เทียบยอดจากสองฝั่งนี้ — ปัดคนละจังหวะแล้วจะขึ้นป้ายทั้งที่ยอดถูก)
 */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * หัตถการเพิ่มเติม (ทำแผล ใส่สาย ฯลฯ) เก็บในรายการเดียวกับอุปกรณ์เสริม แต่ติด kind: 'procedure'
 * และมีเลข VN ของตัวเอง (หนึ่งหัตถการ = หนึ่งครั้งที่ให้บริการ ดู cases/visitNumbers.js)
 * อยู่ในรายการเดียวกันเพื่อให้ยอดใบแจ้งหนี้ ป้าย "ไม่ตรงกับเคส" ใบส่วนที่เหลือ และใบเสร็จ ทำงานเหมือนกันทุกจุด
 */
export const PROCEDURE = 'procedure';
export const isProcedure = (a) => a?.kind === PROCEDURE;

/**
 * เรียงคีย์ตายตัวและตัดค่าแปลกปลอมทิ้ง — ใช้ทั้งตอนเก็บลงฐานข้อมูลและตอนเทียบว่าเปลี่ยนไหม
 * อุปกรณ์เสริมคงรูปเดิมทุกตัวอักษร { name, quantity, unit_price } — ข้อความของรายการนี้อยู่ใน service_key
 * ของใบแจ้งหนี้ ถ้าเติมคีย์ใหม่ให้ทุกบรรทัด ใบเก่าทั้งระบบจะขึ้นป้าย "แพ็คเกจไม่ตรง" ทันที
 * หัตถการเท่านั้นที่มี kind + vn ต่อท้าย (จำนวน 1 เสมอ — หนึ่งบรรทัดคือหนึ่งครั้ง)
 */
export const normalizeAddons = (addons) =>
  (Array.isArray(addons) ? addons : []).map((a) =>
    isProcedure(a)
      ? {
          name: String(a.name ?? '').trim(),
          quantity: 1,
          unit_price: Number(a.unit_price ?? 0),
          kind: PROCEDURE,
          vn: a.vn ? String(a.vn) : null,
        }
      : {
          name: String(a.name ?? '').trim(),
          quantity: Number(a.quantity ?? 1),
          unit_price: Number(a.unit_price ?? 0),
        },
  );

/** ข้อความบรรทัดในใบแจ้งหนี้ — ต้องตรงกับ addonLabel ใน client/src/lib/addons.js */
export const addonLabel = (a) =>
  isProcedure(a) ? `หัตถการ: ${a.name}${a.vn ? ` (${a.vn})` : ''}` : `อุปกรณ์เสริม: ${a.name}`;

export const addonAmount = (a) => round2(Number(a.quantity) * Number(a.unit_price));

export const addonsTotal = (addons) =>
  round2(normalizeAddons(addons).reduce((sum, a) => sum + addonAmount(a), 0));

/** ฉบับ SQL ของ addonsTotal — c = alias ของตารางที่มีคอลัมน์ addons (cases หรือ invoices) */
export const addonsTotalSql = (c) => `COALESCE((
    SELECT SUM(ROUND((a ->> 'quantity')::numeric * (a ->> 'unit_price')::numeric, 2))
    FROM jsonb_array_elements(${c}.addons) a), 0)::double precision`;
