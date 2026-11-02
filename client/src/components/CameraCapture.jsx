import { useEffect, useRef, useState } from 'react';

const MAX_EDGE = 1280;
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
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    onCapture(canvas.toDataURL('image/jpeg', QUALITY));
  }

  return (
    <div className="camera-capture">
      {error ? (
        <p className="error">{error}</p>
      ) : (
        // กล้องหน้าแสดงกลับด้านเหมือนกระจก แต่รูปที่จับจริงไม่กลับ
        <video
          ref={videoRef}
          className={`camera-video ${facing === 'user' ? 'is-mirror' : ''}`}
          playsInline
          muted
        />
      )}
      <div className="photo-actions">
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
