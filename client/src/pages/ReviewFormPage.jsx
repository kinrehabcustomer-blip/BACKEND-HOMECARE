import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { openDatePicker, todayTH } from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';
import { StarPicker } from '../components/Stars.jsx';
import {
  REVIEW_QUESTIONS,
  SCORE_LABELS,
  WANT_AGAIN_LABELS,
  RECOMMEND_LABELS,
} from '../lib/reviewQuestions.js';

const BLANK = {
  patient_name: '',
  service_date: todayTH(),
  impressed: '',
  improve: '',
  want_again: '',
  recommend: '',
};

/** ตัวเลือกปลายปิด — วาดเป็นปุ่มกดเลือกแทน radio กลมเล็กๆ ที่กดยากบนมือถือ */
function ChoiceGroup({ name, labels, value, onChange }) {
  return (
    <div className="review-choices" role="radiogroup" aria-label={name}>
      {Object.entries(labels).map(([key, text]) => (
        <label key={key} className={`review-choice ${value === key ? 'is-on' : ''}`}>
          <input
            type="radio"
            name={name}
            value={key}
            checked={value === key}
            onChange={() => onChange(key)}
          />
          {text}
        </label>
      ))}
    </div>
  );
}

/**
 * แบบประเมินความพึงพอใจที่ญาติผู้รับบริการกรอก — หน้าสาธารณะ ไม่มี login ไม่มีเมนูของระบบ
 *
 * เปิดจากลิงก์เฉพาะตัวของพนักงาน (/review/:token) ชื่อผู้ถูกประเมินจึงมาจากลิงก์ ไม่ให้เลือกเอง
 * — ญาติจำชื่อเต็มของนักกายภาพไม่ได้เป็นเรื่องปกติ และการให้เลือกจากรายชื่อก็เท่ากับ
 * เปิดรายชื่อพนักงานทั้งบริษัทให้คนนอกเห็น
 */
