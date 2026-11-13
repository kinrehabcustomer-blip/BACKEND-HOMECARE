import { PHYSIO_BUNDLE } from './addons.js';

/**
 * ที่ที่จดรหัสเคสไว้โดยไม่มี FK ON UPDATE CASCADE ตามให้ — เคสเปลี่ยนรหัส (CASE-xxxx → KN… ตอนผูกแฟ้ม
 * หรือ KN เดิม → KN ใหม่ตอนแก้รหัสผู้รับบริการ) แล้วต้องย้ายตามเอง (ตรวจ 13 พ.ย. 2569)
 *
 * 1. คิวแจ้งเตือน (สร้างแบบ lazy) — เดิมชี้รหัสเก่าค้าง: claimVisitChanges หาเคสไม่เจอแล้วข้ามเงียบ ๆ
 *    (แจ้งเลื่อน/ยกเลิกนัดหาย) และกระดิ่งในแอปลิงก์ไปหน้า 404
 * 2. บรรทัดแพ็กกายภาพในใบแจ้งหนี้ Homecare (invoices.addons[].ref) — เดิมชี้รหัสเก่าค้าง:
 *    bundleCoveredSql มองไม่เห็นว่าใบ Homecare เก็บแพ็กนี้ไปแล้ว → ออกใบแยกของแพ็กได้อีกใบ (เก็บเงินซ้ำ)
 *    และป้าย "แพ็กถูกยกเลิก ยังไม่ออกใบลดหนี้" หายไป
 *
 * เรียกใน transaction เดียวกับที่เปลี่ยนรหัสเคส · ชื่อตารางเป็นค่าคงที่ข้างล่างเท่านั้น · ตารางที่ยังไม่ถูกสร้างก็ข้ามไป
 */
const CASE_REF_TABLES = ['visit_change_outbox', 'staff_notifications', 'case_event_outbox'];

/**
 * newId(col) / matches(col) = ชิ้น SQL ที่คิดจากรหัสเดิมในคอลัมน์/นิพจน์ col
 * (เขียนแบบเดียวกับ UPDATE cases ของผู้เรียก) · params = พารามิเตอร์ :name ที่ชิ้น SQL อ้าง
 */
export async function renameCaseRefs(tx, newId, matches, params) {
  const tables = await tx.all(
    `SELECT c.relname AS t FROM pg_class c
      WHERE c.relname = ANY(:names::text[]) AND c.relkind = 'r' AND pg_table_is_visible(c.oid)`,
    { names: CASE_REF_TABLES },
  );
  for (const { t } of tables) {
    if (!CASE_REF_TABLES.includes(t)) continue;
    await tx.run(`UPDATE ${t} SET case_id = ${newId('case_id')} WHERE ${matches('case_id')}`, params);
  }

  await renameBundleRefs(tx, newId, matches, params);
}

/**
 * ลบเคส = ลบแถวคิวแจ้งเตือนของเคสนั้นด้วย (ตรวจ 13 พ.ย. 2569) — ไม่มี FK ลบตามให้
 * ถ้าค้างไว้ เคสใหม่ของผู้รับบริการคนเดิมได้รหัส KN เดิมกลับมา (caseIdForPatient) แล้ว
 * claimVisitChanges ส่ง "นัดถูกยกเลิก/เลื่อน" ของเคสที่ลบไปหาญาติของเคสใหม่ · กระดิ่งลิงก์ไปผิดเคส
 */
export async function deleteCaseRefs(tx, caseId) {
  const tables = await tx.all(
    `SELECT c.relname AS t FROM pg_class c
      WHERE c.relname = ANY(:names::text[]) AND c.relkind = 'r' AND pg_table_is_visible(c.oid)`,
    { names: CASE_REF_TABLES },
  );
  for (const { t } of tables) {
    if (!CASE_REF_TABLES.includes(t)) continue;
    await tx.run(`DELETE FROM ${t} WHERE case_id = :id`, { id: caseId });
  }
}

async function renameBundleRefs(tx, newId, matches, params) {
  const ref = `(e ->> 'ref')`;
  const isBundle = `e ->> 'kind' = '${PHYSIO_BUNDLE}' AND ${matches(ref)}`;
  await tx.run(
    `UPDATE invoices i
        SET addons = (SELECT jsonb_agg(CASE WHEN ${isBundle}
                                            THEN jsonb_set(e, '{ref}', to_jsonb((${newId(ref)})::text))
                                            ELSE e END ORDER BY ord)
                        FROM jsonb_array_elements(i.addons) WITH ORDINALITY x(e, ord))
      WHERE jsonb_typeof(i.addons) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.addons) e WHERE ${isBundle})`,
    params,
  );
}
