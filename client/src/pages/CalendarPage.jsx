import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import CaseModal from '../components/CaseModal.jsx';
import {
  CASE_STATUS_LABELS, CASE_TYPE_LABELS, MONTH_LABELS, POSITION_LABELS, toBuddhistYear,
} from '../labels.js';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/** 'YYYY-MM-DD' จากตัวเลขปี/เดือน/วัน — ประกอบเองไม่ผ่าน toISOString เพราะตัวนั้นแปลงเป็น UTC แล้ววันเพี้ยน */
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const todayISO = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
};

export default function CalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [cases, setCases] = useState([]);
  const [staff, setStaff] = useState([]);
  const [employeeId, setEmployeeId] = useState(''); // '' = ดูตารางรวมทุกคน
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const mm = String(month).padStart(2, '0');
  const today = todayISO();

  useEffect(() => {
    api.assignableEmployees().then(setStaff).catch(() => {});
  }, []);

  useEffect(() => {
    api
      .caseCalendar({ year: String(year), month: mm, employee_id: employeeId })
      .then(setCases)
      .catch((e) => setError(e.message));
  }, [year, mm, employeeId, reloadKey]);

  /** ขยับเดือน — ให้ Date คำนวณข้ามปีให้เอง (ธ.ค. -> ม.ค. ปีถัดไป) */
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

  // ช่องว่างนำหน้าให้วันที่ 1 ตกวันในสัปดาห์ที่ถูกต้อง + จำนวนวันของเดือน (วันที่ 0 ของเดือนถัดไป = วันสุดท้ายของเดือนนี้)
  const leading = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  /**
   * จัดวันนัดเข้าแต่ละวันล่วงหน้าครั้งเดียว แทนการ filter ซ้ำทุกช่องปฏิทิน
   * ทุกเคสมาเป็น "วันนัด" วันเดียว (ทั้ง Homecare และกายภาพ) จึง group ตาม visit_date ได้ตรงๆ
   */
  const byDay = useMemo(() => {
    const map = new Map();
    for (const c of cases) {
      if (!map.has(c.visit_date)) map.set(c.visit_date, []);
      map.get(c.visit_date).push(c);
    }
    return map;
  }, [cases]);

  const selected = staff.find((s) => s.employee_id === employeeId);

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ตารางงาน</h1>
          <p className="muted">
            {selected && <>ตารางของ <strong>{selected.first_name} {selected.last_name}</strong> · </>}
            เดือนนี้มี {cases.length} วันนัด
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => shiftMonth(-1)} aria-label="เดือนก่อนหน้า">←</button>
          <button className="btn" onClick={goToday}>วันนี้</button>
          <button className="btn" onClick={() => shiftMonth(1)} aria-label="เดือนถัดไป">→</button>
        </div>
      </header>

      <div className="toolbar">
        <select
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          aria-label="เลือกพนักงาน"
        >
          <option value="">พนักงานทุกคน</option>
          {staff.map((s) => (
            <option key={s.employee_id} value={s.employee_id}>
              {s.first_name} {s.last_name}
              {s.nickname ? ` (${s.nickname})` : ''} · {POSITION_LABELS[s.position]}
            </option>
          ))}
        </select>
      </div>

      <h2 className="cal-title">{MONTH_LABELS[mm]} {toBuddhistYear(year)}</h2>

      {cases.length === 0 && (
        <p className="notice">
          {selected
            ? `${selected.first_name} ${selected.last_name} ไม่มีงานในเดือนนี้`
            : 'ไม่มีงานในเดือนนี้'}
        </p>
      )}

      {/* จอแคบ: ให้ปฏิทินเลื่อนแนวนอนในกล่องของตัวเอง ไม่ดันทั้งหน้าให้เลื่อนตาม */}
      <div className="table-wrap">
      <div className="cal-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-head">{w}</div>
        ))}

        {/* ช่องว่างก่อนวันที่ 1 — ให้คอลัมน์ตรงกับวันในสัปดาห์ */}
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

              {/* เคสเยอะกว่าที่ช่องรับไหว = เลื่อนดูในช่องได้เลย ไม่ตัดทิ้ง */}
              <div className="cal-chips">
                {list.map((c) => (
                  <button
                    key={`v${c.visit_id}`}
                    type="button"
                    className={`cal-chip case-${c.status}`}
                    onClick={() => setOpenId(c.case_id)}
                    title={[
                      c.case_id,
                      CASE_TYPE_LABELS[c.case_type],
                      c.client_name,
                      c.assigned_name ?? 'ยังไม่จับคู่พนักงาน',
                      CASE_STATUS_LABELS[c.status],
                    ].filter(Boolean).join(' · ')}
                  >
                    {c.assigned_name ?? '— ยังไม่จับคู่ —'}
                    <span className="cal-chip-sub">{c.client_name}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      </div>

      <p className="muted cal-note">
        ทุกเคส (ทั้ง <strong>Homecare</strong> และ <strong>กายภาพบำบัด</strong>) แสดงตาม
        <strong>วันนัดที่ลงไว้</strong>ในหน้าจัดการเคส — เคสที่ยังไม่ลงวันนัดจะไม่ขึ้นบนปฏิทิน
      </p>

      {openId && (
        <CaseModal
          caseId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </>
  );
}
