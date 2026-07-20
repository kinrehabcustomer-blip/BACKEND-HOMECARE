import '../lib/env.js';
import { pool, sql, transaction } from './index.js';

// seed ตารางเรทตามรูปตัวอย่าง — ทำงานเฉพาะตอนยังไม่มีเกรดในระบบ (กันเขียนทับของที่แก้ไปแล้ว)
const { n } = await sql.one('SELECT COUNT(*) AS n FROM pkg_grades');
if (Number(n) > 0) {
  console.log(`มีเกรดอยู่แล้ว ${n} รายการ — ข้ามการ seed (ต้องการ seed ใหม่ให้ลบข้อมูลในตาราง pkg_* ก่อน)`);
  await pool.end();
  process.exit(0);
}

const GRADES = [
  { key: 'g1', name: 'เกรด 1', description: 'ดูแลผู้สูงอายุทั่วไปที่ช่วยเหลือตัวเองได้บ้าง ประคองเดิน เตรียมอาหาร ยาพื้นฐาน พยุงเข้าห้องน้ำ', sort_order: 1 },
  { key: 'g2', name: 'เกรด 2', description: 'ดูแลเคสที่ให้อาหารทางสายยาง (NG Tube), ดูดเสมหะ (Suction)', sort_order: 2 },
  { key: 'g3', name: 'เกรด 3', description: 'ดูแลผู้ป่วยติดเตียง (Bedridden) ทำแผลกดทับเบื้องต้น ดูแลเคสใช้อุปกรณ์การแพทย์', sort_order: 3 },
];

const FORMATS = [
  { key: 'd12', name: 'รายวัน 12 ชม.', category: 'daily', graded: false, sort_order: 1 },
  { key: 'd24', name: 'รายวัน 24 ชม.', category: 'daily', graded: false, sort_order: 2 },
  { key: 'w12', name: 'รายสัปดาห์ 12 ชม.', category: 'weekly', graded: false, sort_order: 3 },
  { key: 'w24', name: 'รายสัปดาห์ 24 ชม.', category: 'weekly', graded: false, sort_order: 4 },
  { key: 'm12off', name: 'รายเดือน 12 ชม. หยุด 4 วัน', category: 'monthly', graded: true, sort_order: 5 },
  { key: 'm12no', name: 'รายเดือน 12 ชม. ไม่มีวันหยุด', category: 'monthly', graded: true, sort_order: 6 },
  { key: 'm24off', name: 'รายเดือน 24 ชม. หยุด 4 วัน', category: 'monthly', graded: true, sort_order: 7 },
  { key: 'm24no', name: 'รายเดือน 24 ชม. ไม่มีวันหยุด', category: 'monthly', graded: true, sort_order: 8 },
];

// ค่าใน [ค่าบริการ, ค่าตอบแทน] · false = ช่องเทา (ให้บริการไม่ได้) · null = เปิดให้บริการแต่ยังไม่ได้ตั้งราคา
// เรทรายวัน/สัปดาห์ (grade = null) ใช้ร่วมทุกเกรด
const SHARED = {
  d12: { CG: [1500, 700], NA: [1800, 900], PN: [2000, 1000] },
  d24: { CG: [2000, 1000], NA: [2500, 1200], PN: [3000, 1500] },
  w12: { CG: [10000, 5500], NA: [12000, 7000], PN: [13000, 7500] },
  w24: { CG: [14000, 8000], NA: [16000, 9000], PN: [18000, 10000] },
};

const GRADED = {
  g1: {
    m12off: { CG: [28000, 18000], NA: [30000, 20000], PN: [33000, 22000] },
    m12no: { CG: [32000, 21000], NA: [36000, 24000], PN: [39000, 26000] },
    m24off: { CG: [32000, 20000], NA: [36000, 24000], PN: [39000, 26000] },
    m24no: { CG: [36000, 24000], NA: [41000, 28000], PN: [45000, 30000] },
  },
  g2: {
    // CG ทำเคสเกรด 2 ไม่ได้ (NG tube/ดูดเสมหะ) — ช่องเทา
    m12off: { CG: false, NA: [35000, 23000], PN: [38000, 25000] },
    m12no: { CG: false, NA: [40000, 27000], PN: [43000, 29000] },
    m24off: { CG: false, NA: [40000, 26000], PN: [43000, 28000] },
    m24no: { CG: false, NA: [45000, 30000], PN: [48000, 32000] },
  },
  g3: {
    // เกรด 3 (ติดเตียง): CG ทำไม่ได้ (ช่องเทา) · NA/PN ราคาตามตารางเรท
    m12off: { CG: false, NA: [40000, 26000], PN: [43000, 28000] },
    m12no: { CG: false, NA: [45000, 30000], PN: [48000, 32000] },
    m24off: { CG: false, NA: [45000, 29000], PN: [48000, 31000] },
    m24no: { CG: false, NA: [50000, 33000], PN: [53000, 35000] },
  },
};

const TIERS = ['CG', 'NA', 'PN'];

function rateRow(formatId, gradeId, tier, val) {
  if (val === false) return { formatId, gradeId, tier, price: null, pay: null, available: false };
  if (val == null) return { formatId, gradeId, tier, price: null, pay: null, available: true };
  return { formatId, gradeId, tier, price: val[0], pay: val[1], available: true };
}

await transaction(async (tx) => {
  const gradeId = {};
  for (const g of GRADES) {
    const row = await tx.one(
      'INSERT INTO pkg_grades (name, description, sort_order) VALUES (:name, :description, :sort_order) RETURNING grade_id',
      g,
    );
    gradeId[g.key] = row.grade_id;
  }

  const formatId = {};
  for (const f of FORMATS) {
    const row = await tx.one(
      'INSERT INTO pkg_service_formats (name, category, graded, sort_order) VALUES (:name, :category, :graded, :sort_order) RETURNING format_id',
      f,
    );
    formatId[f.key] = row.format_id;
  }

  const rows = [];
  // เรทรวม (รายวัน/สัปดาห์) — grade = null
  for (const [fkey, tiers] of Object.entries(SHARED)) {
    for (const tier of TIERS) rows.push(rateRow(formatId[fkey], null, tier, tiers[tier]));
  }
  // เรทตามเกรด (รายเดือน)
  for (const [gkey, formats] of Object.entries(GRADED)) {
    for (const [fkey, tiers] of Object.entries(formats)) {
      for (const tier of TIERS) rows.push(rateRow(formatId[fkey], gradeId[gkey], tier, tiers[tier]));
    }
  }

  for (const r of rows) {
    await tx.one(
      `INSERT INTO pkg_rates (format_id, grade_id, staff_tier, customer_price, staff_pay, available)
       VALUES (:format_id, :grade_id, :staff_tier, :customer_price, :staff_pay, :available) RETURNING rate_id`,
      {
        format_id: r.formatId,
        grade_id: r.gradeId,
        staff_tier: r.tier,
        customer_price: r.price,
        staff_pay: r.pay,
        available: r.available,
      },
    );
  }

  console.log(`seed สำเร็จ: ${GRADES.length} เกรด, ${FORMATS.length} รูปแบบ, ${rows.length} ช่องราคา`);
});

await pool.end();
