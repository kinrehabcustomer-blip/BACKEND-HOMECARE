import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('ไม่พบ DATABASE_URL — รัน `vercel env pull .env` หรือใส่ connection string ของ Neon ใน .env');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  /* ตรวจใบรับรองของฝั่งเซิร์ฟเวอร์จริง — เดิมเป็น rejectUnauthorized: false ซึ่งแปลว่า
     "เข้ารหัสก็จริง แต่ไม่สนว่าปลายทางเป็นใคร" ใครที่แทรกกลางทางได้ก็ยื่นใบรับรองปลอมแล้วอ่าน
     ทั้งรหัสผ่านที่ hash ไว้ เลขบัตรประชาชน และประวัติการรักษาได้หมด
     Neon ใช้ใบรับรองจาก CA สาธารณะ จึงผ่านการตรวจด้วยชุด CA ที่ Node มีมาให้อยู่แล้ว (ทดสอบแล้ว) */
  ssl: { rejectUnauthorized: true },
  // serverless function หนึ่ง instance รับทีละ request — เปิด connection ค้างไว้เยอะไม่มีประโยชน์ และ Neon นับ quota
  max: 3,
  idleTimeoutMillis: 10_000,
});

// เรียงลำดับสำคัญ: กินสิ่งที่ ":" ข้างในไม่ใช่พารามิเตอร์ทิ้งไปก่อน แล้วค่อยจับ :name
//   1. string literal ('...' รวม '' ที่ escape แล้ว) — ไม่งั้น ':MI' ใน 'YYYY-MM-DD HH24:MI:SS' โดนนับเป็น param
//   2. คอมเมนต์ของ SQL (-- ถึงท้ายบรรทัด และ /* ... */) — คนเขียนคอมเมนต์อธิบายโดยอ้างชื่อพารามิเตอร์
//      เป็นเรื่องปกติ ("total คิดจาก :amount - :discount") ถ้าไม่ข้าม ข้อความในคอมเมนต์จะถูกนับเป็น
//      พารามิเตอร์จริง แล้วลำดับ $n เพี้ยนทั้งคำสั่ง — เคยกัดมาแล้วครั้งหนึ่ง (ดู syncOpenFromCase)
//   3. cast (::)
const TOKEN = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|::|:([a-z_][a-z0-9_]*)/gi;

/**
 * แปลง :name ของ SQL เป็น $1..$n ที่ node-postgres ต้องการ (ชื่อเดียวกันใช้ $ ตัวเดิมซ้ำได้)
 *
 * ชื่อที่ไม่มีใน params = โยนทิ้งทันที ไม่ใช่แทนด้วย NULL เงียบๆ
 * โค้ดในโปรเจคนี้ประกอบคำสั่ง UPDATE จากชื่อคอลัมน์หลายที่ (`${c} = :${c}`) พิมพ์ชื่อผิดครั้งเดียว
 * ถ้าปล่อยเป็น NULL คือ "บันทึกสำเร็จ" แต่ข้อมูลเดิมถูกล้างทิ้ง โดยไม่มีอะไรฟ้องเลยสักอย่าง
 * ล้มตั้งแต่ตอนประกอบคำสั่งเจ็บน้อยกว่ามาก — และเจอตอนเทส ไม่ใช่ตอนข้อมูลหายไปแล้ว
 *
 * ส่งค่ามาเป็น null/undefined โดยตั้งใจยังทำได้ตามเดิม (เช็คว่า "มีคีย์ไหม" ไม่ใช่ "ค่าว่างไหม")
 */
function compile(text, params) {
  const values = [];
  const slots = new Map();

  const sql = text.replace(TOKEN, (match, name) => {
    if (!name) return match; // literal / คอมเมนต์ / cast — ปล่อยผ่าน

    if (!slots.has(name)) {
      if (!(name in params)) {
        throw new Error(`ไม่พบพารามิเตอร์ :${name} ที่คำสั่ง SQL อ้างถึง — ตรวจชื่อให้ตรงกับที่ส่งเข้ามา`);
      }
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
export const nextInvoiceId = (tx) => nextId(tx, 'invoice', 'INV');
export const nextPayrollId = (tx) => nextId(tx, 'payroll', 'PAY');
