export const POSITION_LABELS = {
  caregiver: 'ผู้ดูแล',
  nurse: 'พยาบาลวิชาชีพ',
  assistant_nurse: 'ผู้ช่วยพยาบาล',
  therapist: 'นักกายภาพบำบัด',
  admin: 'ธุรการ',
  driver: 'พนักงานขับรถ',
  manager: 'ผู้จัดการ',
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

export const formatBaht = (value) =>
  value == null ? '—' : `฿${Number(value).toLocaleString('th-TH')}`;

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('th-TH', { dateStyle: 'medium' }) : '—';
