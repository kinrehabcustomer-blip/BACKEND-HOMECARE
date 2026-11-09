import { amountText, bahtText, docDate } from '../labels.js';
import { DocHeader } from './CustomerInvoiceDoc.jsx';
import { withTitle } from '../lib/customerInvoice.js';

/**
 * ใบลดหนี้ (HC-CN…) / ใบเพิ่มหนี้ (HC-DN…) — ทางเดียวที่ปรับยอดของใบแจ้งหนี้ที่ออกแล้ว (server invoices/ledger.js)
 *
 * จัดหน้าตามแบบเอกสารปรับปรุงยอดทั่วไป: มูลค่าตามใบเดิม → ผลต่าง → มูลค่าที่ถูกต้อง พร้อมเหตุผล
 * ยอดก่อน/หลังเป็นสำเนา ณ วันออก (total_before/total_after) ไม่คิดใหม่จากใบปัจจุบัน
 * — ออกใบที่สองทีหลังแล้วใบแรกต้องยังพิมพ์ตัวเลขเดิมของมัน
 */
export default function AdjustmentNoteDoc({ item, note, refund, signer }) {
  const credit = note.kind === 'credit';
  const cancelled = note.status === 'cancelled';
  const lines = note.items?.length > 0 ? note.items : [{ description: note.reason, amount: note.amount }];

  return (
    <>
      <DocHeader
        title={credit ? 'ใบลดหนี้ /Credit Note' : 'ใบเพิ่มหนี้ /Debit Note'}
        copy={cancelled ? 'ยกเลิกแล้ว' : 'สำเนา'}
      />

      <div className="inv-parties">
        <div>
          <p>รหัสผู้รับบริการ : <span className="mono">{item.patient_id ?? '—'}</span></p>
          <p>ชื่อผู้รับบริการ : {item.patient_name ?? '—'}</p>
          <p>ผู้จ่ายเงิน : {note.bill_to_name}</p>
          {note.bill_to_tax_id && <p>เลขผู้เสียภาษี : <span className="mono">{note.bill_to_tax_id}</span></p>}
        </div>
        <div className="inv-parties-right">
          <p>{credit ? 'Credit' : 'Debit'} Note No: <strong className="mono">{note.note_id}</strong></p>
          <p>วันที่ /Date : {docDate(note.issue_date)}</p>
          <p>อ้างอิงใบแจ้งหนี้ /Ref : <span className="mono">{item.invoice_id}</span></p>
          {note.ref_receipt_id && <p>อ้างอิงใบเสร็จ : <span className="mono">{note.ref_receipt_id}</span></p>}
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
            <th>รายการที่{credit ? 'ลด' : 'เพิ่ม'} (Description)</th>
            <th>จำนวนเงิน (Amount)</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td className="inv-c">{i + 1}</td>
              <td>{line.description}</td>
              <td className="inv-r">{amountText(line.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="inv-r">มูลค่าตามใบแจ้งหนี้เดิม/Original Amount</td>
            <td className="inv-r">{amountText(note.total_before)}</td>
          </tr>
          <tr>
            <td colSpan={2} className="inv-r">{credit ? 'ลดลง/Decrease' : 'เพิ่มขึ้น/Increase'}</td>
            <td className="inv-r"><strong>{credit ? '−' : '+'}{amountText(note.amount)}</strong></td>
          </tr>
          <tr>
            <td colSpan={2} className="inv-r">มูลค่าที่ถูกต้อง/Correct Amount</td>
            <td className="inv-r">{amountText(note.total_after)}</td>
          </tr>
          <tr>
            <td colSpan={3} className="inv-r inv-words">( {bahtText(note.amount)} )</td>
          </tr>
        </tfoot>
      </table>

      <p className="inv-line">เหตุผล : {note.reason}</p>
      {refund && (
        <p className="inv-line">
          คืนเงินให้ผู้จ่าย {amountText(refund.amount)} บาท วันที่ {docDate(refund.refunded_at)}
          {refund.method && ` · ${refund.method}`}
          {refund.refund_doc_id && <> · ใบสำคัญจ่าย <span className="mono">{refund.refund_doc_id}</span></>}
          {refund.status === 'voided' && ' (ยกเลิกแล้ว)'}
        </p>
      )}
      {cancelled && (
        <p className="inv-line">
          <strong>เอกสารนี้ถูกยกเลิก</strong> — {note.cancel_reason}
        </p>
      )}

      <div className="inv-signs">
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้รับเอกสาร</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {withTitle(note.bill_to_name)} )</span>
        </div>
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้ออกเอกสาร</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {note.issued_by_name || signer} )</span>
        </div>
      </div>
    </>
  );
}
