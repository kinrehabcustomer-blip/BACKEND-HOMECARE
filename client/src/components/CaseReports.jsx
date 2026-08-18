import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { formatDate, todayTH } from '../labels.js';
import ConfirmButton from './ConfirmButton.jsx';
import ReportArchiveModal from './ReportArchiveModal.jsx';
import DailyCareForm from './DailyCareForm.jsx';
import DailyCareView from './DailyCareView.jsx';
import { usesDailyRecord, dailyBrief } from '../lib/dailyCare.js';
import TimeSelect from './TimeSelect.jsx';

/**
 * สัญญาณชีพที่ให้กรอก — ช่วง min/max ตรงกับ zod ฝั่ง server และ CHECK ในตาราง
 * ตั้งไว้บน input ด้วยเพื่อให้รู้ตั้งแต่ตอนพิมพ์ว่าเกินช่วง ไม่ต้องรอกดบันทึกแล้วค่อยเด้ง error กลับมา
 */
const VITALS = [
  { key: 'bp_systolic', label: 'ความดันตัวบน', unit: 'mmHg', min: 40, max: 300 },
  { key: 'bp_diastolic', label: 'ความดันตัวล่าง', unit: 'mmHg', min: 20, max: 200 },
  { key: 'pulse', label: 'ชีพจร', unit: 'ครั้ง/นาที', min: 20, max: 250 },
  { key: 'respiratory_rate', label: 'อัตราการหายใจ', unit: 'ครั้ง/นาที', min: 4, max: 80 },
  { key: 'temperature_c', label: 'อุณหภูมิ', unit: '°C', min: 30, max: 45, step: 0.1 },
  { key: 'spo2', label: 'ออกซิเจนปลายนิ้ว', unit: '%', min: 50, max: 100 },
  { key: 'blood_sugar', label: 'น้ำตาลปลายนิ้ว', unit: 'mg/dL', min: 10, max: 800 },
  { key: 'pain_score', label: 'ระดับความเจ็บปวด', unit: '0–10', min: 0, max: 10 },
];

const TEXTS = [
  { key: 'symptoms', label: 'อาการที่พบ', placeholder: 'เช่น มีไข้ต่ำๆ ไอมีเสมหะ บ่นปวดเข่าขวา' },
  { key: 'care_given', label: 'การดูแลที่ให้', placeholder: 'เช่น เช็ดตัวลดไข้ ทำแผลกดทับ พลิกตะแคงทุก 2 ชม.' },
  { key: 'intake_output', label: 'อาหาร / ขับถ่าย / การนอน', placeholder: 'เช่น ทานข้าวต้ม 1 ถ้วย ปัสสาวะปกติ นอนหลับดี' },
  { key: 'follow_up', label: 'สิ่งที่ต้องติดตาม', placeholder: 'เช่น ถ้าไข้ไม่ลดภายในพรุ่งนี้ ให้แจ้งญาติพาไปพบแพทย์' },
  { key: 'note', label: 'หมายเหตุ', placeholder: 'เรื่องอื่นๆ ที่คนเวรถัดไปควรรู้' },
];

/**
 * เวลาที่แก้ล่าสุด — อ่านจากข้อความที่เก็บไว้ตรงๆ ไม่แปลงโซนเวลา
 *
 * ไม่ใช้ stampText ของส่วนกลาง เพราะมันเติม 'Z' ให้ค่าที่ไม่มีโซนเวลา (ของเดิมทั้งระบบเคยเก็บเป็น UTC)
 * แต่ updated_at ของตารางนี้เป็นเวลาไทยตั้งแต่แถวแรก — แปลงอีกทีจะบวกเกินไป 7 ชั่วโมง
 * (ดูบล็อกท้าย schema.sql: DEFAULT ของทั้งระบบย้ายมาเป็น Asia/Bangkok แล้ว)
 */
const editedAt = (value) => (value ? `${value.slice(8, 10)}/${value.slice(5, 7)} ${value.slice(11, 16)} น.` : '');

