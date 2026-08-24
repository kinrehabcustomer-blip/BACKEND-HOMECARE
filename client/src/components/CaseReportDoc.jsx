import { useAuth } from '../auth.jsx';
import { ISSUER, printStamp } from '../lib/issuer.js';
import { formatDate } from '../labels.js';
import { TEXTS, vitalChips } from './CaseReports.jsx';
import DailyCareView from './DailyCareView.jsx';
import { usesDailyRecord, usesPhysioRecord, DAILY_SECTIONS, PHYSIO_SECTIONS } from '../lib/dailyCare.js';

/** ป้ายกำกับใบที่ไม่ใช่รอบปกติ — บนกระดาษไม่มีสีให้ดู จึงต้องเป็นคำ */
const TYPE_LABELS = { incident: 'ผิดปกติ', change: 'มีการเปลี่ยนแปลง' };

/** เวลาเดียวกับที่แถวบนจอใช้: เวลาที่วัด ถ้าไม่ได้กรอกก็เวลาที่กดบันทึก */
const rowTime = (r) => r.report_time ?? r.created_at?.slice(11, 16) ?? '—';

/**
 * แบบฟอร์มรายงานอาการผู้ป่วยของเคสหนึ่งใบ สำหรับพิมพ์ / บันทึกเป็น PDF
 *
 * ใบนี้คือของที่ต้องส่งออกนอกระบบ — ญาติขอดูย้อนหลัง แพทย์ขอประวัติการดูแลไปประกอบการตรวจ
 * หรือเก็บเข้าแฟ้มเคสตอนปิดเคส ซึ่งทั้งหมดทำจากหน้าจอไม่ได้ (ต้องมีหัวเอกสาร ชื่อศูนย์ และลายเซ็น)
 *
 * วาดจากนิยามชุดเดียวกับบนจอทั้งหมด (DailyCareView / VITALS / TEXTS ของ CaseReports)
 * ใบที่พิมพ์จึงมีเนื้อหาตรงกับที่เห็นเสมอ ไม่ใช่โครงที่สองที่ต้องตามแก้คู่กันไปตลอด
 *
 * PDF ใช้เครื่องพิมพ์ของเบราว์เซอร์ (กดพิมพ์ → เลือก "Save as PDF") แบบเดียวกับใบแจ้งหนี้
 * ตัวใบถูกซ่อนบนจอ (ดู .report-doc ใน index.css) โผล่เฉพาะตอนสั่งพิมพ์
 *
 * รูปแผลไม่ลงกระดาษ — ตอนกดพิมพ์รูปยังโหลดไม่เสร็จ จะได้กรอบว่างแทน
 * และใบนี้มีไว้อ่านเนื้อหา ไม่ใช่แทนการดูรูปจริงในระบบ
 */
export default function CaseReportDoc({ caseItem, reports }) {
  const { user } = useAuth();
  if (!caseItem || !reports?.length) return null;

  const printerName = [user?.first_name, user?.last_name].filter(Boolean).join(' ');
  const structured = usesPhysioRecord(caseItem) || usesDailyRecord(caseItem);
  const sections = usesPhysioRecord(caseItem) ? PHYSIO_SECTIONS : DAILY_SECTIONS;

  /* เรียงเก่า→ใหม่บนกระดาษ ตรงข้ามกับบนจอ — หน้าจอคือ "มีอะไรใหม่" (ใหม่สุดอยู่บน)
     ส่วนกระดาษคืออ่านเป็นลำดับเหตุการณ์ตั้งแต่ต้นจนจบ เหมือนแฟ้มประวัติทั่วไป */
  const ordered = [...reports].sort((a, b) =>
    `${a.report_date} ${rowTime(a)}`.localeCompare(`${b.report_date} ${rowTime(b)}`),
  );

  return (
    <div className="report-doc" aria-hidden="true">
      <p className="inv-printed">วันที่พิมพ์: {printStamp()}</p>

      <div className="inv-header">
        <div className="inv-logo">
          <img src={ISSUER.logo} alt={ISSUER.name} />
        </div>
        <h3 className="inv-title">แบบฟอร์มรายงานอาการผู้ป่วย /Patient Care Report</h3>
        <p className="inv-org">{ISSUER.name}</p>
        <p className="inv-org-line">{ISSUER.address}</p>
        <p className="inv-org-line">Tel. {ISSUER.tel}</p>
        <hr className="inv-rule" />
      </div>

      {/* หัวใบ: ใครถูกดูแล ในเคสไหน ช่วงไหน — ใบที่หลุดออกไปนอกระบบต้องอ่านออกด้วยตัวเอง */}
      <table className="inv-table report-doc-head">
        <tbody>
          <tr>
            <th>รหัสเคส</th>
            <td className="mono">{caseItem.case_id}</td>
            <th>บริการ</th>
            <td>{caseItem.title}</td>
          </tr>
          <tr>
            <th>ชื่อผู้ป่วย</th>
            <td>{caseItem.client_name ?? '—'}</td>
            <th>ผู้ดูแลที่รับเคส</th>
            <td>{caseItem.assigned_name ?? '—'}</td>
          </tr>
          <tr>
            <th>ช่วงเวลา</th>
            <td>
              {caseItem.start_date ? formatDate(caseItem.start_date) : '—'}
              {' – '}
              {caseItem.end_date ? formatDate(caseItem.end_date) : 'ปัจจุบัน'}
            </td>
            <th>จำนวนรายงานในใบนี้</th>
            <td>{ordered.length} ใบ</td>
          </tr>
        </tbody>
      </table>

      {ordered.map((r, i) => (
        <section className="report-doc-item" key={r.report_id}>
          <h4 className="report-doc-item-head">
            ครั้งที่ {i + 1} · {formatDate(r.report_date)} เวลา {rowTime(r)} น.
            {r.report_type && r.report_type !== 'routine' && ` · (${TYPE_LABELS[r.report_type] ?? r.report_type})`}
            <span className="report-doc-by">ผู้บันทึก: {r.reported_by_name ?? '—'}</span>
          </h4>

          {structured ? (
            <DailyCareView report={r} sections={sections} photoUrl={null} />
          ) : (
            <>
              {vitalChips(r).length > 0 && (
                <ul className="report-doc-vitals">
                  {vitalChips(r).map(([label, value, unit]) => (
                    <li key={label}>
                      <span className="field-label">{label}</span>
                      <span>{value}{unit ? ` ${unit}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
              {TEXTS.filter((t) => r[t.key]).map((t) => (
                <p className="report-doc-text" key={t.key}>
                  <strong>{t.label}:</strong> {r[t.key]}
                </p>
              ))}
            </>
          )}
        </section>
      ))}

      <div className="inv-signs">
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้จัดทำเอกสาร</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( {printerName} )</span>
        </div>
        <div className="inv-sign">
          <span className="inv-sign-role">ผู้รับเอกสาร</span>
          <span className="inv-sign-dots">(...................................................)</span>
          <span className="inv-sign-name">( ................................. )</span>
        </div>
      </div>
    </div>
  );
}
