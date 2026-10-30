import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import EChart from './EChart.jsx';
import { useChartTokens } from '../lib/chartTheme.js';
import { POSITION_LABELS, SERVICE_KIND_LABELS, VISIT_STATE_LABELS } from '../labels.js';

/**
 * หน้าภาพรวมแบบการ์ด KPI + sparkline (ดร.ธงชัย 30 ต.ค. 2569 เลือกแนวนี้ เพราะข้อมูลจริงยังน้อย กราฟแท่งใหญ่จึงดูโล่ง)
 * ข้อมูลกะ/เคสรายเดือน/ภาระงาน มาจาก GET /api/cases/dashboard คำขอเดียว · สัดส่วนบริการมาจาก summary ของหน้า
 *
 * กติกาที่ใช้ทุกชิ้นในไฟล์นี้ (ตามแนวทาง dataviz):
 *   - สีมาจาก --viz-* ใน index.css ซึ่งผ่านตัวตรวจสีทั้งสองธีมแล้ว ห้ามหยิบสีอื่นมาเติมเอง
 *   - ตัวเลขเป็นพระเอก กราฟเล็กเป็นบริบท · ตัวหนังสือใช้สีหมึกของธีม ไม่ใช่สีของกราฟ
 *   - วงแหวนมีคำอธิบายพร้อมตัวเลขและ % เสมอ — สีไม่ใช่ทางเดียวที่บอกว่าชิ้นไหนคืออะไร
 *   - ชี้ได้ทุกชิ้น: sparkline มีจุดชี้รายวัน · วงแหวนมี tooltip ของ ECharts
 */

const num = (n) => n.toLocaleString('th-TH');
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const dayText = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
const monthText = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'short', year: '2-digit' });

// ---------------------------------------------------------------------------
// sparkline — SVG เล็กในการ์ด (ไม่ใช้ ECharts: เบากว่าและวาดทันทีพร้อมตัวเลข)

const SW = 160; // ความกว้างใน viewBox — ยืดเต็มการ์ดด้วย CSS
const SH = 40;

/**
 * kind 'line' = แนวโน้ม (ค่า null = วันที่ไม่มีข้อมูล เส้นขาดตรงนั้น ไม่ลากผ่านศูนย์ให้เข้าใจผิด)
 * kind 'bar'  = จำนวนต่อช่วง · ชี้ที่ช่องไหนเห็นค่าของช่องนั้น (ช่องชี้กว้างเท่าช่วง ใหญ่กว่าตัวแท่ง)
 */
