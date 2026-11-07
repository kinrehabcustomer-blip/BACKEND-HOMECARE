import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import ConfirmButton from './ConfirmButton.jsx';
import CaseFamilyChat, { BACKOFFICE_SOURCE } from './CaseFamilyChat.jsx';
import { formatDate } from '../labels.js';

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
      <CustomerLine caseId={caseId} disabled={disabled} onLinked={load} />
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
            ได้รับความยินยอมจากผู้รับบริการหรือผู้มีอำนาจแทนแล้ว ให้ญาติคนนี้ดูสรุปการดูแลผ่าน LINE
          </label>
          <button className="btn tiny primary" type="button" disabled={!consent || busy} onClick={createInvite}>
            {busy ? 'กำลังออกรหัส…' : 'เชิญญาติเข้า LINE'}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <FamilyTimeline caseId={caseId} disabled={disabled} linkedCount={items.filter((x) => x.state === 'linked').length} />
    </div>
  );
}

/**
 * ช่องทางติดต่อ LINE ของลูกค้าเจ้าของเคส — มาจากแชทสอบถามทาง OA Kin HomeCare ที่ทีมกด "ส่งเข้าระบบงาน"
 * ข้อความแชทอยู่ที่ chat.kinorigin.com (ปุ่มเปิดแชท) · ปุ่ม "ให้ LINE นี้ดูการดูแล" ผูกเป็นญาติคนแรกได้เลย ไม่ต้องส่งรหัส
 */
function CustomerLine({ caseId, disabled, onLinked }) {
  const [d, setD] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = () => api.caseCustomerLine(caseId).then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d?.has_line) return null;
  async function link() {
    setBusy(true);
    setError(null);
    try {
      await api.linkCustomerLine(caseId);
      setConsent(false);
      onLinked();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="customer-line">
      <div>
        <strong>LINE ลูกค้า: {d.line_display_name || '-'}</strong>{' '}
        <span className="muted">· {d.name} ({d.customer_id})</span>
        <p className="muted">
          ทักครั้งแรก {d.chat_first_at ? formatDate(d.chat_first_at) : '-'}
          {d.chat_interest && ` · สนใจ ${d.chat_interest}`}
          {d.chat_url && <> · <a href={d.chat_url} target="_blank" rel="noreferrer">เปิดแชท</a></>}
        </p>
      </div>
      {!disabled && (
        <div className="family-invite">
          <label className="checkbox">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            ได้รับความยินยอมแล้ว ให้ LINE นี้ดูสรุปการดูแล
          </label>
          <button className="btn tiny primary" type="button" disabled={!consent || busy} onClick={link}>
            {busy ? 'กำลังผูก…' : 'ให้ LINE นี้ดูการดูแล'}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * ไทม์ไลน์เคส (แบบ 3 · ดร. 22 ต.ค. 2569) — ข้อความ/รูปจากญาติและทีม ทุกคนในเคสเห็นเหมือนกัน
 * ทีมตอบที่นี่ ญาติเห็นในหน้า "ดูการดูแล" ใน LINE · ซ่อนข้อความที่ไม่เหมาะได้ (ไม่ลบจริง)
 * ในหน้าเคสเหลือแค่การ์ดสรุป (จำนวน + ข้อความล่าสุด) — ตัวบทสนทนาเปิดเป็น popup แชท (5 พ.ย. 2569)
 * เดิมวางข้อความทั้งหมดต่อกันในหน้าเคส ข้อความสะสมมากขึ้นก็ดันเนื้อหาส่วนอื่นลงไปไกล
 */
function FamilyTimeline({ caseId, disabled, linkedCount }) {
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);

  const load = () => api.familyMessages(caseId).then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = items?.[0]; // API คืนใหม่ไปเก่า
  return (
    <div className="family-timeline">
      <button type="button" className="family-tl-card" onClick={() => setOpen(true)}>
        <span className="family-tl-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
          </svg>
        </span>
        <span className="family-tl-text">
          <strong>
            ไทม์ไลน์กับญาติ
            {items?.length > 0 && <span className="family-tl-count">{items.length}</span>}
          </strong>
          <span className="family-tl-preview">
            {!items && !error && 'กำลังโหลด…'}
            {items?.length === 0 && (disabled ? 'ยังไม่มีข้อความ' : 'ยังไม่มีข้อความ — กดเพื่อส่งข้อความถึงญาติ')}
            {latest && (
              <>
                <b>{latest.author_name}</b> · {formatDateTime(latest.created_at)} — {latest.body || '📷 รูปภาพ'}
              </>
            )}
          </span>
        </span>
        <span className="family-tl-open">เปิดแชท ›</span>
      </button>
      {error && <p className="error">{error}</p>}
      {open && (
        <FamilyTimelinePopup
          caseId={caseId}
          disabled={disabled}
          linkedCount={linkedCount}
          onLoaded={(d) => setItems(d.items)}
          onClose={() => { setOpen(false); load(); }}
        />
      )}
    </div>
  );
}

/** popup แชทไทม์ไลน์ — ซ้อนบน popup เคส · Esc ปิดเฉพาะชั้นนี้ (ไม่ปิดเคสข้างหลัง) */
function FamilyTimelinePopup({ caseId, disabled, linkedCount, onLoaded, onClose }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    boxRef.current?.focus();
    // ดักช่วง capture ก่อนตัวจัดการของ popup เคส (bubble) — เหมือน ConfirmButton
    // กล่องยืนยัน "ซ่อนข้อความ" เปิดซ้อนอยู่ = ปล่อยให้มันปิดตัวเองก่อน
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || document.querySelector('.confirm-box')) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onClose}>
      <div
        className="modal family-chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label="ไทม์ไลน์กับญาติ"
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <p className="muted mono">{caseId}</p>
            <h2>ไทม์ไลน์กับญาติ</h2>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="ปิด">×</button>
        </header>
        <CaseFamilyChat
          caseId={caseId}
          closed={disabled}
          source={BACKOFFICE_SOURCE}
          familyCount={linkedCount}
          onLoaded={onLoaded}
        />
      </div>
    </div>,
    document.body,
  );
}
