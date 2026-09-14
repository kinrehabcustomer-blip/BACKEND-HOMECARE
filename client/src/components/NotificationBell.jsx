import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import LineIcon from './LineIcon.jsx';
import { ALERT_GROUPS } from '../lib/alertDefs.js';

/* ดึงใหม่ทุกๆ กี่นาที — ของค้างพวกนี้เปลี่ยนระดับ "วันละไม่กี่ครั้ง" ไม่ใช่วินาทีต่อวินาที
   ถี่กว่านี้คือยิง query นับทั้งระบบซ้ำโดยไม่ได้อะไรเพิ่ม (แต่ละครั้งนับสิบกว่าตาราง) */
const REFRESH_MS = 5 * 60_000;

/** ความกว้างที่ต้องการของกล่อง (21rem) — จอแคบกว่านี้จะถูกย่อลงตามจอ */
const PANEL_W = 336;
/** ระยะห่างจากปุ่ม/ขอบจอ */
const GAP = 8;

/**
 * กระดิ่งแจ้งเตือนบนแถบเมนู — ของค้างของ 4 หน้าที่ต้องมีคนทำอะไรต่อ
 *
 * มีอยู่เพราะของค้างในระบบนี้ "เงียบ" เกือบทั้งหมด: เคสที่ยังไม่จับคู่ ใบร่างที่ลืมออก
 * เงินที่ปิดเคสแล้วแต่ไม่มีใครกดปล่อย — ไม่มีอะไรบนหน้าจอฟ้องจนกว่าจะมีคนเปิดไปดูเอง
 * อีเมลสรุปประจำวันแก้ปัญหานี้ไปครึ่งทาง (ส่งวันละครั้ง ตอน 08:00) กระดิ่งคืออีกครึ่ง
 * สำหรับของที่เกิดขึ้นระหว่างวัน
 *
 * ตัวเลขทุกตัวมาจาก /api/notify/alerts ซึ่งเรียก repo ของหน้าที่มันชี้ไป — ไม่ได้นับเองที่นี่
 */
