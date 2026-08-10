import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import CheckInModal from '../components/CheckInModal.jsx';
import { serviceName } from '../components/MyCaseModal.jsx';
import { getPosition } from '../lib/geo.js';
import PageRefresh, { RefreshButton } from '../components/PageRefresh.jsx';
import { CASE_TYPE_LABELS, VISIT_STATE_LABELS, timeText, durationText } from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';

/** หน้าหลักของพนักงานภาคสนาม — กะงานวันนี้ พร้อมปุ่มเช็คอิน/เช็คเอาท์ */
export default function MyTodayPage() {
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);     // เวลาที่ข้อมูลชุดที่เห็นอยู่ถูกดึงมา
  const [loading, setLoading] = useState(false);
  const [checkinFor, setCheckinFor] = useState(null); // กะที่กำลังจะเช็คอิน (เปิด modal)
  const [busyId, setBusyId] = useState(null);         // กะที่กำลังเช็คเอาท์

  /* หน้านี้เปิดค้างไว้ทั้งวัน — เดิมโหลดครั้งเดียวตอนเปิดแล้วไม่ดึงใหม่อีกเลย
     ผู้จัดการเพิ่ม/ย้ายกะระหว่างวัน พนักงานจึงไม่เห็นจนกว่าจะปิด-เปิดแอปใหม่
     และไม่มีอะไรบอกว่าสิ่งที่เห็นอยู่เก่าแค่ไหน */
  const loadId = useRef(0);      // เลขรอบการโหลด — รอบที่ออกทีหลังชนะเสมอ
  const mutationId = useRef(0);  // เด้งขึ้นทุกครั้งที่เช็คอิน/เช็คเอาท์สำเร็จ

  const load = useCallback(async () => {
    const id = ++loadId.current;
    const mutationAtStart = mutationId.current;
    setLoading(true);
    try {
      const data = await api.myToday();
      /* ทิ้งผลชุดนี้ถ้ามีอะไรใหม่กว่าเกิดขึ้นระหว่างรอ:
         มีรอบโหลดใหม่แซงไป · หรือผู้ใช้เพิ่งเช็คอิน/เช็คเอาท์สำเร็จ
         อย่างหลังสำคัญกว่า — ข้อมูลชุดนี้ถูกดึงก่อนการเช็คอิน เอามาทับจะเห็นปุ่ม
         กลับไปเป็น "เช็คอิน" อีกครั้งทั้งที่เช็คอินไปแล้ว แล้วคนจะกดซ้ำ */
      if (id !== loadId.current || mutationAtStart !== mutationId.current) return;
      setVisits(data);
      setLoadedAt(new Date());
      setError(null); // โหลดผ่านแล้ว error ของรอบก่อนต้องหายไปด้วย
    } catch (e) {
      if (id === loadId.current) setError(e.message);
    } finally {
      // เทียบกับ loadId อย่างเดียว ไม่รวม mutationId — ไม่งั้นเช็คอินระหว่างโหลดค้างอยู่
      // จะทำให้ปุ่มรีเฟรชค้างเป็น disabled ตลอดกาล
      if (id === loadId.current) setLoading(false);
    }
  }, []);

  // โหลดรอบแรก — ส่วนการดึงหน้าลงและการโหลดใหม่ตอนกลับเข้าแอป <PageRefresh> จัดการให้
  useEffect(() => { load(); }, [load]);

  /** ทับกะที่อัปเดตแล้วในรายการ (หลังเช็คอิน/เอาท์) */
  const apply = (updated) => {
    mutationId.current++; // ประกาศว่าสิ่งที่อยู่บนจอตอนนี้ใหม่กว่าผลของ load ที่ยังค้างอยู่
    setVisits((vs) => vs.map((v) => (v.visit_id === updated.visit_id ? updated : v)));
  };

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

  const dateLabel = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      <header className="page-head">
        <div>
          <h1>งานวันนี้</h1>
          <p className="muted">{dateLabel}{visits && ` · ${visits.length} กะ`}</p>
        </div>
        <RefreshButton onRefresh={load} busy={loading} updatedAt={loadedAt} />
      </header>

      {/* error เป็นแถบเหนือรายการ ไม่ทับทั้งหน้า — กะที่โหลดมาได้แล้วต้องยังกดเช็คอิน/เช็คเอาท์ได้
          ถึงการดึงข้อมูลรอบล่าสุดจะล้มเหลว (พนักงานอยู่หน้างาน สัญญาณหายเป็นเรื่องปกติ) */}
      {error && <p className="error">{error}</p>}

      {!visits ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : visits.length === 0 ? (
        <section className="card empty-state">
          <p>วันนี้คุณไม่มีกะงาน</p>
          <p className="muted">
            เมื่อผู้จัดการนัดกะให้คุณ งานจะปรากฏที่นี่ — หน้านี้ดึงข้อมูลใหม่ให้เองทุกครั้งที่กลับเข้าแอป
          </p>
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
    </PageRefresh>
  );
}

