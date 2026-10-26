import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // เรียก /api จากหน้าเว็บได้ตรงๆ โดยไม่ต้องใส่ host — vite ส่งต่อไปที่ Express ให้
    proxy: {
      /* ใช้ 127.0.0.1 ไม่ใช่ localhost (ตรวจรอบ 20) — บนเครื่องที่มี Node อีกตัวฟัง [::]:4000 อยู่
         ชื่อ localhost จะถูกเลือกไปที่ตัว IPv6 ก่อน คนที่คิดว่ากำลังทดสอบกับ API ของตัวเอง
         อาจยิงคำสั่งสร้าง/แก้/ลบไปโดนอีก backend โดยไม่รู้ตัว (เจอจริงตอนตรวจหน้าเว็บ 26 ต.ค. 2569) */
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
});
