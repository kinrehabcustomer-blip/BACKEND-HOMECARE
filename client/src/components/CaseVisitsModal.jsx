import { useEffect } from 'react';
import CaseVisits from './CaseVisits.jsx';

/**
 * popup เฉพาะสำหรับลงวันนัดให้บริการ — เปิดซ้อนบน CaseModal อีกที
 *
 * ไม่แตะ document.body.style.overflow เพราะ popup แม่ (CaseModal) ล็อกการเลื่อนไว้อยู่แล้ว
 * ถ้าแตะด้วย พอปิดตัวนี้จะไปปลดล็อกทั้งที่ popup แม่ยังเปิดอยู่
 */
export default function CaseVisitsModal({ caseItem, readOnly = false, onClose }) {
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop modal-stacked" onClick={onClose}>
      <div className="modal modal-narrow" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseItem.case_id}</p>
            <h2>วันนัดให้บริการ</h2>
            <p className="muted">{caseItem.client_name}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          <CaseVisits
            caseId={caseItem.case_id}
            target={caseItem.physio_sessions ?? null}
            readOnly={readOnly}
          />
        </div>

        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>เสร็จสิ้น</button>
        </footer>
      </div>
    </div>
  );
}
