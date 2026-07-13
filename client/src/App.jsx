import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import EmployeeListPage from './pages/EmployeeListPage.jsx';
import EmployeeFormPage from './pages/EmployeeFormPage.jsx';
import EmployeeDetailPage from './pages/EmployeeDetailPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">KIN</span>
            <span className="brand-sub">Homecare · หลังบ้าน</span>
          </div>
          <nav>
            <NavLink to="/employees">พนักงาน</NavLink>
          </nav>
          <p className="sidebar-note">
            โมดูลถัดไป: ผู้ป่วย · ตารางเวร · เงินเดือน
            <br />
            ทุกโมดูลจะอ้างอิงพนักงานด้วย <code>employee_id</code>
          </p>
        </aside>

        <main className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/employees" replace />} />
            <Route path="/employees" element={<EmployeeListPage />} />
            <Route path="/employees/new" element={<EmployeeFormPage />} />
            <Route path="/employees/:id" element={<EmployeeDetailPage />} />
            <Route path="/employees/:id/edit" element={<EmployeeFormPage />} />
            <Route path="*" element={<p>ไม่พบหน้านี้</p>} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
