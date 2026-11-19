import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * หมวดหมู่ (cat / sub cat) — server/src/categories · โหลดครั้งเดียวต่อการเปิดแอป แล้วใช้ร่วมทุกหน้า
 * (ช่องเลือกเหตุผลยกเลิก · ช่องค้นหาหัตถการ) · หน้าจัดการหมวดแก้แล้วเรียก invalidateCategories()
 *
 * ได้เฉพาะหมวดที่เปิดใช้ — ช่องเลือกทั่วไปต้องไม่มีตัวเลือกที่ใช้ไม่ได้ (หน้าจัดการหมวดขอแบบรวมที่ปิดเอง)
 */
let cache = null;
// ช่องเลือกที่เปิดค้างอยู่ — แก้หมวดแล้วแจ้งให้โหลดใหม่ (ไม่งั้นเหตุผลที่เพิ่งปิดยังให้เลือกจนรีเฟรช แล้ว server ตีกลับ)
const listeners = new Set();

export function loadCategories() {
  cache ??= api.categories().catch((err) => {
    cache = null; // ล้มแล้วรอบหน้าลองใหม่ ไม่ค้างเป็น error ตลอด
    throw err;
  });
  return cache;
}

export const invalidateCategories = () => {
  cache = null;
  for (const fn of listeners) fn();
};

/** { domains, categories } หรือ null ระหว่างโหลด/โหลดไม่ได้ */
export function useCategories() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => loadCategories().then((d) => alive && setData(d)).catch(() => {});
    load();
    listeners.add(load);
    return () => {
      alive = false;
      listeners.delete(load);
    };
  }, []);
  return data;
}

/** หมวดหลักของโดเมนพร้อมหมวดย่อย [{ ...main, children: [...] }] เรียงตาม sort_order */
export function treeOf(rows, domain) {
  const inDomain = (rows ?? []).filter((c) => c.domain === domain);
  const bySort = (a, b) => a.sort_order - b.sort_order || a.category_id - b.category_id;
  return inDomain
    .filter((c) => c.parent_id == null)
    .sort(bySort)
    .map((main) => ({ ...main, children: inDomain.filter((c) => c.parent_id === main.category_id).sort(bySort) }));
}

/** หมวดของรายการที่กำหนดในระบบ (รหัสหัตถการ PR0003 · เหตุการณ์ fall) → { main, sub } หรือ null */
export function itemCategory(rows, domain, key) {
  const sub = (rows ?? []).find((c) => c.domain === domain && c.parent_id != null && c.item_keys?.includes(key));
  if (!sub) return null;
  const main = rows.find((c) => c.category_id === sub.parent_id);
  return { main, sub };
}

/** ชื่อทุกรายการของหมวดย่อยในโดเมน (อุปกรณ์เสริม) [{ name, group }] — ใช้เป็นคำแนะนำในช่องพิมพ์ชื่อ */
export function categoryItemNames(rows, domain) {
  return treeOf(rows, domain).flatMap((main) =>
    main.children.flatMap((sub) => (sub.item_keys ?? []).map((name) => ({ name, group: `${main.name_th} › ${sub.name_th}` }))),
  );
}

/** ราคาที่ตั้งไว้ในหน้าหมวดหมู่ (catalog_prices) ของรายการหนึ่ง — ไม่มี = null (ใช้ราคาตั้งต้นในโค้ดถ้ามี) */
export function priceRow(data, domain, key) {
  const k = String(key ?? '').trim();
  return (data?.prices ?? []).find((p) => p.domain === domain && p.item_key === k) ?? null;
}

/** ราคาต่อหน่วยของอุปกรณ์เสริมตามรูปแบบ (เช่า/ซื้อขาด) — ชื่อต้องตรงกับที่ตั้งไว้ · ไม่มี = null */
export function equipmentPrice(data, name, kind) {
  const row = priceRow(data, 'equipment', name);
  if (!row) return null;
  return (kind === 'sale' ? row.price_sale : row.price_rent) ?? null;
}
