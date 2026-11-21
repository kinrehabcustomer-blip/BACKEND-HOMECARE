import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { POSITION_LABELS } from '../labels.js';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';

/**
 * หัวหน้าพาร์ทเนอร์ — ทีมของฉัน (21 พ.ย. 2569)
 * เพิ่มคนเองได้ (ชื่อ · เบอร์ · ตำแหน่งหน้างาน) → ได้รหัสพนักงานอัตโนมัติ · เข้าครั้งแรกด้วยรหัสเริ่มต้นแล้วระบบบังคับตั้งรหัสใหม่
 * ปิดบัญชีคนที่ออก (ยังถือกะข้างหน้าอยู่ปิดไม่ได้ — server ตอบเหตุผล) · บัญชีหัวหน้าแก้จากหลังบ้าน KIN
 */
const EMPTY = { first_name: '', last_name: '', nickname: '', phone: '', position: 'therapist' };

export default function PartnerTeamPage() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
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
      const p = await api.partnerAddPerson({ ...form, nickname: form.nickname || null, phone: form.phone || null });
      toast(`เพิ่ม ${p.first_name} แล้ว — รหัสเข้าระบบ ${p.employee_id} · รหัสผ่านเริ่มต้น 12345678 (เข้าครั้งแรกต้องตั้งใหม่)`);
      setForm(EMPTY);
      setAdding(false);
      load();
    } catch (err) {
      setFormError(err.message);
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
          {!adding && <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ เพิ่มคน</button>}
        </header>

        <ErrorBar message={error} onRetry={load} busy={loading} />

        {/* จอคอม: รายชื่อซ้าย ฟอร์มเพิ่มคนขวา · มือถือ: ฟอร์มอยู่บนรายชื่อ */}
        <div className={`pt-team-layout${adding ? ' has-form' : ''}`}>
        {adding && (
          <form className="pt-card pt-form" onSubmit={save}>
            <strong>เพิ่มคนในทีม</strong>
            <div className="pt-form-grid">
              <label>ชื่อ<input required value={form.first_name} onChange={set('first_name')} disabled={busy} /></label>
              <label>นามสกุล<input required value={form.last_name} onChange={set('last_name')} disabled={busy} /></label>
              <label>ชื่อเล่น<input value={form.nickname} onChange={set('nickname')} disabled={busy} /></label>
              <label>เบอร์โทร<input type="tel" value={form.phone} onChange={set('phone')} disabled={busy} /></label>
              <label className="pt-span">ตำแหน่ง
                <select value={form.position} onChange={set('position')} disabled={busy}>
                  {positions.map((p) => <option key={p} value={p}>{POSITION_LABELS[p] ?? p}</option>)}
                </select>
              </label>
            </div>
            <p className="muted">ได้รหัสพนักงานอัตโนมัติ · เข้าครั้งแรกด้วยรหัสผ่านเริ่มต้น แล้วระบบให้ตั้งรหัสใหม่</p>
            {formError && <p className="error" role="alert">{formError}</p>}
            <div className="pt-actions is-end">
              <button type="button" className="btn" onClick={() => { setAdding(false); setFormError(null); }} disabled={busy}>ยกเลิก</button>
              <button type="submit" className="btn primary" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
            </div>
          </form>
        )}

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
                <div key={p.employee_id} className={`pt-member${on ? '' : ' is-off'}`}>
                  <span className="pt-avatar" aria-hidden="true">{p.first_name?.[0] ?? '?'}</span>
                  <span className="pt-member-main">
                    <b>{p.first_name} {p.last_name}{p.nickname ? ` (${p.nickname})` : ''}</b>
                    <span className="muted pt-member-sub">
                      {POSITION_LABELS[p.position] ?? p.position} · <span className="mono">{p.employee_id}</span>
                      {!lead && on && ` · เดือนนี้ ${p.done_this_month} ครั้ง`}
                    </span>
                    {p.phone && <span className="muted pt-member-phone">{p.phone}</span>}
                  </span>
                  {/* คอลัมน์ของจอคอม (มือถือรวมอยู่ในบรรทัดรองด้านบน) */}
                  <span className="pt-col">{POSITION_LABELS[p.position] ?? p.position}</span>
                  <span className="pt-col mono">{p.employee_id}</span>
                  <span className="pt-col is-num">{lead ? '—' : `${p.done_this_month} ครั้ง`}</span>
                  <span className="pt-col-act">
                  {!on ? (
                    <button type="button" className="btn tiny" onClick={() => setStatus(p, 'active')}>เปิดบัญชี</button>
                  ) : lead ? (
                    <span className="pt-tag is-muted">หัวหน้า</span>
                  ) : p.default_password && !p.last_login_at ? (
                    <span className="pt-tag is-warn">รอเข้าครั้งแรก</span>
                  ) : (
                    <ConfirmButton className="btn tiny" title={`ปิดบัญชี ${p.first_name}?`}
                      detail="เข้าระบบไม่ได้อีก · เปิดคืนได้ภายหลัง" confirmLabel="ปิดบัญชี" cancelLabel="ไม่ปิด"
                      onConfirm={() => setStatus(p, 'resigned')}>ปิดบัญชี</ConfirmButton>
                  )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        </div>
      </div>
    </PageRefresh>
  );
}
