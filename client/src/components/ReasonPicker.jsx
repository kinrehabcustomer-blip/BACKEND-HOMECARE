import SearchSelect from './SearchSelect.jsx';
import { treeOf, useCategories } from '../lib/categories.js';

/**
 * ช่องเลือกเหตุผล (หมวดหลัก → เหตุผล) จากหมวดหมู่ของระบบ — ใช้ตอนยกเลิกเคส / นัด / ใบแจ้งหนี้ (16 พ.ย. 2569)
 * domain = cancel_case | cancel_visit | cancel_invoice · value / onChange เป็นรหัสหมวด (ตัวเลขเป็นข้อความ, '' = ยังไม่เลือก)
 * เลือกได้เฉพาะหมวดย่อย (ตัวเหตุผล) — หมวดหลักเป็นหัวกลุ่ม · เพิ่ม/แก้เหตุผลได้ที่หน้า "หมวดหมู่"
 * บังคับเลือกหรือไม่ให้ผู้เรียกตัดสินด้วย useHasReasons — โหลดไม่ได้/ไม่มีหมวด = อย่าบังคับ ไม่งั้นยกเลิกอะไรไม่ได้เลย
 */
export default function ReasonPicker({ domain, value, onChange, label = 'เหตุผล', required = false, autoFocus = false }) {
  const data = useCategories();
  const groups = treeOf(data?.categories, domain).filter((g) => g.children.length > 0);

  return (
    <label>
      {label}{required ? '' : ' (ไม่บังคับ)'}
      <SearchSelect
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        autoFocus={autoFocus}
        disabled={!data}
      >
        <option value="">{data ? '— เลือกเหตุผล —' : 'กำลังโหลด…'}</option>
        {groups.map((g) => (
          <optgroup key={g.category_id} label={g.name_th}>
            {g.children.map((c) => <option key={c.category_id} value={String(c.category_id)}>{c.name_th}</option>)}
          </optgroup>
        ))}
      </SearchSelect>
    </label>
  );
}

/** มีเหตุผลให้เลือกไหม — ใช้ตัดสินว่าจะบังคับเลือกก่อนกดยืนยันหรือเปล่า */
export function useHasReasons(domain) {
  const data = useCategories();
  return treeOf(data?.categories, domain).some((g) => g.children.length > 0);
}
