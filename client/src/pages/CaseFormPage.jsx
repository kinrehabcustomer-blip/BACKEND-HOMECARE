import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import MapPicker from '../components/MapPicker.jsx';
import {
  POSITION_LABELS, GENDER_LABELS, SERVICE_KIND_LABELS, ENGLISH_SURCHARGE,
  formatBaht, ageFromBirthDate, positionsForCase, todayTH,
} from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';
import StaffPicker from '../components/StaffPicker.jsx';
import PatientCodeInput from '../components/PatientCodeInput.jsx';
import YearCodeInput from '../components/YearCodeInput.jsx';
import { isPatientCode, isCaseCode } from '../lib/patientCode.js';
import { nextRoundDates, endDateFor } from '../lib/caseRounds.js';
import { useCanSeeStaffPay } from '../auth.jsx';
import { useScrollLock } from '../lib/scrollLock.js';
import { formatPhone, formatPhoneInput } from '../lib/phone.js';

const TIERS = ['CG', 'NA', 'PN', 'RN'];
const CATEGORY_LABELS = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน' };

const BLANK = {
  // รหัสเคส VN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก (กรอกเอง) — ตอนแก้: ว่าง = คงรหัสเดิม
  case_code: '',
  customer_id: '',
  patient_id: '',
  service_kind: '',
  pkg_format_id: '', pkg_grade_id: '', pkg_staff_tier: '', // [Homecare]
  pkg_english: false, // [Homecare] พนักงานสื่อสารภาษาอังกฤษ — บวกค่าภาษาเข้า fee
  physio_package_id: '', // [กายภาพ]

  // ตัวตนผู้รับบริการ (มาจากแฟ้ม patient / หรือกรอกเพื่อสร้างแฟ้มใหม่) — client_name/gender/age/medical_history คัดลอกเป็น snapshot ในเคส
  client_name: '', patient_gender: '', patient_age: '', medical_history: '',
  // เฉพาะตอนสร้างผู้รับบริการใหม่ — เก็บที่แฟ้มผู้รับบริการ ไม่ใช่คอลัมน์ของเคส (ถูกตัดออกก่อนบันทึกเคส)
  weight_kg: '', height_cm: '', allergies: '', food_allergies: '',

  // การประเมิน/อาการครั้งนี้ (ข้อมูลของเคส เปลี่ยนได้ทุกรอบ)
  current_symptoms: '', medical_devices: '', care_goal: '',

  // รายละเอียดการใช้บริการ
  service_start_preference: '', address: '', client_phone: '', nurse_call_preference: '',

  // พิกัดสถานที่ดูแล (geofence เช็คอิน)
  geo_lat: '', geo_lng: '', geofence_radius_m: '',

  // fee = ค่าบริการที่ลูกค้าจ่าย · staff_pay = ค่าจ้างที่พนักงานได้เมื่อปิดเคส (คนละตัวเลข)
  start_date: '', end_date: '', fee: '', staff_pay: '', note: '',
  // อุปกรณ์เสริมที่คิดเงินเพิ่ม [{ name, quantity, unit_price }] — บวกเข้ายอดใบแจ้งหนี้ ไม่รวมในค่าบริการ
  addons: [],
  // รหัสผู้รับบริการ (KN…) ของแฟ้มที่จะสร้างใหม่ — ไม่ใช่คอลัมน์ของเคส (ถูกตัดออกก่อนบันทึกเคส)
  patient_code: '',
  assigned_to: '',
};

/* ชื่อแทนของเคสที่เปิดโดยรู้แค่ผู้ว่าจ้าง — ต้องตรงกับ PATIENT_PENDING ใน server/src/cases/schema.js
   โหลดเคสมาแก้แล้วแปลงกลับเป็นช่องว่าง ให้กรอกชื่อจริงทับได้เลย ไม่ต้องลบคำนี้ออกเอง */
const PATIENT_PENDING = 'ยังไม่ระบุผู้รับบริการ';

const BLANK_ADDON = { name: '', quantity: '1', unit_price: '' };

/** ยอดของบรรทัด — ปัดสองตำแหน่งแบบเดียวกับ server/src/lib/addons.js ตัวเลขบนฟอร์มจะได้ตรงกับใบ */
const addonAmount = (a) => Math.round(Number(a.quantity || 0) * Number(a.unit_price || 0) * 100) / 100;
const addonsTotal = (list) => Math.round(list.reduce((s, a) => s + addonAmount(a), 0) * 100) / 100;

/** แถวที่ยังไม่กรอกอะไรเลยถือว่าไม่มี (กดเพิ่มแล้วไม่ใช้) — แถวที่กรอกครึ่งๆ ส่งไปให้ server ทักเป็นรายช่อง */
const addonsPayload = (list) =>
  list
    .filter((a) => String(a.name).trim() !== '' || String(a.unit_price) !== '')
    .map((a) => ({
      name: String(a.name).trim(),
      quantity: Number(a.quantity === '' ? 1 : a.quantity),
      unit_price: Number(a.unit_price === '' ? 0 : a.unit_price),
    }));

/* ตัวเลือกที่ระบุแพ็คเกจ/เรทจริง — ไม่รวม service_kind เพราะเคสเก่าที่ยังว่างถูกเดาให้ตอนโหลด
   (ต้องตรงกับ SERVICE_ID_FIELDS ใน server/src/cases/repo.js) */
