import { prefetchGet } from '../api.js';

/**
 * ดึงข้อมูลหลักของหน้าแรกล่วงหน้า ขนานไปกับการถาม /auth/me (ตรวจความเร็ว 24 พ.ย. 2569)
 *
 * เดิม: เปิดแอป/รีเฟรช → รอ /auth/me ตอบ → หน้าแสดง → หน้าเริ่มดึงข้อมูลของตัวเอง = ต้องรอสองรอบเต็ม
 * ตอนนี้: ยิงเส้นที่หน้านั้นจะขอแน่ๆ ไปพร้อมกับ /auth/me แล้วเก็บคำตอบไว้ (api.js · keep)
 * หน้าแสดงแล้วยิงเส้นเดิมตามปกติ → ได้คำตอบที่มาถึงแล้ว/กำลังมาทันที ตัวหน้าไม่ต้องแก้อะไร
 *
 * กติกา
 * - ต้องเป็นเส้นเดียวกับที่หน้ายิงเป๊ะ (รวมลำดับพารามิเตอร์) ไม่งั้นแค่เปลืองหนึ่งคำขอ ไม่มีอะไรพัง
 *   หน้ารายการ: ทำเฉพาะตอน URL ไม่มีตัวกรอง (ค่าเริ่มต้นของหน้า — ดู DEFAULTS ของแต่ละหน้า)
 * - ยังไม่ login / ไม่มีสิทธิ์ = คำขอล่วงหน้าโดนปฏิเสธเงียบๆ (silent) ไม่ทำให้เด้งออก ไม่โชว์ error
 * - ทำครั้งเดียวตอนเปิดแอป — เปลี่ยนเมนูในแอปไม่ได้ถาม /auth/me ซ้ำอยู่แล้ว
 */
const LIST = (path, sort, extra = '') => `${path}?page=1&per_page=20&sort=${sort}&order=desc${extra}`;
const PAGE_DATA = {
  // ภาพรวม (DashboardPage)
  // ภาพรวม: กราฟรายได้โผล่เฉพาะคนที่มีสิทธิ์ — คนที่ไม่มีสิทธิ์ คำขอล่วงหน้าโดนปฏิเสธเงียบๆ เท่านั้น
  '/dashboard': ['/cases/dashboard', '/cases/summary', '/cases?status=unassigned&per_page=5&sort=created_at&order=desc', '/invoices/revenue?bucket=day'],
  '/cases': [LIST('/cases', 'created_at'), '/cases/assignable-employees', '/cases/periods'],
  '/invoices': [LIST('/invoices', 'invoice_id', '&hide_cancelled=yes'), '/invoices/cases-without-invoice', '/invoices/cases-with-extras'],
  '/customers': [LIST('/customers', 'customer_id')],
  '/patients': [LIST('/patients', 'patient_id')],
  '/employees': [LIST('/employees', 'employee_id')],
  '/calendar': ['/cases/assignable-employees'],
  '/attendance': ['/cases/assignable-employees'],
  '/payroll': ['/cases/assignable-employees', '/payroll/case-queue?view=pending'],
  '/packages': ['/packages/matrix'],
  '/physio-packages': ['/physio/packages'],
  '/reviews': ['/reviews/summary'],
  '/my-today': ['/my/today'],
  '/my-cases': ['/my/cases'],
  '/my-chat': ['/my/cases'],
  '/my-reports': ['/my/cases'],
};

/** start = path ของหน้าที่จะเปิด (หน้าแรกจริง ไม่ใช่ "/" ที่ยังไม่รู้ตำแหน่ง) · search = location.search */
export function prefetchStart(start, search) {
  if (!start) return;
  // กระดิ่งแจ้งเตือนโหลดทุกหน้า: หลังบ้าน = /notify/alerts · พนักงาน/พาร์ทเนอร์ = /my/notifications
  const staff = start.startsWith('/my-') || start.startsWith('/partner');
  prefetchGet(staff ? '/my/notifications' : '/notify/alerts');
  if (search) return; // มีตัวกรองใน URL — เส้นที่หน้าจะขอไม่ใช่ค่าเริ่มต้น ไม่เดา
  for (const path of PAGE_DATA[start] ?? []) {
    prefetchGet(path, path === '/cases/assignable-employees' ? 60_000 : 10_000);
  }
}
