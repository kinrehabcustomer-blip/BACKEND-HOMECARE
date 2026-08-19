import LineIcon from './LineIcon.jsx';
import { shiftMonth, thisMonth } from '../lib/attendanceUi.js';

/** เลือกเดือนพร้อมปุ่มถอย/เดินหน้าทีละเดือน — เดือนที่อยากดูมักอยู่ติดกับเดือนปัจจุบัน */
export default function MonthPicker({ month, onChange, children }) {
  return (
    <div className="att-filter">
      <span className="month-step">
        <button className="btn icon-btn" onClick={() => onChange(shiftMonth(month, -1))} title="เดือนก่อนหน้า" aria-label="เดือนก่อนหน้า"><LineIcon name="chevron-left" /></button>
        <input type="month" value={month} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="เดือน" />
        <button
          className="btn icon-btn"
          onClick={() => onChange(shiftMonth(month, 1))}
          disabled={month >= thisMonth()}
          title="เดือนถัดไป"
          aria-label="เดือนถัดไป"
        ><LineIcon name="chevron-right" /></button>
      </span>
      {children}
    </div>
  );
}
