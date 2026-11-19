import { pool, sql, transaction } from '../db/index.js';
import { ApiError } from '../lib/errors.js';

/**
 * หมวดหมู่ (category / sub category) — ตารางเดียวใช้ร่วมทุกส่วน แยกด้วย domain (ผู้ใช้ขอ 16 พ.ย. 2569 · เฟสแรก)
 *
 *   หมวดหลัก (parent_id ว่าง) → หมวดย่อย (parent_id = หมวดหลัก) · ลึกได้ 2 ชั้นเท่านั้น (trigger ในฐานกันไว้)
 *   รหัส (code): <โดเมน 3 ตัว>-<หมวดหลัก 3 ตัว>[-<หมวดย่อย 2 หลัก>] เช่น RCS-CUS-02 · ตั้งแล้วเปลี่ยนไม่ได้
 *   ไม่มีการลบ — เลิกใช้ = ปิด (active = false) รายงานย้อนหลังยังมีชื่อหมวดให้อ่าน
 *
 * แคตตาล็อกสินค้า/บริการ (19 พ.ย. 2569) — หัตถการ + อุปกรณ์เสริม
 *   meta.items บอกว่ารายการในหมวดย่อยคืออะไร — เพิ่มหมวดหลัก/ย่อยเองได้ แล้วจัดรายการเข้าหมวดย่อย (setItems)
 *     procedure = รหัส PRxxxx (client/src/lib/procedureCatalog.js) · free = ชื่ออุปกรณ์ที่พิมพ์เอง (ไม่มีตารางสินค้า)
 *   หมวดของแพ็กเกจ Homecare/กายภาพ เคยอยู่ที่นี่ด้วย — เอาออกแล้ว (ผู้ใช้ให้รวมเหลือที่เดียว 19 พ.ย. 2569):
 *   แพ็กจัดการที่หน้าแพ็คเกจที่เดียว · รูปแบบบริการ Homecare มีประเภท รายวัน/สัปดาห์/เดือน ของตัวเองอยู่แล้ว
 *   หนึ่งรายการอยู่ได้หมวดย่อยเดียวต่อโดเมน — ย้ายเข้าหมวดใหม่ = ถูกถอดจากหมวดเดิมให้เอง
 *
 * สองแบบของโดเมน
 *   · เหตุผล (cancel_*): หมวดย่อยคือตัวเหตุผลเอง — เพิ่ม/แก้/ปิดได้จากหน้าจัดการหมวด แล้วโผล่ในช่องเลือกเหตุผลทันที
 *   · แคตตาล็อก (ด้านบน): หมวดย่อยถือรายชื่อรหัสของรายการไว้ (item_keys) — เพิ่มหมวด/จัดรายการเองได้
 *   · รายการที่กำหนดในระบบ (incident): ตัวรายการ (fall) อยู่ในโค้ด หมวดย่อยถือรายชื่อรหัสไว้ (item_keys)
 *     แก้ชื่อ/ลำดับ/เปิดปิดได้ แต่เพิ่มหมวดใหม่ไม่ได้ (หมวดเปล่าที่ไม่มีรายการไม่มีประโยชน์)
 *
 * เหตุผลยกเลิกเก็บเป็น cancel_reason_id ของเคส/กะ/ใบแจ้งหนี้ (ไว้ทำรายงาน) และชื่อเหตุผลถูกเขียนนำหน้าข้อความ
 * cancel_reason เดิม — หน้าจอ/ข้อความ LINE ที่แสดง cancel_reason อยู่แล้วจึงเห็นชื่อเหตุผลโดยไม่ต้องแก้ตาม
 */

/* settings: true = หมวดของระบบ (เหตุผลยกเลิก · เหตุการณ์ผิดปกติ) — จัดการได้ในหน้าตั้งค่า เฉพาะ Super Admin + ผู้จัดการ
   (ผู้ใช้ขอ 19 พ.ย. 2569 · ตายตัว ไม่ขึ้นกับสิทธิ์ categories) · ที่เหลือ = แคตตาล็อกในเมนู "หมวดหมู่" (สิทธิ์ categories) */
export const CATEGORY_DOMAINS = {
  cancel_case: { prefix: 'RCS', label: 'เหตุผลยกเลิกเคส', editable: true, settings: true },
  cancel_visit: { prefix: 'RVS', label: 'เหตุผลยกเลิกนัด / กะ', editable: true, settings: true },
  cancel_invoice: { prefix: 'RIV', label: 'เหตุผลยกเลิกใบแจ้งหนี้', editable: true, settings: true },
  procedure: { prefix: 'PRC', label: 'หมวดหัตถการ', editable: true, items: 'procedure', itemLabel: 'หัตถการ' },
  equipment: { prefix: 'EQP', label: 'หมวดอุปกรณ์เสริม', editable: true, items: 'free', itemLabel: 'อุปกรณ์' },
  incident: { prefix: 'INC', label: 'หมวดเหตุการณ์ผิดปกติ (รายงานการดูแล)', editable: false, settings: true, itemLabel: 'เหตุการณ์' },
};
export const DOMAIN_KEYS = Object.keys(CATEGORY_DOMAINS);

