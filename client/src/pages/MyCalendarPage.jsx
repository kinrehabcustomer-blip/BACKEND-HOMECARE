import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import MyCaseModal from '../components/MyCaseModal.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import { CASE_TYPE_LABELS, VISIT_STATE_LABELS, MONTH_LABELS, toBuddhistYear } from '../labels.js';
import { CAL_STATES, dayLabel, timeRange } from '../lib/calendarUi.js';

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

  const load = useCallback((staleCheck) => {
    // ปุ่มรีเฟรชส่ง event ของการคลิกมาเป็นอาร์กิวเมนต์แรก — ใช้เฉพาะตอนที่เป็นฟังก์ชันจริง
    const isStale = typeof staleCheck === 'function' ? staleCheck : () => false;
    setLoading(true);
    return api
      .myCalendar({ year: String(year), month: mm })
      .then((data) => {
        if (isStale()) return; // เปลี่ยนเดือนไปแล้วระหว่างรอ — ของชุดนี้เป็นของเดือนเก่า ทิ้งไป
        setCases(data);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => !isStale() && setError(e.message))
      .finally(() => !isStale() && setLoading(false));
  }, [year, mm]);

  /* ธง cancelled: สลับเดือนไปมาเร็วๆ คำตอบของเดือนเก่าที่มาถึงทีหลังต้องถูกทิ้ง
     ไม่งั้นปฏิทินจะขึ้นงานของอีกเดือนหนึ่งใต้หัวข้อเดือนที่เลือกอยู่ */
  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => { cancelled = true; };
  }, [load]);

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
    <PageRefresh onRefresh={load} busy={loading}>
      <header className="page-head">
        <div>
          <h1>ตารางงานของฉัน</h1>
          <p className="muted">
            {cases
              ? `เดือนนี้คุณมี ${cases.length} วันนัด — กดที่งานเพื่อดูรายละเอียดเคส`
              : 'กดที่งานเพื่อดูรายละเอียดเคส'}
          </p>
        </div>
        {/* cal-nav — ดูคำอธิบายที่ CalendarPage: ปุ่มเลื่อนเดือนไม่ต้องยืดเต็มบรรทัดบนมือถือ */}
        <div className="actions cal-nav">
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

      {/* คำอธิบายสี — ชิปมี 5 สีตามสถานะกะ ฝั่ง admin มีบรรทัดนี้มาตั้งแต่แรก แต่ฝั่งพนักงานไม่มี
          ทั้งที่เป็นฝั่งที่ต้องอ่านสีของตัวเองว่า "กะนี้ยังไม่ได้เช็คอิน" หรือ "กะนี้ขาดงานไปแล้ว" */}
      <div className="cal-legend">
        {CAL_STATES.map((st) => (
          <span key={st} className="cal-legend-item">
            <i className={`cal-swatch visit-${st}`} aria-hidden="true" />
            {VISIT_STATE_LABELS[st]}
          </span>
        ))}
      </div>

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
                {/* หัววัน — โหมดตาราง (จอกว้าง) เห็นแค่ตัวเลข ส่วนบนมือถือปฏิทินกลายเป็นรายการการ์ด
                    การ์ดหนึ่งใบต้องบอกตัวเองได้ว่าเป็นวันอะไร ไม่มีหัวคอลัมน์หรือวันข้างๆ ให้เทียบแล้ว
                    (CSS ซ่อน .cal-date-full/.cal-today-tag ไว้ในโหมดตาราง แล้วสลับกันในโหมดรายการ)
                    ไม่ใช่ปุ่มเหมือนฝั่ง admin เพราะฝั่งพนักงานไม่มีหน้า "งานของวันนี้ทั้งวัน" ให้เปิดต่อ */}
                <div className="cal-day-head">
                  <span className="cal-date">{day}</span>
                  <span className="cal-date-full">{dayLabel(key)}</span>
                  {key === today && <span className="cal-today-tag">วันนี้</span>}
                  {list.length > 0 && <span className="cal-count">{list.length}</span>}
                </div>

                <div className="cal-chips">
                  {list.map((c) => (
                    <button
                      key={`v${c.visit_id}`}
                      type="button"
                      className={`cal-chip visit-${c.state}`}
                      onClick={() => setOpenId(c.case_id)}
                      title={[
                        timeRange(c),
                        c.case_id,
                        CASE_TYPE_LABELS[c.case_type],
                        c.client_name,
                        VISIT_STATE_LABELS[c.state],
                      ].filter(Boolean).join(' · ')}
                    >
                      {/* เวลานัดมาก่อนชื่อ — คำถามแรกของคนที่เปิดตารางงานตัวเองคือ "วันนั้นต้องไปกี่โมง"
                          ฝั่ง admin มีมาตั้งแต่แรก ฝั่งพนักงานกลับไม่มี ทั้งที่เป็นคนที่ต้องไปจริง */}
                      {timeRange(c) && <span className="cal-chip-time">{timeRange(c)}</span>}
                      {c.client_name}
                      <span className="cal-chip-sub">
                        {CASE_TYPE_LABELS[c.case_type]}
                        {/* สถานะเป็นคำ ไม่ใช่แค่สี — ขึ้นเฉพาะโหมดรายการบนมือถือที่ชิปมีที่พอ
                            (ในตารางบนจอกว้าง ชิปสูงสองบรรทัดอยู่แล้ว เพิ่มอีกคำจะล้นช่อง) */}
                        <span className="cal-chip-state"> · {VISIT_STATE_LABELS[c.state]}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {/* วันว่างในโหมดรายการมีได้แค่ "วันนี้" (วันอื่นถูกยุบทิ้ง) — กล่องเปล่าอ่านเหมือนโหลดไม่เสร็จ */}
                {list.length === 0 && <p className="cal-empty-day">ไม่มีงาน</p>}
              </div>
            );
          })}
        </div>
      </div>

      <p className="muted cal-note">
        งานแสดงตาม<strong>วันนัดที่ลงไว้</strong>ในเคส — ถ้าวันไหนควรมีงานแต่ไม่ขึ้น แจ้งผู้จัดการให้ลงวันนัดให้
      </p>

      {openId && <MyCaseModal caseId={openId} onClose={() => setOpenId(null)} />}
    </PageRefresh>
  );
}
