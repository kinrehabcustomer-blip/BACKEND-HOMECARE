import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBaht } from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';

const TIERS = ['CG', 'NA', 'PN', 'RN'];
const CATEGORY_LABELS = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน' };

/**
 * ระดับการดูแลของแต่ละเกรด ไล่ตามลำดับเกรด (เกรด 1 = เบาสุด)
 * ผูกกับ "ลำดับ" ไม่ใช่ชื่อหรือ id — เกรดที่ 4 ขึ้นไปถ้ามีในอนาคตจะไม่มีป้ายกำกับ ไม่พัง
 */
const CARE_LEVELS = ['Light Care', 'Medium Care', 'Heavy Care'];
const careLevelOf = (index) => CARE_LEVELS[index] ?? null;

const cellKey = (formatId, gradeId, tier) => `${formatId}:${gradeId ?? 'x'}:${tier}`;

/** ช่องกรอกว่าง = ไม่ได้ตั้งค่า (null) ไม่ใช่ศูนย์ */
const num = (v) => (v === '' || v == null ? null : Number(v));

/**
 * ส่วนลดเป็นบาท — สูตรเดียวกับฝั่ง server (packages/repo.js)
 * กรอก % ไว้ให้ใช้ % ก่อน ไม่งั้นใช้จำนวนเงิน · ตัดไม่ให้เกินราคาเต็ม ราคาสุทธิจะได้ไม่ติดลบ
 */
function discountOf(price, percent, amount) {
  if (price == null || price <= 0) return 0;
  const raw = percent != null && percent > 0 ? (price * percent) / 100 : (amount ?? 0);
  return Math.min(Math.max(raw, 0), price);
}

/**
 * เซลล์ราคา 1 ช่อง — โหมดดู: ราคาสุทธิ (+ ราคาเต็มขีดฆ่าถ้ามีส่วนลด) · โหมดแก้: ราคา + ส่วนลด %/บาท
 *
 * ประกาศไว้นอก PackagesPage โดยตั้งใจ — ถ้าประกาศข้างในจะกลายเป็น component "ชนิดใหม่" ทุกครั้งที่ state เปลี่ยน
 * React จะถอด input ทิ้งแล้วสร้างใหม่ทุกตัวอักษรที่พิมพ์ ทำให้โฟกัสหลุดจนพิมพ์ตัวเลขต่อกันไม่ได้
 */
