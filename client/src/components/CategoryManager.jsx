import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import ErrorBar from './ErrorBar.jsx';
import SearchSelect from './SearchSelect.jsx';
import { SettingsPaneHead } from './SettingsShell.jsx';
import { invalidateCategories, treeOf } from '../lib/categories.js';
import { PROCEDURE_CATALOG, defaultPrices } from '../lib/procedureCatalog.js';
import { INCIDENT_TYPES, PHYSIO_INCIDENT_TYPES } from '../lib/dailyCare.js';
import LineIcon from './LineIcon.jsx';

/**
 * จัดการหมวดหมู่ของโดเมนเดียว (cat / sub cat) — แผงขวาของหน้าตั้งค่า/หน้าหมวดหมู่ (ดีไซน์ใหม่ 19 พ.ย. 2569)
 *
 *   หมวดหลัก = การ์ดหนึ่งใบ (ชื่อ · รหัส · "เปิดใช้งาน X จาก Y รายการ" · ปุ่ม + เพิ่มหมวดย่อย)
 *   หมวดย่อย = แถวในการ์ด (เลขหมวด · ชื่อ · รหัส · สวิตช์เปิดใช้งาน · ปุ่มแก้ไข)
 *   ไม่มีปุ่มเลื่อนลำดับ ▲▼ (ผู้ใช้ให้เอาออก 19 พ.ย. 2569) — เรียงตามลำดับที่ตั้งไว้/ลำดับที่เพิ่ม
 *   แคตตาล็อก (meta.items) — แถวหมวดย่อยมีชิปรายการ + ช่องเพิ่ม · การ์ด "ยังไม่จัดหมวด" อยู่บนสุด
 *   ไม่มีปุ่มลบโดยตั้งใจ — ปิดใช้แทน ข้อมูลเก่าที่อ้างหมวดนั้นยังอ่านชื่อได้
 *
 * สิทธิ์: server ตรวจเอง (categories/routes.js) — เหตุผลยกเลิก/เหตุการณ์ = Super Admin + ผู้จัดการ · แคตตาล็อก = สิทธิ์ categories
 */

/* ข้อความของแต่ละโดเมน — title/desc หัวแผง · unit = เรียกหมวดย่อยว่าอะไร · pick = ที่ปิดไว้จะไม่ขึ้นให้เลือก "ที่ไหน" */
export const PANE_INFO = {
  cancel_case: { title: 'เหตุผลยกเลิกเคส', desc: 'เหตุผลที่ให้เลือกตอนยกเลิกเคส — ใช้ดูรายงานว่าเคสถูกยกเลิกเพราะอะไร', unit: 'เหตุผล', pick: 'ตอนยกเลิกเคส' },
  cancel_visit: { title: 'เหตุผลยกเลิกนัด / กะ', desc: 'เหตุผลที่ให้เลือกตอนยกเลิกนัดกายภาพหรือกะ Homecare', unit: 'เหตุผล', pick: 'ตอนยกเลิกนัด' },
  cancel_invoice: { title: 'เหตุผลยกเลิกใบแจ้งหนี้', desc: 'เหตุผลที่ให้เลือกตอนยกเลิกใบแจ้งหนี้', unit: 'เหตุผล', pick: 'ตอนยกเลิกใบแจ้งหนี้' },
  incident: { title: 'หมวดเหตุการณ์ผิดปกติ', desc: 'จัดกลุ่มเหตุการณ์ในรายงานการดูแล — ตัวเหตุการณ์กำหนดในระบบ แก้ชื่อหมวด ลำดับ และเปิด-ปิดได้', unit: 'หมวด', pick: 'ในรายงาน' },
  procedure: { title: 'หมวดหัตถการ', unit: 'หมวดย่อย', pick: 'ในฟอร์มเคส', example: 'ทางเดินหายใจ' },
  equipment: { title: 'หมวดอุปกรณ์เสริม', unit: 'หมวดย่อย', pick: 'ในฟอร์มเคส', example: 'อุปกรณ์ทางเดินหายใจ' },
};

