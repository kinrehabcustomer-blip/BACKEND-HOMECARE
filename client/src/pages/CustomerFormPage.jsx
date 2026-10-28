import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import {
  GENDER_LABELS, TITLE_LABELS, MARITAL_STATUS_LABELS, ageFromBirthDate,
} from '../labels.js';

// customer = "ผู้ว่าจ้าง/ผู้ติดต่อ" — ข้อมูลสุขภาพ (โรคประจำตัว/แพ้ยา/กรุ๊ปเลือด/สิทธิรักษา/น้ำหนัก/ส่วนสูง)
// ย้ายไปกรอกที่แฟ้มผู้รับการดูแล (patient) แล้ว จึงไม่มีในฟอร์มนี้
// คอลัมน์การแพทย์เดิมยังอยู่ใน DB (ลูกค้าเก่าที่กรอกไว้ไม่หาย) — แค่ไม่ถูกส่งในฟอร์มนี้ จึงไม่ถูกเขียนทับ
const BLANK = {
  // ตัวตน
  name: '', title: '', nickname: '', name_en: '', gender: '',
  national_id: '', passport_no: '', birth_date: '', age: '',
  nationality: '', marital_status: '',

  // ติดต่อ
  phone: '', home_phone: '', line_id: '', email: '',

  // ที่อยู่
  address: '', subdistrict: '', district: '', province: '', postal_code: '',

  // ผู้ดูแล
  emergency_contact_name: '', emergency_contact_phone: '',

  occupation: '', customer_type: '', referral_source: '', note: '',
};

const NUMERIC = ['age'];

const toPayload = (form) =>
  Object.fromEntries(
    Object.entries(form).map(([k, v]) => {
      if (v === '') return [k, null];
      if (NUMERIC.includes(k)) return [k, Number(v)];
      return [k, v];
    }),
  );

