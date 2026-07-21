/**
 * ปุ่มสลับลำดับของทั้งตาราง — วางไว้ขวาสุดของหัวตาราง ใช้ร่วมกันทุกหน้ารายการ
 *
 * เป็นปุ่มเดียว กดซ้ำเพื่อสลับไปมา: เก่าไปใหม่ (asc) ⇄ ใหม่ไปเก่า (desc)
 * ลูกศรโชว์ทั้งขึ้นและลงเสมอ ตัวที่ตรงกับลำดับปัจจุบันจะขาวเต็ม อีกตัวจาง — รู้ทันทีว่าเรียงทางไหนอยู่
 *
 * เรียงด้วยรหัส (EMP/CUS/PAT/CASE-xxxx) ซึ่งออกเรียงตามลำดับการสร้างเสมอ
 * การเรียงด้วยรหัสจึงเท่ากับเรียงตามเวลาที่เพิ่มเข้าระบบ
 */

/** สามเหลี่ยมทึบมุมมน — วาดเป็นเส้นหนาทับ path เดียวกัน มุมเลยมนตาม stroke-linejoin */
function Triangle({ down = false }) {
  return (
    <svg viewBox="0 0 24 14" width="11" height="7" aria-hidden="true" className={down ? 'flip' : ''}>
      <path
        d="M12 3 L21 12 L3 12 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function SortToggle({ order, onChange }) {
  const next = order === 'asc' ? 'desc' : 'asc';
  const label = next === 'asc' ? 'กดเพื่อเรียงจากเก่าไปใหม่' : 'กดเพื่อเรียงจากใหม่ไปเก่า';

  return (
    <button type="button" className="sort-toggle" title={label} aria-label={label} onClick={() => onChange(next)}>
      <span className={`sort-arrow ${order === 'asc' ? 'on' : ''}`}>
        <Triangle />
      </span>
      <span className={`sort-arrow ${order === 'desc' ? 'on' : ''}`}>
        <Triangle down />
      </span>
    </button>
  );
}
