import { useEffect, useRef, useState } from 'react';

const SIZE = 960; // ด้านของรูปสี่เหลี่ยมจัตุรัสที่เก็บ — ตรงกับกรอบที่เห็นบนจอ
const QUALITY = 0.82;

const ERRORS = {
  NotAllowedError: 'ไม่ได้รับอนุญาตให้ใช้กล้อง — เปิดสิทธิ์กล้องของเบราว์เซอร์แล้วกด "ลองใหม่"',
  SecurityError: 'ไม่ได้รับอนุญาตให้ใช้กล้อง — เปิดสิทธิ์กล้องของเบราว์เซอร์แล้วกด "ลองใหม่"',
  NotFoundError: 'ไม่พบกล้องในอุปกรณ์นี้',
  NotReadableError: 'กล้องกำลังถูกใช้งานโดยแอปอื่น — ปิดแอปนั้นแล้วกด "ลองใหม่"',
};

/**
 * กล้องสดสำหรับถ่ายรูปยืนยันตัวตน — เปิดกล้องผ่าน getUserMedia แล้วจับภาพจากวิดีโอเอง
 * ไม่มีทางเลือกไฟล์จากแกลเลอรี (ต่างจาก <input capture> ที่เบราว์เซอร์บางตัว/เดสก์ท็อปเมินแล้วเปิดตัวเลือกไฟล์แทน)
 * onCapture(dataUrl) เมื่อกดถ่าย · onCancel เมื่อเลิก
 */
export default function CameraCapture({ facing = 'user', onCapture, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('เบราว์เซอร์นี้เปิดกล้องไม่ได้ (ต้องใช้ผ่าน https) — ลองเปิดด้วย Chrome หรือ Safari');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play().catch(() => {});
        setReady(true);
      } catch (err) {
        if (!cancelled) setError(ERRORS[err?.name] ?? `เปิดกล้องไม่สำเร็จ (${err?.message ?? err})`);
      }
    }
    start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing, attempt]);

  function snap() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    // ตัดกลางภาพเป็นสี่เหลี่ยมจัตุรัส — ตรงกับกรอบที่เห็น (กล้องหน้ามือถือเป็นแนวตั้ง เว็บแคมเป็นแนวนอน ภาพที่ได้จึงเหมือนกันทุกเครื่อง)
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;
    const out = Math.min(SIZE, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    canvas.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, out, out);
    onCapture(canvas.toDataURL('image/jpeg', QUALITY));
  }

  return (
    <div className="camera-capture">
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <div className="camera-frame">
          {/* กล้องหน้าแสดงกลับด้านเหมือนกระจก แต่รูปที่จับจริงไม่กลับ */}
          <video
            ref={videoRef}
            className={`camera-video ${facing === 'user' ? 'is-mirror' : ''}`}
            playsInline
            muted
          />
          <span className="camera-guide" aria-hidden="true" />
          {!ready && <span className="camera-wait">กำลังเปิดกล้อง…</span>}
        </div>
      )}
      <div className="photo-actions camera-actions">
        {error ? (
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>ลองใหม่</button>
        ) : (
          <button type="button" className="btn primary" onClick={snap} disabled={!ready}>
            {ready ? 'ถ่ายรูป' : 'กำลังเปิดกล้อง…'}
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel}>ยกเลิก</button>
      </div>
    </div>
  );
}
