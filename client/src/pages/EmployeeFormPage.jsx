import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
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
  const toast = useToast();
  const isEdit = Boolean(id);

  const [form, setForm] = useState(BLANK);
  // สภาพรูปที่อยู่ใน DB ตอนนี้ — แยกจาก form เพราะรูปไม่ได้ถูกส่งไปกับ JSON ของพนักงาน (ไปคนละเส้น)
  const [savedPhoto, setSavedPhoto] = useState(null);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const certificates = useRef(null); // ส่วนใบรับรอง — สั่งบันทึกใบที่รออยู่ตอนกดปุ่มบันทึก
  const portfolio = useRef(null); // ส่วนผลงาน — เช่นเดียวกัน
  const photo = useRef(null); // รูปพนักงาน — เช่นเดียวกัน
  const formEl = useRef(null);

  // ค่าตั้งต้นไว้เทียบว่าผู้ใช้แก้อะไรไปแล้วบ้าง (ใช้เตือนก่อนออกจากหน้า)
  const initial = useRef(JSON.stringify(BLANK));

  useEffect(() => {
    if (!isEdit) return;
    api.getEmployee(id).then((emp) => {
      // แปลง null จาก DB กลับเป็น "" เพื่อไม่ให้ input กลายเป็น uncontrolled
      const filled = { ...BLANK };
      for (const key of Object.keys(BLANK)) filled[key] = emp[key] ?? '';
      setForm(filled);
      initial.current = JSON.stringify(filled);
      setSavedPhoto({ has_photo: emp.has_photo, updated_at: emp.updated_at });
    }).catch((err) => setError(err.message));
  }, [id, isEdit]);

  /** มีอะไรที่กรอก/เลือกไว้แล้วแต่ยังไม่ได้บันทึกไหม — รวมรูป ใบรับรอง และผลงานที่ยังค้างในคิวด้วย */
  const isDirty = () =>
    JSON.stringify(form) !== initial.current ||
    Boolean(photo.current?.dirty?.()) ||
    Boolean(certificates.current?.dirty?.()) ||
    Boolean(portfolio.current?.dirty?.());

  /*
   * ปิดแท็บ/กดรีเฟรชทั้งที่ยังกรอกค้าง — ให้เบราว์เซอร์ถามก่อน
   * ฟอร์มนี้มี 20 กว่าช่อง เสียไปทั้งหมดเพราะเผลอกดปุ่มเดียวเป็นความเสียหายที่กู้คืนไม่ได้
   * (เบราว์เซอร์บังคับใช้ข้อความมาตรฐานของตัวเอง กำหนดเองไม่ได้)
   */
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (saving || !isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  });

  const field = (key) => ({
    value: form[key],
    'aria-invalid': fieldErrors[key] ? true : undefined,
    onChange: (e) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
      // แก้ช่องที่เพิ่งโดนทักแล้ว ข้อความเตือนควรหายไปทันที ไม่ใช่ค้างจนกว่าจะกดบันทึกอีกรอบ
      setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    },
  });

  /** ข้อความเตือนใต้ช่อง — มาจาก details ของ zod ที่ server ส่งกลับมา */
  const fieldError = (key) =>
    fieldErrors[key] ? <span className="field-error">{fieldErrors[key]}</span> : null;

  /** ออกจากหน้าโดยยังไม่บันทึก — ถามก่อน */
  const confirmLeave = (e) => {
    if (isDirty() && !window.confirm('ยังไม่ได้บันทึก — ออกจากหน้านี้แล้วข้อมูลที่กรอกไว้จะหาย')) {
      e.preventDefault();
    }
  };

  /** ปุ่มบันทึกอันเดียว: บันทึกข้อมูลพนักงานก่อน แล้วค่อยเอาใบรับรองที่รออยู่ไปผูกกับรหัสพนักงาน */
  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const payload = toPayload(form);
      const saved = isEdit ? await api.updateEmployee(id, payload) : await api.createEmployee(payload);

      // พนักงานใหม่เพิ่งได้รหัสตรงนี้ รูป/ใบรับรอง/ผลงานจึงต้องบันทึกหลังพนักงานเสมอ
      await photo.current?.save(saved.employee_id);
      await certificates.current?.save(saved.employee_id);
      await portfolio.current?.save(saved.employee_id);

      // ล้างสถานะ "ยังไม่บันทึก" ก่อนเปลี่ยนหน้า ไม่งั้น beforeunload จะเตือนทั้งที่บันทึกสำเร็จแล้ว
      initial.current = JSON.stringify(form);
      toast(isEdit ? 'บันทึกการแก้ไขแล้ว' : `เพิ่มพนักงาน ${saved.employee_id} แล้ว`);
      navigate(`/employees/${saved.employee_id}`);
    } catch (err) {
      setError(err.message);

      // zod บอกมาเป็นรายช่อง — เอาไปแปะใต้ช่องที่ผิด แล้วเลื่อนไปหาช่องแรกให้เลย
      if (err.fields) {
        setFieldErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.message])));
        const first = err.fields[0]?.field;
        formEl.current?.querySelector(`[name="${first}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      setSaving(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{isEdit ? `แก้ไขข้อมูล ${id}` : 'เพิ่มพนักงานใหม่'}</h1>
          {!isEdit && <p className="muted">กรอกแค่ชื่อกับตำแหน่งก็บันทึกได้ — ที่เหลือมาเติมทีหลังได้</p>}
        </div>
        {/* ไม่มีปุ่มยกเลิกตรงนี้ — แถบล่างเป็น sticky ติดขอบจอตลอด ปุ่มยกเลิกที่นั่นกดถึงได้เสมอ */}
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" ref={formEl} onSubmit={handleSubmit}>
        {/* สามช่องที่ระบบบังคับจริงๆ อยู่บนสุดและเปิดค้างไว้เสมอ — เพิ่มคนใหม่จึงจบได้ในหน้าจอเดียว */}
        <h2>ข้อมูลที่ต้องกรอก</h2>
        <div className="grid">
          <label>ชื่อ (ไทย) *
            <input required name="first_name" {...field('first_name')} />
            {fieldError('first_name')}
          </label>
          <label>นามสกุล (ไทย) *
            <input required name="last_name" {...field('last_name')} />
            {fieldError('last_name')}
          </label>
          <label>ตำแหน่ง *
            <select required name="position" {...field('position')}>
              {Object.entries(POSITION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {fieldError('position')}
          </label>

          <label>ชื่อเล่น
            <input name="nickname" {...field('nickname')} />
            {fieldError('nickname')}
          </label>
          <label>เบอร์โทร
            <input name="phone" inputMode="tel" {...field('phone')} />
            {fieldError('phone')}
          </label>
          <label>สถานะ
            <select name="status" {...field('status')}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {fieldError('status')}
          </label>
        </div>

        {/* ที่เหลือพับไว้ — ตอนเพิ่มคนใหม่ไม่ต้องเจอทั้ง 20 ช่องพร้อมกัน
            ตอนแก้ไขเปิดค้างไว้หมด เพราะคนที่เข้ามาแก้มักรู้อยู่แล้วว่าจะแก้ช่องไหน */}
        <details className="form-section" open={isEdit}>
          <summary>ข้อมูลส่วนตัวเพิ่มเติม</summary>
          <div className="grid">
            <label>ชื่อ (อังกฤษ)
              <input name="first_name_en" placeholder="Phupha" {...field('first_name_en')} />
              {fieldError('first_name_en')}
            </label>
            <label>นามสกุล (อังกฤษ)
              <input name="last_name_en" placeholder="Chunyong" {...field('last_name_en')} />
              {fieldError('last_name_en')}
            </label>
            <label>เลขบัตรประชาชน
              <input name="national_id" maxLength={13} inputMode="numeric" placeholder="13 หลัก" {...field('national_id')} />
              {fieldError('national_id')}
            </label>
            <label>เพศ
              <select name="gender" {...field('gender')}>
                <option value="">— ไม่ระบุ —</option>
                {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label>วันเกิด
              <input type="date" name="birth_date" {...field('birth_date')} />
              {fieldError('birth_date')}
            </label>
            <label>อีเมล
              <input type="email" name="email" {...field('email')} />
              {fieldError('email')}
            </label>
            <label className="span-2">ที่อยู่<textarea rows={2} name="address" {...field('address')} /></label>
            <label className="span-2">ประวัติการศึกษา
              <textarea
                rows={3}
                name="education"
                placeholder="เช่น ปวส. การดูแลผู้สูงอายุ · วิทยาลัยอาชีวศึกษา · จบปี 2562&#10;ป.ตรี พยาบาลศาสตร์ · มหาวิทยาลัยมหิดล · จบปี 2565"
                {...field('education')}
              />
            </label>
          </div>
        </details>

        <details className="form-section" open={isEdit}>
          <summary>ข้อมูลการจ้างงาน</summary>
          <div className="grid">
            <label>ประเภทการจ้าง
              <select name="employment_type" {...field('employment_type')}>
                {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label>วันเริ่มงาน
              <input type="date" name="hire_date" {...field('hire_date')} />
              {fieldError('hire_date')}
            </label>
            <label>ค่าจ้าง (บาท)
              <input type="number" min="0" step="0.01" name="base_salary" {...field('base_salary')} />
              {fieldError('base_salary')}
            </label>
          </div>
        </details>

        <details className="form-section" open={isEdit}>
          <summary>ผู้ติดต่อฉุกเฉิน &amp; หมายเหตุ</summary>
          <div className="grid">
            <label>ชื่อผู้ติดต่อ<input name="emergency_contact_name" {...field('emergency_contact_name')} /></label>
            <label>เบอร์โทร<input name="emergency_contact_phone" inputMode="tel" {...field('emergency_contact_phone')} /></label>
            <label className="span-2">หมายเหตุ<textarea rows={2} name="note" {...field('note')} /></label>
          </div>
        </details>

        {/* อยู่ในการ์ดและฟอร์มเดียวกัน — ใช้ปุ่มบันทึกร่วมกันด้านล่าง
            (ยังคงอยู่ใน DOM แม้ยังไม่กางออก ref จึงเรียก save() ได้ตามปกติ) */}
        <details className="form-section" open={isEdit}>
          <summary>รูป · ใบรับรอง · ผลงาน</summary>
          <h3 className="form-sub">รูปพนักงาน</h3>
          <PhotoField ref={photo} employeeId={id ?? null} saved={savedPhoto} />
          <CertificateSection ref={certificates} employeeId={id ?? null} />
          <PortfolioSection ref={portfolio} employeeId={id ?? null} />
        </details>

        {/* ติดขอบล่างจอ — แก้คำเดียวก็ไม่ต้องเลื่อนผ่านใบรับรองกับผลงานไปกดปุ่ม */}
        <div className="form-actions sticky">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกพนักงานใหม่'}
          </button>
          <Link className="btn" to={isEdit ? `/employees/${id}` : '/employees'} onClick={confirmLeave}>ยกเลิก</Link>
        </div>
      </form>
    </>
  );
}
