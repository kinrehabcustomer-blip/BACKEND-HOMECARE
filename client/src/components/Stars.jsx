const StarShape = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />
  </svg>
);

/**
 * ดาวแบบอ่านอย่างเดียว — เติมได้เป็นเศษส่วน (4.3 ดาว = ดาวใบที่ 5 เติม 30%)
 *
 * ซ้อนสองชั้น: ชั้นล่างเป็นดาวโปร่งครบ 5 ใบ ชั้นบนเป็นดาวทึบชุดเดียวกันที่ถูกครอบความกว้างไว้
 * ทำแบบนี้แทนการปัดเป็นครึ่งดาว เพราะคะแนน 4.4 กับ 4.6 ต่างกันจริงในสายตาคนอ่าน
 * แต่ถ้าปัดเป็นครึ่งดาวจะกลายเป็นดาวเท่ากันทั้งคู่
 */
export default function Stars({ value, size = 'md', showValue = false }) {
  const filled = Math.max(0, Math.min(5, value ?? 0));
  const label = value == null ? 'ยังไม่มีคะแนน' : `${value.toFixed(1)} จาก 5 ดาว`;

  return (
    <span className={`stars stars-${size}`} role="img" aria-label={label}>
      {/* กรอบของ "ดาว 5 ใบ" ต้องแยกจากตัวเลขที่ต่อท้าย — ชั้นที่เติมสีคิดความกว้างเป็น %
          ของกรอบนี้ ถ้าเอาตัวเลขมารวมอยู่ในกรอบเดียวกัน 100% จะกินความกว้างของตัวเลขไปด้วย
          แล้วสัดส่วนดาวที่เติมจะเพี้ยนตามความยาวของตัวเลขที่บังเอิญโชว์อยู่ */}
      <span className="stars-figure" aria-hidden="true">
        <span className="stars-track">
          {[0, 1, 2, 3, 4].map((i) => (
            <StarShape key={i} />
          ))}
        </span>
        <span className="stars-fill" style={{ width: `${(filled / 5) * 100}%` }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <StarShape key={i} />
          ))}
        </span>
      </span>
      {showValue && <span className="stars-value">{value == null ? '—' : value.toFixed(1)}</span>}
    </span>
  );
}

/**
 * ดาวแบบกดให้คะแนน — เป็น radio จริงที่ซ่อนไว้ ไม่ใช่ปุ่มที่ทำท่าเหมือน radio
 *
 * ญาติหลายท่านเป็นผู้สูงอายุและใช้โปรแกรมอ่านหน้าจอ/ขยายจอ — radio ที่มี fieldset+legend
 * ทำให้ได้ยินว่า "ข้อไหน กี่ดาวจากห้า เลือกอยู่หรือยัง" ครบโดยไม่ต้องเขียน ARIA เพิ่มเอง
 * และเลื่อนเลือกด้วยลูกศรได้ตามปกติของ radio group
 */
export function StarPicker({ name, value, onChange, describedBy }) {
  return (
    <span className="star-pick" aria-describedby={describedBy}>
      {[1, 2, 3, 4, 5].map((n) => (
        <label key={n} className={`star-pick-item ${value >= n ? 'is-on' : ''}`}>
          <input
            type="radio"
            name={name}
            value={n}
            checked={value === n}
            onChange={() => onChange(n)}
          />
          <StarShape />
          {/* ชื่อของตัวเลือกสำหรับโปรแกรมอ่านหน้าจอ — บนจอเห็นเป็นดาวอย่างเดียว */}
          <span className="sr-only">{n} ดาว</span>
        </label>
      ))}
    </span>
  );
}
