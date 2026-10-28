import { useState } from 'react';
import ChangePasswordForm from '../components/ChangePasswordForm.jsx';
import { getTheme, setTheme as persistTheme } from '../lib/theme.js';
import LineIcon from '../components/LineIcon.jsx';
import { useAuth } from '../auth.jsx';
import { guideUrlFor } from '../lib/guide.js';

export default function SettingsPage() {
  const { user } = useAuth();
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
          <p className="muted">ปรับแต่งการแสดงผล ความปลอดภัยของบัญชี และดูวิธีใช้งาน</p>
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
              <LineIcon name="sun" />สว่าง
            </button>
            <button
              className={`btn ${theme === 'dark' ? 'primary' : ''}`}
              onClick={() => changeTheme('dark')}
            >
              <LineIcon name="moon" />กลางคืน
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>เปลี่ยนรหัสผ่าน</h2>
        <p className="muted change-pw-note">ยืนยันด้วยรหัสผ่านปัจจุบันของคุณก่อนตั้งรหัสใหม่</p>
        <ChangePasswordForm />
      </section>

      <section className="card">
        <h2>ช่วยเหลือ</h2>
        <div className="setting-row">
          <div>
            <strong>วิดีโอสอนใช้งาน</strong>
            <p className="muted">
              {user?.role === 'admin' ? 'ขั้นตอนงานหลังบ้านทีละขั้น' : 'วิธีใช้งานสำหรับพนักงานภาคสนาม'} — เปิดในแท็บใหม่
            </p>
          </div>
          {/* ลิงก์ออกนอกระบบ ใช้ <a> — เปิดแท็บใหม่ งานที่ค้างอยู่ในระบบจึงไม่หาย */}
          <a className="btn" href={guideUrlFor(user)} target="_blank" rel="noopener noreferrer">
            <LineIcon name="play" />ดูวิดีโอ
          </a>
        </div>
      </section>
    </>
  );
}
