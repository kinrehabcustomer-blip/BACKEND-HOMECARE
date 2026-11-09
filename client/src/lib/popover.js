/**
 * ตำแหน่งแผงที่กางลงใต้ปุ่ม (แผงรอออกใบ / ดาวน์โหลด CSV ในหน้าใบแจ้งหนี้) — position: fixed
 *
 * ชิดขอบขวาของปุ่มเป็นหลัก แต่หนีบไม่ให้ล้นขอบจอทั้งซ้ายและขวา (เว้น 12px)
 * เดิมยึดแค่ขอบขวาของปุ่ม — ปุ่มที่อยู่ครึ่งซ้ายของจอแคบ แผงกว้าง 30rem จึงล้นออกนอกจอซ้าย (ผู้ใช้แจ้ง 9 พ.ย. 2569)
 * ความกว้างคิดที่นี่ที่เดียวแล้วส่งเป็น inline style — ตัวหนีบต้องใช้ความกว้างจริงของแผง
 */
export function placeUnder(rect, { maxWidth = 480, gap = 12, offset = 6 } = {}) {
  const vw = window.innerWidth;
  const width = Math.min(maxWidth, vw - gap * 2);
  const left = Math.min(Math.max(gap, rect.right - width), vw - width - gap);
  return { top: rect.bottom + offset, left, width };
}
