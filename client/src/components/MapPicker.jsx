import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps, hasMapsKey } from '../lib/gmaps.js';

const BANGKOK = { lat: 13.7563, lng: 100.5018 };

/**
 * แผนที่ปักหมุดตั้งพิกัดสถานที่ดูแล — ลากหมุด หรือคลิกแผนที่เพื่อย้ายหมุด
 * เรียก onChange(lat, lng) ทุกครั้งที่หมุดขยับ; พิกัดจากภายนอก (ปุ่ม geocode/กรอกมือ) จะเลื่อนหมุดตาม
 * ไม่มี key = แสดงข้อความแทน (ยังกรอกพิกัดมือได้)
 */
export default function MapPicker({ lat, lng, onChange }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [error, setError] = useState(null);

  // สร้างแผนที่ครั้งเดียว
  useEffect(() => {
    if (!hasMapsKey) return;
    let cancelled = false;

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !ref.current) return;
        const has = lat != null && lat !== '' && lng != null && lng !== '';
        const center = has ? { lat: Number(lat), lng: Number(lng) } : BANGKOK;

        mapRef.current = new maps.Map(ref.current, {
          center,
          zoom: has ? 16 : 11,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        markerRef.current = new maps.Marker({ position: center, map: mapRef.current, draggable: true });

        const emit = (latLng) => onChangeRef.current(latLng.lat(), latLng.lng());
        markerRef.current.addListener('dragend', (e) => emit(e.latLng));
        mapRef.current.addListener('click', (e) => {
          markerRef.current.setPosition(e.latLng);
          emit(e.latLng);
        });
      })
      .catch((e) => setError(e.message));

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // พิกัดเปลี่ยนจากภายนอก (geocode/กรอกมือ) -> เลื่อนหมุดตาม
  useEffect(() => {
    if (!markerRef.current || !mapRef.current || lat == null || lat === '' || lng == null || lng === '') return;
    const pos = { lat: Number(lat), lng: Number(lng) };
    if (Number.isNaN(pos.lat) || Number.isNaN(pos.lng)) return;
    markerRef.current.setPosition(pos);
    mapRef.current.panTo(pos);
    if (mapRef.current.getZoom() < 15) mapRef.current.setZoom(16);
  }, [lat, lng]);

  if (!hasMapsKey) {
    return <p className="muted map-note">ตั้งค่า VITE_GOOGLE_MAPS_KEY เพื่อเปิดแผนที่ปักหมุด (กรอกพิกัดเองด้านบนได้)</p>;
  }
  if (error) return <p className="error">{error}</p>;
  return <div ref={ref} className="map-picker" />;
}
