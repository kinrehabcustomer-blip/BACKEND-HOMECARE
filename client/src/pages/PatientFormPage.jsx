import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  GENDER_LABELS, TITLE_LABELS, BLOOD_TYPE_LABELS, PATIENT_STATUS_LABELS, ageFromBirthDate,
} from '../labels.js';

const BLANK = {
  // ผู้ว่าจ้าง (ลูกค้า) ที่แฟ้มนี้อยู่ใต้
  customer_id: '',

  // ตัวตน
  name: '', title: '', nickname: '', name_en: '', gender: '',
  national_id: '', passport_no: '', birth_date: '', age: '',
  nationality: '', relation_to_customer: '',

  // การแพทย์เชิงคงที่
  weight_kg: '', height_cm: '', medical_history: '', allergies: '', blood_type: '', medical_rights: '',

  // ที่อยู่สถานที่ดูแล
  address: '', subdistrict: '', district: '', province: '', postal_code: '',

  // ญาติ/ผู้ติดต่อฉุกเฉิน
  emergency_contact_name: '', emergency_contact_phone: '', emergency_contact_relation: '',

  status: 'active', note: '',
};

const NUMERIC = ['age', 'weight_kg', 'height_cm'];

const toPayload = (form) =>
  Object.fromEntries(
    Object.entries(form).map(([k, v]) => {
      if (v === '') return [k, null];
      if (NUMERIC.includes(k)) return [k, Number(v)];
      return [k, v];
    }),
  );

