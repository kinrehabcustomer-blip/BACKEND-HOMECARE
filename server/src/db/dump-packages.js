/*
 * ดึงข้อมูลตารางราคาแพ็คเกจ Homecare ออกมาเป็นไฟล์ .sql สำหรับเอาไปใส่โปรเจคอื่น
 *
 *     npm run dump:packages                      -> ได้ไฟล์ homecare-packages-data.sql ที่ root
 *     npm run dump:packages -- ราคา.sql           -> ตั้งชื่อ/ที่อยู่ไฟล์เอง
 *     npm run dump:packages -- --no-staff-pay    -> ไม่เอาค่าจ้างพนักงานไปด้วย
 *
 * สคริปต์ที่ root เรียก node ตรง ไม่ใช่ `npm run ... --workspace server` เหมือนสคริปต์อื่น
 * เพราะ npm ชั้นนอกจะกิน `--no-staff-pay` ไปเป็น config ของตัวเอง (--no-<key> = ตั้ง key เป็น false)
 * แล้วมันไปไม่ถึงสคริปต์เลย · สคริปต์อื่นในโปรเจคไม่รับ argument จึงไม่เจอปัญหานี้
 *
 * อ่านอย่างเดียว ไม่เขียนอะไรลงฐานเลย — ปลอดภัยกับฐาน production ที่ DATABASE_URL ชี้อยู่
 *
 * ทำไมไม่ใช้ pg_dump: pg_dump ต้องลงเครื่องมือของ Postgres แยกและต้องคุมรุ่นให้ตรงกับ server
 * ส่วนสคริปต์นี้ใช้ไดรเวอร์ pg ที่โปรเจคมีอยู่แล้ว ใครโคลน repo มาก็รันได้ทันที
 * และคุมรูปแบบผลลัพธ์ได้เอง (คงเลข id เดิม + ตั้งตัวนับต่อให้ถูก — สองอย่างที่พลาดกันบ่อยที่สุด)
 */
import '../lib/env.js';
import { writeFileSync } from 'node:fs';
import { pool, sql } from './index.js';

const args = process.argv.slice(2);

/* --no-staff-pay = ไม่ต้องเอาค่าจ้างพนักงานไปด้วย
   staff_pay เป็นต้นทุนที่ระบบนี้เปิดให้เห็นเฉพาะผู้จัดการ (canSeeStaffPay ใน lib/auth.js)
   ถ้าโปรเจคปลายทางไม่มีชั้นสิทธิ์แบบเดียวกัน ตัวเลขนี้จะกลายเป็นของที่ทุกคนเปิดดูได้

   ตัดตั้งแต่ตอน SELECT ไม่ใช่ให้คนไปแก้ไฟล์เอาเองทีหลัง — ไฟล์ผลลัพธ์มี 64 บรรทัด
   ที่หน้าตาเหมือนกันหมด นับคอลัมน์ผิดบรรทัดเดียวก็ได้ราคาที่ผิดโดยไม่มีอะไรฟ้อง */
const withStaffPay = !args.includes('--no-staff-pay');
const outFile = args.find((a) => !a.startsWith('--')) ?? 'homecare-packages-data.sql';

/**
 * ค่าหนึ่งค่า -> literal ของ SQL
 *
 * ต้อง escape เอง เพราะผลลัพธ์เป็นไฟล์ข้อความ ไม่ใช่ query ที่ส่งพารามิเตอร์แยกได้
 * ชื่อรูปแบบบริการมีเครื่องหมาย ' ได้จริง (เช่น "รายเดือน 24 ชม. 'ไม่มีวันหยุด'")
 * ถ้าไม่คูณ ' เป็น '' ไฟล์ที่ได้จะพังตอนรัน และพังแบบอ่านไม่ออกว่าพังตรงไหน
 */
