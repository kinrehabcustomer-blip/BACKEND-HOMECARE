import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import CaseLocationLink from './CaseLocationLink.jsx';
import ReportArchiveModal from './ReportArchiveModal.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import { SERVICE_KIND_LABELS, serviceKindOf, GENDER_LABELS, VISIT_STATE_LABELS, formatDate, timeText, caseStage, todayTH } from '../labels.js';
import { formatPhone } from '../lib/phone.js';
import { caseCode } from '../lib/patientCode.js';

/** ชื่อบริการของเคส — กายภาพใช้ชื่อแพ็คเกจ, Homecare ใช้รูปแบบ+เกรด (ใช้ร่วมกันหลายหน้าของ field) */
export const serviceName = (c) => {
  if (c.physio_package_id && c.physio_package_name) {
    return [c.physio_package_name, c.physio_sessions && `${c.physio_sessions} ครั้ง`].filter(Boolean).join(' · ');
  }
  return [c.format_name, c.grade_name].filter(Boolean).join(' · ') || SERVICE_KIND_LABELS[serviceKindOf(c)];
};

function Field({ label, value }) {
  const empty = value == null || value === '' || value === false;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className={`field-value ${empty ? 'is-empty' : ''}`}>{empty ? 'ไม่ได้ระบุ' : value}</span>
    </div>
  );
}

/**
 * popup รายละเอียดเคส (อ่านอย่างเดียว) สำหรับพนักงานภาคสนาม
 * ดึงจาก /api/my/cases/:id ซึ่งกรองให้เห็นเฉพาะเคสของตัวเอง และไม่มีข้อมูลการเงิน
 */
