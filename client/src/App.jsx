import { Fragment, Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth, permissionsOf } from './auth.jsx';
import { POSITION_LABELS } from './labels.js';
import LoginPage from './pages/LoginPage.jsx';
import LineIcon from './components/LineIcon.jsx';
import ChangePasswordForm from './components/ChangePasswordForm.jsx';
import NotificationBell from './components/NotificationBell.jsx';

/*
 * ทุกหน้ายกเว้นหน้า login ถูกโหลดตอนกดเข้าไปดูจริง ไม่ใช่ตอนเปิดเว็บ
 *
 * เดิมรวมเป็นไฟล์เดียว 1.1 MB — พนักงานภาคสนามที่เข้าแค่ 4 หน้า (งานวันนี้/เคสของฉัน/ตารางงาน/
 * ค่าตอบแทน) ต้องโหลดหน้าหลังบ้านทั้งหมดรวมทั้งไลบรารีกราฟติดมาด้วย ทั้งที่ไม่มีสิทธิ์เปิดสักหน้า
 * คนกลุ่มนี้ใช้จากมือถือนอกสถานที่ ซึ่งเป็นที่ที่เน็ตแย่ที่สุด
 *
 * หน้า login ยังโหลดมาแต่แรก (ไม่ lazy) เพราะเป็นหน้าที่ทุกคนเจอก่อนเสมอ
 * ทำให้ lazy ก็แค่เพิ่มการรอไปอีกรอบโดยไม่ได้ลดอะไร
 */
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage.jsx'));
/* หน้าแบบประเมินของญาติ — lazy เหมือนหน้าอื่น และสำคัญกว่าหน้าอื่นด้วย
   คนที่เปิดคือญาติผู้ป่วยจากลิงก์ในไลน์ บนมือถือ ครั้งเดียวจบ ไม่ควรต้องโหลดระบบหลังบ้านทั้งก้อน */
