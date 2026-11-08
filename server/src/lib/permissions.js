import { sql } from '../db/index.js';
import { BACK_POSITIONS } from '../employees/schema.js';

/**
 * สิทธิ์การเข้าถึงรายตำแหน่ง — ตั้งได้จากหน้า "จัดการสิทธิ์" (6 พ.ย. 2569)
 *
 * เดิมเขียนตายตัวไว้เป็น 3 หมวด (office / billing / money) ใน lib/auth.js
 * ตอนนี้แยกเป็นรายเมนู + งานอ่อนไหว แล้ว "คิด" 3 หมวดเดิมจากชุดนี้ — ด่านเดิมราว 100 จุดที่เช็ค
 * can(position, 'office' | 'billing' | 'money') จึงทำงานต่อได้โดยไม่ต้องแก้ทีละจุด
 *
 *   office  = มีเมนูงานหลังบ้านอย่างน้อยหนึ่งเมนู (เคส ตารางงาน การมาทำงาน แพ็คเกจ ลูกค้า ผู้รับบริการ พนักงาน ประเมิน ภาพรวม)
 *   billing = มีเมนูใบแจ้งหนี้
 *   money   = มีอย่างน้อยหนึ่งอย่างในเรื่องเงิน (ค่าตอบแทน รายได้ เห็นค่าจ้าง ใบลดหนี้/ยกเลิกใบ)
 *
 * เมนูงานหลังบ้านแต่ละเมนูกันที่หน้าเว็บ (ซ่อนเมนู + เข้าหน้าไม่ได้) ส่วนด่าน API ของกลุ่มนี้ยังเป็น office ร่วมกัน
 * เพราะหน้าเหล่านี้เรียก API ข้ามกัน (หน้าตารางงาน/การมาทำงานเปิดเคส · ฟอร์มเคสโหลดแพ็คเกจ/ผู้รับบริการ)
 * ส่วนเมนู/งานที่แยก API ได้จริง กันที่ server ด้วย: ค่าตอบแทน · รายได้ · เห็นค่าจ้าง · ใบลดหนี้/ยกเลิกใบ · ลบสลิป
 */
export const PERMISSION_CATALOG = [
  { key: 'dashboard', group: 'menu', label: 'ภาพรวม' },
  { key: 'cases', group: 'menu', label: 'เคส' },
  { key: 'calendar', group: 'menu', label: 'ตารางงาน' },
  { key: 'attendance', group: 'menu', label: 'การมาทำงาน' },
  { key: 'invoices', group: 'menu', label: 'ใบแจ้งหนี้' },
  { key: 'payroll', group: 'menu', label: 'ค่าตอบแทนพนักงาน', hint: 'อนุมัติกะ · ปล่อยค่าจ้าง · เปิด/จ่ายรอบ' },
  { key: 'revenue', group: 'menu', label: 'รายได้บริษัท' },
  { key: 'packages', group: 'menu', label: 'แพ็คเกจ (Homecare · กายภาพ)' },
  { key: 'customers', group: 'menu', label: 'ลูกค้า' },
  { key: 'patients', group: 'menu', label: 'ผู้รับบริการ' },
  { key: 'employees', group: 'menu', label: 'พนักงาน' },
  { key: 'reviews', group: 'menu', label: 'คะแนนประเมินจากญาติ' },
  { key: 'see_pay', group: 'sensitive', label: 'เห็นค่าจ้างพนักงาน / ต้นทุน / กำไร' },
  { key: 'invoice_adjust', group: 'sensitive', label: 'ออกใบลดหนี้ · ยกเลิกใบแจ้งหนี้ · แก้ข้อมูลเงินคืน' },
  { key: 'slip_delete', group: 'sensitive', label: 'ลบสลิปการโอน' },
];
export const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);

const OFFICE_KEYS = ['dashboard', 'cases', 'calendar', 'attendance', 'packages', 'customers', 'patients', 'employees', 'reviews'];
const MONEY_KEYS = ['payroll', 'revenue', 'see_pay', 'invoice_adjust'];

/** ตำแหน่งที่แก้สิทธิ์ได้ — Super Admin ได้ครบเสมอ (แก้ไม่ได้ กันล็อกทุกคนออกจากระบบ) · สายภาคสนามไม่มีหลังบ้าน */
export const LOCKED_POSITION = 'super_admin';
export const EDITABLE_POSITIONS = BACK_POSITIONS.filter((p) => p !== LOCKED_POSITION);
/** ใครเปิดหน้าจัดการสิทธิ์ได้ — ตายตัว ไม่อยู่ในตาราง (ถ้าตั้งได้ ก็ปิดทางกลับของตัวเองได้) */
export const PERMISSION_ADMINS = ['super_admin', 'manager'];

