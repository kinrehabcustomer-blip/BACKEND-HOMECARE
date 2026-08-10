import { Router } from 'express';
import * as repo from './repo.js';
import { sendDigestEmail, mailerReady } from '../lib/mailer.js';
import { asyncRoute } from '../lib/errors.js';
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
      title: 'กะวันนี้ที่ยังไม่มีคนไป',
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
      lines: flagged.map(
        (v) => `${esc(v.visit_date)} · ${who(v)} — ${v.off_schedule ? 'นอกวันนัด' : 'นอกพื้นที่'}`,
      ),
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
 * ส่งสรุปประจำวัน — cron เรียกวันละครั้ง
 * ไม่มีของค้าง = ไม่ส่ง (เมลที่บอกว่า "ไม่มีอะไร" ทุกวันคือเมลที่คนเลิกเปิด)
 */
notifyRouter.get(
  '/daily-digest',
  cronOrAdmin,
  asyncRoute(async (req, res) => {
    const { date, sections } = await collect();
    if (sections.length === 0) {
      return res.json({ sent: false, reason: 'ไม่มีของค้าง', date, sections });
    }

    const recipients = await repo.digestRecipients();
    if (recipients.length === 0) {
      return res.json({ sent: false, reason: 'ไม่มีผู้จัดการที่มีอีเมลในระบบ', date, sections });
    }

    const sent = await sendDigestEmail({ to: recipients.map((r) => r.email), date, sections });
    res.json({
      sent,
      reason: sent ? null : 'ยังไม่ได้ตั้งค่า SMTP — พิมพ์ลง log ของ server แทน',
      date,
      recipients: recipients.length,
      sections,
    });
  }),
);

/** ดูว่าตอนนี้มีอะไรค้างบ้างโดยไม่ส่งอีเมล — ให้หน้าเว็บเรียกดูได้ */
notifyRouter.get(
  '/digest-preview',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => res.json({ ...(await collect()), mailer_ready: mailerReady })),
);

/**
 * cron ของ Vercel แนบ Authorization: Bearer <CRON_SECRET> มาให้เอง เมื่อมี env CRON_SECRET
 * ไม่ได้ตั้ง CRON_SECRET ไว้ = ไม่เปิดทางให้เรียกจากภายนอกเลย ต้อง login เป็นผู้จัดการเท่านั้น
 * (ปล่อยให้เรียกฟรีเมื่อไม่มี secret เท่ากับเปิดช่องให้คนนอกยิงจนอีเมลถูกส่งรัวๆ)
 */
function cronOrAdmin(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.get('authorization') === `Bearer ${secret}`) return next();

  return requireAuth(req, res, (err) => (err ? next(err) : requireAdmin(req, res, next)));
}
