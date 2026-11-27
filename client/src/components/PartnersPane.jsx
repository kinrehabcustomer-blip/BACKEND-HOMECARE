import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useCan } from '../auth.jsx';
import { useToast } from '../toast.jsx';
import { POSITION_LABELS, formatBaht, formatDate } from '../labels.js';
import { timeRange } from '../lib/calendarUi.js';
import { caseCode } from '../lib/patientCode.js';
import ErrorBar from './ErrorBar.jsx';
import ConfirmButton from './ConfirmButton.jsx';
import { useConfirm } from './ConfirmDialog.jsx';
import PartnerLogo, { logoDataUrl } from './PartnerLogo.jsx';
import LineIcon from './LineIcon.jsx';
import { useScrollLock } from '../lib/scrollLock.js';

/** เวลา timestamptz → วันที่ไทย (YYYY-MM-DD) — ตัดสตริง UTC ตรงๆ ได้วันก่อนหน้าช่วงตี 0–7 */
const dateTH = (ts) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

/**
 * ตั้งค่าระบบ › พาร์ทเนอร์ (ผู้รับเหมาช่วงรายครั้ง · 21 พ.ย. 2569) — สิทธิ์งานหลังบ้าน (office)
 *   กะที่ต้องดู · บริษัท (เรทต่อครั้ง · บัญชีหัวหน้า · คนในทีม) · สรุปรายเดือน + บันทึกจ่าย (สิทธิ์ค่าตอบแทน)
 * ส่งกะให้พาร์ทเนอร์ทำที่ตารางนัดของเคส (CaseVisits) · server: partners/
 */
