import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
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
  weight_kg: '', height_cm: '', medical_history: '', blood_type: '', medical_rights: '',
  allergies: '',      // แพ้ยา
  food_allergies: '', // แพ้อาหาร

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
  const toast = useToast();
  const isEdit = Boolean(id);

  const [searchParams] = useSearchParams();
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const formEl = useRef(null);

  // ค่าตั้งต้นไว้เทียบว่าผู้ใช้แก้อะไรไปแล้วบ้าง (ใช้เตือนก่อนออกจากหน้า)
  const initial = useRef(JSON.stringify(BLANK));

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
        initial.current = JSON.stringify(filled);
        if (p.customer) setPicked(p.customer);
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
      // วันเกิดแม่นกว่า — เก็บอายุซ้ำจะขัดกันเองเมื่อเวลาผ่านไป (ช่องอายุถูก disable ตอนมีวันเกิด)
      if (payload.birth_date) payload.age = null;

      const saved = isEdit ? await api.updatePatient(id, payload) : await api.createPatient(payload);

      // ล้างสถานะ "ยังไม่บันทึก" ก่อนเปลี่ยนหน้า ไม่งั้น beforeunload จะเตือนทั้งที่บันทึกสำเร็จแล้ว
      initial.current = JSON.stringify(form);
      toast(isEdit ? 'บันทึกการแก้ไขแล้ว' : `เพิ่มผู้รับการดูแล ${saved.patient_id} แล้ว`);
      navigate(`/patients/${saved.patient_id}`);
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
          <h1>{isEdit ? `แก้ไขผู้รับการดูแล ${id}` : 'เพิ่มผู้รับการดูแลใหม่'}</h1>
          <p className="muted">
            {isEdit
              ? 'มีแต่ชื่อที่บังคับกรอก — ช่องที่เหลือเว้นว่างไว้ก่อนแล้วมาเติมทีหลังได้'
              : 'ระบบจะออกรหัส (PAT-xxxx) ให้อัตโนมัติหลังบันทึก · มีแต่ชื่อที่บังคับกรอก'}
          </p>
        </div>
        <Link className="btn" to="/patients" onClick={confirmLeave}>ยกเลิก</Link>
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" ref={formEl} onSubmit={handleSubmit}>
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

        {/* ช่องที่บังคับจริงมีแค่ชื่อ — ที่เหลือในบล็อกนี้คือช่องที่กรอกกันแทบทุกครั้ง
            แพ้ยาอยู่ในนี้ด้วยทั้งที่ไม่บังคับ เพราะเป็นข้อมูลความปลอดภัยที่ห้ามถูกฝังอยู่ในส่วนที่พับไว้ */}
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

          <label>เพศ
            <select name="gender" {...field('gender')}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>ความสัมพันธ์กับผู้ว่าจ้าง
            <input name="relation_to_customer" placeholder="เช่น บิดา มารดา คุณตา" {...field('relation_to_customer')} />
          </label>
          <label>สถานะ
            <select name="status" {...field('status')}>
              {Object.entries(PATIENT_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>

          {/* แยกสองช่อง — แพ้ยาเป็นเรื่องของคนให้ยา แพ้อาหารเป็นเรื่องของคนเตรียมอาหาร
              รวมช่องเดียวแล้วคนกรอกมักใส่มาแค่อย่างเดียว และคนอ่านต้องเดาว่าอันไหนเป็นอันไหน */}
          <label className="span-2">แพ้ยา
            <textarea rows={2} name="allergies" placeholder="เช่น เพนิซิลลิน แอสไพริน — ไม่มีให้เว้นว่าง" {...field('allergies')} />
          </label>
          <label className="span-2">แพ้อาหาร
            <textarea rows={2} name="food_allergies" placeholder="เช่น อาหารทะเล ถั่ว นมวัว — ไม่มีให้เว้นว่าง" {...field('food_allergies')} />
          </label>
        </div>

        {/* ที่เหลือพับไว้ — ตอนเพิ่มแฟ้มใหม่ไม่ต้องเจอทุกช่องพร้อมกัน
            ตอนแก้ไขเปิดค้างไว้หมด เพราะคนที่เข้ามาแก้มักรู้อยู่แล้วว่าจะแก้ช่องไหน */}
        <details className="form-section" open={isEdit}>
          <summary>ข้อมูลส่วนตัวเพิ่มเติม</summary>
          <div className="grid">
            <label>ชื่อ - นามสกุล (ภาษาอังกฤษ)<input name="name_en" {...field('name_en')} /></label>
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

            {computedAge != null && (
              <p className="form-hint muted">
                กรอกวันเกิดแล้ว — ระบบคำนวณอายุเป็น <strong>{computedAge} ปี</strong> ให้เอง
                และจะตรงเสมอแม้เวลาผ่านไป (ช่องอายุใช้เมื่อรู้แต่อายุคร่าวๆ ไม่รู้วันเกิด)
              </p>
            )}

            <label>สัญชาติ<input name="nationality" placeholder="เช่น ไทย" {...field('nationality')} /></label>
            <label>เลขบัตรประชาชน
              <input name="national_id" inputMode="numeric" maxLength={13} placeholder="13 หลัก" {...field('national_id')} />
              {fieldError('national_id')}
            </label>
            <label>เลข Passport<input name="passport_no" {...field('passport_no')} /></label>
          </div>
        </details>

        <details className="form-section" open={isEdit}>
          <summary>ข้อมูลสุขภาพอื่น</summary>
          <div className="grid">
            <label>น้ำหนัก (กก.)<input type="number" min="0" step="0.1" name="weight_kg" {...field('weight_kg')} /></label>
            <label>ส่วนสูง (ซม.)<input type="number" min="0" step="0.1" name="height_cm" {...field('height_cm')} /></label>
            <label>กรุ๊ปเลือด
              <select name="blood_type" {...field('blood_type')}>
                <option value="">— ไม่ระบุ —</option>
                {Object.keys(BLOOD_TYPE_LABELS).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="span-2">สิทธิการรักษา
              <input name="medical_rights" placeholder="เช่น บัตรทอง ประกันสังคม ประกันเอกชน" {...field('medical_rights')} />
            </label>
            <label className="span-2">โรคประจำตัว
              <textarea rows={2} name="medical_history" placeholder="เช่น เบาหวาน ความดันโลหิตสูง" {...field('medical_history')} />
            </label>
          </div>
        </details>

        <details className="form-section" open={isEdit}>
          <summary>ที่อยู่สถานที่ดูแล</summary>
          <div className="grid">
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
          <summary>ญาติ / ผู้ติดต่อกรณีฉุกเฉิน &amp; หมายเหตุ</summary>
          <div className="grid">
            <label>ชื่อผู้ติดต่อ<input name="emergency_contact_name" {...field('emergency_contact_name')} /></label>
            <label>เบอร์ผู้ติดต่อ
              <input name="emergency_contact_phone" inputMode="tel" {...field('emergency_contact_phone')} />
              {fieldError('emergency_contact_phone')}
            </label>
            <label>ความสัมพันธ์<input name="emergency_contact_relation" placeholder="เช่น บุตร คู่สมรส" {...field('emergency_contact_relation')} /></label>
            <label className="span-2">หมายเหตุ<textarea rows={2} name="note" {...field('note')} /></label>
          </div>
        </details>

        {/* ติดขอบล่างจอ — แก้คำเดียวก็ไม่ต้องเลื่อนผ่านทุกบล็อกไปกดปุ่ม */}
        <div className="form-actions sticky">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกผู้รับการดูแล'}
          </button>
          <Link className="btn" to="/patients" onClick={confirmLeave}>ยกเลิก</Link>
        </div>
      </form>
    </>
  );
}
