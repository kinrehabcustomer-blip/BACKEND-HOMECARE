import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import CustomerCases from '../components/CustomerCases.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import {
  GENDER_LABELS, TITLE_LABELS, MARITAL_STATUS_LABELS, PATIENT_STATUS_LABELS,
  formatDate, ageFromBirthDate,
} from '../labels.js';

function Row({ label, children }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{children || '—'}</span>
    </div>
  );
}

export default function CustomerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState(null);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0); // เด้งค่าเพื่อสั่งโหลดใหม่จากปุ่ม "ลองใหม่"

  useEffect(() => {
    api
      .getCustomer(id)
      .then((v) => {
        setCustomer(v);
        setError(null); // โหลดผ่านแล้ว error ของรอบก่อนต้องหายไปด้วย
      })
      .catch((err) => setError(err.message));
  }, [id, reloadKey]);

  async function handleDelete() {
    await api.deleteCustomer(id);
    navigate('/customers');
  }

  // โหลดไม่สำเร็จ ยังไม่มีข้อมูลให้แสดง — แต่ต้องมีทางกดใหม่ ไม่ใช่ต้องรีเฟรชเบราว์เซอร์เอง
  if (error) return <ErrorBar message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!customer) return <p className="muted">กำลังโหลด…</p>;

  // อายุจากวันเกิดแม่นกว่าเลขที่กรอกไว้เมื่อหลายปีก่อน — ใช้ช่อง age เป็นตัวสำรอง
  const age = ageFromBirthDate(customer.birth_date) ?? customer.age;
  const fullAddress =
    [customer.address, customer.subdistrict, customer.district, customer.province, customer.postal_code]
      .filter(Boolean)
      .join(' ');

  return (
    <>
      <header className="page-head">
        <div>
          <p className="mono muted">{customer.customer_id}</p>
          <h1>
            {[TITLE_LABELS[customer.title], customer.name].filter(Boolean).join('')}
            {customer.nickname && <span className="muted"> ({customer.nickname})</span>}
          </h1>
          {customer.name_en && <p className="muted">{customer.name_en}</p>}
        </div>
        <div className="actions">
          <Link className="btn" to="/customers">← กลับ</Link>
          <Link className="btn" to={`/cases/new?customer_id=${customer.customer_id}`}>+ เปิดเคส</Link>
          <Link className="btn primary" to={`/customers/${id}/edit`}>แก้ไข</Link>
        </div>
      </header>

      <div className="columns">
        <section className="card">
          <h2>ข้อมูลส่วนตัว</h2>
          <Row label="เพศ">{GENDER_LABELS[customer.gender]}</Row>
          <Row label="วันเกิด">
            {customer.birth_date && `${formatDate(customer.birth_date)}${age != null ? ` (อายุ ${age} ปี)` : ''}`}
          </Row>
          {/* ลูกค้าที่รู้แต่อายุคร่าวๆ ไม่มีวันเกิด — โชว์อายุแยกให้ ไม่งั้นบรรทัดบนจะว่างเปล่า */}
          {!customer.birth_date && <Row label="อายุ">{age != null && `${age} ปี`}</Row>}
          <Row label="สถานภาพ">{MARITAL_STATUS_LABELS[customer.marital_status]}</Row>
          {/* ครอบ mono เฉพาะตอนมีค่า — span เปล่าเป็น truthy ทำให้ Row ไม่ตกไปที่ '—' แล้วช่องจะว่างเปล่า */}
          <Row label="เลขบัตรประชาชน">
            {customer.national_id && <span className="mono">{customer.national_id}</span>}
          </Row>
          <Row label="เลข Passport">
            {customer.passport_no && <span className="mono">{customer.passport_no}</span>}
          </Row>
          <Row label="สัญชาติ">{customer.nationality}</Row>
          <Row label="อาชีพ">{customer.occupation}</Row>
        </section>

        <section className="card">
          <h2>ข้อมูลติดต่อ</h2>
          <Row label="เบอร์มือถือ">{customer.phone}</Row>
          <Row label="เบอร์บ้าน">{customer.home_phone}</Row>
          <Row label="Line ID">{customer.line_id}</Row>
          <Row label="Email">{customer.email}</Row>
          <Row label="ที่อยู่">{fullAddress}</Row>
        </section>

        <section className="card">
          <h2>ผู้ดูแล / ญาติที่ติดต่อได้</h2>
          <Row label="ชื่อผู้ดูแล">{customer.emergency_contact_name}</Row>
          <Row label="เบอร์ผู้ดูแล">{customer.emergency_contact_phone}</Row>

          <h2>อื่นๆ</h2>
          <Row label="ประเภทลูกค้า">{customer.customer_type}</Row>
          <Row label="รู้จักผ่านช่องทาง">{customer.referral_source}</Row>
          <Row label="หมายเหตุ">
            {customer.note && <span className="pre-line">{customer.note}</span>}
          </Row>
        </section>
      </div>

      {/* ผู้รับการดูแลใต้ลูกค้ารายนี้ — ลูกค้าหนึ่งคนดูแลได้หลายคน (พ่อ+แม่) */}
      <section className="card">
        <div className="card-head">
          <h2>ผู้รับการดูแล ({customer.patients?.length ?? 0})</h2>
          <Link className="btn" to={`/patients/new?customer_id=${customer.customer_id}`}>
            + เพิ่มผู้รับการดูแล
          </Link>
        </div>

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

      <section className="card">
        <h2>เคสที่เคยใช้บริการ ({customer.cases.length})</h2>
        <CustomerCases cases={customer.cases} />
      </section>

      <section className="card">
        <h2>ข้อมูลระบบ</h2>
        <Row label="สร้างเมื่อ">{formatDate(customer.created_at)}</Row>
        <Row label="แก้ไขล่าสุด">{formatDate(customer.updated_at)}</Row>
      </section>

      <section className="card danger-zone">
        <div>
          <strong>ลบถาวร</strong>
          <p className="muted">
            ลบข้อมูลลูกค้าออกจากฐานข้อมูล กู้คืนไม่ได้ — เคสที่เคยให้บริการยังอยู่ครบ แต่จะไม่เชื่อมกับลูกค้ารายนี้อีก
          </p>
        </div>
        <ConfirmButton
          className="btn danger"
          title={`ลบลูกค้า ${id} ออกจากฐานข้อมูลถาวร?`}
          detail="เคสที่เคยให้บริการจะยังอยู่ (ข้อมูลผู้ป่วยถูกบันทึกไว้ในเคสแล้ว) แต่จะไม่เชื่อมกับลูกค้ารายนี้อีก"
          confirmLabel="ลบถาวร"
          onConfirm={handleDelete}
        >
          ลบถาวร
        </ConfirmButton>
      </section>
    </>
  );
}
