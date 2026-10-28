import { createHash, randomInt } from 'node:crypto';
import { sql } from '../db/index.js';
import { ApiError } from './errors.js';

/**
 * ญาติดูการดูแลผ่าน LINE OA KIN HomeCare หลัก (ดร.ธงชัย 22 ต.ค. 2569 · แบบร่าง coordination/family-line-page-design-20261022.md)
 *
 * ต้องเชิญเท่านั้น: แอดมินกด "เชิญญาติ" ในหน้าเคส (ยืนยันว่าได้รับความยินยอมจากผู้ป่วย/ผู้แทนแล้ว)
 * → ได้รหัส 6 ตัว อายุ 7 วัน ใช้ได้ครั้งเดียว → ญาติส่ง "ญาติ <รหัส>" ในแชท OA → ผูก LINE ของญาติกับเคสนั้นเคสเดียว
 * ระบบไม่จับคู่ญาติเองจากชื่อ/เบอร์ · แอดมินปลดได้ทุกเมื่อ · เคสปิดเกิน 30 วันแล้วญาติดูไม่ได้
 * ข้อมูลที่ญาติเห็นเป็น "สรุป" (ดร. เคาะ): เวลาเข้า–ออกจริง · ผู้ดูแล · สรุปรายงานสั้น + สัญญาณชีพหลัก · นัดถัดไป
 * ไม่ส่ง: GPS · เซลฟี่ · ค่าจ้าง/ราคา · บันทึกภายใน · เบอร์เจ้าหน้าที่
 */
export const FAMILY_MAX_PER_CASE = 5;
const CODE_DAYS = 7;
export const CLOSED_GRACE_DAYS = 30;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // ตัด 0/O/1/I/L ที่อ่านสับสน

export const hashCode = (code) => createHash('sha256').update(`kin-family:${String(code).toUpperCase()}`).digest('hex');
export const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

let ready = null;
export const ensureFamilyTable = () =>
  (ready ??= sql
    .run(
      `CREATE TABLE IF NOT EXISTS case_family_links (
         link_id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         case_id          TEXT NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE ON UPDATE CASCADE,
         code_hash        TEXT,
         code_expires_at  TIMESTAMPTZ,
         line_user_id     TEXT,
         display_name     TEXT,
         invited_by       TEXT NOT NULL,
         consent_by       TEXT NOT NULL,
         created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
         accepted_at      TIMESTAMPTZ,
         revoked_at       TIMESTAMPTZ
       )`,
    )
    // แบบ ข (ดร. 22 ต.ค.): ญาติคนแรกที่แอดมินเชิญ (can_invite) ชวนคนอื่นต่อได้ · คนที่ถูกชวนต่อชวนต่อไม่ได้
    .then(() => sql.run('ALTER TABLE case_family_links ADD COLUMN IF NOT EXISTS can_invite BOOLEAN NOT NULL DEFAULT false'))
    .then(() => sql.run('ALTER TABLE case_family_links ADD COLUMN IF NOT EXISTS invited_via INTEGER'))
    // ไทม์ไลน์เคส (แบบ 3): ข้อความ/รูปจากญาติและทีม — ทุกคนในเคสเห็นเหมือนกัน · ลบ = ซ่อน (deleted_at)
    .then(() =>
      sql.run(
        `CREATE TABLE IF NOT EXISTS case_family_messages (
           message_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           case_id       TEXT NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE ON UPDATE CASCADE,
           author_kind   TEXT NOT NULL CHECK (author_kind IN ('family', 'team', 'staff')),
           author_name   TEXT NOT NULL,
           line_user_id  TEXT,
           employee_id   TEXT,
           body          TEXT,
           photo_data    BYTEA,
           photo_mime    TEXT,
           created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
           deleted_at    TIMESTAMPTZ
         )`,
      ),
    )
    // ตารางถูกสร้างไปแล้วก่อนมี 'staff' (ผู้ดูแล/นักกายภาพตอบแชทญาติ · ดร. 24 ต.ค.) — CREATE TABLE IF NOT EXISTS
    // จึงไม่ช่วย ต้องปลด constraint เดิมแล้วใส่ใหม่ ไม่งั้นผู้ดูแลกดส่งแล้ว 500 ทุกครั้ง (เจอ 25 ต.ค.)
    .then(() => sql.run('ALTER TABLE case_family_messages DROP CONSTRAINT IF EXISTS case_family_messages_author_kind_check'))
    .then(() => sql.run(
      "ALTER TABLE case_family_messages ADD CONSTRAINT case_family_messages_author_kind_check CHECK (author_kind IN ('family','team','staff'))"))
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_family_msg_case ON case_family_messages (case_id, created_at DESC)'))
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_family_case ON case_family_links (case_id)'))
    .then(() => sql.run('CREATE INDEX IF NOT EXISTS idx_family_line ON case_family_links (line_user_id) WHERE line_user_id IS NOT NULL'))
    // รหัสที่ยังรอรับต้องไม่ชนกัน ส่วนรหัสที่รับแล้ว/ถูกปลดให้ใช้ค่าเดิมซ้ำได้
    .then(() => sql.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_family_pending_code ON case_family_links (code_hash)
       WHERE code_hash IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL`,
    ))
    /* LINE เดียวกันผูกเคสเดียวกันได้ครั้งเดียว — linkCustomerLine() กับ accept() ต่างก็ตรวจด้วย SELECT
       ก่อน INSERT/UPDATE ซึ่งสองคำขอพร้อมกันลอดได้ทั้งคู่ · ดัชนีนี้คือด่านจริงที่ฐานข้อมูลบังคับเอง
       แยกเฉพาะแถวที่ยังไม่ถูกปลด (revoked_at IS NULL) เพราะปลดแล้วเชิญใหม่ต้องทำได้
       ถ้าฐานเดิมมีคู่ซ้ำค้างอยู่ CREATE UNIQUE INDEX จะล้ม — จับไว้แล้วเตือน ไม่ให้ ensureFamilyTable
       ทั้งตัวพังตามจนทุกเส้นของญาติใช้ไม่ได้ (ล้างคู่ซ้ำแล้วค่อยรันใหม่รอบหน้าก็ติดเอง) */
    .then(() =>
      sql
        .run(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_family_case_line ON case_family_links (case_id, line_user_id)
           WHERE revoked_at IS NULL AND line_user_id IS NOT NULL`,
        )
        .catch((err) => {
          console.warn('[family] สร้าง uq_family_case_line ไม่สำเร็จ (น่าจะมีคู่ (case_id, line_user_id) ซ้ำค้างอยู่):', err.message);
        }),
    )
    .catch((err) => {
      ready = null;
      throw err;
    }));

