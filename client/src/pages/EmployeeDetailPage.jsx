import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import WorkHistory from '../components/WorkHistory.jsx';
import Avatar from '../components/Avatar.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import LineIcon from '../components/LineIcon.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import {
  POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS, formatDate, todayTH,
} from '../labels.js';
import { formatPhone } from '../lib/phone.js';


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
  const { user } = useAuth();
  const canSeeTempPassword = ['super_admin', 'manager', 'admin', 'hr'].includes(user?.position);

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

  async function handleUnlinkLine() {
    await api.unlinkEmployeeLine(id);
    reload();
  }

  // รหัสผูก LINE 6 หลัก (ดร.ธงชัย 23 ต.ค. 2569) — แสดงครั้งเดียวหลังกด ไม่ดึงซ้ำจากเซิร์ฟเวอร์ (เก็บแค่ hash)
  const [lineCode, setLineCode] = useState(null);
  const [lineCodeError, setLineCodeError] = useState(null);
  const [copied, setCopied] = useState(false);
  function copyLineCodeMessage() {
    const msg = `รหัสยืนยันตัวตนพนักงานของคุณ: ${lineCode.code}\n`
      + '1. เปิด LINE @kinjobs กดปุ่ม "เช็คอินเข้างาน" ในเมนูด้านล่าง\n'
      + '2. หน้าเข้าระบบจะเปิดขึ้น กรอกรหัส 6 หลักนี้ในช่อง "รหัส 6 หลัก"\n'
      + '3. กด "ยืนยันรหัส แล้วเข้าระบบ" — ครั้งต่อไปกดจาก LINE เข้าได้ทันที ไม่ต้องใช้รหัสผ่าน\n'
      + `(ใช้ได้ครั้งเดียว ถึง ${lineCode.expires_at} น.)`;
    navigator.clipboard?.writeText(msg).then(() => setCopied(true)).catch(() => setLineCodeError('คัดลอกไม่ได้ — จดรหัสส่งให้เองได้เลย'));
  }
  async function handleLineCode() {
    setCopied(false);
    setLineCodeError(null);
    try {
      setLineCode(await api.createEmployeeLineCode(id));
    } catch (err) {
      setLineCodeError(err.message);
    }
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

      {canSeeTempPassword && employee.must_change_password && (
        <p className="notice">
          <LineIcon name="alert" className="text-ico" />
          ยังใช้รหัสผ่านชั่วคราวอยู่ —{' '}
          {employee.temp_password
            ? <>รหัสคือ <strong className="mono">{employee.temp_password}</strong>{' '}</>
            : <>ไม่มีรหัสชั่วคราวที่บันทึกไว้สำหรับบัญชีนี้{' '}</>}
          แจ้งให้เจ้าตัวเข้าระบบแล้วเปลี่ยนรหัสผ่าน การแจ้งเตือนนี้จะหายไปเมื่อเปลี่ยนรหัสแล้ว
        </p>
      )}

      <div className="columns">
        <section className="card">
          <h2>ข้อมูลส่วนตัว</h2>
          <Row label="ชื่อ-นามสกุล (อังกฤษ)">
            {[employee.first_name_en, employee.last_name_en].filter(Boolean).join(' ')}
          </Row>
          <Row label="เลขบัตรประชาชน">{employee.national_id && <span className="mono">{employee.national_id}</span>}</Row>
          <Row label="เพศ">{GENDER_LABELS[employee.gender]}</Row>
          <Row label="วันเกิด">{formatDate(employee.birth_date)}</Row>
          <Row label="เบอร์โทร">{formatPhone(employee.phone)}</Row>
          <Row label="อีเมล">{employee.email}</Row>
          <Row label="ที่อยู่">{employee.address}</Row>
          {/* ขึ้นบรรทัดใหม่ตามที่กรอกไว้ — ประวัติการศึกษามักมีหลายบรรทัด */}
          <Row label="ประวัติการศึกษา">
            {employee.education && <span className="pre-line">{employee.education}</span>}
          </Row>
          <Row label="ผู้ติดต่อฉุกเฉิน">
            {employee.emergency_contact_name &&
              `${employee.emergency_contact_name} · ${formatPhone(employee.emergency_contact_phone) ?? ''}`}
          </Row>
        </section>

        <section className="card">
          <h2>ข้อมูลการจ้างงาน</h2>
          <Row label="ตำแหน่ง">{POSITION_LABELS[employee.position]}</Row>
          <Row label="ประเภทการจ้าง">{EMPLOYMENT_TYPE_LABELS[employee.employment_type]}</Row>
          <Row label="วันเริ่มงาน">{formatDate(employee.hire_date)}</Row>
          <Row label="วันลาออก">{formatDate(employee.resign_date)}</Row>
          <Row label="หมายเหตุ">{employee.note}</Row>
          {/* เข้าระบบด้วย LINE จากหน้า "งานของฉัน" ใน LINE OA — ผูกเองครั้งแรกด้วยรหัสผ่าน ปลดได้ที่นี่ */}
          {/* คำที่คนเห็น = "ยืนยันตัวตนพนักงาน" ไม่ใช่ "ผูก LINE" (ดร. 24 ต.ค. 2569 "ผูก line กับคินคืออะไร? ผมทำเองยังไม่รู้เรื่องเลย") */}
          <Row label="ยืนยันตัวตนผ่าน LINE">
            {employee.line_linked ? (
              <>
                ยืนยันตัวตนแล้ว{' '}
                <ConfirmButton
                  className="btn tiny"
                  title="ยกเลิกการยืนยันตัวตน LINE ของบัญชีนี้?"
                  detail="ครั้งหน้าที่เจ้าตัวกดจาก LINE ต้องยืนยันตัวตนใหม่ (รหัสยืนยันตัวตน 6 หลัก หรือรหัสผ่านเดิม)"
                  confirmLabel="ยกเลิกการยืนยัน"
                  cancelLabel="ยกเลิก"
                  danger={false}
                  onConfirm={handleUnlinkLine}
                >
                  ยกเลิกการยืนยันตัวตน
                </ConfirmButton>
              </>
            ) : (
              'ยังไม่ยืนยันตัวตน'
            )}{' '}
            <button type="button" className="btn tiny" onClick={handleLineCode}>
              {employee.line_linked ? 'ออกรหัสยืนยันตัวตนใหม่' : 'ออกรหัสยืนยันตัวตน'}
            </button>
            {/* อธิบายเป็นขั้น + ปุ่มคัดลอกข้อความส่งให้พนักงาน (ดร. 23 ต.ค. 2569 "รหัสผูกต้องอธิบายมากกว่านี้ ถึงจะเข้าใจ") */}
            {lineCode && (
              <span style={{ display: 'block', marginTop: 8, padding: 10, border: '1px solid #e5d5b0', borderRadius: 10, background: '#fbf6ec' }}>
                รหัสยืนยันตัวตนพนักงานของ {employee.first_name}:{' '}
                <strong style={{ fontSize: '1.6em', letterSpacing: 4 }}>{lineCode.code}</strong>
                <span style={{ display: 'block', marginTop: 6 }}>
                  <b>ส่งรหัสนี้ให้พนักงาน แล้วบอกให้ทำ 3 ขั้น:</b>
                  <br />1. เปิด LINE @kinjobs แล้วกดปุ่ม "เช็คอินเข้างาน" (หรือ "ส่งรายงานวันนี้") ในเมนูด้านล่าง
                  <br />2. หน้าเข้าระบบจะเปิดขึ้นมา กรอกรหัส 6 หลักนี้ในช่อง "รหัส 6 หลัก"
                  <br />3. กด "ยืนยันรหัส แล้วเข้าระบบ" — เสร็จ ครั้งต่อไปกดจาก LINE เข้าได้ทันที ไม่ต้องใช้รหัสผ่าน
                  <br /><span className="muted">หรือพิมพ์รหัสนี้ส่งในแชท LINE @kinjobs ก็ได้ · ใช้ได้ครั้งเดียว ถึง {lineCode.expires_at} น.</span>
                </span>
                <button type="button" className="btn tiny" style={{ marginTop: 6 }} onClick={copyLineCodeMessage}>
                  {copied ? 'คัดลอกแล้ว ✓ วางส่งใน LINE ได้เลย' : 'คัดลอกข้อความส่งให้พนักงาน'}
                </button>
              </span>
            )}
            {lineCodeError && <span style={{ display: 'block', color: '#b42318' }}>{lineCodeError}</span>}
          </Row>
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
