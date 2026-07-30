import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps, hasMapsKey } from '../lib/gmaps.js';

/**
 * แผนที่เล็กแสดงหมุดที่พิกัดเดียว (ใช้ยืนยันจุดเช็คอิน ฯลฯ)
 *
 * ตั้งเป็นแบบ "ปัดไม่ได้" (gestureHandling: none) ให้เหมือนรูปนิ่ง — จะได้ไม่แย่งการเลื่อนใน modal บนมือถือ
 * ถ้ายังไม่ได้ตั้ง VITE_GOOGLE_MAPS_KEY หรือไม่มีพิกัด/โหลดแผนที่พัง → ไม่แสดงอะไร (หน้าไม่พัง)
 */
export default function LocationMap({ lat, lng, zoom = 16, className = '' }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hasMapsKey || lat == null || lng == null) return undefined;

    let cancelled = false;
    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !ref.current) return;
        const center = { lat, lng };
        const map = new maps.Map(ref.current, {
          center,
          zoom,
          disableDefaultUI: true,
          gestureHandling: 'none', // ดูอย่างเดียว ไม่ให้ลาก/ซูม (กันแย่งสกรอลใน modal)
          keyboardShortcuts: false,
          clickableIcons: false,
        });
        new maps.Marker({ position: center, map });
      })
      .catch(() => !cancelled && setFailed(true));

    return () => {
      cancelled = true;
    };
  }, [lat, lng, zoom]);

  if (!hasMapsKey || lat == null || lng == null || failed) return null;
  return <div ref={ref} className={`location-map ${className}`.trim()} />;
}
