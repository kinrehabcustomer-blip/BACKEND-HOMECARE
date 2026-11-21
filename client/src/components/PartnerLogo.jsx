import { api } from '../api.js';

/**
 * โลโก้บริษัทพาร์ทเนอร์ (21 พ.ย. 2569) — ไม่มีโลโก้ = ตัวอักษรแรกของชื่อในวงกลม (fallback) หรือไม่แสดงเลย (fallback=false)
 * partner ต้องมี partner_id · has_logo · logo_version (server ส่งมาจากทุกเส้นของพาร์ทเนอร์)
 */
export default function PartnerLogo({ partner, size = 20, fallback = true, className = '' }) {
  if (!partner) return null;
  const style = { width: size, height: size };
  if (partner.has_logo) {
    return (
      <img className={`partner-logo ${className}`} style={style} alt="" aria-hidden="true"
        src={api.partnerLogoUrl(partner.partner_id, partner.logo_version)} />
    );
  }
  if (!fallback) return null;
  return (
    <span className={`partner-logo is-blank ${className}`} style={{ ...style, fontSize: Math.max(10, size * 0.45) }} aria-hidden="true">
      {partner.name?.trim()?.[0] ?? '?'}
    </span>
  );
}

/** ย่อรูปโลโก้ในเบราว์เซอร์ก่อนอัปโหลด — ด้านยาวสุด 512px · WebP (เก็บพื้นโปร่งใส ไม่เป็นพื้นดำแบบ JPEG) */
export async function logoDataUrl(file) {
  if (!file.type.startsWith('image/')) throw new Error('กรุณาเลือกไฟล์รูปภาพ (JPG, PNG หรือ WebP)');
  if (file.size > 10 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกินไป — จำกัดที่ 10 MB');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('เปิดไฟล์รูปไม่ได้ — ไฟล์อาจเสียหาย'); });
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL('image/webp', 0.92);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}
