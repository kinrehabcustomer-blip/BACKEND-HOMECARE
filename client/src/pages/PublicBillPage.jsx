import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import CustomerInvoiceDoc from '../components/CustomerInvoiceDoc.jsx';

/**
 * ใบแจ้งหนี้/ใบเสร็จที่ส่งเข้า LINE ลูกค้า (ดร.ธงชัย 24 ต.ค. 2569 ข้อ 4) — /bill/:token
 * ไม่มี AppLayout/login แบบเดียวกับแบบประเมินญาติ · ความปลอดภัยอยู่ที่ token ในลิงก์ (server/src/invoices/share.js)
 * ตัวเอกสารเป็นชิ้นเดียวกับที่ทีมพิมพ์จากระบบ (CustomerInvoiceDoc) จึงตรงกันทุกตัวอักษร · บันทึก PDF ด้วยปุ่มพิมพ์ของเบราว์เซอร์
 */
export default function PublicBillPage() {
  const { token } = useParams();
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.publicBill(token).then(setItem).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    if (!item) return;
    document.title = `${item.status === 'paid' ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้'}_${item.invoice_id}`;
  }, [item]);

  if (error) {
    return (
      <div className="review-page">
        <section className="review-card review-msg">
          <img className="review-logo" src="/logo-navbar.webp" alt="KIN Home Care" />
          <h1>เปิดเอกสารไม่ได้</h1>
          <p>{error}</p>
        </section>
      </div>
    );
  }
  if (!item) return <p className="muted app-loading">กำลังเปิดเอกสาร…</p>;

  return (
    <div className="bill-page">
      <div className="bill-actions no-print">
        <span>{item.status === 'paid' ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้'} {item.invoice_id}</span>
        <button className="btn primary" onClick={() => window.print()}>บันทึก PDF / พิมพ์</button>
      </div>
      <div className="bill-scroll">
        <div className="invoice-doc">
          <CustomerInvoiceDoc item={item} signer={item.signer} />
        </div>
      </div>
      <p className="bill-note no-print">สอบถามเรื่องเอกสารหรือการชำระเงิน พิมพ์ในแชท LINE KIN HomeCare ได้เลยค่ะ</p>
    </div>
  );
}
