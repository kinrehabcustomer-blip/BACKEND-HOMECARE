import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { STATUS_LABELS, POSITION_LABELS, stampText } from '../labels.js';
import Stars from '../components/Stars.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import { scoreText } from '../lib/reviewQuestions.js';

/**
 * คะแนนประเมินจากญาติผู้รับบริการ — ภาพรวมรายบุคคล
 *
 * คะแนนรวมของแต่ละคน = ค่าเฉลี่ยของ "ค่าเฉลี่ยทุกข้อในใบนั้น" ของทุกใบ (คิดฝั่ง server)
 * ทุกใบจึงมีน้ำหนักเท่ากันไม่ว่าญาติจะให้คะแนนกระจายแค่ไหนในใบเดียว
 */
export default function ReviewsPage() {
  const navigate = useNavigate();
  /* ตัวกรองอยู่ใน URL แบบเดียวกับหน้าเคส/ลูกค้า — กดเข้าดูรายละเอียดแล้วย้อนกลับ คำค้นยังอยู่
     replace ไม่ push: พิมพ์ทีละตัวไม่ควรกลายเป็นประวัติให้กดย้อนกลับทีละตัวอักษร */
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const ratedFilter = params.get('rated') ?? '';
  const setFilter = (key, value) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  const filtered = Boolean(q || ratedFilter);
  const clearFilters = () => setParams({}, { replace: true });
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

  /* ค้นในหน้า (ข้อมูลทั้งทีมโหลดมาครั้งเดียวอยู่แล้ว) — ชื่อ นามสกุล ชื่อเล่น รหัส หรือตำแหน่ง
     การ์ดสรุปด้านบนยังเป็นตัวเลขของทั้งทีม ไม่เปลี่ยนตามคำค้น */
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (ratedFilter === 'yes' && !r.review_count) return false;
    if (ratedFilter === 'no' && r.review_count) return false;
    if (!needle) return true;
    return [r.first_name, r.last_name, `${r.first_name} ${r.last_name}`, r.nickname, r.employee_id,
      POSITION_LABELS[r.position], r.position]
      .some((v) => v && String(v).toLowerCase().includes(needle));
  });

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      {/* ไม่มีหัวหน้าบนจอ (การ์ดสรุปเป็นส่วนบนสุด) — คง h1 ไว้ให้โปรแกรมอ่านหน้าจอ */}
      <h1 className="sr-only">คะแนนประเมินจากญาติ</h1>

      {error && <p className="error">{error}</p>}

      {/* สรุปตัวเลข + ตาราง อยู่ในการ์ดขาวใบเดียว (โครงเดียวกับหน้าการมาทำงาน — ดู .reviews-card) */}
      <div className="list-card reviews-card">
        {/* is-static — ช่องตัวเลขพวกนี้กดไม่ได้ ต้องไม่เปลี่ยนสีตอนเอาเมาส์ชี้ ไม่งั้นหลอกว่ากดได้ */}
        <div className="tiles review-tiles">
          <div className="tile is-static">
            <span className="tile-label">คะแนนเฉลี่ยทั้งทีม</span>
            <span className="tile-value">{scoreText(teamAvg)}</span>
            <Stars value={teamAvg} size="sm" />
          </div>
          <div className="tile is-static">
            <span className="tile-label">แบบประเมินทั้งหมด</span>
            <span className="tile-value">{totalReviews}</span>
            <span className="tile-frac">ใบ</span>
          </div>
          <div className="tile is-static">
            <span className="tile-label">มีคะแนนแล้ว</span>
            <span className="tile-value">{rated.length}</span>
            <span className="tile-frac">จาก {rows.length} คน</span>
          </div>
        </div>

        {rows.length > 0 && (
          <div className="toolbar">
            <input
              className="search search-compact"
              type="search"
              placeholder="ค้นหา ชื่อพนักงาน / ชื่อเล่น / รหัสพนักงาน / ตำแหน่ง"
              aria-label="ค้นหาพนักงาน"
              value={q}
              onChange={(e) => setFilter('q', e.target.value)}
            />
            <select value={ratedFilter} onChange={(e) => setFilter('rated', e.target.value)} aria-label="คะแนน">
              <option value="">พนักงานทุกคน</option>
              <option value="yes">มีคะแนนแล้ว</option>
              <option value="no">ยังไม่มีคะแนน</option>
            </select>
            {/* โผล่เฉพาะตอนมีอะไรกรองอยู่ — ปุ่มที่กดแล้วไม่เกิดอะไรขึ้นไม่ควรมีให้เห็น */}
            {filtered && <button className="btn" onClick={clearFilters}>ล้างตัวกรอง</button>}
            {filtered && <span className="muted">พบ {shown.length} จาก {rows.length} คน</span>}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="empty-state">
            <p>ยังไม่มีพนักงานกลุ่ม front ในระบบ</p>
            <p className="muted">
              แบบประเมินนี้เปิดใช้กับพนักงานที่ออกไปดูแลผู้รับบริการ — CG, NA, PN, RN และสายบำบัด
            </p>
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
                {shown.map((r) => (
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
                        {/* ทุกตำแหน่งหน้างานอยู่ตารางเดียวกันแล้ว — บอกตำแหน่งให้แยกออกว่าใครเป็นใคร */}
                        <span className="cell-sub"><span className="mono">{r.employee_id}</span> · {POSITION_LABELS[r.position] ?? r.position}</span>
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
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      ไม่พบพนักงานที่ตรงกับคำค้น{' '}
                      <button className="btn link-btn" onClick={clearFilters}>ล้างตัวกรอง</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageRefresh>
  );
}
