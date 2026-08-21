import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { allocateShares, entitlements, round } from '../lib/payShare.js';
import { formatBaht, formatDate, openDatePicker } from '../labels.js';

/**
 * แผงจัดการค่าจ้างของเคสหนึ่งใบ — ใช้ที่แท็บ "ปล่อยค่าจ้าง" ของหน้ารอบจ่าย
 *
 * เดิมแผงนี้ฝังอยู่ในหน้าเคส ซึ่งเป็นหน้าที่เปิดเพื่อดูเรื่องงาน (ตารางกะ รายงานอาการ ใบแจ้งหนี้)
 * คนที่กำลังทำเรื่องเงินจึงต้องเปิดเคสทีละใบ และไม่มีที่ไหนเห็นภาพรวมว่ามีเงินค้างต้องปล่อยกี่เคส
 * ย้ายมาอยู่รวมกับรอบจ่ายแล้ว — เรื่องเงินทั้งสายพาน (อนุมัติ → ปล่อยเป็นงวด → เปิดรอบโอน)
 * จบในหน้าเดียว ส่วนหน้าเคสเหลือแต่เรื่องงานล้วนๆ
 */
/**
 * ค่าจ้างพนักงานของเคส — ยอดเหมาก้อนเดียว ผู้จัดการกดปล่อยเมื่อพร้อมจ่าย
 *
 * เดิมไม่มีแผงนี้ เพราะค่าจ้างถูกเกลี่ยเป็นรายกะให้อัตโนมัติ (ยอดเคส ÷ จำนวนกะ) แล้วไหลเข้ารอบจ่ายเอง
 * ซึ่งแปลว่าไม่มีใครเคย "ตัดสินใจ" จ่าย และตัวเลขก็ขยับเองทุกครั้งที่ตารางกะเปลี่ยน
 * ตอนนี้การจ่ายเป็นการกระทำที่มีคนกด มีวันเวลา และมีชื่อคนกดกำกับ — ยอดตายตัวตั้งแต่วินาทีนั้น
 *
 * โหลดข้อมูลเองแยกจากตัวเคส เพราะต้องรีเฟรชหลังกดปล่อย/ถอนคืนโดยไม่ต้องรีโหลดทั้ง modal
 */