/** ญาติของเคส (ทั้งที่รอรับคำเชิญและที่เชื่อมแล้ว) — ไม่ส่งรหัส/LINE userId ออกไป */
export const listForCase = (caseId) =>
  sql.all(
    `SELECT link_id, display_name, invited_by, consent_by, created_at, accepted_at, code_expires_at, can_invite,
            CASE WHEN accepted_at IS NOT NULL THEN 'linked'
                 WHEN code_expires_at < now() THEN 'expired' ELSE 'pending' END AS state
     FROM case_family_links WHERE case_id = :id AND revoked_at IS NULL
     ORDER BY created_at`,
    { id: caseId },
  );

export const activeCount = async (caseId) =>
  (
    await sql.one(
      `SELECT count(*)::int AS n FROM case_family_links
       WHERE case_id = :id AND revoked_at IS NULL AND (accepted_at IS NOT NULL OR code_expires_at > now())`,
      { id: caseId },
    )
  ).n;

/** ออกรหัสเชิญ · canInvite = ญาติคนแรก (แอดมินเชิญ) ชวนต่อได้ · via = link_id ของญาติที่ชวน */
export async function createInvite(caseId, actorName, { canInvite = true, via = null, consentBy = actorName } = {}) {
  await ensureFamilyTable();
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    try {
      await sql.run(
        `INSERT INTO case_family_links (case_id, code_hash, code_expires_at, invited_by, consent_by, can_invite, invited_via)
         VALUES (:case_id, :hash, now() + make_interval(days => :days), :actor, :consent, :can_invite, :via)`,
        { case_id: caseId, hash: hashCode(code), days: CODE_DAYS, actor: actorName, consent: consentBy, can_invite: canInvite, via },
      );
      return { code, days: CODE_DAYS };
    } catch (err) {
      if (err?.code !== '23505') throw err;
    }
  }
  throw new ApiError(503, 'สร้างรหัสเชิญไม่สำเร็จชั่วคราว กรุณาลองใหม่');
}

