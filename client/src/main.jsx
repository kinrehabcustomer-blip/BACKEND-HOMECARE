import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './warm-clarity.css' // ชั้นดีไซน์ Warm Clarity — ลบบรรทัดนี้ = กลับหน้าตาเดิม
// ดีไซน์ใหม่ v2 (23 พ.ย. 2569) แยกไฟล์ตามส่วน — ทับ warm-clarity ด้วยลำดับ · แตะหน้าตาอย่างเดียว
import './v2/shell.css'
import './v2/admin-ops.css'
import './v2/admin-data.css'
import './v2/field-partner.css'
import './v2/popups-case.css'
import './v2/popups-other.css'
import App from './App.jsx'
import { ToastProvider } from './toast.jsx'
import { ConfirmProvider } from './components/ConfirmDialog.jsx'
import { applyTheme, getTheme } from './lib/theme.js'
import { initPwa } from './lib/pwa.js'

// ตั้งธีมก่อน render — กันหน้าจอกระพริบสีขาวก่อนสลับเป็นโหมดมืด
applyTheme(getTheme())

// PWA: ลง service worker + เก็บจังหวะ "ติดตั้งแอป" ไว้ให้ปุ่มในหน้าตั้งค่า
initPwa()

// เลื่อนหน้าอยู่ = ปิดไฮไลต์ตอนทาบเมาส์ (คลาส is-scrolling บน <html> · ดูท้าย warm-clarity.css)
// ไม่งั้นช่องที่เลื่อนผ่านใต้เมาส์จะกะพริบไฮไลต์ไล่กันไป · ไฮไลต์กลับมาเมื่อขยับเมาส์จริงเท่านั้น
// เบราว์เซอร์ยิง mousemove ปลอมที่ตำแหน่งเดิมระหว่าง/หลังเลื่อน จึงเทียบพิกัดก่อน
{
  const root = document.documentElement
  let lastX = -1, lastY = -1
  addEventListener('scroll', () => root.classList.add('is-scrolling'), { capture: true, passive: true })
  addEventListener('mousemove', (e) => {
    if (e.clientX === lastX && e.clientY === lastY) return
    lastX = e.clientX
    lastY = e.clientY
    root.classList.remove('is-scrolling')
  }, { passive: true })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* ครอบไว้นอกสุด — toast ต้องขึ้นได้ทั้งจากหน้า login และหน้าหลังบ้าน */}
    <ToastProvider>
      {/* กล่องยืนยันของระบบ (แทน window.confirm) — ใช้ผ่าน useConfirm() */}
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
)
