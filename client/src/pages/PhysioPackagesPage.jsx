import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBaht } from '../labels.js';

const BLANK = {
  name: '',
  sessions: '',
  duration_months: '',
  original_price: '',
  discount_percent: '',
  discount_amount: '',
  staff_pay: '',
  active: true,
  note: '',
};

const toNum = (v) => (v === '' || v == null ? null : Number(v));

/**
 * ส่วนลดเป็นบาท — สูตรเดียวกับฝั่ง server (physio/repo.js)
 * กรอก % ไว้ให้ใช้ % ก่อน ไม่งั้นใช้จำนวนเงิน · ตัดไม่ให้เกินราคาเต็ม ราคาสุทธิจะได้ไม่ติดลบ
 */
function discountOf(price, percent, amount) {
  if (price == null || price <= 0) return 0;
  const raw = percent != null && percent > 0 ? (price * percent) / 100 : (amount ?? 0);
  return Math.min(Math.max(raw, 0), price);
}

/** ราคาสุทธิ/ส่วนลด/ตกเฉลี่ย/กำไร ที่โชว์ในฟอร์มระหว่างพิมพ์ — สูตรเดียวกับที่ server ใช้ */
function preview(form) {
  const sessions = toNum(form.sessions);
  const full = toNum(form.original_price);
  const pay = toNum(form.staff_pay);
  const discount = discountOf(full, toNum(form.discount_percent), toNum(form.discount_amount));
  const net = full != null ? full - discount : null;
  return {
    discount,
    net,
    avg: sessions > 0 && net != null ? Math.round(net / sessions) : null,
    // กำไรคิดจากราคาที่ขายจริง (หลังลด) ไม่ใช่ราคาตั้ง — ตั้งส่วนลดแล้วกำไรต้องลดตาม
    profit: net != null && pay != null ? net - pay : null,
  };
}

/** บรรทัดรองใต้ชื่อแพ็คเกจ: "10 ครั้ง · 3 เดือน" */
const detailLine = (p) =>
  [`${p.sessions} ครั้ง`, p.duration_months && `${p.duration_months} เดือน`].filter(Boolean).join(' · ');