export default function CasePayPanel({ caseId, busy, run, toast }) {
  const [pay, setPay] = useState(null);
  const [amount, setAmount] = useState('');
  /* วันที่นัดจ่ายงวดนี้ — ว่าง = ยังไม่ได้นัด ซึ่งเป็นค่าที่ยอมรับได้ (ไม่ใช่ทุกงวดตกลงวันไว้ตั้งแต่ปล่อย)
     ไม่ตั้งวันนี้เป็นค่าปริยาย เพราะมันจะกลายเป็นวันนัดที่ไม่มีใครตั้งใจ แล้วพนักงานจะรอเก้อ */
  const [due, setDue] = useState('');
  /* จะซอยยอดที่เหลือเป็นกี่งวด — ค่าปริยาย 1 คือ "จ่ายทีเดียวจบ" ซึ่งเป็นกรณีส่วนใหญ่
     ตัวนี้เป็นแค่เครื่องช่วยคิดเลขให้ช่องยอด ไม่ได้ผูกมัดอะไรกับเคส: เลือก 3 แล้วเปลี่ยนใจ
     ปล่อยงวดเดียวจบก็ยังได้ เพราะทุกงวดคิดจากยอดคงเหลือ ณ ตอนนั้นเสมอ
     (ถ้าเก็บเป็น "แผน" ของเคส มันจะกลายเป็นตัวเลขที่ต้องคอยแก้ให้ตรงกับความจริงอีกตัวหนึ่ง) */
  const [parts, setParts] = useState(1);
  /* ส่วนแบ่งรายคนที่ผู้จัดการแก้เอง — null = ยังใช้ข้อเสนอของระบบ ซึ่งเป็นกรณีส่วนใหญ่
     เก็บเป็นข้อความ ไม่ใช่ตัวเลข เพราะช่องที่กำลังพิมพ์อยู่อาจเป็น "" หรือ "7." ชั่วคราว
     ถ้าแปลงเป็นตัวเลขทุกครั้งที่พิมพ์ เคอร์เซอร์จะกระโดดและลบตัวเลขทิ้งไม่ได้ */
  const [split, setSplit] = useState(null);

  useEffect(() => {
    let alive = true;
    setSplit(null);
    setDue('');
    setParts(1);
    api.casePayStatus(caseId).then((d) => alive && setPay(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [caseId]);

  if (!pay) return null;

  const {
    staff_pay: total,
    fee,
    company_share: companyShare,
    released,
    remaining,
    shares,
    payouts,
    has_agreement: hasAgreement,
    max_installments: maxRounds,
    installments_used: used,
    installments_left: left,
    next_installment: nextRound,
    is_final_installment: isFinal,
  } = pay;

  const workers = shares.length;
  const manyHands = shares.length > 1;
  const entitled = entitlements(shares, total);

  /* ยอดของงวดนี้: เว้นว่าง = ยอดคงเหลือทั้งหมด (กรณีปกติ งานจบแล้วจ่ายให้ครบ) */
  const text = amount.trim();
  const value = text === '' ? remaining : Number(text);
  const validAmount = Number.isFinite(value) && value > 0 && value <= remaining;

  /* ส่วนแบ่งของงวดนี้ตามข้อตกลง (หรือหารเท่ากันถ้ายังไม่ได้ตกลงอะไร) พร้อมไล่ชดเชยงวดก่อน
     split เก็บเฉพาะตอนที่ผู้จัดการแก้เฉพาะงวดนี้ — null = ตามข้อตกลง ซึ่งเป็นกรณีส่วนใหญ่ */
  const proposal = validAmount ? allocateShares(shares, value) : [];
  const rows = proposal.map((r) => ({ ...r, text: split?.[r.employee_id] ?? String(r.amount) }));
  const sum = round(rows.reduce((s, r) => s + (Number(r.text) || 0), 0));
  const sumOk = validAmount && sum === round(value);

  /* จัดก้อนเงินเป็น "งวด" ตามที่ผู้จัดการกดปล่อยจริง — หนึ่งครั้งที่กดอาจแตกเป็นหลายแถว
     เพราะมีผู้รับหลายคน ถ้าเรียงเป็นแถวเปล่าๆ เคสที่มีสองคนสองงวดจะกลายเป็นสี่บรรทัด
     ที่อ่านไม่ออกว่าตกลงกันไว้กี่งวด งวดละเท่าไหร่ ซึ่งเป็นคำถามเดียวที่คนเปิดดูหน้านี้ถาม */
  const rounds = [];
  for (const item of payouts) {
    const found = rounds.find((r) => r.no === item.installment_no);
    if (found) {
      found.amount += item.amount;
      found.rows.push(item);
    } else {
      rounds.push({
        no: item.installment_no,
        amount: item.amount,
        released_at: item.released_at,
        due_date: item.due_date,
        rows: [item],
      });
    }
  }
  rounds.sort((a, b) => a.no - b.no);

  async function release() {
    if (!validAmount || !sumOk) return;

    /* เหลือค้างเท่าไหร่หลังงวดนี้ ต้องเห็นก่อนกดยืนยัน —
       "ปล่อย 7,000 เหลืออีก 8,000 จ่ายได้อีก 2 งวด" อ่านจบในบรรทัดเดียว */
    const after = round(remaining - value);
    const tail =
      after === 0
        ? 'ครบค่าจ้างของเคสพอดี'
        : left - 1 === 0
          ? `เหลือ ${formatBaht(after)} ที่จะปล่อยไม่ได้อีก (หมดงวดแล้ว)`
          : `เหลืออีก ${formatBaht(after)} · จ่ายได้อีก ${left - 1} งวด`;

    /* ยืนยันด้วยรายชื่อจริง ไม่ใช่ "ให้ 2 คน" — ตัวเลขรายคนคือสิ่งที่ผิดแล้วแก้ยากที่สุด
       (ถอนคืนได้เฉพาะก้อนที่ยังไม่ถูกจ่ายออกไปจริง) จึงต้องอ่านทวนได้ก่อนกด */
    const who = rows
      .filter((r) => Number(r.text) > 0)
      .map((r) => `  ${r.employee_name} ${formatBaht(Number(r.text))}`)
      .join('\n');
    const ok = confirm(
      `ปล่อยค่าจ้างงวดที่ ${nextRound} จำนวน ${formatBaht(value)}\n${who}\n\n` +
        `${due ? `นัดจ่ายวันที่ ${formatDate(due)}` : 'ยังไม่ได้นัดวันจ่าย'}\n${tail}`,
    );
    if (!ok) return;

    /* เคสคนเดียวส่งแค่ยอดไป ให้ฝั่ง server เป็นคนแบ่ง (ไม่มีอะไรให้แบ่งอยู่แล้ว)
       เคสหลายคนส่งส่วนแบ่งไปด้วยเสมอ แม้ไม่ได้แก้เอง — ตัวเลขที่เห็นบนจอตอนกด
       ต้องเป็นตัวเลขเดียวกับที่ลงฐานข้อมูล ไม่ใช่ของที่ถูกคิดใหม่ระหว่างทาง */
    const body = manyHands
      ? {
          amount: value,
          shares: rows.map((r) => ({ employee_id: r.employee_id, amount: Number(r.text) })),
        }
      : text === ''
        ? {}
        : { amount: value };
    if (due) body.due_date = due;

    run(async () => {
      setPay(await api.releaseCasePay(caseId, body));
      setAmount('');
      setSplit(null);
      setDue('');
      setParts(1);
      toast(`ปล่อยค่าจ้างงวดที่ ${nextRound} จำนวน ${formatBaht(value)} แล้ว — จะเข้ารอบจ่ายถัดไป`);
    });
  }

  return (
    <section className="case-pay">
      {total == null ? (
        <div className="pay-block">
          <p className="muted">
            เคสนี้ยังไม่ได้ตั้งค่าจ้างพนักงาน — แก้ไขเคสเพื่อระบุยอดค่าจ้างก่อนจึงจะปล่อยค่าจ้างได้
          </p>
        </div>
      ) : (
        <>
          {/* ค่าบริการ → ส่วนบริษัท → ค่าจ้างพนักงาน เรียงตามทางเดินของเงินจริง
              คนตั้งยอดคิดเป็น "เคส 20,000 บริษัทเอา 5,000 พนักงานได้ 15,000" ไม่ใช่ตัวเลขลอยๆ ตัวเดียว */}
          <div className="pay-block">
            <p className="muted">
              {fee != null && (
                <span className="cell-sub">
                  ค่าบริการทั้งเคส {formatBaht(fee)}
                  {companyShare != null && ` · ส่วนของบริษัท ${formatBaht(companyShare)}`}
                </span>
              )}
              <strong>ค่าจ้างพนักงาน {formatBaht(total)}</strong>
              <span className="cell-sub">
                ปล่อยแล้ว {formatBaht(released)} · เหลือ {formatBaht(remaining)}
                {used > 0 && ` · แบ่งจ่ายแล้ว ${used} งวด`}
              </span>
              {/* จ่ายพนักงานมากกว่าที่เก็บลูกค้า = เคสขาดทุน ซึ่งเกิดได้จากพิมพ์ผิดหลักเดียว
                  ไม่ใช่หน้าที่ของระบบจะห้าม แต่ต้องไม่ปล่อยให้ผ่านตาไปเงียบๆ */}
              {companyShare != null && companyShare < 0 && (
                <span className="cell-sub flag-text">
                  ค่าจ้างพนักงานมากกว่าค่าบริการ {formatBaht(-companyShare)} — เคสนี้ขาดทุน
                </span>
              )}
            </p>
          </div>

          {/* ---- ข้อตกลงส่วนแบ่ง: เคสคนเดียวไม่มีอะไรให้ตกลง จึงไม่ต้องมีแผงนี้ ---- */}
          {manyHands && (
            <ShareAgreement
              caseId={caseId}
              pay={pay}
              entitled={entitled}
              busy={busy}
              run={run}
              toast={toast}
              onSaved={(next) => {
                setPay(next);
                setSplit(null); // ข้อตกลงเปลี่ยน = ส่วนแบ่งของงวดที่แก้ค้างไว้ไม่เกี่ยวข้องอีกต่อไป
              }}
            />
          )}

          {/* ---- ปล่อยค่าจ้างงวดถัดไป ---- */}
          {remaining > 0 && left === 0 ? (
            /* ทางตันที่ต้องบอกทางออกให้ ไม่ใช่ซ่อนปุ่มเฉยๆ แล้วปล่อยให้งงว่าทำไมยอดยังเหลือแต่กดไม่ได้ */
            <p className="notice">
              เคสนี้แบ่งจ่ายครบ {maxRounds} งวดแล้ว แต่ยังเหลือ {formatBaht(remaining)} —
              ถ้ายังต้องจ่ายอีก ให้ถอนงวดที่ปล่อยผิดคืนก่อน แล้วปล่อยใหม่ให้เต็มยอดในงวดนั้น
            </p>
          ) : remaining > 0 ? (
            <div className="pay-block">
              {workers === 0 ? (
                <p className="muted">
                  เคสนี้ยังไม่มีพนักงานเลย จึงยังไม่รู้ว่าจะจ่ายให้ใคร — มอบหมายพนักงานหรือลงกะให้เคสนี้ก่อน
                </p>
              ) : (
                <>
                  {/* ไม่บอกว่า "งวดที่ 1 จาก 3" เพราะเคสไม่ได้ถูกกำหนดจำนวนงวดไว้ล่วงหน้า —
                      ตัวหารแบบนั้นเป็นคำสัญญาที่ระบบให้ไม่ได้ (ผู้จัดการเปลี่ยนใจกลางทางได้ตลอด)
                      บอกแค่ว่านี่คืองวดที่เท่าไหร่ ซึ่งเป็นข้อเท็จจริงที่นับจากของที่ปล่อยไปแล้ว */}
                  <p className="muted">
                    <strong>งวดที่ {nextRound}</strong>
                    {/* งวดสุดท้ายคือจุดที่ตัดสินใจกลับไม่ได้ — กรอกน้อยกว่ายอดคงเหลือแล้วส่วนที่เหลือ
                        จะปล่อยไม่ได้อีก ต้องเตือนก่อนกด ไม่ใช่มารู้ตอนที่ปุ่มหายไปแล้ว */}
                    {isFinal && (
                      <span className="cell-sub flag-text">
                        งวดสุดท้ายที่เคสนี้ปล่อยได้ — กรอกน้อยกว่า {formatBaht(remaining)} แล้วส่วนที่เหลือจะปล่อยไม่ได้อีก
                      </span>
                    )}
                  </p>

                  {/* เลือกจำนวนงวดเฉพาะตอนที่ยังซอยได้จริง (เหลือมากกว่าหนึ่งงวด)
                      เลือกแล้วช่องยอดถูกเติมให้เป็น "ยอดคงเหลือ ÷ จำนวนงวด" — แก้ทับได้เสมอ */}
                  {left > 1 && (
                    <label className="pay-parts">
                      แบ่งจ่าย
                      <select
                        value={parts}
                        disabled={busy}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setParts(n);
                          setAmount(n === 1 ? '' : String(round(remaining / n)));
                          setSplit(null);
                        }}
                      >
                        {Array.from({ length: left }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>
                            {n === 1 ? 'จ่ายทีเดียวจบ' : `${n} งวด`}
                          </option>
                        ))}
                      </select>
                      {parts > 1 && (
                        <span className="muted">
                          งวดละ {formatBaht(round(remaining / parts))} จาก {formatBaht(remaining)}
                        </span>
                      )}
                    </label>
                  )}

                  <div className="grid cols-2 pay-release-form">
                    <label>
                      ยอดของงวดนี้
                      <input
                        type="number"
                        min="0"
                        step="100"
                        placeholder={`฿${Math.round(remaining)}`}
                        value={amount}
                        disabled={busy}
                        /* เปลี่ยนยอดของงวด = ส่วนแบ่งที่แก้ไว้ใช้ไม่ได้แล้ว (ผลรวมไม่ตรง) จึงทิ้งแล้วเสนอใหม่
                           ปล่อยให้ค้างไว้คือการซ่อนตัวเลขที่ผิดไว้ใต้ยอดใหม่ */
                        onChange={(e) => {
                          setAmount(e.target.value);
                          setSplit(null);
                        }}
                      />
                      <span className="cell-sub">เว้นว่าง = ปล่อยยอดคงเหลือทั้งหมด</span>
                    </label>

                    {/* วันที่นัดจ่ายของงวดนี้ — ติดไปกับงวด ไม่ใช่กับรอบโอน
                        พนักงานจะได้เห็นว่า "งวดที่ 2 นัดไว้ 25 ส.ค." แทนที่จะได้แค่คำว่ารอ
                        ไม่บังคับ เพราะบางงวดปล่อยไว้ก่อนแล้วค่อยนัดวันทีหลังจริงๆ */}
                    <label>
                      นัดจ่ายวันที่
                      <input
                        type="date"
                        value={due}
                        disabled={busy}
                        onClick={openDatePicker}
                        onChange={(e) => setDue(e.target.value)}
                      />
                      <span className="cell-sub">ไม่บังคับ — ว่าง = ยังไม่ได้นัด</span>
                    </label>
                  </div>

                  {/* ปุ่มเทาเฉยๆ ไม่ได้บอกว่าผิดตรงไหน — และยอดที่เกินยอดคงเหลือคือความผิดพลาด
                      ที่เกิดบ่อยที่สุดตอนแบ่งงวด (จำสลับกับค่าจ้างทั้งเคส) */}
                  {text !== '' && !validAmount && (
                    <p className="muted flag-text">
                      ยอดของงวดต้องมากกว่า 0 และไม่เกินยอดคงเหลือ {formatBaht(remaining)}
                    </p>
                  )}

                  {/* ---- งวดนี้ใครได้เท่าไหร่ (พรีวิว แก้เฉพาะงวดนี้ได้) ---- */}
                  {manyHands && (
                    <div className="pay-split">
                      <p className="muted">
                        <strong>งวดนี้แบ่งกันแบบนี้</strong>
                        <span className="cell-sub">
                          คิดจาก{hasAgreement ? 'ส่วนแบ่งที่ตกลงไว้' : 'การหารเท่ากัน'}
                          แล้วไล่ชดเชยงวดก่อนให้แล้ว — แก้เฉพาะงวดนี้ได้ ผลรวมต้องเท่ากับยอดของงวด
                        </span>
                      </p>

                      <ul className="plain-list pay-split-rows">
                        {rows.map((r, i) => {
                          /* ได้ล่วงหน้าเกินส่วนของตัวเองไปแล้วหรือยัง — เทียบกับส่วนแบ่งของทั้งเคส
                             เกิดได้จริงเมื่องวดแรกถูกปล่อยตอนที่ยังไม่มีชื่อคนอื่นในเคส
                             ต้องบอกไว้ ไม่งั้นจะงงว่าทำไมคนนี้ได้ 0 ในงวดนี้ทั้งที่ทำงานอยู่ */
                          const over = round(r.paid - entitled[i]);

                          return (
                            <li key={r.employee_id}>
                              <span>
                                {r.employee_name}
                                {/* ไม่มีจำนวนกะในบรรทัดนี้ — ค่าจ้างไม่ได้หารด้วยจำนวนกะแล้ว
                                    ค่าปริยายคือหารเท่ากันตามหัว ส่วนที่ต่างจากนั้นมาจากข้อตกลงที่คนตั้งเอง
                                    เอาเลขกะมาวางข้างยอดเงินเมื่อไหร่ คนอ่านจะกลับไปคิดว่ายอดมาจากกะทันที */}
                                <span className="cell-sub">
                                  ส่วนของทั้งเคส {formatBaht(entitled[i])} · ได้ไปแล้ว {formatBaht(r.paid)}
                                  {over > 0 && (
                                    <span className="flag-text"> · ได้ล่วงหน้าเกินไป {formatBaht(over)}</span>
                                  )}
                                </span>
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="100"
                                className="visit-pay-input"
                                value={r.text}
                                disabled={busy}
                                onChange={(e) =>
                                  setSplit({
                                    ...Object.fromEntries(rows.map((x) => [x.employee_id, x.text])),
                                    [r.employee_id]: e.target.value,
                                  })
                                }
                              />
                            </li>
                          );
                        })}
                      </ul>

                      <p className={`muted pay-split-sum ${sumOk ? '' : 'flag-text'}`}>
                        <span>
                          รวม {formatBaht(sum)} จาก {validAmount ? formatBaht(value) : '—'}
                          {validAmount && !sumOk && ` · ต่างอยู่ ${formatBaht(round(value - sum))}`}
                        </span>
                        {split && (
                          <button className="btn tiny" disabled={busy} onClick={() => setSplit(null)}>
                            คืนค่าที่ระบบเสนอ
                          </button>
                        )}
                      </p>
                    </div>
                  )}

                  <div className="approve-row">
                    <button className="btn primary" disabled={busy || !validAmount || !sumOk} onClick={release}>
                      ปล่อยงวดที่ {nextRound}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {/* ประวัติการจ่ายเรียงตามงวด ไม่ใช่ตามเวลาที่กด — คนอ่านหาว่า "งวดที่ 2 จ่ายไปหรือยัง"
              ไม่ได้หาว่า "เมื่อวานกดอะไรไปบ้าง" */}
          {rounds.map((r) => (
            <div className="pay-block pay-round" key={r.no}>
              <p className="muted">
                <strong>
                  งวดที่ {r.no} · {formatBaht(r.amount)}
                </strong>
                <span className="cell-sub">
                  {r.due_date ? `นัดจ่าย ${formatDate(r.due_date)} · ` : ''}
                  ปล่อยเมื่อ {formatDate(r.released_at)}
                </span>
              </p>
              <ul className="plain-list">
                {r.rows.map((item) => (
                  <li key={item.payout_id} className="approve-row">
                    <p className="muted">
                      <strong>
                        {item.employee_name} {formatBaht(item.amount)}
                      </strong>
                      <span className="cell-sub">
                        {item.run_status === 'paid'
                          ? `จ่ายแล้วในรอบ ${item.run_id}`
                          : item.run_id
                            ? `อยู่ในรอบ ${item.run_id} (ยังไม่จ่าย)`
                            : 'รอเข้ารอบจ่าย'}
                      </span>
                    </p>
                    {/* จ่ายออกไปแล้วถอนคืนไม่ได้ — ต้องยกเลิกรอบจ่ายนั้นก่อน (server กันไว้อีกชั้น) */}
                    {item.run_status !== 'paid' && (
                      <button
                        className="btn tiny danger-ghost"
                        disabled={busy}
                        onClick={() => {
                          const ok = confirm(
                            `ถอนค่าจ้างงวดที่ ${r.no} ของ ${item.employee_name} จำนวน ${formatBaht(item.amount)} คืน?`,
                          );
                          if (!ok) return;
                          run(async () => {
                            setPay(await api.cancelCasePayout(caseId, item.payout_id));
                            setSplit(null);
                            toast('ถอนคืนแล้ว');
                          });
                        }}
                      >
                        ถอนคืน
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/**
 * ข้อตกลงส่วนแบ่งของเคส — "เคสนี้ ใครได้เท่าไหร่" ตั้งครั้งเดียว ใช้กับทุกงวด
 *
 * ค่าปริยายคือหารเท่ากัน ซึ่งถูกสำหรับเคสส่วนใหญ่ แผงนี้จึงเป็นบรรทัดเดียวจนกว่าจะกดแก้ —
 * ถ้าโชว์ช่องกรอกของทุกคนไว้ตลอด เคสปกติที่ไม่ต้องตัดสินใจอะไรจะดูเหมือนมีงานค้างให้ทำ
 *
 * แยกออกมาเป็นคอมโพเนนต์ของตัวเองเพราะมันมีสถานะ "กำลังแก้" ของตัวเอง ที่ไม่เกี่ยวกับ
 * การปล่อยเงินเลย — ปนอยู่ในแผงเดียวกันแล้วจะแยกไม่ออกว่าตัวเลขไหนเป็นของข้อตกลง
 * ตัวเลขไหนเป็นของงวดที่กำลังจะปล่อย
 */
function ShareAgreement({ caseId, pay, entitled, busy, run, toast, onSaved }) {
  const { shares, staff_pay: total, has_agreement: hasAgreement, agreed_total: agreedTotal, agreement_matches: agreementOk } = pay;
  const [draft, setDraft] = useState(null); // null = ไม่ได้กำลังแก้

  const open = (rows) => setDraft(Object.fromEntries(shares.map((r, i) => [r.employee_id, String(rows[i])])));

  const sum = draft ? round(Object.values(draft).reduce((s, v) => s + (Number(v) || 0), 0)) : 0;
  const sumOk = draft ? sum === round(total) : false;

  function save() {
    if (!sumOk) return;
    run(async () => {
      const rows = shares.map((r) => ({ employee_id: r.employee_id, share: Number(draft[r.employee_id]) || 0 }));
      onSaved(await api.setCasePayShares(caseId, rows));
      setDraft(null);
      toast('บันทึกส่วนแบ่งของเคสแล้ว — งวดถัดไปจะแบ่งตามนี้');
    });
  }

  function clear() {
    if (!confirm('ล้างข้อตกลง แล้วกลับไปหารเท่ากันทุกคน?')) return;
    run(async () => {
      onSaved(await api.setCasePayShares(caseId, []));
      setDraft(null);
      toast('กลับไปหารเท่ากันแล้ว');
    });
  }

  return (
    <div className="pay-block pay-agreement">
      {draft === null ? (
        <div className="approve-row pay-release-row">
          <p className="muted">
            <strong>
              ส่วนแบ่งของเคส —{' '}
              {hasAgreement ? 'ตกลงกันไว้เป็นพิเศษ' : `หารเท่ากัน ${shares.filter((r) => r.shifts > 0).length} คน`}
            </strong>
            <span className="cell-sub">
              {shares.map((r, i) => `${r.employee_name} ${formatBaht(entitled[i])}`).join(' · ')}
            </span>
            {/* ผลรวมของข้อตกลงหลุดจากค่าจ้างของเคสได้เมื่อยอดถูกแก้ทีหลัง — สัดส่วนยังใช้ได้อยู่
                แต่ตัวเลขที่ตกลงกันไว้ไม่ใช่ตัวเลขที่จะได้จริงแล้ว ต้องบอก ไม่ใช่เกลี่ยเงียบๆ */}
            {!agreementOk && (
              <span className="cell-sub flag-text">
                ข้อตกลงรวม {formatBaht(agreedTotal)} ไม่ตรงกับค่าจ้างของเคส {formatBaht(total)} —
                ระบบใช้เป็นสัดส่วนไปก่อน ควรตั้งใหม่ให้ตรง
              </span>
            )}
          </p>
          <div className="pick-actions">
            <button className="btn tiny" disabled={busy} onClick={() => open(entitled)}>
              แก้ส่วนแบ่ง
            </button>
            {hasAgreement && (
              <button className="btn tiny danger-ghost" disabled={busy} onClick={clear}>
                กลับไปหารเท่ากัน
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <p className="muted">
            <strong>แก้ส่วนแบ่งของเคส</strong>
            <span className="cell-sub">
              ผลรวมต้องเท่ากับค่าจ้างของเคส {formatBaht(total)} — ตัวเลขนี้ใช้กับทุกงวด
              ไม่ใช่เฉพาะงวดถัดไป
            </span>
          </p>

          <ul className="plain-list pay-split-rows">
            {shares.map((r) => (
              <li key={r.employee_id}>
                <span>
                  {r.employee_name}
                  <span className="cell-sub">ได้ไปแล้ว {formatBaht(r.paid)}</span>
                </span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  className="visit-pay-input"
                  value={draft[r.employee_id]}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, [r.employee_id]: e.target.value })}
                />
              </li>
            ))}
          </ul>

          <p className={`muted pay-split-sum ${sumOk ? '' : 'flag-text'}`}>
            <span>
              รวม {formatBaht(sum)} จาก {formatBaht(total)}
              {!sumOk && ` · ต่างอยู่ ${formatBaht(round(total - sum))}`}
            </span>
            <span className="pick-actions">
              {/* หารเท่ากันใหม่คือทางกลับที่เร็วที่สุดเมื่อกรอกจนมั่วแล้ว — และเป็นตัวตั้งที่คนส่วนใหญ่เริ่มจากตรงนี้ */}
              <button
                className="btn tiny"
                disabled={busy}
                onClick={() => open(entitlements(shares.map((r) => ({ ...r, share: null })), total))}
              >
                หารเท่ากัน
              </button>
              <button className="btn tiny" disabled={busy} onClick={() => setDraft(null)}>
                ยกเลิก
              </button>
              <button className="btn primary tiny" disabled={busy || !sumOk} onClick={save}>
                บันทึก
              </button>
            </span>
          </p>
        </>
      )}
    </div>
  );
}
