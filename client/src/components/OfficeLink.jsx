import { Link } from 'react-router-dom';
import { useCan } from '../auth.jsx';

/**
 * ลิงก์ไปหน้างานสำนักงาน (เคส / เข้างาน) จากหน้าที่ฝ่ายการเงินเปิดได้ด้วย
 * ฝ่ายการเงินไม่มีสิทธิ์ office — กดลิงก์จริงจะถูกเด้งกลับหน้าแรกเงียบๆ จึงโชว์เป็นข้อความเฉยๆ แทน
 */
export default function OfficeLink({ to, className, onClick, children }) {
  if (useCan('office')) return <Link className={className} to={to} onClick={onClick}>{children}</Link>;
  // คงหน้าตาตัวอักษรไว้ (mono / flag-text) แต่ตัดสไตล์ที่ทำให้ดูเหมือนกดได้ออก
  const plain = className?.split(' ').filter((c) => !['link', 'btn', 'primary'].includes(c)).join(' ');
  return <span className={plain || undefined}>{children}</span>;
}
