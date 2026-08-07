/**
 * แถบแจ้ง error พร้อมปุ่มลองใหม่ — วางเหนือเนื้อหา ไม่ใช่แทนที่ทั้งหน้า
 *
 * หลายหน้าเคยเขียนว่า `if (error) return <p className="error">{error}</p>` ซึ่งแปลว่า
 * เน็ตสะดุดครั้งเดียวทั้งหน้าหายไปเหลือข้อความแดงบรรทัดเดียว ตัวกรอง/ปุ่ม/ข้อมูลที่โหลดมาได้แล้ว
 * หายตามไปหมด และไม่มีทางกลับมานอกจากรีเฟรชเบราว์เซอร์เอง
 * หน้ารายการ (เคส/ใบแจ้งหนี้/พนักงาน) ทำถูกมาตั้งแต่แรกคือเก็บ UI ไว้แล้วขึ้นแถบเหนือตาราง
 * ตัวนี้คือท่านั้นที่ยกมาใช้ร่วมกันได้ทุกหน้า บวกปุ่มลองใหม่ซึ่งเดิมไม่มีเลยสักที่ในระบบ
 *
 * onRetry เว้นได้ — บางที่ error มาจากการกระทำที่กดซ้ำเองได้อยู่แล้ว ไม่ต้องมีปุ่มซ้อน
 */
export default function ErrorBar({ message, onRetry, busy = false }) {
  if (!message) return null;

  return (
    <div className="error error-bar">
      {/* ข้อความ error จาก zod มีหลายบรรทัด — ต้องคง white-space ของ .error ไว้ จึงห่อด้วย span ไม่ใช่ p */}
      <span className="error-bar-text">{message}</span>
      {onRetry && (
        <button type="button" className="btn tiny" disabled={busy} onClick={onRetry}>
          {busy ? 'กำลังลอง…' : 'ลองใหม่'}
        </button>
      )}
    </div>
  );
}
