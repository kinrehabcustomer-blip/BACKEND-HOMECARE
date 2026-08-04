const KEY = 'kin-theme';

// ปริยาย = dark (ธีม KIN แนว dashboard) — สลับเป็น light ได้จากหน้าตั้งค่า แล้วจำค่าที่เลือกไว้
export const getTheme = () => (localStorage.getItem(KEY) === 'light' ? 'light' : 'dark');

/** เขียนธีมลง <html> ให้ CSS ที่อิง [data-theme] มีผลทั้งหน้า */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}
