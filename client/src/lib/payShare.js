/**
 * การแบ่งค่าจ้างของเคสให้พนักงานหลายคน — ฝาแฝดของ allocateShares ใน server/src/cases/repo.js
 *
 * ทำไมต้องมีสองที่: หน้าจอต้องโชว์ให้เห็นก่อนกดว่าใครจะได้เท่าไหร่ (และให้แก้ตัวเลขเองได้)
 * ส่วน server ต้องคิดเองได้ด้วยเมื่อไม่มีใครส่งส่วนแบ่งมา ไม่ใช่เชื่อตัวเลขจากหน้าเว็บอย่างเดียว
 * โปรเจคนี้ไม่มีโฟลเดอร์โค้ดร่วมระหว่างสองฝั่ง — จึงคุมด้วยเทสที่เทียบผลของทั้งคู่แทน
 * (ดู "ตัวแบ่งค่าจ้างฝั่งหน้าเว็บต้องให้ผลตรงกับฝั่ง server" ใน server/test/logic.test.js)
 * แก้ที่นี่แล้วต้องแก้อีกฝั่งเสมอ ไม่งั้นเทสจะฟ้อง
 */

/** ปัดเป็นสตางค์ — เงินไม่มีทศนิยมที่สาม */
export const round = (n) => Math.round(n * 100) / 100;

/**
 * น้ำหนักของแต่ละคนในการแบ่งค่าจ้างของเคส
 *
 * ค่าปริยาย = หารเท่ากันทุกคนที่อยู่ในเคสนี้ (สองคนคนละครึ่ง สามคนหารสาม)
 * ไม่ผูกกับจำนวนกะและไม่ผูกกับว่ากะถูกยืนยันหรือยัง
 * มีข้อตกลง (share) = ใช้ยอดที่ตกลงเป็นน้ำหนัก — เหตุผลเต็มอยู่ที่ฝั่ง server
 */
export function weightsFor(shares) {
  const agreed = shares.some((r) => r.share != null);
  return shares.map((r) => (agreed ? (r.share ?? 0) : 1));
}

/**
 * เกลี่ยเงินของงวดนี้ตาม "ส่วนที่แต่ละคนยังขาดจากเป้าหมาย" ไม่ใช่แบ่งเฉพาะเงินก้อนนี้
 *
 * เป้าหมายของคนหนึ่ง = (เงินที่ปล่อยไปแล้วทั้งเคส + ยอดของงวดนี้) × น้ำหนักของเขา / น้ำหนักรวม
 * งวดหลังจึงแก้ความเอียงที่เกิดจากจังหวะการปล่อยงวดก่อนให้เอง — เหตุผลเต็มอยู่ที่ฝั่ง server
 *
 * shares = [{ employee_id, shifts, paid, share }] · คืนแถวเดิมพร้อม amount (คนที่ไม่ได้ส่วนแบ่ง = 0)
 */
export function allocateShares(shares, amount) {
  const weights = weightsFor(shares);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return [];

  const target = shares.reduce((s, r) => s + (r.paid ?? 0), 0) + amount;

  const rows = shares.map((r, i) => ({
    ...r,
    owed: Math.max(0, round((target * weights[i]) / totalWeight - (r.paid ?? 0))),
  }));

  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);
  if (totalOwed === 0) return [];

  for (const r of rows) r.amount = round((amount * r.owed) / totalOwed);

  // เศษลงที่คนสุดท้ายที่ยังมีส่วนได้ ไม่ใช่แถวสุดท้ายเฉยๆ (แถวสุดท้ายอาจเป็นคนที่ได้ 0)
  const receivers = rows.filter((r) => r.owed > 0);
  const allocated = receivers.slice(0, -1).reduce((s, r) => s + r.amount, 0);
  receivers[receivers.length - 1].amount = round(amount - allocated);

  return rows;
}

/**
 * ทั้งเคสแล้วแต่ละคนควรได้เท่าไหร่ — ใช้บอกว่าใครได้ล่วงหน้าเกินส่วนของตัวเองไปแล้ว
 * และใช้เป็นตัวตั้งของช่อง "หารเท่ากัน" ตอนตั้งข้อตกลง
 */
export function entitlements(shares, staffPay) {
  const weights = weightsFor(shares);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (!totalWeight || staffPay == null) return shares.map(() => 0);

  /* เศษลงที่คนสุดท้ายที่มีน้ำหนัก ด้วยเหตุผลเดียวกับตอนแบ่งเงินจริง —
     ผลรวมของสิ่งที่ทุกคน "ควรได้" ต้องเท่ากับค่าจ้างของเคสเป๊ะ ไม่งั้นตัวเลขที่โชว์จะไม่ลงตัว */
  const out = weights.map((w) => round((staffPay * w) / totalWeight));
  const last = weights.reduce((at, w, i) => (w > 0 ? i : at), -1);
  if (last >= 0) {
    out[last] = round(staffPay - out.reduce((s, v, i) => (i === last ? s : s + v), 0));
  }
  return out;
}
