import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import {
  CASE_TYPE_LABELS,
  CASE_STATUS_LABELS,
  GENDER_LABELS,
  VISIT_STATE_LABELS,
  formatDate,
  timeText,
} from '../labels.js';

/** ชื่อบริการของเคส — กายภาพใช้ชื่อแพ็คเกจ, Homecare ใช้รูปแบบ+เกรด (ใช้ร่วมกันหลายหน้าของ field) */
export const serviceName = (c) => {
  if (c.physio_package_id && c.physio_package_name) {
    return [c.physio_package_name, c.physio_sessions && `${c.physio_sessions} ครั้ง`].filter(Boolean).join(' · ');
  }
  return [c.format_name, c.grade_name].filter(Boolean).join(' · ') || CASE_TYPE_LABELS[c.case_type];
};

function Field({ label, value }) {
  const empty = value == null || value === '' || value === false;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className={`field-value ${empty ? 'is-empty' : ''}`}>{empty ? 'ไม่ได้ระบุ' : value}</span>
    </div>
  );
}

/**
 * popup รายละเอียดเคส (อ่านอย่างเดียว) สำหรับพนักงานภาคสนาม
 * ดึงจาก /api/my/cases/:id ซึ่งกรองให้เห็นเฉพาะเคสของตัวเอง และไม่มีข้อมูลการเงิน
 */
export default function MyCaseModal({ caseId, onClose }) {
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.myCase(caseId).then((c) => !cancelled && setItem(c)).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [caseId]);

  useScrollLock();
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const genderAge = item
    ? [GENDER_LABELS[item.patient_gender], item.patient_age != null && `${item.patient_age} ปี`].filter(Boolean).join(' / ')
    : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {!item && !error && <p className="muted modal-loading">กำลังโหลด…</p>}
        {!item && error && <pre className="error modal-loading">{error}</pre>}

        {item && (
          <>
            <header className="modal-head">
              <div>
                <p className="mono muted">{item.case_id}</p>
                <h2>{serviceName(item)}</h2>
                <p className="muted">{item.client_name}</p>
                <span className={`badge case-${item.status}`}>{CASE_STATUS_LABELS[item.status]}</span>
              </div>
              <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
            </header>

            <div className="modal-body">
              <section>
                <h3>ผู้รับการดูแล</h3>
                <div className="field-grid">
                  <Field label="ชื่อผู้ป่วย" value={item.client_name} />
                  <Field label="เพศ / อายุ" value={genderAge} />
                </div>
                {/* แพ้ยา/แพ้อาหาร/หมู่เลือด อ่านสดจากแฟ้มผู้ป่วย — ไม่มีสำเนาในเคส
                    ถ้ารอให้เคสคัดลอกไว้ ข้อมูลที่พยาบาลเพิ่งอัปเดตจะไปไม่ถึงคนที่กำลังจะเข้าบ้าน */}
                {(item.patient_allergies || item.patient_food_allergies) && (
                  <p className="allergy-alert">
                    {item.patient_allergies && <>แพ้ยา: {item.patient_allergies}</>}
                    {item.patient_allergies && item.patient_food_allergies && ' · '}
                    {item.patient_food_allergies && <>แพ้อาหาร: {item.patient_food_allergies}</>}
                  </p>
                )}

                <Field label="โรคประจำตัว" value={item.patient_medical_history ?? item.medical_history} />
                {/* แฟ้มผู้ป่วยถูกแก้หลังเปิดเคส — โชว์ของล่าสุด แต่บอกด้วยว่าตอนเปิดเคสบันทึกไว้ว่าอะไร */}
                {item.medical_history_stale && (
                  <p className="notice">
                    ข้อมูลโรคประจำตัวเป็นของล่าสุดจากแฟ้มผู้ป่วย (ตอนเปิดเคสบันทึกไว้ว่า:{' '}
                    {item.medical_history || 'ไม่ได้ระบุ'})
                  </p>
                )}
                <Field label="หมู่เลือด" value={item.patient_blood_type} />
                <Field label="อาการปัจจุบัน" value={item.current_symptoms} />
                <Field label="อุปกรณ์ / สายต่างๆ" value={item.medical_devices} />
                <Field label="จุดประสงค์ในการดูแล" value={item.care_goal} />
              </section>

              <section>
                <h3>สถานที่ / ติดต่อ</h3>
                <Field label="ที่อยู่สถานที่ดูแล" value={item.address} />
                <Field label="เบอร์ติดต่อญาติ" value={item.client_phone} />
              </section>

              <section>
                <h3>รายละเอียดการให้บริการ</h3>
                <div className="field-grid">
                  <Field label="ประเภทเคส" value={CASE_TYPE_LABELS[item.case_type]} />
                  <Field label="บริการ" value={serviceName(item)} />
                  <Field label="วันเริ่ม" value={item.start_date && formatDate(item.start_date)} />
                  <Field label="วันสิ้นสุด" value={item.end_date && formatDate(item.end_date)} />
                </div>
              </section>

              {/* Homecare = ตารางกะ · กายภาพ = ตารางนัดเข้าคอร์ส */}
              <section>
                <h3>
                  {(item.service_kind === 'physio' || item.physio_package_id != null) ? 'ตารางนัด' : 'ตารางกะ'}
                  {' '}({item.visits.length})
                </h3>
                {item.visits.length === 0 ? (
                  <p className="muted">ยังไม่มีนัด</p>
                ) : (
                  <ol className="visit-list">
                    {item.visits.map((v, i) => (
                      <li key={v.visit_id} className={`visit-${v.state}`}>
                        <span className="visit-seq">ครั้งที่ {i + 1}</span>
                        {/* เวลานัดต้องอยู่คู่กับวันเสมอ — ระบุเวลาไว้แล้วคนที่ต้องไปไม่เห็น ก็เท่ากับไม่ได้ระบุ */}
                        <span className="visit-date">
                          {formatDate(v.visit_date)}
                          {[v.planned_start, v.planned_end].filter(Boolean).length > 0 &&
                            ` · ${[v.planned_start, v.planned_end].filter(Boolean).join('-')}`}
                        </span>
                        <span className="muted">
                          {VISIT_STATE_LABELS[v.state]}
                          {v.check_in_at && ` · เข้า ${timeText(v.check_in_at)}`}
                          {v.check_out_at && ` · ออก ${timeText(v.check_out_at)}`}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
