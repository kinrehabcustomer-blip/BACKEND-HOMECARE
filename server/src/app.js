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
import { integrationRouter } from './integration/routes.js';
import { familyRouter } from './family/routes.js';
import { publicReviewsRouter, reviewsRouter } from './reviews/routes.js';
import { publicBillRouter } from './invoices/publicRoutes.js';
import { ensureReviewColumns } from './reviews/repo.js';
import { errorHandler } from './lib/errors.js';
import { requireAuth, requireAdmin, requireBilling, requireCaseAccess, requirePermission, requirePasswordChanged, ensureRevokedSessions, ensureDefaultPasswordColumn, requirePartnerLead } from './lib/auth.js';
import { adminPartnersRouter, partnerLogoRoute, partnerRouter } from './partners/routes.js';
import { permissionsRouter } from './permissions/routes.js';
import { auditRouter } from './audit/routes.js';
import { financeRouter } from './finance/routes.js';
import { auditTrail, ensureAuditTable } from './lib/audit.js';
import { pushAfterRequest } from './notify/webPush.js';
import { ensurePartnerSchema } from './partners/schema.js';
import { categoriesRouter } from './categories/routes.js';
import { ensureCategories } from './categories/repo.js';
import { ensureFormatDays } from './packages/formatDays.js';

