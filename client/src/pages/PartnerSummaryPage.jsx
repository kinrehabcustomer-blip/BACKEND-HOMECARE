import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBaht, formatDate } from '../labels.js';
import { downloadCsv } from '../lib/attendanceUi.js';
import ErrorBar from '../components/ErrorBar.jsx';
import PageRefresh from '../components/PageRefresh.jsx';
import LineIcon from '../components/LineIcon.jsx';

/** เวลา timestamptz → วันที่ไทย (YYYY-MM-DD) — ตัดสตริง UTC ตรงๆ ได้วันก่อนหน้าช่วงตี 0–7 */
const dateTH = (ts) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

/**
 * หัวหน้าพาร์ทเนอร์ — สรุปรายเดือน (21 พ.ย. 2569)
 * ยอดที่บริษัทจะได้รับ = กะที่ไปจริง (เช็คอิน+เช็คเอาท์) × เรท ณ ตอนที่ KIN ส่งงาน · ขาดงาน = ฿0
 * KIN จ่ายให้บริษัท ค่าจ้างของแต่ละคนบริษัทจ่ายเอง · server: partners/repo.js summary
 *
 * วางหน้า (ผู้ใช้ขอจัด layout 21 พ.ย. 2569):
 *   แถวบน = แถบตัวเลขเต็มความกว้าง (ยอด + สถานะการจ่าย · ไปจริง · ขาดงาน · ปฏิเสธ · เรทต่อครั้ง)
 *   ล่าง  = แยกตามคน (ซ้าย) · ตารางครั้งที่ไป (ขวา) · เดือนที่ยังไม่มีงาน = กล่องว่างกล่องเดียวเต็มความกว้าง
 *   มือถือเรียงลงเป็นคอลัมน์เดียว รายการเป็นแถวการ์ดแทนตาราง
 */
