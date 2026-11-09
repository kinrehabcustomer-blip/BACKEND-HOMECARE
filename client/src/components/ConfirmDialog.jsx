import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../lib/scrollLock.js';

/**
 * กล่องยืนยันของระบบ — แทน window.confirm() ที่เด้งเป็นกล่อง "localhost:5173 บอกว่า" ของเบราว์เซอร์
 * (ผู้ใช้ขอ 9 พ.ย. 2569 "ทำเป็น ui")
 *
 *   const ask = useConfirm();
 *   if (!(await ask({ title: 'ปิดเคส?', items: ['…'], confirmLabel: 'ปิดเคส', danger: true }))) return;
 *
 * เหตุผลเดียวกับ ConfirmButton: confirm() ถูกบล็อกได้แล้วคืน false เงียบๆ (ปุ่มกดไม่ติดโดยไม่มีอะไรบอก)
 * และเป็นตัวหนังสือล้วน จัดหัวข้อ/รายการไม่ได้ · ตัวนี้เรียกจากโค้ดได้ (คืน Promise<boolean>)
 * เหมาะกับจุดที่ต้องถามกลางทาง เช่น server ตีกลับมาว่า "ข้อมูลยังไม่ครบ จะทำต่อไหม"
 *
 * ปุ่มปลอดภัย (ยกเลิก) รับโฟกัสก่อน · Esc / แตะฉากหลัง = ยกเลิก · วาดที่ document.body (ดู ConfirmButton)
 */
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null); // { title, detail, items, confirmLabel, cancelLabel, danger, resolve }
  const cancelRef = useRef(null);

  const ask = useCallback(
    (opts) =>
      new Promise((resolve) => {
        const o = typeof opts === 'string' ? { title: opts } : opts;
        setReq({ ...o, resolve });
      }),
    [],
  );

  const answer = useCallback((value) => {
    setReq((cur) => {
      cur?.resolve(value);
      return null;
    });
  }, []);

  useScrollLock(Boolean(req));

  useEffect(() => {
    if (!req) return undefined;
    cancelRef.current?.focus();
    // Esc ปิดเฉพาะกล่องนี้ ไม่ให้ popup แม่ข้างหลังปิดตามไปด้วย (ดักช่วง capture แล้วหยุด)
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      answer(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [req, answer]);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {req &&
        createPortal(
          <div className="modal-backdrop modal-stacked" onClick={() => answer(false)}>
            <div
              className="modal modal-narrow confirm-box"
              role="alertdialog"
              aria-modal="true"
              aria-label={req.title}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-body confirm-body">
                <h2>{req.title}</h2>
                {req.detail && <p className="muted">{req.detail}</p>}
                {req.items?.length > 0 && (
                  <ul className={`confirm-items${req.itemsTone === 'warn' ? ' is-warn' : ''}`}>
                    {req.items.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                )}
                {req.note && <p className="muted confirm-note">{req.note}</p>}
              </div>
              <footer className="modal-foot">
                <button type="button" className="btn" ref={cancelRef} onClick={() => answer(false)}>
                  {req.cancelLabel ?? 'ยกเลิก'}
                </button>
                <button type="button" className={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={() => answer(true)}>
                  {req.confirmLabel ?? 'ยืนยัน'}
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmContext.Provider>
  );
}

/** คืนฟังก์ชัน ask(opts) → Promise<boolean> · opts เป็นข้อความเฉยๆ ก็ได้ (ใช้เป็นหัวข้อ) */
export function useConfirm() {
  const ask = useContext(ConfirmContext);
  // ไม่มี Provider (เช่นในเทสต์) — ถอยไปใช้กล่องของเบราว์เซอร์ ดีกว่าโยน error ทั้งหน้า
  return ask ?? ((o) => Promise.resolve(window.confirm(typeof o === 'string' ? o : [o.title, o.detail, ...(o.items ?? [])].filter(Boolean).join('\n'))));
}

/** ออกจากฟอร์มที่ยังไม่บันทึก — ข้อความชุดเดียวกันทุกฟอร์ม · ปุ่มปลอดภัยคือ "อยู่ต่อ" */
export const LEAVE_UNSAVED = {
  title: 'ยังไม่ได้บันทึก — ออกจากหน้านี้เลยไหม?',
  detail: 'ข้อมูลที่กรอกหรือแก้ไว้จะหาย',
  cancelLabel: 'อยู่ต่อ',
  confirmLabel: 'ออกโดยไม่บันทึก',
  danger: true,
};
