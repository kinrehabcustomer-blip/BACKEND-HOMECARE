import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import MapPicker from '../components/MapPicker.jsx';
import {
  CASE_TYPE_LABELS, POSITION_LABELS, GENDER_LABELS, SERVICE_KIND_LABELS, formatBaht, ageFromBirthDate,
} from '../labels.js';

const TIERS = ['CG', 'NA', 'PN', 'RN'];
const CATEGORY_LABELS = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน' };

const BLANK = {
  case_type: 'elderly_care',
  customer_id: '',
  patient_id: '',
  service_kind: '',
  pkg_format_id: '', pkg_grade_id: '', pkg_staff_tier: '', // [Homecare]
  physio_package_id: '', // [กายภาพ]

  // ตัวตนผู้ป่วย (มาจากแฟ้ม patient / หรือกรอกเพื่อสร้างแฟ้มใหม่) — client_name/gender/age/medical_history คัดลอกเป็น snapshot ในเคส
  client_name: '', patient_gender: '', patient_age: '', medical_history: '',
  // เฉพาะตอนสร้างผู้ป่วยใหม่ — เก็บที่แฟ้มผู้ป่วย ไม่ใช่คอลัมน์ของเคส (ถูกตัดออกก่อนบันทึกเคส)
  weight_kg: '', height_cm: '', allergies: '', food_allergies: '', relation_to_customer: '',

  // การประเมิน/อาการครั้งนี้ (ข้อมูลของเคส เปลี่ยนได้ทุกรอบ)
  current_symptoms: '', medical_devices: '', care_goal: '',

  // รายละเอียดการใช้บริการ
  service_start_preference: '', address: '', client_phone: '', nurse_call_preference: '',

  // พิกัดสถานที่ดูแล (geofence เช็คอิน)
  geo_lat: '', geo_lng: '', geofence_radius_m: '',

  // fee = ค่าบริการที่ลูกค้าจ่าย · staff_pay = ค่าจ้างที่พนักงานได้เมื่อปิดเคส (คนละตัวเลข)
  start_date: '', end_date: '', fee: '', staff_pay: '', note: '',
  assigned_to: '',
};

// ช่องตัวเลขต้องส่งเป็น number ไม่ใช่ string ไม่งั้น zod ปฏิเสธ
const NUMERIC = ['fee', 'staff_pay', 'patient_age', 'weight_kg', 'height_cm', 'pkg_format_id', 'pkg_grade_id',
  'physio_package_id', 'geo_lat', 'geo_lng', 'geofence_radius_m'];

/** ช่องว่างต้องส่งเป็น null ไม่ใช่ "" */
const toPayload = (form) =>
  Object.fromEntries(
    Object.entries(form).map(([k, v]) => {
      if (v === '') return [k, null];
      if (NUMERIC.includes(k)) return [k, Number(v)];
      return [k, v];
    }),
  );

const shownAge = (p) => {
  const a = p.age ?? ageFromBirthDate(p.birth_date);
  return a != null ? `${a} ปี` : null;
};

