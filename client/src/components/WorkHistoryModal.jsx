import { useEffect, useState } from 'react';
import CaseModal from './CaseModal.jsx';
import { CASE_TYPE_LABELS, CASE_STATUS_LABELS, formatBaht, formatDate } from '../labels.js';

/**
 * หน้าต่างประวัติการทำงานฉบับเต็มของพนักงานหนึ่งคน — ตารางแบบเดียวกับหน้าเคส
 * คลิกแถวเพื่อเปิดรายละเอียดเคส (CaseModal ซ้อนขึ้นมาอีกชั้น)
 */
export default function WorkHistoryModal({ employeeName, cases = [], onClose }) {
  const [openCaseId, setOpenCaseId] = useState(null);

  useEffect(() => {
    // CaseModal ซ้อนอยู่ = ให้ Escape ปิดตัวนั้นก่อน ไม่ใช่ปิดพรวดทั้งสองชั้น
    const onKeyDown = (e) => e.key === 'Escape' && !openCaseId && onClose();
    document.addEventListener('keydown', onKeyDown);

    // ผูกกับ openCaseId ด้วย เพราะ CaseModal ปลดล็อกการเลื่อนตอนมันปิด — ต้องล็อกกลับทันที
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose, openCaseId]);

  const active = cases.filter((c) => c.status === 'assigned' || c.status === 'in_progress');
  const closed = cases.filter((c) => c.status === 'closed');
  const earned = closed.reduce((sum, c) => sum + (c.fee ?? 0), 0);

  /**
   * วันที่ที่สนใจต่างกันตามสถานะ: เคสจบแล้วสนใจว่าจบเมื่อไหร่ เคสที่ทำอยู่สนใจว่ารับมาเมื่อไหร่
   * ในช่องโชว์แค่ตัววันที่ — คำนำหน้ากินความกว้างจนวันที่โดนตัด ซึ่งเป็นตัวเลขที่คนมาอ่านจริงๆ
   * ว่าเป็นวันไหนดูได้จากคอลัมน์สถานะที่อยู่ติดกัน และมีข้อความเต็มใน title ตอนเอาเมาส์ชี้
   */
  const whenOf = (c) =>
    c.status === 'closed' ? formatDate(c.closed_at ?? c.end_date) : formatDate(c.assigned_at);

  const whenLabel = (c) => (c.status === 'closed' ? 'ปิดเคสเมื่อ' : 'รับเคสเมื่อ');

  const openCase = (id) => setOpenCaseId(id);

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal modal-wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <header className="modal-head">
            <div>
              <h2>ประวัติการทำงาน</h2>
              <p className="muted">
                {employeeName && <>{employeeName} · </>}
                ทั้งหมด {cases.length} เคส · กำลังดำเนินการ {active.length} · ปิดแล้ว {closed.length}
                {earned > 0 && ` · รายได้จากเคสที่ปิดแล้ว ${formatBaht(earned)}`}
              </p>
            </div>
            <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
          </header>

          <div className="modal-body">
            <div className="table-wrap">
              <table className="table table-2line">
                <colgroup>
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '31%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '18%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>รหัสเคส</th>
                    <th>ชื่อเคส / ผู้รับบริการ</th>
                    <th>ประเภท</th>
                    <th>วันที่ / ค่าจ้าง</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => (
                    <tr
                      key={c.case_id}
                      className="row-clickable"
                      tabIndex={0}
                      onClick={() => openCase(c.case_id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openCase(c.case_id);
                        }
                      }}
                    >
                      <td className="mono link">{c.case_id}</td>
                      <td>
                        {c.title}
                        <span className="cell-sub">{c.client_name}</span>
                      </td>
                      <td>{CASE_TYPE_LABELS[c.case_type]}</td>
                      <td title={`${whenLabel(c)} ${whenOf(c)}`}>
                        {whenOf(c)}
                        {c.fee != null && <span className="cell-sub">{formatBaht(c.fee)}</span>}
                      </td>
                      <td>
                        <span className={`badge case-${c.status}`}>{CASE_STATUS_LABELS[c.status]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <footer className="modal-foot">
            <button className="btn primary" onClick={onClose}>ปิด</button>
          </footer>
        </div>
      </div>

      {/* วางนอก backdrop ด้านบน — ไม่งั้นคลิกใน CaseModal จะไปโดน onClick ของ backdrop แล้วปิดทิ้ง */}
      {openCaseId && <CaseModal caseId={openCaseId} onClose={() => setOpenCaseId(null)} />}
    </>
  );
}
