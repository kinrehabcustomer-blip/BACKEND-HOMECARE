import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import WorkHistory from './WorkHistory.jsx';
import Avatar from './Avatar.jsx';
import {
  POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS,
  formatBaht, formatDate,
} from '../labels.js';

// popup เป็นตัวอย่างข้อมูลย่อ — โชว์ประวัติการทำงานแค่ 3 ครั้งล่าสุด ที่เหลือดูที่หน้าเต็ม
const PREVIEW_HISTORY = 3;

/** อายุงาน/อายุ คำนวณจากวันที่ให้ดูง่าย — ข้อมูลที่ตารางไม่ได้โชว์ */
function yearsSince(dateStr) {
  if (!dateStr) return null;
  const from = new Date(dateStr);
  const months = (Date.now() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  const rest = Math.floor(months % 12);
  return years > 0 ? `${years} ปี ${rest} เดือน` : `${rest} เดือน`;
}

function Field({ label, value, mono }) {
  // รับ false ด้วย เพราะ `x && f(x)` ที่ผู้เรียกใช้จะคืน false เมื่อไม่มีค่า
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

export default function EmployeeModal({ employeeId, onClose }) {
  const [employee, setEmployee] = useState(null);
  const [error, setError] = useState(null);

  // ตารางรายชื่อมีข้อมูลไม่ครบ (ไม่มีใบรับรอง) จึงดึงข้อมูลเต็มด้วย employee_id อีกรอบ
  useEffect(() => {
    let cancelled = false;
    setEmployee(null);
    setError(null);

    api
      .getEmployee(employeeId)
      .then((data) => !cancelled && setEmployee(data))
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  // ปิดด้วย Esc + ล็อกไม่ให้หน้าหลังเลื่อนตาม
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* กันไม่ให้คลิกในกล่องทะลุไปโดน backdrop จนปิดเอง */}
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {error && <pre className="error">{error}</pre>}
        {!employee && !error && <p className="muted modal-loading">กำลังโหลด…</p>}

        {employee && (
          <>
            <header className="modal-head">
              <div className="head-identity">
                <Avatar employee={employee} size="avatar-lg" clickable />
                <div>
                  <p className="mono muted">{employee.employee_id}</p>
                  <h2>
                    {employee.first_name} {employee.last_name}
                    {employee.nickname && <span className="muted"> ({employee.nickname})</span>}
                  </h2>
                  <span className={`badge ${employee.status}`}>{STATUS_LABELS[employee.status]}</span>
                </div>
              </div>
              <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
            </header>

            <div className="modal-body">
              <section>
                <h3>ข้อมูลส่วนตัว</h3>
                <div className="field-grid">
                  <Field
                    label="ชื่อ-นามสกุล (อังกฤษ)"
                    value={[employee.first_name_en, employee.last_name_en].filter(Boolean).join(' ')}
                  />
                  <Field label="เลขบัตรประชาชน" value={employee.national_id} mono />
                  <Field label="เพศ" value={GENDER_LABELS[employee.gender]} />
                  <Field
                    label="วันเกิด"
                    value={
                      employee.birth_date &&
                      `${formatDate(employee.birth_date)} (อายุ ${yearsSince(employee.birth_date)?.split(' ปี')[0]} ปี)`
                    }
                  />
                  <Field label="เบอร์โทร" value={employee.phone} />
                  <Field label="อีเมล" value={employee.email} />
                </div>
                <Field label="ที่อยู่" value={employee.address} />
                <Field label="ประวัติการศึกษา" value={employee.education} />
              </section>

              <section>
                <h3>ข้อมูลการจ้างงาน</h3>
                <div className="field-grid">
                  <Field label="ตำแหน่ง" value={POSITION_LABELS[employee.position]} />
                  <Field label="ประเภทการจ้าง" value={EMPLOYMENT_TYPE_LABELS[employee.employment_type]} />
                  {/* ส่ง null เมื่อไม่มีค่า ให้ Field ขึ้น "ไม่ได้ระบุ" แทนที่จะเป็นขีด — */}
                  <Field label="ค่าจ้าง" value={employee.base_salary != null && formatBaht(employee.base_salary)} />
                  <Field label="วันเริ่มงาน" value={employee.hire_date && formatDate(employee.hire_date)} />
                  <Field label="อายุงาน" value={employee.resign_date ? null : yearsSince(employee.hire_date)} />
                  <Field label="วันลาออก" value={employee.resign_date && formatDate(employee.resign_date)} />
                </div>
              </section>

              <section>
                <h3>ผู้ติดต่อฉุกเฉิน</h3>
                <div className="field-grid">
                  <Field label="ชื่อผู้ติดต่อ" value={employee.emergency_contact_name} />
                  <Field label="เบอร์โทร" value={employee.emergency_contact_phone} />
                </div>
              </section>

              <section>
                <h3>ใบรับรอง / ใบประกอบวิชาชีพ ({employee.certificates.length})</h3>
                {employee.certificates.length === 0 && <p className="muted">ยังไม่มีใบรับรองในระบบ</p>}
                {employee.certificates.map((c) => {
                  const expired = c.expiry_date && new Date(c.expiry_date) < new Date();
                  return (
                    <div className="modal-cert" key={c.certificate_id}>
                      {c.has_image && (
                        <a
                          className="cert-thumb"
                          href={api.certificateImageUrl(employee.employee_id, c.certificate_id)}
                          target="_blank"
                          rel="noreferrer"
                          title="กดเพื่อดูรูปเต็ม"
                        >
                          <img
                            src={api.certificateImageUrl(employee.employee_id, c.certificate_id)}
                            alt={`รูป ${c.name}`}
                          />
                        </a>
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
                    </div>
                  );
                })}
              </section>

              <section>
                <h3>ผลงาน ({employee.portfolio.length})</h3>
                {employee.portfolio.length === 0 ? (
                  <p className="muted">ยังไม่มีผลงาน</p>
                ) : (
                  <div className="portfolio-grid">
                    {employee.portfolio.map((item) => (
                      <figure className="portfolio-item" key={item.portfolio_id}>
                        <a
                          href={api.portfolioImageUrl(employee.employee_id, item.portfolio_id)}
                          target="_blank"
                          rel="noreferrer"
                          title="กดเพื่อดูรูปเต็ม"
                        >
                          <img
                            src={api.portfolioImageUrl(employee.employee_id, item.portfolio_id)}
                            alt={item.title}
                          />
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

              <section>
                <h3>ประวัติการทำงาน ({employee.cases.length})</h3>
                <WorkHistory cases={employee.cases} limit={PREVIEW_HISTORY} />
              </section>

              <section>
                <h3>หมายเหตุ</h3>
                <Field label="บันทึกภายใน" value={employee.note} />
              </section>

              <section className="modal-meta">
                <Field label="สร้างเมื่อ" value={formatDate(employee.created_at)} />
                <Field label="แก้ไขล่าสุด" value={formatDate(employee.updated_at)} />
              </section>
            </div>

            <footer className="modal-foot">
              <Link className="btn" to={`/employees/${employee.employee_id}`}>เปิดหน้าเต็ม</Link>
              <Link className="btn primary" to={`/employees/${employee.employee_id}/edit`}>แก้ไขข้อมูล</Link>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
