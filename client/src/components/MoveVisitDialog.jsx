import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDate } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';
import { timeRange } from '../lib/calendarUi.js';
import { nowMinutes, timesForStart, toMin } from '../lib/visitMove.js';
import { useScrollLock } from '../lib/scrollLock.js';
import TimeComboInput from './TimeComboInput.jsx';
import LineIcon from './LineIcon.jsx';

/**
 * ยืนยันก่อนย้าย/เลื่อนนัด — การย้ายส่ง LINE ถึงพนักงานและญาติ กดพลาดต้องไม่กลายเป็นข้อความถึงลูกค้า
 *
 * ใช้สองที่:
 *   ปฏิทิน — ลากลงช่องวัน/ชั่วโมงแล้ว วันปลายทางมาจากช่องที่วาง (move.to) · เลือกแค่เวลาที่นี่
 *   ตารางนัดในเคส (pickDate) — ไม่มีอะไรให้ลาก จึงเลือกทั้งวันใหม่และเวลาใหม่ในกล่องนี้
 *
 * ออกแบบใหม่ (ผู้ใช้ขอ 16 พ.ย. 2569): เดิมเป็นช่องวันที่ของเบราว์เซอร์ (โชว์ ค.ศ. 23/11/2026 ขัดกับ พ.ศ. ด้านบน)
 *   + ช่องเวลา + บรรทัด "เดิม → ใหม่" ที่ซ้ำกันเองตอนยังไม่เปลี่ยน และข้อความเทาสองบรรทัดซ้อนกัน
 *   ใหม่: ชิปวัน 7 วันรอบวันเดิม (+ "วันอื่น" เปิดปฏิทิน) · ชิปเวลาที่ใช้บ่อย (+ "เวลาอื่น" พิมพ์เอง)
 *   แล้วสรุป "นัดเดิม / นัดใหม่" เป็นกล่องเดียวท้ายฟอร์ม — แตะสองครั้งจบ เห็นผลก่อนกดยืนยัน
 *
 * onConfirm(วันใหม่, เวลาใหม่ หรือ null = เวลาเดิม) · error = เหตุผลที่ server ปฏิเสธ (กล่องยังเปิดให้แก้แล้วกดใหม่)
 */
const WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const DAY_CHIPS = 7;
const TIME_PRESETS = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00'];

// วันที่เป็นข้อความ 'YYYY-MM-DD' — คิดด้วย UTC ล้วน โซนเวลาของเครื่องจะได้ไม่ทำให้วันเลื่อน
const addDays = (key, n) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (key) => WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()];
const dayMonth = (key) => formatDate(key).replace(/\s*\d{4}$/, ''); // "23 พ.ย."
const longDate = (key) => `${weekday(key)} ${formatDate(key)}`;

