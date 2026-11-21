import { useCallback, useEffect, useState } from 'react';
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

/**
 * หัวหน้าพาร์ทเนอร์ — งานที่ KIN ส่งมา (ผู้ใช้ขอ 21 พ.ย. 2569 · ดีไซน์ที่ตกลงกัน "หลังบ้านพาร์ทเนอร์")
 *   รอรับ   → รับงาน + เลือกคนในทีม / ปฏิเสธ (กะกลับไปหา KIN)
 *   รับแล้ว → เปลี่ยนคน / ปฏิเสธ (ก่อนเช็คอิน)
 *   ที่ผ่านมา → ไปแล้ว / ขาดงาน / ยกเลิก
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
  if (!v.check_in_at) return { text: 'ขาดงาน', cls: 'pt-tag is-warn' };
  return { text: 'ยังไม่เช็คเอาท์', cls: 'pt-tag is-warn' };
}

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

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([api.partnerMe(), api.partnerVisits(tab)])
      .then(([m, rows]) => { setMe(m); setList(rows); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tab]);
  useEffect(() => { setList(null); load(); }, [load]);

  const done = (msg) => { setAssigning(null); setRejecting(null); toast(msg); load(); };

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
              <span className="tile-share">ครั้ง (เช็คอิน+เช็คเอาท์)</span>
            </div>
          </div>
        )}

        <div className="seg pt-tabs" role="tablist" aria-label="สถานะงาน">
          {TABS.map((t) => {
            const n = t.key === 'past' ? null : me?.counts?.[t.key];
            return (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
                {t.label}{n ? ` · ${n}` : ''}
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
                    <strong>{formatDate(v.visit_date)}{timeRange(v) ? ` · ${timeRange(v)} น.` : ''}</strong>
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
                  {tab !== 'past' && !v.check_in_at && v.visit_date < todayTH() && (
                    <p className="pt-who"><span className="pt-tag is-warn">เลยวันแล้ว · ยังไม่มีการเช็คอิน</span></p>
                  )}
                  {tab !== 'past' && !v.check_in_at && v.visit_date >= todayTH() && (
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
        <p className="muted pt-foot">ไม่เห็นราคาที่ลูกค้าจ่าย · เห็นเฉพาะกะที่ส่งให้บริษัทคุณ</p>
      </div>

      {viewing && (
        <DetailDialog visit={viewing} tab={tab} onCancel={() => setViewing(null)}
          onAssign={(v) => { setViewing(null); setAssigning(v); }}
          onReject={(v) => { setViewing(null); setRejecting(v); }} />
      )}
      {assigning && <AssignDialog visit={assigning} onCancel={() => setAssigning(null)} onDone={done} />}
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

/** รายละเอียดเคสคร่าวๆ — server ให้เท่าที่ใช้เตรียมตัว (ไม่มีอาการ/โรค/เบอร์โทร/ราคา · partners/repo.js partnerVisitDetail) */
function DetailDialog({ visit, tab, onCancel, onAssign, onReject }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEsc(onCancel);
  useEffect(() => {
    api.partnerVisit(visit.visit_id).then(setD).catch((e) => setError(e.message));
  }, [visit.visit_id]);
  const v = d ?? visit;
  const map = mapUrl(v);
  const body = [
    v.patient_gender && GENDER_LABELS[v.patient_gender],
    v.patient_age != null && `${v.patient_age} ปี`,
    v.weight_kg && `${v.weight_kg} กก.`,
    v.height_cm && `${v.height_cm} ซม.`,
  ].filter(Boolean).join(' · ');
  // ต้องโหลดรายละเอียดสำเร็จก่อน — KIN ดึงกะคืนไประหว่างนั้น (404) ไม่ควรเหลือปุ่มที่กดแล้วพัง
  const canAct = Boolean(d) && tab !== 'past' && v.status !== 'cancelled' && !v.check_in_at && v.visit_date >= todayTH();
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow pt-sheet" role="dialog" aria-modal="true" aria-labelledby="pt-detail-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 id="pt-detail-title">{v.client_name}</h2>
            <p className="muted">{v.substitute ? 'ไปแทนทีม KIN' : 'งานรายครั้ง'}{v.service_name ? ` · ${v.service_name}` : ''}</p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด">×</button>
        </header>
        <div className="modal-body">
          {error && <p className="error" role="alert">{error}</p>}
          <dl className="pt-detail">
            <dt>นัดครั้งนี้</dt>
            <dd>
              {formatDate(v.visit_date)}{timeRange(v) ? ` · ${timeRange(v)} น.` : ''}
              {d?.visit_no && d?.visit_total ? <span className="muted"> · ครั้งที่ {d.visit_no} จาก {d.visit_total} ของเคส</span> : null}
            </dd>
            {d && (d.start_date || d.end_date) && (
              <>
                <dt>ช่วงเคส</dt>
                <dd>{d.start_date ? formatDate(d.start_date) : '—'} – {d.end_date ? formatDate(d.end_date) : 'ยังไม่กำหนด'}</dd>
              </>
            )}
            {body && (<><dt>ผู้รับบริการ</dt><dd>{body}</dd></>)}
            {d?.medical_devices && (<><dt>อุปกรณ์ที่ติดตัว</dt><dd className="pt-pre">{d.medical_devices}</dd></>)}
            <dt>สถานที่</dt>
            <dd>
              {v.address || <span className="muted">ไม่ได้ระบุที่อยู่</span>}
              {map && <><br /><a href={map} target="_blank" rel="noopener noreferrer" className="pt-map"><LineIcon name="pin" className="text-ico" />เปิดแผนที่</a></>}
            </dd>
            <dt>คนที่ไป</dt>
            <dd>
              {v.assigned_name || <span className="muted">ยังไม่ได้เลือกคน</span>}
              {v.check_in_at && <span className="muted"> · เข้า {hhmm(v.check_in_at)}{v.check_out_at ? ` · ออก ${hhmm(v.check_out_at)}` : ''}</span>}
            </dd>
          </dl>
          {!d && !error && <p className="muted">กำลังโหลดรายละเอียด…</p>}
          {d?.others?.length > 0 && (
            <section className="pt-detail-others">
              <h3>กะอื่นของเคสนี้ที่ส่งให้บริษัทคุณ</h3>
              <ul>
                {d.others.map((o) => {
                  const past = o.visit_date < todayTH();
                  const tag = o.status === 'cancelled' ? 'ยกเลิก'
                    : o.check_out_at ? 'ไปแล้ว'
                      : o.check_in_at ? (past ? 'ยังไม่เช็คเอาท์' : 'กำลังทำงาน')
                        : past ? 'ขาดงาน' : 'รอวันนัด';
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
          {canAct ? (
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
      onDone(`ส่งงานให้ ${chosen?.first_name ?? ''} แล้ว — เขาได้แจ้งเตือนในแอป`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow pt-sheet" role="dialog" aria-modal="true" aria-labelledby="pt-assign-title" onClick={(e) => e.stopPropagation()}>
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
                  <span className="pt-person-main">
                    <b>{p.first_name} {p.last_name}{p.nickname ? ` (${p.nickname})` : ''}</b>
                    <span className="muted">
                      {POSITION_LABELS[p.position] ?? p.position}
                      {p.busy.length > 0 ? ` · มีงาน ${p.busy.map((b) => (b.start ? `${b.start}${b.end ? `–${b.end}` : ''}` : 'ทั้งวัน')).join(', ')}` : ' · ว่างทั้งวัน'}
                    </span>
                  </span>
                  <span className={`pt-tag ${p.conflict ? 'is-warn' : 'is-ok'}`}>{p.conflict ? 'ชนเวลา' : 'ว่าง'}</span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <p className="move-note"><LineIcon name="bell" className="text-ico" />คนที่เลือกได้แจ้งเตือน "กะใหม่" ทันที · เปลี่ยนคนได้จนถึงก่อนเช็คอิน</p>
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
      <div className="modal modal-narrow" role="alertdialog" aria-modal="true" aria-labelledby="pt-reject-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 id="pt-reject-title">ปฏิเสธงานนี้?</h2>
            <p className="muted">{formatDate(visit.visit_date)}{timeRange(visit) ? ` · ${timeRange(visit)}` : ''} · {visit.client_name}</p>
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
