import { sql } from '../db/index.js';

/* แพ็กกายภาพเสริมของเคส Homecare (cases.addon_of — ดูท้าย schema.sql)
   เติมคอลัมน์ให้เองตอนใช้ครั้งแรก ฐานที่ยังไม่ได้ migrate จะไม่ล้มกลางการเปิดเคส

   แยกเป็นไฟล์ของตัวเอง (10 พ.ย. 2569) — repo ของผู้ว่าจ้าง/ผู้รับบริการ/พนักงานต้องเรียกด้วย (รายการเคสในหน้าของคนนั้นๆ
   ดึง addon_of มารวมแถวแพ็กเสริม) แต่ cases/repo.js import patients/repo.js อยู่แล้ว import กลับจะวนกัน */
let addonLinkReady = null;
export const ensureAddonLink = () =>
  (addonLinkReady ??= (async () => {
    /* findById/รายการเคสเรียกตัวนี้ทุกครั้ง (หลัง cold start ทุกรอบ) — ALTER TABLE ขอล็อกทั้งตารางแม้คอลัมน์มีแล้ว
       ถ้ามีทรานแซกชันอื่นถือล็อกแถว cases อยู่จะต้องรอ จึงดูจาก catalog ก่อน (ไม่ล็อกอะไร) มีครบแล้ว = จบ */
    const { n } = await sql.one(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'cases' AND column_name IN ('addon_of', 'bill_with_parent')`,
    );
    if (n === 2) return;
    await sql.run(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS addon_of TEXT
      REFERENCES cases (case_id) ON DELETE SET NULL ON UPDATE CASCADE`);
    await sql.run('CREATE INDEX IF NOT EXISTS idx_cases_addon_of ON cases (addon_of) WHERE addon_of IS NOT NULL');
    await sql.run('ALTER TABLE cases ADD COLUMN IF NOT EXISTS bill_with_parent BOOLEAN NOT NULL DEFAULT FALSE');
  })().catch((err) => { addonLinkReady = null; throw err; }));

/**
 * คอลัมน์ที่รายการเคสในหน้าอื่น (ผู้ว่าจ้าง · ผู้รับบริการ · พนักงาน) ต้องมี เพื่อให้หน้าเว็บรวมแพ็กเสริมเข้าแถวเคส Homecare
 * (client/src/lib/caseAddons.js) — ต้อง LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id ด้วย
 */
export const ADDON_LIST_COLUMNS = `c.addon_of, c.bill_with_parent,
       pp.name AS physio_package_name, pp.sessions AS physio_sessions`;
