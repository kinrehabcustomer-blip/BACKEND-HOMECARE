import { amountText, bahtText, docDate } from '../labels.js';
import { DocHeader, channelOf } from './CustomerInvoiceDoc.jsx';
import { withTitle } from '../lib/customerInvoice.js';

/**
 * ใบเสร็จของการรับเงินหนึ่งครั้ง (HC-RC…) — รับเงิน 1 ครั้ง = ใบเสร็จ 1 ใบ (4 พ.ย. 2569 · server invoices/ledger.js)
 *
 * ต่างจาก "ใบเสร็จ" เดิมใน CustomerInvoiceDoc ที่คือใบแจ้งหนี้ใบเดิมพลิกหัวเป็นใบเสร็จตอนจ่ายครบ
 * ใบนี้มีเลขที่ของตัวเอง ระบุยอดที่รับครั้งนี้ และยอดคงค้างหลังรับ — ลูกค้าที่จ่ายมัดจำก็ได้ใบเสร็จทันที
 * ผู้จ่าย/ยอดทุกตัวเป็นสำเนา ณ วันออก ไม่อ่านจากใบแจ้งหนี้ปัจจุบัน
 */
export default function ReceiptDoc({ item, receipt, signer }) {
  const voided = receipt.status === 'voided';
  const channel = channelOf(receipt.method);
  const pay = { cash: '', credit: '', transfer: '', [channel]: amountText(receipt.amount) };

  return (
    <>
      <DocHeader title="ใบเสร็จรับเงิน /Receipt" copy={voided ? 'ยกเลิกแล้ว' : 'สำเนา'} />

      <div className="inv-parties">
        <div>
          <p>รหัสผู้รับบริการ : <span className="mono">{item.patient_id ?? '—'}</span></p>
          <p>ชื่อผู้รับบริการ : {item.patient_name ?? '—'}</p>
          {receipt.bill_to_tax_id && <p>เลขผู้เสียภาษี : <span className="mono">{receipt.bill_to_tax_id}</span></p>}
        </div>
        <div className="inv-parties-right">
          <p>Receipt No: <strong className="mono">{receipt.receipt_id}</strong></p>
          <p>วันที่ /Date : {docDate(receipt.paid_at)}</p>
          <p>อ้างอิงใบแจ้งหนี้ /Ref : <span className="mono">{item.invoice_id}</span></p>
        </div>
      </div>

      <table className="inv-table">
        <colgroup>
          <col style={{ width: '8%' }} />
          <col />
          <col style={{ width: '20%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>No.</th>
            <th>รายการ (Description)</th>
            <th>จำนวนเงิน (Amount)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="inv-c">1</td>
            <td>
              {receipt.is_deposit ? 'เงินมัดจำ' : 'รับชำระ'}ตามใบแจ้งหนี้เลขที่ <span className="mono">{item.invoice_id}</span>
            </td>
            <td className="inv-r">{amountText(receipt.amount)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="inv-r">รับชำระครั้งนี้/Paid</td>
            <td className="inv-r"><strong>{amountText(receipt.amount)}</strong></td>
          </tr>
          <tr>
            <td colSpan={2} className="inv-r">ยอดคงค้างหลังรับชำระ/Balance</td>
            <td className="inv-r">{amountText(receipt.balance_after)}</td>
          </tr>
          <tr>
            <td colSpan={3} className="inv-r inv-words">( {bahtText(receipt.amount)} )</td>
          </tr>
        </tfoot>
      </table>

      <p className="inv-methods">
        <span>เงินสด Cash={pay.cash}</span>
        <span>บัตรเครดิต/Credit Card={pay.credit}</span>
        <span>โอน/Transfer={pay.transfer}</span>
      </p>

      <p className="inv-line">ได้รับเงินจาก (Received from) {withTitle(receipt.bill_to_name)}</p>
      {voided && (
        <p className="inv-line">
          <strong>ใบเสร็จนี้ถูกยกเลิก</strong> — {receipt.void_reason}
          {receipt.voided_at && ` (${docDate(receipt.voided_at.slice(0, 10))})`}
        </p>
      )}

      <div className="inv-signs">
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้ชำระเงิน</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {withTitle(receipt.bill_to_name)} )</span>
        </div>
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้รับเงิน</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {receipt.issued_by_name || signer} )</span>
        </div>
      </div>
    </>
  );
}