const monthOf = (d = new Date()) => new Date(d.getTime() + 7 * 3.6e6).toISOString().slice(0, 7);
const shift = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const monthName = (ym) => new Date(`${ym}-01T00:00:00+07:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : '');

export default function PartnerSummaryPage() {
  const now = monthOf();
  const [month, setMonth] = useState(now);
  const [data, setData] = useState(null);
  const [rate, setRate] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([api.partnerSummary(month), api.partnerMe().catch(() => null)])
      .then(([d, me]) => { setData(d); setRate(me ?? null); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [month]);
  useEffect(() => { setData(null); load(); }, [load]);

  const max = Math.max(1, ...(data?.by_staff ?? []).map((s) => s.done));
  const empty = data && data.visits.length === 0;
  const exportCsv = () => downloadCsv(`สรุปงานพาร์ทเนอร์_${month}.csv`,
    ['วันที่', 'ผู้รับบริการ', 'คนที่ไป', 'เช็คอิน', 'เช็คเอาท์', 'ผล', 'ยอด'],
    data.visits.map((v) => [v.visit_date, v.client_name, v.employee_name ?? '', hhmm(v.check_in_at), hhmm(v.check_out_at),
      v.done ? 'ไปแล้ว' : 'ขาดงาน', v.amount]));

  return (
    <PageRefresh onRefresh={load} busy={loading}>
      <div className="pt-page">
        <header className="pt-head">
          <div>
            <h1>สรุปรายเดือน</h1>
            <p className="muted">กะที่ไปจริง (เช็คอิน+เช็คเอาท์) × เรทต่อครั้ง · KIN จ่ายให้บริษัทหลังสิ้นเดือน</p>
          </div>
          <div className="pt-head-tools">
            <div className="pt-month" role="group" aria-label="เลือกเดือน">
              <button type="button" className="btn tiny" aria-label="เดือนก่อน" onClick={() => setMonth(shift(month, -1))}>‹</button>
              <span>{monthName(month)}</span>
              <button type="button" className="btn tiny" aria-label="เดือนถัดไป" disabled={month >= now} onClick={() => setMonth(shift(month, 1))}>›</button>
            </div>
            <button type="button" className="btn" disabled={!data?.visits.length} onClick={exportCsv}>
              <LineIcon name="download" className="btn-ico" />ดาวน์โหลด CSV
            </button>
          </div>
        </header>

        <ErrorBar message={error} onRetry={load} busy={loading} />
        {!data ? (!error && <p className="muted">กำลังโหลด…</p>) : (
          <>
            {/* แถบตัวเลข — ยอดเงินเป็นช่องใหญ่ ที่เหลือเป็นไทล์เท่ากัน */}
            <section className="pt-kpis" aria-label={`ตัวเลขเดือน${monthName(month)}`}>
              <div className="pt-card pt-kpi-main">
                <span className="muted">ยอดที่บริษัทจะได้รับ</span>
                <strong className="pt-amount">{formatBaht(data.amount)}</strong>
                {data.payment ? (
                  <span className="pt-paid"><LineIcon name="check" className="text-ico" />KIN จ่ายแล้ว {formatBaht(data.payment.amount)} · {formatDate(dateTH(data.payment.paid_at))}</span>
                ) : (
                  <span className="pt-unpaid">{month >= now ? 'เดือนนี้ยังไม่จบ · ยอดยังเพิ่มได้' : 'ยังไม่จ่าย · KIN ตรวจยอดหลังสิ้นเดือน'}</span>
                )}
              </div>
              <div className="pt-card pt-kpi"><span className="muted">ไปจริง</span><b>{data.done}</b><span className="muted">ครั้ง</span></div>
              <div className="pt-card pt-kpi"><span className="muted">ขาดงาน</span><b className={data.missed ? 'is-warn' : ''}>{data.missed}</b><span className="muted">ครั้ง · ไม่นับเงิน</span></div>
              <div className="pt-card pt-kpi"><span className="muted">ปฏิเสธ</span><b>{data.rejected}</b><span className="muted">งานที่ส่งกลับ KIN</span></div>
              <div className="pt-card pt-kpi"><span className="muted">เรทต่อครั้ง</span><b>{rate?.rate_per_visit != null ? formatBaht(rate.rate_per_visit) : '—'}</b><span className="muted">{Number(rate?.english_rate) > 0 ? `ภาษาอังกฤษ +${formatBaht(rate.english_rate)}/ครั้ง` : 'เรทปัจจุบัน'}</span></div>
            </section>

            {empty ? (
              <section className="pt-card pt-empty">
                <LineIcon name="calendar" className="pt-empty-ico" />
                <strong>{monthName(month)} ยังไม่มีงานที่ไปแล้ว</strong>
                <span className="muted">งานที่ทีมไปเช็คอินและเช็คเอาท์ครบจะนับเข้ายอดของเดือนนี้</span>
                <button type="button" className="btn" onClick={() => setMonth(shift(month, -1))}>‹ ดูเดือนก่อน</button>
              </section>
            ) : (
              <div className="pt-sum-body">
                <section className="pt-card pt-staff" aria-label="แยกตามคน">
                  <h2 className="pt-card-title">แยกตามคน</h2>
                  {data.by_staff.length === 0 ? <p className="muted">ยังไม่มีคนไปครบ</p> : data.by_staff.map((s) => (
                    <div key={s.employee_id ?? s.name} className="pt-bar-row">
                      <div className="pt-bar-label"><span>{s.name}</span><b>{s.done} ครั้ง · {formatBaht(s.amount)}</b></div>
                      <div className="pt-bar" aria-hidden="true"><span style={{ width: `${(s.done / max) * 100}%` }} /></div>
                    </div>
                  ))}
                  <p className="muted">KIN จ่ายให้บริษัท · ค่าจ้างของแต่ละคนบริษัทจ่ายเอง</p>
                </section>

                <section className="pt-card pt-visits" aria-label="รายการครั้งที่ไป">
                  <h2 className="pt-card-title">รายการครั้งที่ไป <span className="muted">{data.visits.length} รายการ</span></h2>
                  {/* จอคอม: ตาราง */}
                  <div className="table-wrap pt-table-wrap">
                    <table className="fin-table pt-table">
                      <thead>
                        <tr><th>วันที่</th><th>ผู้รับบริการ</th><th>คนที่ไป</th><th>เข้า – ออก</th><th>ผล</th><th className="num">ยอด</th></tr>
                      </thead>
                      <tbody>
                        {data.visits.map((v) => (
                          <tr key={v.visit_id}>
                            <td className="nw">{formatDate(v.visit_date)}</td>
                            <td>{v.client_name}</td>
                            <td>{v.employee_name ?? '—'}</td>
                            <td className="nw">{v.done ? `${hhmm(v.check_in_at)} – ${hhmm(v.check_out_at)}` : '—'}</td>
                            <td><span className={`pt-tag ${v.done ? 'is-ok' : 'is-warn'}`}>{v.done ? 'ไปแล้ว' : 'ขาดงาน'}</span></td>
                            <td className={`num ${v.done ? 'pt-money' : 'muted'}`}>{formatBaht(v.amount)}{v.done && Number(v.partner_english) > 0 && <span className="cell-sub">รวมค่าภาษา {formatBaht(v.partner_english)}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr><td colSpan={5}>รวม {data.done} ครั้งที่ไปจริง</td><td className="num pt-money">{formatBaht(data.amount)}</td></tr>
                      </tfoot>
                    </table>
                  </div>
                  {/* มือถือ: แถวการ์ด */}
                  <div className="pt-rows">
                    {data.visits.map((v) => (
                      <div key={v.visit_id} className="pt-row">
                        <span>
                          <b>{formatDate(v.visit_date)} · {v.client_name}</b>
                          <span className={v.done ? 'muted' : 'is-warn'}>
                            {v.employee_name ?? '—'} · {v.done ? `เข้า ${hhmm(v.check_in_at)} · ออก ${hhmm(v.check_out_at)}` : 'ไม่มีการเช็คอิน (ขาดงาน)'}
                          </span>
                        </span>
                        <span className={v.done ? 'pt-money' : 'muted'}>{formatBaht(v.amount)}{v.done && Number(v.partner_english) > 0 && <span className="cell-sub">รวมค่าภาษา {formatBaht(v.partner_english)}</span>}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </PageRefresh>
  );
}
