import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // เรียก /api จากหน้าเว็บได้ตรงๆ โดยไม่ต้องใส่ host — vite ส่งต่อไปที่ Express ให้
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
