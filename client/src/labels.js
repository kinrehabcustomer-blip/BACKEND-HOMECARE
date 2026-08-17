export const POSITION_LABELS = {
  caregiver: 'CG',
  assistant_nurse: 'NA',
  practical_nurse: 'PN',
  nurse: 'RN',   // พยาบาลวิชาชีพ — ใช้ตัวย่อ RN ให้ตรงกับระดับพนักงานในตารางราคาแพ็คเกจ
  therapist: 'นักกายภาพบำบัด',
  manager: 'ผู้จัดการ',
  hr: 'HR',
};

/**
 * ระดับพนักงานในตารางราคา -> ตำแหน่งของพนักงานที่ตรงกับระดับนั้น
 * (สายกายภาพบำบัดไม่มีระดับ ใช้ตำแหน่งนักกายภาพบำบัดเป็นเกณฑ์แทน — ดู positionsForCase)
 */
export const TIER_POSITIONS = {
  CG: ['caregiver'],
  NA: ['assistant_nurse'],
  PN: ['practical_nurse'],
  RN: ['nurse'],
};

/**
 * ตำแหน่งที่ "ควรจะ" รับเคสนี้ — คืน null ถ้ายังบอกไม่ได้ (ยังไม่เลือกบริการ) = ไม่ต้องกรองใคร
 * ใช้เป็นตัวกรองรายชื่อตอนจับคู่ ไม่ใช่กฎบังคับ: พยาบาลลงไปทำงานระดับต่ำกว่าได้จริง
 * หน้าเว็บจึงต้องเปิดทางให้ดูทุกตำแหน่งได้เสมอ
 */
export function positionsForCase({ service_kind, physio_package_id, pkg_staff_tier }) {
  if (service_kind === 'physio' || physio_package_id) return ['therapist'];
  return TIER_POSITIONS[pkg_staff_tier] ?? null;
}

export const EMPLOYMENT_TYPE_LABELS = {
  fulltime: 'ประจำ',
  parttime: 'พาร์ทไทม์',
  contract: 'สัญญาจ้าง',
  daily: 'รายวัน',
};

export const STATUS_LABELS = {
  active: 'ทำงานอยู่',
  probation: 'ทดลองงาน',
  on_leave: 'ลาพัก',
  suspended: 'พักงาน',
  resigned: 'ลาออกแล้ว',
};

export const GENDER_LABELS = { male: 'ชาย', female: 'หญิง', other: 'อื่นๆ' };

/** สถานะแฟ้มผู้รับการดูแล */
export const PATIENT_STATUS_LABELS = {
  active: 'กำลังดูแล',
  inactive: 'พักการดูแล',
};

export const TITLE_LABELS = {
  mr: 'นาย',
  mrs: 'นาง',
  miss: 'นางสาว',
  boy: 'เด็กชาย',
  girl: 'เด็กหญิง',
};

export const BLOOD_TYPE_LABELS = { A: 'A', B: 'B', AB: 'AB', O: 'O' };

export const MARITAL_STATUS_LABELS = {
  single: 'โสด',
  married: 'สมรส',
  divorced: 'หย่า',
  widowed: 'หม้าย',
};

export const CASE_TYPE_LABELS = {
  elderly_care: 'ดูแลผู้สูงอายุ',
  bedridden_care: 'ดูแลผู้ป่วยติดเตียง',
  post_op_care: 'ดูแลหลังผ่าตัด',
  physiotherapy: 'กายภาพบำบัด',
  wound_care: 'ทำแผล',
  hospital_watch: 'เฝ้าไข้ที่โรงพยาบาล',
  medical_escort: 'พาไปพบแพทย์',
  other: 'อื่นๆ',
};

export const CASE_STATUS_LABELS = {
  unassigned: 'ยังไม่จับคู่พนักงาน',
  assigned: 'จับคู่แล้ว/รอเริ่ม',
  in_progress: 'กำลังให้บริการ',
  closed: 'ปิดเคส',
  cancelled: 'ยกเลิก',
};

export const INVOICE_STATUS_LABELS = {
  draft: 'ร่าง',
  issued: 'ออกใบแล้ว',
  paid: 'ชำระแล้ว',
  cancelled: 'ยกเลิก',
};

/** สายบริการที่เคสเลือกใช้ — คนละโมเดลราคากัน (ตารางเรท vs แพ็คเกจเหมาครั้ง) */
export const SERVICE_KIND_LABELS = {
  homecare: 'Homecare',
  physio: 'กายภาพบำบัด',
};

