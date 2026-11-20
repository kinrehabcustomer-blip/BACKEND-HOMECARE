import { lazy, Suspense } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { permissionsOf, useAuth } from '../auth.jsx';
import SettingsShell, { SettingsPaneHead } from '../components/SettingsShell.jsx';
import CategoryManager from '../components/CategoryManager.jsx';
import RevenueTargetsPane from '../components/RevenueTargetsPane.jsx';

const PermissionsPage = lazy(() => import('./PermissionsPage.jsx'));
const AuditLogPage = lazy(() => import('./AuditLogPage.jsx'));
const FinanceLogPage = lazy(() => import('./FinanceLogPage.jsx'));

/**
 * ตั้งค่าระบบ — เปิดจากปุ่มไอคอนไขควงข้างปุ่มตั้งค่าในแถบเมนู (ผู้ใช้ขอ 19 พ.ย. 2569 — แยกจากหน้าตั้งค่าบัญชี)
 *   หมวดของระบบ: เหตุผลยกเลิก (เคส · นัด/กะ · ใบแจ้งหนี้) · หมวดเหตุการณ์ผิดปกติ — Super Admin + ผู้จัดการ
 *   ผู้ใช้และความปลอดภัย: จัดการสิทธิ์ (Super Admin + ผู้จัดการ) · บันทึกการใช้งาน (สิทธิ์ audit_logs)
 *   การเงิน: บันทึกการเงิน (สิทธิ์ finance_logs · 20 พ.ย. 2569) — ยอดประจำวัน + รายการเงินทุกความเคลื่อนไหว
 *          เป้ารายได้ต่อ BU (Super Admin + ผู้จัดการ · 20 พ.ย. 2569) — หน้ารายได้ตาม BU ใช้เทียบ
 * แต่ละแท็บโผล่เฉพาะคนที่เข้าได้ — server ตรวจสิทธิ์ซ้ำทุกเส้น (categories · permissions · audit-logs)
 * จำแท็บที่เลือกไว้ใน ?tab= · ลิงก์เดิม /permissions และ /audit-log พามาแท็บเดียวกันที่นี่
 */
export const SYSTEM_ADMINS = ['super_admin', 'manager'];

const PANES = {
  permissions: { title: 'จัดการสิทธิ์', desc: 'เปิด/ปิดเมนูและสิทธิ์รายตำแหน่ง — มีผลกับทุกคนในตำแหน่งนั้น' },
  audit: { title: 'บันทึกการใช้งาน', desc: 'ใครทำอะไรในระบบ เมื่อไร จากที่ไหน — เก็บย้อนหลัง 1 ปี' },
  finance: { title: 'บันทึกการเงิน' },
  targets: { title: 'เป้ารายได้' },
};
const PANE_PAGES = { permissions: PermissionsPage, audit: AuditLogPage, finance: FinanceLogPage, targets: RevenueTargetsPane };

export default function SystemSettingsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const isAdmin = SYSTEM_ADMINS.includes(user?.position);
  const canAudit = permissionsOf(user).includes('audit_logs');
  const canFinance = permissionsOf(user).includes('finance_logs');

  const groups = [
    isAdmin && { label: 'เหตุผลยกเลิก', items: [
      { key: 'cancel_case', label: 'ยกเลิกเคส' },
      { key: 'cancel_visit', label: 'ยกเลิกนัด / กะ' },
      { key: 'cancel_invoice', label: 'ยกเลิกใบแจ้งหนี้' },
    ] },
    isAdmin && { label: 'รายงานการดูแล', items: [{ key: 'incident', label: 'หมวดเหตุการณ์ผิดปกติ' }] },
    (isAdmin || canAudit) && { label: 'ผู้ใช้และความปลอดภัย', items: [
      isAdmin && { key: 'permissions', label: 'จัดการสิทธิ์' },
      canAudit && { key: 'audit', label: 'บันทึกการใช้งาน' },
    ].filter(Boolean) },
    (canFinance || isAdmin) && { label: 'การเงิน', items: [
      canFinance && { key: 'finance', label: 'บันทึกการเงิน' },
      isAdmin && { key: 'targets', label: 'เป้ารายได้' },
    ].filter(Boolean) },
  ].filter(Boolean);
  const keys = groups.flatMap((g) => g.items.map((i) => i.key));
  if (keys.length === 0) return <Navigate to="/settings" replace />;
  const tab = keys.includes(params.get('tab')) ? params.get('tab') : keys[0];

  let pane;
  if (PANES[tab]) {
    const Page = PANE_PAGES[tab];
    pane = (
      <>
        <SettingsPaneHead title={PANES[tab].title} desc={PANES[tab].desc} />
        {/* หน้าเดิมทั้งหน้าฝังในแผงขวา — CSS .set-embed ปรับให้พอดีความกว้างแผง */}
        <div className="set-embed">
          <Suspense fallback={<p className="muted">กำลังโหลด…</p>}>
            <Page />
          </Suspense>
        </div>
      </>
    );
  } else {
    pane = <CategoryManager key={tab} domain={tab} />;
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ตั้งค่าระบบ</h1>
        </div>
      </header>
      <SettingsShell groups={groups} active={tab} label="ตั้งค่าระบบ"
        onSelect={(k) => setParams({ tab: k }, { replace: true })}>
        {pane}
      </SettingsShell>
    </>
  );
}
