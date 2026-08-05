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
    faint: v('--text-faint'),
    border: v('--border'),
    divider: v('--divider'),
    brand: v('--brand'),
    brandSoft: v('--brand-soft'),
    surface: v('--surface'),
    danger: v('--danger'),
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
