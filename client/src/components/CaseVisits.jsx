import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
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

/**
 * เวลากะที่ใช้จริงซ้ำๆ — กดชิปแทนการพิมพ์
 * การพิมพ์เวลาบนมือถือคือขั้นที่ช้าที่สุดของหน้านี้ (native time picker + AM/PM กรอกผิดง่าย)
 * กะที่ไม่เข้าแบบไหนเลย (เช่น ข้ามเที่ยงคืน) ใช้ "กำหนดเอง" ซึ่งยังเป็นช่องเวลาปกติ
 */
const TIME_PRESETS = [
  { key: 'none', label: 'ไม่ระบุเวลา', start: '', end: '' },
  { key: 'day', label: '08:00–17:00', start: '08:00', end: '17:00' },
  { key: 'late', label: '09:00–18:00', start: '09:00', end: '18:00' },
  { key: 'full', label: '24 ชม.', start: '00:00', end: '23:59' },
];

/** สีของช่องวันบนปฏิทินจากกะทั้งหมดในวันนั้น: มีกะรอ/กำลังทำ = เขียวแบรนด์, เสร็จหมด = เขียวเข้ม, ยกเลิกหมด = แดง */
function dayClass(list) {
  if (!list?.length) return '';
  if (list.some((v) => v.status === 'scheduled')) return 'is-booked visit-scheduled';
  if (list.some((v) => v.status === 'done')) return 'is-booked visit-done';
  return 'is-booked visit-cancelled';
}

/**
 * ปฏิทินลงตารางของเคส — "เลือกวันก่อน แล้วบันทึกทีเดียว"
 *
 * ของเดิมแตะวัน = บันทึกทันทีด้วยค่าที่ตั้งไว้ล่วงหน้าในแถบด้านบน ซึ่งมีปัญหาสามอย่าง:
 * ลืมตั้งค่าก่อนแตะแล้วต้องลบทิ้งทำใหม่ (ไม่มี undo) · ลง 20 กะ = ยิง 20 request ·
 * และรู้ว่ากะชนกับงานอื่นก็ต่อเมื่อบันทึกไปแล้ว
 *
 * ของใหม่: แตะวันเป็นการ "เลือก" (อยู่ในหน้าเว็บล้วนๆ) แก้ไปมาได้จนพอใจ แล้วค่อยกดบันทึกครั้งเดียว
 * ระหว่างเลือกจะเช็คให้ตลอดว่าวันไหนชนกับงานอื่นของคนคนนั้น และวันไหนมีกะเหมือนกันอยู่แล้ว
 *
 * mode='shift' (Homecare)     เลือกคน + เวลาให้กับกะที่กำลังจะลง
 * mode='appointment' (กายภาพ) นับเป็น "ครั้ง" ในคอร์ส ไม่ต้องระบุคน/เวลา
 */
