import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { GENDER_LABELS, POSITION_LABELS, formatDate, todayTH } from '../labels.js';
import { timeRange } from '../lib/calendarUi.js';
import { useScrollLock } from '../lib/scrollLock.js';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import LineIcon from '../components/LineIcon.jsx';
import PartnerLogo from '../components/PartnerLogo.jsx';
import DailyCareForm from '../components/DailyCareForm.jsx';
import { usesPhysioRecord, DAILY_SECTIONS, PHYSIO_SECTIONS } from '../lib/dailyCare.js';

/**
 * หัวหน้าพาร์ทเนอร์ — งานที่ KIN ส่งมา (ผู้ใช้ขอ 21 พ.ย. 2569 · ดีไซน์ที่ตกลงกัน "หลังบ้านพาร์ทเนอร์")
 *   รอรับ   → รับงาน + เลือกคนในทีม / ปฏิเสธ (กะกลับไปหา KIN)
 *   รับแล้ว → เปลี่ยนคน / ปฏิเสธ (ก่อนวันนัด) · ถึงวันนัดแล้ว → ลงรายงาน + เวลาเริ่ม–จบ (27 พ.ย. 2569)
 *   ที่ผ่านมา → ไปแล้ว / ยังไม่ลงรายงาน (ลงย้อนหลังได้) / ยกเลิก
 * พนักงานพาร์ทเนอร์ไม่ได้เข้าระบบ — ไม่มีเช็คอินของเขา หัวหน้าเป็นคนลงรายงาน แล้วกะนับว่าไปจริง (นับเงิน)
 * server กรองด้วยบริษัทใน session — ไม่มีราคาที่ลูกค้าจ่าย ไม่มีอาการ ไม่มีกะอื่นของเคส (partners/repo.js)
 */
const TABS = [
  { key: 'pending', label: 'รอรับ' },
  { key: 'accepted', label: 'รับแล้ว' },
  { key: 'past', label: 'ที่ผ่านมา' },
];