/* ---------- หมวดตั้งต้น ----------
 * [รหัสหมวดหลัก, ชื่อ, [[ชื่อหมวดย่อย, รายการ?], …]] — หมวดย่อยได้เลข 01, 02, … ตามลำดับ
 * ใส่ครั้งเดียวตอนยังไม่มีรหัสนั้น (ON CONFLICT DO NOTHING) — ชื่อที่ผู้ใช้แก้แล้วไม่ถูกทับตอน migrate รอบหลัง */
const SEED = {
  cancel_case: [
    ['CUS', 'ฝั่งลูกค้า / ผู้รับบริการ', [
      ['ลูกค้าเปลี่ยนใจ / ไม่ต้องการบริการแล้ว'], ['ผู้รับบริการเข้าโรงพยาบาล'], ['ผู้รับบริการเสียชีวิต'],
      ['ย้ายไปใช้ผู้ให้บริการอื่น'], ['ราคา / งบประมาณ'], ['ญาติดูแลเอง'],
    ]],
    ['COM', 'ฝั่งบริษัท', [['หาพนักงานไม่ได้'], ['อยู่นอกพื้นที่ให้บริการ'], ['เปิดเคสผิด / ซ้ำ']]],
    ['STF', 'ฝั่งพนักงาน', [['พนักงานลาออก / ไม่มาทำงาน'], ['ลูกค้าขอเปลี่ยนพนักงาน หาคนแทนไม่ได้']]],
    ['OTH', 'อื่น ๆ', [['อื่น ๆ (ระบุในรายละเอียด)']]],
  ],
  cancel_visit: [
    ['CUS', 'ฝั่งลูกค้า / ผู้รับบริการ', [
      ['ผู้รับบริการไม่สบาย / เข้าโรงพยาบาล'], ['ลูกค้าขอเลื่อน / งดนัด'], ['ไม่มีคนอยู่บ้าน / เข้าบ้านไม่ได้'],
    ]],
    ['STF', 'ฝั่งพนักงาน', [['พนักงานป่วย / ลา'], ['พนักงานไม่มาโดยไม่แจ้ง']]],
    ['COM', 'ฝั่งบริษัท', [['ลงนัดผิด / ซ้ำ'], ['ปรับแผนการดูแล']]],
    ['FRC', 'เหตุสุดวิสัย', [['ภัยธรรมชาติ / การเดินทาง']]],
    ['OTH', 'อื่น ๆ', [['อื่น ๆ (ระบุในรายละเอียด)']]],
  ],
  cancel_invoice: [
    ['ERR', 'ออกใบผิด', [['ยอด / รายการผิด'], ['ชื่อ / ที่อยู่ผู้ชำระผิด'], ['ออกใบซ้ำ']]],
    ['CUS', 'ฝั่งลูกค้า', [['ลูกค้ายกเลิกบริการ'], ['เปลี่ยนแพ็คเกจ / รูปแบบบริการ']]],
    ['OTH', 'อื่น ๆ', [['อื่น ๆ (ระบุในรายละเอียด)']]],
  ],
  // รายการ = รหัสใน client/src/lib/procedureCatalog.js
  procedure: [
    ['RES', 'ทางเดินหายใจ', [['ดูดเสมหะ', ['PR0003']], ['ออกซิเจน / พ่นยา', ['PR0007', 'PR0021', 'PR0029']]]],
    ['FED', 'การให้อาหารทางสาย', [['ให้อาหาร / นมทางสาย', ['PR0001', 'PR0002']], ['ใส่สายให้อาหาร', ['PR0014', 'PR0015', 'PR0016']]]],
    ['WND', 'แผล', [['ทำแผลทั่วไป', ['PR0008', 'PR0009', 'PR0010']], ['แผลเจาะคอ / หน้าท้อง', ['PR0004', 'PR0005', 'PR0006']]]],
    ['URO', 'ทางเดินปัสสาวะ', [['สวนปัสสาวะ', ['PR0017', 'PR0018']]]],
    ['LAB', 'ตรวจ / เจาะเลือด', [['ตรวจน้ำตาลปลายนิ้ว', ['PR0019', 'PR0020']], ['เจาะเลือด', ['PR0022']]]],
    ['CAR', 'บุคลากรดูแล / เฝ้า', [
      ['ผู้เฝ้า / นักบริบาลเฝ้าพิเศษ', ['PR0011', 'PR0023']], ['ค่าดูแลผู้ป่วยรายเดือน', ['PR0024', 'PR0025']],
      ['แพทย์ตรวจประเมิน', ['PR0028']],
    ]],
    ['REH', 'ฟื้นฟู', [['กายภาพพื้นฐาน', ['PR0026']], ['ทีมฟื้นฟูสหวิชาชีพ', ['PR0027']]]],
    ['EQP', 'อุปกรณ์', [['เตียงลม', ['PR0012', 'PR0013']]]],
  ],
  /* อุปกรณ์เสริม — รายการสินค้าที่ผู้ใช้ส่งมา 19 พ.ย. 2569 (หมวดหลักตามที่จัดมา · หมวดย่อยแบ่งตามชนิดสินค้า แก้ชื่อได้)
     รายการ = ชื่ออุปกรณ์ (free) · ราคาอยู่ใน EQUIPMENT_PRICES ข้างล่าง */
  equipment: [
    ['HCK', 'อุปกรณ์ตรวจสุขภาพ', [
      ['เครื่องตรวจ / เครื่องวัด', ['เครื่องตรวจน้ำตาลสะสม HbA1c GluCoA1c', 'เครื่องวัดน้ำตาลต่อเนื่อง CGMS CareSens Air', 'เครื่องตรวจน้ำตาล GlucoNavii GDH (พร้อมเข็มและแผ่นตรวจ)', 'เครื่องวัดความดันข้อมือ (แบรนด์เยอรมัน)', 'เครื่องวัดความดันต้นแขน Jziki ZK-B869']],
      ['แผ่นตรวจน้ำตาล', ['แผ่นตรวจน้ำตาลสะสม HbA1c แถมเข็ม', 'แผ่นตรวจน้ำตาล GlucoNavii 50 ชิ้น', 'แผ่นตรวจน้ำตาล GlucoNavii 25 ชิ้น']],
      ['ชุดตรวจ / ATK', ['ชุดตรวจมะเร็งลำไส้ Synthgene FOB', 'ชุดตรวจซิฟิลิส Synthgene', 'ชุดตรวจ H. pylori Synthgene', 'ชุดตรวจไมโครอัลบูมินในปัสสาวะ Acmex', 'ATK โควิด+ไข้หวัดใหญ่ A/B+RSV EuroGen (4in1)', 'ATK โควิด+ไข้หวัดใหญ่ A/B EuroGen (3in1)', 'ATK โควิด-19 EuroGen']],
    ]],
    ['OXY', 'ออกซิเจนและเครื่องดูดเสมหะ', [
      ['เครื่องผลิตออกซิเจน', ['เครื่องผลิตออกซิเจนพกพา CANTA HPT-10', 'CANTA V10-W-NS 10 ลิตร สีดำ', 'CANTA V8-WN-NS 8 ลิตร สีดำ', 'CANTA VH5-BNMC 5 ลิตร ระบบ VPSA สีขาว', 'CANTA VH5 5 ลิตร สีฟ้า', 'เครื่องผลิตออกซิเจน 10 ลิตร KSOC-10', 'Yuwell 9F-5BW (5 ลิตร)', 'เครื่องผลิตออกซิเจน 5 ลิตร KSW-5']],
      ['เครื่องดูดเสมหะ', ['เครื่องดูดเสมหะ Yuwell 7E-H1']],
    ]],
    ['BED', 'เตียงผู้ป่วยไฟฟ้า', [
      ['ชุดเตียง ALLWELL', ['ชุดเตียง ALLWELL Floore', 'ชุดเตียง ALLWELL Dali Low Entry', 'ชุดเตียง ALLWELL KS-828b']],
      ['เตียงไฟฟ้า', ['เตียงไฟฟ้า 5 ไกร์ FB-308', 'เตียงไฟฟ้า 3 ไกร์ FB-214']],
    ]],
    ['WCH', 'รถเข็นและวีลแชร์ไฟฟ้า', [
      ['วีลแชร์ไฟฟ้า', ['วีลแชร์ไฟฟ้า ROBUST CONCISE', 'วีลแชร์ไฟฟ้า ROVED Feather', 'วีลแชร์ไฟฟ้า ROVED Standard Rotate']],
      ['รถเข็น', ['รถเข็นพับได้ ALLWELL (4 รุ่น)', 'รถเข็น MATSUNAGA AR-200 / Elevating']],
    ]],
    ['MOB', 'อุปกรณ์ช่วยเดินและเคลื่อนย้าย', [
      ['เก้าอี้เคลื่อนย้าย', ['เก้าอี้เคลื่อนย้ายขึ้นบันได FSC-001', 'เก้าอี้เคลื่อนย้ายและนั่งถ่าย FAL-128']],
      ['อุปกรณ์ช่วยเดิน', ['รถเข็นช่วยเดินพับได้ พร้อมที่นั่งพัก']],
    ]],
    ['MAT', 'ที่นอนและอุปกรณ์ข้างเตียง', [
      ['ที่นอน', ['ที่นอนโฟม DHG Dyna-Form Mercury 15']],
      ['อุปกรณ์ข้างเตียง', ['โต๊ะคร่อมเตียง Overbed']],
    ]],
  ],
  // รายการ = ค่าใน INCIDENT_TYPES / PHYSIO_INCIDENT_TYPES (client/src/lib/dailyCare.js · คอลัมน์ case_reports.incident_types)
  incident: [
    ['SAF', 'ความปลอดภัย / อุบัติเหตุ', [['ล้ม / เกือบล้ม', ['fall']], ['บาดเจ็บระหว่างทำ', ['injury']], ['ความผิดพลาดเรื่องยา', ['med_error']]]],
    ['RES', 'ระบบหายใจ', [['หายใจลำบาก / เหนื่อย', ['breathing', 'dyspnea']], ['ออกซิเจนต่ำ', ['spo2']], ['เสมหะผิดปกติ', ['sputum']]]],
    ['CVS', 'หัวใจและการไหลเวียน', [
      ['ความดันผิดปกติ', ['bp_abnormal']], ['ชีพจรผิดปกติ', ['pulse_abnormal']], ['เจ็บแน่นหน้าอก', ['chest_pain']],
      ['เวียนศีรษะ / หน้ามืด', ['dizzy']],
    ]],
    ['NEU', 'ระบบประสาท', [['ความรู้สึกตัวเปลี่ยน', ['consciousness']], ['ชัก', ['seizure']], ['เกร็งผิดปกติ', ['spasticity']]]],
    ['GEN', 'อาการทั่วไป', [['ไข้', ['fever']], ['อาเจียน', ['vomiting']], ['ปัสสาวะลดลง', ['urine']], ['ปวดเพิ่มขึ้น', ['pain_up']]]],
    ['SKN', 'ผิวหนัง / แผล / เลือด', [['แผล / รอยแดงใหม่', ['wound', 'skin']], ['เลือดออก', ['bleeding']]]],
    ['DEV', 'สายและอุปกรณ์', [['สายทางการแพทย์มีปัญหา', ['tube']], ['อุปกรณ์ขัดข้อง', ['equipment']]]],
    ['OTH', 'อื่น ๆ', [['ปฏิเสธการรักษา / หยุดกลางคัน', ['refuse']], ['อื่น ๆ', ['other']]]],
  ],
};