const thisMonth = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 7);
const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const monthName = (ym) => new Date(`${ym}-01T00:00:00+07:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
const EMPTY_PARTNER = { name: '', contact_name: '', phone: '', rate_per_visit: '', english_rate: '', service_kind: 'homecare' };
/* ฝั่งงานของบริษัท (26 พ.ย. 2569) — Homecare หรือกายภาพบำบัด อย่างใดอย่างหนึ่ง · ป้ายต่อท้ายชื่อ + ปุ่มสลับใน popup/ฟอร์ม */
const KIND_OPTIONS = [['homecare', 'Homecare'], ['physio', 'กายภาพบำบัด']];
const kindOf = (p) => p?.service_kind ?? 'homecare';
function KindBadge({ partner }) {
  const k = kindOf(partner);
  return <span className={`pa-kind is-${k}`}>{KIND_OPTIONS.find(([x]) => x === k)[1]}</span>;
}
/** ปุ่มสลับ Homecare | กายภาพบำบัด — เลือกได้อย่างเดียว */
function KindSwitch({ value, disabled = false, onChange }) {
  return (
    <div className="pa-kind-switch" role="radiogroup" aria-label="ประเภทงาน">
      {KIND_OPTIONS.map(([k, label]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} disabled={disabled}
          className={`pa-kind-seg is-${k}${value === k ? ' is-on' : ''}`} onClick={() => value !== k && onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}
const EMPTY_LEAD = { first_name: '', last_name: '', phone: '' };

export default function PartnersPane() {
  const toast = useToast();
  const ask = useConfirm();
  const canPay = useCan('payroll');
  /* สิทธิ์ (ตรวจ 21 พ.ย. 2569 · server ตรวจซ้ำ): จัดการงาน = office · ตัวเลขเงิน = see_pay
     การเงิน (payroll + see_pay ไม่มี office) เห็นเฉพาะสรุปรายเดือน + บันทึกจ่าย */
  const canOffice = useCan('office');
  const seePay = useCan('see_pay');
  const [partners, setPartners] = useState(null);
  const [attention, setAttention] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // null = ปิด · { partner_id?, ...fields }
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => (canOffice
    ? Promise.all([api.partners(), api.partnerAttention()])
      .then(([p, a]) => { setPartners(p); setAttention(a); setError(null); })
      .catch((e) => setError(e.message))
    : Promise.resolve()), [canOffice]);
  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const body = { name: form.name, contact_name: form.contact_name || null, phone: form.phone || null, service_kind: kindOf(form),
        ...(seePay ? { rate_per_visit: Number(form.rate_per_visit || 0), english_rate: Number(form.english_rate || 0) } : {}) };
      if (form.partner_id) await api.updatePartner(form.partner_id, body);
      else await api.createPartner(body);
      toast(form.partner_id ? 'บันทึกข้อมูลพาร์ทเนอร์แล้ว' : `เพิ่ม ${body.name} แล้ว — สร้างบัญชีหัวหน้าต่อได้เลย`);
      setForm(null);
      load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const uploadLogo = async (p, file) => {
    if (!file) return;
    try {
      await api.setPartnerLogo(p.partner_id, await logoDataUrl(file));
      toast(`อัปโหลดโลโก้ ${p.name} แล้ว`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };
  const removeLogo = async (p) => {
    try {
      await api.setPartnerLogo(p.partner_id, null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };
  /* ลบถาวร — server ตรวจเองว่าลบได้ไหม (มีงานที่ไปจริง/บันทึกจ่าย = ลบไม่ได้ · มีกะค้าง = ดึงคืนก่อน) */
  const removePartner = async (p) => {
    try {
      await api.deletePartner(p.partner_id);
      toast(`ลบ ${p.name} แล้ว`);
      if (openId === p.partner_id) setOpenId(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };
  /* สลับฝั่งงาน Homecare/กายภาพบำบัด จาก popup ตั้งค่า — บันทึกทันที (26 พ.ย. 2569) */
  const setKind = async (p, kind) => {
    try {
      await api.updatePartner(p.partner_id, { service_kind: kind });
      toast(`${p.name} เป็นพาร์ทเนอร์ฝั่ง${kind === 'physio' ? 'กายภาพบำบัด' : ' Homecare'} แล้ว`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };
  const toggleStatus = async (p) => {
    try {
      await api.updatePartner(p.partner_id, { status: p.status === 'active' ? 'inactive' : 'active' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!canOffice) {
    return <div className="pa">{seePay ? <MonthlySummary canPay={canPay} /> : <p className="muted">บัญชีของคุณไม่มีสิทธิ์ดูหน้านี้</p>}</div>;
  }

  return (
    <div className="pa">
      <ErrorBar message={error} onRetry={load} />

      {attention.length > 0 && (
        <section className="set-card pa-attention" aria-label="กะที่ต้องดู">
          <h3>กะที่ต้องดู <span className="pa-count">{attention.length}</span></h3>
          <p className="muted">ส่งให้พาร์ทเนอร์แล้วยังไม่มีคน (ใกล้นัดภายใน 24 ชม.) หรือพาร์ทเนอร์ปฏิเสธกลับมา — เปิดเคสเพื่อหาคนหรือส่งบริษัทอื่น</p>
          <ul className="pa-list">
            {attention.map((v) => (
              <li key={v.visit_id}>
                <span>
                  <b>{formatDate(v.visit_date)}{timeRange(v) ? ` · ${timeRange(v)}` : ''} · {v.client_name}</b>
                  <span className={v.reason === 'rejected' ? 'pa-bad' : 'muted'}>
                    {v.reason === 'rejected'
                      ? `${v.partner_name ?? 'พาร์ทเนอร์'} ปฏิเสธ${v.partner_reject_reason ? ` — ${v.partner_reject_reason}` : ''}`
                      : `${v.partner_name} ยังไม่เลือกคน`}
                  </span>
                </span>
                <Link className="btn tiny" to={`/cases?open=${encodeURIComponent(v.case_id)}`}>{caseCode(v.case_id)}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="set-card" aria-label="บริษัทพาร์ทเนอร์">
        <header className="set-card-head">
          <div className="set-card-title">
            <h3>บริษัทพาร์ทเนอร์</h3>
            <p className="muted">เรทต่อครั้ง = ยอดที่ KIN จ่ายบริษัทต่อกะที่ไปจริง · ค่าภาษา = บวกเพิ่มต่อกะ เฉพาะเคสที่ลูกค้าขอภาษาอังกฤษ (จดไว้ ณ ตอนส่งกะ เปลี่ยนเรทไม่ย้อนแก้กะเก่า)</p>
          </div>
          <button type="button" className="btn primary" onClick={() => { setFormError(null); setForm({ ...EMPTY_PARTNER }); }}>+ เพิ่มพาร์ทเนอร์</button>
        </header>

        {/* เพิ่ม/แก้ไขบริษัท = popup กลางจอ (ผู้ใช้ขอ 25 พ.ย. 2569) — error ขึ้นในกล่องเอง เพราะแถบ error ของหน้าอยู่หลังกล่อง */}
        {form && (
          <CenterPopup wide title={form.partner_id ? 'แก้ไขพาร์ทเนอร์' : 'เพิ่มพาร์ทเนอร์'} onClose={() => !busy && setForm(null)}>
            <form className="pa-form pa-form-modal" onSubmit={save}>
              {formError && <p className="form-error pa-form-error" role="alert">{formError}</p>}
              <label>ชื่อบริษัท<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={busy} /></label>
              <div className="pa-kind-field">
                <span>ประเภทงาน</span>
                <KindSwitch value={kindOf(form)} disabled={busy} onChange={(k) => setForm({ ...form, service_kind: k })} />
              </div>
              <label>ผู้ติดต่อ<input value={form.contact_name ?? ''} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} disabled={busy} /></label>
              <label>เบอร์โทร<input type="tel" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={busy} /></label>
              {seePay && <label>เรทต่อครั้ง (บาท)<input required inputMode="decimal" value={form.rate_per_visit} onChange={(e) => setForm({ ...form, rate_per_visit: e.target.value })} disabled={busy} /></label>}
              {seePay && <label>ค่าภาษาอังกฤษต่อครั้ง (บาท)<input inputMode="decimal" placeholder="0" value={form.english_rate ?? ''} onChange={(e) => setForm({ ...form, english_rate: e.target.value })} disabled={busy} /></label>}
              <div className="pa-form-actions">
                <button type="button" className="btn" onClick={() => setForm(null)} disabled={busy}>ยกเลิก</button>
                <button type="submit" className="btn primary" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
              </div>
            </form>
          </CenterPopup>
        )}

        {!partners ? <p className="muted">กำลังโหลด…</p> : partners.length === 0 ? (
          <p className="muted set-empty">ยังไม่มีพาร์ทเนอร์</p>
        ) : (
          <ul className="pa-partners">
            {partners.map((p) => (
              <li key={p.partner_id} className={p.status === 'active' ? '' : 'is-off'}>
                <div className="pa-partner-row">
                  <PartnerLogo partner={p} size={44} className="pa-logo" />
                  <button type="button" className="pa-partner-name" aria-expanded={openId === p.partner_id}
                    onClick={() => setOpenId(openId === p.partner_id ? null : p.partner_id)}>
                    <b>{p.name}<KindBadge partner={p} /></b>
                    <span className="muted">
                      {p.rate_per_visit != null && `${formatBaht(p.rate_per_visit)}/ครั้ง · `}{Number(p.english_rate) > 0 && `ภาษาอังกฤษ +${formatBaht(p.english_rate)} · `}หัวหน้า {p.leads} · ทีม {p.staff} คน · งานค้าง {p.open_visits} · เดือนนี้ไปแล้ว {p.done_this_month}
                      {p.contact_name ? ` · ${p.contact_name}` : ''}{p.phone ? ` ${p.phone}` : ''}
                    </span>
                  </button>
                  <div className="pa-partner-tools">
                    {/* ปุ่มตั้งค่าเดียว รวม โลโก้ · แก้ไข · ลบ (ผู้ใช้ขอ 25 พ.ย. 2569) — สวิตช์เปิด/ปิดยังอยู่นอกเมนู ให้เห็นสถานะทันที */}
                    <PartnerMenu
                      partner={p}
                      onEdit={() => { setFormError(null); setForm({ ...p, service_kind: kindOf(p), rate_per_visit: String(p.rate_per_visit ?? ''), english_rate: Number(p.english_rate) > 0 ? String(p.english_rate) : '' }); }}
                      onLogo={(file) => uploadLogo(p, file)}
                      onKind={(k) => setKind(p, k)}
                      onRemoveLogo={async () => {
                        if (await ask({ title: `ลบโลโก้ ${p.name}?`, confirmLabel: 'ลบโลโก้', cancelLabel: 'ไม่ลบ', danger: true })) removeLogo(p);
                      }}
                      onRemove={async () => {
                        if (await ask({
                          title: `ลบ ${p.name} ถาวร?`,
                          detail: 'บัญชีหัวหน้าและทีมของบริษัทนี้จะถูกลบด้วย กู้คืนไม่ได้ · บริษัทที่มีงานที่ไปจริงหรือบันทึกจ่ายแล้วลบไม่ได้ ใช้ปิดใช้งานแทน',
                          confirmLabel: 'ลบพาร์ทเนอร์', cancelLabel: 'ไม่ลบ', danger: true,
                        })) removePartner(p);
                      }}
                    />
                    {/* สวิตช์เปิด/ปิดใช้งาน (ผู้ใช้ขอ 21 พ.ย. 2569 — แบบเดียวกับหน้าจัดการสิทธิ์) · ปิด = ถามยืนยันก่อน */}
                    <label className={`set-switch pa-switch${p.status === 'active' ? ' is-on' : ''}`}>
                      <input type="checkbox" role="switch" className="perm-check" checked={p.status === 'active'}
                        aria-label={`${p.status === 'active' ? 'ปิด' : 'เปิด'}ใช้งาน ${p.name}`}
                        onChange={async () => {
                          if (p.status === 'active' && !(await ask({
                            title: `ปิดใช้งาน ${p.name}?`,
                            detail: 'ส่งกะใหม่ให้ไม่ได้ · หัวหน้าเข้าหน้างานไม่ได้ · กะที่ส่งไปแล้วยังอยู่',
                            confirmLabel: 'ปิดใช้งาน', cancelLabel: 'ไม่ปิด', danger: true,
                          }))) return;
                          toggleStatus(p);
                        }} />
                      <span>{p.status === 'active' ? 'เปิดใช้งาน' : 'ปิดอยู่'}</span>
                    </label>
                  </div>
                </div>
                {openId === p.partner_id && <PartnerPeople partner={p} onChange={load} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      {seePay && <MonthlySummary canPay={canPay} />}
    </div>
  );
}

/**
 * popup กลางจอของหน้าพาร์ทเนอร์ (ผู้ใช้ขอ 25 พ.ย. 2569) — ใช้กับเมนูตั้งค่าและฟอร์มเพิ่ม/แก้ไขบริษัท
 * กลางจอทุกขนาดจอ (ไม่เป็นแผ่นเลื่อนจากขอบล่างบนมือถือ) · ปิดเมื่อกดพื้นหลัง / Esc / ปุ่มปิด
 * head = ส่วนหัวแทนชื่อธรรมดา (เมนูตั้งค่าใช้โลโก้ + ชื่อบริษัท)
 */
function CenterPopup({ title, head, onClose, wide = false, children }) {
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useScrollLock(true);
  useEffect(() => {
    if (!head) closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [head]);
  return createPortal(
    <div className="modal-backdrop modal-stacked pa-menu-backdrop" onClick={onClose}>
      <div className={`modal modal-narrow pa-menu-modal${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}>
        <header className="pa-menu-head">
          {head ?? <div><b>{title}</b></div>}
          <button type="button" className="btn icon-btn pa-menu-close" ref={closeRef} aria-label="ปิด" onClick={onClose}>
            <LineIcon name="close" className="btn-ico" />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * ปุ่มตั้งค่า (เฟือง) ของแถวบริษัท — กดแล้วเปิด popup กลางจอ:
 * แก้ไขข้อมูล · เพิ่ม/เปลี่ยนโลโก้ · ลบโลโก้ · ลบพาร์ทเนอร์
 * เลือกรายการแล้ว popup ปิด · การยืนยันลบใช้กล่องยืนยัน (useConfirm) หลัง popup ปิดแล้ว
 */
function PartnerMenu({ partner, onEdit, onLogo, onKind, onRemoveLogo, onRemove }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const changeKind = async (k) => { setSaving(true); try { await onKind(k); } finally { setSaving(false); } };
  const fileRef = useRef(null);
  const pick = (fn) => () => { setOpen(false); fn(); };
  return (
    <>
      <button type="button" className="btn tiny pa-menu-btn" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`ตั้งค่า ${partner.name}`} onClick={() => setOpen(true)}>
        <LineIcon name="settings" className="btn-ico" /><span>ตั้งค่า</span>
      </button>
      {/* อัปโหลดโลโก้ — เลือกไฟล์แล้วอัปโหลดทันที (ย่อเป็น WebP ≤ 512px ในเบราว์เซอร์) */}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={(e) => { onLogo(e.target.files?.[0]); e.target.value = ''; }} />
      {open && (
        <CenterPopup
          title={`ตั้งค่า ${partner.name}`}
          onClose={() => setOpen(false)}
          head={(
            <>
              <PartnerLogo partner={partner} size={48} className="pa-logo" />
              <div>
                <b>{partner.name}</b>
                <span className="pa-menu-sub">
                  <span className={`pa-menu-status${partner.status === 'active' ? ' is-on' : ''}`}>{partner.status === 'active' ? 'เปิดใช้งาน' : 'ปิดอยู่'}</span>
                  {partner.rate_per_visit != null && <span className="muted">{formatBaht(partner.rate_per_visit)}/ครั้ง</span>}
                </span>
              </div>
            </>
          )}
        >
          {/* ฝั่งงานของบริษัท — เลือกได้อย่างเดียว · กดแล้วบันทึกทันที */}
          <div className="pa-menu-kind">
            <span>ประเภทงาน</span>
            <KindSwitch value={kindOf(partner)} disabled={saving} onChange={changeKind} />
          </div>
          <div className="pa-menu-list" role="menu">
            <MenuItem icon="edit" title="แก้ไขข้อมูล" desc="ชื่อ ผู้ติดต่อ เบอร์โทร เรท และค่าภาษา" onClick={pick(onEdit)} />
            <MenuItem icon="image" title={partner.has_logo ? 'เปลี่ยนโลโก้' : 'เพิ่มโลโก้'} desc="PNG / JPG / WebP — ย่อขนาดให้อัตโนมัติ"
              onClick={pick(() => fileRef.current?.click())} />
            {partner.has_logo && <MenuItem icon="image-off" title="ลบโลโก้" desc="กลับไปใช้อักษรย่อแทน" onClick={pick(onRemoveLogo)} />}
          </div>
          <div className="pa-menu-list is-danger-zone" role="menu">
            <MenuItem icon="trash" danger title="ลบพาร์ทเนอร์" desc="ลบพร้อมบัญชีของบริษัท · กู้คืนไม่ได้" onClick={pick(onRemove)} />
          </div>
        </CenterPopup>
      )}
    </>
  );
}

