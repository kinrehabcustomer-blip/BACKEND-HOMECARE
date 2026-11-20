/**
 * สำรองข้อมูลทั้งฐาน (อ่านอย่างเดียว) — npm run backup:db --workspace server
 * ผู้ใช้ขอ 19 พ.ย. 2569: "ถ้าย้าย (โปรเจกต์ Neon ไปอีกบัญชี) ช่วย backup ข้อมูลไว้ก่อน"
 * กู้คืนด้วย src/db/restore.js (npm run restore:db) — ลงฐานเปล่าเท่านั้น
 *
 * ทำไมไม่ใช้ pg_dump: เครื่องนี้ไม่มี (embedded-postgres ของเทสต์มีแค่ตัวเซิร์ฟเวอร์) — สคริปต์นี้ใช้ไลบรารี pg ตัวเดียวกับแอป
 *
 * ได้อะไร: โฟลเดอร์ backups/<ชื่อฐาน>-<วันเวลาไทย>/ ที่รากโปรเจกต์ (อยู่ใน .gitignore — มีข้อมูลผู้ป่วยและรหัสผ่านที่ hash แล้ว)
 *   data/<ตาราง>.ndjson.gz  ทุกแถวของทุกตารางใน schema public — หนึ่งบรรทัดหนึ่งแถว เป็น JSON ที่ Postgres สร้างเอง (row_to_json)
 *                           ค่าทุกชนิดตรงตามฐาน: วันที่/เวลา · numeric ไม่ปัดเศษ · bytea (\x…) · jsonb · array
 *   schema-pre.sql          ก่อนโหลดข้อมูล: extension · sequence · function · ตาราง (คอลัมน์ ค่าตั้งต้น PK/UNIQUE/CHECK)
 *   schema-post.sql         หลังโหลดข้อมูล: index · foreign key · trigger · ตั้งเลขรันต่อของ sequence/identity
 *                           (แยกเพราะ FK/trigger ที่ใส่ก่อนจะตีกลับแถวที่โหลดผิดลำดับ — เช่นหมวดย่อยมาก่อนหมวดหลัก)
 *   manifest.json           จำนวนแถว · คอลัมน์ · sha256 ของทุกไฟล์ · เวอร์ชันเซิร์ฟเวอร์ · เวลา snapshot
 *
 * โครงสร้างอ่านจาก catalog ของฐานจริง ไม่ใช่จาก db/schema.sql — รวมตารางที่แอปสร้างเองตอนรัน (ensure*) ด้วย
 * อ่านทุกตารางใน transaction เดียวแบบ REPEATABLE READ READ ONLY — ภาพ ณ จุดเวลาเดียวกันทั้งฐาน และเขียนอะไรลงฐานไม่ได้เลย
 * นับแถวซ้ำหลังเขียนไฟล์ ไม่ตรง = ล้มทั้งชุดและลบโฟลเดอร์ทิ้ง ไม่ทิ้ง backup ที่ไม่ครบไว้ให้เข้าใจผิดว่าใช้ได้
 *
 * ฐานที่จะสำรอง: DATABASE_URL (จาก .env) · ใส่ BACKUP_DATABASE_URL เพื่อชี้ฐานอื่น · BACKUP_DIR เปลี่ยนที่เก็บ
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';

const url = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('ไม่พบ DATABASE_URL — รันด้วย npm run backup:db --workspace server (อ่าน .env ที่รากโปรเจกต์)');
  process.exit(1);
}
const local = /sslmode=disable/.test(url);
const BATCH = 1000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const outRoot = process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : join(root, 'backups');

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const stamp = () => {
  const d = new Date(Date.now() + 7 * 3600e3).toISOString(); // เวลาไทย
  return `${d.slice(0, 10).replace(/-/g, '')}-${d.slice(11, 19).replace(/:/g, '')}`;
};
const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: true } });
let dir = null;

try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [info] } = await client.query('SELECT current_database() AS db, version() AS version, now() AS at');
  dir = join(outRoot, `${info.db}-${stamp()}`);
  await mkdir(join(dir, 'data'), { recursive: true });
  console.log(`สำรองฐาน ${info.db} → ${dir}`);

  const pre = [
    `-- ส่วนก่อนโหลดข้อมูล · ฐาน ${info.db} · snapshot ${new Date(info.at).toISOString()}`,
    // function ถูกสร้างก่อนตาราง — ไม่ให้ตรวจตัวเนื้อ (อ้างชื่อตาราง/คอลัมน์ที่ยังไม่เกิด) ตอนสร้าง
    'SET LOCAL check_function_bodies = false;',
    '',
  ];
  const post = [`-- ส่วนหลังโหลดข้อมูล · ฐาน ${info.db}`, ''];

  // ---------- extension (นอกจาก plpgsql ที่มีมากับทุกฐาน) ----------
  const { rows: exts } = await client.query(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1`);
  for (const e of exts) pre.push(`CREATE EXTENSION IF NOT EXISTS ${qi(e.extname)};`);

  // ---------- sequence อิสระ (SERIAL ฯลฯ) — sequence ของ identity สร้างมากับคอลัมน์เอง ข้าม ----------
  const { rows: seqs } = await client.query(
    `SELECT c.relname AS name, s.seqincrement AS inc, s.seqstart AS start, s.seqmin AS min, s.seqmax AS max, s.seqcycle AS cycle
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_sequence s ON s.seqrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'S'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i')
      ORDER BY 1`,
  );
  for (const s of seqs) {
    pre.push(`CREATE SEQUENCE ${qi(s.name)} INCREMENT ${s.inc} MINVALUE ${s.min} MAXVALUE ${s.max} START ${s.start}${s.cycle ? ' CYCLE' : ''};`);
    // เลขล่าสุดอ่านจากตัว sequence เอง (pg_sequences ไม่มี is_called)
    const { rows: [cur] } = await client.query(`SELECT last_value, is_called FROM ${qi(s.name)}`);
    post.push(`SELECT setval(${lit(qi(s.name))}, ${cur.last_value}, ${cur.is_called});`);
  }

  // ---------- function ที่ผู้ใช้สร้าง (ตัว guard ของ audit_logs / categories) ----------
  const { rows: fns } = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY p.proname`,
  );
  for (const f of fns) pre.push(`${f.def};`);
  pre.push('');

  const { rows: tables } = await client.query(
    `SELECT c.relname AS name, c.oid
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
  );

  const manifest = {
    database: info.db, server_version: info.version, snapshot_at: info.at,
    created_by: 'server/src/db/backup.js', restore_with: 'server/src/db/restore.js', tables: [],
  };

  for (const t of tables) {
    // ---------- โครงสร้างของตาราง ----------
    const { rows: cols } = await client.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity AS identity, a.attgenerated AS generated
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [t.oid],
    );
    const { rows: cons } = await client.query(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1 ORDER BY contype DESC, conname`,
      [t.oid],
    );
    const { rows: idx } = await client.query(
      `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
        WHERE i.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
        ORDER BY 1`,
      [t.oid],
    );
    const { rows: trg } = await client.query(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname`,
      [t.oid],
    );

    const lines = cols.map((c) => {
      let line = `  ${qi(c.name)} ${c.type}`;
      if (c.identity === 'a') line += ' GENERATED ALWAYS AS IDENTITY';
      else if (c.identity === 'd') line += ' GENERATED BY DEFAULT AS IDENTITY';
      else if (c.generated === 's') line += ` GENERATED ALWAYS AS (${c.default_expr}) STORED`;
      else if (c.default_expr) line += ` DEFAULT ${c.default_expr}`;
      if (c.not_null) line += ' NOT NULL';
      return line;
    });
    // PK / UNIQUE / CHECK / EXCLUDE อยู่ในตาราง · FK ไปส่วนหลังโหลดข้อมูล
    for (const c of cons.filter((x) => x.contype !== 'f')) lines.push(`  CONSTRAINT ${qi(c.conname)} ${c.def}`);
    pre.push(`CREATE TABLE ${qi(t.name)} (\n${lines.join(',\n')}\n);`, '');

    for (const i of idx) post.push(`${i.def};`);
    for (const c of cons.filter((x) => x.contype === 'f')) post.push(`ALTER TABLE ${qi(t.name)} ADD CONSTRAINT ${qi(c.conname)} ${c.def};`);
    for (const g of trg) post.push(`${g.def};`);
    // identity: เลขรันต่อจากค่าสูงสุดที่มี (ไม่งั้นแถวใหม่หลังกู้คืนชนเลขเดิม)
    for (const c of cols.filter((x) => x.identity)) {
      post.push(`SELECT setval(pg_get_serial_sequence(${lit(qi(t.name))}, ${lit(c.name)}), COALESCE((SELECT max(${qi(c.name)}) FROM ${qi(t.name)}), 0) + 1, false);`);
    }

    // ---------- ข้อมูล ----------
    const file = `data/${t.name}.ndjson.gz`;
    const gzip = createGzip({ level: 6 });
    const out = createWriteStream(join(dir, file));
    gzip.pipe(out);
    const cursor = `bk_${t.oid}`;
    await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT row_to_json(x)::text AS j FROM ${qi(t.name)} x`);
    let written = 0;
    for (;;) {
      const { rows } = await client.query(`FETCH ${BATCH} FROM ${cursor}`);
      if (rows.length === 0) break;
      for (const r of rows) {
        if (!gzip.write(`${r.j}\n`)) await once(gzip, 'drain');
      }
      written += rows.length;
    }
    await client.query(`CLOSE ${cursor}`);
    gzip.end();
    await once(out, 'finish');

    // นับซ้ำใน snapshot เดียวกัน — ต้องเท่ากับที่เขียนออกไป
    const { rows: [{ n }] } = await client.query(`SELECT count(*)::bigint AS n FROM ${qi(t.name)}`);
    if (Number(n) !== written) throw new Error(`ตาราง ${t.name}: เขียน ${written} แถว แต่ในฐานมี ${n} แถว`);
    manifest.tables.push({
      name: t.name, rows: written, file, sha256: await sha(join(dir, file)),
      columns: cols.map((c) => ({ name: c.name, type: c.type, generated: c.generated === 's' })),
    });
    console.log(`  ${t.name.padEnd(32)} ${String(written).padStart(8)} แถว`);
  }

  await client.query('COMMIT');
  await writeFile(join(dir, 'schema-pre.sql'), pre.join('\n'), 'utf8');
  await writeFile(join(dir, 'schema-post.sql'), post.join('\n'), 'utf8');
  manifest.schema = {
    pre: { file: 'schema-pre.sql', sha256: await sha(join(dir, 'schema-pre.sql')) },
    post: { file: 'schema-post.sql', sha256: await sha(join(dir, 'schema-post.sql')) },
  };
  manifest.total_rows = manifest.tables.reduce((s, t) => s + t.rows, 0);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`เสร็จ — ${manifest.tables.length} ตาราง ${manifest.total_rows} แถว · ${dir}`);
} catch (err) {
  console.error(`สำรองไม่สำเร็จ: ${err.code ? `${err.code} ` : ''}${err.message}`);
  // ไม่ทิ้งโฟลเดอร์ที่ไม่ครบไว้ — กันเข้าใจผิดว่าเป็น backup ที่ใช้ได้
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