/* ราคาตั้งต้นของอุปกรณ์เสริม (catalog_prices) — ผู้ใช้ส่งมา 19 พ.ย. 2569 · ใส่ครั้งเดียว (ON CONFLICT DO NOTHING) ราคาที่แก้แล้วไม่ถูกทับ
   หมวดอุปกรณ์ตรวจสุขภาพ = ราคาขาย · หมวดอื่น = ค่าเช่า (ผู้ใช้ยืนยัน) · [ชื่อ, ช่องราคา, ราคา] */
const EQUIPMENT_PRICES = [
  ['เครื่องตรวจน้ำตาลสะสม HbA1c GluCoA1c', 'price_sale', 15000],
  ['เครื่องวัดน้ำตาลต่อเนื่อง CGMS CareSens Air', 'price_sale', 1800],
  ['เครื่องตรวจน้ำตาล GlucoNavii GDH (พร้อมเข็มและแผ่นตรวจ)', 'price_sale', 1500],
  ['เครื่องวัดความดันข้อมือ (แบรนด์เยอรมัน)', 'price_sale', 1500],
  ['เครื่องวัดความดันต้นแขน Jziki ZK-B869', 'price_sale', 1000],
  ['แผ่นตรวจน้ำตาลสะสม HbA1c แถมเข็ม', 'price_sale', 1440],
  ['แผ่นตรวจน้ำตาล GlucoNavii 50 ชิ้น', 'price_sale', 600],
  ['แผ่นตรวจน้ำตาล GlucoNavii 25 ชิ้น', 'price_sale', 300],
  ['ชุดตรวจมะเร็งลำไส้ Synthgene FOB', 'price_sale', 160],
  ['ชุดตรวจซิฟิลิส Synthgene', 'price_sale', 160],
  ['ชุดตรวจ H. pylori Synthgene', 'price_sale', 160],
  ['ชุดตรวจไมโครอัลบูมินในปัสสาวะ Acmex', 'price_sale', 160],
  ['ATK โควิด+ไข้หวัดใหญ่ A/B+RSV EuroGen (4in1)', 'price_sale', 50],
  ['ATK โควิด+ไข้หวัดใหญ่ A/B EuroGen (3in1)', 'price_sale', 40],
  ['ATK โควิด-19 EuroGen', 'price_sale', 30],
  ['เครื่องผลิตออกซิเจนพกพา CANTA HPT-10', 'price_rent', 35000],
  ['CANTA V10-W-NS 10 ลิตร สีดำ', 'price_rent', 32000],
  ['CANTA V8-WN-NS 8 ลิตร สีดำ', 'price_rent', 28000],
  ['CANTA VH5-BNMC 5 ลิตร ระบบ VPSA สีขาว', 'price_rent', 23000],
  ['CANTA VH5 5 ลิตร สีฟ้า', 'price_rent', 19000],
  ['เครื่องผลิตออกซิเจน 10 ลิตร KSOC-10', 'price_rent', 4000],
  ['Yuwell 9F-5BW (5 ลิตร)', 'price_rent', 2500],
  ['เครื่องผลิตออกซิเจน 5 ลิตร KSW-5', 'price_rent', 2200],
  ['เครื่องดูดเสมหะ Yuwell 7E-H1', 'price_rent', 1500],
  ['ชุดเตียง ALLWELL Floore', 'price_rent', 7500],
  ['ชุดเตียง ALLWELL Dali Low Entry', 'price_rent', 4990],
  ['ชุดเตียง ALLWELL KS-828b', 'price_rent', 4500],
  ['เตียงไฟฟ้า 5 ไกร์ FB-308', 'price_rent', 900],
  ['เตียงไฟฟ้า 3 ไกร์ FB-214', 'price_rent', 820],
  ['วีลแชร์ไฟฟ้า ROBUST CONCISE', 'price_rent', 6300],
  ['วีลแชร์ไฟฟ้า ROVED Feather', 'price_rent', 4000],
  ['วีลแชร์ไฟฟ้า ROVED Standard Rotate', 'price_rent', 2600],
  ['รถเข็นพับได้ ALLWELL (4 รุ่น)', 'price_rent', 2500],
  ['รถเข็น MATSUNAGA AR-200 / Elevating', 'price_rent', 900],
  ['เก้าอี้เคลื่อนย้ายขึ้นบันได FSC-001', 'price_rent', 7500],
  ['เก้าอี้เคลื่อนย้ายและนั่งถ่าย FAL-128', 'price_rent', 3500],
  ['รถเข็นช่วยเดินพับได้ พร้อมที่นั่งพัก', 'price_rent', 2500],
  ['ที่นอนโฟม DHG Dyna-Form Mercury 15', 'price_rent', 2000],
  ['โต๊ะคร่อมเตียง Overbed', 'price_rent', 750],
];

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (items) => `ARRAY[${(items ?? []).map(lit).join(', ')}]::text[]`;

