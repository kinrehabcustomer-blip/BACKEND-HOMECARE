import { useAuth } from '../auth.jsx';
import { ISSUER, printStamp } from '../lib/issuer.js';
import { amountText, bahtText, formatPeriod } from '../labels.js';

/**
 * ใบสรุปค่าตอบแทนพนักงานสำหรับพิมพ์ลงกระดาษ / บันทึกเป็น PDF
 *
 * เป็น "แบบฟอร์ม" ไม่ใช่รายงาน — มีช่องลงชื่อผู้รับเงินท้ายแถวของทุกคน และช่องลงนาม
 * ผู้จัดทำ/ผู้อนุมัติท้ายใบ เพราะสิ่งที่พิมพ์ออกไปจริงๆ คือกระดาษที่ต้องเซ็นกำกับตอนจ่ายเงิน
 * (CSV ตอบอีกคำถามหนึ่ง: เอาตัวเลขไปคิดต่อในโปรแกรมบัญชี — จึงเก็บไว้ทั้งคู่ ไม่ใช่แทนกัน)
 *
 * PDF ใช้เครื่องพิมพ์ของเบราว์เซอร์ (กดพิมพ์ → เลือก "Save as PDF") ไม่ใช้ไลบรารีสร้าง PDF
 * แบบเดียวกับใบแจ้งหนี้ — ฟอนต์ไทยฝังมากับเครื่องอยู่แล้ว ไม่ต้องแบกไฟล์ฟอนต์เข้ามาใน bundle
 *
 * ตัวใบถูกซ่อนบนจอ (ดู .payroll-doc ใน index.css) เพราะตารางบนหน้าบอกเรื่องเดียวกัน
 * และกดดูรายเคสต่อได้ ซึ่งกระดาษทำไม่ได้ — ใบนี้มีไว้ตอนสั่งพิมพ์อย่างเดียว
 */
export default function PayrollSummaryDoc({ month, rows }) {
  const { user } = useAuth();
  if (!rows?.length) return null;

  // ชื่อผู้จัดทำ = คนที่กำลังสั่งพิมพ์ (session ส่ง first_name/last_name แยกกันมา ไม่มีฟิลด์รวม)
  const printerName = [user?.first_name, user?.last_name].filter(Boolean).join(' ');
  const [year, mm] = month.split('-');

  const sum = (field) => rows.reduce((s, r) => s + Number(r[field] ?? 0), 0);
  const totalPay = sum('pay');

  return (
    /* aria-hidden: บนจอมันถูกซ่อนอยู่ ไม่ควรถูกอ่านซ้ำกับตารางจริงโดยโปรแกรมอ่านหน้าจอ */
    <div className="payroll-doc" aria-hidden="true">
      <p className="inv-printed">วันที่พิมพ์: {printStamp()}</p>

      <div className="inv-header">
        <div className="inv-logo">
          <img src={ISSUER.logo} alt={ISSUER.name} />
        </div>
        <h3 className="inv-title">ใบสรุปค่าตอบแทนพนักงาน /Payroll Summary</h3>
        <p className="inv-org">{ISSUER.name}</p>
        <p className="inv-org-line">{ISSUER.address}</p>
        <p className="inv-org-line">Tel. {ISSUER.tel}</p>
        <hr className="inv-rule" />
      </div>

      <div className="inv-parties">
        <div>
          <p>ประจำเดือน : <strong>{formatPeriod(year, mm)}</strong></p>
        </div>
        <div className="inv-parties-right">
          <p>จำนวนพนักงาน : {rows.length} คน</p>
        </div>
      </div>

      <table className="inv-table payroll-doc-table">
        <thead>
          <tr>
            <th className="pd-no">ลำดับ</th>
            <th className="pd-code">รหัส</th>
            <th>ชื่อ–สกุล</th>
            <th className="pd-num">กะ</th>
            <th className="pd-num">ชั่วโมง</th>
            <th className="pd-num">เคส</th>
            <th className="pd-money">ค่าจ้างที่ปล่อย</th>
            <th className="pd-money">จ่ายแล้ว</th>
            <th className="pd-money">ค้างจ่าย</th>
            {/* ช่องเซ็นรับเงิน — เว้นว่างไว้ให้เขียนด้วยมือ คือเหตุผลที่ใบนี้ต้องเป็นกระดาษ */}
            <th className="pd-sign">ลงชื่อผู้รับเงิน</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.employee_id}>
              <td className="inv-c">{i + 1}</td>
              <td className="inv-c mono">{r.employee_id}</td>
              <td>{r.employee_name}</td>
              <td className="inv-c">{r.shifts}</td>
              {/* ชั่วโมงเป็นทศนิยมหลักเดียว ไม่ใช่ "8 ชม. 30 น." — บนกระดาษต้องเอาไปบวกต่อด้วยมือได้ */}
              <td className="inv-c">{(r.minutes / 60).toFixed(1)}</td>
              <td className="inv-c">{r.cases_worked}</td>
              <td className="inv-r">{amountText(r.pay)}</td>
              <td className="inv-r">{amountText(r.paid_pay ?? 0)}</td>
              <td className="inv-r">{amountText(r.unpaid_pay ?? 0)}</td>
              <td className="pd-sign" />
            </tr>
          ))}
        </tbody>
        <tfoot>
          {/* แถวรวมเป็น <td> ไม่ใช่ <th> — กฎของฟอร์ม (".inv-table th" จัดกึ่งกลาง) ชนะคลาส
              .inv-r/.inv-c ที่ติดไว้ทีละช่อง ตัวเลขเงินในแถวรวมจะไม่ตรงแนวกับแถวข้างบน */}
          <tr>
            <td colSpan={3} className="inv-r"><strong>รวม {rows.length} คน</strong></td>
            <td className="inv-c"><strong>{sum('shifts')}</strong></td>
            <td className="inv-c"><strong>{(sum('minutes') / 60).toFixed(1)}</strong></td>
            <td className="inv-c"><strong>{sum('cases_worked')}</strong></td>
            <td className="inv-r"><strong>{amountText(totalPay)}</strong></td>
            <td className="inv-r"><strong>{amountText(sum('paid_pay'))}</strong></td>
            <td className="inv-r"><strong>{amountText(sum('unpaid_pay'))}</strong></td>
            <td className="pd-sign" />
          </tr>
          {/* ยอดเป็นตัวหนังสือกำกับตัวเลข — กติกาเดียวกับใบเสร็จ กันแก้ตัวเลขทีหลังด้วยปากกา */}
          <tr>
            <td colSpan={10} className="inv-words">( {bahtText(totalPay)} )</td>
          </tr>
        </tfoot>
      </table>

      <p className="inv-line">
        หมายเหตุ : ยอด “ค่าจ้างที่ปล่อย” คือค่าจ้างที่อนุมัติให้จ่ายในเดือนนี้ ส่วน “จ่ายแล้ว”
        นับเฉพาะรอบจ่ายที่ปิดแล้ว
      </p>

      <div className="inv-signs">
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้จัดทำ</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {printerName} )</span>
        </div>
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้อนุมัติจ่าย</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( ................................. )</span>
        </div>
      </div>
    </div>
  );
}
