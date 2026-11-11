import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import CaseFamilyChat from '../components/CaseFamilyChat.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import { caseCode } from '../lib/patientCode.js';
import { SERVICE_KIND_LABELS, serviceKindOf } from '../labels.js';

const CLOSED = ['closed', 'cancelled'];

/** ตัวอักษรแรกของชื่อ — ใช้ทำวงกลมแทนรูปโปรไฟล์ (ข้ามคำนำหน้า) */
const initialOf = (name) => (String(name ?? '').replace(/^(คุณ|นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.)\s*/, '').trim()[0] ?? '?');

/**
 * เมนู "แชทญาติ" ของพนักงานหน้างาน — คุยกับญาติของเคสที่ตัวเองรับผิดชอบ
 * ซ้าย = รายชื่อเคส (ค้นหาได้) · ขวา = บทสนทนา · จอแคบ = ทีละหน้า (รายชื่อ → แชท มีปุ่มย้อนกลับ)
 * ข้อความไทม์ไลน์เดียวกับที่ญาติเห็นใน LINE และทีม KIN เห็นที่หน้าเคส
 */
export default function MyChatPage() {
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  // ?case=<รหัส> จากลิงก์แจ้งเตือนใน LINE → เปิดห้องนั้นเลย
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('case'));
  const [familyCount, setFamilyCount] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    return api
      .myCases()
      .then((list) => { setCases(list); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // เคสที่ยังเปิดอยู่ขึ้นก่อน เคสที่จบแล้วอยู่ท้าย
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (cases ?? [])
      .filter((c) => !term || `${c.client_name} ${c.case_id}`.toLowerCase().includes(term))
      .sort((a, b) => Number(CLOSED.includes(a.status)) - Number(CLOSED.includes(b.status)));
  }, [cases, q]);

  const current = (cases ?? []).find((c) => c.case_id === selected) ?? null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>แชทญาติ</h1>
          <p className="muted">คุยและส่งรูปความคืบหน้าถึงญาติของเคสที่คุณดูแล — ญาติเห็นผ่าน LINE ทีม KIN เห็นข้อความเดียวกัน</p>
        </div>
      </header>

      <ErrorBar message={error} onRetry={load} busy={loading} />

      {!cases ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : cases.length === 0 ? (
        <section className="card empty-state">
          <p>ยังไม่มีเคสที่คุณรับผิดชอบ</p>
          <p className="muted">เมื่อผู้จัดการจับคู่เคสให้คุณ ห้องแชทของเคสจะปรากฏที่นี่</p>
        </section>
      ) : (
        <div className={`mychat ${current ? 'has-room' : ''}`}>
          <aside className="mychat-list" aria-label="รายชื่อเคส">
            <input
              className="mychat-search"
              type="search"
              placeholder="ค้นหาชื่อผู้รับบริการ / รหัสเคส"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ul>
              {list.length === 0 && <li className="mychat-none">ไม่พบเคสที่ตรงกับ “{q}”</li>}
              {list.map((c) => {
                const closed = CLOSED.includes(c.status);
                return (
                  <li key={c.case_id}>
                    <button
                      type="button"
                      className={`mychat-item ${c.case_id === selected ? 'is-active' : ''}`}
                      onClick={() => { setSelected(c.case_id); setFamilyCount(null); }}
                    >
                      <span className={`mychat-avatar ${closed ? 'is-closed' : ''}`}>{initialOf(c.client_name)}</span>
                      <span className="mychat-meta">
                        <strong>{c.client_name}</strong>
                        {/* บอกสายบริการด้วย — เคส Homecare กับแพ็กกายภาพเสริมของคนเดียวกันขึ้นรหัส KN เดียวกัน (ตัด -R)
                            เดิมเห็นสองแถวหน้าตาเหมือนกันทุกตัวอักษร ไม่รู้ว่าแถวไหนคือห้องแชทของเคสไหน (ตรวจจอมือถือ 11 พ.ย. 2569) */}
                        <span className="muted mono">{caseCode(c.case_id)} · {SERVICE_KIND_LABELS[serviceKindOf(c)]}</span>
                      </span>
                      {closed && <span className="badge">จบแล้ว</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="mychat-room">
            {!current ? (
              <div className="mychat-placeholder">
                <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.7-.8L3 21l1.9-5.1A8.4 8.4 0 1 1 21 11.5z" />
                </svg>
                <strong>เลือกเคสเพื่อเริ่มคุยกับญาติ</strong>
                <span className="muted">เลือกจากรายชื่อด้านซ้าย</span>
              </div>
            ) : (
              <>
                <header className="mychat-head">
                  <button type="button" className="mychat-back" onClick={() => setSelected(null)} aria-label="กลับไปรายชื่อเคส">‹</button>
                  <span className="mychat-avatar">{initialOf(current.client_name)}</span>
                  <div className="mychat-title">
                    <strong>{current.client_name}</strong>
                    <span className="muted">
                      <span className="mono">{caseCode(current.case_id)}</span>
                      {familyCount != null && ` · ญาติเชื่อม LINE ${familyCount} คน`}
                    </span>
                  </div>
                </header>
                <CaseFamilyChat
                  key={current.case_id}
                  caseId={current.case_id}
                  closed={CLOSED.includes(current.status)}
                  onLoaded={(d) => setFamilyCount(d.family_count ?? 0)}
                />
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
