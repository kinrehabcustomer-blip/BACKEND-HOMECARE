import { createPortal } from 'react-dom';
import { SERVICE_KIND_LABELS, VISIT_STATE_LABELS } from '../labels.js';
import { CAL_STATES, timeRange } from '../lib/calendarUi.js';
import { caseCode } from '../lib/patientCode.js';
import { ISSUER, printStamp } from '../lib/issuer.js';

/**
 * ตารางงานฉบับพิมพ์ / PDF (ออกแบบใหม่ 19 พ.ย. 2569 — "อันปัจจุบันดูไม่โอเคเลย")
 *
 * เดิมพิมพ์ปฏิทินบนจอตรงๆ: ช่องละ 2 กะ ที่เหลือเป็นปุ่ม "+N งานที่เหลือ" ซึ่งบนกระดาษกดไม่ได้
 * กะส่วนใหญ่ของวันที่งานแน่นจึงหายไปจากที่พิมพ์ · ชื่อถูกตัด "…" · สีพื้นชมพู/เหลืองจางจนอ่านยากบนเครื่องพิมพ์ขาวดำ
 *
 * ฉบับนี้เป็นเอกสารของกระดาษโดยเฉพาะ (A4 แนวตั้ง):
 *   หัวกระดาษ (โลโก้ · ช่วงเวลา · ตัวกรองที่ใช้ · เวลาที่พิมพ์) → แถบสรุปจำนวนกะแยกสถานะ
 *   → ตารางเดียวทั้งช่วง แบ่งกลุ่มตามวัน ทุกกะครบ ไม่ตัดชื่อ หัวตารางซ้ำทุกหน้า
 *   กรองพนักงาน/ผู้รับบริการคนเดียว = ตัดคอลัมน์นั้นทิ้ง (ชื่ออยู่บนหัวกระดาษแล้ว) เหลือที่ให้ช่องอื่น
 *   สถานะเป็นตัวอักษร + เครื่องหมายรูปทรง อ่านออกบนเครื่องพิมพ์ขาวดำ
 *
 * portal ไปเป็นลูกตรงของ <body> ในชื่อ .print-sheet — CSS ตอนพิมพ์ซ่อนทั้งแอปเหลือแต่ตัวนี้ (กติกาเดียวกับใบแจ้งหนี้)
 * แสดงเฉพาะตอนกดพิมพ์ (CalendarPage) ไม่ค้างใน DOM — ไม่ชนกับสำเนาใบแจ้งหนี้ถ้ามีเปิดอยู่
 */
const kindOf = (c) => (c.service_kind === 'physio' || c.physio_package_id != null ? 'physio' : 'homecare');

const longDay = (key) =>
  new Date(`${key}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export default function CalendarPrintDoc({ title, kicker, rangeText, days, byDay, filters, hideStaff, hideClient }) {
  const all = days.flatMap((d) => byDay.get(d) ?? []);
  const workDays = days.filter((d) => (byDay.get(d) ?? []).length > 0);
  const counts = Object.fromEntries(CAL_STATES.map((s) => [s, all.filter((c) => c.state === s).length]));
  const cols = 4 + (hideStaff ? 0 : 1) + (hideClient ? 0 : 1);

  return createPortal(
    <div className="print-sheet" aria-hidden="true">
      <article className="cal-doc">
        <header className="cal-doc-head">
          <img className="cal-doc-logo" src={ISSUER.docLogo} alt={ISSUER.brand} />
          <div className="cal-doc-title">
            <p className="cal-doc-kicker">{kicker}</p>
            <h1>{title}</h1>
            <p className="cal-doc-range">{rangeText}</p>
          </div>
          <div className="cal-doc-meta">
            <span>พิมพ์เมื่อ {printStamp()}</span>
            <span>{ISSUER.brand}</span>
          </div>
        </header>

        {/* ตัวกรองที่ใช้ตอนพิมพ์ — แผ่นที่ถูกหยิบไปทีหลังต้องบอกได้ว่าเป็นตารางของใคร/อะไร ไม่ใช่ตารางรวม */}
        <dl className="cal-doc-filters">
          {filters.map(([label, value]) => (
            <div key={label} className={value ? 'is-set' : ''}>
              <dt>{label}</dt>
              <dd>{value || 'ทั้งหมด'}</dd>
            </div>
          ))}
        </dl>

        <div className="cal-doc-summary">
          <div className="cal-doc-total">
            <strong>{all.length}</strong>
            <span>กะ · {workDays.length} วันที่มีงาน</span>
          </div>
          {CAL_STATES.map((s) => (
            <div key={s} className={`cal-doc-stat${counts[s] ? '' : ' is-zero'}`}>
              <i className={`cal-doc-mark m-${s}`} aria-hidden="true" />
              <span>{VISIT_STATE_LABELS[s]}</span>
              <strong>{counts[s]}</strong>
            </div>
          ))}
        </div>

        {all.length === 0 ? (
          <p className="cal-doc-empty">ไม่มีกะในช่วงนี้ตามตัวกรองที่เลือก</p>
        ) : (
          <table className="cal-doc-table">
            <colgroup>
              <col className="cd-time" />
              {!hideStaff && <col className="cd-staff" />}
              {!hideClient && <col className="cd-client" />}
              <col className="cd-case" />
              <col className="cd-kind" />
              <col className="cd-state" />
            </colgroup>
            <thead>
              <tr>
                <th>เวลา</th>
                {!hideStaff && <th>พนักงาน</th>}
                {!hideClient && <th>ผู้รับบริการ</th>}
                <th>เคส</th>
                <th>บริการ</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            {workDays.map((d) => {
              const list = byDay.get(d);
              return (
                <tbody key={d} className="cal-doc-day">
                  <tr className="cal-doc-dayrow">
                    <th colSpan={cols} scope="rowgroup">
                      <span>{longDay(d)}</span>
                      <span className="cal-doc-daycount">{list.length} กะ</span>
                    </th>
                  </tr>
                  {list.map((c) => (
                    <tr key={c.visit_id} className={`cal-doc-row is-${c.state}`}>
                      <td className="cd-time">{timeRange(c) ?? <span className="cd-muted">ไม่ระบุเวลา</span>}</td>
                      {!hideStaff && <td>{c.assigned_name ?? <span className="cd-muted">ยังไม่จับคู่พนักงาน</span>}</td>}
                      {!hideClient && <td>{c.client_name ?? '—'}</td>}
                      <td className="cd-code">{caseCode(c.case_id)}</td>
                      <td>{SERVICE_KIND_LABELS[kindOf(c)]}</td>
                      <td className="cd-state">
                        <i className={`cal-doc-mark m-${c.state}`} aria-hidden="true" />
                        {VISIT_STATE_LABELS[c.state]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        )}
      </article>
    </div>,
    document.body,
  );
}
