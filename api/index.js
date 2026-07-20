import '../server/src/lib/env.js';
import { createApp } from '../server/src/app.js';

// Vercel เรียกไฟล์นี้เป็น serverless function — Express app เป็น (req, res) handler อยู่แล้วจึง export ตรงๆ ได้
// vercel.json rewrite ทุก /api/* มาที่นี่ ดังนั้น path เต็ม (เช่น /api/employees) ยังถึง router เดิมครบ
export default createApp();
