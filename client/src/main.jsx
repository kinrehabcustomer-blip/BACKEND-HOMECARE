import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ToastProvider } from './toast.jsx'
import { applyTheme, getTheme } from './lib/theme.js'

// ตั้งธีมก่อน render — กันหน้าจอกระพริบสีขาวก่อนสลับเป็นโหมดมืด
applyTheme(getTheme())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* ครอบไว้นอกสุด — toast ต้องขึ้นได้ทั้งจากหน้า login และหน้าหลังบ้าน */}
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
