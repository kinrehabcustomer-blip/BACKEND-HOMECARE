import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { MONTH_LABELS, formatDate, toBuddhistYear } from '../labels.js';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/** 'YYYY-MM-DD' ประกอบเอง — ไม่ใช้ toISOString เพราะตัวนั้นแปลงเป็น UTC แล้ววันเพี้ยนข้ามวัน */
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const todayISO = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
};

const VISIT_STATUS_LABELS = { scheduled: 'นัดไว้', done: 'ไปแล้ว', cancelled: 'ไม่ได้ไป' };

/**
 * ลงตารางวันที่จะไปให้บริการของเคสหนึ่งใบ
 *
 * กดวันบนปฏิทิน = จองวันนั้น · กดวันที่จองแล้วซ้ำ = ยกเลิกวันนั้น (วันซ้ำในเคสเดียวถูกกันไว้ที่ DB)
 * target = จำนวนครั้งที่แพ็คเกจกำหนด (เช่น กายภาพ 10 ครั้ง) — ไม่มีก็ลงได้ไม่จำกัด
 */
export default function CaseVisits({ caseId, target = null, readOnly = false }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [visits, setVisits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const mm = String(month).padStart(2, '0');
  const today = todayISO();

  useEffect(() => {
    let cancelled = false;
    api
      .listVisits(caseId)
      .then((v) => !cancelled && setVisits(v))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // ค้นวันนัดจากวันที่ได้ทันที ไม่ต้องไล่ array ซ้ำทุกช่องปฏิทิน
  const byDate = useMemo(() => new Map(visits.map((v) => [v.visit_date, v])), [visits]);

  const booked = visits.filter((v) => v.status !== 'cancelled').length;
  const doneCount = visits.filter((v) => v.status === 'done').length;

  function shiftMonth(delta) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }

  /** ทุก action ใช้ทางเดียวกัน: ยิง API -> ได้รายการล่าสุดกลับมา -> ทับ state */
  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      setVisits(await action());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** กดวันบนปฏิทิน — ยังไม่จอง = จอง, จองแล้ว = ยกเลิก */
  function toggleDay(dateStr) {
    const existing = byDate.get(dateStr);
    if (existing) return run(() => api.deleteVisit(caseId, existing.visit_id));
    return run(() => api.addVisit(caseId, { visit_date: dateStr }));
  }

  const leading = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  return (
    <>
      <div className="visit-head">
        <p className="muted">
          {target
            ? <>จองแล้ว <strong>{booked}</strong> / {target} ครั้ง · ไปแล้ว {doneCount} ครั้ง</>
            : <>จองไว้ <strong>{booked}</strong> วัน · ไปแล้ว {doneCount} วัน</>}
        </p>
        <div className="visit-nav">
          <button type="button" className="btn tiny" onClick={() => shiftMonth(-1)} aria-label="เดือนก่อนหน้า">←</button>
          <span className="visit-month">{MONTH_LABELS[mm]} {toBuddhistYear(year)}</span>
          <button type="button" className="btn tiny" onClick={() => shiftMonth(1)} aria-label="เดือนถัดไป">→</button>
        </div>
      </div>

      {target && booked > target && (
        <p className="notice">จองเกินจำนวนครั้งของแพ็คเกจแล้ว ({booked} จาก {target} ครั้ง)</p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="mini-cal">
        {WEEKDAYS.map((w) => (
          <div key={w} className="mini-cal-head">{w}</div>
        ))}

        {Array.from({ length: leading }, (_, i) => (
          <div key={`pad-${i}`} className="mini-cal-day is-blank" />
        ))}

        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = iso(year, month, day);
          const visit = byDate.get(key);

          return (
            <button
              key={day}
              type="button"
              disabled={busy || readOnly}
              className={`mini-cal-day ${visit ? `is-booked visit-${visit.status}` : ''} ${key === today ? 'is-today' : ''}`}
              onClick={() => toggleDay(key)}
              title={visit ? `${formatDate(key)} — ${VISIT_STATUS_LABELS[visit.status]} (กดเพื่อยกเลิก)` : `จองวันที่ ${formatDate(key)}`}
            >
              {day}
            </button>
          );
        })}
      </div>

      {visits.length === 0 ? (
        <p className="muted visit-empty">ยังไม่ได้ลงวัน — กดวันบนปฏิทินเพื่อจอง</p>
      ) : (
        <ol className="visit-list">
          {visits.map((v, idx) => (
            <li key={v.visit_id} className={`visit-${v.status}`}>
              <span className="visit-seq">ครั้งที่ {idx + 1}</span>
              <span className="visit-date">{formatDate(v.visit_date)}</span>

              {readOnly ? (
                <span className="muted">{VISIT_STATUS_LABELS[v.status]}</span>
              ) : (
                <>
                  <select
                    value={v.status}
                    disabled={busy}
                    onChange={(e) => run(() => api.updateVisit(caseId, v.visit_id, { status: e.target.value }))}
                  >
                    {Object.entries(VISIT_STATUS_LABELS).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn tiny danger-ghost"
                    disabled={busy}
                    onClick={() => run(() => api.deleteVisit(caseId, v.visit_id))}
                  >
                    ลบ
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