/**
 * ลิงก์ของ LINE นี้ในเคสนี้ (เชื่อมแล้ว ยังไม่ถูกปลด) — ใช้ตรวจสิทธิ์ทุกเส้นฝั่งญาติ
 *
 * ต้องผ่านกติกา 30 วันหลังเคสปิดด้วย (FAMILY_CASE_OPEN) เหมือนทุกเส้นของญาติ
 * เดิมตรวจแค่ "ถูกเชิญและยังไม่ถูกปลด" — หน้า /family ซ่อนเคสที่ปิดเกิน 30 วันไปแล้ว (summaryFor กรองอยู่)
 * แต่ /family/photo กับ /family/post รับ case_id มาจากคำขอตรงๆ ญาติที่เก็บลิงก์รูปเก่าไว้
 * จึงยังดึงรูปในไทม์ไลน์ของเคสที่ปิดไปนานแล้วได้เรื่อยๆ ทั้งที่เปิดหน้าดูเองไม่ได้แล้ว (PDPA · ตรวจรอบ 10A)
 */
export const memberLink = (lineUserId, caseId) =>
  sql.one(
    `SELECT l.link_id, l.display_name, l.can_invite, l.consent_by
     FROM case_family_links l JOIN cases c ON c.case_id = l.case_id
     WHERE l.line_user_id = :uid AND l.case_id = :case_id AND l.revoked_at IS NULL AND l.accepted_at IS NOT NULL
       AND ${FAMILY_CASE_OPEN}`,
    { uid: lineUserId, case_id: caseId, grace: CLOSED_GRACE_DAYS },
  );

/** ญาติคนแรกชวนญาติอีกคน (แบบ ข) — รวมทั้งเคสไม่เกิน 5 · ความยินยอมอ้างอิงจากที่แอดมินยืนยันไว้กับญาติคนแรก */
export async function familyInvite(lineUserId, caseId) {
  const me = await memberLink(lineUserId, caseId);
  if (!me) return { ok: false, reason: 'not_member' };
  if (!me.can_invite) return { ok: false, reason: 'cannot_invite' };
  if ((await activeCount(caseId)) >= FAMILY_MAX_PER_CASE) return { ok: false, reason: 'full' };
  const inv = await createInvite(caseId, `${me.display_name || 'ญาติ'} (ญาติชวน)`, {
    canInvite: false,
    via: me.link_id,
    consentBy: me.consent_by,
  });
  return { ok: true, ...inv };
}

export const revoke = (caseId, linkId) =>
  sql.run('UPDATE case_family_links SET revoked_at = now() WHERE case_id = :case_id AND link_id = :id AND revoked_at IS NULL', {
    case_id: caseId,
    id: linkId,
  });

