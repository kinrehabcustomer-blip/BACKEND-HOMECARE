/*
 * ไอคอนเส้นชุดเดียวกับเมนูด้านข้างและปุ่มเลือกไฟล์ (Lucide-style)
 *
 * stroke=currentColor จึงเปลี่ยนสีตามปุ่มที่มันอยู่เอง — ทั้งโหมดสว่าง/มืด และปุ่มพื้นทอง
 * ไม่ใช้อีโมจิ (🖨 ⬇) เพราะสองเหตุผล:
 *   1. ฟอนต์ Sarabun ไม่มีอักขระพวกนี้ บางเครื่องจึงขึ้นเป็นกล่องสี่เหลี่ยม
 *   2. อีโมจิพกสีของตัวเองมา ไม่ตามธีม เลยดูหลุดจากปุ่มที่อยู่ข้างๆ
 */
const PATHS = {
  printer: (
    <>
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="7" rx="1" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
};

export default function LineIcon({ name, className = 'btn-ico' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
