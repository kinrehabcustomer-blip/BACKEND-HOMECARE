import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, setUnauthorizedHandler } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(null);
  const [loading, setLoading] = useState(true); // ยังไม่รู้ว่า login อยู่ไหม จนกว่า /auth/me จะตอบ
  // ตั้งเป็น true เมื่อผู้ใช้กดออกจากระบบเอง — ต่างจากโดนเด้งออกเพราะเซสชันหมดอายุ
  const intentionalLogout = useRef(false);
  // เหตุผลที่โดนเด้งออก (ข้อความจาก server) — ส่งต่อไปขึ้นบนหน้า login
  const [kickedOut, setKickedOut] = useState(null);
  /* เซสชันหมดอายุระหว่างใช้งาน (ต่างจาก "ยังไม่เคย login") — ขึ้นกล่องเข้าระบบใหม่ทับหน้าเดิม
     แทนการเด้งออก ดูเหตุผลที่ตัวจัดการ 401 ข้างล่าง */
  const [sessionExpired, setSessionExpired] = useState(false);

  /* เงาของ user ไว้ให้ตัวจัดการ 401 อ่าน — ตัวจัดการถูกลงทะเบียนครั้งเดียว
     ถ้าไปอ่าน user จาก closure จะค้างอยู่ที่ค่าตอนลงทะเบียน (null) ตลอดไป */
  const currentUser = useRef(null);
  const setUser = useCallback((value) => {
    currentUser.current = value;
    setUserState(value);
  }, []);

  // คุกกี้เป็น httpOnly อ่านจาก JS ไม่ได้ — ต้องถาม server ว่าเซสชันยังใช้ได้อยู่หรือเปล่า
  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [setUser]);

  /*
   * เซสชันใช้ไม่ได้แล้วระหว่างใช้งาน — ขึ้นกล่องเข้าระบบใหม่ทับหน้าเดิม ไม่ล้าง user ทิ้ง
   *
   * 🔴 เดิมล้าง user ทิ้งให้ RequireAuth พาไปหน้า login ซึ่งทำให้ "หน้าที่ค้างอยู่ถูก unmount"
   *    = ทุกอย่างที่พิมพ์ค้างไว้ในฟอร์มหายหมด กู้ไม่ได้ (ตรวจรอบ 10 · ทดสอบจริงที่ /patients/new)
   *    คุกกี้อายุ 8 ชม. คนที่เข้าระบบ 08:00 จะโดนราว 16:00 ซึ่งเป็นช่วงคีย์ข้อมูลบ่ายพอดี
   *    ตัวกัน beforeunload ที่ฟอร์มยาวมีอยู่แล้วก็ช่วยไม่ได้ เพราะเป็นการเปลี่ยนหน้าภายในแอป
   *
   * ตอนนี้ children ยังอยู่ครบ (ไม่ถูก unmount) มีแค่กล่องทึบทับอยู่ข้างบน — เข้าระบบใหม่เสร็จ
   * กล่องหายไป ผู้ใช้กดบันทึกซ้ำได้ทันทีโดยไม่ต้องกรอกใหม่
   *
   * ลงทะเบียนที่เดียวตรงนี้ ครอบคลุมทุกหน้าและทุกปุ่มโดยที่หน้าไม่ต้องรู้เรื่องด้วย
   */
  useEffect(() => {
    setUnauthorizedHandler((message) => {
      // ไม่เคย login อยู่แล้ว (เปิดแอปมาเจอ /auth/me ตอบ 401) — เป็นเรื่องปกติ ไม่ใช่การโดนเด้งออก
      // ขึ้นข้อความว่าเซสชันหมดอายุกับคนที่เพิ่งเปิดเว็บครั้งแรกจะทำให้งงเปล่าๆ
      if (!currentUser.current) return;
      setKickedOut(message);
      setSessionExpired(true);
    });
    return () => setUnauthorizedHandler(null);
  }, [setUser]);

  const login = async (email, password) => {
    intentionalLogout.current = false;
    setKickedOut(null); // เข้าใหม่สำเร็จแล้ว เหตุผลของรอบก่อนไม่ต้องค้างไว้
    setUser(await api.login(email, password));
    setSessionExpired(false); // ปิดกล่องเข้าระบบใหม่ (ถ้าเข้ามาทางนั้น) — งานที่ค้างอยู่ยังอยู่ครบ
  };

  const logout = async () => {
    intentionalLogout.current = true;
    setKickedOut(null);
    setSessionExpired(false);
    await api.logout().catch(() => {}); // คุกกี้อาจหมดอายุไปแล้ว — ยังไงก็ต้องออกจากระบบฝั่งหน้าเว็บ
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setUser, intentionalLogout, kickedOut }}>
      {children}
      {/* คนที่ไม่มีอีเมลในประวัติใช้รหัสพนักงานเป็นชื่อผู้ใช้ (ดู /auth/login ฝั่ง server) */}
      {sessionExpired && user && (
        <ReloginOverlay email={user.email || user.employee_id} notice={kickedOut} onLogin={login} onLogout={logout} />
      )}
    </AuthContext.Provider>
  );
}

/**
 * กล่องเข้าระบบใหม่ที่ทับหน้าเดิมเมื่อเซสชันหมดอายุกลางคัน — หน้าข้างหลังไม่ถูก unmount
 * ของที่พิมพ์ค้างไว้จึงยังอยู่ และกดบันทึกซ้ำได้ทันทีหลังเข้าระบบใหม่
 *
 * ปุ่ม "ออกจากระบบ" จำเป็น — ถ้าบัญชีถูกพักงาน/ให้ออก การเข้าใหม่จะไม่มีวันผ่าน
 * ไม่มีปุ่มนี้ผู้ใช้จะติดอยู่ในกล่องโดยไม่มีทางออก
 */