/** รับคำเชิญ — รหัสใช้ได้ครั้งเดียว · LINE เดียวกันกับเคสเดิมซ้ำ = ถือว่าสำเร็จ (กดส่งซ้ำ) */
export async function accept(code, lineUserId, displayName) {
  const link = await sql.one(
    `SELECT l.link_id, l.case_id, l.accepted_at, l.line_user_id, l.invited_by, (l.invited_via IS NOT NULL) AS via_family,
            (l.code_expires_at < now()) AS expired, c.client_name,
            /* เคสปิด/ยกเลิกไปแล้วและพ้นช่วงผ่อนผัน = รับคำเชิญไม่ได้ เดิมไม่เช็คสถานะเคสเลย
               ญาติจึงกดรับคำเชิญของเคสที่ปิดไปนานแล้วได้ (รหัสอายุ 7 วัน แต่เคสอาจปิดไปก่อน) */
            (c.status IN ('closed', 'cancelled') AND NOT (${WITHIN_GRACE})) AS case_over
     FROM case_family_links l JOIN cases c ON c.case_id = l.case_id
     WHERE l.code_hash = :hash AND l.revoked_at IS NULL
     /* รหัสเก็บเป็น hash และไม่ถูกล้างทิ้งหลังใช้ (ดูหมายเหตุที่ UPDATE ข้างล่าง) ใบที่ยังไม่มีคนรับ
        จึงต้องมาก่อนเสมอ เผื่อวันหนึ่ง newCode() สุ่มได้ซ้ำกับใบเก่าที่ใช้ไปแล้ว (1 ใน 887 ล้าน) */
     ORDER BY l.accepted_at NULLS FIRST, l.link_id DESC`,
    { hash: hashCode(code), grace: CLOSED_GRACE_DAYS },
  );
  if (!link) return { ok: false, reason: 'not_found' };
  if (link.accepted_at) {
    return link.line_user_id === lineUserId ? { ok: true, case_id: link.case_id, client_name: link.client_name } : { ok: false, reason: 'used' };
  }
  if (link.expired) return { ok: false, reason: 'expired' };
  if (link.case_over) return { ok: false, reason: 'case_closed' };
  /* LINE นี้เป็นญาติของเคสนี้อยู่แล้ว แต่ได้ "รหัสใบใหม่" มา (ทีมออกให้ซ้ำเพราะไม่รู้ว่าเข้าไปแล้ว)
     เดิมเดินหน้า UPDATE ต่อจนชน uq_family_case_line = 500 → ฝั่งแชทตอบ "ระบบขัดข้องชั่วคราว"
     แล้วญาติพิมพ์ซ้ำกี่ครั้งก็เจอเหมือนเดิม (ตรวจรอบ 12A) · ถือว่าสำเร็จ ไม่กินรหัสใบใหม่
     (ใบนั้นยังว่างไว้ให้ญาติคนอื่นใช้ได้) */
  const already = await memberLink(lineUserId, link.case_id);
  if (already) return { ok: true, case_id: link.case_id, client_name: link.client_name };
  /* 🔴 UPDATE เป็นตัวตัดสินว่าใครได้รหัสใบนี้ ไม่ใช่ SELECT ข้างบน
     เดิม SELECT ตรวจ accepted_at แล้วค่อย UPDATE โดยไม่มีเงื่อนไข = lost update:
     ลูกสาวส่งรหัสต่อในกลุ่มไลน์ แล้วลูกสาวกับลูกชายพิมพ์พร้อมกัน ทั้งคู่ผ่าน SELECT
     แล้วเขียนทับกัน ตอบ { ok:true, client_name } ทั้งคู่ ทั้งที่เป็นสมาชิกจริงแค่คนเดียว
     คนที่แพ้จึงได้ชื่อผู้ป่วยไปด้วยโดยไม่มีสิทธิ์ (PDPA) · พิสูจน์แล้ว 30/30 รอบ
     คืน 0 แถว = แพ้การแข่ง → 'used' และห้ามส่ง client_name กลับ (ฝั่ง chat มี JOIN_FAIL.used อยู่แล้ว)

     code_hash ต้อง "ไม่" ถูกล้างเป็น NULL ตรงนี้ — เดิมล้างทิ้ง ทำให้การส่งรหัสเดิมซ้ำ
     (เน็ตกระตุก/กดสองที) หาแถวไม่เจอแล้วตอบ "ไม่พบรหัสนี้" ทั้งที่เพิ่งผูกสำเร็จไปเมื่อครู่
     และคนที่เอารหัสจากกลุ่มไลน์มาใช้ตามก็ได้ 'not_found' แทน 'used' (ตรวจรอบ 12A) */
  let won = null;
  try {
    won = await sql.one(
      `UPDATE case_family_links SET line_user_id = :uid, display_name = :name, accepted_at = now()
       WHERE link_id = :id AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING link_id`,
      { uid: lineUserId, name: displayName ? String(displayName).slice(0, 80) : null, id: link.link_id },
    );
  } catch (err) {
    // ชน uq_family_case_line = อีกคำขอของ LINE เดียวกันเข้าเคสนี้ไปก่อนเสี้ยววินาที — ผลลัพธ์ที่ญาติต้องการเกิดขึ้นแล้ว
    if (err?.code !== '23505') throw err;
    return { ok: true, case_id: link.case_id, client_name: link.client_name };
  }
  if (!won) return { ok: false, reason: 'used' };
  return { ok: true, case_id: link.case_id, client_name: link.client_name, invited_by: link.invited_by, via_family: link.via_family, first: true };
}

/**
 * เคสที่ปิด/ยกเลิกแล้วยังอยู่ในช่วงผ่อนผัน 30 วันไหม (ต้องมี :grace เป็นพารามิเตอร์ของคำสั่งนั้น)
 *
 * ต้องดู cancelled_at ด้วย ไม่ใช่ closed_at อย่างเดียว — ตอนยกเลิกเคส cases/repo.js เซ็ต cancelled_at
 * ไม่ได้เซ็ต closed_at เดิมจึงตกไปที่ now() ซึ่งแปลว่า "ยังไม่หมดอายุ" ตลอดกาล เคสที่ยกเลิกไปแล้ว
 * ญาติดูข้อมูลผู้ป่วยได้ไม่สิ้นสุด · ไม่มีวันปิดบันทึกไว้เลย = ถือว่าหมดอายุ ('epoch') ปลอดภัยกว่าเปิดค้าง
 */
export const WITHIN_GRACE = `coalesce(nullif(c.closed_at, ''), nullif(c.cancelled_at, ''), 'epoch')::timestamp
            > now() - make_interval(days => :grace)`;

