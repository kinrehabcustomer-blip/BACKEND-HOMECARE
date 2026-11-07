import { useEffect, useState } from 'react';

/** จอมือถือ — ตรงกับ breakpoint 600px ของ CSS (การ์ดรายการ / แถบตัวกรองแบบมือถือ) */
export const MOBILE_QUERY = '(max-width: 600px)';

/** true เมื่อจอแคบระดับมือถือ — อัปเดตเองตอนหมุนจอ/ย่อหน้าต่าง */
export function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}
