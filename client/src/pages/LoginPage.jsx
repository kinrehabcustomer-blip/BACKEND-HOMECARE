import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import PasswordInput from '../components/PasswordInput.jsx';
import LineIcon from '../components/LineIcon.jsx';

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
  const safeTo = ['/my-today', '/my-cases', '/my-calendar', '/my-attendance'].includes(toParam) || /^\/my-cases\?case=[A-Za-z0-9-]{3,30}$/.test(toParam || '') ? toParam : '/';
  const backTo = from ? `${from.pathname}${from.search ?? ''}` : safeTo; // '/' พาไปหน้าแรกตามสิทธิ์ (การเงินไม่มีหน้าภาพรวม)

  /* มาจากปุ่มในหน้า "งานของฉัน" ใน LINE แต่ LINE นี้ยังไม่ได้ผูกกับบัญชีไหน (ดู GET /api/auth/line)
     login ด้วยรหัสผ่านเดิมครั้งนี้ครั้งเดียว แล้วผูกให้ทันที — ครั้งต่อไปกดจาก LINE เข้าได้เลย */
  const query = new URLSearchParams(location.search);
  const lineTicket = query.get('line');
  const lineError = query.get('line_error');
  const ssoError = query.get('sso_error');

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
      <p className="muted app-loading">กำลังยืนยันตัวตน…</p>
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
    <div className="login-page login-v2">
      {/* ดีไซน์ v2 (23 พ.ย. 2569): การ์ดสองฝั่ง — แผงแบรนด์ทองจาง (ซ้าย) + ฟอร์ม (ขวา)
          มือถือ: แผงแบรนด์เป็นแถบบน ฟอร์มเป็นการ์ดลอยทับขอบล่างของแถบ · ฟอร์ม/ลำดับการกรอกเหมือนเดิมทุกอย่าง */}
      <div className="login-shell">
        <aside className="login-aside" aria-hidden="true">
          <svg className="login-aside-art" viewBox="0 0 360 220" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 150 L150 40 L230 100" /><path d="M120 150 L230 62 L350 150" /><path d="M215 76 V40 H235 V92" />
          </svg>
          <div className="login-aside-brand">
            {/* โลโก้ KIN HOME CARE (ผู้ใช้ขอ 24 พ.ย. 2569) — สลับไฟล์ตามธีมด้วยกฎ .logo-light/.logo-dark */}
            <img className="brand-logo login-logo logo-light" src="/logo-navbar.webp" alt="KIN Home Care" />
            <img className="brand-logo login-logo logo-dark" src="/logo-navbar-dark.webp" alt="" aria-hidden="true" />
          </div>
          <div className="login-aside-main">
            <p className="login-aside-title">ระบบงาน<br />เจ้าหน้าที่ KIN</p>
            <ul className="login-aside-list">
              <li><span className="login-aside-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg></span>เช็คอิน</li>
              <li><span className="login-aside-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h5" /></svg></span>ส่งรายงาน</li>
              <li><span className="login-aside-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg></span>ตารางงาน</li>
            </ul>
          </div>
          <p className="login-aside-foot">KIN HOME CARE · STAFF PORTAL</p>
        </aside>
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-heading">
          <h1>เข้าสู่ระบบ</h1>
          <p className="login-description">ระบบงานเจ้าหน้าที่ KIN<span className="login-desc-more"> · เช็คอิน · ส่งรายงาน · ตารางงาน</span></p>
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
            {lineError === 'blocked'
              ? 'บัญชีนี้ใช้งานไม่ได้ — ติดต่อผู้ดูแลระบบ'
              /* ตั๋วใช้ได้ครั้งเดียว (ดู GET /api/auth/line) — ลิงก์เดิมในแชท/ประวัติเบราว์เซอร์กดซ้ำไม่ได้ */
              : lineError === 'used'
                ? 'ลิงก์นี้ถูกใช้เข้าระบบไปแล้ว (ใช้ได้ครั้งเดียว) กรุณากดปุ่มในเมนู LINE @kinjobs ใหม่อีกครั้ง'
                : 'ลิงก์จาก LINE หมดอายุแล้ว กรุณากดปุ่มในหน้า "งานของฉัน" ใหม่อีกครั้ง'}
          </p>
        )}
        {/* มาจากปุ่ม "ระบบงาน Staff" ในแดชบอร์ด admin แต่เข้าไม่ได้ (GET /api/auth/admin-sso · 24 ต.ค. 2569) */}
        {ssoError && (
          <p className="error login-error">
            {ssoError === 'nomatch'
              ? 'อีเมลที่ใช้เข้าแดชบอร์ด admin ไม่ตรงกับอีเมลในประวัติพนักงาน หรือตำแหน่งนี้ยังเข้าจากปุ่มไม่ได้ (เปิดให้ Admin HC · HR · ผู้จัดการ) — ให้ HR ตั้งอีเมลในหน้าพนักงานให้ตรงกัน หรือเข้าด้วยรหัสผ่านด้านล่าง'
              : ssoError === 'blocked' ? 'บัญชีนี้ใช้งานไม่ได้ — ติดต่อผู้ดูแลระบบ' : 'ลิงก์จากแดชบอร์ด admin หมดอายุ กรุณากดปุ่ม "ระบบงาน Staff" ใหม่อีกครั้ง'}
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
            // สั้นพอให้จบในช่องบนจอมือถือ — เดิมยาวจนถูกตัดเหลือ "…เช่น A6" (ป้ายเหนือช่องบอกแล้วว่ากรอกอีเมลหรือรหัสก็ได้)
            placeholder="เช่น A6901059 หรืออีเมล"
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

        {/* ดีไซน์ v2: ลิงก์ลืมรหัสผ่านอยู่ใต้ปุ่มเข้าสู่ระบบ (เดิมอยู่ท้ายการ์ด) */}
        <p className="muted login-note">
          <Link to="/forgot-password">ลืมรหัสผ่าน?</Link>
        </p>

        {/* ดร.ธงชัย 2 พ.ย. 2569 สั่งให้เขียนรหัสเริ่มต้นไว้หน้า login เลย (เปลี่ยนจากเดิมที่ไม่บอกรหัส) */}
        <div className="notice login-hint">
          <div className="login-hint-head">
            <b>เข้าใช้งานครั้งแรก</b>
            <dl className="login-hint-list">
              <dt>Username</dt><dd>รหัสพนักงาน</dd>
              <dt>Password</dt><dd className="login-hint-pw">12345678</dd>
            </dl>
          </div>
          {/* รหัสเริ่มต้นเหมือนกันทุกคน — ย้ำให้เปลี่ยนหลังเข้าได้แล้ว (11 พ.ย. 2569) */}
          <p className="login-hint-warn">
            <LineIcon name="alert" className="text-ico" />
            <span>กรุณาเปลี่ยนรหัสผ่านเมื่อเข้าใช้งานแล้ว<br />เปลี่ยนรหัสผ่านได้ที่ เมนูตั้งค่า</span>
          </p>
        </div>
      </form>
      </div>
      <p className="login-footer">KIN HOME CARE · STAFF PORTAL</p>
    </div>
  );
}
