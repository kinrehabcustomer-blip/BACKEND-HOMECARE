import { useCallback, useEffect, useRef, useState } from 'react';
import { usePullToRefresh } from '../lib/pullRefresh.js';
import LineIcon from './LineIcon.jsx';
import { timeText } from '../labels.js';

/* เว้นระยะขั้นต่ำระหว่างการโหลดอัตโนมัติ — สลับแอปกลับมาทีเดียวบางเบราว์เซอร์ยิงทั้ง
   visibilitychange และ focus ติดกัน ถ้าไม่กันไว้จะยิง API สองรอบทุกครั้งที่เปิดแอปขึ้นมา
   ไม่คุมการดึงที่ผู้ใช้ทำเอง — ดึงแล้วต้องโหลดจริงเสมอ ไม่งั้นเหมือนท่าไม่ทำงาน */
const AUTO_RELOAD_GAP_MS = 15_000;

/* เพดานรอ "โหลดเสร็จ" กรณีหน้าไม่ได้บอกสถานะมา — กันวงกลมหมุนค้างตลอดกาล
   ถ้าหน้าไหนส่ง busy มาให้ ตัวนี้แทบไม่ถูกใช้ */
const MAX_WAIT_MS = 8_000;

/**
 * ครอบเนื้อหาหน้าเพื่อให้ "ดึงลงเพื่อรีเฟรช" + "ดึงข้อมูลใหม่เองตอนกลับเข้าแอป" ทำงาน
 *
 * ทำเป็นของกลางเพราะทุกหน้าต้องการพฤติกรรมเดียวกันเป๊ะ — ถ้าก๊อปกลไกไปไว้ทีละหน้า
 * วันหนึ่งจะมีหน้าที่แก้บั๊กแล้วอีกสิบหน้าไม่ได้แก้ตาม
 *
 * onRefresh  สั่งให้หน้าโหลดข้อมูลใหม่ · คืน promise มาก็ได้ ไม่คืนก็ได้
 * busy       หน้ากำลังโหลดอยู่ไหม — ใช้ตัดสินว่าจะคาวงกลมหมุนไว้อีกนานแค่ไหน
 *            (หน้าที่คืน promise มาแล้วไม่ต้องส่งก็ได้ ตัว promise บอกเองว่าจบเมื่อไร)
 */
export default function PageRefresh({ onRefresh, busy = false, children }) {
  // ตัวปลุก promise ที่ค้างรอ busy กลับเป็น false
  const waiting = useRef(null);
  const lastAt = useRef(0);
  const latest = useRef(onRefresh);
  latest.current = onRefresh;

  /* busy เปลี่ยนจาก true เป็น false = โหลดเสร็จแล้ว ปลุกคนที่รออยู่
     ต้องรอ "ขาลง" เท่านั้น ไม่ใช่แค่เห็น false เฉยๆ เพราะตอนเพิ่งสั่งรีเฟรช
     หน้ายังไม่ทันตั้ง busy เป็น true ค่าที่อ่านได้ยังเป็น false อยู่ */
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) waiting.current?.();
    wasBusy.current = busy;
  }, [busy]);

  const run = useCallback(() => {
    lastAt.current = Date.now();
    const result = latest.current?.();
    // หน้าไหนคืน promise มา ใช้ของมันเลย ตรงและแม่นกว่าเดา
    if (result && typeof result.then === 'function') return result;

    // ไม่คืนมา (เช่นหน้าที่สั่งโหลดด้วยการเด้งตัวนับ) — รอจน busy ลงจาก true เป็น false แทน
    return new Promise((resolve) => {
      const done = () => {
        if (waiting.current !== done) return;
        waiting.current = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, MAX_WAIT_MS);
      waiting.current = done;
    });
  }, []);

  const { zoneRef, contentRef } = usePullToRefresh(run);

  useEffect(() => {
    /* กลับมาที่แอปแล้วดึงใหม่ให้เอง — จังหวะที่คนเปิดหน้าขึ้นมาดูคือจังหวะที่ต้องการข้อมูลล่าสุดพอดี
       ดักสองเหตุการณ์เพราะบนมือถือแต่ละเบราว์เซอร์ยิงไม่เหมือนกัน (บางตัวสลับแอปแล้วไม่ยิง
       visibilitychange เลย) มี AUTO_RELOAD_GAP_MS กันการยิงซ้ำอยู่แล้ว */
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastAt.current < AUTO_RELOAD_GAP_MS) return;
      run();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [run]);

  return (
    <div className="pull-zone" ref={zoneRef}>
      {/* วงกลมที่โผล่มาในช่องว่างซึ่งเนื้อหาเลื่อนลงไปเปิดให้ — จางอยู่นอกสายตาตอนไม่ได้ดึง
          aria-hidden เพราะเป็นภาพประกอบท่านิ้วล้วนๆ คนใช้โปรแกรมอ่านหน้าจอมีปุ่มรีเฟรชให้กด */}
      <div className="pull-hint" data-pull-hint aria-hidden="true">
        <LineIcon name="refresh" className="pull-hint-ico" />
      </div>

      <div className="pull-content" ref={contentRef}>
        {children}
      </div>
    </div>
  );
}

/**
 * ปุ่มรีเฟรช + เวลาที่ดึงข้อมูลมาล่าสุด — สำหรับเครื่องที่ใช้เมาส์ซึ่งดึงหน้าลงไม่ได้
 * CSS ซ่อนปุ่มบนเครื่องที่ใช้นิ้ว (ดู .pull-only-btn) เหลือไว้แค่เวลา
 */
export function RefreshButton({ onRefresh, busy = false, updatedAt = null }) {
  return (
    <span className="refresh-slot">
      {updatedAt && <span className="muted refresh-at">อัปเดต {timeText(updatedAt)}</span>}
      <button type="button" className="btn pull-only-btn" disabled={busy} onClick={onRefresh}>
        <LineIcon name="refresh" />{busy ? 'กำลังโหลด…' : 'รีเฟรช'}
      </button>
    </span>
  );
}

/** เวลาที่ดึงข้อมูลมาล่าสุด สำหรับหน้าที่อยากใส่ไว้ในบรรทัดสรุปของตัวเอง */
export function useUpdatedAt(busy) {
  const [at, setAt] = useState(null);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) setAt(new Date());
    wasBusy.current = busy;
  }, [busy]);
  return at;
}
