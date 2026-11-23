import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useScrollLock } from '../lib/scrollLock.js';
import { useToast } from '../toast.jsx';
import { POSITION_LABELS, formatDate, todayTH } from '../labels.js';
import { timeRange } from '../lib/calendarUi.js';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';

/**
 * หัวหน้าพาร์ทเนอร์ — ทีมของฉัน (21 พ.ย. 2569)
 * เพิ่มคนเองได้ (ชื่อ · เบอร์ · ตำแหน่งหน้างาน) → ได้รหัสพนักงานอัตโนมัติ · เข้าครั้งแรกด้วยรหัสเริ่มต้นแล้วระบบบังคับตั้งรหัสใหม่
 * แก้ชื่อ/ชื่อเล่น/เบอร์/ตำแหน่งของคนในทีมได้ (ผู้ใช้ขอ 23 พ.ย. 2569) — เพิ่ม/แก้ใช้ popup กลางจอใบเดียวกัน
 * ปิดบัญชีคนที่ออก — ปุ่มอยู่ใน popup แก้ไข (ผู้ใช้ขอ 23 พ.ย. 2569 · ยังถือกะข้างหน้าอยู่ปิดไม่ได้ — server ตอบเหตุผล)
 * บัญชีหัวหน้าแก้จากหลังบ้าน KIN
 * แตะแถว = ดูรายละเอียดคนนั้น (ข้อมูลบัญชี + กะที่บริษัทให้ไป · ผู้ใช้ขอ 23 พ.ย. 2569)
 */
const EMPTY = { first_name: '', last_name: '', nickname: '', phone: '', email: '', position: 'therapist' };

