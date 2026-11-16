import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import { invalidateCategories, treeOf } from '../lib/categories.js';
import { PROCEDURE_CATALOG } from '../lib/procedureCatalog.js';
import { INCIDENT_TYPES, PHYSIO_INCIDENT_TYPES } from '../lib/dailyCare.js';

/**
 * หมวดหมู่ (cat / sub cat) — สิทธิ์ categories (หน้าจัดการสิทธิ์) · server/src/categories (16 พ.ย. 2569 เฟสแรก)
 *
 * เลือกโดเมนด้านบน (จำไว้ใน ?domain=) แล้วเห็นหมวดหลัก → หมวดย่อย พร้อมรหัส
 *   · โดเมนเหตุผล: เพิ่มหมวดหลัก (ตั้งรหัส 3 ตัว) / เพิ่มเหตุผล (เลขถัดไปให้เอง) / แก้ชื่อ / เลื่อนลำดับ / เปิด-ปิด
 *   · โดเมนที่รายการอยู่ในระบบ (หัตถการ · เหตุการณ์): แก้ชื่อ / ลำดับ / เปิด-ปิด และเห็นว่าแต่ละหมวดมีรายการอะไร
 * ไม่มีปุ่มลบโดยตั้งใจ — ปิดใช้แทน ข้อมูลเก่าที่อ้างหมวดนั้นยังอ่านชื่อได้
 */

const ITEM_LABELS = {
  procedure: Object.fromEntries(PROCEDURE_CATALOG.map((p) => [p.code, `${p.code} ${p.name}`])),
  incident: Object.fromEntries([...INCIDENT_TYPES, ...PHYSIO_INCIDENT_TYPES].map((o) => [o.value, o.label])),
};

function NameEditor({ value, onSave, busy }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  if (!editing) {
    return (
      <span className="cat-name">
        {value}
        <button type="button" className="btn tiny ghost" disabled={busy} onClick={() => { setText(value); setEditing(true); }}>
          แก้ชื่อ
        </button>
      </span>
    );
  }
  const save = async () => {
    const next = text.trim();
    if (!next || next === value) return setEditing(false);
    if (await onSave(next)) setEditing(false);
  };
  return (
    <span className="cat-name is-editing">
      <input
        autoFocus
        value={text}
        maxLength={120}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); }
        }}
      />
      <button type="button" className="btn tiny primary" disabled={busy} onClick={save}>บันทึก</button>
      <button type="button" className="btn tiny" disabled={busy} onClick={() => setEditing(false)}>ยกเลิก</button>
    </span>
  );
}

function AddForm({ placeholder, withCode = false, prefix, busy, onAdd }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const ready = name.trim() && (!withCode || /^[A-Z]{3}$/.test(code));
  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    if (await onAdd({ code: withCode ? code : undefined, name_th: name.trim() })) {
      setCode('');
      setName('');
    }
  };
  return (
    <form className="cat-add" onSubmit={submit}>
      {withCode && (
        <label className="cat-add-code" title="ตัวอักษรภาษาอังกฤษพิมพ์ใหญ่ 3 ตัว — ตั้งแล้วเปลี่ยนไม่ได้">
          <span className="mono muted">{prefix}-</span>
          <input
            value={code}
            maxLength={3}
            placeholder="ABC"
            aria-label="รหัสหมวดหลัก 3 ตัวอักษร"
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          />
        </label>
      )}
      <input value={name} maxLength={120} placeholder={placeholder} aria-label={placeholder} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn tiny primary" disabled={busy || !ready}>+ เพิ่ม</button>
    </form>
  );
}

function Row({ c, siblings, index, domain, busy, onPatch, onMove, children }) {
  const items = c.item_keys ?? [];
  return (
    <div className={`cat-row${c.active ? '' : ' is-off'}`}>
      <div className="cat-row-head">
        <span className="mono cat-code">{c.code}</span>
        <NameEditor value={c.name_th} busy={busy} onSave={(name_th) => onPatch(c, { name_th })} />
        <span className="cat-row-tools">
          {!c.active && <span className="badge resigned">ปิดใช้</span>}
          <button type="button" className="btn tiny ghost" disabled={busy || index === 0} title="เลื่อนขึ้น" aria-label="เลื่อนขึ้น"
            onClick={() => onMove(siblings, index, -1)}>▲</button>
          <button type="button" className="btn tiny ghost" disabled={busy || index === siblings.length - 1} title="เลื่อนลง" aria-label="เลื่อนลง"
            onClick={() => onMove(siblings, index, 1)}>▼</button>
          <button type="button" className={`btn tiny ${c.active ? 'danger-ghost' : ''}`} disabled={busy}
            onClick={() => onPatch(c, { active: !c.active })}>
            {c.active ? 'ปิดใช้' : 'เปิดใช้'}
          </button>
        </span>
      </div>
      {items.length > 0 && (
        <ul className="cat-items">
          {items.map((k) => <li key={k}>{ITEM_LABELS[domain]?.[k] ?? k}</li>)}
        </ul>
      )}
      {children}
    </div>
  );
}

