import { CASE_TYPE_LABELS, CASE_STATUS_LABELS, formatBaht, formatDate } from '../labels.js';

/**
 * เคสที่ลูกค้ารายนี้เคยใช้บริการ — มุมของลูกค้า จึงโชว์ "พนักงานที่รับ" ไม่ใช่ชื่อผู้ป่วย
 * (คนละมุมกับ WorkHistory ที่เป็นเคสของพนักงาน จึงแยกกันคนละตัว)
 *
 * limit: โชว์กี่เคสก่อน — ไม่ส่ง = โชว์ทั้งหมด (หน้าเต็ม)
 *        popup ส่ง limit มา แล้วบอกว่าเหลืออีกกี่เคส ให้ไปดูที่หน้าเต็ม
 */
export default function CustomerCases({ cases = [], limit }) {
  if (cases.length === 0) {
    return <p className="muted">ยังไม่เคยเปิดเคสให้ลูกค้ารายนี้</p>;
  }

  const closed = cases.filter((c) => c.status === 'closed');
  const spent = closed.reduce((sum, c) => sum + (c.fee ?? 0), 0);

  const shown = limit ? cases.slice(0, limit) : cases;
  const hidden = cases.length - shown.length;

  return (
    <>
      <p className="muted history-summary">
        ทั้งหมด {cases.length} เคส · ปิดแล้ว {closed.length} เคส
        {spent > 0 && ` · ยอดจากเคสที่ปิดแล้ว ${formatBaht(spent)}`}
      </p>

      {shown.map((c) => (
        <div className="history-item" key={c.case_id}>
          <div>
            <strong>{c.title}</strong>
            <p className="muted">
              <span className="mono">{c.case_id}</span>
              {' · '}{CASE_TYPE_LABELS[c.case_type]}
              {c.assigned_name && ` · ${c.assigned_name}`}
            </p>
            <p className="muted">
              {c.start_date ? `เริ่ม ${formatDate(c.start_date)}` : 'ยังไม่ระบุวันเริ่ม'}
              {c.fee != null && ` · ${formatBaht(c.fee)}`}
            </p>
          </div>
          <span className={`badge case-${c.status}`}>{CASE_STATUS_LABELS[c.status]}</span>
        </div>
      ))}

      {hidden > 0 && (
        <p className="muted history-more">และอีก {hidden} เคส — ดูทั้งหมดได้ที่หน้าเต็ม</p>
      )}
    </>
  );
}
