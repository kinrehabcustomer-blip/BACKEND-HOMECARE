import { useEffect, useState } from 'react';

/**
 * โทเคนสีสำหรับกราฟ
 *
 * ECharts วาดลง canvas ซึ่งอ่าน CSS variable ไม่ได้ — ต้องอ่านค่าจริงออกมาเป็น string
 * แล้วยัดใส่ option เอง ไม่งั้นกราฟจะไม่เปลี่ยนตามธีมที่ผู้ใช้เลือก (ดู lib/theme.js)
 */
const read = () => {
  const style = getComputedStyle(document.documentElement);
  const v = (name) => style.getPropertyValue(name).trim();

  return {
    text: v('--text'),
    muted: v('--muted'),
    heading: v('--heading'),
    faint: v('--text-faint'),
    border: v('--border'),
    divider: v('--divider'),
    brand: v('--brand'),
    brandSoft: v('--brand-soft'),
    surface: v('--surface'),
    danger: v('--danger'),
    // ชุดสีกราฟหน้าภาพรวม — นิยามใน index.css (--viz-*) ตรวจแล้วทั้งสองธีม
    viz: {
      homecare: v('--viz-homecare'),
      physio: v('--viz-physio'),
      // รายได้ตาม BU (RevenueBuPage) — ตรวจชุดสีแล้วทั้งสองธีม
      procedure: v('--viz-procedure'),
      rent: v('--viz-rent'),
      sale: v('--viz-sale'),
      other: v('--viz-other'),
      working: v('--viz-visit-working'),
      done: v('--viz-visit-done'),
      missed: v('--viz-visit-missed'),
      stale: v('--viz-visit-stale'),
      scheduled: v('--viz-visit-scheduled'),
      // ชุดสีกลุ่มทั่วไป 8 ช่อง (index.css --viz-cat-1..8) — ใช้ตามลำดับ ห้ามวนซ้ำ (เกิน 8 = "อื่น ๆ")
      cat: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--viz-cat-${i}`)),
      // รายได้ตาม BU (วงแหวน): ต้นทุน = เทา · อายุหนี้ = ไล่เฉดอุ่น 5 ขั้น · อันดับ = ไล่เฉดน้ำเงิน 4 ขั้น (index.css)
      cost: v('--viz-cost'),
      age: [1, 2, 3, 4, 5].map((i) => v(`--viz-age-${i}`)),
      seq: [1, 2, 3, 4].map((i) => v(`--viz-seq-${i}`)),
    },
    // ฟอนต์ต้องส่งเข้า option ด้วยเหมือนกัน — canvas ไม่สืบทอดจาก CSS
    font: getComputedStyle(document.body).fontFamily,
  };
};

/**
 * โทเคนสีปัจจุบัน อัปเดตเองเมื่อสลับธีม
 * เฝ้า data-theme บน <html> แทนการ subscribe จาก setTheme() — หน้าไหนก็ใช้ได้โดยไม่ต้องเดินสถานะลงมา
 */
export function useChartTokens() {
  const [tokens, setTokens] = useState(read);

  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(read()));
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return tokens;
}