export default function PhysioPackagesPage() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null = ปิดฟอร์ม | {} = เพิ่มใหม่ | {...} = แก้ไข

  const load = () => api.listPhysioPackages().then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function move(index, delta) {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next); // ขยับให้เห็นทันที ไม่ต้องรอ server
    try {
      setItems(await api.reorderPhysioPackages(next.map((p) => p.physio_package_id)));
    } catch (e) {
      setError(e.message);
      load(); // ลำดับบนจอกับใน DB อาจไม่ตรงกันแล้ว — ดึงของจริงมาทับ
    }
  }

  async function remove(p) {
    if (!confirm(`ลบแพ็คเกจ "${p.name}"?\nการลบนี้ย้อนกลับไม่ได้ — ถ้าแค่หยุดขายชั่วคราว ให้ติ๊ก "เปิดขาย" ออกแทน`)) return;
    try {
      await api.deletePhysioPackage(p.physio_package_id);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (error && !items) return <p className="error">{error}</p>;
  if (!items) return <p className="muted">กำลังโหลด…</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>แพ็คเกจกายภาพบำบัด</h1>
          <p className="muted">
            แพ็คเกจเหมาจำนวนครั้ง · ตกเฉลี่ย (บาท/ครั้ง) คำนวณให้อัตโนมัติจากราคาพิเศษ ÷ จำนวนครั้ง
          </p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ ...BLANK })}>+ เพิ่มแพ็คเกจ</button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="table-wrap">
        <table className="table physio-table">
          <thead>
            <tr>
              <th>แพ็กเกจ</th>
              <th>ราคาเต็ม (บาท)</th>
              <th>ราคาสุทธิ (บาท)</th>
              <th>ตกเฉลี่ย (บาท/ครั้ง)</th>
              <th>ค่าจ้างพนักงาน (บาท)</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p, i) => (
              <tr key={p.physio_package_id} className={p.active ? '' : 'is-inactive'}>
                <td className="physio-name">
                  {p.name}
                  {!p.active && <span className="badge muted-badge">ปิดขาย</span>}
                  <span className="cell-sub">{detailLine(p)}</span>
                </td>
                {/* ขีดฆ่าราคาเต็มเฉพาะตอนมีส่วนลดจริง — ไม่งั้นจะขีดฆ่าเลขเดียวกับราคาสุทธิ ดูสับสน */}
                <td className="physio-was">
                  {p.discount > 0 ? <s>{formatBaht(p.original_price)}</s> : <span className="muted">—</span>}
                </td>
                <td className="physio-special">
                  {formatBaht(p.special_price)}
                  {p.discount > 0 && (
                    <span className="cell-sub">
                      ลด {p.discount_percent > 0 ? `${p.discount_percent}%` : formatBaht(p.discount)}
                    </span>
                  )}
                </td>
                {/* ช่องที่ยังไม่ตั้งต้องเห็นชัด — ไม่มีค่าจ้าง = เคสสายกายภาพคำนวณค่าตอบแทนให้พนักงานไม่ได้เลย */}
                <td className="physio-pay">
                  {p.staff_pay == null ? (
                    <span className="pay-missing">ยังไม่ตั้ง</span>
                  ) : (
                    <>
                      {formatBaht(p.staff_pay)}
                      {p.margin != null && <span className="cell-sub">กำไร {p.margin}%</span>}
                    </>
                  )}
                </td>
                <td className="physio-actions">
                  <button className="btn tiny" title="เลื่อนขึ้น" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn tiny" title="เลื่อนลง" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="btn tiny" onClick={() => setEditing(p)}>แก้ไข</button>
                  <button className="btn tiny danger-ghost" onClick={() => remove(p)}>ลบ</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">ยังไม่มีแพ็คเกจ — กด "+ เพิ่มแพ็คเกจ" เพื่อเริ่ม</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <PackageForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

/** ฟอร์มเพิ่ม/แก้ไข — ปุ่มบันทึกเดียว บันทึกทุกช่องพร้อมกัน */
function PackageForm({ initial, onClose, onSaved }) {
  const isNew = !initial.physio_package_id;
  const [form, setForm] = useState({
    ...BLANK,
    ...initial,
    // ค่า null จาก DB ต้องกลายเป็น '' ไม่งั้น React เตือนเรื่อง controlled input
    duration_months: initial.duration_months ?? '',
    // แพ็คเกจเก่าที่ไม่เคยตั้งราคาเต็ม ให้ถือว่าราคาที่ขายอยู่คือราคาเต็ม (ส่วนลด 0)
    original_price: initial.original_price ?? initial.special_price ?? '',
    discount_percent: initial.discount_percent ?? '',
    discount_amount: initial.discount_amount ?? '',
    staff_pay: initial.staff_pay ?? '',
    sessions: initial.sessions ?? '',
    note: initial.note ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const { avg, discount, net, profit } = preview(form);
  const canSave = form.name.trim() && toNum(form.sessions) > 0 && toNum(form.original_price) != null;

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        sessions: toNum(form.sessions),
        duration_months: toNum(form.duration_months),
        original_price: toNum(form.original_price),
        discount_percent: toNum(form.discount_percent),
        discount_amount: toNum(form.discount_amount),
        // server คิดราคาสุทธิเองจาก (ราคาเต็ม − ส่วนลด) — ส่งไปด้วยเพื่อให้ schema เดิมผ่าน
        special_price: net,
        staff_pay: toNum(form.staff_pay),
        active: form.active,
        note: form.note.trim() || null,
      };
      if (isNew) await api.createPhysioPackage(body);
      else await api.updatePhysioPackage(initial.physio_package_id, body);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{isNew ? 'เพิ่มแพ็คเกจกายภาพบำบัด' : 'แก้ไขแพ็คเกจ'}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>

        <div className="modal-body">
          {error && <p className="error">{error}</p>}

          <div className="grid cols-2">
            <label className="span-2">ชื่อแพ็กเกจ *
              <input
                value={form.name}
                placeholder="เช่น ทดลองครั้งแรก / แพ็ค 10 ครั้ง"
                onChange={(e) => set('name', e.target.value)}
              />
            </label>

            <label>จำนวนครั้ง *
              <input
                type="number" min="1" step="1" value={form.sessions}
                onChange={(e) => set('sessions', e.target.value)}
              />
            </label>
            <label>ระยะเวลา (เดือน)
              <input
                type="number" min="1" step="1" value={form.duration_months}
                placeholder="ไม่มีกำหนด"
                onChange={(e) => set('duration_months', e.target.value)}
              />
            </label>

            <label className="span-2">ราคาเต็ม (บาท) *
              <input
                type="number" min="0" step="100" value={form.original_price}
                onChange={(e) => set('original_price', e.target.value)}
              />
            </label>

            {/* กรอกส่วนลดอย่างใดอย่างหนึ่ง — กรอก % ไว้จะใช้ % ก่อน */}
            <label>ส่วนลด (%)
              <input
                type="number" min="0" max="100" step="1" value={form.discount_percent}
                placeholder="เช่น 15"
                onChange={(e) => set('discount_percent', e.target.value)}
              />
            </label>
            <label>ส่วนลด (บาท)
              <input
                type="number" min="0" step="100" value={form.discount_amount}
                placeholder="ใช้เมื่อไม่ได้กรอก %"
                disabled={toNum(form.discount_percent) > 0}
                onChange={(e) => set('discount_amount', e.target.value)}
              />
            </label>

            {/* ค่าจ้างพนักงานต่อแพ็คเกจ — เคสคัดลอกไปใช้เป็นยอดที่พนักงานได้รับเมื่อปิดเคส
                ไม่กรอก = เคสสายกายภาพจะคำนวณค่าตอบแทนให้พนักงานไม่ได้ */}
            <label className="span-2">ค่าจ้างพนักงาน (บาท)
              <input
                type="number" min="0" step="100" value={form.staff_pay}
                placeholder="ยอดที่พนักงานได้รับต่อแพ็คเกจนี้"
                onChange={(e) => set('staff_pay', e.target.value)}
              />
            </label>

            {/* ยืนยันตัวเลขให้เห็นก่อนกดบันทึก — ตกเฉลี่ยคือคอลัมน์ที่ลูกค้าใช้เทียบความคุ้ม */}
            <div className="physio-preview span-2">
              <div>
                <span className="field-label">ส่วนลด</span>
                <strong>{discount > 0 ? formatBaht(discount) : '—'}</strong>
              </div>
              <div>
                <span className="field-label">ราคาสุทธิ (คำนวณให้)</span>
                <strong className="net-price">{net != null ? formatBaht(net) : '—'}</strong>
              </div>
              <div>
                <span className="field-label">ตกเฉลี่ย</span>
                <strong>{avg != null ? `${formatBaht(avg)} / ครั้ง` : '—'}</strong>
              </div>
              <div>
                <span className="field-label">กำไรที่บริษัทได้</span>
                <strong>{profit != null ? formatBaht(profit) : '—'}</strong>
              </div>
            </div>

            <label className="span-2">หมายเหตุ
              <textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
            </label>

            <label className="checkbox-row">
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
              เปิดขายอยู่ (ติ๊กออก = ซ่อนจากรายการขาย แต่ยังเก็บราคาไว้)
            </label>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn" disabled={busy} onClick={onClose}>ยกเลิก</button>
          <button className="btn primary" disabled={busy || !canSave} onClick={save}>
            {busy ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
        </footer>
      </div>
    </div>
  );
}