function ReloginOverlay({ email, notice, onLogin, onLogout }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onLogin(email, password);
    } catch (err) {
      setError(err.message || 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(32,26,20,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
      role="dialog"
      aria-modal="true"
      aria-label="เซสชันหมดอายุ เข้าสู่ระบบอีกครั้ง"
    >
      <form className="list-card" onSubmit={submit} style={{ maxWidth: '380px', width: '100%', padding: '20px' }}>
        <h2 style={{ marginTop: 0 }}>เซสชันหมดอายุ</h2>
        <p className="muted">
          {notice || 'ระบบออกจากระบบให้อัตโนมัติเพื่อความปลอดภัย'}
          <br />
          <strong>งานที่กรอกค้างไว้ยังอยู่</strong> — เข้าระบบอีกครั้งแล้วกดบันทึกต่อได้เลย
        </p>
        <label>
          อีเมล / รหัสพนักงาน
          <input type="text" value={email || ''} readOnly />
        </label>
        <label>
          รหัสผ่าน
          {/* autoFocus ตั้งใจ — ผู้ใช้กำลังทำงานค้างอยู่ ต้องพิมพ์รหัสแล้วกลับไปทำต่อให้เร็วที่สุด */}
          <input type="password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'กำลังเข้าระบบ…' : 'เข้าระบบและทำงานต่อ'}
          </button>
          <button type="button" className="btn" onClick={onLogout} disabled={busy}>
            ออกจากระบบ
          </button>
        </div>
      </form>
    </div>
  );
}

export const useAuth = () => useContext(AuthContext);

/**
 * หมวดสิทธิ์ของผู้ใช้ (office / billing / money) — server ส่งมากับ session (ดู POSITION_PERMISSIONS
 * ใน server/src/lib/auth.js) หน้าเว็บใช้แค่ซ่อนเมนู/ปุ่ม ตัวจริงที่กันคือด่านของแต่ละเส้น API
 *
 * session จาก server รุ่นก่อนมีหมวดยังไม่มีช่อง permissions — เดาจากกติกาเดิม
 * (หลังบ้าน = office + billing · ผู้จัดการได้ money เพิ่ม) แทนที่จะปล่อยให้ทุกคนโดนล็อกออกจากทุกหน้า
 */
export function permissionsOf(user) {
  if (!user) return [];
  if (Array.isArray(user.permissions)) return user.permissions;
  if (user.role !== 'admin') return [];
  return ['manager', 'super_admin'].includes(user.position) ? ['office', 'billing', 'money'] : ['office', 'billing'];
}

export const useCan = (permission) => permissionsOf(useAuth()?.user).includes(permission);

/**
 * เห็นค่าจ้างพนักงาน/กำไรได้ไหม = มีสิทธิ์หมวด money (ผู้จัดการ · การเงิน)
 *
 * ตัวนี้ใช้ตัดสินแค่ว่าจะ "วาด" อะไรบนหน้าจอ — ตัวจริงที่กันคือ server ที่ตัดฟิลด์ออกจาก payload
 * (ดู canSeeStaffPay ใน server/src/lib/auth.js) แก้ค่านี้ในเบราว์เซอร์แล้วก็ยังไม่มีตัวเลขให้ดูอยู่ดี
 */
export const useCanSeeStaffPay = () => useCan('money');

/**
 * เห็นรายได้รวมของบริษัทได้ไหม (กราฟรายได้หน้าภาพรวม) — เฉพาะตำแหน่งผู้จัดการเช่นกัน
 *
 * ถามแยกจาก useCanSeeStaffPay ทั้งที่ตอนนี้ตอบเหมือนกัน เพราะเป็นคนละคำถาม —
 * ค่าจ้างพนักงานกับรายได้บริษัทเปิดให้ตำแหน่งอื่นเห็นทีละอย่างได้ในอนาคต
 * โดยไม่ต้องไล่ดูว่าจุดที่เรียก useCanSeeStaffPay อยู่หมายถึงอันไหน (กติกาเดียวกับฝั่ง server)
 *
 * ตัวจริงที่กันคือ requireManager หน้าเส้น /api/invoices/revenue — อันนี้แค่ไม่วาดการ์ดที่ยังไงก็โหลดไม่ได้
 */
export const useCanSeeRevenue = () => useCan('money');

/** ครอบหน้าที่ต้อง login — ยังไม่ login ให้เด้งไปหน้า login */
export function RequireAuth({ children }) {
  const { user, loading, intentionalLogout, kickedOut } = useAuth();
  const location = useLocation();

  if (loading) return <p className="muted app-loading">กำลังตรวจสอบสิทธิ์…</p>;

  if (!user) {
    // จำหน้าที่ค้างไว้เฉพาะตอนโดนเด้งออก (ยังไม่ login / เซสชันหมดอายุ) เพื่อพากลับมาที่เดิมหลัง login
    // แต่ถ้าผู้ใช้กดออกจากระบบเอง ไม่ต้องจำ — ครั้งหน้าให้เริ่มที่หน้าแรกตามปกติ
    // kickedOut = เหตุผลที่โดนเด้ง ต้องบอกด้วย ไม่งั้นคนที่กำลังกรอกอยู่ดีๆ จะเจอหน้า login เฉยๆ
    // แล้วเข้าใจว่าระบบพังหรือกดอะไรผิด
    const state = intentionalLogout.current ? undefined : { from: location, notice: kickedOut };
    return <Navigate to="/login" state={state} replace />;
  }

  return children;
}