function seedSql() {
  const out = [];
  for (const [domain, mains] of Object.entries(SEED)) {
    const { prefix } = CATEGORY_DOMAINS[domain];
    mains.forEach(([cat, name, subs], i) => {
      const code = `${prefix}-${cat}`;
      out.push(`INSERT INTO categories (domain, code, name_th, sort_order) VALUES (${lit(domain)}, ${lit(code)}, ${lit(name)}, ${(i + 1) * 10})
        ON CONFLICT (code) DO NOTHING;`);
      subs.forEach(([subName, items], j) => {
        const subCode = `${code}-${String(j + 1).padStart(2, '0')}`;
        out.push(`INSERT INTO categories (domain, parent_id, code, name_th, sort_order, item_keys)
          SELECT ${lit(domain)}, category_id, ${lit(subCode)}, ${lit(subName)}, ${(j + 1) * 10}, ${arr(items)}
            FROM categories WHERE code = ${lit(code)}
          ON CONFLICT (code) DO NOTHING;`);
      });
    });
  }
  for (const [name, field, price] of EQUIPMENT_PRICES) {
    out.push(`INSERT INTO catalog_prices (domain, item_key, ${field}) VALUES ('equipment', ${lit(name)}, ${price})
      ON CONFLICT (domain, item_key) DO NOTHING;`);
  }
  return out.join('\n');
}

