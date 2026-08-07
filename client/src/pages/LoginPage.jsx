import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /* หน้าที่ค้างไว้ตอนโดนเด้งออก — ต้องเอา search ไปด้วย ไม่ใช่แค่ pathname
     เพราะหน้ารายการเก็บตัวกรอง/หน้าที่เปิดอยู่ไว้ใน URL ทั้งหมด (?status=...&open=CASE-0001)
     ตัดทิ้งแล้วจะกลับมาเจอรายการเปล่าๆ ต้องไล่กรองใหม่เองทั้งที่ระบบพากลับมาถูกหน้าแล้ว */
  const from = location.state?.from;
  const backTo = from ? `${from.pathname}${from.search ?? ''}` : '/dashboard';

  // login อยู่แล้วก็ไม่ต้องเห็นหน้านี้ — กลับไปหน้าที่ตั้งใจจะเข้าตอนแรก
  if (loading) return <p className="muted app-loading">กำลังตรวจสอบสิทธิ์…</p>;
  if (user) return <Navigate to={backTo} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(backTo, { replace: true });
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

        {/* ป้ายเคยเขียนว่า "รหัสผ่าน (รหัสพนักงาน)" และ placeholder เป็น EMP-0001
            ซึ่งเท่ากับประกาศบนหน้าที่ใครก็เปิดได้ว่ารหัสผ่านตั้งต้นคือรหัสพนักงาน
            รหัสพนักงานเรียงเป็นลำดับ (EMP-0001, EMP-0002, …) และโชว์อยู่ในตารางพนักงาน
            คนที่เดาอีเมลได้จึงเดารหัสผ่านของคนที่ยังไม่เคยเปลี่ยนได้ทันที
            ฝั่งแอดมินยังรู้ได้จากหน้าประวัติพนักงาน (ขึ้นเฉพาะคนที่ยังไม่เคยเปลี่ยนรหัส) */}
        <label>
          รหัสผ่าน
          <PasswordInput
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </button>

        {/* บอกว่าไปเอารหัสจากใคร โดยไม่บอกว่ารหัสคืออะไร — คนที่ควรรู้ถามได้ คนที่ไม่ควรรู้ไม่ได้อะไรไป */}
        <p className="muted login-note">
          เข้าครั้งแรกใช้รหัสที่ฝ่ายบุคคลแจ้งไว้ · <Link to="/forgot-password">ลืมรหัสผ่าน?</Link>
        </p>
      </form>
    </div>
  );
}
