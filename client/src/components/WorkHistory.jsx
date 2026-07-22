import { useState } from 'react';
import WorkHistoryModal from './WorkHistoryModal.jsx';
import { CASE_TYPE_LABELS, CASE_STATUS_LABELS, formatBaht, formatDate } from '../labels.js';

/**
 * ประวัติการทำงาน = เคสที่พนักงานคนนี้ถืออยู่ ทั้งที่กำลังทำและที่ปิดไปแล้ว
 * (เคสที่ปิดแล้วยังเก็บ assigned_to ไว้ จึงยังรู้ว่าใครเป็นคนทำ) — เรียงใหม่สุดขึ้นก่อน
 *
 * ตรงนี้โชว์แค่ย่อๆ เสมอ (limit รายการล่าสุด) — ฉบับเต็มเปิดเป็นหน้าต่างแยกที่คลิกดูรายละเอียดเคสได้
 *
 * limit: จำนวนที่โชว์ย่อ — ไม่ส่ง = โชว์ทั้งหมด
 * collapsible: หน้าเต็มส่ง true → มีปุ่มเปิดหน้าต่างประวัติฉบับเต็ม
 *              popup ไม่ส่ง → บอกเฉยๆ ว่าเหลืออีกกี่เคส (ซ้อน popup อีกชั้นในนั้นมันลึกเกินไป)
 */
export default function WorkHistory({ cases = [], limit, collapsible = false, employeeName }) {
  const [fullOpen, setFullOpen] = useState(false);

  if (cases.length === 0) {
    return <p className="muted">ยังไม่เคยรับเคสใดในระบบ</p>;
  }

  // กำลังดำเนินการ = จับคู่แล้วรอเริ่ม หรือกำลังให้บริการอยู่ (เคสยกเลิกไม่นับเป็นทั้งสองกลุ่ม)
  const active = cases.filter((c) => c.status === 'assigned' || c.status === 'in_progress');
  const closed = cases.filter((c) => c.status === 'closed');
  const earned = closed.reduce((sum, c) => sum + (c.fee ?? 0), 0);

  const shown = limit ? cases.slice(0, limit) : cases;
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

      {/* หน้าเต็ม: เปิดประวัติฉบับเต็มเป็นหน้าต่างแยก (ตาราง + คลิกดูรายละเอียดเคสได้) */}
      {collapsible && (
        <button className="btn history-toggle" onClick={() => setFullOpen(true)}>
          ดูประวัติทั้งหมด ({cases.length} เคส)
        </button>
      )}

      {/* popup: ไม่ซ้อนอีกชั้น บอกตรงๆ ว่ายังมีอีก ให้ไปดูครบที่หน้าเต็ม */}
      {!collapsible && hidden > 0 && (
        <p className="muted history-more">และอีก {hidden} เคส — ดูทั้งหมดได้ที่หน้าเต็ม</p>
      )}

      {fullOpen && (
        <WorkHistoryModal
          employeeName={employeeName}
          cases={cases}
          onClose={() => setFullOpen(false)}
        />
      )}
    </>
  );
}