/* ---------- โครงสร้าง ----------
 * แหล่งเดียว (แบบเดียวกับ audit_logs) — migrate.js รันทั้งก้อนทุกครั้ง · แอปรันเองตอนยังไม่มีตาราง
 * รวมคอลัมน์ cancel_reason_id ของเคส/กะ/ใบแจ้งหนี้ไว้ที่นี่ เพราะชี้มาที่ตารางนี้ (ต้องเกิดหลังตาราง) */
export const CATEGORY_DDL = `
CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain      TEXT NOT NULL,
  parent_id   INTEGER REFERENCES categories (category_id) ON DELETE RESTRICT,
  code        TEXT NOT NULL UNIQUE,
  name_th     TEXT NOT NULL,
  name_en     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  item_keys   TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_categories_domain ON categories (domain, parent_id, sort_order);

CREATE OR REPLACE FUNCTION categories_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE p categories%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.code <> OLD.code OR NEW.domain <> OLD.domain
                           OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    RAISE EXCEPTION 'รหัส โดเมน และหมวดแม่ของหมวดหมู่เปลี่ยนไม่ได้';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO p FROM categories WHERE category_id = NEW.parent_id;
    IF p.parent_id IS NOT NULL THEN RAISE EXCEPTION 'หมวดหมู่ลึกได้ 2 ชั้น (หมวดหลัก → หมวดย่อย) เท่านั้น'; END IF;
    IF p.domain <> NEW.domain THEN RAISE EXCEPTION 'หมวดย่อยต้องอยู่โดเมนเดียวกับหมวดหลัก'; END IF;
  END IF;
  RETURN NEW;
END
$fn$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'categories_guard') THEN
    CREATE TRIGGER categories_guard BEFORE INSERT OR UPDATE ON categories
      FOR EACH ROW EXECUTE FUNCTION categories_guard();
  END IF;
END
$do$;

ALTER TABLE cases       ADD COLUMN IF NOT EXISTS cancel_reason_id INTEGER REFERENCES categories (category_id) ON DELETE SET NULL;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS cancel_reason_id INTEGER REFERENCES categories (category_id) ON DELETE SET NULL;
ALTER TABLE invoices    ADD COLUMN IF NOT EXISTS cancel_reason_id INTEGER REFERENCES categories (category_id) ON DELETE SET NULL;

/* ราคาของรายการในแคตตาล็อก (ผู้ใช้ขอ 19 พ.ย. 2569 — "ไม่มีช่องราคาหรอ") — ตั้งในหน้าหมวดหมู่ ฟอร์มเคสดึงไปเติมราคาให้
   หัตถการ: ราคารายครั้ง/วัน/เดือน · อุปกรณ์เสริม: ค่าเช่า/ราคาขาย (ต่อหน่วย) · ว่าง = ไม่มีราคาแบบนั้น
   ยังไม่มีแถว = ใช้ราคาตั้งต้นในโค้ด (หัตถการ — client/src/lib/procedureCatalog.js) · มีแถวแล้ว = แถวนี้คือราคาจริงทั้งชุด */
CREATE TABLE IF NOT EXISTS catalog_prices (
  domain      TEXT NOT NULL,
  item_key    TEXT NOT NULL,
  price_visit DOUBLE PRECISION CHECK (price_visit >= 0),
  price_day   DOUBLE PRECISION CHECK (price_day >= 0),
  price_month DOUBLE PRECISION CHECK (price_month >= 0),
  price_rent  DOUBLE PRECISION CHECK (price_rent >= 0),
  price_sale  DOUBLE PRECISION CHECK (price_sale >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, item_key)
);

${seedSql()}
`;

