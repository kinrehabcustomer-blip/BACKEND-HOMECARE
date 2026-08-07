import { useEffect, useState } from 'react';
import { api } from '../api.js';
import CheckInModal from '../components/CheckInModal.jsx';
import { serviceName } from '../components/MyCaseModal.jsx';
import { getPosition } from '../lib/geo.js';
import { CASE_TYPE_LABELS, VISIT_STATE_LABELS, timeText, durationText } from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';

/** หน้าหลักของพนักงานภาคสนาม — กะงานวันนี้ พร้อมปุ่มเช็คอิน/เช็คเอาท์ */
export default function MyTodayPage() {
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState(null);
  const [checkinFor, setCheckinFor] = useState(null); // กะที่กำลังจะเช็คอิน (เปิด modal)
  const [busyId, setBusyId] = useState(null);         // กะที่กำลังเช็คเอาท์

  useEffect(() => {
    api.myToday().then(setVisits).catch((e) => setError(e.message));
  }, []);

  /** ทับกะที่อัปเดตแล้วในรายการ (หลังเช็คอิน/เอาท์) */
  const apply = (updated) =>
    setVisits((vs) => vs.map((v) => (v.visit_id === updated.visit_id ? updated : v)));

  async function checkOut(visit) {
    setBusyId(visit.visit_id);
    setError(null);
    try {
      const pos = await getPosition();
      apply(await api.checkOut(visit.visit_id, pos.ok ? { lat: pos.lat, lng: pos.lng } : {}));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!visits) return <p className="muted">กำลังโหลด…</p>;

  const dateLabel = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>งานวันนี้</h1>
          <p className="muted">{dateLabel} · {visits.length} กะ</p>
        </div>
      </header>

      {visits.length === 0 ? (
        <section className="card empty-state">
          <p>วันนี้คุณไม่มีกะงาน</p>
          <p className="muted">เมื่อผู้จัดการนัดกะให้คุณ งานจะปรากฏที่นี่</p>
        </section>
      ) : (
        <div className="shift-list">
          {visits.map((v) => (
            <ShiftCard
              key={v.visit_id}
              visit={v}
              busy={busyId === v.visit_id}
              onCheckIn={() => setCheckinFor(v)}
              onCheckOut={() => checkOut(v)}
            />
          ))}
        </div>
      )}

      {checkinFor && (
        <CheckInModal
          visit={checkinFor}
          onClose={() => setCheckinFor(null)}
          onDone={(updated) => {
            apply(updated);
            setCheckinFor(null);
          }}
        />
      )}
    </>
  );
}

function ShiftCard({ visit, busy, onCheckIn, onCheckOut }) {
  const planned = [visit.planned_start, visit.planned_end].filter(Boolean).join(' - ');
  const canCheckOut = visit.state === 'working' || visit.state === 'stale';

  return (
    <section className={`card shift-card visit-${visit.state}`}>
      <div className="shift-main">
        <div className="shift-when">
          <span className="shift-time">{planned || 'ไม่ระบุเวลา'}</span>
          <span className={`badge visit-${visit.state}`}>{VISIT_STATE_LABELS[visit.state]}</span>
        </div>
        <h2 className="shift-title">{visit.client_name}</h2>
        <p className="muted">{serviceName(visit) || CASE_TYPE_LABELS[visit.case_type]}</p>
        {visit.address && <p className="muted shift-addr"><LineIcon name="pin" className="text-ico" />{visit.address}</p>}

        {visit.check_in_at && (
          <p className="shift-times">
            เข้า {timeText(visit.check_in_at)}
            {visit.check_out_at && ` · ออก ${timeText(visit.check_out_at)} · รวม ${durationText(visit.worked_minutes)}`}
            {visit.location_flagged && <span className="badge flag">นอกพื้นที่</span>}
          </p>
        )}
      </div>

      <div className="shift-actions">
        {visit.state === 'scheduled' && (
          <button className="btn primary" disabled={busy} onClick={onCheckIn}>เช็คอิน</button>
        )}
        {canCheckOut && (
          <button className="btn primary" disabled={busy} onClick={onCheckOut}>
            {busy ? 'กำลังเช็คเอาท์…' : 'เช็คเอาท์'}
          </button>
        )}
        {visit.state === 'done' && <span className="shift-done"><LineIcon name="check" className="text-ico" />เสร็จแล้ว</span>}
      </div>
    </section>
  );
}
