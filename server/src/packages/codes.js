import { sql } from '../db/index.js';
import { ApiError } from '../lib/errors.js';

/**
 * รหัสแพ็คเกจที่คนอ่านออก (ผู้ใช้ขอ 20 พ.ย. 2569 "อยากเห็นและแก้ได้จากหน้าเว็บ")
 *
 *   กายภาพ   physio_packages.code — ตั้งต้น PT-<id 3 หลัก>          เช่น PT-006
 *   Homecare pkg_rates.code        — ตั้งต้น HC-<รูปแบบ>-<เกรด>-<ระดับ> เช่น HC-M24N-G1-RN
 *
 * เป็นป้ายชื่อสำหรับคน ไม่ใช่ตัวเชื่อมข้อมูล — เคสยังผูกด้วย physio_package_id / (format, grade, tier) เหมือนเดิม
 * แก้รหัสแล้วเคสเก่าจึงไม่หลุด · ID ตัวเลขเดิมแก้ไม่ได้ (เคสทุกใบชี้มันอยู่)
 *
 * กติกา: A-Z 0-9 และ - · ยาวไม่เกิน 20 · ห้ามซ้ำ "ข้ามทั้งสองตาราง" ไม่สนตัวพิมพ์
 * ส่งรหัสว่างมา = ให้ระบบตั้งรหัสตั้งต้นให้ใหม่
 *
 * คอลัมน์สร้างแบบ lazy (Vercel ไม่ได้รัน schema.sql ตอน deploy — แบบเดียวกับ formatDays.js)
 * และ SELECT ของเคสอ้าง pp.code / r.code จึงถูกเรียกจาก ensureAddonLink ก่อนทุกการอ่านเคสด้วย
 */
export const CODE_MAX = 20;
export const CODE_RE = /^[A-Z0-9-]{1,20}$/;

/** ตัวพิมพ์ใหญ่ · ช่องว่างกลางคำเป็น - · ตัดหัวท้าย — "hc m24n" กับ "HC-M24N" คือตัวเดียวกัน */
export const normalizeCode = (s) =>
  String(s ?? '').trim().toUpperCase().replace(/\s+/g, '-');

export const physioDefaultCode = (id) => `PT-${String(id).padStart(3, '0')}`;

/**
 * ตัวย่อรูปแบบบริการ: D/W/M + ชั่วโมง (+ H = มีวันหยุด / N = ไม่มีวันหยุด สำหรับรายเดือน)
 *   รายวัน 12 ชม. → D12 · รายเดือน 24 ชม. หยุด 4 วัน → M24H · รายเดือน 24 ชม. ไม่มีวันหยุด → M24N
 * อ่านชั่วโมงจากชื่อไม่ออก (รูปแบบที่ตั้งชื่อเอง) = F<format_id> — ยังไม่ซ้ำกันแน่นอน
 */
export function formatAbbr(f) {
  const hours = /(\d+)\s*ชม/.exec(f?.name ?? '')?.[1];
  const cat = { daily: 'D', weekly: 'W', monthly: 'M' }[f?.category];
  if (!hours || !cat) return `F${f?.format_id ?? ''}`;
  if (f.category !== 'monthly') return `${cat}${hours}`;
  // "ไม่มีวันหยุด" มีคำว่า "หยุด" อยู่ข้างใน ต้องเช็คก่อน
  const off = !/ไม่มีวันหยุด/.test(f.name) && /หยุด/.test(f.name);
  return `${cat}${hours}${off ? 'H' : 'N'}`;
}

/** เกรด → G + เลขในชื่อ ("เกรด 1" → G1) · ชื่อไม่มีเลข = G<grade_id> */
export const gradeAbbr = (g) => `G${/(\d+)/.exec(g?.name ?? '')?.[1] ?? g?.grade_id ?? ''}`;

export const rateDefaultCode = (rate, format, grade) =>
  ['HC', formatAbbr(format), rate.grade_id != null ? gradeAbbr(grade) : null, rate.staff_tier]
    .filter(Boolean)
    .join('-');

const RATE_INDEX = 'uq_pkg_rates_code';
const PHYSIO_INDEX = 'uq_physio_packages_code';

/** ชนดัชนีรหัสซ้ำ (สองคำขอพร้อมกันที่ผ่านการเช็คล่วงหน้ามาได้ทั้งคู่) */
export const isDuplicateCodeError = (err) =>
  err?.code === '23505' && [RATE_INDEX, PHYSIO_INDEX].some((n) => String(err?.constraint ?? '').includes(n));

export const duplicateCodeError = (code) =>
  new ApiError(409, `รหัสแพ็คเกจ "${code}" มีแพ็คอื่นใช้อยู่แล้ว — ตั้งรหัสให้ต่างกัน`);

