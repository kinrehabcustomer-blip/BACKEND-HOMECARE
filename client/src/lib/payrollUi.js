/** จำนวนรอบจ่ายที่ยัง active ได้สูงสุดต่อเดือน — ตรงกับ CHECK ของ payroll_runs */
export const MAX_PAYROLL_ROUNDS = 3;

/** เลือกเลขรอบต่ำสุดที่ยังว่าง; รอบ cancelled ไม่ควรถูกส่งเข้ามา */
export function firstAvailablePayrollRound(activeRounds) {
  const used = new Set(activeRounds.map((row) => Number(row?.round_no ?? row)));
  for (let round = 1; round <= MAX_PAYROLL_ROUNDS; round += 1) {
    if (!used.has(round)) return round;
  }
  return null;
}
