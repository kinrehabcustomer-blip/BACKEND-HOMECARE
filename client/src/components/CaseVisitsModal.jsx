import { useEffect, useState } from 'react';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import CaseVisits from './CaseVisits.jsx';
import LineIcon from './LineIcon.jsx';
import { caseCode } from '../lib/patientCode.js';

/**
 * popup เฉพาะสำหรับลงวันนัดให้บริการ — เปิดซ้อนบน CaseModal อีกที
 * การล็อกหน้าหลังนับชั้นเอง (ดู lib/scrollLock.js) จึงเรียกได้ตามปกติ ไม่ไปปลดล็อกของ popup แม่
 */
export default function CaseVisitsModal({ caseItem, readOnly = false, mode = 'shift', initialPartnerId = null, onClose }) {
  const title = mode === 'appointment' ? 'ตารางนัด' : 'ตารางกะ';
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด
  useScrollLock();
  // ปุ่ม "ยกเลิกนัดทั้งหมด" ที่มุมซ้ายของ footer — CaseVisits ส่งสถานะมา (null = ไม่มีนัดให้ยกเลิก)
  const [footAction, setFootAction] = useState(null);
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop modal-stacked" onClick={onClose}>
      <div className="modal modal-narrow is-subsheet cv-modal" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          {/* ดีไซน์ v2: หัวข้อก่อน แล้ว "ชื่อผู้รับบริการ · รหัสเคส" บรรทัดเดียว (ข้อมูลเดิม สลับลำดับ) */}
          <div>
            <h2>{title}</h2>
            <p className="muted">{caseItem.client_name}<span className="cv-head-sep" aria-hidden="true"> · </span><span className="mono cv-head-code">{caseCode(caseItem.case_id)}</span></p>
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
            initialPartnerId={initialPartnerId}
            onFootAction={setFootAction}
          />
        </div>

        <footer className="modal-foot">
          {/* ปุ่มทำลายชิดซ้าย ห่างจาก "เสร็จสิ้น" (.foot-danger — มือถือลงไปเป็นแถวของตัวเอง) */}
          {footAction && (
            <button
              type="button"
              className="btn tiny danger-ghost foot-danger visit-foot-cancel"
              disabled={footAction.busy}
              title={footAction.title}
              onClick={footAction.onClick}
            >
              <LineIcon name="x-circle" className="text-ico" />
              {footAction.label}
            </button>
          )}
          <button className="btn primary" onClick={onClose}>เสร็จสิ้น</button>
        </footer>
      </div>
    </div>
  );
}
