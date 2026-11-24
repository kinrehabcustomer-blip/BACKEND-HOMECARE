import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import { PROCEDURE, isProcedure } from '../lib/addons.js';
import { formatBaht } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';
import SearchSelect from './SearchSelect.jsx';
import ProcedureNameInput from './ProcedureNameInput.jsx';
import { categoryItemNames, equipmentPrice, useCategories } from '../lib/categories.js';

/**
 * popup เพิ่มหัตถการ / อุปกรณ์เสริม จากหน้ารายละเอียดเคส (ผู้ใช้ขอ 9 พ.ย. 2569) — ไม่ต้องออกไปหน้าแก้ไขเต็ม
 *
 * เพิ่มทีละรายการแล้วบันทึกลง cases.addons ผ่าน PATCH เดียวกับฟอร์มแก้ไขเคส
 * จึงได้ทุกอย่างเหมือนเดิม: หัตถการได้ VN ของตัวเอง · ใบแจ้งหนี้ร่างซิงก์ยอดตาม · ใบที่ออกไปแล้วขึ้นเป็นค่าใช้จ่ายเพิ่มเติม
 * รายการเดิมส่งกลับไปตามที่ server ให้มา (หัตถการคง VN เดิม) — รูปแบบเดียวกับ addonsPayload/proceduresPayload ในฟอร์มเคส
 *
 * mode: 'procedure' | 'equipment'
 *
 * ไม่ติดธง is-subsheet (แผ่นเต็มจอบนมือถือ) — ฟอร์มสั้น เต็มจอแล้วปุ่มลอยกลางจอเหลือที่ว่างครึ่งล่าง
 * เป็นแผ่นสูงตามเนื้อหาที่เลื่อนขึ้นจากขอบล่างแทน (ผู้ใช้ขอ 9 พ.ย. 2569 "ดึงลงมา") แบบเดียวกับกล่องยืนยัน
 */
const toPayload = (a) =>
  isProcedure(a)
    ? { kind: PROCEDURE, name: a.name, quantity: 1, unit_price: Number(a.unit_price), vn: a.vn ?? null }
    : {
      name: a.name,
      // เช่าคงรูปเดิม (ไม่มีคีย์ kind) — เติมให้ทุกบรรทัดแล้วใบเก่าทั้งระบบจะขึ้นป้าย "แพ็คเกจไม่ตรง"
      ...(a.kind === 'sale' ? { kind: 'sale' } : {}),
      quantity: Number(a.quantity),
      unit_price: Number(a.unit_price),
    };