/** สถานะกะของพนักงานภาคสนาม (คำนวณตอนอ่านจากฝั่ง server — ดู withVisitState) */
export const VISIT_STATE_LABELS = {
  scheduled: 'รอเช็คอิน',
  working: 'กำลังทำงาน',
  done: 'เสร็จแล้ว',
  stale: 'ค้างเช็คเอาท์',
  missed: 'ขาดงาน',
  cancelled: 'ยกเลิก',
};

/** เวลาแบบ HH:MM (โซนเครื่องผู้ใช้) จาก timestamp เช็คอิน/เอาท์ */
export const timeText = (value) =>
  value ? new Date(value).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '—';

/** สถานะการอนุมัติค่าจ้างของกะ (case_visits.pay_status) */
export const PAY_STATUS_LABELS = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ไม่อนุมัติ',
};

/** ประวัติการทำรายการของเคส (case_events.event) */
export const CASE_EVENT_LABELS = {
  created: 'เปิดเคส',
  edited: 'แก้ข้อมูล',
  assigned: 'จับคู่พนักงาน',
  unassigned: 'ถอดพนักงาน',
  started: 'เริ่มให้บริการ',
  closed: 'ปิดเคส',
  cancelled: 'ยกเลิกเคส',
  reopened: 'เปิดเคสใหม่',
  visit_adjusted: 'แก้กะ',
  pay_approved: 'อนุมัติค่าจ้าง',
  pay_rejected: 'ไม่อนุมัติค่าจ้าง',
};

/**
 * วัน + เวลา จากช่องเวลาที่ฐานข้อมูลเก็บเป็นข้อความ 'YYYY-MM-DD HH:MM:SS' (เวลา UTC)
 *
 * ต้องเติม 'Z' ให้เอง — สตริงที่ไม่มีโซนเวลา เบราว์เซอร์อ่านเป็น "เวลาเครื่อง"
 * ประวัติที่บันทึกตอนบ่ายสองจะกลายเป็นเจ็ดโมงเช้า ซึ่งอ่านแล้วสรุปเหตุการณ์ผิดลำดับได้
 * ค่าที่มีโซนมาแล้ว (TIMESTAMPTZ ที่ผ่าน JSON) ปล่อยผ่านตามเดิม
 */
export const stampText = (value) => {
  if (!value) return '—';
  const iso = typeof value === 'string' && !/[Z+]|\d[+-]\d\d:\d\d$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
};

/** ชั่วโมง:นาที จากจำนวนนาที (เช่น 90 -> '1 ชม. 30 น.') */
export function durationText(minutes) {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && `${h} ชม.`, m && `${m} น.`].filter(Boolean).join(' ') || '0 น.';
}

/**
 * ระยะทางเป็นข้อความที่อ่านแล้วรู้ทันทีว่าไกลแค่ไหน
 *
 * เกินหนึ่งกิโลเมตรให้เป็น กม. — "6288 ม." ต้องหารในหัวก่อนถึงจะรู้ว่าคือ 6 กว่ากิโล
 * ซึ่งเป็นตัวเลขที่ผู้จัดการต้องตัดสินใจจากมันทันทีว่าเช็คอินนี้ผิดปกติจริงไหม
 * ต่ำกว่านั้นคงหน่วยเมตรไว้ เพราะหลักสิบเมตรคือช่วงที่ตัดสินว่า "อยู่หน้าบ้าน" หรือ "อยู่ปากซอย"
 */