export function createApp() {
  /* ตาราง revoked_sessions ต้องมีก่อนคำขอแรก — requireAuth อ่านมันในคิวรีเดียวกับที่อ่านพนักงาน
     และ Postgres ตรวจชื่อตารางตั้งแต่ตอนแปลคำสั่ง จะสร้างแบบ lazy ตอน logout ครั้งแรกไม่ได้
     ไม่ await ที่นี่ (createApp ไม่ใช่ async) — คำขอแรก ๆ ที่มาก่อนตารางเสร็จจะได้ 500 หนึ่งครั้ง
     แล้วหายเอง · บนของจริง schema.sql สร้างให้ตั้งแต่ migrate อยู่แล้ว */
  ensureRevokedSessions().catch((err) => console.error('[auth] สร้างตาราง revoked_sessions ไม่ได้ —', err.message));
  ensureDefaultPasswordColumn().catch((err) => console.error('[auth] เพิ่มคอลัมน์ uses_default_password ไม่ได้ —', err.message));
  // พาร์ทเนอร์ (partners/schema.js) — requireAuth อ่าน employees.partner_id ทุกคำขอ
  ensurePartnerSchema().catch((err) => console.error('[partners] สร้างตารางพาร์ทเนอร์ไม่ได้ —', err.message));
  // คอลัมน์ของลิงก์ประเมิน — เหตุผลเดียวกัน (ดู reviews/repo.js)
  ensureReviewColumns().catch((err) => console.error('[reviews] เพิ่มคอลัมน์ review_token_issued_at ไม่ได้ —', err.message));
  // ตารางบันทึกการใช้งาน (lib/audit.js) — ของจริงสร้างจาก schema.sql ตอน migrate · ตรงนี้กันกรณียังไม่ได้ migrate
  ensureAuditTable().catch((err) => console.error('[audit] สร้างตาราง audit_logs ไม่ได้ —', err.message));
  // หมวดหมู่ + คอลัมน์ cancel_reason_id (categories/repo.js) — เหตุผลเดียวกัน
  ensureCategories().catch((err) => console.error('[categories] สร้างตาราง categories ไม่ได้ —', err.message));
  ensureFormatDays().catch((err) => console.error('[packages] เพิ่มคอลัมน์จำนวนวันของรูปแบบบริการไม่ได้ —', err.message));

  const app = express();
  // อยู่หลัง proxy ของ Vercel — req.ip = IP ผู้ใช้จริง (ตัวกันยิงถี่ /api/public/bill ไม่นับทุกคนเป็น IP เดียว)
  app.set('trust proxy', 1);

  // credentials: true — เบราว์เซอร์ต้องส่งคุกกี้ session ข้าม origin (dev: 5173 -> 4000)
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true }));
  // ค่าปริยายของ express คือ 100KB — รูปใบรับรองที่ส่งมาแบบ base64 ใหญ่กว่านั้นแน่นอน
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieParser());
  /* บันทึกการใช้งาน (เก็บอย่างน้อย 1 ปี) — วางก่อนทุก router เส้นใหม่ที่เพิ่มทีหลังจึงถูกบันทึกเอง
     ต้องอยู่หลัง express.json/cookieParser (อ่าน body และคุกกี้) · ดู lib/audit.js */
  app.use('/api', auditTrail);
  /* แจ้งเตือนบนมือถือ — คำขอที่สร้างแจ้งเตือนกะ (ลงกะ/เลื่อน/ยกเลิก/ย้ายคน) ส่ง push ก่อนตอบกลับ · ดู notify/webPush.js */
  app.use('/api', pushAfterRequest);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  // /api/auth ไม่ผ่านด่านบังคับเปลี่ยนรหัส — ไม่งั้นคนที่ต้องเปลี่ยนรหัสจะเรียก /auth/change-password ไม่ได้
  app.use('/api/auth', authRouter);

  /* แบบประเมินความพึงพอใจที่ญาติผู้รับบริการกรอก — เป็นหน้าสาธารณะโดยตั้งใจ ไม่มี login
     ญาติไม่ใช่ผู้ใช้ของระบบ จะออกบัญชีให้ทุกบ้านก็ไม่มีใครกรอก · สิ่งที่ใช้แทนคือลิงก์ที่เดาไม่ได้
     (review_token สุ่มจาก CSPRNG) บวกเพดานกันยิงซ้ำในตัว router เอง

     ต้องมาก่อน /api/reviews ที่มีด่าน admin — express จับ prefix ตามลำดับที่ประกาศ
     ถ้าสลับกัน เส้นสาธารณะจะถูกด่าน admin กินไปด้วย แล้วญาติจะเปิดฟอร์มไม่ได้เลย */
  app.use('/api/reviews/form', publicReviewsRouter);
  // ลิงก์ดูใบแจ้งหนี้/ใบเสร็จที่ส่งเข้า LINE ลูกค้า (24 ต.ค. 2569) — ไม่มี login ความปลอดภัยอยู่ที่ token ในลิงก์ (invoices/share.js)
  app.use('/api/public/bill', publicBillRouter);

  /* ทุกเส้นที่ต้อง login ต้องผ่านสามด่านตามลำดับ: มีเซสชัน → ตั้งรหัสของตัวเองแล้ว → มีสิทธิ์พอ
     รวมเป็นชุดเดียวเพื่อไม่ให้ router ใหม่ในอนาคตลืมด่านกลางไป (ซึ่งจะเงียบสนิท ไม่มีอะไรฟ้อง) */
  const signedIn = [requireAuth, requirePasswordChanged];

  // ส่วนจัดการหลังบ้านทั้งหมด — ต้อง login + เป็น admin (ผู้จัดการ/HR) เท่านั้น
  // พนักงานภาคสนาม (field) เข้าไม่ได้ทุกเส้นในกลุ่มนี้ (ยังไม่มีฟีเจอร์ฝั่ง field — จะเพิ่มพร้อมระบบเช็คอิน)
  app.use('/api/employees', signedIn, requireAdmin, employeesRouter);
  // การเงินเข้าได้เฉพาะเส้นที่หน้าค่าตอบแทนต้องใช้ (ดู requireCaseAccess) — ที่เหลือต้องเป็น office
  app.use('/api/cases', signedIn, requireCaseAccess, casesRouter);
  app.use('/api/customers', signedIn, requireAdmin, customersRouter);
  // ญาติที่ดูการดูแลผ่าน LINE ของแต่ละเคส (เชิญ/ปลด) — family/routes.js
  app.use('/api/family', signedIn, requireAdmin, familyRouter);
  app.use('/api/patients', signedIn, requireAdmin, patientsRouter);
  app.use('/api/packages', signedIn, requireAdmin, packagesRouter);
  app.use('/api/physio', signedIn, requireAdmin, physioRouter);
  app.use('/api/invoices', signedIn, requireBilling, invoicesRouter);
  // คะแนนประเมินจากญาติ — ผู้จัดการและ HR เปิดดูได้ (HR เป็นคนดูแลเรื่องประเมินผลงานอยู่แล้ว)
  app.use('/api/reviews', signedIn, requireAdmin, reviewsRouter);
  // ค่าตอบแทนและการปิดรอบทำให้เงินจริงออกจากบริษัท — HR เป็น admin แต่ไม่ใช่ผู้มีสิทธิ์ด้านการเงิน
  // วาง requireManager ก่อน router เพื่อกันก่อนแม้แต่ param loader จะอ่าน/บอกใบ้รหัสรอบที่มีอยู่
  app.use('/api/payroll', signedIn, requirePermission('payroll', 'บัญชีของคุณไม่มีสิทธิ์เข้าหน้าค่าตอบแทนพนักงาน'), payrollRouter);
  // หน้าจัดการสิทธิ์ — Super Admin · ผู้จัดการ (ด่านอยู่ใน router เพราะเป็นรายตำแหน่ง ไม่ใช่รายสิทธิ์)
  app.use('/api/permissions', signedIn, permissionsRouter);
  // บันทึกการใช้งาน — Super Admin เท่านั้น (ด่านอยู่ใน router · audit/routes.js)
  app.use('/api/audit-logs', signedIn, auditRouter);
  // บันทึกการเงิน — ยอดประจำวัน + สมุดรายการเงิน (สิทธิ์ finance_logs ตรวจใน router)
  app.use('/api/finance-log', signedIn, financeRouter);
  // หมวดหมู่ (cat / sub cat) — อ่านได้ทุกคนที่ login · เพิ่ม/แก้ต้องมีสิทธิ์ categories (ด่านอยู่ใน router)
  app.use('/api/categories', signedIn, categoriesRouter);

  // ส่วนของพนักงานภาคสนาม — เห็นเฉพาะเคสของตัวเอง (กรองด้วย employee_id ในเส้น) จึงไม่ต้อง requireAdmin
  app.use('/api/my', signedIn, myRouter);
  /* พาร์ทเนอร์ (partners/ · 21 พ.ย. 2569) — หลังบ้าน KIN จัดการบริษัท/ส่งกะ · หัวหน้าพาร์ทเนอร์เห็นเฉพาะของบริษัทตัวเอง */
  app.get('/api/partner-logos/:id', signedIn, partnerLogoRoute);
  // ด่านรายเส้นอยู่ใน partners/routes.js (งาน = office · ตัวเลขเงิน = see_pay · บันทึกจ่าย = payroll)
  app.use('/api/partners', signedIn, adminPartnersRouter);
  app.use('/api/partner', signedIn, requirePartnerLead, partnerRouter);

  // แจ้งเตือนอัตโนมัติ — ตรวจสิทธิ์เองในเส้น เพราะ Vercel Cron ยิงเข้ามาโดยไม่มีคุกกี้ session
  app.use('/api/notify', notifyRouter);
  // ระบบสมัครงาน chat.kinorigin.com → สร้างพนักงาน (ลงลายเซ็น ไม่ใช้คุกกี้ · ดู integration/routes.js)
  app.use('/api/integration', integrationRouter);

  app.use((req, res) => res.status(404).json({ error: `ไม่พบ endpoint: ${req.method} ${req.path}` }));
  app.use(errorHandler);

  return app;
}
