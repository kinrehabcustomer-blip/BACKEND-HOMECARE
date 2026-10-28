import { sql, transaction, nextVisitNumber } from '../db/index.js';
import { normalizeAddons, isProcedure } from '../lib/addons.js';

/**
 * เลข VN = เลขของ "ครั้งที่ให้บริการ" หนึ่งครั้ง (ดร.ธงชัย 28 ต.ค. 2569) — ระบบออกให้เอง ไม่ได้กรอก
 *
 *   กายภาพบำบัด  หนึ่งนัด = หนึ่ง VN  (แพ็คเกจ 10 ครั้ง = 10 VN) — ออกตอนลงนัด เก็บที่ case_visits.vn
 *   Homecare     หนึ่งเคส = หนึ่ง VN  (ทั้งแพ็คเกจ ไม่ว่ารายวัน/สัปดาห์/เดือน) — ออกตอนลงนัดครั้งแรก
 *                เก็บที่ cases.vn · กะถัดๆ ไปของเคสเดียวกันไม่ได้ VN เพิ่ม
 *   หัตถการ      หนึ่งรายการ = หนึ่ง VN แยก — ออกตอนบันทึกเคสที่มีหัตถการ เก็บในรายการ addons
 *
 * ออกแล้วไม่คืน: ยกเลิกนัด/ยกเลิกเคส VN ยังติดอยู่กับครั้งนั้น (เลขไม่ถูกนำกลับมาใช้ซ้ำ)
 * สายบริการตัดสินด้วยเกณฑ์เดียวกับ isPhysioCase ใน cases/repo.js
 */
const isPhysio = (c) =>
  c.service_kind === 'physio' || c.physio_package_id != null || (!c.service_kind && c.case_type === 'physiotherapy');

/** หลังลงนัดใหม่ — ออก VN ตามสายบริการของเคส (visitIds = นัดที่เพิ่งสร้าง) */
export async function issueForVisits(tx, caseId, visitIds) {
  if (visitIds.length === 0) return;
  const c = await tx.one(
    `SELECT case_id, vn, service_kind, physio_package_id, case_type FROM cases WHERE case_id = :id FOR UPDATE`,
    { id: caseId },
  );
  if (!c) return;
  if (isPhysio(c)) {
    for (const visitId of [...visitIds].sort((a, b) => a - b)) {
      await tx.run('UPDATE case_visits SET vn = :vn WHERE visit_id = :id AND vn IS NULL', {
        vn: await nextVisitNumber(tx),
        id: visitId,
      });
    }
  } else if (!c.vn) {
    await tx.run('UPDATE cases SET vn = :vn WHERE case_id = :id', { vn: await nextVisitNumber(tx), id: caseId });
  }
}

/**
 * VN ของหัตถการ — หัตถการที่ยังไม่มีเลข (เพิ่งเพิ่ม) ได้เลขใหม่ · ของเดิมคงเลขเดิม
 * เลขที่ส่งมาต้องเป็นของหัตถการในเคสนี้อยู่แล้วเท่านั้น (previous) — กันหน้าเว็บส่งเลขมั่ว/ก๊อปเลขจากเคสอื่น
 * และเลขเดียวกันซ้ำสองบรรทัด (กดคัดลอกแถว) = บรรทัดหลังได้เลขใหม่ · ต่อเคสรอบใหม่ = หัตถการได้ VN ใหม่ทั้งหมด
 */
export async function withProcedureNumbers(tx, addons, previous = []) {
  const owned = new Set(normalizeAddons(previous).filter(isProcedure).map((a) => a.vn).filter(Boolean));
  const used = new Set();
  const out = [];
  for (const a of normalizeAddons(addons)) {
    if (isProcedure(a)) {
      const keep = a.vn && owned.has(a.vn) && !used.has(a.vn);
      a.vn = keep ? a.vn : await nextVisitNumber(tx);
      used.add(a.vn);
    }
    out.push(a);
  }
  return out;
}

/**
 * เติม VN ย้อนหลังให้ข้อมูลที่ลงนัดไว้ก่อนมีระบบนี้ (เรียกจาก db/migrate.js) — รันซ้ำได้
 * ไล่ตามวันนัด เคสกายภาพได้ VN ทุกนัดที่ยังไม่มีเลข · Homecare ที่มีนัดแล้วได้ VN เคสละหนึ่ง
 * หัตถการไม่ต้องเติม (เพิ่งมีพร้อมระบบนี้)
 */
export async function backfillVisitNumbers() {
  const cases = await sql.all(
    `SELECT c.case_id, array_agg(v.visit_id ORDER BY v.visit_date, v.planned_start NULLS FIRST, v.visit_id) AS visit_ids
     FROM cases c JOIN case_visits v ON v.case_id = c.case_id
     WHERE v.vn IS NULL
     GROUP BY c.case_id, c.created_at
     ORDER BY c.created_at, c.case_id`,
  );
  let issued = 0;
  for (const { case_id, visit_ids } of cases) {
    await transaction(async (tx) => {
      const before = await tx.one(
        `SELECT (SELECT COUNT(*)::int FROM case_visits WHERE case_id = :id AND vn IS NOT NULL)
              + (SELECT COUNT(*)::int FROM cases WHERE case_id = :id AND vn IS NOT NULL) AS n`,
        { id: case_id },
      );
      await issueForVisits(tx, case_id, visit_ids);
      const after = await tx.one(
        `SELECT (SELECT COUNT(*)::int FROM case_visits WHERE case_id = :id AND vn IS NOT NULL)
              + (SELECT COUNT(*)::int FROM cases WHERE case_id = :id AND vn IS NOT NULL) AS n`,
        { id: case_id },
      );
      issued += after.n - before.n;
    });
  }
  return issued;
}
