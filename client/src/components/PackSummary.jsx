import { formatDate } from '../labels.js';
import LineIcon from './LineIcon.jsx';

/**
 * แผงสรุป "ใช้ไปแล้ว X / N" + แถบความคืบหน้า + วันหมดอายุแพ็กนับถอยหลัง (ผู้ใช้ขอ 16 พ.ย. 2569)
 * ใช้สองที่: บนสุดของตารางนัด (CaseVisits) และช่องตารางนัดในหน้าเคส (CaseModal · plain = ไม่มีกรอบซ้อนในการ์ด)
 *
 * used = นัดที่ไปจริงแล้ว · total = จำนวนครั้งของแพ็ก (กายภาพ) หรือกะที่นัดไว้ (Homecare ไม่มีเพดาน)
 * expiresOn = วันสุดท้ายที่ใช้แพ็กได้ (physioQuota) · ใกล้หมด ≤ 14 วัน = ส้ม · เลยแล้ว = แดง
 */
export default function PackSummary({ used, total, unitWord, expiresOn = null, today, plain = false }) {
  const daysLeft = expiresOn
    ? Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5)
    : null;
  return (
    <section className={`pack-summary${plain ? ' is-plain' : ''}`} aria-label="สรุปการใช้แพ็กเกจ">
      <div className="vs-head">
        <span className="vs-used">
          <span className="vs-used-label">ใช้ไปแล้ว</span>
          <strong>{used}</strong>
          <span className="vs-used-total">/ {total} {unitWord}</span>
        </span>
        {expiresOn && (
          <span className={`vs-expiry${daysLeft < 0 ? ' is-over' : daysLeft <= 14 ? ' is-soon' : ''}`}>
            <LineIcon name="calendar" className="vs-expiry-ico" />
            ใช้ได้ถึง {formatDate(expiresOn)}
            <span className="vs-expiry-left">
              {daysLeft < 0 ? `หมดอายุแล้ว ${-daysLeft} วัน` : daysLeft === 0 ? 'วันนี้วันสุดท้าย' : `อีก ${daysLeft} วัน`}
            </span>
          </span>
        )}
      </div>
      {total > 0 && (
        <div className="vs-bar" role="img" aria-label={`ใช้ไปแล้ว ${used} จาก ${total}`}>
          {used > 0 && <span className="vs-seg is-done" style={{ width: `${Math.min(100, (used / total) * 100)}%` }} />}
        </div>
      )}
    </section>
  );
}
