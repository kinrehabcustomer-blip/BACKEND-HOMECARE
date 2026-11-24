import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * ข้อความยืนยันสั้นๆ มุมจอ — ใช้บอกว่า "ทำสำเร็จแล้ว" ในที่ที่หน้าเว็บไม่ได้เปลี่ยนให้เห็นชัด
 *
 * ไม่ใช้แทน error ที่ต้องอ่านจริงจัง (พวกนั้นยังอยู่ในแถบ .error ของแต่ละหน้า เพราะ toast หายเอง
 * คนที่มองไปทางอื่นจะพลาด) — ที่นี่มีไว้สำหรับ "บันทึกแล้ว" ที่ไม่ต้องทำอะไรต่อ
 */
const ToastContext = createContext(null);

const LIFETIME = 3200;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (message, kind = 'ok') => {
      const id = (nextId.current += 1);
      setToasts((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => dismiss(id), LIFETIME);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live เพื่อให้โปรแกรมอ่านหน้าจอประกาศข้อความ โดยไม่ต้องแย่งโฟกัสจากสิ่งที่ผู้ใช้ทำอยู่ */}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`toast toast-${t.kind}`}
            onClick={() => dismiss(t.id)}
            title="กดเพื่อปิด"
          >
            {/* ดีไซน์ v2: ไอคอนนำหน้า — ติ๊กถูก (สำเร็จ) / วงกลมตกใจ (ผิดพลาด) · ตกแต่งอย่างเดียว */}
            <svg className="toast-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {t.kind === 'error'
                ? <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>
                : <path d="M5 12l5 5L20 7" />}
            </svg>
            <span className="toast-text">{t.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** คืนฟังก์ชัน toast(message, 'ok' | 'error') — เรียกได้จากทุกที่ที่อยู่ใต้ ToastProvider */
export const useToast = () => useContext(ToastContext).toast;
