import { sql } from '../db/index.js';
import { employeeStars } from './ratings.js';

/**
 * ระดับพนักงาน Diamond / Gold / Silver / Bronze (ดร.ธงชัย 25 ต.ค. 2569 "ระดับสูงได้เห็นงานก่อน หรือได้เรทดีกว่า … ทำได้เลย")
 * คิดจาก 90 วันล่าสุด: จำนวนกะที่เสร็จ · เช็คอินตรงเวลา (สายไม่เกิน 15 นาที) · ส่งรายงานในวันที่เข้ากะ · ดาวเฉลี่ยจากครอบครัว (มี ≥3 ความเห็นจึงนับ)
 * เกณฑ์ตั้งต้น (ปรับได้ที่ TIERS) — สิทธิพิเศษของแต่ละระดับ (เห็นงานก่อน · เรท) เป็นนโยบายที่ ดร. เคาะแยก
 */
// ชื่อระดับภาษาอังกฤษ (ดร. 25 ต.ค. 2569 "ใช้ชื่อภาษาอังกฤษ Gold, Silver, Diamond") · ยังไม่มีกะ = Starter
export const TIERS = [
  { key: 'diamond', label: 'Diamond', minShifts: 40, onTime: 0.97, reports: 0.95, stars: 4.7 },
  { key: 'gold', label: 'Gold', minShifts: 20, onTime: 0.95, reports: 0.9, stars: 4.5 },
  { key: 'silver', label: 'Silver', minShifts: 8, onTime: 0.85, reports: 0.75, stars: 4.0 },
  { key: 'bronze', label: 'Bronze', minShifts: 1, onTime: 0, reports: 0, stars: 0 },
];
const LAST = TIERS.length - 1;
const LATE_OK = 15;

/** ตัวชี้วัด 90 วันของพนักงาน → { shifts, on_time, reports, stars, n_stars } (สัดส่วน 0–1 · null = ยังไม่มีข้อมูล) */
export async function employeeMetrics(employeeId) {
  const since = new Date(Date.now() + 7 * 3.6e6 - 90 * 864e5).toISOString().slice(0, 10);
  const v = await sql.one(
    `SELECT count(*)::int AS shifts,
            count(*) FILTER (WHERE COALESCE(v.check_in_late_minutes, 0) <= ${LATE_OK})::int AS on_time,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM case_reports r WHERE r.case_id = v.case_id AND r.report_date = v.visit_date AND r.reported_by = :emp))::int AS reported
     FROM case_visits v
     WHERE COALESCE(v.checked_in_by, v.assigned_to) = :emp AND v.visit_date >= :since
       AND (v.status = 'done' OR v.check_out_at IS NOT NULL)`,
    { emp: employeeId, since },
  );
  const st = await employeeStars(employeeId);
  const shifts = v?.shifts || 0;
  return {
    shifts,
    on_time: shifts ? v.on_time / shifts : null,
    reports: shifts ? v.reported / shifts : null,
    stars: st.avg, n_stars: st.n,
  };
}

/** ระดับจากตัวชี้วัด → { key, label, next: { label, missing: [ข้อความ] } | null } */
export function tierOf(m) {
  if (!m.shifts) return { key: 'starter', label: 'Starter', next: { label: TIERS[LAST].label, missing: ['ทำกะแรกให้เสร็จ'] } };
  const pass = (t) => m.shifts >= t.minShifts && (m.on_time ?? 0) >= t.onTime && (m.reports ?? 0) >= t.reports && (m.stars == null || m.stars >= t.stars);
  const idx = TIERS.findIndex(pass);
  const cur = TIERS[idx === -1 ? LAST : idx];
  const up = TIERS[(idx === -1 ? LAST : idx) - 1];
  const missing = [];
  if (up) {
    if (m.shifts < up.minShifts) missing.push(`ทำอีก ${up.minShifts - m.shifts} กะ`);
    if ((m.on_time ?? 0) < up.onTime) missing.push(`เช็คอินตรงเวลาให้ถึง ${Math.round(up.onTime * 100)}%`);
    if ((m.reports ?? 0) < up.reports) missing.push(`ส่งรายงานทุกกะให้ถึง ${Math.round(up.reports * 100)}%`);
    if (m.stars != null && m.stars < up.stars) missing.push(`ดาวจากครอบครัวให้ถึง ${up.stars}`);
  }
  return { key: cur.key, label: cur.label, next: up ? { label: up.label, missing } : null };
}

export async function employeeTier(employeeId) {
  const m = await employeeMetrics(employeeId);
  return { ...tierOf(m), metrics: m };
}
