import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBaht } from '../labels.js';

const TIERS = ['CG', 'NA', 'PN'];
const CATEGORY_LABELS = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน' };

const cellKey = (formatId, gradeId, tier) => `${formatId}:${gradeId ?? 'x'}:${tier}`;

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
              customer_price: dv.customer_price === '' ? null : Number(dv.customer_price),
              // ค่าตอบแทนไม่มีช่องแก้ในหน้านี้แล้ว — ส่งค่าเดิมกลับไปเพื่อไม่ให้ข้อมูลที่เคยกรอกหาย
              staff_pay: rateMap[key]?.staff_pay ?? null,
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

  /** เซลล์ราคา 1 ช่อง = 1 คอลัมน์ (ค่าบริการ) */
  function RateCell({ format, gradeId, tier }) {
    const key = cellKey(format.format_id, gradeId, tier);

    if (editing) {
      const dv = draft[key] ?? { customer_price: '', available: true };
      if (!dv.available) {
        return (
          <td className="rate-off">
            <button type="button" className="btn tiny" onClick={() => patchCell(key, { available: true })}>
              เปิดช่องนี้
            </button>
          </td>
        );
      }
      return (
        <td className="rate-input">
          <input
            type="number" min="0" step="100" value={dv.customer_price}
            onChange={(e) => patchCell(key, { customer_price: e.target.value })}
          />
          <button
            type="button" className="btn tiny ghost" title="ปิดช่องนี้ (ให้บริการไม่ได้)"
            onClick={() => patchCell(key, { available: false })}
          >
            ✕
          </button>
        </td>
      );
    }

    const r = rateMap[key];
    if (!r || !r.available) {
      return <td className="rate-off">ให้บริการไม่ได้</td>;
    }
    return <td className="rate-price">{r.customer_price != null ? formatBaht(r.customer_price) : '—'}</td>;
  }

  function RateTable({ label, formats, gradeId }) {
    if (formats.length === 0) return <p className="muted">ยังไม่มีรูปแบบบริการในกลุ่มนี้</p>;
    return (
      <div className="table-wrap">
        <table className="table rate-table">
          {/* ล็อกความกว้างคอลัมน์ให้คงที่ — ทุกตารางจึงมีคอลัมน์รูปแบบ + CG/NA/PN เท่ากันหมด แถบสีตรงกันทุกตาราง */}
          <colgroup>
            <col className="rate-col-format" />
            <col />
            <col />
            <col />
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
                {TIERS.map((t) => (
                  <RateCell key={t} format={f} gradeId={gradeId} tier={t} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>แพ็คเกจบริการ</h1>
          <p className="muted">ตารางเรทตามเกรด × รูปแบบบริการ × ระดับพนักงาน (CG / NA / PN)</p>
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
        <RateTable label="รูปแบบบริการ" formats={sharedFormats} gradeId={null} />
      </section>

      {matrix.grades.map((g) => (
        <section className="rate-section" key={g.grade_id}>
          <h2>{g.name} <span className="muted">· รายเดือน</span></h2>
          {g.description && <p className="grade-desc">{g.description}</p>}
          <RateTable label="รูปแบบบริการ" formats={gradedFormats} gradeId={g.grade_id} />
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
            {matrix.grades.map((g) => (
              <li key={g.grade_id}>
                <div>
                  <strong>{g.name}</strong>
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