const SERVICE_ID_FIELDS = ['physio_package_id', 'pkg_format_id', 'pkg_grade_id', 'pkg_staff_tier'];
const TERMINAL_STATUSES = ['closed', 'cancelled'];

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
  // เปิดดูพนักงานทุกตำแหน่ง แทนที่จะเห็นเฉพาะระดับที่เคสนี้ต้องการ
  const formEl = useRef(null);

  /* โหมดแก้ไข: เคสตามที่โหลดมา (ไว้เทียบว่าเปลี่ยนบริการไหม) + ใบแจ้งหนี้ของเคส (ไว้บอกว่าจะกระทบใบไหน)
     แยกจาก initial ด้านล่าง เพราะ initial ถูกตั้งใหม่ตอนกดบันทึก ส่วนอันนี้ต้องเป็นของเดิมจริงเสมอ */
  const [original, setOriginal] = useState(null);
  const [caseInvoices, setCaseInvoices] = useState([]);
  // กล่องยืนยันก่อนบันทึกการเปลี่ยนแพ็คเกจ
  const [confirmingService, setConfirmingService] = useState(false);
  useScrollLock(confirmingService);

  // ค่าตั้งต้นไว้เทียบว่าผู้ใช้แก้อะไรไปแล้วบ้าง (ใช้เตือนก่อนออกจากหน้า)
  const initial = useRef(JSON.stringify(BLANK));
  // ตั้งพิกัดสถานที่ดูแล: พิมพ์ชื่อสถานที่เพื่อค้นหา หรือวางลิงก์ Google Maps ก็ได้ (ช่องเดียวกัน)
  const [locQuery, setLocQuery] = useState('');
  const [finding, setFinding] = useState(false);
  const [locError, setLocError] = useState(null);
  const [candidates, setCandidates] = useState([]);   // ผลค้นหาให้เลือก (กรณีพิมพ์ชื่อ)
  const [resolvedAddress, setResolvedAddress] = useState(null);

  // ค่าจ้าง/ส่วนต่าง = เฉพาะผู้จัดการ — คนอื่นเปิดเคสได้ครบ แค่ไม่เห็นและไม่ตั้งตัวเลขฝั่งต้นทุน
  const seePay = useCanSeeStaffPay();

  // ค้นหา/เลือกผู้รับการดูแล (patient) เป็นหลัก
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [pickedPatient, setPickedPatient] = useState(null);
  /* ผู้ว่าจ้างเป็นอะไรกับผู้รับบริการ — เก็บที่แฟ้มผู้รับบริการ (employer_relation) ไม่ใช่ที่เคส จึงแยกจาก form
     relationSaved = ค่าในแฟ้มตอนนี้ — แก้แล้วค่อยบันทึกกลับแฟ้มหลังบันทึกเคส */
  const [relation, setRelation] = useState('');
  const relationSaved = useRef('');
  const loadRelation = (p) => {
    setRelation(p?.employer_relation ?? '');
    relationSaved.current = p?.employer_relation ?? '';
  };
  // ผู้รับการดูแลที่อยู่ใต้ผู้ว่าจ้างที่เลือกไว้ — เสนอให้เลือกเลยโดยไม่ต้องพิมพ์ค้นหา
  const [ownPatients, setOwnPatients] = useState([]);

  // ผู้ว่าจ้าง (customer) — เลือกได้ไม่บังคับ; ถ้าเลือกผู้รับบริการที่ผูกลูกค้าไว้แล้วจะมาเอง
  const [payer, setPayer] = useState(null);
  const [payerQuery, setPayerQuery] = useState('');
  const [payerMatches, setPayerMatches] = useState([]);
  // ผู้ว่าจ้างรายใหม่ที่ยังไม่มีในระบบ { name, phone } — บันทึกเข้าตารางลูกค้าตอนกดบันทึกเคส
  // (ไม่สร้างทันทีที่กดเพิ่ม เพราะถ้าเปลี่ยนใจไม่เปิดเคส จะเหลือลูกค้าค้างในระบบโดยไม่มีใครรู้)
  const [payerPhone, setPayerPhone] = useState('');
  /* พิมพ์ชื่อผู้ว่าจ้างแล้วไม่ได้เลือกจากรายการที่มีอยู่ = ผู้ว่าจ้างรายใหม่ (ไม่ต้องกดปุ่มเพิ่มก่อน)
     คิดจากช่องที่กรอกอยู่ตรงๆ ไม่เก็บเป็น state แยก — ช่องกับสิ่งที่จะบันทึกจึงไม่มีทางไม่ตรงกัน */
  const newPayer = !form.customer_id && payerQuery.trim() ? { name: payerQuery, phone: payerPhone } : null;

  /* ข้อมูลประกอบของฟอร์ม — โหลดล้มแล้วต้องบอก ไม่ใช่กลืนเงียบ (ตรวจรอบ 20)
     เดิมทั้งสามเส้นเป็น .catch(() => {}) · API ล่มแล้วผู้จัดการเห็นช่อง "รูปแบบบริการ" เหลือ
     "— ไม่ระบุ —" ช่อง "ระดับพนักงาน" กดไม่ได้ และ "พนักงานที่รับเคส" ว่างเปล่า
     โดยไม่มีอะไรบอกว่าระบบขัดข้อง — แยกไม่ออกว่า "ไม่มีข้อมูล" หรือ "โหลดไม่สำเร็จ"
     แล้วอาจเปิดเคสทั้งที่ยังไม่มีบริการและคนรับผิดชอบ */
  const [loadFailed, setLoadFailed] = useState([]);
  useEffect(() => {
    const load = (label, run, set) =>
      run().then(set).catch(() => setLoadFailed((prev) => (prev.includes(label) ? prev : [...prev, label])));

    load('พนักงานที่รับเคสได้', api.assignableEmployees, setStaff);
    // ตารางเรททั้งหมด (เกรด + รูปแบบ + ราคา) — ใช้ให้เลือกเรทตอนเปิดเคส
    load('รูปแบบบริการและเรท Homecare', api.packageMatrix, setMatrix);
    // แพ็คเกจกายภาพบำบัด (เหมาจำนวนครั้ง) — อีกสายที่เลือกได้แทน Homecare
    load('แพ็คเกจกายภาพบำบัด', api.listPhysioPackages, setPhysio);
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
  // ค่าภาษาของรูปแบบที่เลือก — 0 = หมวดนี้ไม่มีตัวเลือกค่าภาษา (รายสัปดาห์)
  const englishFee = ENGLISH_SURCHARGE[selectedFormat?.category] ?? 0;
  const currentRate =
    selectedFormat && form.pkg_staff_tier && (!needGrade || selGradeId)
      ? lookupRate(selectedFormat.format_id, effectiveGrade, form.pkg_staff_tier)
      : null;

  /* ---------- รายชื่อพนักงานที่เข้ากับบริการที่เลือกไว้ ----------
     เลือกระดับ "RN" ไว้แล้วยังต้องไล่หาพยาบาลเองในรายชื่อทั้งบริษัทไม่มีเหตุผล
     — กรองให้เหลือเฉพาะตำแหน่งที่ตรงกับระดับ (สายกายภาพ = นักกายภาพบำบัด)

     แสดงเฉพาะตำแหน่งที่ตรงเท่านั้น (ผู้ใช้ขอ 2026-10-16 — เดิมมีปุ่ม "ดูทุกตำแหน่ง" และถอยไปแสดงทุกคน)
       · ยังไม่เลือกบริการ = ยังไม่รู้ว่าต้องการใคร → แสดงพนักงาน front ทุกคน
       · ไม่มีใครตรง = dropdown ว่าง พร้อมบอกว่าขาดตำแหน่งไหน
       · คนที่เลือกไว้แล้วยังอยู่ในรายการเสมอ แม้จะเปลี่ยนระดับทีหลังจนไม่ตรง (ติดป้ายบอกว่าไม่ตรงระดับ) */
  const wantedPositions = positionsForCase(form);
  /* เลือกได้เฉพาะสายดูแล/สายบำบัด (server ส่ง can_take_cases มา และกันซ้ำตอนบันทึก)
     staff ยังเก็บทุกคนไว้ — เคสเก่าที่ผู้รับผิดชอบเป็นสายสำนักงานยังต้องโชว์ชื่อเดิมได้ */
  const fieldStaff = staff.filter((e) => e.can_take_cases);
  const matchingStaff = wantedPositions ? fieldStaff.filter((e) => wantedPositions.includes(e.position)) : fieldStaff;
  // แสดงเฉพาะตำแหน่งที่เคสต้องการเท่านั้น — ไม่มีปุ่มดูทุกตำแหน่ง และไม่ถอยไปแสดงทุกคนเมื่อไม่มีใครตรง
  const baseStaff = matchingStaff;
  const shownStaff =
    form.assigned_to && !baseStaff.some((e) => e.employee_id === form.assigned_to)
      ? [...baseStaff, ...staff.filter((e) => e.employee_id === form.assigned_to)]
      : baseStaff;

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
      // เปลี่ยนตัวเลือกบริการแล้วค่าจ้างเดิมไม่ใช่ default ของบริการใหม่อีกต่อไป
      // ล้างก่อน แล้วเติมค่าของเรทใหม่เมื่อเลือกครบ; ถ้าเรทใหม่ยังไม่ตั้งค่า ช่องต้องว่างให้เห็นจริง
      merged.staff_pay = '';
      const fmt = matrix?.formats.find((f) => f.format_id === Number(merged.pkg_format_id));
      if (fmt && !fmt.graded) merged.pkg_grade_id = ''; // รูปแบบไม่อิงเกรด ล้างเกรดทิ้ง
      const surcharge = ENGLISH_SURCHARGE[fmt?.category] ?? 0;
      if (!surcharge) merged.pkg_english = false; // ย้ายไปหมวดที่ไม่มีค่าภาษา ธงต้องไม่ค้าง
      // เปลี่ยนรูปแบบบริการ = ความยาวของบริการเปลี่ยน → วันสิ้นสุดตามจำนวนวันของหมวดใหม่
      // (เฉพาะตอนเปลี่ยนรูปแบบ ไม่ใช่ตอนเปลี่ยนเกรด/ระดับ — ไม่งั้นวันสิ้นสุดที่แก้เองจะถูกทับทุกครั้ง)
      if ('pkg_format_id' in next) merged.end_date = endDateFor(merged.start_date, fmt?.category) ?? merged.end_date;
      const gid = fmt?.graded ? (merged.pkg_grade_id === '' ? null : Number(merged.pkg_grade_id)) : null;
      if (fmt && merged.pkg_staff_tier && (!fmt.graded || gid)) {
        const r = lookupRate(fmt.format_id, gid, merged.pkg_staff_tier);
        if (r && r.available && r.customer_price != null) {
          merged.fee = String((r.net_price ?? r.customer_price) + (merged.pkg_english ? surcharge : 0));
          // ค่าจ้างพนักงานคัดลอกมาคู่กันเสมอ — เป็นตัวตั้งของยอดที่พนักงานจะเห็นตอนปิดเคส
          if (r.staff_pay != null) merged.staff_pay = String(r.staff_pay);
        }
      }
      return merged;
    });
  }

  /**
   * ติ๊ก/เอาติ๊กค่าภาษาอังกฤษออก -> บวก/ลบค่าภาษาจาก fee ที่อยู่ในช่องตอนนี้
   * บวกลบจากตัวเลขปัจจุบัน ไม่ใช่ตั้งใหม่จากตารางเรท — เคสที่ตกลงราคาพิเศษไว้ต้องไม่ถูกทับ
   */
  function toggleEnglish(on) {
    setForm((prev) => {
      const merged = { ...prev, pkg_english: on };
      if (prev.fee !== '' && englishFee) {
        merged.fee = String(Math.max(Number(prev.fee) + (on ? englishFee : -englishFee), 0));
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

  /* ---------- แก้เคส: เปลี่ยนแพ็คเกจจากของเดิมไหม และจะกระทบอะไรบ้าง ---------- */
  const serviceLocked = isEdit && TERMINAL_STATUSES.includes(original?.status);
  const serviceChanged =
    isEdit && original != null &&
    SERVICE_ID_FIELDS.some((f) => String(original[f] ?? '') !== String(form[f] ?? ''));

  /** ชื่อบริการจากชุดตัวเลือก — ใช้ทั้งของเดิมและของใหม่ในกล่องยืนยัน */
  function serviceText(s) {
    if (s.physio_package_id !== '' && s.physio_package_id != null) {
      const p = physio.find((x) => x.physio_package_id === Number(s.physio_package_id));
      return p ? `${p.name} (${p.sessions} ครั้ง)` : `แพ็คเกจกายภาพ #${s.physio_package_id}`;
    }
    if (s.pkg_format_id !== '' && s.pkg_format_id != null) {
      const f = matrix?.formats.find((x) => x.format_id === Number(s.pkg_format_id));
      const g = matrix?.grades.find((x) => x.grade_id === Number(s.pkg_grade_id));
      return [f?.name ?? `รูปแบบ #${s.pkg_format_id}`, s.pkg_grade_id !== '' && g?.name, s.pkg_staff_tier]
        .filter(Boolean).join(' · ');
    }
    return 'ไม่ระบุบริการ';
  }

  const moneyText = (v) => (v === '' || v == null ? 'ไม่ระบุ' : formatBaht(Number(v)));

  /* ใบที่ระบบจะปรับยอดให้ตามเคส — ต้องตรงกับเงื่อนไขของ syncOpenFromCase ฝั่ง server
     ที่เหลือ (แบ่งงวด/แตกรายครั้ง/รับเงินแล้ว/ชำระแล้ว) จะไม่ถูกแตะ แต่ขึ้นป้าย "แพ็คเกจไม่ตรง" ให้ไปตรวจเอง */
  const syncedInvoices = caseInvoices.filter(
    (v) => (v.status === 'draft' || v.status === 'issued') && !v.has_items && !v.is_plan_part && v.paid_amount === 0,
  );
  const untouchedInvoices = caseInvoices.filter((v) => !syncedInvoices.includes(v));

  /* ผู้รับผิดชอบหลักตำแหน่งไม่ตรงกับบริการใหม่ (เช่น CG ค้างอยู่ในเคสที่เปลี่ยนเป็นกายภาพ)
     ไม่บล็อก — คนระดับสูงกว่าทำงานระดับต่ำกว่าได้จริง แต่ต้องบอกให้รู้ก่อนบันทึก */
  const assignee = form.assigned_to ? staff.find((e) => e.employee_id === form.assigned_to) : null;
  const assigneeMismatch =
    serviceChanged && assignee && wantedPositions && !wantedPositions.includes(assignee.position);

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
   * ล้างค่าจ้างเดิมทันที — ป้องกันค่าของบริการเก่าค้างอยู่ถ้าบริการใหม่ยังไม่ตั้ง staff_pay
   */
  function changeKind(kind) {
    setForm((prev) => ({
      ...prev,
      service_kind: kind,
      staff_pay: '',
      ...(kind !== 'homecare' ? { pkg_format_id: '', pkg_grade_id: '', pkg_staff_tier: '', pkg_english: false } : null),
      ...(kind !== 'physio' ? { physio_package_id: '' } : null),
    }));
  }

  /** เลือกแพ็คเกจกายภาพบำบัด -> คัดลอกราคาพิเศษมาเป็นค่าจ้าง (คัดลอก ไม่ใช่อ้างอิง เหมือนฝั่ง Homecare) */
  function applyPhysio(value) {
    setForm((prev) => {
      const merged = { ...prev, physio_package_id: value, staff_pay: '' };
      const p = physio.find((x) => x.physio_package_id === Number(value));
      if (p && p.special_price != null) merged.fee = String(p.special_price);
      if (p && p.staff_pay != null) merged.staff_pay = String(p.staff_pay);
      return merged;
    });
  }

  /**
   * เลือกผู้รับบริการ -> ผูก patient_id + คัดลอกข้อมูลตัวตน (snapshot) เข้าเคส และดึงผู้ว่าจ้างที่ผูกไว้มาแสดง
   * "คัดลอก" ไม่ใช่ "อ้างอิง" — เคสที่ปิดแล้วคงข้อมูล ณ วันให้บริการไว้แม้แฟ้มผู้รับบริการจะแก้ทีหลัง
   */
  function pickPatient(p) {
    setPickedPatient(p);
    loadRelation(p);
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

  /** เลิกเลือกผู้รับบริการ -> กลับไปโหมดค้นหา/สร้างใหม่ (ข้อมูลที่เติมไว้ไม่ล้าง เผื่อสร้างแฟ้มใหม่จากข้อมูลเดิม) */
  function unpickPatient() {
    setPickedPatient(null);
    relationSaved.current = ''; // ค่าที่พิมพ์ค้างไว้ ใช้กับแฟ้มใหม่ต่อได้
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

  // ค้นหาผู้รับบริการที่ server — โชว์เฉพาะเมื่อยังไม่ได้เลือกและมีการพิมพ์
  useEffect(() => {
    if (form.patient_id || !query.trim()) {
      setMatches([]);
      return;
    }
    /* ธง cancelled: พิมพ์ต่อระหว่างที่คำค้นก่อนหน้ายังไม่กลับมา ผลของคำเก่าที่มาถึงทีหลัง
       จะทับรายการที่ตรงกับสิ่งที่พิมพ์อยู่จริง (debounce กันได้แค่จำนวนครั้งที่ยิง ไม่ได้กันลำดับที่ตอบกลับ) */
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .listPatients({ q: query.trim(), per_page: 8 })
        .then((r) => !cancelled && setMatches(r.data))
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
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

  // ค้นหาผู้ว่าจ้าง (customer) สำหรับผูกกับผู้รับบริการใหม่
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

  /* ---------- ต่อเคส (?renew=CASE-0005) ----------
     คัดลอกทุกอย่างจากรอบก่อนมาเป็นค่าเริ่มต้น: ผู้ว่าจ้าง ผู้รับบริการ บริการ ค่าบริการ อุปกรณ์เสริม ที่อยู่ พิกัด พนักงาน
     แก้ได้ทุกช่องก่อนบันทึก (ลูกค้าต่อแล้วเปลี่ยนแพ็คเกจ/ราคาได้) · ทีมดูแลรอบก่อน server ใส่ให้เองตอนบันทึก */
  const renewFrom = !isEdit ? searchParams.get('renew') : null;
  const [renewSource, setRenewSource] = useState(null);
  useEffect(() => {
    if (!renewFrom) return;
    api
      .getCase(renewFrom)
      .then((c) => {
        const filled = { ...BLANK };
        for (const key of Object.keys(BLANK)) filled[key] = c[key] ?? '';
        if (filled.client_name === PATIENT_PENDING) filled.client_name = '';
        filled.addons = (c.addons ?? []).map((a) => ({
          name: a.name, quantity: String(a.quantity), unit_price: String(a.unit_price),
        }));
        if (!filled.service_kind) {
          if (filled.physio_package_id !== '') filled.service_kind = 'physio';
          else if (filled.pkg_format_id !== '') filled.service_kind = 'homecare';
          // เคสเก่าที่ตั้งประเภทเคสเป็นกายภาพไว้ (ไม่มีแพ็คเกจ) — เกณฑ์เดียวกับ serviceKindOf ในรายการ
          else if (c.case_type === 'physiotherapy') filled.service_kind = 'physio';
        }
        Object.assign(filled, nextRoundDates(c.start_date, c.end_date, todayTH()));
        setForm(filled);
        initial.current = JSON.stringify(filled);
        setRenewSource(c);
        if (c.customer_id) setPayer({ customer_id: c.customer_id, name: c.customer_name });
        // แฟ้มผู้รับบริการเดิม — โชว์เป็นผู้รับบริการที่เลือกอยู่ (ไม่ทับข้อมูลในฟอร์มด้วยข้อมูลแฟ้ม รอบก่อนอาจแก้ไว้แล้ว)
        if (c.patient_id) {
          api.getPatient(c.patient_id).then((p) => { setPickedPatient(p); loadRelation(p); }).catch(() => {});
        }
      })
      .catch((err) => setError(err.message));
  }, [renewFrom]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ต่อเคสแพ็คเกจ Homecare — วันสิ้นสุดรอบใหม่ตามจำนวนวันของรูปแบบบริการ (กติกาเดียวกับตอนกรอกวันเริ่ม)
     ไม่ใช่ความยาวของรอบก่อน ซึ่งอาจถูกแก้สั้น/ยาวเป็นกรณีพิเศษ · ตารางเรทโหลดคนละจังหวะกับเคส
     จึงรอให้มีทั้งคู่แล้วปรับครั้งเดียว (ผู้ใช้แก้ทับได้ตามปกติหลังจากนั้น) */
  const renewDatesApplied = useRef(false);
  useEffect(() => {
    if (!renewSource || !matrix || renewDatesApplied.current) return;
    renewDatesApplied.current = true;
    const fmt = renewSource.pkg_format_id
      ? matrix.formats.find((f) => f.format_id === renewSource.pkg_format_id)
      : null;
    setForm((prev) => {
      const end = endDateFor(prev.start_date, fmt?.category);
      if (!end || end === prev.end_date) return prev;
      const next = { ...prev, end_date: end };
      initial.current = JSON.stringify(next); // ค่าตั้งต้นของฟอร์ม ไม่ใช่ "ยังไม่บันทึก"
      return next;
    });
  }, [renewSource, matrix]);

  // เปิดเคสจากหน้าผู้รับการดูแล (?patient_id=PAT-0001) -> เลือกผู้รับบริการรายนั้นให้เลย
  useEffect(() => {
    if (isEdit) return;
    const pid = searchParams.get('patient_id');
    if (!pid) return;
    api.getPatient(pid).then((p) => pickPatient(p)).catch(() => {});
  }, [isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // เปิดเคสจากหน้าลูกค้า (?customer_id=CUS-0001) -> รู้ผู้ว่าจ้างแล้ว เหลือเลือก/สร้างผู้รับบริการ
  useEffect(() => {
    if (isEdit) return;
    const cid = searchParams.get('customer_id');
    if (!cid || searchParams.get('patient_id')) return; // ถ้ามาจากผู้รับบริการ ผู้ว่าจ้างมาเองแล้ว
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
        if (filled.client_name === PATIENT_PENDING) filled.client_name = '';
        filled.case_code = isCaseCode(c.case_id) ? c.case_id : ''; // รหัสเดิมแบบ CASE-xxxx = ช่องว่าง (กรอก VN เพื่อเปลี่ยน)
        filled.addons = (c.addons ?? []).map((a) => ({
          name: a.name, quantity: String(a.quantity), unit_price: String(a.unit_price),
        }));

        // เคสที่เปิดก่อนมีสองสายไม่มี service_kind — เดาจากสิ่งที่ผูกไว้จริง
        // ไม่เดา ชุด dropdown จะถูกซ่อนแล้วบริการที่เลือกไว้จะหายไปจากสายตา (และโดนล้างทิ้งตอนกดบันทึก)
        if (!filled.service_kind) {
          if (filled.physio_package_id !== '') filled.service_kind = 'physio';
          else if (filled.pkg_format_id !== '') filled.service_kind = 'homecare';
          // เคสเก่าที่ตั้งประเภทเคสเป็นกายภาพไว้ (ไม่มีแพ็คเกจ) — เกณฑ์เดียวกับ serviceKindOf ในรายการ
          else if (c.case_type === 'physiotherapy') filled.service_kind = 'physio';
        }
        setForm(filled);
        initial.current = JSON.stringify(filled);
        setOriginal({ ...filled, status: c.status });

        // มีผู้ว่าจ้างผูกไว้แล้ว — โชว์เป็นลูกค้าที่เลือกอยู่ (ใช้ชื่อจาก SELECT ของเคส ไม่ต้องยิงซ้ำ)
        // ยังไม่มี = ปล่อย payer เป็น null ส่วนผู้ว่าจ้างจะโชว์ช่องค้นหาให้เพิ่มลูกค้าเจ้าของเคส
        if (c.customer_id) setPayer({ customer_id: c.customer_id, name: c.customer_name });
        if (c.patient_id) api.getPatient(c.patient_id).then(loadRelation).catch(() => {});
      })
      .catch((err) => setError(err.message));

    // ไม่ได้ใบ = แค่กล่องยืนยันบอกผลกระทบต่อใบไม่ได้ ไม่ควรกันการแก้เคส
    api
      .listInvoices({ case_id: id, per_page: 100 })
      .then((r) => setCaseInvoices(r.data.filter((v) => v.status !== 'cancelled')))
      .catch(() => setCaseInvoices([]));
  }, [id, isEdit]);

  const isDirty = () => JSON.stringify(form) !== initial.current || relation.trim() !== relationSaved.current;

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
       (ฟอร์มลูกค้า/ผู้รับบริการ/พนักงานเขียน name ใส่ทีละช่องเอง จึงไม่เจอปัญหานี้) */
    name: key,
    value: key.endsWith('phone') ? formatPhoneInput(form[key]) : form[key],
    'data-empty': form[key] === '' ? '' : undefined, // ช่องวันที่ว่าง → ตัวอักษร วว/ดด/ปปปป สีเทา (ดู index.css)
    'aria-invalid': fieldErrors[key] ? true : undefined,
    onChange: (e) => {
      setForm((prev) => ({ ...prev, [key]: key.endsWith('phone') ? formatPhoneInput(e.target.value) : e.target.value }));
      // แก้ช่องที่เพิ่งโดนทักแล้ว ข้อความเตือนควรหายไปทันที ไม่ใช่ค้างจนกว่าจะกดบันทึกอีกรอบ
      setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    },
  });

  // มีผู้ว่าจ้างแล้ว (เลือกจากระบบ หรือเพิ่มใหม่) = เปิดเคสได้โดยยังไม่ต้องรู้ชื่อผู้รับบริการ
  const payerKnown = Boolean(form.customer_id || newPayer);

  /* ---------- อุปกรณ์เสริม: เพิ่ม/แก้/ลบทีละแถว ---------- */
  const setAddon = (i, key, value) => {
    setForm((prev) => ({
      ...prev,
      addons: prev.addons.map((a, j) => (j === i ? { ...a, [key]: value } : a)),
    }));
    const errKey = `addons.${i}.${key}`;
    setFieldErrors((prev) => (prev[errKey] ? { ...prev, [errKey]: undefined } : prev));
  };
  const addAddon = () => setForm((prev) => ({ ...prev, addons: [...prev.addons, { ...BLANK_ADDON }] }));
  /* ลบแถวกลางแล้วเลขแถวของข้อความเตือนเลื่อน — ล้างข้อความเตือนของอุปกรณ์ทิ้งทั้งชุด ไม่ให้ไปค้างผิดแถว */
  const removeAddon = (i) => {
    setForm((prev) => ({ ...prev, addons: prev.addons.filter((_, j) => j !== i) }));
    setFieldErrors((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith('addons.'))));
  };

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

  /** error รายช่องจาก API อื่น (ผู้รับบริการ/ผู้ว่าจ้าง) ใช้ชื่อช่องของตารางนั้น — แปลงเป็นชื่อช่องในฟอร์มนี้ ให้ขึ้นใต้ช่องได้ */
  const remapFields = (map) => (err) => {
    if (err.fields) err.fields = err.fields.map((f) => ({ ...f, field: map[f.field] ?? f.field }));
    throw err;
  };

  /**
   * ยังไม่ได้เลือกผู้รับบริการ = ผู้รับบริการรายใหม่ -> สร้างแฟ้ม (รหัส KN ที่กรอก) จากข้อมูลที่กรอก แล้วผูกกับผู้ว่าจ้าง (ถ้ามี)
   * เก็บ patient_id กลับเข้าฟอร์ม เผื่อบันทึกเคสพลาดแล้วกดใหม่ จะไม่สร้างผู้รับบริการซ้ำ
   */
  async function ensurePatient(payload) {
    if (payload.patient_id) return payload.patient_id;
    // รู้แค่ผู้ว่าจ้าง — ยังไม่มีชื่อให้สร้างแฟ้ม (server เติม "ยังไม่ระบุผู้รับบริการ" ให้เคส)
    if (!payload.client_name) return null;

    const patient = await api.createPatient({
      patient_id: form.patient_code,
      name: payload.client_name,
      gender: payload.patient_gender,
      age: payload.patient_age,
      weight_kg: payload.weight_kg,
      height_cm: payload.height_cm,
      medical_history: payload.medical_history,
      allergies: payload.allergies,
      food_allergies: payload.food_allergies,
      employer_relation: relation.trim() || null,
      address: payload.address,
      customer_id: payload.customer_id, // ผูกผู้ว่าจ้างตั้งแต่แรก (null ได้ถ้ายังไม่รู้ผู้จ่าย)
    }).catch(remapFields({ patient_id: 'patient_code', name: 'client_name' }));

    setForm((prev) => ({ ...prev, patient_id: patient.patient_id }));
    relationSaved.current = relation.trim(); // บันทึกไปพร้อมแฟ้มใหม่แล้ว
    return patient.patient_id;
  }

  /* เปลี่ยนแพ็คเกจของเคสที่มีอยู่แล้ว = ค่าบริการ/ค่าจ้าง/ใบแจ้งหนี้เปลี่ยนตามทั้งชุด
     ต้องให้เห็นก่อนว่าอะไรจะเปลี่ยนเป็นเท่าไร ไม่ใช่รู้ทีหลังจากใบที่ลูกค้าถืออยู่ */
  function handleSubmit(e) {
    e.preventDefault();
    if (serviceChanged) {
      setConfirmingService(true);
      return;
    }
    save();
  }

  /** บันทึกผู้ว่าจ้างรายใหม่เข้าตารางลูกค้า แล้วสลับเป็น "เลือกแล้ว" ทันที
      ถ้าขั้นต่อไปล้ม (เช่น เปิดเคสไม่ผ่าน) กดบันทึกซ้ำจะใช้ลูกค้าเดิม ไม่สร้างซ้ำ */
  /** ความสัมพันธ์ที่แก้ในฟอร์มนี้ → บันทึกกลับแฟ้มผู้รับบริการ (เคสบันทึกไปแล้ว พลาดตรงนี้แค่เตือน ไม่ล้มทั้งหน้า) */
  async function saveRelation(patientId) {
    if (!patientId || relation.trim() === relationSaved.current) return;
    try {
      await api.updatePatient(patientId, { employer_relation: relation.trim() || null });
      relationSaved.current = relation.trim();
    } catch (err) {
      toast(`บันทึกเคสแล้ว แต่บันทึกความสัมพันธ์กับผู้รับบริการไม่สำเร็จ: ${err.message}`);
    }
  }

  async function ensurePayer(payload) {
    if (!newPayer) return payload.customer_id;
    const created = await api.createCustomer({
      name: newPayer.name.trim(),
      phone: newPayer.phone.trim() || null,
      address: payload.address ?? null,
    }).catch(remapFields({ name: 'payer_name', phone: 'payer_phone' }));
    setPayerQuery('');
    setPayerPhone('');
    setPayer(created);
    setForm((prev) => ({ ...prev, customer_id: created.customer_id }));
    return created.customer_id;
  }

  async function save() {
    setConfirmingService(false);

    // กรอกเบอร์ผู้ว่าจ้างไว้แต่ไม่มีชื่อ — บันทึกผู้ว่าจ้างที่ไม่มีชื่อไม่ได้ ทักให้กรอกชื่อ ไม่ใช่ทิ้งเบอร์ไปเงียบๆ
    /* ความสัมพันธ์เก็บที่แฟ้มผู้รับบริการ — กรอกได้ทุกเมื่อ (ช่องอยู่ก่อนส่วนผู้รับบริการ) แต่ถ้าบันทึกโดยยังไม่มีผู้รับบริการเลย
       ค่านี้ไม่มีที่ให้เก็บ จะหายไปเงียบๆ — ทักให้กรอกชื่อผู้รับบริการก่อน หรือเว้นช่องนี้ไว้ */
    if (relation.trim() && !form.patient_id && !form.client_name.trim()) {
      setError('กรอกความสัมพันธ์กับผู้รับบริการไว้ แต่ยังไม่มีชื่อผู้รับบริการ — กรอกชื่อผู้รับบริการก่อน หรือเว้นช่องความสัมพันธ์ไว้');
      setFieldErrors((prev) => ({ ...prev, employer_relation: 'ต้องมีชื่อผู้รับบริการก่อน จึงจะบันทึกความสัมพันธ์ได้' }));
      formEl.current?.querySelector('[name="employer_relation"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    if (!form.customer_id && !payerQuery.trim() && payerPhone.trim()) {
      setError('กรอกเบอร์ผู้ว่าจ้างไว้แล้ว — กรุณากรอกชื่อผู้ว่าจ้างด้วย');
      setFieldErrors((prev) => ({ ...prev, payer_name: 'กรอกชื่อผู้ว่าจ้าง' }));
      formEl.current?.querySelector('[name="payer_name"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // ต้องรู้อย่างน้อยหนึ่งคน: ผู้รับบริการ หรือผู้ว่าจ้าง (เคสที่ไม่มีทั้งคู่ไม่รู้ว่าจะดูแลใคร/เก็บเงินใคร)
    if (!form.client_name.trim() && !form.customer_id && !newPayer?.name.trim()) {
      setError('กรุณากรอกชื่อผู้รับบริการ หรือระบุผู้ว่าจ้างอย่างน้อยหนึ่งอย่าง');
      setFieldErrors((prev) => ({ ...prev, client_name: 'กรอกชื่อผู้รับบริการ หรือเลือก/เพิ่มผู้ว่าจ้างด้านบน' }));
      formEl.current?.querySelector('[name="client_name"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    /* รหัสเคส VN เป็นเลขที่เจ้าหน้าที่กรอก (ระบบออกเองไม่ได้) — เปิดเคส/ต่อเคสต้องกรอกให้ครบ
       หน้าแก้: ว่าง/กรอกไม่ครบ = คงรหัสเดิม */
    if (!isEdit && !isCaseCode(form.case_code)) {
      setError('กรุณากรอกรหัสเคส (VN) ให้ครบ');
      setFieldErrors((prev) => ({ ...prev, case_code: 'กรอกให้ครบ: VN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก' }));
      formEl.current?.querySelector('[name="case_code"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    /* ต้องสร้างแฟ้มผู้รับบริการใหม่ = ต้องมีรหัส KN ครบ (เปิดเคสใหม่ที่ไม่ได้เลือกผู้รับบริการเดิม
       หรือแก้เคสที่เพิ่งใส่ชื่อผู้รับบริการให้ครั้งแรก) — ทักก่อนยิง จะได้ไม่สร้างผู้ว่าจ้างไปครึ่งทาง */
    const needsCode = form.client_name.trim() && !form.patient_id && (!isEdit || !original?.client_name);
    if (needsCode && !isPatientCode(form.patient_code)) {
      setError('กรุณากรอกรหัสผู้รับบริการ (KN) สำหรับแฟ้มผู้รับบริการใหม่');
      setFieldErrors((prev) => ({ ...prev, patient_code: 'กรอกให้ครบ: KN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก' }));
      formEl.current?.querySelector('[name="patient_code"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(form);
      payload.customer_id = await ensurePayer(payload);
      // รหัสแฟ้มใหม่ส่งไปที่ /patients (เปิดเคส) หรือแนบไปกับการแก้เคส (สร้างแฟ้มย้อนหลัง) เท่านั้น
      if (!(isEdit && needsCode)) delete payload.patient_code;
      // รหัสเคส: เปิดเคส = บังคับส่ง · แก้เคส = ส่งเฉพาะตอนกรอกรหัสใหม่ที่ต่างจากเดิม (= เปลี่ยนรหัส)
      delete payload.case_code;
      if (!isEdit) payload.case_id = form.case_code;
      else if (isCaseCode(form.case_code) && form.case_code !== id) payload.case_id = form.case_code;

      // เคสใหม่ต้องผูกแฟ้มผู้รับบริการเสมอ — เลือกไว้แล้วใช้เลย ไม่งั้นสร้างใหม่จากข้อมูลที่กรอก
      if (!isEdit) payload.patient_id = await ensurePatient(payload);

      // ไม่มีช่องชื่อเคสแล้ว — ตั้งชื่ออัตโนมัติจากบริการที่เลือก + ชื่อผู้รับบริการ (ใช้สำหรับค้นหา)
      const gradeName = needGrade ? matrix?.grades.find((g) => g.grade_id === selGradeId)?.name : null;
      const serviceParts = isPhysio
        ? [selectedPhysio?.name]
        : [selectedFormat?.name, gradeName];
      // ยังไม่รู้ชื่อผู้รับบริการ = ใช้ชื่อผู้ว่าจ้างต่อท้ายแทน เคสจะได้ค้นเจอด้วยชื่อคนที่โทรมาจอง
      const who = payload.client_name || payer?.name || newPayer?.name?.trim() || null;
      payload.title = [...serviceParts, who].filter(Boolean).join(' · ') || who;

      // ฟิลด์เหล่านี้ย้ายไปเก็บที่แฟ้มผู้รับบริการแล้ว ไม่เก็บซ้ำในเคส (allergies/relation ไม่ใช่คอลัมน์ของเคสอยู่แล้ว)
      delete payload.allergies;
      delete payload.food_allergies;
      delete payload.weight_kg;
      delete payload.height_cm;

      /* คนที่ไม่เห็นค่าจ้างต้องไม่ "ส่งค่าจ้าง" ด้วย — ต้องถอดคีย์ทิ้ง ไม่ใช่ปล่อยให้เป็น null
         server แยกสองกรณีนี้ออกจากกัน: ไม่มีคีย์ = ไม่แตะของเดิม · ส่ง null = ตั้งใจล้างแล้วดึงจากแพ็คเกจใหม่
         หน้านี้ไม่มีช่องค่าจ้างให้คนกลุ่มนี้ตั้งแต่แรก ค่าที่ส่งไปจึงเป็นค่าว่างเสมอ
         ถ้าปล่อยผ่าน แค่ HR เข้ามาแก้หมายเหตุ ค่าจ้างที่ผู้จัดการตั้งทับไว้เองก็จะถูกดีดกลับเป็นเรทของแพ็คเกจ
         (หรือหายเป็น null เลยถ้าเคสนั้นไม่ได้เลือกแพ็คเกจไว้) — กติกาเดียวกับหน้าแพ็คเกจ/กายภาพ */
      if (!seePay) delete payload.staff_pay;

      payload.addons = addonsPayload(form.addons);

      // ล้างสถานะ "ยังไม่บันทึก" ก่อนเปลี่ยนหน้า ไม่งั้น beforeunload จะเตือนทั้งที่บันทึกสำเร็จแล้ว
      initial.current = JSON.stringify(form);

      if (isEdit) {
        // การจับคู่พนักงานทำผ่านปุ่มใน popup เท่านั้น เพื่อไม่ให้สถานะเคสกับพนักงานขัดแย้งกัน
        const { assigned_to: _unused, ...rest } = payload;
        const updated = await api.updateCase(id, rest);
        await saveRelation(updated.patient_id);
        toast(
          updated.invoice_sync_failed
            ? "บันทึกเคสแล้ว แต่ใบร่างยังไม่อัปเดต กด 'รีเฟรชใบ' ในหน้าใบแจ้งหนี้ค่ะ"
            : updated.case_id !== id
            ? `บันทึกแล้ว · เปลี่ยนรหัสเคสเป็น ${updated.case_id}`
            : 'บันทึกการแก้ไขแล้ว',
        );
        navigate(`/cases?open=${updated.case_id}`); // เปลี่ยนรหัสแล้วเคสเดิมไม่มีอยู่ที่รหัสเก่า
      } else {
        if (renewFrom) payload.renewed_from = renewFrom;
        const created = await api.createCase(payload);
        await saveRelation(created.patient_id);
        toast(
          created.invoice_draft_created === false
            ? `เปิดเคส ${created.case_id} แล้ว แต่ใบร่างยังไม่เกิด กรุณาไปหน้าใบแจ้งหนี้แล้วกด "สร้างใบร่าง" ค่ะ`
            : renewFrom
            ? `ต่อเคสเป็น ${created.case_id} (รอบที่ ${created.round_no}) แล้ว · ระบบออกใบแจ้งหนี้ (ร่าง) ของรอบนี้ให้เรียบร้อย`
            : `เปิดเคส ${created.case_id} แล้ว · ระบบออกใบแจ้งหนี้ (ร่าง) ให้เรียบร้อย`,
        );
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
          <h1>{isEdit ? `แก้ไขเคส ${id}` : renewFrom ? `ต่อเคส ${renewFrom}` : 'เปิดเคสใหม่'}</h1>
          {!isEdit && !renewFrom && <p className="muted">กรอกรหัสเคส (VN) · ระบบออกใบแจ้งหนี้ (ร่าง) ให้หลังบันทึก</p>}
          {renewFrom && (
            <p className="muted">
              รอบที่ {(renewSource?.round_no ?? 1) + 1} — คัดลอกข้อมูลจากรอบก่อนมาให้แล้ว ตรวจ/แก้ได้ทุกช่องก่อนบันทึก
              {' '}· กรอกรหัสเคส (VN) ของรอบนี้ แล้วระบบออกใบแจ้งหนี้ (ร่าง) ให้ ทีมดูแลรอบก่อนตามมาด้วย
            </p>
          )}
        </div>
        {/* ไม่มีปุ่มยกเลิกตรงนี้ — แถบล่างเป็น sticky ติดขอบจอตลอด ปุ่มยกเลิกที่นั่นกดถึงได้เสมอ
            มีสองที่ทำหน้าที่เดียวกันคือให้คนต้องเลือกโดยไม่จำเป็น และบนมือถือมันกินไปทั้งบรรทัด */}
      </header>

      {error && <pre className="error">{error}</pre>}

      {/* โหลดข้อมูลประกอบไม่สำเร็จ — ต้องรู้ก่อนกรอก ไม่ใช่มาเจอตอนช่องว่างเปล่า (ตรวจรอบ 20) */}
      {loadFailed.length > 0 && (
        <div className="notice stale-notice">
          <p>
            <b>โหลดข้อมูลบางส่วนไม่สำเร็จ:</b> {loadFailed.join(' · ')}
            <br />
            ช่องที่เกี่ยวข้องจะว่างหรือเลือกไม่ได้ — <b>ยังไม่ต้องเปิดเคส</b> ให้โหลดหน้านี้ใหม่ก่อน
            ถ้ายังไม่หาย แปลว่าระบบขัดข้องอยู่ ไม่ใช่ว่าไม่มีข้อมูล
          </p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            โหลดหน้านี้ใหม่
          </button>
        </div>
      )}

      <form className="card form" ref={formEl} onSubmit={handleSubmit}>
        {/* ผู้ว่าจ้าง (ผู้จ่ายเงิน) อยู่บนสุด — ต้องเห็นตั้งแต่แรกว่าเคสนี้ผูกกับลูกค้ารายไหน
            เลือกผู้รับบริการที่ผูกลูกค้าไว้แล้ว ผู้ว่าจ้างจะเด้งมาที่นี่เอง
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
            /* กรอกชื่อ/เบอร์ผู้ว่าจ้างได้เลย — ไม่เลือกจากรายการ = บันทึกเป็นผู้ว่าจ้างรายใหม่ตอนกดบันทึกเคส
               รายชื่อที่มีอยู่แล้วโผล่ใต้ช่องชื่อ ให้กดเลือกแทนได้ (กันสร้างคนเดิมซ้ำ) */
            <div className="grid payer-grid">
              <label>
                ชื่อผู้ว่าจ้าง — ไม่บังคับ
                <input
                  name="payer_name"
                  value={payerQuery}
                  aria-invalid={fieldErrors.payer_name ? true : undefined}
                  autoComplete="off"
                  onChange={(e) => {
                    setPayerQuery(e.target.value);
                    setFieldErrors((prev) => (prev.client_name || prev.payer_name ? { ...prev, client_name: undefined, payer_name: undefined } : prev));
                  }}
                />
                {fieldError('payer_name')}
                {payerMatches.length > 0 && (
                  <>
                    <span className="form-hint muted">มีในระบบแล้ว? กดเลือกด้านล่าง — ไม่เลือกจะบันทึกเป็นผู้ว่าจ้างรายใหม่</span>
                    <ul className="customer-results">
                      {payerMatches.map((c) => (
                        <li key={c.customer_id}>
                          <button type="button" onClick={() => pickPayer(c)}>
                            <strong>{c.name}</strong>
                            <span className="muted">
                              <span className="mono">{c.customer_id}</span>
                              {c.phone && ` · ${formatPhone(c.phone)}`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </label>
              <label>
                เบอร์โทรผู้ว่าจ้าง
                <input
                  name="payer_phone"
                  type="tel"
                  inputMode="tel"
                  value={payerPhone}
                  aria-invalid={fieldErrors.payer_phone ? true : undefined}
                  onChange={(e) => {
                    setPayerPhone(formatPhoneInput(e.target.value));
                    setFieldErrors((prev) => (prev.payer_phone ? { ...prev, payer_phone: undefined } : prev));
                  }}
                />
                {fieldError('payer_phone')}
              </label>
            </div>
          )}
          {/* เก็บที่แฟ้มผู้รับบริการ — ยังไม่มีผู้รับบริการ (รู้แค่ผู้ว่าจ้าง) ก็ยังไม่มีที่ให้เก็บ */}
          <div className="grid payer-grid payer-relation">
            <label>
              ความสัมพันธ์กับผู้รับบริการ
              <input
                name="employer_relation"
                value={relation}
                aria-invalid={fieldErrors.employer_relation ? true : undefined}
                onChange={(e) => {
                  setRelation(e.target.value);
                  setFieldErrors((prev) => (prev.employer_relation ? { ...prev, employer_relation: undefined } : prev));
                }}
              />
              {fieldError('employer_relation')}
            </label>
          </div>
        </div>

        <h2>รายละเอียดเคส</h2>
        <div className="grid">
          <label>รหัสเคส (VN) {isEdit ? '' : '*'}
            <YearCodeInput
              prefix="VN"
              name="case_code"
              value={form.case_code}
              invalid={Boolean(fieldErrors.case_code || fieldErrors.case_id)}
              checker={(code) => (code === id ? Promise.resolve(null) : api.checkCaseId(code, isEdit ? id : null))}
              takenLabel="รหัสนี้ถูกใช้กับเคสอื่นแล้ว"
              onChange={(code) => {
                setForm((prev) => ({ ...prev, case_code: code }));
                setFieldErrors((prev) => (prev.case_code || prev.case_id ? { ...prev, case_code: undefined, case_id: undefined } : prev));
              }}
            />
            {isEdit && !isCaseCode(id) && (
              <span className="form-hint muted">รหัสเดิม {id} — กรอกรหัส VN เพื่อเปลี่ยน (กะ ใบแจ้งหนี้ และค่าจ้างที่ผูกอยู่ตามไปเอง)</span>
            )}
            {fieldError('case_code')}
            {fieldError('case_id')}
          </label>
          {/* ไม่มีช่องประเภทเคสแล้ว — server ตั้งให้เองจากประเภทบริการ (ใช้เลือกแบบบันทึกของพนักงาน) */}
          {serviceLocked && (
            <p className="form-hint muted span-2">
              <LineIcon name="alert" className="text-ico" />เคสนี้ปิดหรือยกเลิกไปแล้ว จึงเปลี่ยนแพ็คเกจไม่ได้
              — ต้องเปิดเคสใหม่ก่อน (แก้ข้อมูลอื่นได้ตามปกติ)
            </p>
          )}
          <label>ประเภทบริการ
            <select value={form.service_kind} disabled={serviceLocked} onChange={(e) => changeKind(e.target.value)}>
              <option value="">— ไม่ระบุ —</option>
              {Object.entries(SERVICE_KIND_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>

          {isHomecare && (
          <label>รูปแบบบริการ
            <select value={form.pkg_format_id} disabled={serviceLocked} onChange={(e) => applySelection({ pkg_format_id: e.target.value })}>
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
              <select value={form.physio_package_id} disabled={serviceLocked} onChange={(e) => applyPhysio(e.target.value)}>
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
              <select value={form.pkg_grade_id} disabled={serviceLocked} onChange={(e) => applySelection({ pkg_grade_id: e.target.value })}>
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
              disabled={serviceLocked || !selectedFormat || (needGrade && !selGradeId)}
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
          {/* เต็มแถว — ไม่งั้นช่องถัดไป (วันเริ่ม) ขึ้นมาแทรกคอลัมน์ที่เหลือข้างกล่องติ๊กบนจอสามคอลัมน์ */}
          {isHomecare && englishFee > 0 && (
            <label className="checkbox-row full-row">
              <input
                type="checkbox"
                checked={Boolean(form.pkg_english)}
                disabled={serviceLocked}
                onChange={(e) => toggleEnglish(e.target.checked)}
              />
              ภาษาอังกฤษ (+{formatBaht(englishFee)}{{ monthly: '/เดือน', weekly: '/สัปดาห์' }[selectedFormat.category] ?? '/วัน'})
            </label>
          )}
          {isPhysio && selectedPhysio && (
            <p className="form-hint muted">
              ราคาพิเศษ <strong>{formatBaht(selectedPhysio.special_price)}</strong>
              {selectedPhysio.original_price != null && ` · จากราคาเดิม ${formatBaht(selectedPhysio.original_price)}`}
              {selectedPhysio.avg_per_session != null && ` · ตกเฉลี่ย ${formatBaht(selectedPhysio.avg_per_session)}/ครั้ง`}
              {seePay && selectedPhysio.staff_pay != null && ` · ค่าตอบแทนพนักงาน ${formatBaht(selectedPhysio.staff_pay)}`}
              {seePay && selectedPhysio.margin != null && ` · ส่วนต่าง ${selectedPhysio.margin}%`}
              {' '}— เติมลงช่องด้านล่างให้แล้ว แก้ทับได้
            </p>
          )}
          {serviceChanged && (
            <p className="notice span-2">
              <LineIcon name="alert" className="text-ico" />เปลี่ยนบริการจาก <strong>{serviceText(original)}</strong>
              {' '}เป็น <strong>{serviceText(form)}</strong> — ค่าบริการ{seePay ? ' ค่าจ้างพนักงาน' : ''}และใบแจ้งหนี้จะเปลี่ยนตาม
              {' '}(จะให้ตรวจอีกครั้งก่อนบันทึก)
              {assigneeMismatch && (
                <>
                  <br />ผู้รับผิดชอบปัจจุบัน <strong>{assignee.first_name} {assignee.last_name}</strong>
                  {' '}({POSITION_LABELS[assignee.position]}) ไม่ตรงกับตำแหน่งที่บริการใหม่ต้องการ
                  {' '}({wantedPositions.map((p) => POSITION_LABELS[p]).join('/')}) — เปลี่ยนผู้รับผิดชอบได้ที่หน้าเคสหลังบันทึก
                </>
              )}
            </p>
          )}
          {/* กรอกวันเริ่มแล้ววันสิ้นสุดตั้งให้ตามจำนวนวันของรูปแบบบริการ (รายวัน 1 · รายสัปดาห์ 7 · รายเดือน 30)
              แก้วันสิ้นสุดทับเองได้ · สายกายภาพ/ยังไม่เลือกรูปแบบ = ไม่ตั้งให้ */}
          <label>วันเริ่ม
            <input
              type="date"
              {...field('start_date')}
              onChange={(e) => {
                const start = e.target.value;
                setForm((prev) => {
                  const fmt = prev.service_kind === 'homecare'
                    ? matrix?.formats.find((f) => f.format_id === Number(prev.pkg_format_id))
                    : null;
                  return { ...prev, start_date: start, end_date: endDateFor(start, fmt?.category) ?? prev.end_date };
                });
                setFieldErrors((prev) => (prev.start_date ? { ...prev, start_date: undefined } : prev));
              }}
            />
            {fieldError('start_date')}
          </label>
          <label>วันสิ้นสุด (ถ้ามี)<input type="date" {...field('end_date')} />{fieldError('end_date')}</label>
          <label>ค่าบริการที่ได้รับ (บาท)
            <input type="number" min="0" step="0.01" {...field('fee')} />
            {fieldError('fee')}
          </label>

          {/* ยอดที่พนักงานจะเห็นเป็นรายได้ของตัวเองเมื่อปิดเคส — ดึงจากแพ็คเกจให้ แก้ทับได้
              เห็นเฉพาะผู้จัดการ · คนอื่นเปิดเคสได้ตามปกติแล้ว server เติมค่าจ้างจากเรท/แพ็คเกจให้เอง
              (payFromService ใน cases/repo.js) — ไม่ใช่ปล่อยว่างจนพนักงานเห็น "ยังไม่ระบุค่าจ้าง" */}
          {seePay && (
            <label>ค่าจ้างพนักงาน (บาท)
              <input
                type="number" min="0" step="0.01"
                placeholder={packagePay != null ? String(packagePay) : undefined}
                {...field('staff_pay')}
              />
              {fieldError('staff_pay')}
            </label>
          )}

          {/* เลือกบริการแล้วแต่แพ็คเกจไม่มีค่าตอบแทน = ดึงมาให้ไม่ได้ ต้องบอกว่าไปตั้งที่ไหน
              ไม่งั้นจะเข้าใจว่าระบบพัง แล้วปล่อยว่างจนพนักงานเห็น "ยังไม่ระบุค่าจ้าง" ตอนปิดเคส */}
          {seePay && pickedService && packagePay == null && (
            <p className="form-hint muted">
              <LineIcon name="alert" className="text-ico" />{isPhysio ? 'แพ็คเกจกายภาพบำบัด' : 'เรทที่เลือก'}นี้ยังไม่ได้ตั้งค่าตอบแทนพนักงานในระบบ —
              กรอกเองในช่องด้านบนได้ หรือไปตั้งที่หน้า
              <Link className="link" to={isPhysio ? '/physio-packages' : '/packages'}>
                {isPhysio ? ' แพ็คเกจกายภาพบำบัด' : ' แพ็คเกจ Homecare'}
              </Link>
              {' '}เพื่อให้เคสอื่นที่ใช้แพ็คเกจเดียวกันได้ด้วย
            </p>
          )}
          {seePay && pickedService && packagePay != null && Number(form.staff_pay) !== packagePay && (
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

        {/* อุปกรณ์เสริม — คิดเงินแยกจากค่าบริการ แล้วบวกเข้ายอดใบแจ้งหนี้ (ใบร่าง/ใบที่ยังไม่รับเงินปรับตามให้เอง)
            อยู่นอก .grid ของรายละเอียดเคสโดยตั้งใจ: ในกริดกล่องนี้ถูกบีบเหลือหนึ่งคอลัมน์บนบางจอ
            (เคยเจอบนมือถือ — ชื่อหัวข้อกับปุ่มเพิ่มหักเป็นสองบรรทัด) แยกออกมาจึงกว้างเต็มฟอร์มเสมอ */}
        <section className="addons-field" aria-labelledby="addons-title">
          <h3 id="addons-title">อุปกรณ์เสริม <span className="muted">(คิดเงินเพิ่ม)</span></h3>
          {form.addons.length === 0 && <p className="muted">ยังไม่มีอุปกรณ์เสริม</p>}
          {form.addons.map((a, i) => (
            <div className="addon-row" key={i}>
              <label>ชื่ออุปกรณ์
                <input
                  name={`addons.${i}.name`}
                  value={a.name}
                  placeholder="เช่น เตียงลม, รถเข็น"
                  aria-invalid={fieldErrors[`addons.${i}.name`] ? true : undefined}
                  onChange={(e) => setAddon(i, 'name', e.target.value)}
                />
                {fieldError(`addons.${i}.name`)}
              </label>
              <label>จำนวน
                <input
                  type="number" min="0" step="any"
                  name={`addons.${i}.quantity`}
                  value={a.quantity}
                  aria-invalid={fieldErrors[`addons.${i}.quantity`] ? true : undefined}
                  onChange={(e) => setAddon(i, 'quantity', e.target.value)}
                />
                {fieldError(`addons.${i}.quantity`)}
              </label>
              <label>ราคาต่อหน่วย (บาท)
                <input
                  type="number" min="0" step="0.01"
                  name={`addons.${i}.unit_price`}
                  value={a.unit_price}
                  aria-invalid={fieldErrors[`addons.${i}.unit_price`] ? true : undefined}
                  onChange={(e) => setAddon(i, 'unit_price', e.target.value)}
                />
                {fieldError(`addons.${i}.unit_price`)}
              </label>
              <span className="addon-amount">{formatBaht(addonAmount(a))}</span>
              <button
                type="button"
                className="btn danger-ghost"
                aria-label={`ลบ ${a.name || 'อุปกรณ์แถวนี้'}`}
                onClick={() => removeAddon(i)}
              >
                ลบ
              </button>
            </div>
          ))}
          <div className="addon-foot">
            <button type="button" className="btn addon-add" onClick={addAddon}>+ เพิ่มอุปกรณ์เสริม</button>
            {form.addons.length > 0 && (
              <p className="form-hint muted">
                รวมอุปกรณ์เสริม <strong>{formatBaht(addonsTotal(form.addons))}</strong>
                {' '}· ยอดในใบแจ้งหนี้ = ค่าบริการ + อุปกรณ์เสริม ={' '}
                <strong>{formatBaht(Number(form.fee || 0) + addonsTotal(form.addons))}</strong>
              </p>
            )}
          </div>
        </section>

        <h2>ผู้รับการดูแล</h2>

        {isEdit ? (
          /* แก้ไขเคส: ข้อมูลผู้รับบริการในเคยคือ snapshot ณ วันให้บริการ — แก้ตรงนี้ไม่กระทบแฟ้มผู้รับบริการ */
          <>
            {form.patient_id && (
              <p className="notice snapshot-note">
                ผูกกับแฟ้มผู้รับบริการ <Link className="link" to={`/patients/${form.patient_id}`}>{form.patient_id}</Link>
                {' '}· การแก้ด้านล่างแก้เฉพาะข้อมูลในเคสนี้ (snapshot) ไม่กระทบแฟ้มผู้รับบริการ
              </p>
            )}
            {/* เคสที่เปิดตอนรู้แค่ผู้ว่าจ้าง — server สร้างแฟ้มให้เมื่อได้ชื่อ (cases/repo.js → patientForNamedCase) */}
            {!form.patient_id && original && !original.client_name && (
              <p className="notice snapshot-note">
                เคสนี้ยังไม่มีแฟ้มผู้รับบริการ — กรอกชื่อและรหัสผู้รับบริการ (KN) แล้วกดบันทึก ระบบจะสร้างแฟ้มผู้รับการดูแล
                {' '}ผูกกับผู้ว่าจ้างของเคสนี้ให้อัตโนมัติ
              </p>
            )}
            <div className="grid">
              <label>ชื่อผู้รับบริการ {payerKnown ? '(ว่างได้ — ยังไม่ทราบชื่อ)' : '*'}<input {...field('client_name')} />{fieldError('client_name')}</label>
              {!form.patient_id && !original?.client_name && (
                <label>รหัสผู้รับบริการ (KN) *
                  <PatientCodeInput
                    name="patient_code"
                    checker={(code) => api.checkPatientId(code)}
                    takenLabel="รหัสนี้ถูกใช้กับผู้รับบริการคนอื่นแล้ว"
                    value={form.patient_code}
                    invalid={Boolean(fieldErrors.patient_code)}
                    onChange={(code) => {
                      setForm((prev) => ({ ...prev, patient_code: code }));
                      setFieldErrors((prev) => (prev.patient_code ? { ...prev, patient_code: undefined } : prev));
                    }}
                  />
                  {fieldError('patient_code')}
                </label>
              )}
              <label>เพศ
                <select {...field('patient_gender')}>
                  <option value="">— ไม่ระบุ —</option>
                  {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              {fieldError('patient_gender')}
              </label>
              <label>อายุ (ปี)<input type="number" min="0" max="130" {...field('patient_age')} />{fieldError('patient_age')}</label>
              <label className="span-2">โรคประจำตัว
                <textarea rows={2} {...field('medical_history')} />
                {fieldError('medical_history')}
              </label>
            </div>
          </>
        ) : pickedPatient ? (
          /* เปิดเคสใหม่ + เลือกผู้รับบริการแล้ว: โชว์ข้อมูลแบบอ่านอย่างเดียว (ตัวตนมาจากแฟ้ม ไม่พิมพ์ซ้ำ) */
          <>
            {pickedPatient.allergies && (
              <p className="notice allergy-alert">
                <strong><LineIcon name="alert" className="text-ico" />แพ้ยา:</strong> {pickedPatient.allergies}
              </p>
            )}
            {pickedPatient.food_allergies && (
              <p className="notice allergy-alert">
                <strong><LineIcon name="alert" className="text-ico" />แพ้อาหาร:</strong> {pickedPatient.food_allergies}
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
              <button type="button" className="btn" onClick={unpickPatient}>เปลี่ยนผู้รับบริการ</button>
            </div>
          </>
        ) : (
          /* เปิดเคสใหม่ + ยังไม่เลือก: ค้นหาผู้รับบริการเดิม หรือกรอกเพื่อสร้างแฟ้มใหม่ */
          <>
            <div className="customer-picker">
              <label className="customer-search">
                ค้นหาผู้รับการดูแล (รหัส / ชื่อ / เลขบัตร)
                <input
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
                            {p.employer_relation ? ` · ผู้ว่าจ้างเป็น${p.employer_relation}` : p.relation_to_customer && ` · ${p.relation_to_customer}`}
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
            </div>

            <h3>ข้อมูลผู้รับบริการใหม่</h3>
            <div className="grid">
              <label>ชื่อผู้รับบริการ {payerKnown ? '(ว่างได้ — ยังไม่ทราบชื่อ)' : '*'}<input {...field('client_name')} />{fieldError('client_name')}</label>
              {!form.patient_id && (
                <label>รหัสผู้รับบริการ (KN) {payerKnown ? '(กรอกเมื่อมีชื่อผู้รับบริการ)' : '*'}
                  <PatientCodeInput
                    name="patient_code"
                    checker={(code) => api.checkPatientId(code)}
                    takenLabel="รหัสนี้ถูกใช้กับผู้รับบริการคนอื่นแล้ว"
                    value={form.patient_code}
                    invalid={Boolean(fieldErrors.patient_code)}
                    onChange={(code) => {
                      setForm((prev) => ({ ...prev, patient_code: code }));
                      setFieldErrors((prev) => (prev.patient_code ? { ...prev, patient_code: undefined } : prev));
                    }}
                  />
                  {fieldError('patient_code')}
                </label>
              )}
              <label>เพศ
                <select {...field('patient_gender')}>
                  <option value="">— ไม่ระบุ —</option>
                  {Object.entries(GENDER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              {fieldError('patient_gender')}
              </label>
              <label>อายุ (ปี)<input type="number" min="0" max="130" {...field('patient_age')} />{fieldError('patient_age')}</label>

              <label>น้ำหนัก (กก.)<input type="number" min="0" step="0.1" {...field('weight_kg')} />{fieldError('weight_kg')}</label>
              <label>ส่วนสูง (ซม.)<input type="number" min="0" step="0.1" {...field('height_cm')} />{fieldError('height_cm')}</label>
              <label className="span-2">โรคประจำตัว
                <textarea rows={2} {...field('medical_history')} />
                {fieldError('medical_history')}
              </label>
              <label className="span-2">แพ้ยา
                <textarea rows={2} {...field('allergies')} />
                {fieldError('allergies')}
              </label>
              <label className="span-2">แพ้อาหาร
                <textarea rows={2} {...field('food_allergies')} />
                {fieldError('food_allergies')}
              </label>
            </div>

          </>
        )}

        <h2>การประเมิน / อาการครั้งนี้</h2>
        <div className="grid">
          <label className="span-2">อาการปัจจุบัน
            <textarea rows={2} {...field('current_symptoms')} />
            {fieldError('current_symptoms')}
          </label>
          <label className="span-2">จุดประสงค์ในการดูแล
            <textarea rows={2} {...field('care_goal')} />
            {fieldError('care_goal')}
          </label>
        </div>

        <h2>พิกัดสถานที่ดูแล (สำหรับเช็คอิน)</h2>
        <div className="geo-section">
          {/* ที่อยู่อยู่คู่กับพิกัด — พิมพ์ที่อยู่แล้วกด "ใช้ที่อยู่ด้านบน" ค้นพิกัดต่อได้ทันที */}
          <label className="geo-label">ที่อยู่สถานที่ดูแล
            <textarea rows={2} {...field('address')} />
            {fieldError('address')}
          </label>
          <label className="geo-label">ค้นหาสถานที่ หรือวางลิงก์ Google Maps
            <input
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
              {finding ? 'กำลังค้นหา…' : <><LineIcon name="search" />ค้นหา / อ่านลิงก์</>}
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
                <span className="geo-set-pin"><LineIcon name="pin" className="text-ico" />ตั้งพิกัดแล้ว</span>
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
              <StaffPicker
                name="assigned_to"
                label="พนักงานที่รับเคส"
                staff={shownStaff}
                value={form.assigned_to}
                wantedPositions={wantedPositions}
                placeholder="— ยังไม่จับคู่ (จับคู่ทีหลังได้) —"
                emptyText="ยังไม่มีพนักงานตำแหน่งที่ตรงกับบริการนี้"
                invalid={Boolean(fieldErrors.assigned_to)}
                onChange={(id) => {
                  setForm((prev) => ({ ...prev, assigned_to: id }));
                  setFieldErrors((prev) => (prev.assigned_to ? { ...prev, assigned_to: undefined } : prev));
                }}
              />
            {fieldError('assigned_to')}
            </label>
          )}

          {/* บอกให้รู้ว่ารายชื่อถูกกรองอยู่ ไม่ใช่ปล่อยให้สงสัยว่าทำไมคนที่หาไม่โผล่ */}
          {!isEdit && wantedPositions && (
            <p className="form-hint muted">
              {matchingStaff.length > 0 ? (
                <>
                  แสดงเฉพาะ<strong>{wantedPositions.map((p) => POSITION_LABELS[p]).join('/')}</strong>
                  {' '}ที่ตรงกับบริการที่เลือก ({matchingStaff.length} คน)
                </>
              ) : (
                <>
                  ยังไม่มีพนักงานตำแหน่ง<strong>{wantedPositions.map((p) => POSITION_LABELS[p]).join('/')}</strong>ในระบบ
                  {' '}— เปิดเคสไว้ก่อนแล้วจับคู่ทีหลังได้ หรือเพิ่มพนักงานที่หน้า
                  <Link className="link" to="/employees"> พนักงาน</Link>
                </>
              )}
            </p>
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

      {confirmingService && original && (
        <div className="modal-backdrop modal-stacked" onClick={() => setConfirmingService(false)}>
          <div
            className="modal modal-narrow confirm-box"
            role="alertdialog"
            aria-modal="true"
            aria-label="ยืนยันการเปลี่ยนแพ็คเกจ"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-body confirm-body">
              <h2>เปลี่ยนแพ็คเกจของเคส {id}?</h2>
              <ul className="change-list">
                <li>บริการ: {serviceText(original)} → <strong>{serviceText(form)}</strong></li>
                <li>ค่าบริการ: {moneyText(original.fee)} → <strong>{moneyText(form.fee)}</strong></li>
                {seePay && (
                  <li>ค่าจ้างพนักงาน: {moneyText(original.staff_pay)} → <strong>{moneyText(form.staff_pay)}</strong></li>
                )}
              </ul>
              {syncedInvoices.length > 0 && (
                <p className="muted">
                  ใบแจ้งหนี้ {syncedInvoices.map((v) => v.invoice_id).join(', ')} จะถูกปรับยอดตามค่าบริการใหม่
                  {syncedInvoices.some((v) => v.status === 'issued') &&
                    ' — มีใบที่ออกให้ลูกค้าไปแล้ว ต้องส่งใบใหม่ให้ลูกค้าด้วย'}
                </p>
              )}
              {untouchedInvoices.length > 0 && (
                <p className="muted">
                  ใบ {untouchedInvoices.map((v) => v.invoice_id).join(', ')} (แบ่งงวด/รายครั้ง/รับเงินแล้ว)
                  ระบบจะไม่แก้ยอดให้ แต่จะขึ้นป้าย "แพ็คเกจไม่ตรง" ให้ไปตรวจเอง
                </p>
              )}
              {assigneeMismatch && (
                <p className="muted">
                  ผู้รับผิดชอบ {assignee.first_name} {assignee.last_name} ({POSITION_LABELS[assignee.position]})
                  ไม่ตรงกับตำแหน่งที่บริการใหม่ต้องการ
                </p>
              )}
              <p className="muted">กะที่นัดไว้แล้วไม่เปลี่ยนตาม — ถ้าจำนวนครั้งของแพ็คเกจใหม่ต่างจากเดิม ให้เพิ่ม/ยกเลิกกะเองที่หน้าเคส</p>
            </div>
            <footer className="modal-foot">
              <button type="button" className="btn" autoFocus onClick={() => setConfirmingService(false)}>
                กลับไปแก้
              </button>
              <button type="button" className="btn primary" disabled={saving} onClick={save}>
                ยืนยันเปลี่ยนแพ็คเกจ
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