let ready = null;
export const ensurePackageCodes = () =>
  (ready ??= (async () => {
    // ดู catalog ก่อน (ไม่ล็อกอะไร) — ALTER TABLE ขอล็อกทั้งตารางแม้คอลัมน์มีแล้ว
    const { n } = await sql.one(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'code'
          AND table_name IN ('pkg_rates', 'physio_packages')`,
    );
    if (n < 2) {
      await sql.run('ALTER TABLE pkg_rates ADD COLUMN IF NOT EXISTS code TEXT');
      await sql.run('ALTER TABLE physio_packages ADD COLUMN IF NOT EXISTS code TEXT');
      await sql.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${RATE_INDEX} ON pkg_rates (upper(code)) WHERE code IS NOT NULL`);
      await sql.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${PHYSIO_INDEX} ON physio_packages (upper(code)) WHERE code IS NOT NULL`);
    }
    await fillMissingCodes();
  })().catch((err) => {
    ready = null;
    throw err;
  }));

/**
 * ตั้งรหัสตั้งต้นให้ทุกแถวที่ยังไม่มีรหัส (ครั้งแรกหลังเพิ่มคอลัมน์ · แถวใหม่ · คนลบรหัสทิ้งให้ระบบตั้งใหม่)
 * ชนรหัสที่มีอยู่แล้วต่อท้าย -2, -3 … · อีก instance ตั้งไปก่อน (ชนดัชนี) = ข้ามแถวนั้น
 */
export async function fillMissingCodes() {
  const [rates, physio] = await Promise.all([
    sql.all('SELECT rate_id, format_id, grade_id, staff_tier FROM pkg_rates WHERE code IS NULL ORDER BY rate_id'),
    sql.all('SELECT physio_package_id FROM physio_packages WHERE code IS NULL ORDER BY physio_package_id'),
  ]);
  if (!rates.length && !physio.length) return;

  const [formats, grades, used] = await Promise.all([
    sql.all('SELECT format_id, name, category FROM pkg_service_formats'),
    sql.all('SELECT grade_id, name FROM pkg_grades'),
    sql.all(`SELECT upper(code) AS c FROM pkg_rates WHERE code IS NOT NULL
             UNION ALL SELECT upper(code) FROM physio_packages WHERE code IS NOT NULL`),
  ]);
  const fmt = new Map(formats.map((f) => [f.format_id, f]));
  const grd = new Map(grades.map((g) => [g.grade_id, g]));
  const taken = new Set(used.map((u) => u.c));
  const unique = (base) => {
    let code = base.slice(0, CODE_MAX);
    for (let i = 2; taken.has(code); i++) code = `${base.slice(0, CODE_MAX - String(i).length - 1)}-${i}`;
    taken.add(code);
    return code;
  };
  const write = async (query, params) => {
    try {
      await sql.run(query, params);
    } catch (err) {
      if (!isDuplicateCodeError(err)) throw err;
    }
  };

  for (const r of rates) {
    const code = unique(rateDefaultCode(r, fmt.get(r.format_id), grd.get(r.grade_id)));
    await write('UPDATE pkg_rates SET code = :code WHERE rate_id = :id AND code IS NULL', { code, id: r.rate_id });
  }
  for (const p of physio) {
    const code = unique(physioDefaultCode(p.physio_package_id));
    await write('UPDATE physio_packages SET code = :code WHERE physio_package_id = :id AND code IS NULL', {
      code,
      id: p.physio_package_id,
    });
  }
}

/**
 * เช็ครหัสก่อนเขียน — ห้ามซ้ำกันเองในชุดที่ส่งมา และห้ามซ้ำกับแพ็คอื่น (ทั้งกายภาพและ Homecare)
 * entries: [{ code, self }] · self(row) = true ถ้าแถวในฐานคือตัวเดียวกับที่กำลังแก้ (ไม่นับว่าชน)
 * ดัชนี unique ยังกันซ้ำชั้นสุดท้ายอยู่ ตรงนี้มีไว้ให้ข้อความบอกได้ว่ารหัสไหนชน
 */
export async function assertCodesFree(entries) {
  const list = entries.filter((e) => e.code);
  if (!list.length) return;
  const seen = new Set();
  for (const e of list) {
    if (seen.has(e.code)) throw new ApiError(409, `รหัสแพ็คเกจ "${e.code}" ซ้ำกันเองในชุดที่บันทึก — แต่ละช่องต้องใช้รหัสต่างกัน`);
    seen.add(e.code);
  }
  const rows = await sql.all(
    `SELECT upper(code) AS code, 'rate' AS kind, format_id, grade_id, staff_tier, NULL::int AS physio_package_id
       FROM pkg_rates WHERE upper(code) = ANY(:codes::text[])
     UNION ALL
     SELECT upper(code), 'physio', NULL, NULL, NULL, physio_package_id
       FROM physio_packages WHERE upper(code) = ANY(:codes::text[])`,
    { codes: [...seen] },
  );
  for (const e of list) {
    const clash = rows.find((r) => r.code === e.code && !e.self(r));
    if (clash) throw duplicateCodeError(e.code);
  }
}
