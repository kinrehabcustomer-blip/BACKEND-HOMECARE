import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import CaseVisitsModal from './CaseVisitsModal.jsx';
import {
  CASE_TYPE_LABELS, CASE_STATUS_LABELS, POSITION_LABELS, GENDER_LABELS, SERVICE_KIND_LABELS,
  formatBaht, formatDate,
} from '../labels.js';

/**
 * ชื่อบริการของเคส — สองสายเก็บคนละที่ (Homecare = รูปแบบ+เกรด, กายภาพ = ชื่อแพ็คเกจ)
 * ไม่อ่าน service_kind ตรงๆ เพราะเคสเก่าที่เปิดก่อนมีสองสายยังเป็น null อยู่ — ดูจากของที่ผูกไว้จริงแทน
 */
const serviceName = (c) => {
  if (c.physio_package_id && c.physio_package_name) {
    return [c.physio_package_name, c.physio_sessions && `${c.physio_sessions} ครั้ง`].filter(Boolean).join(' · ');
  }
  return [c.format_name, c.grade_name].filter(Boolean).join(' · ') || null;
};

/** รวมสองค่าที่คู่กันเป็นบรรทัดเดียว — กรอกมาแค่ค่าเดียวก็ยังแสดงค่านั้นได้ ไม่ต้องรอครบคู่ */
const genderAge = (c) =>
  [GENDER_LABELS[c.patient_gender], c.patient_age != null && `${c.patient_age} ปี`]
    .filter(Boolean)
    .join(' / ');

const weightHeight = (c) =>
  [c.weight_kg != null && `${c.weight_kg} กก.`, c.height_cm != null && `${c.height_cm} ซม.`]
    .filter(Boolean)
    .join(' / ');

function Field({ label, value, mono }) {
  const empty = value == null || value === '' || value === false;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className={`field-value ${mono ? 'mono' : ''} ${empty ? 'is-empty' : ''}`}>
        {empty ? 'ไม่ได้ระบุ' : value}
      </span>
    </div>
  );
}