/** แถวของฟอร์ม (ข้อความล้วน) -> ค่าที่ส่งขึ้น API: ช่องว่าง = null, ตัวเลขต้องเป็น number ไม่ใช่ '78' */
function toPayload(form) {
  const out = { report_date: form.report_date || null, report_time: form.report_time || null };
  for (const { key } of VITALS) out[key] = form[key] === '' || form[key] == null ? null : Number(form[key]);
  for (const { key } of TEXTS) out[key] = form[key]?.trim() ? form[key].trim() : null;
  return out;
}

/** ค่าจาก API -> ค่าในฟอร์ม (input ต้องการข้อความเสมอ — null ที่ใส่ลง value ทำให้ช่องกลายเป็น uncontrolled) */
function toForm(report) {
  const out = {
    report_date: report?.report_date ?? todayTH(),
    report_time: report?.report_time ?? '',
  };
  for (const { key } of [...VITALS, ...TEXTS]) out[key] = report?.[key] ?? '';
  return out;
}

/** ยังไม่ได้กรอกอะไรเลย = ปุ่มบันทึกยังกดไม่ได้ (server ก็ปฏิเสธใบเปล่าอยู่แล้ว แต่รู้ก่อนกดดีกว่า) */
const isBlank = (form) =>
  ![...VITALS, ...TEXTS].some(({ key }) => String(form[key] ?? '').trim() !== '');

/** ความดันอ่านเป็นคู่เสมอ (120/80) — วัดมาข้างเดียวก็ยังต้องแสดงได้ ไม่ใช่ซ่อนทั้งคู่ */
function vitalChips(r) {
  const chips = [];
  if (r.bp_systolic != null || r.bp_diastolic != null) {
    chips.push(['ความดัน', `${r.bp_systolic ?? '—'}/${r.bp_diastolic ?? '—'}`, 'mmHg']);
  }
  for (const v of VITALS) {
    if (v.key === 'bp_systolic' || v.key === 'bp_diastolic') continue;
    if (r[v.key] != null) chips.push([v.label, r[v.key], v.unit === '0–10' ? '' : v.unit]);
  }
  return chips;
}

function ReportForm({ initial, busy, error, onSubmit, onCancel }) {
  const [form, setForm] = useState(() => toForm(initial));
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <form
      className="report-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(toPayload(form));
      }}
    >
      {error && <p className="error">{error}</p>}

      <div className="grid cols-2 report-when">
        <label>วันที่<input type="date" value={form.report_date} onChange={set('report_date')} max={todayTH()} /></label>
        {/* ใช้ตัวเลือกเวลาตัวเดียวกับหน้าลงกะ/แก้เวลาเข้างาน — <input type="time"> แสดง AM/PM
            ตามภาษาของเครื่อง ไม่ใช่ของหน้าเว็บ ทั้งที่ทั้งระบบใช้ 24 ชม. (ดู TimeSelect.jsx) */}
        <label>เวลาที่วัด
          <TimeSelect
            label="เวลาที่วัด"
            value={form.report_time}
            disabled={busy}
            onChange={(v) => setForm((prev) => ({ ...prev, report_time: v }))}
          />
        </label>
      </div>

      <h4 className="report-form-head">สัญญาณชีพ <span className="muted">(วัดได้ช่องไหนกรอกช่องนั้น)</span></h4>
      <div className="grid cols-2 report-vitals">
        {VITALS.map((v) => (
          <label key={v.key}>
            {v.label} <span className="muted">({v.unit})</span>
            <input
              type="number"
              inputMode="decimal"
              min={v.min}
              max={v.max}
              step={v.step ?? 1}
              value={form[v.key]}
              onChange={set(v.key)}
            />
          </label>
        ))}
      </div>

      <h4 className="report-form-head">อาการ / การดูแล</h4>
      <div className="report-texts">
        {TEXTS.map((t) => (
          <label key={t.key} className="report-text">
            {t.label}
            <textarea rows={2} value={form[t.key]} placeholder={t.placeholder} onChange={set(t.key)} />
          </label>
        ))}
      </div>

      <div className="quick-edit-actions">
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>ยกเลิก</button>
        <button className="btn primary" type="submit" disabled={busy || isBlank(form)}>
          {busy ? 'กำลังบันทึก…' : 'บันทึกรายงาน'}
        </button>
      </div>
    </form>
  );
}