let ready = null;
/** สร้างตาราง + หมวดตั้งต้นครั้งแรกของแต่ละ instance ถ้ายังไม่มี (ของจริงสร้างตอน migrate · ดู db/migrate.js) */
export const ensureCategories = () =>
  (ready ??= (async () => {
    // ตารางราคามาทีหลัง (19 พ.ย. 2569) — ฐานที่มีหมวดแล้วแต่ยังไม่มีตารางราคาก็รัน DDL (ทั้งก้อนรันซ้ำได้)
    const { rows } = await pool.query(
      `SELECT to_regclass('categories') IS NOT NULL AND to_regclass('catalog_prices') IS NOT NULL AS ok`,
    );
    if (!rows[0].ok) await pool.query(CATEGORY_DDL);
  })().catch((err) => {
    ready = null;
    throw err;
  }));

const COLUMNS = `category_id, domain, parent_id, code, name_th, name_en, sort_order, active, item_keys,
                 to_char(updated_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS updated_at`;

/* ช่องราคาของแต่ละโดเมน — โดเมนที่ไม่อยู่ที่นี่ตั้งราคาที่หน้านี้ไม่ได้ (แพ็กเกจมีหน้าราคาของตัวเอง) */
export const PRICE_FIELDS = {
  procedure: ['price_visit', 'price_day', 'price_month'],
  equipment: ['price_rent', 'price_sale'],
};
const ALL_PRICE_FIELDS = ['price_visit', 'price_day', 'price_month', 'price_rent', 'price_sale'];

/** ราคาที่ตั้งไว้ทั้งหมด (เฉพาะโดเมนที่มีราคา) [{ domain, item_key, price_* }] */
export async function listPrices({ domain = null } = {}) {
  await ensureCategories();
  return sql.all(
    `SELECT domain, item_key, ${ALL_PRICE_FIELDS.join(', ')} FROM catalog_prices
      WHERE (:domain::text IS NULL OR domain = :domain::text) ORDER BY domain, item_key`,
    { domain },
  );
}

/**
 * ตั้งราคาของรายการ (แทนทั้งชุดของโดเมนนั้น — ช่องที่ไม่ส่ง/ว่าง = ไม่มีราคาแบบนั้น)
 * หัตถการต้องเป็นรหัส PRxxxx · อุปกรณ์เป็นชื่อ (ไม่บังคับว่าต้องอยู่ในหมวด — ตั้งราคาไว้ก่อนจัดหมวดได้)
 */
export async function setPrice(domain, itemKey, input) {
  await ensureCategories();
  const fields = PRICE_FIELDS[domain];
  if (!fields) throw new ApiError(400, 'หมวดนี้ไม่มีราคาให้ตั้งที่หน้านี้');
  const key = String(itemKey ?? '').trim();
  if (!key) throw new ApiError(400, 'ไม่ได้ระบุรายการ');
  if (domain === 'procedure' && !/^PR\d{4}$/.test(key)) throw new ApiError(400, `รายการ "${key}" ไม่ใช่รหัสหัตถการ (PRxxxx)`);
  if (key.length > 120) throw new ApiError(400, 'ชื่อรายการยาวเกิน 120 ตัวอักษร');
  const values = Object.fromEntries(ALL_PRICE_FIELDS.map((f) => [f, fields.includes(f) ? input[f] ?? null : null]));
  return sql.one(
    `INSERT INTO catalog_prices (domain, item_key, ${ALL_PRICE_FIELDS.join(', ')})
     VALUES (:domain, :key, ${ALL_PRICE_FIELDS.map((f) => `:${f}`).join(', ')})
     ON CONFLICT (domain, item_key) DO UPDATE SET ${ALL_PRICE_FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ')}, updated_at = now()
     RETURNING domain, item_key, ${ALL_PRICE_FIELDS.join(', ')}`,
    { domain, key, ...values },
  );
}

/** รายการหมวด (แบนราบ หน้าเว็บประกอบเป็นต้นไม้เอง) — includeInactive สำหรับหน้าจัดการหมวด */
export async function list({ domain = null, includeInactive = false } = {}) {
  await ensureCategories();
  return sql.all(
    `SELECT ${COLUMNS} FROM categories
      WHERE (:domain::text IS NULL OR domain = :domain::text)
        AND (:all::boolean OR active)
      ORDER BY domain, sort_order, category_id`,
    { domain, all: includeInactive },
  );
}

/**
 * เพิ่มหมวด — หมวดหลักต้องตั้งรหัส 3 ตัวอักษรเอง · หมวดย่อยได้เลขถัดไปของหมวดแม่ให้เอง
 * โดเมนที่รายการอยู่ในโค้ด (editable: false) เพิ่มไม่ได้ — หมวดเปล่าที่ไม่มีรายการไม่มีประโยชน์
 */
