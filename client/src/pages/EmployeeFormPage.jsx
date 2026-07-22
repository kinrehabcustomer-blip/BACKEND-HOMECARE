import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import CertificateSection from '../components/CertificateSection.jsx';
import PortfolioSection from '../components/PortfolioSection.jsx';
import PhotoField from '../components/PhotoField.jsx';
import { POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS } from '../labels.js';

const BLANK = {
  first_name: '', last_name: '', first_name_en: '', last_name_en: '',
  nickname: '', national_id: '', phone: '', email: '',
  gender: '', birth_date: '', address: '', education: '',
  position: 'caregiver', employment_type: 'fulltime', status: 'active',
  hire_date: '', base_salary: '',
  emergency_contact_name: '', emergency_contact_phone: '', note: '',
};

/** ช่องว่างในฟอร์มต้องส่งเป็น null ไม่ใช่ "" — ไม่งั้นจะไม่ผ่าน validation ของ email/date/national_id */
function toPayload(form) {
  const payload = {};
  for (const [key, value] of Object.entries(form)) {
    if (key === 'base_salary') {
      payload[key] = value === '' ? null : Number(value);
    } else {
      payload[key] = value === '' ? null : value;
    }
  }
  return payload;
}

export default function EmployeeFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState(BLANK);
  // สภาพรูปที่อยู่ใน DB ตอนนี้ — แยกจาก form เพราะรูปไม่ได้ถูกส่งไปกับ JSON ของพนักงาน (ไปคนละเส้น)
  const [savedPhoto, setSavedPhoto] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const certificates = useRef(null); // ส่วนใบรับรอง — สั่งบันทึกใบที่รออยู่ตอนกดปุ่มบันทึก
  const portfolio = useRef(null); // ส่วนผลงาน — เช่นเดียวกัน
  const photo = useRef(null); // รูปพนักงาน — เช่นเดียวกัน

  useEffect(() => {
    if (!isEdit) return;
    api.getEmployee(id).then((emp) => {
      // แปลง null จาก DB กลับเป็น "" เพื่อไม่ให้ input กลายเป็น uncontrolled
      const filled = { ...BLANK };
      for (const key of Object.keys(BLANK)) filled[key] = emp[key] ?? '';
      setForm(filled);
      setSavedPhoto({ has_photo: emp.has_photo, updated_at: emp.updated_at });
    }).catch((err) => setError(err.message));
  }, [id, isEdit]);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  /** ปุ่มบันทึกอันเดียว: บันทึกข้อมูลพนักงานก่อน แล้วค่อยเอาใบรับรองที่รออยู่ไปผูกกับรหัสพนักงาน */
  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(form);
      const saved = isEdit ? await api.updateEmployee(id, payload) : await api.createEmployee(payload);

      // พนักงานใหม่เพิ่งได้รหัสตรงนี้ รูป/ใบรับรอง/ผลงานจึงต้องบันทึกหลังพนักงานเสมอ
      await photo.current?.save(saved.employee_id);
      await certificates.current?.save(saved.employee_id);
      await portfolio.current?.save(saved.employee_id);

      navigate(`/employees/${saved.employee_id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{isEdit ? `แก้ไขข้อมูล ${id}` : 'เพิ่มพนักงานใหม่'}</h1>
          {!isEdit && <p className="muted">ระบบจะออกรหัสพนักงาน (EMP-xxxx) ให้อัตโนมัติหลังบันทึก</p>}
        </div>
        <Link className="btn" to={isEdit ? `/employees/${id}` : '/employees'}>ยกเลิก</Link>
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" onSubmit={handleSubmit}>
        <h2>รูปพนักงาน</h2>
        <PhotoField ref={photo} employeeId={id ?? null} saved={savedPhoto} />

        <h2>ข้อมูลส่วนตัว</h2>
        <div className="grid">
          <label>ชื่อ (ไทย) *<input required {...field('first_name')} /></label>
          <label>นามสกุล (ไทย) *<input required {...field('last_name')} /></label>
          <label>ชื่อเล่น<input {...field('nickname')} /></label>

          <label>ชื่อ (อังกฤษ)<input placeholder="Phupha" {...field('first_name_en')} /></label>
          <label>นามสกุล (อังกฤษ)<input placeholder="Chunyong" {...field('last_name_en')} /></label>
          <label>เลขบัตรประชาชน<input maxLength={13} placeholder="13 หลัก" {...field('national_id')} /></label>
          <label>เพศ
            <select {...field('gender')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>วันเกิด<input type="date" {...field('birth_date')} /></label>
          <label>เบอร์โทร<input {...field('phone')} /></label>
          <label>อีเมล<input type="email" {...field('email')} /></label>
          <label className="span-2">ที่อยู่<textarea rows={2} {...field('address')} /></label>
          <label className="span-2">ประวัติการศึกษา
            <textarea
              rows={3}
              placeholder="เช่น ปวส. การดูแลผู้สูงอายุ · วิทยาลัยอาชีวศึกษา · จบปี 2562&#10;ป.ตรี พยาบาลศาสตร์ · มหาวิทยาลัยมหิดล · จบปี 2565"
              {...field('education')}
            />
          </label>
        </div>

        <h2>ข้อมูลการจ้างงาน</h2>
        <div className="grid">
          <label>ตำแหน่ง *
            <select required {...field('position')}>
              {Object.entries(POSITION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>ประเภทการจ้าง
            <select {...field('employment_type')}>
              {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>สถานะ
            <select {...field('status')}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>วันเริ่มงาน<input type="date" {...field('hire_date')} /></label>
          <label>ค่าจ้าง (บาท)<input type="number" min="0" step="0.01" {...field('base_salary')} /></label>
        </div>

        <h2>ผู้ติดต่อฉุกเฉิน</h2>
        <div className="grid">
          <label>ชื่อผู้ติดต่อ<input {...field('emergency_contact_name')} /></label>
          <label>เบอร์โทร<input {...field('emergency_contact_phone')} /></label>
          <label className="span-2">หมายเหตุ<textarea rows={2} {...field('note')} /></label>
        </div>

        {/* อยู่ในการ์ดและฟอร์มเดียวกัน — ใช้ปุ่มบันทึกร่วมกันด้านล่าง */}
        <CertificateSection ref={certificates} employeeId={id ?? null} />
        <PortfolioSection ref={portfolio} employeeId={id ?? null} />

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกพนักงานใหม่'}
          </button>
        </div>
      </form>
    </>
  );
}
