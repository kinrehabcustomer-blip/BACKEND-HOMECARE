import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { POSITION_LABELS } from '../labels.js';
import FilterBar from '../components/FilterBar.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import { downloadCsv } from '../lib/attendanceUi.js';

/**
 * บันทึกการใช้งาน — Super Admin เท่านั้น (server/src/audit/routes.js)
 *
 * ใคร ทำอะไร กับข้อมูลของใคร เมื่อไร จากที่ไหน สำเร็จไหม · เก็บอย่างน้อย 1 ปี (ลบ/แก้ย้อนหลังไม่ได้)
 * ตัวกรองทั้งหมดอยู่ใน URL — รีเฟรชแล้วอยู่ที่เดิม ส่งลิงก์ให้กันดูได้
 * การเปิดหน้านี้และการส่งออกก็ถูกบันทึกด้วย
 */

const LEVEL_CLASS = { 1: 'invoice-overdue', 2: 'case-awaiting_close', 3: 'probation', 4: 'on_leave' };
const LEVEL_SHORT = { 1: 'ความปลอดภัย', 2: 'ข้อมูลบุคคล', 3: 'การเงิน', 4: 'งานบริการ' };

const bkkDate = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const daysAgo = (n) => bkkDate(new Date(Date.now() - n * 86_400_000));

const FILTER_KEYS = ['q', 'from', 'to', 'level', 'actor', 'action', 'ok'];
const posLabel = (p) => (p ? POSITION_LABELS[p] ?? p : '');

/** ผู้ทำรายการ — ไม่มีรหัสพนักงาน = มาจากนอกระบบ (ลิงก์บิล/แบบประเมิน หรือระบบแชท LINE) */
function actorText(r) {
  if (r.actor_id) return r.actor_name ?? r.actor_id;
  if (r.detail?.source) return 'ระบบแชท (LINE)';
  if (r.action.startsWith('public.') || r.action === 'reviews.form') return 'บุคคลภายนอก (ลิงก์)';
  if (r.detail?.login) return `ไม่ทราบตัวตน (${r.detail.login})`;
  return 'ไม่ทราบตัวตน';
}

function targetText(r) {
  if (!r.target_id) return '—';
  if (r.target_type === 'positions') return `ตำแหน่ง ${posLabel(r.target_id)}`;
  return r.target_label ? `${r.target_label}` : r.target_id;
}

