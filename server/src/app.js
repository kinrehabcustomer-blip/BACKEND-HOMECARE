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
import { errorHandler } from './lib/errors.js';
import { requireAuth } from './lib/auth.js';

export function createApp() {
  const app = express();

  // credentials: true — เบราว์เซอร์ต้องส่งคุกกี้ session ข้าม origin (dev: 5173 -> 4000)
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true }));
  // ค่าปริยายของ express คือ 100KB — รูปใบรับรองที่ส่งมาแบบ base64 ใหญ่กว่านั้นแน่นอน
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);

  // ข้อมูลพนักงาน เคส และลูกค้า ต้อง login ก่อนทั้งหมด
  app.use('/api/employees', requireAuth, employeesRouter);
  app.use('/api/cases', requireAuth, casesRouter);
  app.use('/api/customers', requireAuth, customersRouter);
  app.use('/api/patients', requireAuth, patientsRouter);
  app.use('/api/packages', requireAuth, packagesRouter);
  app.use('/api/physio', requireAuth, physioRouter);
  app.use('/api/invoices', requireAuth, invoicesRouter);

  app.use((req, res) => res.status(404).json({ error: `ไม่พบ endpoint: ${req.method} ${req.path}` }));
  app.use(errorHandler);

  return app;
}
