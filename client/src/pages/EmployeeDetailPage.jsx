import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import WorkHistory from '../components/WorkHistory.jsx';
import Avatar from '../components/Avatar.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import LineIcon from '../components/LineIcon.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import {
  POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS, formatDate, todayTH,
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

  // มี reload() อยู่แล้ว (ปุ่มบันทึกลาออกก็เรียกตัวนี้) — ปุ่ม "ลองใหม่" ใช้ตัวเดียวกัน ไม่ต้องมีตัวนับซ้อน
  /* isStale: กดสลับพนักงานเร็วๆ คำตอบของคนก่อนหน้าที่มาถึงทีหลังต้องถูกทิ้ง
     ไม่งั้นหน้าจะขึ้นชื่อคนหนึ่งแต่ข้อมูล/ใบรับรองของอีกคน (ปุ่มลาออก/นำออกก็จะเล็งผิดคนตามไปด้วย) */
  const reload = (isStale = () => false) =>
    api
      .getEmployee(id)
      .then((v) => {
        if (isStale()) return;
        setEmployee(v);
        setError(null); // โหลดผ่านแล้ว error ของรอบก่อนต้องหายไปด้วย
      })
      .catch((err) => !isStale() && setError(err.message));

  useEffect(() => {
    let cancelled = false;
    reload(() => cancelled);
    return () => { cancelled = true; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleResign() {
    await api.resignEmployee(id, todayTH());
    reload();
  }

  async function handleDelete() {
    await api.deleteEmployee(id);
    navigate('/employees');
  }

  // โหลดไม่สำเร็จ ยังไม่มีข้อมูลให้แสดง — แต่ต้องมีทางกดใหม่ ไม่ใช่ต้องรีเฟรชเบราว์เซอร์เอง
  if (error) return <ErrorBar message={error} onRetry={reload} />;
  if (!employee) return <p className="muted">กำลังโหลด…</p>;

  return (
    <>
      <header className="page-head">
        <div className="head-identity">
          <Avatar employee={employee} size="avatar-lg" clickable />
          <div>
            <p className="mono muted">{employee.employee_id}</p>
            <h1>
              {employee.first_name} {employee.last_name}
              {employee.nickname && <span className="muted"> ({employee.nickname})</span>}
            </h1>
            <span className={`badge ${employee.status}`}>{STATUS_LABELS[employee.status]}</span>
          </div>
        </div>
        <div className="actions">
          <Link className="btn" to="/employees">← กลับ</Link>
          <Link className="btn primary" to={`/employees/${id}/edit`}>แก้ไข</Link>
        </div>
      </header>

      {/* คนนี้ยังไม่เคยตั้งรหัสผ่านของตัวเอง = ยังใช้รหัสตั้งต้นซึ่งคือรหัสพนักงาน
          ที่เดียวในระบบที่บอกเรื่องนี้ ต้องอยู่ตรงนี้ ไม่ใช่บนหน้า login ซึ่งใครก็เปิดได้
          เดิมหน้า login เขียนไว้ให้ทุกคนอ่าน ส่วนฝ่ายบุคคลที่ต้องแจ้งพนักงานใหม่กลับไม่มีอะไรบอกเลย
          ป้ายนี้หายไปเองเมื่อเจ้าตัวเปลี่ยนรหัสแล้ว (must_change_password) จึงใช้เช็คได้ด้วยว่าใครยังค้าง */}
      {employee.must_change_password && (
        <p className="notice">
          <LineIcon name="alert" className="text-ico" />
          ยังใช้รหัสผ่านตั้งต้นอยู่ — รหัสคือ <strong className="mono">{employee.employee_id}</strong>{' '}
          แจ้งให้เจ้าตัวเข้าระบบแล้วเปลี่ยนรหัสทันที เพราะรหัสพนักงานเป็นเลขที่คนอื่นเห็นได้
        </p>
      )}

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
          // แถวรูปย่อ + ข้อความ ขนาดเดียวกับใบรับรองในการ์ดด้านบน (ดู .media-* ใน index.css)
          <div>
            {employee.portfolio.map((item) => (
              <figure className="media-row" key={item.portfolio_id}>
                <a
                  className="media-thumb"
                  href={api.portfolioImageUrl(id, item.portfolio_id)}
                  target="_blank"
                  rel="noreferrer"
                  title="กดเพื่อดูรูปเต็ม"
                >
                  <img src={api.portfolioImageUrl(id, item.portfolio_id)} alt={item.title} />
                </a>
                <figcaption className="media-info">
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
        <WorkHistory
          cases={employee.cases}
          limit={3}
          collapsible
          employeeName={`${employee.first_name} ${employee.last_name}`}
        />
      </section>

      <section className="card danger-zone">
        <div>
          <strong>บันทึกการลาออก</strong>
          <p className="muted">เก็บประวัติไว้ในระบบ เปลี่ยนสถานะเป็น "ลาออกแล้ว" — แนะนำให้ใช้วิธีนี้</p>
        </div>
        <ConfirmButton
          className="btn"
          disabled={employee.status === 'resigned'}
          title={`บันทึกการลาออกของ ${id}?`}
          detail='ข้อมูลจะยังอยู่ในระบบ แต่สถานะจะเปลี่ยนเป็น "ลาออกแล้ว"'
          confirmLabel="บันทึกลาออก"
          cancelLabel="ยังไม่บันทึก"
          danger={false}
          onConfirm={handleResign}
        >
          บันทึกลาออก
        </ConfirmButton>

        <div>
          <strong>ลบถาวร</strong>
          <p className="muted">ลบข้อมูลพนักงานและใบรับรองทั้งหมดออกจากฐานข้อมูล กู้คืนไม่ได้</p>
        </div>
        <ConfirmButton
          className="btn danger"
          title={`ลบ ${id} ออกจากฐานข้อมูลถาวร?`}
          detail="ใบรับรองทั้งหมดของพนักงานคนนี้จะถูกลบไปด้วย และกู้คืนไม่ได้"
          confirmLabel="ลบถาวร"
          onConfirm={handleDelete}
        >
          ลบถาวร
        </ConfirmButton>
      </section>
    </>
  );
}
