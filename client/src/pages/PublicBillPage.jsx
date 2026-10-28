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
  const [slipError, setSlipError] = useState(null);
  const [slipMessage, setSlipMessage] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.publicBill(token).then(setItem).catch((e) => setError(e.message));
  }, [token]);

  /* ชื่อเอกสาร — ใบที่ถูกยกเลิกยังเปิดได้ (ดู server/src/invoices/publicRoutes.js)
     ลูกค้าที่จ่ายเงินมาแล้วต้องไม่เสียหลักฐานเพราะทีมยกเลิกใบ แต่ต้องรู้ด้วยว่ามันถูกยกเลิกแล้ว */
  const docName = item?.status === 'cancelled'
    ? (Number(item.paid_amount) > 0 ? 'หลักฐานการชำระเงิน (ใบถูกยกเลิก)' : 'ใบแจ้งหนี้ที่ถูกยกเลิก')
    : item?.status === 'paid' ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้';

  useEffect(() => {
    if (!item) return;
    document.title = `${docName}_${item.invoice_id}`;
  }, [item, docName]);

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

  const canAttachSlip = item.status === 'issued' && Number(item.balance) > 0;
  const uploadSlip = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSlipError(null);
    setSlipMessage('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setSlipError('รับเฉพาะรูป JPG, PNG หรือ WEBP ค่ะ');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setSlipError('รูปสลิปต้องมีขนาดไม่เกิน 8 MB ค่ะ');
      return;
    }
    setUploading(true);
    try {
      const result = await api.publicBillSlip(token, file);
      setSlipMessage(result.message);
    } catch (e) {
      setSlipError(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="bill-page">
      <div className="bill-actions no-print">
        <span>{docName} {item.invoice_id}</span>
        <button className="btn primary" onClick={() => window.print()}>บันทึก PDF / พิมพ์</button>
      </div>
      {item.status === 'cancelled' && (
        <div className="bill-cancelled">
          <b>เอกสารฉบับนี้ถูกยกเลิกแล้ว</b>
          <br />
          {Number(item.paid_amount) > 0
            ? `ยอดที่ชำระเข้ามาแล้ว ${Number(item.paid_amount).toLocaleString('th-TH')} บาท ยังบันทึกไว้ด้านล่างเป็นหลักฐาน — ` +
              'ทีม KIN HomeCare จะติดต่อเรื่องเอกสารฉบับใหม่หรือการคืนเงินค่ะ'
            : 'ไม่ต้องชำระยอดในเอกสารฉบับนี้ค่ะ — หากมีเอกสารฉบับใหม่ ทีมงานจะส่งให้ทางแชท LINE'}
          <br />
          สอบถามได้ที่แชท LINE KIN HomeCare หรือ 061-881-9399 ค่ะ
        </div>
      )}
      <div className="bill-scroll">
        <div className="invoice-doc">
          <CustomerInvoiceDoc item={item} signer={item.signer} />
        </div>
      </div>
      {canAttachSlip && (
        <section className="bill-slip-upload no-print" aria-live="polite">
          <b>โอนเงินแล้ว แนบสลิปได้ที่นี่</b>
          <p>รับรูป JPG, PNG หรือ WEBP ขนาดไม่เกิน 8 MB</p>
          <label className={`btn primary${uploading ? ' disabled' : ''}`}>
            {uploading ? 'กำลังส่งสลิป…' : 'แนบสลิปการโอน'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={uploadSlip}
              disabled={uploading}
              hidden
            />
          </label>
          {slipMessage && <p className="success-msg">{slipMessage}</p>}
          {slipError && <p className="error-msg">{slipError}</p>}
        </section>
      )}
      <p className="bill-note no-print">สอบถามเรื่องเอกสารหรือการชำระเงิน พิมพ์ในแชท LINE KIN HomeCare ได้เลยค่ะ</p>
    </div>
  );
}