/**
 * "เคสนี้ยังส่งข้อมูลถึงญาติได้ไหม" — ชิ้นส่วน SQL ที่ทุกเส้นของญาติต้องใช้ตัวเดียวกัน
 * ต้องมี alias `c` = cases และพารามิเตอร์ `:grace` (= CLOSED_GRACE_DAYS) ในคำสั่งนั้นด้วย
 *
 * เดิมบังคับเฉพาะ "ทางดึง" (ญาติเปิดหน้า /family) ส่วน "ทางส่ง" เข้า LINE สามเส้นใน integration/routes.js
 * ไม่เช็คเลย (ตรวจรอบ 7) — เคสที่ปิดเกิน 30 วันแล้วทีมลงรายงานย้อนหลัง cron จึงยังดึงไปส่งถึงญาติ
 * ที่สิทธิ์หมดไปแล้วได้ ทั้งที่เจ้าตัวเปิดหน้าดูเองไม่ได้แล้ว (PDPA)
 */
export const FAMILY_CASE_OPEN = `(c.status NOT IN ('closed', 'cancelled') OR ${WITHIN_GRACE})`;

/**
 * เวลาที่เคสปิด/ยกเลิกจริง (ต้องมี alias `c` = cases) — ใช้คำนวณ "วันสุดท้ายที่ญาติยังเปิดดูได้"
 * เป็นชิ้นหัวชิ้นเดียวกับที่ WITHIN_GRACE ใช้เปรียบเทียบ · ถ้าสองตัวนี้หลุดจากกันเมื่อไร
 * วันที่ที่บอกญาติจะไม่ตรงกับวันที่ระบบปิดประตูจริง จึงเตือนไว้ตรงนี้ (ตัวทดสอบตรวจซ้ำอีกชั้น)
 */
export const CASE_ENDED_AT = `coalesce(nullif(c.closed_at, ''), nullif(c.cancelled_at, ''), 'epoch')::timestamp`;
if (!WITHIN_GRACE.startsWith(CASE_ENDED_AT)) {
  console.warn('[family] CASE_ENDED_AT ไม่ตรงกับหัวของ WITHIN_GRACE แล้ว — วันหมดสิทธิ์ที่แจ้งญาติอาจเพี้ยน');
}

/**
 * "เคสปิดมาแล้วยังไม่เกิน N วัน" แบบเลือกชื่อพารามิเตอร์ได้ — สร้างจาก WITHIN_GRACE ตัวเดิมโดยตรง ไม่ก๊อปสูตร
 * มีไว้เพื่อให้คำสั่งเดียวถามได้หลายช่วงพร้อมกัน เช่น "ยังไม่เกิน 30 วัน แต่พ้น 27 วันแล้ว" = เหลือสิทธิ์อีก ≤3 วัน
 * (ดร.ธงชัย 25 ต.ค. 2569 "ส่งข้อความปิดเคส เตือนก่อนหมดอีก 3 วัน")
 */
export const withinDays = (param = 'grace') => WITHIN_GRACE.replaceAll(':grace', `:${param}`);

/**
 * เคสที่ต้องส่งข้อความถึงญาติรอบนี้ (ดร.ธงชัย 25 ต.ค. 2569 "ส่งข้อความปิดเคส เตือนก่อนหมดอีก 3 วัน")
 *   closed   = เพิ่งปิด/ยกเลิกภายใน closedWindowDays วัน → ข้อความขอบคุณ + บอกว่ายังเปิดดูย้อนหลังได้ถึงเมื่อไร
 *   expiring = สิทธิ์เปิดดูเหลือ ≤ leadDays วัน          → ข้อความเตือนให้เปิดดู/บันทึกไว้ก่อน
 * เฉพาะเคสที่มีญาติผูก LINE แล้ว · ส่งออกไปแค่ชื่อต้นของผู้ป่วย ไม่มีชื่อโรค/อาการ/นามสกุล
 * (ข้อความเด้งขึ้นหน้าจอล็อกของญาติ คนข้าง ๆ เห็นได้)
 *
 * 🔴 หน้าต่าง closedWindowDays กันรอบแรกหลัง deploy ยิงย้อนหลังรวดเดียว — ถ้าเอา "ปิดแล้วและยังอยู่ใน
 *    ผ่อนผัน" ตรง ๆ เคสที่ปิดไป 29 วันแล้วจะได้ข้อความขอบคุณพร้อมกันทั้งก้อน
 */
