import { ISSUER } from './issuer.js';

/** ชื่อรายการที่ลูกค้าเห็นบนใบ — ข้อมูลภายในหน้า staff ยังคงใช้ชื่อจริงตามเดิม */
export function customerAddonDescription(addon) {
  if (addon?.kind === 'sale') return String(addon.name ?? '').trim() || ISSUER.customerServiceDescription;
  return ISSUER.customerServiceDescription;
}

/**
 * ใบรายครั้งเก็บบรรทัดกะไว้ก่อน แล้วต่ออุปกรณ์ตามลำดับท้ายรายการ
 * ใช้ snapshot addons ของใบจับคู่ว่าบรรทัดท้ายเป็นเช่าหรือซื้อขาด โดยไม่เปลี่ยนยอด/จำนวนเดิม
 */
export function customerItemDescription(item, index) {
  const items = Array.isArray(item?.items) ? item.items : [];
  const addons = Array.isArray(item?.addons) ? item.addons : [];
  const addonStart = items.length - addons.length;
  if (addonStart >= 0 && index >= addonStart) {
    return customerAddonDescription(addons[index - addonStart]);
  }
  return ISSUER.customerServiceDescription;
}
