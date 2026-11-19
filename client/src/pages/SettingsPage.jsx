import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SettingsShell, { SettingsPaneHead } from '../components/SettingsShell.jsx';
import ChangePasswordForm from '../components/ChangePasswordForm.jsx';
import { getTheme, setTheme as persistTheme } from '../lib/theme.js';
import LineIcon from '../components/LineIcon.jsx';
import { useAuth } from '../auth.jsx';
import { guideUrlFor } from '../lib/guide.js';
import { canPromptInstall, isIos, isStandalone, onInstallChange, promptInstall } from '../lib/pwa.js';

// หมวดของระบบ (เหตุผลยกเลิก · เหตุการณ์ผิดปกติ) ย้ายไปหน้า "ตั้งค่าระบบ" แล้ว (ปุ่มไขควงข้างปุ่มตั้งค่า · SystemSettingsPage)

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

/* เมนูซ้ายของหน้าตั้งค่า (ดีไซน์ 19 พ.ย. 2569 — เมนูซ้าย + แผงขวา) · จำหน้าที่เลือกไว้ใน ?tab= · เรื่องของบัญชีนี้เท่านั้น */
const GROUPS = [
  { label: 'บัญชีของฉัน', items: [
    { key: 'display', label: 'การแสดงผล' },
    { key: 'app', label: 'แอปบนมือถือ' },
    { key: 'password', label: 'เปลี่ยนรหัสผ่าน' },
    { key: 'help', label: 'ช่วยเหลือ' },
  ] },
];

export default function SettingsPage() {
  const { user } = useAuth();
  const [theme, setThemeState] = useState(getTheme);
  const [params, setParams] = useSearchParams();
  const groups = GROUPS;
  const keys = groups.flatMap((g) => g.items.map((i) => i.key));
  const tab = keys.includes(params.get('tab')) ? params.get('tab') : keys[0];

  const changeTheme = (value) => {
    setThemeState(value);
    persistTheme(value); // เปลี่ยนทั้งระบบทันที + จำไว้ครั้งหน้า
  };

  let pane;
  if (tab === 'display') {
    pane = (
      <>
        <SettingsPaneHead title="การแสดงผล" desc="ธีมของหน้าจอ — จำไว้ในเครื่องนี้ เปลี่ยนแล้วมีผลทั้งระบบทันที" />
        <section className="set-card">
          <div className="setting-row">
            <div>
              <strong>โหมดกลางคืน</strong>
              <p className="muted">พื้นหลังเข้ม สบายตาเวลาใช้งานในที่แสงน้อย</p>
            </div>
            {/* สลับสว่าง/มืด — ปุ่มคู่ให้เห็นชัดว่าตอนนี้อยู่โหมดไหน */}
            <div className="theme-toggle">
              <button className={`btn ${theme === 'light' ? 'primary' : ''}`} onClick={() => changeTheme('light')}>
                <LineIcon name="sun" />สว่าง
              </button>
              <button className={`btn ${theme === 'dark' ? 'primary' : ''}`} onClick={() => changeTheme('dark')}>
                <LineIcon name="moon" />กลางคืน
              </button>
            </div>
          </div>
        </section>
      </>
    );
  } else if (tab === 'app') {
    pane = (
      <>
        <SettingsPaneHead title="แอปบนมือถือ" desc="ติดตั้งระบบเป็นไอคอนบนหน้าโฮม เปิดได้เร็วเหมือนแอป" />
        <section className="set-card"><InstallApp /></section>
      </>
    );
  } else if (tab === 'password') {
    pane = (
      <>
        <SettingsPaneHead title="เปลี่ยนรหัสผ่าน" desc="ยืนยันด้วยรหัสผ่านปัจจุบันของคุณก่อนตั้งรหัสใหม่" />
        <section className="set-card"><ChangePasswordForm /></section>
      </>
    );
  } else {
    pane = (
      <>
        <SettingsPaneHead title="ช่วยเหลือ" desc="วิธีใช้งานระบบ" />
        <section className="set-card">
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

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ตั้งค่า</h1>
          <p className="muted">ปรับแต่งการแสดงผล ความปลอดภัยของบัญชี และดูวิธีใช้งาน</p>
        </div>
      </header>
      <SettingsShell groups={groups} active={tab} onSelect={(k) => setParams({ tab: k }, { replace: true })}>
        {pane}
      </SettingsShell>
    </>
  );
}
