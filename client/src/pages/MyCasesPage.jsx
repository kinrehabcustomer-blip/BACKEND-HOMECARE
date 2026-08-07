import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import MyCaseModal, { serviceName } from '../components/MyCaseModal.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import { CASE_STATUS_LABELS, formatDate } from '../labels.js';

export default function MyCasesPage() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

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

  return (
    <>
      <header className="page-head">
        <div>
          <h1>เคสของฉัน</h1>
          <p className="muted">
            {list
              ? `เคสที่คุณรับผิดชอบทั้งหมด ${list.length} เคส — กดที่เคสเพื่อดูรายละเอียด`
              : 'เคสที่คุณรับผิดชอบ'}
          </p>
        </div>
      </header>

      {/* error เป็นแถบเหนือรายการ ไม่ทับทั้งหน้า — พนักงานอยู่หน้างาน สัญญาณหายเป็นเรื่องปกติ
          เคสที่โหลดมาได้แล้วต้องยังเปิดดูได้ และต้องมีปุ่มลองใหม่ ไม่ใช่ต้องรีเฟรชเบราว์เซอร์เอง */}
      <ErrorBar message={error} onRetry={load} busy={loading} />

      {!list ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : list.length === 0 ? (
        <section className="card empty-state">
          <p>ยังไม่มีเคสที่คุณรับผิดชอบ</p>
          <p className="muted">เมื่อผู้จัดการจับคู่เคสให้คุณ เคสจะปรากฏที่นี่</p>
        </section>
      ) : (
        <div className="table-wrap">
          {/* พนักงานภาคสนามเปิดหน้านี้จากมือถือเป็นหลัก — table-cards ทำให้แต่ละเคสเป็นการ์ดใบหนึ่ง
              แทนที่จะเป็นตารางกว้างที่ต้องปัดซ้ายขวาถึงจะเห็นสถานะ */}
          <table className="table table-cards table-2line">
            <colgroup>
              <col style={{ width: '16%' }} />
              <col style={{ width: '40%' }} />
              <col style={{ width: '24%' }} />
              <col style={{ width: '20%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>รหัสเคส</th>
                <th>ผู้รับการดูแล / บริการ</th>
                <th>วันเริ่ม</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr
                  key={c.case_id}
                  className="row-clickable"
                  tabIndex={0}
                  onClick={() => setOpenId(c.case_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpenId(c.case_id);
                    }
                  }}
                >
                  <td className="mono link" data-label="รหัสเคส">{c.case_id}</td>
                  <td data-label="ผู้รับการดูแล">
                    {c.client_name}
                    <span className="cell-sub">{serviceName(c)}</span>
                  </td>
                  <td data-label="วันเริ่ม">{c.start_date ? formatDate(c.start_date) : '—'}</td>
                  <td data-label="สถานะ"><span className={`badge case-${c.status}`}>{CASE_STATUS_LABELS[c.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && <MyCaseModal caseId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