/** แถวในเมนูตั้งค่า — ไอคอนในกรอบ · ชื่อ · คำอธิบายสั้น · ลูกศร */
function MenuItem({ icon, title, desc, danger = false, onClick }) {
  return (
    <button type="button" role="menuitem" className={danger ? 'pa-menu-item is-danger' : 'pa-menu-item'} onClick={onClick}>
      <span className="pa-menu-ico"><LineIcon name={icon} className="btn-ico" /></span>
      <span className="pa-menu-text"><b>{title}</b>{desc && <span>{desc}</span>}</span>
      <LineIcon name="chevron-right" className="btn-ico pa-menu-arrow" />
    </button>
  );
}

/** คนของบริษัท — สร้างบัญชีหัวหน้า (หลังบ้าน KIN เท่านั้น) · ทีมหัวหน้าเพิ่มเอง · ปิด/เปิดบัญชีได้ */
function PartnerPeople({ partner, onChange }) {
  const toast = useToast();
  const [people, setPeople] = useState(null);
  const [lead, setLead] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.partnerPeople(partner.partner_id).then(setPeople).catch((e) => setError(e.message)), [partner.partner_id]);
  useEffect(() => { load(); }, [load]);

  const addLead = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.createPartnerLead(partner.partner_id, { ...lead, phone: lead.phone || null });
      toast(`สร้างบัญชีหัวหน้าแล้ว — เข้าระบบด้วยรหัส ${p.employee_id} · รหัสผ่านเริ่มต้น 12345678 (เข้าครั้งแรกต้องตั้งใหม่)`);
      setLead(null);
      load();
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (p, status) => {
    try {
      await api.updatePartnerPerson(partner.partner_id, p.employee_id, { status });
      load();
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="pa-people">
      {error && <p className="error" role="alert">{error}</p>}
      {!people ? <p className="muted">กำลังโหลด…</p> : people.length === 0 ? <p className="muted">ยังไม่มีบัญชี — สร้างบัญชีหัวหน้าก่อน หัวหน้าจะเพิ่มคนในทีมเองได้</p> : (
        <ul>
          {people.map((p) => {
            const on = ['active', 'probation'].includes(p.status);
            return (
              <li key={p.employee_id} className={on ? '' : 'is-off'}>
                <span>
                  <b>{p.first_name} {p.last_name}</b>
                  <span className="muted"> · {POSITION_LABELS[p.position] ?? p.position} · <span className="mono">{p.employee_id}</span>{p.phone ? ` · ${p.phone}` : ''}</span>
                </span>
                {on ? (
                  <ConfirmButton className="btn tiny" title={`ปิดบัญชี ${p.first_name}?`} detail="เข้าระบบไม่ได้อีก · เปิดคืนได้ภายหลัง"
                    confirmLabel="ปิดบัญชี" cancelLabel="ไม่ปิด" onConfirm={() => setStatus(p, 'resigned')}>ปิดบัญชี</ConfirmButton>
                ) : <button type="button" className="btn tiny" onClick={() => setStatus(p, 'active')}>เปิดบัญชี</button>}
              </li>
            );
          })}
        </ul>
      )}
      {lead ? (
        <form className="pa-form" onSubmit={addLead}>
          <label>ชื่อ<input required value={lead.first_name} onChange={(e) => setLead({ ...lead, first_name: e.target.value })} disabled={busy} /></label>
          <label>นามสกุล<input required value={lead.last_name} onChange={(e) => setLead({ ...lead, last_name: e.target.value })} disabled={busy} /></label>
          <label>เบอร์โทร<input type="tel" value={lead.phone} onChange={(e) => setLead({ ...lead, phone: e.target.value })} disabled={busy} /></label>
          <div className="pa-form-actions">
            <button type="button" className="btn" onClick={() => setLead(null)} disabled={busy}>ยกเลิก</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'กำลังสร้าง…' : 'สร้างบัญชีหัวหน้า'}</button>
          </div>
        </form>
      ) : partner.status === 'active' && (
        <button type="button" className="btn tiny" onClick={() => setLead({ ...EMPTY_LEAD })}>+ บัญชีหัวหน้าพาร์ทเนอร์</button>
      )}
    </div>
  );
}

