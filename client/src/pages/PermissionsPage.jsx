import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../toast.jsx';
import { POSITION_LABELS, stampText } from '../labels.js';
import ConfirmButton from '../components/ConfirmButton.jsx';

const GROUPS = [
  { key: 'menu', label: 'เมนูที่เข้าได้', hint: 'ปิดแล้วเมนูหายจากแถบซ้าย และเข้าหน้านั้นไม่ได้' },
  { key: 'sensitive', label: 'งานอ่อนไหว', hint: 'เรื่องเงินและหลักฐาน — กันที่ระบบหลังบ้านด้วย ไม่ใช่แค่ซ่อนปุ่ม' },
];

/* ไอคอนเส้นของแต่ละสิทธิ์ — ชุดเดียวกับเมนูซ้าย (NAV_ICONS ใน App.jsx) จะได้จำได้ว่าสวิตช์ไหนคือเมนูไหน */
const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>,
  cases: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6M9 16h6" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /></>,
  attendance: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></>,
  invoices: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6" /></>,
  payroll: <><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20M16 15h2" /></>,
  revenue: <><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>,
  packages: <><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /></>,
  customers: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3" /></>,
  patients: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" />,
  employees: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  reviews: <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />,
  see_pay: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  invoice_adjust: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 15h6" /></>,
  slip_delete: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></>,
};
const ROLE_ICON = <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>;

