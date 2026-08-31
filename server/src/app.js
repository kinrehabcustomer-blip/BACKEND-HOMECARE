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
import { payrollRouter } from './payroll/routes.js';
import { myRouter } from './my/routes.js';
import { notifyRouter } from './notify/routes.js';
import { publicReviewsRouter, reviewsRouter } from './reviews/routes.js';
import { errorHandler } from './lib/errors.js';
import { requireAuth, requireAdmin, requireManager, requirePasswordChanged } from './lib/auth.js';

export function createApp() {
  const app = express();

  // credentials: true — เบราว์เซอร์ต้องส่งคุกกี้ session ข้าม origin (dev: 5173 -> 4000)
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true }));
  // ค่าปริยายของ express คือ 100KB — รูปใบรับรองที่ส่งมาแบบ base64 ใหญ่กว่านั้นแน่นอน
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  // /api/auth ไม่ผ่านด่านบังคับเปลี่ยนรหัส — ไม่งั้นคนที่ต้องเปลี่ยนรหัสจะเรียก /auth/change-password ไม่ได้
  app.use('/api/auth', authRouter);

  /* แบบประเมินความพึงพอใจที่ญาติผู้รับบริการกรอก — เป็นหน้าสาธารณะโดยตั้งใจ ไม่มี login
     ญาติไม่ใช่ผู้ใช้ของระบบ จะออกบัญชีให้ทุกบ้านก็ไม่มีใครกรอก · สิ่งที่ใช้แทนคือลิงก์ที่เดาไม่ได้
     (review_token สุ่มจาก CSPRNG) บวกเพดานกันยิงซ้ำในตัว router เอง

     ต้องมาก่อน /api/reviews ที่มีด่าน admin — express จับ prefix ตามลำดับที่ประกาศ
     ถ้าสลับกัน เส้นสาธารณะจะถูกด่าน admin กินไปด้วย แล้วญาติจะเปิดฟอร์มไม่ได้เลย */
  app.use('/api/reviews/form', publicReviewsRouter);

  /* ทุกเส้นที่ต้อง login ต้องผ่านสามด่านตามลำดับ: มีเซสชัน → ตั้งรหัสของตัวเองแล้ว → มีสิทธิ์พอ
     รวมเป็นชุดเดียวเพื่อไม่ให้ router ใหม่ในอนาคตลืมด่านกลางไป (ซึ่งจะเงียบสนิท ไม่มีอะไรฟ้อง) */
  const signedIn = [requireAuth, requirePasswordChanged];

  // ส่วนจัดการหลังบ้านทั้งหมด — ต้อง login + เป็น admin (ผู้จัดการ/HR) เท่านั้น
  // พนักงานภาคสนาม (field) เข้าไม่ได้ทุกเส้นในกลุ่มนี้ (ยังไม่มีฟีเจอร์ฝั่ง field — จะเพิ่มพร้อมระบบเช็คอิน)
  app.use('/api/employees', signedIn, requireAdmin, employeesRouter);
  app.use('/api/cases', signedIn, requireAdmin, casesRouter);
  app.use('/api/customers', signedIn, requireAdmin, customersRouter);
  app.use('/api/patients', signedIn, requireAdmin, patientsRouter);
  app.use('/api/packages', signedIn, requireAdmin, packagesRouter);
  app.use('/api/physio', signedIn, requireAdmin, physioRouter);
  app.use('/api/invoices', signedIn, requireAdmin, invoicesRouter);
  // คะแนนประเมินจากญาติ — ผู้จัดการและ HR เปิดดูได้ (HR เป็นคนดูแลเรื่องประเมินผลงานอยู่แล้ว)
  app.use('/api/reviews', signedIn, requireAdmin, reviewsRouter);
  // ค่าตอบแทนและการปิดรอบทำให้เงินจริงออกจากบริษัท — HR เป็น admin แต่ไม่ใช่ผู้มีสิทธิ์ด้านการเงิน
  // วาง requireManager ก่อน router เพื่อกันก่อนแม้แต่ param loader จะอ่าน/บอกใบ้รหัสรอบที่มีอยู่
  app.use('/api/payroll', signedIn, requireManager, payrollRouter);

  // ส่วนของพนักงานภาคสนาม — เห็นเฉพาะเคสของตัวเอง (กรองด้วย employee_id ในเส้น) จึงไม่ต้อง requireAdmin
  app.use('/api/my', signedIn, myRouter);

  // แจ้งเตือนอัตโนมัติ — ตรวจสิทธิ์เองในเส้น เพราะ Vercel Cron ยิงเข้ามาโดยไม่มีคุกกี้ session
  app.use('/api/notify', notifyRouter);

  app.use((req, res) => res.status(404).json({ error: `ไม่พบ endpoint: ${req.method} ${req.path}` }));
  app.use(errorHandler);

  return app;
}
