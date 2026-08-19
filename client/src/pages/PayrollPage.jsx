import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { Approvals, PayoutSummary } from '../components/PayrollTabs.jsx';
import { thisMonth as currentMonth } from '../lib/attendanceUi.js';
import { formatBaht, formatDate, durationText, todayTH } from '../labels.js';
import PageRefresh from '../components/PageRefresh.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import LineIcon from '../components/LineIcon.jsx';

/** ป้ายสถานะรอบ — ใช้สีชุดเดียวกับใบแจ้งหนี้ (ร่าง/จ่ายแล้ว/ยกเลิก มีความหมายเดียวกัน) */
const STATUS = {
  draft: { label: 'ร่าง', className: 'invoice-draft' },
  paid: { label: 'จ่ายแล้ว', className: 'invoice-paid' },
  cancelled: { label: 'ยกเลิก', className: 'invoice-cancelled' },
};

const thisMonth = () => todayTH().slice(0, 7);

/**
 * วันตัดรอบที่แนะนำตามจำนวนรอบที่เลือกจ่ายในเดือนนั้น
 * เป็นแค่ค่าเริ่มต้นให้กดน้อยลง — แก้เป็นวันไหนก็ได้ เพราะรอบไม่ได้ผูกกับช่วงวันตายตัว
 */
function suggestCutoff(month, roundNo) {
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const day = roundNo === 1 ? 15 : lastDay;
  return `${month}-${String(day).padStart(2, '0')}`;
}

const total = (rows, field) => rows.reduce((sum, r) => sum + Number(r[field] ?? 0), 0);

/**
 * แท็บ "รอบจ่าย" — เปิดรอบ / ตรวจ / จ่าย / ประวัติรอบ
 *
 * รอบ = ตะกร้าของกะที่อนุมัติแล้วและยังไม่เคยถูกจ่าย โดยมีวันตัดรอบเป็นเพดาน ไม่มีขอบล่าง
 * กะที่อนุมัติช้าจึงถูกกวาดเข้ารอบถัดไปเสมอ ไม่ตกหล่น (ดู ELIGIBLE ใน server/src/payroll/repo.js)
 */
