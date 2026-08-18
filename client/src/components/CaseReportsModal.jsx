import { useEffect, useState } from 'react';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import CaseReports from './CaseReports.jsx';

/**
 * popup รายงานอาการผู้ป่วย — เปิดซ้อนบน CaseModal อีกที (แบบเดียวกับตารางกะ)
 * แยกออกมาเป็น popup เพราะรายงานสะสมไปเรื่อยๆ ตามอายุเคส กางไว้ในหน้าเคสจะดันส่วนอื่นตกจอ
 */
export default function CaseReportsModal({ caseItem, onClose }) {
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด
  // ฟอร์มกางอยู่ = ซ่อนปุ่มปิดของกล่อง ให้เหลือปุ่มเดียวคือปุ่มของฟอร์ม
  const [formOpen, setFormOpen] = useState(false);
  useScrollLock();
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop modal-stacked" onClick={onClose}>
      <div className="modal modal-wide" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseItem.case_id}</p>
            <h2>รายงานอาการผู้ป่วย</h2>
            <p className="muted">{caseItem.client_name}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          <CaseReports
            caseId={caseItem.case_id}
            caseInfo={caseItem}
            scope="admin"
            allowAdd={false}
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
