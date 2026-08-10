import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import {
  POSITION_LABELS, VISIT_STATE_LABELS, MONTH_LABELS, formatBaht, formatDate, timeText, toBuddhistYear,
} from '../labels.js';
import LineIcon from './LineIcon.jsx';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/** 'YYYY-MM-DD' ประกอบเอง — ไม่ใช้ toISOString เพราะแปลงเป็น UTC แล้ววันเพี้ยน */
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const todayISO = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
};

/** สีของช่องวันบนปฏิทินจากกะทั้งหมดในวันนั้น: มีกะรอ/กำลังทำ = เขียวแบรนด์, เสร็จหมด = เขียวเข้ม, ยกเลิกหมด = แดง */
function dayClass(list) {
  if (!list?.length) return '';
  if (list.some((v) => v.status === 'scheduled')) return 'is-booked visit-scheduled';
  if (list.some((v) => v.status === 'done')) return 'is-booked visit-done';
  return 'is-booked visit-cancelled';
}

/**
 * ปฏิทินลงตารางของเคส — มี 2 โหมด:
 *   mode='shift' (Homecare)       กดวัน = เพิ่ม "กะ" (วัน+เวลา+พนักงาน) รองรับหลายกะ/วัน/หลายคน
 *   mode='appointment' (กายภาพ)   กดวัน = จอง/ยกเลิก "นัด" เข้าคอร์ส (วันละ 1 นัด นับ X/N ครั้ง) ไม่ต้องระบุคน/เวลา
 * ไม่ระบุพนักงาน = ใช้ผู้รับผิดชอบหลักของเคส · ลบทีละรายการที่ลิสต์ด้านล่าง
 */
