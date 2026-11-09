/**
 * อุปกรณ์เสริม + หัตถการของเคส — รายการที่คิดเงินเพิ่มจากค่าบริการ [{ name, quantity, unit_price, kind?, vn? }]
 *
 * ยอดของแต่ละบรรทัดปัดสองตำแหน่งก่อนรวม ให้ตรงกับ addonsTotalSql ทุกสตางค์
 * (ป้าย "ไม่ตรงกับเคส" เทียบยอดจากสองฝั่งนี้ — ปัดคนละจังหวะแล้วจะขึ้นป้ายทั้งที่ยอดถูก)
 */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * หัตถการเพิ่มเติม (ทำแผล ใส่สาย ฯลฯ) เก็บในรายการเดียวกับอุปกรณ์เสริม แต่ติด kind: 'procedure'
 * และมีเลข VN ของตัวเอง (หนึ่งหัตถการ = หนึ่งครั้งที่ให้บริการ ดู cases/visitNumbers.js)
 * อยู่ในรายการเดียวกันเพื่อให้ยอดใบแจ้งหนี้ ป้าย "ไม่ตรงกับเคส" ใบส่วนที่เหลือ และใบเสร็จ ทำงานเหมือนกันทุกจุด
 */
export const PROCEDURE = 'procedure';
export const isProcedure = (a) => a?.kind === PROCEDURE;

/**
 * แพ็กกายภาพเสริมที่เก็บเงินรวมในใบของเคส Homecare (cases.bill_with_parent — ดร.ธงชัย 9 พ.ย. 2569)
 * ไม่เคยอยู่ใน addons ของเคส (schema ของเคสไม่รับ kind นี้) — ใบแจ้งหนี้ประกอบบรรทัดนี้เองจากเคสกายภาพ
 * ตอนออก/ซิงก์ใบ (ดู bundledAddons ใน invoices/repo.js) · ref = case_id ของเคสกายภาพ ใช้แยกว่าใบไหนเก็บแพ็กไหนไปแล้ว
 * อยู่ในรายการเดียวกับอุปกรณ์ จึงได้กติกาเดียวกันทุกจุด: ยอดใบ ป้าย "ไม่ตรงกับเคส" และแบ่งมัดจำ
 * (ใบมัดจำเป็นเงินก้อน บรรทัดนี้ย้ายไปใบส่วนที่เหลือเต็มจำนวน = มัดจำหักจากค่า Homecare ล้วน)
 */
export const PHYSIO_BUNDLE = 'physio';
export const isPhysioBundle = (a) => a?.kind === PHYSIO_BUNDLE;

/**
 * เรียงคีย์ตายตัวและตัดค่าแปลกปลอมทิ้ง — ใช้ทั้งตอนเก็บลงฐานข้อมูลและตอนเทียบว่าเปลี่ยนไหม
 * อุปกรณ์เสริมคงรูปเดิมทุกตัวอักษร { name, quantity, unit_price } — ข้อความของรายการนี้อยู่ใน service_key
 * ของใบแจ้งหนี้ ถ้าเติมคีย์ใหม่ให้ทุกบรรทัด ใบเก่าทั้งระบบจะขึ้นป้าย "แพ็คเกจไม่ตรง" ทันที
 * หัตถการเท่านั้นที่มี kind + vn ต่อท้าย (จำนวน 1 เสมอ — หนึ่งบรรทัดคือหนึ่งครั้ง)
 */
export const normalizeAddons = (addons) =>
  (Array.isArray(addons) ? addons : []).map((a) =>
    isPhysioBundle(a)
      ? {
          name: String(a.name ?? '').trim(),
          quantity: 1,
          unit_price: Number(a.unit_price ?? 0),
          kind: PHYSIO_BUNDLE,
          ref: a.ref ? String(a.ref) : null,
        }
      : isProcedure(a)
      ? {
          name: String(a.name ?? '').trim(),
          quantity: 1,
          unit_price: Number(a.unit_price ?? 0),
          kind: PROCEDURE,
          vn: a.vn ? String(a.vn) : null,
        }
      : {
          name: String(a.name ?? '').trim(),
          quantity: Number(a.quantity ?? 1),
          unit_price: Number(a.unit_price ?? 0),
          // ซื้อขาดเท่านั้นที่ติด kind (ใบลูกค้าพิมพ์ชื่อสินค้าจริง) · เช่า/ของเดิมคงรูปเดิม ไม่ให้ใบเก่าขึ้นป้ายไม่ตรง
          ...(a.kind === 'sale' ? { kind: 'sale' } : {}),
        },
  );

