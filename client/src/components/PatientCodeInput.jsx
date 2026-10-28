import YearCodeInput from './YearCodeInput.jsx';

/** ช่องรหัสผู้รับบริการ KN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก (ตัวจริงอยู่ที่ YearCodeInput) — เป็นรหัสเคสของผู้รับบริการคนนี้ด้วย */
export default function PatientCodeInput(props) {
  return <YearCodeInput prefix="KN" {...props} />;
}
