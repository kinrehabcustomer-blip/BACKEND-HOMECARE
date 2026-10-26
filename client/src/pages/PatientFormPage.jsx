import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import PatientCodeInput from '../components/PatientCodeInput.jsx';
import { isPatientCode } from '../lib/patientCode.js';
import {
  GENDER_LABELS, TITLE_LABELS, BLOOD_TYPE_LABELS, PATIENT_STATUS_LABELS, ageFromBirthDate,
} from '../labels.js';
import { formatPhoneInput } from '../lib/phone.js';

const BLANK = {
  // รหัสผู้ป่วย KN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก (กรอกเอง) — ตอนแก้คือรหัสเดิม (อาจยังเป็น PAT-xxxx)
  patient_id: '',
  // ผู้ว่าจ้าง (ลูกค้า) ที่แฟ้มนี้อยู่ใต้
  customer_id: '',

  // ตัวตน
  name: '', title: '', nickname: '', name_en: '', gender: '',
  national_id: '', passport_no: '', birth_date: '', age: '',
  nationality: '', employer_relation: '',

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
  /* ผู้ว่าจ้างของแฟ้มนี้ — ไม่มีหน้าลูกค้าแยกแล้ว จึงเพิ่ม/แก้ข้อมูลผู้ว่าจ้างได้จากตรงนี้ที่เดียว
     { customer_id (null = รายใหม่ ยังไม่บันทึก), name, phone, tax_id, billing_address } · null = ไม่ผูก
     เลขผู้เสียภาษี/ที่อยู่ออกใบเสร็จไปขึ้นในใบแจ้งหนี้ จึงต้องแก้ได้ที่นี่ */
  const [employer, setEmployer] = useState(null);
  const employerInitial = useRef(null); // ค่าเดิมของผู้ว่าจ้างที่ผูกอยู่ — แก้แล้วค่อยบันทึกกลับ

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
        if (p.customer) pickCustomer(p.customer);
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
    api.getCustomer(preset).then(pickCustomer).catch(() => {});
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

  const employerFields = (c) => ({
    customer_id: c.customer_id ?? null,
    name: c.name ?? '',
    phone: c.phone ?? '',
    tax_id: c.tax_id ?? '',
    billing_address: c.billing_address ?? '',
  });

  function pickCustomer(c) {
    const e = employerFields(c);
    setEmployer(e);
    employerInitial.current = JSON.stringify(e);
    setForm((prev) => ({ ...prev, customer_id: c.customer_id }));
  }

  /** ไม่เจอในระบบ — เพิ่มเป็นผู้ว่าจ้างรายใหม่จากชื่อที่พิมพ์ (บันทึกจริงตอนกดบันทึกแฟ้มผู้ป่วย) */
  function newEmployer() {
    setEmployer(employerFields({ name: query.trim() }));
    employerInitial.current = null;
    setQuery('');
    setMatches([]);
  }

  function unpickCustomer() {
    setEmployer(null);
    employerInitial.current = null;
    setQuery('');
    setForm((prev) => ({ ...prev, customer_id: '' }));
  }

  const setEmployerField = (key) => (e) => {
    const value = key === 'phone' ? formatPhoneInput(e.target.value) : e.target.value;
    setEmployer((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => (prev[`employer_${key}`] ? { ...prev, [`employer_${key}`]: undefined } : prev));
  };

  /**
   * บันทึกผู้ว่าจ้างก่อนแฟ้มผู้ป่วย — รายใหม่ = สร้าง · ที่ผูกอยู่แล้วแก้ข้อมูล = แก้กลับ
   * คืน customer_id ที่จะผูกกับแฟ้ม · error ของช่องผู้ว่าจ้างย้ายชื่อเป็น employer_* ไม่ให้ชนช่องของผู้ป่วย
   */
  async function saveEmployer() {
    if (!employer) return form.customer_id || null;
    if (!employer.name.trim()) {
      const err = new Error('กรุณากรอกชื่อผู้ว่าจ้าง หรือกด "ไม่ผูก"');
      err.fields = [{ field: 'employer_name', message: 'กรอกชื่อผู้ว่าจ้าง' }];
      throw err;
    }
    const body = {
      name: employer.name.trim(),
      phone: employer.phone.trim() || null,
      tax_id: employer.tax_id.trim() || null,
      billing_address: employer.billing_address.trim() || null,
    };
    try {
      if (!employer.customer_id) {
        const created = await api.createCustomer(body);
        // สลับเป็น "ผูกอยู่แล้ว" ทันที — ถ้าขั้นบันทึกผู้ป่วยล้ม กดบันทึกซ้ำจะไม่สร้างผู้ว่าจ้างซ้ำ
        pickCustomer(created);
        return created.customer_id;
      }
      if (JSON.stringify(employer) !== employerInitial.current) {
        const updated = await api.updateCustomer(employer.customer_id, body);
        employerInitial.current = JSON.stringify(employerFields(updated));
      }
      return employer.customer_id;
    } catch (err) {
      if (err.fields) err.fields = err.fields.map((f) => ({ ...f, field: `employer_${f.field}` }));
      throw err;
    }
  }

  const field = (key) => ({
    value: key.endsWith('phone') ? formatPhoneInput(form[key]) : form[key],
    'aria-invalid': fieldErrors[key] ? true : undefined,
    onChange: (e) => {
      setForm((prev) => ({ ...prev, [key]: key.endsWith('phone') ? formatPhoneInput(e.target.value) : e.target.value }));
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
      /* รหัสผู้ป่วย: เพิ่มใหม่ต้องมีรหัส KN ครบ · แก้ไข = ส่งเฉพาะตอนกรอกรหัส KN ใหม่ที่ต่างจากเดิม
         (แฟ้มเก่าที่ยังเป็น PAT-xxxx ไม่บังคับเปลี่ยน — ช่องว่างไว้ = คงรหัสเดิม) */
      if (!isPatientCode(form.patient_id) || (isEdit && form.patient_id === id)) {
        delete payload.patient_id;
        if (!isEdit) {
          setFieldErrors({ patient_id: 'กรอกรหัสผู้ป่วยให้ครบ: KN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก' });
          formEl.current?.querySelector('[name="patient_id"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setSaving(false);
          return;
        }
      }

      // ผ่านการทักฝั่งหน้าจอแล้วค่อยบันทึกผู้ว่าจ้าง (สร้างใหม่/แก้ข้อมูล)
      payload.customer_id = await saveEmployer();

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
              : 'กรอกรหัสผู้ป่วย (KN) และชื่อ — ช่องที่เหลือเว้นว่างไว้ก่อนแล้วมาเติมทีหลังได้'}
          </p>
        </div>
        {/* ไม่มีปุ่มยกเลิกตรงนี้ — แถบล่างเป็น sticky ติดขอบจอตลอด ปุ่มยกเลิกที่นั่นกดถึงได้เสมอ */}
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" ref={formEl} onSubmit={handleSubmit}>
        <h2>ผู้ว่าจ้าง</h2>
        {/* ผู้จ่ายเงินของแฟ้มนี้ — ผู้ว่าจ้างหนึ่งคนดูแลได้หลายคน · เพิ่ม/แก้ได้ที่นี่ (ไม่มีหน้าลูกค้าแยกแล้ว)
            ชื่อ/เลขผู้เสียภาษี/ที่อยู่ออกใบเสร็จ ไปขึ้นเป็นผู้จ่ายในใบแจ้งหนี้ */}
        <div className="customer-picker">
          {employer ? (
            <div className="employer-edit">
              <div className="employer-edit-head">
                <span className="muted">
                  {employer.customer_id
                    ? <>ผูกกับผู้ว่าจ้าง <span className="mono">{employer.customer_id}</span> · แก้ข้อมูลด้านล่างได้เลย</>
                    : 'ผู้ว่าจ้างรายใหม่ — บันทึกพร้อมแฟ้มผู้ป่วย'}
                </span>
                <button type="button" className="btn" onClick={unpickCustomer}>เปลี่ยน / ไม่ผูก</button>
              </div>
              <div className="grid">
                <label>ชื่อผู้ว่าจ้าง *
                  <input name="employer_name" value={employer.name} aria-invalid={fieldErrors.employer_name ? true : undefined} onChange={setEmployerField('name')} />
                  {fieldError('employer_name')}
                </label>
                <label>เบอร์โทรผู้ว่าจ้าง
                  <input name="employer_phone" inputMode="tel" value={employer.phone} aria-invalid={fieldErrors.employer_phone ? true : undefined} onChange={setEmployerField('phone')} />
                  {fieldError('employer_phone')}
                </label>
                <label>เลขผู้เสียภาษี (ถ้ามี)
                  <input name="employer_tax_id" inputMode="numeric" value={employer.tax_id} aria-invalid={fieldErrors.employer_tax_id ? true : undefined} onChange={setEmployerField('tax_id')} />
                  {fieldError('employer_tax_id')}
                </label>
                <label>ความสัมพันธ์กับผู้ป่วย
                  <input name="employer_relation" placeholder="เช่น บุตร หลาน คู่สมรส" {...field('employer_relation')} />
                  {fieldError('employer_relation')}
                </label>
                <label className="span-2">ที่อยู่ออกใบเสร็จ (ถ้าต่างจากที่อยู่ผู้ป่วย)
                  <input name="employer_billing_address" value={employer.billing_address} aria-invalid={fieldErrors.employer_billing_address ? true : undefined} onChange={setEmployerField('billing_address')} />
                  {fieldError('employer_billing_address')}
                </label>
              </div>
              {employer.customer_id && (
                <p className="form-hint muted">แก้ข้อมูลผู้ว่าจ้างที่นี่ มีผลกับผู้ป่วยคนอื่นที่ใช้ผู้ว่าจ้างคนเดียวกันด้วย</p>
              )}
            </div>
          ) : (
            <>
              <label className="customer-search">
                ค้นหาผู้ว่าจ้าง (ชื่อ / เบอร์โทร) หรือพิมพ์ชื่อเพื่อเพิ่มรายใหม่
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

              {/* ไม่เจอ (หรือเจอแต่ไม่ใช่คนนี้) — เพิ่มเป็นผู้ว่าจ้างรายใหม่จากชื่อที่พิมพ์ได้เลย */}
              {query.trim() && (
                <button type="button" className="btn add-payer" onClick={newEmployer}>
                  + เพิ่ม "{query.trim()}" เป็นผู้ว่าจ้างรายใหม่
                </button>
              )}
            </>
          )}
        </div>

        {/* ช่องที่บังคับจริงมีแค่ชื่อ — ที่เหลือในบล็อกนี้คือช่องที่กรอกกันแทบทุกครั้ง
            แพ้ยาอยู่ในนี้ด้วยทั้งที่ไม่บังคับ เพราะเป็นข้อมูลความปลอดภัยที่ห้ามถูกฝังอยู่ในส่วนที่พับไว้ */}
        <h2>ข้อมูลที่ต้องกรอก</h2>
        <div className="grid">
          <label>รหัสผู้ป่วย {isEdit ? '' : '*'}
            <PatientCodeInput
              name="patient_id"
              // แฟ้มที่กำลังแก้ ไม่นับว่ารหัสเดิมของตัวเองซ้ำ
              checker={(code) => (code === id ? Promise.resolve(null) : api.checkPatientId(code, isEdit ? id : null))}
              takenLabel="รหัสนี้ถูกใช้กับผู้ป่วยคนอื่นแล้ว"
              value={isPatientCode(form.patient_id) ? form.patient_id : ''}
              invalid={Boolean(fieldErrors.patient_id)}
              onChange={(code) => {
                // แก้ไข: ลบเลขจนไม่ครบ = กลับไปใช้รหัสเดิม ไม่ใช่ส่งรหัสว่าง
                setForm((prev) => ({ ...prev, patient_id: code }));
                setFieldErrors((prev) => (prev.patient_id ? { ...prev, patient_id: undefined } : prev));
              }}
            />
            {isEdit && !isPatientCode(id) && (
              <span className="form-hint muted">รหัสเดิม {id} — กรอกรหัส KN เพื่อเปลี่ยน (เคสที่ผูกอยู่เปลี่ยนตามให้เอง)</span>
            )}
            {fieldError('patient_id')}
          </label>
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
