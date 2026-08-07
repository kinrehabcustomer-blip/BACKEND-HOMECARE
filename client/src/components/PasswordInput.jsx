import { useState } from 'react';
import LineIcon from './LineIcon.jsx';

/**
 * ช่องรหัสผ่านที่มีปุ่มดู/ซ่อนในตัว
 *
 * พิมพ์รหัสบนคีย์บอร์ดมือถือแล้วมองไม่เห็นว่าพิมพ์อะไรไป เป็นสาเหตุอันดับต้นๆ ของอาการ
 * "เข้าไม่ได้" ทั้งที่รหัสถูก — พนักงานภาคสนามเข้าระบบจากมือถือเป็นหลัก
 * และฟอร์มตั้งรหัสใหม่ยิ่งหนักกว่า เพราะต้องพิมพ์ให้ตรงกันสองช่องโดยไม่เห็นสักตัว
 *
 * ทุกช่องคุมสถานะแสดง/ซ่อนของตัวเอง — กดดูช่อง "รหัสผ่านใหม่" ไม่ควรเปิดช่อง "รหัสผ่านปัจจุบัน" ตามไปด้วย
 * props ที่เหลือส่งต่อให้ input ตรงๆ (required / minLength / autoComplete / placeholder …)
 */
export default function PasswordInput({ value, onChange, ...props }) {
  const [shown, setShown] = useState(false);

  return (
    <span className="pw-field">
      <input type={shown ? 'text' : 'password'} value={value} onChange={onChange} {...props} />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
        aria-pressed={shown}
        // ไม่ให้ Tab จากช่องรหัสไปโดนปุ่มนี้ก่อนปุ่มยืนยัน — คนที่กรอกด้วยคีย์บอร์ดอยากกด Enter ต่อเลย
        tabIndex={-1}
      >
        <LineIcon name={shown ? 'eye-off' : 'eye'} />
      </button>
    </span>
  );
}
