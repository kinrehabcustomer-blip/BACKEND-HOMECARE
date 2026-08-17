import { Suspense, lazy } from 'react';

/**
 * กราฟที่โหลดไลบรารีตอนจะวาดจริง — หน้าตาการใช้งานเหมือนเดิมทุกอย่าง (ผู้เรียกไม่ต้องแก้)
 *
 * ECharts หนักราว 550 KB ซึ่งใหญ่กว่าโค้ดทั้งแอปรวมกัน และมีที่ใช้อยู่หน้าเดียวคือหน้าภาพรวม
 * ผูกไว้ตรงๆ แล้วมันจะถูกมัดรวมไปกับหน้านั้น ทำให้เปิดหน้าภาพรวมครั้งแรกต้องรอโหลดก้อนใหญ่
 * ก่อนจะเห็นแม้แต่ตัวเลขสรุปด้านบนที่ไม่ได้ใช้กราฟเลย
 *
 * แยกเป็นไฟล์ของตัวเองแล้ว ตัวเลขสรุปขึ้นทันที ส่วนกราฟค่อยเติมเข้ามาเมื่อไลบรารีมาถึง
 */
const EChartCanvas = lazy(() => import('./EChartCanvas.jsx'));

export default function EChart({ option, height = 280, className = '', ariaLabel }) {
  return (
    /* ที่ว่างระหว่างรอต้องสูงเท่ากราฟจริงเป๊ะ ไม่งั้นเนื้อหาใต้กราฟจะกระโดดตอนโหลดเสร็จ
       (กำลังอ่านตัวเลขอยู่แล้วบรรทัดเลื่อนหนีมือ) — ใส่ className เดิมด้วยเพื่อให้กินที่เท่ากันจริง */
    <Suspense fallback={<div className={className} style={{ height }} aria-hidden="true" />}>
      <EChartCanvas option={option} height={height} className={className} ariaLabel={ariaLabel} />
    </Suspense>
  );
}
