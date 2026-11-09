import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import CaseReports from '../components/CaseReports.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import { todayTH } from '../labels.js';
import { caseCode } from '../lib/patientCode.js';
import SearchSelect from '../components/SearchSelect.jsx';

const CLOSED = ['closed', 'cancelled'];

/**
 * เมนู "รายงานของฉัน" ของพนักงานหน้างาน — เลือกเคสแล้วดูรายงานทั้งหมดของเคสนั้น
 * ลงรายงานย้อนหลังของกะที่ผ่านมา และแก้ใบที่ตัวเองบันทึกได้ในที่เดียว
 * (รายงานของกะวันนี้ยังบันทึกจากหน้า "งานวันนี้" ได้ตามเดิม)
 */
export default function MyReportsPage() {
  const me = useAuth()?.user?.employee_id ?? null;
  const [cases, setCases] = useState(null);
  const [caseId, setCaseId] = useState('');
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadCases = useCallback(() => {
    setLoading(true);
    return api
      .myCases()
      .then((list) => {
        setCases(list);
        // ค่าปริยาย = เคสที่ยังเปิดอยู่เคสแรก ไม่มีก็เคสแรกของรายการ
        setCaseId((cur) => cur || (list.find((c) => !CLOSED.includes(c.status)) ?? list[0])?.case_id || '');
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadCases(); }, [loadCases]);

  const loadCase = useCallback(() => {
    if (!caseId) return Promise.resolve();
    return api.myCase(caseId).then(setItem).catch((e) => setError(e.message));
  }, [caseId]);

  useEffect(() => {
    setItem(null);
    loadCase();
  }, [loadCase]);

  const closed = item ? CLOSED.includes(item.status) : true;
  const today = todayTH();
  const backfillVisits = item && !closed
    ? item.visits.filter((v) => v.assigned_to === me && v.visit_date <= today && v.status !== 'cancelled').reverse()
    : [];

  return (
    <PageRefresh onRefresh={() => Promise.all([loadCases(), loadCase()])} busy={loading}>
      {/* ไม่มีหัวหน้าบนจอ — ช่องเลือกเคสเป็นหัวการ์ด รายงานของเคสอยู่ในการ์ดใบเดียวกัน · h1 คงไว้ให้โปรแกรมอ่านหน้าจอ */}
      <h1 className="sr-only">รายงานของฉัน</h1>

      <ErrorBar message={error} onRetry={loadCases} busy={loading} />

      {!cases ? (
        !error && <p className="muted">กำลังโหลด…</p>
      ) : cases.length === 0 ? (
        <section className="card empty-state my-card">
          <p>ยังไม่มีเคสที่คุณรับผิดชอบ</p>
          <p className="muted">เมื่อผู้จัดการจับคู่เคสให้คุณ รายงานของเคสจะปรากฏที่นี่</p>
        </section>
      ) : (
        <section className="card my-card my-reports">
          <label className="my-reports-pick">
            <span>เลือกเคส</span>
            <SearchSelect value={caseId} onChange={(e) => setCaseId(e.target.value)}>
              {cases.map((c) => (
                <option key={c.case_id} value={c.case_id}>
                  {caseCode(c.case_id)} · {c.client_name}{CLOSED.includes(c.status) ? ' (จบแล้ว)' : ''}
                </option>
              ))}
            </SearchSelect>
            <small className="muted">ดูรายงานอาการของเคส · ลงย้อนหลังและแก้ไขรายงานของคุณได้ที่นี่</small>
          </label>

          {!item ? (
            <p className="muted my-reports-loading">กำลังโหลด…</p>
          ) : (
            <div className="my-reports-body">
              <CaseReports
                key={item.case_id}
                caseId={item.case_id}
                caseInfo={item}
                scope="my"
                currentEmployeeId={me}
                readOnly={closed}
                allowAdd={false}
                backfillVisits={backfillVisits.length > 0 ? backfillVisits : null}
                archiveTitle={item.client_name}
              />
            </div>
          )}
        </section>
      )}
    </PageRefresh>
  );
}
