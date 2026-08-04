import { forwardRef } from 'react';
import { ACCEPTED } from '../lib/image.js';

/* ไอคอนเส้นชุดเดียวกับเมนูด้านข้าง (stroke=currentColor จึงเปลี่ยนสีตามปุ่มเอง)
   ไม่ใช้อีโมจิ 📎/📷 เพราะฟอนต์ Sarabun ไม่มีอักขระพวกนี้ บางเครื่องจึงขึ้นเป็นกล่องสี่เหลี่ยม */
const ICONS = {
  upload: (<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></>),
  camera: (<><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="3.5" /></>),
};

/**
 * ปุ่มเลือกไฟล์ที่ใช้ร่วมกันทุกที่ (ใบรับรอง / ผลงาน / รูปพนักงาน / เซลฟี่เช็คอิน)
 *
 * <input type="file"> จัดหน้าตาเองไม่ได้ ทุกจุดจึงต้องซ่อน input แล้วครอบด้วย <label>
 * รวมมาไว้ที่เดียวเพื่อให้ไอคอน ระยะห่าง และสถานะ "กำลังย่อรูป" เหมือนกันหมด
 *
 * ส่ง ref ทะลุไปที่ <input> เพราะผู้เรียกต้องล้าง .value เองหลังบันทึก
 * (ไม่ล้างแล้วเลือกไฟล์ชื่อเดิมซ้ำจะไม่เกิด onChange)
 */
const FileButton = forwardRef(function FileButton(
  { children, icon = 'upload', accept = ACCEPTED, capture, disabled = false, busy = false, onPick },
  ref,
) {
  const off = disabled || busy;

  return (
    // label กด :disabled ไม่ได้ (ไม่ใช่ปุ่มจริง) จึงใช้ aria-disabled สื่อสถานะทั้งกับ CSS และ screen reader
    <label className="btn file-btn" aria-disabled={off}>
      <svg
        className="file-btn-ico"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {ICONS[icon]}
      </svg>
      {busy ? 'กำลังย่อรูป…' : children}
      <input type="file" ref={ref} accept={accept} capture={capture} hidden disabled={off} onChange={onPick} />
    </label>
  );
});

export default FileButton;
