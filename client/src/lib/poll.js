import { useEffect } from 'react';

/**
 * ดึงข้อมูลซ้ำทุก ms มิลลิวินาที — แต่ "เฉพาะตอนที่หน้าแอปเปิดอยู่บนจอ" (optimize 6 พ.ย. 2569)
 *
 * เดิม setInterval ตรงๆ ยิงต่อไปเรื่อยๆ แม้แท็บถูกพับ/จอมือถือดับ — เปิดแชทญาติค้างไว้หนึ่งแท็บ = 240 คำขอต่อชั่วโมง
 * ทุกคำขอปลุก serverless function และทำให้ฐานข้อมูล Neon ไม่ได้พักเครื่อง (คิดค่า compute ตามเวลาที่ตื่น)
 *
 * แท็บซ่อน = ข้ามรอบนั้นไป · กลับมาเปิด = ดึงทันทีถ้าห่างจากครั้งล่าสุดเกิน ms (ไม่ต้องรอรอบถัดไป)
 * key = ค่าที่เปลี่ยนแล้วต้องดึงใหม่ทันทีและนับรอบใหม่ (เช่น path ของหน้า)
 */
export function useVisiblePoll(load, ms, key) {
  useEffect(() => {
    let last = 0;
    const run = () => {
      last = Date.now();
      load();
    };
    run();
    const timer = setInterval(() => {
      if (!document.hidden) run();
    }, ms);
    const onWake = () => {
      if (!document.hidden && Date.now() - last >= ms) run();
    };
    document.addEventListener('visibilitychange', onWake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [load, ms, key]);
}
