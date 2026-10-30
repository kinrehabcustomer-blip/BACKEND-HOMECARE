import { amountText, bahtText, docDate } from '../labels.js';
import { ISSUER, TRANSFER_PAYMENT_INSTRUCTION, printStamp } from '../lib/issuer.js';
import { customerAddonDescription, customerItemDescription } from '../lib/customerInvoice.js';

/**
 * ตัวเอกสารใบแจ้งหนี้/ใบเสร็จรับเงินของลูกค้า — ใช้ร่วม 2 ที่ให้ตรงกันทุกตัวอักษร (24 ต.ค. 2569)
 *   1. InvoiceModal (ทีมดูบนจอ + พิมพ์)
 *   2. PublicInvoicePage (/bill/:token ลิงก์ที่ส่งเข้า LINE ลูกค้า · ดร.ธงชัย "ส่งบิล/ใบเสร็จเข้า LINE ลูกค้าจาก staff")
 * signer = ชื่อผู้ลงนามช่องผู้ออกเอกสาร (ในระบบ = คนที่พิมพ์ · ลิงก์ลูกค้า = คนที่ออกใบ/รับเงิน)
 */

/** ช่องทางชำระเก็บเป็นข้อความอิสระ (คนกรอกพิมพ์เอง) — เดาจากคำที่พิมพ์มา ไม่เข้าอันไหนถือเป็นเงินสด */
export function channelOf(method) {
  const m = (method ?? '').toLowerCase();
  if (m.includes('โอน') || m.includes('transfer')) return 'transfer';
  if (m.includes('บัตร') || m.includes('credit')) return 'credit';
  return 'cash';
}

/**
 * ยอดแยกตามช่องทางบนใบเสร็จ — บวกจาก "รายการรับชำระทุกใบ" ของใบนี้
 *
 * ของเดิมอ่าน invoices.payment_method (ซึ่งถูกทับด้วยช่องทางของการรับชำระครั้งล่าสุด)
 * แล้วยัดยอดเต็มลงช่องนั้นช่องเดียว — ใบที่มัดจำด้วยเงินสดแล้วโอนส่วนที่เหลือ จึงพิมพ์ออกมาว่า
 * "โอนทั้งจำนวน" ซึ่งไม่ตรงกับเงินที่รับมาจริง และเป็นเอกสารที่ลูกค้าถือไว้เป็นหลักฐาน
 *
 * ยังคงรวมเป็นก้อนต่อช่องทาง ไม่ใช่รายบรรทัด เพราะฟอร์มมีช่องละหนึ่งบรรทัดเท่านั้น
 */
export function paidBy(payments, method, total, status, paidAmount = null) {
  const blank = { cash: '', credit: '', transfer: '' };
  if (status !== 'paid' && !(status === 'cancelled' && Number(paidAmount) > 0)) return blank;

  const sums = { cash: 0, credit: 0, transfer: 0 };
  for (const pmt of payments ?? []) sums[channelOf(pmt.method)] += Number(pmt.amount ?? 0);

  // ใบเก่าที่รับเงินไว้ก่อนระบบเก็บรายการรับชำระแยกใบ — ไม่มีรายการให้บวก ใช้ของเดิมเป็นทางสำรอง
  const recorded = Object.values(sums).reduce((a, b) => a + b, 0);
  if (recorded <= 0) return { ...blank, [channelOf(method)]: amountText(paidAmount ?? total) };

  return {
    cash: sums.cash > 0 ? amountText(sums.cash) : '',
    credit: sums.credit > 0 ? amountText(sums.credit) : '',
    transfer: sums.transfer > 0 ? amountText(sums.transfer) : '',
  };
}

/** ยอดของบรรทัดอุปกรณ์ — ปัดแบบเดียวกับ server/src/lib/addons.js */
export const addonAmount = (a) => Math.round(Number(a.quantity) * Number(a.unit_price) * 100) / 100;

/* อุปกรณ์เสริม — แตกเป็นบรรทัดของตัวเองเมื่อแตกลง (ดูคำอธิบายเต็มใน InvoiceModal) · คืน { addons, serviceAmount } */
export function splitAddons(item) {
  const candidates = !(item.items?.length > 0) ? (item.addons ?? []) : [];
  const sum = Math.round(candidates.reduce((s, a) => s + addonAmount(a), 0) * 100) / 100;
  const addons = Number(item.amount) >= sum ? candidates : [];
  return { addons, serviceAmount: Math.round((Number(item.amount) - (addons.length > 0 ? sum : 0)) * 100) / 100 };
}

