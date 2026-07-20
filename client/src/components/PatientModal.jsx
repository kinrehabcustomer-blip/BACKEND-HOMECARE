import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import PatientCases from './PatientCases.jsx';
import {
  GENDER_LABELS, TITLE_LABELS, PATIENT_STATUS_LABELS, formatDate, ageFromBirthDate,
} from '../labels.js';

/** อายุจากวันเกิดแม่นกว่าเลขที่กรอกไว้เมื่อหลายปีก่อน — ใช้ช่อง age เป็นตัวสำรองเมื่อไม่รู้วันเกิด */
function displayAge(p) {
  const age = ageFromBirthDate(p.birth_date) ?? p.age;
  return age != null ? `${age} ปี` : null;
}

const fullAddress = (p) =>
  [p.address, p.subdistrict, p.district, p.province, p.postal_code].filter(Boolean).join(' ') || null;

function Field({ label, value, mono }) {
  const empty = value == null || value === '' || value === false;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className={`field-value ${mono ? 'mono' : ''} ${empty ? 'is-empty' : ''}`}>
        {empty ? 'ไม่ได้ระบุ' : value}
      </span>
    </div>
  );
}

export default function PatientModal({ patientId, onClose, onChanged }) {
  const [patient, setPatient] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setPatient(null);
    setError(null);

    api
      .getPatient(patientId)
      .then((data) => !cancelled && setPatient(data))
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [patientId]);

  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  async function handleDelete() {
    if (
      !confirm(
        `ลบแฟ้มผู้รับการดูแล ${patientId}?\nเคสที่เคยผูกไว้จะยังอยู่ในระบบ (ข้อมูลผู้ป่วยถูกบันทึกในเคสแล้ว) แต่จะไม่เชื่อมกับแฟ้มนี้อีก`,
      )
    ) {
      return;
    }

    await api.deletePatient(patientId);
    onChanged?.();
    onClose();
  }

  const genderAge = patient
    ? [GENDER_LABELS[patient.gender], displayAge(patient)].filter(Boolean).join(' / ')
    : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {!patient && !error && <p className="muted modal-loading">กำลังโหลด…</p>}
        {!patient && error && <pre className="error modal-loading">{error}</pre>}

        {patient && (
          <>
            <header className="modal-head">
              <div>
                <p className="mono muted">{patient.patient_id}</p>
                <h2>
                  {[TITLE_LABELS[patient.title], patient.name].filter(Boolean).join('')}
                  {patient.nickname && <span className="muted"> ({patient.nickname})</span>}
                </h2>
                <span className={`badge ${patient.status}`}>{PATIENT_STATUS_LABELS[patient.status]}</span>
              </div>
              <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
            </header>

            <div className="modal-body">
              {patient.allergies && (
                <p className="notice allergy-alert">
                  <strong>⚠ แพ้ยา / แพ้อาหาร:</strong> {patient.allergies}
                </p>
              )}

              <section>
                <h3>ข้อมูลพื้นฐาน</h3>
                <div className="field-grid">
                  <Field label="เพศ / อายุ" value={genderAge} />
                  <Field label="วันเกิด" value={patient.birth_date && formatDate(patient.birth_date)} />
                  <Field label="ความสัมพันธ์กับผู้ว่าจ้าง" value={patient.relation_to_customer} />
                  <Field label="เลขบัตรประชาชน" value={patient.national_id} mono />
                  <Field label="สัญชาติ" value={patient.nationality} />
                </div>
              </section>

              <section>
                <h3>ผู้ว่าจ้าง</h3>
                <Field
                  label="ลูกค้า"
                  value={patient.customer ? `${patient.customer.name} (${patient.customer.customer_id})` : null}
                />
              </section>

              <section>
                <h3>ข้อมูลสุขภาพ</h3>
                <div className="field-grid">
                  <Field
                    label="น้ำหนัก / ส่วนสูง"
                    value={[
                      patient.weight_kg != null && `${patient.weight_kg} กก.`,
                      patient.height_cm != null && `${patient.height_cm} ซม.`,
                    ].filter(Boolean).join(' / ')}
                  />
                  <Field label="กรุ๊ปเลือด" value={patient.blood_type} />
                  <Field label="สิทธิการรักษา" value={patient.medical_rights} />
                </div>
                <Field label="โรคประจำตัว" value={patient.medical_history} />
                <Field label="แพ้ยา / แพ้อาหาร" value={patient.allergies} />
                <Field label="ที่อยู่สถานที่ดูแล" value={fullAddress(patient)} />
              </section>

              <section>
                <h3>ญาติ / ผู้ติดต่อกรณีฉุกเฉิน</h3>
                <div className="field-grid">
                  <Field label="ชื่อผู้ติดต่อ" value={patient.emergency_contact_name} />
                  <Field label="เบอร์ผู้ติดต่อ" value={patient.emergency_contact_phone} />
                  <Field label="ความสัมพันธ์" value={patient.emergency_contact_relation} />
                </div>
                <Field label="หมายเหตุ" value={patient.note} />
              </section>

              <section>
                <h3>เคสที่ผูกกับผู้รับการดูแลรายนี้ ({patient.cases.length})</h3>
                {/* popup เป็นตัวอย่างย่อ — โชว์ 3 เคสล่าสุด ที่เหลือดูที่หน้าเต็ม */}
                <PatientCases cases={patient.cases} limit={3} />
              </section>

              <section className="modal-meta">
                <Field label="สร้างเมื่อ" value={formatDate(patient.created_at)} />
                <Field label="แก้ไขล่าสุด" value={formatDate(patient.updated_at)} />
              </section>
            </div>

            <footer className="modal-foot">
              <button className="btn danger-ghost" onClick={handleDelete}>ลบแฟ้ม</button>
              <Link className="btn" to={`/cases/new?patient_id=${patient.patient_id}`}>+ เปิดเคส</Link>
              <Link className="btn" to={`/patients/${patient.patient_id}`}>เปิดหน้าเต็ม</Link>
              <Link className="btn primary" to={`/patients/${patient.patient_id}/edit`}>แก้ไขข้อมูล</Link>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
