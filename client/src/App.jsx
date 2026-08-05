import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth } from './auth.jsx';
import LineIcon from './components/LineIcon.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import EmployeeListPage from './pages/EmployeeListPage.jsx';
import EmployeeFormPage from './pages/EmployeeFormPage.jsx';
import EmployeeDetailPage from './pages/EmployeeDetailPage.jsx';
import CaseListPage from './pages/CaseListPage.jsx';
import CaseFormPage from './pages/CaseFormPage.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import InvoiceListPage from './pages/InvoiceListPage.jsx';
import CustomerListPage from './pages/CustomerListPage.jsx';
import CustomerFormPage from './pages/CustomerFormPage.jsx';
import CustomerDetailPage from './pages/CustomerDetailPage.jsx';
import PatientListPage from './pages/PatientListPage.jsx';
import PatientFormPage from './pages/PatientFormPage.jsx';
import PatientDetailPage from './pages/PatientDetailPage.jsx';
import PackagesPage from './pages/PackagesPage.jsx';
import PhysioPackagesPage from './pages/PhysioPackagesPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import AttendancePage from './pages/AttendancePage.jsx';
import MyTodayPage from './pages/MyTodayPage.jsx';
import MyCasesPage from './pages/MyCasesPage.jsx';
import MyCalendarPage from './pages/MyCalendarPage.jsx';
import MyAttendancePage from './pages/MyAttendancePage.jsx';

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
};

function NavIcon({ name }) {
  return (
    <svg className="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {NAV_ICONS[name]}
    </svg>
  );
}

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = user.role === 'admin';

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
      <div className="brand">
        <img className="brand-logo" src="/logo-navbar.webp" alt="KIN Home Care" />
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

      {/* เมนูจัดการเห็นเฉพาะผู้ดูแลระบบ (ผู้จัดการ/HR) — พนักงานภาคสนามยังไม่มีส่วนของตัวเอง */}
      {isAdmin ? (
        <nav id="main-nav">
          <NavLink to="/dashboard"><NavIcon name="dashboard" />ภาพรวม</NavLink>
          <NavLink to="/cases"><NavIcon name="cases" />เคส</NavLink>
          <NavLink to="/calendar"><NavIcon name="calendar" />ตารางงาน</NavLink>
          <NavLink to="/attendance"><NavIcon name="clock" />การมาทำงาน</NavLink>
          <NavLink to="/invoices"><NavIcon name="invoice" />ใบแจ้งหนี้</NavLink>
          <NavLink to="/customers"><NavIcon name="users" />ลูกค้า</NavLink>
          <NavLink to="/patients"><NavIcon name="heart" />ผู้รับการดูแล</NavLink>
          <NavLink to="/packages"><NavIcon name="home" />แพ็คเกจ Homecare</NavLink>
          <NavLink to="/physio-packages"><NavIcon name="activity" />แพ็คเกจกายภาพบำบัด</NavLink>
          <NavLink to="/employees"><NavIcon name="user" />พนักงาน</NavLink>
        </nav>
      ) : (
        <nav id="main-nav">
          <NavLink to="/my-today"><NavIcon name="today" />งานวันนี้</NavLink>
          <NavLink to="/my-cases"><NavIcon name="cases" />เคสของฉัน</NavLink>
          <NavLink to="/my-calendar"><NavIcon name="calendar" />ตารางงานของฉัน</NavLink>
          <NavLink to="/my-attendance"><NavIcon name="clock" />ค่าตอบแทนของฉัน</NavLink>
        </nav>
      )}

      <div className="sidebar-foot">
        <div className="who-row">
          <div className="who">
            <strong>{user.first_name} {user.last_name}</strong>
            <span className="mono muted">{user.employee_id}</span>
          </div>
          <NavLink className="btn icon-btn" to="/settings" title="ตั้งค่า" aria-label="ตั้งค่า">⚙</NavLink>
        </div>
        <button className="btn sidebar-btn" onClick={handleLogout}>ออกจากระบบ</button>
      </div>
    </aside>
  );
}

/** เตือนคนที่ยังใช้รหัสพนักงานเป็นรหัสผ่านอยู่ — รหัสนั้นโชว์ในตารางให้ทุกคนเห็น */
function DefaultPasswordBanner() {
  const { user } = useAuth();
  if (!user.must_change_password) return null;

  return (
    <div className="banner">
      คุณยังใช้รหัสพนักงานเป็นรหัสผ่านอยู่ ซึ่งคนอื่นเดาได้ง่าย —{' '}
      <Link to="/settings">ตั้งรหัสผ่านใหม่</Link>
    </div>
  );
}

