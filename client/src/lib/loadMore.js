import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * รายการยาวต่อเนื่องบนมือถือ — แทนแถบเลื่อนหน้า (ก่อนหน้า / หน้า 1/3 / ถัดไป / แสดง 20 ต่อหน้า) (ผู้ใช้ขอ 6 พ.ย. 2569)
 *
 * หน้ารายการยังโหลด "หน้า 1" เองเหมือนเดิม (ตัวกรอง/เรียง/ค้นหาไม่เปลี่ยน) แล้ว hook นี้โหลดหน้า 2, 3, … ต่อท้าย
 * ตอนเลื่อนใกล้ท้ายรายการ (ดู <LoadMore>) · ผลหน้า 1 เปลี่ยน (ตัวกรองเปลี่ยน / ดึงรีเฟรช) = เริ่มนับใหม่
 *
 * enabled   = เปิดเฉพาะมือถือ — จอกว้างคืน result.data ตรงๆ แถบเลื่อนหน้าเดิมยังทำงานตามปกติ
 * result    = ผลหน้า 1 จาก API ({ data, pagination: { total, total_pages } })
 * fetchPage = (n) => Promise ของผลหน้า n ด้วยเงื่อนไขเดียวกับหน้า 1
 * getKey    = กุญแจของแถว — กันแถวซ้ำเมื่อมีรายการใหม่แทรกเข้ามาระหว่างเลื่อน (ทุกอย่างเลื่อนลงหนึ่งช่อง)
 */
export function useLoadMore({ enabled, result, fetchPage, getKey }) {
  const [extra, setExtra] = useState([]);
  const [nextPage, setNextPage] = useState(2);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // ผลหน้า 1 ชุดไหนเป็นปัจจุบัน — คำขอหน้าถัดไปที่ตอบกลับมาหลังตัวกรองเปลี่ยนแล้ว ต้องทิ้ง ไม่ใช่ต่อท้ายรายการใหม่
  const current = useRef(result);
  const busy = useRef(false);
  useEffect(() => {
    current.current = result;
    busy.current = false;
    setExtra([]);
    setNextPage(2);
    setLoading(false);
    setError(null);
  }, [result]);

  const totalPages = result?.pagination?.total_pages ?? 1;
  const hasMore = Boolean(enabled && result && nextPage <= totalPages);

  const loadMore = useCallback(() => {
    if (!hasMore || busy.current) return;
    busy.current = true;
    const base = result;
    setLoading(true);
    setError(null);
    fetchPage(nextPage)
      .then((data) => {
        if (current.current !== base) return;
        setExtra((prev) => [...prev, ...(data?.data ?? [])]);
        setNextPage((n) => n + 1);
      })
      .catch((err) => current.current === base && setError(err.message))
      .finally(() => {
        if (current.current !== base) return;
        busy.current = false;
        setLoading(false);
      });
  }, [hasMore, result, nextPage, fetchPage]);

  const first = result?.data ?? [];
  let rows = first;
  if (enabled && extra.length) {
    const seen = new Set(first.map(getKey));
    rows = [...first];
    for (const r of extra) {
      const k = getKey(r);
      if (!seen.has(k)) { seen.add(k); rows.push(r); }
    }
  }

  return { rows, hasMore, loading, error, loadMore, total: result?.pagination?.total ?? first.length };
}
