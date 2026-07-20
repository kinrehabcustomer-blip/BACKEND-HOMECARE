import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
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
  const isEdit = Boolean(id);

  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isEdit) return;
    api
      .getCustomer(id)
      .then((c) => {
        const filled = { ...BLANK };
        for (const key of Object.keys(BLANK)) filled[key] = c[key] ?? '';
        setForm(filled);
      })
      .catch((err) => setError(err.message));
  }, [id, isEdit]);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  const computedAge = ageFromBirthDate(form.birth_date);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(form);
      // วันเกิดเป็นแหล่งความจริงที่แม่นกว่า — เก็บอายุไว้ซ้ำจะขัดกันเองเมื่อเวลาผ่านไปอีกปี
      // (ช่องอายุถูก disable ตอนมีวันเกิด แต่ค่าเก่ายังค้างใน state อยู่ ต้องล้างตรงนี้)
      if (payload.birth_date) payload.age = null;

      const saved = isEdit ? await api.updateCustomer(id, payload) : await api.createCustomer(payload);
      navigate('/customers', { state: { saved: saved.customer_id } });
    } catch (err) {
      setError(err.message);
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
        <Link className="btn" to="/customers">ยกเลิก</Link>
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" onSubmit={handleSubmit}>
        <h2>ข้อมูลพื้นฐาน</h2>
        <div className="grid">
          <label>คำนำหน้า
            <select {...field('title')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(TITLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>ชื่อ - นามสกุล *<input required {...field('name')} /></label>
          <label>ชื่อเล่น<input {...field('nickname')} /></label>

          <label>ชื่อ - นามสกุล (ภาษาอังกฤษ)<input {...field('name_en')} /></label>
          <label>เพศ
            <select {...field('gender')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>สถานภาพ
            <select {...field('marital_status')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(MARITAL_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>

          <label>วันเกิด<input type="date" {...field('birth_date')} /></label>
          <label>อายุ (ปี)
            <input
              type="number" min="0" max="130"
              placeholder={computedAge != null ? `${computedAge} (จากวันเกิด)` : ''}
              disabled={computedAge != null}
              {...field('age')}
            />
          </label>
          <label>อาชีพ<input {...field('occupation')} /></label>

          {computedAge != null && (
            <p className="form-hint muted">
              กรอกวันเกิดแล้ว — ระบบคำนวณอายุเป็น <strong>{computedAge} ปี</strong> ให้เอง
              และจะตรงเสมอแม้เวลาผ่านไป (ช่องอายุใช้เมื่อรู้แต่อายุคร่าวๆ ไม่รู้วันเกิด)
            </p>
          )}

          <label>เลขบัตรประชาชน<input inputMode="numeric" maxLength={13} placeholder="13 หลัก" {...field('national_id')} /></label>
          <label>เลข Passport<input {...field('passport_no')} /></label>
          <label>สัญชาติ<input placeholder="เช่น ไทย" {...field('nationality')} /></label>
        </div>

        {/* ข้อมูลสุขภาพ (โรคประจำตัว/แพ้ยา/กรุ๊ปเลือด/น้ำหนัก/ส่วนสูง) ย้ายไปกรอกที่แฟ้มผู้รับการดูแลแล้ว */}
        <p className="notice">
          ข้อมูลสุขภาพ (โรคประจำตัว แพ้ยา กรุ๊ปเลือด น้ำหนัก/ส่วนสูง) ให้กรอกที่
          <strong> แฟ้มผู้รับการดูแล</strong> เพราะเป็นข้อมูลของผู้ป่วย ไม่ใช่ของผู้ว่าจ้าง
        </p>

        <h2>ข้อมูลติดต่อ</h2>
        <div className="grid">
          <label>เบอร์มือถือ<input {...field('phone')} /></label>
          <label>เบอร์บ้าน<input {...field('home_phone')} /></label>
          <label>Line ID<input {...field('line_id')} /></label>

          <label className="span-2">Email<input type="email" {...field('email')} /></label>
        </div>

        <h2>ที่อยู่</h2>
        <div className="grid">
          <label className="span-2">ที่อยู่ (บ้านเลขที่ / หมู่ / ถนน)
            <textarea rows={2} {...field('address')} />
          </label>
          <label>ตำบล / แขวง<input {...field('subdistrict')} /></label>

          <label>อำเภอ / เขต<input {...field('district')} /></label>
          <label>จังหวัด<input {...field('province')} /></label>
          <label>รหัสไปรษณีย์<input inputMode="numeric" maxLength={5} {...field('postal_code')} /></label>
        </div>

        <h2>ผู้ดูแล / ญาติที่ติดต่อได้</h2>
        <div className="grid">
          <label>ชื่อผู้ดูแล<input {...field('emergency_contact_name')} /></label>
          <label>เบอร์ผู้ดูแล<input {...field('emergency_contact_phone')} /></label>
        </div>

        <h2>อื่นๆ</h2>
        <div className="grid">
          <label>ประเภทลูกค้า<input placeholder="เช่น รายเดือน รายครั้ง องค์กร" {...field('customer_type')} /></label>
          <label>รู้จักผ่านช่องทาง<input placeholder="เช่น Facebook เพื่อนแนะนำ โรงพยาบาล" {...field('referral_source')} /></label>
          <label className="span-2">หมายเหตุ<textarea rows={2} {...field('note')} /></label>
        </div>

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกลูกค้าใหม่'}
          </button>
        </div>
      </form>
    </>
  );
}
