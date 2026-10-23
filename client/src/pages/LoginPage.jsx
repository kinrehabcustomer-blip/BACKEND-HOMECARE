import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import PasswordInput from '../components/PasswordInput.jsx';

export default function LoginPage() {
  const { user, loading, login, setUser } = useAuth();
  const [linkCode, setLinkCode] = useState('');
  const [codeError, setCodeError] = useState(null);
  const [codeBusy, setCodeBusy] = useState(false);
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
  // ?to= มาจากลิงก์ LINE ที่ยังไม่ผูก (GET /api/auth/line) — รับเฉพาะหน้างานของพนักงาน (ดร. 23 ต.ค. 2569 ปุ่ม "ส่งรายงานวันนี้")
  const toParam = new URLSearchParams(location.search).get('to');
  const safeTo = ['/my-today', '/my-cases', '/my-calendar'].includes(toParam) ? toParam : '/';
  const backTo = from ? `${from.pathname}${from.search ?? ''}` : safeTo; // '/' พาไปหน้าแรกตามสิทธิ์ (การเงินไม่มีหน้าภาพรวม)

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

  // รหัสผูก LINE 6 หลักจากผู้ประสานงาน (ดร. 23 ต.ค. 2569) — ผูกแล้วเข้าระบบทันที useEffect ด้านบนพาไปหน้าที่ตั้งใจต่อเอง
  async function handleCode(e) {
    e.preventDefault();
    setCodeBusy(true);
    setCodeError(null);
    try {
      setUser(await api.lineCodeLogin(lineTicket, linkCode));
    } catch (err) {
      setCodeError(err.message);
      setCodeBusy(false);
    }
  }

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
        {/* ชื่อหน้าเข้าระบบ = KIN Jobs (ดร.ธงชัย 23 ต.ค. 2569 "ตัว Login ไม่น่าชื่อ Kin Home Care แล้ว น่าจะชื่อ Kin Job")
            ใช้ชื่อเดียวกับ LINE @kinjobs ที่เจ้าหน้าที่กดเข้ามา · โลโก้เดิมมีคำว่า HOME CARE จึงใช้ตัวอักษรแทน */}
        <div className="login-brand">
          <div style={{ fontFamily: 'Prompt, sans-serif', fontWeight: 800, fontSize: 34, letterSpacing: 1, color: '#7a5a1e' }}>KIN Jobs</div>
        </div>

        <div className="login-heading">
          <h1>เข้าสู่ระบบ</h1>
          <p className="login-description">ระบบงานเจ้าหน้าที่ KIN<br />เช็คอิน · ส่งรายงาน · ตารางงาน</p>
        </div>

        {/* ข้อความส่งต่อมาจากหน้าตั้งรหัสผ่านใหม่ */}
        {location.state?.notice && <p className="notice">{location.state.notice}</p>}
        {lineTicket && (
          /* มาจากปุ่มใน LINE แต่ LINE นี้ยังไม่ผูกกับบัญชีพนักงาน — ทางง่ายสุดคือรหัส 6 หลักจากผู้ประสานงาน (ดร. 23 ต.ค. 2569)
             อยู่ใน form เดียวกับรหัสผ่าน จึงใช้ปุ่ม type="button" + Enter ในช่องรหัสส่งเอง ไม่ให้ไปกดเข้าระบบด้วยรหัสผ่าน */
          <div className="notice" style={{ display: 'grid', gap: 8 }}>
            <b>ครั้งแรกที่เข้าจาก LINE ต้องยืนยันตัวตน 1 ครั้ง</b>
            <span>
              <b>ทางที่ 1 (ง่ายสุด):</b> กรอกรหัสตัวเลข 6 หลักที่ได้จากผู้ประสานงาน / หัวหน้างาน
              {' '}(ยังไม่มีรหัส ขอได้จากผู้ประสานงานหรือหัวหน้างานของคุณ)
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="รหัส 6 หลัก เช่น 482916"
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCode(e); }}
              style={{ fontSize: 22, letterSpacing: 4, textAlign: 'center' }}
            />
            {codeError && <span className="error">{codeError}</span>}
            <button type="button" className="btn primary" disabled={codeBusy || linkCode.length !== 6} onClick={handleCode}>
              {codeBusy ? 'กำลังตรวจรหัส…' : 'ยืนยันรหัส แล้วเข้าระบบ'}
            </button>
            <span className="muted">ทำครั้งเดียว ครั้งต่อไปกดปุ่มใน LINE @kinjobs เข้าได้ทันที</span>
            <span><b>ทางที่ 2:</b> มีรหัสผ่านระบบงานอยู่แล้ว กรอกด้านล่างนี้ได้เลย</span>
          </div>
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
