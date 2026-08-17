import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
const configured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

const transporter = configured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT ?? 587),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

if (!configured) {
  console.warn(
    '⚠  ยังไม่ได้ตั้งค่า SMTP ใน .env — OTP จะถูกพิมพ์ลง console แทนการส่งอีเมล (ใช้ได้เฉพาะตอน dev)',
  );
}

/** true = ส่งอีเมลได้จริง (ตั้งค่า SMTP ครบ) — ให้ผู้เรียกบอกผู้ใช้ได้ว่าทำไมไม่มีเมลเข้า */
export const mailerReady = configured;

/**
 * กัน HTML จากข้อมูลผู้ใช้ไม่ให้หลุดไปเป็นแท็กจริงในอีเมล
 *
 * ฝั่งสรุปประจำวันประกอบข้อความมาแบบ escape แล้ว (ดู esc ใน notify/routes.js) แต่เมล OTP
 * แปะชื่อพนักงานลง HTML ตรงๆ ชื่อมาจากช่องที่ admin กรอกเอง จึงใส่แท็กลงไปได้
 * ไม่ใช่ช่องโจมตีที่น่ากลัวนัก แต่ไม่มีเหตุผลให้สองเมลในไฟล์เดียวกันปลอดภัยไม่เท่ากัน
 */
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SHELL = (title, body) => `
  <div style="font-family:'Segoe UI',sans-serif;max-width:640px;color:#1c2024">
    <p style="font-size:20px;font-weight:800;letter-spacing:2px;color:#0f7b6c;margin:0">KIN</p>
    <p style="font-size:12px;color:#6b7280;margin:2px 0 20px">Homecare · ระบบหลังบ้าน</p>
    <h2 style="font-size:17px;margin:0 0 16px">${title}</h2>
    ${body}
    <p style="color:#6b7280;font-size:12px;border-top:1px solid #e3e6ea;padding-top:14px;margin-top:24px">
      อีเมลอัตโนมัติจากระบบ — จัดการรายการเหล่านี้ได้ที่หน้า "การมาทำงาน" และ "ใบแจ้งหนี้"
    </p>
  </div>`;

/**
 * สรุปของค้างประจำวันถึงผู้จัดการ
 *
 * sections = [{ title, lines: string[] }] — ส่วนที่ไม่มีรายการถูกตัดทิ้งตั้งแต่ผู้เรียก
 * ไม่ส่งอีเมลตอนไม่มีอะไรค้าง เพราะเมลที่เขียนว่า "ไม่มีอะไร" ทุกวันคือเมลที่คนเลิกอ่าน
 */
export async function sendDigestEmail({ to, date, sections }) {
  const body = sections
    .map(
      (s) => `
        <p style="font-weight:700;margin:18px 0 6px">${s.title} (${s.lines.length})</p>
        <ul style="margin:0;padding-left:18px;line-height:1.7;font-size:14px">
          ${s.lines.map((l) => `<li>${l}</li>`).join('')}
        </ul>`,
    )
    .join('');

  const subject = `[KIN] สรุปของค้าง ${date} — ${sections.map((s) => `${s.title} ${s.lines.length}`).join(' · ')}`;

  if (!transporter) {
    console.log(`\n📧 [DEV] ${subject}\nถึง: ${to.join(', ')}\n`);
    return false;
  }

  await transporter.sendMail({
    from: SMTP_FROM ?? `KIN Homecare <${SMTP_USER}>`,
    to: to.join(', '),
    subject,
    html: SHELL(`สรุปของค้าง ประจำวันที่ ${date}`, body),
  });
  return true;
}

export async function sendOtpEmail({ to, name, code, minutes }) {
  const subject = `รหัสยืนยันสำหรับตั้งรหัสผ่านใหม่: ${code}`;
  const html = `
    <div style="font-family:'Segoe UI',sans-serif;max-width:480px;color:#1c2024">
      <p style="font-size:20px;font-weight:800;letter-spacing:2px;color:#0f7b6c;margin:0">KIN</p>
      <p style="font-size:12px;color:#6b7280;margin:2px 0 24px">Homecare · ระบบหลังบ้าน</p>
      <p>สวัสดีคุณ ${escapeHtml(name)}</p>
      <p>มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ กรุณาใช้รหัสยืนยันนี้:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:8px;background:#e6f3f1;color:#0f7b6c;
                padding:16px;text-align:center;border-radius:10px;margin:20px 0">${code}</p>
      <p>รหัสนี้ใช้ได้ภายใน <strong>${minutes} นาที</strong> และใช้ได้ครั้งเดียว</p>
      <p style="color:#6b7280;font-size:13px;border-top:1px solid #e3e6ea;padding-top:16px;margin-top:24px">
        ถ้าคุณไม่ได้เป็นคนขอ ให้เพิกเฉยอีเมลนี้ รหัสผ่านเดิมของคุณจะยังใช้ได้ตามปกติ
      </p>
    </div>`;

  if (!transporter) {
    console.log(`\n📧 [DEV] OTP สำหรับ ${to} คือ ${code} (หมดอายุใน ${minutes} นาที)\n`);
    return;
  }

  await transporter.sendMail({
    from: SMTP_FROM ?? `KIN Homecare <${SMTP_USER}>`,
    to,
    subject,
    html,
  });
}
