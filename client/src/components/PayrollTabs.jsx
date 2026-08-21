import { Fragment, useEffect, useState } from 'react';
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

  /* กะที่ยังเช็คอิน–เอาท์ไม่ครบ (ขาดงาน / ค้างเช็คเอาท์) — ไม่มีวันโผล่ในคิวนี้ เพราะคิวนี้
     รับเฉพาะกะที่ "ทำจบแล้ว" (มีเวลาออก) ที่ยังไม่ถูกยืนยัน
     ต้องนับให้เห็นตอนคิวว่าง ไม่งั้นหน้าจอจะบอกว่า "ยืนยันครบแล้ว" ทั้งที่ยังมีงานค้างอยู่อีกที่หนึ่ง
     แล้วเงินของกะพวกนั้นก็เงียบหายไปโดยไม่มีใครรู้ว่าต้องไปทำอะไรต่อที่ไหน
     โหลดเฉพาะตอนคิวว่างเท่านั้น — ถ้ามีของให้ทำอยู่แล้ว ตัวเลขนี้ไม่ได้ช่วยอะไร */
  const [stuck, setStuck] = useState(null);

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
        setStuck(null);
        if (r.length === 0) {
          api
            .attendanceExceptions()
            .then((x) => !cancelled && setStuck(x.length))
            .catch(() => {});
        }
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

      {/* เหลือไว้แค่ท่าที่มองไม่เห็นจากหน้าจอ — ว่าแถวทั้งแถวกดเลือกได้ ไม่ใช่ต้องจิ้มช่องติ๊ก */}
      <p className="muted tab-hint"><strong>แตะที่แถวเพื่อเลือก</strong></p>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : rows?.length === 0 ? (
        /* คิวว่างไม่ได้แปลว่าไม่มีอะไรต้องทำ — บอกทั้งสองทางที่ไปต่อได้จริง
           (กะที่ค้างอยู่คนละที่ · ขั้นถัดไปของสายพาน) ไม่งั้นหน้าจอนี้เป็นทางตัน */
        <section className="card empty-state">
          <p><LineIcon name="check" className="text-ico" />ไม่มีกะรออนุมัติในเดือนนี้</p>
          <p className="muted">
            คิวนี้รับเฉพาะกะที่<strong>เช็คอิน–เอาท์ครบแล้ว</strong> — กะที่ขาดงานหรือค้างเช็คเอาท์
            อยู่ที่แท็บ “รายการต้องตรวจ”
            <span className="cell-sub">
              การยืนยันกะไม่ได้กั้นการจ่ายเงิน — ค่าจ้างปล่อยได้ตั้งแต่ปิดเคส
            </span>
          </p>
          <div className="empty-actions">
            {stuck > 0 && (
              <Link className="btn primary" to="/attendance">
                มี {stuck} กะที่ต้องตรวจ →
              </Link>
            )}
          </div>
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

  /* ที่มาของยอดรายคน — ยอดรวมตอบได้แค่ "ได้เท่าไหร่" แต่คำถามถัดมาเสมอคือ "มาจากเคสไหนบ้าง"
     โหลดตอนกดเท่านั้น เพราะเดือนหนึ่งมีพนักงานหลายสิบคน ส่วนใหญ่ไม่ได้ถูกกางดู */
  const [openId, setOpenId] = useState(null);
  const [cases, setCases] = useState(null);

  function toggleCases(id) {
    if (openId === id) {
      setOpenId(null);
      setCases(null);
      return;
    }
    setOpenId(id);
    setCases(null); // ล้างก่อนเสมอ ไม่งั้นระหว่างรอจะเห็นเคสของคนก่อนหน้าค้างอยู่ใต้ชื่อคนใหม่
    api
      .payrollEmployeeCases(month, id)
      .then(setCases)
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .attendanceReport(month, employeeId || undefined)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setOpenId(null);
        setCases(null);
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
      ['รหัสพนักงาน', 'ชื่อ', 'จำนวนกะ', 'ชั่วโมงรวม', 'เคสที่ทำ', 'ค่าจ้างที่ปล่อยแล้ว (บาท)',
        'จ่ายไปแล้ว (บาท)', 'ยังไม่ได้จ่าย (บาท)', 'เคสที่ปล่อยค่าจ้าง',
        'กะที่อนุมัติแล้ว', 'กะที่รออนุมัติ', 'กะที่ไม่อนุมัติ'],
      rows.map((r) => [
        r.employee_id, r.employee_name, r.shifts, (r.minutes / 60).toFixed(1), r.cases_worked, r.pay,
        r.paid_pay ?? 0, r.unpaid_pay ?? 0, r.cases_paid ?? 0,
        r.approved_shifts, r.pending_shifts, r.rejected_shifts,
      ]),
    );
  }

  const totalShifts = rows?.reduce((s, r) => s + r.shifts, 0) ?? 0;
  const totalMinutes = rows?.reduce((s, r) => s + r.minutes, 0) ?? 0;
  const totalPay = rows?.reduce((s, r) => s + r.pay, 0) ?? 0;
  const totalPendingShifts = rows?.reduce((s, r) => s + (r.pending_shifts ?? 0), 0) ?? 0;
  const totalUnpaid = rows?.reduce((s, r) => s + (r.unpaid_pay ?? 0), 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>
        {employeePicker}
        {rows?.length > 0 && <button className="btn" onClick={exportCsv}><LineIcon name="download" />ดาวน์โหลด CSV</button>}
      </MonthPicker>

      <p className="muted tab-hint"><strong>แตะชื่อพนักงานเพื่อดูรายเคส</strong></p>

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
                <Fragment key={r.employee_id}>
                <tr>
                  <td data-label="พนักงาน">
                    <button className="linkish" onClick={() => toggleCases(r.employee_id)}>
                      {r.employee_name}
                    </button>
                    <span className="cell-sub mono">{r.employee_id}</span>
                    <span className="cell-sub">
                      {openId === r.employee_id ? 'แตะเพื่อย่อ' : 'แตะชื่อเพื่อดูรายเคส'}
                    </span>
                  </td>
                  <td data-label="จำนวนกะ">
                    {r.shifts}
                    <span className="cell-sub">{r.cases_worked} เคส</span>
                  </td>
                  <td data-label="ชั่วโมงรวม">{durationText(r.minutes)}</td>
                  {/* เงินที่ค้างอยู่ที่โต๊ะผู้จัดการเอง ไม่ใช่ปัญหาของพนักงาน — กดไปที่คิวอนุมัติได้เลย */}
                  <td data-label="รออนุมัติ">
                    {r.pending_shifts > 0 ? (
                      <Link className="link" to={`/attendance?tab=approvals&month=${month}&employee_id=${r.employee_id}`}>
                        {r.pending_shifts} กะ
                        <span className="cell-sub">ยืนยันกะก่อนจึงจะแบ่งค่าจ้างได้ →</span>
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
                    {/* ทำงานแล้วแต่ยังไม่มีใครกดปล่อยค่าจ้าง — กดไปหาเคสของคนนี้ได้เลย */}
                    {r.pay === 0 && r.approved_shifts > 0 && (
                      <span className="cell-sub">
                        <Link className="link flag-text" to={`/cases?assigned_to=${r.employee_id}`}>
                          ยังไม่ได้ปล่อยค่าจ้าง →
                        </Link>
                      </span>
                    )}
                    {r.rejected_shifts > 0 && (
                      <span className="cell-sub flag-text">ไม่อนุมัติ {r.rejected_shifts} กะ</span>
                    )}
                  </td>
                </tr>

                {/* ทำไปกี่เคส เคสอะไรบ้าง ใบละเท่าไหร่ — กางใต้แถวของคนนั้น กินเต็มความกว้าง
                    เพราะชื่อผู้รับบริการยาวกว่าคอลัมน์ "พนักงาน" ที่กว้างแค่หนึ่งในห้าของตาราง */}
                {openId === r.employee_id && (
                  <tr className="row-expand">
                    <td colSpan={5}>
                      {cases === null ? (
                        <span className="muted">กำลังโหลด…</span>
                      ) : cases.length === 0 ? (
                        <span className="muted">เดือนนี้ยังไม่มีเคส</span>
                      ) : (
                        <ul className="plain-list payroll-item-cases">
                          {cases.map((c) => (
                            <li key={c.case_id}>
                              <span>
                                {c.client_name}
                                <span className="cell-sub mono">{c.case_id}</span>
                              </span>
                              <span>
                                {c.pay === 0 ? (
                                  <span className="muted">ยังไม่ปล่อยค่าจ้าง</span>
                                ) : (
                                  formatBaht(c.pay)
                                )}
                                {c.installments && (
                                  <span className="cell-sub">งวดที่ {c.installments}</span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
            {/* data-label ไม่ได้มีไว้แค่สวย — จอเล็กหัวตารางถูกซ่อน แถวรวมที่เหลือแต่ตัวเลขเปล่าๆ
                จะอ่านไม่ออกว่าเลขไหนคืออะไร */}
            <tfoot>
              <tr>
                <th data-label="พนักงาน">รวม {rows.length} คน</th>
                <th data-label="จำนวนกะ">{totalShifts}</th>
                <th data-label="ชั่วโมงรวม">{durationText(totalMinutes)}</th>
                <th data-label="รออนุมัติ">{totalPendingShifts > 0 ? `${totalPendingShifts} กะ` : '—'}</th>
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
