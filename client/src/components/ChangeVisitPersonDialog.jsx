import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { POSITION_LABELS, formatDate } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';
import { timeRange } from '../lib/calendarUi.js';
import { useScrollLock } from '../lib/scrollLock.js';
import SearchSelect from './SearchSelect.jsx';
import LineIcon from './LineIcon.jsx';

/**
 * เปลี่ยนคนไปนัด — กดชื่อพนักงานในแถวนัดของตารางนัด (ผู้ใช้ขอ 16 พ.ย. 2569: นักกายภาพติดธุระ ให้อีกคนไปแทน
 * รอบแรกทำเป็นกล่องในแถบเลือกวัน แล้วผู้ใช้บอกว่ายังใช้ยาก ให้อยู่ที่แถวนัดแทน)
 *
 * เลือกคนจากทีมของเคส (ชิป) หรือคนนอกทีม (ช่องค้นหา · ไปแทนชั่วคราว ไม่ต้องเพิ่มเข้าทีม)
 * ติ๊ก "นัดถัดไปทั้งหมดของคนเดิม" = เปลี่ยนทั้งชุด (คนเดิมลาออก/ลายาว)
 * ตรวจชนกับงานอื่นของคนใหม่ก่อนกด (เตือน ไม่บล็อก — กติกาเดียวกับตอนลงนัด)
 * server แจ้ง LINE ถึงคนเดิม (ถอดงาน) และคนใหม่ (ได้งาน) ไม่แจ้งญาติ
 *
 * onConfirm(รหัสพนักงานคนใหม่, รายการนัดที่จะเปลี่ยน)
 */
