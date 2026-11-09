import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import MyCaseModal, { serviceName } from '../components/MyCaseModal.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import { formatDate, caseStage } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';
import LineIcon from '../components/LineIcon.jsx';

const CLOSED = ['closed', 'cancelled'];

export default function MyCasesPage() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // ?case=<รหัส> จากลิงก์แจ้งเตือนแชทเคสใน LINE → เปิดเคสนั้นเลย (24 ต.ค. 2569)
  const [openId, setOpenId] = useState(() => new URLSearchParams(window.location.search).get('case'));

  const load = useCallback(() => {
    setLoading(true);
    return api
      .myCases()
      .then((data) => {
        setList(data);
        setError(null); // โหลดผ่านแล้ว error ของรอบก่อนต้องหายไปด้วย
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const active = list ? list.filter((c) => !CLOSED.includes(c.status)).length : 0;

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      {/* ไม่มีหัวหน้าบนจอ (แบบเดียวกับหน้างานวันนี้) — จำนวนเคสอยู่แถวบนของรายการ · h1 คงไว้ให้โปรแกรมอ่านหน้าจอ */}
      <h1 className="sr-only">เคสของฉัน</h1>

      {/* error เป็นแถบเหนือรายการ ไม่ทับทั้งหน้า — พนักงานอยู่หน้างาน สัญญาณหายเป็นเรื่องปกติ
          เคสที่โหลดมาได้แล้วต้องยังเปิดดูได้ และต้องมีปุ่มลองใหม่ ไม่ใช่ต้องรีเฟรชเบราว์เซอร์เอง */}
      <ErrorBar message={error} onRetry={load} busy={loading} />

      {!list ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : list.length === 0 ? (
        <section className="card empty-state my-card">
          <p>ยังไม่มีเคสที่คุณรับผิดชอบ</p>
          <p className="muted">เมื่อผู้จัดการจับคู่เคสให้คุณ เคสจะปรากฏที่นี่</p>
        </section>
      ) : (
        <>
          <p className="my-list-head">
            <strong>เคสของฉัน</strong>
            <span className="muted">
              {list.length} เคส{active > 0 && active < list.length ? ` · กำลังดูแล ${active}` : ''} — แตะเพื่อดูรายละเอียด
            </span>
          </p>
          {/* การ์ดรายเคส (เดิมเป็นตารางที่แปลงเป็นการ์ด ชื่อผู้รับบริการไปอยู่ชิดขวาเล็กๆ) — ชื่อคือสิ่งที่พนักงานมองหา จึงขึ้นนำ */}
          <ul className="my-case-list">
            {list.map((c) => {
              const stage = caseStage(c);
              return (
                <li key={c.case_id}>
                  <button type="button" className="my-case-card" onClick={() => setOpenId(c.case_id)}>
                    <span className="my-case-top">
                      <strong className="my-case-name">{c.client_name}</strong>
                      <span className={`badge case-${stage.key}`}>{stage.label}</span>
                    </span>
                    <span className="my-case-meta">
                      {serviceName(c)}{c.start_date ? ` · เริ่ม ${formatDate(c.start_date)}` : ''}
                    </span>
                    <span className="my-case-foot">
                      <span className="mono">{caseCode(c.case_id)}</span>
                      <LineIcon name="chevron-right" className="my-case-chev" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {openId && <MyCaseModal caseId={openId} onClose={() => setOpenId(null)} />}
    </PageRefresh>
  );
}
