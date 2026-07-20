export const POSITION_LABELS = {
  caregiver: 'CG',
  assistant_nurse: 'NA',
  practical_nurse: 'PN',
  nurse: 'พยาบาล',
  therapist: 'นักกายภาพบำบัด',
};

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

/** สายบริการที่เคสเลือกใช้ — คนละโมเดลราคากัน (ตารางเรท vs แพ็คเกจเหมาครั้ง) */
export const SERVICE_KIND_LABELS = {
  homecare: 'Homecare',
  physio: 'กายภาพบำบัด',
};

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
