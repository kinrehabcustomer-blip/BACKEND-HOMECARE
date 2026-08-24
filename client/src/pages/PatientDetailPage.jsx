import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import PatientCases from '../components/PatientCases.jsx';
import {
  GENDER_LABELS, TITLE_LABELS, PATIENT_STATUS_LABELS, formatDate, ageFromBirthDate,
} from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';

function Row({ label, children }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{children || '—'}</span>
    </div>
  );
}

export default function PatientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [patient, setPatient] = useState(null);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0); // เด้งค่าเพื่อสั่งโหลดใหม่จากปุ่ม "ลองใหม่"

  useEffect(() => {
    /* ธง cancelled: กดจากแฟ้มหนึ่งไปอีกแฟ้มเร็วๆ (หรือกดปุ่มก่อนหน้า/ถัดไปรัวๆ)
       คำตอบของแฟ้มเก่าที่มาถึงทีหลังจะทับแฟ้มที่เปิดอยู่ — ได้หน้าที่ขึ้นชื่อคนหนึ่ง
       แต่ข้อมูลสุขภาพของอีกคน ซึ่งมองด้วยตาไม่มีทางรู้ว่าผิด */
    let cancelled = false;
    api
      .getPatient(id)
      .then((v) => {
        if (cancelled) return;
        setPatient(v);
        setError(null); // โหลดผ่านแล้ว error ของรอบก่อนต้องหายไปด้วย
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [id, reloadKey]);

  async function handleDelete() {
    await api.deletePatient(id);
    navigate('/patients');
  }

  // โหลดไม่สำเร็จ ยังไม่มีข้อมูลให้แสดง — แต่ต้องมีทางกดใหม่ ไม่ใช่ต้องรีเฟรชเบราว์เซอร์เอง
  if (error) return <ErrorBar message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!patient) return <p className="muted">กำลังโหลด…</p>;

  const age = ageFromBirthDate(patient.birth_date) ?? patient.age;
  const fullAddress =
    [patient.address, patient.subdistrict, patient.district, patient.province, patient.postal_code]
      .filter(Boolean)
      .join(' ');

  return (
    <>
      <header className="page-head">
        <div>
          <p className="mono muted">{patient.patient_id}</p>
          <h1>
            {[TITLE_LABELS[patient.title], patient.name].filter(Boolean).join('')}
            {patient.nickname && <span className="muted"> ({patient.nickname})</span>}
          </h1>
          <span className={`badge ${patient.status}`}>{PATIENT_STATUS_LABELS[patient.status]}</span>
          {patient.name_en && <p className="muted">{patient.name_en}</p>}
        </div>
        <div className="actions">
          <Link className="btn" to="/patients">← กลับ</Link>
          <Link className="btn" to={`/cases/new?patient_id=${patient.patient_id}`}>+ เปิดเคส</Link>
          <Link className="btn primary" to={`/patients/${id}/edit`}>แก้ไข</Link>
        </div>
      </header>

      {/* การแพ้อยู่บนสุด — พนักงานต้องเห็นก่อนเข้าเคส ไม่ใช่ต้องเลื่อนหา
          แยกสองแถบ เพราะคนละคนที่ต้องรู้ (คนให้ยา vs คนเตรียมอาหาร) */}
      {patient.allergies && (
        <p className="notice allergy-alert">
          <strong><LineIcon name="alert" className="text-ico" />แพ้ยา:</strong> {patient.allergies}
        </p>
      )}
      {patient.food_allergies && (
        <p className="notice allergy-alert">
          <strong><LineIcon name="alert" className="text-ico" />แพ้อาหาร:</strong> {patient.food_allergies}
        </p>
      )}

      <div className="columns">
        <section className="card">
          <h2>ข้อมูลส่วนตัว</h2>
          <Row label="เพศ">{GENDER_LABELS[patient.gender]}</Row>
          <Row label="วันเกิด">
            {patient.birth_date && `${formatDate(patient.birth_date)}${age != null ? ` (อายุ ${age} ปี)` : ''}`}
          </Row>
          {!patient.birth_date && <Row label="อายุ">{age != null && `${age} ปี`}</Row>}
          <Row label="ความสัมพันธ์กับผู้ว่าจ้าง">{patient.relation_to_customer}</Row>
          <Row label="เลขบัตรประชาชน">
            {patient.national_id && <span className="mono">{patient.national_id}</span>}
          </Row>
          <Row label="เลข Passport">
            {patient.passport_no && <span className="mono">{patient.passport_no}</span>}
          </Row>
          <Row label="สัญชาติ">{patient.nationality}</Row>
        </section>

        <section className="card">
          <h2>ข้อมูลสุขภาพ</h2>
          <Row label="น้ำหนัก">{patient.weight_kg != null && `${patient.weight_kg} กก.`}</Row>
          <Row label="ส่วนสูง">{patient.height_cm != null && `${patient.height_cm} ซม.`}</Row>
          <Row label="กรุ๊ปเลือด">{patient.blood_type}</Row>
          <Row label="สิทธิการรักษา">{patient.medical_rights}</Row>
          <Row label="โรคประจำตัว">
            {patient.medical_history && <span className="pre-line">{patient.medical_history}</span>}
          </Row>
          <Row label="แพ้ยา">
            {patient.allergies && <span className="pre-line">{patient.allergies}</span>}
          </Row>
          <Row label="แพ้อาหาร">
            {patient.food_allergies && <span className="pre-line">{patient.food_allergies}</span>}
          </Row>
        </section>

        <section className="card">
          <h2>ผู้ว่าจ้าง / ที่อยู่</h2>
          <Row label="ผู้ว่าจ้าง (ลูกค้า)">
            {patient.customer ? (
              <Link className="link" to={`/customers/${patient.customer.customer_id}`}>
                {patient.customer.name} <span className="mono muted">({patient.customer.customer_id})</span>
              </Link>
            ) : null}
          </Row>
          <Row label="ที่อยู่สถานที่ดูแล">{fullAddress}</Row>
        </section>

        <section className="card">
          <h2>ญาติ / ผู้ติดต่อกรณีฉุกเฉิน</h2>
          <Row label="ชื่อผู้ติดต่อ">{patient.emergency_contact_name}</Row>
          <Row label="เบอร์ผู้ติดต่อ">{patient.emergency_contact_phone}</Row>
          <Row label="ความสัมพันธ์">{patient.emergency_contact_relation}</Row>

          <h2>อื่นๆ</h2>
          <Row label="หมายเหตุ">
            {patient.note && <span className="pre-line">{patient.note}</span>}
          </Row>
        </section>
      </div>

      <section className="card">
        <h2>เคสที่ผูกกับผู้รับการดูแลรายนี้ ({patient.cases.length})</h2>
        <PatientCases cases={patient.cases} />
      </section>

      <section className="card">
        <h2>ข้อมูลระบบ</h2>
        <Row label="สร้างเมื่อ">{formatDate(patient.created_at)}</Row>
        <Row label="แก้ไขล่าสุด">{formatDate(patient.updated_at)}</Row>
      </section>

      <section className="card danger-zone">
        <div>
          <strong>ลบถาวร</strong>
          <p className="muted">
            ลบแฟ้มผู้รับการดูแลออกจากฐานข้อมูล กู้คืนไม่ได้ — เคสที่เคยผูกไว้ยังอยู่ครบ แต่จะไม่เชื่อมกับแฟ้มนี้อีก
          </p>
        </div>
        <ConfirmButton
          className="btn danger"
          title={`ลบแฟ้มผู้รับการดูแล ${id} ออกจากฐานข้อมูลถาวร?`}
          detail="เคสที่เคยผูกไว้จะยังอยู่ (ข้อมูลผู้ป่วยถูกบันทึกในเคสแล้ว) แต่จะไม่เชื่อมกับแฟ้มนี้อีก"
          confirmLabel="ลบถาวร"
          onConfirm={handleDelete}
        >
          ลบถาวร
        </ConfirmButton>
      </section>
    </>
  );
}
