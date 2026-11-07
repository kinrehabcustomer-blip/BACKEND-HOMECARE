import { useEffect, useRef } from 'react';

/**
 * ท้ายรายการยาวบนมือถือ (แทนแถบเลื่อนหน้า) — เลื่อนมาใกล้ (ล่วงหน้า 600px) แล้วโหลดชุดถัดไปเอง ไม่ต้องกดอะไร
 * แสดงสถานะ: กำลังโหลด… · โหลดไม่สำเร็จ + ปุ่มลองใหม่ · แสดงครบ N รายการ
 *
 * hasMore / loading / error / onMore มาจาก useLoadMore (หรือตัวนับแบบโหลดมาครบแล้วของหน้าการมาทำงาน)
 */
export default function LoadMore({ hasMore, loading, error, onMore, total, unit = 'รายการ' }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || loading || error) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onMore();
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, error, onMore]);

  return (
    <div className="load-more" ref={ref} aria-live="polite">
      {error ? (
        <>
          <span>โหลดรายการเพิ่มไม่สำเร็จ</span>
          <button type="button" className="btn" onClick={onMore}>ลองใหม่</button>
        </>
      ) : hasMore ? (
        <span className="load-more-busy"><i aria-hidden="true" />กำลังโหลด…</span>
      ) : total > 0 ? (
        <span>แสดงครบ {total.toLocaleString('th-TH')} {unit}</span>
      ) : null}
    </div>
  );
}