export default function CustomerFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = Boolean(id);

  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const formEl = useRef(null);

  // ค่าตั้งต้นไว้เทียบว่าผู้ใช้แก้อะไรไปแล้วบ้าง (ใช้เตือนก่อนออกจากหน้า)
  const initial = useRef(JSON.stringify(BLANK));

  useEffect(() => {
    if (!isEdit) return;
    api
      .getCustomer(id)
      .then((c) => {
        const filled = { ...BLANK };
        for (const key of Object.keys(BLANK)) filled[key] = c[key] ?? '';
        setForm(filled);
        initial.current = JSON.stringify(filled);
      })
      .catch((err) => setError(err.message));
  }, [id, isEdit]);

  const isDirty = () => JSON.stringify(form) !== initial.current;

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

  const computedAge = ageFromBirthDate(form.birth_date);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const payload = toPayload(form);
      // วันเกิดเป็นแหล่งความจริงที่แม่นกว่า — เก็บอายุไว้ซ้ำจะขัดกันเองเมื่อเวลาผ่านไปอีกปี
      // (ช่องอายุถูก disable ตอนมีวันเกิด แต่ค่าเก่ายังค้างใน state อยู่ ต้องล้างตรงนี้)
      if (payload.birth_date) payload.age = null;

      const saved = isEdit ? await api.updateCustomer(id, payload) : await api.createCustomer(payload);

      // ล้างสถานะ "ยังไม่บันทึก" ก่อนเปลี่ยนหน้า ไม่งั้น beforeunload จะเตือนทั้งที่บันทึกสำเร็จแล้ว
      initial.current = JSON.stringify(form);
      toast(isEdit ? 'บันทึกการแก้ไขแล้ว' : `เพิ่มลูกค้า ${saved.customer_id} แล้ว`);
      navigate(`/customers?open=${saved.customer_id}`);
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
          <h1>{isEdit ? `แก้ไขลูกค้า ${id}` : 'เพิ่มลูกค้าใหม่'}</h1>
          <p className="muted">
            {isEdit
              ? 'มีแต่ชื่อที่บังคับกรอก — ช่องที่เหลือเว้นว่างไว้ก่อนแล้วมาเติมทีหลังได้'
              : 'ระบบจะออกรหัสลูกค้า (CUS-xxxx) ให้อัตโนมัติหลังบันทึก · มีแต่ชื่อที่บังคับกรอก'}
          </p>
        </div>
        {/* ไม่มีปุ่มยกเลิกตรงนี้ — แถบล่างเป็น sticky ติดขอบจอตลอด ปุ่มยกเลิกที่นั่นกดถึงได้เสมอ */}
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" ref={formEl} onSubmit={handleSubmit}>
        {/* ช่องที่บังคับจริงมีแค่ชื่อ — ที่เหลือในบล็อกนี้คือช่องที่กรอกกันแทบทุกครั้ง
            เพิ่มลูกค้าใหม่จึงจบได้ในหน้าจอเดียว ไม่ต้องเลื่อนผ่าน 20 กว่าช่อง */}
        <h2>ข้อมูลที่ต้องกรอก</h2>
        <div className="grid">
          <label>คำนำหน้า
            <select name="title" {...field('title')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(TITLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>ชื่อ - นามสกุล *
            <input required name="name" {...field('name')} />
            {fieldError('name')}
          </label>
          <label>ชื่อเล่น<input name="nickname" {...field('nickname')} /></label>

          <label>เบอร์มือถือ
            <input name="phone" inputMode="tel" {...field('phone')} />
            {fieldError('phone')}
          </label>
          <label>Line ID<input name="line_id" {...field('line_id')} /></label>
          <label>เพศ
            <select name="gender" {...field('gender')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>

        {/* ที่เหลือพับไว้ — ตอนเพิ่มลูกค้าใหม่ไม่ต้องเจอทุกช่องพร้อมกัน
            ตอนแก้ไขเปิดค้างไว้หมด เพราะคนที่เข้ามาแก้มักรู้อยู่แล้วว่าจะแก้ช่องไหน */}
        <details className="form-section" open={isEdit}>
          <summary>ข้อมูลส่วนตัวเพิ่มเติม</summary>
          <div className="grid">
            <label>ชื่อ - นามสกุล (ภาษาอังกฤษ)<input name="name_en" {...field('name_en')} /></label>
            <label>สถานภาพ
              <select name="marital_status" {...field('marital_status')}>
                <option value="">— ไม่ระบุ —</option>
                {Object.entries(MARITAL_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label>อาชีพ<input name="occupation" {...field('occupation')} /></label>

            <label>วันเกิด
              <input type="date" name="birth_date" {...field('birth_date')} />
              {fieldError('birth_date')}
            </label>
            <label>อายุ (ปี)
              <input
                type="number" min="0" max="130" name="age"
                placeholder={computedAge != null ? `${computedAge} (จากวันเกิด)` : ''}
                disabled={computedAge != null}
                {...field('age')}
              />
            </label>
            <label>สัญชาติ<input name="nationality" placeholder="เช่น ไทย" {...field('nationality')} /></label>

            {computedAge != null && (
              <p className="form-hint muted">
                กรอกวันเกิดแล้ว — ระบบคำนวณอายุเป็น <strong>{computedAge} ปี</strong> ให้เอง
                และจะตรงเสมอแม้เวลาผ่านไป (ช่องอายุใช้เมื่อรู้แต่อายุคร่าวๆ ไม่รู้วันเกิด)
              </p>
            )}

            <label>เลขบัตรประชาชน
              <input name="national_id" inputMode="numeric" maxLength={13} placeholder="13 หลัก" {...field('national_id')} />
              {fieldError('national_id')}
            </label>
            <label>เลข Passport<input name="passport_no" {...field('passport_no')} /></label>
          </div>

          {/* ข้อมูลสุขภาพ (โรคประจำตัว/แพ้ยา/กรุ๊ปเลือด/น้ำหนัก/ส่วนสูง) ย้ายไปกรอกที่แฟ้มผู้รับการดูแลแล้ว */}
          <p className="notice">
            ข้อมูลสุขภาพ (โรคประจำตัว แพ้ยา กรุ๊ปเลือด น้ำหนัก/ส่วนสูง) ให้กรอกที่
            <strong> แฟ้มผู้รับการดูแล</strong> เพราะเป็นข้อมูลของผู้ป่วย ไม่ใช่ของผู้ว่าจ้าง
          </p>
        </details>

        <details className="form-section" open={isEdit}>
          <summary>ช่องทางติดต่ออื่น &amp; ที่อยู่</summary>
          <div className="grid">
            <label>เบอร์บ้าน<input name="home_phone" inputMode="tel" {...field('home_phone')} /></label>
            <label className="span-2">Email
              <input type="email" name="email" {...field('email')} />
              {fieldError('email')}
            </label>

            <label className="span-2">ที่อยู่ (บ้านเลขที่ / หมู่ / ถนน)
              <textarea rows={2} name="address" {...field('address')} />
            </label>
            <label>ตำบล / แขวง<input name="subdistrict" {...field('subdistrict')} /></label>

            <label>อำเภอ / เขต<input name="district" {...field('district')} /></label>
            <label>จังหวัด<input name="province" {...field('province')} /></label>
            <label>รหัสไปรษณีย์<input name="postal_code" inputMode="numeric" maxLength={5} {...field('postal_code')} /></label>
          </div>
        </details>

        <details className="form-section" open={isEdit}>
          <summary>ผู้ดูแล / ญาติที่ติดต่อได้ &amp; อื่นๆ</summary>
          <div className="grid">
            <label>ชื่อผู้ดูแล<input name="emergency_contact_name" {...field('emergency_contact_name')} /></label>
            <label className="span-2">เบอร์ผู้ดูแล
              <input name="emergency_contact_phone" inputMode="tel" {...field('emergency_contact_phone')} />
            </label>

            <label>ประเภทลูกค้า<input name="customer_type" placeholder="เช่น รายเดือน รายครั้ง องค์กร" {...field('customer_type')} /></label>
            <label className="span-2">รู้จักผ่านช่องทาง<input name="referral_source" placeholder="เช่น Facebook เพื่อนแนะนำ โรงพยาบาล" {...field('referral_source')} /></label>
            <label className="span-2">หมายเหตุ<textarea rows={2} name="note" {...field('note')} /></label>
          </div>
        </details>

        {/* ติดขอบล่างจอ — แก้คำเดียวก็ไม่ต้องเลื่อนผ่านทุกบล็อกไปกดปุ่ม */}
        <div className="form-actions sticky">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกลูกค้าใหม่'}
          </button>
          <Link className="btn" to="/customers" onClick={confirmLeave}>ยกเลิก</Link>
        </div>
      </form>
    </>
  );
}
