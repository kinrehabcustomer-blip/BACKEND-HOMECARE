import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, useNavigate } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth } from './auth.jsx';
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

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">KIN</span>
        <span className="brand-sub">Homecare · หลังบ้าน</span>
      </div>

      <nav>
        <NavLink to="/dashboard">ภาพรวม</NavLink>
        <NavLink to="/cases">เคส</NavLink>
        <NavLink to="/calendar">ตารางงาน</NavLink>
        <NavLink to="/invoices">ใบแจ้งหนี้</NavLink>
        <NavLink to="/customers">ลูกค้า</NavLink>
        <NavLink to="/patients">ผู้รับการดูแล</NavLink>
        <NavLink to="/packages">แพ็คเกจ Homecare</NavLink>
        <NavLink to="/physio-packages">แพ็คเกจกายภาพบำบัด</NavLink>
        <NavLink to="/employees">พนักงาน</NavLink>
      </nav>

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

/** เลย์เอาต์ของหน้าที่ต้อง login (มี sidebar); หน้า login ใช้เลย์เอาต์ของตัวเอง */
function AppLayout({ children }) {
  return (
    <RequireAuth>
      <div className="app">
        <Sidebar />
        <main className="content">
          <DefaultPasswordBanner />
          {children}
        </main>
      </div>
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
          <Route path="/dashboard" element={<AppLayout><DashboardPage /></AppLayout>} />
          <Route path="/employees" element={<AppLayout><EmployeeListPage /></AppLayout>} />
          <Route path="/employees/new" element={<AppLayout><EmployeeFormPage /></AppLayout>} />
          <Route path="/employees/:id" element={<AppLayout><EmployeeDetailPage /></AppLayout>} />
          <Route path="/employees/:id/edit" element={<AppLayout><EmployeeFormPage /></AppLayout>} />

          <Route path="/cases" element={<AppLayout><CaseListPage /></AppLayout>} />
          <Route path="/cases/new" element={<AppLayout><CaseFormPage /></AppLayout>} />
          <Route path="/cases/:id/edit" element={<AppLayout><CaseFormPage /></AppLayout>} />

          <Route path="/calendar" element={<AppLayout><CalendarPage /></AppLayout>} />
          <Route path="/invoices" element={<AppLayout><InvoiceListPage /></AppLayout>} />

          <Route path="/customers" element={<AppLayout><CustomerListPage /></AppLayout>} />
          <Route path="/customers/new" element={<AppLayout><CustomerFormPage /></AppLayout>} />
          <Route path="/customers/:id" element={<AppLayout><CustomerDetailPage /></AppLayout>} />
          <Route path="/customers/:id/edit" element={<AppLayout><CustomerFormPage /></AppLayout>} />

          <Route path="/patients" element={<AppLayout><PatientListPage /></AppLayout>} />
          <Route path="/patients/new" element={<AppLayout><PatientFormPage /></AppLayout>} />
          <Route path="/patients/:id" element={<AppLayout><PatientDetailPage /></AppLayout>} />
          <Route path="/patients/:id/edit" element={<AppLayout><PatientFormPage /></AppLayout>} />

          <Route path="/packages" element={<AppLayout><PackagesPage /></AppLayout>} />
          <Route path="/physio-packages" element={<AppLayout><PhysioPackagesPage /></AppLayout>} />

          <Route path="*" element={<AppLayout><p>ไม่พบหน้านี้</p></AppLayout>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