export async function lifecycleDue({ closedWindowDays = 2, leadDays = 3 } = {}) {
  await ensureFamilyTable();
  const grace = CLOSED_GRACE_DAYS;
  // :lead = ช่วงที่ "ยังเหลือสิทธิ์เกิน leadDays วัน" → NOT (…) คือกลุ่มที่เหลือ ≤ leadDays วัน
  const lead = Math.max(0, grace - leadDays);
  const justClosed = `(${withinDays('fresh')})`;
  const nearlyOver = `NOT (${withinDays('lead')})`;
  const rows = await sql.all(
    `WITH fam AS (
       SELECT case_id, array_agg(DISTINCT line_user_id) AS family FROM case_family_links
       WHERE accepted_at IS NOT NULL AND revoked_at IS NULL AND line_user_id IS NOT NULL GROUP BY case_id)
     SELECT c.case_id, split_part(COALESCE(c.client_name, ''), ' ', 1) AS client_first, fam.family,
            to_char(${CASE_ENDED_AT}, 'YYYY-MM-DD') AS ended_on,
            to_char(${CASE_ENDED_AT} + make_interval(days => :grace), 'YYYY-MM-DD') AS access_until,
            ceil(extract(epoch FROM (${CASE_ENDED_AT} + make_interval(days => :grace)) - now()) / 86400)::int AS days_left,
            ${justClosed} AS just_closed, ${nearlyOver} AS nearly_over
     FROM cases c JOIN fam ON fam.case_id = c.case_id
     WHERE c.status IN ('closed', 'cancelled') AND ${WITHIN_GRACE}
       AND (${justClosed} OR ${nearlyOver})
     ORDER BY c.case_id`,
    { grace, fresh: closedWindowDays, lead },
  );
  const brief = (r) => ({
    case_id: r.case_id,
    client_first: r.client_first || null,
    family: r.family,
    ended_on: r.ended_on,
    access_until: r.access_until,
    days_left: Number(r.days_left),
  });
  return {
    grace_days: grace,
    lead_days: leadDays,
    closed_window_days: closedWindowDays,
    closed: rows.filter((r) => r.just_closed).map(brief),
    // เคสเดียวเข้าได้ทั้งสองกลุ่มเมื่อผ่อนผันสั้นมาก — ให้ข้อความปิดเคสมาก่อน ไม่ส่งสองใบในรอบเดียว
    expiring: rows.filter((r) => r.nearly_over && !r.just_closed).map(brief),
  };
}