// ช่องราคาของรายการ (catalog_prices · server PRICE_FIELDS) — หัตถการ: ครั้ง/วัน/เดือน · อุปกรณ์: เช่า/ขาย ต่อหน่วย
const PRICE_LABELS = { price_visit: 'ต่อครั้ง', price_day: 'ต่อวัน', price_month: 'ต่อเดือน', price_rent: 'ค่าเช่า', price_sale: 'ราคาขาย' };
const PROC_BY_CODE = Object.fromEntries(PROCEDURE_CATALOG.map((p) => [p.code, p]));
const STATIC_ITEMS = {
  procedure: PROCEDURE_CATALOG.map((p) => ({ key: p.code, label: `${p.code} ${p.name}`, short: p.name })),
  incident: [...INCIDENT_TYPES, ...PHYSIO_INCIDENT_TYPES].map((o) => ({ key: o.value, label: o.label })),
};

/** สวิตช์เปิด/ปิดใช้ — checkbox จริง วาดเป็นสวิตช์ (.perm-check ของหน้าจัดการสิทธิ์) */
function ActiveSwitch({ on, busy, name, onToggle, locked = false }) {
  return (
    <label className={`set-switch${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
      title={locked ? 'หมวดหลักปิดอยู่ — เปิดหมวดหลักก่อน' : undefined}>
      <input type="checkbox" role="switch" className="perm-check" checked={on} disabled={busy || locked}
        aria-label={`${on ? 'ปิด' : 'เปิด'}ใช้ ${name}`} onChange={onToggle} />
      <span>{on ? 'เปิดใช้งาน' : 'ปิดอยู่'}</span>
    </label>
  );
}

/** ปุ่มแก้ไข — ระหว่างแก้ชื่อยังกินที่เท่าเดิม (ซ่อนแบบมองไม่เห็น) สวิตช์จะได้ไม่กระโดด */
function EditButton({ editing, busy, onClick }) {
  return (
    <button type="button" className={`btn tiny set-edit-btn${editing ? ' is-hidden' : ''}`} disabled={busy || editing}
      aria-hidden={editing || undefined} tabIndex={editing ? -1 : undefined} onClick={onClick}>แก้ไข</button>
  );
}

/** ช่องแก้ชื่อในที่ — Enter บันทึก · Esc ยกเลิก */
function NameInput({ value, busy, onSave, onCancel }) {
  const [text, setText] = useState(value);
  const save = async () => {
    const next = text.trim();
    if (!next || next === value) return onCancel();
    if (await onSave(next)) onCancel();
  };
  return (
    <span className="set-name-edit">
      <input autoFocus value={text} maxLength={120} aria-label="ชื่อหมวด" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }} />
      <button type="button" className="btn tiny primary" disabled={busy} onClick={save}>บันทึก</button>
      <button type="button" className="btn tiny" disabled={busy} onClick={onCancel}>ยกเลิก</button>
    </span>
  );
}

/** ฟอร์มเพิ่ม — หมวดหลักตั้งรหัส 3 ตัว (withCode) · หมวดย่อยได้เลขถัดไปเอง */
function AddForm({ placeholder, withCode = false, prefix, busy, onAdd, onCancel }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const ready = name.trim() && (!withCode || /^[A-Z]{3}$/.test(code));
  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    if (await onAdd({ code: withCode ? code : undefined, name_th: name.trim() })) {
      setCode('');
      setName('');
      onCancel?.();
    }
  };
  return (
    <form className="set-add" onSubmit={submit}>
      {withCode && (
        <label className="set-add-code" title="ตัวอักษรภาษาอังกฤษพิมพ์ใหญ่ 3 ตัว — ตั้งแล้วเปลี่ยนไม่ได้">
          <span className="mono muted">{prefix}-</span>
          <input value={code} maxLength={3} placeholder="ABC" aria-label="รหัสหมวดหลัก 3 ตัวอักษร"
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
        </label>
      )}
      <input autoFocus={!withCode} value={name} maxLength={120} placeholder={placeholder} aria-label={placeholder}
        onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn primary" disabled={busy || !ready}>เพิ่ม</button>
      {onCancel && <button type="button" className="btn" disabled={busy} onClick={onCancel}>ยกเลิก</button>}
    </form>
  );
}

/** ช่องราคาหนึ่งช่อง — บันทึกเมื่อออกจากช่อง/กด Enter (ค่าเปลี่ยนเท่านั้น) · ว่าง = ไม่มีราคาแบบนี้ */
function PriceInput({ label, value, busy, onSave }) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const clean = text.replace(/,/g, '').trim();
    if (clean === shown) return;
    if (clean !== '' && !(Number(clean) >= 0)) { setText(shown); return; }
    onSave(clean === '' ? null : Number(clean));
  };
  return (
    <label className="set-price">
      <small>{label}</small>
      <span className="set-price-box">
        <input type="number" min="0" step="0.01" inputMode="decimal" value={text} placeholder="—" disabled={busy}
          aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
        <span className="muted">฿</span>
      </span>
    </label>
  );
}

/** แถวรายการพร้อมช่องราคา (หัตถการ/อุปกรณ์) — ราคาของหัตถการที่ยังไม่ตั้ง = ราคาตั้งต้นในโค้ด */
function PricedItems({ domain, keys, kind, labels, fields, priceOf, busy, onRemove, onPrice }) {
  return (
    <ul className="set-item-rows">
      {keys.map((k) => {
        const proc = domain === 'procedure' ? PROC_BY_CODE[k] : null;
        const row = priceOf(k);
        const current = row ?? (proc ? defaultPrices(proc) : {});
        // ช่วงราคาในตารางเดิม (เช่น 12,000/8,000) — ช่องเก็บได้ตัวเลขเดียว บอกไว้ให้รู้ว่าเดิมมีสองระดับ
        const ranged = !row && proc && Object.values(proc.rates).some((t) => t && /[/-]/.test(t));
        return (
          <li key={k} className={`set-item-row${kind === 'free' || labels[k] ? '' : ' is-missing'}`}>
            <div className="set-item-name">
              {proc ? <><span className="mono muted">{k}</span> {proc.name}</> : <span>{labels[k] ?? (kind === 'free' ? k : `${k} (ไม่พบในระบบแล้ว)`)}</span>}
              {ranged && (
                <small className="muted">ตารางราคาเดิม: {Object.entries(proc.rates).filter(([, t]) => t).map(([r, t]) => `${PRICE_LABELS[`price_${r}`]} ${t}`).join(' · ')}</small>
              )}
            </div>
            <div className="set-item-prices">
              {fields.map((f) => (
                <PriceInput key={f} label={PRICE_LABELS[f]} value={current[f] ?? null} busy={busy}
                  onSave={(v) => onPrice(k, { ...Object.fromEntries(fields.map((x) => [x, current[x] ?? null])), [f]: v })} />
              ))}
            </div>
            <button type="button" className="cat-chip-x" disabled={busy} aria-label={`เอา ${labels[k] ?? k} ออกจากหมวด`}
              title="เอาออกจากหมวด" onClick={() => onRemove(k)}>×</button>
          </li>
        );
      })}
    </ul>
  );
}

/** ชิปรายการในหมวดย่อย + ช่องเพิ่ม (เลือกจากแคตตาล็อก หรือพิมพ์ชื่อสำหรับอุปกรณ์) · มีราคา = แถวพร้อมช่องราคาแทนชิป */
function ItemEditor({ c, domain, kind, itemLabel, catalog, labels, ownerOf, priceFields, priceOf, busy, onSet, onPrice, visible = null }) {
  const keys = c.item_keys ?? [];
  // ตัวกรองด้านบน — แสดงเฉพาะรายการที่ตรง แต่เพิ่ม/เอาออกยังคิดจากรายการเต็มของหมวด
  const shown = visible ? keys.filter((k) => visible(k)) : keys;
  const [text, setText] = useState('');
  const addFree = async () => {
    const name = text.trim();
    if (!name) return;
    if (keys.some((k) => k.toLowerCase() === name.toLowerCase())) { setText(''); return; }
    if (await onSet(c, [...keys, name])) setText('');
  };
  const choices = (catalog ?? []).filter((it) => !keys.includes(it.key));
  return (
    <div className="set-items">
      {shown.length > 0 && priceFields && (
        <PricedItems domain={domain} keys={shown} kind={kind} labels={labels} fields={priceFields} priceOf={priceOf} busy={busy}
          onRemove={(k) => onSet(c, keys.filter((x) => x !== k))} onPrice={onPrice} />
      )}
      {shown.length > 0 && !priceFields && (
        <ul className="cat-chips">
          {shown.map((k) => (
            <li key={k} className={`cat-chip${kind === 'free' || labels[k] ? '' : ' is-missing'}`}>
              <span>{labels[k] ?? (kind === 'free' ? k : `${k} (ไม่พบในระบบแล้ว)`)}</span>
              <button type="button" className="cat-chip-x" disabled={busy} aria-label={`เอา ${labels[k] ?? k} ออกจากหมวด`}
                title="เอาออกจากหมวด" onClick={() => onSet(c, keys.filter((x) => x !== k))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {kind === 'free' ? (
        <div className="cat-item-add">
          <input value={text} maxLength={120} placeholder={`พิมพ์ชื่อ${itemLabel} เช่น เตียงลม`} aria-label={`เพิ่ม${itemLabel}ใน ${c.name_th}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFree(); } }} />
          <button type="button" className="btn tiny primary" disabled={busy || !text.trim()} onClick={addFree}>+ เพิ่ม</button>
        </div>
      ) : catalog && choices.length > 0 && (
        <div className="cat-item-add">
          <SearchSelect value="" disabled={busy} aria-label={`เพิ่ม${itemLabel}ใน ${c.name_th}`}
            onChange={(e) => e.target.value && onSet(c, [...keys, e.target.value])}>
            <option value="">+ เพิ่ม{itemLabel}เข้าหมวดนี้…</option>
            {choices.map((it) => (
              <option key={it.key} value={it.key}>
                {`${it.label}${it.off ? ' (ปิดขาย)' : ''}${ownerOf.get(it.key) ? ` — ย้ายจาก ${ownerOf.get(it.key).name_th}` : ''}`}
              </option>
            ))}
          </SearchSelect>
        </div>
      )}
    </div>
  );
}

