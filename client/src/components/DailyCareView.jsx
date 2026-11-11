import { DAILY_SECTIONS, bmiOf, dailyValueText, isFilled } from '../lib/dailyCare.js';

/**
 * แสดงรายงานที่บันทึกไว้แล้ว — วาดจากนิยามชุดเดียวกับฟอร์ม (ส่ง sections ชุดเดียวกันเข้ามา)
 *
 * โชว์เฉพาะช่องที่กรอกไว้จริง ไม่วาดช่องว่างทิ้งไว้: ใบหนึ่งมีได้ 80 ช่อง
 * แต่เวรหนึ่งกรอกจริงราว 15–25 ช่อง ถ้าโชว์ครบทุกช่องคนอ่านจะต้องกวาดตาผ่าน "ไม่ได้ระบุ" เต็มหน้า
 * กว่าจะเจอสิ่งที่เปลี่ยนไป ซึ่งเป็นสิ่งเดียวที่เขาเปิดเข้ามาดู
 */
export default function DailyCareView({ report: raw, sections = DAILY_SECTIONS, photoUrl = null, imageUrl = null }) {
  const report = { ...raw, bmi: bmiOf(raw.weight_kg, raw.height_cm) };
  const blocks = sections.map((s) => ({
    key: s.key,
    title: s.title,
    highlight: s.highlight,
    rows: s.fields
      .filter((f) => f.type !== 'photo' && isFilled(report[f.key]))
      .map((f) => [f, dailyValueText(f, report[f.key])])
      .filter(([, text]) => text != null),
  })).filter((s) => s.rows.length > 0);

  return (
    <div className="care-view">
      {blocks.map((b) => (
        <div key={b.key} className={`care-view-block ${b.highlight ? 'is-key' : ''}`}>
          <h5>{b.title}</h5>
          <ul>
            {b.rows.map(([f, text]) => (
              <li key={f.key} className={f.type === 'text' ? 'is-text' : undefined}>
                <span className="field-label">{f.label}</span>
                {/* ข้อความยาวขึ้นบรรทัดตามที่พิมพ์ไว้ — พนักงานเขียนเป็นข้อๆ กันเป็นปกติ */}
                <span className={f.type === 'text' ? 'care-view-text' : ''}>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {imageUrl && report.image_ids?.length > 0 && (
        <div className="care-view-block">
          <h5>รูปภาพแนบ ({report.image_ids.length})</h5>
          <div className="report-images-grid">
            {report.image_ids.map((id) => (
              <a className="report-image" key={id} href={imageUrl(id)} target="_blank" rel="noreferrer">
                <img src={imageUrl(id)} alt="รูปแนบรายงาน" loading="lazy" />
              </a>
            ))}
          </div>
        </div>
      )}

      {report.has_wound_photo && photoUrl && (
        <div className="care-view-block">
          <h5>รูปแผล</h5>
          {/* เปิดรูปเต็มในแท็บใหม่ได้ — บนมือถือรูปย่อในการ์ดเล็กเกินกว่าจะดูลักษณะแผลจริง */}
          <a href={photoUrl} target="_blank" rel="noreferrer" className="care-photo">
            <img src={photoUrl} alt="รูปแผล" loading="lazy" />
          </a>
        </div>
      )}
    </div>
  );
}
