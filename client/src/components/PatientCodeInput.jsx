import YearCodeInput from './YearCodeInput.jsx';

/** ช่องรหัสผู้ป่วย KN + ปี พ.ศ. 2 หลัก + เลข 7 หลัก (ตัวจริงอยู่ที่ YearCodeInput ใช้ร่วมกับรหัสเคส VN) */
export default function PatientCodeInput(props) {
  return <YearCodeInput prefix="KN" {...props} />;
}
