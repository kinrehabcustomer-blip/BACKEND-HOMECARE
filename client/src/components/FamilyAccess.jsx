import { useEffect, useState } from 'react';
import { api } from '../api.js';
import ConfirmButton from './ConfirmButton.jsx';
import { formatDate } from '../labels.js';
import { ACCEPTED, compressImage } from '../lib/image.js';

/**
 * ญาติที่ดูการดูแลผ่าน LINE OA Kin HomeCare (@145aflze) — ส่วนหนึ่งของหน้าเคส (ดู server/src/lib/family.js)
 * เชิญได้เท่านั้น: กดเชิญ → ติ๊กยืนยันความยินยอม → ได้รหัส 6 ตัว + ลิงก์ส่งให้ญาติ (อายุ 7 วัน ใช้ได้ครั้งเดียว)
 * ญาติเห็นแค่สรุป: เวลาเข้า–ออกจริง · ผู้ดูแล · สรุปรายงาน · นัดถัดไป (ไม่มี GPS/เซลฟี่/ค่าจ้าง)
 */
// วันเวลาแบบไทยสั้น ๆ สำหรับข้อความในไทม์ไลน์ (created_at เป็น timestamptz)
const formatDateTime = (v) =>
  new Date(v).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

const STATE = { linked: 'เชื่อมแล้ว', pending: 'รอญาติกดรับ', expired: 'รหัสหมดอายุ' };

export default function FamilyAccess({ caseId, disabled }) {
  const [data, setData] = useState(null);
  const [consent, setConsent] = useState(false);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.familyLinks(caseId).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function createInvite() {
    setBusy(true);
    setError(null);
    try {
      setInvite(await api.createFamilyInvite(caseId));
      setConsent(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId) {
    await api.revokeFamilyLink(caseId, linkId);
    load();
  }

  const items = data?.items ?? [];
  const full = items.filter((x) => x.state !== 'expired').length >= (data?.max ?? 5);

  return (
    <div className="family-access">
      {items.length === 0 ? (
        <p className="muted">ยังไม่มีญาติที่ดูการดูแลผ่าน LINE</p>
      ) : (
        items.map((x) => (
          <div className="history-item" key={x.link_id}>
            <div>
              <strong>{x.display_name || 'ญาติ (ยังไม่กดรับ)'}</strong>{' '}
              <span className="muted">· {STATE[x.state]}</span>
              <p className="muted">
                เชิญโดย {x.invited_by} · {formatDate(x.created_at)}
                {x.accepted_at && ` · เชื่อม ${formatDate(x.accepted_at)}`}
              </p>
            </div>
            <ConfirmButton
              className="btn tiny"
              title="ปลดญาติคนนี้?"
              detail="ปลดแล้วญาติจะเปิดดูการดูแลของเคสนี้ใน LINE ไม่ได้อีก"
              confirmLabel="ปลด"
              cancelLabel="ยกเลิก"
              danger={false}
              onConfirm={() => revoke(x.link_id)}
            >
              ปลด
            </ConfirmButton>
          </div>
        ))
      )}

      {invite && (
        <div className="notice">
          ส่งให้ญาติ: <strong className="mono">ญาติ {invite.code}</strong> ในแชท LINE {invite.oa} (ใช้ได้ {invite.days} วัน ครั้งเดียว)
          <br />
          หรือส่งลิงก์นี้ — กดแล้วเปิดแชทพร้อมพิมพ์รหัสไว้ให้:{' '}
          <a href={invite.link} target="_blank" rel="noreferrer">{invite.link}</a>{' '}
          <button className="btn tiny" type="button" onClick={() => navigator.clipboard?.writeText(invite.link)}>คัดลอกลิงก์</button>
        </div>
      )}

      {!disabled && !full && (
        <div className="family-invite">
          <label className="checkbox">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            ได้รับความยินยอมจากผู้ป่วยหรือผู้มีอำนาจแทนแล้ว ให้ญาติคนนี้ดูสรุปการดูแลผ่าน LINE
          </label>
          <button className="btn tiny primary" type="button" disabled={!consent || busy} onClick={createInvite}>
            {busy ? 'กำลังออกรหัส…' : 'เชิญญาติเข้า LINE'}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <FamilyTimeline caseId={caseId} disabled={disabled} />
    </div>
  );
}

/**
 * ไทม์ไลน์เคส (แบบ 3 · ดร. 22 ต.ค. 2569) — ข้อความ/รูปจากญาติและทีม ทุกคนในเคสเห็นเหมือนกัน
 * ทีมตอบที่นี่ ญาติเห็นในหน้า "ดูการดูแล" ใน LINE · ซ่อนข้อความที่ไม่เหมาะได้ (ไม่ลบจริง)
 */
function FamilyTimeline({ caseId, disabled }) {
  const [items, setItems] = useState(null);
  const [body, setBody] = useState('');
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = () => api.familyMessages(caseId).then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      await api.postFamilyMessage(caseId, { body: body.trim() || null, image });
      setBody('');
      setImage(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="family-timeline">
      <h4>ไทม์ไลน์กับญาติ</h4>
      {!disabled && (
        <div className="family-post">
          <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000}
            placeholder="แจ้งญาติทุกคนในเคสนี้ เช่น วันนี้คุณพ่อเดินได้ไกลขึ้น 10 เมตร" />
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
      {items?.length === 0 && <p className="muted">ยังไม่มีข้อความ</p>}
      {items?.map((m) => (
        <div className={`family-msg ${m.author_kind}`} key={m.message_id}>
          <div className="muted">
            <strong>{m.author_name}</strong> · {formatDateTime(m.created_at)}
            {' '}
            <ConfirmButton className="btn tiny" title="ซ่อนข้อความนี้?" detail="ญาติทุกคนจะไม่เห็นข้อความนี้อีก"
              confirmLabel="ซ่อน" cancelLabel="ยกเลิก" danger={false}
              onConfirm={() => api.hideFamilyMessage(caseId, m.message_id).then(load)}>
              ซ่อน
            </ConfirmButton>
          </div>
          {m.body && <p className="pre-line">{m.body}</p>}
          {m.has_photo && (
            <a href={api.familyPhotoUrl(caseId, m.message_id)} target="_blank" rel="noreferrer">
              <img className="family-photo" src={api.familyPhotoUrl(caseId, m.message_id)} alt="รูปในไทม์ไลน์" loading="lazy" />
            </a>
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
