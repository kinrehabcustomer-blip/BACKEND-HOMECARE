import CategoryManager from '../components/CategoryManager.jsx';

/**
 * หน้าหัตถการ / อุปกรณ์เสริม — หมวด + ราคา (สิทธิ์ categories · server/src/categories)
 * เมนูย่อยของ "แพ็คเกจ" (ผู้ใช้ขอ 19 พ.ย. 2569 — เดิมเป็นเมนู "หมวดหมู่" แยก มีเมนูซ้ายเลือกสองแท็บ)
 * domain = 'procedure' (/procedures) | 'equipment' (/equipment) · ลิงก์ /categories เดิมพามาที่นี่ (App.jsx)
 * เหตุผลยกเลิก / หมวดเหตุการณ์อยู่หน้าตั้งค่าระบบ (ปุ่มไขควง · Super Admin + ผู้จัดการ — ดู SystemSettingsPage)
 */
export default function CategoriesPage({ domain }) {
  return (
    <>
      <h1 className="sr-only">{domain === 'equipment' ? 'อุปกรณ์เสริม' : 'หัตถการ'}</h1>
      <div className="catalog-page">
        <CategoryManager key={domain} domain={domain} />
      </div>
    </>
  );
}