function Runs({ reloadKey }) {
  const toast = useToast();

  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // ฟอร์มเปิดรอบ — เปิดค้างไว้ไม่ได้รบกวนใคร เพราะพรีวิวคือข้อมูลที่อยากรู้อยู่แล้ว
  const [opening, setOpening] = useState(false);
  const [form, setForm] = useState({ period_month: thisMonth(), round_no: 1, period_to: '' });
  const [preview, setPreview] = useState(null);

  const [openRunId, setOpenRunId] = useState(null); // รอบที่กางดูรายละเอียดอยู่
  const [detail, setDetail] = useState(null);
  const [payForm, setPayForm] = useState(null);     // null = ยังไม่ได้กดจ่าย

  const load = useCallback(
    () =>
      api
        .listPayrollRuns()
        .then((v) => { setRuns(v); setError(null); })
        .catch((e) => setError(e.message)),
    [],
  );

  useEffect(() => { load(); }, [load, reloadKey]);

  /* พรีวิวเปลี่ยนตามวันตัดรอบทันที — ตัวเลขที่ใช้ตัดสินใจว่าจะปิดรอบวันไหน
     ต้องเห็นก่อนกด ไม่ใช่กดสร้างแล้วค่อยมาดูว่าได้ใครมาบ้าง */
  useEffect(() => {
    if (!opening || !form.period_to) return setPreview(null);
    let cancelled = false;
    api
      .payrollPreview(form.period_to)
      .then((v) => !cancelled && setPreview(v))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [opening, form.period_to]);

  const openForm = () => {
    const month = thisMonth();
    setForm({ period_month: month, round_no: 1, period_to: suggestCutoff(month, 1) });
    setOpening(true);
  };

  const setField = (key, value) =>
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // เปลี่ยนเดือน/รอบ = ขยับวันตัดรอบให้ตามไปด้วย (แก้เองทับได้เสมอ)
      if (key !== 'period_to') next.period_to = suggestCutoff(next.period_month, Number(next.round_no));
      return next;
    });

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const collapse = () => {
    setOpenRunId(null);
    setDetail(null);
    setPayForm(null);
  };

  /* แตะแถวเดิมซ้ำ = ย่อกลับ — แถวที่กางอยู่แล้วไม่มีอะไรให้กดเปิดอีก
     การกดซ้ำจึงตีความได้ทางเดียวว่าอยากปิด (ปุ่ม "ย่อ" ในหัวรายละเอียดยังอยู่ตามเดิม
     สำหรับตอนที่เลื่อนลงไปไกลจนแถวหลุดจอ) */
  const toggleDetail = (runId) => {
    if (openRunId === runId) return collapse();
    return run(async () => {
      const v = await api.getPayrollRun(runId);
      setDetail(v);
      setOpenRunId(runId);
      setPayForm(null);
    });
  };

  const refreshDetail = async (runId) => setDetail(await api.getPayrollRun(runId));

  return (
    <>
      <div className="att-filter">
        <p className="muted tab-hint">
          เดือนหนึ่งแบ่งจ่ายได้ 1–3 รอบ · แต่ละรอบกวาด <strong>กะที่อนุมัติแล้วและยังไม่เคยจ่าย</strong>{' '}
          เข้ามาให้เอง กะที่อนุมัติช้าจึงไปโผล่รอบถัดไปเสมอ
        </p>
        {!opening && <button className="btn primary" onClick={openForm}>+ เปิดรอบจ่าย</button>}
      </div>

      {error && <p className="error">{error}</p>}

      {/* ---------- เปิดรอบใหม่ ---------- */}
      {opening && (
        <section className="notice payroll-open">
          <h3>เปิดรอบจ่าย</h3>

          <div className="grid">
            <label>เดือนของรอบ
              <input
                type="month"
                value={form.period_month}
                onChange={(e) => setField('period_month', e.target.value)}
              />
            </label>
            <label>รอบที่
              <select value={form.round_no} onChange={(e) => setField('round_no', Number(e.target.value))}>
                <option value={1}>รอบที่ 1</option>
                <option value={2}>รอบที่ 2</option>
                <option value={3}>รอบที่ 3</option>
              </select>
            </label>
            <label>วันตัดรอบ
              <input
                type="date"
                value={form.period_to}
                max={todayTH()}
                onChange={(e) => setField('period_to', e.target.value)}
              />
            </label>
          </div>

          <p className="muted">
            กะที่ทำถึงวันที่ <strong>{form.period_to ? formatDate(form.period_to) : '—'}</strong> และอนุมัติแล้ว
            จะถูกกวาดเข้ารอบนี้ทั้งหมด รวมกะเก่าที่ยังไม่เคยจ่าย
          </p>

          {preview && (
            <>
              {preview.unpriced_shifts > 0 && (
                <p className="stale-tag">
                  <LineIcon name="alert" className="text-ico" />
                  มี {preview.unpriced_shifts} กะที่อนุมัติแล้วแต่ยังไม่ได้ตั้งค่าจ้าง — ยังไม่ถูกรวมในรอบนี้
                </p>
              )}

              {preview.rows.length === 0 ? (
                <p className="muted">ไม่มีกะที่พร้อมจ่ายถึงวันที่เลือก</p>
              ) : (
                <>
                  {/* ยอดรวมอยู่เหนือรายชื่อ ไม่ใช่ท้ายตาราง — ทีมมีพนักงานกี่คนก็ตาม
                      ตัวเลขที่ใช้ตัดสินใจต้องเห็นทันทีโดยไม่ต้องเลื่อนผ่านทุกคนก่อน */}
                  <p className="payroll-sum">
                    รวม <strong>{preview.rows.length} คน</strong>
                    {' · '}{total(preview.rows, 'shifts')} กะ
                    {' · '}<strong>{formatBaht(total(preview.rows, 'total_pay'))}</strong>
                  </p>

                  {/* รายชื่อเลื่อนในกล่องตัวเอง — ปุ่ม "เปิดรอบนี้" จึงอยู่ในระยะที่กดถึงเสมอ
                      แม้จะมีพนักงานสามสิบคน (ของเดิมเป็นตารางที่ยืดยาวไปเรื่อยๆ ดันปุ่มตกจอ) */}
                  <div className="payroll-people">
                    {preview.rows.map((r) => (
                      <div className="history-item" key={r.employee_id}>
                        <div>
                          <strong>{r.employee_name}</strong>
                          <p className="muted">
                            {r.shifts} กะ · เก่าสุด {formatDate(r.oldest_shift_date)}
                          </p>
                        </div>
                        <strong>{formatBaht(r.total_pay)}</strong>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          <div className="quick-edit-actions">
            <button className="btn" onClick={() => { setOpening(false); setPreview(null); }}>ยกเลิก</button>
            <button
              className="btn primary"
              disabled={busy || !preview || preview.rows.length === 0}
              onClick={() =>
                run(async () => {
                  const created = await api.createPayrollRun(form);
                  toast(`เปิดรอบ ${created.run_id} แล้ว`);
                  setOpening(false);
                  setPreview(null);
                  setDetail(created);
                  setOpenRunId(created.run_id);
                })
              }
            >
              เปิดรอบนี้
            </button>
          </div>
        </section>
      )}

      {/* ---------- รายการรอบ ---------- */}
      {!runs ? (
        <p className="muted">กำลังโหลด…</p>
      ) : runs.length === 0 ? (
        <p className="muted">ยังไม่มีรอบจ่าย — กด “เปิดรอบจ่าย” เพื่อเริ่มรอบแรก</p>
      ) : (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr>
                <th>รอบ</th><th>วันตัดรอบ</th><th>สถานะ</th>
                <th>พนักงาน</th><th>กะ</th><th>ยอดรวม</th><th>วันที่จ่าย</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.run_id}
                  className={`is-tappable ${openRunId === r.run_id ? 'is-picked' : ''}`}
                  onClick={() => toggleDetail(r.run_id)}
                >
                  <td data-label="รอบ">
                    <span className="mono">{r.run_id}</span>
                    <span className="cell-sub">{r.period_month} · รอบที่ {r.round_no}</span>
                  </td>
                  <td data-label="วันตัดรอบ">{formatDate(r.period_to)}</td>
                  <td data-label="สถานะ">
                    <span className={`badge ${STATUS[r.status].className}`}>{STATUS[r.status].label}</span>
                  </td>
                  <td data-label="พนักงาน">{r.employees}</td>
                  <td data-label="กะ">{r.shifts}</td>
                  <td data-label="ยอดรวม">{formatBaht(r.total_pay)}</td>
                  <td data-label="วันที่จ่าย">{r.pay_date ? formatDate(r.pay_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- รายละเอียดรอบที่เลือก ---------- */}
      {detail && openRunId === detail.run_id && (
        <section className="notice payroll-detail">
          <header className="section-head">
            <h3>
              <span className="mono">{detail.run_id}</span> · {detail.period_month} รอบที่ {detail.round_no}
              {' '}
              <span className={`badge ${STATUS[detail.status].className}`}>{STATUS[detail.status].label}</span>
            </h3>
            <button className="btn" onClick={collapse}>ย่อ</button>
          </header>

          <p className="muted">
            ตัดรอบที่ {formatDate(detail.period_to)} · {detail.employees} คน · {detail.shifts} กะ ·
            {' '}<strong>{formatBaht(detail.total_pay)}</strong>
            {detail.status === 'paid' && detail.pay_date && ` · จ่ายเมื่อ ${formatDate(detail.pay_date)}`}
            {detail.method && ` · ${detail.method}`}
          </p>

          {detail.items.length === 0 ? (
            <p className="muted">ไม่มีใครอยู่ในรอบนี้แล้ว</p>
          ) : (
            <div className="payroll-people">
              {detail.items.map((i) => (
                <div className="history-item" key={i.item_id}>
                  <div>
                    <strong>{i.employee_name}</strong>
                    <p className="muted">{i.shifts} กะ · {durationText(i.minutes)}</p>
                  </div>
                  <div className="payroll-people-end">
                    <strong>{formatBaht(i.total_pay)}</strong>
                    {detail.status === 'draft' && (
                      <ConfirmButton
                        className="btn tiny danger-ghost"
                        disabled={busy}
                        title={`เอา ${i.employee_name} ออกจากรอบนี้?`}
                        detail="กะของเขาจะกลับเข้ากองรอจ่าย แล้วไปโผล่ในรอบถัดไปเอง — ไม่ใช่การตัดสิทธิ์"
                        confirmLabel="เอาออกจากรอบ"
                        onConfirm={() =>
                          run(async () => {
                            await api.removePayrollItem(detail.run_id, i.item_id);
                            await refreshDetail(detail.run_id);
                          })
                        }
                      >
                        เอาออก
                      </ConfirmButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ฟอร์มจ่าย — ทำเป็นฟอร์มในหน้า ไม่ใช่ prompt() ตามแนวเดียวกับฟอร์มรับชำระของใบแจ้งหนี้ */}
          {payForm && (
            <div className="grid cols-2 payroll-pay">
              <label>วันที่จ่าย
                <input
                  type="date"
                  value={payForm.pay_date}
                  onChange={(e) => setPayForm({ ...payForm, pay_date: e.target.value })}
                />
              </label>
              <label>ช่องทาง
                <input
                  type="text"
                  placeholder="เช่น โอน, เงินสด"
                  value={payForm.method}
                  onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}
                />
              </label>
            </div>
          )}

          {/* เรียงเป็นคู่: แถวบน = ทำต่อกับรอบ · แถวล่าง = เลิกกับรอบ
              ปุ่มทำลายอยู่ท้ายสุดเสมอ ห่างจากปุ่มที่กดกันจริงที่สุดเท่าที่กริดจะทำได้ */}
          <div className="payroll-actions">
            {detail.status === 'draft' && (
              <>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const v = await api.rebuildPayrollRun(detail.run_id);
                      setDetail(v);
                      toast('ดึงกะใหม่แล้ว');
                    })
                  }
                >
                  ดึงกะใหม่
                </button>

                {payForm ? (
                  <button
                    className="btn primary"
                    disabled={busy || !payForm.pay_date}
                    onClick={() =>
                      run(async () => {
                        const v = await api.payPayrollRun(detail.run_id, payForm);
                        setDetail(v);
                        setPayForm(null);
                        toast(`ปิดรอบ ${v.run_id} เป็นจ่ายแล้ว`);
                      })
                    }
                  >
                    ยืนยันการจ่าย
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    disabled={busy || detail.employees === 0}
                    onClick={() => setPayForm({ pay_date: todayTH(), method: '' })}
                  >
                    บันทึกการจ่าย
                  </button>
                )}
              </>
            )}

            {detail.status !== 'cancelled' && (
              <ConfirmButton
                className="btn"
                disabled={busy}
                title={`ยกเลิกรอบ ${detail.run_id}?`}
                detail="รอบยังอยู่เป็นประวัติ แต่กะทั้งหมดจะกลับเข้ากองรอจ่าย แล้วไปโผล่ในรอบถัดไป"
                confirmLabel="ยกเลิกรอบ"
                cancelLabel="ไม่ยกเลิกแล้ว"
                onConfirm={() =>
                  run(async () => {
                    const v = await api.cancelPayrollRun(detail.run_id);
                    setDetail(v);
                    toast(`ยกเลิกรอบ ${v.run_id} แล้ว`);
                  })
                }
              >
                ยกเลิกรอบ
              </ConfirmButton>
            )}

            {detail.status === 'draft' && (
                <ConfirmButton
                  className="btn danger-ghost"
                  disabled={busy}
                  title={`ลบรอบ ${detail.run_id} ทิ้งถาวร?`}
                  detail="ลบแล้วกู้คืนไม่ได้ และเลขที่รอบจะข้าม — กะทั้งหมดกลับเข้ากองรอจ่าย"
                  confirmLabel="ลบถาวร"
                  onConfirm={() =>
                    run(async () => {
                      await api.deletePayrollRun(detail.run_id);
                      toast(`ลบรอบ ${detail.run_id} แล้ว`);
                      setOpenRunId(null);
                      setDetail(null);
                    })
                  }
                >
                  ลบรอบนี้
                </ConfirmButton>
            )}
          </div>
        </section>
      )}
    </>
  );
}

/* ทั้งสามแท็บคือสายพานเดียวกันของ "เงินที่ต้องจ่ายพนักงาน" เรียงตามลำดับที่ทำจริง:
     รออนุมัติ  → กะที่ทำจบแล้วแต่ยังไม่เป็นเงิน จนกว่าผู้จัดการจะกดอนุมัติ
     รอบจ่าย    → รวมกะที่อนุมัติแล้วเป็นรอบ แล้วจ่ายออกจริง
     สรุป       → ยอดรายเดือนต่อคน ไว้ตรวจย้อนหลัง/ส่งบัญชี
   สองแท็บแรกเคยอยู่หน้า "การมาทำงาน" ซึ่งทำให้เรื่องเงินกระจายอยู่สองหน้าโดยไม่มีเหตุผล */
const TABS = {
  approvals: 'รออนุมัติค่าจ้าง',
  runs: 'รอบจ่าย',
  summary: 'สรุปค่าตอบแทน',
};

export default function PayrollPage() {
  const [params, setParams] = useSearchParams();
  const [staff, setStaff] = useState([]);
  /* ตัวนับสั่งโหลดใหม่ระดับหน้า — แต่ละแท็บโหลดข้อมูลเอง หน้าแม่สั่งตรงไม่ได้
     (กติกาเดียวกับหน้าการมาทำงาน ซึ่งสองแท็บนี้ย้ายมาจากที่นั่น) */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.assignableEmployees().then(setStaff).catch(() => {});
  }, []);

  const get = (key) => params.get(key) ?? '';
  const tab = TABS[get('tab')] ? get('tab') : 'runs';
  const employeeId = get('employee_id');
  /* ทุกแท็บเปิดมาที่เดือนปัจจุบัน — เดิมแท็บสรุปถอยไปเดือนที่แล้วให้เอง
     ซึ่งอ่านแล้วเหมือนระบบไม่มีข้อมูล ("เดือนนี้ยังไม่มีการเช็คอิน") ทั้งที่เปิดมาผิดเดือนเอง
     อยากดูเดือนที่แล้วกดลูกศรถอยทีเดียวก็ถึง */
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(get('month')) ? get('month') : currentMonth();

  const patch = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === '' || value == null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const employeePicker = (
    <select value={employeeId} onChange={(e) => patch({ employee_id: e.target.value })} aria-label="พนักงาน">
      <option value="">พนักงานทุกคน</option>
      {staff.map((e) => (
        <option key={e.employee_id} value={e.employee_id}>{e.first_name} {e.last_name}</option>
      ))}
    </select>
  );

  return (
    <PageRefresh onRefresh={() => setReloadKey((k) => k + 1)}>
      <header className="page-head">
        <div>
          <h1>ค่าตอบแทนพนักงาน</h1>
          <p className="muted">อนุมัติค่าจ้างรายกะ · รวมเป็นรอบแล้วจ่าย · สรุปยอดรายเดือน</p>
        </div>
      </header>

      <div className="att-tabs" role="tablist" aria-label="มุมมองค่าตอบแทน">
        {Object.entries(TABS).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`att-tab ${tab === key ? 'is-active' : ''}`}
            onClick={() => patch({ tab: key === 'runs' ? '' : key })}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'runs' && <Runs reloadKey={reloadKey} />}
      {tab === 'approvals' && (
        <Approvals
          month={month}
          employeeId={employeeId}
          patch={patch}
          employeePicker={employeePicker}
          reloadKey={reloadKey}
        />
      )}
      {tab === 'summary' && (
        <PayoutSummary
          month={month}
          employeeId={employeeId}
          patch={patch}
          employeePicker={employeePicker}
          reloadKey={reloadKey}
        />
      )}
    </PageRefresh>
  );
}