const valueText = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function Detail({ r }) {
  const d = r.detail ?? {};
  const items = [
    ['เส้นทาง', `${r.method ?? ''} ${r.path ?? ''}`.trim() || '—'],
    ['ผลจากระบบ', r.status ? `HTTP ${r.status}` : '—'],
    d.error && ['ข้อความ', d.error],
    d.login && ['ชื่อที่ใช้เข้าระบบ', d.login],
    d.reason && ['เหตุผล', d.reason],
    d.otp && ['OTP', d.otp === 'issued' ? 'ออกรหัสแล้ว' : 'ไม่ได้ออกรหัส'],
    d.sub && ['รายการย่อย', Object.entries(d.sub).map(([k, v]) => `${k} ${v}`).join(' · ')],
    d.fields && !d.values && ['ช่องที่ส่งมาแก้', d.fields.join(', ')],
    d.query && ['ตัวกรองที่ใช้', Object.entries(d.query).map(([k, v]) => `${k}=${valueText(v)}`).join(' · ')],
    d.source && ['ที่มา', d.source],
    r.target_id && ['รหัสเป้าหมาย', `${r.target_type ?? ''} ${r.target_id}`],
    r.actor_id && ['รหัสผู้ทำ', `${r.actor_id}${r.actor_position ? ` · ${posLabel(r.actor_position)}` : ''}`],
    ['IP', r.ip ?? '—'],
    ['อุปกรณ์', r.user_agent ?? '—'],
  ].filter(Boolean);

  return (
    <div className="audit-detail">
      <dl>
        {items.map(([k, v]) => (
          <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>
        ))}
      </dl>
      {d.values && (
        <>
          <p className="audit-detail-title">ค่าที่ส่งมา</p>
          <dl>
            {Object.entries(d.values).map(([k, v]) => (
              <Fragment key={k}><dt className="mono">{k}</dt><dd>{valueText(v)}</dd></Fragment>
            ))}
          </dl>
        </>
      )}
      {Array.isArray(d.case_events) && d.case_events.length > 0 && (
        <>
          <p className="audit-detail-title">สำเนาประวัติเคสก่อนลบ ({d.case_events.length} รายการ)</p>
          <ul className="audit-events">
            {d.case_events.map((e, i) => (
              <li key={i}>{e.created_at} · {e.actor_name ?? '—'} · {e.event}{e.detail ? ` — ${e.detail}` : ''}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const lastQuery = useRef({});
  /* รุ่นของชุดผลลัพธ์ — เปลี่ยนตัวกรองแล้ว "โหลดเพิ่ม" ที่ยังค้างของชุดเก่าต้องไม่ต่อท้ายชุดใหม่ */
  const generation = useRef(0);

  const get = (k) => params.get(k) ?? '';
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, get(k)]));
  // ค่าปริยาย: 7 วันล่าสุด — เปิดหน้ามาแล้วไม่ต้องกวาดทั้งปี
  const from = filters.from || daysAgo(6);
  const to = filters.to || bkkDate(new Date());
  const filtered = FILTER_KEYS.some((k) => filters[k]);

  const patch = (changes) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === '' || v == null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api.auditMeta().then(setMeta).catch(() => {});
  }, [reloadKey]);

  const query = { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), from, to, limit: 50 };
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    let cancelled = false;
    generation.current += 1;
    setLoading(true);
    const timer = setTimeout(() => {
      const q = JSON.parse(queryKey);
      api
        .auditLogs(q)
        .then((data) => {
          if (cancelled) return;
          lastQuery.current = q;
          setRows(data.rows);
          setNextBefore(data.next_before);
          setOpen(null);
          setError(null);
        })
        .catch((e) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [queryKey, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!nextBefore) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const data = await api.auditLogs({ ...lastQuery.current, before: nextBefore });
      if (gen !== generation.current) return; // ตัวกรองเปลี่ยนระหว่างรอ — ทิ้ง
      setRows((rs) => [...rs, ...data.rows]);
      setNextBefore(data.next_before);
      setError(null);
    } catch (e) {
      if (gen === generation.current) setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [nextBefore]);

  async function exportCsv() {
    setExporting(true);
    try {
      // ตัวกรองที่เห็นบนจอตอนกด ไม่ใช่ชุดที่โหลดเสร็จล่าสุด (อาจยังไม่ทันโหลด หรือโหลดไม่สำเร็จ)
      const { limit: _limit, ...q } = JSON.parse(queryKey);
      const data = await api.exportAuditLogs(q);
      downloadCsv(
        `audit-log-${q.from}_${q.to}.csv`,
        ['เวลา', 'ผู้ทำ', 'รหัสผู้ทำ', 'ตำแหน่ง', 'ระดับ', 'การกระทำ', 'action', 'เป้าหมาย', 'รหัสเป้าหมาย',
          'ผล', 'HTTP', 'เส้นทาง', 'IP', 'อุปกรณ์', 'รายละเอียด'],
        data.rows.map((r) => [
          r.at, actorText(r), r.actor_id ?? '', posLabel(r.actor_position), LEVEL_SHORT[r.level] ?? r.level,
          r.label, r.action, targetText(r), r.target_id ?? '', r.ok ? 'สำเร็จ' : 'ไม่สำเร็จ', r.status ?? '',
          `${r.method ?? ''} ${r.path ?? ''}`.trim(), r.ip ?? '', r.user_agent ?? '',
          r.detail ? JSON.stringify(r.detail) : '',
        ]),
      );
      if (data.truncated) setError(`ส่งออกได้ครั้งละไม่เกิน ${data.max.toLocaleString('th-TH')} รายการ — ไฟล์มีเฉพาะรายการล่าสุด กรุณาแบ่งช่วงวันที่แล้วส่งออกใหม่`);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  }

  const toggle = (id) => setOpen((cur) => (cur === id ? null : id));

  return (
    <>
      <h1 className="sr-only">บันทึกการใช้งาน</h1>
      <div className="list-card">
        <FilterBar
          search={<input
            className="search search-compact"
            placeholder="ค้นหา ชื่อ / รหัสพนักงาน / รหัสลูกค้า-เคส / IP / อีเมลที่ใช้เข้าระบบ"
            value={filters.q}
            onChange={(e) => patch({ q: e.target.value })}
          />}
          filters={(<>
            <label className="audit-date">ตั้งแต่
              <input type="date" value={from} max={to} onChange={(e) => patch({ from: e.target.value })} />
            </label>
            <label className="audit-date">ถึง
              <input type="date" value={to} min={from} onChange={(e) => patch({ to: e.target.value })} />
            </label>
            <SearchSelect value={filters.level} onChange={(e) => patch({ level: e.target.value })} aria-label="ระดับ">
              <option value="">ทุกระดับ</option>
              {[1, 2, 3, 4].map((l) => <option key={l} value={l}>ระดับ {l} · {meta?.levels?.[l] ?? LEVEL_SHORT[l]}</option>)}
            </SearchSelect>
            <SearchSelect value={filters.actor} onChange={(e) => patch({ actor: e.target.value })} aria-label="ผู้ทำรายการ">
              <option value="">ทุกคน</option>
              {(meta?.actors ?? []).map((a) => (
                <option key={a.actor_id} value={a.actor_id}>
                  {a.actor_name ?? a.actor_id} ({a.actor_id}{a.actor_position ? ` · ${posLabel(a.actor_position)}` : ''})
                </option>
              ))}
            </SearchSelect>
            <SearchSelect value={filters.action} onChange={(e) => patch({ action: e.target.value })} aria-label="การกระทำ">
              <option value="">ทุกการกระทำ</option>
              {(meta?.actions ?? []).map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
            </SearchSelect>
            <SearchSelect value={filters.ok} onChange={(e) => patch({ ok: e.target.value })} aria-label="ผลลัพธ์">
              <option value="">ทุกผลลัพธ์</option>
              <option value="1">สำเร็จ</option>
              <option value="0">ไม่สำเร็จ / ถูกปฏิเสธ</option>
            </SearchSelect>
          </>)}
          filtered={filtered}
          onClear={() => patch(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}
          action={(
            <button type="button" className="btn toolbar-action" onClick={exportCsv} disabled={exporting || loading}>
              {exporting ? 'กำลังส่งออก…' : 'ส่งออก CSV'}
            </button>
          )}
        />

        {meta && (
          <p className="muted audit-meta">
            เก็บไว้อย่างน้อย 1 ปี (ลบอัตโนมัติเมื่อเกิน {meta.retention_days} วัน · แก้หรือลบย้อนหลังไม่ได้)
            {' · '}มีทั้งหมด{meta.total_approx ? 'ประมาณ' : ''} {meta.total.toLocaleString('th-TH')} รายการ
            {meta.oldest && ` · เก่าสุด ${meta.oldest}`}
          </p>
        )}

        <ErrorBar message={error} onRetry={() => setReloadKey((k) => k + 1)} busy={loading} />

        <div className="table-wrap">
          <table className="table table-cards audit-table">
            <thead>
              <tr>
                <th>เวลา</th>
                <th>ผู้ทำ</th>
                <th>การกระทำ</th>
                <th>เป้าหมาย</th>
                <th>ผล</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.log_id}>
                  <tr
                    className={`row-clickable${open === r.log_id ? ' audit-open' : ''}`}
                    tabIndex={0}
                    aria-expanded={open === r.log_id}
                    onClick={() => toggle(r.log_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle(r.log_id);
                      }
                    }}
                  >
                    <td className="mono" data-label="เวลา">{r.at}</td>
                    <td data-label="ผู้ทำ">
                      {actorText(r)}
                      {r.actor_position && <span className="cell-sub">{posLabel(r.actor_position)} · {r.actor_id}</span>}
                    </td>
                    <td data-label="การกระทำ">
                      {r.label}
                      <span className="cell-sub"><span className={`badge ${LEVEL_CLASS[r.level] ?? ''}`}>{LEVEL_SHORT[r.level]}</span></span>
                    </td>
                    <td data-label="เป้าหมาย">
                      {targetText(r)}
                      {r.target_label && r.target_id && <span className="cell-sub mono">{r.target_id}</span>}
                    </td>
                    <td data-label="ผล">
                      <span className={`badge ${r.ok ? 'active' : 'suspended'}`}>{r.ok ? 'สำเร็จ' : 'ไม่สำเร็จ'}</span>
                    </td>
                    <td className="mono" data-label="IP">{r.ip ?? '—'}</td>
                  </tr>
                  {open === r.log_id && (
                    <tr className="audit-detail-row">
                      <td colSpan={6}><Detail r={r} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && rows.length === 0 && !error && (
          <p className="muted audit-empty">ไม่พบรายการในช่วง {from} ถึง {to}</p>
        )}
        <div className="load-more">
          {nextBefore ? (
            <button type="button" className="btn" onClick={loadMore} disabled={loadingMore || loading}>
              {loadingMore ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}
            </button>
          ) : rows.length > 0 ? (
            <span>แสดงครบ {rows.length.toLocaleString('th-TH')} รายการ</span>
          ) : null}
        </div>
      </div>
    </>
  );
}