function RateCell({ editing, rate, draft, onPatch }) {
  if (editing) {
    const dv = draft ?? {
      customer_price: '', staff_pay: '', discount_percent: '', discount_amount: '', available: true,
    };
    if (!dv.available) {
      return (
        <td className="rate-off">
          <button type="button" className="btn tiny" onClick={() => onPatch({ available: true })}>
            เปิดช่องนี้
          </button>
        </td>
      );
    }

    const price = dv.customer_price === '' ? null : Number(dv.customer_price);
    const cut = discountOf(price, num(dv.discount_percent), num(dv.discount_amount));
    const net = price != null ? price - cut : null;
    const pay = num(dv.staff_pay);
    // กำไรคิดจากราคาสุทธิ (เงินที่เก็บได้จริง) ไม่ใช่ราคาตั้ง — ตั้งส่วนลดแล้วกำไรต้องลดตาม
    const profit = net != null && pay != null ? net - pay : null;

    return (
      <td className="rate-input">
        <div className="rate-edit">
          <div className="rate-edit-row">
            <input
              type="number" min="0" step="100" placeholder="ราคา" value={dv.customer_price}
              onChange={(e) => onPatch({ customer_price: e.target.value })}
            />
            <button
              type="button" className="btn tiny ghost" title="ปิดช่องนี้ (ให้บริการไม่ได้)"
              onClick={() => onPatch({ available: false })}
            >
              <LineIcon name="close" />
            </button>
          </div>
          {/* ค่าจ้างพนักงาน — ตัวตั้งของสรุปค่าตอบแทนรายเดือน ไม่มีช่องนี้ระบบคำนวณค่าแรงให้ใครไม่ได้เลย */}
          <div className="rate-edit-row">
            <input
              type="number" min="0" step="100" placeholder="ค่าจ้าง" title="ค่าจ้างพนักงานต่อรอบบริการ"
              value={dv.staff_pay}
              onChange={(e) => onPatch({ staff_pay: e.target.value })}
            />
          </div>
          <div className="rate-edit-row">
            <input
              type="number" min="0" max="100" step="1" placeholder="ลด %" title="ส่วนลดเป็นเปอร์เซ็นต์"
              value={dv.discount_percent}
              onChange={(e) => onPatch({ discount_percent: e.target.value })}
            />
            <input
              type="number" min="0" step="100" placeholder="ลด ฿" title="ส่วนลดเป็นจำนวนเงิน (ใช้เมื่อไม่ได้กรอก %)"
              value={dv.discount_amount}
              onChange={(e) => onPatch({ discount_amount: e.target.value })}
            />
          </div>
          {/* คำนวณให้เห็นทันทีระหว่างพิมพ์ — สูตรเดียวกับที่ server ใช้ */}
          {price != null && (
            <span className="rate-net">
              {cut > 0 ? `สุทธิ ${formatBaht(net)}` : 'ไม่มีส่วนลด'}
              {profit != null && ` · กำไร ${formatBaht(profit)}`}
            </span>
          )}
        </div>
      </td>
    );
  }

  if (!rate || !rate.available) return <td className="rate-off">ให้บริการไม่ได้</td>;
  if (rate.customer_price == null) return <td className="rate-price">—</td>;

  const discounted = rate.discount_value > 0;
  return (
    <td className="rate-price">
      {discounted && <span className="rate-was">{formatBaht(rate.customer_price)}</span>}
      {formatBaht(discounted ? rate.net_price : rate.customer_price)}
      {discounted && (
        <span className="rate-cut">
          −{rate.discount_percent > 0 ? `${rate.discount_percent}%` : formatBaht(rate.discount_value)}
        </span>
      )}
      {/* ค่าจ้างพนักงาน + กำไรที่เหลือ — ช่องที่ยังไม่ได้ตั้งต้องเห็นชัด เพราะสรุปค่าตอบแทนจะคิดไม่ได้ */}
      {rate.staff_pay != null ? (
        <span className="rate-staff">
          จ้าง {formatBaht(rate.staff_pay)}
          {rate.margin != null && ` · กำไร ${rate.margin}%`}
        </span>
      ) : (
        <span className="rate-staff is-missing">ยังไม่ตั้งค่าจ้าง</span>
      )}
    </td>
  );
}