export default function PatientFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [searchParams] = useSearchParams();
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // ผูกผู้ว่าจ้าง (ลูกค้า) — ค้นหาที่ server เหมือนหน้าเปิดเคส
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [picked, setPicked] = useState(null); // ลูกค้าที่ผูกอยู่ (ไว้โชว์ชื่อ)

  // โหลดข้อมูลเดิมตอนแก้ไข
  useEffect(() => {
    if (!isEdit) return;
    api
      .getPatient(id)
      .then((p) => {
        const filled = { ...BLANK };
        for (const key of Object.keys(BLANK)) filled[key] = p[key] ?? '';
        filled.status = p.status ?? 'active';
        setForm(filled);
        if (p.customer) setPicked(p.customer);
      })
      .catch((err) => setError(err.message));
  }, [id, isEdit]);

  // เปิดจากหน้าลูกค้า (?customer_id=CUS-0001) -> ผูกลูกค้ารายนั้นให้เลย
  useEffect(() => {
    if (isEdit) return;
    const preset = searchParams.get('customer_id');
    if (!preset) return;
    setForm((prev) => ({ ...prev, customer_id: preset }));
    api.getCustomer(preset).then(setPicked).catch(() => {});
  }, [isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // ค้นหาลูกค้าที่ server (ไม่กรองในหน้าเว็บ) — โชว์เฉพาะเมื่อยังไม่ผูกและมีการพิมพ์
  useEffect(() => {
    if (form.customer_id || !query.trim()) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .listCustomers({ q: query.trim(), per_page: 8 })
        .then((r) => setMatches(r.data))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [query, form.customer_id]);

  function pickCustomer(c) {
    setPicked(c);
    setForm((prev) => ({ ...prev, customer_id: c.customer_id }));
  }

  function unpickCustomer() {
    setPicked(null);
    setQuery('');
    setForm((prev) => ({ ...prev, customer_id: '' }));
  }

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
      // วันเกิดแม่นกว่า — เก็บอายุซ้ำจะขัดกันเองเมื่อเวลาผ่านไป (ช่องอายุถูก disable ตอนมีวันเกิด)
      if (payload.birth_date) payload.age = null;

      const saved = isEdit ? await api.updatePatient(id, payload) : await api.createPatient(payload);
      navigate(`/patients/${saved.patient_id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{isEdit ? `แก้ไขผู้รับการดูแล ${id}` : 'เพิ่มผู้รับการดูแลใหม่'}</h1>
          <p className="muted">
            {isEdit
              ? 'มีแต่ชื่อที่บังคับกรอก — ช่องที่เหลือเว้นว่างไว้ก่อนแล้วมาเติมทีหลังได้'
              : 'ระบบจะออกรหัส (PAT-xxxx) ให้อัตโนมัติหลังบันทึก · มีแต่ชื่อที่บังคับกรอก'}
          </p>
        </div>
        <Link className="btn" to="/patients">ยกเลิก</Link>
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" onSubmit={handleSubmit}>
        <h2>ผู้ว่าจ้าง (ลูกค้า)</h2>
        {/* ผูกแฟ้มผู้ป่วยกับลูกค้าที่เป็นผู้จ่ายเงิน — ลูกค้าหนึ่งคนดูแลได้หลายคน */}
        <div className="customer-picker">
          {picked ? (
            <div className="picked-customer">
              <div>
                <strong>{picked.name}</strong>
                <p className="muted">
                  <span className="mono">{picked.customer_id}</span>
                  {picked.phone && ` · ${picked.phone}`}
                </p>
              </div>
              <button type="button" className="btn" onClick={unpickCustomer}>เปลี่ยน / ไม่ผูก</button>
            </div>
          ) : (
            <>
              <label className="customer-search">
                ค้นหาลูกค้า (รหัส / ชื่อ / เบอร์โทร)
                <input
                  placeholder="พิมพ์เพื่อค้นหา — เว้นว่างได้ถ้ายังไม่รู้ว่าใครเป็นผู้ว่าจ้าง"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>

              {matches.length > 0 && (
                <ul className="customer-results">
                  {matches.map((c) => (
                    <li key={c.customer_id}>
                      <button type="button" onClick={() => pickCustomer(c)}>
                        <strong>{c.name}</strong>
                        <span className="muted">
                          <span className="mono">{c.customer_id}</span>
                          {c.phone && ` · ${c.phone}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {query && matches.length === 0 && (
                <p className="muted">ไม่พบลูกค้าที่ตรงกับ "{query}"</p>
              )}
            </>
          )}
        </div>

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
          <label>ความสัมพันธ์กับผู้ว่าจ้าง
            <input placeholder="เช่น บิดา มารดา คุณตา" {...field('relation_to_customer')} />
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
          <label>สัญชาติ<input placeholder="เช่น ไทย" {...field('nationality')} /></label>

          {computedAge != null && (
            <p className="form-hint muted">
              กรอกวันเกิดแล้ว — ระบบคำนวณอายุเป็น <strong>{computedAge} ปี</strong> ให้เอง
              และจะตรงเสมอแม้เวลาผ่านไป (ช่องอายุใช้เมื่อรู้แต่อายุคร่าวๆ ไม่รู้วันเกิด)
            </p>
          )}

          <label>เลขบัตรประชาชน<input inputMode="numeric" maxLength={13} placeholder="13 หลัก" {...field('national_id')} /></label>
          <label>เลข Passport<input {...field('passport_no')} /></label>
          <label>สถานะ
            <select {...field('status')}>
              {Object.entries(PATIENT_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>

        <h2>ข้อมูลสุขภาพ</h2>
        <div className="grid">
          <label>น้ำหนัก (กก.)<input type="number" min="0" step="0.1" {...field('weight_kg')} /></label>
          <label>ส่วนสูง (ซม.)<input type="number" min="0" step="0.1" {...field('height_cm')} /></label>
          <label>กรุ๊ปเลือด
            <select {...field('blood_type')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.keys(BLOOD_TYPE_LABELS).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="span-2">สิทธิการรักษา
            <input placeholder="เช่น บัตรทอง ประกันสังคม ประกันเอกชน" {...field('medical_rights')} />
          </label>

          <label className="span-2">โรคประจำตัว
            <textarea rows={2} placeholder="เช่น เบาหวาน ความดันโลหิตสูง" {...field('medical_history')} />
          </label>
          <label className="span-2">แพ้ยา / แพ้อาหาร
            <textarea rows={2} placeholder="เช่น แพ้เพนิซิลลิน แพ้อาหารทะเล — ไม่มีให้เว้นว่าง" {...field('allergies')} />
          </label>
        </div>

        <h2>ที่อยู่สถานที่ดูแล</h2>
        <div className="grid">
          <label className="span-2">ที่อยู่ (บ้านเลขที่ / หมู่ / ถนน)
            <textarea rows={2} {...field('address')} />
          </label>
          <label>ตำบล / แขวง<input {...field('subdistrict')} /></label>

          <label>อำเภอ / เขต<input {...field('district')} /></label>
          <label>จังหวัด<input {...field('province')} /></label>
          <label>รหัสไปรษณีย์<input inputMode="numeric" maxLength={5} {...field('postal_code')} /></label>
        </div>

        <h2>ญาติ / ผู้ติดต่อกรณีฉุกเฉิน</h2>
        <div className="grid">
          <label>ชื่อผู้ติดต่อ<input {...field('emergency_contact_name')} /></label>
          <label>เบอร์ผู้ติดต่อ<input {...field('emergency_contact_phone')} /></label>
          <label>ความสัมพันธ์<input placeholder="เช่น บุตร คู่สมรส" {...field('emergency_contact_relation')} /></label>
        </div>

        <h2>อื่นๆ</h2>
        <div className="grid">
          <label className="span-2">หมายเหตุ<textarea rows={2} {...field('note')} /></label>
        </div>

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกผู้รับการดูแล'}
          </button>
        </div>
      </form>
    </>
  );
}
