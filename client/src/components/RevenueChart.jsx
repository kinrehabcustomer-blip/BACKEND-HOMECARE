import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatBaht } from '../labels.js';
import { useChartTokens } from '../lib/chartTheme.js';
import EChart from './EChart.jsx';

const BUCKETS = [
  { key: 'day', label: 'รายวัน', note: '30 วันล่าสุด' },
  { key: 'week', label: 'รายสัปดาห์', note: '12 สัปดาห์ล่าสุด' },
];

const dayText = (iso) =>
  new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });

/** ป้ายกำกับหนึ่งช่องบนแกน — สัปดาห์บอกเป็นช่วง 7 วันเต็ม ไม่ใช่แค่วันจันทร์ที่เป็นจุดเริ่ม */
function periodText(iso, bucket) {
  if (bucket === 'day') return new Date(iso).toLocaleDateString('th-TH', { dateStyle: 'medium' });

  const end = new Date(iso);
  end.setDate(end.getDate() + 6);
  return `${dayText(iso)} – ${end.toLocaleDateString('th-TH', { dateStyle: 'medium' })}`;
}

/** ตัวเลขบนแกน Y ย่อเป็นหลักพัน — ฿120,000 กินความกว้างจนบีบพื้นที่กราฟ */
const axisMoney = (value) =>
  value >= 1000
    ? `฿${(value / 1000).toLocaleString('th-TH', { maximumFractionDigits: 1 })}k`
    : `฿${value.toLocaleString('th-TH')}`;

export default function RevenueChart() {
  const [bucket, setBucket] = useState('day');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const tokens = useChartTokens();

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);

    api
      .invoiceRevenue({ bucket })
      // ผลของ bucket เก่าที่มาถึงทีหลังต้องทิ้ง ไม่งั้นกราฟเด้งกลับไปชุดข้อมูลที่ไม่ได้เลือกแล้ว
      .then((r) => !cancelled && setResult(r))
      .catch((err) => !cancelled && setError(err.message));

    return () => { cancelled = true; };
  }, [bucket]);

  const option = useMemo(() => {
    if (!result) return null;
    const { data } = result;

    return {
      grid: { left: 4, right: 16, top: 16, bottom: 4, containLabel: true },

      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: tokens.border } },
        backgroundColor: tokens.surface,
        borderColor: tokens.border,
        textStyle: { color: tokens.text, fontFamily: tokens.font },
        formatter: ([point]) => {
          const row = data[point.dataIndex];
          const bills = row.invoices === 0 ? 'ไม่มีใบที่ชำระ' : `${row.invoices} ใบ`;
          return `${periodText(row.period, bucket)}<br/><strong>${formatBaht(row.revenue)}</strong> · ${bills}`;
        },
      },

      xAxis: {
        type: 'category',
        data: data.map((r) => r.period),
        boundaryGap: false,
        axisLabel: {
          color: tokens.muted,
          fontFamily: tokens.font,
          hideOverlap: true,
          formatter: dayText,
        },
        axisLine: { lineStyle: { color: tokens.border } },
        axisTick: { show: false },
      },

      yAxis: {
        type: 'value',
        min: 0,
        axisLabel: { color: tokens.muted, fontFamily: tokens.font, formatter: axisMoney },
        // เส้นตารางแนวนอนอย่างเดียว จางๆ พอให้กวาดตาไปหาค่าได้ ไม่แย่งสายตาไปจากเส้นข้อมูล
        splitLine: { lineStyle: { color: tokens.divider } },
      },

      series: [{
        type: 'line',
        data: data.map((r) => r.revenue),
        // เส้นตรงระหว่างจุด ไม่ smooth — เส้นโค้งจะสร้างยอด/ท้องที่ไม่มีอยู่จริงระหว่างสองวัน
        smooth: false,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: data.length <= 40,
        lineStyle: { color: tokens.brand, width: 2 },
        itemStyle: { color: tokens.brand },
        areaStyle: { color: tokens.brandSoft },
        emphasis: { scale: 1.6 },
      }],
    };
  }, [result, bucket, tokens]);

  const current = BUCKETS.find((b) => b.key === bucket);

  return (
    <section className="card">
      <div className="card-head">
        <h2>รายได้ · {current.note}</h2>

        {/* ตัวสลับความละเอียดอยู่ในหัวการ์ด ติดกับสิ่งที่มันควบคุม */}
        <div className="seg" role="group" aria-label="ความละเอียดของกราฟรายได้">
          {BUCKETS.map((b) => (
            <button
              key={b.key}
              type="button"
              className={b.key === bucket ? 'on' : ''}
              aria-pressed={b.key === bucket}
              onClick={() => setBucket(b.key)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!error && !result && <p className="muted">กำลังโหลด…</p>}

      {result && (
        <>
          <p className="chart-total">
            <strong>{formatBaht(result.total)}</strong>
            <span className="muted">
              {result.invoices === 0
                ? ' — ยังไม่มีใบแจ้งหนี้ที่ชำระในช่วงนี้'
                : ` จาก ${result.invoices} ใบที่ชำระแล้ว`}
            </span>
          </p>
          <EChart
            option={option}
            height={260}
            ariaLabel={`กราฟรายได้${current.label} ${current.note} รวม ${formatBaht(result.total)}`}
          />
        </>
      )}
    </section>
  );
}