export default function MyCaseModal({ caseId, onClose }) {
  const sheetRef = useSheetSwipe(onClose); // จอแคบ: ปัดลงเพื่อปิด
  // รหัสของผู้ใช้ที่ล็อกอินอยู่ — ใช้ตัดสินว่ารายงานใบไหนเป็นของตัวเอง (จึงจะกดแก้ได้)
  const me = useAuth()?.user?.employee_id ?? null;
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);
  const [visitsOpen, setVisitsOpen] = useState(false);   // ตารางนัดเต็มใน popup แยก
  const [reportsOpen, setReportsOpen] = useState(false); // ประวัติการรักษาเต็มใน popup แยก
  const [history, setHistory] = useState(null);          // สรุปประวัติการรักษา { total, abnormal, latest }
  const [historyError, setHistoryError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.myCase(caseId).then((c) => !cancelled && setItem(c)).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [caseId]);

  /* ดึงแค่ใบล่าสุดใบเดียว — ได้ทั้งจำนวนรวม (total) และรายเดือน (นับใบผิดปกติ) มาในคำขอเดียว
     ไม่ต้องโหลดทั้งคลังมาเพื่อเขียนบรรทัดสรุปบรรทัดเดียว */
  const loadHistory = useCallback(() => {
    api
      .myPatientReports(caseId, { per_page: 1 })
      .then((res) => {
        setHistory({
          total: res.total,
          abnormal: (res.months ?? []).reduce((sum, m) => sum + (m.abnormal ?? 0), 0),
          latest: res.data?.[0] ?? null,
        });
        setHistoryError(null);
      })
      .catch((e) => setHistoryError(e.message));
  }, [caseId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  useScrollLock();
  useEffect(() => {
    // popup ที่เปิดซ้อนอยู่ = Esc ปิดแค่ชั้นบน (มันจัดการเอง) ไม่ใช่ปิดหน้าเคสทั้งใบไปด้วย
    const onKeyDown = (e) => e.key === 'Escape' && !visitsOpen && !reportsOpen && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, visitsOpen, reportsOpen]);

  const isPhysio = item && (item.service_kind === 'physio' || item.physio_package_id != null);
  const visitWord = isPhysio ? 'นัด' : 'กะ';
  // นัดถัดไป = ใบแรกที่ยังไม่จบ (รอเช็คอิน/กำลังทำงาน) — รายการเรียงตามวันอยู่แล้ว
  const nextVisit = item?.visits.find((v) => v.state === 'scheduled' || v.state === 'working') ?? null;

  /* กะของฉันที่ลงรายงานย้อนหลังได้ — เกณฑ์เดียวกับหน้า "รายงานของฉัน" และที่ server ตรวจซ้ำ
     (กะของตัวเอง · ถึงวันแล้ว · ไม่ถูกยกเลิก · เคสยังไม่จบ) ใหม่สุดขึ้นก่อน เพราะส่วนใหญ่ลืมลงของเมื่อวาน */
  const closed = item ? ['closed', 'cancelled'].includes(item.status) : true;
  const backfillVisits = item && !closed
    ? item.visits.filter((v) => v.assigned_to === me && v.visit_date <= todayTH() && v.status !== 'cancelled').reverse()
    : [];
  const openHistory = (adding) => setReportsOpen(adding ? 'add' : 'view');

  const genderAge = item
    ? [GENDER_LABELS[item.patient_gender], item.patient_age != null && `${item.patient_age} ปี`].filter(Boolean).join(' / ')
    : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal my-case-modal" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {!item && !error && <p className="muted modal-loading">กำลังโหลด…</p>}
        {!item && error && <pre className="error modal-loading">{error}</pre>}

        {item && (
          <>
            <header className="modal-head">
              {/* ชื่อผู้รับบริการขึ้นนำ — คือสิ่งที่พนักงานใช้จำเคส (บริการ/รหัสเป็นบรรทัดรอง) */}
              <div>
                <h2>{item.client_name}</h2>
                <p className="muted my-case-sub">{serviceName(item)} · <span className="mono">{caseCode(item.case_id)}</span></p>
                <span className={`badge case-${caseStage(item).key}`}>{caseStage(item).label}</span>
              </div>
              <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
            </header>

            <div className="modal-body">
              <section>
                <h3>ผู้รับการดูแล</h3>
                <div className="field-grid">
                  <Field label="เพศ / อายุ" value={genderAge} />
                  <Field label="หมู่เลือด" value={item.patient_blood_type} />
                </div>
                {/* แพ้ยา/แพ้อาหาร/หมู่เลือด อ่านสดจากแฟ้มผู้รับบริการ — ไม่มีสำเนาในเคส
                    ถ้ารอให้เคสคัดลอกไว้ ข้อมูลที่พยาบาลเพิ่งอัปเดตจะไปไม่ถึงคนที่กำลังจะเข้าบ้าน */}
                {(item.patient_allergies || item.patient_food_allergies) && (
                  <p className="allergy-alert">
                    {item.patient_allergies && <>แพ้ยา: {item.patient_allergies}</>}
                    {item.patient_allergies && item.patient_food_allergies && ' · '}
                    {item.patient_food_allergies && <>แพ้อาหาร: {item.patient_food_allergies}</>}
                  </p>
                )}

                <Field label="โรคประจำตัว" value={item.patient_medical_history ?? item.medical_history} />
                {/* แฟ้มผู้รับบริการถูกแก้หลังเปิดเคส — โชว์ของล่าสุด แต่บอกด้วยว่าตอนเปิดเคสบันทึกไว้ว่าอะไร */}
                {item.medical_history_stale && (
                  <p className="notice">
                    ข้อมูลโรคประจำตัวเป็นของล่าสุดจากแฟ้มผู้รับบริการ (ตอนเปิดเคสบันทึกไว้ว่า:{' '}
                    {item.medical_history || 'ไม่ได้ระบุ'})
                  </p>
                )}
                <Field label="อาการปัจจุบัน" value={item.current_symptoms} />
                {item.medical_devices && <Field label="อุปกรณ์ / สายต่างๆ" value={item.medical_devices} />}
                <Field label="จุดประสงค์ในการดูแล" value={item.care_goal} />
              </section>

              <section>
                <h3>สถานที่ / ติดต่อ</h3>
                <Field label="ที่อยู่สถานที่ดูแล" value={item.address} />
                <CaseLocationLink key={`${item.geo_lat},${item.geo_lng}`} item={item} />
                {/* เบอร์ญาติแตะโทรได้เลย — พนักงานหน้าบ้านต้องโทรหาญาติบ่อย ไม่ควรต้องจำเบอร์ไปกดเอง */}
                <Field
                  label="เบอร์ติดต่อญาติ"
                  value={item.client_phone && (
                    <a className="link my-case-tel" href={`tel:${String(item.client_phone).replace(/[^\d+]/g, '')}`}>
                      {formatPhone(item.client_phone)}
                    </a>
                  )}
                />
              </section>

              <section>
                <h3>รายละเอียดการให้บริการ</h3>
                <div className="field-grid">
                  <Field label="ประเภทบริการ" value={SERVICE_KIND_LABELS[serviceKindOf(item)]} />
                  <Field label="บริการ" value={serviceName(item)} />
                  <Field label="วันเริ่ม" value={item.start_date && formatDate(item.start_date)} />
                  <Field label="วันสิ้นสุด" value={item.end_date && formatDate(item.end_date)} />
                </div>
              </section>

              {/* ที่นี่คือ "ประวัติ" อย่างเดียว — อ่านของทุกคนในเคสได้ (ผลัดเวรต้องรู้ว่ากะก่อนหน้าเจออะไร)
                  แต่การบันทึกอยู่ที่หน้างานวันนี้ที่เดียว เพราะรายงานต้องผูกกับกะที่ไปทำจริงเสมอ
                  ถ้าเปิดให้กรอกจากตรงนี้ด้วย จะได้รายงานที่ไม่รู้ว่าเป็นของนัดไหน */}
              {/* Homecare = ตารางกะ · กายภาพ = ตารางนัดเข้าคอร์ส
                  เคสยาวมีนัดเป็นสิบๆ ครั้ง กางทั้งหมดในหน้าเคสจะดันประวัติการรักษาตกจอ
                  ในหน้าเคสจึงเหลือแค่สรุป + นัดถัดไป แล้วเปิดตารางเต็มเป็น popup แยก */}
              <section>
                <h3>{visitWord === 'นัด' ? 'ตารางนัด' : 'ตารางกะ'}</h3>
                <div className="visit-summary">
                  <p className="muted">
                    {item.visits.length === 0 ? (
                      'ยังไม่มีนัด'
                    ) : (
                      <>
                        {visitWord === 'นัด' ? 'นัดไว้' : 'นัดกะไว้'} <strong>{item.visits.length}</strong> ครั้ง
                        {' · '}ไปแล้ว {item.visits.filter((v) => v.state === 'done').length} ครั้ง
                        {nextVisit && (
                          <span className="cell-sub">
                            {visitWord}ถัดไป {formatDate(nextVisit.visit_date)}
                            {visitTime(nextVisit) && ` · ${visitTime(nextVisit)}`}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                  {item.visits.length > 0 && (
                    <button className="btn" type="button" onClick={() => setVisitsOpen(true)}>
                      ดูตาราง{visitWord}
                    </button>
                  )}
                </div>
              </section>

              {/* ประวัติการรักษาของผู้รับบริการคนนี้ทั้งหมด — ทุกเคส (รวมรอบก่อนๆ) ไม่ว่าใครเป็นคนลง
                  คนที่ไปดูแลต้องรู้ว่าก่อนหน้านี้เจออะไรมา ไม่ใช่เห็นแค่ใบของตัวเอง
                  อ่านอย่างเดียว ยกเว้นใบของตัวเองในเคสนี้ที่ยังแก้ได้ · บันทึกใหม่ยังอยู่ที่หน้างานวันนี้ที่เดียว */}
              {/* ในหน้าเคสเหลือแค่สรุป (กี่ใบ · ผิดปกติกี่ใบ · ใบล่าสุด) — ตัวรายการเปิดใน popup แยกเหมือนตารางนัด */}
              <section>
                <h3>ประวัติการรักษา</h3>
                <div className="visit-summary">
                  <p className="muted">
                    {!history ? (
                      historyError ? <span className="error">{historyError}</span> : 'กำลังโหลด…'
                    ) : history.total === 0 ? (
                      'ยังไม่มีรายงานอาการ'
                    ) : (
                      <>
                        มีรายงาน <strong>{history.total}</strong> ใบ
                        {history.abnormal > 0 && <> · <span className="history-abnormal">ผิดปกติ {history.abnormal} ใบ</span></>}
                        {history.latest && (
                          <span className="cell-sub">
                            ล่าสุด {formatDate(history.latest.report_date)}
                            {history.latest.report_time && ` · ${history.latest.report_time}`}
                            {history.latest.reported_by_name && ` · ${history.latest.reported_by_name}`}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                  <span className="stack-actions">
                    {history?.total > 0 && (
                      <button className="btn" type="button" onClick={() => openHistory(false)}>
                        ดูประวัติการรักษา
                      </button>
                    )}
                    {backfillVisits.length > 0 && (
                      <button className="btn primary" type="button" onClick={() => openHistory(true)}>
                        + ลงรายงานย้อนหลัง
                      </button>
                    )}
                  </span>
                </div>
              </section>
            </div>
          </>
        )}
      </div>

      {reportsOpen && item && (
        <ReportArchiveModal
          caseId={item.case_id}
          caseInfo={item}
          heading="ประวัติการรักษา"
          title={item.client_name}
          scope="my"
          patientWide
          currentEmployeeId={me}
          readOnly={closed}
          backfillVisits={backfillVisits.length > 0 ? backfillVisits : null}
          startAdding={reportsOpen === 'add'}
          onClose={() => { setReportsOpen(false); loadHistory(); }}
        />
      )}

      {visitsOpen && item && (
        <VisitsModal
          caseId={item.case_id}
          title={`ตาราง${visitWord} · ${item.client_name}`}
          visits={item.visits}
          onClose={() => setVisitsOpen(false)}
        />
      )}
    </div>
  );
}

/** เวลานัดต้องอยู่คู่กับวันเสมอ — ระบุเวลาไว้แล้วคนที่ต้องไปไม่เห็น ก็เท่ากับไม่ได้ระบุ */
const visitTime = (v) => [v.planned_start, v.planned_end].filter(Boolean).join('-');

/** popup ตารางนัด/ตารางกะเต็ม — ซ้อนบนหน้าเคส (จอแคบกินเต็มจอ ปัดลงเพื่อปิด) */
function VisitsModal({ caseId, title, visits, onClose }) {
  const sheetRef = useSheetSwipe(onClose);
  useScrollLock();
  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop modal-stacked" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal is-subsheet report-archive" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{caseCode(caseId)}</p>
            <h2>{title}</h2>
            <p className="muted">ทั้งหมด {visits.length} ครั้ง</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
        </header>
        <div className="modal-body">
          <ol className="visit-list">
            {visits.map((v, i) => (
              <li key={v.visit_id} className={`visit-${v.state}`}>
                <span className="visit-seq">ครั้งที่ {i + 1}</span>
                <span className="visit-date">
                  {formatDate(v.visit_date)}
                  {visitTime(v) && ` · ${visitTime(v)}`}
                </span>
                <span className="muted">
                  {VISIT_STATE_LABELS[v.state]}
                  {v.check_in_at && ` · เข้า ${timeText(v.check_in_at)}`}
                  {v.check_out_at && ` · ออก ${timeText(v.check_out_at)}`}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>ปิด</button>
        </footer>
      </div>
    </div>
  );
}
