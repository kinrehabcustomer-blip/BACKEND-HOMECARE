import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import WorkHistory from './WorkHistory.jsx';
import Avatar from './Avatar.jsx';
import {
  POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS,
  formatBaht, formatDate,
} from '../labels.js';
import LineIcon from './LineIcon.jsx';

// popup เป็นตัวอย่างข้อมูลย่อ — โชว์ประวัติการทำงานแค่ 3 ครั้งล่าสุด ที่เหลือดูที่หน้าเต็ม
const PREVIEW_HISTORY = 3;

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

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

/**
 * แก้ช่องที่เปลี่ยนบ่อยที่สุดได้ตรงนี้เลย ไม่ต้องออกไปหน้าฟอร์มเต็ม
 * เลือกมาสามช่องเพราะเป็นสิ่งที่แก้กันจริงในงานประจำวัน (ย้ายตำแหน่ง, เปลี่ยนเบอร์, ลาพัก/กลับมา)
 * ที่เหลือยังต้องไปหน้าฟอร์ม — ช่องพวกนั้นแก้กันปีละครั้ง ไม่คุ้มกับความเสี่ยงที่จะกดพลาดในนี้
 */
function QuickEdit({ employee, onDone, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({
    status: employee.status,
    position: employee.position,
    phone: employee.phone ?? '',
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
      const updated = await api.updateEmployee(employee.employee_id, {
        ...form,
        phone: form.phone.trim() === '' ? null : form.phone.trim(),
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
            {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>ตำแหน่ง
          <select {...field('position')}>
            {Object.entries(POSITION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="span-2">เบอร์โทร
          <input placeholder="เช่น 081-234-5678" {...field('phone')} />
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

export default function EmployeeModal({ employeeId, siblings = [], onNavigate, onSaved, onClose }) {
  const [employee, setEmployee] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const boxRef = useRef(null);
  // จอแคบ: ปัดลงเพื่อปิด — ใช้ ref เดียวกับ focus trap เพราะ element เดียวแปะสอง ref ไม่ได้
  useSheetSwipe(onClose, boxRef);

  // ตารางรายชื่อมีข้อมูลไม่ครบ (ไม่มีใบรับรอง) จึงดึงข้อมูลเต็มด้วย employee_id อีกรอบ
  useEffect(() => {
    let cancelled = false;
    setEmployee(null);
    setError(null);
    setEditing(false); // เปลี่ยนคนแล้วต้องปิดโหมดแก้ ไม่งั้นค่าที่ค้างอยู่จะไปทับข้อมูลคนใหม่

    api
      .getEmployee(employeeId)
      .then((data) => !cancelled && setEmployee(data))
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  /*
   * ล็อกไม่ให้หน้าหลังเลื่อนตาม + คืนโฟกัสกลับไปที่แถวเดิมตอนปิด (ไม่ใช่ดีดกลับไปต้นหน้า)
   * ต้องแยกออกมาเป็น effect ที่ทำงานครั้งเดียวตลอดอายุกล่อง — ถ้าไปรวมกับ effect ที่มี deps
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

  /*
   * ปิดด้วย Esc + ขังโฟกัสไว้ในกล่อง
   * ถ้าไม่ขัง Tab จะวิ่งไปโดนลิงก์/ปุ่มที่อยู่หลังฉาก ซึ่งคนใช้คีย์บอร์ดจะหลงทางทันที
   */
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
  const index = siblings.indexOf(employeeId);
  const prevId = index > 0 ? siblings[index - 1] : null;
  const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  /** แก้ด่วนสำเร็จ — เอาข้อมูลใหม่มาแสดงทันที แล้วบอกหน้ารายการให้ดึงใหม่ ตัวเลขสรุปจะได้ตรง */
  const handleSaved = (updated) => {
    setEmployee((prev) => ({ ...prev, ...updated }));
    setEditing(false);
    onSaved?.();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* กันไม่ให้คลิกในกล่องทะลุไปโดน backdrop จนปิดเอง */}
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="ข้อมูลพนักงาน"
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
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

              <div className="modal-head-actions">
                {/* ไล่ดูทีละคนได้โดยไม่ต้องปิด-เปิดใหม่ (เฉพาะคนที่อยู่ในหน้ารายการปัจจุบัน) */}
                {siblings.length > 1 && (
                  <span className="modal-nav">
                    <button
                      className="btn icon-btn"
                      disabled={!prevId}
                      onClick={() => onNavigate?.(prevId)}
                      title="คนก่อนหน้า"
                      aria-label="คนก่อนหน้า"
                    ><LineIcon name="chevron-left" /></button>
                    <button
                      className="btn icon-btn"
                      disabled={!nextId}
                      onClick={() => onNavigate?.(nextId)}
                      title="คนถัดไป"
                      aria-label="คนถัดไป"
                    ><LineIcon name="chevron-right" /></button>
                  </span>
                )}
                <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
              </div>
            </header>

            <div className="modal-body">
              {/* ข้อมูลติดต่อขึ้นก่อนทุกอย่าง — คนส่วนใหญ่เปิด popup นี้มาหาเบอร์โทร */}
              <section>
                <div className="section-head">
                  <h3>ติดต่อ &amp; งานปัจจุบัน</h3>
                  {!editing && (
                    <button className="btn tiny" onClick={() => setEditing(true)}>แก้ด่วน</button>
                  )}
                </div>

                {editing ? (
                  <QuickEdit employee={employee} onDone={handleSaved} onCancel={() => setEditing(false)} />
                ) : (
                  <div className="field-grid">
                    <Field
                      label="เบอร์โทร"
                      value={employee.phone && <a className="link" href={`tel:${employee.phone}`}>{employee.phone}</a>}
                    />
                    <Field
                      label="อีเมล"
                      value={employee.email && <a className="link" href={`mailto:${employee.email}`}>{employee.email}</a>}
                    />
                    <Field label="ตำแหน่ง" value={POSITION_LABELS[employee.position]} />
                    <Field label="ประเภทการจ้าง" value={EMPLOYMENT_TYPE_LABELS[employee.employment_type]} />
                  </div>
                )}
              </section>

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
                </div>
                <Field label="ที่อยู่" value={employee.address} />
                <Field label="ประวัติการศึกษา" value={employee.education} />
              </section>

              <section>
                <h3>ข้อมูลการจ้างงาน</h3>
                <div className="field-grid">
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
                  <Field
                    label="เบอร์โทร"
                    value={
                      employee.emergency_contact_phone &&
                      <a className="link" href={`tel:${employee.emergency_contact_phone}`}>{employee.emergency_contact_phone}</a>
                    }
                  />
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
                  // แถวรูปย่อ + ข้อความ ขนาดเดียวกับใบรับรองด้านบน (ดู .media-* ใน index.css)
                  employee.portfolio.map((item) => (
                    <figure className="media-row" key={item.portfolio_id}>
                      <a
                        className="media-thumb"
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
                      <figcaption className="media-info">
                        <strong>{item.title}</strong>
                        {item.description && <p className="muted">{item.description}</p>}
                      </figcaption>
                    </figure>
                  ))
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
              <Link className="btn primary" to={`/employees/${employee.employee_id}/edit`}>แก้ไขทั้งหมด</Link>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
