import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { formatBaht, formatDate, todayTH } from '../labels.js';
import { useChartTokens } from '../lib/chartTheme.js';
import { downloadCsv } from '../lib/attendanceUi.js';
import { placeUnder } from '../lib/popover.js';
import EChart from '../components/EChart.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import LineIcon from '../components/LineIcon.jsx';

/**
 * รายได้ตาม BU (ผู้ใช้ขอ 19 พ.ย. 2569 — เมนูแยก + ส่งออกได้) · server: invoices/revenueBu.js · สิทธิ์ revenue
 *
 * เกณฑ์เงินสดแบบเดียวกับกราฟรายได้หน้าภาพรวม — เงินแต่ละงวดแบ่งเข้า BU ตามสัดส่วนของใบ · เงินคืนติดลบตามสัดส่วนเดียวกัน
 * รวมทุก BU = รายได้บริษัทของช่วงเดียวกันพอดี
 *
 * ด้านบน: ช่วงเวลา (ตัวเลือกด่วน / กำหนดเอง) + ความละเอียดกราฟ + ส่งออก
 * การ์ดตัวเลข: รวม + ราย BU (ยอด · สัดส่วน · เทียบช่วงก่อนหน้าที่ยาวเท่ากัน)
 * กราฟแท่งซ้อนตามช่วง · ตาราง BU (กดแถว = ดูรายการเงินเข้าของ BU นั้น)
 * ส่งออก CSV สองแบบ: สรุปตาม BU (+ ตารางรายช่วง) · รายการเงินเข้าแบ่ง BU (แถวละหนึ่ง BU ของหนึ่งงวด)
 *
 * สีของ BU ตรวจด้วยตัวตรวจชุดสี (dataviz) แล้วทั้งสองธีม — homecare/physio ใช้สีเดียวกับหน้าภาพรวม
 * สีสว่างบางตัวคอนทราสต์กับพื้นขาวไม่ถึง 3:1 จึงมีป้ายชื่อ + ตัวเลขกำกับทุกที่ (คำอธิบายกราฟ · การ์ด · ตาราง)
 */

const BU_COLOR = { homecare: 'homecare', physio: 'physio', procedure: 'procedure', rent: 'rent', sale: 'sale', other: 'other' };

const pad = (n) => String(n).padStart(2, '0');
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
const monthEnd = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};
const addMonths = (iso, n) => {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
};

/* ตัวเลือกช่วงด่วน — ความละเอียดกราฟที่เหมาะกับช่วงนั้นตั้งให้เอง (เปลี่ยนเองต่อได้) */
const PRESETS = [
  { key: 'this_month', label: 'เดือนนี้', group: 'day', range: (t) => [monthStart(t), t] },
  { key: 'last_month', label: 'เดือนก่อน', group: 'day', range: (t) => { const s = addMonths(t, -1); return [s, monthEnd(s)]; } },
  {
    key: 'quarter', label: 'ไตรมาสนี้', group: 'week',
    range: (t) => { const m = Number(t.slice(5, 7)); const q = Math.floor((m - 1) / 3) * 3 + 1; return [`${t.slice(0, 4)}-${pad(q)}-01`, t]; },
  },
  { key: 'year', label: 'ปีนี้', group: 'month', range: (t) => [`${t.slice(0, 4)}-01-01`, t] },
  { key: '12m', label: '12 เดือนล่าสุด', group: 'month', range: (t) => [addMonths(t, -11), t] },
];
const GROUPS = [
  { key: 'day', label: 'รายวัน', short: 'วัน' },
  { key: 'week', label: 'รายสัปดาห์', short: 'สัปดาห์' },
  { key: 'month', label: 'รายเดือน', short: 'เดือน' },
];

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysIn = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
const monthsIn = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
/** ช่วงที่เริ่มวันที่ 1 และจบสิ้นเดือน (หรือจบวันนี้ของเดือนนี้) — เลื่อนทีละเดือนได้ */
const monthAligned = (from, to, today) => from.endsWith('-01') && (to === monthEnd(to) || to === today);

