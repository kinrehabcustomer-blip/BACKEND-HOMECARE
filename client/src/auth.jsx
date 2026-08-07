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
   * เซสชันใช้ไม่ได้แล้วระหว่างใช้งาน — ล้าง user ทิ้งเพื่อให้ RequireAuth พาไปหน้า login เอง
   *
   * ลงทะเบียนที่เดียวตรงนี้ ครอบคลุมทุกหน้าและทุกปุ่มโดยที่หน้าไม่ต้องรู้เรื่องด้วย
   * ทำงานก่อน catch ของหน้าที่เรียก API เสมอ (api.js แจ้งก่อนโยน error ออกมา)
   * React จึงรวมการอัปเดตทั้งสองไว้รอบเดียว — ผู้ใช้ไม่ทันเห็นแถบ error แวบก่อนถูกเด้ง
   */
  useEffect(() => {
    setUnauthorizedHandler((message) => {
      // ไม่เคย login อยู่แล้ว (เปิดแอปมาเจอ /auth/me ตอบ 401) — เป็นเรื่องปกติ ไม่ใช่การโดนเด้งออก
      // ขึ้นข้อความว่าเซสชันหมดอายุกับคนที่เพิ่งเปิดเว็บครั้งแรกจะทำให้งงเปล่าๆ
      if (!currentUser.current) return;
      setKickedOut(message);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, [setUser]);

  const login = async (email, password) => {
    intentionalLogout.current = false;
    setKickedOut(null); // เข้าใหม่สำเร็จแล้ว เหตุผลของรอบก่อนไม่ต้องค้างไว้
    setUser(await api.login(email, password));
  };

  const logout = async () => {
    intentionalLogout.current = true;
    setKickedOut(null);
    await api.logout().catch(() => {}); // คุกกี้อาจหมดอายุไปแล้ว — ยังไงก็ต้องออกจากระบบฝั่งหน้าเว็บ
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setUser, intentionalLogout, kickedOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

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