/** ข้อความบรรทัดในใบแจ้งหนี้ — ต้องตรงกับ addonLabel ใน client/src/lib/addons.js */
export const addonLabel = (a) =>
  isPhysioBundle(a)
    ? `กายภาพบำบัด: ${a.name}`
    : isProcedure(a) ? `หัตถการ: ${a.name}${a.vn ? ` (${a.vn})` : ''}` : `อุปกรณ์เสริม: ${a.name}`;

export const addonAmount = (a) => round2(Number(a.quantity) * Number(a.unit_price));

export const addonsTotal = (addons) =>
  round2(normalizeAddons(addons).reduce((sum, a) => sum + addonAmount(a), 0));

/** ฉบับ SQL ของ addonsTotal — c = alias ของตารางที่มีคอลัมน์ addons (cases หรือ invoices) */
export const addonsTotalSql = (c) => `COALESCE((
    SELECT SUM(ROUND((a ->> 'quantity')::numeric * (a ->> 'unit_price')::numeric, 2))
    FROM jsonb_array_elements(${c}.addons) a), 0)::double precision`;

/* รายการเดียวกัน = ชื่อ ราคาต่อหน่วย ชนิด และ VN ตรงกัน — จำนวนไม่อยู่ใน key เพราะนับแยกเป็นยอดคงเหลือ
   (เช่าเตียงเพิ่มจาก 1 เป็น 2 เดือน = ค้างเก็บอีก 1 ไม่ใช่รายการใหม่ทั้งก้อน) */
const addonKey = (a) =>
  // แพ็กกายภาพผูกกับเคสกายภาพใบเดียว (ref) — เปลี่ยนราคาแล้วยังเป็นแพ็กเดิม ไม่ใช่รายการใหม่
  isPhysioBundle(a) ? JSON.stringify([PHYSIO_BUNDLE, a.ref]) : JSON.stringify([a.name, a.unit_price, a.kind ?? null, a.vn ?? null]);
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * อุปกรณ์เสริม/หัตถการของเคสที่ยังไม่อยู่ในใบแจ้งหนี้ใบไหนเลย (ดร.ธงชัย 4 พ.ย. 2569)
 *
 * ค่าใช้จ่ายนอกแพ็คเกจที่เพิ่มเข้าเคสหลังใบแพ็คเกจออกไปแล้ว ไม่ถูกยัดเข้าใบเดิม — แอดมินออกเป็นใบใหม่เอง
 * billed = addons ของทุกใบที่ยังไม่ยกเลิกของเคสนี้รวมกัน (ใบร่างนับด้วย เพราะใบร่างก็กำลังจะเก็บรายการนั้น)
 * แต่ละรายการถูกเก็บได้ครั้งเดียวทั้งเคส ไม่ว่าจะอยู่ในใบแพ็คเกจ ใบส่วนที่เหลือ ใบตามกะ หรือใบค่าใช้จ่ายเพิ่มเติม
 */
export function unbilledAddons(caseAddons, billed = []) {
  const covered = new Map();
  for (const a of normalizeAddons(billed)) {
    covered.set(addonKey(a), (covered.get(addonKey(a)) ?? 0) + a.quantity);
  }
  const out = [];
  for (const a of normalizeAddons(caseAddons)) {
    const key = addonKey(a);
    const used = Math.min(a.quantity, covered.get(key) ?? 0);
    covered.set(key, round3((covered.get(key) ?? 0) - used));
    const left = round3(a.quantity - used);
    if (left > 0) out.push({ ...a, quantity: left });
  }
  return out;
}
