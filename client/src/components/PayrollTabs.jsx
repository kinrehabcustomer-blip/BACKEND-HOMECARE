import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { formatBaht, formatDate, monthText, timeText, durationText, caseStage } from '../labels.js';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import LineIcon from './LineIcon.jsx';
import CaseModal from './CaseModal.jsx';
import OfficeLink from './OfficeLink.jsx';
import MonthPicker from './MonthPicker.jsx';
import PayrollSummaryDoc from './PayrollSummaryDoc.jsx';
import { LATE_MINUTES } from '../lib/attendanceUi.js';
import { caseCode } from '../lib/patientCode.js';

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
  /* ค่าจ้างไม่ได้คิดรายกะแล้ว (ก้อนเดียวต่อเคส ปล่อยที่แท็บ "ปล่อยค่าจ้าง") — แท็บนี้ยืนยันแค่ว่ากะเกิดขึ้นจริง
     จึงสรุปเป็นชั่วโมงทำงาน ไม่ใช่ยอดเงิน (เดิมรวม v.pay ที่ server ไม่ได้ส่งมาแล้ว ได้ ฿0 ทุกครั้ง) */
  const pickedMinutes = pickedRows.reduce((s, v) => s + (v.worked_minutes ?? 0), 0);

  async function decide(approve) {
    const ids = [...picked];
    if (ids.length === 0) return;

    let reason = null;
    if (!approve) {
      // ไม่อนุมัติต้องมีเหตุผลเสมอ — เป็นสิ่งเดียวที่พนักงานจะได้รู้ว่าทำไมกะนั้นไม่ได้เงิน
      reason = prompt(`ไม่อนุมัติ ${ids.length} กะ — เหตุผล (พนักงานจะเห็นข้อความนี้)`);
      if (!reason?.trim()) return;
    } else if (!confirm(`ยืนยัน ${ids.length} กะ (รวม ${durationText(pickedMinutes)})?`)) {
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
    ].filter(Boolean);

  const totalMinutes = rows?.reduce((s, v) => s + (v.worked_minutes ?? 0), 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>{employeePicker}</MonthPicker>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted loading-center">กำลังโหลด…</p>
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
              <OfficeLink className="btn primary" to="/attendance">
                มี {stuck} กะที่ต้องตรวจ →
              </OfficeLink>
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
                        <OfficeLink
                          className="link mono"
                          to={`/cases?open=${v.case_id}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {caseCode(v.case_id)}
                        </OfficeLink>
                      </span>
                    </td>
                    <td data-label="เข้า–ออก">
                      {timeText(v.check_in_at)} – {timeText(v.check_out_at)}
                      {flags(v).length > 0 && <span className="cell-sub flag-text">{flags(v).join(' · ')}</span>}
                    </td>
                    <td data-label="รวม">{durationText(v.worked_minutes)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th />
                  <th data-label="รวม">{rows.length} กะ</th>
                  <th />
                  <th />
                  <th data-label="ชั่วโมงรวม">{durationText(totalMinutes)}</th>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* แถบยืนยันติดขอบล่าง — ติ๊กมา 40 กะแล้วต้องเลื่อนกลับขึ้นไปหาปุ่มคือคนละเรื่องกัน */}
          {picked.size > 0 && (
            <div className="approve-bar">
              <p className="pick-count">
                เลือกไว้ <strong>{picked.size}</strong> กะ · รวม <strong>{durationText(pickedMinutes)}</strong>
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
  const [openRow, setOpenRow] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .attendanceReport(month, employeeId || undefined)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setOpenRow(null);
        setError(null); // เปลี่ยนเดือนแล้วโหลดผ่าน error ของเดือนก่อนต้องหายไปด้วย
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [month, employeeId, reloadKey]);

  const totalShifts = rows?.reduce((s, r) => s + r.shifts, 0) ?? 0;
  const totalMinutes = rows?.reduce((s, r) => s + r.minutes, 0) ?? 0;
  const totalPay = rows?.reduce((s, r) => s + r.pay, 0) ?? 0;
  const totalPendingShifts = rows?.reduce((s, r) => s + (r.pending_shifts ?? 0), 0) ?? 0;
  const totalUnpaid = rows?.reduce((s, r) => s + (r.unpaid_pay ?? 0), 0) ?? 0;

  return (
    <>
      <MonthPicker month={month} onChange={(m) => patch({ month: m })}>
        {employeePicker}
        {/* ทางออกของแท็บนี้เหลือทางเดียวคือใบที่พิมพ์ — CSV ถูกตัดออกเพราะไม่มีใครเอาไปใช้ต่อจริง
            (ปุ่ม CSV ของแท็บ "ประวัติเช็คอิน" เป็นคนละชุดข้อมูล ยังอยู่ตามเดิม) */}
        {rows?.length > 0 && (
          <button className="btn" onClick={() => window.print()}>
            <LineIcon name="printer" />พิมพ์ / บันทึก PDF
          </button>
        )}
      </MonthPicker>

      {/* ใบที่จะถูกพิมพ์ — ซ่อนอยู่บนจอ โผล่เฉพาะตอนสั่งพิมพ์ (ดู .payroll-doc ใน index.css) */}
      <PayrollSummaryDoc month={month} rows={rows} />

      <p className="muted tab-hint no-print"><strong>แตะที่แถวเพื่อดูรายเคส</strong></p>

      {error && <p className="error">{error}</p>}

      {loading && !rows ? (
        <p className="muted loading-center">กำลังโหลด…</p>
      ) : !error && rows?.length === 0 ? (
        // บอกให้ชัดว่าว่างเพราะ "ไม่มีใครเช็คอิน" หรือเพราะ "คนที่กรองไว้ไม่ได้เช็คอิน" — ไม่งั้นเข้าใจว่าข้อมูลหาย
        <section className="card empty-state">
          <p>{employeeId ? 'เดือนนี้พนักงานคนนี้ยังไม่มีการเช็คอิน' : 'เดือนนี้ยังไม่มีการเช็คอิน'}</p>
        </section>
      ) : rows?.length > 0 ? (
        /* no-print: ใบสรุปด้านบนแทนตารางนี้บนกระดาษแล้ว ปล่อยไว้จะได้กระดาษเปล่าตามมาอีกหลายหน้า
           (ของที่ถูกซ่อนตอนพิมพ์ยังกินพื้นที่หน้ากระดาษอยู่ ถ้าไม่สั่ง display: none) */
        <div className="table-wrap no-print payout-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>พนักงาน</th><th>จำนวนกะ</th><th>ชั่วโมงรวม</th><th>รออนุมัติ</th><th>ค่าจ้างรวม</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.employee_id}>
                {/* กดได้ทั้งแถว ไม่ใช่เฉพาะชื่อ — ท่าเดียวกับคิวอนุมัติกะด้านบนในไฟล์นี้
                    tabIndex + onKeyDown เพราะชื่อพนักงานเลิกเป็น <button> แล้ว ถ้าไม่ใส่
                    คนที่ใช้แป้นพิมพ์จะกางดูรายเคสไม่ได้เลย (is-tappable มีกรอบโฟกัสรออยู่แล้ว) */}
                <tr
                  className={`is-tappable ${openRow?.employee_id === r.employee_id ? 'is-picked' : ''}`}
                  tabIndex={0}
                  onClick={() => setOpenRow(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpenRow(r);
                    }
                  }}
                >
                  <td data-label="พนักงาน">
                    <span className="linkish">{r.employee_name}</span>
                    <span className="cell-sub mono">{r.employee_id}</span>
                    <span className="cell-sub">แตะเพื่อดูรายเคส</span>
                  </td>
                  <td data-label="จำนวนกะ">
                    {r.shifts}
                    {/* นับเฉพาะเคสที่มีกะในเดือนนี้ — เคสที่ได้เงินจากงานเดือนก่อนอยู่ใน popup รายเคส
                        เขียนว่า "จาก N เคส" ไม่ใช่ "N เคส" ไม่งั้นอ่านชนกับจำนวนแถวใน popup */}
                    {r.cases_worked > 0 && <span className="cell-sub">จาก {r.cases_worked} เคส</span>}
                  </td>
                  <td data-label="ชั่วโมงรวม">{durationText(r.minutes)}</td>
                  {/* เงินที่ค้างอยู่ที่โต๊ะผู้จัดการเอง ไม่ใช่ปัญหาของพนักงาน — กดไปที่คิวอนุมัติได้เลย */}
                  <td data-label="รออนุมัติ">
                    {r.pending_shifts > 0 ? (
                      /* stopPropagation กันไม่ให้การกดลิงก์กางแถวตามไปด้วย (แถวทั้งแถวกดได้แล้ว) */
                      <OfficeLink
                        className="link"
                        to={`/attendance?tab=approvals&month=${month}&employee_id=${r.employee_id}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.pending_shifts} กะ
                        <span className="cell-sub">ยืนยันกะก่อนจึงจะแบ่งค่าจ้างได้ →</span>
                      </OfficeLink>
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
                        <OfficeLink
                          className="link flag-text"
                          to={`/cases?assigned_to=${r.employee_id}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          ยังไม่ได้ปล่อยค่าจ้าง →
                        </OfficeLink>
                      </span>
                    )}
                    {r.rejected_shifts > 0 && (
                      <span className="cell-sub flag-text">ไม่อนุมัติ {r.rejected_shifts} กะ</span>
                    )}
                  </td>
                </tr>

                </Fragment>
              ))}
              {/* แถวว่างกินพื้นที่ที่เหลือ — ดันแถวรวมลงไปชิดล่างการ์ดตอนรายชื่อสั้น (ดู .payout-wrap) */}
              <tr className="row-filler" aria-hidden="true"><td /><td /><td /><td /><td /></tr>
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

      {openRow && (
        <EmployeeCasesModal month={month} row={openRow} onClose={() => setOpenRow(null)} />
      )}
    </>
  );
}

/**
 * ทำไปกี่เคส เคสอะไรบ้าง ใบละเท่าไหร่ ของพนักงานหนึ่งคนในเดือนนั้น — เปิดจากแถวในสรุปเงินได้
 * เดิมกางใต้แถว ดันตารางทั้งก้อนลงจนหาแถวรวมไม่เจอ · กดแถวเคสเพื่อเปิดรายละเอียดเคส (CaseModal ซ้อนอีกชั้น)
 * โหลดตอนเปิดเท่านั้น เพราะเดือนหนึ่งมีพนักงานหลายสิบคน ส่วนใหญ่ไม่ได้ถูกเปิดดู
 */
function EmployeeCasesModal({ month, row, onClose }) {
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const [openCaseId, setOpenCaseId] = useState(null);
  const sheetRef = useSheetSwipe(onClose);

  useEffect(() => {
    let cancelled = false;
    api
      .payrollEmployeeCases(month, row.employee_id)
      .then((r) => !cancelled && setCases(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [month, row.employee_id]);

  useScrollLock();
  useEffect(() => {
    // CaseModal ซ้อนอยู่ = ให้ Escape ปิดตัวนั้นก่อน ไม่ใช่ปิดพรวดทั้งสองชั้น
    const onKeyDown = (e) => e.key === 'Escape' && !openCaseId && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, openCaseId]);

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal modal-wide" ref={sheetRef} role="dialog" aria-modal="true" aria-label="รายเคส" onClick={(e) => e.stopPropagation()}>
          <header className="modal-head">
            <div>
              <p className="mono muted">{row.employee_id}</p>
              <h2>{row.employee_name}</h2>
              <p className="muted">
                {monthText(month)} · {row.shifts} กะ · ค่าจ้าง {formatBaht(row.pay)}
              </p>
            </div>
            <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
          </header>

          <div className="modal-body">
            {error && <p className="error">{error}</p>}
            {!cases && !error ? (
              <p className="muted modal-loading">กำลังโหลด…</p>
            ) : cases?.length === 0 ? (
              <p className="muted">เดือนนี้ยังไม่มีเคส</p>
            ) : cases ? (
              <div className="table-wrap">
                <table className="table table-cards">
                  <colgroup>
                    <col style={{ width: '40%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '25%' }} />
                    <col style={{ width: '20%' }} />
                  </colgroup>
                  <thead>
                    <tr><th>เคส / ผู้รับบริการ</th><th>จำนวนกะ</th><th>ค่าจ้างเดือนนี้</th><th>สถานะเคส</th></tr>
                  </thead>
                  <tbody>
                    {cases.map((c) => (
                      <tr
                        key={c.case_id}
                        className="is-tappable"
                        tabIndex={0}
                        onClick={() => setOpenCaseId(c.case_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpenCaseId(c.case_id);
                          }
                        }}
                      >
                        <td data-label="เคส / ผู้รับบริการ">
                          <span className="linkish">{c.client_name || c.title}</span>
                          <span className="cell-sub mono">{caseCode(c.case_id)}</span>
                        </td>
                        <td data-label="จำนวนกะ">
                          {c.shifts}
                          {c.pending_shifts > 0 && <span className="cell-sub">รออนุมัติ {c.pending_shifts}</span>}
                        </td>
                        <td data-label="ค่าจ้างเดือนนี้">
                          {c.pay === 0 ? <span className="muted">ยังไม่ปล่อยค่าจ้าง</span> : formatBaht(c.pay)}
                          {c.installments && <span className="cell-sub">งวดที่ {c.installments}</span>}
                        </td>
                        <td data-label="สถานะเคส">
                          <span className={`badge case-${caseStage(c).key}`}>{caseStage(c).label}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* วางนอก backdrop — ไม่งั้นคลิกใน CaseModal จะไปโดน onClick ของ backdrop แล้วปิดทิ้ง */}
      {openCaseId && <CaseModal caseId={openCaseId} onClose={() => setOpenCaseId(null)} />}
    </>
  );
}
