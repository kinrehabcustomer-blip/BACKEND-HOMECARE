import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import LineIcon from './LineIcon.jsx';
import { todayTH } from '../labels.js';
import { useVisiblePoll } from '../lib/poll.js';

/* ดึงใหม่ทุก 2 นาที (เฉพาะตอนแอปเปิดอยู่บนจอ — ดู lib/poll.js) + ทุกครั้งที่เปลี่ยนหน้า */
const REFRESH_MS = 2 * 60_000;
const GAP = 8;

/** "จ. 10 พ.ย." — วันที่ของกะเป็น 'YYYY-MM-DD' ตามเวลาไทย */
const dayText = (d) =>
  d ? new Date(`${d}T00:00:00+07:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const whenText = (d, start) => `${dayText(d)}${start ? ` ${start} น.` : ''}`;

/** ข้อความของแต่ละชนิด — server เก็บแค่ข้อมูล (notify/staffInbox.js) ถ้อยคำอยู่ที่นี่ที่เดียว */
function describe(n) {
  const p = n.payload ?? {};
  const who = p.client ?? 'ผู้รับบริการ';
  switch (n.kind) {
    case 'visits_added':
      return {
        icon: 'calendar',
        title: p.total > 1 ? `กะใหม่ ${p.total} กะ` : 'กะใหม่',
        body: `${who} · ${whenText(p.date, p.start)}${p.total > 1 && p.last_date !== p.date ? ` ถึง ${dayText(p.last_date)}` : ''}`,
      };
    case 'visit_moved':
      return { icon: 'calendar', title: 'กะถูกเลื่อน', body: `${who} · ${whenText(p.old_date, p.old_start)} → ${whenText(p.date, p.start)}` };
    case 'visit_cancelled':
      return { icon: 'close', title: 'กะถูกยกเลิก', body: `${who} · ${whenText(p.date, p.start)}`, urgent: true };
    case 'visit_removed':
      return { icon: 'close', title: 'กะถูกย้ายไปให้คนอื่น', body: `${who} · ${whenText(p.date, p.start)}`, urgent: true };
    case 'remind_day':
      return { icon: 'bell', title: 'พรุ่งนี้มีกะ', body: `${who} · ${whenText(p.date, p.start)}` };
    case 'remind_3h':
      return { icon: 'bell', title: 'ใกล้ถึงเวลากะ', body: `${who} · เริ่ม ${p.start} น.` };
    default:
      return { icon: 'bell', title: 'แจ้งเตือน', body: who };
  }
}

/** กดแจ้งเตือนแล้วไปไหน — กะวันนี้ไปหน้างานวันนี้ (เช็คอินได้เลย) ที่เหลือไปตารางงาน */
const targetOf = (n) => (n.payload?.date === todayTH() && !['visit_cancelled', 'visit_removed'].includes(n.kind) ? '/my-today' : '/my-calendar');

function agoText(at) {
  const mins = Math.floor((Date.now() - new Date(at).getTime()) / 60_000);
  if (mins < 1) return 'เมื่อสักครู่';
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} ชม.ที่แล้ว`;
  return new Date(at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}

/**
 * กระดิ่งแจ้งเตือนของพนักงานภาคสนาม (ผู้ใช้ขอ 9 พ.ย. 2569) — กะใหม่ / เลื่อน / ยกเลิก / เตือนก่อนถึงกะ
 * คนละตัวกับ NotificationBell ของหลังบ้าน (ตัวนั้นนับของค้างทั้งระบบ — พนักงานเรียกไม่ได้)
 *
 * เปิดกล่อง = ถือว่าอ่านแล้วทั้งหมด (เลขแดงหายทันที) แต่ในกล่องรอบนี้ยังไฮไลต์อันที่เพิ่งมาให้เห็นว่าอันไหนใหม่
 */
export default function StaffBell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [freshIds, setFreshIds] = useState(() => new Set()); // อันที่ยังไม่อ่านตอนเปิดกล่องรอบนี้
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const load = useCallback(() => api.myNotifications().then(setData).catch(() => {}), []);
  useVisiblePoll(load, REFRESH_MS, location.pathname);
  useEffect(() => setOpen(false), [location.pathname]);

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
    const close = (e) => {
      if (e?.type === 'scroll' && panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onClickAway);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onClickAway);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  if (!data) return null;
  const items = data.items ?? [];

  const toggle = () => {
    if (open) return setOpen(false);
    /* ตำแหน่ง: จอกว้างกางข้างแถบเมนู · จอแคบกางลงใต้ปุ่ม ชิดขวา (แบบเดียวกับกระดิ่งหลังบ้าน) */
    const r = btnRef.current.getBoundingClientRect();
    const sidebar = btnRef.current.closest('.sidebar')?.getBoundingClientRect();
    const desktop = window.matchMedia('(min-width: 901px)').matches && sidebar;
    const leftEdge = desktop ? sidebar.right + GAP : GAP;
    const width = Math.min(336, window.innerWidth - leftEdge - GAP);
    const left = desktop ? leftEdge : Math.max(GAP, Math.min(r.right - width, window.innerWidth - width - GAP));
    const top = desktop ? Math.max(GAP, r.top) : r.bottom + GAP;
    setPos({ width, left, top, maxHeight: Math.min(window.innerHeight * 0.7, window.innerHeight - top - GAP * 2) });

    setFreshIds(new Set(items.filter((n) => !n.read_at).map((n) => n.id)));
    setOpen(true);
    if (data.unread > 0) {
      setData((d) => ({ ...d, unread: 0, items: d.items.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })) }));
      api.readMyNotifications().catch(() => {});
    }
    return undefined;
  };

  const go = (n) => {
    setOpen(false);
    navigate(targetOf(n));
  };

  return (
    <div className="bell">
      <button
        type="button"
        ref={btnRef}
        className="btn icon-btn bell-btn"
        aria-expanded={open}
        aria-label={data.unread > 0 ? `แจ้งเตือน ${data.unread} รายการใหม่` : 'แจ้งเตือน'}
        title="แจ้งเตือน"
        onClick={toggle}
      >
        <LineIcon name="bell" />
        {data.unread > 0 && <span className="bell-count">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>

      {/* portal ไปที่ body — เหตุผลเดียวกับ NotificationBell (.sidebar เป็น scroll container ตัดกล่องที่ล้นออกไป) */}
      {open && createPortal(
        <div
          className="bell-panel staff-bell-panel"
          role="dialog"
          aria-label="การแจ้งเตือน"
          ref={panelRef}
          style={{ width: pos.width, left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
        >
          <h2 className="bell-panel-title">การแจ้งเตือน</h2>
          {items.length === 0 ? (
            <p className="bell-empty">
              <LineIcon name="check" className="text-ico" />
              ยังไม่มีการแจ้งเตือน
            </p>
          ) : (
            items.map((n) => {
              const d = describe(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`staff-note${freshIds.has(n.id) ? ' is-new' : ''}${d.urgent ? ' is-urgent' : ''}`}
                  onClick={() => go(n)}
                >
                  <span className="staff-note-ico" aria-hidden="true"><LineIcon name={d.icon} /></span>
                  <span className="staff-note-main">
                    <strong>{d.title}</strong>
                    <span className="staff-note-body">{d.body}</span>
                    <span className="staff-note-time">{agoText(n.created_at)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
