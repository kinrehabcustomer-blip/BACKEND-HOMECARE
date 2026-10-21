import LineIcon from './LineIcon.jsx';
import { shiftMonth, thisMonth } from '../lib/attendanceUi.js';

/**
 * เลือกเดือนพร้อมปุ่มถอย/เดินหน้าทีละเดือน — เดือนที่อยากดูมักอยู่ติดกับเดือนปัจจุบัน
 *
 * month = '' ได้ (= "ทุกเดือน") ช่องเดือนจะว่างไว้ ส่วนปุ่มถอย/เดินหน้าคิดจากเดือนปัจจุบัน
 * เป็นจุดตั้งต้น ไม่งั้นได้ NaN · ผู้เรียกที่ส่งเดือนจริงมาเสมอไม่มีอะไรเปลี่ยน
 */
export default function MonthPicker({ month, onChange, children }) {
  const base = month || thisMonth();

  return (
    <div className="att-filter">
      <span className="month-step">
        <button className="btn icon-btn" onClick={() => onChange(shiftMonth(base, -1))} title="เดือนก่อนหน้า" aria-label="เดือนก่อนหน้า"><LineIcon name="chevron-left" /></button>
        {/* ช่องเดือนที่ว่าง (= ทุกเดือน) เบราว์เซอร์วาดเป็น "--------- ----" อ่านแล้วเหมือนพัง — ทับด้วยคำว่า "ทุกเดือน" */}
        <span className={`month-input ${month ? '' : 'is-all'}`}>
          <input type="month" value={month} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="เดือน" />
          {!month && <span className="month-all" aria-hidden="true">ทุกเดือน</span>}
        </span>
        <button
          className="btn icon-btn"
          onClick={() => onChange(shiftMonth(base, 1))}
          disabled={base >= thisMonth()}
          title="เดือนถัดไป"
          aria-label="เดือนถัดไป"
        ><LineIcon name="chevron-right" /></button>
      </span>
      {children}
    </div>
  );
}
