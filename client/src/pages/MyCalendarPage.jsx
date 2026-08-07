import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import MyCaseModal from '../components/MyCaseModal.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import { CASE_TYPE_LABELS, VISIT_STATE_LABELS, MONTH_LABELS, toBuddhistYear } from '../labels.js';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/** 'YYYY-MM-DD' ประกอบเอง — ไม่ใช้ toISOString เพราะแปลงเป็น UTC แล้ววันเพี้ยน */
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const todayISO = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
};

/** ตารางงานของพนักงานภาคสนามเอง — เหมือนหน้าตารางงาน admin แต่เห็นเฉพาะงานตัวเอง และเปิดดูแบบอ่านอย่างเดียว */
export default function MyCalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

  const mm = String(month).padStart(2, '0');
  const today = todayISO();

  const load = useCallback(() => {
    setLoading(true);
    return api
      .myCalendar({ year: String(year), month: mm })
      .then((data) => {
        setCases(data);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [year, mm]);

  useEffect(() => { load(); }, [load]);

  function shiftMonth(delta) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }

  function goToday() {
    const t = new Date();
    setYear(t.getFullYear());
    setMonth(t.getMonth() + 1);
  }

  const leading = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const byDay = useMemo(() => {
    const map = new Map();
    for (const c of cases ?? []) {
      if (!map.has(c.visit_date)) map.set(c.visit_date, []);
      map.get(c.visit_date).push(c);
    }
    return map;
  }, [cases]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ตารางงานของฉัน</h1>
          <p className="muted">
            {cases
              ? `เดือนนี้คุณมี ${cases.length} วันนัด — กดที่งานเพื่อดูรายละเอียดเคส`
              : 'กดที่งานเพื่อดูรายละเอียดเคส'}
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => shiftMonth(-1)} aria-label="เดือนก่อนหน้า">←</button>
          <button className="btn" onClick={goToday}>วันนี้</button>
          <button className="btn" onClick={() => shiftMonth(1)} aria-label="เดือนถัดไป">→</button>
        </div>
      </header>

      {/* error เป็นแถบเหนือปฏิทิน ไม่ทับทั้งหน้า — ปุ่มเลื่อนเดือนต้องยังกดได้
          และเดือนที่โหลดมาได้แล้วต้องยังอ่านต่อได้ ถึงเดือนถัดไปจะโหลดไม่สำเร็จ */}
      <ErrorBar message={error} onRetry={load} busy={loading} />

      <h2 className="cal-title">
        {MONTH_LABELS[mm]} {toBuddhistYear(year)}
        {loading && <span className="muted"> · กำลังโหลด…</span>}
      </h2>

      {cases?.length === 0 && <p className="notice">คุณไม่มีงานในเดือนนี้</p>}

      <div className="table-wrap">
        <div className="cal-grid">
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-head">{w}</div>
          ))}

          {Array.from({ length: leading }, (_, i) => (
            <div key={`pad-${i}`} className="cal-cell is-empty" />
          ))}

          {Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1;
            const key = iso(year, month, day);
            const list = byDay.get(key) ?? [];

            return (
              <div key={day} className={`cal-cell ${key === today ? 'is-today' : ''}`}>
                <span className="cal-date">{day}</span>

                <div className="cal-chips">
                  {list.map((c) => (
                    <button
                      key={`v${c.visit_id}`}
                      type="button"
                      className={`cal-chip visit-${c.state}`}
                      onClick={() => setOpenId(c.case_id)}
                      title={[
                        c.case_id,
                        CASE_TYPE_LABELS[c.case_type],
                        c.client_name,
                        VISIT_STATE_LABELS[c.state],
                      ].filter(Boolean).join(' · ')}
                    >
                      {c.client_name}
                      <span className="cal-chip-sub">{CASE_TYPE_LABELS[c.case_type]}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="muted cal-note">
        งานแสดงตาม<strong>วันนัดที่ลงไว้</strong>ในเคส — ถ้าวันไหนควรมีงานแต่ไม่ขึ้น แจ้งผู้จัดการให้ลงวันนัดให้
      </p>

      {openId && <MyCaseModal caseId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
