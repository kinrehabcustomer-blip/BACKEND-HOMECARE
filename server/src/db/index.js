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
  let released = false;
  try {
    await client.query('BEGIN');
    const result = await fn(executorFor(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    /* ROLLBACK เองก็ล้มได้ (connection ขาด / เซิร์ฟเวอร์ปิดไปแล้ว) ถ้าปล่อยให้โยนออกไป
       มันจะกลบ error ตัวจริงที่ทำให้ transaction ล้ม — คนอ่าน log เห็นแต่อาการปลายทาง
       และ client ถูก release กลับ pool ทั้งที่ยังค้าง transaction อยู่ คำสั่งของคนถัดไป
       ที่หยิบ connection นี้ไปจะไหลเข้า transaction ค้างนั้นต่อ · destroy ทิ้งปลอดภัยกว่า */
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      rollbackFailed = true;
      console.error('ROLLBACK ล้มเหลว — ตัด connection ทิ้ง ไม่คืนเข้า pool:', rollbackErr.message);
    }
    if (rollbackFailed) {
      try {
        client.release(true); // true = destroy ไม่เอากลับเข้า pool
      } catch {
        /* release ซ้ำใน finally ไม่เป็นไร */
      }
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
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

/**
 * รหัสพนักงาน = A + ปี พ.ศ. 2 หลัก + ชุด 2 หลัก + เลขรัน 3 หลัก  เช่น A6901059
 * เลขรันวิ่ง 001–999 ครบแล้วขึ้นชุดถัดไป: A6901999 → A6902001 · ตัวนับเริ่มใหม่ทุกปี พ.ศ. (A7001001)
 *
 * ลำดับที่ n ของปี (เริ่ม 1) → ชุด = ⌈n/999⌉ · เลขรัน = ((n−1) mod 999) + 1
 */
export function employeeCodeFor(yy, n) {
  const series = Math.floor((n - 1) / 999) + 1;
  const num = ((n - 1) % 999) + 1;
  if (series > 99) throw new Error(`รหัสพนักงานของปี ${yy} เต็มแล้ว (99 ชุด × 999 คน)`);
  return `A${yy}${String(series).padStart(2, '0')}${String(num).padStart(3, '0')}`;
}

/** ปี พ.ศ. 2 หลักตามเวลาไทย */
const beYear2 = (now) => String((new Date(now.getTime() + 7 * 3.6e6).getUTCFullYear() + 543) % 100).padStart(2, '0');

/**
 * ออกรหัสพนักงานใหม่อัตโนมัติ — ข้ามเลขที่มีคนใช้อยู่แล้ว (เจ้าหน้าที่กรอกรหัสเองได้ ซึ่งอาจดักหน้าตัวนับไว้)
 * ตัวนับแยกรายปีใน id_counters ชื่อ 'employee:YY' · รหัสเก่าแบบ EMP-0001 คงเดิม
 */
export async function nextEmployeeId(tx, now = new Date()) {
  const yy = beYear2(now);
  for (;;) {
    const { value } = await tx.one(
      `INSERT INTO id_counters (name, value) VALUES (:counter, 1)
       ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1
       RETURNING value`,
      { counter: `employee:${yy}` },
    );
    const id = employeeCodeFor(yy, value);
    const taken = await tx.one('SELECT 1 AS taken FROM employees WHERE employee_id = :id', { id });
    if (!taken) return id;
  }
}
/**
 * เลข VN (visit number) = VN + ปี พ.ศ. 2 หลัก + เลขรัน 7 หลัก  เช่น VN690000001
 * ออกให้ "ครั้งที่ให้บริการ" หนึ่งครั้ง (ดู cases/visitNumbers.js) — ตัวนับแยกรายปีใน id_counters ชื่อ 'vn:YY'
 * ข้ามเลขที่ถูกใช้เป็นรหัสเคสอยู่แล้ว (เคสเก่าที่เคยกรอก VN เป็นรหัสเคสเอง) จะได้ไม่มีเลขเดียวกันสองความหมาย
 */
export async function nextVisitNumber(tx, now = new Date()) {
  const yy = beYear2(now);
  for (;;) {
    const { value } = await tx.one(
      `INSERT INTO id_counters (name, value) VALUES (:counter, 1)
       ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1
       RETURNING value`,
      { counter: `vn:${yy}` },
    );
    if (value > 9_999_999) throw new Error(`เลข VN ของปี ${yy} เต็มแล้ว`);
    const vn = `VN${yy}${String(value).padStart(7, '0')}`;
    // เช็ค vn ที่ออกไปแล้วด้วย กันตัวนับถอยหลัง (restore/reset) แล้วชน unique index (ตรวจ Codex 30 ต.ค. 2569 ข้อ 22)
    const taken = await tx.one(
      `SELECT 1 AS taken WHERE EXISTS (SELECT 1 FROM cases WHERE case_id = :vn OR vn = :vn)
                            OR EXISTS (SELECT 1 FROM case_visits WHERE vn = :vn)`,
      { vn },
    );
    if (!taken) return vn;
  }
}
export const nextCaseId = (tx) => nextId(tx, 'case', 'CASE');
export const nextCustomerId = (tx) => nextId(tx, 'customer', 'CUS');
export const nextPatientId = (tx) => nextId(tx, 'patient', 'PAT');
/**
 * เลขที่ใบแจ้งหนี้ = HC-IV + ปี พ.ศ. 2 หลัก + เดือน 2 หลัก + วัน 2 หลัก + ลำดับใบของวันนั้น 4 หลัก
 * เช่น HC-IV6909010001 = ใบแรกของวันที่ 1 ก.ย. 2569 · ใบที่สองของวันเดียวกัน = HC-IV6909010002
 *
 * วันที่ตามเวลาไทย (ไม่ใช่ UTC — ออกใบตอนตีสองต้องได้เลขของวันนั้น ไม่ใช่เมื่อวาน)
 * ตัวนับแยกรายวันใน id_counters ชื่อ 'invoice:YYMMDD' — upsert แถวเดียวจึงไม่มีเลขซ้ำแม้ออกพร้อมกัน
 * ใบเก่าแบบ INV-0001 คงเลขเดิม (ส่งให้ลูกค้าไปแล้ว) ตัวนับ 'invoice' เดิมไม่ถูกใช้อีก
 */
export function invoiceDayCode(now = new Date()) {
  const th = new Date(now.getTime() + 7 * 3.6e6);
  const yy = String((th.getUTCFullYear() + 543) % 100).padStart(2, '0');
  const mm = String(th.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(th.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export async function nextInvoiceId(tx, now = new Date()) {
  const day = invoiceDayCode(now);
  const { value } = await tx.one(
    `INSERT INTO id_counters (name, value) VALUES (:counter, 1)
     ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1
     RETURNING value`,
    { counter: `invoice:${day}` },
  );
  return `HC-IV${day}${String(value).padStart(4, '0')}`;
}
export const nextPayrollId = (tx) => nextId(tx, 'payroll', 'PAY');
