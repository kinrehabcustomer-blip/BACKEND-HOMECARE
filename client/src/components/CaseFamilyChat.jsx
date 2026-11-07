import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useVisiblePoll } from '../lib/poll.js';
import { ACCEPTED, compressImage } from '../lib/image.js';
import ConfirmButton from './ConfirmButton.jsx';

/**
 * แชทเคสกับญาติ — ฝั่งผู้ดูแล/นักกายภาพ (ดร.ธงชัย 24 ต.ค. 2569 แบบ ก)
 * ไทม์ไลน์เดียวกับที่ญาติเห็นในหน้า "ดูการดูแล" ใน LINE และทีมเห็นในหน้าเคส · ทีม KIN อ่านและแทรกได้ทุกข้อความ
 * ส่งแล้วญาติได้แจ้งเตือนใน LINE Kin HomeCare ภายในไม่กี่นาที (ฝั่ง chat ดึงไปแจ้ง) · ไม่มีใครเห็น LINE ส่วนตัวของอีกฝ่าย
 *
 * หน้าตาแบบแชท: ข้อความของเรา (mine) ชิดขวาสีทอง · ญาติ/ทีม/เพื่อนร่วมงานชิดซ้าย · คั่นด้วยวันที่
 * ใช้ในหน้า "แชทญาติ" (pages/MyChatPage.jsx) — header/รายชื่อเคสอยู่ที่หน้านั้น ที่นี่เป็นเฉพาะตัวบทสนทนา + ช่องพิมพ์
 * และ popup ไทม์ไลน์ในหน้าเคสหลังบ้าน (FamilyAccess.jsx) — ส่ง source = BACKOFFICE_SOURCE: ใช้ API หลังบ้าน
 * ข้อความของทีม KIN ชิดขวา · มีปุ่มซ่อนข้อความ · จำนวนญาติส่งมาทาง familyCount (API หลังบ้านคืนเป็น array เปล่า ๆ)
 */
const MAX_LEN = 1000;
const WHO = { family: 'ญาติ', team: 'ทีม KIN', staff: '' };

const timeText = (v) =>
  new Date(v).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
const dayKey = (v) => new Date(v).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const dayText = (v) => {
  const key = dayKey(v);
  if (key === dayKey(Date.now())) return 'วันนี้';
  if (key === dayKey(Date.now() - 86400000)) return 'เมื่อวาน';
  return new Date(v).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });
};

const MY_SOURCE = {
  list: (id) => api.myFamilyMessages(id),
  post: (id, body) => api.postMyFamilyMessage(id, body),
  photoUrl: (id, msgId) => api.myFamilyPhotoUrl(id, msgId),
  hide: null,
};

export const BACKOFFICE_SOURCE = {
  list: (id) =>
    api.familyMessages(id).then((items) => ({ items: items.map((m) => ({ ...m, mine: m.author_kind === 'team' })) })),
  post: (id, body) => api.postFamilyMessage(id, body),
  photoUrl: (id, msgId) => api.familyPhotoUrl(id, msgId),
  hide: (id, msgId) => api.hideFamilyMessage(id, msgId),
};

