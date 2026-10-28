/**
 * รหัสเคส = รหัสผู้รับบริการ (KN) ของคนที่เคสนี้ดูแล — เลิกใช้รหัสเคส VN ที่กรอกแยกแล้ว
 *
 * ผู้รับบริการหนึ่งคนมีได้หลายเคส (ต่อเคส/เปิดใหม่) แต่ case_id เป็น PK จึงซ้ำกันไม่ได้:
 *   เคสแรก = KN690202463 · เคสถัดไป = KN690202463-R2, KN690202463-R3 … (-R = เลขภายใน ไม่แสดง)
 * หน้าจอ/เอกสารแสดงผ่าน caseCode() ซึ่งตัด -R ออก ทุกเคสของคนเดียวกันจึงขึ้นรหัสเดียวกัน
 * ใช้ -R ไม่ใช่แค่ -2 เพราะรหัสเก่าแบบ CASE-0001 / PAT-0003 ก็ลงท้ายด้วย -ตัวเลข อยู่แล้ว
 *
 * เคสที่ยังไม่ผูกแฟ้มผู้รับบริการ (รู้แค่ผู้ว่าจ้าง) ได้รหัสชั่วคราว CASE-xxxx แล้วเปลี่ยนเป็น KN ตอนผูกแฟ้ม
 * (ต้องตรงกับ caseCode ใน client/src/lib/patientCode.js)
 */
export const caseCode = (id) => String(id ?? '').replace(/-R\d+$/, '');

/** เคสนี้ใช้รหัสของผู้รับบริการคนนี้อยู่แล้วหรือยัง */
export const isCaseOfPatient = (caseId, patientId) => Boolean(patientId) && caseCode(caseId) === patientId;

/**
 * case_id ใบใหม่ของผู้รับบริการคนนี้ — ยังไม่มีเคสที่ใช้รหัสตรงๆ = ใช้รหัส KN เลย ไม่งั้นต่อ -R(ลำดับถัดไป)
 * exceptId = เคสที่กำลังย้ายมาผูกคนนี้ (ไม่นับรหัสของตัวเอง)
 * ล็อกต่อรหัสผู้รับบริการจนจบ transaction — เปิดเคสให้คนเดียวกันพร้อมกันสองใบจะไม่ได้เลขเดียวกัน
 */
export async function caseIdForPatient(tx, patientId, exceptId = null) {
  await tx.one('SELECT pg_advisory_xact_lock(hashtext(:key)) IS NULL AS locked', { key: `case-id:${patientId}` });
  const rows = await tx.all(
    `SELECT case_id FROM cases
     WHERE (case_id = :base OR case_id LIKE :pattern) AND case_id IS DISTINCT FROM :except`,
    { base: patientId, pattern: `${patientId}-R%`, except: exceptId },
  );
  if (rows.length === 0) return patientId;
  const rounds = rows.map((r) => Number(/-R(\d+)$/.exec(r.case_id)?.[1] ?? 1));
  return `${patientId}-R${Math.max(1, ...rounds) + 1}`;
}
