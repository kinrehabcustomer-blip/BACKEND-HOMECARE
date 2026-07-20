import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import WorkHistory from '../components/WorkHistory.jsx';
import {
  POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS,
  formatBaht, formatDate,
} from '../labels.js';


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
  const [error, setError] = useState(null);

  const reload = () => api.getEmployee(id).then(setEmployee).catch((err) => setError(err.message));

  useEffect(() => {
    reload();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <Row label="ชื่อ-นามสกุล (อังกฤษ)">
            {[employee.first_name_en, employee.last_name_en].filter(Boolean).join(' ')}
          </Row>
          <Row label="เลขบัตรประชาชน"><span className="mono">{employee.national_id}</span></Row>
          <Row label="เพศ">{GENDER_LABELS[employee.gender]}</Row>
          <Row label="วันเกิด">{formatDate(employee.birth_date)}</Row>
          <Row label="เบอร์โทร">{employee.phone}</Row>
          <Row label="อีเมล">{employee.email}</Row>
          <Row label="ที่อยู่">{employee.address}</Row>
          {/* ขึ้นบรรทัดใหม่ตามที่กรอกไว้ — ประวัติการศึกษามักมีหลายบรรทัด */}
          <Row label="ประวัติการศึกษา">
            {employee.education && <span className="pre-line">{employee.education}</span>}
          </Row>
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

      {/* ดูอย่างเดียว — เพิ่ม/แก้/ลบใบรับรอง ทำที่หน้าแก้ไข */}
      <section className="card">
        <h2>ใบรับรอง / ใบประกอบวิชาชีพ</h2>

        {employee.certificates.length === 0 ? (
          <p className="muted">ยังไม่มีใบรับรอง</p>
        ) : (
          <ul className="cert-names">
            {employee.certificates.map((c) => {
              const expired = c.expiry_date && new Date(c.expiry_date) < new Date();
              return (
                <li key={c.certificate_id}>
                  {/* กดรูปเพื่อเปิดขนาดเต็มในแท็บใหม่ ใบที่ไม่มีรูปแสดงกรอบว่างไว้ให้แถวเรียงตรงกัน */}
                  {c.has_image ? (
                    <a
                      className="cert-thumb"
                      href={api.certificateImageUrl(id, c.certificate_id)}
                      target="_blank"
                      rel="noreferrer"
                      title="กดเพื่อดูรูปเต็ม"
                    >
                      <img src={api.certificateImageUrl(id, c.certificate_id)} alt={`รูป ${c.name}`} />
                    </a>
                  ) : (
                    <div className="cert-thumb empty"><span>ไม่มีรูป</span></div>
                  )}

                  <div className="cert-info">
                    <strong>{c.name}</strong>
                    <p className="muted">
                      {c.issuer ?? 'ไม่ระบุผู้ออก'} · ออกเมื่อ {formatDate(c.issued_date)}
                      {c.expiry_date && (
                        <>
                          {' '}· หมดอายุ {formatDate(c.expiry_date)}
                          {expired && <span className="badge suspended cert-flag">หมดอายุแล้ว</span>}
                        </>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ผลงาน — ดูอย่างเดียว จัดการที่หน้าแก้ไข */}
      <section className="card">
        <h2>ผลงาน</h2>

        {employee.portfolio.length === 0 ? (
          <p className="muted">ยังไม่มีผลงาน</p>
        ) : (
          <div className="portfolio-grid">
            {employee.portfolio.map((item) => (
              <figure className="portfolio-item" key={item.portfolio_id}>
                <a
                  href={api.portfolioImageUrl(id, item.portfolio_id)}
                  target="_blank"
                  rel="noreferrer"
                  title="กดเพื่อดูรูปเต็ม"
                >
                  <img src={api.portfolioImageUrl(id, item.portfolio_id)} alt={item.title} />
                </a>
                <figcaption>
                  <strong>{item.title}</strong>
                  {item.description && <p className="muted">{item.description}</p>}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      {/* ประวัติการทำงาน — โชว์ 3 เคสล่าสุด ที่เหลือกดปุ่มลูกศรขยายดูได้ */}
      <section className="card">
        <h2>ประวัติการทำงาน ({employee.cases.length})</h2>
        <WorkHistory cases={employee.cases} limit={3} collapsible />
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