const short = (s, n = 180) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** สรุปการดูแลของทุกเคสที่ LINE นี้ถูกเชิญ (หน้า /family ฝั่ง chat) */
export async function summaryFor(lineUserId) {
  const cases = await sql.all(
    `SELECT c.case_id, c.client_name, c.status, c.service_kind, c.start_date, c.end_date
     FROM case_family_links l JOIN cases c ON c.case_id = l.case_id
     WHERE l.line_user_id = :uid AND l.revoked_at IS NULL AND l.accepted_at IS NOT NULL
       AND ${FAMILY_CASE_OPEN}
     ORDER BY c.case_id`,
    { uid: lineUserId, grace: CLOSED_GRACE_DAYS },
  );
  const out = [];
  for (const c of cases) {
    const [visits, next, reports] = await Promise.all([
      sql.all(
        `SELECT v.visit_date, v.planned_start, v.planned_end, v.status,
                to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_in,
                to_char(v.check_out_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_out,
                e.first_name AS staff_first, e.nickname AS staff_nick, e.position AS staff_position
         FROM case_visits v LEFT JOIN employees e ON e.employee_id = v.assigned_to
         WHERE v.case_id = :id AND v.status <> 'cancelled'
           AND v.visit_date <= to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
         ORDER BY v.visit_date DESC, v.planned_start DESC NULLS LAST LIMIT 14`,
        { id: c.case_id },
      ),
      sql.one(
        `SELECT v.visit_date, v.planned_start, e.first_name AS staff_first, e.nickname AS staff_nick
         FROM case_visits v LEFT JOIN employees e ON e.employee_id = v.assigned_to
         WHERE v.case_id = :id AND v.status <> 'cancelled' AND v.check_in_at IS NULL
           AND v.visit_date > to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
         ORDER BY v.visit_date, v.planned_start NULLS LAST LIMIT 1`,
        { id: c.case_id },
      ),
      sql.all(
        /* "เวลาที่วัด" เว้นว่างได้ — ใบที่เว้นไว้เคยส่งเวลาเป็น null ออกไป แล้วหน้า /family เอาไปตีเป็น
           00:00 ของวันนั้น รายงานเย็นจึงไปจมอยู่ใต้ข้อความแชทของเมื่อเช้าทั้งวัน (ตรวจรอบ 12A)
           ใช้เวลาที่กดบันทึกแทนแบบเดียวกับรายการรายงานในระบบงาน (cases/repo.js) */
        `SELECT r.report_id, r.report_date, COALESCE(r.report_time, substr(r.created_at, 12, 5)) AS report_time,
                r.condition_change, r.bp_systolic, r.bp_diastolic, r.pulse, r.spo2,
                r.temperature_c, r.pain_score, r.symptoms, r.care_given, r.note, r.follow_up,
                e.first_name AS staff_first, e.nickname AS staff_nick
         FROM case_reports r LEFT JOIN employees e ON e.employee_id = r.reported_by
         WHERE r.case_id = :id
         ORDER BY r.report_date DESC, COALESCE(r.report_time, substr(r.created_at, 12, 5)) DESC, r.report_id DESC
         LIMIT 10`,
        { id: c.case_id },
      ),
    ]);
    const staffName = (r) => (r.staff_nick ? `${r.staff_first} (${r.staff_nick})` : r.staff_first) || null;
    const [me, family, pending, messages] = await Promise.all([
      memberLink(lineUserId, c.case_id),
      sql.all(
        `SELECT display_name FROM case_family_links
         WHERE case_id = :id AND revoked_at IS NULL AND accepted_at IS NOT NULL ORDER BY accepted_at`,
        { id: c.case_id },
      ),
      /* คำเชิญที่ออกไปแล้วแต่ยังไม่มีใครกดรับ ก็กินที่ในเพดาน 5 คน (activeCount นับด้วย)
         เดิมหน้า /family นับเฉพาะคนที่เชื่อมแล้ว จอจึงขึ้น "1/5" พร้อมปุ่มชวนต่อ แต่กดแล้วได้
         "ครบ 5 คนแล้ว" เพราะอีก 4 ใบยังค้างอยู่ — ส่งตัวเลขนี้ไปให้จอพูดตรงกับระบบ (ตรวจรอบ 12A) */
      sql.one(
        `SELECT count(*)::int AS n FROM case_family_links
         WHERE case_id = :id AND revoked_at IS NULL AND accepted_at IS NULL AND code_expires_at > now()`,
        { id: c.case_id },
      ),
      messagesFor(c.case_id),
    ]);
    out.push({
      can_invite: !!me?.can_invite,
      family: family.map((f) => f.display_name || 'ญาติ'),
      family_pending: pending?.n || 0,
      family_max: FAMILY_MAX_PER_CASE,
      messages,
      case_id: c.case_id,
      client_name: c.client_name,
      status: c.status,
      service_kind: c.service_kind,
      visits: visits.map((v) => ({
        date: v.visit_date, planned: v.planned_start, check_in: v.check_in, check_out: v.check_out, staff: staffName(v),
      })),
      next_visit: next ? { date: next.visit_date, planned: next.planned_start, staff: staffName(next) } : null,
      reports: reports.map((r) => ({
        id: r.report_id, // คีย์ของแถวในไทม์ไลน์ฝั่งหน้าเว็บ — วันเดียวกัน เวลาเดียวกัน คนเดียวกัน เคยชนกัน
        date: r.report_date,
        time: r.report_time,
        staff: staffName(r),
        condition: r.condition_change,
        vitals: {
          bp: r.bp_systolic && r.bp_diastolic ? `${r.bp_systolic}/${r.bp_diastolic}` : null,
          pulse: r.pulse, spo2: r.spo2, temp: r.temperature_c, pain: r.pain_score,
        },
        summary: short([r.symptoms, r.care_given, r.note].filter(Boolean).join(' · ')),
        follow_up: short(r.follow_up, 120) || null,
      })),
    });
  }
  return out;
}

/** ความยาวข้อความสูงสุดในไทม์ไลน์เคส — ยาวกว่านี้ให้ตีกลับ ไม่ใช่ตัดทิ้ง */
export const MESSAGE_MAX = 1000;

