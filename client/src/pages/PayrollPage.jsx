import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { Approvals, PayoutSummary } from '../components/PayrollTabs.jsx';
import PayQueue from '../components/PayQueue.jsx';
import { thisMonth as currentMonth } from '../lib/attendanceUi.js';
import { formatBaht, formatDate, openDatePicker, todayTH } from '../labels.js';
import PageRefresh from '../components/PageRefresh.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import LineIcon from '../components/LineIcon.jsx';

/** ป้ายสถานะรอบ — ใช้สีชุดเดียวกับใบแจ้งหนี้ (ร่าง/จ่ายแล้ว/ยกเลิก มีความหมายเดียวกัน) */
const STATUS = {
  draft: { label: 'ร่าง', className: 'invoice-draft' },
  paid: { label: 'จ่ายแล้ว', className: 'invoice-paid' },
  cancelled: { label: 'ยกเลิก', className: 'invoice-cancelled' },
};

/** 'สิงหาคม 2569' — ใช้ในป้ายชื่อรอบที่ระบบตั้งให้ */
const monthLabel = (ym) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

/** เดือนหนึ่งแบ่งจ่ายได้กี่รอบ — ตรงกับกติกาฝั่ง server */
const MAX_ROUNDS = 3;

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
  // ฟอร์มเปิดรอบเหลือช่องเดียว — เดือน/รอบที่ ระบบตั้งเองจากวันตัดรอบ (ดู server/src/payroll/schema.js)
  const [cutoff, setCutoff] = useState('');
  const [preview, setPreview] = useState(null);

  const [openRunId, setOpenRunId] = useState(null); // รอบที่กางดูรายละเอียดอยู่
  const [detail, setDetail] = useState(null);
  const [payForm, setPayForm] = useState(null);     // null = ยังไม่ได้กดจ่าย

  /* สลิปที่กางดู "ที่มาของยอด" อยู่ — ยอดบนสลิปเป็นก้อนเดียวรวมทุกเคส เพราะโอนครั้งเดียว
     แต่คำถามที่ตามมาทันทีคือ "ก้อนนี้มาจากเคสไหนบ้าง เคสละเท่าไหร่ งวดที่เท่าไหร่"
     โหลดตอนกดเท่านั้น ไม่ดึงมาล่วงหน้าทุกคน — รอบหนึ่งมีสิบกว่าคน ส่วนใหญ่ไม่ได้ถูกกางดู */
  const [openItemId, setOpenItemId] = useState(null);
  const [itemCases, setItemCases] = useState(null);


  const load = useCallback(
    () =>
      /* โหลดแค่รายการรอบ — พรีวิว "ถ้าเปิดรอบวันนี้จะได้เท่าไหร่" ย้ายไปโหลดตอนกดเปิดฟอร์ม
         อย่างเดียวแล้ว (ตัวเดียวกับที่ effect ข้างล่างโหลดตามวันตัดรอบ) ไม่ต้องยิงสองรอบ */
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
    if (!opening || !cutoff) return setPreview(null);
    let cancelled = false;
    api
      .payrollPreview(cutoff)
      .then((v) => !cancelled && setPreview(v))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [opening, cutoff]);

  const openForm = () => {
    setCutoff(todayTH());   // ปกติเปิดรอบวันที่ตัดจริง ซึ่งคือวันนี้
    setOpening(true);
  };

  /* ชื่อรอบที่ระบบจะตั้งให้ — คิดจากรอบที่มีอยู่แล้วในเดือนของวันตัดรอบ
     คิดฝั่งนี้ด้วยเพื่อให้เห็นทันทีตอนเลือกวัน (server คิดซ้ำอีกทีตอนสร้างจริง เป็นตัวตัดสิน) */
  const cutMonth = cutoff.slice(0, 7);
  const usedRounds = runs?.filter((r) => r.period_month === cutMonth && r.status !== 'cancelled').length ?? 0;
  const nextRound = usedRounds + 1;
  const roundsFull = nextRound > MAX_ROUNDS;

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
    setOpenItemId(null);
    setItemCases(null);
  };

  /* กางที่มาของสลิปใบหนึ่ง — แตะซ้ำที่ใบเดิมคือย่อกลับ (กติกาเดียวกับแถวรอบด้านบน)
     ล้าง itemCases ก่อนโหลดใบใหม่เสมอ ไม่งั้นระหว่างรอ จะเห็นรายเคสของคนก่อนหน้า
     ค้างอยู่ใต้ชื่อคนใหม่ ซึ่งเป็นตัวเลขเงินที่ผิดคน */
  const toggleItem = (itemId) => {
    if (openItemId === itemId) {
      setOpenItemId(null);
      setItemCases(null);
      return;
    }
    setOpenItemId(itemId);
    setItemCases(null);
    return run(async () => setItemCases(await api.payrollItemPayouts(detail.run_id, itemId)));
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
      {error && <p className="error">{error}</p>}

      {/* แถบสรุป (ยอดพร้อมจ่าย · ร่างค้าง · จ่ายแล้วเดือนนี้ · รอบที่เปิดไปแล้ว) ถูกตัดออก
          ทุกตัวอ่านได้จากตารางรอบข้างล่างอยู่แล้ว — สถานะของแต่ละรอบ ยอดของแต่ละรอบ และจำนวนแถว
          ส่วนยอด "พร้อมจ่าย ยังไม่เข้ารอบ" เห็นเต็มๆ ตอนกดเปิดรอบ ซึ่งเป็นจังหวะที่ต้องใช้จริง
          แถบสูงๆ ที่คั่นระหว่างแท็บกับตารางมีแต่ดันของจริงตกจอ */}

      {/* แถบเตือน "N เคสยังไม่ได้ปล่อยค่าจ้าง" ถูกตัดออก — แท็บ "ปล่อยค่าจ้าง" บอกเรื่องเดียวกัน
          แต่บอกได้ละเอียดกว่า (ใบไหนบ้าง ใบละเท่าไหร่) และกดทำต่อได้ตรงนั้นเลย
          แถบเตือนที่บอกแค่จำนวนแล้วให้ไปหาต่อเองคือขั้นตอนที่เพิ่มมาโดยไม่ได้ช่วยอะไร */}

      <div className="att-filter payroll-bar">
        {!opening && <button className="btn primary" onClick={openForm}>+ เปิดรอบจ่าย</button>}
      </div>

      {/* ---------- เปิดรอบใหม่ ---------- */}
      {opening && (
        <section className="payroll-open">

          {/* ช่องเดียวที่ต้องตัดสินใจ — เดือนกับเลขรอบที่ระบบตั้งให้เอง จึงไม่มีทางกรอกให้ขัดกันเอง */}
          <label className="payroll-cutoff">
            จ่ายค่างานถึงวันที่
            <input
              type="date"
              value={cutoff}
              max={todayTH()}
              onClick={openDatePicker}
              onChange={(e) => setCutoff(e.target.value)}
            />
          </label>

          {cutoff && (
            <p className={`payroll-name ${roundsFull ? 'is-blocked' : ''}`}>
              {roundsFull ? (
                <>
                  <LineIcon name="alert" className="text-ico" />
                  {monthLabel(cutMonth)} เปิดครบ {MAX_ROUNDS} รอบแล้ว — เลือกวันในเดือนอื่น หรือยกเลิกรอบเดิมก่อน
                </>
              ) : (
                <>
                  รอบนี้จะชื่อ <strong>{monthLabel(cutMonth)} · รอบที่ {nextRound}</strong>
                  {usedRounds > 0 && ` (เดือนนี้เปิดไปแล้ว ${usedRounds} รอบ)`}
                </>
              )}
            </p>
          )}

          <p className="muted payroll-note">
            รวมค่าจ้างที่ปล่อยแล้วถึงวันนั้นทั้งหมด รวมของเก่าที่ยังไม่เคยจ่าย
          </p>

          {preview && (
            <>
              {preview.unreleased_cases > 0 && (
                <p className="stale-tag">
                  <LineIcon name="alert" className="text-ico" />
                  มี {preview.unreleased_cases} เคสที่ทำงานจบแล้วแต่ยังไม่ได้กดปล่อยค่าจ้าง — ยังไม่ถูกรวมในรอบนี้
                </p>
              )}

              {preview.rows.length === 0 ? (
                <p className="muted">ไม่มีค่าจ้างที่พร้อมจ่ายถึงวันที่เลือก</p>
              ) : (
                <>
                  {/* ยอดรวมอยู่เหนือรายชื่อ ไม่ใช่ท้ายตาราง — ทีมมีพนักงานกี่คนก็ตาม
                      ตัวเลขที่ใช้ตัดสินใจต้องเห็นทันทีโดยไม่ต้องเลื่อนผ่านทุกคนก่อน */}
                  {/* ไม่รวมจำนวนเคสตรงนี้ เพราะเคสเดียวที่มีพนักงานสองคนจะถูกนับสองครั้ง —
                      ตัวเลขที่บวกข้ามคนแล้วยังถูกต้องมีแค่จำนวนคนกับยอดเงิน */}
                  <p className="payroll-sum">
                    รวม <strong>{preview.rows.length} คน</strong>
                    {' · '}<strong>{formatBaht(total(preview.rows, 'total_pay'))}</strong>
                  </p>

                  {/* รายชื่อเลื่อนในกล่องตัวเอง — ปุ่ม "เปิดรอบนี้" จึงอยู่ในระยะที่กดถึงเสมอ
                      แม้จะมีพนักงานสามสิบคน (ของเดิมเป็นตารางที่ยืดยาวไปเรื่อยๆ ดันปุ่มตกจอ) */}
                  <div className="payroll-people">
                    {preview.rows.map((r) => (
                      <div className="history-item" key={r.employee_id}>
                        <div>
                          <strong>{r.employee_name}</strong>
                          {/* ไม่บอกจำนวนกะตรงนี้ — ค่าจ้างไม่ได้คิดจากกะแล้ว (ไม่ได้หารด้วยจำนวนกะ
                              และไม่ได้คิดเป็นรายกะ) การเอามาวางข้างยอดเงินทำให้อ่านเป็นว่ายอดนี้
                              มาจากกะ ซึ่งเป็นวิธีคิดของระบบเก่าที่เลิกใช้ไปแล้ว
                              หน่วยของเงินตอนนี้คือ "งวดของเคส" — บอกเท่านั้นพอ */}
                          <p className="muted">
                            {r.cases} เคส · {r.payouts} งวด
                            <span className="cell-sub">
                              ปล่อยเก่าสุด {formatDate(r.oldest_release_date)}
                              {r.earliest_due_date && ` · นัดจ่าย ${formatDate(r.earliest_due_date)}`}
                            </span>
                            {/* ยอดรายคนแก้ที่หน้าเคสเท่านั้น (ที่นั่นคือที่ที่ตกลงส่วนแบ่งกันไว้)
                                จึงต้องมีทางกดไปให้ถึง ไม่ใช่ปล่อยให้ไปหาเองว่าเคสไหนของใคร */}
                            <span className="cell-sub">
                              <Link className="link" to="/payroll?tab=release">
                                แก้ยอดที่แท็บปล่อยค่าจ้าง →
                              </Link>
                            </span>
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

          {/* รายชื่อกับยอดที่จะจ่ายอยู่ข้างบนนี้ครบแล้ว — การบังคับให้ "เปิดรอบ" ก่อนแล้วค่อยไป
              กด "บันทึกการจ่าย" อีกหน้าจอหนึ่ง คือการให้ตรวจซ้ำสิ่งที่เพิ่งตรวจไป
              ทางหลักจึงเป็นปุ่มเดียวจบ ส่วนร่างเก็บไว้ให้กรณีที่ต้องเอาใครออกจากรอบก่อนจ่ายจริง
              (จ่ายผิดก็ยังกด "ยกเลิกรอบ" ได้ เงินกลับเข้ากองรอจ่ายทั้งก้อน ไม่ใช่ทางเดียวที่กลับไม่ได้) */}
          <div className="quick-edit-actions">
            <button className="btn" onClick={() => { setOpening(false); setPreview(null); }}>ยกเลิก</button>
            <button
              className="btn"
              disabled={busy || roundsFull || !preview || preview.rows.length === 0}
              onClick={() =>
                run(async () => {
                  const created = await api.createPayrollRun({ period_to: cutoff });
                  toast(`เปิดรอบ ${created.run_id} เป็นร่างแล้ว`);
                  setOpening(false);
                  setPreview(null);
                  setDetail(created);
                  setOpenRunId(created.run_id);
                })
              }
            >
              เปิดเป็นร่างไว้ก่อน
            </button>
            <button
              className="btn primary"
              disabled={busy || roundsFull || !preview || preview.rows.length === 0}
              onClick={() =>
                run(async () => {
                  const created = await api.createPayrollRun({ period_to: cutoff });
                  const paid = await api.payPayrollRun(created.run_id, { pay_date: todayTH() });
                  toast(`จ่ายรอบ ${paid.run_id} แล้ว ${formatBaht(paid.total_pay)}`);
                  setOpening(false);
                  setPreview(null);
                  setDetail(paid);
                  setOpenRunId(paid.run_id);
                })
              }
            >
              จ่ายเลย
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
            {/* สี่คอลัมน์พอ — จอแคบตารางกลายเป็นการ์ดใบละแถว คอลัมน์ที่เพิ่มมาคือบรรทัดที่เพิ่มในการ์ด
                ของเดิมเจ็ดคอลัมน์ = การ์ดใบละเจ็ดบรรทัด ทั้งที่ "คน" กับ "กะ" อ่านคู่กันอยู่แล้ว
                และสถานะก็เป็นป้ายที่ควรอยู่ติดกับรหัสรอบ ไม่ใช่บรรทัดของตัวเอง */}
            <thead>
              <tr>
                <th>รอบ</th><th>จ่ายค่างานถึง</th><th>ยอดรวม</th><th>วันที่จ่าย</th>
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
                    <span className="run-id">
                      <span className="mono">{r.run_id}</span>
                      <span className={`badge ${STATUS[r.status].className}`}>{STATUS[r.status].label}</span>
                    </span>
                    <span className="cell-sub">{monthLabel(r.period_month)} · รอบที่ {r.round_no}</span>
                  </td>
                  <td data-label="จ่ายค่างานถึง">{formatDate(r.period_to)}</td>
                  {/* เงินในรอบมาจากงวดของเคส ไม่ใช่จากกะ — หน่วยที่บอกว่ารอบนี้ประกอบด้วยอะไร
                      จึงต้องเป็น "คน · เคส" ส่วนจำนวนกะเป็นแค่ที่มาของสัดส่วน ย้ายไปอยู่ในรายละเอียด
                      (รอบที่ยกเลิกไม่เหลือก้อนเงินผูกอยู่ จำนวนเคสจึงเป็น 0 — ไม่แสดงดีกว่าโชว์ศูนย์) */}
                  <td data-label="ยอดรวม">
                    {formatBaht(r.total_pay)}
                    <span className="cell-sub">
                      {r.employees} คน{r.cases > 0 ? ` · ${r.cases} เคส` : ''}
                    </span>
                  </td>
                  <td data-label="วันที่จ่าย">{r.pay_date ? formatDate(r.pay_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- รายละเอียดรอบที่เลือก ---------- */}
      {detail && openRunId === detail.run_id && (
        /* ไม่ครอบกล่องและไม่ทวนหัวข้อ — แถวที่กดกางอยู่ข้างบนบอก รหัสรอบ/วันตัดรอบ/คน/กะ/ยอด ครบแล้ว
           กล่องซ้อนกล่องที่พูดเรื่องเดิมซ้ำสองรอบคือสิ่งที่ทำให้หน้านี้ดูแน่น ทั้งที่ข้อมูลจริงมีนิดเดียว
           ปุ่ม "ย่อ" ก็ไม่ต้องมี เพราะแตะแถวเดิมซ้ำก็ย่อได้อยู่แล้ว */
        <section className="payroll-detail">
          {/* ต่างกันคนละเรื่อง: ร่างยังขยับตามข้อมูลได้ · จ่ายแล้วคือตัวเลขที่เงินออกไปจริง
              ไม่บอกไว้ คนอ่านจะไม่รู้ว่าเลขที่เห็นเป็นของ "ตอนนี้" หรือ "ตอนที่จ่าย" */}
          <p className={`muted payroll-freshness ${detail.status === 'draft' ? 'is-live' : ''}`}>
            {detail.status === 'draft'
              ? 'ร่าง — ยังเอาคนออก/ดึงยอดเพิ่มได้ ตัวเลขจะถูกตรึงตอนกดบันทึกการจ่าย'
              : `ยอดถูกตรึงไว้แล้ว${detail.pay_date ? ` เมื่อ ${formatDate(detail.pay_date)}` : ''} — แก้ค่าจ้างย้อนหลังไม่ทำให้ตัวเลขนี้เปลี่ยน`}
          </p>

          {/* คำถามที่ตามมาทันทีเมื่อเห็นยอดรายคนคือ "ถ้าคนนี้ควรได้ไม่เท่านี้ แก้ตรงไหน"
              ถ้าไม่ตอบไว้ตรงนี้ คนอ่านจะพยายามแก้ที่รอบ (ซึ่งแก้ไม่ได้) แล้วสรุปว่าระบบทำไม่ได้ */}
          {detail.status === 'draft' && (
            <p className="muted payroll-freshness">
              ยอดของแต่ละคนตั้งตอนปล่อยค่าจ้าง — แตะชื่อคนเพื่อกางดูว่ามาจากเคสไหน
              แล้วกดชื่อเคสเพื่อไปที่แท็บ “ปล่อยค่าจ้าง” สำหรับปรับส่วนแบ่งหรือถอนงวดที่ปล่อยผิดคืน
            </p>
          )}

          {detail.items.length === 0 ? (
            <p className="muted">ไม่มีใครอยู่ในรอบนี้แล้ว</p>
          ) : (
            <div className="payroll-people">
              {/* แถวคน (ชื่อ | ยอด+ปุ่ม) กับที่มารายเคส เป็นคนละชั้นกัน — ที่มาเป็นของทั้งแถว
                  ไม่ใช่ของคอลัมน์ซ้าย ถ้ายัดไว้ในคอลัมน์ซ้าย พอจอแคบแล้วบล็อกซ้ายสูงขึ้น
                  ยอดเงินจะถูกดันลงไปอยู่ท้ายรายการเคส ห่างจากชื่อที่มันเป็นยอดของ */}
              {detail.items.map((i) => (
                <div className="payroll-person" key={i.item_id}>
                  <div className="history-item">
                  <div>
                    {/* ทั้งบล็อกซ้ายกดได้ ไม่ใช่ปุ่มเล็กๆ ท้ายแถว — ที่มาของยอดคือสิ่งที่คนกดหาจริง
                        และแถวนี้ก็ไม่มีการกระทำอื่นที่การกดจะไปชนได้ */}
                    <button className="linkish" onClick={() => toggleItem(i.item_id)}>
                      <strong>{i.employee_name}</strong>
                    </button>
                    <p className="muted">
                      {i.cases} เคส · {i.payouts} งวด
                      <span className="cell-sub">
                        {openItemId === i.item_id ? 'แตะเพื่อย่อ' : 'แตะชื่อเพื่อดูว่ามาจากเคสไหน งวดไหน'}
                      </span>
                    </p>
                  </div>
                  <div className="payroll-people-end">
                    <strong>{formatBaht(i.total_pay)}</strong>
                    {detail.status === 'draft' && (
                      <ConfirmButton
                        className="btn tiny danger-ghost"
                        disabled={busy}
                        title={`เอา ${i.employee_name} ออกจากรอบนี้?`}
                        detail="ค่าจ้างของเขาจะกลับเข้ากองรอจ่าย แล้วไปโผล่ในรอบถัดไปเอง — ไม่ใช่การตัดสิทธิ์"
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

                  {/* รวมทุกเคสเป็นยอดเดียวด้านขวา แต่กางแล้วต้องบอกได้ว่ามาจากเคสไหน เท่าไหร่
                      และเป็นงวดที่เท่าไหร่ของเคสนั้น — ตัวเลขที่ตรวจสอบไม่ได้คือตัวเลขที่ต้องมาถามคน */}
                  {openItemId === i.item_id &&
                    (itemCases === null ? (
                      <p className="muted">กำลังโหลด…</p>
                    ) : (
                      <ul className="plain-list payroll-item-cases">
                        {itemCases.map((c) => (
                          <li key={c.payout_id}>
                            {/* ชื่อเคสเป็นลิงก์ = ทางไปแก้ยอดของคนนี้เคสนี้ (ปรับส่วนแบ่ง/ถอนงวดคืน)
                                ยอดในรอบเป็นแค่ภาพสะท้อนของสิ่งที่ตกลงไว้ที่เคส แก้ที่นี่ไม่ได้โดยตั้งใจ —
                                ถ้าแก้ได้สองที่ ตัวเลขบนเคสกับตัวเลขที่โอนจริงจะเดินคนละทางทันที */}
                            <span>
                              <Link className="link" to={`/payroll?tab=release&open=${c.case_id}`}>
                                {c.client_name ?? c.case_title ?? 'เคสที่ถูกลบแล้ว'}
                              </Link>
                              <span className="cell-sub mono">{c.case_id}</span>
                            </span>
                            <span>
                              {formatBaht(c.amount)}
                              {/* งวดไหนของเคสไหน และนัดจ่ายไว้วันไหน — สามอย่างนี้คือสิ่งที่ต้องเห็น
                                  ก่อนกดอนุมัติจ่าย ไม่ใช่แค่ยอดรวมที่ตรวจกับอะไรไม่ได้ */}
                              <span className="cell-sub">
                                งวดที่ {c.installment_no}
                                {c.case_installments > 1 ? `/${c.case_installments}` : ''}
                                {c.due_date && ` · นัดจ่าย ${formatDate(c.due_date)}`}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ))}
                </div>
              ))}
            </div>
          )}

          {/* วันที่จ่ายโชว์ค้างไว้เลยตอนเป็นร่าง ไม่ต้องกดปุ่มเพื่อให้ฟอร์มโผล่มาก่อน —
              ปกติคือวันนี้ซึ่งถูกอยู่แล้ว คนที่ต้องแก้คือคนที่ลงย้อนหลัง ซึ่งเป็นส่วนน้อย
              ช่อง "ช่องทาง" ถูกตัดออก: ไม่มีหน้าไหนเอาไปใช้ตัดสินใจอะไรต่อ เป็นแค่ช่องให้กรอกเพิ่ม
              ตอนที่คนกำลังอยากกดจบ (ประวัติการโอนจริงอยู่ที่สลิปธนาคาร ไม่ใช่ที่นี่) */}
          {detail.status === 'draft' && (
            <div className="payroll-pay">
              <label>วันที่จ่าย
                <input
                  type="date"
                  value={payForm?.pay_date ?? todayTH()}
                  onClick={openDatePicker}
                  onChange={(e) => setPayForm({ pay_date: e.target.value })}
                />
              </label>
            </div>
          )}

          {/* เรียงเป็นคู่: แถวบน = ทำต่อกับรอบ · แถวล่าง = เลิกกับรอบ
              ปุ่มทำลายอยู่ท้ายสุดเสมอ ห่างจากปุ่มที่กดกันจริงที่สุดเท่าที่กริดจะทำได้ */}
          <div className="payroll-actions">
            {detail.status === 'draft' && (
              <>
                {/* ใช้ตอนปล่อยค่าจ้างเพิ่มหลังเปิดรอบไปแล้ว — ยอดที่ปล่อยใหม่ไม่ไหลเข้ารอบที่เปิดค้างไว้เอง */}
                <ConfirmButton
                  className="btn"
                  disabled={busy}
                  title="ดึงค่าจ้างที่ปล่อยเพิ่มเข้ารอบนี้?"
                  detail="ระบบจะกวาดรายชื่อใหม่ทั้งรอบ — คนที่เคยเอาออกจากรอบไปจะกลับเข้ามาด้วย"
                  confirmLabel="ดึงยอดเพิ่ม"
                  onConfirm={() =>
                    run(async () => {
                      const v = await api.rebuildPayrollRun(detail.run_id);
                      setDetail(v);
                      toast('ดึงยอดที่ปล่อยเพิ่มแล้ว');
                    })
                  }
                >
                  ดึงยอดเพิ่ม
                </ConfirmButton>

                <ConfirmButton
                  className="btn primary"
                  disabled={busy || detail.employees === 0}
                  danger={false}
                  title={`บันทึกการจ่ายรอบ ${detail.run_id}?`}
                  detail={`${detail.employees} คน · ${formatBaht(detail.total_pay)} — หลังจากนี้ตัวเลขทั้งรอบถูกตรึง แก้ได้ทางเดียวคือยกเลิกรอบ`}
                  confirmLabel="บันทึกการจ่าย"
                  onConfirm={() =>
                    run(async () => {
                      const v = await api.payPayrollRun(detail.run_id, {
                        pay_date: payForm?.pay_date ?? todayTH(),
                      });
                      setDetail(v);
                      setPayForm(null);
                      toast(`จ่ายรอบ ${v.run_id} แล้ว`);
                    })
                  }
                >
                  บันทึกการจ่าย
                </ConfirmButton>
              </>
            )}

            {detail.status !== 'cancelled' && (
              <ConfirmButton
                className="btn"
                disabled={busy}
                title={`ยกเลิกรอบ ${detail.run_id}?`}
                detail="รอบยังอยู่เป็นประวัติ แต่ค่าจ้างทุกก้อนจะกลับเข้ากองรอจ่าย แล้วไปโผล่ในรอบถัดไป"
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

            {/* ปุ่ม "ลบรอบนี้" ถูกตัดออก — สำหรับรอบร่าง มันให้ผลเหมือน "ยกเลิกรอบ" แทบทุกอย่าง
                (ค่าจ้างกลับเข้ากองรอจ่ายเหมือนกัน) ต่างแค่ลบประวัติทิ้ง ซึ่งไม่ใช่สิ่งที่ใครต้องการจริง
                ปุ่มทำลายสองปุ่มติดกันที่ผลลัพธ์เกือบเหมือนกัน มีแต่ทำให้ต้องหยุดคิดว่าจะกดอันไหน
                (เส้นฝั่ง server ยังอยู่ เผื่อวันหนึ่งต้องล้างรอบร่างที่สร้างผิดจริงๆ) */}
          </div>
        </section>
      )}
    </>
  );
}

/* สามแท็บคือสายพานของ "เงินที่ต้องจ่ายพนักงาน" เรียงซ้ายไปขวาตามลำดับที่ทำจริง:

     1 ปล่อยค่าจ้าง → หักส่วนบริษัทแล้วแบ่งค่าจ้างของเคสเป็นงวด ใครได้เท่าไหร่ นัดจ่ายวันไหน
     2 อนุมัติจ่าย  → ตรวจว่ารอบนี้จะจ่ายใครเท่าไหร่จากเคสไหน แล้วโอนออกจริง
     3 สรุปเงินได้  → ใครได้ไปเท่าไหร่ จากเคสอะไรบ้าง ไว้ตรวจย้อนหลัง/ส่งบัญชี

   ติดเลขลำดับไว้บนแท็บเพราะสามชื่อนี้อ่านแยกกันแล้วไม่บอกว่าอะไรมาก่อนอะไร — โดยเฉพาะ
   "ปล่อยค่าจ้าง" กับ "อนุมัติจ่าย" ที่ฟังดูเหมือนเป็นเรื่องเดียวกันทั้งที่เป็นคนละขั้น

   เคยมีแท็บ "ยืนยันกะ" นำหน้าอยู่ ตอนที่กะเป็นประตูของเงิน — ย้ายกลับไปหน้า "การมาทำงาน" แล้ว
   เพราะประตูของเงินคือการปิดเคส ไม่ใช่ตารางกะ การมีขั้นที่ไม่กระทบเงินปนอยู่ในสายพานนี้
   ทำให้เข้าใจผิดว่าต้องยืนยันกะให้ครบก่อนถึงจะจ่ายได้ ซึ่งไม่จริงและทำให้เงินค้างโดยไม่จำเป็น */
const TABS = {
  release: 'ปล่อยค่าจ้าง',
  runs: 'อนุมัติจ่าย',
  summary: 'สรุปเงินได้',
};

/** ลำดับขั้น = ลำดับคีย์ใน TABS — เขียนไว้ที่เดียว จะได้ไม่มีวันหลุดจากกันเอง */
const TAB_ORDER = Object.keys(TABS);

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
  /* เปิดหน้ามาอยู่ที่ขั้นแรกเสมอ — เดิมเปิดมาที่ "รอบจ่าย" ซึ่งเป็นขั้นที่สาม
     คนเปิดหน้าจึงเห็นปลายทางก่อนต้นทาง แล้วต้องย้อนกลับไปหาเองว่าเริ่มตรงไหน */
  const tab = TABS[get('tab')] ? get('tab') : TAB_ORDER[0];
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
          {/* คำโปรยต้องเป็นชื่อแท็บเรียงตามลำดับเป๊ะๆ ไม่ใช่คำอธิบายคนละชุด —
              ไม่งั้นมันกลายเป็นข้อมูลที่ต้องจับคู่กับแท็บเอาอีกที */}
          <p className="muted">ปล่อยค่าจ้าง → อนุมัติจ่าย → สรุปเงินได้</p>
        </div>
      </header>

      <div className="att-tabs" role="tablist" aria-label="มุมมองค่าตอบแทน">
        {Object.entries(TABS).map(([key, label], i) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`att-tab ${tab === key ? 'is-active' : ''}`}
            onClick={() => patch({ tab: key === TAB_ORDER[0] ? '' : key })}
          >
            <span className="tab-step">{i + 1}</span>
            {label}
          </button>
        ))}
      </div>

      {tab === 'release' && (
        <PayQueue
          reloadKey={reloadKey}
          openCase={get('open')}
          onOpenCase={(id) => patch({ open: id })}
        />
      )}
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
