import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { EMPLOYEE_CODE_RE } from '../lib/employeeCode.js';

/**
 * รหัสพนักงาน — ช่องกรอกช่องเดียว
 *   เว้นว่าง = ระบบออกรหัสให้อัตโนมัติ (A + ปี พ.ศ. + ชุด + เลขรัน เช่น A6901059)
 *              หน้าแก้ไข: เว้นว่าง/คงรหัสเดิมไว้ = ไม่เปลี่ยนรหัส
 *   กรอกเอง  = ตรวจรูปแบบระหว่างพิมพ์ (ขึ้นต้น A + ตัวเลขครบ 7 หลัก) ครบแล้วตรวจซ้ำกับคนอื่นให้ทันที
 *
 * ตัวจริงที่กันซ้ำคือตอนบันทึกฝั่ง server (ensureEmployeeCodeFree + PK) — อันนี้บอกล่วงหน้าให้แก้ก่อนกด
 */
export default function EmployeeCodeField({ currentId = null, value, onChange, error = null }) {
  const isEdit = Boolean(currentId);
  const unchanged = !value || value === currentId;
  const [check, setCheck] = useState(null); // null | 'checking' | { available, taken_by }

  // ตรวจซ้ำเมื่อรูปแบบครบแล้วเท่านั้น — หน่วงให้พิมพ์จบก่อน และทิ้งผลของคำค้นเก่าที่ตอบกลับมาช้ากว่า
  useEffect(() => {
    if (unchanged || !EMPLOYEE_CODE_RE.test(value)) {
      setCheck(null);
      return undefined;
    }
    let cancelled = false;
    setCheck('checking');
    const timer = setTimeout(() => {
      api
        .checkEmployeeId(value, currentId)
        .then((r) => !cancelled && setCheck(r))
        .catch(() => !cancelled && setCheck(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, currentId, unchanged]);

  /* สถานะใต้ช่อง — ไล่จากเรื่องที่ต้องแก้ก่อน: รูปแบบ → จำนวนหลัก → ซ้ำ → ใช้ได้ */
  const digits = value.startsWith('A') ? value.slice(1) : '';
  let status;
  let bad = false;
  if (error) {
    status = <span className="field-error">{error}</span>;
    bad = true;
  } else if (unchanged) {
    status = (
      <span className="code-check muted">
        {isEdit ? `เว้นว่าง = ใช้รหัสเดิม ${currentId}` : 'เว้นว่าง = ระบบออกรหัสให้อัตโนมัติ'}
      </span>
    );
  } else if (!value.startsWith('A') || /\D/.test(digits)) {
    status = <span className="code-check is-bad">ต้องขึ้นต้นด้วย A ตามด้วยตัวเลข 7 หลัก (เช่น A6901059)</span>;
    bad = true;
  } else if (digits.length < 7) {
    status = <span className="code-check is-warn">ยังไม่ครบ — ตัวเลข {digits.length}/7 หลัก</span>;
  } else if (check === 'checking') {
    status = <span className="code-check muted">กำลังตรวจรหัสซ้ำ…</span>;
  } else if (check && !check.available) {
    status = <span className="code-check is-bad">ซ้ำ — รหัสนี้ใช้กับ {check.taken_by} แล้ว</span>;
    bad = true;
  } else if (check?.available) {
    status = (
      <span className="code-check is-ok">
        ✓ ครบ 7 หลัก และยังไม่มีใครใช้{isEdit ? ' · เปลี่ยนแล้วข้อมูลที่ผูกอยู่ตามไปเอง' : ''}
      </span>
    );
  }

  return (
    <label className="employee-code">
      รหัสพนักงาน
      <input
        name="employee_id"
        className="mono"
        placeholder={isEdit ? currentId : undefined}
        maxLength={8}
        autoComplete="off"
        value={value}
        aria-invalid={bad || undefined}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/\s/g, ''))}
      />
      {status}
    </label>
  );
}
