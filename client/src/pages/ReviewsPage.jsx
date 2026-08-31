import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { STATUS_LABELS, stampText } from '../labels.js';
import Stars from '../components/Stars.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import { scoreText } from '../lib/reviewQuestions.js';

/**
 * คะแนนประเมินจากญาติผู้รับบริการ — ภาพรวมรายบุคคล
 *
 * คะแนนรวมของแต่ละคน = ค่าเฉลี่ยของ "ค่าเฉลี่ย 10 ข้อในใบนั้น" ของทุกใบ (คิดฝั่ง server)
 * ทุกใบจึงมีน้ำหนักเท่ากันไม่ว่าญาติจะให้คะแนนกระจายแค่ไหนในใบเดียว
 */
export default function ReviewsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    return api
      .reviewSummary()
      .then((v) => { setRows(v); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  if (error && !rows) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">กำลังโหลด…</p>;

  const rated = rows.filter((r) => r.review_count > 0);
  // ค่าเฉลี่ยของทั้งทีม — ถ่วงตามจำนวนใบ ไม่ใช่เฉลี่ยของค่าเฉลี่ยรายคน
  // ไม่งั้นคนที่มีใบเดียวจะมีน้ำหนักเท่ากับคนที่มีสามสิบใบ
  const totalReviews = rated.reduce((sum, r) => sum + r.review_count, 0);
  const teamAvg = totalReviews
    ? rated.reduce((sum, r) => sum + r.avg_score * r.review_count, 0) / totalReviews
    : null;

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      <header className="page-head">
        <div>
          <h1>คะแนนประเมินจากญาติ</h1>
          <p className="muted">
            ญาติผู้รับบริการกรอกจากลิงก์เฉพาะตัวของพนักงานแต่ละคน · กดที่ชื่อเพื่อดูคะแนนรายหัวข้อและลิงก์/QR
          </p>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">คะแนนเฉลี่ยทั้งทีม</span>
          <span className="tile-value">{scoreText(teamAvg)}</span>
          <Stars value={teamAvg} size="sm" />
        </div>
        <div className="tile">
          <span className="tile-label">แบบประเมินทั้งหมด</span>
          <span className="tile-value">{totalReviews}</span>
          <span className="tile-frac">ใบ</span>
        </div>
        <div className="tile">
          <span className="tile-label">มีคะแนนแล้ว</span>
          <span className="tile-value">{rated.length}</span>
          <span className="tile-frac">จาก {rows.length} คน</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">
          <p>ยังไม่มีพนักงานตำแหน่งนักกายภาพบำบัดในระบบ</p>
          <p className="muted">แบบประเมินนี้เปิดใช้กับตำแหน่งนักกายภาพบำบัดก่อนเป็นตำแหน่งแรก</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr>
                <th>พนักงาน</th>
                <th>คะแนนรวม</th>
                <th>จำนวนใบ</th>
                <th>ประเมินล่าสุด</th>
                <th>ลิงก์ประเมิน</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                /* กดได้ทั้งแถว ไม่ใช่เฉพาะชื่อ — ท่าเดียวกับตารางเคส/ลูกค้า/พนักงาน
                   ชื่อจึงไม่เป็นลิงก์ซ้อนอยู่ข้างใน (ลิงก์ในแถวที่กดได้ = เป้าหมายซ้อนกันสองชั้น
                   ที่คนใช้แป้นพิมพ์ต้องกด Tab ผ่านสองครั้งเพื่อไปที่เดียวกัน) */
                <tr
                  key={r.employee_id}
                  className="row-clickable"
                  tabIndex={0}
                  onClick={() => navigate(`/reviews/${r.employee_id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/reviews/${r.employee_id}`);
                    }
                  }}
                >
                  <td data-label="พนักงาน">
                    <span className="name-cell">
                      <span className="link">{r.first_name} {r.last_name}</span>
                      <span className="cell-sub mono">{r.employee_id}</span>
                      {r.status !== 'active' && (
                        <span className="badge muted-badge">{STATUS_LABELS[r.status] ?? r.status}</span>
                      )}
                    </span>
                  </td>
                  <td data-label="คะแนนรวม">
                    {r.review_count ? (
                      <span className="review-score-cell">
                        <Stars value={r.avg_score} size="sm" />
                        <strong>{scoreText(r.avg_score)}</strong>
                      </span>
                    ) : (
                      <span className="muted">ยังไม่มีคะแนน</span>
                    )}
                  </td>
                  <td data-label="จำนวนใบ">{r.review_count}</td>
                  <td data-label="ประเมินล่าสุด">
                    {r.last_review_at ? stampText(r.last_review_at) : <span className="muted">—</span>}
                  </td>
                  <td data-label="ลิงก์ประเมิน">
                    {/* has_link บอกว่าเคยออกลิงก์ให้คนนี้แล้วหรือยัง — ยังไม่เคยออกไม่ใช่ปัญหา
                        ลิงก์ถูกออกให้เองตอนเปิดหน้ารายละเอียดครั้งแรก */}
                    {r.has_link ? (
                      <span className="badge">ออกลิงก์แล้ว</span>
                    ) : (
                      <span className="muted">ยังไม่ได้ออก</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageRefresh>
  );
}
