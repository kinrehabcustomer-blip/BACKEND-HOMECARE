/**
 * นิยามของกระดิ่งแจ้งเตือน — ป้ายภาษาไทย ลิงก์ และลำดับความสำคัญ
 *
 * ฝั่ง server ส่งมาแต่ตัวเลขที่คีย์ด้วยชื่อ (ดู notify/alerts.js) ข้อความกับลิงก์อยู่ที่นี่
 * กติกาเดียวกับ reviewQuestions.js — server ไม่ต้องรู้ว่าหน้าเว็บเรียกมันว่าอะไร
 * และแก้คำเตือนให้อ่านลื่นขึ้นไม่ต้องแตะ API
 *
 * เรียงในนี้ = เรียงบนกระดิ่ง · เรียงจาก "เงินหรือคนเสียหายถ้าไม่รู้วันนี้" ลงมาหา "ควรรู้"
 */
export const ALERT_GROUPS = [
  {
    key: 'attendance',
    label: 'การมาทำงาน',
    to: '/attendance',
    items: [
      {
        key: 'exceptions',
        label: 'เช็คอินที่ต้องตรวจ',
        hint: 'นอกพื้นที่ · นอกวันนัด · สายเกิน 30 น. · ค้างเช็คเอาท์',
        to: '/attendance',
      },
      {
        key: 'missed',
        label: 'กะที่ไม่มีใครเช็คอิน',
        hint: 'ย้อนหลัง 14 วัน — อาจไม่มีคนไปบ้านลูกค้าจริง',
        to: '/attendance',
        urgent: true,
      },
      {
        key: 'unstaffed_today',
        label: 'กะวันนี้ที่ยังไม่มีคนรับ',
        hint: 'รู้เช้านี้ยังหาคนทัน',
        to: '/calendar',
        urgent: true,
      },
    ],
  },
  {
    key: 'payroll',
    label: 'ค่าตอบแทนพนักงาน',
    to: '/payroll',
    items: [
      {
        key: 'unreleased',
        label: 'ปิดเคสแล้วยังไม่ปล่อยค่าจ้าง',
        hint: 'พนักงานรอเงินอยู่ — เงินยังไม่เข้ากองรอจ่าย',
        to: '/payroll',
        urgent: true,
      },
      {
        key: 'unbatched',
        label: 'ปล่อยแล้วยังไม่มีรอบกวาด',
        hint: 'อยู่ในกองรอจ่าย กด “เปิดรอบจ่าย” เพื่อกวาดเข้ารอบ',
        to: '/payroll?tab=runs',
      },
      {
        key: 'draft_runs',
        label: 'รอบร่างที่ยังไม่กดจ่าย',
        hint: 'เงินติดอยู่ในรอบที่เปิดค้างไว้',
        to: '/payroll?tab=runs',
      },
    ],
  },
  {
    key: 'cases',
    label: 'เคส',
    to: '/cases',
    items: [
      {
        key: 'unassigned',
        label: 'เคสที่ยังไม่จับคู่พนักงาน',
        hint: 'รับงานมาแล้วยังไม่มีคนทำ',
        to: '/cases?status=unassigned',
        urgent: true,
      },
      {
        key: 'overdue_close',
        label: 'เลยวันสิ้นสุดแล้วยังไม่ปิดเคส',
        hint: 'ยอดค่าจ้างยังไม่ถูกตรึง · ออกใบตามกะที่ไปจริงไม่ได้',
        to: '/cases?status=in_progress',
      },
      {
        key: 'no_staff_pay',
        label: 'มีกะแล้วแต่ยังไม่ตั้งค่าจ้าง',
        hint: 'ปล่อยค่าจ้างของเคสนี้ไม่ได้เลย',
        to: '/cases?no_staff_pay=yes',
      },
      {
        key: 'closed_no_invoice',
        label: 'ปิดเคสแล้วยังไม่มีใบแจ้งหนี้',
        hint: 'งานเสร็จแล้วแต่ยังไม่ได้เก็บเงิน',
        to: '/cases?status=closed',
      },
    ],
  },
  {
    key: 'invoices',
    label: 'ใบแจ้งหนี้',
    to: '/invoices',
    items: [
      {
        key: 'overdue',
        label: 'เลยกำหนดชำระ',
        hint: 'ลูกค้าค้างจ่าย',
        to: '/invoices?overdue=yes',
        urgent: true,
      },
      {
        key: 'draft_stale',
        label: 'ใบร่างค้างเกิน 7 วัน',
        hint: 'ยังไม่ได้ออกให้ลูกค้า',
        to: '/invoices?status=draft',
      },
      {
        key: 'data_stale',
        label: 'ข้อมูลในใบไม่ตรงกับเคสแล้ว',
        hint: 'ยอดหรือชื่อผู้จ่ายเพี้ยน — ตรวจก่อนเก็บเงิน',
        to: '/invoices?stale=yes',
      },
    ],
  },
];
