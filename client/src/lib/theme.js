const KEY = 'kin-theme';

export const getTheme = () => (localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light');

/** เขียนธีมลง <html> ให้ CSS ที่อิง [data-theme] มีผลทั้งหน้า */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}
