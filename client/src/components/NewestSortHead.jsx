/**
 * หัวคอลัมน์รหัสที่เป็นปุ่มสลับ ใหม่สุด ↔ เก่าสุด — "รหัสเคส ⇅ ใหม่สุด" (ผู้ใช้ขอ 16 พ.ย. 2569 ให้ใช้แบบนี้ทุกหน้าที่มีตารางข้อมูล)
 *
 * กดครั้งเดียวเปลี่ยนเลย ไม่ต้องเปิด dropdown · กำลังเรียงตามคอลัมน์อื่นอยู่ = กดแล้วกลับมา "ใหม่สุด"
 * column = คอลัมน์ที่ใช้เรียง "ตามลำดับที่เพิ่มเข้าระบบ" ของหน้านั้น (ส่งให้ server ตรงตัว)
 * legacy = ค่า sort เก่าที่ยังอาจค้างในลิงก์ — นับว่าเรียงด้วยหัวนี้ แต่โชว์เป็นลูกศร ▼/▲ เพราะไม่ใช่ ใหม่/เก่า ตรงตัว
 */
export default function NewestSortHead({ label, column, legacy = [], sort, order, onSort }) {
  const exact = sort === column;
  const active = exact || legacy.includes(sort);
  const current = exact ? (order === 'desc' ? 'ใหม่สุด' : 'เก่าสุด') : active ? (order === 'desc' ? '▼' : '▲') : '';
  const next = exact && order === 'desc' ? 'asc' : 'desc';
  const nextLabel = next === 'desc' ? 'ใหม่สุด' : 'เก่าสุด';
  const now = exact ? current : active ? `ตาม${label}` : 'ตามคอลัมน์อื่น';

  return (
    <button
      type="button"
      className={`th-sort-pick${active ? ' on' : ''}`}
      onClick={() => onSort(column, next)}
      title={`ตอนนี้: ${now} — กดเพื่อเรียง${nextLabel}ก่อน`}
      aria-label={`${label} เรียงลำดับ ตอนนี้ ${now} กดเพื่อเปลี่ยนเป็น${nextLabel}`}
    >
      <span>{label}</span>
      <svg className="th-sort-pick-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 20V4M3.5 7.5 7 4l3.5 3.5M17 4v16m-3.5-3.5L17 20l3.5-3.5" />
      </svg>
      {current && <span className="th-sort-pick-value">{current}</span>}
    </button>
  );
}