export default function MoveVisitDialog({ move, busy, today, pickDate = false, error = null, onConfirm, onCancel }) {
  const { visit } = move;
  const [to, setTo] = useState(move.to ?? visit.visit_date);
  // '' = เวลาเดิม · 'HH:MM' = เวลาเริ่มใหม่
  const [start, setStart] = useState(move.times?.planned_start ?? '');
  const [valid, setValid] = useState(true);
  // เวลาที่ไม่อยู่ในชิป (มาจากช่องที่วางในปฏิทิน) = เปิดช่องพิมพ์ไว้ให้เห็นค่าเลย
  const [customTime, setCustomTime] = useState(
    Boolean(move.times?.planned_start) && !TIME_PRESETS.includes(move.times.planned_start),
  );
  const dateRef = useRef(null);
  const [showDateInput, setShowDateInput] = useState(false);

  const times = valid && start ? timesForStart(visit, start) : null;
  const after = times ? { ...visit, ...times } : visit;
  const dateOk = Boolean(to) && to >= today;
  const past = valid && dateOk && to === today && after.planned_start && toMin(after.planned_start) < nowMinutes();
  const unchanged = valid && to === visit.visit_date && (!times || times.planned_start === visit.planned_start);
  const canConfirm = !busy && valid && dateOk && !past && !unchanged;

  /* ชิปวัน: 7 วันเริ่มก่อนวันเดิมสองวัน (คนมักเลื่อนไปใกล้ๆ วันเดิม) แต่ไม่ย้อนก่อนวันนี้ */
  const dayChips = useMemo(() => {
    const from = addDays(visit.visit_date, -2) < today ? today : addDays(visit.visit_date, -2);
    return Array.from({ length: DAY_CHIPS }, (_, i) => addDays(from, i));
  }, [visit.visit_date, today]);
  const otherDay = !dayChips.includes(to);

  /* ชิปเวลา: ชั่วโมงที่ใช้บ่อย · เวลาเดิมอยู่ในชุดเสมอ (ติดป้าย "เดิม") */
  const timeChips = useMemo(() => {
    const set = new Set(TIME_PRESETS);
    if (visit.planned_start) set.add(visit.planned_start);
    return [...set].sort();
  }, [visit.planned_start]);
  const endOf = (s) => timesForStart(visit, s).planned_end;
  const timePast = (s) => to === today && toMin(s) < nowMinutes();
  const activeStart = start || visit.planned_start || '';

  useScrollLock();
  useEffect(() => {
    // Esc ปิดเฉพาะกล่องนี้ — ตารางนัดเปิดซ้อนอยู่บนหน้าเคส ไม่ให้ popup ข้างหลังปิดตาม (ดักช่วง capture แล้วหยุด)
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  /** "วันอื่น" — เปิดปฏิทินของเบราว์เซอร์ตรงๆ · เบราว์เซอร์ที่เปิดเองไม่ได้ โชว์ช่องวันที่ให้กดแทน */
  function openDatePicker() {
    try {
      dateRef.current.showPicker();
    } catch {
      setShowDateInput(true);
      setTimeout(() => dateRef.current?.focus(), 0);
    }
  }

  function pickTime(s) {
    setCustomTime(false);
    setValid(true);
    setStart(s === visit.planned_start ? '' : s);
  }

  // portal ออกไปที่ body — ตอนเปิดจากตารางนัด กล่องนี้อยู่ใน popup ที่ตัดขอบ (overflow) ไว้
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow move-dialog" role="alertdialog" aria-modal="true" aria-labelledby="move-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseCode(visit.case_id)}{visit.vn ? ` · ${visit.vn}` : ''}</p>
            <h2 id="move-title">{pickDate ? 'เลื่อนนัด' : 'ย้ายวันและเวลานัด'}</h2>
            <p className="muted">
              {[visit.client_name, visit.assigned_name ?? 'ยังไม่จับคู่พนักงาน'].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด" disabled={busy}>×</button>
        </header>

        <div className="modal-body">
          {pickDate && (
            <fieldset className="move-section" disabled={busy}>
              <legend className="move-label">วันนัดใหม่</legend>
              <div className="move-days">
                {dayChips.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`move-chip${to === d ? ' is-on' : ''}${d === visit.visit_date ? ' is-orig' : ''}`}
                    aria-pressed={to === d}
                    onClick={() => setTo(d)}
                  >
                    <span className="move-chip-top">{d === today ? 'วันนี้' : weekday(d)}</span>
                    <span className="move-chip-main">{dayMonth(d)}</span>
                    {d === visit.visit_date && <span className="move-chip-tag">เดิม</span>}
                  </button>
                ))}
                <button
                  type="button"
                  className={`move-chip move-chip-other${otherDay ? ' is-on' : ''}`}
                  aria-pressed={otherDay}
                  onClick={openDatePicker}
                >
                  <LineIcon name="calendar" className="move-chip-ico" />
                  <span className="move-chip-main">{otherDay && dateOk ? dayMonth(to) : 'วันอื่น'}</span>
                </button>
              </div>
              {/* ปฏิทินของเบราว์เซอร์ — ปกติซ่อนไว้ (ตัวเลขในช่องเป็น ค.ศ. ตามเครื่อง) ใช้เป็นแค่ตัวเปิดปฏิทิน */}
              <input
                ref={dateRef}
                type="date"
                className={showDateInput ? 'move-date-input' : 'move-date-hidden'}
                min={today}
                value={to}
                onChange={(e) => e.target.value && setTo(e.target.value)}
                aria-label="เลือกวันนัดใหม่จากปฏิทิน"
                tabIndex={showDateInput ? 0 : -1}
              />
            </fieldset>
          )}

          <fieldset className="move-section" disabled={busy}>
            <legend className="move-label">
              เวลาเริ่ม{visit.planned_end ? <span className="muted"> · ความยาวนัดเท่าเดิม</span> : null}
            </legend>
            <div className="move-times">
              {!visit.planned_start && (
                <button
                  type="button"
                  className={`move-chip is-orig${!start && !customTime ? ' is-on' : ''}`}
                  aria-pressed={!start && !customTime}
                  onClick={() => { setCustomTime(false); setValid(true); setStart(''); }}
                >
                  <span className="move-chip-main">ไม่ระบุ</span>
                  <span className="move-chip-tag">เดิม</span>
                </button>
              )}
              {timeChips.map((s) => {
                const on = !customTime && activeStart === s;
                return (
                  <button
                    key={s}
                    type="button"
                    className={`move-chip${on ? ' is-on' : ''}${s === visit.planned_start ? ' is-orig' : ''}`}
                    aria-pressed={on}
                    disabled={timePast(s)}
                    title={timePast(s) ? 'เวลานี้ของวันนี้ผ่านไปแล้ว' : undefined}
                    onClick={() => pickTime(s)}
                  >
                    <span className="move-chip-main">{s}</span>
                    {endOf(s) && <span className="move-chip-sub">ถึง {endOf(s)}</span>}
                    {s === visit.planned_start && <span className="move-chip-tag">เดิม</span>}
                  </button>
                );
              })}
              <button
                type="button"
                className={`move-chip move-chip-other${customTime ? ' is-on' : ''}`}
                aria-pressed={customTime}
                onClick={() => setCustomTime(true)}
              >
                <span className="move-chip-main">เวลาอื่น</span>
              </button>
            </div>
            {customTime && (
              <div className="move-custom-time">
                <label htmlFor="move-confirm-hour" className="sr-only">เวลาเริ่มใหม่</label>
                <TimeComboInput
                  id="move-confirm-hour"
                  value={start}
                  emptyLabel={visit.planned_start ? `เวลาเดิม (${visit.planned_start})` : 'ไม่ระบุเวลา (คงเดิม)'}
                  around={start || visit.planned_start || ''}
                  disabled={busy}
                  onChange={(v, ok) => { setStart(v); setValid(ok); }}
                />
              </div>
            )}
          </fieldset>

          {/* สรุปก่อนกด — เทียบเดิมกับใหม่ในกล่องเดียว ยังไม่เปลี่ยนอะไร = บอกว่าต้องเลือกอะไร แทนการโชว์ค่าซ้ำ */}
          <div className={`move-summary${canConfirm ? ' is-ready' : ''}`} aria-live="polite">
            <div className="move-summary-row is-old">
              <span className="move-summary-label">นัดเดิม</span>
              <span>{longDate(visit.visit_date)} · {timeRange(visit) ?? 'ไม่ระบุเวลา'}</span>
            </div>
            <div className="move-summary-row is-new">
              <span className="move-summary-label">นัดใหม่</span>
              {!dateOk ? (
                <span className="error">เลือกวันนี้หรือวันถัดไป</span>
              ) : unchanged ? (
                <span className="muted">เลือก{pickDate ? 'วันหรือ' : ''}เวลาใหม่ด้านบน</span>
              ) : (
                <strong>{longDate(to)} · {timeRange(after) ?? 'ไม่ระบุเวลา'}</strong>
              )}
            </div>
          </div>

          {past && <p className="error" role="alert">เวลา {after.planned_start} ของวันนี้ผ่านไปแล้ว — เลือกเวลาที่ยังไม่ถึง</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <p className="move-note">
            <LineIcon name="bell" className="text-ico" />
            ยืนยันแล้วระบบแจ้งเลื่อนนัดทาง LINE ถึงพนักงานและญาติที่ผูกไว้ · พนักงานคนเดิม
          </p>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="button" className="btn primary" onClick={() => onConfirm(to, times)} disabled={!canConfirm}>
            {busy ? 'กำลังเลื่อน…' : pickDate ? 'ยืนยันเลื่อนนัด' : 'ยืนยันย้าย'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
