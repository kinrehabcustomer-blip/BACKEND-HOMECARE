import { useId, useState } from 'react';

/**
 * ช่อง "รหัสแพ็คเกจ" ในฟอร์มเปิดเคส (ผู้ใช้ขอ 20 พ.ย. 2569) — พิมพ์รหัสแล้วเลือกแพ็คให้ทันที
 *
 * ปกติแสดงรหัสของแพ็คที่เลือกอยู่ (เลือกจากช่องรูปแบบ/เกรด/ระดับ หรือแพ็คกายภาพ ก็เห็นรหัสตามไปด้วย)
 * พิมพ์ทับ = ค้นหา · ตรงรหัสใดรหัสหนึ่งพอดีและไม่มีรหัสอื่นที่ยาวกว่าขึ้นต้นเหมือนกัน = เลือกเลย
 * ยังกำกวม (เช่น HC-D12-CG กับ HC-D12-CG-2) = รอ Enter หรือออกจากช่อง
 *
 * entries: [{ code, kind: 'homecare' | 'physio', label, ... }] — สร้างจากตารางเรท/แพ็คกายภาพที่เปิดขาย
 * allowKinds: จำกัดสาย (เช่น แพ็คเสริมของเคส Homecare เลือกได้แต่กายภาพ) · null = ได้ทุกสาย
 */
export const normCode = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '-');

export default function PackageCodeInput({ entries, currentCode, disabled, onPick, allowKinds = null }) {
  const listId = useId();
  const [query, setQuery] = useState(null); // null = แสดงรหัสของแพ็คที่เลือกอยู่
  const [msg, setMsg] = useState(null);

  const find = (code) => entries.find((e) => e.code === code) ?? null;

  function pick(entry) {
    if (allowKinds && !allowKinds.includes(entry.kind)) {
      setMsg(`รหัส ${entry.code} เป็นแพ็ค${entry.kind === 'physio' ? 'กายภาพ' : ' Homecare'} — เคสนี้เลือกไม่ได้`);
      return;
    }
    onPick(entry);
    setQuery(null);
    setMsg(null);
  }

  function onChange(raw) {
    const code = normCode(raw);
    setQuery(raw.toUpperCase());
    setMsg(null);
    if (!code) return;
    const exact = find(code);
    const longer = entries.some((e) => e.code !== code && e.code.startsWith(code));
    if (exact && !longer) pick(exact);
  }

  /** Enter / ออกจากช่อง — ตัดสินรหัสที่พิมพ์ค้างไว้ */
  function commit() {
    if (query == null) return;
    const code = normCode(query);
    if (!code) {
      setQuery(null);
      return;
    }
    const exact = find(code);
    if (exact) pick(exact);
    else setMsg(`ไม่พบรหัส ${code} — ดูรหัสได้ที่หน้าแพ็คเกจ หรือเลือกจากช่องด้านล่าง`);
  }

  const typed = query != null ? normCode(query) : '';
  const noneLike = typed && !entries.some((e) => e.code.startsWith(typed));

  return (
    <label>รหัสแพ็คเกจ
      <input
        className="pkg-code-input"
        list={listId}
        value={query ?? currentCode ?? ''}
        placeholder="พิมพ์รหัส เช่น PT-006 / HC-M24N-G1-RN"
        maxLength={20}
        spellCheck={false}
        autoCapitalize="characters"
        autoComplete="off"
        disabled={disabled}
        aria-invalid={msg || noneLike ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault(); // ไม่ให้ Enter ส่งฟอร์มเคสทั้งใบ
            commit();
          } else if (e.key === 'Escape' && query != null) {
            setQuery(null);
            setMsg(null);
          }
        }}
      />
      <datalist id={listId}>
        {entries
          .filter((e) => !allowKinds || allowKinds.includes(e.kind))
          .map((e) => <option key={e.code} value={e.code} label={e.label} />)}
      </datalist>
      {(msg || noneLike) && (
        <span className="field-error">{msg ?? `ไม่พบรหัสที่ขึ้นต้นด้วย ${typed}`}</span>
      )}
    </label>
  );
}
