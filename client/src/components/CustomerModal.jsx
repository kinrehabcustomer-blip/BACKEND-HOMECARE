import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import CustomerCases from './CustomerCases.jsx';
import {
  GENDER_LABELS, TITLE_LABELS, MARITAL_STATUS_LABELS, PATIENT_STATUS_LABELS,
  formatDate, ageFromBirthDate,
} from '../labels.js';

/** อายุจากวันเกิดแม่นกว่าเลขที่กรอกไว้เมื่อหลายปีก่อน — ใช้ช่อง age เป็นตัวสำรองเมื่อไม่รู้วันเกิด */
function displayAge(c) {
  const age = ageFromBirthDate(c.birth_date) ?? c.age;
  return age != null ? `${age} ปี` : null;
}

/** ที่อยู่เต็มจากส่วนย่อย — ประกอบตอนแสดง ไม่เก็บซ้ำ */
const fullAddress = (c) =>
  [c.address, c.subdistrict, c.district, c.province, c.postal_code].filter(Boolean).join(' ') || null;

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

export default function CustomerModal({ customerId, onClose, onChanged }) {
  const [customer, setCustomer] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setCustomer(null);
    setError(null);

    api
      .getCustomer(customerId)
      .then((data) => !cancelled && setCustomer(data))
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [customerId]);

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
        `ลบลูกค้า ${customerId}?\nเคสที่เคยให้บริการจะยังอยู่ในระบบ (ข้อมูลผู้ป่วยถูกบันทึกไว้ในเคสแล้ว) แต่จะไม่เชื่อมกับลูกค้ารายนี้อีก`,
      )
    ) {
      return;
    }

    await api.deleteCustomer(customerId);
    onChanged?.();
    onClose();
  }

  const genderAge = customer
    ? [GENDER_LABELS[customer.gender], displayAge(customer)].filter(Boolean).join(' / ')
    : '';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {!customer && !error && <p className="muted modal-loading">กำลังโหลด…</p>}
        {!customer && error && <pre className="error modal-loading">{error}</pre>}

        {customer && (
          <>
            <header className="modal-head">
              <div>
                <p className="mono muted">{customer.customer_id}</p>
                <h2>
                  {[TITLE_LABELS[customer.title], customer.name].filter(Boolean).join('')}
                  {customer.nickname && <span className="muted"> ({customer.nickname})</span>}
                </h2>
                {customer.name_en && <p className="muted">{customer.name_en}</p>}
              </div>
              <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
            </header>

            <div className="modal-body">
              <section>
                <h3>ข้อมูลพื้นฐาน</h3>
                <div className="field-grid">
                  <Field label="เพศ / อายุ" value={genderAge} />
                  <Field label="วันเกิด" value={customer.birth_date && formatDate(customer.birth_date)} />
                  <Field label="สถานภาพ" value={MARITAL_STATUS_LABELS[customer.marital_status]} />
                  <Field label="เลขบัตรประชาชน" value={customer.national_id} mono />
                  <Field label="เลข Passport" value={customer.passport_no} mono />
                  <Field label="สัญชาติ" value={customer.nationality} />
                  <Field label="อาชีพ" value={customer.occupation} />
                </div>
              </section>

              <section>
                <h3>ข้อมูลติดต่อ</h3>
                <div className="field-grid">
                  <Field label="เบอร์มือถือ" value={customer.phone} />
                  <Field label="เบอร์บ้าน" value={customer.home_phone} />
                  <Field label="Line ID" value={customer.line_id} />
                  <Field label="Email" value={customer.email} />
                </div>
                <Field label="ที่อยู่" value={fullAddress(customer)} />
              </section>

              <section>
                <h3>ผู้ดูแล / ญาติที่ติดต่อได้</h3>
                <div className="field-grid">
                  <Field label="ชื่อผู้ดูแล" value={customer.emergency_contact_name} />
                  <Field label="เบอร์ผู้ดูแล" value={customer.emergency_contact_phone} />
                </div>
              </section>

              <section>
                <h3>อื่นๆ</h3>
                <div className="field-grid">
                  <Field label="ประเภทลูกค้า" value={customer.customer_type} />
                  <Field label="รู้จักผ่านช่องทาง" value={customer.referral_source} />
                </div>
                <Field label="หมายเหตุ" value={customer.note} />
              </section>

              {/* ผู้รับการดูแลใต้ลูกค้ารายนี้ — ลูกค้าหนึ่งคนดูแลได้หลายคน (พ่อ+แม่) */}
              <section>
                <h3>ผู้รับการดูแล ({customer.patients?.length ?? 0})</h3>
                {(customer.patients?.length ?? 0) === 0 ? (
                  <p className="muted">ยังไม่มีผู้รับการดูแลในความดูแลของลูกค้ารายนี้</p>
                ) : (
                  customer.patients.map((p) => {
                    const age = ageFromBirthDate(p.birth_date) ?? p.age;
                    const meta = [
                      p.relation_to_customer,
                      GENDER_LABELS[p.gender],
                      age != null && `${age} ปี`,
                    ].filter(Boolean).join(' · ');
                    return (
                      <div className="history-item" key={p.patient_id}>
                        <div>
                          <strong>
                            <Link className="link" to={`/patients/${p.patient_id}`}>
                              {p.name}{p.nickname && ` (${p.nickname})`}
                            </Link>
                          </strong>
                          <p className="muted">
                            <span className="mono">{p.patient_id}</span>
                            {meta && ` · ${meta}`}
                          </p>
                        </div>
                        <span className={`badge ${p.status}`}>{PATIENT_STATUS_LABELS[p.status]}</span>
                      </div>
                    );
                  })
                )}
              </section>

              <section>
                <h3>เคสที่เคยใช้บริการ ({customer.cases.length})</h3>
                {/* popup เป็นตัวอย่างย่อ — โชว์ 3 เคสล่าสุด ที่เหลือดูที่หน้าเต็ม */}
                <CustomerCases cases={customer.cases} limit={3} />
              </section>

              <section className="modal-meta">
                <Field label="สร้างเมื่อ" value={formatDate(customer.created_at)} />
                <Field label="แก้ไขล่าสุด" value={formatDate(customer.updated_at)} />
              </section>
            </div>

            <footer className="modal-foot">
              <button className="btn danger-ghost" onClick={handleDelete}>ลบลูกค้า</button>
              <Link
                className="btn"
                to={`/cases/new?customer_id=${customer.customer_id}`}
              >
                + เปิดเคสให้ลูกค้ารายนี้
              </Link>
              <Link className="btn" to={`/customers/${customer.customer_id}`}>เปิดหน้าเต็ม</Link>
              <Link className="btn primary" to={`/customers/${customer.customer_id}/edit`}>แก้ไขข้อมูล</Link>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
