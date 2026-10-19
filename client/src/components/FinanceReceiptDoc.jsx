import { amountText, bahtText, docDate } from '../labels.js';
import { ISSUER } from '../lib/issuer.js';

/**
 * ใบเสร็จรับเงิน ส่วนที่ 2 สำหรับฝ่ายการเงิน / บัญชี — ออกได้เมื่อใบแจ้งหนี้ชำระครบแล้ว
 *
 * คนละใบกับใบเสร็จที่ส่งให้ลูกค้า (ตัวหลักใน InvoiceModal): ใบนี้เป็นสำเนาเก็บเข้าแฟ้มบัญชี
 * จึงจัดหน้าแบบแบบฟอร์มบัญชี — หัวกระดาษมีเลขเอกสาร/รหัสผู้ป่วย/เลขเคสให้ค้นย้อน ตารางแยกส่วนลดกับยอดคงเหลือ
 * และมีช่องลงนามของผู้รับบริการกับเจ้าหน้าที่การเงิน พร้อมที่ประทับตราบริษัท
 *
 * ตัวเลขทุกตัวมาจากใบแจ้งหนี้ใบเดียวกับใบของลูกค้า (lines/pay ที่ InvoiceModal คิดไว้แล้ว)
 * ไม่คิดใหม่ที่นี่ — สองใบของรายการเดียวกันต้องไม่มีวันยอดไม่ตรงกัน
 *
 * lines = [{ description, amount, discount }] · pay = ยอดแยกช่องทาง { cash, credit, transfer } (ข้อความ, ว่าง = ไม่ได้ใช้)
 */
const MIN_ROWS = 10; // เติมบรรทัดว่างให้ตารางสูงเท่ากันทุกใบ — แบบฟอร์มบัญชีเดิมเป็นกรอบสูงตายตัว

export default function FinanceReceiptDoc({ item, lines, pay, cashier }) {
  const paidDate = item.paid_at ?? item.payments?.at(-1)?.paid_at ?? item.issue_date;
  const filler = Math.max(0, MIN_ROWS - lines.length);

  const methods = [
    { key: 'cash', th: 'เงินสด', en: 'Cash' },
    { key: 'credit', th: 'บัตรเครดิต', en: 'Credit' },
    { key: 'transfer', th: 'โอนเงิน', en: 'Transfer' },
  ];

  return (
    <div className="fr-doc">
      <p className="fr-part">ส่วนที่ 2 สำหรับฝ่ายการเงิน / บัญชี</p>

      <div className="fr-box">
        <div className="fr-head">
          <div className="fr-issuer">
            <img className="fr-logo" src={ISSUER.logo} alt={ISSUER.name} />
            <div>
              <p className="fr-org">{ISSUER.name}</p>
              <p>{ISSUER.address}</p>
              <p>โทร {ISSUER.tel}</p>
            </div>
          </div>
          <dl className="fr-meta">
            <dt>วันที่ / Date :</dt><dd>{docDate(paidDate)}</dd>
            <dt>เลขที่เอกสาร / Document No :</dt><dd className="mono">{item.invoice_id}</dd>
            <dt>ชื่อผู้ชำระ / Name :</dt><dd>{item.bill_to_name}</dd>
            {/* รหัสผู้ป่วย (KN…) — ไม่ใช่รหัสผู้ว่าจ้าง ฝ่ายบัญชีค้นย้อนจากแฟ้มผู้ป่วยได้ตรงกว่า (ไม่มีหน้าลูกค้าแล้ว) */}
            <dt>รหัสผู้ป่วย :</dt><dd className="mono">{item.patient_id ?? '—'}</dd>
            <dt>เลขที่เคส :</dt><dd className="mono">{item.case_id ?? '—'}</dd>
            <dt>ที่อยู่ :</dt><dd>{item.bill_to_address || '—'}</dd>
          </dl>
          <div className="fr-title">
            <h3>ใบเสร็จรับเงิน / RECEIPT</h3>
            <p>สำเนา / COPY</p>
          </div>
        </div>

        <table className="fr-table">
          <colgroup>
            <col style={{ width: '8%' }} />
            <col />
            <col style={{ width: '15%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '15%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>ลำดับ<br />NO.</th>
              <th>รายการ<br />DESCRIPTION</th>
              <th>จำนวนเงิน<br />AMOUNT</th>
              <th>ส่วนลด<br />DISCOUNT</th>
              <th>คงเหลือ<br />NET AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="fr-c">{i + 1}</td>
                <td>{l.description}</td>
                <td className="fr-r">{amountText(l.amount)}</td>
                <td className="fr-c">{l.discount > 0 ? amountText(l.discount) : '–'}</td>
                <td className="fr-r">{amountText(l.amount - (l.discount ?? 0))}</td>
              </tr>
            ))}
            {Array.from({ length: filler }, (_, i) => (
              <tr key={`blank-${i}`} className="fr-blank" aria-hidden="true">
                <td /><td /><td /><td /><td />
              </tr>
            ))}
          </tbody>
        </table>

        <div className="fr-total">
          <div>
            <p>จำนวนเงิน / TOTAL AMOUNT IN LETTERS</p>
            <p className="fr-strong">{bahtText(item.total)}</p>
          </div>
          <div className="fr-total-num">
            <p>รวมทั้งสิ้น / TOTAL</p>
            <p className="fr-strong">{amountText(item.total)}</p>
          </div>
        </div>

        <div className="fr-methods">
          <span>วิธีการชำระ :</span>
          {methods.map((m) => (
            <span className="fr-method" key={m.key}>
              <span>{pay[m.key] ? '☑' : '☐'} {m.th}</span>
              <small>{m.en}{pay[m.key] ? ` - ${pay[m.key]} บาท` : ''}</small>
            </span>
          ))}
        </div>

        <div className="fr-signs">
          <div className="fr-sign">
            <span className="fr-sign-name">{item.bill_to_name}</span>
            <span className="fr-sign-role">ชื่อผู้รับบริการ (CLIENT&apos;S SIGNATURE)</span>
          </div>
          <div className="fr-stamp">ตราประทับบริษัท</div>
          <div className="fr-sign">
            <span className="fr-sign-name">{cashier}</span>
            <span className="fr-sign-role">เจ้าหน้าที่การเงิน (CASHIER)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
