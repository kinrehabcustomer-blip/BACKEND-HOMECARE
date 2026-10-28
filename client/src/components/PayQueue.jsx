import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import { useToast } from '../toast.jsx';
import { formatBaht, formatDate, openDatePicker, caseStage } from '../labels.js';
import CasePayPanel from './CasePay.jsx';
import LineIcon from './LineIcon.jsx';
import { caseCode } from '../lib/patientCode.js';

/**
 * แท็บ "ปล่อยค่าจ้าง" — เคสทุกใบที่มีเงินให้จัดการ อยู่รวมกันในหน้าเดียว
 *
 * นี่คือขั้นแรกของสายพานเงิน ที่เดิมไม่มีหน้าของตัวเอง: ปิดเคสแล้วเงินยังไม่ไปไหน
 * จนกว่าจะมีคนกด "ปล่อยค่าจ้าง" ของเคสนั้น ซึ่งเดิมทำได้ทางเดียวคือเปิดเคสทีละใบจากหน้าเคส
 * แปลว่าคนทำเรื่องเงินต้องรู้เองว่าเคสไหนค้าง แล้วไล่เปิดทีละใบ — เงินที่ลืมปล่อยจึงเงียบสนิท
 *
 * ใช้ตารางแบบเดียวกับหน้าอื่นในระบบ (.table-cards) ไม่ใช่รายการทรงอิสระของตัวเอง —
 * คนที่ใช้ระบบนี้อ่านตารางหน้าตานี้มาทั้งวันแล้วจากหน้าเคส/ใบแจ้งหนี้/รอบจ่าย ของที่หน้าตา
 * ไม่เหมือนใครบังคับให้หยุดอ่านใหม่ทุกครั้งว่าตัวเลขไหนคืออะไร · บนจอแคบมันยุบเป็นการ์ดให้เอง
 * ตามกติกาเดียวกับทุกตาราง แตะแถวไหนก็เปิดแผงจัดการของเคสนั้นเป็น popup
 */
/* ป้าย "ค้าง N วัน" ขึ้นเฉพาะลำดับ 1–3 — ลำดับ 4–5 ปกติรอปิดเคสก่อนจ่าย ติดป้ายไปก็เร่งผิดที่ */
const URGENT_TIERS = [1, 2, 3];

/* เกินหนึ่งเดือน = ค้างข้ามรอบเงินเดือนไปแล้ว เปลี่ยนเป็นสีเตือน */
const LATE_DAYS = 30;

/* วันของเคส — ใช้ waiting_since ตัวเดียวกับที่ใช้เรียงลำดับ (วันปิดเคส / วันกะแรก)
   ถ้าใช้คนละวันกับที่เรียง เคสจะย้ายช่วงวันโดยที่ลำดับไม่ขยับ แล้วเชื่อทั้งสองอย่างไม่ได้ */
const dayOf = (c) => (c.waiting_since ?? c.created_at ?? '').slice(0, 10);

