import { caseStage, formatBaht } from '../labels.js';
import { addonName, addonSessions } from '../lib/caseAddons.js';

/**
 * ชิ้นส่วนแสดงแพ็กกายภาพเสริมในแถวของเคส Homecare — รูปแบบเดียวกันทุกหน้า (ดู lib/caseAddons.js)
 * สไตล์: .case-addon* / .badge-flat ใน index.css · ไอคอนสถานะใน warm-clarity.css
 */

/**
 * บรรทัด "[+ กายภาพ] ชื่อแพ็ก · ราคา · ใบแยก · 🕘 สถานะ" ต่อแพ็ก
 * สถานะของแพ็กอยู่ท้ายบรรทัดนี้เลย (ผู้ใช้ขอ 10 พ.ย. 2569) — อ่านจบในบรรทัดเดียวว่าแพ็กไหนอยู่ขั้นไหน
 * คอลัมน์/มุมสถานะของแถวจึงเหลือป้ายเดียว (สถานะเคส Homecare) ตรงแนวกับทุกแถว
 * ป้ายแพ็กเป็นแบบแบน (badge-flat: ไอคอน+ข้อความสีสถานะ ไม่มีพื้น) — เป็นรายละเอียดของแพ็ก ไม่แย่งป้ายหลัก
 * showFee = ราคา (พนักงานภาคสนามไม่เห็น) · showStaff = ชื่อนักกายภาพ (หน้าที่ไม่มีคอลัมน์พนักงานแยก)
 */
export function AddonLines({ addons, showFee = true, showStaff = false }) {
  if (!addons?.length) return null;
  return addons.map((a) => {
    const name = addonName(a);
    const sessions = addonSessions(a);
    const st = caseStage(a);
    return (
      <span key={a.case_id} className="case-addon">
        <span className="case-addon-tag">+ กายภาพ</span>
        <span className="case-addon-name">
          {name}
          {sessions && !String(name).includes(`${sessions} ครั้ง`) && <span className="muted"> · {sessions} ครั้ง</span>}
        </span>
        {showFee && a.fee != null && (
          <span className="muted">{formatBaht(a.fee)}{!a.bill_with_parent && ' · ใบแยก'}</span>
        )}
        {showStaff && a.assigned_name && <span className="muted">นักกายภาพ {a.assigned_name}</span>}
        <span className={`badge badge-flat case-${st.key}`} title={`สถานะแพ็กกายภาพ: ${st.label}`}>{st.label}</span>
      </span>
    );
  });
}

/** ป้ายสถานะของเคส — สถานะของแพ็กเสริมอยู่ท้ายบรรทัด "+ กายภาพ" แล้ว (AddonLines) ไม่ซ้อนที่นี่ */
export function CaseStatus({ c }) {
  const st = caseStage(c);
  return <span className={`badge case-${st.key}`}>{st.label}</span>;
}