/** ความละเอียดกราฟที่เหมาะกับความยาวช่วง — ตั้งให้เองเมื่อเปลี่ยนช่วง (เปลี่ยนเองต่อได้) */
const autoGroup = (from, to) => { const n = daysIn(from, to); return n <= 35 ? 'day' : n <= 120 ? 'week' : 'month'; };
/** ตัวเลือกที่ไม่เหมาะกับช่วงนี้ — รายวันเกิน 3 เดือน (แท่งเยอะจนอ่านไม่ได้) · รายเดือนในช่วงไม่ถึงเดือน (แท่งเดียว) */
function groupBlocked(key, from, to) {
  if (key === 'day' && daysIn(from, to) > 93) return 'ช่วงยาวเกิน 3 เดือน — ดูรายวันแล้วแท่งแน่นจนอ่านไม่ได้';
  if (key === 'month' && monthsIn(from, to) < 2) return 'ช่วงนี้อยู่ในเดือนเดียว — ดูรายเดือนได้แท่งเดียว';
  return null;
}

const MONTH_FMT = { month: 'long', year: 'numeric', timeZone: 'UTC' };
/** ชื่อช่วงที่คนอ่านเข้าใจ: ชื่อตัวเลือกด่วน → "พฤศจิกายน 2569" → "ปี 2569" → ไม่มี (โชว์แค่วันที่) */
function rangeName(from, to, today) {
  const p = PRESETS.find((x) => { const [f, t] = x.range(today); return f === from && t === to; });
  if (p) return p.label;
  if (from.endsWith('-01') && to === monthEnd(from)) return new Date(`${from}T00:00:00Z`).toLocaleDateString('th-TH', MONTH_FMT);
  if (from.endsWith('-01-01') && to.endsWith('-12-31') && from.slice(0, 4) === to.slice(0, 4)) return `ปี ${Number(from.slice(0, 4)) + 543}`;
  return null;
}
/** วันที่ของช่วงแบบสั้น: 1–19 พ.ย. 2569 · 1 ต.ค. – 19 พ.ย. 2569 · ข้ามปีเขียนเต็มทั้งสองฝั่ง */
function rangeDates(from, to) {
  const d = (iso, o) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('th-TH', { timeZone: 'UTC', ...o });
  if (from === to) return d(from, { day: 'numeric', month: 'short', year: 'numeric' });
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${d(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${d(from, { day: 'numeric', month: 'short' })} – ${d(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `${d(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${d(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

const shortDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function periodLabel(p, group, long = false) {
  if (group === 'month') {
    return new Date(`${p}-01T00:00:00Z`).toLocaleDateString('th-TH', { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
  }
  if (group === 'week') {
    const end = new Date(`${p}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    return `${shortDay(p)} – ${shortDay(end.toISOString().slice(0, 10))}`;
  }
  return long ? formatDate(p) : shortDay(p);
}

/** เปลี่ยนแปลงจากช่วงก่อน — บอกเป็นข้อความ + ลูกศร (ไม่พึ่งสีอย่างเดียว) */
function Delta({ now, before }) {
  if (!before) return <span className="bu-delta">{now ? 'ช่วงก่อนไม่มีรายได้' : '—'}</span>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const dir = Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down';
  const text = `${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'} ${Math.abs(pct).toLocaleString('th-TH', { maximumFractionDigits: 1 })}%`;
  return <span className={`bu-delta is-${dir}`} title={`ช่วงก่อนหน้า ${formatBaht(before)}`}>{text}</span>;
}

/** เงินติดลบ (เงินคืน) เขียนเป็น −฿1,450 ไม่ใช่ ฿-1,450 */
const money = (v) => (Number(v) < 0 ? `−${formatBaht(-Number(v))}` : formatBaht(v));
const pctOf = (v, total) => (total > 0 ? (v / total) * 100 : 0);
const pctText = (v, total) => `${pctOf(v, total).toLocaleString('th-TH', { maximumFractionDigits: 1 })}%`;
const num = (v) => Math.round(Number(v) * 100) / 100;

export default function RevenueBuPage() {
  const today = todayTH();
  // ช่วงที่ดูอยู่ — ตัวเลือกด่วน/ลูกศร/กำหนดเอง ตั้งค่าตัวนี้ตัวเดียว
  const [range, setRange] = useState({ from: monthStart(today), to: today });
  const [group, setGroup] = useState('day');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openBu, setOpenBu] = useState(null);
  const tokens = useChartTokens();

  const { from, to } = range;
  const rangeOk = from && to && from <= to;

  useEffect(() => {
    if (!rangeOk) return undefined;
    let cancelled = false;
    setError(null);
    api.revenueByBu({ from, to, group })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [from, to, group, rangeOk]);

  /** เปลี่ยนช่วง — ความละเอียดกราฟตั้งให้เหมาะกับช่วงใหม่เอง · ปิดรายการเจาะดูของช่วงเดิม */
  const applyRange = (f, t) => {
    setRange({ from: f, to: t });
    setGroup(autoGroup(f, t));
    setOpenBu(null);
  };
  /* ลูกศร ‹ › — ช่วงเดือน (1 ถึงสิ้นเดือน) เลื่อนทีละจำนวนเดือนเท่าเดิม · ช่วงอื่นเลื่อนทีละความยาวเท่าเดิม
     ไปข้างหน้าไม่เกินวันนี้ (ไม่มีเงินเข้าในอนาคต) */
  const step = (dir) => {
    if (monthAligned(from, to, today)) {
      const n = monthsIn(from, to);
      const f = addMonths(from, dir * n);
      const t = monthEnd(addMonths(f, n - 1));
      applyRange(f, t > today ? today : t);
    } else {
      const n = daysIn(from, to);
      const f = addDays(from, dir * n);
      const t = addDays(to, dir * n);
      applyRange(f, t > today ? today : t);
    }
  };
  const canNext = to < today;

  // BU ที่โชว์: ทุกตัวหลัก · "ไม่ระบุบริการ" โชว์เฉพาะเมื่อมีเงิน (ใบที่ไม่ผูกเคส — ปกติไม่มี)
  const bus = (data?.bus ?? []).filter((b) => b.key !== 'other' || data.totals.other || data.previous.totals.other);
  const color = (k) => tokens.viz[BU_COLOR[k]] ?? tokens.muted;

  const option = useMemo(() => {
    if (!data) return null;
    return {
      grid: { left: 4, right: 12, top: 40, bottom: 4, containLabel: true },
      legend: {
        top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10,
        textStyle: { color: tokens.text, fontFamily: tokens.font },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: tokens.brandSoft, opacity: 0.5 } },
        backgroundColor: tokens.surface,
        borderColor: tokens.border,
        textStyle: { color: tokens.text, fontFamily: tokens.font },
        formatter: (points) => {
          const s = data.series[points[0].dataIndex];
          const lines = points
            .filter((p) => p.value)
            .map((p) => `${p.marker} ${p.seriesName} <strong style="float:right;margin-left:1rem">${money(p.value)}</strong>`);
          return `${periodLabel(s.period, data.group, true)}<br/>${lines.join('<br/>') || 'ไม่มีเงินเข้า'}`
            + `<br/><span style="color:${tokens.muted}">รวม</span> <strong style="float:right">${money(s.total)}</strong>`;
        },
      },
      xAxis: {
        type: 'category',
        data: data.series.map((s) => periodLabel(s.period, data.group)),
        axisLabel: { color: tokens.muted, fontFamily: tokens.font, hideOverlap: true },
        axisLine: { lineStyle: { color: tokens.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        max: data.total === 0 ? 1000 : undefined,
        axisLabel: {
          color: tokens.muted, fontFamily: tokens.font,
          formatter: (v) => (Math.abs(v) >= 1000 ? `฿${(v / 1000).toLocaleString('th-TH', { maximumFractionDigits: 1 })}k` : `฿${v}`),
        },
        splitLine: { lineStyle: { color: tokens.divider } },
      },
      series: bus.map((b) => ({
        name: b.label,
        type: 'bar',
        stack: 'bu',
        barMaxWidth: 36,
        data: data.series.map((s) => s.values[b.key] || 0),
        // เส้นสีพื้นรอบแต่ละท่อน = ช่องว่างระหว่างท่อนที่ซ้อนกัน (แยก BU ติดกันได้แม้สีใกล้กัน)
        itemStyle: { color: color(b.key), borderColor: tokens.surface, borderWidth: 1 },
        emphasis: { focus: 'series' },
      })),
    };
  }, [data, tokens, bus.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* ไม่มีแถวหัวหน้าแล้ว (ผู้ใช้ขอ 19 พ.ย. 2569 "ขยับให้ชิดด้านบน") — ชื่อหน้าอยู่แถบบนอยู่แล้ว ปุ่มส่งออกย้ายไปท้ายแถวตัวกรอง */}
      <h1 className="sr-only">รายได้ตาม BU</h1>

      {/* ตัวกรอง (ออกแบบใหม่ 19 พ.ย. 2569 "ให้ใช้ง่ายกว่านี้")
          ช่วงเวลา = ปุ่มเดียวที่บอกว่ากำลังดูช่วงไหน (กดเลือกจากรายการ/กำหนดเอง) + ลูกศร ‹ › เลื่อนช่วงก่อน/ถัดไป
          แสดงเป็น = แยกเป็นอีกกลุ่มมีป้ายกำกับ ไม่ปนกับปุ่มช่วงเวลา · ตัวเลือกที่ไม่เหมาะกับช่วงถูกปิดพร้อมบอกเหตุผล */}
      <div className="bu-filters" role="toolbar" aria-label="ตัวกรองรายได้">
        <div className="bu-range-ctl">
          <button type="button" className="bu-step" onClick={() => step(-1)} aria-label="ช่วงก่อนหน้า" title="ช่วงก่อนหน้า">‹</button>
          <RangePicker from={from} to={to} today={today} onApply={applyRange} />
          <button type="button" className="bu-step" onClick={() => step(1)} disabled={!canNext} aria-label="ช่วงถัดไป" title="ช่วงถัดไป">›</button>
        </div>
        <div className="bu-show">
          <span className="muted">แสดงเป็น</span>
          <div className="seg" role="group" aria-label="ความละเอียดของกราฟ">
            {GROUPS.map((g) => {
              const blocked = groupBlocked(g.key, from, to);
              return (
                <button key={g.key} type="button" className={group === g.key ? 'on' : ''} aria-pressed={group === g.key}
                  disabled={Boolean(blocked)} title={blocked ?? g.label} onClick={() => setGroup(g.key)}>{g.short}</button>
              );
            })}
          </div>
        </div>
        <div className="bu-export-slot">
          <ExportMenu data={data} from={from} to={to} bus={bus} disabled={!data || !rangeOk} />
        </div>
      </div>

      {!rangeOk && <p className="error">วันเริ่มต้องไม่เกินวันสิ้นสุด</p>}
      <ErrorBar message={error} />
      {!data && !error && <p className="muted">กำลังโหลด…</p>}

      {data && (
        <>
          <p className="muted bu-range">เทียบกับช่วงก่อนหน้า {rangeDates(data.previous.from, data.previous.to)}</p>

          <div className="bu-tiles">
            <div className="kpi bu-tile is-total">
              <span className="kpi-label">รายได้รวม</span>
              <span className="kpi-value">{money(data.total)}</span>
              <span className="kpi-sub"><Delta now={data.total} before={data.previous.total} /> จากช่วงก่อน</span>
            </div>
            {bus.map((b) => (
              <button key={b.key} type="button" className={`kpi bu-tile${openBu === b.key ? ' is-on' : ''}`}
                onClick={() => setOpenBu(openBu === b.key ? null : b.key)} aria-pressed={openBu === b.key}>
                <span className="kpi-label"><span className="viz-swatch" style={{ background: color(b.key) }} />{b.label}</span>
                <span className="kpi-value">{money(data.totals[b.key])}</span>
                <span className="kpi-sub">{pctText(data.totals[b.key], data.total)} · <Delta now={data.totals[b.key]} before={data.previous.totals[b.key]} /></span>
              </button>
            ))}
          </div>

          <section className="card">
            <div className="card-head">
              <h2>รายได้แยก BU · {GROUPS.find((g) => g.key === data.group).label}</h2>
            </div>
            <EChart option={option} height={300}
              ariaLabel={`กราฟแท่งซ้อนรายได้ตาม BU ${formatDate(data.from)} ถึง ${formatDate(data.to)} รวม ${money(data.total)}`} />
          </section>

          <section className="card bu-table-card">
            <div className="card-head">
              <h2>สรุปตาม BU</h2>
              <span className="muted">กดแถวเพื่อดูรายการเงินเข้า</span>
            </div>
            <div className="table-wrap">
              <table className="bu-table">
                <thead>
                  <tr>
                    <th>BU</th>
                    <th className="num">รายได้</th>
                    <th className="num">สัดส่วน</th>
                    <th className="num">ช่วงก่อนหน้า</th>
                    <th className="num">เปลี่ยนแปลง</th>
                    <th className="num">ใบ</th>
                    <th className="num">เคส</th>
                  </tr>
                </thead>
                <tbody>
                  {bus.map((b) => (
                    <tr key={b.key} className={`is-click${openBu === b.key ? ' is-on' : ''}`} tabIndex={0}
                      onClick={() => setOpenBu(openBu === b.key ? null : b.key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenBu(openBu === b.key ? null : b.key); } }}>
                      <td><span className="bu-name"><span className="viz-swatch" style={{ background: color(b.key) }} />{b.label}</span></td>
                      <td className="num"><strong>{money(data.totals[b.key])}</strong></td>
                      <td className="num">
                        <span className="bu-share">
                          <span className="bu-share-bar"><span style={{ width: `${Math.max(0, pctOf(data.totals[b.key], data.total))}%`, background: color(b.key) }} /></span>
                          {pctText(data.totals[b.key], data.total)}
                        </span>
                      </td>
                      <td className="num muted">{money(data.previous.totals[b.key])}</td>
                      <td className="num"><Delta now={data.totals[b.key]} before={data.previous.totals[b.key]} /></td>
                      <td className="num">{data.invoices[b.key]}</td>
                      <td className="num">{data.cases[b.key]}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>รวม</td>
                    <td className="num"><strong>{money(data.total)}</strong></td>
                    <td className="num">100%</td>
                    <td className="num muted">{money(data.previous.total)}</td>
                    <td className="num"><Delta now={data.total} before={data.previous.total} /></td>
                    <td className="num" />
                    <td className="num" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {openBu && (
            <BuEntries key={`${openBu}-${from}-${to}`} bu={bus.find((b) => b.key === openBu)} from={from} to={to}
              swatch={color(openBu)} onClose={() => setOpenBu(null)} />
          )}
        </>
      )}
    </>
  );
}

/**
 * ปุ่มช่วงเวลา — บอกชื่อช่วง + วันที่ · กดแล้วกางรายการตัวเลือกด่วน (ติ๊กตัวที่ใช้อยู่) และช่องกำหนดเองท้ายรายการ
 * กำหนดเองต้องกด "ใช้ช่วงนี้" ก่อนถึงโหลดใหม่ — ไม่ยิงข้อมูลทุกครั้งที่เลื่อนปฏิทินไปมา
 */
function RangePicker({ from, to, today, onApply }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [draft, setDraft] = useState({ from, to });
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const name = rangeName(from, to, today);

  useEffect(() => {
    if (!open) return undefined;
    setDraft({ from, to });
    const r = btnRef.current.getBoundingClientRect();
    // กว้างพอดีรายการ + ช่องวันที่เต็มความกว้าง (19 พ.ย. 2569 "ปรับขนาดการ์ดให้พอดี")
    const width = Math.min(272, window.innerWidth - 24);
    setPos({ top: r.bottom + 6, left: Math.min(Math.max(12, r.left), window.innerWidth - width - 12), width });
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (f, t) => { onApply(f, t); setOpen(false); };
  const draftOk = draft.from && draft.to && draft.from <= draft.to && draft.to <= today;

  return (
    <>
      <button ref={btnRef} type="button" className="bu-range-btn" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <LineIcon name="calendar" />
        <span className="bu-range-text">
          {name && <strong>{name}</strong>}
          <span className={name ? 'muted' : ''}>{rangeDates(from, to)}</span>
        </span>
        <span className="bu-caret" aria-hidden="true">▾</span>
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} className="bu-range-pop" style={pos} role="dialog" aria-label="เลือกช่วงเวลา">
          <ul className="bu-range-list">
            {PRESETS.map((p) => {
              const [f, t] = p.range(today);
              const on = f === from && t === to;
              return (
                <li key={p.key}>
                  <button type="button" className={`bu-range-opt${on ? ' is-on' : ''}`} onClick={() => pick(f, t)}>
                    <span className="bu-check" aria-hidden="true">{on ? '✓' : ''}</span>
                    {/* ไม่มีวันที่ต่อท้าย (ผู้ใช้ขอ 19 พ.ย. 2569) — วันที่จริงขึ้นบนปุ่มหลังเลือกแล้ว */}
                    <span className="bu-opt-name">{p.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="bu-range-custom">
            <p className="field-label">กำหนดเอง</p>
            {/* สองแถว ตั้งแต่ / ถึง — ช่องวันที่เต็มความกว้าง ไม่ถูกตัดตัวเลข */}
            <div className="bu-range-inputs">
              <label>
                <span className="muted">ตั้งแต่</span>
                <input type="date" value={draft.from} max={draft.to || today}
                  onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
              </label>
              <label>
                <span className="muted">ถึง</span>
                <input type="date" value={draft.to} min={draft.from || undefined} max={today}
                  onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
              </label>
            </div>
            <button type="button" className="btn primary bu-range-apply" disabled={!draftOk} onClick={() => pick(draft.from, draft.to)}>
              ใช้ช่วงนี้
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** รายการเงินเข้า/คืนของ BU หนึ่ง — แสดงทีละ 50 */
function BuEntries({ bu, from, to, swatch, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [shown, setShown] = useState(50);
  useEffect(() => {
    let cancelled = false;
    api.revenueByBuRows({ from, to, bu: bu.key })
      .then((d) => !cancelled && setRows([...d.rows].reverse()))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [bu.key, from, to]);
  return (
    <section className="card">
      <div className="card-head">
        <h2><span className="bu-name"><span className="viz-swatch" style={{ background: swatch }} />รายการเงินเข้า · {bu.label}</span></h2>
        <button type="button" className="btn tiny" onClick={onClose}>ปิด</button>
      </div>
      <ErrorBar message={error} />
      {!rows && !error && <p className="muted">กำลังโหลด…</p>}
      {rows && rows.length === 0 && <p className="muted">ไม่มีเงินเข้าของ BU นี้ในช่วงที่เลือก</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="bu-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>รายการ</th>
                  <th>ใบแจ้งหนี้</th>
                  <th>ผู้ชำระ</th>
                  <th className="num">ยอดทั้งงวด</th>
                  <th className="num">ส่วนของ BU</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r) => (
                  <tr key={`${r.type}-${r.ref_id}`}>
                    <td className="nw">{formatDate(r.date)}</td>
                    <td>{r.type === 'refund' ? <span className="badge invoice-cancelled">คืนเงิน</span> : 'รับเงิน'}{r.method ? <span className="muted"> · {r.method}</span> : ''}</td>
                    <td className="mono nw">{r.invoice_id}</td>
                    <td>{r.bill_to_name}{r.case_id && <span className="muted mono"> · {r.case_id}</span>}</td>
                    <td className="num muted">{money(r.entry_amount)}</td>
                    <td className="num"><strong>{money(r.amount)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > shown && (
            <button type="button" className="btn bu-more" onClick={() => setShown((n) => n + 50)}>
              แสดงเพิ่ม ({rows.length - shown} รายการ)
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** ปุ่มส่งออก — CSV สองแบบ (เปิดใน Excel ได้ภาษาไทยครบ · มี BOM) */
function ExportMenu({ data, from, to, bus, disabled }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setPos(placeUnder(btnRef.current.getBoundingClientRect(), { maxWidth: 320 }));
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tag = `${from}_${to}`;
  const exportSummary = () => {
    const lines = bus.map((b) => [
      b.label, num(data.totals[b.key]), num(pctOf(data.totals[b.key], data.total)),
      num(data.previous.totals[b.key]),
      data.previous.totals[b.key] ? num(((data.totals[b.key] - data.previous.totals[b.key]) / Math.abs(data.previous.totals[b.key])) * 100) : '',
      data.invoices[b.key], data.cases[b.key],
    ]);
    lines.push(['รวม', num(data.total), 100, num(data.previous.total),
      data.previous.total ? num(((data.total - data.previous.total) / Math.abs(data.previous.total)) * 100) : '', '', '']);
    lines.push([]);
    lines.push([`ช่วง ${data.from} ถึง ${data.to} · เทียบกับ ${data.previous.from} ถึง ${data.previous.to} · เกณฑ์เงินสด (วันที่เงินเข้า หักเงินคืน)`]);
    lines.push([]);
    lines.push(['ช่วง', ...bus.map((b) => b.label), 'รวม']);
    for (const s of data.series) lines.push([periodLabel(s.period, data.group, true), ...bus.map((b) => num(s.values[b.key])), num(s.total)]);
    downloadCsv(`รายได้ตามBU_สรุป_${tag}.csv`,
      ['BU', 'รายได้ (บาท)', 'สัดส่วน (%)', 'ช่วงก่อนหน้า (บาท)', 'เปลี่ยนแปลง (%)', 'จำนวนใบ', 'จำนวนเคส'], lines);
    setOpen(false);
  };
  const exportRows = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { rows } = await api.revenueByBuRows({ from, to });
      const label = Object.fromEntries((data?.bus ?? []).map((b) => [b.key, b.label]));
      downloadCsv(`รายได้ตามBU_รายการ_${tag}.csv`,
        ['วันที่', 'รายการ', 'เลขที่ใบแจ้งหนี้', 'ผู้ชำระ', 'เลขเคส', 'ช่องทาง', 'ยอดทั้งงวด (บาท)', 'BU', 'ส่วนของ BU (บาท)'],
        rows.map((r) => [r.date, r.type === 'refund' ? 'คืนเงิน' : 'รับเงิน', r.invoice_id, r.bill_to_name, r.case_id ?? '',
          r.method ?? '', num(r.entry_amount), label[r.bu] ?? r.bu, num(r.amount)]));
      setOpen(false);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* ไอคอนไฟล์ CSV สีเขียว + "ดาวน์โหลด CSV" (ผู้ใช้ส่งแบบมา 20 พ.ย. 2569) */}
      <button ref={btnRef} type="button" className="btn" disabled={disabled} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <LineIcon name="csv" className="btn-ico csv-ico" />ดาวน์โหลด CSV
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} className="bu-export" style={pos} role="menu">
          <p className="muted bu-export-range">ช่วง {formatDate(from)} – {formatDate(to)}</p>
          <button type="button" role="menuitem" className="bu-export-item" onClick={exportSummary}>
            <strong>สรุปตาม BU (CSV)</strong>
            <span className="muted">ยอด · สัดส่วน · เทียบช่วงก่อน · ตารางรายช่วงตามกราฟ</span>
          </button>
          <button type="button" role="menuitem" className="bu-export-item" disabled={busy} onClick={exportRows}>
            <strong>{busy ? 'กำลังเตรียมไฟล์…' : 'รายการเงินเข้าแบ่ง BU (CSV)'}</strong>
            <span className="muted">ทุกงวดที่รับ/คืน แถวละหนึ่ง BU — ไว้กระทบยอดกับบัญชี</span>
          </button>
          {msg && <p className="error">{msg}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}