export default function CaseVisits({ caseId, target = null, readOnly = false, mode = 'shift' }) {
  const toast = useToast();
  const isAppt = mode === 'appointment';
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [visits, setVisits] = useState([]);
  const [staff, setStaff] = useState([]);

  // ร่างที่ยังไม่บันทึก — เลือก/ยกเลิกได้อิสระ ไม่มีอะไรถูกเขียนลงฐานข้อมูลจนกว่าจะกดบันทึก
  const [picked, setPicked] = useState(() => new Set());
  const [who, setWho] = useState('');
  const [timeKey, setTimeKey] = useState('none');
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [preview, setPreview] = useState({ conflicts: [], duplicates: [] });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const mm = String(month).padStart(2, '0');
  const today = todayISO();

  const time = timeKey === 'custom' ? custom : TIME_PRESETS.find((p) => p.key === timeKey) ?? TIME_PRESETS[0];
  const plannedStart = isAppt ? '' : time.start;
  const plannedEnd = isAppt ? '' : time.end;

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

  const pickedList = useMemo(() => [...picked].sort(), [picked]);
  const conflictDates = useMemo(
    () => new Set(preview.conflicts.map((c) => c.visit_date)),
    [preview.conflicts],
  );
  const duplicateDates = useMemo(() => new Set(preview.duplicates), [preview.duplicates]);
  // วันที่เลือกไว้ซึ่งมีกะอยู่แล้ว = ลบทิ้งได้ (ปุ่มลบจึงโผล่เฉพาะตอนที่ลบได้จริง)
  const pickedWithVisits = pickedList.filter((d) => byDate.has(d));

  /**
   * ถามฝั่ง server ว่าร่างชุดนี้ชนกับงานอื่นไหม — หน่วงไว้ก่อนยิง
   * ผู้ใช้กดวันรัวๆ ทีละหลายวัน ถ้ายิงทุกครั้งที่แตะจะได้ request ท่วมโดยไม่จำเป็น
   */
  const previewRef = useRef(0);
  useEffect(() => {
    if (pickedList.length === 0) {
      setPreview({ conflicts: [], duplicates: [] });
      return undefined;
    }

    const seq = ++previewRef.current;
    const timer = setTimeout(() => {
      api
        .previewVisits(caseId, {
          dates: pickedList,
          assigned_to: who || null,
          planned_start: plannedStart || null,
          planned_end: plannedEnd || null,
        })
        // ผลของคำขอเก่าที่กลับมาช้ากว่าต้องไม่ทับของใหม่
        .then((r) => seq === previewRef.current && setPreview(r))
        .catch(() => seq === previewRef.current && setPreview({ conflicts: [], duplicates: [] }));
    }, 300);

    return () => clearTimeout(timer);
  }, [caseId, pickedList, who, plannedStart, plannedEnd]);

  /**
   * ทุกคำสั่งคืน "รายการกะล่าสุด" มาให้เสมอ จึงไม่ต้องดึงซ้ำเอง
   * คำสั่งที่เพิ่ม/ลบทีละหลายกะคืนสรุปผลมาด้วย — เอามาบอกผู้ใช้ว่าเกิดอะไรขึ้นจริง
   * (กดบันทึกแล้วหน้าจอนิ่งเพราะซ้ำทั้งหมด จะดูเหมือนปุ่มเสีย)
   *
   * ผลลัพธ์บอกผ่าน toast ไม่ใช่ข้อความในหน้า เพราะบนมือถือปุ่มบันทึกอยู่ท้ายสุด
   * ข้อความที่อยู่เหนือปฏิทินจึงอยู่นอกจอตอนกด — เท่ากับไม่ได้บอกอะไรเลย
   */
  async function run(action, { clearPicked = false } = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (Array.isArray(res)) {
        setVisits(res);
      } else {
        setVisits(res.visits);
        if (res.deleted != null) {
          toast(`ลบ ${res.deleted} กะ${res.kept ? ` · เก็บ ${res.kept} กะที่เช็คอินไปแล้วไว้` : ''}`);
        } else if (res.added != null) {
          toast(`บันทึก ${res.added} กะ${res.skipped ? ` · ข้าม ${res.skipped} วันที่มีกะเหมือนกันอยู่แล้ว` : ''}`);
        }
      }
      if (clearPicked) setPicked(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleDay(dateStr) {
    if (readOnly) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  }

  /** เลือกทั้งเดือนที่กำลังดูอยู่ตามวันในสัปดาห์ (ยังไม่บันทึก — ทบทวนบนปฏิทินได้ก่อน) */
  function pickPattern(weekdays) {
    const days = new Date(year, month, 0).getDate();
    setPicked((prev) => {
      const next = new Set(prev);
      for (let d = 1; d <= days; d += 1) {
        const key = iso(year, month, d);
        if (!weekdays || weekdays.includes(new Date(`${key}T00:00:00Z`).getUTCDay())) next.add(key);
      }
      return next;
    });
  }

  function save() {
    return run(
      () =>
        api.addVisits(caseId, {
          dates: pickedList,
          assigned_to: who || null,
          planned_start: plannedStart || null,
          planned_end: plannedEnd || null,
        }),
      { clearPicked: true },
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

  function shiftMonth(delta) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
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

      {/* ปฏิทินอยู่บนสุด — เป็นสิ่งที่คนเปิดหน้านี้มาดู ฟอร์มค่อยโผล่ตอนเลือกวันแล้ว */}
      <div className="mini-cal">
        {WEEKDAYS.map((w) => <div key={w} className="mini-cal-head">{w}</div>)}

        {Array.from({ length: leading }, (_, i) => (
          <div key={`pad-${i}`} className="mini-cal-day is-blank" />
        ))}

        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = iso(year, month, day);
          const list = byDate.get(key) ?? [];
          const isPicked = picked.has(key);
          const hasConflict = isPicked && conflictDates.has(key);
          const isDuplicate = isPicked && duplicateDates.has(key);

          const existing = list.length
            ? list
                .map((v) => `${[v.planned_start, v.planned_end].filter(Boolean).join('-') || 'ไม่ระบุเวลา'} · ${v.assigned_name ?? 'ไม่ระบุคน'}`)
                .join('\n')
            : '';
          const title = [
            formatDate(key),
            existing,
            hasConflict && 'ชนกับงานอื่นของคนนี้',
            isDuplicate && 'มีกะเหมือนกันอยู่แล้ว — บันทึกแล้วจะถูกข้าม',
          ]
            .filter(Boolean)
            .join('\n');

          return (
            <button
              key={day}
              type="button"
              disabled={busy || readOnly}
              aria-pressed={isPicked}
              className={[
                'mini-cal-day',
                dayClass(list),
                key === today ? 'is-today' : '',
                isPicked ? 'is-picked' : '',
                hasConflict ? 'has-conflict' : '',
                isDuplicate ? 'is-duplicate' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => toggleDay(key)}
              title={title}
            >
              {day}
              {list.length > 0 && <span className="mini-cal-count">{list.length}</span>}
              {hasConflict && <span className="mini-cal-warn" aria-hidden="true">!</span>}
            </button>
          );
        })}
      </div>

      {!readOnly && (
        <div className="pick-presets">
          <span className="muted">เลือกเร็ว:</span>
          <button type="button" className="btn tiny" disabled={busy} onClick={() => pickPattern([1, 2, 3, 4, 5])}>จ–ศ</button>
          <button type="button" className="btn tiny" disabled={busy} onClick={() => pickPattern([0, 6])}>ส–อา</button>
          <button type="button" className="btn tiny" disabled={busy} onClick={() => pickPattern(null)}>ทั้งเดือน</button>
          {picked.size > 0 && (
            <button type="button" className="btn tiny" disabled={busy} onClick={() => setPicked(new Set())}>ล้าง</button>
          )}
        </div>
      )}

      {!readOnly && picked.size === 0 && (
        <p className="muted visit-hint">
          {isAppt ? 'แตะวันบนปฏิทินเพื่อเลือกวันนัด แล้วกดบันทึก' : 'แตะวันบนปฏิทินเพื่อเลือก (แตะซ้ำเพื่อยกเลิก) แล้วตั้งคน/เวลาแล้วกดบันทึก'}
        </p>
      )}

      {/* แถบสรุปร่าง — โผล่เมื่อเลือกวันแล้วเท่านั้น จอเล็กจึงไม่ถูกฟอร์มบังปฏิทินตั้งแต่แรก */}
      {!readOnly && picked.size > 0 && (
        <div className="pick-bar">
          <p className="pick-count">
            เลือกไว้ <strong>{picked.size}</strong> วัน
            {duplicateDates.size > 0 && (
              <span className="cell-sub">{duplicateDates.size} วันมีกะเหมือนกันอยู่แล้ว — จะถูกข้าม</span>
            )}
          </p>

          {!isAppt && (
            <>
              <select value={who} disabled={busy} onChange={(e) => setWho(e.target.value)}>
                <option value="">— พนักงาน (ไม่ระบุ = ผู้รับผิดชอบหลัก) —</option>
                {staff.map((s) => (
                  <option key={s.employee_id} value={s.employee_id}>
                    {s.first_name} {s.last_name} ({POSITION_LABELS[s.position]})
                  </option>
                ))}
              </select>

              <div className="time-chips">
                {TIME_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={`btn tiny ${timeKey === p.key ? 'primary' : ''}`}
                    disabled={busy}
                    onClick={() => setTimeKey(p.key)}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`btn tiny ${timeKey === 'custom' ? 'primary' : ''}`}
                  disabled={busy}
                  onClick={() => setTimeKey('custom')}
                >
                  กำหนดเอง
                </button>
              </div>

              {timeKey === 'custom' && (
                <div className="time-custom">
                  <input type="time" value={custom.start} disabled={busy} title="เวลาเริ่ม"
                    onChange={(e) => setCustom((p) => ({ ...p, start: e.target.value }))} />
                  <span className="muted">–</span>
                  <input type="time" value={custom.end} disabled={busy} title="เวลาเลิก"
                    onChange={(e) => setCustom((p) => ({ ...p, end: e.target.value }))} />
                </div>
              )}
            </>
          )}

          {/* เตือนก่อนบันทึก ไม่ใช่หลังบันทึก — ยังกดบันทึกได้ บางครั้งจงใจซ้อน (แวะสองบ้านติดกัน) */}
          {preview.conflicts.length > 0 && (
            <div className="banner">
              <strong>ชนกับงานอื่น {preview.conflicts.length} รายการ</strong>
              <ul className="conflict-list">
                {preview.conflicts.slice(0, 4).map((c) => (
                  <li key={`${c.visit_date}-${c.other_case_id}`}>
                    {formatDate(c.visit_date)} · {c.employee_name ?? 'ไม่ระบุคน'} มีงานที่ {c.other_client_name}
                    {' ('}<span className="mono">{c.other_case_id}</span>
                    {c.other_start ? ` ${c.other_start}-${c.other_end ?? ''}` : ' ไม่ระบุเวลา'})
                  </li>
                ))}
                {preview.conflicts.length > 4 && (
                  <li className="muted">และอีก {preview.conflicts.length - 4} รายการ</li>
                )}
              </ul>
            </div>
          )}

          <div className="pick-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={save}>
              บันทึก {picked.size} {isAppt ? 'นัด' : 'กะ'}
            </button>
            {pickedWithVisits.length > 0 && (
              <button
                type="button"
                className="btn danger-ghost"
                disabled={busy}
                onClick={() => run(() => api.deleteVisitsOn(caseId, pickedWithVisits), { clearPicked: true })}
              >
                ลบของวันที่เลือก ({pickedWithVisits.length})
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => setPicked(new Set())}>ล้าง</button>
          </div>
        </div>
      )}

      {visits.length === 0 ? (
        <p className="muted visit-empty">ยังไม่ได้นัดกะ{readOnly ? '' : ' — แตะวันบนปฏิทินเพื่อเลือก'}</p>
      ) : (
        <ol className="visit-list">
          {visits.map((v, idx) => {
            const t = [v.planned_start, v.planned_end].filter(Boolean).join('-');
            return (
              <li key={v.visit_id} className={`visit-${v.state}`}>
                <span className="visit-seq">{idx + 1}</span>
                <span className="visit-date">
                  {formatDate(v.visit_date)}{t && ` · ${t}`}
                </span>
                <span className="visit-who muted">
                  {v.assigned_name ?? 'ไม่ระบุคน'}
                  {v.check_in_at && ` · เข้า ${timeText(v.check_in_at)}`}
                  {v.check_out_at && ` · ออก ${timeText(v.check_out_at)}`}
                  {v.location_flagged && <> · <LineIcon name="alert" className="text-ico" />นอกพื้นที่</>}
                  {v.off_schedule && <> · <LineIcon name="alert" className="text-ico" />นอกวันนัด</>}
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
