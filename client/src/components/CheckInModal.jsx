import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import FileButton from './FileButton.jsx';
import { getPosition } from '../lib/geo.js';
import { compressImage } from '../lib/image.js';
import { serviceName } from './MyCaseModal.jsx';
import LocationMap from './LocationMap.jsx';
import { CASE_TYPE_LABELS } from '../labels.js';

/**
 * popup ยืนยันเช็คอินกะ — ขอ GPS ตอนเปิด แล้วให้แนบเซลฟี่ได้ (ไม่บังคับ)
 * เวลาเช็คอินจริงตั้งจากฝั่ง server (now()) — ที่นี่แค่ส่งพิกัด/รูปประกอบ
 * onDone(updatedVisit) เมื่อเช็คอินสำเร็จ (พ่อแม่เอาไปรีเฟรชรายการ)
 */
export default function CheckInModal({ visit, onDone, onClose }) {
  const sheetRef = useSheetSwipe(onClose);    // จอแคบ: ปัดลงเพื่อปิด
  const [pos, setPos] = useState(null);       // ผลขอ GPS: { ok, lat, lng, accuracy, reason }
  const [locating, setLocating] = useState(true);
  const [photo, setPhoto] = useState(null);   // data URL เซลฟี่ (ย่อแล้ว)
  const [photoBusy, setPhotoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getPosition().then((p) => {
      if (cancelled) return;
      setPos(p);
      setLocating(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose, busy]);

  async function retryLocation() {
    setLocating(true);
    setPos(await getPosition());
    setLocating(false);
  }

  async function pickPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPhotoBusy(true);
    try {
      setPhoto(await compressImage(file));
    } catch (err) {
      setError(err.message);
    } finally {
      setPhotoBusy(false);
      e.target.value = '';
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = { photo };
      if (pos?.ok) {
        body.lat = pos.lat;
        body.lng = pos.lng;
        body.accuracy = pos.accuracy;
      }
      onDone(await api.checkIn(visit.visit_id, body));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop modal-stacked" onClick={() => !busy && onClose()}>
      <div className="modal modal-narrow" ref={sheetRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="mono muted">{visit.case_id}</p>
            <h2>เช็คอินเข้างาน</h2>
            <p className="muted">{visit.client_name} · {serviceName(visit) || CASE_TYPE_LABELS[visit.case_type]}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="ปิด" disabled={busy}>×</button>
        </header>

        <div className="modal-body">
          {/* สถานะ GPS */}
          <div className={`gps-status ${pos?.ok ? 'is-ok' : locating ? '' : 'is-warn'}`}>
            {locating ? (
              <>📍 กำลังหาตำแหน่ง…</>
            ) : pos?.ok ? (
              <>
                📍 ได้ตำแหน่งแล้ว <span className="muted">(ความแม่นยำ ±{pos.accuracy} ม.)</span>
              </>
            ) : (
              <>
                ⚠ {pos?.reason}
                <button type="button" className="btn tiny" onClick={retryLocation}>ลองใหม่</button>
              </>
            )}
          </div>

          {/* แผนที่จุดที่เช็คอิน — โชว์เมื่อได้พิกัดและตั้ง key แล้ว (ไม่มี key ก็ซ่อนไปเอง) */}
          {pos?.ok && <LocationMap lat={pos.lat} lng={pos.lng} />}

          {/* เซลฟี่ (ไม่บังคับ) */}
          <section className="checkin-photo">
            <h3>รูปเซลฟี่ (ไม่บังคับ)</h3>
            {photo ? (
              <div className="checkin-photo-preview">
                <img src={photo} alt="เซลฟี่เช็คอิน" />
                <button type="button" className="btn tiny danger-ghost" onClick={() => setPhoto(null)} disabled={busy}>
                  เอารูปออก
                </button>
              </div>
            ) : (
              // capture=user = เปิดกล้องหน้าบนมือถือ
              <FileButton icon="camera" capture="user" busy={photoBusy} onPick={pickPhoto}>
                ถ่ายรูป
              </FileButton>
            )}
            <p className="muted">ช่วยยืนยันว่าคุณอยู่หน้างานจริง</p>
          </section>

          {error && <pre className="error">{error}</pre>}
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>ยกเลิก</button>
          <button className="btn primary" onClick={submit} disabled={busy || locating || photoBusy}>
            {busy ? 'กำลังเช็คอิน…' : 'ยืนยันเช็คอิน'}
          </button>
        </footer>
      </div>
    </div>
  );
}
