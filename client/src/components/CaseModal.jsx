import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import CaseVisitsModal from './CaseVisitsModal.jsx';
import InvoiceModal from './InvoiceModal.jsx';
import {
  CASE_TYPE_LABELS, CASE_STATUS_LABELS, POSITION_LABELS, GENDER_LABELS, SERVICE_KIND_LABELS,
  INVOICE_STATUS_LABELS, CASE_EVENT_LABELS, formatBaht, formatDate, stampText,
} from '../labels.js';
import LineIcon from './LineIcon.jsx';
import ConfirmButton from './ConfirmButton.jsx';

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

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

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

/**
 * แก้ช่องที่เปลี่ยนบ่อยที่สุดได้ตรงนี้เลย ไม่ต้องออกไปหน้าฟอร์มเต็ม (ที่ยาว 800 บรรทัด)
 * สถานะไม่อยู่ในนี้เพราะเปลี่ยนผ่านปุ่ม action เฉพาะทาง (เริ่ม/ปิด/ยกเลิก) ที่คุมลำดับสถานะไว้แล้ว
 */
function QuickEdit({ item, onDone, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({
    start_date: item.start_date ?? '',
    end_date: item.end_date ?? '',
    fee: item.fee ?? '',
    client_phone: item.client_phone ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // ช่องว่างต้องเป็น null ไม่ใช่ "" ไม่งั้นไม่ผ่าน validation ของวันที่/เบอร์โทร
      const blank = (v) => (String(v).trim() === '' ? null : String(v).trim());
      await api.updateCase(item.case_id, {
        start_date: blank(form.start_date),
        end_date: blank(form.end_date),
        fee: form.fee === '' ? null : Number(form.fee),
        client_phone: blank(form.client_phone),
      });
      toast('บันทึกแล้ว');
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="quick-edit" onSubmit={handleSubmit}>
      {error && <p className="error">{error}</p>}
      <div className="grid cols-2">
        <label>วันเริ่ม<input type="date" {...field('start_date')} /></label>
        <label>วันสิ้นสุด<input type="date" {...field('end_date')} /></label>
        <label>ค่าบริการ (บาท)<input type="number" min="0" step="0.01" {...field('fee')} /></label>
        <label>เบอร์ติดต่อคุณญาติ<input inputMode="tel" {...field('client_phone')} /></label>
      </div>
      <div className="quick-edit-actions">
        <button className="btn" type="button" onClick={onCancel} disabled={saving}>ยกเลิก</button>
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </div>
    </form>
  );
}

export default function CaseModal({ caseId, siblings = [], onNavigate, onClose, onChanged }) {
  const boxRef = useRef(null);
  // จอแคบ: ปัดลงเพื่อปิด — ใช้ ref เดียวกับ focus trap เพราะ element เดียวแปะสอง ref ไม่ได้
  useSheetSwipe(onClose, boxRef);
  const [editing, setEditing] = useState(false);
  const [item, setItem] = useState(null);
  const [staff, setStaff] = useState([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [visits, setVisits] = useState([]);      // ใช้แค่สรุปจำนวนบนปุ่ม การจัดการจริงอยู่ใน popup ย่อย
  const [visitsOpen, setVisitsOpen] = useState(false);
  // ฟอร์มยืนยันการยกเลิกเคส — ทำเป็นฟอร์มในหน้าแทน prompt() ที่เบราว์เซอร์บล็อกได้
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [invoices, setInvoices] = useState([]);  // ใบแจ้งหนี้ของเคสนี้ (ปกติมีใบเดียว)
  const [openInvoiceId, setOpenInvoiceId] = useState(null);
  const [events, setEvents] = useState([]);      // ประวัติการทำรายการ (audit log) — ใหม่สุดอยู่บน
  const [eventsOpen, setEventsOpen] = useState(false);

  // ดึงเคส รายชื่อพนักงาน และวันนัดพร้อมกัน — จำนวนเคสที่แต่ละคนถืออยู่เปลี่ยนทุกครั้งที่จับคู่/ยกเลิก
  const load = () =>
    Promise.all([
      api.getCase(caseId),
      api.assignableEmployees(),
      api.listVisits(caseId),
      api.listInvoices({ case_id: caseId }),
      api.listCaseEvents(caseId),
    ]).then(([c, list, v, inv, ev]) => {
      setItem(c);
      setStaff(list);
      setVisits(v);
      setInvoices(inv.data);
      setEvents(ev);
    });

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);
    setEditing(false); // เปลี่ยนเคสแล้วต้องปิดโหมดแก้ ไม่งั้นค่าที่ค้างอยู่จะไปทับข้อมูลเคสใหม่

    Promise.all([
      api.getCase(caseId),
      api.assignableEmployees(),
      api.listVisits(caseId),
      api.listInvoices({ case_id: caseId }),
      api.listCaseEvents(caseId),
    ])
      .then(([c, list, v, inv, ev]) => {
        if (cancelled) return;
        setItem(c);
        setStaff(list);
        setVisits(v);
        setInvoices(inv.data);
        setEvents(ev);
        setPick(c.assigned_to ?? '');
      })
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [caseId]);

  /*
   * ล็อกไม่ให้หน้าหลังเลื่อนตาม + คืนโฟกัสกลับไปที่แถวเดิมตอนปิด (ไม่ใช่ดีดกลับไปต้นหน้า)
   * ต้องแยกเป็น effect ที่ทำงานครั้งเดียวตลอดอายุกล่อง — ถ้าไปรวมกับ effect ที่มี deps
   * โฟกัสจะถูกคืนออกไปข้างนอกทุกครั้งที่ deps เปลี่ยน (เช่น ตอนเปิด popup วันนัด)
   */
  useEffect(() => {
    const previous = document.activeElement;
    boxRef.current?.focus();
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  /* ปิดด้วย Esc + ขังโฟกัสไว้ในกล่อง — ถ้าไม่ขัง Tab จะวิ่งไปโดนลิงก์ที่อยู่หลังฉาก */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        // popup ย่อยเปิดอยู่ = ให้มันปิดตัวเองก่อน ไม่ใช่ปิดทั้งสองชั้นพร้อมกัน
        if (visitsOpen || openInvoiceId) return;
        e.stopPropagation();
        // กำลังแก้อยู่ / ยืนยันยกเลิกอยู่ — Esc ควรพับสิ่งนั้นก่อน ไม่ใช่ปิดทั้งกล่องจนที่พิมพ์ไว้หาย
        if (cancelOpen) setCancelOpen(false);
        else if (editing) setEditing(false);
        else onClose();
        return;
      }

      if (e.key !== 'Tab' || visitsOpen || openInvoiceId) return;

      const items = [...(boxRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === boxRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, visitsOpen, openInvoiceId, editing, cancelOpen]);

  // ตำแหน่งของเคสนี้ในรายการหน้าปัจจุบัน — ใช้ทำปุ่มดูเคสก่อนหน้า/ถัดไป
  const index = siblings.indexOf(caseId);
  const prevId = index > 0 ? siblings[index - 1] : null;
  const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

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

  // ระบบนัดกะมีเฉพาะเคส Homecare — กายภาพบำบัดคิดเป็นแพ็คเกจเหมาครั้ง ไม่ต้องจัดกะรายวัน
  // เคสเก่าที่ service_kind ยังว่างถือเป็น Homecare (มีกะได้) — ดูจากแพ็คเกจกายภาพที่ผูกไว้จริงด้วย
  const isPhysio = item?.service_kind === 'physio' || item?.physio_package_id != null;

  // วันที่ยกเลิกไม่นับเป็นนัดที่จองไว้ แต่ยังเก็บไว้เป็นประวัติใน popup
  const bookedVisits = visits.filter((v) => v.status !== 'cancelled').length;
  const doneVisits = visits.filter((v) => v.status === 'done').length;

  /** ลบใบแจ้งหนี้ทิ้งถาวร แล้วถามต่อว่าจะออกใบใหม่ตามข้อมูลปัจจุบันเลยไหม */
  function deleteInvoice(v) {
    return run(async () => {
      await api.deleteInvoice(v.invoice_id);
      if (confirm('ลบแล้ว — ออกใบใหม่ตามข้อมูลปัจจุบันของเคสเลยไหม?')) {
        const created = await api.createInvoice({ case_id: item.case_id });
        setOpenInvoiceId(created.invoice_id);
      }
    });
  }

  /**
   * ยกเลิกเคส — ยืนยันด้วยฟอร์มในหน้า ไม่ใช่ prompt()
   *
   * prompt() ถูกเบราว์เซอร์บล็อกได้ (คนใช้ติ๊ก "ไม่ให้หน้านี้สร้างกล่องอีก" หรือบนมือถือบางตัว)
   * พอโดนบล็อกมันคืน null เงียบๆ ปุ่มเลยกดแล้วไม่เกิดอะไรขึ้นเลย ไม่ยิง API ไม่มีข้อความ
   * เหมือนปุ่มเสีย — ฟอร์มรับชำระเงินใน InvoiceModal ย้ายออกจาก prompt() ไปแล้วด้วยเหตุผลเดียวกัน
   */
  function cancelCase() {
    run(async () => {
      await api.cancelCase(item.case_id, cancelReason.trim() || null);
      setCancelOpen(false);
      setCancelReason('');
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="รายละเอียดเคส"
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
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

              <div className="modal-head-actions">
                {/* ไล่ดูทีละเคสได้โดยไม่ต้องปิด-เปิดใหม่ (เฉพาะเคสที่อยู่ในหน้ารายการปัจจุบัน) */}
                {siblings.length > 1 && (
                  <span className="modal-nav">
                    <button className="btn icon-btn" disabled={!prevId} onClick={() => onNavigate?.(prevId)} title="เคสก่อนหน้า" aria-label="เคสก่อนหน้า"><LineIcon name="chevron-left" /></button>
                    <button className="btn icon-btn" disabled={!nextId} onClick={() => onNavigate?.(nextId)} title="เคสถัดไป" aria-label="เคสถัดไป"><LineIcon name="chevron-right" /></button>
                  </span>
                )}
                <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
              </div>
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
                {/* แพ้ยา/แพ้อาหาร มีที่แฟ้มผู้ป่วยที่เดียว (ไม่ได้คัดลอกลงเคส) — อ่านสดมาแสดงคู่กัน */}
                {(item.patient_allergies || item.patient_food_allergies) && (
                  <p className="allergy-alert">
                    {item.patient_allergies && <>แพ้ยา: {item.patient_allergies}</>}
                    {item.patient_allergies && item.patient_food_allergies && ' · '}
                    {item.patient_food_allergies && <>แพ้อาหาร: {item.patient_food_allergies}</>}
                  </p>
                )}
                <Field label="โรคประจำตัว" value={item.medical_history} />
                {/* snapshot ในเคสไม่ตรงกับแฟ้มผู้ป่วยแล้ว — พนักงานภาคสนามเห็นของล่าสุดอยู่
                    แต่ที่นี่ยังโชว์ snapshot เพราะเป็นข้อมูล ณ วันเปิดเคส จึงต้องบอกให้รู้ว่าต่างกัน */}
                {item.medical_history_stale && (
                  <p className="notice">
                    แฟ้มผู้ป่วยถูกแก้หลังเปิดเคส — ปัจจุบันคือ “{item.patient_medical_history || 'ไม่ได้ระบุ'}”
                    {' '}(พนักงานภาคสนามเห็นข้อมูลล่าสุดนี้แล้ว)
                  </p>
                )}
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
                <div className="section-head">
                  <h3>รายละเอียดเคส</h3>
                  {/* เคสที่ปิด/ยกเลิกแล้วเป็นข้อเท็จจริงที่จบไปแล้ว — ต้องเปิดเคสใหม่ก่อนถึงจะแก้ได้ */}
                  {!editing && !terminal && (
                    <button className="btn tiny" onClick={() => setEditing(true)}>แก้ด่วน</button>
                  )}
                </div>

                {editing && (
                  <QuickEdit
                    item={item}
                    onCancel={() => setEditing(false)}
                    onDone={() => {
                      setEditing(false);
                      run(() => Promise.resolve()); // โหลดเคสใหม่ + บอกหน้ารายการให้รีเฟรช
                    }}
                  />
                )}

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
                  <Field label="ค่าบริการที่ได้รับ" value={item.fee != null && formatBaht(item.fee)} />
                  {/* ยอดที่พนักงานจะเห็นเป็นรายได้ของตัวเองเมื่อปิดเคส — ต้องเห็นก่อนกดปิด */}
                  <Field label="ค่าจ้างพนักงาน" value={item.staff_pay != null && formatBaht(item.staff_pay)} />
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

              {/* Homecare = ตารางกะ (วัน+เวลา+คน) · กายภาพ = ตารางนัดเข้าคอร์ส (นับ X/N ครั้ง) */}
              <section>
                <h3>{isPhysio ? 'ตารางนัด' : 'ตารางกะ'}</h3>
                <div className="visit-summary">
                  <p className="muted">
                    {bookedVisits === 0 ? (
                      isPhysio ? 'ยังไม่ได้ลงนัด' : 'ยังไม่ได้นัดกะ'
                    ) : isPhysio ? (
                      <>
                        นัดแล้ว <strong>{bookedVisits}</strong>
                        {item.physio_sessions ? ` / ${item.physio_sessions}` : ''} ครั้ง
                        {' · '}ไปแล้ว {doneVisits} ครั้ง
                      </>
                    ) : (
                      <>นัดไว้ <strong>{bookedVisits}</strong> กะ{' · '}ไปแล้ว {doneVisits} กะ</>
                    )}
                  </p>
                  <button className="btn" onClick={() => setVisitsOpen(true)}>
                    {terminal
                      ? (isPhysio ? 'ดูตารางนัด' : 'ดูตารางกะ')
                      : (isPhysio ? 'ลงนัด' : 'นัดกะ')}
                  </button>
                </div>
              </section>

              {/* ออกใบแจ้งหนี้จากเคสนี้ — ระบบคัดลอกผู้จ่าย/ที่อยู่/ค่าจ้างไปให้เอง */}
              <section>
                <h3>ใบแจ้งหนี้</h3>
                {invoices.length === 0 ? (
                  <div className="visit-summary">
                    <p className="muted">
                      ยังไม่ได้ออกใบแจ้งหนี้
                      {doneVisits > 0 && <span className="cell-sub">ทำไปแล้ว {doneVisits} กะ — เลือกออกตามกะได้</span>}
                    </p>
                    <div className="row-actions">
                      <button
                        className="btn"
                        disabled={busy || item.status === 'cancelled'}
                        title={item.status === 'cancelled' ? 'เคสที่ยกเลิกแล้วออกใบแจ้งหนี้ไม่ได้' : undefined}
                        onClick={() =>
                          run(async () => {
                            const created = await api.createInvoice({ case_id: item.case_id });
                            setOpenInvoiceId(created.invoice_id);
                          })
                        }
                      >
                        ออกใบตามแพ็คเกจ
                      </button>
                      {/* เก็บเงินตามครั้งที่ไปจริง — ใบจะแตกเป็นรายการรายวัน ยอดเป็นสัดส่วนของกะที่ทำ
                          ใช้กับเคสที่เก็บเงินระหว่างทาง หรือเคสที่ตกลงกันเป็นรายครั้ง */}
                      {doneVisits > 0 && (
                        <button
                          className="btn"
                          disabled={busy || item.status === 'cancelled'}
                          onClick={() =>
                            run(async () => {
                              const created = await api.createInvoice({
                                case_id: item.case_id,
                                basis: 'visits',
                              });
                              setOpenInvoiceId(created.invoice_id);
                            })
                          }
                        >
                          ออกใบตามกะที่ไปจริง ({doneVisits})
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  invoices.map((v) => (
                    <div className="history-item" key={v.invoice_id}>
                      <div>
                        <strong>{formatBaht(v.total)}</strong>
                        <p className="muted">
                          <span className="mono">{v.invoice_id}</span>
                          {' · '}ออกเมื่อ {formatDate(v.issue_date)}
                          {' · '}{INVOICE_STATUS_LABELS[v.status]}
                        </p>
                        {/* ข้อมูลในใบไม่ตรงกับเคสแล้ว (ค่าจ้าง และ/หรือ ชื่อผู้จ่าย) — เปิดใบเพื่อรีเฟรช/ออกใหม่ */}
                        {v.is_stale && v.status !== 'cancelled' && (
                          <p className="stale-tag">
                            <><LineIcon name="alert" className="text-ico" />{v.payer_stale ? 'ผู้จ่ายในใบไม่ตรงกับเคส' : `ไม่ตรงกับค่าจ้างเคส (${formatBaht(v.case_fee)})`}</>
                          </p>
                        )}
                      </div>
                      <div className="invoice-row-actions">
                        <button className="btn tiny" onClick={() => setOpenInvoiceId(v.invoice_id)}>
                          เปิดดู
                        </button>
                        <ConfirmButton
                          className="btn tiny danger-ghost"
                          disabled={busy}
                          title={`ลบใบแจ้งหนี้ ${v.invoice_id} ทิ้งถาวร?`}
                          detail="ลบแล้วกู้คืนไม่ได้ และเลขที่ใบจะข้าม — ระบบจะถามต่อว่าจะออกใบใหม่ตามข้อมูลปัจจุบันเลยไหม"
                          confirmLabel="ลบถาวร"
                          onConfirm={() => deleteInvoice(v)}
                        >
                          ลบ
                        </ConfirmButton>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* ประวัติการทำรายการ — ใครทำอะไรกับเคสนี้บ้าง เก็บทีละครั้ง ไม่ใช่แค่เวลาล่าสุด
                  ย่อไว้เพราะเป็นข้อมูลที่เปิดดูเฉพาะตอนต้องไล่ย้อน ไม่ใช่ของที่ต้องเห็นทุกครั้ง */}
              <section>
                <h3>ประวัติการทำรายการ</h3>
                {events.length === 0 ? (
                  <p className="muted">ยังไม่มีประวัติ (เคสนี้เปิดก่อนระบบเริ่มบันทึก)</p>
                ) : (
                  <>
                    <ol className="event-log">
                      {(eventsOpen ? events : events.slice(0, 3)).map((ev) => (
                        <li key={ev.event_id}>
                          <span className="badge">{CASE_EVENT_LABELS[ev.event] ?? ev.event}</span>
                          <span className="event-detail">
                            {ev.detail}
                            <span className="cell-sub">
                              {stampText(ev.created_at)}
                              {' · '}{ev.actor_name ?? 'ไม่ทราบผู้ทำรายการ'}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ol>
                    {events.length > 3 && (
                      <button className="btn tiny" onClick={() => setEventsOpen((v) => !v)}>
                        {eventsOpen ? 'ย่อ' : `ดูทั้งหมด (${events.length})`}
                      </button>
                    )}
                  </>
                )}
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

            {/* ยืนยันยกเลิกเคส — อยู่เหนือแถบปุ่มเพื่อให้เห็นพร้อมกับปุ่มที่กดไป
                เหตุผลไม่บังคับ แต่เป็นสิ่งเดียวที่บอกได้ทีหลังว่าทำไมเคสนี้ถึงไม่ได้เกิดขึ้น */}
            {cancelOpen && (
              <div className="notice pay-form no-print">
                <label>
                  เหตุผลที่ยกเลิก (ไม่บังคับ)
                  <input
                    autoFocus
                    placeholder="เช่น ญาติเปลี่ยนใจ / หาพนักงานไม่ได้"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter = ยืนยัน · Esc ให้ตัวจัดการรวมด้านบนพับฟอร์มนี้
                      if (e.key === 'Enter') { e.preventDefault(); cancelCase(); }
                    }}
                  />
                </label>
                <div className="pay-form-actions">
                  <button className="btn" disabled={busy} onClick={() => setCancelOpen(false)}>
                    ไม่ยกเลิกแล้ว
                  </button>
                  <button className="btn danger" disabled={busy} onClick={cancelCase}>
                    ยืนยันยกเลิก {item.case_id}
                  </button>
                </div>
              </div>
            )}

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

              {/* เคสที่ยังทำงานอยู่ — ยกเลิกได้เสมอ (กดแล้วกางฟอร์มยืนยันด้านบน ไม่ยิงทันที) */}
              {!terminal && (
                <button
                  className="btn danger-ghost"
                  disabled={busy || cancelOpen}
                  onClick={() => setCancelOpen(true)}
                >
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
                    // ปิดเคส = ตรึงค่าจ้างของกะที่ทำไปแล้ว — บอกให้รู้ตัวก่อนกด
                    const pay = item.staff_pay != null
                      ? `\nค่าจ้างของกะที่ทำไปแล้วจะถูกตรึงตามยอดเคส ${formatBaht(item.staff_pay)}`
                      : '\nเคสนี้ยังไม่ได้ระบุค่าจ้างพนักงาน — กะที่ทำไปแล้วจะยังไม่มียอด';

                    /* ของค้างที่ต้องบอกก่อนปิด (server กันซ้ำอีกชั้นด้วย force)
                       กะที่ยังไม่ถึงวันจะถูกยกเลิก ส่วนกะที่ค้างเช็คเอาท์จะไม่มีชั่วโมง/ค่าจ้างเลย */
                    const today = new Date().toISOString().slice(0, 10);
                    const upcoming = visits.filter(
                      (v) => v.status === 'scheduled' && !v.check_in_at && v.visit_date >= today,
                    ).length;
                    const openShifts = visits.filter((v) => v.check_in_at && !v.check_out_at).length;
                    const warn = [
                      upcoming > 0 && `• ${upcoming} กะที่ยังไม่ถึงวันนัด จะถูกยกเลิก`,
                      openShifts > 0 && `• ${openShifts} กะที่เช็คอินแล้วแต่ยังไม่เช็คเอาท์ จะไม่ถูกนับชั่วโมง/ค่าจ้าง`,
                    ].filter(Boolean);
                    const pending = warn.length ? `\n\nยังมีของค้าง:\n${warn.join('\n')}` : '';

                    if (!confirm(`ปิดเคส ${item.case_id}?${pay}${pending}\nเคสจะยังอยู่ในระบบเป็นประวัติ และเปิดใหม่ได้ภายหลัง`)) return;
                    run(() => api.closeCase(item.case_id, today, warn.length > 0));
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
                mode={isPhysio ? 'appointment' : 'shift'}
                onClose={() => {
                  setVisitsOpen(false);
                  load().catch(() => {});
                }}
              />
            )}

            {openInvoiceId && (
              <InvoiceModal
                invoiceId={openInvoiceId}
                onChanged={() => load().catch(() => {})}
                onReissued={(newId) => setOpenInvoiceId(newId)}  /* ออกใบใหม่แล้วสลับไปดูใบใหม่ทันที */
                onClose={() => {
                  setOpenInvoiceId(null);
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
