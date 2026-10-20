import { useEffect, useRef, useState } from 'react';
import { joinCode, parsePastedCode, splitCode } from '../lib/patientCode.js';

/**
 * ช่องกรอกรหัสแบบ [ตัวอักษร] [ปี พ.ศ. 2 หลัก] [เลข 7 หลัก] — ใช้กับรหัสผู้ป่วย (KN) และรหัสเคส (VN)
 *
 * ตัวอักษรตายตัว · ปีตั้งเป็นปีปัจจุบันให้ (แก้ได้) · เลข 7 หลักกรอกเอง รับเฉพาะตัวเลข
 * add-on: วางรหัสเต็มทั้งก้อน (เช่น VN690215209) ลงช่องไหนก็ได้ ระบบแยกปี/เลขให้เอง
 * ส่ง checker มา = ตรวจซ้ำระหว่างพิมพ์ (เมื่อครบ 9 หลักแล้ว) แล้วบอกผลใต้ช่อง
 *
 * onChange ส่งรหัสเต็มเมื่อครบ ไม่ครบส่ง '' — ฟอร์มจึงรู้ว่ายังไม่มีรหัส
 * name ใช้กับช่องเลข 7 หลัก ให้ฟอร์มเลื่อนจอมาหาได้ตอน server ทักว่าช่องนี้ผิด
 */
export default function YearCodeInput({
  prefix,
  value,
  onChange,
  name,
  invalid = false,
  disabled = false,
  checker = null,     // async (code) => { available, taken_by } · ไม่ส่ง = ไม่ตรวจซ้ำ
  takenLabel = 'รหัสนี้ถูกใช้แล้ว',
}) {
  const [parts, setParts] = useState(() => splitCode(prefix, value));
  const [check, setCheck] = useState(null); // null | 'checking' | { available, taken_by }
  /* เก็บ checker ใน ref — ผู้เรียกมักส่งฟังก์ชันใหม่ทุกครั้งที่ render (arrow function ในตัว JSX)
     ถ้าเอาไปเป็น dependency ตรงๆ การตรวจจะยิงซ้ำทุก render วนไม่จบ */
  const checkerRef = useRef(checker);
  checkerRef.current = checker;
  const hasChecker = Boolean(checker);

  /* ค่าที่ช่องนี้ส่งออกไปเองล่าสุด — value ที่เด้งกลับมาเท่ากับค่านี้คือเสียงสะท้อนของการพิมพ์ ไม่ใช่ค่าจากภายนอก
     (เดิมเทียบกับ parts: ลบปีออก 1 หลักตอนเลขครบ → ส่ง '' → ถูกมองว่าฟอร์มล้างค่า เลข 7 หลักหายและปีเด้งกลับ) */
  const emitted = useRef(value);

  // ค่าจากภายนอกเปลี่ยนจริง (โหลดมาแก้ / ล้างฟอร์ม / วางรหัสจากที่อื่น) — ตามให้ทัน
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    if ((value || '') !== joinCode(prefix, parts.year, parts.number)) setParts(splitCode(prefix, value || ''));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // ตรวจซ้ำเมื่อครบแล้ว — หน่วงให้พิมพ์จบก่อน และทิ้งผลของคำค้นเก่าที่ตอบกลับมาช้ากว่า
  useEffect(() => {
    if (!hasChecker || !value) {
      setCheck(null);
      return undefined;
    }
    let cancelled = false;
    setCheck('checking');
    const timer = setTimeout(() => {
      checkerRef.current(value)
        .then((r) => !cancelled && setCheck(r))
        .catch(() => !cancelled && setCheck(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, hasChecker]);

  const update = (next) => {
    const merged = { ...parts, ...next };
    setParts(merged);
    const code = joinCode(prefix, merged.year, merged.number);
    emitted.current = code;
    onChange(code);
  };
  const digits = (v, max) => v.replace(/\D/g, '').slice(0, max);
  const onPaste = (e) => {
    const whole = parsePastedCode(prefix, e.clipboardData.getData('text'));
    if (!whole) return; // ไม่ใช่รหัสเต็ม — ปล่อยให้วางตามปกติ (ตัวเลขล้วนจะถูกกรองตอน onChange)
    e.preventDefault();
    update(whole);
  };

  const bad = invalid || (check && check !== 'checking' && !check.available);
  let status = null;
  if (check === 'checking') status = <span className="code-check muted">กำลังตรวจรหัสซ้ำ…</span>;
  else if (check && !check.available) status = <span className="code-check is-bad">ซ้ำ — {takenLabel}{check.taken_by ? ` (${check.taken_by})` : ''}</span>;
  else if (check?.available) status = <span className="code-check is-ok">✓ ครบ และยังไม่มีใครใช้</span>;
  else if (parts.number.length > 0 && parts.number.length < 7) {
    status = <span className="code-check is-warn">ยังไม่ครบ — เลข {parts.number.length}/7 หลัก</span>;
  }

  return (
    <>
      <span className={`patient-code ${bad ? 'is-invalid' : ''}`}>
        <span className="patient-code-prefix" aria-hidden="true">{prefix}</span>
        <input
          className="patient-code-year"
          inputMode="numeric"
          aria-label="ปี พ.ศ. 2 หลัก"
          maxLength={2}
          value={parts.year}
          disabled={disabled}
          aria-invalid={bad || undefined}
          onPaste={onPaste}
          onChange={(e) => update({ year: digits(e.target.value, 2) })}
        />
        <input
          className="patient-code-number"
          name={name}
          inputMode="numeric"
          aria-label="เลข 7 หลัก"
          maxLength={7}
          value={parts.number}
          disabled={disabled}
          aria-invalid={bad || undefined}
          onPaste={onPaste}
          onChange={(e) => update({ number: digits(e.target.value, 7) })}
        />
      </span>
      {status}
    </>
  );
}
