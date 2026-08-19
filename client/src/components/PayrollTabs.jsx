import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { formatBaht, formatDate, timeText, durationText } from '../labels.js';
import LineIcon from './LineIcon.jsx';
import MonthPicker from './MonthPicker.jsx';
import { downloadCsv, LATE_MINUTES } from '../lib/attendanceUi.js';

/**
 * สองแท็บของหน้า "รอบจ่ายค่าตอบแทน" ที่ย้ายมาจากหน้า "การมาทำงาน"
 *
 * ย้ายมาเพราะทั้งคู่เป็นเรื่องเงินล้วนๆ ไม่ใช่เรื่องการเข้า–ออกงาน:
 * คิวอนุมัติคือประตูที่ทำให้กะกลายเป็นเงิน ส่วนสรุปคือยอดที่ต้องจ่าย
 * ทั้งสองอย่างอยู่ก่อนหน้า "เปิดรอบจ่าย" ในสายพานเดียวกัน จึงควรอยู่หน้าเดียวกัน
 */

/**
 * คิวอนุมัติค่าจ้าง — กะที่ทำงานจบแล้วแต่เงินยังไม่เข้าพนักงานจนกว่าจะกดอนุมัติที่นี่
 *
 * ต้องเลือกทีละหลายกะได้ เพราะเดือนหนึ่งมีหลักร้อยกะ ถ้าให้กดทีละใบจะไม่มีใครทำ
 * แต่ต้องเห็น "ธงที่ต้องดู" ของแต่ละกะก่อนกดด้วย (นอกพื้นที่/สาย/ทำงาน 0 นาที)
 * ไม่งั้นปุ่มอนุมัติทั้งหมดจะกลายเป็นตรายางที่ไม่มีใครอ่านอะไรเลย
 */
