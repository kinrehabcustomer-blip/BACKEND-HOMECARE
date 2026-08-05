/**
 * หัวคอลัมน์ที่กดเรียงได้ — ใช้ร่วมกันทุกหน้ารายการ
 *
 * ต่างจาก SortToggle ตรงที่ผูกกับคอลัมน์จริง ๆ ไม่ใช่ปุ่มสลับลำดับของทั้งตาราง
 * (ปุ่มลอยที่หัวตารางอ่านเหมือนเรียงตามคอลัมน์ที่มันไปนั่งอยู่ข้างๆ ซึ่งมักไม่ใช่คอลัมน์นั้น)
 *
 * กดคอลัมน์ที่เรียงอยู่แล้ว = สลับทิศ · กดคอลัมน์อื่น = เริ่มที่ asc (ชื่อ ก-ฮ, วันเก่าไปใหม่ อ่านเป็นธรรมชาติกว่า)
 */

/** สามเหลี่ยมทึบมุมมน — ชุดเดียวกับ SortToggle เพื่อให้ภาษาภาพของการเรียงเหมือนกันทั้งระบบ */
function Triangle({ down }) {
  return (
    <svg viewBox="0 0 24 14" width="10" height="6" aria-hidden="true" className={down ? 'flip' : ''}>
      <path d="M12 3 L21 12 L3 12 Z" fill="currentColor" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
    </svg>
  );
}

export default function SortHead({ column, label, hint, sort, order, onSort }) {
  const active = sort === column;

  return (
    <button
      type="button"
      className={`sort-head ${active ? 'on' : ''}`}
      title={hint}
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(column, active && order === 'asc' ? 'desc' : 'asc')}
    >
      {label}
      {/* จองที่ของลูกศรไว้เสมอ ไม่งั้นหัวตารางขยับตอนสลับคอลัมน์ที่เรียง */}
      <span className="sort-head-ico">{active && <Triangle down={order === 'desc'} />}</span>
    </button>
  );
}