function Icon({ children, className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const posLabel = (p) => POSITION_LABELS[p] ?? p;

/**
 * จัดการสิทธิ์ — หน้าละตำแหน่ง (Super Admin · ผู้จัดการ · server/src/permissions/routes.js)
 *
 * การ์ดด้านซ้ายเลือกตำแหน่ง (จำไว้ใน ?position= ให้รีเฟรช/ส่งลิงก์แล้วกลับมาที่เดิม) · มือถือเรียงเป็นแถวเลื่อนข้าง
 * ด้านขวาเป็นสิทธิ์ของตำแหน่งนั้นเป็นการ์ดย่อยมีสวิตช์ แบ่งสองกลุ่ม (เมนู · งานอ่อนไหว) แล้วกดบันทึกครั้งเดียวท้ายหน้า
 * Super Admin มีครบเสมอ (สวิตช์ล็อก) — กันไม่ให้ระบบเหลือคนที่เข้าหน้านี้ไม่ได้
 * ตั้งแล้วมีผลกับทุกคนในตำแหน่งนั้นภายใน ~15 วินาที (ผู้ใช้ต้องรีเฟรชหน้าให้เมนูเปลี่ยนตาม)
 */
export default function PermissionsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null); // Set(keys) ที่ยังไม่บันทึกของตำแหน่งที่เปิดอยู่
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.permissions().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">กำลังโหลด…</p>;

  const positions = data.positions;
  const total = data.catalog.length;
  const selectedKey = positions.some((p) => p.position === params.get('position'))
    ? params.get('position')
    : positions.find((p) => p.editable)?.position ?? positions[0].position;
  const pos = positions.find((p) => p.position === selectedKey);
  const current = draft ?? new Set(pos.permissions);
  const dirty = draft != null
    && (draft.size !== pos.permissions.length || pos.permissions.some((k) => !draft.has(k)));

  function pick(position) {
    if (position === selectedKey) return;
    setDraft(null);
    setError(null);
    setParams({ position }, { replace: true });
  }

  function setKeys(keys, on) {
    if (!pos.editable) return;
    const next = new Set(current);
    for (const k of keys) if (on) next.add(k); else next.delete(k);
    setDraft(next);
  }

  async function run(action, done) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      setData((d) => ({ ...d, positions: res.positions }));
      setDraft(null);
      toast(done);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="sr-only">จัดการสิทธิ์</h1>
      <div className="list-card perm-card">
        <div className="perm-layout">
          {/* การ์ดเลือกตำแหน่งด้านข้าง — สลับแล้วการเปลี่ยนที่ยังไม่บันทึกของตำแหน่งเดิมถูกทิ้ง */}
          <nav className="perm-cards" aria-label="ตำแหน่ง">
            <p className="perm-cards-title">ตำแหน่ง</p>
            {positions.map((p) => {
              const on = p.position === selectedKey;
              const pct = Math.round((p.permissions.length / total) * 100);
              return (
                <button
                  key={p.position}
                  type="button"
                  aria-current={on ? 'true' : undefined}
                  className={`perm-card-btn${on ? ' is-on' : ''}`}
                  onClick={() => pick(p.position)}
                >
                  <span className="perm-avatar"><Icon className="perm-avatar-ico">{ROLE_ICON}</Icon></span>
                  <span className="perm-card-text">
                    <span className="perm-card-name">
                      {posLabel(p.position)}
                      {p.customized && <span className="perm-tab-dot" title="ปรับจากค่าตั้งต้นแล้ว" aria-label="ปรับแล้ว" />}
                    </span>
                    <span className="perm-card-meta">
                      {p.editable ? `${p.permissions.length} จาก ${total} สิทธิ์` : 'ครบทุกสิทธิ์ · ล็อก'}
                    </span>
                    <span className="perm-card-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="perm-body" aria-label={`สิทธิ์ของ ${posLabel(pos.position)}`}>
            <header className="perm-hero">
              <span className="perm-avatar is-lg"><Icon className="perm-avatar-ico">{ROLE_ICON}</Icon></span>
              <div className="perm-hero-text">
                <h2>{posLabel(pos.position)}</h2>
                <p className="muted">
                  {pos.editable
                    ? (pos.customized ? 'ปรับจากค่าตั้งต้นแล้ว' : 'ใช้ค่าตั้งต้น')
                    : 'มีสิทธิ์ครบทุกอย่างเสมอ แก้ไม่ได้ — กันไม่ให้ระบบเหลือคนที่เข้าหน้าจัดการสิทธิ์ไม่ได้'}
                  {pos.updated_at && ` · แก้ล่าสุด ${stampText(pos.updated_at)}${pos.updated_by_name ? ` โดย ${pos.updated_by_name}` : ''}`}
                </p>
              </div>
              <div className="perm-count" aria-label={`เปิด ${current.size} จาก ${total} สิทธิ์`}>
                <strong>{current.size}</strong><span>/{total}</span>
                <small>สิทธิ์ที่เปิด</small>
              </div>
            </header>

            {error && <p className="error">{error}</p>}

            {GROUPS.map((g) => {
              const items = data.catalog.filter((c) => c.group === g.key);
              const keys = items.map((i) => i.key);
              const onInGroup = keys.filter((k) => current.has(k)).length;
              return (
                <section key={g.key} className="perm-section">
                  <div className="perm-section-head">
                    <div>
                      <h3>{g.label} <span className="perm-section-count">{onInGroup}/{keys.length}</span></h3>
                      <p className="muted perm-section-hint">{g.hint}</p>
                    </div>
                    {pos.editable && (
                      <div className="perm-bulk">
                        <button type="button" className="btn link-btn" disabled={busy || onInGroup === keys.length}
                          onClick={() => setKeys(keys, true)}>เปิดทั้งหมด</button>
                        <button type="button" className="btn link-btn" disabled={busy || onInGroup === 0}
                          onClick={() => setKeys(keys, false)}>ปิดทั้งหมด</button>
                      </div>
                    )}
                  </div>
                  <ul className="perm-grid">
                    {items.map((item) => {
                      const id = `perm-${pos.position}-${item.key}`;
                      const on = current.has(item.key);
                      return (
                        <li key={item.key}>
                          <label htmlFor={id} className={`perm-tile${on ? ' is-on' : ''}${pos.editable ? '' : ' is-locked'}`}>
                            <span className="perm-tile-ico"><Icon>{ICONS[item.key]}</Icon></span>
                            <span className="perm-text">
                              <span className="perm-label">{item.label}</span>
                              {item.hint && <span className="cell-sub">{item.hint}</span>}
                            </span>
                            {/* สวิตช์ = checkbox จริง (คีย์บอร์ด/โปรแกรมอ่านหน้าจอใช้ได้) วาดเป็นสวิตช์ด้วย CSS */}
                            <input
                              id={id}
                              type="checkbox"
                              role="switch"
                              className="perm-check"
                              checked={on}
                              disabled={!pos.editable || busy}
                              onChange={() => setKeys([item.key], !on)}
                            />
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>

        {pos.editable && (
          <div className={`perm-foot${dirty ? ' is-dirty' : ''}`}>
            {pos.customized && (
              <ConfirmButton
                className="btn"
                disabled={busy}
                title={`คืนค่าตั้งต้นของ ${posLabel(pos.position)}?`}
                detail="กลับไปใช้สิทธิ์ชุดเดิมของตำแหน่งนี้ (ก่อนมีหน้าจัดการสิทธิ์)"
                confirmLabel="คืนค่าตั้งต้น"
                cancelLabel="ไม่คืนแล้ว"
                onConfirm={() => run(() => api.resetPermissions(pos.position), `คืนค่าตั้งต้นของ ${posLabel(pos.position)} แล้ว`)}
              >
                คืนค่าตั้งต้น
              </ConfirmButton>
            )}
            {dirty && <span className="perm-foot-note">มีการเปลี่ยนที่ยังไม่บันทึก</span>}
            <div className="perm-foot-right">
              {dirty && (
                <button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>
                  ยกเลิกการเปลี่ยน
                </button>
              )}
              <ConfirmButton
                className="btn primary"
                danger={false}
                disabled={!dirty || busy}
                title={`บันทึกสิทธิ์ของ ${posLabel(pos.position)}?`}
                detail={pos.position === user.position
                  ? 'นี่คือตำแหน่งของคุณเอง — ถ้าปิดเมนูไหน คุณจะเข้าเมนูนั้นไม่ได้หลังรีเฟรช (หน้าจัดการสิทธิ์ยังเข้าได้เสมอ)'
                  : 'มีผลกับทุกคนในตำแหน่งนี้ทันทีที่เขารีเฟรชหน้า'}
                confirmLabel="บันทึก"
                cancelLabel="ยังไม่บันทึก"
                onConfirm={() => run(
                  () => api.savePermissions(pos.position, [...current]),
                  `บันทึกสิทธิ์ของ ${posLabel(pos.position)} แล้ว — ผู้ใช้ตำแหน่งนี้รีเฟรชหน้าแล้วเห็นผล`,
                )}
              >
                {busy ? 'กำลังบันทึก…' : 'บันทึก'}
              </ConfirmButton>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
