import { useState } from 'react';
import { CASE_TYPE_LABELS, CASE_STATUS_LABELS, formatBaht, formatDate } from '../labels.js';

/**
 * ประวัติการทำงาน = เคสที่พนักงานคนนี้ถืออยู่ ทั้งที่กำลังทำและที่ปิดไปแล้ว
 * (เคสที่ปิดแล้วยังเก็บ assigned_to ไว้ จึงยังรู้ว่าใครเป็นคนทำ) — เรียงใหม่สุดขึ้นก่อน
 *
 * limit: จำนวนที่โชว์ก่อน (ทั้งสองที่ส่ง 3) — ไม่ส่ง = โชว์ทั้งหมด
 * collapsible: หน้าเต็มส่ง true → มีปุ่มลูกศรกดขยายดูที่เหลือได้
 *              popup ไม่ส่ง → โชว์แค่ limit แล้วบอกว่าเหลืออีกกี่เคส ให้ไปดูที่หน้าเต็ม
 */
export default function WorkHistory({ cases = [], limit, collapsible = false }) {
  const [expanded, setExpanded] = useState(false);

  if (cases.length === 0) {
    return <p className="muted">ยังไม่เคยรับเคสใดในระบบ</p>;
  }

  // กำลังดำเนินการ = จับคู่แล้วรอเริ่ม หรือกำลังให้บริการอยู่ (เคสยกเลิกไม่นับเป็นทั้งสองกลุ่ม)
  const active = cases.filter((c) => c.status === 'assigned' || c.status === 'in_progress');
  const closed = cases.filter((c) => c.status === 'closed');
  const earned = closed.reduce((sum, c) => sum + (c.fee ?? 0), 0);

  const showAll = !limit || (collapsible && expanded);
  const shown = showAll ? cases : cases.slice(0, limit);
  const hidden = cases.length - shown.length;

  return (
    <>
      <p className="muted history-summary">
        กำลังดำเนินการ {active.length} เคส · ปิดแล้ว {closed.length} เคส
        {earned > 0 && ` · รายได้จากเคสที่ปิดแล้ว ${formatBaht(earned)}`}
      </p>

      {shown.map((c) => (
        <div className="history-item" key={c.case_id}>
          <div>
            <strong>{c.title}</strong>
            <p className="muted">
              <span className="mono">{c.case_id}</span>
              {' · '}{CASE_TYPE_LABELS[c.case_type]}
              {' · '}{c.client_name}
            </p>
            <p className="muted">
              {/* เคสที่ปิดแล้วสนใจว่าจบเมื่อไหร่ ส่วนเคสที่ทำอยู่สนใจว่ารับมาตั้งแต่เมื่อไหร่ */}
              {c.status === 'closed'
                ? `ปิดเคสเมื่อ ${formatDate(c.closed_at ?? c.end_date)}`
                : `รับเคสเมื่อ ${formatDate(c.assigned_at)}`}
              {c.fee != null && ` · ${formatBaht(c.fee)}`}
            </p>
          </div>
          <span className={`badge case-${c.status}`}>{CASE_STATUS_LABELS[c.status]}</span>
        </div>
      ))}

      {/* หน้าเต็ม: มีเคสมากกว่า limit → ปุ่มลูกศรขยาย/ย่อ */}
      {collapsible && cases.length > limit && (
        <button
          className="btn history-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'ย่อลง' : `แสดงทั้งหมด (อีก ${cases.length - limit} เคส)`}
          <svg
            className={`chevron ${expanded ? 'up' : ''}`}
            width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"
          >
            <path
              d="M1 1.5 6 6.5l5-5"
              fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {/* popup: ไม่ขยายในตัว บอกตรงๆ ว่ายังมีอีก ให้ไปดูครบที่หน้าเต็ม */}
      {!collapsible && hidden > 0 && (
        <p className="muted history-more">และอีก {hidden} เคส — ดูทั้งหมดได้ที่หน้าเต็ม</p>
      )}
    </>
  );
}