export default function CaseFamilyChat({ caseId, closed, onLoaded = null, source = MY_SOURCE, familyCount = null }) {
  const [data, setData] = useState(null);
  const [body, setBody] = useState('');
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const stickRef = useRef(true); // อยู่ล่างสุดอยู่ = ข้อความใหม่เลื่อนตาม · อ่านย้อนหลังอยู่ = ไม่ดึงลง

  const load = useCallback(
    () => source.list(caseId).then((d) => { setData(d); setError(null); onLoaded?.(d); }).catch((e) => setError(e.message)),
    [caseId, source], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // เปลี่ยนเคส = ล้างของเก่า (ต้องประกาศก่อน useVisiblePoll — effect รันตามลำดับ ล้างก่อนแล้วค่อยดึง)
  useEffect(() => {
    setData(null);
    stickRef.current = true;
  }, [load]);
  // ทุก 15 วิ เฉพาะตอนแท็บเปิดอยู่ (ดู lib/poll.js) — เดิมยิงต่อแม้พับแท็บ/จอดับ
  useVisiblePoll(load, 15000);

  // API คืนใหม่ไปเก่า — เรียงใหม่สุดไว้ล่างแบบแชททั่วไป
  const items = [...(data?.items || [])].reverse();

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length, data]);

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
    if (busy || (!body.trim() && !image)) return;
    setBusy(true);
    setError(null);
    try {
      await source.post(caseId, { body: body.trim() || null, image });
      setBody('');
      setImage(null);
      stickRef.current = true;
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  let lastDay = null;
  return (
    <div className="fchat">
      <div
        className="fchat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!data && !error && <p className="fchat-note">กำลังโหลดข้อความ…</p>}
        {data && items.length === 0 && (
          <div className="fchat-empty">
            <strong>ยังไม่มีข้อความ</strong>
            <span>พิมพ์รายงานความคืบหน้าถึงญาติได้เลย เช่น วันนี้คุณแม่ทานข้าวได้หมดจาน</span>
          </div>
        )}

        {items.map((m) => {
          const day = dayKey(m.created_at);
          const sep = day !== lastDay ? <div className="fchat-day" key={`d-${day}`}><span>{dayText(m.created_at)}</span></div> : null;
          lastDay = day;
          const label = WHO[m.author_kind] && !m.author_name.includes(WHO[m.author_kind]) ? ` · ${WHO[m.author_kind]}` : '';
          return (
            <div key={m.message_id} className="fchat-row">
              {sep}
              <div className={`fchat-msg ${m.mine ? 'is-mine' : ''} kind-${m.author_kind}`}>
                {!m.mine && <span className="fchat-who">{m.author_name}{label}</span>}
                <div className="fchat-bubble">
                  {m.has_photo && (
                    <a href={source.photoUrl(caseId, m.message_id)} target="_blank" rel="noreferrer">
                      {/* รูปโหลดเสร็จทีหลังการเลื่อนลงล่างครั้งแรก — กล่องสูงขึ้นจนข้อความล่าสุดหลุดใต้ขอบ จึงเลื่อนตามอีกรอบ */}
                      <img className="fchat-photo" src={source.photoUrl(caseId, m.message_id)} alt="รูปในแชทเคส" loading="lazy"
                        onLoad={() => { const el = scrollRef.current; if (el && stickRef.current) el.scrollTop = el.scrollHeight; }} />
                    </a>
                  )}
                  {m.body && <p className="pre-line">{m.body}</p>}
                </div>
                <span className="fchat-meta">
                  <time className="fchat-time">{timeText(m.created_at)}</time>
                  {source.hide && (
                    <ConfirmButton className="fchat-hide" title="ซ่อนข้อความนี้?" detail="ญาติทุกคนจะไม่เห็นข้อความนี้อีก"
                      confirmLabel="ซ่อน" cancelLabel="ยกเลิก" danger={false}
                      onConfirm={() => source.hide(caseId, m.message_id).then(load)}>
                      ซ่อน
                    </ConfirmButton>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="error fchat-error">{error}</p>}

      {closed ? (
        <p className="fchat-closed">เคสนี้ปิดแล้ว — ส่งข้อความใหม่ไม่ได้</p>
      ) : (
        <div className="fchat-composer">
          {image && (
            <div className="fchat-attach">
              <img src={image} alt="" />
              <button type="button" onClick={() => setImage(null)} aria-label="เอารูปออก">×</button>
            </div>
          )}
          <div className="fchat-input-row">
            <label className="fchat-clip" title="แนบรูป" aria-label="แนบรูป">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="1.6" /><path d="M21 16l-5-5-9 9" />
              </svg>
              <input type="file" accept={ACCEPTED} hidden onChange={pick} />
            </label>
            <textarea
              rows={1}
              value={body}
              maxLength={MAX_LEN}
              placeholder="พิมพ์ข้อความถึงญาติ…"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                // Enter = ส่ง (บนเดสก์ท็อป) · Shift+Enter = ขึ้นบรรทัดใหม่ · มือถือไม่มี Shift จึงใช้ปุ่มส่งแทน
                if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(hover: hover)').matches) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="fchat-send" type="button" disabled={busy || (!body.trim() && !image)} onClick={send}>
              {busy ? '…' : 'ส่ง'}
            </button>
          </div>
          <span className="fchat-count">
            {(familyCount ?? data?.family_count) ? `ญาติที่เชื่อม LINE แล้ว ${familyCount ?? data.family_count} คนจะได้รับแจ้งเตือน` : 'ยังไม่มีญาติเชื่อม LINE กับเคสนี้ — ทีมเห็นข้อความ'}
            {body.length > MAX_LEN - 150 && ` · ${body.length}/${MAX_LEN}`}
          </span>
        </div>
      )}
    </div>
  );
}
