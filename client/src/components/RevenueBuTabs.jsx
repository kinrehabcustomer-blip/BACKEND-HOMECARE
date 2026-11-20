import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBaht, formatDate } from '../labels.js';
import EChart from './EChart.jsx';
import {
  BU_LABELS, BU_ORDER, MARGIN_DIMS, change, marginOf, monthLabel, pct, pctText, r2,
} from '../lib/revenueReport.js';

/**
 * แท็บของหน้ารายได้ตาม BU (pages/RevenueBuPage.jsx · server: invoices/buReport.js)
 * แบบ dashboard (ผู้ใช้ขอ 20 พ.ย. 2569 "เปลี่ยนจากตาราง ให้เป็น design dashboard") — ไม่มีตารางบนจอแล้ว
 * ตัวเลขละเอียดรายแถวอยู่ในไฟล์ CSV ของแต่ละแท็บ (lib/revenueReport.js) ครบเท่าเดิม
 *
 * กติกากราฟ (dataviz):
 *   สีประจำ BU ชุดเดิมที่ตรวจแล้วทั้งสองธีม — สีตาม BU เสมอ ไม่เปลี่ยนตามอันดับ
 *   อายุหนี้/อันดับลูกค้า = ลำดับขั้น → ไล่เฉดสีเดียว (--viz-age-* · --viz-seq-*) ไม่ใช้สีรุ้ง
 *   ต้นทุน = เทากลาง (--viz-cost) · กำไร = สี BU · ขาดทุน = สีแดงของระบบ + ป้าย "ขาดทุน"
 *   ทุกแถบมีตัวเลข/ป้ายกำกับเขียนไว้ข้าง ๆ และ title ตอนชี้ — สีไม่ใช่ตัวบอกความหมายอย่างเดียว
 *   แกนเดียวทุกกราฟ · ช่องว่าง 2px ระหว่างท่อนที่ต่อกัน
 */

/** เงินติดลบเขียน −฿1,450 · ว่าง = — */
export const money = (v) => (v == null ? '—' : Number(v) < 0 ? `−${formatBaht(r2(-Number(v)))}` : formatBaht(r2(v)));
/** เงินแบบย่อสำหรับป้ายในกราฟ ฿1.2M · ฿85k */
const short = (v) => {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toLocaleString('th-TH', { maximumFractionDigits: 1 })}M` : a >= 1e3 ? `${(a / 1e3).toLocaleString('th-TH', { maximumFractionDigits: 1 })}k` : `${r2(a)}`;
  return `${n < 0 ? '−' : ''}฿${s}`;
};
const BU_VAR = (k) => `var(--viz-${k})`;

/** เปลี่ยนแปลงจากฐาน — ลูกศร + ตัวเลข (ไม่พึ่งสีอย่างเดียว) */
export function Delta({ now, before, empty = '—', title }) {
  const v = change(now, before);
  if (v == null) return <span className="bu-delta">{before === 0 && now ? 'ใหม่' : empty}</span>;
  const dir = Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'up' : 'down';
  return (
    <span className={`bu-delta is-${dir}`} title={title ?? `ฐาน ${money(before)}`}>
      {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'} {pctText(Math.abs(v))}
    </span>
  );
}

/** "▲ 12% จากปีก่อน" · ฐานเป็นศูนย์ = "ปีก่อนไม่มีรายได้" */
function Versus({ now, before, what }) {
  if (!before) return <span className="muted">{now ? `${what}ไม่มีรายได้` : `${what} —`}</span>;
  return <><Delta now={now} before={before} /> จาก{what}</>;
}

const Swatch = ({ color }) => <span className="viz-swatch" style={{ background: color }} aria-hidden="true" />;

/** แถบสัดส่วน 0–100% (เกิน 100 ตัดที่ 100 — ตัวเลขข้างแถบบอกค่าจริง) */
function Bar({ value, color, tone }) {
  const w = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <span className={`rbu-bar${tone ? ` is-${tone}` : ''}`} aria-hidden="true">
      <span style={{ width: `${w}%`, background: color }} />
    </span>
  );
}

function Tile({ label, value, sub, swatch, total, children }) {
  return (
    <div className={`kpi bu-tile${total ? ' is-total' : ''}`}>
      <span className="kpi-label">{swatch && <Swatch color={swatch} />}{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
      {children}
    </div>
  );
}

/** ความคืบหน้าเทียบเป้า — แถบ + "78% ของเป้า ฿120,000" */
function TargetProgress({ now, target }) {
  if (target == null) return null;
  const p = pct(now, target);
  return (
    <span className="rbu-target">
      <Bar value={p} tone={p != null && p >= 100 ? 'good' : undefined} />
      <span className="rbu-target-text">{pctText(p, 0)} ของเป้า {money(target)}</span>
    </span>
  );
}

/** การ์ดหนึ่งช่องของ dashboard — หัว + คำอธิบายสั้น + เนื้อหา */
function Panel({ title, note, wide, children, actions }) {
  return (
    <section className={`card rbu-panel${wide ? ' is-wide' : ''}`}>
      <div className="rbu-panel-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
      {note && <p className="muted rbu-foot">{note}</p>}
    </section>
  );
}

/** คำอธิบายสี (แสดงเสมอเมื่อมี ≥ 2 สี) */
function Legend({ items }) {
  return (
    <ul className="rbu-legend">
      {items.map((i) => <li key={i.label}><Swatch color={i.color} />{i.label}{i.value != null && <strong>{i.value}</strong>}</li>)}
    </ul>
  );
}

/**
 * แถบนอนต่อท่อน — segments [{ value, color, label }] ยาวตามสัดส่วนของ max
 * target = เส้นขีดตั้ง (เป้า/ราคาตั้ง) ตำแหน่งเทียบ max เดียวกัน
 */
function HBar({ segments, max, target, tall, fmt = money }) {
  const sum = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const scale = max > 0 ? max : 1;
  return (
    <span className={`rbu-track${tall ? ' is-tall' : ''}`} aria-hidden="true">
      <span className="rbu-fill" style={{ width: `${Math.min(100, (sum / scale) * 100)}%` }}>
        {segments.filter((x) => x.value > 0).map((x) => (
          <span key={x.label} className={x.hatch ? 'is-hatch' : ''} style={{ flexGrow: x.value, background: x.color }} title={`${x.label} ${fmt(x.value)}`} />
        ))}
      </span>
      {target != null && target > 0 && <span className="rbu-tick" style={{ left: `${Math.min(100, (target / scale) * 100)}%` }} />}
    </span>
  );
}

/** รายการแถบ — ชื่อ | แถบ | ตัวเลข (มือถือ: ชื่อ + ตัวเลขบรรทัดบน แถบเต็มความกว้างใต้) */
function BarRow({ label, swatch, rank, sub, value, valueSub, children, title, tone }) {
  return (
    <li className={`rbu-row${tone ? ` is-${tone}` : ''}`} title={title}>
      <span className="rbu-row-label">
        {rank != null && <span className="rbu-rank">{rank}</span>}
        {swatch && <Swatch color={swatch} />}
        <span className="rbu-row-name">
          {label}
          {sub && <span className="rbu-sub muted">{sub}</span>}
        </span>
      </span>
      <span className="rbu-row-bar">{children}</span>
      <span className="rbu-row-value">
        {value}
        {valueSub && <span className="rbu-sub muted">{valueSub}</span>}
      </span>
    </li>
  );
}

/** แสดง N แรก + ปุ่มดูทั้งหมด */
function useTop(list, n = 8) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, n);
  const toggle = list.length > n && (
    <button type="button" className="btn tiny ghost rbu-more" onClick={() => setAll((v) => !v)}>
      {all ? 'แสดงน้อยลง' : `ดูทั้งหมด (${list.length.toLocaleString('th-TH')})`}
    </button>
  );
  return [shown, toggle];
}

const Empty = ({ text }) => <p className="muted rbu-empty">{text}</p>;

/**
 * วงแหวนเปอร์เซ็นต์ (SVG) — อัตราต่อเคส · อัตรากำไร · ทำได้เทียบเป้า ฯลฯ
 * เกิน 100% วาดเต็มวง (ตัวเลขกลางวงบอกค่าจริง) · ค่าว่าง = วงเปล่า + "—"
 */
function Ring({ value, color, label, sub, size = 104, stroke = 10, tone }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
  const mid = size / 2;
  return (
    <div className={`rbu-ring${tone ? ` is-${tone}` : ''}`}>
      <span className="rbu-ring-chart" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label ?? ''} ${pctText(value, 0)}`}>
          <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
          {v > 0 && (
            <circle cx={mid} cy={mid} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={`${(c * v) / 100} ${c}`} transform={`rotate(-90 ${mid} ${mid})`} />
          )}
        </svg>
        <strong className="rbu-ring-value">{pctText(value, 0)}</strong>
      </span>
      {label && <span className="rbu-ring-label">{label}</span>}
      {sub && <span className="muted rbu-ring-sub">{sub}</span>}
    </div>
  );
}

