import { useState } from 'react';

export default function CaseLocationLink({ item }) {
  const [copyStatus, setCopyStatus] = useState('');
  const lat = Number(item.geo_lat);
  const lng = Number(item.geo_lng);
  const hasLocation = item.geo_lat != null && item.geo_lat !== ''
    && item.geo_lng != null && item.geo_lng !== ''
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  if (!hasLocation) return null;

  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus('คัดลอกลิงก์แล้ว');
    } catch {
      setCopyStatus('คัดลอกไม่สำเร็จ กรุณาเลือกและคัดลอกลิงก์ด้านบน');
    }
  }

  /* ดีไซน์ v2: กล่องลิงก์นำทาง — ไอคอนนำทาง · ป้าย+ลิงก์ · ปุ่มคัดลอกชิดขวา (ลิงก์/ปุ่ม/ข้อความสถานะเดิมทั้งหมด) */
  return (
    <div className="field case-loc">
      <svg className="case-loc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 11l18-8-8 18-2-8z" />
      </svg>
      <span className="case-loc-main">
        <span className="field-label">ลิงก์นำทาง</span>
        <a className="field-value" href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>
      </span>
      <button type="button" className="btn tiny case-loc-copy" onClick={copyLink}>
        <svg className="text-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h8" />
        </svg>
        คัดลอกลิงก์
      </button>
      <span className="muted case-loc-status" role="status">{copyStatus}</span>
    </div>
  );
}
