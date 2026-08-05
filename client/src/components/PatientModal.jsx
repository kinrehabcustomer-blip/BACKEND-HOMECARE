import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import PatientCases from './PatientCases.jsx';
import {
  GENDER_LABELS, TITLE_LABELS, PATIENT_STATUS_LABELS, formatDate, ageFromBirthDate,
} from '../labels.js';

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

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

/**
 * แก้ช่องที่เปลี่ยนบ่อยที่สุดได้ตรงนี้เลย ไม่ต้องออกไปหน้าฟอร์มเต็ม
 * สถานะเปลี่ยนบ่อยสุด (พักการดูแล/กลับมาดูแลต่อ) ส่วนแพ้ยาต้องแก้ได้ทันทีที่รู้เพิ่ม เพราะเป็นข้อมูลความปลอดภัย
 */
function QuickEdit({ patient, onDone, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({
    status: patient.status,
    allergies: patient.allergies ?? '',
    food_allergies: patient.food_allergies ?? '',
    emergency_contact_phone: patient.emergency_contact_phone ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // ช่องว่างต้องเป็น null ไม่ใช่ "" ไม่งั้นไม่ผ่าน validation ของเบอร์โทร
      const blank = (v) => (v.trim() === '' ? null : v.trim());
      const updated = await api.updatePatient(patient.patient_id, {
        status: form.status,
        allergies: blank(form.allergies),
        food_allergies: blank(form.food_allergies),
        emergency_contact_phone: blank(form.emergency_contact_phone),
      });
      toast('บันทึกแล้ว');
      onDone(updated);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="quick-edit" onSubmit={handleSubmit}>
      {error && <p className="error">{error}</p>}
      <div className="grid cols-2">
        <label>สถานะ
          <select {...field('status')}>
            {Object.entries(PATIENT_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>เบอร์ผู้ติดต่อฉุกเฉิน<input inputMode="tel" {...field('emergency_contact_phone')} /></label>
        <label className="span-2">แพ้ยา
          <textarea rows={2} placeholder="เช่น เพนิซิลลิน แอสไพริน — ไม่มีให้เว้นว่าง" {...field('allergies')} />
        </label>
        <label className="span-2">แพ้อาหาร
          <textarea rows={2} placeholder="เช่น อาหารทะเล ถั่ว นมวัว — ไม่มีให้เว้นว่าง" {...field('food_allergies')} />
        </label>
      </div>
      <div className="quick-edit-actions">
        <button className="btn" type="button" onClick={onCancel} disabled={saving}>ยกเลิก</button>
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </div>
    </form>
  );
}

export default function PatientModal({ patientId, siblings = [], onNavigate, onClose, onChanged }) {
  const [patient, setPatient] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const boxRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setPatient(null);
    setError(null);
    setEditing(false); // เปลี่ยนคนแล้วต้องปิดโหมดแก้ ไม่งั้นค่าที่ค้างอยู่จะไปทับข้อมูลคนใหม่

    api
      .getPatient(patientId)
      .then((data) => !cancelled && setPatient(data))
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [patientId]);

  /*
   * ล็อกไม่ให้หน้าหลังเลื่อนตาม + คืนโฟกัสกลับไปที่แถวเดิมตอนปิด (ไม่ใช่ดีดกลับไปต้นหน้า)
   * ต้องแยกเป็น effect ที่ทำงานครั้งเดียวตลอดอายุกล่อง — ถ้าไปรวมกับ effect ที่มี deps
   * โฟกัสจะถูกคืนออกไปข้างนอกทุกครั้งที่ deps เปลี่ยน (เช่น ตอนกดเข้าโหมดแก้ด่วน)
   */
  useEffect(() => {
    const previous = document.activeElement;
    boxRef.current?.focus();
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  /* ปิดด้วย Esc + ขังโฟกัสไว้ในกล่อง — ถ้าไม่ขัง Tab จะวิ่งไปโดนลิงก์ที่อยู่หลังฉาก */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // กำลังแก้อยู่ Esc ควรยกเลิกการแก้ก่อน ไม่ใช่ปิดทั้งกล่องจนสิ่งที่พิมพ์ไว้หาย
        if (editing) setEditing(false);
        else onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      const items = [...(boxRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === boxRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, editing]);

  // ตำแหน่งของคนนี้ในรายการหน้าปัจจุบัน — ใช้ทำปุ่มดูคนก่อนหน้า/ถัดไป
  const index = siblings.indexOf(patientId);
  const prevId = index > 0 ? siblings[index - 1] : null;
  const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  /** แก้ด่วนสำเร็จ — เอาข้อมูลใหม่มาแสดงทันที แล้วบอกหน้ารายการให้ดึงใหม่ */
  const handleSaved = (updated) => {
    setPatient((prev) => ({ ...prev, ...updated }));
    setEditing(false);
    onChanged?.();
  };

  async function handleDelete() {
    if (
      !confirm(
        `ลบแฟ้มผู้รับการดูแล ${patientId}?\nเคสที่เคยผูกไว้จะยังอยู่ในระบบ (ข้อมูลผู้ป่วยถูกบันทึกในเคสแล้ว) แต่จะไม่เชื่อมกับแฟ้มนี้อีก`,
      )
    ) {
      return;
    }

    setDeleting(true);
    try {
      await api.deletePatient(patientId);
      toast(`ลบแฟ้ม ${patientId} แล้ว`);
      onChanged?.();
      onClose();
    } catch (err) {
      // ก่อนหน้านี้ไม่มี catch — ลบไม่สำเร็จแล้วเงียบสนิท ผู้ใช้เห็น popup ค้างอยู่โดยไม่รู้ว่าเกิดอะไรขึ้น
      setError(err.message);
      setDeleting(false);
    }
  }

  const genderAge = patient
    ? [GENDER_LABELS[patient.gender], displayAge(patient)].filter(Boolean).join(' / ')
    : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="ข้อมูลผู้รับการดูแล"
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
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

              <div className="modal-head-actions">
                {/* ไล่ดูทีละคนได้โดยไม่ต้องปิด-เปิดใหม่ (เฉพาะคนที่อยู่ในหน้ารายการปัจจุบัน) */}
                {siblings.length > 1 && (
                  <span className="modal-nav">
                    <button className="btn icon-btn" disabled={!prevId} onClick={() => onNavigate?.(prevId)} title="คนก่อนหน้า" aria-label="คนก่อนหน้า">‹</button>
                    <button className="btn icon-btn" disabled={!nextId} onClick={() => onNavigate?.(nextId)} title="คนถัดไป" aria-label="คนถัดไป">›</button>
                  </span>
                )}
                <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
              </div>
            </header>

            <div className="modal-body">
              {/* error ที่เกิดหลังโหลดข้อมูลได้แล้ว (เช่น ลบไม่สำเร็จ) — ต้องมีที่ยืนของตัวเอง
                  ไม่งั้นจะถูกกลืนหายไปเพราะเงื่อนไขด้านบนแสดงเฉพาะตอนยังไม่มีข้อมูล */}
              {error && <p className="error">{error}</p>}

              {/* แยกสองแถบ ไม่รวมเป็นแถบเดียว — คนที่มาอ่านมักสนใจอย่างใดอย่างหนึ่ง
                  (คนให้ยาดูแพ้ยา คนเตรียมอาหารดูแพ้อาหาร) รวมกันแล้วต้องอ่านทั้งก้อนเพื่อหาบรรทัดของตัวเอง */}
              {patient.allergies && (
                <p className="notice allergy-alert">
                  <strong>⚠ แพ้ยา:</strong> {patient.allergies}
                </p>
              )}
              {patient.food_allergies && (
                <p className="notice allergy-alert">
                  <strong>⚠ แพ้อาหาร:</strong> {patient.food_allergies}
                </p>
              )}

              {/* ผู้ว่าจ้างขึ้นก่อน — ผู้รับการดูแลไม่มีเบอร์ของตัวเอง เบอร์ที่โทรจริงคือเบอร์คนนี้ */}
              <section>
                <div className="section-head">
                  <h3>ผู้ว่าจ้าง &amp; การติดต่อ</h3>
                  {!editing && <button className="btn tiny" onClick={() => setEditing(true)}>แก้ด่วน</button>}
                </div>

                {editing ? (
                  <QuickEdit patient={patient} onDone={handleSaved} onCancel={() => setEditing(false)} />
                ) : (
                  <div className="field-grid">
                    <Field
                      label="ลูกค้า (ผู้ว่าจ้าง)"
                      value={
                        patient.customer && (
                          <Link className="link" to={`/customers?open=${patient.customer.customer_id}`}>
                            {patient.customer.name} ({patient.customer.customer_id})
                          </Link>
                        )
                      }
                    />
                    <Field
                      label="เบอร์ผู้ว่าจ้าง"
                      value={
                        patient.customer?.phone &&
                        <a className="link" href={`tel:${patient.customer.phone}`}>{patient.customer.phone}</a>
                      }
                    />
                    <Field label="ชื่อผู้ติดต่อฉุกเฉิน" value={patient.emergency_contact_name} />
                    <Field
                      label="เบอร์ผู้ติดต่อฉุกเฉิน"
                      value={
                        patient.emergency_contact_phone &&
                        <a className="link" href={`tel:${patient.emergency_contact_phone}`}>{patient.emergency_contact_phone}</a>
                      }
                    />
                    <Field label="ความสัมพันธ์กับผู้ติดต่อ" value={patient.emergency_contact_relation} />
                    <Field label="ความสัมพันธ์กับผู้ว่าจ้าง" value={patient.relation_to_customer} />
                  </div>
                )}
              </section>

              <section>
                <h3>ข้อมูลพื้นฐาน</h3>
                <div className="field-grid">
                  <Field label="เพศ / อายุ" value={genderAge} />
                  <Field label="วันเกิด" value={patient.birth_date && formatDate(patient.birth_date)} />
                  <Field label="เลขบัตรประชาชน" value={patient.national_id} mono />
                  <Field label="สัญชาติ" value={patient.nationality} />
                </div>
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
                <Field label="แพ้ยา" value={patient.allergies} />
                <Field label="แพ้อาหาร" value={patient.food_allergies} />
                <Field label="ที่อยู่สถานที่ดูแล" value={fullAddress(patient)} />
              </section>

              <section>
                <h3>หมายเหตุ</h3>
                <Field label="บันทึกภายใน" value={patient.note} />
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
              {/* ปุ่มลบดันไปชิดซ้ายสุด แยกออกจากกลุ่มปุ่มที่กดกันจริง — ไม่ให้มือไปโดนตอนเล็งปุ่มข้างๆ */}
              <button className="btn danger-ghost foot-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'กำลังลบ…' : 'ลบแฟ้ม'}
              </button>
              <Link className="btn" to={`/cases/new?patient_id=${patient.patient_id}`}>+ เปิดเคส</Link>
              <Link className="btn" to={`/patients/${patient.patient_id}`}>เปิดหน้าเต็ม</Link>
              <Link className="btn primary" to={`/patients/${patient.patient_id}/edit`}>แก้ไขทั้งหมด</Link>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