/** แถวหมวดย่อย — เลข · ชื่อ/รหัส · สวิตช์ · แก้ไข (+ รายการของแคตตาล็อก) */
function SubRow({ c, parentOn, busy, labels, kind, meta, editor, onPatch, forceOpen = false }) {
  // forceOpen = มีคำค้นอยู่ (เลือกแค่หมวดหลักไม่นับ — กางทุกหมวดย่อยพร้อมราคาจะยาวเหมือนเดิม)
  const [editing, setEditing] = useState(false);
  /* แคตตาล็อก (หัตถการ/อุปกรณ์): รายการ + ช่องราคาพับเก็บไว้ตั้งต้น กดจำนวนรายการเพื่อกาง (ผู้ใช้ขอ 20 พ.ย. 2569
     "การ์ดเล็กลง รายการมากขึ้นหน้าจะยาวเกิน") · ค้นหาอยู่ = กางให้เอง จะได้เห็นรายการที่ตรง */
  const [open, setOpen] = useState(false);
  const shownOpen = open || forceOpen;
  const items = c.item_keys ?? [];
  const num = c.code.split('-').pop();
  let sub = <span className="mono">{c.code}</span>;
  if (kind) {
    sub = (
      <>
        <span className="mono">{c.code}</span> ·{' '}
        <button type="button" className="set-fold-link" aria-expanded={shownOpen} onClick={() => setOpen(!shownOpen)}>
          {items.length} {meta.itemLabel}
          <LineIcon name="chevron" className={`set-fold-ico${shownOpen ? ' is-open' : ''}`} />
        </button>
      </>
    );
  } else if (items.length > 0) sub = <><span className="mono">{c.code}</span> · {items.map((k) => labels[k] ?? k).join(' · ')}</>;
  return (
    <li className={`set-row${c.active ? '' : ' is-off'}${kind ? ' is-catalog' : ''}`}>
      <div className="set-row-main">
        <span className="set-row-ico mono" aria-hidden="true">{num}</span>
        <div className="set-row-text">
          {editing
            ? <NameInput value={c.name_th} busy={busy} onSave={(name_th) => onPatch(c, { name_th })} onCancel={() => setEditing(false)} />
            : <strong>{c.name_th}</strong>}
          <span className="set-row-sub">{sub}</span>
        </div>
        <div className="set-row-tools">
          {/* หมวดหลักปิดอยู่ = หมวดย่อยปิดตามและล็อกสวิตช์ไว้ (เปิดที่หมวดหลักแล้วเปิดตามทั้งหมด) */}
          <ActiveSwitch on={c.active} locked={!parentOn} busy={busy} name={c.name_th} onToggle={() => onPatch(c, { active: !c.active })} />
          <EditButton editing={editing} busy={busy} onClick={() => setEditing(true)} />
        </div>
      </div>
      {(!kind || shownOpen) && editor}
    </li>
  );
}

