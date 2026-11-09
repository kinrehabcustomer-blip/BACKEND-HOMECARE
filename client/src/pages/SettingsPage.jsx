import { useEffect, useState } from 'react';
import ChangePasswordForm from '../components/ChangePasswordForm.jsx';
import { getTheme, setTheme as persistTheme } from '../lib/theme.js';
import LineIcon from '../components/LineIcon.jsx';
import { useAuth } from '../auth.jsx';
import { guideUrlFor } from '../lib/guide.js';
import { canPromptInstall, isIos, isStandalone, onInstallChange, promptInstall } from '../lib/pwa.js';

/**
 * ติดตั้งแอปลงหน้าโฮม (PWA)
 * - เปิดจากไอคอนอยู่แล้ว → บอกว่าติดตั้งแล้ว
 * - Chrome/Android ที่พร้อมติดตั้ง → ปุ่ม "ติดตั้งแอป" เปิดหน้าต่างติดตั้งของเบราว์เซอร์
 * - iPhone → Safari ไม่มีปุ่มให้เว็บเรียก สอนขั้นตอน แชร์ → เพิ่มไปยังหน้าจอโฮม
 * - ที่เหลือ → บอกให้หาเมนูติดตั้งในเบราว์เซอร์
 */
function InstallApp() {
  const [, rerender] = useState(0);
  useEffect(() => onInstallChange(() => rerender((n) => n + 1)), []);
  const [done, setDone] = useState(false);

  let body;
  if (done || isStandalone()) {
    body = <p className="muted">ติดตั้งแล้ว — เปิดจากไอคอน KIN Homecare บนหน้าโฮมได้เลย</p>;
  } else if (canPromptInstall()) {
    body = (
      <button type="button" className="btn primary" onClick={async () => setDone(await promptInstall())}>
        <LineIcon name="download" />ติดตั้งแอป
      </button>
    );
  } else if (isIos()) {
    body = (
      <ol className="install-steps muted">
        <li>เปิดหน้านี้ใน <strong>Safari</strong></li>
        <li>กดปุ่ม <strong>แชร์</strong> (สี่เหลี่ยมมีลูกศรชี้ขึ้น)</li>
        <li>เลือก <strong>เพิ่มไปยังหน้าจอโฮม</strong> แล้วกด <strong>เพิ่ม</strong></li>
      </ol>
    );
  } else {
    body = <p className="muted">เปิดเมนูของเบราว์เซอร์ (⋮) แล้วเลือก "ติดตั้งแอป" หรือ "เพิ่มไปยังหน้าจอหลัก"</p>;
  }

  return (
    <div className="setting-row install-row">
      <div>
        <strong>ติดตั้งแอปลงหน้าโฮม</strong>
        <p className="muted">เปิดจากไอคอนได้เลย เต็มจอเหมือนแอป ไม่ต้องพิมพ์ที่อยู่เว็บ</p>
      </div>
      {body}
    </div>
  );
}

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
        <h2>แอปบนมือถือ</h2>
        <InstallApp />
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
