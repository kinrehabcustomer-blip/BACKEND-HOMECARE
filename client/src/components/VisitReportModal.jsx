import { useEffect, useState } from 'react';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import { useAuth } from '../auth.jsx';
import CaseReports from './CaseReports.jsx';
import { serviceName } from './MyCaseModal.jsx';
import { CASE_TYPE_LABELS, formatDate } from '../labels.js';

/**
 * popup บันทึกรายงานอาการของ "กะนี้" — เปิดจากการ์ดงานวันนี้ของพนักงาน
 *
 * แยกจากรายงานทั้งเคส (MyCaseModal) เพราะจังหวะการใช้ต่างกัน:
 * ที่นี่คือตอนอยู่หน้างานเพิ่งดูแลผู้ป่วยเสร็จ ต้องเห็นแค่ของกะที่กำลังทำและกรอกได้ทันที
 * ส่วนของทั้งเคสคือตอนอยากไล่ดูย้อนหลังว่าอาการเปลี่ยนไปยังไง
 *
 * onSaved() — ให้หน้าแม่ไปดึงข้อมูลใหม่ ตัวเลขจำนวนรายงานบนการ์ดจะได้ตรง
 */
export default function VisitReportModal({ visit, onSaved, onClose }) {
  const sheetRef = useSheetSwipe(onClose);
  const me = useAuth()?.user?.employee_id ?? null;
  // ฟอร์มกางอยู่ = ซ่อนปุ่มปิดของกล่อง ให้เหลือปุ่มเดียวคือปุ่มของฟอร์ม
  const [formOpen, setFormOpen] = useState(false);

  useScrollLock();
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const planned = [visit.planned_start, visit.planned_end].filter(Boolean).join(' - ');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">
              {formatDate(visit.visit_date)}{planned && ` · ${planned}`}
            </p>
            <h2>รายงานอาการผู้ป่วย</h2>
            <p className="muted">
              {visit.client_name}
              {' · '}
              {serviceName(visit) || CASE_TYPE_LABELS[visit.case_type]}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          <CaseReports
            caseId={visit.case_id}
            caseInfo={visit}
            scope="my"
            visitId={visit.visit_id}
            currentEmployeeId={me}
            onChanged={onSaved}
            onFormOpen={setFormOpen}
          />
        </div>

        {!formOpen && (
          <footer className="modal-foot">
            <button className="btn primary" onClick={onClose}>เสร็จสิ้น</button>
          </footer>
        )}
      </div>
    </div>
  );
}
