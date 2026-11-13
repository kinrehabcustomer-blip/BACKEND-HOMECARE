import { sql, transaction } from '../db/index.js';
import { caseCode } from './caseCode.js';
import { PHYSIO_BUNDLE } from '../lib/addons.js';

/* แพ็กกายภาพเสริมของเคส Homecare (cases.addon_of / addon_next — ดูท้าย schema.sql)
   เติมคอลัมน์ให้เองตอนใช้ครั้งแรก ฐานที่ยังไม่ได้ migrate จะไม่ล้มกลางการเปิดเคส

   แยกเป็นไฟล์ของตัวเอง (10 พ.ย. 2569) — repo ของผู้ว่าจ้าง/ผู้รับบริการ/พนักงานต้องเรียกด้วย (รายการเคสในหน้าของคนนั้นๆ
   ดึง addon_of มารวมแถวแพ็กเสริม) แต่ cases/repo.js import patients/repo.js อยู่แล้ว import กลับจะวนกัน */
const ADDON_COLUMNS = ['addon_of', 'bill_with_parent', 'addon_next'];
let addonLinkReady = null;
export const ensureAddonLink = () =>
  (addonLinkReady ??= (async () => {
    /* findById/รายการเคสเรียกตัวนี้ทุกครั้ง (หลัง cold start ทุกรอบ) — ALTER TABLE ขอล็อกทั้งตารางแม้คอลัมน์มีแล้ว
       ถ้ามีทรานแซกชันอื่นถือล็อกแถว cases อยู่จะต้องรอ จึงดูจาก catalog ก่อน (ไม่ล็อกอะไร) มีครบแล้ว = จบ */
    const { n } = await sql.one(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'cases' AND column_name = ANY(:cols::text[])`,
      { cols: ADDON_COLUMNS },
    );
    if (n === ADDON_COLUMNS.length) return;
    await sql.run(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS addon_of TEXT
      REFERENCES cases (case_id) ON DELETE SET NULL ON UPDATE CASCADE`);
    await sql.run('CREATE INDEX IF NOT EXISTS idx_cases_addon_of ON cases (addon_of) WHERE addon_of IS NOT NULL');
    await sql.run('ALTER TABLE cases ADD COLUMN IF NOT EXISTS bill_with_parent BOOLEAN NOT NULL DEFAULT FALSE');
    await sql.run(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS addon_next TEXT
      REFERENCES cases (case_id) ON DELETE SET NULL ON UPDATE CASCADE`);
    await sql.run('CREATE INDEX IF NOT EXISTS idx_cases_addon_next ON cases (addon_next) WHERE addon_next IS NOT NULL');
  })().catch((err) => { addonLinkReady = null; throw err; }));

/**
 * คอลัมน์ที่รายการเคสในหน้าอื่น (ผู้ว่าจ้าง · ผู้รับบริการ · พนักงาน) ต้องมี เพื่อให้หน้าเว็บรวมแพ็กเสริมเข้าแถวเคส Homecare
 * (client/src/lib/caseAddons.js) — ต้อง LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id ด้วย
 */
export const ADDON_LIST_COLUMNS = `c.addon_of, c.bill_with_parent,
       pp.name AS physio_package_name, pp.sessions AS physio_sessions`;

/**
 * แพ็กกายภาพที่รวมในเคส Homecare (c = alias ของเคสกายภาพ) ถูก "ดูแลการเก็บเงิน" โดยเคส Homecare อยู่จริงไหม
 *   - ใบที่ยังไม่ยกเลิกของ Homecare มีบรรทัดแพ็กนี้แล้ว หรือ
 *   - Homecare ยังไม่มีใบแพ็คเกจเลย (และยังไม่ยกเลิก) — ใบที่ออกทีหลังดึงบรรทัดนี้ไปเอง (ดู bundledAddons ใน invoices/repo.js)
 * ไม่ทั้งสองอย่าง (ใบ Homecare ออก/แบ่งงวดไปแล้วโดยไม่มีบรรทัดนี้ หรือ Homecare ถูกยกเลิก/ลบ) = แพ็กต้องออกใบของตัวเอง
 * อยู่ที่นี่ (ไม่ใช่ invoices/repo.js) เพราะรายการเคส/กระดิ่ง "ปิดแล้วไม่มีใบ" ต้องใช้เกณฑ์เดียวกัน (11 พ.ย. 2569)
 */
export const bundleCoveredSql = (c) => `(${c}.bill_with_parent AND (
  EXISTS (SELECT 1 FROM invoices pi
          WHERE pi.case_id = ${c}.addon_of AND pi.status <> 'cancelled'
            AND pi.addons @> jsonb_build_array(jsonb_build_object('kind', '${PHYSIO_BUNDLE}', 'ref', ${c}.case_id)))
  OR (NOT EXISTS (SELECT 1 FROM invoices pi
                  WHERE pi.case_id = ${c}.addon_of AND pi.status <> 'cancelled'
                    AND pi.billing_kind IS DISTINCT FROM 'extra')
      AND EXISTS (SELECT 1 FROM cases pc WHERE pc.case_id = ${c}.addon_of AND pc.status <> 'cancelled'))))`;

/**
 * รอบปัจจุบันของเคส Homecare ที่แพ็กกายภาพควรผูกอยู่ — ไล่ตามสายต่อรอบ (renewed_from) จากเคสที่ให้มา (11 พ.ย. 2569)
 *
 * เดิมต่อรอบแพ็กกายภาพ/ผูกแพ็กแล้ว ผูกกับรอบ Homecare ที่ส่งมาตรงๆ ไม่มีการจองย้าย:
 *   - Homecare ต่อรอบไว้แล้ว (รอเริ่ม) → แพ็กใหม่ค้างอยู่รอบเก่า ไม่ย้ายตามเมื่อรอบใหม่เริ่ม
 *   - รอบเก่าปิดแล้ว รอบใหม่กำลังเดิน → แพ็กใหม่หลุดเป็นเคสเดี่ยว แทนที่จะผูกกับรอบที่ให้บริการอยู่
 * ตอนนี้: รอบที่ปิดแล้วแต่ต่อไว้ = เดินหน้าไปรอบถัดไป · หยุดที่รอบที่ยังไม่ปิด/ยกเลิก
 * คืน { parent, next } — parent = แถวรอบที่ผูก (null = ไม่มีรอบที่ยังเดิน) · next = รอบถัดไปที่ต่อไว้แล้ว (ให้จองย้าย)
 * รอบถัดไปที่เริ่มไปแล้วก็จองไว้ได้ — promoteDueAddons ย้ายให้ตอนอ่านครั้งถัดไปตามกติกาเดิม
 */
export async function currentAddonRound(db, caseId) {
  const nextOf = (id) => db.one(
    `SELECT r.case_id FROM cases r WHERE r.renewed_from = :id AND r.status <> 'cancelled'
     ORDER BY r.created_at DESC LIMIT 1`,
    { id },
  );
  let parent = await db.one(
    'SELECT case_id, status, patient_id FROM cases WHERE case_id = :id FOR SHARE',
    { id: caseId },
  );
  // กันวนไม่จบถ้าข้อมูลสายต่อรอบเพี้ยน — ต่อรอบติดกันเกินนี้ในการผูกครั้งเดียวไม่มีจริง
  for (let step = 0; parent && step < 24; step += 1) {
    const next = await nextOf(parent.case_id);
    if (!['closed', 'cancelled'].includes(parent.status) || !next) {
      if (['closed', 'cancelled'].includes(parent.status)) return { parent: null, next: null };
      return { parent, next: next?.case_id ?? null };
    }
    parent = await db.one(
      'SELECT case_id, status, patient_id FROM cases WHERE case_id = :id FOR SHARE',
      { id: next.case_id },
    );
  }
  return { parent: null, next: null };
}

/* ---------- ย้ายคอร์สกายภาพตามรอบ Homecare (ผู้ใช้เลือกวิธี A แบบจองย้าย · 10 พ.ย. 2569) ----------
   ต่อเคส Homecare → แพ็กที่ยังเดิน + เก็บเงินใบแยก ถูก "จองย้าย" (addon_next = รอบใหม่) — ดู create() ใน repo.js
   ย้ายจริงเมื่อรอบใหม่เริ่ม อย่างใดอย่างหนึ่งก่อน:
     ① รอบใหม่เริ่มงานแล้ว (เช็คอินกะแรก = in_progress / ปิดไปแล้ว)  ② ถึงวันเริ่มของรอบใหม่  ③ รอบเก่าปิดหรือถูกยกเลิก
   ต่อเคสล่วงหน้าแล้วแพ็กจึงยังอยู่กับรอบที่ให้บริการจริงจนถึงวันเปลี่ยนรอบ — ไม่โผล่ในรอบที่ยัง "รอเริ่ม"

   ทำแบบ "ตรวจเมื่อมีคนเปิดดู" (รายการ/ป๊อปอัป/หน้าภาพรวม เรียกก่อนอ่าน) ไม่แทรกในทุกเส้นที่เปลี่ยนสถานะ
   — ข้อมูลที่ทุกหน้าเห็นถูกเสมอ โดยไม่ต้องตามแก้ทุกจุดที่เคสเริ่ม/ปิด/ยกเลิก · ตรวจไม่ถี่กว่านาทีละครั้งต่อเครื่อง
   แพ็กที่เก็บเงินรวมใบไม่จอง/ไม่ย้าย — บรรทัดเงินอยู่ในใบของรอบเก่า ย้ายแล้วใบรอบใหม่จะดึงไปเก็บซ้ำ */
const PROMOTE_EVERY_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;
let lastPromote = 0;
let promoting = null;

export function promoteDueAddons() {
  if (promoting) return promoting;
  if (Date.now() - lastPromote < PROMOTE_EVERY_MS) return Promise.resolve(0);
  lastPromote = Date.now();
  promoting = runPromotion()
    .catch((err) => {
      lastPromote = 0; // ล้มแล้วให้ลองใหม่รอบหน้าได้เลย — ไม่ทำให้คำขอที่เปิดดูอยู่ล้มตาม
      console.error('[addon-promote]', err?.message ?? err);
      return 0;
    })
    .finally(() => { promoting = null; });
  return promoting;
}

const TODAY_TH = "to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')";

async function runPromotion() {
  await ensureAddonLink();
  /* ส่วนใหญ่ไม่มีแพ็กไหนจองย้ายรอบอยู่เลย — ถามคำเดียวก่อน (ใช้ดัชนีบางส่วน idx_cases_addon_next)
     แทนที่จะ UPDATE ล้าง + เปิด transaction ย้ายทุกครั้ง (4 คิวรี + ล็อกแถวเขียน) ทั้งที่ไม่มีอะไรให้ทำ
     (ปรับความเร็ว 13 พ.ย. 2569 — ทุกเส้นที่อ่านเคส/ลูกค้า/ผู้รับบริการ/พนักงานเรียกตัวนี้ก่อนอ่าน) */
  const pending = await sql.one('SELECT EXISTS (SELECT 1 FROM cases WHERE addon_next IS NOT NULL) AS yes');
  if (!pending?.yes) return 0;
  // ล้างการจองที่ไม่มีความหมายแล้ว: รอบใหม่ถูกยกเลิก · แพ็กจบ/ยกเลิก · แพ็กเปลี่ยนเป็นรวมใบ · ถูกยกเลิกการผูก
  await sql.run(
    `UPDATE cases p SET addon_next = NULL
      WHERE p.addon_next IS NOT NULL
        AND (p.status IN ('closed', 'cancelled') OR p.bill_with_parent OR p.addon_of IS NULL
             OR EXISTS (SELECT 1 FROM cases n WHERE n.case_id = p.addon_next AND n.status = 'cancelled'))`,
  );
  let moved = 0;
  // ต่อหลายรอบติดกัน (รอบ 2 → 3 ผ่านไปแล้วทั้งคู่) = เลื่อนทีละรอบจนถึงรอบปัจจุบัน
  for (let step = 0; step < 6; step += 1) {
    const rows = await transaction(async (tx) => {
      const done = await tx.all(
        `UPDATE cases p
            SET addon_of = n.case_id,
                /* รอบใหม่ต่อรอบถัดไปไว้แล้ว = จองต่อทันที (แพ็กตามรอบที่ให้บริการจริงเสมอ) */
                addon_next = (SELECT r.case_id FROM cases r
                               WHERE r.renewed_from = n.case_id AND r.status <> 'cancelled'
                               ORDER BY r.created_at DESC LIMIT 1),
                updated_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
           FROM cases n, cases o
          WHERE p.addon_next = n.case_id AND o.case_id = p.addon_of
            AND p.status NOT IN ('closed', 'cancelled') AND NOT p.bill_with_parent
            AND n.status <> 'cancelled'
            AND (n.status IN ('in_progress', 'closed')
                 OR n.start_date <= ${TODAY_TH}
                 OR o.status IN ('closed', 'cancelled'))
          RETURNING p.case_id, p.physio_package_id, o.case_id AS old_parent, n.case_id AS new_parent, n.round_no`,
      );
      for (const r of done) {
        const pkg = r.physio_package_id
          ? await tx.one('SELECT name FROM physio_packages WHERE physio_package_id = :id', { id: r.physio_package_id })
          : null;
        const name = pkg?.name ? `"${pkg.name}"` : 'กายภาพ';
        const log = (caseId, detail) => tx.run(
          `INSERT INTO case_events (case_id, event, detail, actor_id, actor_name)
           VALUES (:case_id, 'physio_addon', :detail, NULL, 'ระบบ (ย้ายตามรอบ)')`,
          { case_id: caseId, detail },
        );
        await log(r.case_id, `รอบที่ ${r.round_no} ของเคส Homecare ${caseCode(r.new_parent)} เริ่มแล้ว — ย้ายคอร์สกายภาพนี้ไปอยู่รอบนั้น`);
        await log(r.new_parent, `รอบนี้เริ่มแล้ว — ย้ายคอร์สกายภาพ ${name} มาอยู่รอบนี้`);
        await log(r.old_parent, `ย้ายคอร์สกายภาพ ${name} ไปอยู่รอบที่ ${r.round_no} แล้ว`);
      }
      return done.length;
    });
    moved += rows;
    if (!rows) break;
  }
  return moved;
}
