/**
 * รหัสที่เจ้าหน้าที่กรอกเองแบบ "ตัวอักษร 2 ตัว + ปี พ.ศ. 2 หลัก + เลข 7 หลัก"
 *   ผู้รับบริการ = KN (เช่น KN690202463) — ต้องตรงกับ PATIENT_CODE_RE ใน server/src/patients/schema.js
 *   เคส     = VN (เช่น VN690215209) — ต้องตรงกับ CASE_CODE_RE ใน server/src/cases/schema.js
 */
export const PATIENT_CODE_RE = /^KN\d{9}$/;
export const CASE_CODE_RE = /^VN\d{9}$/;

const codeRe = (prefix) => new RegExp(`^${prefix}(\\d{2})(\\d{7})$`);

export const isPatientCode = (v) => PATIENT_CODE_RE.test(String(v ?? ''));
export const isCaseCode = (v) => CASE_CODE_RE.test(String(v ?? ''));

/** ปี พ.ศ. 2 หลักของวันนี้ (เวลาไทย) — ค่าเริ่มต้นของช่องปี เช่น 2569 → '69' */
export const currentBEYear2 = () =>
  String((new Date(Date.now() + 7 * 3.6e6).getUTCFullYear() + 543) % 100).padStart(2, '0');

/** แยกรหัสเป็นส่วนปีกับเลข 7 หลัก — รหัสที่ไม่ใช่รูปแบบนี้ (เช่น PAT-0003 / CASE-0007 เดิม) ได้ปีปัจจุบันกับเลขว่าง */
export function splitCode(prefix, code) {
  const m = codeRe(prefix).exec(String(code ?? ''));
  return m ? { year: m[1], number: m[2] } : { year: currentBEYear2(), number: '' };
}

/** ประกอบกลับเป็นรหัสเต็ม — ยังกรอกเลขไม่ครบ 7 หลัก = '' (ยังไม่มีรหัส ฟอร์มจะทักให้กรอก) */
export function joinCode(prefix, year, number) {
  const code = `${prefix}${year}${number}`;
  return codeRe(prefix).test(code) ? code : '';
}

/** วางรหัสเต็มทั้งก้อน (เช่น "vn 690215209") — คืน { year, number } ถ้าเป็นรหัสของ prefix นี้ ไม่ใช่ก็ null */
export function parsePastedCode(prefix, text) {
  const m = codeRe(prefix).exec(String(text ?? '').toUpperCase().replace(/[\s-]/g, ''));
  return m ? { year: m[1], number: m[2] } : null;
}

// ชื่อเดิมของรหัสผู้รับบริการ — ยังใช้อยู่ในฟอร์ม/เทส
export const splitPatientCode = (code) => splitCode('KN', code);
export const joinPatientCode = (year, number) => joinCode('KN', year, number);
