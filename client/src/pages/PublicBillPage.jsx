import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import CustomerInvoiceDoc from '../components/CustomerInvoiceDoc.jsx';
import ReceiptDoc from '../components/ReceiptDoc.jsx';
import AdjustmentNoteDoc from '../components/AdjustmentNoteDoc.jsx';
import { ISSUER } from '../lib/issuer.js';
import { amountText } from '../labels.js';

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
  const [accountCopyMessage, setAccountCopyMessage] = useState('');
  const [accountCopyError, setAccountCopyError] = useState('');
  /* เอกสารที่ลูกค้าเลือกดู — 'invoice' = ใบแจ้งหนี้ · 'rc:<เลขที่>' = ใบเสร็จรายครั้ง · 'note:<เลขที่>' = ใบลดหนี้/เพิ่มหนี้
     ลิงก์เดียวเห็นเอกสารทุกใบของบิลนี้ ไม่ต้องส่งลิงก์ใหม่ทุกครั้งที่รับเงิน (แผนแก้ระบบการเงิน ข้อ 8) */
  const [docView, setDocView] = useState('invoice');

  useEffect(() => {
    api.publicBill(token).then(setItem).catch((e) => setError(e.message));
  }, [token]);

  const viewReceipt = docView.startsWith('rc:') ? item?.receipts?.find((r) => r.receipt_id === docView.slice(3)) : null;
  const viewNote = docView.startsWith('note:') ? item?.adjustments?.find((n) => n.note_id === docView.slice(5)) : null;

  /* ชื่อเอกสาร — ใบที่ถูกยกเลิกยังเปิดได้ (ดู server/src/invoices/publicRoutes.js)
     ลูกค้าที่จ่ายเงินมาแล้วต้องไม่เสียหลักฐานเพราะทีมยกเลิกใบ แต่ต้องรู้ด้วยว่ามันถูกยกเลิกแล้ว */
  const invoiceName = item?.status === 'cancelled'
    ? (Number(item.paid_amount) > 0 ? 'หลักฐานการชำระเงิน (ใบถูกยกเลิก)' : 'ใบแจ้งหนี้ที่ถูกยกเลิก')
    : item?.status === 'paid' ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้';
  const docName = viewReceipt ? 'ใบเสร็จรับเงิน' : viewNote ? (viewNote.kind === 'credit' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้') : invoiceName;
  const docNo = viewReceipt?.receipt_id ?? viewNote?.note_id ?? item?.invoice_id;

  useEffect(() => {
    if (!item) return;
    document.title = `${docName}_${docNo}`;
  }, [item, docName, docNo]);

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
  const copyAccount = async () => {
    setAccountCopyMessage('');
    setAccountCopyError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(ISSUER.transfer.copyNumber);
      setAccountCopyMessage('คัดลอกเลขบัญชีแล้ว');
    } catch {
      setAccountCopyError(`คัดลอกอัตโนมัติไม่ได้ กรุณาคัดลอกเลข ${ISSUER.transfer.copyNumber}`);
    }
  };
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
        {item.receipts?.length > 0 || item.adjustments?.length > 0 ? (
          <select
            className="bill-doc-picker"
            aria-label="เลือกเอกสาร"
            value={viewReceipt || viewNote ? docView : 'invoice'}
            onChange={(e) => setDocView(e.target.value)}
          >
            <option value="invoice">{invoiceName} {item.invoice_id}</option>
            {item.receipts?.map((r) => (
              <option key={r.receipt_id} value={`rc:${r.receipt_id}`}>
                ใบเสร็จ {r.receipt_id} · {amountText(r.amount)} บาท
              </option>
            ))}
            {item.adjustments?.map((n) => (
              <option key={n.note_id} value={`note:${n.note_id}`}>
                {n.kind === 'credit' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'} {n.note_id}
              </option>
            ))}
          </select>
        ) : (
          <span>{docName} {item.invoice_id}</span>
        )}
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
          สอบถามได้ที่แชท LINE KIN HomeCare หรือ {ISSUER.tel} ค่ะ
        </div>
      )}
      <div className="bill-scroll">
        <div className="invoice-doc">
          {viewReceipt ? (
            <ReceiptDoc item={item} receipt={viewReceipt} signer={item.signer} />
          ) : viewNote ? (
            <AdjustmentNoteDoc
              item={item}
              note={viewNote}
              refund={item.refunds?.find((r) => r.note_id === viewNote.note_id)}
              signer={item.signer}
            />
          ) : (
            <CustomerInvoiceDoc item={item} signer={item.signer} />
          )}
        </div>
      </div>
      {canAttachSlip && (
        <section className="bill-slip-upload no-print" aria-live="polite">
          <button className="btn" type="button" onClick={copyAccount}>คัดลอกเลขบัญชี</button>
          {accountCopyMessage && <p className="success-msg">{accountCopyMessage}</p>}
          {accountCopyError && <p className="error-msg">{accountCopyError}</p>}
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