export async function create({ domain, parent_id = null, code = null, name_th, name_en = null }) {
  await ensureCategories();
  const meta = CATEGORY_DOMAINS[domain];
  if (!meta) throw new ApiError(400, 'ไม่รู้จักโดเมนนี้');
  if (!meta.editable) throw new ApiError(400, `${meta.label}: รายการอยู่ในระบบ เพิ่มหมวดเองไม่ได้ — แก้ชื่อ/ลำดับ/เปิดปิดได้`);

  if (parent_id == null) {
    if (!/^[A-Z]{3}$/.test(code ?? '')) throw new ApiError(400, 'รหัสหมวดหลักต้องเป็นตัวอักษรภาษาอังกฤษพิมพ์ใหญ่ 3 ตัว (เช่น CUS)');
    const fullCode = `${meta.prefix}-${code}`;
    if (await sql.one('SELECT 1 FROM categories WHERE code = :c', { c: fullCode })) {
      throw new ApiError(409, `รหัส ${fullCode} ถูกใช้แล้ว`);
    }
    const next = await sql.one(
      `SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM categories WHERE domain = :domain AND parent_id IS NULL`,
      { domain },
    );
    return sql.one(
      `INSERT INTO categories (domain, code, name_th, name_en, sort_order)
       VALUES (:domain, :code, :name_th, :name_en, :sort) RETURNING ${COLUMNS}`,
      { domain, code: fullCode, name_th, name_en, sort: next.n },
    );
  }

  /* หมวดย่อย — เลขถัดไปคิดจากรหัสที่มีอยู่ (รวมที่ปิดไปแล้ว — เลขเก่าไม่ถูกเอามาใช้ซ้ำ)
     ล็อกหมวดแม่ไว้กันสองคนกดเพิ่มพร้อมกันแล้วได้เลขเดียวกัน */
  return transaction(async (tx) => {
    const parent = await tx.one('SELECT * FROM categories WHERE category_id = :id FOR UPDATE', { id: parent_id });
    if (!parent || parent.domain !== domain) throw new ApiError(400, 'ไม่พบหมวดหลักนี้ในโดเมนที่เลือก');
    if (parent.parent_id != null) throw new ApiError(400, 'หมวดหมู่ลึกได้ 2 ชั้น — เพิ่มใต้หมวดหลักเท่านั้น');
    const { n, sort } = await tx.one(
      `SELECT COALESCE(max(substring(code FROM '-(\\d+)$')::int), 0) + 1 AS n,
              COALESCE(max(sort_order), 0) + 10 AS sort
         FROM categories WHERE parent_id = :id`,
      { id: parent_id },
    );
    if (n > 99) throw new ApiError(409, 'หมวดนี้มีหมวดย่อยครบ 99 รายการแล้ว');
    return tx.one(
      `INSERT INTO categories (domain, parent_id, code, name_th, name_en, sort_order)
       VALUES (:domain, :parent_id, :code, :name_th, :name_en, :sort) RETURNING ${COLUMNS}`,
      { domain, parent_id, code: `${parent.code}-${String(n).padStart(2, '0')}`, name_th, name_en, sort },
    );
  });
}

/** โดเมนของหมวด (ไว้ตรวจสิทธิ์ก่อนแก้) — ไม่พบ = null */
export async function domainOf(id) {
  await ensureCategories();
  return (await sql.one('SELECT domain FROM categories WHERE category_id = :id', { id }))?.domain ?? null;
}

/** แก้ชื่อ / ลำดับ / เปิด-ปิด — รหัส โดเมน และหมวดแม่เปลี่ยนไม่ได้ (trigger กันซ้ำอีกชั้น) */
export async function update(id, input) {
  await ensureCategories();
  const fields = ['name_th', 'name_en', 'sort_order', 'active'].filter((k) => k in input);
  if (fields.length === 0) throw new ApiError(400, 'ไม่มีอะไรให้แก้');
  return transaction(async (tx) => {
    const current = await tx.one(
      `SELECT c.parent_id, p.active AS parent_active FROM categories c
         LEFT JOIN categories p ON p.category_id = c.parent_id
        WHERE c.category_id = :id FOR UPDATE OF c`,
      { id },
    );
    if (!current) throw new ApiError(404, 'ไม่พบหมวดนี้');
    /* เปิด/ปิดหมวดหลัก = หมวดย่อยทั้งหมดเปิด/ปิดตาม (ผู้ใช้ขอ 19 พ.ย. 2569 — "ปิดหัวข้อ เมนูย่อยต้องปิดตามทั้งหมด")
       หมวดย่อยใต้หมวดหลักที่ปิดอยู่ เปิดเดี่ยวๆ ไม่ได้ — ต้องเปิดหมวดหลักก่อน */
    if (input.active === true && current.parent_id != null && current.parent_active === false) {
      throw new ApiError(400, 'หมวดหลักปิดอยู่ — เปิดหมวดหลักก่อน แล้วหมวดย่อยจะเปิดตามทั้งหมด');
    }
    const row = await tx.one(
      `UPDATE categories SET ${fields.map((f) => `${f} = :${f}`).join(', ')}, updated_at = now()
        WHERE category_id = :id RETURNING ${COLUMNS}`,
      { id, ...Object.fromEntries(fields.map((f) => [f, input[f] ?? null])) },
    );
    if ('active' in input && current.parent_id == null) {
      await tx.run(
        `UPDATE categories SET active = :active, updated_at = now() WHERE parent_id = :id AND active <> :active`,
        { id, active: input.active },
      );
    }
    return row;
  });
}

