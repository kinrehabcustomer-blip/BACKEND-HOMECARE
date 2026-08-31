import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { STATUS_LABELS, formatDate, stampText } from '../labels.js';
import Stars from '../components/Stars.jsx';
import LineIcon from '../components/LineIcon.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import { useToast } from '../toast.jsx';
import {
  REVIEW_QUESTIONS,
  SCORE_LABELS,
  WANT_AGAIN_LABELS,
  RECOMMEND_LABELS,
  scoreText,
} from '../lib/reviewQuestions.js';

/** ที่อยู่เต็มของลิงก์ที่ญาติจะเปิด — โดเมนเดียวกับที่ผู้จัดการเปิดหน้านี้อยู่ */
const linkFor = (token) => `${window.location.origin}/review/${token}`;

/** แถวกราฟแท่ง — สัดส่วนคิดจาก max ที่ส่งเข้ามา เพื่อให้ทุกแถวในชุดเดียวกันเทียบกันได้ */
function Bar({ label, value, max, text }) {
  return (
    <li>
      <span className="bar-label review-bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
      </span>
      <span className="bar-value review-bar-value">{text}</span>
    </li>
  );
}

/** นับคำตอบปลายปิดเป็นแถว — ตัวเลือกที่ไม่มีใครเลือกยังต้องขึ้น (0 คือคำตอบเหมือนกัน) */
function ChoiceBars({ labels, counts }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return <p className="muted">ยังไม่มีใครตอบข้อนี้</p>;

  return (
    <ul className="bars">
      {Object.entries(labels).map(([key, text]) => (
        <Bar key={key} label={text} value={counts[key] ?? 0} max={total} text={counts[key] ?? 0} />
      ))}
    </ul>
  );
}

/**
 * คะแนนประเมินรายบุคคล — คะแนนรวม, รายหัวข้อ, ความเห็น และลิงก์/QR ที่เอาไปส่งให้ญาติ
 */
