import { useEffect } from 'react';

/**
 * บีบใบแจ้งหนี้/ใบเสร็จ (.inv-fit) ให้จบใน A4 แผ่นเดียวตอนสั่งพิมพ์ (11 พ.ย. 2569)
 *
 * ขั้นที่ 1 — ใส่คลาส inv-printing ที่ <html> ระหว่างพิมพ์ → CSS ลดระยะห่าง/โลโก้ (ดู index.css ".inv-printing")
 *   ทำผ่านคลาสแทน @media print เพราะต้องวัดความสูงจริงด้วยสไตล์ชุดเดียวกับที่จะพิมพ์ (ขั้นที่ 2)
 *   ซึ่ง beforeprint ยังเป็น layout ของจออยู่ @media print ยังไม่ทำงาน
 * ขั้นที่ 2 — โคลนเอกสารไปวางนอกจอที่ความกว้างเท่าพื้นที่พิมพ์ของ A4 แล้ววัดความสูง
 *   เกินหนึ่งแผ่น (เช่น ใบรายครั้งที่มีหลายสิบบรรทัด) → ย่อด้วย zoom ให้พอดี ซึ่งต่างจาก transform ตรงที่ย่อพื้นที่ใน layout ด้วย
 *   หน้ากระดาษจึงไม่ถูกตัดขึ้นแผ่นใหม่
 *
 * ขั้นที่ 3 — ตั้ง @page margin: 0 ระหว่างพิมพ์ เพื่อไม่ให้เบราว์เซอร์พิมพ์หัว/ท้ายกระดาษของตัวเอง
 *   (วันที่-เวลา · ชื่อแท็บ · URL localhost:5173/... · เลขหน้า) — เบราว์เซอร์วาดพวกนี้ลงในขอบกระดาษ ขอบเป็น 0 จึงไม่มีที่ให้วาด
 *   ระยะขอบ 15mm ย้ายไปเป็น padding ของ .inv-fit / .inv-slip แทน (index.css ".inv-printing")
 *   ฉีดเป็น <style> เฉพาะตอนพิมพ์ใบเหล่านี้ — ใบสรุปค่าตอบแทน/รายงานอาการยังใช้ @page margin 15mm เดิม
 */
const MM = 96 / 25.4;
// กระดาษ A4 เต็มแผ่น (ขอบ 15mm อยู่ใน padding ของ .inv-fit แล้ว)
const PRINT_WIDTH_MM = 210;
// เผื่อ 4mm กันปัดเศษ/ฟอนต์ต่างกันเล็กน้อยระหว่างจอกับเครื่องพิมพ์
const PRINT_HEIGHT_MM = 297 - 4;
const PAGE_STYLE_ID = 'inv-print-page';

function fit() {
  document.documentElement.classList.add('inv-printing');
  if (!document.getElementById(PAGE_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    style.textContent = '@page { size: A4; margin: 0; }';
    document.head.appendChild(style);
  }
  for (const el of document.querySelectorAll('.inv-fit')) {
    el.style.zoom = '';
    const probe = document.createElement('div');
    probe.className = 'invoice-doc inv-print-probe';
    probe.style.width = `${PRINT_WIDTH_MM}mm`;
    probe.appendChild(el.cloneNode(true));
    document.body.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    const limit = PRINT_HEIGHT_MM * MM;
    if (height > limit) el.style.zoom = String(Math.floor((limit / height) * 1000) / 1000);
  }
}

function reset() {
  document.documentElement.classList.remove('inv-printing');
  document.getElementById(PAGE_STYLE_ID)?.remove();
  for (const el of document.querySelectorAll('.inv-fit')) el.style.zoom = '';
}

/** เรียกในหน้าที่มีปุ่มพิมพ์ใบแจ้งหนี้/ใบเสร็จ — ครอบตัวเอกสาร (ไม่รวมสลิปแนบ) ด้วย <div className="inv-fit"> */
export function usePrintFit() {
  useEffect(() => {
    window.addEventListener('beforeprint', fit);
    window.addEventListener('afterprint', reset);
    return () => {
      window.removeEventListener('beforeprint', fit);
      window.removeEventListener('afterprint', reset);
      reset();
    };
  }, []);
}