const ReviewFormPage = lazy(() => import('./pages/ReviewFormPage.jsx'));
const ReviewsPage = lazy(() => import('./pages/ReviewsPage.jsx'));
const ReviewDetailPage = lazy(() => import('./pages/ReviewDetailPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const RevenuePage = lazy(() => import('./pages/RevenuePage.jsx'));
const EmployeeListPage = lazy(() => import('./pages/EmployeeListPage.jsx'));
const EmployeeFormPage = lazy(() => import('./pages/EmployeeFormPage.jsx'));
const EmployeeDetailPage = lazy(() => import('./pages/EmployeeDetailPage.jsx'));
const CaseListPage = lazy(() => import('./pages/CaseListPage.jsx'));
const CaseFormPage = lazy(() => import('./pages/CaseFormPage.jsx'));
const CalendarPage = lazy(() => import('./pages/CalendarPage.jsx'));
const InvoiceListPage = lazy(() => import('./pages/InvoiceListPage.jsx'));
const PayrollPage = lazy(() => import('./pages/PayrollPage.jsx'));
const PatientListPage = lazy(() => import('./pages/PatientListPage.jsx'));
const PatientFormPage = lazy(() => import('./pages/PatientFormPage.jsx'));
const PatientDetailPage = lazy(() => import('./pages/PatientDetailPage.jsx'));
const PackagesPage = lazy(() => import('./pages/PackagesPage.jsx'));
const PhysioPackagesPage = lazy(() => import('./pages/PhysioPackagesPage.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const AttendancePage = lazy(() => import('./pages/AttendancePage.jsx'));
const MyTodayPage = lazy(() => import('./pages/MyTodayPage.jsx'));
const MyCasesPage = lazy(() => import('./pages/MyCasesPage.jsx'));
const MyCalendarPage = lazy(() => import('./pages/MyCalendarPage.jsx'));
const MyAttendancePage = lazy(() => import('./pages/MyAttendancePage.jsx'));

/* ไอคอนเมนูแบบเส้น (Lucide-style) — stroke=currentColor จึง tint ตามสีเมนู (จาง → ทองตอน active) เอง */
const NAV_ICONS = {
  dashboard: (<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>),
  cases: (<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6M9 16h6" /></>),
  calendar: (<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /></>),
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></>),
  invoice: (<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6" /></>),
  users: (<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>),
  heart: (<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.5 4.04 3 5.5l7 7z" />),
  home: (<><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>),
  activity: (<path d="M22 12h-4l-3 9L9 3l-3 9H2" />),
  user: (<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>),
  today: (<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /><path d="M9 15l2 2 4-4" /></>),
  wallet: (<><path d="M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 9h18" /><path d="M16 13.5h2.5" /></>),
  star: (<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />),
};

function NavIcon({ name }) {
  return (
    <svg className="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {NAV_ICONS[name]}
    </svg>
  );
}

/* เมนูเก็บเป็นข้อมูล ไม่ใช่ JSX ตายตัว — ใช้สองที่: วาดรายการเมนู และหาชื่อหน้าปัจจุบันมาโชว์บนแถบบน
   ถ้าแยกกันเขียนสองชุด วันหนึ่งจะมีเมนูที่เปลี่ยนชื่อแล้วแถบบนยังเรียกชื่อเก่า */
/* perm = หมวดสิทธิ์ที่ต้องมีถึงจะเห็นเมนูนี้ (ดู POSITION_PERMISSIONS ใน server/src/lib/auth.js)
   unlessPerm = ซ่อนถ้ามีหมวดนี้อยู่แล้ว — หน้ารายได้แยกมีไว้ให้การเงิน ผู้จัดการดูกราฟเดียวกันที่หน้าภาพรวม */
const ADMIN_NAV = [
  { to: '/dashboard', icon: 'dashboard', label: 'ภาพรวม', perm: 'office' },
  { to: '/cases', icon: 'cases', label: 'เคส', perm: 'office' },
  { to: '/calendar', icon: 'calendar', label: 'ตารางงาน', perm: 'office' },
  { to: '/attendance', icon: 'clock', label: 'การมาทำงาน', perm: 'office' },
  { to: '/invoices', icon: 'invoice', label: 'ใบแจ้งหนี้', perm: 'billing' },
  { to: '/payroll', icon: 'wallet', label: 'ค่าตอบแทนพนักงาน', perm: 'money' },
  { to: '/revenue', icon: 'dashboard', label: 'รายได้บริษัท', perm: 'money', unlessPerm: 'office' },
  { to: '/packages', icon: 'home', label: 'แพ็คเกจ Homecare', perm: 'office' },
  { to: '/physio-packages', icon: 'activity', label: 'แพ็คเกจกายภาพบำบัด', perm: 'office' },
  { to: '/patients', icon: 'heart', label: 'ผู้ป่วย', perm: 'office' },
  { to: '/employees', icon: 'user', label: 'พนักงาน', perm: 'office' },
  { to: '/reviews', icon: 'star', label: 'คะแนนประเมินจากญาติ', perm: 'office' },
];

/** เมนูหลังบ้านที่ผู้ใช้คนนี้เห็น — ว่าง = ตำแหน่งที่ยังไม่ได้กำหนดสิทธิ์ (ถ้ามีตำแหน่งใหม่ที่ยังไม่ได้ผูกสิทธิ์) */
const navFor = (user) => {
  const perms = permissionsOf(user);
  return ADMIN_NAV.filter((i) => perms.includes(i.perm) && !(i.unlessPerm && perms.includes(i.unlessPerm)));
};

/** หน้าแรกหลัง login — หน้าแรกที่เข้าได้จริง ไม่ใช่ /dashboard ตายตัว (การเงินเข้าภาพรวมไม่ได้) */
const homePath = (user) => {
  if (user.role !== 'admin') return '/my-today';
  return navFor(user)[0]?.to ?? '/no-access';
};

const FIELD_NAV = [
  { to: '/my-today', icon: 'today', label: 'งานวันนี้' },
  { to: '/my-cases', icon: 'cases', label: 'เคสของฉัน' },
  { to: '/my-calendar', icon: 'calendar', label: 'ตารางงานของฉัน' },
  { to: '/my-attendance', icon: 'clock', label: 'ค่าตอบแทนของฉัน' },
];

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = user.role === 'admin';
  const items = isAdmin ? navFor(user) : FIELD_NAV;

  // เมนูพับได้เฉพาะจอแคบ (CSS ซ่อนปุ่มบนจอกว้าง) — บนจอกว้างค่านี้ไม่มีผลกับอะไรเลย
  const [menuOpen, setMenuOpen] = useState(false);

  // เปลี่ยนหน้าแล้วต้องพับเมนูเอง ไม่งั้นเมนูค้างบังเนื้อหาที่เพิ่งกดเข้าไปดู
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Esc = พับเมนู — ทางออกมาตรฐานของทุกอย่างที่กางทับหน้าจอ
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
      {/* แถวบนสุด: โลโก้ซ้าย · กระดิ่งขวา — ของค้างเป็นสิ่งแรกที่ควรเห็นตอนเปิดระบบ
          ไม่ใช่ต้องกวาดตาลงไปหาที่ท้ายแถบเมนูรวมกับปุ่มตั้งค่า/ออกจากระบบ

          กระดิ่งเฉพาะฝั่งหลังบ้าน — ของค้างทั้ง 4 กลุ่มเป็นงานของผู้จัดการ/HR
          พนักงานภาคสนามเข้าหน้าพวกนั้นไม่ได้เลย (และ /api/notify/alerts เป็น requireAdmin)
          ใส่ให้เขาก็ได้กระดิ่งที่กดแล้วเจอ 403 ทุกบรรทัด */}
      <div className="brand">
        <img className="brand-logo" src="/logo-navbar.webp" alt="KIN Home Care" />
        {/* ตำแหน่งที่ยังไม่มีสิทธิ์หมวดไหนเลย ไม่มีของค้างให้ดู (และ /api/notify/alerts ตอบ 403) */}
        {isAdmin && items.length > 0 && <NotificationBell />}
      </div>

      {/* ปุ่มพับ/กางเมนู — โผล่เฉพาะจอแคบ (ดู @media ใน index.css)
          aria-expanded + aria-controls บอกโปรแกรมอ่านหน้าจอว่าปุ่มนี้คุมกล่องไหนและตอนนี้กางอยู่ไหม */}
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={menuOpen}
        aria-controls="main-nav"
        aria-label={menuOpen ? 'ปิดเมนู' : 'เปิดเมนู'}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <LineIcon name={menuOpen ? 'close' : 'menu'} className="nav-toggle-ico" />
      </button>

      {/* ฉากหรี่หลังเมนูที่กางอยู่ — แตะแล้วปิด เป็นทางออกที่นิ้วหาเจอก่อนปุ่ม ✕ เสมอ
          เป็น element จริงไม่ใช่ ::before เพราะต้องรับการแตะได้เอง
          aria-hidden + ไม่มี label — คนใช้โปรแกรมอ่านหน้าจอปิดเมนูด้วย Esc หรือปุ่ม ✕ ที่มีชื่อกำกับอยู่แล้ว */}
      {menuOpen && (
        <div className="nav-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}

      {/* เมนูจัดการเห็นเฉพาะผู้ดูแลระบบ (ผู้จัดการ/HR) — พนักงานภาคสนามเห็นเฉพาะงานของตัวเอง

          กรอบนี้เป็น display: contents บนจอกว้าง = ไม่มีตัวตนในการจัดวาง เมนูกับส่วนท้าย
          ยังเป็นลูกโดยตรงของ sidebar เหมือนเดิมเป๊ะ · บนจอแคบมันกลายเป็นแผงเดียวที่กางลงมา
          ทำให้ปุ่มตั้งค่า/ออกจากระบบย้ายเข้าไปอยู่ในเมนู แทนที่จะแย่งที่บนแถบบน */}
      <div className="sidebar-panel">
        <nav id="main-nav" aria-label="เมนูหลัก">
          {items.map((i) => (
            <Fragment key={i.to}>
              {i.to === items[0].to && <span className="nav-section-label">{isAdmin ? 'การดำเนินงาน' : 'พื้นที่ทำงาน'}</span>}
              {i.to === '/packages' && <span className="nav-section-label">ข้อมูลและบริการ</span>}
              <NavLink to={i.to}><NavIcon name={i.icon} />{i.label}</NavLink>
            </Fragment>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="who-row">
            <div className="who">
              <strong>{user.first_name} {user.last_name}</strong>
              <span className="mono muted">{user.employee_id}</span>
            </div>
            {/* ตั้งค่า + ออกจากระบบ เป็นปุ่มไอคอนคู่กันท้ายแถวชื่อผู้ใช้ — ทั้งคู่คือ "เรื่องของบัญชีนี้"
                ไม่ใช่เมนูของระบบ · ออกจากระบบเดิมเป็นปุ่มข้อความเต็มความกว้างอยู่บรรทัดล่าง
                ซึ่งเด่นกว่าเมนูงานทุกอันในหน้า ทั้งที่เป็นสิ่งที่กดกันวันละครั้ง */}
            <div className="who-actions">
              <NavLink className="btn icon-btn" to="/settings" title="ตั้งค่า" aria-label="ตั้งค่า">
                <LineIcon name="settings" />
              </NavLink>
              {/* aria-label/title ทำหน้าที่แทนข้อความในปุ่ม — ไอคอนล้วนไม่มีชื่อกำกับจะไม่มีใครรู้ว่าปุ่มอะไร
                  ทั้งคนที่ใช้โปรแกรมอ่านหน้าจอ และคนที่จิ้มค้างดูคำอธิบายบนเดสก์ท็อป */}
              <button
                className="btn icon-btn"
                onClick={handleLogout}
                title="ออกจากระบบ"
                aria-label="ออกจากระบบ"
              >
                <LineIcon name="logout" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * ยังใช้รหัสชั่วคราวอยู่ = ใช้ระบบไม่ได้จนกว่าจะตั้งรหัสของตัวเอง
 *
 * เดิมเป็นแค่แถบเตือนที่ข้ามได้ ซึ่งแปลว่าบัญชีที่ผู้ออกรหัสให้ (HR/ผู้จัดการ) ยังรู้รหัสอยู่
 * ถูกใช้งานต่อได้เรื่อยๆ — ตอนนี้ฝั่ง API กันไว้แล้ว (requirePasswordChanged) หน้าเว็บจึงต้องกันด้วย
 * ไม่งั้นจะกดอะไรก็ขึ้น 403 ทุกปุ่มโดยไม่มีอะไรบอกว่าต้องทำอะไรก่อน
 */
function ForcePasswordChange() {
  const { user, logout } = useAuth();

  return (
    <div className="login-page">
      <section className="login-card">
        <h1>ตั้งรหัสผ่านของคุณก่อนเริ่มใช้งาน</h1>
        <p className="muted">
          บัญชี <strong>{user.employee_id}</strong> ยังใช้รหัสผ่านชั่วคราวที่ผู้ดูแลตั้งให้อยู่ —
          คนที่ออกรหัสให้ก็รู้รหัสนี้ด้วย จึงต้องเปลี่ยนเป็นรหัสของตัวเองก่อน
        </p>
        <ChangePasswordForm />
        <button className="btn link-btn" type="button" onClick={logout}>ออกจากระบบ</button>
      </section>
    </div>
  );
}

/** เนื้อในของเลย์เอาต์ — อยู่หลัง RequireAuth แล้ว จึงมั่นใจว่า user ไม่เป็น null */
function LayoutInner({ children, perm }) {
  const { user } = useAuth();

  // หน้าที่ต้องมีหมวดสิทธิ์ (office/billing/money) — ไม่มีก็เด้งไปหน้าแรกของตัวเอง
  // เป็นแค่การกันฝั่งหน้าเว็บ ตัวจริงกันที่ด่านของแต่ละเส้น API อีกชั้น
  if (perm && !permissionsOf(user).includes(perm)) return <Navigate to={homePath(user)} replace />;

  // ยังไม่ได้ตั้งรหัสของตัวเอง — API ปฏิเสธทุกเส้นอยู่แล้ว จึงไม่มีอะไรให้ทำในระบบนอกจากตั้งรหัส
  if (user.must_change_password) return <ForcePasswordChange />;

  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        {children}
      </main>
    </div>
  );
}

/** เลย์เอาต์ของหน้าที่ต้อง login (มี sidebar); หน้า login ใช้เลย์เอาต์ของตัวเอง
 *  perm = หมวดสิทธิ์ที่หน้านั้นต้องใช้ ('office' | 'billing' | 'money') · ไม่ใส่ = ทุกคนที่ login เข้าได้ */
function AppLayout({ children, perm = null }) {
  return (
    <RequireAuth>
      <LayoutInner perm={perm}>{children}</LayoutInner>
    </RequireAuth>
  );
}

/** "/" และ "/home" — พาไปหน้าแรกตามตำแหน่ง */
function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={homePath(user)} replace />;
}

/** ตำแหน่งหลังบ้านที่ยังไม่ได้กำหนดสิทธิ์ — บอกตรงๆ แทนการเด้งวนหรือหน้าว่าง (ตอนนี้ทุกตำแหน่งมีสิทธิ์แล้ว เผื่อเพิ่มตำแหน่งใหม่) */
function NoAccessPage() {
  const { user } = useAuth();
  if (navFor(user).length > 0 || user.role !== 'admin') return <Navigate to={homePath(user)} replace />;
  return (
    <div className="empty-state">
      <h1>ยังไม่ได้กำหนดสิทธิ์การใช้งาน</h1>
      <p className="muted">
        บัญชีตำแหน่ง {POSITION_LABELS[user.position] ?? user.position} ยังไม่มีสิทธิ์เข้าหน้าไหนในระบบ —
        กรุณาติดต่อผู้จัดการ
      </p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* หน้าที่ยังโหลดไม่เสร็จขึ้นข้อความเดียวกับตอนตรวจสิทธิ์ (ดู RequireAuth)
            สองอย่างนี้เกิดต่อกันเป็นชุดเดียวในสายตาคนใช้ ถ้าใช้คนละข้อความจะเห็นจอกระพริบสองจังหวะ */}
        <Suspense fallback={<p className="muted app-loading">กำลังโหลด…</p>}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />

            {/* แบบประเมินที่ญาติกรอก — ไม่มี AppLayout เพราะไม่มี login ไม่มีเมนู ไม่มีสิทธิ์อะไรให้ตรวจ
                คนที่เปิดหน้านี้ไม่ใช่ผู้ใช้ของระบบ ความปลอดภัยอยู่ที่ token ในลิงก์ (ดู reviews/routes.js) */}
            <Route path="/review/:token" element={<ReviewFormPage />} />
            <Route path="/settings" element={<AppLayout><SettingsPage /></AppLayout>} />
            {/* ลิงก์เดิมที่อาจถูก bookmark ไว้ ให้เด้งไปหน้าตั้งค่าแทน */}
            <Route path="/change-password" element={<Navigate to="/settings" replace />} />
            <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />
            <Route path="/no-access" element={<AppLayout><NoAccessPage /></AppLayout>} />
            <Route path="/dashboard" element={<AppLayout perm="office"><DashboardPage /></AppLayout>} />
            <Route path="/employees" element={<AppLayout perm="office"><EmployeeListPage /></AppLayout>} />
            <Route path="/employees/new" element={<AppLayout perm="office"><EmployeeFormPage /></AppLayout>} />
            <Route path="/employees/:id" element={<AppLayout perm="office"><EmployeeDetailPage /></AppLayout>} />
            <Route path="/employees/:id/edit" element={<AppLayout perm="office"><EmployeeFormPage /></AppLayout>} />

            <Route path="/cases" element={<AppLayout perm="office"><CaseListPage /></AppLayout>} />
            <Route path="/cases/new" element={<AppLayout perm="office"><CaseFormPage /></AppLayout>} />
            <Route path="/cases/:id/edit" element={<AppLayout perm="office"><CaseFormPage /></AppLayout>} />

            <Route path="/calendar" element={<AppLayout perm="office"><CalendarPage /></AppLayout>} />
            <Route path="/attendance" element={<AppLayout perm="office"><AttendancePage /></AppLayout>} />
            <Route path="/invoices" element={<AppLayout perm="billing"><InvoiceListPage /></AppLayout>} />
            <Route path="/payroll" element={<AppLayout perm="money"><PayrollPage /></AppLayout>} />
            <Route path="/revenue" element={<AppLayout perm="money"><RevenuePage /></AppLayout>} />

            {/* หน้าของพนักงานภาคสนาม — เข้าได้ทั้ง field และ admin (แสดงเฉพาะงานที่ตัวเองรับ) */}
            <Route path="/my-today" element={<AppLayout><MyTodayPage /></AppLayout>} />
            <Route path="/my-cases" element={<AppLayout><MyCasesPage /></AppLayout>} />
            <Route path="/my-calendar" element={<AppLayout><MyCalendarPage /></AppLayout>} />
            <Route path="/my-attendance" element={<AppLayout><MyAttendancePage /></AppLayout>} />

            {/* ไม่มีหน้าลูกค้าแล้ว — ข้อมูลผู้ว่าจ้างดู/แก้ในแฟ้มผู้ป่วย · ลิงก์/บุ๊กมาร์กเก่าพาไปหน้าผู้ป่วยแทนหน้าว่าง */}
            <Route path="/customers/*" element={<Navigate to="/patients" replace />} />

            <Route path="/patients" element={<AppLayout perm="office"><PatientListPage /></AppLayout>} />
            <Route path="/patients/new" element={<AppLayout perm="office"><PatientFormPage /></AppLayout>} />
            <Route path="/patients/:id" element={<AppLayout perm="office"><PatientDetailPage /></AppLayout>} />
            <Route path="/patients/:id/edit" element={<AppLayout perm="office"><PatientFormPage /></AppLayout>} />

            <Route path="/reviews" element={<AppLayout perm="office"><ReviewsPage /></AppLayout>} />
            <Route path="/reviews/:id" element={<AppLayout perm="office"><ReviewDetailPage /></AppLayout>} />

            <Route path="/packages" element={<AppLayout perm="office"><PackagesPage /></AppLayout>} />
            <Route path="/physio-packages" element={<AppLayout perm="office"><PhysioPackagesPage /></AppLayout>} />

            <Route path="*" element={<AppLayout perm="office"><p>ไม่พบหน้านี้</p></AppLayout>} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