function Spark({ points, kind = 'line', color, format, max: fixedMax }) {
  const n = points.length;
  const values = points.map((p) => p.value);
  const max = fixedMax ?? Math.max(1, ...values.filter((v) => v != null));
  const step = SW / n;
  const y = (v) => SH - 2 - (v / max) * (SH - 6);

  let marks;
  if (kind === 'bar') {
    const w = Math.max(2, Math.min(10, step - 3));
    marks = points.map((p, i) =>
      p.value > 0 ? (
        <rect key={i} x={i * step + (step - w) / 2} y={y(p.value)} width={w} height={SH - 2 - y(p.value)} rx="1.5" fill={color} />
      ) : (
        // ศูนย์ = ขีดจางบนฐาน ให้รู้ว่ามีวันนั้นแต่ไม่มีค่า (ไม่ใช่ข้อมูลหาย)
        <rect key={i} x={i * step + (step - w) / 2} y={SH - 3} width={w} height="1" fill="currentColor" opacity="0.25" />
      ),
    );
  } else {
    const segs = [];
    let cur = [];
    points.forEach((p, i) => {
      if (p.value == null) { if (cur.length) segs.push(cur); cur = []; return; }
      cur.push([i * step + step / 2, y(p.value)]);
    });
    if (cur.length) segs.push(cur);
    const lastIdx = values.findLastIndex((v) => v != null);
    marks = (
      <>
        {segs.map((s, i) =>
          s.length > 1 ? (
            <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} fill="none" stroke={color}
                      strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ) : (
            <circle key={i} cx={s[0][0]} cy={s[0][1]} r="2" fill={color} />
          ),
        )}
        {lastIdx >= 0 && <circle cx={lastIdx * step + step / 2} cy={y(values[lastIdx])} r="3" fill={color} />}
      </>
    );
  }

  return (
    <svg className="spark" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none" aria-hidden="true">
      {marks}
      {/* ช่องชี้รายช่วง — tooltip ของเบราว์เซอร์บอกวันและค่า */}
      {points.map((p, i) => (
        <rect key={`h${i}`} x={i * step} y="0" width={step} height={SH} fill="transparent">
          <title>{`${p.label}: ${p.value == null ? 'ไม่มีกะ' : format(p.value)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

function Kpi({ to, label, value, unit, sub, children }) {
  return (
    <Link className="kpi" to={to}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {children}
      <span className="kpi-sub">{sub}</span>
    </Link>
  );
}

/** แถวการ์ด KPI สี่ใบ — ตัวเลขเด่น + กราฟเล็กบอกทิศทาง */
export function KpiRow({ data }) {
  const tokens = useChartTokens();
  const { visits, today, monthly } = data;

  const past = visits.filter((d) => d.date <= today);
  const next = visits.filter((d) => d.date > today);
  const attendedOf = (d) => d.done + d.working + d.stale;
  const attended = past.reduce((n, d) => n + attendedOf(d), 0);
  const missed = past.reduce((n, d) => n + d.missed, 0);
  const due = attended + missed;
  const upcoming = next.reduce((n, d) => n + d.scheduled, 0);
  const busiest = next.reduce((best, d) => (d.scheduled > (best?.scheduled ?? 0) ? d : best), null);

  const monthTotal = (r) => r.homecare + r.physio;
  const thisMonth = monthly.at(-1);
  const lastMonth = monthly.at(-2);
  const diff = thisMonth && lastMonth ? monthTotal(thisMonth) - monthTotal(lastMonth) : 0;

  return (
    <div className="kpi-row">
      <Kpi
        to="/attendance"
        label="ไปตามนัด · 14 วัน"
        value={due ? pct(attended, due) : '—'}
        unit={due ? '%' : ''}
        sub={due ? `${num(attended)} จาก ${num(due)} กะที่ถึงวันแล้ว` : 'ยังไม่มีกะที่ถึงวัน'}
      >
        <Spark
          kind="line"
          color={tokens.brand}
          max={100}
          format={(v) => `${v}%`}
          points={past.map((d) => {
            const dayDue = attendedOf(d) + d.missed;
            return { label: dayText(d.date), value: dayDue ? pct(attendedOf(d), dayDue) : null };
          })}
        />
      </Kpi>

      <Kpi
        to="/attendance"
        label="ขาดงาน · 14 วัน"
        value={num(missed)}
        unit="กะ"
        sub={missed ? 'กะที่เลยวันแล้วไม่มีคนเช็คอิน' : 'ไม่มีกะขาดงาน'}
      >
        <Spark kind="bar" color={tokens.viz.missed} format={(v) => `${v} กะ`}
               points={past.map((d) => ({ label: dayText(d.date), value: d.missed }))} />
      </Kpi>

      <Kpi
        to="/calendar"
        label="นัดล่วงหน้า · 7 วัน"
        value={num(upcoming)}
        unit="กะ"
        sub={busiest ? `แน่นสุด ${dayText(busiest.date)} (${busiest.scheduled} กะ)` : 'ยังไม่มีนัดใน 7 วันข้างหน้า'}
      >
        <Spark kind="bar" color={tokens.viz.scheduled} format={(v) => `${v} กะ`}
               points={next.map((d) => ({ label: dayText(d.date), value: d.scheduled }))} />
      </Kpi>

      <Kpi
        to="/cases"
        label="เคสใหม่เดือนนี้"
        value={thisMonth ? num(monthTotal(thisMonth)) : '—'}
        unit="เคส"
        sub={
          !lastMonth ? '' : diff === 0
            ? `เท่ากับเดือนก่อน (${monthTotal(lastMonth)})`
            : `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)} จากเดือนก่อน (${monthTotal(lastMonth)})`
        }
      >
        <Spark kind="bar" color={tokens.brand} format={(v) => `${v} เคส`}
               points={monthly.map((r) => ({ label: monthText(r.month), value: monthTotal(r) }))} />
      </Kpi>
    </div>
  );
}

// ---------------------------------------------------------------------------
// วงแหวน

/**
 * วงแหวนหนึ่งวง + คำอธิบายพร้อมตัวเลข/% — ตัวเลขรวมอยู่กลางวง
 * slices = [{ key, label, value, color }] ตามลำดับที่ตรวจสีไว้ (ชิ้นที่ติดกันในวงต้องแยกกันออก)
 */
function Donut({ slices, centerLabel, ariaLabel }) {
  const tokens = useChartTokens();
  const total = slices.reduce((n, s) => n + s.value, 0);

  const option = useMemo(() => ({
    tooltip: {
      trigger: 'item',
      backgroundColor: tokens.surface,
      borderColor: tokens.border,
      textStyle: { color: tokens.text, fontFamily: tokens.font, fontSize: 12 },
      formatter: (p) => `${p.name}<br/><strong>${num(p.value)}</strong> · ${pct(p.value, total)}%`,
    },
    title: {
      text: num(total),
      subtext: centerLabel,
      left: 'center',
      top: '34%',
      itemGap: 2,
      textStyle: { color: tokens.text, fontFamily: tokens.font, fontSize: 24, fontWeight: 700 },
      subtextStyle: { color: tokens.muted, fontFamily: tokens.font, fontSize: 11 },
    },
    series: [{
      type: 'pie',
      radius: ['64%', '84%'],
      avoidLabelOverlap: false,
      label: { show: false },
      labelLine: { show: false },
      // เส้นสีพื้นคั่นระหว่างชิ้น — ชิ้นที่ติดกันแยกออกจากกันชัด
      itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { scale: true, scaleSize: 4 },
      data: slices.filter((s) => s.value > 0).map((s) => ({ name: s.label, value: s.value, itemStyle: { color: s.color } })),
    }],
  }), [slices, total, centerLabel, tokens]);

  if (!total) return null;
  return (
    <div className="donut">
      <div className="donut-chart">
        <EChart option={option} height={168} ariaLabel={ariaLabel} />
      </div>
      <ul className="donut-legend">
        {slices.map((s) => (
          <li key={s.key}>
            <i className="viz-swatch" style={{ background: s.color }} aria-hidden="true" />
            <span>{s.label}</span>
            <strong>{num(s.value)}</strong>
            <span className="muted">{pct(s.value, total)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** สัดส่วนบริการ (Homecare / กายภาพ) — ตามช่วงปี/เดือนที่เลือกด้านบน เหมือนตัวเลขสรุป */
export function ServiceDonut({ byService, periodLabel }) {
  const tokens = useChartTokens();
  const count = (k) => byService.find((s) => s.service_kind === k)?.count ?? 0;
  const slices = useMemo(
    () => ['homecare', 'physio'].map((k) => ({ key: k, label: SERVICE_KIND_LABELS[k], value: count(k), color: tokens.viz[k] })),
    [byService, tokens], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return (
    <section className="card">
      <h2>สัดส่วนบริการ</h2>
      <p className="muted viz-note">{periodLabel}</p>
      {slices.some((s) => s.value) ? (
        <Donut
          slices={slices}
          centerLabel="เคส"
          ariaLabel={`สัดส่วนบริการ: ${slices.map((s) => `${s.label} ${s.value} เคส`).join(', ')}`}
        />
      ) : (
        <p className="muted">ยังไม่มีเคสในช่วงเวลานี้</p>
      )}
    </section>
  );
}

/** ลำดับชิ้นในวงสถานะกะ — ติดกันเป็นวง (สุดท้ายต่อกับแรก) ตรวจสีคู่ที่ติดกันรวมรอยต่อแล้ว ห้ามสลับ */
const SHIFT_RING = ['working', 'done', 'missed', 'stale'];

/** ผลของกะที่ถึงวันแล้วใน 14 วัน — เสร็จ/กำลังทำ/ค้างเช็คเอาท์/ขาดงาน */
export function ShiftDonut({ data }) {
  const tokens = useChartTokens();
  const slices = useMemo(() => {
    const past = data.visits.filter((d) => d.date <= data.today);
    return SHIFT_RING.map((s) => ({
      key: s, label: VISIT_STATE_LABELS[s], value: past.reduce((n, d) => n + d[s], 0), color: tokens.viz[s],
    }));
  }, [data, tokens]);
  return (
    <section className="card">
      <div className="card-head">
        <h2>ผลการเข้างาน</h2>
        <Link className="link" to="/attendance">ดูการมาทำงาน →</Link>
      </div>
      <p className="muted viz-note">กะที่ถึงวันแล้วใน 14 วันล่าสุด</p>
      {slices.some((s) => s.value) ? (
        <Donut
          slices={slices}
          centerLabel="กะ"
          ariaLabel={`ผลการเข้างาน 14 วัน: ${slices.map((s) => `${s.label} ${s.value} กะ`).join(', ')}`}
        />
      ) : (
        <p className="muted">ยังไม่มีกะที่ถึงวันใน 14 วันล่าสุด</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * ภาระงานพนักงาน — แถบเทียบในบรรทัด (HTML ล้วน) 8 คนที่ถือเคสมากสุด · คนละหนึ่งบรรทัด: ชื่อ | แถบ | เคส + กะ
 * แยกหลัก/ทีมอยู่ใน title ของแถว (ชี้ดูได้) — ตัวเลขที่ใช้ตัดสินใจ (เคส, กะ 7 วัน) อยู่บนจอเสมอ
 */
export function WorkloadList({ data }) {
  const rows = data.workload;
  const max = Math.max(1, ...rows.map((r) => r.cases));
  return (
    <section className="card">
      <h2>ภาระงานพนักงาน</h2>
      <p className="muted viz-note">เคสที่ยังให้บริการอยู่ต่อคน (ผู้รับผิดชอบหลัก + ทีม)</p>
      {rows.length === 0 ? (
        <p className="muted">ยังไม่มีพนักงานที่ถือเคสที่ยังให้บริการอยู่</p>
      ) : (
        <ul className="load-list">
          {rows.map((r) => {
            const team = r.cases - r.lead_cases;
            return (
              <li key={r.employee_id} title={`ผู้รับผิดชอบหลัก ${r.lead_cases} เคส${team ? ` · ทีม ${team} เคส` : ''}`}>
                <span className="load-name">
                  <strong>{r.nickname || r.first_name}</strong>
                  <span className="muted">{POSITION_LABELS[r.position] ?? r.position}</span>
                </span>
                <span className="load-track" aria-hidden="true">
                  <span className="load-fill" style={{ width: `${(r.cases / max) * 100}%` }} />
                </span>
                <span className="load-count">
                  <strong>{num(r.cases)} เคส</strong>
                  <span className="muted">กะ 7 วัน {r.upcoming_visits}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
