import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import {
  POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS,
  formatBaht, formatDate,
} from '../labels.js';

const BLANK_CERT = { name: '', issuer: '', issued_date: '', expiry_date: '' };

function Row({ label, children }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{children || '—'}</span>
    </div>
  );
}

export default function EmployeeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [employee, setEmployee] = useState(null);
  const [cert, setCert] = useState(BLANK_CERT);
  const [error, setError] = useState(null);

  const reload = () => api.getEmployee(id).then(setEmployee).catch((err) => setError(err.message));

  useEffect(() => {
    reload();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addCertificate(e) {
    e.preventDefault();
    setError(null);
    try {
      const payload = Object.fromEntries(
        Object.entries(cert).map(([k, v]) => [k, v === '' ? null : v]),
      );
      await api.addCertificate(id, payload);
      setCert(BLANK_CERT);
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleResign() {
    if (!confirm(`บันทึกการลาออกของ ${id}?\nข้อมูลจะยังอยู่ในระบบ แต่สถานะจะเปลี่ยนเป็น "ลาออกแล้ว"`)) return;
    await api.resignEmployee(id, new Date().toISOString().slice(0, 10));
    reload();
  }

  async function handleDelete() {
    if (!confirm(`ลบ ${id} ออกจากฐานข้อมูลถาวร?\nใบรับรองทั้งหมดของพนักงานคนนี้จะถูกลบไปด้วย และกู้คืนไม่ได้`)) return;
    await api.deleteEmployee(id);
    navigate('/employees');
  }

  if (error) return <pre className="error">{error}</pre>;
  if (!employee) return <p className="muted">กำลังโหลด…</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <p className="mono muted">{employee.employee_id}</p>
          <h1>
            {employee.first_name} {employee.last_name}
            {employee.nickname && <span className="muted"> ({employee.nickname})</span>}
          </h1>
          <span className={`badge ${employee.status}`}>{STATUS_LABELS[employee.status]}</span>
        </div>
        <div className="actions">
          <Link className="btn" to="/employees">← กลับ</Link>
          <Link className="btn primary" to={`/employees/${id}/edit`}>แก้ไข</Link>
        </div>
      </header>

      <div className="columns">
        <section className="card">
          <h2>ข้อมูลส่วนตัว</h2>
          <Row label="เลขบัตรประชาชน"><span className="mono">{employee.national_id}</span></Row>
          <Row label="เพศ">{GENDER_LABELS[employee.gender]}</Row>
          <Row label="วันเกิด">{formatDate(employee.birth_date)}</Row>
          <Row label="เบอร์โทร">{employee.phone}</Row>
          <Row label="อีเมล">{employee.email}</Row>
          <Row label="ที่อยู่">{employee.address}</Row>
          <Row label="ผู้ติดต่อฉุกเฉิน">
            {employee.emergency_contact_name &&
              `${employee.emergency_contact_name} · ${employee.emergency_contact_phone ?? ''}`}
          </Row>
        </section>

        <section className="card">
          <h2>ข้อมูลการจ้างงาน</h2>
          <Row label="ตำแหน่ง">{POSITION_LABELS[employee.position]}</Row>
          <Row label="ประเภทการจ้าง">{EMPLOYMENT_TYPE_LABELS[employee.employment_type]}</Row>
          <Row label="วันเริ่มงาน">{formatDate(employee.hire_date)}</Row>
          <Row label="วันลาออก">{formatDate(employee.resign_date)}</Row>
          <Row label="ค่าจ้าง">{formatBaht(employee.base_salary)}</Row>
          <Row label="หมายเหตุ">{employee.note}</Row>
        </section>
      </div>

      <section className="card">
        <h2>ใบรับรอง / ใบประกอบวิชาชีพ</h2>
        {employee.certificates.length === 0 && <p className="muted">ยังไม่มีใบรับรอง</p>}
        {employee.certificates.map((c) => (
          <div className="cert" key={c.certificate_id}>
            <div>
              <strong>{c.name}</strong>
              <p className="muted">
                {c.issuer ?? 'ไม่ระบุผู้ออก'} · ออกเมื่อ {formatDate(c.issued_date)}
                {c.expiry_date && ` · หมดอายุ ${formatDate(c.expiry_date)}`}
              </p>
            </div>
            <button
              className="btn danger-ghost"
              onClick={async () => {
                await api.deleteCertificate(id, c.certificate_id);
                reload();
              }}
            >
              ลบ
            </button>
          </div>
        ))}

        <form className="cert-form" onSubmit={addCertificate}>
          <input
            required placeholder="ชื่อใบรับรอง *"
            value={cert.name} onChange={(e) => setCert({ ...cert, name: e.target.value })}
          />
          <input
            placeholder="ผู้ออกใบรับรอง"
            value={cert.issuer} onChange={(e) => setCert({ ...cert, issuer: e.target.value })}
          />
          <input
            type="date" title="วันที่ออก"
            value={cert.issued_date} onChange={(e) => setCert({ ...cert, issued_date: e.target.value })}
          />
          <input
            type="date" title="วันหมดอายุ"
            value={cert.expiry_date} onChange={(e) => setCert({ ...cert, expiry_date: e.target.value })}
          />
          <button className="btn" type="submit">+ เพิ่ม</button>
        </form>
      </section>

      <section className="card danger-zone">
        <div>
          <strong>บันทึกการลาออก</strong>
          <p className="muted">เก็บประวัติไว้ในระบบ เปลี่ยนสถานะเป็น "ลาออกแล้ว" — แนะนำให้ใช้วิธีนี้</p>
        </div>
        <button className="btn" onClick={handleResign} disabled={employee.status === 'resigned'}>
          บันทึกลาออก
        </button>

        <div>
          <strong>ลบถาวร</strong>
          <p className="muted">ลบข้อมูลพนักงานและใบรับรองทั้งหมดออกจากฐานข้อมูล กู้คืนไม่ได้</p>
        </div>
        <button className="btn danger" onClick={handleDelete}>ลบถาวร</button>
      </section>
    </>
  );
}
