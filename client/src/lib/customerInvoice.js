import { ISSUER } from './issuer.js';

/** ชื่อรายการที่ลูกค้าเห็นบนใบ — ข้อมูลภายในหน้า staff ยังคงใช้ชื่อจริงตามเดิม */
export function customerAddonDescription(addon) {
  if (addon?.kind === 'sale') return String(addon.name ?? '').trim() || ISSUER.customerServiceDescription;
  // แพ็กกายภาพเสริมที่เก็บรวมในใบ Homecare — ลูกค้าต้องเห็นว่าจ่ายค่าคอร์สกายภาพอะไร ไม่ใช่ "ค่าบริการ" ซ้ำสองบรรทัด
  if (addon?.kind === 'physio') return `กายภาพบำบัด: ${String(addon.name ?? '').trim()}`;
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

/* คำนำหน้าที่มีอยู่ในชื่อแล้ว — เจอแล้วไม่เติม "คุณ" ซ้ำ (ผู้ใช้ขอ 9 พ.ย. 2569: ใบเสร็จขึ้น "คุณ คุณสมศรี")
   รวมชื่อนิติบุคคลด้วย — "คุณ บริษัท …" ผิดเหมือนกัน
   ติดกับชื่อได้ (คุณสมศรี) แต่ตัวถัดไปต้องเป็นพยัญชนะ/สระหน้า — "คุณากร" "นายิกา" เป็นชื่อจริง ไม่ใช่คำนำหน้า */
const HAS_TITLE = /^\s*(คุณ|นางสาว|นาง|นาย|น\.ส\.|ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง|ดร\.|นพ\.|พญ\.|ทพ\.|ทพญ\.|ภก\.|ภญ\.|ผศ\.|รศ\.|ศ\.|บริษัท|บจก\.?|หจก\.?|ห้างหุ้นส่วน|มูลนิธิ|โรงพยาบาล|Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.?)(\s|$|(?=[ก-ฮเแโใไA-Za-z]))/i;

/** ชื่อบนเอกสาร (ได้รับเงินจาก / จ่ายให้ / ช่องลงชื่อ) — เติม "คุณ " นำหน้าเฉพาะชื่อที่ยังไม่มีคำนำหน้า */
export const withTitle = (name) => {
  const n = String(name ?? '').trim();
  if (!n) return 'คุณ';
  return HAS_TITLE.test(n) ? n : `คุณ ${n}`;
};