/**
 * โดนัทสัดส่วนเงิน — ยอดรวมอยู่กลางวง · คำอธิบายพร้อมยอดและ % อยู่ข้าง ๆ (แบบเดียวกับวงแหวนหน้าภาพรวม)
 * slices = [{ key, label, value, color }] — color ต้องเป็นค่าสีจริง (canvas อ่านตัวแปร CSS ไม่ได้)
 */
function MoneyDonut({ slices, tokens, centerLabel, ariaLabel, fmt = money }) {
  const live = slices.filter((x) => x.value > 0);
  const total = r2(live.reduce((n, x) => n + x.value, 0));
  const option = useMemo(() => ({
    tooltip: {
      trigger: 'item', confine: true,
      backgroundColor: tokens.surface, borderColor: tokens.border,
      textStyle: { color: tokens.text, fontFamily: tokens.font, fontSize: 12 },
      formatter: (p) => `${p.marker} ${p.name}<br/><strong>${fmt(p.value)}</strong> · ${pctText(pct(p.value, total))}`,
    },
    series: [{
      type: 'pie', radius: ['62%', '86%'], avoidLabelOverlap: false, label: { show: false }, labelLine: { show: false },
      itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 4 },
      emphasis: { scale: true, scaleSize: 4 },
      data: live.map((x) => ({ name: x.label, value: x.value, itemStyle: { color: x.color } })),
    }],
  }), [slices, tokens]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!total) return null;
  return (
    <div className="donut rbu-donut">
      <div className="donut-chart rbu-donut-chart">
        <EChart option={option} height={176} ariaLabel={ariaLabel} />
        <span className="rbu-donut-center" aria-hidden="true">
          <strong>{short(total)}</strong>
          <span>{centerLabel}</span>
        </span>
      </div>
      <ul className="donut-legend">
        {slices.map((x) => (
          <li key={x.key}>
            <i className="viz-swatch" style={{ background: x.color }} aria-hidden="true" />
            <span>{x.label}</span>
            <strong>{fmt(x.value)}</strong>
            <span className="muted">{pctText(pct(x.value, total))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- ECharts ร่วม ---------- */
function chartBase(tokens) {
  const text = { color: tokens.muted, fontFamily: tokens.font };
  return {
    legend: {
      top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, type: 'scroll',
      textStyle: { color: tokens.text, fontFamily: tokens.font },
    },
    tooltip: {
      trigger: 'axis', confine: true,
      axisPointer: { type: 'shadow', shadowStyle: { color: tokens.brandSoft, opacity: 0.5 } },
      backgroundColor: tokens.surface, borderColor: tokens.border, textStyle: { color: tokens.text, fontFamily: tokens.font },
    },
    valueAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { ...text, formatter: (v) => short(v) },
      splitLine: { lineStyle: { color: tokens.divider } },
    },
    catAxis: { type: 'category', axisLabel: { ...text, hideOverlap: true }, axisLine: { lineStyle: { color: tokens.border } }, axisTick: { show: false } },
  };
}
const tipLine = (marker, name, value) => `${marker} ${name} <strong style="float:right;margin-left:1rem">${money(value)}</strong>`;

/** กราฟแท่งนอนเป็นกลุ่ม — หมวดเป็นแถว (BU) · series แต่ละตัว [{ name, color, data }] */
function hGroupOption(tokens, cats, series) {
  const b = chartBase(tokens);
  return {
    grid: { left: 4, right: 20, top: 34, bottom: 4, containLabel: true },
    legend: b.legend,
    tooltip: { ...b.tooltip, formatter: (ps) => `${ps[0].axisValue}<br/>${ps.map((p) => tipLine(p.marker, p.seriesName, p.value)).join('<br/>')}` },
    xAxis: b.valueAxis,
    yAxis: { ...b.catAxis, inverse: true, data: cats, axisLabel: { color: tokens.text, fontFamily: tokens.font } },
    series: series.map((s) => ({
      type: 'bar', name: s.name, data: s.data, barMaxWidth: 12, barGap: '25%',
      itemStyle: { color: s.color, borderRadius: [0, 4, 4, 0] },
    })),
  };
}

/* ===================================== ภาพรวม ===================================== */

export function OverviewTab({ d, tokens }) {
  const bus = BU_ORDER.filter((k) => k !== 'other' || d.current.other || d.previous_totals.other || d.last_year_totals.other);
  const sum = (o) => r2(bus.reduce((s, k) => s + Number(o[k] ?? 0), 0));
  const total = sum(d.current);
  const prev = sum(d.previous_totals);
  const ly = sum(d.last_year_totals);
  const targeted = bus.filter((k) => d.targets[k] != null);
  const targetTotal = targeted.length ? r2(targeted.reduce((s, k) => s + Number(d.targets[k]), 0)) : null;

  const trend = useMemo(() => {
    const b = chartBase(tokens);
    const tBus = BU_ORDER.filter((k) => d.trend.some((t) => t.values[k]));
    const withTarget = d.trend.some((t) => t.target_total != null);
    return {
      grid: { left: 4, right: 12, top: 40, bottom: 4, containLabel: true },
      legend: b.legend,
      tooltip: {
        ...b.tooltip,
        formatter: (points) => {
          const t = d.trend[points[0].dataIndex];
          const rows = points.filter((p) => p.seriesType === 'bar' && p.value).map((p) => tipLine(p.marker, p.seriesName, p.value));
          return `${monthLabel(t.month, true)}${t.partial ? ' (ถึงวันนี้)' : ''}<br/>${rows.join('<br/>') || 'ไม่มีเงินเข้า'}`
            + `<br/><strong>รวม</strong> <strong style="float:right">${money(t.total)}</strong>`
            + `<br/><span style="color:${tokens.muted}">ปีก่อน</span> <span style="float:right">${money(t.last_year_total)}</span>`
            + (t.target_total != null ? `<br/><span style="color:${tokens.muted}">เป้า</span> <span style="float:right">${money(t.target_total)}</span>` : '');
        },
      },
      xAxis: { ...b.catAxis, data: d.trend.map((t) => monthLabel(t.month)) },
      yAxis: b.valueAxis,
      series: [
        ...tBus.map((k) => ({
          name: BU_LABELS[k], type: 'bar', stack: 'bu', barMaxWidth: 28,
          data: d.trend.map((t) => t.values[k] || 0),
          itemStyle: { color: tokens.viz[k] ?? tokens.viz.other, borderColor: tokens.surface, borderWidth: 1 },
          emphasis: { focus: 'series' },
        })),
        {
          name: 'ปีก่อน', type: 'line', z: 5, data: d.trend.map((t) => t.last_year_total),
          symbol: 'circle', symbolSize: 8, lineStyle: { width: 2, color: tokens.muted }, itemStyle: { color: tokens.muted, borderColor: tokens.surface, borderWidth: 2 },
        },
        withTarget && {
          name: 'เป้า', type: 'line', z: 6, data: d.trend.map((t) => t.target_total),
          symbol: 'none', lineStyle: { width: 2, type: 'dashed', color: tokens.heading }, itemStyle: { color: tokens.heading },
        },
      ].filter(Boolean),
    };
  }, [d, tokens]);

  // BU ที่ไม่มีเงินเลยทั้งสามช่วงไม่ต้องกินแถวในกราฟ
  const cmpBus = bus.filter((k) => d.current[k] || d.previous_totals[k] || d.last_year_totals[k]);
  const compare = useMemo(() => hGroupOption(tokens, cmpBus.map((k) => BU_LABELS[k]), [
    { name: 'ช่วงนี้', color: tokens.viz.cat[0], data: cmpBus.map((k) => d.current[k]) },
    { name: 'ช่วงก่อนหน้า', color: tokens.viz.cat[3], data: cmpBus.map((k) => d.previous_totals[k]) },
    { name: 'ปีก่อน', color: tokens.viz.cat[6], data: cmpBus.map((k) => d.last_year_totals[k]) },
  ]), [d, tokens]); // eslint-disable-line react-hooks/exhaustive-deps

  const mix = bus.filter((k) => d.current[k] > 0);

  return (
    <>
      <div className="bu-tiles">
        <Tile total label="รายได้รวม" value={money(total)}
          sub={<><Versus now={total} before={prev} what="ช่วงก่อน" /> · <Versus now={total} before={ly} what="ปีก่อน" /></>}>
          <TargetProgress now={total} target={targetTotal} />
        </Tile>
        {bus.map((k) => (
          <Tile key={k} swatch={tokens.viz[k]} label={BU_LABELS[k]} value={money(d.current[k])}
            sub={<>{pctText(pct(d.current[k], total))} ของทั้งหมด · <Versus now={d.current[k]} before={d.last_year_totals[k]} what="ปีก่อน" /></>}>
            <TargetProgress now={d.current[k]} target={d.targets[k]} />
          </Tile>
        ))}
      </div>

      <div className="rbu-grid">
        <Panel wide title={`รายได้ 12 เดือนล่าสุด · เทียบปีก่อน${d.trend.some((t) => t.target_total != null) ? ' และเป้า' : ''}`}>
          <EChart option={trend} height={320}
            ariaLabel={`กราฟแท่งซ้อนรายได้รายเดือนแยก BU 12 เดือนจนถึง ${monthLabel(d.trend.at(-1).month, true)} พร้อมเส้นยอดปีก่อน`} />
        </Panel>

        <Panel title="สัดส่วนรายได้" note="เกณฑ์เงินสด: วันที่รับเงิน หักเงินคืน">
          {total <= 0 ? <Empty text="ไม่มีรายได้ในช่วงนี้" /> : (
            <MoneyDonut tokens={tokens} centerLabel="รายได้รวม" ariaLabel="วงแหวนสัดส่วนรายได้ตาม BU"
              slices={mix.map((k) => ({ key: k, label: BU_LABELS[k], value: d.current[k], color: tokens.viz[k] }))} />
          )}
        </Panel>

        <Panel title="ทำได้เทียบเป้า"
          note={targeted.length ? 'ตัวเลขใต้วง = ทำได้ / เป้าของช่วงนี้ (เป้ารายเดือนเฉลี่ยตามจำนวนวันที่ช่วงครอบ) · เกิน 100% = เต็มวง' : null}>
          {targeted.length === 0 ? (
            <Empty text="ยังไม่ได้ตั้งเป้า — Super Admin/ผู้จัดการตั้งได้ที่ ตั้งค่าระบบ › การเงิน › เป้ารายได้" />
          ) : (
            <div className="rbu-rings">
              <Ring value={pct(total, targetTotal)} color="var(--brand)" tone={pct(total, targetTotal) >= 100 ? 'good' : undefined}
                label="รวม" sub={`${short(total)} / ${short(targetTotal)}`} />
              {targeted.map((k) => {
                const p = pct(d.current[k], d.targets[k]);
                return (
                  <Ring key={k} value={p} color={BU_VAR(k)} tone={p >= 100 ? 'good' : undefined}
                    label={<><Swatch color={tokens.viz[k]} />{BU_LABELS[k]}</>} sub={`${short(d.current[k])} / ${short(d.targets[k])}`} />
                );
              })}
            </div>
          )}
        </Panel>

        <Panel wide title="เทียบช่วงก่อนหน้าและปีก่อน"
          note={`ช่วงก่อนหน้า ${formatDate(d.previous.from)} – ${formatDate(d.previous.to)} · ปีก่อน ${formatDate(d.last_year.from)} – ${formatDate(d.last_year.to)}`}>
          {cmpBus.length === 0 ? <Empty text="ไม่มีรายได้ทั้งสามช่วง" /> : <EChart option={compare} height={60 + cmpBus.length * 52} ariaLabel="กราฟแท่งนอนเทียบรายได้ช่วงนี้ ช่วงก่อนหน้า และปีก่อน ต่อ BU" />}
        </Panel>
      </div>
    </>
  );
}

/* ===================================== กำไร ===================================== */

export function MarginTab({ d, tokens, basis, setBasis, dim, setDim }) {
  const rows = useMemo(() => d[dim]
    .map((r) => ({ ...r, m: marginOf(r, basis) }))
    .filter((r) => r.m.revenue || r.m.cost)
    .sort((a, b) => b.m.revenue - a.m.revenue || b.m.cost - a.m.cost), [d, dim, basis]);
  const t = marginOf(d.totals, basis);
  const [shown, toggle] = useTop(rows, 10);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.m.revenue, r.m.cost)));
  const colorOf = (r) => (dim === 'bu' ? BU_VAR(r.key) : r.bu ? BU_VAR(r.bu) : 'var(--brand)');
  const label = MARGIN_DIMS.find((x) => x.key === dim).label;
  const buRows = d.bu.map((r) => ({ ...r, m: marginOf(r, basis) })).filter((r) => r.m.revenue || r.m.cost);

  return (
    <>
      <div className="rbu-controls">
        <div className="rbu-ctl">
          <span className="muted">แยกตาม</span>
          <div className="seg" role="group" aria-label="แยกตาม">
            {MARGIN_DIMS.map((x) => (
              <button key={x.key} type="button" className={dim === x.key ? 'on' : ''} aria-pressed={dim === x.key} onClick={() => setDim(x.key)}>{x.label}</button>
            ))}
          </div>
        </div>
        <div className="rbu-ctl">
          <span className="muted">รายได้</span>
          <div className="seg" role="group" aria-label="เกณฑ์รายได้">
            <button type="button" className={basis === 'recognized' ? 'on' : ''} aria-pressed={basis === 'recognized'} onClick={() => setBasis('recognized')}
              title="รายได้ตามบริการที่ส่งมอบในช่วง — จับคู่กับค่าจ้างที่จ่ายตามงานได้ตรงกว่า">ตามบริการ</button>
            <button type="button" className={basis === 'cash' ? 'on' : ''} aria-pressed={basis === 'cash'} onClick={() => setBasis('cash')}
              title="เงินที่รับเข้าในช่วง หักเงินคืน">เงินสด</button>
          </div>
        </div>
      </div>

      <div className="bu-tiles">
        <Tile total label={basis === 'cash' ? 'รายได้ (เงินสด)' : 'รายได้ (ตามบริการ)'} value={money(t.revenue)} />
        <Tile label="ต้นทุนค่าจ้าง" value={money(t.cost)} sub="ค่าจ้างที่ปล่อยจ่ายในช่วง" />
        <Tile label="กำไรขั้นต้น" value={money(t.profit)} sub={<>อัตรากำไร {pctText(t.margin)}</>}>
          <span className="rbu-target"><Bar value={t.margin} color="var(--brand)" /></span>
        </Tile>
      </div>

      <div className="rbu-grid">
        <Panel wide title={`รายได้ ต้นทุน และกำไรขั้นต้น ตาม${dim === 'bu' ? ' ' : ''}${label}`}
          actions={<Legend items={[{ label: 'ต้นทุนค่าจ้าง', color: 'var(--viz-cost)' }, { label: 'กำไรขั้นต้น (สีของ BU)', color: 'var(--viz-homecare)' }, { label: 'ต้นทุนเกินรายได้', color: 'var(--danger)' }]} />}
          note={<>ความยาวแถบ = รายได้ · ส่วนเทา = ต้นทุนค่าจ้างที่ปล่อยจ่ายในช่วง · ส่วนสี = กำไรขั้นต้น · อุปกรณ์และหัตถการไม่มีต้นทุนในระบบ
            {dim === 'staff' && ' · "พนักงานหลัก" = รายได้และค่าจ้างทั้งหมดของเคสที่คนนั้นเป็นพนักงานหลัก (ไม่ใช่เงินที่คนนั้นได้)'}</>}>
          {rows.length === 0 ? <Empty text="ไม่มีรายได้หรือค่าจ้างในช่วงนี้" /> : (
            <>
              <ul className="rbu-rows">
                {shown.map((r) => {
                  const cost = Math.min(r.m.cost, r.m.revenue);
                  const loss = r.m.profit < 0;
                  return (
                    <BarRow key={r.key} label={r.label} swatch={colorOf(r)}
                      sub={[r.code, dim !== 'bu' && r.bu ? BU_LABELS[r.bu] : null, r.case_count ? `${r.case_count} เคส` : null].filter(Boolean).join(' · ')}
                      value={<strong className={loss ? 'is-neg' : ''}>{money(r.m.profit)}</strong>}
                      valueSub={loss ? `ขาดทุน · รายได้ ${short(r.m.revenue)}` : `${pctText(r.m.margin)} · รายได้ ${short(r.m.revenue)}`}
                      title={`${r.label}: รายได้ ${money(r.m.revenue)} · ต้นทุน ${money(r.m.cost)} · กำไร ${money(r.m.profit)}`}>
                      <HBar max={max} segments={[
                        { value: cost, color: 'var(--viz-cost)', label: 'ต้นทุนค่าจ้าง' },
                        { value: Math.max(0, r.m.profit), color: colorOf(r), label: 'กำไรขั้นต้น' },
                        { value: loss ? r.m.cost - r.m.revenue : 0, color: 'var(--danger)', label: 'ต้นทุนเกินรายได้', hatch: true },
                      ]} />
                    </BarRow>
                  );
                })}
              </ul>
              {toggle}
            </>
          )}
        </Panel>

        <Panel title="รายได้แบ่งเป็นต้นทุนกับกำไร" note={t.profit < 0 ? 'ต้นทุนรวมเกินรายได้ในช่วงนี้' : null}>
          {t.revenue <= 0 ? <Empty text="ไม่มีรายได้ในช่วงนี้" /> : (
            <MoneyDonut tokens={tokens} centerLabel={basis === 'cash' ? 'รายได้ (เงินสด)' : 'รายได้ (ตามบริการ)'} ariaLabel="วงแหวนสัดส่วนต้นทุนค่าจ้างกับกำไรขั้นต้น"
              slices={[
                { key: 'cost', label: 'ต้นทุนค่าจ้าง', value: Math.min(t.cost, t.revenue), color: tokens.viz.cost },
                { key: 'profit', label: 'กำไรขั้นต้น', value: Math.max(0, t.profit), color: tokens.brand },
              ]} />
          )}
        </Panel>

        <Panel title="อัตรากำไรขั้นต้นต่อ BU" note="อุปกรณ์และหัตถการไม่มีต้นทุนในระบบ จึงเต็มวง">
          {buRows.length === 0 ? <Empty text="ไม่มีรายได้ในช่วงนี้" /> : (
            <div className="rbu-rings">
              {buRows.map((r) => (
                <Ring key={r.key} value={r.m.margin} color={BU_VAR(r.key)} tone={r.m.profit < 0 ? 'neg' : undefined}
                  label={<><Swatch color={tokens.viz[r.key]} />{r.label}</>} sub={`กำไร ${short(r.m.profit)}`} />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

/* ===================================== รับรู้รายได้ ===================================== */

export function RecognitionTab({ d, tokens }) {
  const sum = (f) => r2(d.by_bu.reduce((s, b) => s + b[f], 0));
  const rows = d.by_bu.filter((b) => b.cash || b.recognized || b.deferred || b.unpaid);
  const [cases, toggle] = useTop(d.cases, 10);
  const caseMax = Math.max(1, ...d.cases.map((c) => Math.abs(c.balance)));
  const balRows = rows.filter((b) => b.deferred || b.unpaid);
  const balMax = Math.max(1, ...balRows.map((b) => Math.max(b.deferred, b.unpaid)));

  const monthly = useMemo(() => {
    if (d.series.length < 2) return null;
    const b = chartBase(tokens);
    return {
      grid: { left: 4, right: 12, top: 40, bottom: 4, containLabel: true },
      legend: b.legend,
      tooltip: { ...b.tooltip, formatter: (ps) => `${monthLabel(d.series[ps[0].dataIndex].month, true)}<br/>${ps.map((p) => tipLine(p.marker, p.seriesName, p.value)).join('<br/>')}` },
      xAxis: { ...b.catAxis, data: d.series.map((s) => monthLabel(s.month)) },
      yAxis: b.valueAxis,
      series: [
        { name: 'รับรู้ตามบริการ', type: 'bar', barMaxWidth: 22, barGap: '15%', data: d.series.map((s) => s.recognized), itemStyle: { color: tokens.viz.cat[0], borderRadius: [4, 4, 0, 0] } },
        { name: 'เงินสด', type: 'bar', barMaxWidth: 22, data: d.series.map((s) => s.cash), itemStyle: { color: tokens.viz.cat[1], borderRadius: [4, 4, 0, 0] } },
      ],
    };
  }, [d, tokens]);
  const byBu = useMemo(() => hGroupOption(tokens, rows.map((b) => BU_LABELS[b.bu]), [
    { name: 'รับรู้ตามบริการ', color: tokens.viz.cat[0], data: rows.map((b) => b.recognized) },
    { name: 'เงินสด', color: tokens.viz.cat[1], data: rows.map((b) => b.cash) },
  ]), [d, tokens]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="bu-tiles">
        <Tile total label="รับรู้ในช่วง (ตามบริการ)" value={money(sum('recognized'))} sub={<>เงินสดเข้า {money(sum('cash'))}</>} />
        <Tile swatch="var(--viz-cat-1)" label="รับเงินล่วงหน้า" value={money(sum('deferred'))}
          sub={<>{sum('deferred_cases')} เคส · ยังไม่ได้ให้บริการ ณ {formatDate(d.to)}</>} />
        <Tile swatch="var(--viz-cat-2)" label="ให้บริการแล้ว ยังไม่ได้รับเงิน" value={money(sum('unpaid'))}
          sub={<>{sum('unpaid_cases')} เคส · ณ {formatDate(d.to)}</>} />
      </div>

      <div className="rbu-grid">
        {monthly && (
          <Panel wide title="รับรู้ตามบริการ เทียบเงินสด รายเดือน">
            <EChart option={monthly} height={280} ariaLabel="กราฟแท่งเทียบรายได้ที่รับรู้ตามบริการกับเงินสดรายเดือน" />
          </Panel>
        )}

        <Panel title="รายได้ที่รับรู้ ตาม BU">
          {sum('recognized') <= 0 ? <Empty text="ไม่มีรายได้ที่รับรู้ในช่วงนี้" /> : (
            <MoneyDonut tokens={tokens} centerLabel="รับรู้ในช่วง" ariaLabel="วงแหวนสัดส่วนรายได้ที่รับรู้ตาม BU"
              slices={rows.filter((b) => b.recognized > 0).map((b) => ({ key: b.bu, label: BU_LABELS[b.bu], value: b.recognized, color: tokens.viz[b.bu] }))} />
          )}
        </Panel>

        <Panel title="รับรู้ เทียบ เงินสด ต่อ BU"
          note="Homecare รับรู้ตามวันที่ให้บริการ · กายภาพตามครั้งที่เช็คอิน · อุปกรณ์ หัตถการ และเคสที่ไม่มีแพ็ก รับรู้วันที่ออกใบ">
          {rows.length === 0 ? <Empty text="ไม่มีความเคลื่อนไหวในช่วงนี้" /> : (
            <EChart option={byBu} height={60 + rows.length * 44} ariaLabel="กราฟแท่งนอนเทียบรายได้ที่รับรู้กับเงินสดต่อ BU" />
          )}
        </Panel>

        <Panel wide title={`ยอดคงค้าง ณ ${formatDate(d.to)}`}
          actions={<Legend items={[{ label: 'รับเงินล่วงหน้า', color: 'var(--viz-cat-1)' }, { label: 'ยังไม่ได้รับเงิน', color: 'var(--viz-cat-2)' }]} />}
          note="รับเงินล่วงหน้า = เงินที่รับแล้วแต่ยังไม่ได้ให้บริการ (หนี้สินต่อลูกค้า) · ยังไม่ได้รับเงิน = ให้บริการไปแล้วแต่เงินยังไม่เข้า">
          {balRows.length === 0 ? <Empty text="ไม่มียอดคงค้าง" /> : (
            <ul className="rbu-rows is-diverging">
              {balRows.map((b) => (
                <li key={b.bu} className="rbu-drow">
                  <span className="rbu-row-label"><Swatch color={tokens.viz[b.bu]} />{BU_LABELS[b.bu]}</span>
                  <span className="rbu-dbar">
                    <span className="rbu-dside is-left" title={`ยังไม่ได้รับเงิน ${money(b.unpaid)} (${b.unpaid_cases} เคส)`}>
                      {b.unpaid > 0 && <span style={{ width: `${(b.unpaid / balMax) * 100}%`, background: 'var(--viz-cat-2)' }} />}
                    </span>
                    <span className="rbu-dside is-right" title={`รับเงินล่วงหน้า ${money(b.deferred)} (${b.deferred_cases} เคส)`}>
                      {b.deferred > 0 && <span style={{ width: `${(b.deferred / balMax) * 100}%`, background: 'var(--viz-cat-1)' }} />}
                    </span>
                  </span>
                  <span className="rbu-dvals">
                    <span>{b.unpaid ? <>{short(b.unpaid)} <span className="muted">· {b.unpaid_cases} เคส</span></> : <span className="muted">—</span>}</span>
                    <span>{b.deferred ? <>{short(b.deferred)} <span className="muted">· {b.deferred_cases} เคส</span></> : <span className="muted">—</span>}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel wide title={`เคสแพ็กที่ยอดคงค้างมากสุด · ${d.cases.length.toLocaleString('th-TH')} เคส`}
          actions={<Legend items={[{ label: 'รับเงินล่วงหน้า', color: 'var(--viz-cat-1)' }, { label: 'ยังไม่ได้รับเงิน', color: 'var(--viz-cat-2)' }]} />}
          note="แถบบาง = หน่วยที่ใช้ไปแล้วจากทั้งแพ็ก (รวมที่ใช้ก่อนเข้าระบบ)">
          {d.cases.length === 0 ? <Empty text="ไม่มีเคสแพ็กที่มีความเคลื่อนไหวหรือยอดค้าง" /> : (
            <>
              <ul className="rbu-rows">
                {cases.map((c) => (
                  <BarRow key={c.case_id} label={c.client_name} swatch={tokens.viz[c.bu]}
                    sub={`${c.case_id} · ${c.package}`}
                    value={<strong className={c.balance < 0 ? 'is-neg' : ''}>{money(Math.abs(c.balance))}</strong>}
                    valueSub={c.balance > 0 ? 'รับล่วงหน้า' : c.balance < 0 ? 'ยังไม่ได้รับเงิน' : 'ตรงกัน'}
                    title={`รับเงินแล้ว ${money(c.paid_to_date)} · รับรู้แล้ว ${money(c.recognized_to_date)} · ราคา/หน่วย ${money(c.unit_price)}`}>
                    <HBar max={caseMax} segments={[{ value: Math.abs(c.balance), color: c.balance >= 0 ? 'var(--viz-cat-1)' : 'var(--viz-cat-2)', label: 'คงค้าง' }]} />
                    <span className="rbu-units">
                      <Bar value={pct(c.units_done, c.units)} color="var(--muted)" />
                      <span className="muted">ใช้ {c.units_done}/{c.units}{c.units_in_period ? ` · ในช่วง ${c.units_in_period}` : ''}</span>
                    </span>
                  </BarRow>
                ))}
              </ul>
              {toggle}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

/* ===================================== ลูกหนี้ ===================================== */

const AGE_VAR = { current: 'var(--viz-age-1)', d1_30: 'var(--viz-age-2)', d31_60: 'var(--viz-age-3)', d61_90: 'var(--viz-age-4)', d90: 'var(--viz-age-5)' };

export function ReceivablesTab({ d, tokens }) {
  const rows = d.by_bu.filter((b) => b.total).sort((a, b) => b.total - a.total);
  const col = (k) => r2(d.by_bu.reduce((s, b) => s + b[k], 0));
  const total = col('total');
  const overdue = r2(total - col('current'));
  const label = Object.fromEntries(d.aging.map((a) => [a.key, a.label]));
  const max = Math.max(1, ...rows.map((b) => b.total));
  const [list, toggle] = useTop(d.invoices, 10);
  const legend = d.aging.map((a) => ({ label: a.label, color: AGE_VAR[a.key] }));

  return (
    <>
      <p className="muted rbu-note">ณ วันนี้ ({formatDate(d.today)}) — แท็บนี้ไม่ขึ้นกับช่วงเวลาที่เลือก</p>
      <div className="bu-tiles">
        <Tile total label="ค้างชำระทั้งหมด" value={money(total)} sub={<>{d.invoices.length.toLocaleString('th-TH')} ใบ</>} />
        <Tile label="เกินกำหนด" value={money(overdue)} sub={<>{pctText(pct(overdue, total))} ของยอดค้าง</>} />
        <Tile swatch="var(--viz-age-5)" label="เกิน 90 วัน" value={money(col('d90'))} sub={<>{pctText(pct(col('d90'), total))} ของยอดค้าง</>} />
      </div>

      <div className="rbu-grid">
        <Panel title="อายุหนี้รวม" note="สีอ่อนไปเข้ม = ค้างนานขึ้น">
          {total <= 0 ? <Empty text="ไม่มียอดค้างชำระ" /> : (
            <MoneyDonut tokens={tokens} centerLabel="ค้างชำระ" ariaLabel="วงแหวนยอดค้างชำระแยกตามอายุหนี้"
              slices={d.aging.map((a, i) => ({ key: a.key, label: a.label, value: col(a.key), color: tokens.viz.age[i] }))} />
          )}
        </Panel>

        <Panel title="อายุหนี้ตาม BU" actions={<Legend items={legend} />} note="ยอดค้างของแต่ละใบแบ่ง BU ตามสัดส่วนในใบ · ไม่มีวันครบกำหนด = ครบกำหนดวันออกใบ">
          {rows.length === 0 ? <Empty text="ไม่มียอดค้างชำระ" /> : (
            <ul className="rbu-rows">
              {rows.map((b) => (
                <BarRow key={b.bu} label={BU_LABELS[b.bu]} swatch={tokens.viz[b.bu]}
                  value={<strong>{short(b.total)}</strong>}
                  valueSub={b.d90 ? <span className="is-neg">เกิน 90 วัน {short(b.d90)}</span> : null}
                  title={d.aging.map((a) => `${a.label} ${money(b[a.key])}`).join(' · ')}>
                  <HBar max={max} segments={d.aging.map((a) => ({ value: b[a.key], color: AGE_VAR[a.key], label: a.label }))} />
                </BarRow>
              ))}
            </ul>
          )}
        </Panel>

        <Panel wide title="ใบค้างนานสุด">
          {d.invoices.length === 0 ? <Empty text="ไม่มีใบค้างชำระ" /> : (
            <>
              <ul className="rbu-inv">
                {list.map((i) => (
                  <li key={i.invoice_id}>
                    <span className="rbu-inv-age" style={{ background: AGE_VAR[i.bucket] }} title={label[i.bucket]}>
                      {i.days_overdue ? <><strong>{i.days_overdue}</strong><span>วัน</span></> : <span>ยังไม่<br />ถึง</span>}
                    </span>
                    <span className="rbu-inv-main">
                      <span className="rbu-inv-name">{i.customer}</span>
                      <span className="muted rbu-sub">
                        <Link className="link mono" to={`/invoices?open=${encodeURIComponent(i.invoice_id)}`}>{i.invoice_id}</Link>
                        {' · '}ครบกำหนด {formatDate(i.due_date ?? i.issue_date)}
                      </span>
                      <HBar max={i.balance} segments={BU_ORDER.filter((k) => i.parts[k]).map((k) => ({ value: i.parts[k], color: BU_VAR(k), label: BU_LABELS[k] }))} />
                    </span>
                    <strong className="rbu-inv-amt">{money(i.balance)}</strong>
                  </li>
                ))}
              </ul>
              {toggle}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

/* ===================================== ลูกค้า ===================================== */

const STARTED = [
  { key: 'started_new', label: 'ใหม่', color: 'var(--viz-seq-4)' },
  { key: 'started_renew', label: 'ต่อเคส', color: 'var(--viz-seq-3)' },
  { key: 'started_midway', label: 'กลางทาง', color: 'var(--viz-seq-2)' },
  { key: 'started_addon', label: 'แพ็กเสริม', color: 'var(--viz-seq-1)' },
];

export function CustomersTab({ d, tokens }) {
  const c = d.concentration;
  const reasonMax = Math.max(1, ...d.reasons.map((r) => r.count));
  const [reasons, toggleReasons] = useTop(d.reasons, 8);
  const topMax = Math.max(1, ...d.top.map((p) => p.amount));
  const tiers = [
    { label: 'อันดับ 1', value: c.top1, color: 'var(--viz-seq-4)' },
    { label: 'อันดับ 2–5', value: r2(c.top5 - c.top1), color: 'var(--viz-seq-3)' },
    { label: 'อันดับ 6–10', value: r2(c.top10 - c.top5), color: 'var(--viz-seq-2)' },
    { label: 'ที่เหลือ', value: r2(c.total - c.top10), color: 'var(--viz-seq-1)' },
  ];
  let running = 0;

  return (
    <>
      <div className="bu-tiles">
        <Tile total label="10 อันดับแรก" value={pctText(pct(c.top10, c.total))} sub={<>ของเงินเข้าสุทธิ {money(c.total)}</>} />
        <Tile label="ลูกค้าอันดับ 1" value={pctText(pct(c.top1, c.total))} sub={d.top[0]?.label ?? '—'} />
        <Tile label="ผู้ชำระในช่วง" value={`${c.payers.toLocaleString('th-TH')} ราย`} sub={<>5 อันดับแรก {pctText(pct(c.top5, c.total))}</>} />
      </div>

      <div className="rbu-grid">
        <Panel wide title="ต่อเคสและยกเลิก"
          note="อัตราต่อเคส = เคสที่ปิดจบในช่วงซึ่งมีรอบถัดไปแล้ว ÷ เคสที่ปิดจบ · อัตรายกเลิก = ยกเลิก ÷ (ปิดจบ + ยกเลิก) ในช่วง">
          <div className="rbu-cards is-two">
            {d.lifecycle.map((l) => {
              const renew = pct(l.renewed, l.closed);
              const cancel = pct(l.cancelled, l.closed + l.cancelled);
              return (
                <div key={l.bu} className="rbu-life">
                  <span className="rbu-stat-label"><Swatch color={tokens.viz[l.bu]} />{BU_LABELS[l.bu]}</span>
                  <div className="rbu-life-rates">
                    <Ring value={renew} color={BU_VAR(l.bu)} label="อัตราต่อเคส" sub={`${l.renewed} จาก ${l.closed} เคสที่ปิดจบ`} />
                    <Ring value={cancel} color="var(--danger)" tone={cancel >= 20 ? 'neg' : undefined} label="อัตรายกเลิก" sub={`ยกเลิก ${l.cancelled} เคส`} />
                  </div>
                  <div className="rbu-life-start">
                    <span className="muted">เปิดเคสในช่วง <strong>{l.started}</strong></span>
                    {l.started > 0 && (
                      <>
                        <HBar max={l.started} segments={STARTED.map((s) => ({ value: l[s.key], color: s.color, label: s.label }))} />
                        <Legend items={STARTED.filter((s) => l[s.key]).map((s) => ({ label: s.label, color: s.color, value: l[s.key] }))} />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="เหตุผลที่ยกเลิก"
          actions={<Legend items={[{ label: 'Homecare', color: BU_VAR('homecare') }, { label: 'กายภาพบำบัด', color: BU_VAR('physio') }]} />}>
          {d.reasons.length === 0 ? <Empty text="ไม่มีเคสยกเลิกในช่วงนี้" /> : (
            <>
              <ul className="rbu-rows">
                {reasons.map((r) => (
                  <BarRow key={r.reason} label={r.reason} value={<><strong>{r.count}</strong> <span className="muted">เคส</span></>}
                    title={`Homecare ${r.homecare} · กายภาพ ${r.physio}`}>
                    <HBar max={reasonMax} segments={[
                      { value: r.homecare, color: BU_VAR('homecare'), label: 'Homecare' },
                      { value: r.physio, color: BU_VAR('physio'), label: 'กายภาพบำบัด' },
                    ]} />
                  </BarRow>
                ))}
              </ul>
              {toggleReasons}
            </>
          )}
        </Panel>

        <Panel title="การกระจุกตัวของลูกค้า" note="ลูกค้า = ผู้ชำระในใบแจ้งหนี้ · ยอด = เงินเข้าหักเงินคืนในช่วง (นับเฉพาะผู้ชำระที่ยอดสุทธิเป็นบวก)">
          {c.total <= 0 ? <Empty text="ไม่มีเงินเข้าในช่วงนี้" /> : (
            <MoneyDonut tokens={tokens} centerLabel={`${c.payers.toLocaleString('th-TH')} ผู้ชำระ`} ariaLabel="วงแหวนสัดส่วนเงินเข้าตามอันดับลูกค้า"
              slices={tiers.map((t, i) => ({ key: t.label, label: t.label, value: t.value, color: tokens.viz.seq[3 - i] }))} />
          )}
        </Panel>

        <Panel wide title="ลูกค้า 10 อันดับแรก (ตามเงินเข้าสุทธิ)"
          actions={<Legend items={BU_ORDER.filter((k) => d.top.some((p) => p.by_bu[k] > 0)).map((k) => ({ label: BU_LABELS[k], color: BU_VAR(k) }))} />}>
          {d.top.length === 0 ? <Empty text="ไม่มีเงินเข้าในช่วงนี้" /> : (
            <ul className="rbu-rows">
              {d.top.map((p, i) => {
                running += p.amount;
                return (
                  <BarRow key={p.key} rank={i + 1} label={p.label}
                    value={<strong>{money(p.amount)}</strong>}
                    valueSub={`${pctText(pct(p.amount, c.total))} · สะสม ${pctText(pct(running, c.total), 0)}`}>
                    <HBar max={topMax} segments={BU_ORDER.filter((k) => p.by_bu[k] > 0).map((k) => ({ value: p.by_bu[k], color: BU_VAR(k), label: BU_LABELS[k] }))} />
                  </BarRow>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

/* ===================================== ส่วนลดและราคา ===================================== */

export function PricingTab({ d, tokens }) {
  const rows = d.by_bu.filter((b) => b.billed || b.received || b.refunds || b.discount || b.credit_discount);
  const [pkgs, toggle] = useTop(d.packages, 10);
  const discTotal = r2(rows.reduce((s, b) => s + b.discount + b.credit_discount, 0));
  const grossTotal = r2(rows.reduce((s, b) => s + b.billed + b.discount, 0));
  const refundTotal = r2(rows.reduce((s, b) => s + b.refunds, 0));
  const receivedTotal = r2(rows.reduce((s, b) => s + b.received, 0));
  const priced = d.packages.filter((p) => p.priced);
  const listSum = r2(priced.reduce((s, p) => s + p.list_total, 0));
  const actualSum = r2(priced.reduce((s, p) => s + p.actual_total, 0));

  return (
    <>
      <div className="bu-tiles">
        <Tile total label="ส่วนลดรวม" value={money(discTotal)} sub={<>{pctText(pct(discTotal, grossTotal))} ของยอดก่อนลด</>} />
        <Tile label="คืนเงินรวม" value={money(refundTotal)} sub={<>{pctText(pct(refundTotal, receivedTotal))} ของเงินที่รับ</>} />
        <Tile label="ได้ราคาจริง (แพ็ก)" value={pctText(pct(actualSum, listSum))} sub={priced.length ? <>ของราคาตั้ง · ลดไป {money(listSum - actualSum)}</> : 'ไม่มีเคสที่มีราคาตั้ง'}>
          {priced.length > 0 && <span className="rbu-target"><Bar value={pct(actualSum, listSum)} color="var(--brand)" /></span>}
        </Tile>
      </div>

      <div className="rbu-grid">
        <Panel wide title="ส่วนลดและเงินคืนตาม BU"
          note={'ใบที่ออกในช่วง · ส่วนลด = ส่วนลดหน้าใบ + ใบลดหนี้เหตุผล "ส่วนลด" เทียบยอดก่อนลด · ส่วนลดหน้าใบเป็นของค่าบริการ (อุปกรณ์/หัตถการคิดเต็มราคา)'}>
          {rows.length === 0 ? <Empty text="ไม่มีใบหรือเงินเข้าในช่วงนี้" /> : (
            <div className="rbu-cards">
              {rows.map((b) => {
                const disc = b.discount + b.credit_discount;
                const dr = pct(disc, b.billed + b.discount);
                const rr = pct(b.refunds, b.received);
                return (
                  <div key={b.bu} className="rbu-stat">
                    <span className="rbu-stat-label"><Swatch color={tokens.viz[b.bu]} />{BU_LABELS[b.bu]}</span>
                    <div className="rbu-pair">
                      <Ring size={84} stroke={8} value={dr} color={BU_VAR(b.bu)} label="ส่วนลด" sub={money(disc)} />
                      <Ring size={84} stroke={8} value={rr} color="var(--danger)" tone={b.refunds ? 'neg' : undefined} label="คืนเงิน" sub={money(b.refunds)} />
                    </div>
                    <span className="muted rbu-stat-sub">ออกใบ {short(b.billed)} · รับเงิน {short(b.received)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel wide title="ราคาขายจริงเทียบราคาตั้ง ต่อแพ็กเกจ"
          note="เคสที่เปิดในช่วง (ไม่นับยกเลิก) · เส้นขีดตั้ง = ราคาตั้ง 100% · แถบ = ราคาที่ขายได้จริงเป็น % ของราคาตั้ง">
          {d.packages.length === 0 ? <Empty text="ไม่มีเคสแพ็กที่เปิดในช่วงนี้" /> : (
            <>
              <ul className="rbu-rows">
                {pkgs.map((p) => {
                  const real = pct(p.actual_total, p.list_total);
                  return (
                    <BarRow key={p.key} label={p.label} swatch={tokens.viz[p.bu]}
                      sub={[p.code, `${p.cases} เคส${p.packs > p.cases ? ` (${p.packs} แพ็ก)` : ''}`].filter(Boolean).join(' · ')}
                      value={real == null ? <span className="muted">ไม่มีราคาตั้ง</span> : <strong>{pctText(real)}</strong>}
                      valueSub={p.priced ? `ลดเฉลี่ย ${short((p.list_total - p.actual_total) / p.priced)}/เคส` : null}
                      title={p.priced ? `ราคาตั้งรวม ${money(p.list_total)} · ขายจริงรวม ${money(p.actual_total)}` : undefined}>
                      {real != null && <HBar fmt={(v) => pctText(v)} max={Math.max(100, real)} target={100} segments={[{ value: real, color: BU_VAR(p.bu), label: 'ราคาจริง (%)' }]} />}
                    </BarRow>
                  );
                })}
              </ul>
              {toggle}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
