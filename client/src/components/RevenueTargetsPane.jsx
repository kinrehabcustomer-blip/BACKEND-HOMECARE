import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatBaht, formatDate, todayTH } from '../labels.js';
import ErrorBar from './ErrorBar.jsx';
import SearchSelect from './SearchSelect.jsx';
import { BU_LABELS, TARGET_BUS, monthLabel, r2 } from '../lib/revenueReport.js';

/**
 * เป้ารายได้รายเดือนต่อ BU (ตั้งค่าระบบ › การเงิน · 20 พ.ย. 2569) — Super Admin + ผู้จัดการเท่านั้น (server ตรวจซ้ำ)
 * หน้ารายได้ตาม BU เอาไปเทียบ: ช่วงที่ไม่เต็มเดือนเฉลี่ยเป้าตามจำนวนวัน · ช่องว่าง = ไม่ตั้งเป้าเดือนนั้น
 * แก้ได้ทั้งปีแล้วกดบันทึกครั้งเดียว · ส่งเฉพาะช่องที่เปลี่ยน
 */

const keyOf = (month, bu) => `${month}|${bu}`;
const parse = (v) => {
  const n = Number(String(v).replace(/[,\s฿]/g, ''));
  return String(v).trim() === '' ? null : Number.isFinite(n) && n >= 0 ? r2(n) : NaN;
};

export default function RevenueTargetsPane() {
  const thisYear = Number(todayTH().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [saved, setSaved] = useState(null); // { 'YYYY-MM|bu': amount }
  const [draft, setDraft] = useState({});
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [fill, setFill] = useState({ bu: TARGET_BUS[0], amount: '' });

  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`), [year]);

  const load = (rows) => {
    const map = Object.fromEntries(rows.map((r) => [keyOf(r.month, r.bu), r.amount]));
    setSaved(map);
    setDraft(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)])));
    const last = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    setMeta(last ? { by: last.updated_by_name, at: last.updated_at } : null);
  };

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setError(null);
    setDone(false);
    api.revenueTargets(year).then((d) => !cancelled && load(d.rows)).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [year]);

  const value = (m, bu) => draft[keyOf(m, bu)] ?? '';
  const set = (m, bu, v) => { setDone(false); setDraft((d) => ({ ...d, [keyOf(m, bu)]: v })); };
  const changes = useMemo(() => {
    if (!saved) return [];
    const out = [];
    for (const m of months) {
      for (const bu of TARGET_BUS) {
        const now = parse(value(m, bu));
        const before = saved[keyOf(m, bu)] ?? null;
        if (Number.isNaN(now) || now === before || (now === 0 && before == null)) continue;
        out.push({ month: m, bu, amount: now || null });
      }
    }
    return out;
  }, [draft, saved, months]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalid = months.some((m) => TARGET_BUS.some((bu) => Number.isNaN(parse(value(m, bu)))));
  const rowTotal = (m) => r2(TARGET_BUS.reduce((s, bu) => s + (parse(value(m, bu)) || 0), 0));
  const colTotal = (bu) => r2(months.reduce((s, m) => s + (parse(value(m, bu)) || 0), 0));
  const grand = r2(months.reduce((s, m) => s + rowTotal(m), 0));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.saveRevenueTargets(year, changes);
      load(d.rows);
      setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const fillAll = () => {
    const n = parse(fill.amount);
    if (Number.isNaN(n)) return;
    setDone(false);
    setDraft((d) => ({ ...d, ...Object.fromEntries(months.map((m) => [keyOf(m, fill.bu), n == null ? '' : String(n)])) }));
  };

  return (
    <div className="rt-pane">
      <div className="rt-head">
        <label className="rt-year">
          <span className="muted">ปี</span>
          <SearchSelect value={String(year)} searchable={false} aria-label="ปีของเป้า" onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{`พ.ศ. ${y + 543}`}</option>)}
          </SearchSelect>
        </label>
        <div className="rt-fill" role="group" aria-label="ใส่เป้าเท่ากันทุกเดือน">
          <SearchSelect value={fill.bu} searchable={false} aria-label="BU ที่จะใส่ทุกเดือน" onChange={(e) => setFill((f) => ({ ...f, bu: e.target.value }))}>
            {TARGET_BUS.map((bu) => <option key={bu} value={bu}>{BU_LABELS[bu]}</option>)}
          </SearchSelect>
          <input type="text" inputMode="decimal" placeholder="บาท/เดือน" value={fill.amount} aria-label="ยอดเป้าต่อเดือน"
            onChange={(e) => setFill((f) => ({ ...f, amount: e.target.value }))} />
          <button type="button" className="btn tiny" disabled={Number.isNaN(parse(fill.amount))} onClick={fillAll}>ใส่ทุกเดือน</button>
        </div>
      </div>

      <ErrorBar message={error} />
      {!saved && !error && <p className="muted">กำลังโหลด…</p>}
      {saved && (
        <>
          <div className="table-wrap">
            <table className="bu-table is-cards rt-table">
              <thead>
                <tr>
                  <th>เดือน</th>
                  {TARGET_BUS.map((bu) => <th key={bu} className="num">{BU_LABELS[bu]}</th>)}
                  <th className="num">รวม</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m}>
                    <td className="rbu-name-cell">{monthLabel(m, true)}</td>
                    {TARGET_BUS.map((bu) => {
                      const bad = Number.isNaN(parse(value(m, bu)));
                      return (
                        <td key={bu} className="num" data-label={BU_LABELS[bu]}>
                          <input type="text" inputMode="decimal" className={`rt-input${bad ? ' is-bad' : ''}`} value={value(m, bu)} placeholder="—"
                            aria-label={`เป้า ${BU_LABELS[bu]} ${monthLabel(m, true)}`} aria-invalid={bad || undefined}
                            onChange={(e) => set(m, bu, e.target.value)} />
                        </td>
                      );
                    })}
                    <td className="num muted" data-label="รวม">{rowTotal(m) ? formatBaht(rowTotal(m)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="rbu-name-cell">ทั้งปี</td>
                  {TARGET_BUS.map((bu) => <td key={bu} className="num" data-label={BU_LABELS[bu]}>{colTotal(bu) ? formatBaht(colTotal(bu)) : '—'}</td>)}
                  <td className="num" data-label="รวม"><strong>{grand ? formatBaht(grand) : '—'}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="rt-actions">
            <span className="muted rt-meta">
              {done ? 'บันทึกแล้ว' : changes.length ? `แก้ไข ${changes.length} ช่อง ยังไม่ได้บันทึก` : meta ? `แก้ล่าสุด ${formatDate(String(meta.at).slice(0, 10))} ${String(meta.at).slice(11, 16)}${meta.by ? ` · ${meta.by}` : ''}` : 'ยังไม่ได้ตั้งเป้าปีนี้'}
            </span>
            <button type="button" className="btn primary" disabled={busy || invalid || changes.length === 0} onClick={save}>
              {busy ? 'กำลังบันทึก…' : 'บันทึกเป้า'}
            </button>
          </div>
          <p className="muted rbu-foot">
            เป้าเทียบกับรายได้เกณฑ์เงินสดในหน้ารายได้ตาม BU · ช่องว่าง = ไม่ตั้งเป้าเดือนนั้น · ดูช่วงที่ไม่เต็มเดือน เป้าจะเฉลี่ยตามจำนวนวัน
          </p>
        </>
      )}
    </div>
  );
}
