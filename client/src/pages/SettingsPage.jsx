import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SettingsShell, { SettingsPaneHead } from '../components/SettingsShell.jsx';
import ChangePasswordForm from '../components/ChangePasswordForm.jsx';
import { getTheme, setTheme as persistTheme } from '../lib/theme.js';
import LineIcon from '../components/LineIcon.jsx';
import { useAuth } from '../auth.jsx';
import { guideUrlFor } from '../lib/guide.js';
import { canPromptInstall, isIos, isStandalone, onInstallChange, promptInstall } from '../lib/pwa.js';
import { currentSubscription, disablePush, enablePush, pushSupport, testPush } from '../lib/push.js';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';

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

/**
 * แจ้งเตือนบนมือถือ (ผู้ใช้ขอ 20 พ.ย. 2569) — พนักงานภาคสนามเท่านั้น · lib/push.js · server notify/webPush.js
 * เด้งที่เครื่องแม้ปิดแอปอยู่: กะใหม่ · เลื่อน/ยกเลิก/ย้ายกะ · เตือนวันก่อนนัด · เตือน 3 ชม.
 * สถานะจริงต้องดูสองฝั่ง: เบราว์เซอร์มีการสมัครอยู่ไหม + server ผูกเครื่องนี้กับเราไหม (คนอื่นอาจเคยล็อกอินเครื่องนี้)
 */
function PushSetting() {
  const toast = useToast();
  const support = pushSupport();
  const [state, setState] = useState({ loading: true, enabled: false, on: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let off = false;
    (async () => {
      const sub = await currentSubscription().catch(() => null);
      const s = await api.pushStatus(sub?.endpoint).catch(() => ({ enabled: false, subscribed: false }));
      if (!off) setState({ loading: false, enabled: s.enabled, on: Boolean(sub && s.subscribed) });
    })();
    return () => { off = true; };
  }, []);

  const run = async (fn, done) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const turnOn = () => run(async () => { await enablePush(); setState((s) => ({ ...s, on: true })); }, 'เปิดแจ้งเตือนเครื่องนี้แล้ว');
  const turnOff = () => run(async () => { await disablePush(); setState((s) => ({ ...s, on: false })); }, 'ปิดแจ้งเตือนเครื่องนี้แล้ว');
  const test = () => run(() => testPush(), 'ส่งข้อความทดสอบแล้ว — ควรเด้งขึ้นภายในไม่กี่วินาที');

  let body;
  if (support === 'ios-install') {
    body = <p className="muted">iPhone ต้องติดตั้งแอปลงหน้าโฮมก่อน (ด้านบน) แล้วเปิดจากไอคอน จึงจะเปิดแจ้งเตือนได้ — ต้องเป็น iOS 16.4 ขึ้นไป</p>;
  } else if (support === 'unsupported') {
    body = <p className="muted">เบราว์เซอร์นี้ไม่รองรับแจ้งเตือน — ใช้ Chrome บน Android หรือแอปที่ติดตั้งบน iPhone</p>;
  } else if (support === 'dev') {
    body = <p className="muted">ใช้ได้เฉพาะเว็บจริง (ไม่ใช่โหมดพัฒนา)</p>;
  } else if (support === 'denied') {
    body = <p className="muted">เครื่องนี้ปิดการแจ้งเตือนของแอปไว้ — เปิดที่การตั้งค่าของเครื่อง (แจ้งเตือน → KIN Homecare) แล้วกลับมาหน้านี้</p>;
  } else if (state.loading) {
    body = <p className="muted">กำลังตรวจสอบ…</p>;
  } else if (!state.enabled) {
    body = <p className="muted">ระบบยังไม่ได้เปิดใช้แจ้งเตือนบนมือถือ — แจ้งผู้ดูแลระบบ</p>;
  } else if (state.on) {
    body = (
      <div className="push-actions">
        <span className="badge active">เปิดอยู่</span>
        <button type="button" className="btn" disabled={busy} onClick={test}>ทดสอบ</button>
        <button type="button" className="btn" disabled={busy} onClick={turnOff}>ปิด</button>
      </div>
    );
  } else {
    body = (
      <button type="button" className="btn primary" disabled={busy} onClick={turnOn}>
        <LineIcon name="bell" />{busy ? 'กำลังเปิด…' : 'เปิดแจ้งเตือน'}
      </button>
    );
  }

  return (
    <div className="setting-row install-row">
      <div>
        <strong>แจ้งเตือนบนมือถือ</strong>
        <p className="muted">เด้งขึ้นที่เครื่องแม้ปิดแอปอยู่ — กะใหม่ · เลื่อน/ยกเลิกกะ · เตือนวันก่อนนัด · เตือน 3 ชม. ก่อนเริ่มกะ</p>
        {error && <p className="error push-error">{error}</p>}
      </div>
      {body}
    </div>
  );
}

