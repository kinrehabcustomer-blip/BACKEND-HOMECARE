import { cloneElement, isValidElement } from 'react';
import { useIsMobile } from '../lib/mobile.js';
import { useFilterSheet } from '../lib/filterSheet.jsx';

/**
 * แถบค้นหา + ตัวกรองของหน้ารายการ (ผู้ใช้ขอออกแบบใหม่บนมือถือ 6 พ.ย. 2569)
 *
 * จอกว้าง (>600px): วาด .toolbar แบบเดิมทุกอย่าง — ช่องค้นหา · dropdown · ล้างตัวกรอง · extra · ปุ่มหลัก เรียงแถวเดียว
 *
 * มือถือ (≤600px): dropdown 3–5 ช่องเรียงกันกินจอไปครึ่งหน้าก่อนจะเห็นรายการแรก จึงเหลือแถวเดียว
 *   [🔍 ค้นหา……] [ตัวกรอง ②] [+]
 *   [ปี 2569 ✕] [กำลังให้บริการ ✕] [ล้างทั้งหมด]   ← โผล่เฉพาะตอนมีตัวกรองติดอยู่
 * dropdown ทั้งหมดย้ายไปอยู่ในแผ่น "ตัวกรอง" ที่เลื่อนลงมาจากขอบบนของจอ (เลือกแล้วมีผลทันทีเหมือนเดิม)
 *
 * ชิปอ่านจาก <select> จริงในแผ่น (SearchSelect ก็เป็น <select> จริงข้างใต้) — ไม่ต้องให้ทุกหน้าส่งรายการชิปมาเอง
 * แผ่นจึงต้อง mount ค้างไว้ตลอด (แค่ซ่อน) ชิปถึงอ่านค่าได้ตอนแผ่นปิด
 * แผ่น portal ไปที่ body — .pull-content ของดึงรีเฟรชใส่ transform ตอนดึง ซึ่งจะลาก position: fixed ไปด้วย
 */

/* ไอคอนบนปุ่มหลักบนมือถือ (ปุ่มกลมทอง ไม่มีข้อความ) — บอกว่า "เพิ่มอะไร" ด้วยรูป ไม่ใช่ + เฉยๆ ทุกหน้า
   เส้นแบบเดียวกับไอคอนเมนู (Lucide-style ปลายมน) · มี + ติดอยู่ในทุกรูป */
const ACTION_ICONS = {
  case: (<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 14h6M12 11v6" /></>),
  employee: (<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></>),
  customer: (<><path d="M2 21a8 8 0 0 1 13.29-6" /><circle cx="10" cy="8" r="5" /><path d="M19 16v6M22 19h-6" /></>),
  patient: (<><path d="M14.48 19.37l-.97.94a2 2 0 0 1-3 .02L5 15c-1.5-1.5-3-3.2-3-5.5A5.5 5.5 0 0 1 7.5 4c1.76 0 3 .5 4.5 2 1.5-1.5 2.74-2 4.5-2a5.5 5.5 0 0 1 5.4 6.5" /><path d="M15 15h6M18 12v6" /></>),
  plus: (<path d="M12 5v14M5 12h14" />),
};

const Ico = ({ children }) => (
  <svg className="fbar-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/**
 * search     = ช่องค้นหา (ไม่บังคับ — หน้าตารางงานไม่มี)
 * lead       = ของที่อยู่หน้าสุดของแถว เช่น ปุ่มสลับ เดือน/สัปดาห์ ของหน้าตารางงาน
 * extra      = ของเพิ่มก่อนปุ่มหลัก (ปุ่มรอออกใบ / ปุ่มพิมพ์ / ข้อความสรุป)
 * actionIcon = ไอคอนของปุ่มหลักบนมือถือ (คีย์ใน ACTION_ICONS) — ใส่แล้วบนมือถือปุ่มกลายเป็นปุ่มกลมทองมีไอคอน
 *              ไม่ใส่ = วาดปุ่มหลักตามที่ส่งมา (หน้าตารางงานซ่อนกลุ่มปุ่มเลื่อนเดือนบนมือถือด้วย CSS แล้ววางไว้ที่หัวแทน)
 * className  = คลาสเพิ่มของแถบ (เช่น no-print)
 */
export default function FilterBar({
  search = null, lead = null, filters, filtered, onClear, extra = null, action = null, actionIcon = null, className = '',
}) {
  const mobile = useIsMobile();
  const fs = useFilterSheet({ filters, filtered, onClear });
  const cls = className ? ` ${className}` : '';

  if (!mobile) {
    return (
      <div className={`toolbar${cls}`}>
        {lead}
        {search}
        {filters}
        {filtered && <button type="button" className="btn" onClick={onClear}>ล้างตัวกรอง</button>}
        {extra}
        {action}
      </div>
    );
  }

  /* ปุ่มหลักบนมือถือ: ตัวเดิมของหน้า (ลิงก์/ปุ่มเดิม ที่หมายเดิม) แค่เปลี่ยนไส้เป็นไอคอน
     ข้อความเดิม ("+ เปิดเคสใหม่") ย้ายไปเป็น aria-label/title — โปรแกรมอ่านหน้าจอยังอ่านชื่อปุ่มได้ครบ */
  const actionText = typeof action?.props?.children === 'string' ? action.props.children.replace(/^\+\s*/, '') : undefined;
  const mobileAction = actionIcon && isValidElement(action)
    ? cloneElement(action, {
      'aria-label': actionText,
      title: actionText,
      children: (
        <svg className="fbar-action-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {ACTION_ICONS[actionIcon] ?? ACTION_ICONS.plus}
        </svg>
      ),
    })
    : action;

  return (
    <div className={`toolbar fbar${cls}`}>
      <div className="fbar-row">
        {lead}
        {search && (
          <label className="fbar-search">
            <Ico><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Ico>
            {search}
          </label>
        )}
        {extra}
        {/* ลำดับขวาสุด (ผู้ใช้ขอ 6 พ.ย. 2569): หน้าที่มีปุ่มทองเพิ่มรายการ (เปิดเคส / เพิ่มพนักงาน / ลูกค้า / ผู้รับบริการ)
            = ปุ่มนั้นขวาสุด ตัวกรองอยู่ถัดเข้ามา · หน้าอื่น = ปุ่ม "ตัวกรอง" ขวาสุด */}
        {actionIcon ? (
          <>
            {fs.button}
            {mobileAction}
          </>
        ) : (
          <>
            {mobileAction}
            {fs.button}
          </>
        )}
      </div>
      {fs.chips}
      {fs.sheet}
    </div>
  );
}