export default function NotificationBell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  /* ตำแหน่งกล่องคิดจากตำแหน่งจริงของปุ่มตอนกด — ต้องคิดเอง เพราะกล่องถูกย้ายไปอยู่ที่
     document.body แล้ว (ดูเหตุผลที่ createPortal ด้านล่าง) จึงไม่มีพ่อให้ยึดตำแหน่งอีก */
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const load = useCallback(
    () => api.alerts().then(setData).catch(() => setData(null)),
    [],
  );

  /* โหลดตอนเปิดแอป แล้วตั้งเวลาดึงซ้ำ · ดึงใหม่ตอนเปลี่ยนหน้าด้วย เพราะคนมักเปลี่ยนหน้า
     "เพื่อไปเคลียร์ของค้าง" — กลับมาแล้วตัวเลขต้องลดลงจริง ไม่ใช่ค้างเลขเดิมอีกห้านาที */
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    setOpen(false); // เปลี่ยนหน้าแล้วพับกล่องเอง ไม่งั้นมันค้างบังเนื้อหาที่เพิ่งกดเข้าไปดู
    load();
  }, [location.pathname, location.search, load]);

  /* Esc และการกดที่อื่น = ปิด — ทางออกมาตรฐานของทุกอย่างที่กางทับหน้าจอในระบบนี้
     (ใช้ช่วง capture เพื่อไม่ให้ชนกับตัวจัดการ Esc ของเมนูด้านข้างบนจอแคบ)

     การกดที่อื่นต้องยกเว้น "ในกล่อง" ด้วย ไม่ใช่แค่ในปุ่ม — กล่องอยู่นอก DOM ของปุ่มแล้ว
     ถ้าเช็คแต่ปุ่ม การกดแถวในกล่องจะถูกนับเป็นกดที่อื่น กล่องหลุดออกจากจอตอน mousedown
     แล้ว click ที่ตามมาไม่มีปลายทางให้ลง — กลายเป็นกระดิ่งที่กดแถวแล้วไม่ไปไหน

     ปิดตอนย่อ/ขยายจอด้วย เพราะตำแหน่งถูกคิดไว้ตอนกดครั้งเดียว ไม่ได้ตามขนาดจอ */
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    const onClickAway = (e) => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onClickAway);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onClickAway);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // ยังไม่รู้ว่ามีอะไรค้าง (กำลังโหลด/โหลดไม่สำเร็จ) = ไม่ต้องมีกระดิ่ง
  // กระดิ่งที่ขึ้นเลข 0 ค้างไว้ตอนโหลดพลาด อ่านว่า "เคลียร์หมดแล้ว" ซึ่งเป็นคำตอบที่ผิด
  if (!data) return null;

  /* ตัดเรื่องที่เป็นศูนย์ทิ้ง — รายการที่ยาวเท่ากันทุกวันโดยส่วนใหญ่เป็น 0
     ทำให้คนเลิกกวาดตาหาเลขที่ไม่ใช่ศูนย์ · ในนี้เหลือแต่ "ของที่ต้องทำ" จริงๆ */
  const groups = ALERT_GROUPS.map((g) => ({
    ...g,
    rows: g.items
      .map((item) => ({ ...item, count: data.groups[g.key]?.[item.key] ?? 0 }))
      .filter((item) => item.count > 0),
  })).filter((g) => g.rows.length > 0);

  const go = (to) => {
    setOpen(false);
    navigate(to);
  };

  /* กางกล่อง = วัดตำแหน่งปุ่มก่อน แล้วเลือกทิศตามที่ว่างจริง ไม่ยึดทิศตายตัว
     ปุ่มอยู่แถวบนสุดของแถบเมนู จึงกางลงเป็นปกติ — แต่บนจอเตี้ย/แนวนอนที่ด้านล่างไม่พอ
     ต้องกางขึ้นแทน ไม่งั้นรายการล่างๆ หลุดจอไปโดยไม่มีอะไรบอกว่ายังมีต่อ
     (หนีบ left ไม่ให้ล้นขอบขวาด้วย — กล่องกว้างกว่าแถบเมนู) */
  const toggle = () => {
    if (open) return setOpen(false);

    const r = btnRef.current.getBoundingClientRect();
    /* ความกว้างคิดที่นี่แล้วส่งเป็น inline style — ห้ามให้ CSS กำหนดกว้างเองแล้ว JS
       เดาเอาอีกที เพราะตัวหนีบ left ต้องใช้ "ความกว้างจริง" ของกล่อง
       เคยแยกกันแล้วพลาด: CSS ย่อกล่องเป็น 100vw−1rem บนจอแคบ แต่ JS ยังหนีบด้วย 21rem
       กล่องจึงล้นขอบขวาไปครึ่งนิ้ว แล้วตัวเลขฝั่งขวาถูกเฉือนหายทั้งคอลัมน์ */
    const width = Math.min(PANEL_W, window.innerWidth - GAP * 2);
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - width - GAP));
    const below = window.innerHeight - r.bottom;

    setPos(
      below >= r.top || below > 320
        ? { width, left, top: r.bottom + GAP }
        : { width, left, bottom: window.innerHeight - r.top + GAP },
    );
    return setOpen(true);
  };

  return (
    <div className="bell">
      <button
        type="button"
        ref={btnRef}
        className="btn icon-btn bell-btn"
        aria-expanded={open}
        aria-label={data.total > 0 ? `แจ้งเตือน ${data.total} รายการ` : 'แจ้งเตือน — ไม่มีของค้าง'}
        title="แจ้งเตือน"
        onClick={toggle}
      >
        <LineIcon name="bell" />
        {/* เลขบนกระดิ่งคือยอดรวมที่ server คิดมา ไม่ได้บวกเองที่หน้าเว็บ
            เกิน 99 ใส่ + เพราะความกว้างของป้ายคุมได้ และ "เยอะมาก" ก็พอตัดสินใจได้แล้ว */}
        {data.total > 0 && (
          <span className="bell-count">{data.total > 99 ? '99+' : data.total}</span>
        )}
      </button>

      {/* ย้ายกล่องไปไว้ที่ document.body — .sidebar ตั้ง overflow-y: auto ไว้ (เผื่อเมนูสูงเกินจอ)
          ซึ่งทำให้มันเป็น scroll container แล้วตัดแกน X ด้วย กล่องที่ล้นออกไปทางขวา
          จึงถูกเฉือนหายที่ขอบแถบเมนู · เหตุผลเดียวกับที่ ConfirmButton ใช้ createPortal */}
      {open && createPortal(
        <div
          className="bell-panel"
          role="dialog"
          aria-label="ของค้างในระบบ"
          ref={panelRef}
          style={{ width: pos.width, left: pos.left, top: pos.top, bottom: pos.bottom }}
        >
          {groups.length === 0 ? (
            <p className="bell-empty">
              <LineIcon name="check" className="text-ico" />
              ไม่มีของค้าง
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="bell-group">
                <h3>{g.label}</h3>
                {g.rows.map((item) => (
                  /* ทั้งแถวกดได้และพาไปถึงของจริงพร้อมตัวกรองที่ถูก — แจ้งเตือนที่บอกแค่จำนวน
                     แล้วให้ไปหาเองคือขั้นตอนที่เพิ่มมาโดยไม่ได้ช่วยอะไร */
                  <button
                    key={item.key}
                    type="button"
                    className={`bell-row ${item.urgent ? 'is-urgent' : ''}`}
                    onClick={() => go(item.to)}
                  >
                    <span className="bell-row-main">
                      <strong>{item.label}</strong>
                      <span className="bell-row-hint">{item.hint}</span>
                    </span>
                    <span className="bell-row-count">{item.count}</span>
                  </button>
                ))}
              </section>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
