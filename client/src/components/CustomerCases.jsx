import { SERVICE_KIND_LABELS, serviceKindOf, formatBaht, formatDate } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';
import { groupAddons } from '../lib/caseAddons.js';
import { AddonLines, CaseStatus } from './CaseAddons.jsx';

/**
 * เคสที่ลูกค้ารายนี้เคยใช้บริการ — มุมของลูกค้า จึงโชว์ "พนักงานที่รับ" ไม่ใช่ชื่อผู้รับบริการ
 * (คนละมุมกับ WorkHistory ที่เป็นเคสของพนักงาน จึงแยกกันคนละตัว)
 *
 * limit: โชว์กี่เคสก่อน — ไม่ส่ง = โชว์ทั้งหมด (หน้าเต็ม)
 *        popup ส่ง limit มา แล้วบอกว่าเหลืออีกกี่เคส ให้ไปดูที่หน้าเต็ม
 */
export default function CustomerCases({ cases = [], limit }) {
  if (cases.length === 0) {
    return <p className="muted">ยังไม่เคยเปิดเคสให้ลูกค้ารายนี้</p>;
  }

  const spent = cases.filter((c) => c.status === 'closed').reduce((sum, c) => sum + (c.fee ?? 0), 0);

  /* แพ็กกายภาพเสริมรวมเข้าแถวเคส Homecare (ผู้ใช้ขอ 10 พ.ย. 2569 — lib/caseAddons.js)
     นับจำนวนเคสตามแถวที่เห็น · ยอดเงินยังรวมทุกเคส (แพ็กที่ปิดแล้วก็เป็นเงินที่ลูกค้าจ่ายจริง) */
  const rows = groupAddons(cases);
  const shown = limit ? rows.slice(0, limit) : rows;
  const hidden = rows.length - shown.length;

  return (
    <>
      <p className="muted history-summary">
        ทั้งหมด {rows.length} เคส · ปิดแล้ว {rows.filter((c) => c.status === 'closed').length} เคส
        {spent > 0 && ` · ยอดจากเคสที่ปิดแล้ว ${formatBaht(spent)}`}
      </p>

      {shown.map((c) => (
        <div className="history-item" key={c.case_id}>
          <div>
            <strong>{c.title}</strong>
            <p className="muted">
              <span className="mono">{caseCode(c.case_id)}</span>
              {' · '}{SERVICE_KIND_LABELS[serviceKindOf(c)]}
              {c.assigned_name && ` · ${[c.assigned_name, c.team_names].filter(Boolean).join(' · ')}`}
            </p>
            <p className="muted">
              {c.start_date ? `เริ่ม ${formatDate(c.start_date)}` : 'ยังไม่ระบุวันเริ่ม'}
              {c.fee != null && ` · ${formatBaht(c.fee)}`}
            </p>
            <AddonLines addons={c.addons} showStaff />
          </div>
          <CaseStatus c={c} />
        </div>
      ))}

      {hidden > 0 && (
        <p className="muted history-more">และอีก {hidden} เคส — ดูทั้งหมดได้ที่หน้าเต็ม</p>
      )}
    </>
  );
}
