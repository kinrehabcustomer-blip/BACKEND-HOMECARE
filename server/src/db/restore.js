/**
 * กู้คืนจากโฟลเดอร์ที่ src/db/backup.js สร้าง — ลงฐานเปล่าเท่านั้น
 *   RESTORE_DATABASE_URL=<ฐานปลายทาง> npm run restore:db --workspace server -- <โฟลเดอร์ backup>
 *
 * กันพลาด:
 *   - ไม่อ่าน DATABASE_URL เลย ต้องระบุ RESTORE_DATABASE_URL เองทุกครั้ง (กันกู้คืนทับฐานจริงเพราะ .env ชี้อยู่)
 *   - ปลายทางต้องไม่มีตารางใน schema public สักตาราง — มีแล้ว = หยุด ไม่แตะอะไร
 *   - ตรวจ sha256 ของทุกไฟล์กับ manifest ก่อนเริ่ม — ไฟล์เสีย/ถูกแก้ = หยุด
 *   - ทำทั้งหมดใน transaction เดียว ล้มตรงไหน = ย้อนทั้งหมด ฐานปลายทางกลับเป็นฐานเปล่า
 *   - จบแล้วนับแถวทุกตารางเทียบกับ manifest
 *
 * ลำดับ: schema-pre.sql (ตาราง ไม่มี FK/trigger) → โหลดข้อมูลทุกตาราง → schema-post.sql (index · FK · trigger · เลขรันต่อ)
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

const url = process.env.RESTORE_DATABASE_URL;
const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!url || !dir) {
  console.error('วิธีใช้: RESTORE_DATABASE_URL=<ฐานปลายทางที่ว่าง> node src/db/restore.js <โฟลเดอร์ backup>');
  process.exit(1);
}
const local = /sslmode=disable/.test(url);
const BATCH = 500;
const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
for (const f of [...manifest.tables.map((t) => ({ file: t.file, sha256: t.sha256 })), manifest.schema.pre, manifest.schema.post]) {
  if ((await sha(join(dir, f.file))) !== f.sha256) {
    console.error(`ไฟล์ ${f.file} ไม่ตรงกับ manifest (เสียหรือถูกแก้) — ไม่กู้คืน`);
    process.exit(1);
  }
}

const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: true } });
try {
  await client.connect();
  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db');
  const { rows: [{ n }] } = await client.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  );
  if (n > 0) throw new Error(`ฐาน ${db} มีตารางอยู่แล้ว ${n} ตาราง — กู้คืนได้เฉพาะฐานเปล่า (ไม่เขียนทับข้อมูลเดิม)`);
  console.log(`กู้คืน ${manifest.database} (snapshot ${manifest.snapshot_at}) → ฐาน ${db}`);

  await client.query('BEGIN');
  await client.query(await readFile(join(dir, 'schema-pre.sql'), 'utf8'));

  for (const t of manifest.tables) {
    // คอลัมน์ generated คำนวณเองจากคอลัมน์อื่น — ใส่ค่าลงไปไม่ได้
    const cols = t.columns.filter((c) => !c.generated).map((c) => qi(c.name)).join(', ');
    const insert = `INSERT INTO ${qi(t.name)} (${cols}) OVERRIDING SYSTEM VALUE
                    SELECT ${cols} FROM json_populate_recordset(NULL::${qi(t.name)}, $1::json)`;
    let batch = [];
    let loaded = 0;
    const flush = async () => {
      if (!batch.length) return;
      await client.query(insert, [`[${batch.join(',')}]`]);
      loaded += batch.length;
      batch = [];
    };
    const lines = createInterface({ input: createReadStream(join(dir, t.file)).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      batch.push(line);
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    if (loaded !== t.rows) throw new Error(`ตาราง ${t.name}: โหลด ${loaded} แถว แต่ manifest บอก ${t.rows}`);
    console.log(`  ${t.name.padEnd(32)} ${String(loaded).padStart(8)} แถว`);
  }

  await client.query(await readFile(join(dir, 'schema-post.sql'), 'utf8'));

  for (const t of manifest.tables) {
    const { rows: [{ c }] } = await client.query(`SELECT count(*)::int AS c FROM ${qi(t.name)}`);
    if (c !== t.rows) throw new Error(`ตรวจหลังกู้คืน: ${t.name} มี ${c} แถว แต่ manifest บอก ${t.rows}`);
  }
  await client.query('COMMIT');
  console.log(`เสร็จ — ${manifest.tables.length} ตาราง ${manifest.total_rows} แถว ตรงกับ backup ทุกตาราง`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`กู้คืนไม่สำเร็จ (ย้อนกลับทั้งหมดแล้ว): ${err.code ? `${err.code} ` : ''}${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
