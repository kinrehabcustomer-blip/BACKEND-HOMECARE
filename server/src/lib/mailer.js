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

export async function sendOtpEmail({ to, name, code, minutes }) {
  const subject = `รหัสยืนยันสำหรับตั้งรหัสผ่านใหม่: ${code}`;
  const html = `
    <div style="font-family:'Segoe UI',sans-serif;max-width:480px;color:#1c2024">
      <p style="font-size:20px;font-weight:800;letter-spacing:2px;color:#0f7b6c;margin:0">KIN</p>
      <p style="font-size:12px;color:#6b7280;margin:2px 0 24px">Homecare · ระบบหลังบ้าน</p>
      <p>สวัสดีคุณ ${name}</p>
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
