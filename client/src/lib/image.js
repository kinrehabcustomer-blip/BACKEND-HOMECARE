const MAX_EDGE = 1600; // ด้านยาวสุดหลังย่อ — พอให้ซูมอ่านตัวหนังสือบนใบรับรองได้
const QUALITY = 0.82;
const MAX_INPUT_BYTES = 20 * 1024 * 1024; // รูปจากกล้องมือถือรุ่นใหม่ ~5-10 MB

export const ACCEPTED = 'image/jpeg,image/png,image/webp';

/**
 * ย่อรูปในเบราว์เซอร์ก่อนอัปโหลด แล้วคืนเป็น data URL
 *
 * ทำฝั่งนี้เพราะรูปถ่ายจากมือถือใบละ 5-10 MB — ถ้าส่งดิบๆ จะกินพื้นที่ฐานข้อมูลและอัปโหลดช้ามาก
 * ย่อแล้วเหลือราว 100-300 KB โดยยังอ่านตัวหนังสือบนใบรับรองออก
 */
export async function compressImage(file) {
  if (!file.type.startsWith('image/')) {
    throw new Error('กรุณาเลือกไฟล์รูปภาพ (JPG, PNG หรือ WebP)');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`ไฟล์ใหญ่เกินไป (${(file.size / 1024 / 1024).toFixed(1)} MB) — จำกัดที่ 20 MB`);
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('เปิดไฟล์รูปไม่ได้ — ไฟล์อาจเสียหาย');
  });

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext('2d');
  // รูป PNG โปร่งใสจะกลายเป็นพื้นดำเมื่อแปลงเป็น JPEG — ทาพื้นขาวรองไว้ก่อน
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas.toDataURL('image/jpeg', QUALITY);
}

export const formatFileSize = (bytes) =>
  bytes == null ? '' : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