export default function ChangeVisitPersonDialog({ visit, caseId, team, outsiders, followUps, busy, error, onConfirm, onCancel }) {
  const [to, setTo] = useState('');
  const [all, setAll] = useState(false);
  const [conflicts, setConflicts] = useState(null); // null = ยังไม่ตรวจ / กำลังตรวจ
  const targets = all ? [visit, ...followUps] : [visit];
  const people = [...team, ...outsiders];
  const nameOf = (id) => {
    const s = people.find((p) => p.employee_id === id);
    return s ? `${s.first_name} ${s.last_name}`.trim() : '';
  };
  const outsiderPicked = to && outsiders.some((p) => p.employee_id === to);

  useScrollLock();
  useEffect(() => {
    // Esc ปิดเฉพาะกล่องนี้ ไม่ให้ตารางนัดข้างหลังปิดตาม
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  /* ตรวจว่าคนใหม่มีงานอื่นชนวัน/เวลานั้นไหม — ใช้ตัวตรวจเดียวกับตอนลงนัด (preview ไม่เขียนอะไร)
     นัดหลายเวลาในชุดเดียว: ตรวจทีละกลุ่มเวลา แล้วรวมผล */
  const targetKey = targets.map((v) => v.visit_id).join(',');
  useEffect(() => {
    if (!to) { setConflicts(null); return undefined; }
    let cancelled = false;
    setConflicts(null);
    const groups = new Map();
    for (const v of targets) {
      const k = `${v.planned_start ?? ''}|${v.planned_end ?? ''}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v.visit_date);
    }
    Promise.all([...groups.entries()].map(([k, dates]) => {
      const [s, e] = k.split('|');
      return api.previewVisits(caseId, { dates, assigned_to: to, planned_start: s || null, planned_end: e || null })
        .then((r) => r.conflicts ?? []);
    }))
      .then((lists) => !cancelled && setConflicts(lists.flat().filter((c) => c.other_case_id !== caseId)))
      .catch(() => !cancelled && setConflicts([]));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, targetKey, caseId]);

  const canConfirm = !busy && Boolean(to) && to !== visit.assigned_to;

  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow move-dialog" role="alertdialog" aria-modal="true" aria-labelledby="swap-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseCode(caseId)}{visit.vn ? ` · ${visit.vn}` : ''}</p>
            <h2 id="swap-title">เปลี่ยนคนไปนัด</h2>
            <p className="muted">
              {formatDate(visit.visit_date)}{timeRange(visit) ? ` · ${timeRange(visit)}` : ''} · ตอนนี้: <strong>{visit.assigned_name ?? 'ยังไม่ระบุคน'}</strong>
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด" disabled={busy}>×</button>
        </header>

        <div className="modal-body">
          {team.length > 0 && (
            <fieldset className="move-section" disabled={busy}>
              <legend className="move-label">ทีมของเคสนี้</legend>
              <div className="swap-people">
                {team.map((p) => {
                  const current = p.employee_id === visit.assigned_to;
                  return (
                    <button
                      key={p.employee_id}
                      type="button"
                      className={`move-chip swap-person${to === p.employee_id ? ' is-on' : ''}${current ? ' is-orig' : ''}`}
                      aria-pressed={to === p.employee_id}
                      disabled={current}
                      title={current ? 'คนที่ไปนัดนี้อยู่แล้ว' : undefined}
                      onClick={() => setTo(p.employee_id)}
                    >
                      <span className="move-chip-main">
                        {p.dotClass && <i className={`vp-dot ${p.dotClass}`} aria-hidden="true" />}
                        {p.first_name} {p.last_name}
                      </span>
                      <span className="move-chip-sub">{POSITION_LABELS[p.position] ?? ''}</span>
                      {current && <span className="move-chip-tag">คนเดิม</span>}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {outsiders.length > 0 && (
            <fieldset className="move-section" disabled={busy}>
              <legend className="move-label">หรือคนนอกทีม <span className="muted">· ไปแทนชั่วคราว ไม่ต้องเพิ่มเข้าทีม</span></legend>
              <SearchSelect
                value={outsiderPicked ? to : ''}
                onChange={(e) => e.target.value && setTo(e.target.value)}
                aria-label="เลือกคนนอกทีมไปแทน"
              >
                <option value="">— ค้นหาชื่อพนักงาน —</option>
                {outsiders.map((p) => (
                  <option key={p.employee_id} value={p.employee_id}>
                    {p.first_name} {p.last_name} ({POSITION_LABELS[p.position] ?? p.position})
                  </option>
                ))}
              </SearchSelect>
            </fieldset>
          )}

          {followUps.length > 0 && (
            <label className="swap-all">
              <input type="checkbox" checked={all} disabled={busy} onChange={(e) => setAll(e.target.checked)} />
              <span>
                เปลี่ยนนัดถัดไปทั้งหมดของ {visit.assigned_name ?? 'คนเดิม'} ในเคสนี้ด้วย
                <span className="muted"> ({followUps.length} นัด · ถึง {formatDate(followUps[followUps.length - 1].visit_date)})</span>
              </span>
            </label>
          )}

          <div className={`move-summary${canConfirm ? ' is-ready' : ''}`} aria-live="polite">
            <div className="move-summary-row">
              <span className="move-summary-label">คนไปใหม่</span>
              {to ? <strong>{nameOf(to)}</strong> : <span className="muted">เลือกคนที่จะไปแทนด้านบน</span>}
            </div>
            <div className="move-summary-row">
              <span className="move-summary-label">จำนวน</span>
              <span>{targets.length} นัด{targets.length > 1 ? ` (${formatDate(targets[0].visit_date)} – ${formatDate(targets[targets.length - 1].visit_date)})` : ''} · วันและเวลาเดิม</span>
            </div>
          </div>

          {to && conflicts?.length > 0 && (
            <div className="banner">
              <strong>{nameOf(to)} มีงานอื่นชน {conflicts.length} รายการ</strong>
              <ul className="conflict-list">
                {conflicts.slice(0, 4).map((c) => (
                  <li key={`${c.visit_date}-${c.other_case_id}`}>
                    {formatDate(c.visit_date)} · {c.other_client_name} (<span className="mono">{caseCode(c.other_case_id)}</span>
                    {c.other_start ? ` ${c.other_start}-${c.other_end ?? ''}` : ' ไม่ระบุเวลา'})
                  </li>
                ))}
                {conflicts.length > 4 && <li className="muted">และอีก {conflicts.length - 4} รายการ</li>}
              </ul>
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <p className="move-note">
            <LineIcon name="bell" className="text-ico" />
            ยืนยันแล้วระบบแจ้ง LINE ถึงคนเดิม (ถอดงาน) และคนใหม่ (ได้งาน) · ไม่แจ้งญาติ
          </p>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="button" className="btn primary" disabled={!canConfirm} onClick={() => onConfirm(to, targets)}>
            {busy ? 'กำลังเปลี่ยน…' : to ? `เปลี่ยนเป็น ${nameOf(to).split(' ')[0]}${targets.length > 1 ? ` (${targets.length})` : ''}` : 'เปลี่ยนคน'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
