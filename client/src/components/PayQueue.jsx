import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { CASE_STATUS_LABELS, formatBaht, formatDate } from '../labels.js';
import CasePayPanel from './CasePay.jsx';
import LineIcon from './LineIcon.jsx';

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
 * ตามกติกาเดียวกับทุกตาราง แตะแถวไหนก็กางแผงจัดการของเคสนั้นใต้แถวนั้นเลย
 */
export default function PayQueue({ reloadKey, openCase, onOpenCase }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);

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

  const pending = rows?.filter((r) => r.remaining > 0) ?? [];
  const done = rows?.filter((r) => r.remaining <= 0) ?? [];
  const shown = showDone ? [...pending, ...done] : pending;

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
          {/* เคสที่จ่ายครบแล้วไม่ใช่ของที่ต้องทำ แต่ต้องยังเปิดดูย้อนได้ (ถอนงวดที่ปล่อยผิดคืน)
              จึงซ่อนไว้หลังสวิตช์ ไม่ใช่ตัดทิ้งหรือปนอยู่ในรายการที่ต้องไล่ทำ */}
          {done.length > 0 && (
            <div className="att-filter">
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={showDone}
                  onChange={(e) => setShowDone(e.target.checked)}
                />
                แสดงเคสที่ปล่อยครบแล้วด้วย ({done.length})
              </label>
            </div>
          )}

          {shown.length === 0 ? (
            <section className="card empty-state">
              <p><LineIcon name="check" className="text-ico" />ไม่มีเคสที่ค้างปล่อยค่าจ้าง</p>
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
                        onClick={() => onOpenCase(openCase === c.case_id ? '' : c.case_id)}
                      >
                        <td className="row-index" data-label="ลำดับ">{i + 1}</td>
                        {/* ชื่อพนักงานเป็นตัวนำ เพราะหน้านี้คือหน้าจ่ายเงิน คำถามแรกคือ "จ่ายให้ใคร"
                            ส่วนว่าเคสไหน รหัสเคสในบรรทัดรองบอกอยู่แล้ว (ชื่อผู้รับบริการต่อท้ายไว้
                            ให้จำเคสได้โดยไม่ต้องแปลรหัสในหัว) */}
                        <td data-label="พนักงาน / เคส">
                          <span className="run-id">
                            <strong>{c.worker_names || 'ยังไม่มีพนักงาน'}</strong>
                            <span className={`badge case-${c.status}`}>
                              {CASE_STATUS_LABELS[c.status] ?? c.status}
                            </span>
                          </span>
                          <span className="cell-sub">
                            <span className="mono">{c.case_id}</span>
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
                          {c.remaining > 0 ? (
                            <>
                              <strong>{formatBaht(c.remaining)}</strong>
                              {c.released > 0 && (
                                <span className="pay-state">
                                  <span className="badge payout-partial">ตามจ่ายอยู่</span>
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="pay-state">
                              <span className="badge payout-full">จ่ายครบแล้ว</span>
                            </span>
                          )}
                        </td>
                      </tr>

                      {/* แผงจัดการกางเป็นแถวของตัวเองใต้แถวเคส กินเต็มความกว้าง —
                          ยัดไว้ในช่องใดช่องหนึ่งของแถวเดิมจะได้ความกว้างแค่หนึ่งในสี่ของตาราง */}
                      {openCase === c.case_id && (
                        <tr className="row-expand">
                          <td colSpan={5}>
                            <CasePayPanel caseId={c.case_id} busy={busy} run={run} toast={toast} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
