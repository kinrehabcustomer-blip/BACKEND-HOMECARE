import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ACCEPTED, compressImage } from '../lib/image.js';

/**
 * แชทเคสกับญาติ — ฝั่งผู้ดูแล/นักกายภาพ (ดร.ธงชัย 24 ต.ค. 2569 แบบ ก)
 * ไทม์ไลน์เดียวกับที่ญาติเห็นในหน้า "ดูการดูแล" ใน LINE และทีมเห็นในหน้าเคส · ทีม KIN อ่านและแทรกได้ทุกข้อความ
 * ส่งแล้วญาติได้แจ้งเตือนใน LINE Kin HomeCare ภายในไม่กี่นาที (ฝั่ง chat ดึงไปแจ้ง) · ไม่มีใครเห็น LINE ส่วนตัวของอีกฝ่าย
 */
const formatDateTime = (v) =>
  new Date(v).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
const WHO = { family: 'ญาติ', team: 'ทีม KIN', staff: '' };

export default function CaseFamilyChat({ caseId, closed }) {
  const [data, setData] = useState(null);
  const [body, setBody] = useState('');
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  const load = () => api.myFamilyMessages(caseId).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setImage(await compressImage(file));
    } catch (err) {
      setError(err.message);
    }
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.postMyFamilyMessage(caseId, { body: body.trim() || null, image });
      setBody('');
      setImage(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // ใหม่สุดอยู่ล่าง แบบแชททั่วไป (API คืนใหม่ไปเก่า)
  const items = [...(data?.items || [])].reverse();
  return (
    <div className="family-timeline">
      <p className="muted">
        ญาติ ทีม KIN และผู้ดูแลของเคสนี้เห็นข้อความเดียวกันทั้งหมด
        {data && (data.family_count ? ` · ญาติที่เชื่อม LINE แล้ว ${data.family_count} คน` : ' · ยังไม่มีญาติเชื่อม LINE กับเคสนี้ (ทีมเห็นข้อความ)')}
      </p>
      {items.length === 0 && data && <p className="muted">ยังไม่มีข้อความ</p>}
      {items.map((m) => (
        <div className={`family-msg ${m.author_kind}`} key={m.message_id}>
          <div className="muted">
            <strong>{m.author_name}</strong>{WHO[m.author_kind] && !m.author_name.includes(WHO[m.author_kind]) ? ` · ${WHO[m.author_kind]}` : ''} · {formatDateTime(m.created_at)}
          </div>
          {m.body && <p className="pre-line">{m.body}</p>}
          {m.has_photo && (
            <a href={api.myFamilyPhotoUrl(caseId, m.message_id)} target="_blank" rel="noreferrer">
              <img className="family-photo" src={api.myFamilyPhotoUrl(caseId, m.message_id)} alt="รูปในแชทเคส" loading="lazy" />
            </a>
          )}
        </div>
      ))}
      <div ref={endRef} />
      {!closed && (
        <div className="family-post">
          <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000}
            placeholder="พิมพ์ถึงญาติ เช่น วันนี้คุณแม่ทานข้าวได้หมดจาน เดินในบ้านได้ 2 รอบค่ะ" />
          <div className="family-post-actions">
            <label className="btn tiny">
              แนบรูป
              <input type="file" accept={ACCEPTED} hidden onChange={pick} />
            </label>
            {image && <img src={image} alt="" className="family-thumb" />}
            <button className="btn tiny primary" type="button" disabled={busy || (!body.trim() && !image)} onClick={send}>
              {busy ? 'กำลังส่ง…' : 'ส่งถึงญาติ'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
