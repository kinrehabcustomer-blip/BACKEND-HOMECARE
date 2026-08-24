import { useEffect } from 'react';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import CaseVisits from './CaseVisits.jsx';

/**
 * popup เฉพาะสำหรับลงวันนัดให้บริการ — เปิดซ้อนบน CaseModal อีกที
 * การล็อกหน้าหลังนับชั้นเอง (ดู lib/scrollLock.js) จึงเรียกได้ตามปกติ ไม่ไปปลดล็อกของ popup แม่
 */
export default function CaseVisitsModal({ caseItem, readOnly = false, mode = 'shift', onClose }) {
  const title = mode === 'appointment' ? 'ตารางนัด' : 'ตารางกะ';
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด
  useScrollLock();
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop modal-stacked" onClick={onClose}>
      <div className="modal modal-narrow is-subsheet" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseItem.case_id}</p>
            <h2>{title}</h2>
            <p className="muted">{caseItem.client_name}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          <CaseVisits
            caseId={caseItem.case_id}
            caseItem={caseItem}
            target={caseItem.physio_sessions ?? null}
            readOnly={readOnly}
            mode={mode}
          />
        </div>

        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>เสร็จสิ้น</button>
        </footer>
      </div>
    </div>
  );
}
