import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, UnauthorizedError } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // ยังไม่รู้ว่า login อยู่ไหม จนกว่า /auth/me จะตอบ
  // ตั้งเป็น true เมื่อผู้ใช้กดออกจากระบบเอง — ต่างจากโดนเด้งออกเพราะเซสชันหมดอายุ
  const intentionalLogout = useRef(false);

  // คุกกี้เป็น httpOnly อ่านจาก JS ไม่ได้ — ต้องถาม server ว่าเซสชันยังใช้ได้อยู่หรือเปล่า
  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    intentionalLogout.current = false;
    setUser(await api.login(email, password));
  };

  const logout = async () => {
    intentionalLogout.current = true;
    await api.logout().catch(() => {}); // คุกกี้อาจหมดอายุไปแล้ว — ยังไงก็ต้องออกจากระบบฝั่งหน้าเว็บ
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setUser, intentionalLogout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

/** ครอบหน้าที่ต้อง login — ยังไม่ login ให้เด้งไปหน้า login */
export function RequireAuth({ children }) {
  const { user, loading, intentionalLogout } = useAuth();
  const location = useLocation();

  if (loading) return <p className="muted app-loading">กำลังตรวจสอบสิทธิ์…</p>;

  if (!user) {
    // จำหน้าที่ค้างไว้เฉพาะตอนโดนเด้งออก (ยังไม่ login / เซสชันหมดอายุ) เพื่อพากลับมาที่เดิมหลัง login
    // แต่ถ้าผู้ใช้กดออกจากระบบเอง ไม่ต้องจำ — ครั้งหน้าให้เริ่มที่หน้าแรกตามปกติ
    const state = intentionalLogout.current ? undefined : { from: location };
    return <Navigate to="/login" state={state} replace />;
  }

  return children;
}

/** เซสชันหมดอายุระหว่างใช้งาน — ให้หน้าที่เรียก API เด้งกลับไป login แทนที่จะโชว์ error ดิบ */
export function useApiError() {
  const { setUser } = useAuth();

  return (err) => {
    if (err instanceof UnauthorizedError) {
      setUser(null);
      return null; // RequireAuth จะพาไปหน้า login เอง
    }
    return err.message;
  };
}