/* เมนูซ้ายของหน้าตั้งค่า (ดีไซน์ 19 พ.ย. 2569 — เมนูซ้าย + แผงขวา) · จำหน้าที่เลือกไว้ใน ?tab= · เรื่องของบัญชีนี้เท่านั้น */
const GROUPS = [
  { label: 'บัญชีของฉัน', items: [
    // icon = ตกแต่งเมนูซ้ายอย่างเดียว (ดีไซน์ v2 23 พ.ย. 2569)
    { key: 'display', label: 'การแสดงผล', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg> },
    { key: 'app', label: 'แอปบนมือถือ', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg> },
    { key: 'password', label: 'เปลี่ยนรหัสผ่าน', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg> },
    { key: 'help', label: 'ช่วยเหลือ', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.1-2.4 3.6M12 17h.01" /></svg> },
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
        {/* ดีไซน์ v2: จอคอม = การ์ดตัวอย่างหน้าจอสองใบ (สว่าง/กลางคืน) · มือถือ = ไอคอน + ปุ่มคู่เต็มกว้าง
            ปุ่มสองตัวเดิม (onClick เดิม) — ตัวอย่างหน้าจอเป็น span ตกแต่ง aria-hidden · ตัวที่เลือกอยู่บอกด้วย aria-pressed */}
        <section className="set-card ad-theme-card">
          <div className="setting-row">
            <span className="ad-theme-ico" aria-hidden="true"><LineIcon name="moon" /></span>
            <div>
              <strong>โหมดกลางคืน</strong>
              <p className="muted">พื้นหลังเข้ม สบายตาเวลาใช้งานในที่แสงน้อย</p>
            </div>
            {/* สลับสว่าง/มืด — ปุ่มคู่ให้เห็นชัดว่าตอนนี้อยู่โหมดไหน */}
            <div className="theme-toggle">
              <button className={`btn ${theme === 'light' ? 'primary' : ''}`} aria-pressed={theme === 'light'} onClick={() => changeTheme('light')}>
                <span className="ad-theme-preview is-light" aria-hidden="true"><i /><i /><i /><i /><b /></span>
                <span className="ad-theme-label"><LineIcon name="sun" />สว่าง</span>
                <span className="ad-theme-on" aria-hidden="true"><LineIcon name="check" />ใช้อยู่</span>
              </button>
              <button className={`btn ${theme === 'dark' ? 'primary' : ''}`} aria-pressed={theme === 'dark'} onClick={() => changeTheme('dark')}>
                <span className="ad-theme-preview is-dark" aria-hidden="true"><i /><i /><i /><i /><b /></span>
                <span className="ad-theme-label"><LineIcon name="moon" />กลางคืน</span>
                <span className="ad-theme-on" aria-hidden="true"><LineIcon name="check" />ใช้อยู่</span>
              </button>
            </div>
          </div>
          <p className="ad-theme-note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
            เลือกแล้วเปลี่ยนทันที ไม่ต้องกดบันทึก — จำไว้เฉพาะเครื่องนี้
          </p>
        </section>
      </>
    );
  } else if (tab === 'app') {
    pane = (
      <>
        <SettingsPaneHead title="แอปบนมือถือ" desc="ติดตั้งระบบเป็นไอคอนบนหน้าโฮม เปิดได้เร็วเหมือนแอป" />
        <section className="set-card"><InstallApp /></section>
        {/* แจ้งเตือนกะงาน — เฉพาะพนักงานภาคสนาม (หลังบ้านใช้กระดิ่งของค้าง + อีเมลสรุป) */}
        {user?.role !== 'admin' && <section className="set-card"><PushSetting /></section>}
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
      <header className="page-head ad-head">
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