function literal(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** INSERT ของทั้งตาราง — ไม่มีแถวก็คืนคอมเมนต์ไว้ ให้คนอ่านไฟล์รู้ว่าตารางนี้ว่างจริง ไม่ใช่ลืมใส่ */
function insertsFor(table, columns, rows) {
  if (!rows.length) return `-- ${table}: ไม่มีข้อมูล\n`;

  const values = rows
    .map((r) => `  (${columns.map((c) => literal(r[c])).join(', ')})`)
    .join(',\n');

  /* OVERRIDING SYSTEM VALUE — คอลัมน์ id เป็น GENERATED ALWAYS AS IDENTITY
     ซึ่งปกติใส่ค่าเองไม่ได้ แต่ที่นี่ "ต้อง" ใส่ เพราะ pkg_rates อ้าง format_id/grade_id
     ถ้าปล่อยให้ฐานใหม่ออกเลขเอง ความเชื่อมโยงระหว่างสามตารางจะสลับกันทั้งชุด

     ON CONFLICT DO NOTHING — รันไฟล์ซ้ำแล้วไม่พังและไม่เพิ่มแถวซ้ำ */
  return (
    `INSERT INTO ${table} (${columns.join(', ')}) OVERRIDING SYSTEM VALUE VALUES\n` +
    `${values}\nON CONFLICT DO NOTHING;\n`
  );
}

/* ตั้งตัวนับ id ให้ต่อจากเลขสูงสุดที่เพิ่งใส่เข้าไป
   ไม่ทำข้อนี้ = แถวแรกที่เพิ่มจากหน้าเว็บของโปรเจคใหม่จะได้ id = 1 ซึ่งชนกับของเดิมทันที
   is_called = false ทำให้ค่าถัดไปเป็น max+1 พอดี ไม่ข้ามไปหนึ่งเลข */
const resetSequence = (table, idColumn) =>
  `SELECT setval(pg_get_serial_sequence('${table}', '${idColumn}'),\n` +
  `              COALESCE((SELECT MAX(${idColumn}) FROM ${table}), 0) + 1, false);\n`;

const GRADE_COLUMNS = ['grade_id', 'name', 'description', 'sort_order'];
const FORMAT_COLUMNS = ['format_id', 'name', 'category', 'graded', 'sort_order'];
// staff_pay หายไปทั้งจาก SELECT และจากรายชื่อคอลัมน์ของ INSERT พร้อมกัน
// ฐานปลายทางจึงได้ค่า NULL ในช่องนั้น (คอลัมน์ไม่ได้เป็น NOT NULL) ไม่ใช่ INSERT ที่พังเพราะคอลัมน์ไม่ครบ
const RATE_COLUMNS = [
  'rate_id', 'format_id', 'grade_id', 'staff_tier', 'customer_price',
  ...(withStaffPay ? ['staff_pay'] : []),
  'available', 'discount_percent', 'discount_amount',
];

// เรียงตาม id เพื่อให้ผลลัพธ์เหมือนเดิมทุกครั้งที่รัน — ไฟล์ที่ diff ได้มีประโยชน์กว่ามาก
const [grades, formats, rates] = await Promise.all([
  sql.all(`SELECT ${GRADE_COLUMNS.join(', ')} FROM pkg_grades ORDER BY grade_id`),
  sql.all(`SELECT ${FORMAT_COLUMNS.join(', ')} FROM pkg_service_formats ORDER BY format_id`),
  sql.all(`SELECT ${RATE_COLUMNS.join(', ')} FROM pkg_rates ORDER BY rate_id`),
]);

const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

const out = `-- ตารางราคาแพ็คเกจ Homecare — ข้อมูล ณ ${stamp} UTC
--
-- รันไฟล์ homecare-packages.sql (สร้างตาราง) ให้เสร็จก่อน แล้วค่อยรันไฟล์นี้:
--     psql "$DATABASE_URL" -f homecare-packages.sql
--     psql "$DATABASE_URL" -f ${outFile}
--
-- เกรด ${grades.length} · รูปแบบบริการ ${formats.length} · ช่องราคา ${rates.length}
--
-- created_at/updated_at ไม่ได้ดึงมาด้วย — ปล่อยให้ฐานใหม่ประทับเวลาที่นำเข้าเอง
-- (เวลาที่ตั้งราคาบนฐานเดิมไม่มีความหมายกับโปรเจคใหม่ และเป็นคนละ timezone ได้)
--
${withStaffPay
  ? `-- ⚠️ ไฟล์นี้มี staff_pay (ค่าจ้างพนักงาน) ซึ่งเป็นต้นทุนที่ระบบเดิมเปิดให้เห็นเฉพาะผู้จัดการ
--    ถ้าโปรเจคปลายทางไม่มีชั้นสิทธิ์แบบเดียวกัน ให้ดึงใหม่ด้วย: npm run dump:packages -- --no-staff-pay`
  : `-- 🔒 ไฟล์นี้ "ไม่มี" staff_pay (ค่าจ้างพนักงาน) — ดึงด้วย --no-staff-pay
--    มีแต่ราคาที่ขายลูกค้า (customer_price) · ช่อง staff_pay ในฐานปลายทางจะเป็น NULL
--    หน้าจอที่คิดส่วนต่าง/กำไรจากสองค่านี้จะคำนวณไม่ได้ ต้องเผื่อกรณี NULL ไว้ด้วย`}

BEGIN;

${insertsFor('pkg_grades', GRADE_COLUMNS, grades)}
${insertsFor('pkg_service_formats', FORMAT_COLUMNS, formats)}
${insertsFor('pkg_rates', RATE_COLUMNS, rates)}
${resetSequence('pkg_grades', 'grade_id')}${resetSequence('pkg_service_formats', 'format_id')}${resetSequence('pkg_rates', 'rate_id')}
COMMIT;
`;

writeFileSync(outFile, out, 'utf8');

console.log(`เขียน ${outFile} เรียบร้อย`);
console.log(`  เกรด            ${grades.length} รายการ`);
console.log(`  รูปแบบบริการ     ${formats.length} รายการ`);
console.log(`  ช่องราคา         ${rates.length} ช่อง`);
console.log(withStaffPay ? '  ค่าจ้างพนักงาน   รวมอยู่ในไฟล์' : '  ค่าจ้างพนักงาน   ตัดออกแล้ว (--no-staff-pay)');

await pool.end();
