import { useMemo } from 'react';
import EChart from './EChart.jsx';
import { useChartTokens } from '../lib/chartTheme.js';
import { CASE_TYPE_LABELS } from '../labels.js';

/* ความสูงต่อหนึ่งแท่ง (รวมช่องว่างระหว่างแท่ง) — คูณจำนวนประเภทที่มีจริง
   ไม่ตั้งความสูงตายตัว เพราะเดือนที่มี 2 ประเภทกับ 8 ประเภทต้องการที่ไม่เท่ากัน
   ตั้งตายตัวแล้วจะได้แท่งอ้วนเว่อร์ตอนมีน้อย และแท่งเบียดกันตอนมีเยอะ */
const ROW_H = 38;
const PAD_H = 16;

/**
 * เคสตามประเภท — กราฟแท่งแนวนอน
 *
 * แนวนอนไม่ใช่แนวตั้ง เพราะชื่อประเภทเป็นภาษาไทยยาว ("ดูแลผู้ป่วยติดเตียง", "เฝ้าไข้ที่โรงพยาบาล")
 * ถ้าวางเป็นแท่งตั้ง ป้ายใต้แกนจะต้องเอียงหรือโดนตัด ซึ่งอ่านยากกว่าตัวกราฟเสียอีก
 *
 * สีเดียวทุกแท่ง — งานของกราฟนี้คือ "เทียบว่าอันไหนมากกว่า" ไม่ใช่ "แยกว่าอันไหนเป็นอันไหน"
 * (ชื่อบนแกนบอกอยู่แล้ว) ให้สีต่างกันรายแท่งคือใส่สีโดยไม่มีความหมาย แล้วยังไปชนกับ
 * ชุดสีสถานะที่ระบบใช้สื่อความหมายจริงอีก
 */
export default function CaseTypeChart({ byType, total }) {
  const tokens = useChartTokens();

  const option = useMemo(() => {
    if (!byType?.length) return null;

    // มากไปน้อย แล้วให้แกนกลับด้าน — ECharts วางรายการแรกไว้ล่างสุด แต่คนอ่านไล่จากบนลงล่าง
    const rows = [...byType].sort((a, b) => b.count - a.count);
    const share = (n) => (total ? Math.round((n / total) * 100) : 0);

    return {
      // ขวาเผื่อที่ให้ตัวเลขที่ปลายแท่ง ไม่งั้นเลขโดนขอบกราฟตัด
      grid: { left: 0, right: 28, top: PAD_H / 2, bottom: PAD_H / 2, containLabel: true },

      tooltip: {
        trigger: 'item',
        backgroundColor: tokens.surface,
        borderColor: tokens.border,
        textStyle: { color: tokens.text, fontFamily: tokens.font },
        formatter: (p) => `${p.name}<br/><strong>${p.value}</strong> เคส · ${share(p.value)}% ของทั้งหมด`,
      },

      /* ซ่อนแกนค่า — ทุกแท่งมีตัวเลขกำกับที่ปลายอยู่แล้ว เส้นตารางกับป้ายแกนจึงเป็นหมึกซ้ำ
         (ถ้าติดป้ายไม่ครบทุกแท่งค่อยเปิดแกนคืน เพราะตอนนั้นแกนคือตัวบอกค่าที่เหลือ) */
      xAxis: { type: 'value', show: true, axisLabel: { show: false }, axisLine: { show: false },
               axisTick: { show: false }, splitLine: { show: false } },

      yAxis: {
        type: 'category',
        inverse: true,
        data: rows.map((r) => CASE_TYPE_LABELS[r.case_type] ?? r.case_type),
        axisLabel: { color: tokens.muted, fontFamily: tokens.font, fontSize: 13 },
        axisLine: { show: false },
        axisTick: { show: false },
      },

      series: [{
        type: 'bar',
        data: rows.map((r) => r.count),
        barMaxWidth: 20,          // ไม่ให้แท่งอ้วนเต็มช่อง เหลืออากาศไว้ให้แถวหายใจ
        itemStyle: {
          color: tokens.brand,
          borderRadius: [0, 4, 4, 0], // มนเฉพาะปลายด้านข้อมูล ฐานชิดแกนคงเป็นมุมฉาก
        },
        // ตัวเลขที่ปลายแท่ง — ใช้สีตัวหนังสือปกติ ไม่ใช่สีแท่ง (ตัวหนังสือไม่ใช่ข้อมูล)
        label: {
          show: true,
          position: 'right',
          color: tokens.text,
          fontFamily: tokens.font,
          fontWeight: 600,
          fontSize: 12,
        },
        emphasis: { itemStyle: { color: tokens.brand, opacity: 0.85 } },
      }],
    };
  }, [byType, total, tokens]);

  if (!option) return <p className="muted">ยังไม่มีเคสในช่วงเวลานี้</p>;

  const rows = [...byType].sort((a, b) => b.count - a.count);
  return (
    <EChart
      option={option}
      height={rows.length * ROW_H + PAD_H}
      /* คนที่ใช้โปรแกรมอ่านหน้าจอไม่เห็น canvas — สรุปตัวเลขทั้งชุดไว้ในป้ายกำกับแทน */
      ariaLabel={`เคสตามประเภท: ${rows.map((r) => `${CASE_TYPE_LABELS[r.case_type] ?? r.case_type} ${r.count} เคส`).join(', ')}`}
    />
  );
}
