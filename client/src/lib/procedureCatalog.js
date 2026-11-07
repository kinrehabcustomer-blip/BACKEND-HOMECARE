/**
 * รายการหัตถการมาตรฐาน (รหัส PRxxxx) ให้เลือกในช่อง "ชื่อหัตถการ" ของฟอร์มเคส
 * rates = ราคาตามตารางราคา (รายครั้ง/รายวัน/รายเดือน) เป็นข้อความตามต้นฉบับ เช่น '12,000/8,000' · null = ไม่มีราคานั้น
 */
export const PROCEDURE_CATALOG = [
  { code: 'PR0001', name: 'ค่าบริการอาหารทางสายยางสูตรมาตรฐาน พร้อมอุปกรณ์', rates: { visit: null, day: '500', month: '12,000/8,000' } },
  { code: 'PR0002', name: 'ค่าบริการให้นมทางสายยาง พร้อมอุปกรณ์ (นำนมมาเอง)', rates: { visit: null, day: '300', month: '7,500/4,000' } },
  { code: 'PR0003', name: 'ค่าบริการดูดเสมหะ พร้อมอุปกรณ์', rates: { visit: '150', day: null, month: '9,000/6,000' } },
  { code: 'PR0004', name: 'ค่าดูแลแผลเจาะคอ', rates: { visit: null, day: '300', month: '3,000' } },
  { code: 'PR0005', name: 'ค่าดูแลแผลเจาะคอ และแผลหน้าท้อง', rates: { visit: null, day: '600', month: '9,000' } },
  { code: 'PR0006', name: 'ค่าดูแลแผลหน้าท้อง', rates: { visit: null, day: '300', month: '3,000-6,000' } },
  { code: 'PR0007', name: 'ค่าบริการให้ออกซิเจน', rates: { visit: null, day: '400', month: '6,000' } },
  { code: 'PR0008', name: 'ค่าทำแผลขนาดเล็ก พร้อมอุปกรณ์', rates: { visit: '200', day: null, month: null } },
  { code: 'PR0009', name: 'ค่าทำแผลขนาดกลาง พร้อมอุปกรณ์', rates: { visit: '400', day: null, month: null } },
  { code: 'PR0010', name: 'ค่าทำแผลขนาดใหญ่ พร้อมอุปกรณ์', rates: { visit: '600', day: null, month: null } },
  { code: 'PR0011', name: 'ค่าบริการผู้เฝ้า (กรณีผู้เฝ้ามาด้วย)', rates: { visit: null, day: '300', month: '6,000' } },
  { code: 'PR0012', name: 'ค่าบริการเตียงลม (ใช้ของทางศูนย์)', rates: { visit: null, day: '150', month: '3,000' } },
  { code: 'PR0013', name: 'ค่าไฟเตียงลม (นำอุปกรณ์มาเอง)', rates: { visit: null, day: '50', month: '1,000' } },
  { code: 'PR0014', name: 'ค่าบริการใส่สายให้อาหารทางจมูก (สายเดิม)', rates: { visit: '300', day: null, month: null } },
  { code: 'PR0015', name: 'ค่าบริการใส่สายให้อาหารทางจมูก (สายใหม่แบบธรรมดา)', rates: { visit: '1,000', day: null, month: null } },
  { code: 'PR0016', name: 'ค่าบริการใส่สายอาหารทางจมูก (สายใหม่แบบ Silicone)', rates: { visit: '1,200', day: null, month: null } },
  { code: 'PR0017', name: 'สวนปัสสาวะแบบสวนทิ้ง', rates: { visit: '550', day: null, month: null } },
  { code: 'PR0018', name: 'สวนปัสสาวะแบบคาสาย', rates: { visit: '800', day: null, month: null } },
  { code: 'PR0019', name: 'ค่าบริการตรวจน้ำตาลปลายนิ้ว DTX (พร้อมอุปกรณ์)', rates: { visit: '100', day: null, month: null } },
  { code: 'PR0020', name: 'ค่าบริการตรวจน้ำตาลปลายนิ้ว DTX (นำอุปกรณ์มาเอง)', rates: { visit: null, day: null, month: '2,500' } },
  { code: 'PR0021', name: 'ค่าบริการพ่นยา พร้อมอุปกรณ์', rates: { visit: '300', day: '400', month: '6,000' } },
  { code: 'PR0022', name: 'ค่าบริการเจาะเลือด (ไม่รวมค่า Lab)', rates: { visit: '200', day: null, month: null } },
  { code: 'PR0023', name: 'ค่านักบริบาลเฝ้าพิเศษ (เวรละ 12 ชั่วโมง)', rates: { visit: '1,600', day: null, month: null } },
  { code: 'PR0024', name: 'ค่าดูแลผู้ป่วยติดเตียง', rates: { visit: null, day: null, month: '7,000' } },
  { code: 'PR0025', name: 'ค่าดูแลผู้ป่วยที่สามารถช่วยเหลือตัวเองได้บางส่วน', rates: { visit: null, day: null, month: '5,000' } },
  { code: 'PR0026', name: 'ค่าบริการกายภาพพื้นฐาน', rates: { visit: '200', day: null, month: null } },
  { code: 'PR0027', name: 'ค่าบริการทีมฟื้นฟูวิชาชีพ ได้แก่ กายภาพบำบัด กิจกรรมบำบัด อรรถบำบัด นักจิตวิทยา แพทย์แผนจีน วิทยาศาสตร์การกีฬา และธาราบำบัด', rates: { visit: '1,600', day: null, month: null } },
  { code: 'PR0028', name: 'ค่าบริการแพทย์ตรวจประเมิน (เข้าตรวจสัปดาห์ละ 1 ครั้ง)', rates: { visit: null, day: null, month: '1,000' } },
  { code: 'PR0029', name: 'บริการให้ออกซิเจน และพ่นยา (พร้อมอุปกรณ์ ไม่รวมยา)', rates: { visit: null, day: '600', month: '9,000' } },
];

/** ต้องพิมพ์อย่างน้อยกี่ตัวอักษรรายการถึงจะขึ้น */
export const PROCEDURE_MIN_CHARS = 3;

/** หัตถการที่ชื่อ/รหัสมีข้อความที่พิมพ์ (ไม่สนตัวพิมพ์เล็กใหญ่) — พิมพ์ไม่ถึง 3 ตัวอักษรได้ [] */
export function searchProcedures(query) {
  const q = query.trim().toLowerCase();
  if (q.length < PROCEDURE_MIN_CHARS) return [];
  return PROCEDURE_CATALOG.filter((p) => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
}

export const RATE_LABELS = { visit: 'ครั้ง', day: 'วัน', month: 'เดือน' };

/** ตัวเลขแรกในข้อความราคา ('12,000/8,000' → 12000) */
export const rateNumber = (text) => Number(String(text).match(/[\d,]+(?:\.\d+)?/)?.[0].replace(/,/g, '') ?? 0);

/** ราคาเริ่มต้นเมื่อเลือกทั้งแถว: รายครั้ง → รายวัน → รายเดือน อันแรกที่มี */
export const defaultRate = (p) => ['visit', 'day', 'month'].map((k) => p.rates[k]).find(Boolean) ?? null;