export default function CaseModal({ caseId, onClose, onChanged }) {
  const [item, setItem] = useState(null);
  const [staff, setStaff] = useState([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [visits, setVisits] = useState([]);      // ใช้แค่สรุปจำนวนบนปุ่ม การจัดการจริงอยู่ใน popup ย่อย
  const [visitsOpen, setVisitsOpen] = useState(false);

  // ดึงเคส รายชื่อพนักงาน และวันนัดพร้อมกัน — จำนวนเคสที่แต่ละคนถืออยู่เปลี่ยนทุกครั้งที่จับคู่/ยกเลิก
  const load = () =>
    Promise.all([api.getCase(caseId), api.assignableEmployees(), api.listVisits(caseId)]).then(
      ([c, list, v]) => {
        setItem(c);
        setStaff(list);
        setVisits(v);
      },
    );

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);

    Promise.all([api.getCase(caseId), api.assignableEmployees(), api.listVisits(caseId)])
      .then(([c, list, v]) => {
        if (cancelled) return;
        setItem(c);
        setStaff(list);
        setVisits(v);
        setPick(c.assigned_to ?? '');
      })
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [caseId]);

  useEffect(() => {
    // popup วันนัดเปิดอยู่ = ให้ Escape ปิดตัวนั้นก่อน ไม่ใช่ปิดทั้งสองชั้นพร้อมกัน
    const onKeyDown = (e) => e.key === 'Escape' && !visitsOpen && onClose();
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose, visitsOpen]);

  /** ทุก action ใช้ทางเดียวกัน: ยิง API -> โหลดเคสใหม่ -> บอกหน้ารายการให้รีเฟรช */
  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // สถานะปลายทาง (ปิด/ยกเลิก) = ล็อกการจับคู่/แก้สถานะไว้ ต้องเปิดเคสใหม่ก่อน
  const terminal = item?.status === 'closed' || item?.status === 'cancelled';
  const status = item?.status;

  // วันที่ยกเลิกไม่นับเป็นนัดที่จองไว้ แต่ยังเก็บไว้เป็นประวัติใน popup
  const bookedVisits = visits.filter((v) => v.status !== 'cancelled').length;
  const doneVisits = visits.filter((v) => v.status === 'done').length;

  /** ยกเลิกเคส — ถามเหตุผล (เว้นว่างได้) แล้วยิง API */
  function cancelCase() {
    const reason = prompt(`ยกเลิกเคส ${item.case_id}?\nระบุเหตุผล (ไม่บังคับ) เช่น ญาติเปลี่ยนใจ / หาพนักงานไม่ได้`, '');
    if (reason === null) return; // กด Cancel ที่กล่อง prompt = ไม่ทำอะไร
    run(() => api.cancelCase(item.case_id, reason.trim() || null));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {!item && !error && <p className="muted modal-loading">กำลังโหลด…</p>}
        {!item && error && <pre className="error modal-loading">{error}</pre>}

        {item && (
          <>
            <header className="modal-head">
              <div>
                <p className="mono muted">{item.case_id}</p>
                <h2>
                  {serviceName(item) ?? <span className="muted">ไม่ระบุบริการ</span>}
                </h2>
                <p className="muted">{item.customer_name ?? item.client_name}</p>
                <span className={`badge case-${item.status}`}>{CASE_STATUS_LABELS[item.status]}</span>
              </div>
              <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
            </header>

            <div className="modal-body">
              {error && <p className="error">{error}</p>}

              <section>
                <h3>รายละเอียดผู้ป่วย</h3>
                <div className="field-grid">
                  <Field label="ชื่อผู้ป่วย" value={item.client_name} />
                  <Field label="เพศ / อายุ" value={genderAge(item)} />
                  <Field label="น้ำหนัก / ส่วนสูง" value={weightHeight(item)} />
                </div>
                <Field label="โรคประจำตัว" value={item.medical_history} />
                <Field label="อาการปัจจุบัน" value={item.current_symptoms} />
                <Field label="อุปกรณ์ / สายต่างๆ" value={item.medical_devices} />
                <Field label="จุดประสงค์ของญาติในการดูแล" value={item.care_goal} />
              </section>

              <section>
                <h3>รายละเอียดการใช้บริการ</h3>
                <div className="field-grid">
                  <Field label="วัน/เวลาที่สะดวกเริ่มใช้บริการ" value={item.service_start_preference} />
                  <Field label="เบอร์ติดต่อคุณญาติ" value={item.client_phone} />
                </div>
                <Field label="ที่อยู่สถานที่ดูแล" value={item.address} />
                <Field
                  label="วัน/เวลาที่สะดวกให้พยาบาลโทรประเมินและรับเคส"
                  value={item.nurse_call_preference}
                />
              </section>

              <section>
                <h3>รายละเอียดเคส</h3>
                <div className="field-grid">
                  <Field label="ประเภทเคส" value={CASE_TYPE_LABELS[item.case_type]} />
                  <Field label="ประเภทบริการ" value={SERVICE_KIND_LABELS[item.service_kind]} />
                  {item.physio_package_id ? (
                    <Field
                      label="แพ็คเกจกายภาพบำบัด"
                      value={[
                        item.physio_package_name,
                        item.physio_sessions && `${item.physio_sessions} ครั้ง`,
                        item.physio_duration_months && `${item.physio_duration_months} เดือน`,
                      ].filter(Boolean).join(' · ')}
                    />
                  ) : (
                    <Field
                      label="บริการ (รูปแบบ / เกรด / ระดับ)"
                      value={[item.format_name, item.grade_name, item.pkg_staff_tier].filter(Boolean).join(' · ')}
                    />
                  )}
                  <Field label="ค่าจ้างที่ได้รับ" value={item.fee != null && formatBaht(item.fee)} />
                  <Field label="วันเริ่ม" value={item.start_date && formatDate(item.start_date)} />
                  <Field label="วันสิ้นสุด" value={item.end_date && formatDate(item.end_date)} />
                  {item.started_at && (
                    <Field label="เริ่มให้บริการเมื่อ" value={formatDate(item.started_at)} />
                  )}
                  {item.status === 'closed' && (
                    <Field label="ปิดเคสเมื่อ" value={item.closed_at && formatDate(item.closed_at)} />
                  )}
                  {item.status === 'cancelled' && (
                    <Field label="ยกเลิกเมื่อ" value={item.cancelled_at && formatDate(item.cancelled_at)} />
                  )}
                </div>
                {item.status === 'cancelled' && <Field label="เหตุผลที่ยกเลิก" value={item.cancel_reason} />}
                <Field label="หมายเหตุ" value={item.note} />
              </section>

              {/* ลงวันที่จะไปให้บริการจริง — ตัวจัดการอยู่ใน popup แยก ตรงนี้โชว์แค่สรุป */}
              <section>
                <h3>วันนัดให้บริการ</h3>
                <div className="visit-summary">
                  <p className="muted">
                    {bookedVisits === 0 ? (
                      'ยังไม่ได้ลงวันนัด'
                    ) : (
                      <>
                        จองไว้ <strong>{bookedVisits}</strong>
                        {item.physio_sessions ? ` / ${item.physio_sessions}` : ''} ครั้ง
                        {' · '}ไปแล้ว {doneVisits} ครั้ง
                      </>
                    )}
                  </p>
                  <button className="btn" onClick={() => setVisitsOpen(true)}>
                    {terminal ? 'ดูวันนัด' : 'ลงวันนัด'}
                  </button>
                </div>
              </section>

              <section>
                <h3>พนักงานที่รับเคส</h3>

                {item.assigned_to ? (
                  <div className="assignee">
                    <div>
                      <strong>{item.assigned_name}</strong>
                      <p className="muted">
                        <span className="mono">{item.assigned_to}</span>
                        {' · '}{POSITION_LABELS[item.assigned_position]}
                        {item.assigned_phone && ` · ${item.assigned_phone}`}
                      </p>
                      <p className="muted">จับคู่เมื่อ {formatDate(item.assigned_at)}</p>
                    </div>
                    {!terminal && (
                      <button
                        className="btn danger-ghost"
                        disabled={busy}
                        onClick={() => run(() => api.unassignCase(item.case_id))}
                      >
                        ยกเลิกการจับคู่
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="muted">ยังไม่มีพนักงานรับเคสนี้</p>
                )}

                {!terminal && (
                  <div className="assign-form">
                    <select value={pick} onChange={(e) => setPick(e.target.value)}>
                      <option value="">— เลือกพนักงาน —</option>
                      {staff.map((e) => (
                        <option key={e.employee_id} value={e.employee_id}>
                          {e.employee_id} · {e.first_name} {e.last_name} ({POSITION_LABELS[e.position]}) · ถืออยู่ {e.active_cases} เคส
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn primary"
                      disabled={busy || !pick || pick === item.assigned_to}
                      onClick={() => run(() => api.assignCase(item.case_id, pick))}
                    >
                      {item.assigned_to ? 'เปลี่ยนพนักงาน' : 'จับคู่พนักงาน'}
                    </button>
                  </div>
                )}
              </section>

              <section className="modal-meta">
                <Field label="สร้างเมื่อ" value={formatDate(item.created_at)} />
                <Field label="แก้ไขล่าสุด" value={formatDate(item.updated_at)} />
              </section>
            </div>

            <footer className="modal-foot">
              <Link className="btn" to={`/cases/${item.case_id}/edit`}>แก้ไขข้อมูล</Link>

              {/* เคสจบแล้ว (ปิด/ยกเลิก) — เหลือแค่เปิดใหม่ */}
              {terminal && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => run(() => api.reopenCase(item.case_id))}
                >
                  เปิดเคสใหม่
                </button>
              )}

              {/* เคสที่ยังทำงานอยู่ — ยกเลิกได้เสมอ */}
              {!terminal && (
                <button className="btn danger-ghost" disabled={busy} onClick={cancelCase}>
                  ยกเลิกเคส
                </button>
              )}

              {/* จับคู่แล้ว รอเริ่ม — ปุ่มหลักคือเริ่มให้บริการ */}
              {status === 'assigned' && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => run(() => api.startCase(item.case_id))}
                >
                  เริ่มให้บริการ
                </button>
              )}

              {/* กำลัง/พร้อมให้บริการ — ปิดเคสได้ (จบตามปกติ) */}
              {(status === 'assigned' || status === 'in_progress') && (
                <button
                  className={`btn ${status === 'in_progress' ? 'primary' : ''}`}
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`ปิดเคส ${item.case_id}?\nเคสจะยังอยู่ในระบบเป็นประวัติ และเปิดใหม่ได้ภายหลัง`)) return;
                    run(() => api.closeCase(item.case_id, new Date().toISOString().slice(0, 10)));
                  }}
                >
                  ปิดเคส
                </button>
              )}
            </footer>

            {/* popup ย่อยของการลงวันนัด — ปิดแล้วดึงข้อมูลใหม่ ตัวเลขสรุปบนปุ่มจะได้ตรง */}
            {visitsOpen && (
              <CaseVisitsModal
                caseItem={item}
                readOnly={terminal}
                onClose={() => {
                  setVisitsOpen(false);
                  load().catch(() => {});
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
