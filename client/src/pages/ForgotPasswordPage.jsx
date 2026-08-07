import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import PasswordInput from '../components/PasswordInput.jsx';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState('email'); // 'email' -> กรอกอีเมล, 'otp' -> กรอกรหัสยืนยัน + รหัสผ่านใหม่
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function requestOtp(e) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { message } = await api.forgotPassword(email);
      setNotice(message);
      setStep('otp');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e) {
    e.preventDefault();
    // เช็คตรงนี้ก่อนยิง API เพื่อไม่ให้เสีย OTP ไปฟรีๆ เพราะพิมพ์รหัสใหม่ไม่ตรงกัน
    if (password !== confirm) return setError('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');

    setBusy(true);
    setError(null);
    try {
      await api.resetPassword({ email, code, new_password: password });
      navigate('/login', {
        replace: true,
        state: { notice: 'ตั้งรหัสผ่านใหม่เรียบร้อย เข้าสู่ระบบด้วยรหัสผ่านใหม่ได้เลย' },
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={step === 'email' ? requestOtp : submitReset}>
        <div className="login-brand">
          <span className="brand-mark">KIN</span>
          <span className="brand-sub">Homecare · ระบบหลังบ้าน</span>
        </div>

        <h1>ลืมรหัสผ่าน</h1>

        {step === 'email' ? (
          <>
            <p className="muted">กรอกอีเมลที่ใช้เข้าระบบ เราจะส่งรหัสยืนยัน 6 หลักไปให้</p>
            {error && <p className="error login-error">{error}</p>}

            <label>
              อีเมล
              <input
                type="email"
                autoComplete="username"
                autoFocus
                required
                placeholder="you@kin.co.th"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <button className="btn primary login-submit" type="submit" disabled={busy}>
              {busy ? 'กำลังส่ง…' : 'ส่งรหัสยืนยัน'}
            </button>
          </>
        ) : (
          <>
            {notice && <p className="notice">{notice}</p>}
            {error && <p className="error login-error">{error}</p>}

            <label>
              รหัสยืนยัน 6 หลัก
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={6}
                placeholder="123456"
                className="otp-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </label>

            <label>
              รหัสผ่านใหม่
              <PasswordInput
                autoComplete="new-password"
                required
                minLength={8}
                placeholder="อย่างน้อย 8 ตัวอักษร"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            <label>
              ยืนยันรหัสผ่านใหม่
              <PasswordInput
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>

            <button className="btn primary login-submit" type="submit" disabled={busy}>
              {busy ? 'กำลังตั้งรหัสผ่าน…' : 'ตั้งรหัสผ่านใหม่'}
            </button>

            <button type="button" className="btn link-btn" onClick={requestOtp} disabled={busy}>
              ไม่ได้รับรหัส? ส่งใหม่อีกครั้ง
            </button>
          </>
        )}

        <p className="muted login-note">
          <Link to="/login">← กลับไปหน้าเข้าสู่ระบบ</Link>
        </p>
      </form>
    </div>
  );
}
