import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // login อยู่แล้วก็ไม่ต้องเห็นหน้านี้ — กลับไปหน้าที่ตั้งใจจะเข้าตอนแรก
  if (loading) return <p className="muted app-loading">กำลังตรวจสอบสิทธิ์…</p>;
  if (user) return <Navigate to={location.state?.from?.pathname ?? '/dashboard'} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(location.state?.from?.pathname ?? '/dashboard', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        {/* โลโก้อย่างเดียว — คำบรรยายใต้โลโก้ซ้ำกับตัวโลโก้ที่มีคำว่า HOME CARE อยู่แล้ว */}
        <div className="login-brand">
          <img className="brand-logo login-logo" src="/logo-navbar.webp" alt="KIN Home Care" />
        </div>

        <h1>เข้าสู่ระบบ</h1>

        {/* ข้อความส่งต่อมาจากหน้าตั้งรหัสผ่านใหม่ */}
        {location.state?.notice && <p className="notice">{location.state.notice}</p>}
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

        <label>
          รหัสผ่าน (รหัสพนักงาน)
          <input
            type="password"
            autoComplete="current-password"
            required
            placeholder="EMP-0001"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </button>

        <p className="muted login-note">
          <Link to="/forgot-password">ลืมรหัสผ่าน?</Link>
        </p>
      </form>
    </div>
  );
}