/**
 * รายงานอาการผู้ป่วย — ใช้ได้ทั้ง "ทั้งเคส" และ "เฉพาะกะเดียว"
 *
 * scope = 'admin' (ฝั่งจัดการ, /api/cases/:id/reports) | 'my' (พนักงานภาคสนาม, /api/my/...)
 * สองเส้นต่างกันที่สิทธิ์ ไม่ใช่ที่หน้าตา จึงใช้คอมโพเนนต์เดียวกัน:
 *   admin แก้/ลบได้ทุกใบ · field แก้ได้เฉพาะใบที่ตัวเองบันทึก และลบไม่ได้เลย
 *   (เป็นบันทึกทางการแพทย์ — กรอกผิดให้แก้ที่ใบเดิม ซึ่งเหลือเวลาที่แก้ไว้ให้เห็น)
 *
 * visitId = โหมด "ของกะนี้เท่านั้น" (หน้างานวันนี้) — เห็นเฉพาะรายงานของกะนั้น และที่บันทึกใหม่
 * จะถูกผูกเข้ากับกะให้เอง (server อ่านกะจาก path ไม่เชื่อค่าที่ส่งมาใน body)
 *
 * readOnly = เคสจบไปแล้ว (ฝั่ง field) — server ปฏิเสธอยู่แล้ว ตรงนี้แค่ไม่วาดปุ่มที่กดไปก็ไม่ผ่าน
 */
/** จำนวนใบต่อการโหลดหนึ่งครั้ง — พอสำหรับดูย้อนหลังราวหนึ่งสัปดาห์ของเคสที่บันทึกวันละ 4 รอบ */
const PER_PAGE = 20;

/** บรรทัดสรุปของฟอร์มสั้น — ใช้ตัวเลขสัญญาณชีพที่มี ไม่มีเลยก็ใช้ข้อความอาการแทน */
function simpleBrief(r) {
  const chips = vitalChips(r).map(([label, value, unit]) => `${label} ${value}${unit ? ` ${unit}` : ''}`);
  if (chips.length > 0) return chips;
  const text = TEXTS.map((t) => r[t.key]).find(Boolean);
  return text ? [text] : [];
}

/**
 * เวลาที่แสดงหน้าแถว — ใช้ "เวลาที่วัด" ถ้ากรอกไว้ ไม่งั้นใช้เวลาที่กดบันทึก
 * เกณฑ์เดียวกับที่ server ใช้เรียงลำดับ แถวจึงเรียงตรงกับตัวเลขที่คนอ่านเห็นเสมอ
 * (ขีด "—" ทำให้ดูเหมือนใบนั้นไม่มีเวลาและไม่รู้ว่าทำไมถึงอยู่ตำแหน่งนั้น)
 */
const rowTime = (r) => r.report_time ?? r.created_at?.slice(11, 16) ?? '—';

/** 'YYYY-MM' -> 'ส.ค. 2569' สำหรับตัวเลือกเดือน */
const monthText = (ym) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'short', year: 'numeric' });

/**
 * รายงานอาการผู้ป่วย — คลังบันทึกของเคสหนึ่งใบ
 *
 * scope = 'admin' (ฝั่งจัดการ) | 'my' (พนักงานภาคสนาม) — ต่างกันที่สิทธิ์ ไม่ใช่ที่หน้าตา
 *   admin แก้/ลบได้ทุกใบ · field แก้ได้เฉพาะใบที่ตัวเองบันทึก และลบไม่ได้เลย
 *   (เป็นบันทึกทางการแพทย์ — กรอกผิดให้แก้ที่ใบเดิม ซึ่งเหลือเวลาที่แก้ไว้ให้เห็น)
 *
 * visitId = โหมด "ของกะนี้เท่านั้น" (หน้างานวันนี้) — บันทึกใหม่ได้เฉพาะโหมดนี้
 * และไม่ต้องแบ่งหน้า/กรอง เพราะกะหนึ่งมีไม่กี่ใบ
 *
 * โหมดทั้งเคสเป็นคลังที่โตขึ้นทุกวัน (วันละ 2–4 ใบ) จึงต้องแบ่งหน้า กรองตามเดือน/ประเภท
 * และจัดกลุ่มตามวัน — ไม่ใช่รายการยาวรวดเดียวที่เลื่อนหาอะไรไม่เจอ
 */