/** สรุปรายเดือนทุกบริษัท + บันทึกจ่าย (เดือนที่จบแล้ว · สิทธิ์ค่าตอบแทน) */
function MonthlySummary({ canPay }) {
  const toast = useToast();
  const [month, setMonth] = useState(shiftMonth(thisMonth(), -1));
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.partnersSummary(month).then(setRows).catch((e) => setError(e.message)), [month]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const pay = async (r) => {
    try {
      await api.payPartner(r.partner_id, { month });
      toast(`บันทึกจ่าย ${r.name} ${formatBaht(r.amount)} แล้ว`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };
  const finished = month < thisMonth();
  return (
    <section className="set-card" aria-label="สรุปรายเดือน">
      <header className="set-card-head">
        <div className="set-card-title">
          <h3>สรุปรายเดือน</h3>
          <p className="muted">กะที่ไปจริง (หัวหน้าพาร์ทเนอร์ลงรายงาน + เวลาแล้ว) × เรท · ไม่ลงรายงานไม่นับเงิน · บันทึกจ่ายได้หลังสิ้นเดือน</p>
        </div>
        <div className="pt-month" role="group" aria-label="เลือกเดือน">
          <button type="button" className="btn tiny" aria-label="เดือนก่อน" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <span>{monthName(month)}</span>
          <button type="button" className="btn tiny" aria-label="เดือนถัดไป" disabled={month >= thisMonth()} onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {!rows ? <p className="muted">กำลังโหลด…</p> : rows.length === 0 ? <p className="muted set-empty">ไม่มีงานพาร์ทเนอร์ในเดือนนี้</p> : (
        <div className="table-wrap">
          <table className="fin-table">
            <thead><tr><th>บริษัท</th><th className="num">ไปจริง</th><th className="num">ขาดงาน</th><th className="num">ปฏิเสธ</th><th className="num">ยอด</th><th>การจ่าย</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.partner_id}>
                  <td>{r.name}<span className="cell-sub">{formatBaht(r.rate_per_visit)}/ครั้ง{Number(r.english_rate) > 0 && ` · ภาษาอังกฤษ +${formatBaht(r.english_rate)}`}</span></td>
                  <td className="num">{r.done}</td>
                  <td className="num">{r.missed}</td>
                  <td className="num">{r.rejected}</td>
                  <td className="num strong">{formatBaht(r.amount)}</td>
                  <td>
                    {r.payment ? (
                      <span className="pt-paid">จ่ายแล้ว {formatBaht(r.payment.amount)}<span className="cell-sub">{formatDate(dateTH(r.payment.paid_at))} · {r.payment.paid_by_name ?? ''}</span></span>
                    ) : canPay && finished && r.done > 0 ? (
                      <ConfirmButton className="btn tiny" danger={false} title={`บันทึกจ่าย ${r.name}?`}
                        detail={`${monthName(month)} · ${r.done} ครั้ง · ${formatBaht(r.amount)} — ตรึงยอดไว้ แก้ทีหลังไม่ได้`}
                        confirmLabel="บันทึกจ่าย" cancelLabel="ยังไม่จ่าย" onConfirm={() => pay(r)}>บันทึกจ่าย</ConfirmButton>
                    ) : <span className="muted">{finished ? (r.done ? 'ยังไม่จ่าย' : '—') : 'เดือนยังไม่จบ'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