function ShiftCard({ visit, busy, onCheckIn, onCheckOut }) {
  const planned = [visit.planned_start, visit.planned_end].filter(Boolean).join(' - ');
  const canCheckOut = visit.state === 'working' || visit.state === 'stale';

  /* เช็คเอาท์ต้องยืนยันก่อน — เดิมกดปุ่มเดียวจบกะทันที
     ฝั่งเช็คอินมี popup เต็มรูปแบบ (GPS + แผนที่ + เซลฟี่) ให้ทบทวนก่อนกดยืนยัน
     ด้านที่ย้อนกลับไม่ได้จึงกลายเป็นด้านที่กดง่ายกว่า — กดพลาดตอนล้วงมือถือในกระเป๋า
     คือกะจบด้วยเวลาผิด ซึ่งพนักงานแก้เองไม่ได้ ต้องให้ผู้จัดการเข้าไปแก้ใน "รายการต้องตรวจ" ให้

     ไม่ใช้ confirm() ของเบราว์เซอร์ เพราะถูกบล็อกได้แล้วคืน false เงียบๆ กลายเป็นปุ่มกดไม่ติด
     (เหตุผลเดียวกับที่ฟอร์มรับชำระเงินกับยกเลิกเคสย้ายออกจาก prompt() มาเป็นฟอร์มในหน้าแล้ว) */
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /* เดินนาฬิกาเฉพาะตอนกล่องยืนยันกางอยู่ — ตัวเลขที่โชว์ต้องเป็นเวลาที่จะถูกบันทึกจริง
     ถ้าจับเวลาไว้ตอนกดเปิดแล้วผู้ใช้ลังเลอยู่สองนาที ตัวเลขที่เห็นจะไม่ใช่สิ่งที่กำลังจะยืนยัน */
  useEffect(() => {
    if (!confirming) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [confirming]);

  /* กะไม่อยู่ในสถานะที่เช็คเอาท์ได้แล้ว (ออกสำเร็จ หรือผู้จัดการเข้าไปปิดกะให้ระหว่างที่กล่องกางอยู่)
     — ล้างธงทิ้งด้วย ไม่งั้นค่าจะค้าง แล้วกล่องยืนยันจะเด้งกลับมาเองถ้ากะกลับมาเช็คเอาท์ได้อีก
     เช็คเอาท์ล้มเหลว (สัญญาณหลุด) ไม่เข้าเงื่อนไขนี้ กล่องจึงค้างไว้ให้กดซ้ำได้ตามที่ควรเป็น */
  useEffect(() => {
    if (!canCheckOut) setConfirming(false);
  }, [canCheckOut]);

  /* เวลาทำงานที่จะถูกบันทึก — สูตรเดียวกับที่ server ใช้คิด worked_minutes (check_out − check_in)
     กันค่าติดลบไว้ด้วย เผื่อนาฬิกาเครื่องเดินเร็วกว่า server (durationText ไม่ได้ออกแบบมารับเลขติดลบ
     จะได้ "-1 ชม. -3 น." ซึ่งอ่านแล้วชวนให้คิดว่าระบบพัง) */
  const workedSoFar = visit.check_in_at
    ? Math.max(0, Math.round((now - new Date(visit.check_in_at).getTime()) / 60000))
    : null;

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

        {/* แพ้ยา/แพ้อาหาร — อ่านสดจากแฟ้มผู้ป่วย ไม่ใช่สำเนาในเคส (แฟ้มถูกแก้เมื่อไหร่ต้องเห็นทันที)
            วางไว้บนการ์ดของวันนี้เลย เพราะเป็นสิ่งที่ต้องรู้ "ก่อนถึงบ้าน" ไม่ใช่ต้องกดเข้าไปหา */}
        {(visit.patient_allergies || visit.patient_food_allergies) && (
          <p className="allergy-alert">
            <LineIcon name="alert" className="text-ico" />
            {visit.patient_allergies && <>แพ้ยา: {visit.patient_allergies}</>}
            {visit.patient_allergies && visit.patient_food_allergies && ' · '}
            {visit.patient_food_allergies && <>แพ้อาหาร: {visit.patient_food_allergies}</>}
          </p>
        )}

        {visit.check_in_at && (
          <p className="shift-times">
            เข้า {timeText(visit.check_in_at)}
            {visit.check_out_at && ` · ออก ${timeText(visit.check_out_at)} · รวม ${durationText(visit.worked_minutes)}`}
            {visit.location_flagged && <span className="badge flag">นอกพื้นที่</span>}
          </p>
        )}
      </div>

      {canCheckOut && confirming ? (
        <div className="shift-confirm">
          <p className="shift-confirm-when">
            บันทึกเวลาออก <strong>{timeText(now)}</strong>
            {workedSoFar != null && <> · รวม <strong>{durationText(workedSoFar)}</strong></>}
          </p>
          {/* ค้างข้ามวัน = ลืมกดออกเมื่อวาน ตัวเลขชั่วโมงจะผิดแน่ๆ ต้องบอกทางแก้ไว้ตรงนี้
              ก่อนที่เขาจะกดยืนยัน ไม่ใช่ปล่อยให้ไปงงทีหลังว่าทำไมชั่วโมงเยอะผิดปกติ */}
          {visit.state === 'stale' && (
            <p className="shift-confirm-warn">
              <LineIcon name="alert" className="text-ico" />
              กะนี้ค้างมาข้ามวัน — ถ้าเวลาไม่ตรง แจ้งผู้จัดการให้แก้ให้หลังกดยืนยัน
            </p>
          )}
          <div className="shift-confirm-actions">
            <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>ยังไม่ออก</button>
            <button className="btn primary" disabled={busy} onClick={onCheckOut}>
              {busy ? 'กำลังเช็คเอาท์…' : 'ยืนยันเช็คเอาท์'}
            </button>
          </div>
        </div>
      ) : (
        <div className="shift-actions">
          {visit.state === 'scheduled' && (
            <button className="btn primary" disabled={busy} onClick={onCheckIn}>เช็คอิน</button>
          )}
          {canCheckOut && (
            <button className="btn primary" disabled={busy} onClick={() => setConfirming(true)}>
              เช็คเอาท์
            </button>
          )}
          {visit.state === 'done' && <span className="shift-done"><LineIcon name="check" className="text-ico" />เสร็จแล้ว</span>}
        </div>
      )}
    </section>
  );
}