/** โพสต์ลงไทม์ไลน์เคส — kind 'family' (ญาติจากหน้า LINE) หรือ 'team' (ทีมจากหน้าเคสใน staff) */
export async function postMessage(caseId, { kind, name, lineUserId = null, employeeId = null, body = null, photo = null }) {
  /* ยาวเกินให้บอก ไม่ใช่ตัดเงียบ ๆ (ตรวจรอบ 19 — เดิม .slice(0, 1000) แล้วตอบสำเร็จ)
     ทั้งญาติและทีมพิมพ์อาการยาว ๆ ได้ ท้ายข้อความหายโดยไม่มีใครรู้ว่าขาด
     กันที่นี่ที่เดียวเพราะทุกทางที่โพสต์ลงไทม์ไลน์ (หน้าญาติ · ทีมในระบบงาน · สะพานแชท) ผ่านฟังก์ชันนี้ */
  const text = body == null ? null : String(body).trim();
  if (text && text.length > MESSAGE_MAX) {
    throw new ApiError(
      400,
      `ข้อความยาว ${text.length.toLocaleString('th-TH')} ตัวอักษร เกินที่ส่งได้ ${MESSAGE_MAX.toLocaleString('th-TH')} ตัว` +
        ` (เกินมา ${(text.length - MESSAGE_MAX).toLocaleString('th-TH')} ตัว) — แบ่งส่งเป็นสองข้อความได้ค่ะ`,
    );
  }
  return sql.one(
    `INSERT INTO case_family_messages (case_id, author_kind, author_name, line_user_id, employee_id, body, photo_data, photo_mime)
     VALUES (:case_id, :kind, :name, :uid, :emp, :body, :data, :mime)
     RETURNING message_id, created_at`,
    {
      case_id: caseId, kind, name: String(name || 'ญาติ').slice(0, 80), uid: lineUserId, emp: employeeId,
      body: text || null, data: photo?.data ?? null, mime: photo?.mime ?? null,
    },
  );
}

export const messagesFor = (caseId, limit = 60) =>
  sql.all(
    `SELECT message_id, author_kind, author_name, body, (photo_data IS NOT NULL) AS has_photo, created_at
     FROM case_family_messages WHERE case_id = :id AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT :limit`,
    { id: caseId, limit },
  );

export const messagePhoto = (caseId, messageId) =>
  sql.one(
    `SELECT photo_data AS data, photo_mime AS mime FROM case_family_messages
     WHERE case_id = :case_id AND message_id = :id AND deleted_at IS NULL AND photo_data IS NOT NULL`,
    { case_id: caseId, id: messageId },
  );

/* ลบ = ซ่อนแถว ไบต์รูปยังอยู่ในฐาน — ดร.ธงชัยเคาะ 25 ต.ค. 2569 ว่า "ไม่ต้องลบ เก็บไว้ก่อน"
   (เคยพิจารณาให้ล้าง photo_data ทิ้งจริงเพื่อให้คำว่า "ลบแล้ว" ตรงกับความจริงในแง่ PDPA แล้วตัดสินใจคงของเดิม) */
export const hideMessage = (caseId, messageId) =>
  sql.run('UPDATE case_family_messages SET deleted_at = now() WHERE case_id = :case_id AND message_id = :id AND deleted_at IS NULL', {
    case_id: caseId,
    id: messageId,
  });

/**
 * "ให้ LINE นี้ดูการดูแล" — ผูก LINE ของลูกค้าเจ้าของเคส (คนที่ทักมาทาง OA Kin HomeCare) เป็นญาติคนแรกทันที
 * ไม่ต้องส่งรหัส เพราะรู้ LINE อยู่แล้วจากแชท (lib/customerLine.js) · แอดมินต้องติ๊กยินยอมเหมือนการเชิญปกติ
 * คืน { ok } · { ok:false, reason: 'no_line' | 'already' | 'full' }
 */
export async function linkCustomerLine(caseId, actorName) {
  const row = await sql.one(
    `SELECT cu.line_user_id, cu.line_display_name FROM cases c JOIN customers cu ON cu.customer_id = c.customer_id
     WHERE c.case_id = :id`,
    { id: caseId },
  );
  if (!row?.line_user_id) return { ok: false, reason: 'no_line' };
  const exists = await sql.one(
    `SELECT 1 AS x FROM case_family_links WHERE case_id = :id AND line_user_id = :uid AND revoked_at IS NULL`,
    { id: caseId, uid: row.line_user_id },
  );
  if (exists) return { ok: false, reason: 'already' };
  if ((await activeCount(caseId)) >= FAMILY_MAX_PER_CASE) return { ok: false, reason: 'full' };
  await sql.run(
    `INSERT INTO case_family_links (case_id, line_user_id, display_name, invited_by, consent_by, accepted_at, can_invite)
     VALUES (:id, :uid, :name, :actor, :actor, now(), true)`,
    { id: caseId, uid: row.line_user_id, name: row.line_display_name || 'ลูกค้า (LINE)', actor: actorName },
  );
  return { ok: true };
}
