import { Router } from 'express';
import * as repo from './repo.js';
import { sendDigestEmail, mailerReady } from '../lib/mailer.js';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';

/**
 * แจ้งเตือนเชิงรุก — ของค้างที่ต้องรีบรู้ ถูกส่งไปหาคน แทนที่จะรอให้คนมาเปิดหน้าเว็บเจอ
 *
 * เรียกได้สองทาง:
 *   1. Vercel Cron (ตั้งไว้ใน vercel.json) — ยืนยันตัวด้วย Authorization: Bearer CRON_SECRET
 *   2. ผู้จัดการกดเองจากหน้าเว็บ — ใช้ session ปกติ (ไว้ทดสอบว่าอีเมลออกจริงไหม)
 */
export const notifyRouter = Router();

/** ตัดข้อความให้พอดีบรรทัดในอีเมล และกัน HTML จากข้อมูลผู้ใช้ไม่ให้หลุดไปเป็นแท็กจริง */
const esc = (s) =>
  String(s ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const who = (v) => `${esc(v.employee_name ?? 'ไม่ระบุคน')} · ${esc(v.client_name)} (${esc(v.case_id)})`;

/** กะหนึ่งอาจผิดปกติหลายอย่างพร้อมกัน — บอกให้ครบ ไม่ใช่เลือกมาอันเดียวแล้วปิดที่เหลือไว้ */
function flagReason(v) {
  return [
    v.location_flagged && 'นอกพื้นที่',
    v.off_schedule && 'นอกวันนัด',
    v.check_in_late_minutes > 0 && `มาสาย ${v.check_in_late_minutes} นาที`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** รวบรวมของค้างทั้งหมด ณ ตอนนี้ — ใช้ทั้งตอนส่งอีเมลและตอนแสดงผลบนหน้าเว็บ */
async function collect() {
  const period = await repo.todayTH();
  const [missed, stale, flagged, unstaffed, overdue] = await Promise.all([
    repo.missedShifts(period),
    repo.staleShifts(),
    repo.flaggedCheckIns(),
    repo.unstaffedToday(period),
    repo.overdueInvoices(period),
  ]);

  const sections = [
    {
      key: 'unstaffed',
      title: 'กะวันนี้ที่ยังไม่มีคนรับ',
      lines: unstaffed.map((v) => `${esc(v.planned_start ?? 'ไม่ระบุเวลา')} · ${esc(v.client_name)} (${esc(v.case_id)})`),
    },
    {
      key: 'stale',
      title: 'ค้างเช็คเอาท์',
      lines: stale.map((v) => `${esc(v.visit_date)} · ${who(v)}`),
    },
    {
      key: 'missed',
      title: 'ขาดงาน (14 วันล่าสุด)',
      lines: missed.map((v) => `${esc(v.visit_date)} · ${who(v)}`),
    },
    {
      key: 'flagged',
      title: 'เช็คอินที่ต้องตรวจ (24 ชม.)',
      lines: flagged.map((v) => `${esc(v.visit_date)} · ${who(v)} — ${flagReason(v)}`),
    },
    {
      key: 'overdue',
      title: 'ใบแจ้งหนี้เลยกำหนด',
      lines: overdue.map(
        (i) => `${esc(i.invoice_id)} · ${esc(i.bill_to_name)} — ครบกำหนด ${esc(i.due_date)} · ${Number(i.total).toLocaleString('th-TH')} บาท`,
      ),
    },
  ].filter((s) => s.lines.length > 0);

  return { date: period.today, sections };
}

/**
 * ส่งสรุปประจำวัน — ไม่มีของค้าง = ไม่ส่ง (เมลที่บอกว่า "ไม่มีอะไร" ทุกวันคือเมลที่คนเลิกเปิด)
 */
const sendDigest = asyncRoute(async (req, res) => {
  const { date, sections } = await collect();
  if (sections.length === 0) {
    return res.json({ sent: false, reason: 'ไม่มีของค้าง', date, sections });
  }

  const recipients = await repo.digestRecipients();
  if (recipients.length === 0) {
    // เกณฑ์ผู้รับคือ "คนที่เข้าหลังบ้านได้" = ผู้จัดการและ HR (ดู digestRecipients) ต้องเขียนให้ตรง
    // ไม่งั้นคนอ่านจะไปตามหาว่าทำไมตั้งอีเมลผู้จัดการแล้วยังไม่ส่ง ทั้งที่ปัญหาอยู่คนละที่
    return res.json({ sent: false, reason: 'ไม่มีผู้จัดการหรือ HR ที่มีอีเมลในระบบ', date, sections });
  }

  const sent = await sendDigestEmail({ to: recipients.map((r) => r.email), date, sections });
  res.json({
    sent,
    reason: sent ? null : 'ยังไม่ได้ตั้งค่า SMTP — พิมพ์ลง log ของ server แทน',
    date,
    recipients: recipients.length,
    sections,
  });
});

/**
 * ทางของ cron เท่านั้น — ยืนยันด้วย Bearer CRON_SECRET ไม่รับคุกกี้ session
 *
 * เส้นนี้ "ส่งอีเมลจริง" ซึ่งไม่ใช่สิ่งที่ GET ควรทำ คุกกี้ของระบบเป็น sameSite=lax
 * จึงยังถูกแนบไปกับการคลิกลิงก์ข้ามเว็บ (top-level navigation) — เว็บไหนก็ได้ที่หลอกให้ผู้จัดการ
 * กดลิงก์มาที่ URL นี้ จะสั่งให้ระบบส่งอีเมลออกไปทั้งชุดในนามของเขา
 * ตัดคุกกี้ออกจากเส้น GET แล้วย้ายปุ่มของคนไปที่ POST ด้านล่าง ช่องนี้จึงปิดสนิท
 */
notifyRouter.get('/daily-digest', cronOnly, sendDigest);

/** ทางของคน — ผู้จัดการ/HR กดจากหน้าเว็บเพื่อทดสอบว่าอีเมลออกจริงไหม หรือส่งซ้ำ */
notifyRouter.post('/daily-digest', requireAuth, requireAdmin, sendDigest);

/** ดูว่าตอนนี้มีอะไรค้างบ้างโดยไม่ส่งอีเมล — ให้หน้าเว็บเรียกดูได้ */
notifyRouter.get(
  '/digest-preview',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => res.json({ ...(await collect()), mailer_ready: mailerReady })),
);

/**
 * cron ของ Vercel แนบ Authorization: Bearer <CRON_SECRET> มาให้เอง เมื่อมี env CRON_SECRET
 * ไม่ได้ตั้ง CRON_SECRET ไว้ = ไม่เปิดทางให้เรียกจากภายนอกเลย
 * (ปล่อยให้เรียกฟรีเมื่อไม่มี secret เท่ากับเปิดช่องให้คนนอกยิงจนอีเมลถูกส่งรัวๆ)
 *
 * ไม่ตกไปใช้ session เป็นทางสำรอง — คนที่อยากส่งเองมี POST ให้ใช้อยู่แล้ว
 * และการรับคุกกี้ที่เส้น GET คือช่องที่ทำให้ลิงก์จากเว็บอื่นสั่งส่งอีเมลได้
 */
function cronOnly(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.get('authorization') === `Bearer ${secret}`) return next();

  next(new ApiError(401, 'เส้นนี้สำหรับงานตั้งเวลาเท่านั้น — กดส่งเองได้จากหน้าเว็บ'));
}
