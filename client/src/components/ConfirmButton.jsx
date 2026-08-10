import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../lib/scrollLock.js';

/**
 * ปุ่มที่ต้องยืนยันก่อนทำงาน — ใช้แทน confirm() ของเบราว์เซอร์
 *
 * confirm() ถูกบล็อกได้ (คนใช้ติ๊ก "ไม่ให้หน้านี้สร้างกล่องอีก" หรือบนมือถือบางตัว)
 * พอโดนบล็อกมันคืน false เงียบๆ ปุ่มลบเลยกดแล้วไม่เกิดอะไรขึ้นเลย ไม่ยิง API ไม่มีข้อความ
 * เหมือนปุ่มเสีย — เป็นเหตุผลเดียวกับที่ฟอร์มรับชำระเงินและยกเลิกเคสย้ายออกจาก prompt() ไปแล้ว
 * และข้อความใน confirm() เป็นตัวหนังสือล้วน จัดรูปแบบไม่ได้ ชื่อของที่กำลังจะลบจึงเน้นให้เห็นไม่ได้เลย
 *
 * ใช้ createPortal ออกไปที่ document.body ไม่ใช่วาดตรงที่ปุ่มอยู่ — ปุ่มลบหลายตัวอยู่ในแถวตาราง
 * หรือใน popup ซึ่งบนจอแคบ .modal มี transform อยู่ ([index.css] แผ่นเลื่อนขึ้นจากขอบล่าง)
 * element ที่ position: fixed ข้างในจะยึด .modal เป็นกรอบแทนหน้าจอ กล่องยืนยันจะไปโผล่ผิดที่
 */
export default function ConfirmButton({
  children,
  className = 'btn danger-ghost',
  disabled = false,
  title,
  detail,
  confirmLabel = 'ยืนยัน',
  cancelLabel = 'ไม่ลบแล้ว',
  danger = true,
  onConfirm,
  ...buttonProps
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(null);

  // ล็อกเฉพาะตอนกล่องยืนยันกางอยู่ · ตัวนับชั้นดูแลกรณีเปิดซ้อนบน popup แม่ให้แล้ว
  useScrollLock(open);

  useEffect(() => {
    if (!open) return undefined;

    // ปุ่มปลอดภัยรับโฟกัสไว้ก่อน — เคาะ Enter ทันทีโดยไม่ทันอ่านจะได้ไม่ลบของทิ้ง
    cancelRef.current?.focus();

    /* Esc ต้องปิดเฉพาะกล่องนี้ ไม่ใช่ปิด popup แม่ที่อยู่ข้างหลังไปด้วย
       ดักที่ช่วง capture แล้วหยุดการส่งต่อ — ตัวจัดการของ popup แม่ผูกไว้ที่ document ช่วง bubble
       ซึ่งทำงานทีหลัง จึงไม่ได้รับ event นี้เลย (ถ้าผูกช่วงเดียวกันจะแพ้เพราะแม่ลงทะเบียนก่อน) */
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || running) return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, running]);

  async function run() {
    setRunning(true);
    try {
      await onConfirm();
    } finally {
      // ปิดกล่องไม่ว่าจะสำเร็จหรือไม่ — ถ้าล้มเหลว ข้อความ error อยู่บนหน้าที่เรียกใช้ ซึ่งกล่องนี้บังอยู่
      setRunning(false);
      setOpen(false);
    }
  }

  return (
    <>
      {/* spread ไว้ก่อน onClick — ผู้เรียกส่ง title/aria มาเพิ่มได้ แต่ต้องแย่ง onClick ไปไม่ได้
          ไม่งั้นปุ่มจะทำงานทันทีโดยข้ามกล่องยืนยัน ซึ่งเป็นสิ่งเดียวที่คอมโพเนนต์นี้มีหน้าที่กัน */}
      <button type="button" className={className} disabled={disabled} {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </button>

      {open &&
        createPortal(
          <div className="modal-backdrop modal-stacked" onClick={() => !running && setOpen(false)}>
            <div
              className="modal modal-narrow confirm-box"
              role="alertdialog"
              aria-modal="true"
              aria-label={title}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-body confirm-body">
                <h2>{title}</h2>
                {detail && <p className="muted">{detail}</p>}
              </div>
              <footer className="modal-foot">
                <button type="button" className="btn" ref={cancelRef} disabled={running} onClick={() => setOpen(false)}>
                  {cancelLabel}
                </button>
                <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={running} onClick={run}>
                  {running ? 'กำลังดำเนินการ…' : confirmLabel}
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