/** ตารางเรทหนึ่งกลุ่ม (รายวัน/สัปดาห์ = ไม่อิงเกรด · รายเดือน = แยกตามเกรด) */
function RateTable({ label, formats, gradeId, editing, rateMap, draft, onPatchCell }) {
  if (formats.length === 0) return <p className="muted">ยังไม่มีรูปแบบบริการในกลุ่มนี้</p>;

  return (
    <div className="table-wrap">
      <table className={`table rate-table ${editing ? 'is-editing' : ''}`}>
        {/* ล็อกความกว้างคอลัมน์ให้คงที่ — ทุกตารางจึงมีคอลัมน์รูปแบบ + ระดับพนักงานเท่ากันหมด แถบสีตรงกันทุกตาราง
            สร้าง <col> ของ tier จาก TIERS เพื่อให้เพิ่ม/ลดระดับพนักงานแล้วจำนวนคอลัมน์ตรงกับหัวตารางเสมอ */}
        <colgroup>
          <col className="rate-col-format" />
          {TIERS.map((t) => <col key={t} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="rate-format-head">{label}</th>
            {TIERS.map((t) => (
              <th key={t} className={`tier-head tier-${t}`}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {formats.map((f) => (
            <tr key={f.format_id}>
              <td className="rate-format">{f.name}</td>
              {TIERS.map((t) => {
                const key = cellKey(f.format_id, gradeId, t);
                return (
                  <RateCell
                    key={t}
                    editing={editing}
                    rate={rateMap[key]}
                    draft={draft[key]}
                    onPatch={(patch) => onPatchCell(key, patch)}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PackagesPage() {
  const [matrix, setMatrix] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.packageMatrix().then(setMatrix).catch((err) => setError(err.message));
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  if (error) return <p className="error">{error}</p>;
  if (!matrix) return <p className="muted">กำลังโหลด…</p>;

  const sharedFormats = matrix.formats.filter((f) => !f.graded);
  const gradedFormats = matrix.formats.filter((f) => f.graded);
  const rateMap = {};
  for (const r of matrix.rates) rateMap[cellKey(r.format_id, r.grade_id, r.staff_tier)] = r;

  // สร้าง draft ของทุกช่องในตาราง (ช่องที่ยังไม่มีในฐานข้อมูลถือเป็นเปิดให้บริการ ราคาว่าง)
  function startEdit() {
    const d = {};
    for (const f of matrix.formats) {
      const gradeIds = f.graded ? matrix.grades.map((g) => g.grade_id) : [null];
      for (const gid of gradeIds) {
        for (const tier of TIERS) {
          const r = rateMap[cellKey(f.format_id, gid, tier)];
          d[cellKey(f.format_id, gid, tier)] = {
            customer_price: r?.customer_price ?? '',
            staff_pay: r?.staff_pay ?? '',
            discount_percent: r?.discount_percent ?? '',
            discount_amount: r?.discount_amount ?? '',
            available: r ? r.available : true,
          };
        }
      }
    }
    setDraft(d);
    setEditing(true);
  }

  async function saveRates() {
    setBusy(true);
    setError(null);
    try {
      const rates = [];
      for (const f of matrix.formats) {
        const gradeIds = f.graded ? matrix.grades.map((g) => g.grade_id) : [null];
        for (const gid of gradeIds) {
          for (const tier of TIERS) {
            const key = cellKey(f.format_id, gid, tier);
            const dv = draft[key];
            rates.push({
              format_id: f.format_id,
              grade_id: gid,
              staff_tier: tier,
              customer_price: num(dv.customer_price),
              staff_pay: num(dv.staff_pay),
              discount_percent: num(dv.discount_percent),
              discount_amount: num(dv.discount_amount),
              available: dv.available,
            });
          }
        }
      }
      const updated = await api.saveRates(rates);
      setMatrix(updated);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const patchCell = (key, patch) =>
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>แพ็คเกจบริการ (พนักงานพาร์ทไทม์)</h1>
          <p className="muted">ตารางเรทตามเกรด × รูปแบบบริการ × ระดับพนักงาน (CG / NA / PN / RN)</p>
        </div>
        <div className="actions">
          {editing ? (
            <>
              <button className="btn" disabled={busy} onClick={() => setEditing(false)}>ยกเลิก</button>
              <button className="btn primary" disabled={busy} onClick={saveRates}>
                {busy ? 'กำลังบันทึก…' : 'บันทึกราคา'}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setManaging((v) => !v)}>
                {managing ? 'ปิดการจัดการ' : 'จัดการเกรด/รูปแบบ'}
              </button>
              <button className="btn primary" onClick={startEdit}>แก้ไขราคา</button>
            </>
          )}
        </div>
      </header>

      {managing && !editing && (
        <ManagePanel matrix={matrix} onChanged={reload} setError={setError} />
      )}

      <section className="rate-section">
        <h2>รายวัน / รายสัปดาห์ <span className="muted">(เรทเดียว ใช้ร่วมทุกเกรด)</span></h2>
        <RateTable
          label="รูปแบบบริการ" formats={sharedFormats} gradeId={null}
          editing={editing} rateMap={rateMap} draft={draft} onPatchCell={patchCell}
        />
      </section>

      {matrix.grades.map((g, i) => (
        <section className="rate-section" key={g.grade_id}>
          <h2>
            {g.name}
            {careLevelOf(i) && ` (${careLevelOf(i)})`}
            {' '}<span className="muted">· รายเดือน</span>
          </h2>
          {g.description && <p className="grade-desc">{g.description}</p>}
          <RateTable
            label="รูปแบบบริการ" formats={gradedFormats} gradeId={g.grade_id}
            editing={editing} rateMap={rateMap} draft={draft} onPatchCell={patchCell}
          />
        </section>
      ))}

      {matrix.grades.length === 0 && (
        <p className="muted">ยังไม่มีเกรด — กด "จัดการเกรด/รูปแบบ" เพื่อเพิ่ม</p>
      )}
    </>
  );
}

/** แผงจัดการโครงสร้าง: เพิ่ม/แก้/ลบ เกรด และ รูปแบบบริการ (แต่ละปุ่มยิง API ทันที) */
function ManagePanel({ matrix, onChanged, setError }) {
  const [gradeForm, setGradeForm] = useState({ name: '', description: '' });
  const [formatForm, setFormatForm] = useState({ name: '', category: 'monthly', graded: true });
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card manage-panel">
      <div className="manage-cols">
        <div>
          <h3>เกรด</h3>
          <ul className="manage-list">
            {matrix.grades.map((g, i) => (
              <li key={g.grade_id}>
                <div>
                  <strong>
                    {g.name}
                    {careLevelOf(i) && ` (${careLevelOf(i)})`}
                  </strong>
                  {g.description && <p className="muted">{g.description}</p>}
                </div>
                <button
                  className="btn tiny danger-ghost" disabled={busy}
                  onClick={() => confirm(`ลบ ${g.name}? ราคาของเกรดนี้จะถูกลบทั้งหมด`) && run(() => api.deleteGrade(g.grade_id))}
                >
                  ลบ
                </button>
              </li>
            ))}
          </ul>
          <div className="manage-add">
            <input
              placeholder="ชื่อเกรด เช่น เกรด 4"
              value={gradeForm.name}
              onChange={(e) => setGradeForm((p) => ({ ...p, name: e.target.value }))}
            />
            <input
              placeholder="คำอธิบาย (ไม่บังคับ)"
              value={gradeForm.description}
              onChange={(e) => setGradeForm((p) => ({ ...p, description: e.target.value }))}
            />
            <button
              className="btn" disabled={busy || !gradeForm.name.trim()}
              onClick={() =>
                run(async () => {
                  await api.createGrade({
                    name: gradeForm.name.trim(),
                    description: gradeForm.description.trim() || null,
                    sort_order: matrix.grades.length + 1,
                  });
                  setGradeForm({ name: '', description: '' });
                })
              }
            >
              + เพิ่มเกรด
            </button>
          </div>
        </div>

        <div>
          <h3>รูปแบบบริการ</h3>
          <ul className="manage-list">
            {matrix.formats.map((f) => (
              <li key={f.format_id}>
                <div>
                  <strong>{f.name}</strong>
                  <p className="muted">
                    {CATEGORY_LABELS[f.category]}
                    {' · '}
                    {f.graded ? 'แยกราคาตามเกรด' : 'เรทเดียวทุกเกรด'}
                  </p>
                </div>
                <button
                  className="btn tiny danger-ghost" disabled={busy}
                  onClick={() => confirm(`ลบ ${f.name}? ราคาของรูปแบบนี้จะถูกลบทั้งหมด`) && run(() => api.deleteFormat(f.format_id))}
                >
                  ลบ
                </button>
              </li>
            ))}
          </ul>
          <div className="manage-add">
            <input
              placeholder="ชื่อรูปแบบ เช่น รายเดือน 8 ชม."
              value={formatForm.name}
              onChange={(e) => setFormatForm((p) => ({ ...p, name: e.target.value }))}
            />
            <select
              value={formatForm.category}
              onChange={(e) => setFormatForm((p) => ({ ...p, category: e.target.value }))}
            >
              {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={formatForm.graded}
                onChange={(e) => setFormatForm((p) => ({ ...p, graded: e.target.checked }))}
              />
              แยกราคาตามเกรด
            </label>
            <button
              className="btn" disabled={busy || !formatForm.name.trim()}
              onClick={() =>
                run(async () => {
                  await api.createFormat({
                    name: formatForm.name.trim(),
                    category: formatForm.category,
                    graded: formatForm.graded,
                    sort_order: matrix.formats.length + 1,
                  });
                  setFormatForm({ name: '', category: 'monthly', graded: true });
                })
              }
            >
              + เพิ่มรูปแบบ
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