/** การ์ดหมวดหลัก — หัวการ์ด (ชื่อ · รหัส · นับที่เปิดใช้ · ปุ่ม) + แถวหมวดย่อย */
function MainCard({ main, busy, labels, kind, meta, info, editorFor, onPatch, onAddSub, shownSubs = null, forceOpen = false, openItems = false }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  /* แคตตาล็อก: การ์ดหมวดหลักพับเก็บตั้งต้น เหลือหัวการ์ดบรรทัดเดียว — กดชื่อหมวดเพื่อกาง (20 พ.ย. 2569)
     กำลังเพิ่มหมวดย่อย/ค้นหาอยู่ = กางให้เอง · หน้าเหตุผลยกเลิก/เหตุการณ์ไม่พับ (รายการสั้นอยู่แล้ว) */
  const [open, setOpen] = useState(false);
  const foldable = Boolean(kind);
  const shownOpen = !foldable || open || forceOpen || adding;
  const subs = main.children;
  const listed = shownSubs ?? subs; // ตัวกรองด้านบน — ตัวนับ "เปิดใช้งาน X จาก Y" ยังนับจากทั้งหมวด
  const on = subs.filter((s) => s.active).length;
  /* กดตรงไหนของการ์ดก็กางได้ (ผู้ใช้ขอ 20 พ.ย. 2569 "คลิกที่ตัวการ์ดเพื่อเปิด") — กางแล้วกดหัวการ์ดเพื่อพับ
     (กดในแถวหมวดย่อยไม่พับ) · ยกเว้นปุ่ม/สวิตช์/ช่องพิมพ์ ซึ่งทำงานของตัวเอง
     ปุ่มลูกศร+ชื่อ (set-fold-btn) ยังเป็นปุ่มจริงไว้ให้คีย์บอร์ด/โปรแกรมอ่านหน้าจอ — ตัวการ์ดเป็นพื้นที่กดเสริมของเมาส์ */
  const clickable = foldable && !editing && !forceOpen && !adding;
  const toggleFromCard = (e) => {
    if (!clickable) return;
    if (e.target.closest('button, a, input, select, textarea, label, form')) return;
    if (shownOpen && !e.target.closest('.set-card-head')) return;
    if (window.getSelection?.().toString()) return; // ลากคลุมข้อความ (เช่นคัดลอกรหัส) ไม่นับเป็นการกด
    setOpen(!shownOpen);
  };
  return (
    <section className={`set-card${main.active ? '' : ' is-off'}${shownOpen ? '' : ' is-folded'}${clickable ? ' is-clickable' : ''}`}
      aria-label={main.name_th} onClick={toggleFromCard}>
      <header className="set-card-head">
        <div className="set-card-title">
          {editing ? (
            <NameInput value={main.name_th} busy={busy} onSave={(name_th) => onPatch(main, { name_th })} onCancel={() => setEditing(false)} />
          ) : (
            foldable ? (
              <button type="button" className="set-fold-btn" aria-expanded={shownOpen} onClick={() => setOpen(!shownOpen)}>
                {/* กรอบสี่เหลี่ยมรอบลูกศร (ดีไซน์ v2) — พื้นทองอ่อนตอนกางอยู่ */}
                <span className="set-fold-box" aria-hidden="true"><LineIcon name="chevron" className={`set-fold-ico${shownOpen ? ' is-open' : ''}`} /></span>
                <h3>{main.name_th} <span className="mono set-code">{main.code}</span></h3>
              </button>
            ) : <h3>{main.name_th} <span className="mono set-code">{main.code}</span></h3>
          )}
          <p className="muted">
            {main.active
              ? `เปิดใช้งาน ${on} จาก ${subs.length} ${info.unit} · ที่ปิดไว้จะไม่ขึ้นให้เลือก${info.pick}`
              : `ปิดทั้งหมวด — ${info.unit}ทั้งหมดปิดตาม ไม่ขึ้นให้เลือก${info.pick} · เปิดหมวดนี้แล้วเปิดตามทั้งหมด`}
          </p>
        </div>
        {/* ปุ่มเพิ่มอยู่ซ้ายสุด — สวิตช์ + แก้ไข ชิดขวาตรงคอลัมน์เดียวกับของแถวหมวดย่อยข้างล่าง */}
        <div className="set-card-tools">
          {meta.editable && (
            <button type="button" className="btn tiny set-add-btn" disabled={busy} onClick={() => setAdding((v) => !v)}>
              + เพิ่ม{kind ? 'หมวดย่อย' : info.unit}
            </button>
          )}
          <ActiveSwitch on={main.active} busy={busy} name={main.name_th} onToggle={() => onPatch(main, { active: !main.active })} />
          <EditButton editing={editing} busy={busy} onClick={() => setEditing(true)} />
        </div>
      </header>
      {shownOpen && (listed.length > 0 ? (
        <ul className="set-rows">
          {listed.map((s) => (
            <SubRow key={s.category_id} c={s} parentOn={main.active} busy={busy} labels={labels} kind={kind} meta={meta}
              editor={editorFor(s)} onPatch={onPatch} forceOpen={openItems} />
          ))}
        </ul>
      ) : <p className="muted set-empty">ยังไม่มี{kind ? 'หมวดย่อย' : info.unit}ในหมวดนี้</p>)}
      {adding && (
        <AddForm placeholder={`ชื่อ${kind ? 'หมวดย่อย' : info.unit}ใหม่ใน "${main.name_th}"`} busy={busy}
          onAdd={(body) => onAddSub(main, body)} onCancel={() => setAdding(false)} />
      )}
    </section>
  );
}

