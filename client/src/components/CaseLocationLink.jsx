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

  return (
    <div className="field">
      <span className="field-label">ลิงก์นำทาง</span>
      <a className="field-value" href={url} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: 'anywhere' }}>
        {url}
      </a>
      <div style={{ marginTop: '0.5rem' }}>
        <button type="button" className="btn tiny" onClick={copyLink}>คัดลอกลิงก์</button>
      </div>
      <span className="muted" role="status">{copyStatus}</span>
    </div>
  );
}
