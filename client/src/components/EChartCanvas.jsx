import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

/*
 * ลงทะเบียนเฉพาะชนิดกราฟ/ส่วนประกอบที่ใช้จริง — import ทั้งก้อน ('echarts') กินพื้นที่ ~1MB
 * ระวัง: option ที่อ้างส่วนประกอบซึ่งไม่ได้ลงทะเบียนไว้ (เช่น pie, dataZoom, visualMap)
 * จะไม่ error — มันแค่ไม่วาดออกมาเฉยๆ ถ้าลอก option จาก ECharts Gallery มาแล้วจอว่าง ให้เช็คบรรทัดนี้ก่อน
 *
 * ไฟล์นี้ถูกแยกออกมาจาก EChart.jsx เพื่อให้ไลบรารีกราฟกลายเป็นไฟล์ก้อนของตัวเอง
 * ที่ดาวน์โหลดตอนจะวาดกราฟจริงเท่านั้น — ดู EChart.jsx ว่าทำไม
 */
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer]);

/**
 * ครอบ ECharts หนึ่ง instance ให้ใช้แบบ React ได้
 *
 * option ควรถูกห่อด้วย useMemo ที่ฝั่งผู้เรียก — object ใหม่ทุกรอบ render จะยิง setOption รัวโดยไม่จำเป็น
 */
export default function EChartCanvas({ option, height = 280, className = '', ariaLabel }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);

  // สร้าง/ทำลาย instance ครั้งเดียวตลอดอายุคอมโพเนนต์
  useEffect(() => {
    const chart = echarts.init(boxRef.current, null, { renderer: 'canvas' });
    chartRef.current = chart;

    // ECharts ไม่ resize ตามกล่องเอง — การ์ดในหน้านี้ยืดหดตามความกว้างจอ ต้องบอกมันทุกครั้ง
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(boxRef.current);

    return () => {
      observer.disconnect();
      chart.dispose(); // ไม่ dispose = canvas ค้างใน memory ทุกครั้งที่เปลี่ยนหน้า
      chartRef.current = null;
    };
  }, []);

  // notMerge: true — กัน series/แกนของ option เก่าค้างอยู่ตอนสลับช่วงเวลาแล้วจำนวนจุดเปลี่ยน
  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={boxRef}
      className={className}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}
