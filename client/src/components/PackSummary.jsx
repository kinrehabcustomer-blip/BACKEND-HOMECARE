import { formatDate } from '../labels.js';
import LineIcon from './LineIcon.jsx';

/**
 * แผงสรุป "ใช้ไปแล้ว X / N" + แถบความคืบหน้า + วันหมดอายุแพ็กนับถอยหลัง (ผู้ใช้ขอ 16 พ.ย. 2569)
 * ใช้สองที่: บนสุดของตารางนัด (CaseVisits) และช่องตารางนัดในหน้าเคส (CaseModal · plain = ไม่มีกรอบซ้อนในการ์ด)
 *
 * used = นัดที่ไปจริงแล้ว · total = จำนวนครั้งของแพ็ก (กายภาพ) หรือกะที่นัดไว้ (Homecare ไม่มีเพดาน)
 * expiresOn = วันสุดท้ายที่ใช้แพ็กได้ (physioQuota) · ใกล้หมด ≤ 14 วัน = ส้ม · เลยแล้ว = แดง
 *
 * จัดวางใหม่ 17 พ.ย. 2569 (ผู้ใช้: "หลอดการนับดูไม่สมส่วน") — สามแถวเรียงลง แทนการอัดหัว+ชิปวันหมดอายุไว้บรรทัดเดียว
 *   1) ใช้ไปแล้ว X / N ……… เหลือ M   2) แถบบางเต็มความกว้าง   3) ใช้ได้ถึง … · อีก N วัน
 * จอแคบชิปวันหมดอายุเคยถูกบีบจนตกบรรทัดไม่เป็นระเบียบ และแถบหนา 10px ที่เติมแค่ 15% ดูเป็นก้อนกลมๆ ไม่ใช่หลอด
 */
export default function PackSummary({ used, total, unitWord, expiresOn = null, today, plain = false }) {
  const daysLeft = expiresOn
    ? Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5)
    : null;
  const hasCap = total > 0;
  const left = hasCap ? Math.max(0, total - used) : null;
  const pct = hasCap ? Math.min(100, (used / total) * 100) : 0;
  return (
    <section className={`pack-summary${plain ? ' is-plain' : ''}`} aria-label="สรุปการใช้แพ็กเกจ">
      <div className="vs-head">
        <span className="vs-used">
          <span className="vs-used-label">ใช้ไปแล้ว</span>
          <strong>{used}</strong>
          <span className="vs-used-total">/ {total} {unitWord}</span>
        </span>
        {hasCap && (
          <span className={`vs-left${left === 0 ? ' is-zero' : ''}`}>
            {left === 0 ? 'ครบแล้ว' : <>เหลือ <strong>{left}</strong> {unitWord}</>}
          </span>
        )}
      </div>
      {hasCap && (
        <div className="vs-bar" role="img" aria-label={`ใช้ไปแล้ว ${used} จาก ${total}`}>
          {used > 0 && <span className="vs-seg is-done" style={{ width: `${pct}%` }} />}
        </div>
      )}
      {expiresOn && (
        <p className={`vs-expiry${daysLeft < 0 ? ' is-over' : daysLeft <= 14 ? ' is-soon' : ''}`}>
          <LineIcon name="calendar" className="vs-expiry-ico" />
          <span>ใช้ได้ถึง {formatDate(expiresOn)}</span>
          <span className="vs-expiry-left">
            {daysLeft < 0 ? `หมดอายุแล้ว ${-daysLeft} วัน` : daysLeft === 0 ? 'วันนี้วันสุดท้าย' : `อีก ${daysLeft} วัน`}
          </span>
        </p>
      )}
    </section>
  );
}