export default function CategoriesPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.categories({ all: '1' }).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const domains = data?.domains ?? {};
  const domainKeys = Object.keys(domains);
  const domain = domainKeys.includes(params.get('domain')) ? params.get('domain') : domainKeys[0];
  const meta = domains[domain];
  const tree = treeOf(data?.categories, domain);

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

  const patch = (c, body) => run(() => api.updateCategory(c.category_id, body),
    'active' in body ? `${body.active ? 'เปิด' : 'ปิด'}ใช้ ${c.code} แล้ว` : `บันทึก ${c.code} แล้ว`);
  /* เลื่อนขึ้น/ลงหนึ่งช่อง — สลับในรายการแล้วไล่ตั้งลำดับใหม่เป็น 10, 20, 30 …
     แก้เฉพาะตัวที่เลขเปลี่ยน · ถูกเสมอแม้ข้อมูลเก่ามีลำดับซ้ำกัน */
  const move = (siblings, index, dir) => run(async () => {
    const order = siblings.slice();
    [order[index], order[index + dir]] = [order[index + dir], order[index]];
    for (const [i, c] of order.entries()) {
      if (c.sort_order !== (i + 1) * 10) await api.updateCategory(c.category_id, { sort_order: (i + 1) * 10 });
    }
  });
  const add = (body) => run(() => api.createCategory({ domain, ...body }), 'เพิ่มหมวดแล้ว');

  if (!data) return error ? <ErrorBar message={error} onRetry={load} /> : <p className="muted">กำลังโหลด…</p>;

  return (
    <>
      <h1 className="sr-only">หมวดหมู่</h1>
      <div className="list-card cat-page">
        <nav className="cat-domains" aria-label="ประเภทหมวด">
          {domainKeys.map((k) => (
            <button key={k} type="button" className={`cat-domain${k === domain ? ' is-on' : ''}`}
              onClick={() => setParams({ domain: k }, { replace: true })}>
              <span>{domains[k].label}</span>
              <small className="mono">{domains[k].prefix}</small>
            </button>
          ))}
        </nav>

        <ErrorBar message={error} onRetry={load} busy={busy} />

        <p className="muted cat-hint">
          รหัส: <span className="mono">{meta.prefix}-หมวดหลัก-เลขหมวดย่อย</span> · ตั้งแล้วเปลี่ยนไม่ได้ · ไม่มีการลบ ใช้ "ปิดใช้" แทน
          {meta.editable
            ? ' · เหตุผลที่เพิ่มขึ้นในช่องเลือกตอนยกเลิกทันที'
            : ` · ${meta.itemLabel}แต่ละรายการกำหนดในระบบ — หน้านี้แก้ชื่อหมวด ลำดับ และเปิด-ปิดได้`}
        </p>

        <div className="cat-tree">
          {tree.map((main, i) => (
            <Row key={main.category_id} c={main} siblings={tree} index={i} domain={domain} busy={busy} onPatch={patch} onMove={move}>
              <div className="cat-children">
                {main.children.map((sub, j) => (
                  <Row key={sub.category_id} c={sub} siblings={main.children} index={j} domain={domain} busy={busy} onPatch={patch} onMove={move} />
                ))}
                {meta.editable && (
                  <AddForm placeholder={`เพิ่มเหตุผลใน "${main.name_th}"`} busy={busy}
                    onAdd={(body) => add({ ...body, parent_id: main.category_id })} />
                )}
              </div>
            </Row>
          ))}
          {tree.length === 0 && <p className="muted">ยังไม่มีหมวด</p>}
        </div>

        {meta.editable && (
          <div className="cat-add-main">
            <p className="field-label">เพิ่มหมวดหลัก</p>
            <AddForm withCode prefix={meta.prefix} placeholder="ชื่อหมวดหลัก เช่น ฝั่งลูกค้า" busy={busy} onAdd={add} />
          </div>
        )}
      </div>
    </>
  );
}
