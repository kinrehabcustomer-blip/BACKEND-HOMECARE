import { useEffect } from 'react';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import CaseReports from './CaseReports.jsx';

/**
 * popup "ตารางรายงานทั้งหมด" ของเคสหนึ่งใบ
 *
 * เคสที่ดูแลต่อเนื่องบันทึกวันละ 2–4 ครั้ง คลังจึงโตขึ้นทุกวันจนกางในหน้าเคสไม่ไหว
 * (หน้าเคสมีทั้งข้อมูลผู้ป่วย ที่อยู่ ตารางกะ — รายงานสองร้อยใบจะดันทุกอย่างตกจอไปหมด)
 * หน้าเคสจึงเหลือแค่ใบล่าสุดไม่กี่ใบ แล้วมาเปิดที่นี่เมื่อต้องไล่ย้อนหลังจริงๆ
 *
 * ข้างในเป็น CaseReports ตัวเดิมที่ไม่ได้จำกัดจำนวน — ตัวกรองเดือน/ประเภท การแบ่งหน้า
 * และการกางดูรายใบ จึงเป็นชุดเดียวกับที่อื่นทั้งหมด ไม่ต้องเรียนรู้หน้าจอใหม่
 */
export default function ReportArchiveModal({ caseId, caseInfo, title, scope, currentEmployeeId, readOnly, onClose }) {
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด
  useScrollLock();
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop modal-stacked" onClick={onClose}>
      <div className="modal modal-wide is-subsheet" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseId}</p>
            <h2>รายงานอาการผู้ป่วย</h2>
            {title && <p className="muted">{title}</p>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          <CaseReports
            caseId={caseId}
            caseInfo={caseInfo}
            scope={scope}
            currentEmployeeId={currentEmployeeId}
            readOnly={readOnly}
            allowAdd={false}
          />
        </div>

        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>ปิด</button>
        </footer>
      </div>
    </div>
  );
}