export function distanceText(meters) {
  if (meters == null) return '—';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} กม.` : `${Math.round(meters)} ม.`;
}

/**
 * อายุ (ปี) จากวันเกิด — คืน null ถ้าไม่มีวันเกิดหรือวันที่ใช้ไม่ได้
 * ใช้คำนวณสดเสมอแทนการอ่านเลขอายุที่เก็บไว้ เพราะเลขที่กรอกเมื่อปีก่อนจะผิดไปเรื่อยๆ
 */
export function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;

  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  // ยังไม่ถึงวันเกิดปีนี้ = ยังไม่ครบอีกปี
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;

  return age >= 0 && age <= 130 ? age : null;
}

/** จำนวนเต็มไม่ต้องมีทศนิยม (฿20,000) แต่ถ้ามีเศษสตางค์ต้องครบสองหลัก (฿18,500.50) */
export const formatBaht = (value) => {
  if (value == null) return '—';

  const n = Number(value);
  return `฿${n.toLocaleString('th-TH', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

/** ส่วนลดเป็นเปอร์เซ็นต์ — ตัดทศนิยมที่ไม่จำเป็นทิ้ง (10% ไม่ใช่ 10.00%, แต่ 12.5% คงไว้) */
export const formatPercent = (value) => {
  if (value == null) return '—';
  const n = Number(value);
  return `${n.toLocaleString('th-TH', { maximumFractionDigits: 2 })}%`;
};

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('th-TH', { dateStyle: 'medium' }) : '—';

/**
 * "วันนี้" ตามเวลาไทย รูปแบบ 'YYYY-MM-DD' — ใช้ทุกครั้งที่ส่งวันที่ขึ้นไปบันทึกที่ server
 *
 * `new Date().toISOString()` เป็น UTC ซึ่งช้ากว่าเวลาไทย 7 ชั่วโมง ทุกอย่างที่ทำระหว่าง
 * เที่ยงคืนถึงตีเจ็ดจึงถูกลงวันที่เป็น "เมื่อวาน" (ปิดเคสตีสองของวันที่ 1 ได้วันสิ้นสุดเป็นวันที่ 31
 * ของเดือนก่อน) ฝั่ง server แก้เรื่องนี้ไปแล้วด้วย TODAY() ที่บวกออฟเซ็ตไทย — ฝั่งนี้ต้องใช้เกณฑ์เดียวกัน
 * ไม่งั้นวันที่ที่หน้าเว็บส่งไปกับวันที่ที่ server เติมให้เองจะเป็นคนละวันในช่วงเวลานั้น
 */
export const todayTH = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);

/** ตัวเลขเงินบนเอกสาร — ทศนิยม 2 ตำแหน่งเสมอ ไม่มีสัญลักษณ์บาท (เช่น 12,000.00) */
export const amountText = (value) =>
  Number(value ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** วันที่แบบราชการบนเอกสาร: 22-07-2569 (วัน-เดือน-พ.ศ.) */
export function docDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear() + 543}`;
}

const THAI_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const THAI_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/**
 * อ่านจำนวนเต็มเป็นภาษาไทย ตามหลักการอ่านเลขไทย
 *  - หลักสิบ: 1 อ่าน "สิบ" (ไม่ใช่ "หนึ่งสิบ") · 2 อ่าน "ยี่สิบ"
 *  - หลักหน่วยที่มีหลักอื่นนำหน้า: 1 อ่าน "เอ็ด" (ยี่สิบเอ็ด, หนึ่งร้อยเอ็ด)
 *  - เกินล้าน: ตัดเป็นก้อนล้านแล้ววนอ่านซ้ำ (หนึ่งล้านสองแสน…)
 */
function readThaiInteger(n) {
  if (n === 0) return 'ศูนย์';
  if (n >= 1_000_000) {
    const high = readThaiInteger(Math.floor(n / 1_000_000));
    const low = n % 1_000_000;
    return `${high}ล้าน${low ? readThaiInteger(low) : ''}`;
  }

  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const digit = Number(s[i]);
    const place = s.length - i - 1; // 0 = หลักหน่วย
    if (digit === 0) continue;

    if (place === 0) out += digit === 1 && s.length > 1 ? 'เอ็ด' : THAI_DIGITS[digit];
    else if (place === 1) out += digit === 1 ? 'สิบ' : `${digit === 2 ? 'ยี่' : THAI_DIGITS[digit]}สิบ`;
    else out += THAI_DIGITS[digit] + THAI_PLACES[place];
  }
  return out;
}

/** จำนวนเงินเป็นตัวหนังสือไทยสำหรับกำกับบนใบเสร็จ เช่น 12000 -> "หนึ่งหมื่นสองพันบาทถ้วน" */
export function bahtText(value) {
  const rounded = Math.round(Number(value ?? 0) * 100) / 100;
  const baht = Math.floor(rounded);
  const satang = Math.round((rounded - baht) * 100);

  if (satang === 0) return `${readThaiInteger(baht)}บาทถ้วน`;
  return `${readThaiInteger(baht)}บาท${readThaiInteger(satang)}สตางค์`;
}

/** '01' -> 'มกราคม' */
export const MONTH_LABELS = {
  '01': 'มกราคม', '02': 'กุมภาพันธ์', '03': 'มีนาคม', '04': 'เมษายน',
  '05': 'พฤษภาคม', '06': 'มิถุนายน', '07': 'กรกฎาคม', '08': 'สิงหาคม',
  '09': 'กันยายน', '10': 'ตุลาคม', '11': 'พฤศจิกายน', '12': 'ธันวาคม',
};

/** '2026' -> '2569' (ปีในระบบเก็บเป็น ค.ศ. แต่คนไทยอ่าน พ.ศ.) */
export const toBuddhistYear = (year) => String(Number(year) + 543);

/** ข้อความบอกช่วงเวลาที่กำลังดูอยู่ */
export function formatPeriod(year, month) {
  if (!year) return 'ทุกช่วงเวลา';
  if (!month) return `ปี ${toBuddhistYear(year)}`;
  return `${MONTH_LABELS[month]} ${toBuddhistYear(year)}`;
}