export default function CustomerInvoiceDoc({ item, signer }) {
  const isReceipt = item.status === 'paid';
  const isCancelled = item.status === 'cancelled';
  const hasPayment = Number(item.paid_amount ?? 0) > 0;
  const isPaymentProof = isReceipt || (isCancelled && hasPayment);
  const pay = paidBy(item.payments, item.payment_method, item.total, item.status, item.paid_amount);
  const { addons, serviceAmount } = splitAddons(item);
  const printerName = signer ?? '';
  return (
  <>
    <p className="inv-printed">วันที่พิมพ์: {printStamp()}</p>

    <div className="inv-header">
      <div className="inv-logo">
        <img className="inv-logo-kin" src={ISSUER.docLogo} alt={ISSUER.brand} />
      </div>

      <h3 className="inv-title">
        {isPaymentProof ? 'ใบเสร็จรับเงิน /Receipt' : isCancelled ? 'เอกสารยกเลิก /Cancelled' : 'ใบแจ้งหนี้ /Invoice'}
      </h3>
      <p className="inv-copy">{isCancelled ? 'ยกเลิกแล้ว' : 'สำเนา'}</p>

      <p className="inv-org">{ISSUER.brand}</p>
      <p className="inv-org-line">{ISSUER.name}</p>
      <p className="inv-org-line">เลขประจำตัวผู้เสียภาษี {ISSUER.taxId}</p>
      <p className="inv-org-line">{ISSUER.address}</p>
      <p className="inv-org-line">โทร {ISSUER.tel}</p>
      <hr className="inv-rule" />
    </div>

    <div className="inv-parties">
      <div>
        {/* หัวใบและช่องลงนามระบุผู้รับบริการตามบิลจริง — ผู้จ่ายเงินอยู่ที่บรรทัด "ได้รับเงินจาก" บนใบเสร็จ */}
        <p>รหัสผู้รับบริการ : <span className="mono">{item.patient_id ?? '—'}</span></p>
        <p>ชื่อผู้รับบริการ : {item.patient_name ?? '—'}</p>
        {item.bill_to_tax_id && (
          <p>เลขผู้เสียภาษี : <span className="mono">{item.bill_to_tax_id}</span></p>
        )}
      </div>
      <div className="inv-parties-right">
        <p>Bill No: <strong className="mono">{item.invoice_id}</strong></p>
        <p>วันที่ /Date : {docDate(item.issue_date)}</p>
        {item.due_date && <p>ครบกำหนด /Due : {docDate(item.due_date)}</p>}
      </div>
    </div>

    <table className="inv-table">
      <colgroup>
        <col style={{ width: '8%' }} />
        <col />
        <col style={{ width: '14%' }} />
        <col style={{ width: '20%' }} />
      </colgroup>
      <thead>
        <tr>
          <th>No.</th>
          <th>รายการ (Description)</th>
          <th>จำนวน (Qty)</th>
          <th>จำนวนเงิน (Amount)</th>
        </tr>
      </thead>
      {/* ใบที่แตกเป็นรายครั้ง (ออกตามกะที่ไปจริง) พิมพ์ทีละบรรทัด
          ใบแพ็คเกจปกติไม่มี items จึงยังเป็นบรรทัดเดียวเหมือนเดิม */}
      <tbody>
        {item.items?.length > 0 ? (
          item.items.map((line, index) => (
            <tr key={line.seq}>
              <td className="inv-c">{line.seq}</td>
              <td>{customerItemDescription(item, index)}</td>
              <td className="inv-c">{line.quantity}</td>
              <td className="inv-r">{amountText(line.amount)}</td>
            </tr>
          ))
        ) : (
          <>
            <tr>
              <td className="inv-c">1</td>
              <td>{ISSUER.customerServiceDescription}</td>
              <td className="inv-c">1</td>
              <td className="inv-r">{amountText(serviceAmount)}</td>
            </tr>
            {addons.map((a, i) => (
              <tr key={`addon-${i}`}>
                <td className="inv-c">{i + 2}</td>
                <td>
                  {customerAddonDescription(a)}
                  {a.quantity !== 1 && ` (${amountText(a.unit_price)} × ${a.quantity})`}
                </td>
                <td className="inv-c">{a.quantity}</td>
                <td className="inv-r">{amountText(addonAmount(a))}</td>
              </tr>
            ))}
          </>
        )}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3} className="inv-r">ยอดรวมทั้งสิ้น/Total</td>
          <td className="inv-r">{amountText(item.amount)}</td>
        </tr>
        <tr>
          <td colSpan={3} className="inv-r">ส่วนลดที่ได้รับ/Discount</td>
          <td className="inv-r">{amountText(item.discount)}</td>
        </tr>
        <tr>
          <td colSpan={3} className="inv-r">รวมเงิน(หลังหักส่วนลด)/Sub Total</td>
          <td className="inv-r">{amountText(item.total)}</td>
        </tr>
        <tr>
          <td colSpan={3} className="inv-r">
            {isPaymentProof ? 'รับชำระแล้ว/Paid' : isCancelled ? 'สถานะ/Status' : 'ยอดที่ต้องชำระ/Amount Due'}
          </td>
          <td className="inv-r"><strong>{isPaymentProof ? amountText(item.paid_amount ?? item.total) : isCancelled ? 'ยกเลิกแล้ว' : amountText(item.total)}</strong></td>
        </tr>
        {/* ใบที่รับเงินมาบางส่วนแล้ว ต้องอ่านออกจากตัวเอกสารว่ารับไปเท่าไหร่และค้างเท่าไหร่
            ไม่งั้นลูกค้าถือใบที่เขียนยอดเต็มไว้ ทั้งที่จ่ายมัดจำไปแล้ว */}
        {!isCancelled && item.paid_amount > 0 && item.balance > 0 && (
          <>
            <tr>
              <td colSpan={3} className="inv-r">รับชำระแล้ว/Paid</td>
              <td className="inv-r">{amountText(item.paid_amount)}</td>
            </tr>
            <tr>
              <td colSpan={3} className="inv-r">คงเหลือ/Balance</td>
              <td className="inv-r"><strong>{amountText(item.balance)}</strong></td>
            </tr>
          </>
        )}
        {(!isCancelled || hasPayment) && (
          <tr>
            <td colSpan={4} className="inv-r inv-words">
              ( {bahtText(isCancelled ? item.paid_amount : item.balance > 0 && item.paid_amount > 0 ? item.balance : item.total)} )
            </td>
          </tr>
        )}
      </tfoot>
    </table>

    {item.status === 'issued' && Number(item.balance) > 0 && (
      <section className="inv-payment-channel">
        <strong>ช่องทางชำระเงิน</strong>
        <span>{TRANSFER_PAYMENT_INSTRUCTION}</span>
      </section>
    )}

    <p className="inv-methods">
      <span>เงินสด Cash={pay.cash}</span>
      <span>บัตรเครดิต/Credit Card={pay.credit}</span>
      <span>โอน/Transfer={pay.transfer}</span>
    </p>

    {isPaymentProof && <p className="inv-line">ได้รับเงินจาก (Received from) คุณ {item.bill_to_name}</p>}
    <p className="inv-line">หมายเหตุ : {item.note ?? ''}</p>

    <div className="inv-signs">
      <div className="inv-sign">
        <span className="inv-sign-role">ผู้รับบริการ</span>
        <span className="inv-sign-dots">(...................................................)</span>
        <span className="inv-sign-name">( คุณ {item.patient_name ?? item.bill_to_name} )</span>
      </div>
      {/* ผู้ลงนาม = คนที่กำลังสั่งพิมพ์ (บัญชีที่ล็อกอินอยู่) เพราะเป็นคนยื่นเอกสารให้ลูกค้าจริง
          ส่วนคนที่ออกใบ/รับเงินยังถูกบันทึกไว้ใน DB (issued_by/paid_by) สำหรับทำรายงาน */}
      <div className="inv-sign">
        <span className="inv-sign-role">เจ้าหน้าที่การเงิน</span>
        <span className="inv-sign-dots">(...................................................)</span>
        <span className="inv-sign-name">( {printerName} )</span>
      </div>
    </div>
  </>
  );
}