export default function CategoryManager({ domain }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addingMain, setAddingMain] = useState(false);
  // ตัวกรองด้านบน (ผู้ใช้ขอ 19 พ.ย. 2569) — ค้นชื่อ/รหัสรายการหรือชื่อหมวด + เลือกหมวดหลัก
  const [query, setQuery] = useState('');
  const [mainFilter, setMainFilter] = useState('');

  const load = useCallback(
    () => api.categories({ all: '1', domain }).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)),
    [domain],
  );
  useEffect(() => { setData(null); setAddingMain(false); setQuery(''); setMainFilter(''); load(); }, [load]);

  const meta = data?.domains?.[domain];
  const info = PANE_INFO[domain] ?? { title: meta?.label ?? '', desc: '', unit: 'หมวดย่อย', pick: '' };
  const tree = treeOf(data?.categories, domain);
  const kind = meta?.items ?? null;
  // หัตถการ = รายการในโค้ด · อุปกรณ์ = ชื่อที่พิมพ์เอง (ไม่มีรายการให้เลือก)
  const catalog = kind === 'procedure' ? STATIC_ITEMS.procedure : null;
  const labels = useMemo(
    () => Object.fromEntries((catalog ?? STATIC_ITEMS[domain] ?? []).map((it) => [it.key, it.label])),
    [catalog, domain],
  );
  // รายการ → หมวดย่อยที่ถืออยู่ (ไว้บอก "ย้ายจาก …" และหา "ยังไม่จัดหมวด")
  const ownerOf = new Map();
  for (const main of tree) for (const sub of main.children) for (const k of sub.item_keys ?? []) ownerOf.set(k, sub);
  /* ---------- ตัวกรอง ----------
     คำค้นตรงชื่อหมวดหลัก/ย่อย = โชว์ทั้งหมวดนั้น · ตรงรายการ = โชว์เฉพาะหมวดย่อยที่มีรายการนั้น และเฉพาะรายการที่ตรง */
  const q = query.trim().toLowerCase();
  const hit = (text) => String(text ?? '').toLowerCase().includes(q);
  const itemHit = (k) => hit(k) || hit(labels[k]);
  const filtering = q !== '' || mainFilter !== '';
  const view = tree
    .filter((main) => !mainFilter || String(main.category_id) === mainFilter)
    .map((main) => {
      if (!q || hit(main.name_th) || hit(main.code)) return { main, subs: main.children, visible: null };
      const subs = main.children.filter((s) => hit(s.name_th) || hit(s.code) || (s.item_keys ?? []).some(itemHit));
      return { main, subs, visible: (k) => itemHit(k) };
    })
    .filter((v) => !q || v.subs.length > 0 || hit(v.main.name_th) || hit(v.main.code));
  // หมวดย่อยที่ตรงเพราะชื่อหมวด (ไม่ใช่รายการ) โชว์รายการครบ
  const visibleFor = (v, sub) => (!q || !v.visible || hit(sub.name_th) || hit(sub.code) ? null : v.visible);
  const shownCount = view.reduce(
    (n, v) => n + v.subs.reduce((m, s) => m + (visibleFor(v, s) ? (s.item_keys ?? []).filter(visibleFor(v, s)).length : (s.item_keys ?? []).length), 0),
    0,
  );
  const loose = catalog ? catalog.filter((it) => !ownerOf.has(it.key) && (!q || hit(it.label) || hit(it.key))) : [];
  const subs = tree.flatMap((main) => main.children.map((sub) => ({ sub, label: `${main.name_th} › ${sub.name_th}` })));

  /** ทำรายการแล้วโหลดใหม่ + ล้างแคชของช่องเลือกทั่วระบบ · คืน true ถ้าสำเร็จ */
  async function run(fn, done) {
    setBusy(true);
    try {
      await fn();
      invalidateCategories();
      await load();
      if (done) toast(done);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  // หมวดหลัก: server เปิด/ปิดหมวดย่อยตามให้ทั้งหมด (categories/repo.js update)
  const patch = (c, body) => run(() => api.updateCategory(c.category_id, body),
    'active' in body
      ? `${body.active ? 'เปิด' : 'ปิด'}ใช้ ${c.name_th}${c.parent_id == null ? ` และ${info.unit}ทั้งหมด` : ''} แล้ว`
      : `บันทึก ${c.code} แล้ว`);
  const add = (body) => run(() => api.createCategory({ domain, ...body }), 'เพิ่มหมวดแล้ว');
  const setItems = (c, keys) => run(() => api.setCategoryItems(c.category_id, keys), `บันทึก ${c.name_th} แล้ว`);
  // ราคาของรายการ (หัตถการ/อุปกรณ์) — server เก็บทั้งชุดของรายการนั้น ส่งทุกช่องไปพร้อมกัน
  const priceFields = data?.price_fields?.[domain] ?? null;
  const priceOf = (k) => (data?.prices ?? []).find((p) => p.domain === domain && p.item_key === k) ?? null;
  const setPrice = (k, values) => run(() => api.setCatalogPrice({ domain, item_key: k, ...values }), `บันทึกราคา ${labels[k] ?? k} แล้ว`);
  const editorFor = (sub, visible = null) => kind && (
    <ItemEditor c={sub} visible={visible} domain={domain} kind={kind} itemLabel={meta.itemLabel} catalog={catalog} labels={labels} ownerOf={ownerOf}
      priceFields={priceFields} priceOf={priceOf} busy={busy} onSet={setItems} onPrice={setPrice} />
  );

  const head = (
    <SettingsPaneHead
      title={info.title}
      /* หัตถการ/อุปกรณ์ไม่มีคำอธิบายตายตัว — ดีไซน์ v2 ให้บอกจำนวนหมวด (นับจากข้อมูลที่โหลดมาแล้ว) */
      desc={info.desc || (data && kind ? `${tree.length} หมวดหลัก · ${subs.length} หมวดย่อย · เฉพาะหมวดที่เปิดใช้งานจะขึ้นให้เลือก${info.pick}` : info.desc)}
      action={meta?.editable && (
        <button type="button" className="btn" disabled={busy || !data} onClick={() => setAddingMain((v) => !v)}>+ เพิ่มหมวดหลัก</button>
      )}
    />
  );
  if (!data) return <>{head}{error ? <ErrorBar message={error} onRetry={load} /> : <p className="muted">กำลังโหลด…</p>}</>;

  return (
    <>
      {head}
      <ErrorBar message={error} onRetry={load} busy={busy} />

      {/* ตัวกรองด้านบน — ค้นชื่อ/รหัส + เลือกหมวดหลัก (หมวดเยอะ/รายการเยอะแล้วหาไม่เจอ) */}
      {tree.length > 0 && (
        <div className="set-filter" role="search">
          <label className="set-filter-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input type="search" value={query} placeholder={kind ? `ค้นหา${meta.itemLabel} ชื่อหรือรหัส หรือชื่อหมวด` : `ค้นหาชื่อ${info.unit}หรือหมวด`}
              aria-label="ค้นหา" onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setQuery(''); } }} />
          </label>
          <SearchSelect value={mainFilter} aria-label="เลือกหมวดหลัก" onChange={(e) => setMainFilter(e.target.value)}>
            <option value="">ทุกหมวดหลัก ({tree.length})</option>
            {tree.map((m) => <option key={m.category_id} value={m.category_id}>{m.name_th}</option>)}
          </SearchSelect>
          {filtering && (
            <span className="set-filter-result">
              {kind ? `พบ ${shownCount + loose.length} ${meta.itemLabel}` : `พบ ${view.reduce((n, v) => n + v.subs.length, 0)} ${info.unit}`}
              <button type="button" className="btn tiny ghost" onClick={() => { setQuery(''); setMainFilter(''); }}>ล้างตัวกรอง</button>
            </span>
          )}
        </div>
      )}

      {addingMain && (
        <section className="set-card" aria-label="เพิ่มหมวดหลัก">
          <header className="set-card-head">
            <div className="set-card-title">
              <h3>เพิ่มหมวดหลัก</h3>
              <p className="muted">ตั้งรหัส 3 ตัวอักษรภาษาอังกฤษ — รหัสเต็มเป็น <span className="mono">{meta.prefix}-ABC</span> ตั้งแล้วเปลี่ยนไม่ได้</p>
            </div>
          </header>
          <AddForm withCode prefix={meta.prefix} placeholder={`ชื่อหมวดหลัก เช่น ${info.example ?? 'ฝั่งลูกค้า'}`} busy={busy}
            onAdd={add} onCancel={() => setAddingMain(false)} />
        </section>
      )}

      {loose.length > 0 && (
        <section className="set-card is-warn" aria-label={`${meta.itemLabel}ที่ยังไม่จัดหมวด`}>
          <header className="set-card-head">
            <div className="set-card-title">
              <h3>ยังไม่จัดหมวด</h3>
              <p className="muted">{loose.length} {meta.itemLabel} · ในฟอร์มเคสจะอยู่กลุ่ม "อื่น ๆ" ท้ายรายการ</p>
            </div>
          </header>
          <ul className="set-rows">
            {loose.map((it) => (
              <li key={it.key} className="set-row">
                <div className="set-row-main">
                  <div className="set-row-text">
                    <strong className={it.off ? 'muted' : ''}>{it.label}</strong>
                    {it.off && <span className="set-row-sub">ปิดขายแล้ว</span>}
                  </div>
                  <div className="set-row-tools">
                    {subs.length > 0 ? (
                      <SearchSelect value="" disabled={busy} aria-label={`เลือกหมวดให้ ${it.label}`}
                        onChange={(e) => {
                          const target = subs.find((x) => String(x.sub.category_id) === e.target.value)?.sub;
                          if (target) setItems(target, [...(target.item_keys ?? []), it.key]);
                        }}>
                        <option value="">เลือกหมวด…</option>
                        {subs.map(({ sub, label }) => <option key={sub.category_id} value={sub.category_id}>{label}</option>)}
                      </SearchSelect>
                    ) : <span className="muted">สร้างหมวดหลักและหมวดย่อยก่อน</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.map((v) => (
        <MainCard key={v.main.category_id} main={v.main} shownSubs={filtering ? v.subs : null} forceOpen={filtering} openItems={q !== ''} busy={busy} labels={labels} kind={kind} meta={meta}
          info={info} editorFor={(sub) => editorFor(sub, visibleFor(v, sub))} onPatch={patch}
          onAddSub={(m, body) => add({ ...body, parent_id: m.category_id })} />
      ))}
      {filtering && view.length === 0 && loose.length === 0 && (
        <section className="set-card set-blank">
          <p className="muted">ไม่พบรายการที่ตรงกับตัวกรอง</p>
        </section>
      )}
      {tree.length === 0 && !addingMain && (
        <section className="set-card set-blank">
          <p className="muted">ยังไม่มีหมวด — กด "+ เพิ่มหมวดหลัก" ด้านบนเพื่อเริ่ม</p>
        </section>
      )}
      <p className="muted set-foot">รหัส <span className="mono">{meta.prefix}-หมวดหลัก-เลขหมวดย่อย</span> ตั้งแล้วเปลี่ยนไม่ได้ · ไม่มีการลบ ใช้สวิตช์ปิดแทน (ข้อมูลเก่ายังอ่านชื่อหมวดได้)</p>
    </>
  );
}