const mapUrl = (v) => (v.geo_lat && v.geo_lng
  ? `https://www.google.com/maps/search/?api=1&query=${v.geo_lat},${v.geo_lng}`
  : v.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.address)}` : null);

function pastLabel(v) {
  if (v.status === 'cancelled') return { text: 'ยกเลิก', cls: 'pt-tag is-muted' };
  if (v.check_out_at) return { text: 'ไปแล้ว', cls: 'pt-tag is-ok' };
  if (!v.check_in_at && v.partner_status === 'pending') return { text: 'ไม่มีคนรับ', cls: 'pt-tag is-muted' };
  if (!v.check_in_at) return { text: 'ยังไม่ลงรายงาน', cls: 'pt-tag is-warn' };
  return { text: 'ไปแล้ว', cls: 'pt-tag is-ok' };
}

/** ลงรายงานได้ไหม — รับงานแล้ว มีคนไป ยังไม่ลง ไม่ถูกยกเลิก และถึงวันนัดแล้ว (เกณฑ์เดียวกับ server reportVisit) */
const canReport = (v) => v.partner_status === 'accepted' && Boolean(v.assigned_to) && !v.check_in_at
  && v.status !== 'cancelled' && v.visit_date <= todayTH();

const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : '');

export default function PartnerJobsPage() {
  const toast = useToast();
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('pending');
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [reporting, setReporting] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([api.partnerMe(), api.partnerVisits(tab)])
      .then(([m, rows]) => { setMe(m); setList(rows); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tab]);
  useEffect(() => { setList(null); load(); }, [load]);

  const done = (msg) => { setAssigning(null); setRejecting(null); setReporting(null); toast(msg); load(); };

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      <div className="pt-page">
        <header className="pt-head">
          <div className="pt-head-brand">
            {me?.has_logo && <PartnerLogo partner={me} size={52} />}
            <div>
              <h1>งานที่ส่งมา</h1>
              {me && <p className="muted">{me.name} · พาร์ทเนอร์ของ KIN Homecare</p>}
            </div>
          </div>
        </header>

        {/* ตัวเลขสรุป — เฉพาะจอคอม (มือถือมีตัวเลขในแท็บอยู่แล้ว · ผู้ใช้ขอ UI สำหรับ PC 21 พ.ย. 2569) */}
        {me?.counts && (
          <div className="tiles pt-tiles">
            <button type="button" className={`tile${me.counts.urgent ? ' is-alert' : ''}`} onClick={() => setTab('pending')}>
              <span className="tile-label">ต้องเลือกคนด่วน</span>
              <span className="tile-value">{me.counts.urgent}</span>
              <span className="tile-share">นัดภายใน 24 ชม.</span>
            </button>
            <button type="button" className="tile" onClick={() => setTab('pending')}>
              <span className="tile-label">รอรับ</span>
              <span className="tile-value">{me.counts.pending}</span>
              <span className="tile-share">ยังไม่ได้เลือกคน</span>
            </button>
            <button type="button" className="tile" onClick={() => setTab('accepted')}>
              <span className="tile-label">รับแล้ว</span>
              <span className="tile-value">{me.counts.accepted}</span>
              <span className="tile-share">มีคนไปแล้ว รอวันนัด</span>
            </button>
            <div className="tile is-static">
              <span className="tile-label">เดือนนี้ไปแล้ว</span>
              <span className="tile-value">{me.counts.done_month}</span>
              <span className="tile-share">ครั้ง (ลงรายงานแล้ว)</span>
            </div>
          </div>
        )}

        {/* แถบแท็บแบบเส้นใต้ เต็มความกว้าง + ตัวเลขเป็นป้าย (ผู้ใช้ขอออกแบบใหม่ 23 พ.ย. 2569) */}
        <div className="pt-tabbar" role="tablist" aria-label="สถานะงาน">
          {TABS.map((t) => {
            const n = t.key === 'past' ? null : me?.counts?.[t.key];
            return (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                className={`pt-tab${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
                <span>{t.label}</span>
                {n > 0 && <span className="pt-tab-count">{n}</span>}
              </button>
            );
          })}
        </div>

        <ErrorBar message={error} onRetry={load} busy={loading} />

        {!list ? (!error && <p className="muted">กำลังโหลด…</p>) : list.length === 0 ? (
          <section className="card empty-state">
            <p>{tab === 'pending' ? 'ยังไม่มีงานรอรับ' : tab === 'accepted' ? 'ยังไม่มีงานที่รับไว้' : 'ยังไม่มีประวัติงาน'}</p>
            {tab === 'pending' && <p className="muted">KIN ส่งงานมาเมื่อไร จะมีแจ้งเตือนและขึ้นที่นี่</p>}
          </section>
        ) : (
          <div className="pt-list">
            {list.map((v) => {
              const map = mapUrl(v);
              const urgent = tab === 'pending' && v.starts_in_hours <= 24;
              const past = tab === 'past' ? pastLabel(v) : null;
              return (
                /* กดที่ตัวการ์ด = ดูรายละเอียดเคสคร่าวๆ (ผู้ใช้ขอ 21 พ.ย. 2569) · ปุ่ม/ลิงก์ในการ์ดไม่เปิดกล่อง */
                <article key={v.visit_id} className="pt-card is-clickable" role="button" tabIndex={0}
                  aria-label={`ดูรายละเอียดเคส ${v.client_name} ${formatDate(v.visit_date)}`}
                  onClick={(e) => { if (!e.target.closest('button, a')) setViewing(v); }}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setViewing(v); } }}>
                  <div className="pt-card-top">
                    <span className={`pt-tag ${v.substitute ? 'is-sub' : 'is-once'}`}>{v.substitute ? 'ไปแทนทีม KIN' : 'งานรายครั้ง'}</span>
                    {urgent && <span className="pt-due">ต้องเลือกคนภายใน {Math.max(0, v.starts_in_hours)} ชม.</span>}
                    {past && <span className={past.cls}>{past.text}</span>}
                    <span className="pt-more">ดูรายละเอียด ›</span>
                  </div>
                  <div className="pt-when">
                    <strong>
                      {formatDate(v.visit_date)}
                      {timeRange(v) && <><span className="pt-when-sep"> · </span><span className="pt-when-time">{timeRange(v)} น.</span></>}
                    </strong>
                    {v.service_name && <span>{v.service_name}</span>}
                  </div>
                  <div className="pt-where">
                    <b>{v.client_name}</b>
                    {v.address && <span className="muted">{v.address}</span>}
                    {map && <a href={map} target="_blank" rel="noopener noreferrer" className="pt-map"><LineIcon name="pin" className="text-ico" />เปิดแผนที่</a>}
                  </div>
                  {v.assigned_to && (
                    <p className="pt-who">
                      {v.assigned_name}
                      {v.check_in_at && <span className="muted"> · เข้า {hhmm(v.check_in_at)}{v.check_out_at ? ` · ออก ${hhmm(v.check_out_at)}` : ''}</span>}
                    </p>
                  )}
                  {canReport(v) && (
                    <div className="pt-actions">
                      <span className="pt-report-hint muted">ไปแล้ว? ลงรายงานพร้อมเวลาเริ่ม–จบ เพื่อนับเป็นงานที่ไปจริง</span>
                      <button type="button" className="btn primary" onClick={() => setReporting(v)}>ลงรายงาน</button>
                    </div>
                  )}
                  {/* ถึงวันนัดแล้ว = การ์ดมีแค่ปุ่มลงรายงาน (ปฏิเสธ/เปลี่ยนคนวันนี้ยังทำได้ในรายละเอียด) */}
                  {tab !== 'past' && !v.check_in_at && v.visit_date >= todayTH() && !canReport(v) && (
                    <div className="pt-actions">
                      <button type="button" className="btn" onClick={() => setRejecting(v)}>ปฏิเสธ</button>
                      <button type="button" className="btn primary" onClick={() => setAssigning(v)}>
                        {tab === 'pending' ? 'รับงาน + เลือกคน' : 'เปลี่ยนคน'}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        <p className="muted pt-foot">
          <svg className="pt-foot-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          ไม่เห็นราคาที่ลูกค้าจ่าย · เห็นเฉพาะกะที่ส่งให้บริษัทคุณ</p>
      </div>

      {viewing && (
        <DetailDialog visit={viewing} tab={tab} onCancel={() => setViewing(null)}
          onReport={(v) => { setViewing(null); setReporting(v); }}
          onAssign={(v) => { setViewing(null); setAssigning(v); }}
          onReject={(v) => { setViewing(null); setRejecting(v); }} />
      )}
      {assigning && <AssignDialog visit={assigning} onCancel={() => setAssigning(null)} onDone={done} />}
      {reporting && <ReportDialog visit={reporting} onCancel={() => setReporting(null)} onDone={done} />}
      {rejecting && <RejectDialog visit={rejecting} onCancel={() => setRejecting(null)} onDone={done} />}
    </PageRefresh>
  );
}

function useEsc(onCancel) {
  useScrollLock();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
}

/** รายละเอียดเคส + ผู้รับบริการ — server ให้ชุดเดียวกับพนักงานภาคสนาม ไม่มีเบอร์ญาติ/ราคา (partners/repo.js partnerVisitDetail) */
function DetailDialog({ visit, tab, onCancel, onAssign, onReject, onReport }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEsc(onCancel);
  useEffect(() => {
    api.partnerVisit(visit.visit_id).then(setD).catch((e) => setError(e.message));
  }, [visit.visit_id]);
  const v = d ?? visit;
  const map = mapUrl(v);
  const genderAge = [v.patient_gender && GENDER_LABELS[v.patient_gender], v.patient_age != null && `${v.patient_age} ปี`]
    .filter(Boolean).join(' / ');
  const weightHeight = [v.weight_kg && `${v.weight_kg} กก.`, v.height_cm && `${v.height_cm} ซม.`].filter(Boolean).join(' / ');
  // ต้องโหลดรายละเอียดสำเร็จก่อน — KIN ดึงกะคืนไประหว่างนั้น (404) ไม่ควรเหลือปุ่มที่กดแล้วพัง
  const canAct = Boolean(d) && tab !== 'past' && v.status !== 'cancelled' && !v.check_in_at && v.visit_date >= todayTH();
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow pt-sheet pt-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="pt-detail-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            {/* ประเภทงานเป็นป้ายเหนือชื่อ (ดีไซน์ใหม่) */}
            <p className="muted pt-detail-kind">
              <span className={`pt-tag ${v.substitute ? 'is-sub' : 'is-once'}`}>{v.substitute ? 'ไปแทนทีม KIN' : 'งานรายครั้ง'}</span>
              {v.service_name && <span>{v.service_name}</span>}
            </p>
            <h2 id="pt-detail-title">{v.client_name}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด">×</button>
        </header>
        <div className="modal-body">
          {error && <p className="error" role="alert">{error}</p>}
          <dl className="pt-detail">
            <dt><LineIcon name="calendar" className="pt-dt-ico" />นัดครั้งนี้</dt>
            <dd>
              {formatDate(v.visit_date)}{timeRange(v) ? ` · ${timeRange(v)} น.` : ''}
              {d?.visit_no && d?.visit_total ? <span className="muted"> · ครั้งที่ {d.visit_no} จาก {d.visit_total} ของเคส</span> : null}
            </dd>
            {d && (d.start_date || d.end_date) && (
              <>
                <dt><ClockIcon />ช่วงเคส</dt>
                <dd>{d.start_date ? formatDate(d.start_date) : '—'} – {d.end_date ? formatDate(d.end_date) : 'ยังไม่กำหนด'}</dd>
              </>
            )}
            <dt><LineIcon name="pin" className="pt-dt-ico" />สถานที่</dt>
            <dd>
              {v.address || <span className="muted">ไม่ได้ระบุที่อยู่</span>}
              {map && (
                <span className="pt-map-row">
                  <a href={map} target="_blank" rel="noopener noreferrer" className="pt-map"><LineIcon name="pin" className="text-ico" />เปิดแผนที่</a>
                  <CopyMapButton url={map} />
                </span>
              )}
            </dd>
            <dt><PersonIcon />คนที่ไป</dt>
            <dd>
              {v.assigned_name || <span className="pt-detail-unassigned">ยังไม่ได้เลือกคน</span>}
              {v.check_in_at && <span className="muted"> · เข้า {hhmm(v.check_in_at)}{v.check_out_at ? ` · ออก ${hhmm(v.check_out_at)}` : ''}</span>}
            </dd>
          </dl>
          {!d && !error && <p className="muted">กำลังโหลดรายละเอียด…</p>}
          {/* รายละเอียดผู้รับบริการ — ชุดเดียวกับหน้าเคสของ KIN (ผู้ใช้ขอ 23 พ.ย. 2569) */}
          {d && (
            <section className="pt-detail-others pt-patient">
              <h3>รายละเอียดผู้รับบริการ</h3>
              <div className="pt-patient-grid">
                <PField label="ชื่อผู้รับบริการ" value={d.client_name} />
                <PField label="เพศ / อายุ" value={genderAge} />
                <PField label="น้ำหนัก / ส่วนสูง" value={weightHeight} />
              </div>
              {(d.patient_allergies || d.patient_food_allergies) && (
                <p className="allergy-alert">
                  <LineIcon name="alert" className="text-ico" />
                  {d.patient_allergies && <>แพ้ยา: {d.patient_allergies}</>}
                  {d.patient_allergies && d.patient_food_allergies && ' · '}
                  {d.patient_food_allergies && <>แพ้อาหาร: {d.patient_food_allergies}</>}
                </p>
              )}
              <PField label="โรคประจำตัว" value={d.medical_history} />
              <PField label="อาการปัจจุบัน" value={d.current_symptoms} />
              {d.medical_devices && <PField label="อุปกรณ์ / สายต่างๆ" value={d.medical_devices} />}
              <PField label="จุดประสงค์ในการดูแล" value={d.care_goal} />
            </section>
          )}
          {d?.others?.length > 0 && (
            <section className="pt-detail-others">
              <h3>กะอื่นของเคสนี้ที่ส่งให้บริษัทคุณ</h3>
              <ul>
                {d.others.map((o) => {
                  const past = o.visit_date < todayTH();
                  const tag = o.status === 'cancelled' ? 'ยกเลิก'
                    : o.check_in_at ? 'ไปแล้ว'
                      : past ? 'ยังไม่ลงรายงาน' : 'รอวันนัด';
                  return (
                    <li key={o.visit_id}>
                      <span>{formatDate(o.visit_date)}{timeRange(o) ? ` · ${timeRange(o)}` : ''}</span>
                      <span className="muted">{o.assigned_name || 'ยังไม่ได้เลือกคน'} · {tag}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
        <footer className="modal-foot">
          {d && canReport(v) ? (
            <>
              {canAct ? (
                <>
                  <button type="button" className="btn" onClick={() => onReject(visit)}>ปฏิเสธ</button>
                  <button type="button" className="btn" onClick={() => onAssign(visit)}>เปลี่ยนคน</button>
                </>
              ) : <button type="button" className="btn" onClick={onCancel}>ปิด</button>}
              <button type="button" className="btn primary" onClick={() => onReport(visit)}>ลงรายงาน</button>
            </>
          ) : canAct ? (
            <>
              <button type="button" className="btn" onClick={() => onReject(visit)}>ปฏิเสธ</button>
              <button type="button" className="btn primary" onClick={() => onAssign(visit)}>
                {tab === 'pending' ? 'รับงาน + เลือกคน' : 'เปลี่ยนคน'}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={onCancel}>ปิด</button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** คัดลอกลิงก์แผนที่ (ผู้ใช้ขอ 27 พ.ย. 2569) — ส่งต่อให้คนในทีมทางแชทได้ · ปุ่มบอกผลเองแล้วกลับเป็นปกติ */
function CopyMapButton({ url }) {
  const [state, setState] = useState(null); // null · 'ok' · 'fail'
  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => setState(null), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setState('ok');
    } catch {
      setState('fail');
    }
  };
  return (
    <button type="button" className={state === 'ok' ? 'pt-map pt-map-copy is-done' : 'pt-map pt-map-copy'} onClick={copy} aria-live="polite">
      {state === 'ok' ? <LineIcon name="check" className="text-ico" /> : (
        <svg className="text-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
        </svg>
      )}
      {state === 'ok' ? 'คัดลอกแล้ว' : state === 'fail' ? 'คัดลอกไม่ได้' : 'คัดลอกลิงก์'}
    </button>
  );
}

/* ไอคอนตกแต่งหน้าหัวข้อในกล่องรายละเอียด — LineIcon ไม่มีนาฬิกา/คน */
function ClockIcon() {
  return (
    <svg className="pt-dt-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}
function PersonIcon() {
  return (
    <svg className="pt-dt-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function PField({ label, value }) {
  const empty = value == null || value === '';
  return (
    <div className="pt-pfield">
      <span className="pt-pfield-label">{label}</span>
      <span className={`pt-pfield-value${empty ? ' is-empty' : ''}`}>{empty ? 'ไม่ได้ระบุ' : value}</span>
    </div>
  );
}

/** เลือกคนในทีม — คนที่มีกะอื่นชนเวลานี้เลือกไม่ได้ */
function AssignDialog({ visit, onCancel, onDone }) {
  const [people, setPeople] = useState(null);
  const [pick, setPick] = useState(visit.assigned_to ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEsc(onCancel);
  useEffect(() => {
    api.partnerCandidates(visit.visit_id).then(setPeople).catch((e) => setError(e.message));
  }, [visit.visit_id]);
  const chosen = people?.find((p) => p.employee_id === pick);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.partnerAccept(visit.visit_id, pick);
      onDone(`ให้ ${chosen?.first_name ?? ''} ไปงานนี้แล้ว`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow pt-sheet pt-assign-dialog" role="dialog" aria-modal="true" aria-labelledby="pt-assign-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 id="pt-assign-title">เลือกคนที่จะไป</h2>
            <p className="muted">{formatDate(visit.visit_date)}{timeRange(visit) ? ` · ${timeRange(visit)}` : ''} · {visit.client_name}</p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด" disabled={busy}>×</button>
        </header>
        <div className="modal-body">
          {!people ? (!error && <p className="muted">กำลังโหลดทีม…</p>) : people.length === 0 ? (
            <p className="muted">ยังไม่มีคนในทีม — เพิ่มคนที่หน้า "ทีมของฉัน" ก่อน</p>
          ) : (
            <div className="pt-people" role="radiogroup" aria-label="คนในทีม">
              {people.map((p) => (
                <label key={p.employee_id} className={`pt-person${pick === p.employee_id ? ' is-on' : ''}${p.conflict ? ' is-busy' : ''}`}>
                  <input type="radio" name="pt-who" value={p.employee_id} checked={pick === p.employee_id}
                    disabled={p.conflict || busy} onChange={() => setPick(p.employee_id)} />
                  <span className="pt-person-avatar" aria-hidden="true">{p.first_name?.[0] ?? '?'}</span>
                  <span className="pt-person-main">
                    <b>{p.first_name} {p.last_name}{p.nickname ? ` (${p.nickname})` : ''}</b>
                    <span className="muted">
                      {POSITION_LABELS[p.position] ?? p.position}
                      {p.busy.length > 0 ? ` · มีงาน ${p.busy.map((b) => `${b.date ? `${formatDate(b.date)} ` : ''}${b.start ? `${b.start}${b.end ? `–${b.end}` : ''}` : 'ทั้งวัน'}`).join(', ')}` : ' · ว่างทั้งวัน'}
                    </span>
                  </span>
                  <span className={`pt-tag ${p.conflict ? 'is-warn' : 'is-ok'}`}>{p.conflict ? 'ชนเวลา' : 'ว่าง'}</span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <p className="move-note"><LineIcon name="bell" className="text-ico" />เปลี่ยนคนได้จนถึงก่อนวันนัด · ไปแล้วให้กด "ลงรายงาน" ที่การ์ดงาน</p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="button" className="btn primary" disabled={!pick || busy || pick === visit.assigned_to || chosen?.conflict} onClick={submit}>
            {busy ? 'กำลังส่ง…' : chosen ? `ยืนยัน · ส่งให้ ${chosen.first_name}` : 'ยืนยัน'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * ลงรายงานของกะ + เวลาเริ่ม–จบที่ไปจริง (ผู้ใช้ขอ 27 พ.ย. 2569)
 * ฟอร์มรายงานชุดเดียวกับพนักงาน KIN (กายภาพ = บันทึกการรักษา · อื่น = บันทึกการดูแลประจำวัน)
 * บันทึกแล้วกะนับว่าไปจริง (นับเงิน) — แก้ทีหลังไม่ได้จากหน้านี้ ถ้าลงผิดให้แจ้ง KIN
 */
function ReportDialog({ visit, onCancel, onDone }) {
  const [start, setStart] = useState(visit.planned_start ?? '');
  const [end, setEnd] = useState(visit.planned_end ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const requestId = useRef(crypto.randomUUID());
  useEsc(() => { if (!busy) onCancel(); });
  const physio = usesPhysioRecord(visit);
  const submit = async (form) => {
    if (!start || !end) { setError('กรอกเวลาเริ่มและเวลาจบที่ไปจริงก่อน'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.partnerReport(visit.visit_id, { ...form, start, end, request_id: requestId.current });
      onDone(`ลงรายงานแล้ว — นับเป็นงานที่ไปจริง (${start}–${end} น.)`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={() => !busy && onCancel()}>
      <div className="modal pt-sheet pt-report-dialog" role="dialog" aria-modal="true" aria-labelledby="pt-report-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 id="pt-report-title">ลงรายงาน</h2>
            <p className="muted">{formatDate(visit.visit_date)} · {visit.client_name}{visit.assigned_name ? ` · ${visit.assigned_name}` : ''}</p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด" disabled={busy}>×</button>
        </header>
        <div className="modal-body">
          <fieldset className="pt-report-time" disabled={busy}>
            <legend>เวลาที่ไปจริง <span className="muted">(ใช้คิดว่าไปจริง · ตั้งต้นเป็นเวลานัด)</span></legend>
            <label>เริ่ม<input type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
            <span aria-hidden="true">–</span>
            <label>จบ<input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
          </fieldset>
          <DailyCareForm
            initial={{ report_date: visit.visit_date }} // server บันทึกเป็นวันนัดเสมอ — ให้ช่องวันที่ตรงกัน
            sections={physio ? PHYSIO_SECTIONS : DAILY_SECTIONS}
            busy={busy}
            error={error}
            onSubmit={submit}
            onCancel={onCancel}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** ปฏิเสธ — กะกลับไปให้ KIN หาคนเอง · เหตุผลช่วยให้ KIN วางแผนครั้งหน้า */
function RejectDialog({ visit, onCancel, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEsc(onCancel);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.partnerReject(visit.visit_id, reason.trim());
      onDone('ปฏิเสธงานแล้ว — KIN ได้รับแจ้ง');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow pt-reject-modal" role="alertdialog" aria-modal="true" aria-labelledby="pt-reject-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="pt-reject-head">
            <LineIcon name="alert" className="pt-reject-ico" />
            <div>
              <h2 id="pt-reject-title">ปฏิเสธงานนี้?</h2>
              <p className="muted">{formatDate(visit.visit_date)}{timeRange(visit) ? ` · ${timeRange(visit)}` : ''} · {visit.client_name}</p>
            </div>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด" disabled={busy}>×</button>
        </header>
        <div className="modal-body">
          <label className="pt-field">
            เหตุผล (ไม่บังคับ)
            <textarea rows={3} maxLength={300} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)}
              placeholder="เช่น ไม่มีคนว่างช่วงเวลานี้" />
          </label>
          {visit.assigned_to && <p className="muted">{visit.assigned_name} จะได้แจ้งว่ากะนี้ถูกถอนออก</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>ไม่ปฏิเสธ</button>
          <button type="button" className="btn danger" onClick={submit} disabled={busy}>{busy ? 'กำลังส่ง…' : 'ปฏิเสธงาน'}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