export default function ReviewFormPage() {
  const { token } = useParams();

  const [therapist, setTherapist] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [scores, setScores] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .reviewForm(token)
      .then(setTherapist)
      .catch((e) => setLoadError(e.message));
  }, [token]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();

    /* บอกให้ครบทีเดียวว่าเหลือข้อไหน ไม่ใช่ทีละข้อ — ฟอร์มยาว 10 ข้อ
       ถ้าฟ้องทีละข้อ คนกรอกต้องเลื่อนขึ้นลงหาซ้ำหลายรอบกว่าจะส่งได้ */
    const missing = REVIEW_QUESTIONS.filter((q) => !scores[q.key]);
    if (missing.length) {
      setError(`กรุณาให้คะแนนให้ครบทุกข้อ — ยังขาดข้อ ${missing.map((q) => REVIEW_QUESTIONS.indexOf(q) + 1).join(', ')}`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.submitReview(token, { ...form, ...scores });
      setDone(true);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="review-page">
        <section className="review-card review-msg">
          <img className="review-logo" src="/logo-navbar.webp" alt="KIN Home Care" />
          <h1>เปิดแบบประเมินไม่ได้</h1>
          <p className="error">{loadError}</p>
        </section>
      </div>
    );
  }

  if (!therapist) {
    return (
      <div className="review-page">
        <p className="muted app-loading">กำลังโหลด…</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="review-page">
        <section className="review-card review-msg">
          <img className="review-logo" src="/logo-navbar.webp" alt="KIN Home Care" />
          {/* เหรียญหัวใจแทนอีโมจิท้ายหัวข้อ — เป็นภาพของหน้านี้ ไม่ใช่ตัวอักษรที่บังเอิญเป็นรูป
              จึงคุมขนาด/สี/ตำแหน่งได้ และตามธีมมืด-สว่างเหมือนไอคอนอื่นทั้งระบบ */}
          <span className="review-done-mark">
            <LineIcon name="heart" className="review-done-ico" />
          </span>
          <h1>ขอบพระคุณสำหรับความคิดเห็นของท่าน</h1>
          <p className="muted">
            ทุกความคิดเห็นของท่านคือส่วนสำคัญในการพัฒนาคุณภาพการดูแลของ KIN
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="review-page">
      <form className="review-card" onSubmit={handleSubmit}>
        <header className="review-head">
          <img className="review-logo" src="/logo-navbar.webp" alt="KIN Home Care" />
          <h1>แบบประเมินความพึงพอใจนักกายภาพบำบัด KIN</h1>
          <p className="review-intro">
            เรียน คุณญาติผู้รับบริการ<br />
            KIN ขอขอบพระคุณสำหรับความไว้วางใจในการใช้บริการกายภาพบำบัดที่บ้าน
            ความคิดเห็นของท่านมีความสำคัญต่อการพัฒนาคุณภาพการให้บริการและการดูแลผู้ป่วยของเรา
          </p>
        </header>

        <div className="review-who">
          <span className="muted">นักกายภาพบำบัด</span>
          <strong>{therapist.first_name} {therapist.last_name}</strong>
        </div>

        <div className="review-fields">
          <label>
            ชื่อผู้ป่วย
            <input
              type="text"
              value={form.patient_name}
              onChange={set('patient_name')}
              placeholder="ไม่กรอกก็ได้"
            />
          </label>
          <label>
            วันที่รับบริการ
            <input type="date" value={form.service_date} onChange={set('service_date')} onFocus={openDatePicker} />
          </label>
        </div>

        <section className="review-section">
          <h2>กรุณาให้คะแนนความพึงพอใจ</h2>
          {/* คำอธิบายคะแนนอยู่ตรงนี้จุดเดียว ไม่ซ้ำใต้ทุกข้อ — id ผูกเข้ากับทุกแถวด้วย aria-describedby
              คนที่ใช้โปรแกรมอ่านหน้าจอจึงได้ยินความหมายของดาวโดยไม่ต้องฟังซ้ำ 10 รอบ */}
          <p className="review-legend" id="review-scale">
            5 = ดีมาก · 4 = ดี · 3 = ปานกลาง · 2 = ควรปรับปรุง · 1 = ควรปรับปรุงมาก
          </p>

          <ol className="review-questions">
            {REVIEW_QUESTIONS.map((q) => (
              <li key={q.key} className="review-q">
                <span className="review-q-label">{q.label}</span>
                <span className="review-q-input">
                  <StarPicker
                    name={q.key}
                    value={scores[q.key] ?? 0}
                    onChange={(n) => setScores((s) => ({ ...s, [q.key]: n }))}
                    describedBy="review-scale"
                  />
                  {/* ย้ำเป็นคำ ไม่ใช่แค่จำนวนดาว — "4 ดาว" กับ "ดี" ไม่ได้แปลว่าเดียวกันในหัวทุกคน */}
                  <span className="review-q-score">{SCORE_LABELS[scores[q.key]] ?? ''}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="review-section">
          <h2>ความคิดเห็นจากคุณญาติ</h2>
          <label className="review-text">
            สิ่งที่ท่านประทับใจในการดูแลของนักกายภาพบำบัดท่านนี้
            <textarea rows="3" value={form.impressed} onChange={set('impressed')} />
          </label>
          <label className="review-text">
            สิ่งที่ท่านอยากให้เราปรับปรุงหรือพัฒนา
            <textarea rows="3" value={form.improve} onChange={set('improve')} />
          </label>
        </section>

        <section className="review-section">
          <h2>คำถามสำหรับประเมินคุณภาพโดยรวม</h2>

          <p className="review-ask">หากมีโอกาส ท่านต้องการให้นักกายภาพบำบัดท่านนี้กลับมาดูแลผู้ป่วยต่อหรือไม่?</p>
          <ChoiceGroup
            name="want_again"
            labels={WANT_AGAIN_LABELS}
            value={form.want_again}
            onChange={(v) => setForm((f) => ({ ...f, want_again: v }))}
          />

          <p className="review-ask">ท่านจะแนะนำ KIN ให้กับครอบครัวหรือคนรู้จักหรือไม่?</p>
          <ChoiceGroup
            name="recommend"
            labels={RECOMMEND_LABELS}
            value={form.recommend}
            onChange={(v) => setForm((f) => ({ ...f, recommend: v }))}
          />
        </section>

        {error && <p className="error">{error}</p>}

        <button className="btn primary review-submit" type="submit" disabled={busy}>
          {busy ? 'กำลังส่ง…' : 'ส่งแบบประเมิน'}
        </button>
        <p className="muted review-note">
          ความคิดเห็นของท่านจะถูกส่งถึงผู้จัดการของ KIN โดยตรง
        </p>
      </form>
    </div>
  );
}