export default function CaseVisits({ caseId, target = null, readOnly = false, mode = 'shift' }) {
  const isAppt = mode === 'appointment';
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [visits, setVisits] = useState([]);
  const [staff, setStaff] = useState([]);
  // ค่าที่จะใช้ตอนกดวันบนปฏิทิน (คงไว้ข้ามการกด เพื่อเพิ่มหลายกะเร็วๆ)
  const [pick, setPick] = useState({ assigned_to: '', planned_start: '', planned_end: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // ลงกะเป็นช่วง — เปิดเมื่อผู้ใช้กด ไม่กางค้างไว้ เพราะการกดวันทีละวันยังเป็นทางหลักของเคสสั้นๆ
  const [bulkOpen, setBulkOpen] = useState(false);
  const [range, setRange] = useState({ from: '', to: '', weekdays: [] });
  const [notice, setNotice] = useState(null);   // ผลของครั้งล่าสุด (เพิ่มกี่กะ ข้ามกี่กะ)
  const [conflicts, setConflicts] = useState([]); // กะที่ชนกับงานอื่นของคนเดียวกัน (เตือน ไม่บล็อก)

  const mm = String(month).padStart(2, '0');
  const today = todayISO();

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listVisits(caseId), api.assignableEmployees()])
      .then(([v, s]) => {
        if (cancelled) return;
        setVisits(v);
        setStaff(s);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const byDate = useMemo(() => {
    const map = new Map();
    for (const v of visits) {
      if (!map.has(v.visit_date)) map.set(v.visit_date, []);
      map.get(v.visit_date).push(v);
    }
    return map;
  }, [visits]);

  const booked = visits.filter((v) => v.status !== 'cancelled').length;
  const doneCount = visits.filter((v) => v.state === 'done').length;

  function shiftMonth(delta) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }

  /**
   * ทุกคำสั่งคืน "รายการกะล่าสุด" มาให้เสมอ จึงไม่ต้องดึงซ้ำเอง
   * คำสั่งที่เพิ่ม/ลบทีละหลายกะคืนเป็นอ็อบเจ็กต์พร้อมสรุปผล — เอามาบอกผู้ใช้ว่าเกิดอะไรขึ้นจริง
   * (กด "สร้างช่วง" แล้วหน้าจอนิ่งเพราะซ้ำทั้งหมด จะดูเหมือนปุ่มเสีย)
   */
  async function run(action) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await action();
      if (Array.isArray(res)) {
        setVisits(res);
        setConflicts([]);
        return;
      }

      setVisits(res.visits);
      setConflicts(res.conflicts ?? []);
      if (res.deleted != null) {
        setNotice(`ลบ ${res.deleted} กะ${res.kept ? ` · เก็บ ${res.kept} กะที่เช็คอินไปแล้วไว้` : ''}`);
      } else if (res.added != null) {
        setNotice(`เพิ่ม ${res.added} กะ${res.skipped ? ` · ข้าม ${res.skipped} กะที่มีอยู่แล้ว` : ''}`);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const toggleWeekday = (d) =>
    setRange((p) => ({
      ...p,
      weekdays: p.weekdays.includes(d) ? p.weekdays.filter((x) => x !== d) : [...p.weekdays, d],
    }));

  /**
   * กดวันบนปฏิทิน:
   *   โหมดนัด (กายภาพ) = จอง/ยกเลิกแบบ toggle (วันละ 1 นัด) ไม่ต้องระบุคน/เวลา
   *   โหมดกะ (Homecare) = เพิ่มกะวันนั้นด้วยพนักงาน/เวลาที่ตั้งไว้ด้านบน (เพิ่มซ้ำได้)
   */
  function handleDay(dateStr) {
    if (readOnly) return;
    if (isAppt) {
      const existing = byDate.get(dateStr);
      if (existing?.length) return run(() => api.deleteVisit(caseId, existing[0].visit_id));
      return run(() => api.addVisit(caseId, { visit_date: dateStr }));
    }
    return run(() =>
      api.addVisit(caseId, {
        visit_date: dateStr,
        assigned_to: pick.assigned_to || null,
        planned_start: pick.planned_start || null,
        planned_end: pick.planned_end || null,
      }),
    );
  }

  /**
   * ตั้งค่าจ้างเฉพาะกะนี้ (ว่าง = กลับไปเกลี่ยจากยอดเคส) — บันทึกตอนออกจากช่อง
   * ค่าไม่เปลี่ยนก็ไม่ยิง ไม่งั้นแค่คลิกผ่านช่องก็เขียน DB ทุกครั้ง
   */
  function savePay(v, raw) {
    const text = raw.trim();
    const value = text === '' ? null : Number(text);
    if (value != null && !Number.isFinite(value)) return;
    if ((v.staff_pay ?? null) === value) return;
    return run(() => api.updateVisit(caseId, v.visit_id, { staff_pay: value }));
  }

  const leading = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  return (
    <>
      <div className="visit-head">
        <p className="muted">
          {isAppt ? (
            <>นัดแล้ว <strong>{booked}</strong>{target ? ` / ${target}` : ''} ครั้ง · ไปแล้ว {doneCount} ครั้ง</>
          ) : (
            <>นัดไว้ <strong>{booked}</strong> กะ · เสร็จ {doneCount} กะ</>
          )}
        </p>
        <div className="visit-nav">
          <button type="button" className="btn tiny" onClick={() => shiftMonth(-1)} aria-label="เดือนก่อนหน้า">←</button>
          <span className="visit-month">{MONTH_LABELS[mm]} {toBuddhistYear(year)}</span>
          <button type="button" className="btn tiny" onClick={() => shiftMonth(1)} aria-label="เดือนถัดไป">→</button>
        </div>
      </div>

      {target && booked > target && (
        <p className="notice">นัดเกินจำนวนครั้งของแพ็คเกจแล้ว ({booked} จาก {target} ครั้ง)</p>
      )}
      {error && <p className="error">{error}</p>}

      {/* ตั้งพนักงาน/เวลาของกะที่จะเพิ่ม แล้วกดวันบนปฏิทิน (เว้นว่างได้ = ผู้รับผิดชอบหลัก ไม่ระบุเวลา) — เฉพาะโหมดกะ */}
      {!readOnly && !isAppt && (
        <div className="shift-form">
          <select
            value={pick.assigned_to}
            disabled={busy}
            onChange={(e) => setPick({ ...pick, assigned_to: e.target.value })}
          >
            <option value="">— พนักงาน (ไม่ระบุ = ผู้รับผิดชอบหลัก) —</option>
            {staff.map((s) => (
              <option key={s.employee_id} value={s.employee_id}>
                {s.first_name} {s.last_name} ({POSITION_LABELS[s.position]})
              </option>
            ))}
          </select>
          <input type="time" value={pick.planned_start} disabled={busy} title="เวลาเริ่ม"
            onChange={(e) => setPick({ ...pick, planned_start: e.target.value })} />
          <input type="time" value={pick.planned_end} disabled={busy} title="เวลาเลิก"
            onChange={(e) => setPick({ ...pick, planned_end: e.target.value })} />
        </div>
      )}

      {!readOnly && (
        <p className="muted visit-hint">
          {isAppt
            ? 'กดวันบนปฏิทินเพื่อจองนัด · กดวันที่จองแล้วอีกครั้งเพื่อยกเลิก'
            : 'กดวันบนปฏิทินเพื่อเพิ่มกะ · กดซ้ำวันเดิมได้ถ้ามีหลายกะ/หลายคน'}
          {!isAppt && (
            <>
              {' · '}
              <button type="button" className="btn link-btn" onClick={() => setBulkOpen((v) => !v)}>
                {bulkOpen ? 'ปิดการลงเป็นช่วง' : 'ลงกะเป็นช่วง'}
              </button>
            </>
          )}
        </p>
      )}

      {/* ลงกะทั้งเดือนในครั้งเดียว — ใช้พนักงาน/เวลาที่ตั้งไว้ด้านบนชุดเดียวกับการกดทีละวัน
          วันในสัปดาห์ไม่เลือกเลย = ทุกวันในช่วง (ตรงกับที่ server ตีความ) */}
      {!readOnly && !isAppt && bulkOpen && (
        <div className="bulk-visit">
          <div className="bulk-row">
            <label>ตั้งแต่
              <input type="date" value={range.from} disabled={busy}
                onChange={(e) => setRange((p) => ({ ...p, from: e.target.value }))} />
            </label>
            <label>ถึง
              <input type="date" value={range.to} disabled={busy}
                onChange={(e) => setRange((p) => ({ ...p, to: e.target.value }))} />
            </label>
          </div>

          <div className="bulk-days">
            {WEEKDAYS.map((w, d) => (
              <button
                key={w}
                type="button"
                className={`btn tiny ${range.weekdays.includes(d) ? 'primary' : ''}`}
                disabled={busy}
                onClick={() => toggleWeekday(d)}
              >
                {w}
              </button>
            ))}
            <span className="muted">{range.weekdays.length === 0 && 'ไม่เลือก = ทุกวันในช่วง'}</span>
          </div>

          <div className="bulk-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !range.from || !range.to}
              onClick={() =>
                run(() =>
                  api.addVisits(caseId, {
                    from: range.from,
                    to: range.to,
                    weekdays: range.weekdays,
                    assigned_to: pick.assigned_to || null,
                    planned_start: pick.planned_start || null,
                    planned_end: pick.planned_end || null,
                  }),
                )
              }
            >
              สร้างกะในช่วงนี้
            </button>
            <button
              type="button"
              className="btn danger-ghost"
              disabled={busy || !range.from || !range.to}
              onClick={() => run(() => api.deleteVisitRange(caseId, { from: range.from, to: range.to }))}
            >
              ลบกะในช่วงนี้
            </button>
          </div>
        </div>
      )}

      {notice && <p className="notice">{notice}</p>}

      {/* กะที่ชนกับงานอื่นของคนเดียวกัน — เตือนอย่างเดียว บางครั้งจงใจซ้อน (แวะสองบ้านติดกัน) */}
      {conflicts.length > 0 && (
        <div className="banner">
          <strong>กะซ้อนกัน {conflicts.length} รายการ</strong>
          <ul className="conflict-list">
            {conflicts.slice(0, 5).map((c) => (
              <li key={`${c.visit_id}-${c.other_case_id}`}>
                {formatDate(c.visit_date)}
                {c.planned_start && ` ${c.planned_start}-${c.planned_end ?? ''}`}
                {' · '}{c.employee_name ?? 'ไม่ระบุคน'} มีงานที่ {c.other_client_name}
                {' ('}<span className="mono">{c.other_case_id}</span>
                {c.other_start ? ` ${c.other_start}-${c.other_end ?? ''}` : ' ไม่ระบุเวลา'})
              </li>
            ))}
            {conflicts.length > 5 && <li className="muted">และอีก {conflicts.length - 5} รายการ</li>}
          </ul>
        </div>
      )}

      <div className="mini-cal">
        {WEEKDAYS.map((w) => <div key={w} className="mini-cal-head">{w}</div>)}

        {Array.from({ length: leading }, (_, i) => (
          <div key={`pad-${i}`} className="mini-cal-day is-blank" />
        ))}

        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = iso(year, month, day);
          const list = byDate.get(key) ?? [];
          const title = list.length
            ? (isAppt
                ? `${formatDate(key)} — จองแล้ว (กดเพื่อยกเลิก)`
                : list.map((v) => `${[v.planned_start, v.planned_end].filter(Boolean).join('-') || 'ไม่ระบุเวลา'} · ${v.assigned_name ?? 'ไม่ระบุคน'}`).join('\n'))
            : `${isAppt ? 'จองนัด' : 'เพิ่มกะ'}วันที่ ${formatDate(key)}`;

          return (
            <button
              key={day}
              type="button"
              disabled={busy || readOnly}
              className={`mini-cal-day ${dayClass(list)} ${key === today ? 'is-today' : ''}`}
              onClick={() => handleDay(key)}
              title={title}
            >
              {day}
              {list.length > 1 && <span className="mini-cal-count">{list.length}</span>}
            </button>
          );
        })}
      </div>

      {visits.length === 0 ? (
        <p className="muted visit-empty">ยังไม่ได้นัดกะ{readOnly ? '' : ' — กดวันบนปฏิทินเพื่อเพิ่ม'}</p>
      ) : (
        <ol className="visit-list">
          {visits.map((v, idx) => {
            const time = [v.planned_start, v.planned_end].filter(Boolean).join('-');
            return (
              <li key={v.visit_id} className={`visit-${v.state}`}>
                <span className="visit-seq">{idx + 1}</span>
                <span className="visit-date">
                  {formatDate(v.visit_date)}{time && ` · ${time}`}
                </span>
                <span className="visit-who muted">
                  {v.assigned_name ?? 'ไม่ระบุคน'}
                  {v.check_in_at && ` · เข้า ${timeText(v.check_in_at)}`}
                  {v.check_out_at && ` · ออก ${timeText(v.check_out_at)}`}
                  {v.location_flagged && <> · <LineIcon name="alert" className="text-ico" />นอกพื้นที่</>}
                </span>
                <span className={`badge visit-${v.state}`}>{VISIT_STATE_LABELS[v.state]}</span>
                {/* ค่าจ้างของกะนี้ — ว่างไว้ = เกลี่ยจากยอดเคส (ตัวเลขที่เกลี่ยได้โชว์เป็น placeholder)
                    กรอกทับได้เมื่อกะนั้นตกลงกันเป็นพิเศษ เช่น ไปครึ่งวัน หรือค่าเดินทางเพิ่ม */}
                {readOnly ? (
                  v.effective_pay != null && <span className="visit-pay muted">{formatBaht(v.effective_pay)}</span>
                ) : (
                  <input
                    type="number"
                    min="0"
                    step="10"
                    className="visit-pay-input"
                    title="ค่าจ้างของกะนี้ — เว้นว่าง = เกลี่ยจากค่าจ้างของเคส"
                    disabled={busy}
                    defaultValue={v.staff_pay ?? ''}
                    placeholder={v.effective_pay == null ? '฿ ค่าจ้าง' : `฿${Math.round(v.effective_pay)}`}
                    onBlur={(e) => savePay(v, e.target.value)}
                  />
                )}
                {!readOnly && (
                  <button
                    type="button"
                    className="btn tiny danger-ghost"
                    disabled={busy}
                    onClick={() => run(() => api.deleteVisit(caseId, v.visit_id))}
                  >
                    ลบ
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
