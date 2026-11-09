import { Fragment, Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth, permissionsOf } from './auth.jsx';
import { POSITION_LABELS } from './labels.js';
import LoginPage from './pages/LoginPage.jsx';
import LineIcon from './components/LineIcon.jsx';
import ChangePasswordForm from './components/ChangePasswordForm.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import { useBottomBounce } from './lib/edgeBounce.js';

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
   คนที่เปิดคือญาติผู้รับบริการจากลิงก์ในไลน์ บนมือถือ ครั้งเดียวจบ ไม่ควรต้องโหลดระบบหลังบ้านทั้งก้อน */
const ReviewFormPage = lazy(() => import('./pages/ReviewFormPage.jsx'));
const PublicBillPage = lazy(() => import('./pages/PublicBillPage.jsx'));
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
const PermissionsPage = lazy(() => import('./pages/PermissionsPage.jsx'));
const CustomerListPage = lazy(() => import('./pages/CustomerListPage.jsx'));
const CustomerFormPage = lazy(() => import('./pages/CustomerFormPage.jsx'));
const CustomerDetailPage = lazy(() => import('./pages/CustomerDetailPage.jsx'));
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
const MyChatPage = lazy(() => import('./pages/MyChatPage.jsx'));
const MyReportsPage = lazy(() => import('./pages/MyReportsPage.jsx'));
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
  package: (<><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>),
  shield: (<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></>),
  chat: (<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.7-.8L3 21l1.9-5.1A8.4 8.4 0 1 1 21 11.5z" />),
  chevron: (<path d="M6 9l6 6 6-6" />),
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
/* perm = สิทธิ์รายเมนูที่ต้องมีถึงจะเห็นเมนูนี้ — ตั้งรายตำแหน่งได้ในหน้า "จัดการสิทธิ์" (server/src/lib/permissions.js)
   unlessPerm = ซ่อนถ้ามีสิทธิ์นี้อยู่แล้ว — หน้ารายได้แยกมีไว้ให้คนที่ไม่มีหน้าภาพรวม (ภาพรวมมีกราฟเดียวกันอยู่แล้ว)
   positions = เมนูที่ผูกกับตำแหน่งตายตัว ไม่อยู่ในตารางสิทธิ์ (หน้าจัดการสิทธิ์เอง — กันปิดทางกลับของตัวเอง) */
// ตำแหน่งที่เปิดหน้าจัดการสิทธิ์ได้ — ตรงกับ PERMISSION_ADMINS ใน server/src/lib/permissions.js
const PERMISSION_ADMINS = ['super_admin', 'manager'];

/* short = ชื่อสั้นบนแถบเมนูล่างของมือถือ (ดู TabBar) — ไม่ใส่ = ใช้ label */
const ADMIN_NAV = [
  { to: '/dashboard', icon: 'dashboard', label: 'ภาพรวม', perm: 'dashboard' },
  { to: '/cases', icon: 'cases', label: 'เคส', perm: 'cases' },
  { to: '/calendar', icon: 'calendar', label: 'ตารางงาน', short: 'ตาราง', perm: 'calendar' },
  { to: '/attendance', icon: 'clock', label: 'การมาทำงาน', short: 'เข้างาน', perm: 'attendance' },
  { to: '/invoices', icon: 'invoice', label: 'ใบแจ้งหนี้', perm: 'invoices' },
  { to: '/payroll', icon: 'wallet', label: 'ค่าตอบแทนพนักงาน', short: 'ค่าตอบแทน', perm: 'payroll' },
  { to: '/revenue', icon: 'dashboard', label: 'รายได้บริษัท', short: 'รายได้', perm: 'revenue', unlessPerm: 'dashboard' },
  /* group = รวมอยู่ใต้หัวข้อเดียวที่กางได้ในแถบเมนู (ดู NAV_GROUPS) · sub = ชื่อสั้นในเมนูย่อย
     label เต็มยังใช้เป็นชื่อหน้าบนแถบบน */
  { to: '/packages', icon: 'home', label: 'แพ็คเกจ Homecare', sub: 'Homecare', group: 'packages', perm: 'packages' },
  { to: '/physio-packages', icon: 'activity', label: 'แพ็คเกจกายภาพบำบัด', sub: 'กายภาพบำบัด', group: 'packages', perm: 'packages' },
  { to: '/customers', icon: 'users', label: 'ลูกค้า', perm: 'customers' },
  { to: '/patients', icon: 'heart', label: 'ผู้รับบริการ', short: 'ผู้รับฯ', perm: 'patients' },
  { to: '/employees', icon: 'user', label: 'พนักงาน', perm: 'employees' },
  { to: '/reviews', icon: 'star', label: 'คะแนนประเมินจากญาติ', short: 'ประเมิน', perm: 'reviews' },
  { to: '/permissions', icon: 'shield', label: 'จัดการสิทธิ์', short: 'สิทธิ์', positions: PERMISSION_ADMINS },
];

/** หัวข้อของเมนูที่รวมกลุ่มกัน — แพ็คเกจสองแบบยุบเป็นหัวข้อเดียว (ผู้ใช้ขอ 30 ต.ค. 2569) */
const NAV_GROUPS = {
  packages: { icon: 'package', label: 'แพ็คเกจ' },
};

/** เมนูหลังบ้านที่ผู้ใช้คนนี้เห็น — ว่าง = ตำแหน่งที่ยังไม่ได้กำหนดสิทธิ์ (ถ้ามีตำแหน่งใหม่ที่ยังไม่ได้ผูกสิทธิ์) */
const navFor = (user) => {
  const perms = permissionsOf(user);
  return ADMIN_NAV.filter((i) =>
    i.positions
      ? i.positions.includes(user.position)
      : perms.includes(i.perm) && !(i.unlessPerm && perms.includes(i.unlessPerm)));
};

/** หน้าแรกหลัง login — หน้าแรกที่เข้าได้จริง ไม่ใช่ /dashboard ตายตัว (การเงินเข้าภาพรวมไม่ได้) */
const homePath = (user) => {
  if (user.role !== 'admin') return '/my-today';
  return navFor(user)[0]?.to ?? '/no-access';
};


// short = ชื่อสั้นบนแถบเมนูล่างของมือถือ (6 ช่องบนจอ 390px ชื่อเต็มไม่พอที่)
const FIELD_NAV = [
  { to: '/my-today', icon: 'today', label: 'งานวันนี้', short: 'วันนี้' },
  { to: '/my-cases', icon: 'cases', label: 'เคสของฉัน', short: 'เคส' },
  { to: '/my-chat', icon: 'chat', label: 'แชทญาติ', short: 'แชท' },
  { to: '/my-reports', icon: 'activity', label: 'รายงานของฉัน', short: 'รายงาน' },
  { to: '/my-calendar', icon: 'calendar', label: 'ตารางงานของฉัน', short: 'ตาราง' },
  { to: '/my-attendance', icon: 'clock', label: 'ค่าตอบแทนของฉัน', short: 'ค่าตอบแทน' },
];
/* แถบล่างของพนักงาน (ผู้ใช้ขอ 9 พ.ย. 2569): ไม่มี ☰ บนแถบบนแล้ว — ช่องขวาสุดเป็นปุ่ม "ตั้งค่า"
   ที่กางแผงเมนูขึ้นจากล่าง ในแผงมีแชทญาติ + ตั้งค่า/ออกจากระบบ · เมนูที่อยู่บนแถบแล้วไม่ซ้ำในแผง */
const FIELD_IN_SHEET = new Set(['/my-chat']);
const FIELD_TABS = FIELD_NAV.filter((i) => !FIELD_IN_SHEET.has(i.to));

/** จำนวนเมนูหลักบนแถบล่างของหลังบ้าน — ช่องที่ 5 คือปุ่ม "เมนู" (390px แบ่ง 5 ช่อง ช่องละ ~70px ชื่อสั้นยังไม่ตกบรรทัด) */
const ADMIN_TABS = 4;

/**
 * แถบเมนูล่างบนมือถือ (จอกว้างซ่อนด้วย CSS — warm-clarity.css) แถบลอยมุมมน อยู่ที่นิ้วโป้งเอื้อมถึง
 *
 * พนักงานภาคสนาม: 5 หน้างาน + ปุ่ม "ตั้งค่า" (ขวาสุด) ที่กางแผงเมนู — แชทญาติ/ตั้งค่า/ออกจากระบบอยู่ในแผงนั้น
 * หลังบ้าน (ผู้ใช้ขอ 6 พ.ย. 2569): เมนูมีถึง 12 อัน ใส่แถบเดียวไม่พอ — 4 อันแรกที่คนนี้เข้าได้อยู่บนแถบ
 * (เรียงตาม ADMIN_NAV ซึ่งเรียงตามความถี่ใช้อยู่แล้ว) ที่เหลือ + ตั้งค่า/ออกจากระบบอยู่ในแผง "เมนู"
 * ที่เลื่อนขึ้นจากด้านล่าง (แผงเดียวกับ ☰ เดิม — แถบบนของหลังบ้านบนมือถือจึงไม่มีปุ่ม ☰ แล้ว)
 */
function TabBar({ menuOpen, onMenu }) {
  const { user } = useAuth();
  const location = useLocation();
  const icon = (name) => <span className="tab-ico"><NavIcon name={name} /></span>;

  // ปุ่มกางแผงเมนู — ใช้ร่วมกันทั้งพนักงาน ("ตั้งค่า") และหลังบ้าน ("เมนู")
  const menuButton = (label, ico, active) => (
    <button
      key="menu"
      type="button"
      className={menuOpen || active ? 'active' : ''}
      aria-expanded={menuOpen}
      aria-controls="main-nav"
      onClick={onMenu}
    >
      <span className="tab-ico"><LineIcon name={menuOpen ? 'close' : ico} className="nav-ico" /></span>
      <span className="tab-label">{label}</span>
    </button>
  );
  // ตอนแผงเมนูกางอยู่ ไฮไลต์ที่ปุ่มเมนูช่องเดียว — สองช่องติดพร้อมกันอ่านไม่ออกว่าอันไหนคือสิ่งที่เปิดอยู่
  const tabLink = (i) => (
    <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive && !menuOpen ? 'active' : '')}>
      {icon(i.icon)}
      <span className="tab-label">{i.short ?? i.label}</span>
    </NavLink>
  );

  if (user.role !== 'admin') {
    // อยู่หน้าที่ไม่มีบนแถบ (แชท/ตั้งค่า) — ไฮไลต์ปุ่ม "ตั้งค่า" แทน จะได้รู้ว่าหน้านี้มาจากปุ่มไหน
    const elsewhere = !FIELD_TABS.some((i) => location.pathname.startsWith(i.to));
    return (
      <nav className="tabbar" aria-label="เมนูพนักงาน">
        {FIELD_TABS.map(tabLink)}
        {menuButton('ตั้งค่า', 'settings', elsewhere)}
      </nav>
    );
  }

  const tabs = navFor(user).filter((i) => !i.group).slice(0, ADMIN_TABS);
  /* อยู่หน้าที่ไม่มีบนแถบ (ลูกค้า/พนักงาน/…) — ไฮไลต์ "เมนู" แทน ไม่งั้นแถบไม่มีช่องไหนติดเลย
     คนใช้จะไม่รู้ว่าตอนนี้อยู่ตรงไหน และไม่รู้ว่าหน้านี้มาจากปุ่มไหน */
  const elsewhere = !tabs.some((i) => location.pathname.startsWith(i.to));
  return (
    <nav className="tabbar" aria-label="เมนูลัด">
      {tabs.map(tabLink)}
      {menuButton('เมนู', 'menu', elsewhere)}
    </nav>
  );
}

