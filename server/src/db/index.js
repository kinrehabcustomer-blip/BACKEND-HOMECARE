import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(process.env.DB_FILE ?? join(here, '../../data/kin.db'));

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

/**
 * ออกรหัสพนักงานใหม่แบบ EMP-0001 โดยเดินตัวนับไปข้างหน้าเสมอ
 * ต้องเรียกภายใน transaction เดียวกับ INSERT employees เพื่อไม่ให้เกิดรหัสค้างเมื่อ insert ล้มเหลว
 */
export function nextEmployeeId() {
  db.prepare(
    `INSERT INTO id_counters (name, value) VALUES ('employee', 1)
     ON CONFLICT (name) DO UPDATE SET value = value + 1`,
  ).run();

  const { value } = db.prepare(`SELECT value FROM id_counters WHERE name = 'employee'`).get();
  return `EMP-${String(value).padStart(4, '0')}`;
}

/** ครอบ callback ด้วย transaction เดียว (node:sqlite ยังไม่มี helper ให้) */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