export default function PartnerTeamPage() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // คนที่กำลังแก้ (null = ฟอร์มเพิ่มคนใหม่)
  const [viewing, setViewing] = useState(null);  // คนที่เปิดดูรายละเอียด
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    return api.partnerTeam().then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const body = { ...form, nickname: form.nickname || null, phone: form.phone || null, email: form.email.trim() || null };
      if (editing) {
        const p = await api.partnerUpdatePerson(editing.employee_id, body);
        toast(`บันทึกข้อมูล ${p.first_name ?? form.first_name} แล้ว`);
      } else {
        const p = await api.partnerAddPerson(body);
        toast(`เพิ่ม ${p.first_name} แล้ว — เข้าระบบด้วย ${p.employee_id}${p.email ? ` หรือ ${p.email}` : ''} · รหัสผ่านเริ่มต้น 12345678 (เข้าครั้งแรกต้องตั้งใหม่)`);
      }
      closeForm();
      load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const openAdd = () => { setEditing(null); setForm(EMPTY); setFormError(null); setAdding(true); };
  const openEdit = (p) => {
    setEditing(p);
    setForm({ first_name: p.first_name ?? '', last_name: p.last_name ?? '', nickname: p.nickname ?? '', phone: p.phone ?? '',
      email: p.email ?? '', position: p.position });
    setFormError(null);
    setAdding(true);
  };
  const closeForm = useCallback(() => { setAdding(false); setEditing(null); setForm(EMPTY); setFormError(null); }, []);
  const closeAccount = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await api.partnerUpdatePerson(editing.employee_id, { status: 'resigned' });
      toast(`ปิดบัญชี ${editing.first_name} แล้ว`);
      closeForm();
      load();
    } catch (err) {
      setFormError(err.message); // เช่น ยังมีกะข้างหน้า — โชว์ใน popup ที่เปิดอยู่
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (p, status) => {
    try {
      await api.partnerUpdatePerson(p.employee_id, { status });
      toast(status === 'resigned' ? `ปิดบัญชี ${p.first_name} แล้ว` : `เปิดบัญชี ${p.first_name} แล้ว`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const people = data?.people ?? [];
  const active = people.filter((p) => ['active', 'probation'].includes(p.status));
  const positions = data?.positions ?? [];

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      <div className="pt-page">
        <header className="pt-head">
          <div>
            <h1>ทีมของฉัน</h1>
            {data && <p className="muted">ใช้งานอยู่ {active.length} คน{people.length > active.length ? ` · ปิดแล้ว ${people.length - active.length}` : ''}</p>}
          </div>
          <button type="button" className="btn primary" onClick={openAdd}>+ เพิ่มคน</button>
        </header>

        <ErrorBar message={error} onRetry={load} busy={loading} />

        {!data ? (!error && <p className="muted">กำลังโหลด…</p>) : (
          <div className="pt-card pt-team">
            <div className="pt-member pt-team-head" aria-hidden="true">
              <span className="pt-avatar is-blank" />
              <span className="pt-member-main">ชื่อ</span>
              <span className="pt-col">ตำแหน่ง</span>
              <span className="pt-col">รหัสเข้าระบบ</span>
              <span className="pt-col is-num">เดือนนี้</span>
              <span className="pt-col-act">สถานะ</span>
            </div>
            {people.map((p) => {
              const on = ['active', 'probation'].includes(p.status);
              const lead = p.position === 'partner_lead';
              return (
                <div key={p.employee_id} className={`pt-member is-clickable${on ? '' : ' is-off'}`} role="button" tabIndex={0}
                  aria-label={`ดูรายละเอียด ${p.first_name} ${p.last_name}`}
                  onClick={(e) => { if (!e.target.closest('button, a')) setViewing(p); }}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setViewing(p); } }}>
                  <span className="pt-avatar" aria-hidden="true">{p.first_name?.[0] ?? '?'}</span>
                  <span className="pt-member-main">
                    <b>{p.first_name} {p.last_name}{p.nickname ? ` (${p.nickname})` : ''}</b>
                    <span className="muted pt-member-sub">
                      {POSITION_LABELS[p.position] ?? p.position} · <span className="mono">{p.employee_id}</span>
                      {!lead && on && ` · เดือนนี้ ${p.done_this_month} ครั้ง`}
                    </span>
                    {(p.phone || p.email) && <span className="muted pt-member-phone">{[p.phone, p.email].filter(Boolean).join(' · ')}</span>}
                  </span>
                  {/* คอลัมน์ของจอคอม (มือถือรวมอยู่ในบรรทัดรองด้านบน) */}
                  <span className="pt-col">{POSITION_LABELS[p.position] ?? p.position}</span>
                  <span className="pt-col mono">{p.employee_id}</span>
                  <span className="pt-col is-num">{lead ? '—' : `${p.done_this_month} ครั้ง`}</span>
                  <span className="pt-col-act">
                  {lead ? (
                    <span className="pt-tag is-muted">หัวหน้า</span>
                  ) : !on ? (
                    p.status === 'suspended'
                      // KIN ระงับไว้ — หัวหน้าเปิดคืนเองไม่ได้ (server กันด้วย · ตรวจ 23 พ.ย. 2569)
                      ? <span className="pt-tag is-warn">KIN ระงับ</span>
                      : <button type="button" className="btn tiny" onClick={() => setStatus(p, 'active')}>เปิดบัญชี</button>
                  ) : (
                    <>
                      {p.default_password && !p.last_login_at && <span className="pt-tag is-warn">รอเข้าครั้งแรก</span>}
                      {/* ปิดบัญชีอยู่ใน popup แก้ไข (23 พ.ย. 2569) — แถวเหลือปุ่มเดียว */}
                      <button type="button" className={`btn tiny${editing?.employee_id === p.employee_id ? ' is-on' : ''}`}
                        onClick={() => openEdit(p)} aria-label={`แก้ไขข้อมูล ${p.first_name}`}>แก้ไข</button>
                    </>
                  )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {viewing && (
        <PersonDetailDialog person={viewing} onCancel={() => setViewing(null)}
          onEdit={(p) => { setViewing(null); openEdit(p); }}
          onReopen={(p) => { setViewing(null); setStatus(p, 'active'); }} />
      )}
      {adding && (
        <PersonDialog editing={editing} form={form} set={set} positions={positions} busy={busy}
          error={formError} onSubmit={save} onCancel={closeForm} onCloseAccount={closeAccount} />
      )}
    </PageRefresh>
  );
}

const visitTag = (v) => {
  const past = v.visit_date < todayTH();
  if (v.status === 'cancelled') return { text: 'ยกเลิก', cls: 'is-muted' };
  if (v.check_out_at) return { text: 'ไปแล้ว', cls: 'is-ok' };
  if (v.check_in_at) return past ? { text: 'ยังไม่เช็คเอาท์', cls: 'is-warn' } : { text: 'กำลังทำงาน', cls: 'is-ok' };
  return past ? { text: 'ขาดงาน', cls: 'is-warn' } : { text: 'รอวันนัด', cls: 'is-once' };
};
const loginAt = (ts) => (ts ? `${formatDate(ts.slice(0, 10))} ${ts.slice(11, 16)} น.` : null);

function VisitList({ rows }) {
  return (
    <ul className="pt-pv-list">
      {rows.map((v) => {
        const t = visitTag(v);
        return (
          <li key={v.visit_id}>
            <span className="pt-pv-when">{formatDate(v.visit_date)}{timeRange(v) ? ` · ${timeRange(v)}` : ''}</span>
            <span className="pt-pv-what">{v.client_name}{v.service_name ? <span className="muted"> · {v.service_name}</span> : null}</span>
            <span className={`pt-tag ${t.cls}`}>{t.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** popup รายละเอียดคนในทีม — ข้อมูลบัญชี + กะที่บริษัทให้ไป (server: partners/repo.js personDetail) */
function PersonDetailDialog({ person, onCancel, onEdit, onReopen }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useScrollLock();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  useEffect(() => {
    api.partnerPerson(person.employee_id).then(setD).catch((e) => setError(e.message));
  }, [person.employee_id]);
  const p = d ?? person;
  const on = ['active', 'probation'].includes(p.status);
  const lead = p.position === 'partner_lead';
  const today = todayTH();
  const visits = d?.visits ?? [];
  const upcoming = visits.filter((v) => v.status !== 'cancelled' && !v.check_out_at && v.visit_date >= today).reverse();
  const history = visits.filter((v) => !upcoming.includes(v));
  const status = p.status === 'suspended' ? { text: 'KIN ระงับ — ติดต่อ KIN เพื่อเปิดคืน', cls: 'is-warn' }
    : !on ? { text: 'ปิดบัญชีแล้ว', cls: 'is-muted' }
    : p.default_password && !p.last_login_at ? { text: 'รอเข้าครั้งแรก', cls: 'is-warn' }
      : { text: 'ใช้งานอยู่', cls: 'is-ok' };
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow pt-person-detail" role="dialog" aria-modal="true" aria-labelledby="pt-pd-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="pt-pd-head">
            <span className="pt-avatar" aria-hidden="true">{p.first_name?.[0] ?? '?'}</span>
            <div>
              <h2 id="pt-pd-title">{p.first_name} {p.last_name}{p.nickname ? ` (${p.nickname})` : ''}</h2>
              <p className="muted">{POSITION_LABELS[p.position] ?? p.position} <span className={`pt-tag ${status.cls}`}>{status.text}</span></p>
            </div>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด">×</button>
        </header>
        <div className="modal-body">
          {error && <p className="error" role="alert">{error}</p>}
          <dl className="pt-detail">
            <dt>รหัสเข้าระบบ</dt><dd className="mono">{p.employee_id}</dd>
            <dt>อีเมล</dt><dd>{p.email || <span className="muted">ไม่ได้ใส่ — เข้าระบบด้วยรหัสพนักงาน</span>}</dd>
            <dt>เบอร์โทร</dt>
            <dd>{p.phone ? <a className="link" href={`tel:${String(p.phone).replace(/[^\d+]/g, '')}`}>{p.phone}</a> : <span className="muted">ไม่ได้ใส่</span>}</dd>
            <dt>เข้าระบบล่าสุด</dt><dd>{loginAt(p.last_login_at) ?? <span className="muted">ยังไม่เคยเข้า</span>}</dd>
            {!lead && (<>
              <dt>ไปแล้ว</dt>
              <dd>เดือนนี้ {p.done_this_month ?? 0} ครั้ง{d ? <span className="muted"> · รวมทั้งหมด {d.done_total} ครั้ง</span> : null}</dd>
            </>)}
          </dl>
          {!lead && !d && !error && <p className="muted">กำลังโหลดงาน…</p>}
          {!lead && d && (
            <>
              <section className="pt-detail-others">
                <h3>งานข้างหน้า{upcoming.length > 0 && <span className="muted"> · {upcoming.length} กะ</span>}</h3>
                {upcoming.length ? <VisitList rows={upcoming} /> : <p className="muted">ยังไม่มีงานที่ให้ไป</p>}
              </section>
              {history.length > 0 && (
                <section className="pt-detail-others">
                  <h3>ประวัติงาน<span className="muted"> · ล่าสุด {history.length} กะ</span></h3>
                  <VisitList rows={history} />
                </section>
              )}
            </>
          )}
          {lead && <p className="muted pt-person-note">บัญชีหัวหน้าแก้ไขได้จากหลังบ้าน KIN</p>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel}>ปิด</button>
          {!lead && (on
            ? <button type="button" className="btn primary" onClick={() => onEdit(p)}>แก้ไขข้อมูล</button>
            : p.status !== 'suspended' && <button type="button" className="btn primary" onClick={() => onReopen(p)}>เปิดบัญชี</button>)}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** popup กลางจอ — เพิ่มคนใหม่ / แก้ข้อมูลคนในทีม (ผู้ใช้ขอ 23 พ.ย. 2569) */
function PersonDialog({ editing, form, set, positions, busy, error, onSubmit, onCancel, onCloseAccount }) {
  useScrollLock();
  useEffect(() => {
    // ผูกช่วง bubble — กล่องยืนยันปิดบัญชี (ConfirmButton) ดัก Esc ช่วง capture ก่อน · Esc จึงปิดแค่กล่องยืนยัน ไม่ปิด popup นี้ไปด้วย
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={() => !busy && onCancel()}>
      <form className="modal modal-narrow pt-person-modal" role="dialog" aria-modal="true" aria-labelledby="pt-person-title"
        onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <header className="modal-head">
          <div>
            <h2 id="pt-person-title">{editing ? 'แก้ไขข้อมูลคนในทีม' : 'เพิ่มคนในทีม'}</h2>
            <p className="muted">
              {editing
                ? <>รหัสเข้าระบบ <span className="mono">{editing.employee_id}</span> · รหัสผ่านไม่เปลี่ยน</>
                : 'ได้รหัสเข้าระบบอัตโนมัติ · เข้าครั้งแรกด้วยรหัสผ่านเริ่มต้น แล้วระบบให้ตั้งใหม่'}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด" disabled={busy}>×</button>
        </header>
        <div className="modal-body">
          <div className="pt-form-grid">
            <label>ชื่อ<input required autoFocus value={form.first_name} onChange={set('first_name')} disabled={busy} /></label>
            <label>นามสกุล<input required value={form.last_name} onChange={set('last_name')} disabled={busy} /></label>
            <label>ชื่อเล่น<input value={form.nickname} onChange={set('nickname')} disabled={busy} placeholder="ไม่บังคับ" /></label>
            <label>เบอร์โทร<input type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} disabled={busy} placeholder="ไม่บังคับ" /></label>
            <label className="pt-span">อีเมล (ใช้เข้าระบบแทนรหัสพนักงานได้)
              <input type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false}
                value={form.email} onChange={set('email')} disabled={busy} placeholder="ไม่บังคับ · เช่น name@example.com" />
            </label>
            <label className="pt-span">ตำแหน่ง
              <select value={form.position} onChange={set('position')} disabled={busy}>
                {positions.map((p) => <option key={p} value={p}>{POSITION_LABELS[p] ?? p}</option>)}
              </select>
            </label>
          </div>
          {editing && <p className="muted pt-person-note">เปลี่ยนตำแหน่งแล้ว มีผลกับงานที่เลือกคนครั้งถัดไป</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot">
          {editing && (
            <ConfirmButton className="btn danger-ghost foot-danger" disabled={busy} title={`ปิดบัญชี ${editing.first_name}?`}
              detail="เข้าระบบไม่ได้อีก · เปิดคืนได้ภายหลังจากหน้าทีมของฉัน · ถ้ายังมีกะข้างหน้า ต้องเปลี่ยนคนในกะนั้นก่อน"
              confirmLabel="ปิดบัญชี" cancelLabel="ไม่ปิด" onConfirm={onCloseAccount}>ปิดบัญชี</ConfirmButton>
          )}
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'เพิ่มคน'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