/* menuOpen อยู่ที่ LayoutInner ไม่ใช่ที่นี่ — ปุ่ม "เมนู" บนแถบล่าง (TabBar) ต้องกางแผงเดียวกันนี้ได้ */
function Sidebar({ menuOpen, setMenuOpen }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = user.role === 'admin';
  const items = isAdmin ? navFor(user) : FIELD_NAV;

  /* หัวข้อกลุ่มที่กางอยู่ (เช่น "แพ็คเกจ") — กางเองเมื่ออยู่ในหน้าของกลุ่มนั้น
     ไม่งั้นเข้าหน้าแพ็คเกจจากลิงก์อื่นแล้วเมนูที่ไฮไลต์ซ่อนอยู่ใต้หัวข้อที่หุบ */
  const groupOf = (path) => items.find((i) => i.group && path.startsWith(i.to))?.group ?? null;
  const [openGroups, setOpenGroups] = useState(() => new Set([groupOf(location.pathname)].filter(Boolean)));
  useEffect(() => {
    const g = groupOf(location.pathname);
    if (g) setOpenGroups((prev) => (prev.has(g) ? prev : new Set([...prev, g])));
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleGroup = (g) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });

  // เปลี่ยนหน้าแล้วต้องพับเมนูเอง ไม่งั้นเมนูค้างบังเนื้อหาที่เพิ่งกดเข้าไปดู
  useEffect(() => setMenuOpen(false), [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc = พับเมนู — ทางออกมาตรฐานของทุกอย่างที่กางทับหน้าจอ
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
        {/* โลโก้ 2 ไฟล์ — CSS เลือกตาม data-theme (ไฟล์ -dark: ตัวอักษร HOME CARE สีครีม พื้นโปร่ง ไม่มีขอบขาว) */}
        <img className="brand-logo logo-light" src="/logo-navbar.webp" alt="KIN Home Care" />
        <img className="brand-logo logo-dark" src="/logo-navbar-dark.webp" alt="" aria-hidden="true" />
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
          {items.map((i, idx) => {
            // เมนูในกลุ่ม: วาดหัวข้อกลุ่มครั้งเดียวตรงตัวแรกของกลุ่ม แล้วเมนูย่อยทั้งหมดอยู่ใต้หัวข้อนั้น
            const firstOfGroup = i.group && items.findIndex((x) => x.group === i.group) === idx;
            if (i.group && !firstOfGroup) return null;
            const members = i.group ? items.filter((x) => x.group === i.group) : null;
            const open = i.group && openGroups.has(i.group);
            const groupActive = members?.some((m) => location.pathname.startsWith(m.to));
            return (
              <Fragment key={i.group ?? i.to}>
                {idx === 0 && <span className="nav-section-label">{isAdmin ? 'การดำเนินงาน' : 'พื้นที่ทำงาน'}</span>}
                {i.to === '/packages' && <span className="nav-section-label">ข้อมูลและบริการ</span>}
                {!i.group ? (
                  /* on-tabbar = พนักงานภาคสนาม เมนูนี้อยู่บนแถบล่างแล้ว — แผงเมนูบนมือถือซ่อนไว้ (จอกว้างยังเห็นครบ) */
                  <NavLink to={i.to} className={!isAdmin && !FIELD_IN_SHEET.has(i.to) ? 'on-tabbar' : undefined}><NavIcon name={i.icon} />{i.label}</NavLink>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`nav-group-btn${groupActive ? ' has-active' : ''}`}
                      aria-expanded={open}
                      aria-controls={`nav-group-${i.group}`}
                      onClick={() => toggleGroup(i.group)}
                    >
                      <NavIcon name={NAV_GROUPS[i.group].icon} />
                      {NAV_GROUPS[i.group].label}
                      <svg className={`nav-caret${open ? ' is-open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {NAV_ICONS.chevron}
                      </svg>
                    </button>
                    {/* วาดไว้เสมอ หุบด้วย CSS (.is-collapsed) — บนมือถือ (แผงเมนูของแถบล่าง) ไม่มีหัวข้อกางหุบ
                        เมนูย่อยโชว์ตรงๆ เป็นเมนูปกติพร้อมชื่อเต็ม (ผู้ใช้ขอ 6 พ.ย. 2569) · ชื่อสั้น/เต็มสลับด้วย CSS */}
                    <div className={`nav-sub${open ? '' : ' is-collapsed'}`} id={`nav-group-${i.group}`}>
                      {members.map((m) => (
                        <NavLink key={m.to} to={m.to}>
                          <NavIcon name={m.icon} />
                          <span className="nav-name-short">{m.sub ?? m.label}</span>
                          <span className="nav-name-full">{m.label}</span>
                        </NavLink>
                      ))}
                    </div>
                  </>
                )}
              </Fragment>
            );
          })}
          {/* วิดีโอสอนใช้งานย้ายไปอยู่ในหน้าตั้งค่าแล้ว (ส่วน "ช่วยเหลือ" — ดู SettingsPage) */}
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
function LayoutInner({ children, perm, positions }) {
  const { user } = useAuth();
  // เมนูพับได้เฉพาะจอแคบ — กางจากปุ่มบนแถบล่าง ("ตั้งค่า" ของพนักงาน / "เมนู" ของหลังบ้าน)
  const [menuOpen, setMenuOpen] = useState(false);
  // เลื่อนจนสุดหน้าแล้วเด้งกลับนิดหนึ่ง (มือถือ) — ต้องเรียกก่อน return ด้านล่างตามกติกาของ hook
  const bounceRef = useBottomBounce();

  // หน้าที่ต้องมีหมวดสิทธิ์ (office/billing/money) — ไม่มีก็เด้งไปหน้าแรกของตัวเอง
  // เป็นแค่การกันฝั่งหน้าเว็บ ตัวจริงกันที่ด่านของแต่ละเส้น API อีกชั้น
  if (perm && !permissionsOf(user).includes(perm)) return <Navigate to={homePath(user)} replace />;
  // หน้าที่ผูกกับตำแหน่งตายตัว (จัดการสิทธิ์)
  if (positions && !positions.includes(user.position)) return <Navigate to={homePath(user)} replace />;

  // ยังไม่ได้ตั้งรหัสของตัวเอง — API ปฏิเสธทุกเส้นอยู่แล้ว จึงไม่มีอะไรให้ทำในระบบนอกจากตั้งรหัส
  if (user.must_change_password) return <ForcePasswordChange />;

  return (
    /* has-tabbar = มีแถบล่าง (ทุกคนบนมือถือ — CSS เว้นที่ให้เฉพาะจอแคบ)
       tabbar-sheet = แผงเมนูเลื่อนขึ้นจากเหนือแถบล่าง ไม่มี ☰ บนแถบบน (ทั้งหลังบ้านและพนักงาน ตั้งแต่ 9 พ.ย. 2569) */
    <div className={`app has-tabbar tabbar-sheet${user.role === 'admin' ? '' : ' tabbar-field'}${menuOpen ? ' menu-open' : ''}`}>
      <Sidebar menuOpen={menuOpen} setMenuOpen={setMenuOpen} />
      <main className="content" ref={bounceRef}>
        {children}
      </main>
      <TabBar menuOpen={menuOpen} onMenu={() => setMenuOpen((v) => !v)} />
    </div>
  );
}

/** เลย์เอาต์ของหน้าที่ต้อง login (มี sidebar); หน้า login ใช้เลย์เอาต์ของตัวเอง
 *  perm = หมวดสิทธิ์ที่หน้านั้นต้องใช้ ('office' | 'billing' | 'money') · ไม่ใส่ = ทุกคนที่ login เข้าได้ */
function AppLayout({ children, perm = null, positions = null }) {
  return (
    <RequireAuth>
      <LayoutInner perm={perm} positions={positions}>{children}</LayoutInner>
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
            {/* ใบแจ้งหนี้/ใบเสร็จที่ส่งเข้า LINE ลูกค้า — ไม่มี login แบบเดียวกับแบบประเมิน (server/src/invoices/share.js) */}
            <Route path="/bill/:token" element={<PublicBillPage />} />
            <Route path="/settings" element={<AppLayout><SettingsPage /></AppLayout>} />
            {/* ลิงก์เดิมที่อาจถูก bookmark ไว้ ให้เด้งไปหน้าตั้งค่าแทน */}
            <Route path="/change-password" element={<Navigate to="/settings" replace />} />
            <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />
            <Route path="/no-access" element={<AppLayout><NoAccessPage /></AppLayout>} />
            <Route path="/dashboard" element={<AppLayout perm="dashboard"><DashboardPage /></AppLayout>} />
            <Route path="/employees" element={<AppLayout perm="employees"><EmployeeListPage /></AppLayout>} />
            <Route path="/employees/new" element={<AppLayout perm="employees"><EmployeeFormPage /></AppLayout>} />
            <Route path="/employees/:id" element={<AppLayout perm="employees"><EmployeeDetailPage /></AppLayout>} />
            <Route path="/employees/:id/edit" element={<AppLayout perm="employees"><EmployeeFormPage /></AppLayout>} />

            <Route path="/cases" element={<AppLayout perm="cases"><CaseListPage /></AppLayout>} />
            <Route path="/cases/new" element={<AppLayout perm="cases"><CaseFormPage /></AppLayout>} />
            <Route path="/cases/:id/edit" element={<AppLayout perm="cases"><CaseFormPage /></AppLayout>} />

            <Route path="/calendar" element={<AppLayout perm="calendar"><CalendarPage /></AppLayout>} />
            <Route path="/attendance" element={<AppLayout perm="attendance"><AttendancePage /></AppLayout>} />
            <Route path="/invoices" element={<AppLayout perm="invoices"><InvoiceListPage /></AppLayout>} />
            <Route path="/payroll" element={<AppLayout perm="payroll"><PayrollPage /></AppLayout>} />
            <Route path="/permissions" element={<AppLayout positions={PERMISSION_ADMINS}><PermissionsPage /></AppLayout>} />
            <Route path="/revenue" element={<AppLayout perm="revenue"><RevenuePage /></AppLayout>} />

            {/* หน้าของพนักงานภาคสนาม — เข้าได้ทั้ง field และ admin (แสดงเฉพาะงานที่ตัวเองรับ) */}
            <Route path="/my-today" element={<AppLayout><MyTodayPage /></AppLayout>} />
            <Route path="/my-cases" element={<AppLayout><MyCasesPage /></AppLayout>} />
            <Route path="/my-chat" element={<AppLayout><MyChatPage /></AppLayout>} />
            <Route path="/my-reports" element={<AppLayout><MyReportsPage /></AppLayout>} />
            <Route path="/my-calendar" element={<AppLayout><MyCalendarPage /></AppLayout>} />
            <Route path="/my-attendance" element={<AppLayout><MyAttendancePage /></AppLayout>} />

            {/* ลูกค้า (ผู้ว่าจ้าง/ผู้จ่ายเงิน) — กลับมาเปิดแสดงในเมนูอีกครั้ง (ดร.ธงชัย 28 ต.ค. 2569) */}
            <Route path="/customers" element={<AppLayout perm="customers"><CustomerListPage /></AppLayout>} />
            <Route path="/customers/new" element={<AppLayout perm="customers"><CustomerFormPage /></AppLayout>} />
            <Route path="/customers/:id" element={<AppLayout perm="customers"><CustomerDetailPage /></AppLayout>} />
            <Route path="/customers/:id/edit" element={<AppLayout perm="customers"><CustomerFormPage /></AppLayout>} />

            <Route path="/patients" element={<AppLayout perm="patients"><PatientListPage /></AppLayout>} />
            <Route path="/patients/new" element={<AppLayout perm="patients"><PatientFormPage /></AppLayout>} />
            <Route path="/patients/:id" element={<AppLayout perm="patients"><PatientDetailPage /></AppLayout>} />
            <Route path="/patients/:id/edit" element={<AppLayout perm="patients"><PatientFormPage /></AppLayout>} />

            <Route path="/reviews" element={<AppLayout perm="reviews"><ReviewsPage /></AppLayout>} />
            <Route path="/reviews/:id" element={<AppLayout perm="reviews"><ReviewDetailPage /></AppLayout>} />

            <Route path="/packages" element={<AppLayout perm="packages"><PackagesPage /></AppLayout>} />
            <Route path="/physio-packages" element={<AppLayout perm="packages"><PhysioPackagesPage /></AppLayout>} />

            <Route path="*" element={<AppLayout perm="office"><p>ไม่พบหน้านี้</p></AppLayout>} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
