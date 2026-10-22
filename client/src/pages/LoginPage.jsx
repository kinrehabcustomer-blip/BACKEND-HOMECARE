import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
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
  const backTo = from ? `${from.pathname}${from.search ?? ''}` : '/'; // '/' พาไปหน้าแรกตามสิทธิ์ (การเงินไม่มีหน้าภาพรวม)

  /* มาจากปุ่มในหน้า "งานของฉัน" ใน LINE แต่ LINE นี้ยังไม่ได้ผูกกับบัญชีไหน (ดู GET /api/auth/line)
     login ด้วยรหัสผ่านเดิมครั้งนี้ครั้งเดียว แล้วผูกให้ทันที — ครั้งต่อไปกดจาก LINE เข้าได้เลย */
  const query = new URLSearchParams(location.search);
  const lineTicket = query.get('line');
  const lineError = query.get('line_error');

  // login ค้างอยู่แล้วแต่กดมาจาก LINE ที่ยังไม่ผูก — ผูกให้เลย ไม่ต้องกรอกรหัสซ้ำ
  useEffect(() => {
    if (!user || !lineTicket) return;
    api
      .linkLine(lineTicket)
      .then(() => navigate(backTo, { replace: true }))
      .catch((err) => setError(err.message));
  }, [user, lineTicket]); // eslint-disable-line react-hooks/exhaustive-deps

  // login อยู่แล้วก็ไม่ต้องเห็นหน้านี้ — กลับไปหน้าที่ตั้งใจจะเข้าตอนแรก
  if (loading) return <p className="muted app-loading">กำลังตรวจสอบสิทธิ์…</p>;
  // ผูกไม่ผ่าน (ตั๋วหมดอายุ / LINE นี้เป็นของคนอื่น) ไม่ขวางการเข้าระบบ — บอกเหตุผลแล้วให้เข้าต่อได้
  if (user && lineTicket) {
    return error ? (
      <p className="error app-loading">
        {error} · <Link to={backTo} replace>เข้าระบบต่อ</Link>
      </p>
    ) : (
      <p className="muted app-loading">กำลังผูกบัญชีกับ LINE…</p>
    );
  }
  if (user) return <Navigate to={backTo} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      // มาจาก LINE: useEffect ด้านบนผูกบัญชีแล้วพาไปต่อเอง (ทำงานทันทีที่ user ถูกตั้ง)
      if (!lineTicket) navigate(backTo, { replace: true });
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

        <div className="login-heading">
          <h1>เข้าสู่ระบบ</h1>
          <p className="login-description">ระบบบริหารจัดการงานดูแลที่บ้าน<br />สำหรับเจ้าหน้าที่และบุคลากร KIN Home Care</p>
        </div>

        {/* ข้อความส่งต่อมาจากหน้าตั้งรหัสผ่านใหม่ */}
        {location.state?.notice && <p className="notice">{location.state.notice}</p>}
        {lineTicket && (
          <p className="notice">เข้าสู่ระบบด้วยรหัสผ่านเดิม <b>ครั้งนี้ครั้งเดียว</b> เพื่อผูกบัญชีกับ LINE — ครั้งต่อไปกดจากหน้า "งานของฉัน" ใน LINE เข้าได้เลย</p>
        )}
        {lineError && (
          <p className="error login-error">
            {lineError === 'blocked' ? 'บัญชีนี้ใช้งานไม่ได้ — ติดต่อผู้ดูแลระบบ' : 'ลิงก์จาก LINE หมดอายุแล้ว กรุณากดปุ่มในหน้า "งานของฉัน" ใหม่อีกครั้ง'}
          </p>
        )}
        {error && <p className="error login-error">{error}</p>}

        <label>
          อีเมล / รหัสพนักงาน
          <input
            type="text"
            autoComplete="username"
            autoFocus
            required
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@kin.co.th หรือรหัสพนักงาน เช่น A6901059"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <p className="muted">หากยังไม่มีอีเมลในประวัติ ให้ใช้รหัสพนักงานเป็น Username ชั่วคราว</p>

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
      <p className="login-footer">KIN HOME CARE · STAFF PORTAL</p>
    </div>
  );
}
