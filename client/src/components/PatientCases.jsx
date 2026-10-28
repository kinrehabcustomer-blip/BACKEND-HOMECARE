import { Link } from 'react-router-dom';
import { SERVICE_KIND_LABELS, serviceKindOf, formatBaht, formatDate, caseStage } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';

/**
 * เคสที่ผูกกับผู้รับการดูแลรายนี้ — มุมของผู้รับบริการ จึงโชว์ "พนักงานที่รับ" ไม่ใช่ชื่อผู้รับบริการซ้ำ
 * (เคสจะขึ้นที่นี่เมื่อเปิดเคสจากหน้าผู้รับบริการ ซึ่งผูก patient_id ให้อัตโนมัติ)
 *
 * แต่ละเคสกดเข้าไปดูตัวเคสได้ (ตารางกะที่ไปดูแลจริง · รายงานอาการรายครั้ง · ค่าใช้จ่าย) —
 * หน้าผู้รับบริการตอบว่า "คนนี้เคยใช้บริการอะไรบ้าง" ส่วนคำถามถัดมาเสมอคือ "แล้วเคสนั้นเป็นยังไง"
 * ซึ่งเดิมต้องจำรหัสเคสแล้วไปหาเองที่หน้าเคส · เปิดเป็น popup บนหน้าเคส ปิดแล้วกดถอยกลับมาที่นี่ได้
 *
 * limit: โชว์กี่เคสก่อน — ไม่ส่ง = โชว์ทั้งหมด (หน้าเต็ม); popup ส่ง limit แล้วบอกว่าเหลืออีกกี่เคส
 */
export default function PatientCases({ cases = [], limit }) {
  if (cases.length === 0) {
    return <p className="muted">ยังไม่มีเคสที่ผูกกับผู้รับการดูแลรายนี้</p>;
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
        {/* จอสัมผัสไม่มี hover ให้บอกว่ากดได้ — ต้องเขียนบอกตรงๆ ไม่งั้นรายการนี้อ่านเป็นข้อความตาย */}
        <span className="cell-sub">แตะที่เคสเพื่อดูตารางกะและรายงานอาการ</span>
      </p>

      {shown.map((c) => (
        /* ทั้งแถบเป็นลิงก์ ไม่ใช่แค่ชื่อเคส — เป้าเล็กๆ บนมือถือคือเป้าที่กดพลาด
           และไม่ทำตัวหนังสือทั้งแถบเป็นสีลิงก์ ไม่งั้นทั้งบล็อกกลายเป็นทะเลสีน้ำเงิน
           (กติกาเดียวกับ .linkish ในหน้าค่าตอบแทน: บอกว่ากดได้ตอนชี้/โฟกัส) */
        <Link className="history-item" to={`/cases?open=${c.case_id}`} key={c.case_id}>
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
          </div>
          <span className={`badge case-${caseStage(c).key}`}>{caseStage(c).label}</span>
        </Link>
      ))}

      {hidden > 0 && (
        <p className="muted history-more">และอีก {hidden} เคส — ดูทั้งหมดได้ที่หน้าเต็ม</p>
      )}
    </>
  );
}
