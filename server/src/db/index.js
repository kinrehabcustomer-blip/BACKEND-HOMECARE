import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('ไม่พบ DATABASE_URL — รัน `vercel env pull .env` หรือใส่ connection string ของ Neon ใน .env');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // serverless function หนึ่ง instance รับทีละ request — เปิด connection ค้างไว้เยอะไม่มีประโยชน์ และ Neon นับ quota
  max: 3,
  idleTimeoutMillis: 10_000,
});

// เรียงลำดับสำคัญ: กิน string literal ('...' รวม '' ที่ escape แล้ว) และ cast (::) ทิ้งไปก่อน
// ไม่งั้น ':MI' ใน 'YYYY-MM-DD HH24:MI:SS' จะโดนนับเป็น named param
const TOKEN = /'(?:[^']|'')*'|::|:([a-z_][a-z0-9_]*)/gi;

/** แปลง :name ของ SQL เป็น $1..$n ที่ node-postgres ต้องการ (ชื่อเดียวกันใช้ $ ตัวเดิมซ้ำได้) */
function compile(text, params) {
  const values = [];
  const slots = new Map();

  const sql = text.replace(TOKEN, (match, name) => {
    if (!name) return match; // literal หรือ cast — ปล่อยผ่าน

    if (!slots.has(name)) {
      values.push(params[name] ?? null);
      slots.set(name, values.length);
    }
    return `$${slots.get(name)}`;
  });

  return { sql, values };
}

/**
 * executor สำหรับ query ทั่วไป — ใช้ connection จาก pool (auto-commit)
 * ภายใน transaction ให้ใช้ตัวที่ transaction() ส่งเข้า callback แทน มิฉะนั้นจะมองไม่เห็นแถวที่ยังไม่ commit
 */
export const sql = executorFor(pool);

function executorFor(client) {
  const exec = (text, params = {}) => {
    const { sql, values } = compile(text, params);
    return client.query(sql, values);
  };

  return {
    /** คืนทุกแถว */
    all: async (text, params) => (await exec(text, params)).rows,
    /** คืนแถวแรก หรือ null */
    one: async (text, params) => (await exec(text, params)).rows[0] ?? null,
    /** คืนจำนวนแถวที่ถูกแก้ */
    run: async (text, params) => (await exec(text, params)).rowCount,
  };
}

/** ครอบ callback ด้วย transaction เดียวบน connection เดียว */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(executorFor(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * ออกรหัสใหม่จากตัวนับที่เดินหน้าอย่างเดียว (EMP-0001, CASE-0001) — ลบแถวแล้วเลขเดิมไม่ถูกใช้ซ้ำ
 * ต้องเรียกด้วย executor ของ transaction เดียวกับ INSERT เพื่อไม่ให้เกิดรหัสค้างเมื่อ insert ล้มเหลว
 */
async function nextId(tx, counter, prefix) {
  const { value } = await tx.one(
    `INSERT INTO id_counters (name, value) VALUES (:counter, 1)
     ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1
     RETURNING value`,
    { counter },
  );

  return `${prefix}-${String(value).padStart(4, '0')}`;
}

export const nextEmployeeId = (tx) => nextId(tx, 'employee', 'EMP');
export const nextCaseId = (tx) => nextId(tx, 'case', 'CASE');
export const nextCustomerId = (tx) => nextId(tx, 'customer', 'CUS');
export const nextPatientId = (tx) => nextId(tx, 'patient', 'PAT');
