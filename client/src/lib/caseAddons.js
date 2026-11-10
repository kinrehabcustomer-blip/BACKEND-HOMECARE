/**
 * แพ็กกายภาพเสริมของเคส Homecare (cases.addon_of) — รูปแบบเดียวกันทั้งระบบ (ผู้ใช้ขอ 10 พ.ย. 2569)
 * แพ็กไม่ขึ้นเป็นแถว/การ์ดของตัวเอง แต่อยู่ในแถวของเคส Homecare แม่:
 *   ช่องบริการ: [+ กายภาพ] ชื่อแพ็ก · ราคา · ใบแยก
 *   สถานะ:     Homecare ● … / กายภาพ ● …
 *
 * หน้ารายการเคสหลัก (CaseListPage) รวมที่ server เพราะแบ่งหน้า (ดู list() ใน cases/repo.js)
 * หน้าอื่นที่โหลดเคสมาครบทั้งรายการ (ผู้ว่าจ้าง · ผู้รับบริการ · พนักงาน · เคสของฉัน) รวมที่นี่ด้วยกติกาเดียวกัน:
 *   ซ่อนแถวแพ็กเฉพาะเมื่อ "แม่อยู่ในรายการเดียวกัน" และแม่ยังไม่ถูกยกเลิก
 *   แม่ไม่อยู่ (เช่น ประวัติของนักกายภาพที่ถือแค่แพ็ก) = แพ็กยังเป็นแถวของตัวเอง ไม่หายไปไหน
 */

/** ชื่อ/จำนวนครั้งของแพ็ก — server ส่งมาสองแบบ: physio_addons ของหน้าเคส (name/sessions) · แถวเคสเต็ม (physio_package_name/physio_sessions) */
export const addonName = (a) => a.name ?? a.physio_package_name ?? 'แพ็กกายภาพ';
export const addonSessions = (a) => a.sessions ?? a.physio_sessions ?? null;

/**
 * รวมแถวแพ็กเสริมเข้าแถวแม่ — คืนรายการใหม่ (ลำดับเดิม) แถวแม่มี addons = [แถวแพ็ก …]
 * ไม่แก้ของเดิม · รายการที่ไม่มีแพ็กเลยคืนตัวเดิมกลับไป
 */
export function groupAddons(cases = []) {
  const parents = new Map(cases.map((c) => [c.case_id, c]));
  const kids = new Map();
  for (const c of cases) {
    const parent = c.addon_of ? parents.get(c.addon_of) : null;
    if (!parent || parent.status === 'cancelled') continue;
    if (!kids.has(parent.case_id)) kids.set(parent.case_id, []);
    kids.get(parent.case_id).push(c);
  }
  if (kids.size === 0) return cases;
  const merged = new Set([...kids.values()].flat().map((c) => c.case_id));
  return cases
    .filter((c) => !merged.has(c.case_id))
    .map((c) => (kids.has(c.case_id) ? { ...c, addons: kids.get(c.case_id) } : c));
}