export default function PayQueue({ reloadKey, openCase, onOpenCase }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  /* ช่วงวันที่ (ตั้งแต่ – ถึง) · ว่างทั้งคู่ = ทุกวัน และเป็นค่าปริยายของแท็บนี้
     คิวนี้คือ "เงินที่ยังค้างพนักงาน" ซึ่งส่วนใหญ่ค้างมาจากเดือนก่อน เปิดมาแบบกรองไว้
     แล้วรายการจะว่างทั้งที่ยังค้างอยู่จริง — ตัวกรองมีไว้ให้เจาะดู ไม่ใช่ซ่อนของค้าง
     ใส่ฝั่งเดียวก็ได้ (ตั้งแต่วันที่ … เป็นต้นไป / จนถึงวันที่ …) */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filtering = from !== '' || to !== '';
  const clearRange = () => { setFrom(''); setTo(''); };

  const load = useCallback(
    () =>
      api
        .payrollCaseQueue()
        .then((r) => {
          setRows(r);
          setError(null);
        })
        .catch((e) => setError(e.message)),
    [],
  );

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  /* ครอบทุกการกระทำที่ยิง API — ปุ่มทั้งแผงถูกปิดระหว่างรอ ไม่ให้กดซ้ำจนปล่อยเงินสองรอบ
     แล้วดึงรายการใหม่ตอนจบ เพราะยอดคงเหลือ/จำนวนงวดของแถวนั้นเพิ่งเปลี่ยน */
  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /* แบ่งด้วย "ยอดที่ระบบเสนอ" ไม่ใช่ยอดเหมา — เคสที่ยกเลิกกลางคันแล้วจ่ายครบตามกะที่ไปจริง
     ต้องนับว่าจบ ไม่ใช่ค้างอยู่ในคิวตลอดไปด้วยยอดของกะที่ไม่มีใครไป (ดร. 25 ต.ค. 2569)
     เคสปกติ suggested_remaining เท่ากับ remaining เป๊ะ การแบ่งจึงไม่เปลี่ยน */
  const leftToPay = (r) => r.suggested_remaining ?? r.remaining;
  const pending = rows?.filter((r) => leftToPay(r) > 0) ?? [];
  const done = rows?.filter((r) => leftToPay(r) <= 0) ?? [];
  const inScope = showDone ? [...pending, ...done] : pending;

  const shown = inScope.filter((c) => {
    const d = dayOf(c);
    return (!from || d >= from) && (!to || d <= to);
  });
  const rangeText = from && to
    ? `ระหว่าง ${formatDate(from)} – ${formatDate(to)}`
    : from ? `ตั้งแต่ ${formatDate(from)}` : `ถึง ${formatDate(to)}`;

  return (
    <>
      {error && <p className="error">{error}</p>}

      {!rows ? (
        <p className="muted">กำลังโหลด…</p>
      ) : rows.length === 0 ? (
        <section className="card empty-state">
          <p><LineIcon name="check" className="text-ico" />ยังไม่มีเคสที่พร้อมปล่อยค่าจ้าง</p>
          <p className="muted">
            เคสจะขึ้นที่นี่ทุกใบที่ตั้งค่าจ้างพนักงานไว้แล้ว — ไม่ต้องรอให้กะครบหรือถูกยืนยันก่อน
          </p>
        </section>
      ) : (
        <>
          {/* กรองตามช่วงวันที่ (วันปิดเคส / วันกะแรก) · เคสที่จ่ายครบซ่อนหลังสวิตช์ ไม่ตัดทิ้ง
              เพราะยังต้องเปิดดูย้อนได้ตอนถอนงวดที่ปล่อยผิดคืน */}
          <div className="att-filter">
            <span className="date-range" role="group" aria-label="ช่วงวันที่">
              <input
                type="date"
                value={from}
                max={to || undefined}
                onClick={openDatePicker}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="ตั้งแต่วันที่"
                title="ตั้งแต่วันที่"
              />
              <span className="date-range-sep">ถึง</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onClick={openDatePicker}
                onChange={(e) => setTo(e.target.value)}
                aria-label="ถึงวันที่"
                title="ถึงวันที่"
              />
            </span>
            {/* ทางกลับไป "ไม่กรองเดือน" — โผล่เฉพาะตอนกรองเดือนอยู่จริง
                ค่าปริยายของแท็บนี้คือทุกเดือน ชิปนี้จึงเป็นปุ่มล้างตัวกรอง ไม่ใช่ตัวเลือกมุมมอง
                โชว์ค้างไว้ตอนไม่ได้กรองก็เป็นปุ่มที่กดแล้วไม่เกิดอะไร และไปนั่งข้างปุ่ม
                "รวมที่จ่ายครบ" จนอ่านเหมือนสองปุ่มนี้เป็นตัวเลือกคู่กัน ทั้งที่คุมคนละมิติ
                (เดือน vs สถานะการจ่าย) แล้วตัวเลขในสองปุ่มก็ไม่เท่ากันด้วย */}
            {filtering && (
              <button
                type="button"
                className="chip"
                onClick={clearRange}
                title="เลิกกรองช่วงวันที่ แสดงทุกวัน"
              >
                ล้างช่วงวันที่
              </button>
            )}

            {/* สองมุมมองที่เลือกได้ทีเดียวอันเดียว — เดิมเป็นช่องติ๊ก "แสดงเคสที่ปล่อยครบแล้วด้วย"
                ซึ่งบอกได้แค่สถานะของตัวเอง คนอ่านต้องเดาว่าถ้าไม่ติ๊กแล้วเห็นอะไร
                ปุ่มคู่บอกทั้งสองทางพร้อมจำนวน จึงเลือกได้โดยไม่ต้องลองกดดูก่อน */}
            {done.length > 0 && (
              <div className="seg" role="group" aria-label="ขอบเขตของรายการ">
                <button
                  type="button"
                  className={showDone ? '' : 'on'}
                  aria-pressed={!showDone}
                  onClick={() => setShowDone(false)}
                >
                  ค้างจ่าย ({pending.length})
                </button>
                {/* ไม่ใช้คำว่า "ทั้งหมด" — มันอ่านว่า "ทุกเคส" ซึ่งชนกับการเลิกกรองช่วงวันที่
                    ชื่อต้องบอกว่ามันเพิ่มอะไรเข้ามา ไม่ใช่บอกว่ามันครอบคลุมแค่ไหน */}
                <button
                  type="button"
                  className={showDone ? 'on' : ''}
                  aria-pressed={showDone}
                  onClick={() => setShowDone(true)}
                >
                  รวมที่จ่ายครบ ({rows.length})
                </button>
              </div>
            )}
          </div>

          {shown.length === 0 ? (
            <section className="card empty-state">
              {/* ว่างเพราะกรองช่วงวันที่ กับว่างเพราะไม่มีงานค้างจริง ต้องเขียนคนละแบบ */}
              {filtering ? (
                <>
                  <p>ไม่มีเคสที่ค้างปล่อยค่าจ้าง{rangeText}</p>
                  {/* "ว่าง" ที่ไม่บอกอะไรต่อคือสาเหตุที่เงินค้างเดือนก่อนถูกลืม */}
                  {inScope.length > 0 && (
                    <p className="muted">ยังมีเคสค้างอยู่นอกช่วงนี้ {inScope.length} เคส</p>
                  )}
                  <div className="empty-actions">
                    <button type="button" className="btn" onClick={clearRange}>
                      ดูทุกวัน ({inScope.length})
                    </button>
                  </div>
                </>
              ) : (
                <p><LineIcon name="check" className="text-ico" />ไม่มีเคสที่ค้างปล่อยค่าจ้าง</p>
              )}
            </section>
          ) : (
            <div className="table-wrap">
              {/* สี่คอลัมน์ = สี่คำถามที่ถามตามลำดับนี้จริง: เคสไหน → ตกลงไว้เท่าไหร่ →
                  จ่ายไปแล้วเท่าไหร่ (กี่งวด) → เหลือเท่าไหร่
                  ยอดคงเหลือคือตัวที่ตัดสินว่าต้องทำอะไรต่อ จึงอยู่ท้ายสุด ซึ่งเป็นที่ที่ตากวาดไปหยุด */}
              {/* table-indexed = คอลัมน์ลำดับหน้าสุด แบบเดียวกับตารางเคส/ลูกค้า/ใบแจ้งหนี้
                  มีไว้ให้พูดถึงแถวได้ ("แถวที่ 7 ยังไม่ได้ปล่อย") และรู้ว่าเลื่อนมาถึงไหนแล้ว
                  โดยไม่ต้องนับเอง — เคสที่ค้างจ่ายมีหลักสิบ ไล่ทีละแถวจนตาลาย */}
              <table className="table table-cards table-indexed">
                <colgroup>
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '38%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '20%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th><th>พนักงาน / เคส</th><th>ค่าจ้างพนักงาน</th><th>ปล่อยแล้ว</th><th>คงเหลือ</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c, i) => (
                    <Fragment key={c.case_id}>
                      <tr
                        className={`is-tappable ${openCase === c.case_id ? 'is-picked' : ''}`}
                        onClick={() => onOpenCase(c.case_id)}
                      >
                        <td className="row-index" data-label="ลำดับ">{i + 1}</td>
                        {/* ชื่อพนักงานเป็นตัวนำ เพราะหน้านี้คือหน้าจ่ายเงิน คำถามแรกคือ "จ่ายให้ใคร"
                            ส่วนว่าเคสไหน รหัสเคสในบรรทัดรองบอกอยู่แล้ว (ชื่อผู้รับบริการต่อท้ายไว้
                            ให้จำเคสได้โดยไม่ต้องแปลรหัสในหัว) */}
                        <td data-label="พนักงาน / เคส">
                          <span className="run-id">
                            <strong>{c.worker_names || 'ยังไม่มีพนักงาน'}</strong>
                            <span className={`badge case-${c.status}`}>
                              {caseStage(c).label}
                            </span>
                            {/* ตัวเลขเดียวกับที่ใช้เรียงลำดับ — ไม่โชว์ ลำดับก็กลายเป็นกติกาที่มองไม่เห็น */}
                            {URGENT_TIERS.includes(c.pay_priority) && c.waiting_days > 0 && (
                              <span className={`badge pay-wait ${c.waiting_days >= LATE_DAYS ? 'is-late' : ''}`}>
                                ค้าง {c.waiting_days} วัน
                              </span>
                            )}
                          </span>
                          <span className="cell-sub">
                            <span className="mono">{caseCode(c.case_id)}</span>
                            {c.client_name && ` · ${c.client_name}`}
                            {c.closed_at && ` · ปิดเคส ${formatDate(c.closed_at)}`}
                          </span>
                        </td>
                        <td data-label="ค่าจ้างพนักงาน">{formatBaht(c.staff_pay)}</td>
                        <td data-label="ปล่อยแล้ว">
                          {formatBaht(c.released)}
                          {/* ไม่มีตัวหาร — จำนวนงวดของเคสไม่ได้ถูกกำหนดล่วงหน้า
                              ปกติจ่ายทีเดียวจบ จะซอยกี่งวดค่อยตัดสินตอนปล่อย */}
                          <span className="cell-sub">
                            {c.installments_used > 0 ? `${c.installments_used} งวด` : 'ยังไม่ปล่อย'}
                          </span>
                        </td>
                        {/* ป้ายสถานะเงิน — ตัวเลขสามคอลัมน์บอกครบอยู่แล้วว่าเคสนี้อยู่ตรงไหน
                            แต่ต้องเอาสองยอดมาลบกันในหัวก่อนถึงจะรู้ ซึ่งเมื่อไล่ทีละสิบแถว
                            (บางใบปิดเคสแล้ว บางใบยังไม่ปิด บางใบซ่อนอยู่หลังสวิตช์) คนอ่านจะเริ่มมึน
                            ป้ายเดียวตอบคำถามที่ถามจริงทันที: จ่ายครบหรือยัง / ยังตามจ่ายอยู่ไหม

                            เคสที่ยังไม่ปล่อยสักบาทไม่มีป้าย — ช่อง "ปล่อยแล้ว" เขียนว่า "ยังไม่ปล่อย"
                            อยู่แล้ว ติดป้ายซ้ำอีกอันคือทำให้สิ่งที่ต้องอ่านเยอะขึ้นโดยไม่ได้บอกอะไรใหม่
                            มีป้าย = มีเงินออกไปแล้ว จึงเป็นสัญญาณที่กวาดตาหาได้จริง */}
                        <td data-label="คงเหลือ">
                          {leftToPay(c) > 0 ? (
                            <>
                              <strong>{formatBaht(leftToPay(c))}</strong>
                              {/* ยอดไม่เท่า "ยอดเหมา − ปล่อยแล้ว" ต้องอธิบายตรงนี้
                                  ไม่งั้นผู้จัดการเอาสองคอลัมน์ซ้ายมาลบกันแล้วคิดว่าระบบคำนวณผิด */}
                              {c.prorated && (
                                <span className="cell-sub">
                                  เคสยกเลิก — คิดตามกะที่ไปจริง {c.worked_shifts} จาก {c.planned_shifts} กะ
                                </span>
                              )}
                              {c.released > 0 && (
                                <span className="pay-state">
                                  <span className="badge payout-partial">ตามจ่ายอยู่</span>
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="pay-state">
                              <span className="badge payout-full">
                                {c.prorated ? 'จ่ายครบตามกะที่ไปจริง' : 'จ่ายครบแล้ว'}
                              </span>
                            </span>
                          )}
                        </td>
                      </tr>

                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* แผงจัดการเปิดเป็น popup — กางใต้แถวแล้วดันตารางทั้งก้อนลงไปจนหาแถวอื่นไม่เจอ
          หาเคสจากทั้งคิว (ไม่ใช่แค่ที่กรองอยู่) ลิงก์ ?open= จากที่อื่นจะได้เปิดถูกเสมอ */}
      {openCase && rows?.some((r) => r.case_id === openCase) && (
        <PayModal
          row={rows.find((r) => r.case_id === openCase)}
          busy={busy}
          run={run}
          toast={toast}
          onClose={() => onOpenCase('')}
        />
      )}
    </>
  );
}

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

function PayModal({ row, busy, run, toast, onClose }) {
  const boxRef = useRef(null);
  useSheetSwipe(onClose, boxRef);
  useScrollLock();

  useEffect(() => {
    const previous = document.activeElement;
    boxRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  /* Esc ปิด + ขังโฟกัสไว้ในกล่อง (แบบเดียวกับ popup อื่นในระบบ) */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...(boxRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === boxRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal pay-modal"
        role="dialog"
        aria-modal="true"
        aria-label="ปล่อยค่าจ้าง"
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <p className="mono muted">
              {caseCode(row.case_id)}
              {row.client_name && ` · ${row.client_name}`}
            </p>
            <h2>{row.worker_names || 'ยังไม่มีพนักงาน'}</h2>
            <span className={`badge case-${caseStage(row).key}`}>{caseStage(row).label}</span>
          </div>
          <div className="modal-head-actions">
            <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
          </div>
        </header>
        <div className="modal-body">
          <CasePayPanel caseId={row.case_id} busy={busy} run={run} toast={toast} />
        </div>
      </div>
    </div>
  );
}
