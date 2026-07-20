import { useState } from 'react';
import ChangePasswordForm from '../components/ChangePasswordForm.jsx';
import { getTheme, setTheme as persistTheme } from '../lib/theme.js';

export default function SettingsPage() {
  const [theme, setThemeState] = useState(getTheme);

  const changeTheme = (value) => {
    setThemeState(value);
    persistTheme(value); // เปลี่ยนทั้งระบบทันที + จำไว้ครั้งหน้า
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ตั้งค่า</h1>
          <p className="muted">ปรับแต่งการแสดงผลและความปลอดภัยของบัญชี</p>
        </div>
      </header>

      <section className="card">
        <h2>การแสดงผล</h2>
        <div className="setting-row">
          <div>
            <strong>โหมดกลางคืน</strong>
            <p className="muted">พื้นหลังเข้ม สบายตาเวลาใช้งานในที่แสงน้อย</p>
          </div>

          {/* สลับสว่าง/มืด — ปุ่มคู่ให้เห็นชัดว่าตอนนี้อยู่โหมดไหน */}
          <div className="theme-toggle">
            <button
              className={`btn ${theme === 'light' ? 'primary' : ''}`}
              onClick={() => changeTheme('light')}
            >
              ☀ สว่าง
            </button>
            <button
              className={`btn ${theme === 'dark' ? 'primary' : ''}`}
              onClick={() => changeTheme('dark')}
            >
              ☾ กลางคืน
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>เปลี่ยนรหัสผ่าน</h2>
        <p className="muted change-pw-note">ยืนยันด้วยรหัสผ่านปัจจุบันของคุณก่อนตั้งรหัสใหม่</p>
        <ChangePasswordForm />
      </section>
    </>
  );
}