export default function CaseReports({
  caseId,
  caseInfo = null,
  scope = 'admin',
  visitId = null,
  currentEmployeeId = null,
  readOnly = false,
  onChanged = null,
  onFormOpen = null,
  inlineLimit = null,
  archiveTitle = null,
  allowAdd = true,
}) {
  const toast = useToast();
  const isAdmin = scope === 'admin';

  /* เคสดูแลต่อเนื่องสาย Homecare (ผู้สูงอายุ/ติดเตียง/หลังผ่าตัด) ใช้แบบบันทึกประจำวันเต็มรูปแบบ
     เคสอื่น (กายภาพ/เฝ้าไข้/พาไปหาหมอ) ใช้ฟอร์มสั้นเหมือนเดิม — ไม่มี NG/ขับถ่าย/เปลี่ยนท่าให้กรอก
     ไม่รู้จักเคส (ไม่ได้ส่ง caseInfo มา) = ใช้ฟอร์มสั้น ซึ่งเป็นชุดช่องย่อยของฟอร์มเต็มอยู่แล้ว */
  const daily = usesDailyRecord(caseInfo);
  const Form = daily ? DailyCareForm : ReportForm;

  const [reports, setReports] = useState(null);        // ใบที่โหลดมาแล้ว (สะสมเมื่อกด "ดูเก่ากว่านี้")
  const [meta, setMeta] = useState({ total: 0, has_more: false, months: [] });
  const [filters, setFilters] = useState({ month: '', type: '' });
  const [error, setError] = useState(null);            // ตอนโหลดรายการ
  const [formError, setFormError] = useState(null);    // ตอนบันทึก — คนละที่กัน ไม่งั้นกดบันทึกพลาดแล้วรายการหาย
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [openId, setOpenId] = useState(null);          // ใบที่กางอยู่ (กางได้ทีละใบ)
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false); // ตารางเต็มใน popup แยก (เมื่อของเยอะ)

  /** ดึงหน้าที่ต้องการ — โหมดรายกะไม่มีการแบ่งหน้า คืนทั้งชุดเลย */
  const fetchPage = useCallback(
    (page) => {
      if (visitId) {
        return api.myVisitReports(visitId).then((rows) => ({
          data: rows,
          total: rows.length,
          has_more: false,
          months: [],
        }));
      }
      const params = { page, per_page: inlineLimit ?? PER_PAGE };
      if (filters.month) params.month = filters.month;
      if (filters.type) params.type = filters.type;
      return isAdmin ? api.listCaseReports(caseId, params) : api.myCaseReports(caseId, params);
    },
    [caseId, isAdmin, visitId, filters.month, filters.type, inlineLimit],
  );

  /* ตอนฟอร์มกางอยู่ ปุ่มของฟอร์ม ("ยืนยันและส่งรายงาน") คือปุ่มหลักของหน้าจอนั้น
     กล่องแม่ต้องเก็บปุ่มปิดของตัวเองไว้ก่อน ไม่งั้นได้ปุ่มสองแถวซ้อนกันแล้วไม่รู้ว่าต้องกดอันไหน */
  useEffect(() => {
    onFormOpen?.(adding || editingId != null);
  }, [adding, editingId, onFormOpen]);

  // เปลี่ยนตัวกรอง = เริ่มนับหนึ่งใหม่เสมอ (ไม่ใช่ต่อท้ายของเดิมที่คนละเงื่อนไข)
  useEffect(() => {
    let cancelled = false;
    setReports(null);
    fetchPage(1)
      .then((res) => {
        if (cancelled) return;
        setReports(res.data);
        setMeta({ total: res.total, has_more: res.has_more, months: res.months ?? [] });
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetchPage(Math.floor(reports.length / PER_PAGE) + 1);
      setReports((prev) => [...prev, ...res.data]);
      setMeta({ total: res.total, has_more: res.has_more, months: res.months ?? meta.months });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  /** ทุกการเขียนใช้ทางเดียวกัน: ยิง API -> โหลดหน้าแรกใหม่ -> พับฟอร์ม */
  async function run(action, done) {
    setBusy(true);
    setFormError(null);
    try {
      await action();
      const res = await fetchPage(1);
      setReports(res.data);
      setMeta({ total: res.total, has_more: res.has_more, months: res.months ?? [] });
      toast(done);
      onChanged?.(); // หน้าแม่ (การ์ดงานวันนี้) ถือตัวเลขจำนวนรายงานอยู่ ต้องให้มันไปดึงใหม่เอง
      setAdding(false);
      setEditingId(null);
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /* ฝั่งพนักงานสร้างได้เฉพาะในโหมดรายกะ (หน้างานวันนี้) — ที่หน้าเคสถูกส่ง readOnly มาเสมอ
     ปุ่มบันทึกจึงไม่มีทางโผล่ และ server ก็ไม่มีเส้นให้สร้างที่ระดับเคสอยู่แล้ว */
  const save = (body) =>
    run(
      () => (visitId ? api.addMyVisitReport(visitId, body) : api.addCaseReport(caseId, body)),
      'บันทึกรายงานแล้ว',
    );

  const edit = (reportId, body) =>
    run(
      () => (isAdmin ? api.updateCaseReport(caseId, reportId, body) : api.updateMyCaseReport(caseId, reportId, body)),
      'แก้ไขรายงานแล้ว',
    );

  const remove = (reportId) => run(() => api.deleteCaseReport(caseId, reportId), 'ลบรายงานแล้ว');

  /** แก้ได้ไหม — admin ได้ทุกใบ · field ได้เฉพาะใบที่ตัวเองเป็นคนบันทึก (server ตรวจซ้ำอีกชั้น) */
  const canEdit = (r) => !readOnly && (isAdmin || (currentEmployeeId != null && r.reported_by === currentEmployeeId));

  /** URL รูปแผลของรายงานใบหนึ่ง — คนละเส้นกันระหว่างหลังบ้านกับพนักงาน (สิทธิ์คนละชุด) */
  const photoUrl = (r) =>
    r.has_wound_photo
      ? (isAdmin ? api.caseReportPhotoUrl(caseId, r.report_id) : api.myReportPhotoUrl(caseId, r.report_id))
      : null;

  /** จัดกลุ่มตามวัน — ในคลังที่มีวันละหลายใบ วันคือหน่วยที่คนใช้ไล่หา ไม่ใช่ลำดับใบ */
  const days = useMemo(() => {
    const map = new Map();
    for (const r of reports ?? []) {
      if (!map.has(r.report_date)) map.set(r.report_date, []);
      map.get(r.report_date).push(r);
    }
    return [...map.entries()];
  }, [reports]);

  const filtering = Boolean(filters.month || filters.type);

  if (error && !reports) return <p className="error">{error}</p>;
  if (!reports) return <p className="muted">กำลังโหลด…</p>;

  /* ของเยอะเกินกว่าจะกางในหน้าเคส — โชว์ใบล่าสุดไม่กี่ใบแล้วเปิดตารางเต็มใน popup แยก
     (หน้าเคสมีข้อมูลผู้ป่วย/ที่อยู่/ตารางกะอยู่ด้วย รายงานสองร้อยใบจะดันทุกอย่างตกจอ) */
  const overflow = inlineLimit != null && meta.total > inlineLimit;

  return (
    <div className="report-list">
      {!readOnly && !adding && (
        <div className="visit-summary">
          <p className="muted">
            {meta.total === 0
              ? (visitId ? 'ยังไม่ได้บันทึกรายงานของกะนี้' : filtering ? 'ไม่มีรายงานที่ตรงกับตัวกรอง' : 'ยังไม่มีรายงานอาการ')
              : `มีรายงาน ${meta.total} ใบ`}
          </p>
          {/* หน้าเคสเป็นที่ "ดูย้อนหลัง" — การบันทึกอยู่ที่หน้างานวันนี้ของกะนั้นที่เดียว
              (แก้/ลบยังทำได้จากที่นี่ เพราะเป็นการแก้ของที่มีอยู่แล้ว ไม่ใช่การสร้างใบที่ไม่ผูกกับกะ) */}
          {allowAdd && (
            <button className="btn primary" type="button" onClick={() => { setAdding(true); setFormError(null); }}>
              + บันทึกรายงาน
            </button>
          )}
        </div>
      )}

      {adding && (
        <Form
          initial={null}
          busy={busy}
          error={formError}
          onSubmit={save}
          onCancel={() => { setAdding(false); setFormError(null); }}
        />
      )}

      {/* ตัวกรองคลัง — โผล่เมื่อของเริ่มเยอะจนต้องหา (เคสที่มีไม่กี่ใบไม่ต้องมีอะไรมาบัง) */}
      {!visitId && !overflow && (meta.months.length > 1 || meta.total > PER_PAGE || filtering) && (
        <div className="report-filters">
          <select
            aria-label="เลือกเดือน"
            value={filters.month}
            onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}
          >
            <option value="">ทุกเดือน</option>
            {meta.months.map((m) => (
              <option key={m.month} value={m.month}>
                {monthText(m.month)} ({m.total}){m.abnormal > 0 ? ` · ผิดปกติ ${m.abnormal}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`chip ${filters.type === 'abnormal' ? 'is-on' : ''}`}
            onClick={() => setFilters((f) => ({ ...f, type: f.type === 'abnormal' ? '' : 'abnormal' }))}
          >
            เฉพาะที่ผิดปกติ
          </button>
        </div>
      )}

      {reports.length === 0 && !adding && readOnly && (
        <p className="muted">{filtering ? 'ไม่มีรายงานที่ตรงกับตัวกรอง' : 'ยังไม่มีรายงานอาการ'}</p>
      )}

      {days.map(([date, rows]) => (
        <section className="report-day" key={date}>
          {/* หัววันแยกออกมา แถวข้างในจึงเหลือแค่เวลา — ไม่ต้องเขียนวันซ้ำทุกใบทั้งที่เป็นวันเดียวกัน */}
          {!visitId && (
            <h4 className="report-day-head">
              {formatDate(date)}
              {rows.length > 1 && <span className="muted"> · {rows.length} ใบ</span>}
            </h4>
          )}

          {rows.map((r) =>
            editingId === r.report_id ? (
              <Form
                key={r.report_id}
                initial={r}
                busy={busy}
                error={formError}
                photoUrl={photoUrl(r)}
                onSubmit={(body) => edit(r.report_id, body)}
                onCancel={() => { setEditingId(null); setFormError(null); }}
              />
            ) : (
              <article className={`report-row ${openId === r.report_id ? 'is-open' : ''}`} key={r.report_id}>
                <button type="button" className="report-row-head" onClick={() => setOpenId(openId === r.report_id ? null : r.report_id)}>
                  <span className={`report-row-time ${r.report_time ? '' : 'is-recorded'}`}>
                    {rowTime(r)}
                  </span>

                  <span className="report-row-brief">
                    {/* ใบที่ไม่ใช่รอบปกติต้องเห็นตั้งแต่ยังไม่กาง */}
                    {r.report_type && r.report_type !== 'routine' && (
                      <span className={`badge report-${r.report_type}`}>
                        {r.report_type === 'incident' ? 'ผิดปกติ' : 'เปลี่ยน'}
                      </span>
                    )}
                    {(daily ? dailyBrief(r) : simpleBrief(r)).join(' · ') || 'ดูรายละเอียด'}
                  </span>

                  <span className="report-row-by">{r.reported_by_name ?? '—'}</span>
                  {/* บอกว่าแถวนี้กางได้ — ไม่มีอะไรบอกเลยคนจะไม่รู้ว่ากดได้
                      กางอยู่แล้วไม่ต้องมีค้างไว้ ปุ่มที่ใช้จริงตอนนั้นคือ "ย่อรายงาน" ท้ายใบ */}
                  {openId !== r.report_id && <span className="report-row-more">ดูทั้งหมด</span>}
                </button>

                {openId === r.report_id && (
                  <div className="report-row-body">
                    {daily ? (
                      <DailyCareView report={r} photoUrl={photoUrl(r)} />
                    ) : (
                      <>
                        {vitalChips(r).length > 0 && (
                          <ul className="vital-chips">
                            {vitalChips(r).map(([label, value, unit]) => (
                              <li key={label}>
                                <span className="vital-label">{label}</span>
                                <span className="vital-value">{value}{unit && <span className="vital-unit"> {unit}</span>}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {TEXTS.filter((t) => r[t.key]).map((t) => (
                          <p className="report-text-row" key={t.key}>
                            <span className="field-label">{t.label}</span>
                            {/* ขึ้นบรรทัดใหม่ตามที่คนกรอกพิมพ์ไว้ — พนักงานเขียนเป็นข้อๆ กันเป็นปกติ */}
                            <span className="report-text-value">{r[t.key]}</span>
                          </p>
                        ))}
                      </>
                    )}

                    <div className="report-row-foot">
                      <span className="cell-sub">
                        บันทึกโดย {r.reported_by_name ?? '—'}
                        {/* แก้ทีหลังแล้วต้องเห็น ไม่งั้นบันทึกที่ถูกแก้จะดูเหมือนของดั้งเดิม */}
                        {r.updated_at !== r.created_at && ` · แก้ล่าสุด ${editedAt(r.updated_at)}`}
                      </span>
                      <span className="stack-actions">
                        {canEdit(r) && (
                          <button className="btn tiny" type="button" disabled={busy} onClick={() => { setEditingId(r.report_id); setFormError(null); }}>
                            แก้ไข
                          </button>
                        )}
                        {isAdmin && !readOnly && (
                          <ConfirmButton
                            className="btn tiny danger-ghost"
                            disabled={busy}
                            title={`ลบรายงานของวันที่ ${formatDate(r.report_date)}?`}
                            detail="เป็นบันทึกอาการที่ลบแล้วกู้คืนไม่ได้ — ถ้าแค่กรอกผิดให้กด “แก้ไข” แทน"
                            confirmLabel="ลบรายงาน"
                            onConfirm={() => remove(r.report_id)}
                          >
                            ลบ
                          </ConfirmButton>
                        )}
                      </span>
                    </div>

                    <button type="button" className="report-collapse" onClick={() => setOpenId(null)}>
                      ย่อรายงาน
                    </button>
                  </div>
                )}
              </article>
            ),
          )}
        </section>
      ))}

      {/* โหมดย่อ: ไม่ต้องมีปุ่มโหลดเพิ่ม ให้ไปดูต่อในตารางเต็มแทน */}
      {overflow && (
        <button className="btn report-more" type="button" onClick={() => setArchiveOpen(true)}>
          ดูตารางรายงานทั้งหมด ({meta.total} ใบ)
        </button>
      )}

      {archiveOpen && (
        <ReportArchiveModal
          caseId={caseId}
          caseInfo={caseInfo}
          title={archiveTitle}
          scope={scope}
          currentEmployeeId={currentEmployeeId}
          readOnly={readOnly}
          onClose={() => setArchiveOpen(false)}
        />
      )}

      {!overflow && meta.has_more && (
        <button className="btn report-more" type="button" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? 'กำลังโหลด…' : `ดูเก่ากว่านี้ (เหลืออีก ${meta.total - reports.length} ใบ)`}
        </button>
      )}

      {/* error ของการบันทึกตอนที่ฟอร์มถูกพับไปแล้ว (เช่น กดลบไม่ผ่าน) — ไม่มีฟอร์มให้แปะจึงมาอยู่ท้ายรายการ */}
      {formError && !adding && editingId == null && <p className="error">{formError}</p>}
    </div>
  );
}
