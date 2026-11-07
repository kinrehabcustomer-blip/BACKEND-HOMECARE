import { sql } from '../db/index.js';

/**
 * เพดานการเรียกแบบ "นับรวมทั้งระบบ" (Codex ข้อ 11 · 8 พ.ย. 2569)
 *
 * ของเดิมเพดานของหน้าบิลสาธารณะเก็บใน Map ของโปรเซส ซึ่งบน Vercel แปลว่า:
 *   · ทุก instance มีตัวนับของตัวเอง — ยิงหลายเส้นพร้อมกันได้เพดาน × จำนวน instance
 *   · cold start แล้วตัวนับเริ่มใหม่หมด
 *   · Map โตเกินก็ clear() ทิ้งทั้งก้อน = ล้างเพดานของทุกคนพร้อมกัน
 * ย้ายมาเก็บในฐานข้อมูลที่ทุก instance เห็นชุดเดียวกัน
 *
 * 🔴 ฐานล่ม = ปล่อยผ่าน (fail-open) โดยตั้งใจ — ตัวนี้เป็นเพดานกันยิงถี่ ไม่ใช่ด่านสิทธิ์
 *    ด่านจริงคือ token ในลิงก์ซึ่งตรวจแยกอยู่แล้ว · ปิดทางเพราะฐานสะดุด = ลูกค้าเปิดบิลไม่ได้
 */

let ready = null;
const ensureTable = () =>
  (ready ??= sql
    .run(
      `CREATE TABLE IF NOT EXISTS public_rate_limits (
         bucket       TEXT PRIMARY KEY,
         window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
         hits         INTEGER NOT NULL DEFAULT 0
       )`,
    )
    .catch((err) => { ready = null; throw err; }));

/* กวาดแถวเก่าเป็นครั้งคราว ไม่ใช่ทุกคำขอ — ตารางนี้ถูกแตะบ่อยกว่าที่มันโตขึ้นมาก */
let lastSweep = 0;
async function sweep() {
  if (Date.now() - lastSweep < 3600_000) return;
  lastSweep = Date.now();
  await sql
    .run(`DELETE FROM public_rate_limits WHERE window_start < now() - interval '2 days'`)
    .catch(() => {});
}

/**
 * นับหนึ่งครั้งแล้วบอกว่ายังอยู่ในเพดานไหม
 * @param {string} bucket   คีย์ของเพดานนั้น (เช่น `bill:<ip>` หรือ `slip:<tokenHash>:<วันที่>`)
 * @param {{limit:number, windowSec:number}} opt
 * @returns {Promise<{ok:boolean, hits:number}>}
 */
export async function hitLimit(bucket, { limit, windowSec }) {
  try {
    await ensureTable();
    const row = await sql.one(
      `INSERT INTO public_rate_limits (bucket, window_start, hits)
            VALUES (:bucket, now(), 1)
       ON CONFLICT (bucket) DO UPDATE
          SET hits = CASE
                       WHEN now() - public_rate_limits.window_start >= make_interval(secs => :win)
                       THEN 1 ELSE public_rate_limits.hits + 1
                     END,
              window_start = CASE
                       WHEN now() - public_rate_limits.window_start >= make_interval(secs => :win)
                       THEN now() ELSE public_rate_limits.window_start
                     END
       RETURNING hits`,
      { bucket: String(bucket).slice(0, 200), win: windowSec },
    );
    sweep();
    const hits = Number(row?.hits ?? 0);
    return { ok: hits <= limit, hits };
  } catch (err) {
    console.error(`[rateLimit] นับไม่ได้ ปล่อยผ่าน (${bucket.slice(0, 40)}): ${err.message}`);
    return { ok: true, hits: 0 };
  }
}