export const MAX_ITEMS = 300;

/** ตรวจรายการตามชนิดของโดเมน — คืนรายการที่ตัดช่องว่าง/ตัวซ้ำแล้ว · ไม่ผ่าน = 400 พร้อมบอกตัวที่ผิด */
async function checkItems(kind, keys, db) {
  const clean = [...new Set(keys.map((k) => String(k ?? '').trim()).filter(Boolean))];
  if (clean.length > MAX_ITEMS) throw new ApiError(400, `หมวดหนึ่งมีได้ไม่เกิน ${MAX_ITEMS} รายการ`);
  const bad = (k, why) => { throw new ApiError(400, `รายการ "${k}" ${why}`); };
  if (kind === 'procedure') {
    for (const k of clean) if (!/^PR\d{4}$/.test(k)) bad(k, 'ไม่ใช่รหัสหัตถการ (PRxxxx)');
  } else if (kind === 'free') {
    for (const k of clean) if (k.length > 120) bad(`${k.slice(0, 20)}…`, 'ยาวเกิน 120 ตัวอักษร');
  }
  return clean;
}

/**
 * ตั้งรายการของหมวดย่อย (แทนทั้งชุด) — เฉพาะโดเมนแคตตาล็อก (meta.items)
 * รายการที่เคยอยู่หมวดย่อยอื่นในโดเมนเดียวกันถูกถอดออกจากที่นั่น (หนึ่งรายการ = หนึ่งหมวด) · คืนแถวทั้งโดเมนที่เปลี่ยนแล้ว
 */
export async function setItems(id, keys) {
  await ensureCategories();
  return transaction(async (tx) => {
    const row = await tx.one('SELECT * FROM categories WHERE category_id = :id', { id });
    if (!row) throw new ApiError(404, 'ไม่พบหมวดนี้');
    const meta = CATEGORY_DOMAINS[row.domain];
    if (!meta?.items) throw new ApiError(400, `${meta?.label ?? 'หมวดนี้'}: จัดรายการเองไม่ได้`);
    if (row.parent_id == null) throw new ApiError(400, 'จัดรายการได้ที่หมวดย่อยเท่านั้น');
    const clean = await checkItems(meta.items, keys, tx);
    // ล็อกทั้งโดเมนตามลำดับ id กันสองคนย้ายรายการเดียวกันพร้อมกันแล้วไปอยู่สองหมวด
    await tx.all('SELECT category_id FROM categories WHERE domain = :d ORDER BY category_id FOR UPDATE', { d: row.domain });
    await tx.run(
      `UPDATE categories SET item_keys = ARRAY(SELECT k FROM unnest(item_keys) k WHERE NOT (k = ANY(:keys::text[]))), updated_at = now()
        WHERE domain = :d AND category_id <> :id AND item_keys && :keys::text[]`,
      { d: row.domain, id, keys: clean },
    );
    await tx.run('UPDATE categories SET item_keys = :keys::text[], updated_at = now() WHERE category_id = :id', { id, keys: clean });
    return tx.all(`SELECT ${COLUMNS} FROM categories WHERE domain = :d ORDER BY sort_order, category_id`, { d: row.domain });
  });
}

/**
 * ตรวจเหตุผลที่เลือกมา — ต้องเป็นหมวดย่อย (มีหมวดแม่) ของโดเมนนั้น และยังเปิดใช้อยู่ทั้งตัวเองและหมวดแม่
 * คืน { id, code, name, label } · label = "หมวดหลัก › เหตุผล" ไว้เขียนนำหน้าข้อความเหตุผลเดิม
 */
export async function resolveReason(domain, id) {
  if (id == null) return null;
  await ensureCategories();
  const row = await sql.one(
    `SELECT c.category_id, c.code, c.name_th, c.active, c.domain, p.name_th AS parent_name, p.active AS parent_active
       FROM categories c LEFT JOIN categories p ON p.category_id = c.parent_id
      WHERE c.category_id = :id`,
    { id },
  );
  if (!row || row.domain !== domain || row.parent_name == null) {
    throw new ApiError(400, 'เหตุผลที่เลือกไม่ถูกต้อง — กรุณาเลือกจากรายการ');
  }
  if (!row.active || !row.parent_active) throw new ApiError(400, 'เหตุผลนี้ถูกปิดใช้แล้ว — กรุณาเลือกใหม่');
  return { id: row.category_id, code: row.code, name: row.name_th, label: `${row.parent_name} › ${row.name_th}` };
}

/** ข้อความเหตุผลที่เก็บ/แสดง = ชื่อเหตุผล [— รายละเอียดที่พิมพ์เพิ่ม] */
export const reasonText = (reason, text) => {
  const extra = (text ?? '').trim();
  if (!reason) return extra || null;
  return extra ? `${reason.name} — ${extra}` : reason.name;
};