export function Approvals({ month, employeeId, patch, employeePicker, reloadKey }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .pendingApprovals({ month, employee_id: employeeId || undefined })
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setPicked(new Set());  // เปลี่ยนตัวกรองแล้วสิ่งที่ติ๊กไว้ไม่เกี่ยวข้องอีกต่อไป
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [month, employeeId, reloadKey]);

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allPicked = rows?.length > 0 && picked.size === rows.length;
  const pickedRows = rows?.filter((v) => picked.has(v.visit_id)) ?? [];
  const pickedTotal = pickedRows.reduce((s, v) => s + (v.pay ?? 0), 0);

  async function decide(approve) {
    const ids = [...picked];
    if (ids.length === 0) return;

    let reason = null;
    if (!approve) {
      // ไม่อนุมัติต้องมีเหตุผลเสมอ — เป็นสิ่งเดียวที่พนักงานจะได้รู้ว่าทำไมกะนั้นไม่ได้เงิน
      reason = prompt(`ไม่อนุมัติ ${ids.length} กะ — เหตุผล (พนักงานจะเห็นข้อความนี้)`);
      if (!reason?.trim()) return;
    } else if (!confirm(`อนุมัติค่าจ้าง ${ids.length} กะ รวม ${formatBaht(pickedTotal)}?`)) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { changed } = await api.decidePay(ids, approve, reason?.trim() ?? null);
      toast(`${approve ? 'อนุมัติ' : 'ไม่อนุมัติ'} ${changed} กะแล้ว`);
      setRows((prev) => prev.filter((v) => !picked.has(v.visit_id)));
      setPicked(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** ธงที่ทำให้กะนี้ควรถูกดูก่อนอนุมัติ — ไม่มีเลย = กะปกติ */
  const flags = (v) =>
    [
      v.location_flagged && 'นอกพื้นที่',
      v.off_schedule && 'นอกวันนัด',
      v.check_in_late_minutes > LATE_MINUTES && `สาย ${durationText(v.check_in_late_minutes)}`,
      v.worked_minutes === 0 && 'ทำงาน 0 นาที',
      v.pay == null && 'ยังไม่ระบุค่าจ้าง',
    ].filter(Boolean);

  const total = rows?.reduce((s, v) => s + (v.pay ?? 0), 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>{employeePicker}</MonthPicker>

      <p className="muted tab-hint">
        กะที่เช็คเอาท์แล้วยัง<strong>ไม่เป็นเงิน</strong>จนกว่าจะอนุมัติที่นี่ · <strong>แตะที่แถวเพื่อเลือก</strong>
      </p>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : rows?.length === 0 ? (
        <section className="card empty-state">
          <p><LineIcon name="check" className="text-ico" />ไม่มีกะรออนุมัติ</p>
          <p className="muted">ค่าจ้างของเดือนนี้ยืนยันครบแล้ว</p>
        </section>
      ) : rows?.length > 0 ? (
        <>
          {/* ปุ่มเลือกทั้งหมดต้องอยู่นอกหัวตาราง — จอแคบหัวตารางถูกซ่อน (แถวกลายเป็นการ์ด)
              ถ้าฝากไว้ในหัวตารางอย่างเดียว บนมือถือจะไม่มีทางเลือกทั้งหมดได้เลย */}
          {/* att-presets — ระยะห่างของแถวนี้เมื่อยืนเดี่ยวๆ ในหน้า ไม่ใช่ตอนอยู่ติดใต้ปฏิทินในโมดัลลงกะ
              ที่นั่นมันเกาะกับปฏิทินโดยตั้งใจ ที่นี่มันถูกขนาบด้วยข้อความอธิบายกับการ์ดกะจนดูอัดกัน */}
          <div className="pick-presets att-presets">
            <button
              className="btn tiny"
              disabled={busy}
              onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((v) => v.visit_id)))}
            >
              {allPicked ? 'ล้างที่เลือก' : `เลือกทั้งหมด (${rows.length})`}
            </button>
            {picked.size > 0 && !allPicked && <span className="muted">เลือกไว้ {picked.size} กะ</span>}
          </div>

          <div className="table-wrap">
            <table className="table table-cards table-2line">
              <thead>
                <tr>
                  <th className="col-check" aria-label="เลือก" />
                  <th>วันที่</th>
                  <th>พนักงาน / เคส</th>
                  <th>เข้า–ออก</th>
                  <th>รวม</th>
                  <th>ค่าจ้าง</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  /* ทั้งแถวคือปุ่มเลือก — เล็งช่องติ๊กเล็กๆ บนมือถือยากและพลาดง่าย
                     ช่องติ๊กเหลือไว้เป็นตัวบอกสถานะอย่างเดียว (pointer-events ปิดใน CSS)
                     จึงไม่เกิดการสลับสองครั้งเมื่อแตะโดนช่องติ๊กพอดี */
                  <tr
                    key={v.visit_id}
                    className={`is-tappable ${picked.has(v.visit_id) ? 'is-picked' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={picked.has(v.visit_id)}
                    aria-label={`กะวันที่ ${v.visit_date} ของ ${v.employee_name}`}
                    onClick={() => toggle(v.visit_id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault(); // เว้นวรรคบนแถวที่โฟกัสอยู่ = เลือก ไม่ใช่เลื่อนหน้า
                      toggle(v.visit_id);
                    }}
                  >
                    <td data-label="เลือก" className="col-check">
                      <input
                        type="checkbox"
                        checked={picked.has(v.visit_id)}
                        readOnly
                        tabIndex={-1}
                        aria-hidden="true"
                      />
                    </td>
                    <td data-label="วันที่">{formatDate(v.visit_date)}</td>
                    <td data-label="พนักงาน / เคส">
                      {v.employee_name}
                      <span className="cell-sub">
                        {v.client_name} ·{' '}
                        {/* ลิงก์ไปเปิดเคส — ต้องไม่ถูกนับเป็นการเลือกแถวไปด้วย */}
                        <Link
                          className="link mono"
                          to={`/cases?open=${v.case_id}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {v.case_id}
                        </Link>
                      </span>
                    </td>
                    <td data-label="เข้า–ออก">
                      {timeText(v.check_in_at)} – {timeText(v.check_out_at)}
                      {flags(v).length > 0 && <span className="cell-sub flag-text">{flags(v).join(' · ')}</span>}
                    </td>
                    <td data-label="รวม">{durationText(v.worked_minutes)}</td>
                    <td data-label="ค่าจ้าง">
                      {v.pay == null ? <span className="muted">—</span> : formatBaht(v.pay)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th />
                  <th data-label="รวม">{rows.length} กะ</th>
                  <th />
                  <th />
                  <th />
                  <th data-label="ค่าจ้างรวม">{formatBaht(total)}</th>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* แถบยืนยันติดขอบล่าง — ติ๊กมา 40 กะแล้วต้องเลื่อนกลับขึ้นไปหาปุ่มคือคนละเรื่องกัน */}
          {picked.size > 0 && (
            <div className="approve-bar">
              <p className="pick-count">
                เลือกไว้ <strong>{picked.size}</strong> กะ · รวม <strong>{formatBaht(pickedTotal)}</strong>
              </p>
              <div className="pick-actions">
                <button className="btn primary" disabled={busy} onClick={() => decide(true)}>
                  อนุมัติ {picked.size} กะ
                </button>
                <button className="btn danger-ghost" disabled={busy} onClick={() => decide(false)}>
                  ไม่อนุมัติ
                </button>
                <button className="btn" disabled={busy} onClick={() => setPicked(new Set())}>ล้าง</button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

export function PayoutSummary({ month, employeeId, patch, employeePicker, reloadKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .attendanceReport(month, employeeId || undefined)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [month, employeeId, reloadKey]);

  function exportCsv() {
    downloadCsv(
      // ใส่รหัสพนักงานในชื่อไฟล์ตอนกรองคนเดียว — ไม่งั้นไฟล์ของคนละคนทับกันในโฟลเดอร์ดาวน์โหลด
      `payroll-${month}${employeeId ? `-${employeeId}` : ''}.csv`,
      ['รหัสพนักงาน', 'ชื่อ', 'จำนวนกะ', 'ชั่วโมงรวม', 'เคสที่ทำ', 'ค่าจ้างที่อนุมัติแล้ว (บาท)',
        'จ่ายไปแล้ว (บาท)', 'ยังไม่ได้จ่าย (บาท)',
        'กะที่อนุมัติแล้ว', 'รออนุมัติ (บาท)', 'กะที่รออนุมัติ', 'กะที่ไม่อนุมัติ', 'กะที่ยังไม่ระบุค่าจ้าง'],
      rows.map((r) => [
        r.employee_id, r.employee_name, r.shifts, (r.minutes / 60).toFixed(1), r.cases_worked, r.pay,
        r.paid_pay ?? 0, r.unpaid_pay ?? 0,
        r.approved_shifts, r.pending_pay, r.pending_shifts, r.rejected_shifts, r.unpriced_shifts,
      ]),
    );
  }

  const totalShifts = rows?.reduce((s, r) => s + r.shifts, 0) ?? 0;
  const totalMinutes = rows?.reduce((s, r) => s + r.minutes, 0) ?? 0;
  const totalPay = rows?.reduce((s, r) => s + r.pay, 0) ?? 0;
  const totalPending = rows?.reduce((s, r) => s + r.pending_pay, 0) ?? 0;
  const totalUnpaid = rows?.reduce((s, r) => s + (r.unpaid_pay ?? 0), 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>
        {employeePicker}
        {rows?.length > 0 && <button className="btn" onClick={exportCsv}><LineIcon name="download" />ดาวน์โหลด CSV</button>}
      </MonthPicker>

      {/* แท็บนี้กับแท็บรอบจ่ายนับคนละแกน ตัวเลขจึงไม่เท่ากันเป็นปกติ —
          ไม่เขียนไว้ คนอ่านจะคิดว่ามีแท็บใดแท็บหนึ่งคำนวณผิด แล้วไปไล่หาบั๊กที่ไม่มีอยู่ */}
      <p className="muted tab-hint">
        นับเฉพาะกะที่อนุมัติแล้วใน<strong>เดือนที่ไปทำงาน</strong> ไม่ว่าจะจ่ายไปหรือยัง ·
        เงินที่ออกจริงดูที่แท็บ <Link className="link" to="/payroll">รอบจ่าย</Link>{' '}
        ซึ่งนับ<strong>ตามรอบ</strong> — ตัวเลขสองที่จึงต่างกันเป็นปกติ
      </p>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : !error && rows?.length === 0 ? (
        // บอกให้ชัดว่าว่างเพราะ "ไม่มีใครเช็คอิน" หรือเพราะ "คนที่กรองไว้ไม่ได้เช็คอิน" — ไม่งั้นเข้าใจว่าข้อมูลหาย
        <section className="card empty-state">
          <p>{employeeId ? 'เดือนนี้พนักงานคนนี้ยังไม่มีการเช็คอิน' : 'เดือนนี้ยังไม่มีการเช็คอิน'}</p>
        </section>
      ) : rows?.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>พนักงาน</th><th>จำนวนกะ</th><th>ชั่วโมงรวม</th><th>รออนุมัติ</th><th>ค่าจ้างรวม</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee_id}>
                  <td data-label="พนักงาน">{r.employee_name}<span className="cell-sub mono">{r.employee_id}</span></td>
                  <td data-label="จำนวนกะ">
                    {r.shifts}
                    <span className="cell-sub">{r.cases_worked} เคส</span>
                  </td>
                  <td data-label="ชั่วโมงรวม">{durationText(r.minutes)}</td>
                  {/* เงินที่ค้างอยู่ที่โต๊ะผู้จัดการเอง ไม่ใช่ปัญหาของพนักงาน — กดไปที่คิวอนุมัติได้เลย */}
                  <td data-label="รออนุมัติ">
                    {r.pending_shifts > 0 ? (
                      <Link className="link" to={`/payroll?tab=approvals&month=${month}&employee_id=${r.employee_id}`}>
                        {formatBaht(r.pending_pay)}
                        <span className="cell-sub">{r.pending_shifts} กะ →</span>
                      </Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="ค่าจ้างรวม">
                    {formatBaht(r.pay)}
                    {/* อนุมัติแล้วยังไม่ใช่ได้เงิน — เงินออกตอนรอบจ่ายถูกปิด
                        ไม่แยกให้เห็น ผู้จัดการจะอ่านยอดนี้ว่า "จ่ายไปแล้ว" ทั้งก้อน */}
                    {(r.unpaid_pay ?? 0) > 0 && (
                      <span className="cell-sub">รอจ่าย {formatBaht(r.unpaid_pay)}</span>
                    )}
                    {(r.paid_pay ?? 0) > 0 && (r.unpaid_pay ?? 0) === 0 && (
                      <span className="cell-sub">จ่ายครบแล้ว</span>
                    )}
                    {/* กดไปหาเคสของคนนี้ได้เลย — เดิมรู้ว่ามีปัญหาแต่ไม่รู้ว่าเคสไหน */}
                    {r.unpriced_shifts > 0 && (
                      <span className="cell-sub">
                        <Link className="link flag-text" to={`/cases?assigned_to=${r.employee_id}`}>
                          {r.unpriced_shifts} กะยังไม่ระบุค่าจ้าง →
                        </Link>
                      </span>
                    )}
                    {r.rejected_shifts > 0 && (
                      <span className="cell-sub flag-text">ไม่อนุมัติ {r.rejected_shifts} กะ</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {/* data-label ไม่ได้มีไว้แค่สวย — จอเล็กหัวตารางถูกซ่อน แถวรวมที่เหลือแต่ตัวเลขเปล่าๆ
                จะอ่านไม่ออกว่าเลขไหนคืออะไร */}
            <tfoot>
              <tr>
                <th data-label="พนักงาน">รวม {rows.length} คน</th>
                <th data-label="จำนวนกะ">{totalShifts}</th>
                <th data-label="ชั่วโมงรวม">{durationText(totalMinutes)}</th>
                <th data-label="รออนุมัติ">{totalPending > 0 ? formatBaht(totalPending) : '—'}</th>
                <th data-label="ค่าจ้างรวม">
                  {formatBaht(totalPay)}
                  {totalUnpaid > 0 && <span className="cell-sub">รอจ่าย {formatBaht(totalUnpaid)}</span>}
                </th>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </>
  );
}
