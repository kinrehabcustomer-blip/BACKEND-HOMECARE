import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, STATUS_LABELS, GENDER_LABELS } from '../labels.js';

const BLANK = {
  first_name: '', last_name: '', nickname: '', national_id: '', phone: '', email: '',
  gender: '', birth_date: '', address: '',
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
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isEdit) return;
    api.getEmployee(id).then((emp) => {
      // แปลง null จาก DB กลับเป็น "" เพื่อไม่ให้ input กลายเป็น uncontrolled
      const filled = { ...BLANK };
      for (const key of Object.keys(BLANK)) filled[key] = emp[key] ?? '';
      setForm(filled);
    }).catch((err) => setError(err.message));
  }, [id, isEdit]);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(form);
      const saved = isEdit ? await api.updateEmployee(id, payload) : await api.createEmployee(payload);
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
        <h2>ข้อมูลส่วนตัว</h2>
        <div className="grid">
          <label>ชื่อ *<input required {...field('first_name')} /></label>
          <label>นามสกุล *<input required {...field('last_name')} /></label>
          <label>ชื่อเล่น<input {...field('nickname')} /></label>
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

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกพนักงานใหม่'}
          </button>
        </div>
      </form>
    </>
  );
}