export default function ReviewDetailPage() {
  const { id } = useParams();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [token, setToken] = useState(null);
  const [qr, setQr] = useState(null);

  const load = () => {
    setLoading(true);
    return api
      .employeeReviews(id)
      .then((v) => { setData(v); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // ลิงก์ถูกออกให้เองตอนเปิดหน้านี้ครั้งแรก จึงไม่มีขั้นตอน "สร้างลิงก์" ให้ต้องกดแยก
    api.reviewLink(id).then((r) => setToken(r.token)).catch((e) => setError(e.message));
  }, [id]);

  /* วาด QR ใหม่ทุกครั้งที่ token เปลี่ยน — ออกลิงก์ใหม่แล้ว QR เดิมต้องไม่ค้างอยู่บนจอ
     ไม่งั้นจะมีคนแคปโค้ดที่ใช้ไม่ได้แล้วส่งให้ญาติ */
  useEffect(() => {
    if (!token) return;
    QRCode.toDataURL(linkFor(token), { width: 512, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [token]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      toast('คัดลอกลิงก์แล้ว');
    } catch {
      // เบราว์เซอร์บล็อกคลิปบอร์ด (มักเป็นตอนเปิดผ่าน http) — บอกไปตรงๆ ว่าให้ก๊อปเอง
      setError('คัดลอกอัตโนมัติไม่ได้ — กรุณาเลือกข้อความในช่องลิงก์แล้วคัดลอกเอง');
    }
  }

  async function rotate() {
    try {
      const r = await api.rotateReviewLink(id);
      setToken(r.token);
      toast('ออกลิงก์ใหม่แล้ว — ลิงก์และ QR เดิมใช้ไม่ได้อีก');
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeReview(reviewId) {
    try {
      await api.deleteReview(reviewId);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">กำลังโหลด…</p>;

  const { employee, review_count, avg_score, last_review_at, questions, stars, reviews } = data;
  const maxStar = Math.max(1, ...stars.map((s) => s.count));

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      <header className="page-head">
        <div>
          <p className="muted"><Link className="link" to="/reviews">← คะแนนประเมินจากญาติ</Link></p>
          <h1>{employee.first_name} {employee.last_name}</h1>
          <p className="muted">
            <span className="mono">{employee.employee_id}</span>
            {employee.status !== 'active' && ` · ${STATUS_LABELS[employee.status] ?? employee.status}`}
            {last_review_at && ` · ประเมินล่าสุด ${stampText(last_review_at)}`}
          </p>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="card review-hero">
        <div className="review-hero-score">
          <span className="review-hero-value">{scoreText(avg_score)}</span>
          <Stars value={avg_score} size="lg" />
          <span className="muted">
            {review_count ? `จากแบบประเมิน ${review_count} ใบ` : 'ยังไม่มีแบบประเมิน'}
          </span>
        </div>

        {/* การแจกแจงบอกสิ่งที่ค่าเฉลี่ยบอกไม่ได้ — 4.0 ที่มาจาก "4 ทุกใบ"
            กับ 4.0 ที่มาจาก "5 ครึ่ง 3 ครึ่ง" เป็นคนละเรื่องกันสิ้นเชิงในการจัดการคน */}
        <ul className="bars review-stars-dist">
          {stars.map((s) => (
            <Bar key={s.star} label={`${s.star} ดาว`} value={s.count} max={maxStar} text={s.count} />
          ))}
        </ul>
      </section>

      <section className="card review-link-card">
        <h2>ลิงก์สำหรับให้ญาติประเมิน</h2>
        <p className="muted">
          ส่งลิงก์นี้หรือให้ญาติสแกน QR — เปิดได้เลยโดยไม่ต้องเข้าสู่ระบบ
          และเป็นลิงก์เฉพาะของ{employee.first_name} คนเดียว
        </p>

        {token ? (
          <div className="review-link-body">
            {qr && <img className="review-qr" src={qr} alt={`QR แบบประเมินของ ${employee.first_name}`} />}
            <div className="review-link-actions">
              <input className="mono review-link-input" type="text" value={linkFor(token)} readOnly onFocus={(e) => e.target.select()} />
              <div className="actions">
                <button className="btn" type="button" onClick={copyLink}>คัดลอกลิงก์</button>
                {qr && (
                  <a className="btn" href={qr} download={`review-${employee.employee_id}.png`}>
                    <LineIcon name="download" /> บันทึก QR
                  </a>
                )}
                <ConfirmButton
                  className="btn danger-ghost"
                  title="ออกลิงก์ใหม่?"
                  detail="ลิงก์และ QR เดิมที่แจกไปแล้วจะใช้ไม่ได้ทันที ใช้เมื่อลิงก์หลุดไปที่ที่ไม่ควรอยู่"
                  confirmLabel="ออกลิงก์ใหม่"
                  cancelLabel="ไม่ต้อง"
                  onConfirm={rotate}
                >
                  ออกลิงก์ใหม่
                </ConfirmButton>
              </div>
            </div>
          </div>
        ) : (
          <p className="muted">กำลังเตรียมลิงก์…</p>
        )}
      </section>

      <section className="card">
        <h2>คะแนนรายหัวข้อ</h2>
        {review_count ? (
          <ul className="bars">
            {REVIEW_QUESTIONS.map((q) => (
              <Bar
                key={q.key}
                label={q.short}
                value={questions[q.key] ?? 0}
                max={5}
                text={scoreText(questions[q.key])}
              />
            ))}
          </ul>
        ) : (
          <p className="muted">ยังไม่มีแบบประเมิน</p>
        )}
      </section>

      <div className="columns">
        <section className="card">
          <h2>อยากให้กลับมาดูแลต่อ</h2>
          <ChoiceBars labels={WANT_AGAIN_LABELS} counts={data.want_again} />
        </section>
        <section className="card">
          <h2>จะแนะนำ KIN ให้คนรู้จัก</h2>
          <ChoiceBars labels={RECOMMEND_LABELS} counts={data.recommend} />
        </section>
      </div>

      <section className="card">
        <h2>ความเห็นจากญาติ</h2>
        {reviews.length === 0 ? (
          <p className="muted">ยังไม่มีแบบประเมิน</p>
        ) : (
          <ul className="review-list">
            {reviews.map((r) => (
              <li key={r.review_id} className="review-item">
                <div className="review-item-head">
                  <span className="review-score-cell">
                    <Stars value={r.avg_score} size="sm" />
                    <strong>{scoreText(r.avg_score)}</strong>
                  </span>
                  <span className="muted">
                    {r.patient_name && `ผู้ป่วย ${r.patient_name} · `}
                    {r.service_date ? `รับบริการ ${formatDate(r.service_date)} · ` : ''}
                    ส่ง {stampText(r.submitted_at)}
                  </span>
                  <ConfirmButton
                    className="btn icon-btn danger-ghost"
                    title="ลบแบบประเมินใบนี้?"
                    detail="ใช้กับใบที่เห็นชัดว่าเป็นการกดทดสอบหรือยิงมั่ว — ค่าเฉลี่ยจะถูกคิดใหม่ให้เอง"
                    confirmLabel="ลบใบนี้"
                    onConfirm={() => removeReview(r.review_id)}
                    aria-label="ลบแบบประเมินใบนี้"
                  >
                    {/* ไอคอนจากชุดกลาง ไม่ใช่อักขระ ✕ — Anuphan ไม่มีอักขระตัวนั้น
                        บางเครื่องจึงขึ้นเป็นกล่องสี่เหลี่ยม (เหตุผลเดียวกับหัวไฟล์ LineIcon.jsx) */}
                    <LineIcon name="close" />
                  </ConfirmButton>
                </div>

                {r.impressed && (
                  <p className="review-item-text">
                    <span className="review-item-tag">ประทับใจ</span> {r.impressed}
                  </p>
                )}
                {r.improve && (
                  <p className="review-item-text">
                    <span className="review-item-tag">อยากให้ปรับปรุง</span> {r.improve}
                  </p>
                )}

                <p className="muted review-item-choices">
                  {r.want_again && `กลับมาดูแลต่อ: ${WANT_AGAIN_LABELS[r.want_again]}`}
                  {r.want_again && r.recommend && ' · '}
                  {r.recommend && `แนะนำ KIN: ${RECOMMEND_LABELS[r.recommend]}`}
                </p>

                {/* คะแนนรายข้อของใบนี้ — กางไว้ให้ดูได้ว่าคะแนนรวมมาจากตรงไหน โดยไม่ต้องเปิดหน้าใหม่ */}
                <details className="review-item-detail">
                  <summary>ดูคะแนนทั้ง 10 ข้อของใบนี้</summary>
                  <ul className="review-item-scores">
                    {REVIEW_QUESTIONS.map((q) => (
                      <li key={q.key}>
                        <span>{q.short}</span>
                        <strong>{r[q.key]} · {SCORE_LABELS[r[q.key]]}</strong>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageRefresh>
  );
}
