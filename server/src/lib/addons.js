/**
 * อุปกรณ์เสริมของเคส — รายการที่คิดเงินเพิ่มจากค่าบริการ [{ name, quantity, unit_price }]
 *
 * ยอดของแต่ละบรรทัดปัดสองตำแหน่งก่อนรวม ให้ตรงกับ addonsTotalSql ทุกสตางค์
 * (ป้าย "ไม่ตรงกับเคส" เทียบยอดจากสองฝั่งนี้ — ปัดคนละจังหวะแล้วจะขึ้นป้ายทั้งที่ยอดถูก)
 */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** เรียงคีย์ตายตัวและตัดค่าแปลกปลอมทิ้ง — ใช้ทั้งตอนเก็บลงฐานข้อมูลและตอนเทียบว่าเปลี่ยนไหม */
export const normalizeAddons = (addons) =>
  (Array.isArray(addons) ? addons : []).map((a) => ({
    name: String(a.name ?? '').trim(),
    quantity: Number(a.quantity ?? 1),
    unit_price: Number(a.unit_price ?? 0),
  }));

export const addonAmount = (a) => round2(Number(a.quantity) * Number(a.unit_price));

export const addonsTotal = (addons) =>
  round2(normalizeAddons(addons).reduce((sum, a) => sum + addonAmount(a), 0));

/** ฉบับ SQL ของ addonsTotal — c = alias ของตารางที่มีคอลัมน์ addons (cases หรือ invoices) */
export const addonsTotalSql = (c) => `COALESCE((
    SELECT SUM(ROUND((a ->> 'quantity')::numeric * (a ->> 'unit_price')::numeric, 2))
    FROM jsonb_array_elements(${c}.addons) a), 0)::double precision`;
