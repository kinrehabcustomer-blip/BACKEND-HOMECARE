import { api } from '../api.js';

/**
 * รูปพนักงานทรงกลม — ใช้ร่วมกันทั้งตารางรายชื่อ popup และหน้ารายละเอียด
 *
 * ยังไม่มีรูปให้แสดงอักษรตัวแรกของชื่อแทน (ไม่ใช่กรอบว่าง) — แถวในตารางจะได้เรียงตรงกันหมด
 * ไม่ว่าใครจะมีรูปหรือไม่ และยังพอแยกคนออกจากกันด้วยสายตาได้
 *
 * `employee` ต้องมี has_photo กับ updated_at ซึ่งมาพร้อมทุก response ของ /api/employees อยู่แล้ว
 */
export default function Avatar({ employee, size = '', clickable = false }) {
  const name = [employee.first_name, employee.last_name].filter(Boolean).join(' ');
  const className = `avatar ${size}`.trim();

  if (!employee.has_photo) {
    return (
      <span className={`${className} is-blank`} title={name} aria-hidden="true">
        {employee.first_name?.[0] ?? '?'}
      </span>
    );
  }

  const url = api.employeePhotoUrl(employee.employee_id, employee.updated_at);
  const img = <img className={className} src={url} alt={`รูปของ ${name}`} />;

  // กดดูรูปเต็มในแท็บใหม่ — เปิดให้กดเฉพาะที่ขอมา ไม่เปิดในตารางรายชื่อ
  // เพราะทั้งแถวเป็นปุ่มเปิด popup อยู่แล้ว ลิงก์ซ้อนในปุ่มจะแย่งคลิกกันเอง
  if (!clickable) return img;

  return (
    <a className="avatar-link" href={url} target="_blank" rel="noreferrer" title="กดเพื่อดูรูปเต็ม">
      {img}
    </a>
  );
}