export default function CaseFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = Boolean(id);

  const [searchParams] = useSearchParams();
  const [form, setForm] = useState(BLANK);
  const [staff, setStaff] = useState([]);
  const [matrix, setMatrix] = useState(null);
  const [physio, setPhysio] = useState([]);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const formEl = useRef(null);

  // ค่าตั้งต้นไว้เทียบว่าผู้ใช้แก้อะไรไปแล้วบ้าง (ใช้เตือนก่อนออกจากหน้า)
  const initial = useRef(JSON.stringify(BLANK));
  // ตั้งพิกัดสถานที่ดูแล: พิมพ์ชื่อสถานที่เพื่อค้นหา หรือวางลิงก์ Google Maps ก็ได้ (ช่องเดียวกัน)
  const [locQuery, setLocQuery] = useState('');
  const [finding, setFinding] = useState(false);
  const [locError, setLocError] = useState(null);
  const [candidates, setCandidates] = useState([]);   // ผลค้นหาให้เลือก (กรณีพิมพ์ชื่อ)
  const [resolvedAddress, setResolvedAddress] = useState(null);

  // ค้นหา/เลือกผู้รับการดูแล (patient) เป็นหลัก
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [pickedPatient, setPickedPatient] = useState(null);
  // ผู้รับการดูแลที่อยู่ใต้ผู้ว่าจ้างที่เลือกไว้ — เสนอให้เลือกเลยโดยไม่ต้องพิมพ์ค้นหา
  const [ownPatients, setOwnPatients] = useState([]);

  // ผู้ว่าจ้าง (customer) — เลือกได้ไม่บังคับ; ถ้าเลือกผู้ป่วยที่ผูกลูกค้าไว้แล้วจะมาเอง
  const [payer, setPayer] = useState(null);
  const [payerQuery, setPayerQuery] = useState('');
  const [payerMatches, setPayerMatches] = useState([]);

  useEffect(() => {
    api.assignableEmployees().then(setStaff).catch(() => {});
    // ตารางเรททั้งหมด (เกรด + รูปแบบ + ราคา) — ใช้ให้เลือกเรทตอนเปิดเคส
    api.packageMatrix().then(setMatrix).catch(() => {});
    // แพ็คเกจกายภาพบำบัด (เหมาจำนวนครั้ง) — อีกสายที่เลือกได้แทน Homecare
    api.listPhysioPackages().then(setPhysio).catch(() => {});
  }, []);

  // ค่าที่เลือกอยู่ (แปลงเป็น number เพื่อเทียบกับ id ในตาราง)
  const selFormatId = form.pkg_format_id === '' ? null : Number(form.pkg_format_id);
  const selGradeId = form.pkg_grade_id === '' ? null : Number(form.pkg_grade_id);
  const selectedFormat = matrix?.formats.find((f) => f.format_id === selFormatId) ?? null;
  const needGrade = selectedFormat?.graded ?? false;

  const lookupRate = (formatId, gradeId, tier) =>
    matrix?.rates.find(
      (r) => r.format_id === formatId && (r.grade_id ?? null) === (gradeId ?? null) && r.staff_tier === tier,
    ) ?? null;

  const effectiveGrade = needGrade ? selGradeId : null;
  const currentRate =
    selectedFormat && form.pkg_staff_tier && (!needGrade || selGradeId)
      ? lookupRate(selectedFormat.format_id, effectiveGrade, form.pkg_staff_tier)
      : null;

  /**
   * ผู้ใช้เปลี่ยนการเลือกเรท -> ถ้าได้ช่องที่ให้บริการได้ คัดลอกค่าบริการมาเป็นค่าจ้าง (fee)
   * ใช้ราคา "หลังหักส่วนลด" (net_price) เหมือนฝั่งกายภาพที่คัดลอก special_price
   * ไม่งั้นส่วนลดที่ตั้งไว้ในตารางเรทจะไม่มีผลกับเคสเลย ลูกค้าโดนเก็บเต็มราคา
   * "คัดลอก" ไม่ใช่ "อ้างอิง" — แก้ค่าจ้างทีหลังได้ และเคสเก่าไม่เปลี่ยนตามเมื่อราคาในตารางเรทถูกแก้
   * ทำเฉพาะตอนผู้ใช้กดเลือกเอง (ไม่ใช่ตอนโหลดเคสมาแก้) จึงไม่ทับ fee ที่บันทึกไว้เดิม
   */
  function applySelection(next) {
    setForm((prev) => {
      const merged = { ...prev, ...next };
      const fmt = matrix?.formats.find((f) => f.format_id === Number(merged.pkg_format_id));
      if (fmt && !fmt.graded) merged.pkg_grade_id = ''; // รูปแบบไม่อิงเกรด ล้างเกรดทิ้ง
      const gid = fmt?.graded ? (merged.pkg_grade_id === '' ? null : Number(merged.pkg_grade_id)) : null;
      if (fmt && merged.pkg_staff_tier && (!fmt.graded || gid)) {
        const r = lookupRate(fmt.format_id, gid, merged.pkg_staff_tier);
        if (r && r.available && r.customer_price != null) {
          merged.fee = String(r.net_price ?? r.customer_price);
          // ค่าจ้างพนักงานคัดลอกมาคู่กันเสมอ — เป็นตัวตั้งของยอดที่พนักงานจะเห็นตอนปิดเคส
          if (r.staff_pay != null) merged.staff_pay = String(r.staff_pay);
        }
      }
      return merged;
    });
  }

  const isHomecare = form.service_kind === 'homecare';
  const isPhysio = form.service_kind === 'physio';

  const selPhysioId = form.physio_package_id === '' ? null : Number(form.physio_package_id);
  const selectedPhysio = physio.find((p) => p.physio_package_id === selPhysioId) ?? null;

  // ปกติเสนอเฉพาะแพ็คเกจที่ยังเปิดขาย — แต่เคสเก่าที่ผูกแพ็คเกจซึ่งปิดขายไปแล้วต้องยังเห็นของตัวเอง
  // ไม่งั้น dropdown จะเด้งเป็นค่าว่างแล้วแพ็คเกจของเคสนั้นหายไปเงียบๆ ตอนกดบันทึก
  const physioOptions = physio.filter((p) => p.active || p.physio_package_id === selPhysioId);

  // ค่าตอบแทนพนักงานที่แพ็คเกจ/เรทซึ่งเลือกอยู่ตอนนี้กำหนดไว้ — ตัวตั้งของช่อง "ค่าจ้างพนักงาน"
  const packagePay = isPhysio
    ? selectedPhysio?.staff_pay ?? null
    : currentRate?.available
      ? currentRate.staff_pay ?? null
      : null;
  const pickedService = isPhysio ? Boolean(selectedPhysio) : Boolean(currentRate);

  /**
   * ช่องค่าจ้างว่างอยู่ + แพ็คเกจที่เลือกมีค่าตอบแทนกำหนดไว้ -> เติมให้เอง
   *
   * ครอบกรณีที่ applySelection/applyPhysio ไม่ครอบ: เปิดฟอร์มแก้เคสเก่าที่ยังไม่มีค่าจ้าง
   * และเคสที่แพ็คเกจเพิ่งถูกตั้งค่าตอบแทนทีหลัง (ตอนเปิดเคสยังไม่มีตัวเลขให้คัดลอก)
   * ไม่ทับค่าที่กรอกไว้แล้ว — เคสที่ตกลงค่าจ้างพิเศษต้องคงตัวเลขของตัวเอง
   */
  useEffect(() => {
    if (packagePay == null) return;
    setForm((prev) => (prev.staff_pay === '' ? { ...prev, staff_pay: String(packagePay) } : prev));
  }, [packagePay]);

  /**
   * เปลี่ยนสายบริการ -> ล้างสิ่งที่เลือกไว้ของสายเดิม
   * ไม่ล้าง ค่าที่ค้างจะถูกส่งไปบันทึกด้วย กลายเป็นเคสที่มีทั้งเรท Homecare และแพ็คเกจกายภาพบำบัด
   * (ฝั่ง server ล้างซ้ำให้อีกชั้น — ที่นี่ล้างเพื่อให้สิ่งที่เห็นบนจอตรงกับสิ่งที่จะถูกบันทึก)
   * ไม่แตะค่าจ้างที่กรอกไว้ — เลือกแพ็คเกจใหม่แล้วมันจะถูกเติมทับให้เอง
   */
  function changeKind(kind) {
    setForm((prev) => ({
      ...prev,
      service_kind: kind,
      ...(kind !== 'homecare' ? { pkg_format_id: '', pkg_grade_id: '', pkg_staff_tier: '' } : null),
      ...(kind !== 'physio' ? { physio_package_id: '' } : null),
    }));
  }

  /** เลือกแพ็คเกจกายภาพบำบัด -> คัดลอกราคาพิเศษมาเป็นค่าจ้าง (คัดลอก ไม่ใช่อ้างอิง เหมือนฝั่ง Homecare) */
  function applyPhysio(value) {
    setForm((prev) => {
      const merged = { ...prev, physio_package_id: value };
      const p = physio.find((x) => x.physio_package_id === Number(value));
      if (p && p.special_price != null) merged.fee = String(p.special_price);
      if (p && p.staff_pay != null) merged.staff_pay = String(p.staff_pay);
      return merged;
    });
  }

  /**
   * เลือกผู้ป่วย -> ผูก patient_id + คัดลอกข้อมูลตัวตน (snapshot) เข้าเคส และดึงผู้ว่าจ้างที่ผูกไว้มาแสดง
   * "คัดลอก" ไม่ใช่ "อ้างอิง" — เคสที่ปิดแล้วคงข้อมูล ณ วันให้บริการไว้แม้แฟ้มผู้ป่วยจะแก้ทีหลัง
   */
  function pickPatient(p) {
    setPickedPatient(p);
    const cust = p.customer ?? (p.customer_id ? { customer_id: p.customer_id, name: p.customer_name } : null);
    setPayer(cust);
    setForm((prev) => ({
      ...prev,
      patient_id: p.patient_id,
      customer_id: p.customer_id ?? '',
      client_name: p.name ?? '',
      patient_gender: p.gender ?? '',
      patient_age: p.age ?? ageFromBirthDate(p.birth_date) ?? '',
      medical_history: p.medical_history ?? '',
      address: p.address ?? '',
    }));
  }

  /** เลิกเลือกผู้ป่วย -> กลับไปโหมดค้นหา/สร้างใหม่ (ข้อมูลที่เติมไว้ไม่ล้าง เผื่อสร้างแฟ้มใหม่จากข้อมูลเดิม) */
  function unpickPatient() {
    setPickedPatient(null);
    setQuery('');
    setForm((prev) => ({ ...prev, patient_id: '' }));
  }

  function pickPayer(c) {
    setPayer(c);
    setPayerQuery('');
    setPayerMatches([]);
    setForm((prev) => ({ ...prev, customer_id: c.customer_id }));
  }

  function unpickPayer() {
    setPayer(null);
    setForm((prev) => ({ ...prev, customer_id: '' }));
  }

  // ค้นหาผู้ป่วยที่ server — โชว์เฉพาะเมื่อยังไม่ได้เลือกและมีการพิมพ์
  useEffect(() => {
    if (form.patient_id || !query.trim()) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api.listPatients({ q: query.trim(), per_page: 8 }).then((r) => setMatches(r.data)).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [query, form.patient_id]);

  /**
   * เลือกผู้ว่าจ้างแล้ว -> ดึงผู้รับการดูแลที่อยู่ใต้ลูกค้ารายนั้นมาเสนอให้เลือกทันที
   * ลูกค้าหนึ่งคนมักจ้างดูแลคนในบ้านเดิมซ้ำๆ (พ่อ/แม่) การให้กดเลือกเลยเร็วกว่าพิมพ์ค้นหาใหม่ทุกครั้ง
   */
  useEffect(() => {
    if (isEdit || !form.customer_id || form.patient_id) {
      setOwnPatients([]);
      return;
    }
    api
      .listPatients({ customer_id: form.customer_id, per_page: 20 })
      .then((r) => setOwnPatients(r.data))
      .catch(() => setOwnPatients([]));
  }, [isEdit, form.customer_id, form.patient_id]);

  // ค้นหาผู้ว่าจ้าง (customer) สำหรับผูกกับผู้ป่วยใหม่
  useEffect(() => {
    if (form.customer_id || !payerQuery.trim()) {
      setPayerMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api.listCustomers({ q: payerQuery.trim(), per_page: 8 }).then((r) => setPayerMatches(r.data)).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [payerQuery, form.customer_id]);

  // เปิดเคสจากหน้าผู้รับการดูแล (?patient_id=PAT-0001) -> เลือกผู้ป่วยรายนั้นให้เลย
  useEffect(() => {
    if (isEdit) return;
    const pid = searchParams.get('patient_id');
    if (!pid) return;
    api.getPatient(pid).then((p) => pickPatient(p)).catch(() => {});
  }, [isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // เปิดเคสจากหน้าลูกค้า (?customer_id=CUS-0001) -> รู้ผู้ว่าจ้างแล้ว เหลือเลือก/สร้างผู้ป่วย
  useEffect(() => {
    if (isEdit) return;
    const cid = searchParams.get('customer_id');
    if (!cid || searchParams.get('patient_id')) return; // ถ้ามาจากผู้ป่วย ผู้ว่าจ้างมาเองแล้ว
    api.getCustomer(cid).then((c) => {
      setPayer(c);
      setForm((prev) => ({ ...prev, customer_id: c.customer_id }));
    }).catch(() => {});
  }, [isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isEdit) return;
    api
      .getCase(id)
      .then((c) => {
        const filled = { ...BLANK };
        for (const key of Object.keys(BLANK)) filled[key] = c[key] ?? '';

        // เคสที่เปิดก่อนมีสองสายไม่มี service_kind — เดาจากสิ่งที่ผูกไว้จริง
        // ไม่เดา ชุด dropdown จะถูกซ่อนแล้วบริการที่เลือกไว้จะหายไปจากสายตา (และโดนล้างทิ้งตอนกดบันทึก)
        if (!filled.service_kind) {
          if (filled.physio_package_id !== '') filled.service_kind = 'physio';
          else if (filled.pkg_format_id !== '') filled.service_kind = 'homecare';
        }
        setForm(filled);
        initial.current = JSON.stringify(filled);

        // มีผู้ว่าจ้างผูกไว้แล้ว — โชว์เป็นลูกค้าที่เลือกอยู่ (ใช้ชื่อจาก SELECT ของเคส ไม่ต้องยิงซ้ำ)
        // ยังไม่มี = ปล่อย payer เป็น null ส่วนผู้ว่าจ้างจะโชว์ช่องค้นหาให้เพิ่มลูกค้าเจ้าของเคส
        if (c.customer_id) setPayer({ customer_id: c.customer_id, name: c.customer_name });
      })
      .catch((err) => setError(err.message));
  }, [id, isEdit]);

  const isDirty = () => JSON.stringify(form) !== initial.current;

  /*
   * ปิดแท็บ/กดรีเฟรชทั้งที่ยังกรอกค้าง — ให้เบราว์เซอร์ถามก่อน
   * ฟอร์มเปิดเคสเป็นฟอร์มที่ยาวที่สุดในระบบ เสียไปทั้งหมดเพราะเผลอกดปุ่มเดียวคือกู้คืนไม่ได้
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
    /* name ต้องมี ไม่ใช่แค่ของประดับ — ตอน server ทักว่าช่องไหนผิด โค้ดด้านล่างเลื่อนจอไปหาช่องนั้น
       ด้วย querySelector('[name="..."]') ฟอร์มนี้เคยไม่ใส่ให้เลยหาไม่เจอสักช่อง คนกรอกจึงเห็นแต่
       ข้อความแดงบนสุดแต่ไม่รู้ว่าต้องแก้ตรงไหน ทั้งที่ฟอร์มยาว 2,300px กว่า
       (ฟอร์มลูกค้า/ผู้ป่วย/พนักงานเขียน name ใส่ทีละช่องเอง จึงไม่เจอปัญหานี้) */
    name: key,
    value: form[key],
    'aria-invalid': fieldErrors[key] ? true : undefined,
    onChange: (e) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
      // แก้ช่องที่เพิ่งโดนทักแล้ว ข้อความเตือนควรหายไปทันที ไม่ใช่ค้างจนกว่าจะกดบันทึกอีกรอบ
      setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    },
  });

  /** ข้อความเตือนใต้ช่อง — มาจาก details ของ zod ที่ server ส่งกลับมา
      ต้องมีคู่กับ aria-invalid เสมอ ไม่ใช้ขอบแดงสื่อความหมายอย่างเดียว (คนตาบอดสีจะไม่เห็น
      และขอบแดงก็ไม่ได้บอกว่าผิดตรงไหน) — ฟอร์มอื่นทำแบบนี้อยู่แล้ว ฟอร์มนี้ตกหล่นไป */
  const fieldError = (key) =>
    fieldErrors[key] ? <span className="field-error">{fieldErrors[key]}</span> : null;

  /** ออกจากหน้าโดยยังไม่บันทึก — ถามก่อน */
  const confirmLeave = (e) => {
    if (isDirty() && !window.confirm('ยังไม่ได้บันทึก — ออกจากหน้านี้แล้วข้อมูลที่กรอกไว้จะหาย')) {
      e.preventDefault();
    }
  };

  /** ตั้งพิกัดลงฟอร์ม + เติมที่อยู่ให้ถ้าช่องที่อยู่ยังว่าง (ไม่ทับที่พิมพ์ไว้เอง) */
  function applyLocation(lat, lng, address) {
    setForm((prev) => ({
      ...prev,
      geo_lat: lat.toFixed(6),
      geo_lng: lng.toFixed(6),
      address: prev.address?.trim() ? prev.address : (address ?? prev.address),
    }));
    setResolvedAddress(address ?? null);
    setCandidates([]);
  }

  const looksLikeUrl = (s) => /^https?:\/\//i.test(s.trim());

  /**
   * ช่องเดียวรับได้ทั้งลิงก์และชื่อสถานที่:
   *   เป็นลิงก์  -> อ่านพิกัด/ที่อยู่จากลิงก์ (รองรับลิงก์ย่อจากปุ่มแชร์)
   *   เป็นข้อความ -> ค้นหาชื่อสถานที่ ได้หลายผลก็ให้เลือกจากรายการ
   */
  async function findLocation() {
    const q = locQuery.trim();
    if (!q) return;
    setFinding(true);
    setLocError(null);
    setCandidates([]);
    try {
      if (looksLikeUrl(q)) {
        const r = await api.resolveMapLink(q);
        applyLocation(r.lat, r.lng, r.address);
      } else {
        // มีพิกัดอยู่แล้ว (เคสเดิม หรือเพิ่งกด "ใช้ที่อยู่ด้านบน") -> ใช้เป็นจุดอ้างอิงให้ผลใกล้ตัวขึ้นก่อน
        const near = form.geo_lat !== '' && form.geo_lng !== ''
          ? { lat: Number(form.geo_lat), lng: Number(form.geo_lng) }
          : null;
        const { results } = await api.searchPlace(q, near);
        if (results.length === 0) setLocError(`ไม่พบสถานที่ที่ตรงกับ "${q}" — ลองพิมพ์ให้เจาะจงขึ้น หรือวางลิงก์ Google Maps`);
        else if (results.length === 1) applyLocation(results[0].lat, results[0].lng, results[0].formatted);
        else setCandidates(results);
      }
    } catch (e) {
      setLocError(e.message);
    } finally {
      setFinding(false);
    }
  }

  /**
   * ใช้ที่อยู่ที่กรอกไว้ด้านบนเป็นจุดตั้งต้น — ไม่ต้องพิมพ์ที่อยู่เดิมซ้ำอีกรอบในช่องค้นหา
   * ได้พิกัดคร่าวๆ ระดับถนน/ซอย แล้วค่อยลากหมุดในแผนที่ไปที่ประตูบ้านจริง
   * (บ้านในซอยส่วนใหญ่ไม่มีอยู่ในฐานข้อมูลสถานที่ของ Google การค้นด้วยชื่อจึงไม่มีทางเจอ)
   */
  async function useTypedAddress() {
    const addr = form.address?.trim();
    if (!addr) return;
    setFinding(true);
    setLocError(null);
    setCandidates([]);
    try {
      const r = await api.geocodeAddress(addr);
      applyLocation(r.lat, r.lng, r.formatted ?? addr);
    } catch (e) {
      setLocError(e.message);
    } finally {
      setFinding(false);
    }
  }

  /** ล้างพิกัดที่ตั้งไว้ — กลับไปไม่ตรวจระยะตอนเช็คอิน */
  const clearGeo = () => {
    setForm((prev) => ({ ...prev, geo_lat: '', geo_lng: '' }));
    setResolvedAddress(null);
    setCandidates([]);
    setLocQuery('');
    setLocError(null);
  };

  /**
   * ยังไม่ได้เลือกผู้ป่วย = ผู้ป่วยรายใหม่ -> สร้างแฟ้ม (PAT-xxxx) จากข้อมูลที่กรอก แล้วผูกกับผู้ว่าจ้าง (ถ้ามี)
   * เก็บ patient_id กลับเข้าฟอร์ม เผื่อบันทึกเคสพลาดแล้วกดใหม่ จะไม่สร้างผู้ป่วยซ้ำ
   */
  async function ensurePatient(payload) {
    if (payload.patient_id) return payload.patient_id;

    const patient = await api.createPatient({
      name: payload.client_name,
      gender: payload.patient_gender,
      age: payload.patient_age,
      weight_kg: payload.weight_kg,
      height_cm: payload.height_cm,
      medical_history: payload.medical_history,
      allergies: payload.allergies,
      food_allergies: payload.food_allergies,
      relation_to_customer: payload.relation_to_customer,
      address: payload.address,
      customer_id: payload.customer_id, // ผูกผู้ว่าจ้างตั้งแต่แรก (null ได้ถ้ายังไม่รู้ผู้จ่าย)
    });

    setForm((prev) => ({ ...prev, patient_id: patient.patient_id }));
    return patient.patient_id;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(form);

      // เคสใหม่ต้องผูกแฟ้มผู้ป่วยเสมอ — เลือกไว้แล้วใช้เลย ไม่งั้นสร้างใหม่จากข้อมูลที่กรอก
      if (!isEdit) payload.patient_id = await ensurePatient(payload);

      // ไม่มีช่องชื่อเคสแล้ว — ตั้งชื่ออัตโนมัติจากบริการที่เลือก + ชื่อผู้ป่วย (ใช้สำหรับค้นหา)
      const gradeName = needGrade ? matrix?.grades.find((g) => g.grade_id === selGradeId)?.name : null;
      const serviceParts = isPhysio
        ? [selectedPhysio?.name]
        : [selectedFormat?.name, gradeName];
      payload.title =
        [...serviceParts, payload.client_name].filter(Boolean).join(' · ') || payload.client_name;

      // ฟิลด์เหล่านี้ย้ายไปเก็บที่แฟ้มผู้ป่วยแล้ว ไม่เก็บซ้ำในเคส (allergies/relation ไม่ใช่คอลัมน์ของเคสอยู่แล้ว)
      delete payload.allergies;
      delete payload.food_allergies;
      delete payload.relation_to_customer;
      delete payload.weight_kg;
      delete payload.height_cm;

      // ล้างสถานะ "ยังไม่บันทึก" ก่อนเปลี่ยนหน้า ไม่งั้น beforeunload จะเตือนทั้งที่บันทึกสำเร็จแล้ว
      initial.current = JSON.stringify(form);

      if (isEdit) {
        // การจับคู่พนักงานทำผ่านปุ่มใน popup เท่านั้น เพื่อไม่ให้สถานะเคสกับพนักงานขัดแย้งกัน
        const { assigned_to: _unused, ...rest } = payload;
        await api.updateCase(id, rest);
        toast('บันทึกการแก้ไขแล้ว');
        navigate(`/cases?open=${id}`);
      } else {
        const created = await api.createCase(payload);
        toast(`เปิดเคส ${created.case_id} แล้ว`);
        // เด้งกลับรายการพร้อมเปิดเคสที่เพิ่งสร้าง — เห็นผลทันทีและกดจับคู่พนักงานต่อได้เลย
        navigate(`/cases?open=${created.case_id}`);
      }
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
          <h1>{isEdit ? `แก้ไขเคส ${id}` : 'เปิดเคสใหม่'}</h1>
          {!isEdit && <p className="muted">ระบบจะออกรหัสเคส (CASE-xxxx) ให้อัตโนมัติหลังบันทึก</p>}
        </div>
        {/* ไม่มีปุ่มยกเลิกตรงนี้ — แถบล่างเป็น sticky ติดขอบจอตลอด ปุ่มยกเลิกที่นั่นกดถึงได้เสมอ
            มีสองที่ทำหน้าที่เดียวกันคือให้คนต้องเลือกโดยไม่จำเป็น และบนมือถือมันกินไปทั้งบรรทัด */}
      </header>

      {error && <pre className="error">{error}</pre>}

      <form className="card form" ref={formEl} onSubmit={handleSubmit}>
        {/* ผู้ว่าจ้าง (ผู้จ่ายเงิน) อยู่บนสุด — ต้องเห็นตั้งแต่แรกว่าเคสนี้ผูกกับลูกค้ารายไหน
            เลือกผู้ป่วยที่ผูกลูกค้าไว้แล้ว ผู้ว่าจ้างจะเด้งมาที่นี่เอง
            โหมดแก้ไข: ถ้าเคสยังไม่มีผู้ว่าจ้าง ให้ค้นหา/เพิ่มลูกค้าเจ้าของเคสได้ที่นี่ (บันทึกแล้วใบแจ้งหนี้จะตามให้เอง) */}
        <h2>ผู้ว่าจ้าง</h2>
        <div className="customer-picker">
          {payer ? (
            <div className="picked-customer">
              <div>
                <strong>ผู้ว่าจ้าง: {payer.name}</strong>
                <p className="muted"><span className="mono">{payer.customer_id}</span></p>
              </div>
              <button type="button" className="btn" onClick={unpickPayer}>เปลี่ยน / ไม่ผูก</button>
            </div>
          ) : (
            <>
              <label className="customer-search">
                ผู้ว่าจ้าง (ลูกค้าผู้จ่าย) — ไม่บังคับ
                <input
                  placeholder="ค้นหาลูกค้า — เว้นว่างได้ถ้ายังไม่รู้ว่าใครจ่าย"
                  value={payerQuery}
                  onChange={(e) => setPayerQuery(e.target.value)}
                />
              </label>
              {payerMatches.length > 0 && (
                <ul className="customer-results">
                  {payerMatches.map((c) => (
                    <li key={c.customer_id}>
                      <button type="button" onClick={() => pickPayer(c)}>
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
            </>
          )}
        </div>

        <h2>รายละเอียดเคส</h2>
        <div className="grid">
          <label>ประเภทเคส *
            <select required {...field('case_type')}>
              {Object.entries(CASE_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          {fieldError('case_type')}
          </label>
          <label>ประเภทบริการ
            <select value={form.service_kind} onChange={(e) => changeKind(e.target.value)}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(SERVICE_KIND_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>

          {isHomecare && (
          <label>รูปแบบบริการ
            <select value={form.pkg_format_id} onChange={(e) => applySelection({ pkg_format_id: e.target.value })}>
              <option value="">— ไม่ระบุ —</option>
              {['daily', 'weekly', 'monthly'].map((cat) => {
                const opts = matrix?.formats.filter((f) => f.category === cat) ?? [];
                if (opts.length === 0) return null;
                return (
                  <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
                    {opts.map((f) => <option key={f.format_id} value={f.format_id}>{f.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </label>
          )}

          {isPhysio && (
            <label>แพ็คเกจกายภาพบำบัด
              <select value={form.physio_package_id} onChange={(e) => applyPhysio(e.target.value)}>
                <option value="">— เลือกแพ็คเกจ —</option>
                {physioOptions.map((p) => (
                  <option key={p.physio_package_id} value={p.physio_package_id}>
                    {p.name} · {p.sessions} ครั้ง
                    {p.duration_months ? ` · ${p.duration_months} เดือน` : ''}
                    {` · ${formatBaht(p.special_price)}`}
                    {p.active ? '' : ' (ปิดขายแล้ว)'}
                  </option>
                ))}
              </select>
            </label>
          )}

          {isHomecare && needGrade && (
            <label>เกรด
              <select value={form.pkg_grade_id} onChange={(e) => applySelection({ pkg_grade_id: e.target.value })}>
                <option value="">— เลือกเกรด —</option>
                {matrix.grades.map((g) => <option key={g.grade_id} value={g.grade_id}>{g.name}</option>)}
              </select>
            </label>
          )}
          {isHomecare && (
          <label>ระดับพนักงาน
            <select
              value={form.pkg_staff_tier}
              onChange={(e) => applySelection({ pkg_staff_tier: e.target.value })}
              disabled={!selectedFormat || (needGrade && !selGradeId)}
            >
              <option value="">— เลือกระดับ —</option>
              {TIERS.map((t) => {
                const r = selectedFormat && (!needGrade || selGradeId)
                  ? lookupRate(selectedFormat.format_id, effectiveGrade, t)
                  : null;
                const off = r && !r.available;
                return (
                  <option key={t} value={t} disabled={off}>
                    {t}
                    {r && r.available && r.customer_price != null ? ` · ${formatBaht(r.customer_price)}` : ''}
                    {off ? ' (ให้บริการไม่ได้)' : ''}
                  </option>
                );
              })}
            </select>
          </label>
          )}
          {isHomecare && currentRate && currentRate.available && currentRate.customer_price != null && (
            <p className="form-hint muted">
              ค่าบริการ <strong>{formatBaht(currentRate.net_price ?? currentRate.customer_price)}</strong>
              {currentRate.discount_value > 0 &&
                ` (จากราคาเต็ม ${formatBaht(currentRate.customer_price)} − ส่วนลด ${formatBaht(currentRate.discount_value)})`}
              {currentRate.staff_pay != null && ` · ค่าตอบแทนพนักงาน ${formatBaht(currentRate.staff_pay)}`}
              {currentRate.margin != null && ` · ส่วนต่าง ${currentRate.margin}%`}
              {' '}— เติมลงช่องด้านล่างให้แล้ว แก้ทับได้
            </p>
          )}
          {isPhysio && selectedPhysio && (
            <p className="form-hint muted">
              ราคาพิเศษ <strong>{formatBaht(selectedPhysio.special_price)}</strong>
              {selectedPhysio.original_price != null && ` · จากราคาเดิม ${formatBaht(selectedPhysio.original_price)}`}
              {selectedPhysio.avg_per_session != null && ` · ตกเฉลี่ย ${formatBaht(selectedPhysio.avg_per_session)}/ครั้ง`}
              {selectedPhysio.staff_pay != null && ` · ค่าตอบแทนพนักงาน ${formatBaht(selectedPhysio.staff_pay)}`}
              {selectedPhysio.margin != null && ` · ส่วนต่าง ${selectedPhysio.margin}%`}
              {' '}— เติมลงช่องด้านล่างให้แล้ว แก้ทับได้
            </p>
          )}
          <label>วันเริ่ม<input type="date" {...field('start_date')} />{fieldError('start_date')}</label>
          <label>วันสิ้นสุด (ถ้ามี)<input type="date" {...field('end_date')} />{fieldError('end_date')}</label>
          <label>ค่าบริการที่ได้รับ (บาท)
            <input type="number" min="0" step="0.01" placeholder="เช่น 15000" {...field('fee')} />
            {fieldError('fee')}
          </label>
          {/* ยอดที่พนักงานจะเห็นเป็นรายได้ของตัวเองเมื่อปิดเคส — ดึงจากแพ็คเกจให้ แก้ทับได้ */}
          <label>ค่าจ้างพนักงาน (บาท)
            <input
              type="number" min="0" step="0.01"
              placeholder={packagePay != null ? String(packagePay) : 'ยังไม่มีในแพ็คเกจ'}
              {...field('staff_pay')}
            />
            {fieldError('staff_pay')}
          </label>

          {/* เลือกบริการแล้วแต่แพ็คเกจไม่มีค่าตอบแทน = ดึงมาให้ไม่ได้ ต้องบอกว่าไปตั้งที่ไหน
              ไม่งั้นจะเข้าใจว่าระบบพัง แล้วปล่อยว่างจนพนักงานเห็น "ยังไม่ระบุค่าจ้าง" ตอนปิดเคส */}
          {pickedService && packagePay == null && (
            <p className="form-hint muted">
              ⚠ {isPhysio ? 'แพ็คเกจกายภาพบำบัด' : 'เรทที่เลือก'}นี้ยังไม่ได้ตั้งค่าตอบแทนพนักงานในระบบ —
              กรอกเองในช่องด้านบนได้ หรือไปตั้งที่หน้า
              <Link className="link" to={isPhysio ? '/physio-packages' : '/packages'}>
                {isPhysio ? ' แพ็คเกจกายภาพบำบัด' : ' แพ็คเกจ Homecare'}
              </Link>
              {' '}เพื่อให้เคสอื่นที่ใช้แพ็คเกจเดียวกันได้ด้วย
            </p>
          )}
          {pickedService && packagePay != null && Number(form.staff_pay) !== packagePay && (
            <p className="form-hint muted">
              ค่าตอบแทนตามแพ็คเกจคือ <strong>{formatBaht(packagePay)}</strong> — ตอนนี้ใช้ตัวเลขที่กรอกเองแทน{' '}
              <button
                type="button"
                className="inline-link"
                onClick={() => setForm((prev) => ({ ...prev, staff_pay: String(packagePay) }))}
              >
                ใช้ค่าตามแพ็คเกจ
              </button>
            </p>
          )}
        </div>

        <h2>ผู้รับการดูแล</h2>

        {isEdit ? (
          /* แก้ไขเคส: ข้อมูลผู้ป่วยในเคยคือ snapshot ณ วันให้บริการ — แก้ตรงนี้ไม่กระทบแฟ้มผู้ป่วย */
          <>
            {form.patient_id && (
              <p className="notice">
                ผูกกับแฟ้มผู้ป่วย <Link className="link" to={`/patients/${form.patient_id}`}>{form.patient_id}</Link>
                {' '}· การแก้ด้านล่างแก้เฉพาะข้อมูลในเคสนี้ (snapshot) ไม่กระทบแฟ้มผู้ป่วย
              </p>
            )}
            <div className="grid">
              <label>ชื่อผู้ป่วย *<input required {...field('client_name')} />{fieldError('client_name')}</label>
              <label>เพศ
                <select {...field('patient_gender')}>
                  <option value="">— ไม่ระบุ —</option>
                  {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              {fieldError('patient_gender')}
              </label>
              <label>อายุ (ปี)<input type="number" min="0" max="130" {...field('patient_age')} />{fieldError('patient_age')}</label>
              <label className="span-2">โรคประจำตัว
                <textarea rows={2} placeholder="เช่น เบาหวาน ความดันโลหิตสูง" {...field('medical_history')} />
                {fieldError('medical_history')}
              </label>
            </div>
          </>
        ) : pickedPatient ? (
          /* เปิดเคสใหม่ + เลือกผู้ป่วยแล้ว: โชว์ข้อมูลแบบอ่านอย่างเดียว (ตัวตนมาจากแฟ้ม ไม่พิมพ์ซ้ำ) */
          <>
            {pickedPatient.allergies && (
              <p className="notice allergy-alert">
                <strong>⚠ แพ้ยา:</strong> {pickedPatient.allergies}
              </p>
            )}
            {pickedPatient.food_allergies && (
              <p className="notice allergy-alert">
                <strong>⚠ แพ้อาหาร:</strong> {pickedPatient.food_allergies}
              </p>
            )}
            <div className="picked-customer">
              <div>
                <strong>{pickedPatient.name}</strong>
                <p className="muted">
                  <span className="mono">{pickedPatient.patient_id}</span>
                  {shownAge(pickedPatient) && ` · ${GENDER_LABELS[pickedPatient.gender] ?? ''} ${shownAge(pickedPatient)}`}
                  {pickedPatient.medical_history && ` · โรคประจำตัว: ${pickedPatient.medical_history}`}
                </p>
              </div>
              <button type="button" className="btn" onClick={unpickPatient}>เปลี่ยนผู้ป่วย</button>
            </div>
          </>
        ) : (
          /* เปิดเคสใหม่ + ยังไม่เลือก: ค้นหาผู้ป่วยเดิม หรือกรอกเพื่อสร้างแฟ้มใหม่ */
          <>
            <div className="customer-picker">
              <label className="customer-search">
                ค้นหาผู้รับการดูแล (รหัส / ชื่อ / เลขบัตร)
                <input
                  placeholder="พิมพ์เพื่อค้นหา — ถ้ายังไม่มีในระบบ กรอกด้านล่างเพื่อสร้างแฟ้มใหม่"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>

              {/* ยังไม่พิมพ์ค้นหา + รู้ผู้ว่าจ้างแล้ว -> เสนอคนในความดูแลของลูกค้ารายนั้นให้กดเลือกเลย */}
              {!query.trim() && ownPatients.length > 0 && (
                <>
                  <p className="muted picker-hint">
                    ผู้รับการดูแลของ{payer ? ` ${payer.name}` : 'ลูกค้ารายนี้'} — กดเลือกได้เลย
                  </p>
                  <ul className="customer-results">
                    {ownPatients.map((p) => (
                      <li key={p.patient_id}>
                        <button type="button" onClick={() => pickPatient(p)}>
                          <strong>{p.name}{p.nickname && ` (${p.nickname})`}</strong>
                          <span className="muted">
                            <span className="mono">{p.patient_id}</span>
                            {p.relation_to_customer && ` · ${p.relation_to_customer}`}
                            {shownAge(p) && ` · ${shownAge(p)}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {matches.length > 0 && (
                <ul className="customer-results">
                  {matches.map((p) => (
                    <li key={p.patient_id}>
                      <button type="button" onClick={() => pickPatient(p)}>
                        <strong>{p.name}{p.nickname && ` (${p.nickname})`}</strong>
                        <span className="muted">
                          <span className="mono">{p.patient_id}</span>
                          {shownAge(p) && ` · ${shownAge(p)}`}
                          {p.customer_name && ` · ผู้ว่าจ้าง ${p.customer_name}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {query && matches.length === 0 && (
                <p className="muted">ไม่พบผู้รับการดูแลที่ตรงกับ "{query}" — กรอกด้านล่างเพื่อสร้างแฟ้มใหม่</p>
              )}

              <p className="notice picker-note">
                ยังไม่ได้เลือกผู้ป่วย — ระบบจะ<strong>สร้างแฟ้มผู้รับการดูแลใหม่ (PAT-xxxx)</strong>
                จากข้อมูลที่กรอกด้านล่างให้อัตโนมัติเมื่อกดบันทึก
              </p>
            </div>

            <h3>ข้อมูลผู้ป่วยใหม่</h3>
            <div className="grid">
              <label>ชื่อผู้ป่วย *<input required {...field('client_name')} />{fieldError('client_name')}</label>
              <label>เพศ
                <select {...field('patient_gender')}>
                  <option value="">— ไม่ระบุ —</option>
                  {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              {fieldError('patient_gender')}
              </label>
              <label>อายุ (ปี)<input type="number" min="0" max="130" {...field('patient_age')} />{fieldError('patient_age')}</label>

              <label>ความสัมพันธ์กับผู้ว่าจ้าง
                <input placeholder="เช่น บิดา มารดา" {...field('relation_to_customer')} />
                {fieldError('relation_to_customer')}
              </label>
              <label>น้ำหนัก (กก.)<input type="number" min="0" step="0.1" {...field('weight_kg')} />{fieldError('weight_kg')}</label>
              <label>ส่วนสูง (ซม.)<input type="number" min="0" step="0.1" {...field('height_cm')} />{fieldError('height_cm')}</label>
              <label className="span-2">โรคประจำตัว
                <textarea rows={2} placeholder="เช่น เบาหวาน ความดันโลหิตสูง" {...field('medical_history')} />
                {fieldError('medical_history')}
              </label>
              <label className="span-2">แพ้ยา
                <textarea rows={2} placeholder="เช่น เพนิซิลลิน แอสไพริน — ไม่มีให้เว้นว่าง" {...field('allergies')} />
                {fieldError('allergies')}
              </label>
              <label className="span-2">แพ้อาหาร
                <textarea rows={2} placeholder="เช่น อาหารทะเล ถั่ว นมวัว — ไม่มีให้เว้นว่าง" {...field('food_allergies')} />
                {fieldError('food_allergies')}
              </label>
            </div>

          </>
        )}

        <h2>การประเมิน / อาการครั้งนี้</h2>
        <div className="grid">
          <label className="span-2">อาการปัจจุบัน
            <textarea rows={2} placeholder="เช่น ติดเตียง ช่วยเหลือตัวเองไม่ได้ กลืนลำบาก" {...field('current_symptoms')} />
            {fieldError('current_symptoms')}
          </label>
          <label className="span-2">อุปกรณ์ / สายต่างๆ
            <textarea rows={2} placeholder="เช่น สายให้อาหารทางจมูก สายสวนปัสสาวะ ถังออกซิเจน" {...field('medical_devices')} />
            {fieldError('medical_devices')}
          </label>
          <label className="span-2">จุดประสงค์ของญาติในการดูแล
            <textarea rows={2} placeholder="เช่น ต้องการให้ฟื้นฟูให้ลุกนั่งได้ / ดูแลประคับประคอง" {...field('care_goal')} />
            {fieldError('care_goal')}
          </label>
        </div>

        <h2>รายละเอียดการใช้บริการ</h2>
        <div className="grid">
          <label className="span-2">วัน / เวลาที่สะดวกเริ่มใช้บริการ
            <input placeholder="เช่น เริ่มได้ 20 ก.ค. เป็นต้นไป ช่วงเช้า" {...field('service_start_preference')} />
            {fieldError('service_start_preference')}
          </label>
          <label>เบอร์ติดต่อคุณญาติ<input {...field('client_phone')} />{fieldError('client_phone')}</label>

          <label className="span-2">ที่อยู่สถานที่ดูแล
            <textarea rows={2} {...field('address')} />
            {fieldError('address')}
          </label>
          <label>วัน / เวลาที่สะดวกให้พยาบาลโทรประเมินและรับเคส
            <input placeholder="เช่น จันทร์-ศุกร์ หลัง 18.00 น." {...field('nurse_call_preference')} />
            {fieldError('nurse_call_preference')}
          </label>
        </div>

        <h2>พิกัดสถานที่ดูแล (สำหรับเช็คอิน)</h2>
        <div className="geo-section">
          <p className="muted">
            พิมพ์ชื่อสถานที่เพื่อค้นหา หรือวางลิงก์ Google Maps ก็ได้ — ระบบจะดึงพิกัดและที่อยู่ให้เอง ·
            เว้นว่างได้ (ไม่ตั้งพิกัด = ระบบจะไม่ตรวจระยะตอนเช็คอิน)
          </p>

          <label className="geo-label">ค้นหาสถานที่ หรือวางลิงก์ Google Maps
            <input
              placeholder='เช่น "โรงพยาบาลบำรุงราษฎร์" หรือวางลิงก์ https://maps.app.goo.gl/...'
              value={locQuery}
              onChange={(e) => setLocQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter = ค้นหา ไม่ใช่ submit ทั้งฟอร์ม (กันเคสถูกบันทึกก่อนตั้งใจ)
                if (e.key === 'Enter') {
                  e.preventDefault();
                  findLocation();
                }
              }}
            />
          </label>

          <div className="geo-actions">
            <button type="button" className="btn" disabled={finding || !locQuery.trim()} onClick={findLocation}>
              {finding ? 'กำลังค้นหา…' : '🔍 ค้นหา / อ่านลิงก์'}
            </button>
            {/* ที่อยู่พิมพ์ไปแล้วด้านบน ไม่มีเหตุผลให้ต้องพิมพ์ซ้ำในช่องค้นหาอีกรอบ */}
            {form.address?.trim() && (
              <button type="button" className="btn" disabled={finding} onClick={useTypedAddress}>
                ใช้ที่อยู่ด้านบน
              </button>
            )}
            {form.geo_lat !== '' && (
              <button type="button" className="btn danger-ghost" onClick={clearGeo}>ล้างพิกัด</button>
            )}
          </div>

          {locError && <p className="error geo-error">{locError}</p>}

          {/* พิมพ์ชื่อแล้วเจอหลายที่ — ให้เลือก */}
          {candidates.length > 0 && (
            <ul className="customer-results">
              {candidates.map((c, i) => (
                <li key={`${c.lat},${c.lng},${i}`}>
                  <button type="button" onClick={() => applyLocation(c.lat, c.lng, c.formatted)}>
                    <strong>{c.name ?? c.formatted}</strong>
                    {c.name && c.formatted && <span className="muted">{c.formatted}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* มีพิกัดแล้ว (เพิ่งค้นหา/อ่านลิงก์ หรือโหลดมาจากเคสเดิม) — โชว์ที่อยู่ + แผนที่ให้ปรับหมุด
              เดิมเป็นแผนที่รูปนิ่ง ปักมาตรงไหนก็ต้องเอาตรงนั้น
              แต่การค้นด้วยชื่อจะได้จุดกลางอาคาร ซึ่งห่างจากประตูจริงได้เป็นร้อยเมตรในตึกใหญ่
              และพิกัดนี้คือตัวตัดสินว่าพนักงานจะโดนธง "นอกพื้นที่" ตอนเช็คอินหรือไม่ (รัศมีปริยาย 200 ม.)
              ลากหมุดได้จึงเป็นวิธีเดียวที่ปักตรงบ้านในซอยซึ่ง Google ไม่รู้จักได้ */}
          {form.geo_lat !== '' && form.geo_lng !== '' && (
            <div className="geo-result">
              <p className="geo-set">
                <span className="geo-set-pin">📍 ตั้งพิกัดแล้ว</span>
                <span className="geo-set-addr">{resolvedAddress ?? `${form.geo_lat}, ${form.geo_lng}`}</span>
              </p>
              <p className="form-hint muted">
                ลากหมุดหรือแตะบนแผนที่เพื่อย้ายไปจุดที่พนักงานต้องไปถึงจริง (ประตูบ้าน/ตึก) —
                ยิ่งตรงจุด การตรวจระยะตอนเช็คอินยิ่งแม่น
              </p>
              <MapPicker
                lat={form.geo_lat}
                lng={form.geo_lng}
                onChange={(lat, lng) =>
                  setForm((prev) => ({ ...prev, geo_lat: lat.toFixed(6), geo_lng: lng.toFixed(6) }))
                }
              />
            </div>
          )}
        </div>

        <h2>{isEdit ? 'หมายเหตุ' : 'จับคู่พนักงาน'}</h2>
        <div className="grid">
          {!isEdit && (
            <label className="span-2">
              พนักงานที่รับเคส
              <select {...field('assigned_to')}>
                <option value="">— ยังไม่จับคู่ (จับคู่ทีหลังได้) —</option>
                {staff.map((e) => (
                  <option key={e.employee_id} value={e.employee_id}>
                    {e.employee_id} · {e.first_name} {e.last_name} ({POSITION_LABELS[e.position]}) · ถืออยู่ {e.active_cases} เคส
                  </option>
                ))}
              </select>
            {fieldError('assigned_to')}
            </label>
          )}
          <label className="span-2">หมายเหตุ<textarea rows={2} {...field('note')} />{fieldError('note')}</label>
        </div>

        {/* ติดขอบล่างจอ — ฟอร์มนี้ยาวที่สุดในระบบ แก้คำเดียวก็ไม่ควรต้องเลื่อนสุดทางไปกดปุ่ม */}
        <div className="form-actions sticky">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : isEdit ? 'บันทึกการแก้ไข' : 'เปิดเคส'}
          </button>
          <Link className="btn" to="/cases" onClick={confirmLeave}>ยกเลิก</Link>
        </div>
      </form>
    </>
  );
}