/** เนื้อในของเลย์เอาต์ — อยู่หลัง RequireAuth แล้ว จึงมั่นใจว่า user ไม่เป็น null */
function LayoutInner({ children, admin }) {
  const { user } = useAuth();

  // หน้าเฉพาะ admin (ผู้จัดการ/HR) — พนักงานภาคสนามเด้งไปหน้า "งานวันนี้" (หน้าหลักของ field)
  // เป็นแค่การกันฝั่งหน้าเว็บ ตัวจริงกันที่ API (requireAdmin) อีกชั้น
  if (admin && user.role !== 'admin') return <Navigate to="/my-today" replace />;

  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        <DefaultPasswordBanner />
        {children}
      </main>
    </div>
  );
}

/** เลย์เอาต์ของหน้าที่ต้อง login (มี sidebar); หน้า login ใช้เลย์เอาต์ของตัวเอง
 *  admin=true = หน้านั้นเข้าได้เฉพาะผู้ดูแลระบบ */
function AppLayout({ children, admin = false }) {
  return (
    <RequireAuth>
      <LayoutInner admin={admin}>{children}</LayoutInner>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/settings" element={<AppLayout><SettingsPage /></AppLayout>} />
          {/* ลิงก์เดิมที่อาจถูก bookmark ไว้ ให้เด้งไปหน้าตั้งค่าแทน */}
          <Route path="/change-password" element={<Navigate to="/settings" replace />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<AppLayout admin><DashboardPage /></AppLayout>} />
          <Route path="/employees" element={<AppLayout admin><EmployeeListPage /></AppLayout>} />
          <Route path="/employees/new" element={<AppLayout admin><EmployeeFormPage /></AppLayout>} />
          <Route path="/employees/:id" element={<AppLayout admin><EmployeeDetailPage /></AppLayout>} />
          <Route path="/employees/:id/edit" element={<AppLayout admin><EmployeeFormPage /></AppLayout>} />

          <Route path="/cases" element={<AppLayout admin><CaseListPage /></AppLayout>} />
          <Route path="/cases/new" element={<AppLayout admin><CaseFormPage /></AppLayout>} />
          <Route path="/cases/:id/edit" element={<AppLayout admin><CaseFormPage /></AppLayout>} />

          <Route path="/calendar" element={<AppLayout admin><CalendarPage /></AppLayout>} />
          <Route path="/attendance" element={<AppLayout admin><AttendancePage /></AppLayout>} />
          <Route path="/invoices" element={<AppLayout admin><InvoiceListPage /></AppLayout>} />

          {/* หน้าของพนักงานภาคสนาม — เข้าได้ทั้ง field และ admin (แสดงเฉพาะงานที่ตัวเองรับ) */}
          <Route path="/my-today" element={<AppLayout><MyTodayPage /></AppLayout>} />
          <Route path="/my-cases" element={<AppLayout><MyCasesPage /></AppLayout>} />
          <Route path="/my-calendar" element={<AppLayout><MyCalendarPage /></AppLayout>} />
          <Route path="/my-attendance" element={<AppLayout><MyAttendancePage /></AppLayout>} />

          <Route path="/customers" element={<AppLayout admin><CustomerListPage /></AppLayout>} />
          <Route path="/customers/new" element={<AppLayout admin><CustomerFormPage /></AppLayout>} />
          <Route path="/customers/:id" element={<AppLayout admin><CustomerDetailPage /></AppLayout>} />
          <Route path="/customers/:id/edit" element={<AppLayout admin><CustomerFormPage /></AppLayout>} />

          <Route path="/patients" element={<AppLayout admin><PatientListPage /></AppLayout>} />
          <Route path="/patients/new" element={<AppLayout admin><PatientFormPage /></AppLayout>} />
          <Route path="/patients/:id" element={<AppLayout admin><PatientDetailPage /></AppLayout>} />
          <Route path="/patients/:id/edit" element={<AppLayout admin><PatientFormPage /></AppLayout>} />

          <Route path="/packages" element={<AppLayout admin><PackagesPage /></AppLayout>} />
          <Route path="/physio-packages" element={<AppLayout admin><PhysioPackagesPage /></AppLayout>} />

          <Route path="*" element={<AppLayout admin><p>ไม่พบหน้านี้</p></AppLayout>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