/** ค่าตั้งต้น = สิทธิ์เดิมก่อนมีหน้านี้ทุกประการ — เปิดใช้แล้วไม่มีใครได้หรือเสียสิทธิ์ */
export const DEFAULT_PERMISSIONS = {
  super_admin: PERMISSION_KEYS,
  manager: PERMISSION_KEYS,
  hr: [...OFFICE_KEYS, 'invoices'],
  admin: [...OFFICE_KEYS, 'invoices', 'slip_delete'],
  finance: ['invoices', 'payroll', 'revenue', 'see_pay', 'invoice_adjust', 'slip_delete'],
  /* หัวหน้าพยาบาล (ดร.ธงชัย 8 พ.ย. 2569 "เปิดชั้น 1+2 เลย") — งานคลินิกล้วน
     เห็นเคส ตารางงาน การมาทำงาน ผู้รับบริการ พนักงาน และคะแนนจากญาติ
     🔴 ไม่มีเมนูเงินสักตัว และไม่มี see_pay — เปิดหน้าพนักงานได้แต่ไม่เห็นค่าจ้าง
     ไม่มีลูกค้า/แพ็คเกจ เพราะเป็นเรื่องผู้จ่ายเงินกับราคา ไม่ใช่เรื่องการดูแล */
  nurse_lead: ['dashboard', 'cases', 'calendar', 'attendance', 'patients', 'employees', 'reviews'],
};

/* แคชในหน่วยความจำ — requireAuth โหลดให้ก่อนทุกคำขอ (อายุ 15 วินาที) ด่านสิทธิ์จึงอ่านแบบ sync ได้
   แก้สิทธิ์แล้วเครื่องที่บันทึกเห็นทันที เครื่องอื่น (instance อื่นบน Vercel) เห็นภายใน 15 วินาที */
const CACHE_MS = 15_000;
let cache = null;
let loadedAt = 0;
let loading = null;

let tableReady = null;
export const ensurePermissionTable = () =>
  (tableReady ??= sql
    .run(
      `CREATE TABLE IF NOT EXISTS role_permissions (
         position        TEXT PRIMARY KEY,
         permissions     TEXT[] NOT NULL,
         updated_by      TEXT,
         updated_by_name TEXT,
         updated_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
       )`,
    )
    .catch((err) => {
      tableReady = null;
      throw err;
    }));

const clean = (keys) => PERMISSION_KEYS.filter((k) => keys.includes(k));

/** โหลดสิทธิ์จากฐาน (ถ้าแคชเก่า) — ฐานล่ม = ใช้แคชเดิม/ค่าตั้งต้นต่อ ไม่ทำให้ทั้งระบบเข้าไม่ได้ */
export async function loadPermissions({ force = false } = {}) {
  if (!force && cache && Date.now() - loadedAt < CACHE_MS) return;
  loading ??= (async () => {
    try {
      await ensurePermissionTable();
      const rows = await sql.all('SELECT position, permissions FROM role_permissions');
      const next = new Map();
      for (const r of rows) {
        if (EDITABLE_POSITIONS.includes(r.position)) next.set(r.position, clean(r.permissions ?? []));
      }
      cache = next;
      loadedAt = Date.now();
    } catch (err) {
      console.error('[permissions] โหลดสิทธิ์จากฐานไม่สำเร็จ ใช้ค่าเดิมต่อ:', err.message);
    } finally {
      loading = null;
    }
  })();
  await loading;
}

/** รายการสิทธิ์รายเมนู/งานของตำแหน่งนี้ (ไม่รวม 3 หมวดที่คิดต่อ) */
export function keysFor(position) {
  if (position === LOCKED_POSITION) return PERMISSION_KEYS;
  return cache?.get(position) ?? DEFAULT_PERMISSIONS[position] ?? [];
}

/** สิทธิ์ทั้งหมดที่ส่งให้หน้าเว็บ/ใช้ตรวจ = รายเมนู/งาน + หมวดเดิมที่คิดจากชุดนั้น */
export function permissionsFor(position) {
  const keys = keysFor(position);
  const derived = [];
  if (keys.some((k) => OFFICE_KEYS.includes(k))) derived.push('office');
  if (keys.includes('invoices')) derived.push('billing');
  if (keys.some((k) => MONEY_KEYS.includes(k))) derived.push('money');
  return [...derived, ...keys];
}

/** ตารางสิทธิ์ทุกตำแหน่ง — สำหรับหน้าจัดการสิทธิ์ */
export async function permissionMatrix() {
  await loadPermissions({ force: true });
  await ensurePermissionTable();
  const meta = await sql.all('SELECT position, updated_by_name, updated_at FROM role_permissions');
  const byPos = new Map(meta.map((m) => [m.position, m]));
  return BACK_POSITIONS.map((position) => ({
    position,
    editable: position !== LOCKED_POSITION,
    customized: byPos.has(position),
    updated_by_name: byPos.get(position)?.updated_by_name ?? null,
    updated_at: byPos.get(position)?.updated_at ?? null,
    permissions: keysFor(position),
  }));
}

/** บันทึกสิทธิ์ของตำแหน่งหนึ่ง (แทนทั้งชุด) · keys = null → กลับไปใช้ค่าตั้งต้น */
export async function savePermissions(position, keys, actor) {
  await ensurePermissionTable();
  if (keys == null) {
    await sql.run('DELETE FROM role_permissions WHERE position = :position', { position });
  } else {
    await sql.run(
      `INSERT INTO role_permissions (position, permissions, updated_by, updated_by_name)
       VALUES (:position, :permissions::text[], :by, :by_name)
       ON CONFLICT (position) DO UPDATE
       SET permissions = EXCLUDED.permissions, updated_by = EXCLUDED.updated_by,
           updated_by_name = EXCLUDED.updated_by_name,
           updated_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`,
      { position, permissions: clean(keys), by: actor?.employee_id ?? null, by_name: actor?.name ?? null },
    );
  }
  await loadPermissions({ force: true });
}
