const KEY = 'kin-theme';

// ปริยาย = light — สลับเป็น dark ได้จากหน้าตั้งค่า แล้วจำค่าที่เลือกไว้
// เทียบกับ 'dark' (ไม่ใช่ 'light') เพื่อให้คนที่ยังไม่เคยเลือก และคนที่เคยเลือก light ไว้ ได้ธีมสว่างเหมือนกัน
export const getTheme = () => (localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light');

/** เขียนธีมลง <html> ให้ CSS ที่อิง [data-theme] มีผลทั้งหน้า */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}
