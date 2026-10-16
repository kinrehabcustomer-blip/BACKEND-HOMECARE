import RevenueChart from '../components/RevenueChart.jsx';

/**
 * รายได้บริษัท — หน้าของคนที่มีสิทธิ์เรื่องเงินแต่ไม่มีสิทธิ์งานหลังบ้าน (การเงิน)
 *
 * ผู้จัดการเห็นกราฟเดียวกันอยู่แล้วที่หน้าภาพรวม แต่หน้าภาพรวมดึงสรุปเคสมาด้วย
 * ซึ่งการเงินไม่มีสิทธิ์อ่าน — แยกกราฟออกมาเป็นหน้าของตัวเองแทนการเปิดข้อมูลเคสเพิ่ม
 */
export default function RevenuePage() {
  return (
    <>
      <header className="page-head">
        <div>
          <h1>รายได้บริษัท</h1>
          <p className="muted">ยอดรับชำระจากใบแจ้งหนี้ตามช่วงเวลา</p>
        </div>
      </header>
      <RevenueChart />
    </>
  );
}
