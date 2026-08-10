import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter } from './auth/routes.js';
import { employeesRouter } from './employees/routes.js';
import { casesRouter } from './cases/routes.js';
import { customersRouter } from './customers/routes.js';
import { patientsRouter } from './patients/routes.js';
import { packagesRouter } from './packages/routes.js';
import { physioRouter } from './physio/routes.js';
import { invoicesRouter } from './invoices/routes.js';
import { myRouter } from './my/routes.js';
import { notifyRouter } from './notify/routes.js';
import { errorHandler } from './lib/errors.js';
import { requireAuth, requireAdmin } from './lib/auth.js';

export function createApp() {
  const app = express();

  // credentials: true — เบราว์เซอร์ต้องส่งคุกกี้ session ข้าม origin (dev: 5173 -> 4000)
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true }));
  // ค่าปริยายของ express คือ 100KB — รูปใบรับรองที่ส่งมาแบบ base64 ใหญ่กว่านั้นแน่นอน
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);

  // ส่วนจัดการหลังบ้านทั้งหมด — ต้อง login + เป็น admin (ผู้จัดการ/HR) เท่านั้น
  // พนักงานภาคสนาม (field) เข้าไม่ได้ทุกเส้นในกลุ่มนี้ (ยังไม่มีฟีเจอร์ฝั่ง field — จะเพิ่มพร้อมระบบเช็คอิน)
  app.use('/api/employees', requireAuth, requireAdmin, employeesRouter);
  app.use('/api/cases', requireAuth, requireAdmin, casesRouter);
  app.use('/api/customers', requireAuth, requireAdmin, customersRouter);
  app.use('/api/patients', requireAuth, requireAdmin, patientsRouter);
  app.use('/api/packages', requireAuth, requireAdmin, packagesRouter);
  app.use('/api/physio', requireAuth, requireAdmin, physioRouter);
  app.use('/api/invoices', requireAuth, requireAdmin, invoicesRouter);

  // ส่วนของพนักงานภาคสนาม — เห็นเฉพาะเคสของตัวเอง (กรองด้วย employee_id ในเส้น) จึงไม่ต้อง requireAdmin
  app.use('/api/my', requireAuth, myRouter);

  // แจ้งเตือนอัตโนมัติ — ตรวจสิทธิ์เองในเส้น เพราะ Vercel Cron ยิงเข้ามาโดยไม่มีคุกกี้ session
  app.use('/api/notify', notifyRouter);

  app.use((req, res) => res.status(404).json({ error: `ไม่พบ endpoint: ${req.method} ${req.path}` }));
  app.use(errorHandler);

  return app;
}