export default function CaseChargeModal({ item, mode, onClose, onSaved }) {
  const isProc = mode === 'procedure';
  const sheetRef = useSheetSwipe(onClose);
  useScrollLock();
  const [form, setForm] = useState({ name: '', kind: 'rent', quantity: '1', unit_price: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && !saving && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  /* อุปกรณ์จากหน้าหมวดหมู่: แนะนำชื่อ + เติมราคาตามรูปแบบ (เช่า/ซื้อขาด) เมื่อชื่อตรงกับที่ตั้งราคาไว้ */
  const cats = useCategories();
  const equipmentNames = categoryItemNames(cats?.categories, 'equipment');
  const fillPrice = (name, kind) => {
    const price = equipmentPrice(cats, name, kind);
    if (price != null) set('unit_price', String(price));
  };
  const qty = isProc ? 1 : Number(form.quantity || 0);
  const amount = Math.round(qty * Number(form.unit_price || 0) * 100) / 100;
  const ready = form.name.trim() !== '' && form.unit_price !== '' && (isProc || Number(form.quantity) > 0);

  async function save(e) {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    const added = isProc
      ? { kind: PROCEDURE, name: form.name.trim(), quantity: 1, unit_price: Number(form.unit_price), vn: null }
      : { name: form.name.trim(), kind: form.kind, quantity: Number(form.quantity), unit_price: Number(form.unit_price) };
    // แพ็กกายภาพที่รวมในใบไม่ได้อยู่ใน addons ของเคส (ระบบต่อบรรทัดให้ตอนออกใบ) — กันไว้เผื่อ
    const current = (item.addons ?? []).filter((a) => a.kind !== 'physio');
    try {
      const saved = await api.updateCase(item.case_id, { addons: [...current, added].map(toPayload) });
      const fresh = (saved?.addons ?? []).filter(isProcedure).at(-1);
      onSaved(isProc && fresh?.vn ? `เพิ่มหัตถการแล้ว — ${fresh.vn}` : `เพิ่ม${isProc ? 'หัตถการ' : 'อุปกรณ์เสริม'}แล้ว`);
    } catch (err) {
      // server ทักรายช่อง (addons.N.name ฯลฯ) — แถวที่เพิ่งเพิ่มคือแถวสุดท้าย ข้อความรวมอ่านรู้เรื่องอยู่แล้ว
      setError(err.fields?.length ? err.fields.map((f) => f.message).join(' · ') : err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop modal-stacked" onClick={() => !saving && onClose()}>
      <div className="modal modal-narrow charge-modal" ref={sheetRef} role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          {/* ดีไซน์ v2: หัวข้อก่อน แล้ว "ชื่อผู้รับบริการ · รหัสเคส" บรรทัดเดียว (ข้อมูลเดิม สลับลำดับ) */}
          <div>
            <h2>{isProc ? 'เพิ่มหัตถการ' : 'เพิ่มอุปกรณ์เสริม'}</h2>
            <p className="muted">{item.client_name}<span aria-hidden="true"> · </span><span className="mono charge-code">{caseCode(item.case_id)}</span></p>
          </div>
          <button className="modal-close" onClick={onClose} disabled={saving} aria-label="ปิด">×</button>
        </header>

        <form onSubmit={save}>
          <div className="modal-body charge-form">
            {error && <p className="error">{error}</p>}
            {isProc ? (
              <>
                <label>ชื่อหัตถการ
                  {/* ดีไซน์ v2: ไอคอนค้นหาในช่อง (ตกแต่ง) */}
                  <span className="charge-search">
                  <svg className="charge-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4.35-4.35" /></svg>
                  <ProcedureNameInput
                    value={form.name}
                    placeholder="พิมพ์ค้นหา (อย่างน้อย 3 ตัวอักษร) เช่น ทำแผล"
                    autoFocus
                    onChange={(v) => set('name', v)}
                    onPick={(proc, price) => {
                      set('name', proc.name);
                      if (price != null) set('unit_price', String(price));
                    }}
                  />
                  </span>
                </label>
                <label>ราคาหัตถการ (บาท)
                  <span className="charge-money"><span className="charge-money-sign" aria-hidden="true">฿</span>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={form.unit_price}
                    onChange={(e) => set('unit_price', e.target.value)} />
                  </span>
                </label>
                <p className="muted charge-hint"><svg className="text-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>ระบบออกเลข VN ให้หัตถการนี้ตอนบันทึก (หนึ่งรายการหนึ่งเลข)</p>
              </>
            ) : (
              <>
                <label>ชื่ออุปกรณ์
                  <input value={form.name} placeholder="เช่น เตียงลม, รถเข็น" autoFocus
                    list={equipmentNames.length > 0 ? 'charge-equipment-names' : undefined}
                    onChange={(e) => { set('name', e.target.value); fillPrice(e.target.value, form.kind); }} />
                  {equipmentNames.length > 0 && (
                    <datalist id="charge-equipment-names">
                      {equipmentNames.map((x) => <option key={x.name} value={x.name} label={x.group} />)}
                    </datalist>
                  )}
                </label>
                <div className="charge-grid">
                  <label>รูปแบบ
                    <SearchSelect value={form.kind} onChange={(e) => { set('kind', e.target.value); fillPrice(form.name, e.target.value); }}>
                      <option value="rent">เช่า</option>
                      <option value="sale">ซื้อขาด</option>
                    </SearchSelect>
                  </label>
                  <label>จำนวน
                    <input type="number" min="0" step="any" inputMode="decimal" value={form.quantity}
                      onChange={(e) => set('quantity', e.target.value)} />
                  </label>
                </div>
                <label>ราคาต่อหน่วย (บาท)
                  <span className="charge-money"><span className="charge-money-sign" aria-hidden="true">฿</span>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={form.unit_price}
                    onChange={(e) => set('unit_price', e.target.value)} />
                  </span>
                </label>
              </>
            )}

            {/* ดีไซน์ v2: ยอด + คำอธิบายอยู่ในกล่องสรุปใบเดียว */}
            <div className="charge-sum">
            <div className="charge-total">
              <span>ยอดที่จะเพิ่มในใบแจ้งหนี้</span>
              <strong>{formatBaht(amount)}</strong>
            </div>
            <p className="muted charge-hint">
              ใบแจ้งหนี้ร่างของเคสปรับยอดให้เอง · ถ้าออกใบไปแล้ว รายการนี้จะขึ้นเป็นค่าใช้จ่ายเพิ่มเติมให้ออกใบแยก
            </p>
            </div>
          </div>

          <footer className="modal-foot">
            <button type="button" className="btn" onClick={onClose} disabled={saving}>ยกเลิก</button>
            <button type="submit" className="btn primary" disabled={saving || !ready}>
              {saving ? 'กำลังบันทึก…' : isProc ? 'เพิ่มหัตถการ' : 'เพิ่มอุปกรณ์เสริม'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
