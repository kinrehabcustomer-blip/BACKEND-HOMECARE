import { amountText, bahtText, docDate } from '../labels.js';
import { DocHeader, channelOf } from './CustomerInvoiceDoc.jsx';
import { withTitle } from '../lib/customerInvoice.js';

/**
 * ใบสำคัญจ่าย (HC-PV…) — หลักฐานเงินที่คืนลูกค้า (แผนแก้ระบบการเงิน ชุด A ข้อ 7 · server invoices/ledger.js)
 *
 * เงินคืนเกิดจากใบลดหนี้ที่ลดจนเงินที่รับไว้เกินยอดใหม่ จึงอ้างทั้งใบแจ้งหนี้และใบลดหนี้
 * ผู้รับเงิน = ผู้จ่ายตามใบลดหนี้ (สำเนา ณ วันออก) · ยอดไม่คิดใหม่ เอาตามที่บันทึกไว้
 */
export default function RefundVoucherDoc({ item, refund, note, signer }) {
  const voided = refund.status === 'voided';
  const channel = channelOf(refund.method);
  const pay = { cash: '', credit: '', transfer: '', [channel]: amountText(refund.amount) };
  const payee = note?.bill_to_name ?? item.bill_to_name;

  return (
    <>
      <DocHeader title="ใบสำคัญจ่าย /Payment Voucher" copy={voided ? 'ยกเลิกแล้ว' : 'สำเนา'} />

      <div className="inv-parties">
        <div>
          <p>รหัสผู้รับบริการ : <span className="mono">{item.patient_id ?? '—'}</span></p>
          <p>ชื่อผู้รับบริการ : {item.patient_name ?? '—'}</p>
          <p>จ่ายให้ /Pay to : {withTitle(payee)}</p>
        </div>
        <div className="inv-parties-right">
          <p>Voucher No: <strong className="mono">{refund.refund_doc_id ?? '—'}</strong></p>
          <p>วันที่ /Date : {docDate(refund.refunded_at)}</p>
          <p>อ้างอิงใบแจ้งหนี้ /Ref : <span className="mono">{item.invoice_id}</span></p>
          {refund.note_id && <p>อ้างอิงใบลดหนี้ : <span className="mono">{refund.note_id}</span></p>}
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
              คืนเงินตามใบลดหนี้เลขที่ <span className="mono">{refund.note_id ?? '—'}</span>
              {note?.reason && ` (${note.reason})`}
            </td>
            <td className="inv-r">{amountText(refund.amount)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="inv-r">รวมจ่ายคืน/Total</td>
            <td className="inv-r"><strong>{amountText(refund.amount)}</strong></td>
          </tr>
          <tr>
            <td colSpan={3} className="inv-r inv-words">( {bahtText(refund.amount)} )</td>
          </tr>
        </tfoot>
      </table>

      <p className="inv-methods">
        <span>เงินสด Cash={pay.cash}</span>
        <span>บัตรเครดิต/Credit Card={pay.credit}</span>
        <span>โอน/Transfer={pay.transfer}</span>
      </p>

      {voided && (
        <p className="inv-line">
          <strong>ใบสำคัญจ่ายนี้ถูกยกเลิก</strong> — {refund.void_reason}
          {refund.voided_at && ` (${docDate(refund.voided_at.slice(0, 10))})`}
        </p>
      )}

      <div className="inv-signs">
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้รับเงิน</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {withTitle(payee)} )</span>
        </div>
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้จ่ายเงิน</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {refund.refunded_by_name || signer} )</span>
        </div>
      </div>
    </>
  );
}
