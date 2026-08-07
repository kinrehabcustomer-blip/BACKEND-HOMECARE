import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatBaht } from '../labels.js';
import LineIcon from '../components/LineIcon.jsx';
import ErrorBar from '../components/ErrorBar.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import PageRefresh from '../components/PageRefresh.jsx';

const TIERS = ['CG', 'NA', 'PN', 'RN'];
const CATEGORY_LABELS = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน' };

/**
 * ระดับการดูแลของแต่ละเกรด ไล่ตามลำดับเกรด (เกรด 1 = เบาสุด)
 * ผูกกับ "ลำดับ" ไม่ใช่ชื่อหรือ id — เกรดที่ 4 ขึ้นไปถ้ามีในอนาคตจะไม่มีป้ายกำกับ ไม่พัง
 */
const CARE_LEVELS = ['Light Care', 'Medium Care', 'Heavy Care'];
const careLevelOf = (index) => CARE_LEVELS[index] ?? null;

const cellKey = (formatId, gradeId, tier) => `${formatId}:${gradeId ?? 'x'}:${tier}`;

/** ช่องกรอกว่าง = ไม่ได้ตั้งค่า (null) ไม่ใช่ศูนย์ */
const num = (v) => (v === '' || v == null ? null : Number(v));

const NUM_FIELDS = ['customer_price', 'staff_pay', 'discount_percent', 'discount_amount'];

/**
 * ช่องนี้ยังเหมือนตอนเปิดโหมดแก้อยู่ไหม
 *
 * เทียบผ่าน num() ไม่ใช่ === ตรงๆ เพราะค่าที่โหลดมาจากฐานข้อมูลเป็นตัวเลข (15000)
 * แต่พอผู้ใช้พิมพ์ทับจะกลายเป็นข้อความ ("15000") — พิมพ์เลขเดิมกลับเข้าไปจึงต้องนับว่า "ไม่เปลี่ยน"
 */
const sameCell = (a, b) =>
  Boolean(a) && Boolean(b) && a.available === b.available && NUM_FIELDS.every((k) => num(a[k]) === num(b[k]));

/**
 * ส่วนลดเป็นบาท — สูตรเดียวกับฝั่ง server (packages/repo.js)
 * กรอก % ไว้ให้ใช้ % ก่อน ไม่งั้นใช้จำนวนเงิน · ตัดไม่ให้เกินราคาเต็ม ราคาสุทธิจะได้ไม่ติดลบ
 */
function discountOf(price, percent, amount) {
  if (price == null || price <= 0) return 0;
  const raw = percent != null && percent > 0 ? (price * percent) / 100 : (amount ?? 0);
  return Math.min(Math.max(raw, 0), price);
}

/**
 * เซลล์ราคา 1 ช่อง — โหมดดู: ราคาสุทธิ (+ ราคาเต็มขีดฆ่าถ้ามีส่วนลด) · โหมดแก้: ราคา + ส่วนลด %/บาท
 *
 * ประกาศไว้นอก PackagesPage โดยตั้งใจ — ถ้าประกาศข้างในจะกลายเป็น component "ชนิดใหม่" ทุกครั้งที่ state เปลี่ยน
 * React จะถอด input ทิ้งแล้วสร้างใหม่ทุกตัวอักษรที่พิมพ์ ทำให้โฟกัสหลุดจนพิมพ์ตัวเลขต่อกันไม่ได้
 */
function RateCell({ editing, rate, draft, changed, onPatch }) {
  if (editing) {
    const dv = draft ?? {
      customer_price: '', staff_pay: '', discount_percent: '', discount_amount: '', available: true,
    };
    // ทำเครื่องหมายช่องที่แก้ไปแล้ว — ตารางมีเป็นร้อยช่อง ไล่หาเองว่าแตะอะไรไปบ้างไม่ไหว
    // และเป็นตัวเดียวกับที่ตัดสินว่าช่องไหนจะถูกส่งขึ้น server ตอนกดบันทึก
    const mark = changed ? ' is-changed' : '';
    if (!dv.available) {
      return (
        <td className={`rate-off${mark}`}>
          <button type="button" className="btn tiny" onClick={() => onPatch({ available: true })}>
            เปิดช่องนี้
          </button>
        </td>
      );
    }

    const price = dv.customer_price === '' ? null : Number(dv.customer_price);
    const cut = discountOf(price, num(dv.discount_percent), num(dv.discount_amount));
    const net = price != null ? price - cut : null;
    const pay = num(dv.staff_pay);
    // กำไรคิดจากราคาสุทธิ (เงินที่เก็บได้จริง) ไม่ใช่ราคาตั้ง — ตั้งส่วนลดแล้วกำไรต้องลดตาม
    const profit = net != null && pay != null ? net - pay : null;

    return (
      <td className={`rate-input${mark}`}>
        <div className="rate-edit">
          <div className="rate-edit-row">
            <input
              type="number" min="0" step="100" placeholder="ราคา" value={dv.customer_price}
              onChange={(e) => onPatch({ customer_price: e.target.value })}
            />
            <button
              type="button" className="btn tiny ghost" title="ปิดช่องนี้ (ให้บริการไม่ได้)"
              onClick={() => onPatch({ available: false })}
            >
              <LineIcon name="close" />
            </button>
          </div>
          {/* ค่าจ้างพนักงาน — ตัวตั้งของสรุปค่าตอบแทนรายเดือน ไม่มีช่องนี้ระบบคำนวณค่าแรงให้ใครไม่ได้เลย */}
          <div className="rate-edit-row">
            <input
              type="number" min="0" step="100" placeholder="ค่าจ้าง" title="ค่าจ้างพนักงานต่อรอบบริการ"
              value={dv.staff_pay}
              onChange={(e) => onPatch({ staff_pay: e.target.value })}
            />
          </div>
          <div className="rate-edit-row">
            <input
              type="number" min="0" max="100" step="1" placeholder="ลด %" title="ส่วนลดเป็นเปอร์เซ็นต์"
              value={dv.discount_percent}
              onChange={(e) => onPatch({ discount_percent: e.target.value })}
            />
            <input
              type="number" min="0" step="100" placeholder="ลด ฿" title="ส่วนลดเป็นจำนวนเงิน (ใช้เมื่อไม่ได้กรอก %)"
              value={dv.discount_amount}
              onChange={(e) => onPatch({ discount_amount: e.target.value })}
            />
          </div>
          {/* คำนวณให้เห็นทันทีระหว่างพิมพ์ — สูตรเดียวกับที่ server ใช้ */}
          {price != null && (
            <span className="rate-net">
              {cut > 0 ? `สุทธิ ${formatBaht(net)}` : 'ไม่มีส่วนลด'}
              {profit != null && ` · กำไร ${formatBaht(profit)}`}
            </span>
          )}
        </div>
      </td>
    );
  }

  if (!rate || !rate.available) return <td className="rate-off">ให้บริการไม่ได้</td>;
  if (rate.customer_price == null) return <td className="rate-price">—</td>;

  const discounted = rate.discount_value > 0;
  return (
    <td className="rate-price">
      {discounted && <span className="rate-was">{formatBaht(rate.customer_price)}</span>}
      {formatBaht(discounted ? rate.net_price : rate.customer_price)}
      {discounted && (
        <span className="rate-cut">
          −{rate.discount_percent > 0 ? `${rate.discount_percent}%` : formatBaht(rate.discount_value)}
        </span>
      )}
      {/* ค่าจ้างพนักงาน + กำไรที่เหลือ — ช่องที่ยังไม่ได้ตั้งต้องเห็นชัด เพราะสรุปค่าตอบแทนจะคิดไม่ได้ */}
      {rate.staff_pay != null ? (
        <span className="rate-staff">
          จ้าง {formatBaht(rate.staff_pay)}
          {rate.margin != null && ` · กำไร ${rate.margin}%`}
        </span>
      ) : (
        <span className="rate-staff is-missing">ยังไม่ตั้งค่าจ้าง</span>
      )}
    </td>
  );
}

/** ตารางเรทหนึ่งกลุ่ม (รายวัน/สัปดาห์ = ไม่อิงเกรด · รายเดือน = แยกตามเกรด) */
function RateTable({ label, formats, gradeId, editing, rateMap, draft, dirty, onPatchCell }) {
  if (formats.length === 0) return <p className="muted">ยังไม่มีรูปแบบบริการในกลุ่มนี้</p>;

  return (
    <div className="table-wrap">
      <table className={`table rate-table ${editing ? 'is-editing' : ''}`}>
        {/* ล็อกความกว้างคอลัมน์ให้คงที่ — ทุกตารางจึงมีคอลัมน์รูปแบบ + ระดับพนักงานเท่ากันหมด แถบสีตรงกันทุกตาราง
            สร้าง <col> ของ tier จาก TIERS เพื่อให้เพิ่ม/ลดระดับพนักงานแล้วจำนวนคอลัมน์ตรงกับหัวตารางเสมอ */}
        <colgroup>
          <col className="rate-col-format" />
          {TIERS.map((t) => <col key={t} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="rate-format-head">{label}</th>
            {TIERS.map((t) => (
              <th key={t} className={`tier-head tier-${t}`}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {formats.map((f) => (
            <tr key={f.format_id}>
              <td className="rate-format">{f.name}</td>
              {TIERS.map((t) => {
                const key = cellKey(f.format_id, gradeId, t);
                return (
                  <RateCell
                    key={t}
                    editing={editing}
                    rate={rateMap[key]}
                    draft={draft[key]}
                    changed={dirty.has(key)}
                    onPatch={(patch) => onPatchCell(key, patch)}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PackagesPage() {
  const [matrix, setMatrix] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // กางกล่องยืนยันตอนกดยกเลิกทั้งที่แก้ไปแล้ว — ไม่ใช้ confirm() ของเบราว์เซอร์ ซึ่งถูกบล็อกได้แล้วคืน false เงียบๆ
  const [discardOpen, setDiscardOpen] = useState(false);
  // ค่าตอนกดเข้าโหมดแก้ ไว้เทียบว่าช่องไหนถูกแก้จริง — เป็น ref เพราะไม่ได้ใช้วาดหน้าจอ ไม่ต้อง re-render
  const baseline = useRef({});

  useEffect(() => {
    setLoading(true);
    api
      .packageMatrix()
      .then((m) => {
        setMatrix(m);
        setError(null); // โหลดผ่านแล้ว error ของรอบก่อนต้องหายไปด้วย
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  // ช่องที่ต่างจากตอนเปิดโหมดแก้ — ใช้ทั้งตัดสินว่าจะส่งอะไรขึ้น server, ทำเครื่องหมายบนตาราง และเตือนก่อนออก
  const dirtyKeys = Object.keys(draft).filter((k) => !sameCell(draft[k], baseline.current[k]));

  /* ปิดแท็บ/กดรีเฟรชทั้งที่แก้ราคาค้างอยู่ — ให้เบราว์เซอร์ถามก่อน
     ตารางนี้แก้ทีเดียวได้หลายสิบช่อง เสียไปทั้งชุดเพราะเผลอกดปุ่มเดียวคือกรอกใหม่ทั้งหมด
     ฟอร์มเคส/ลูกค้า/ผู้ป่วย/พนักงานเตือนไว้หมดแล้ว ตารางที่ใหญ่ที่สุดกลับไม่มีอะไรกัน
     (เบราว์เซอร์บังคับใช้ข้อความมาตรฐานของตัวเอง กำหนดเองไม่ได้)
     ไม่ใส่ deps โดยตั้งใจ — ต้องผูกใหม่ทุก render เพื่อให้เห็น dirtyKeys ล่าสุดเสมอ */
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!editing || dirtyKeys.length === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  });

  /* ยังไม่มีตารางให้แสดงเลย (โหลดครั้งแรกไม่สำเร็จ) — ไม่มีอะไรให้เก็บไว้จริงๆ
     แต่ต้องมีปุ่มลองใหม่ ไม่ใช่ปล่อยให้ค้างเป็นข้อความแดงจนต้องรีเฟรชเบราว์เซอร์เอง
     ส่วน error ที่เกิดตอนบันทึก/จัดการเกรด จะขึ้นเป็นแถบเหนือตารางโดยไม่ล้างงานที่แก้ค้างไว้ */
  if (!matrix) {
    return error
      ? <ErrorBar message={error} onRetry={reload} />
      : <p className="muted">กำลังโหลด…</p>;
  }

  const sharedFormats = matrix.formats.filter((f) => !f.graded);
  const gradedFormats = matrix.formats.filter((f) => f.graded);
  const rateMap = {};
  for (const r of matrix.rates) rateMap[cellKey(r.format_id, r.grade_id, r.staff_tier)] = r;

  // สร้าง draft ของทุกช่องในตาราง (ช่องที่ยังไม่มีในฐานข้อมูลถือเป็นเปิดให้บริการ ราคาว่าง)
  function startEdit() {
    const d = {};
    for (const f of matrix.formats) {
      const gradeIds = f.graded ? matrix.grades.map((g) => g.grade_id) : [null];
      for (const gid of gradeIds) {
        for (const tier of TIERS) {
          const r = rateMap[cellKey(f.format_id, gid, tier)];
          d[cellKey(f.format_id, gid, tier)] = {
            customer_price: r?.customer_price ?? '',
            staff_pay: r?.staff_pay ?? '',
            discount_percent: r?.discount_percent ?? '',
            discount_amount: r?.discount_amount ?? '',
            available: r ? r.available : true,
          };
        }
      }
    }
    setDraft(d);
    baseline.current = d; // ก้อนเดียวกัน — patchCell สร้างออบเจ็กต์ช่องใหม่เสมอ ของเดิมจึงไม่ถูกแก้ตาม
    setDiscardOpen(false);
    setEditing(true);
  }

  /** ออกจากโหมดแก้ ทิ้ง draft — ใช้ทั้งตอนบันทึกเสร็จและตอนกดยกเลิก */
  function stopEdit() {
    setEditing(false);
    setDiscardOpen(false);
    setDraft({});
    baseline.current = {};
  }

  async function saveRates() {
    /* ส่งเฉพาะช่องที่แก้จริง ไม่ใช่ยกตารางทั้งใบขึ้นไปทุกครั้ง — สองเรื่องพร้อมกัน:
       1. สองคนเปิดแก้คนละช่องพร้อมกัน คนที่กดบันทึกทีหลังเคยทับงานของคนแรกทั้งตารางแบบเงียบๆ
          ส่งเฉพาะช่องของตัวเองแล้ว งานของทั้งคู่รอด (เหลือแต่กรณีแก้ช่องเดียวกันจริงๆ ซึ่งเลี่ยงไม่ได้)
       2. เดิมกดแก้ไขราคาแล้วกดบันทึกโดยไม่แตะอะไรเลย จะสร้างแถวราคาให้ทุกช่องในตาราง
          ช่องที่เคยขึ้นว่า "ให้บริการไม่ได้" (ไม่มีแถว) จะกลายเป็น "—" (มีแถว เปิดขาย ราคาว่าง) ยกแผง
          ทั้งที่ไม่มีใครสั่งให้เปลี่ยน */
    const rates = dirtyKeys.map((key) => {
      const [formatId, gradeId, tier] = key.split(':');
      const dv = draft[key];
      return {
        format_id: Number(formatId),
        grade_id: gradeId === 'x' ? null : Number(gradeId),
        staff_tier: tier,
        customer_price: num(dv.customer_price),
        staff_pay: num(dv.staff_pay),
        discount_percent: num(dv.discount_percent),
        discount_amount: num(dv.discount_amount),
        available: dv.available,
      };
    });

    // ไม่ได้แก้อะไรเลย — ปิดโหมดแก้เฉยๆ (ฝั่ง server ปฏิเสธรายการเปล่าอยู่แล้ว ยิงไปก็ได้ error กลับมางงๆ)
    if (rates.length === 0) return stopEdit();

    setBusy(true);
    setError(null);
    try {
      const updated = await api.saveRates(rates);
      setMatrix(updated);
      stopEdit();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const patchCell = (key, patch) =>
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const dirty = new Set(dirtyKeys);

  return (
    <PageRefresh onRefresh={reload} busy={loading}>
      <header className="page-head">
        <div>
          <h1>แพ็คเกจบริการ (พนักงานพาร์ทไทม์)</h1>
          <p className="muted">
            ตารางเรทตามเกรด × รูปแบบบริการ × ระดับพนักงาน (CG / NA / PN / RN)
            {/* บอกจำนวนที่ค้างไว้ตลอดเวลาที่แก้อยู่ — ตารางยาวกว่าหนึ่งหน้าจอ เลื่อนลงไปแก้ล่างสุด
                แล้วลืมว่ายังไม่ได้บันทึกเป็นเรื่องที่เกิดง่ายมาก */}
            {editing && dirtyKeys.length > 0 && (
              <> · <strong className="flag-text">แก้ไปแล้ว {dirtyKeys.length} ช่อง ยังไม่บันทึก</strong></>
            )}
          </p>
        </div>
        <div className="actions">
          {editing ? (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => (dirtyKeys.length > 0 ? setDiscardOpen(true) : stopEdit())}
              >
                ยกเลิก
              </button>
              <button className="btn primary" disabled={busy} onClick={saveRates}>
                {busy ? 'กำลังบันทึก…' : dirtyKeys.length > 0 ? `บันทึก ${dirtyKeys.length} ช่อง` : 'บันทึกราคา'}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setManaging((v) => !v)}>
                {managing ? 'ปิดการจัดการ' : 'จัดการเกรด/รูปแบบ'}
              </button>
              <button className="btn primary" onClick={startEdit}>แก้ไขราคา</button>
            </>
          )}
        </div>
      </header>

      {/* error ตอนบันทึก/เพิ่ม-ลบเกรด — เป็นแถบเหนือตาราง ห้ามทับทั้งหน้า
          ไม่งั้นราคาที่แก้ค้างไว้หลายสิบช่องจะหายไปพร้อมกับหน้าจอ ทั้งที่ยังอยู่ใน state ครบ

          ไม่มีปุ่มลองใหม่ตรงนี้โดยตั้งใจ — error ที่ถึงจุดนี้มาจากการกดปุ่ม (บันทึก/เพิ่ม/ลบ)
          ซึ่งกดซ้ำได้เองอยู่แล้ว ส่วน "ลองใหม่" ในหน้านี้แปลว่าดึงตารางใหม่จาก server
          ซึ่งเป็นคนละเรื่องกับสิ่งที่เพิ่งล้มเหลว และถ้ากำลังแก้ราคาค้างอยู่จะยิ่งชวนสับสน */}
      <ErrorBar message={error} />

      {/* ยืนยันทิ้งการแก้ — อยู่ใต้แถบปุ่มที่เพิ่งกด ให้เห็นพร้อมกับปุ่มที่ทำให้มันโผล่มา */}
      {discardOpen && (
        <div className="notice pay-form">
          <p>ทิ้งการแก้ราคา <strong>{dirtyKeys.length} ช่อง</strong> ที่ยังไม่ได้บันทึก? กู้คืนไม่ได้</p>
          <div className="pay-form-actions">
            <button className="btn" onClick={() => setDiscardOpen(false)}>กลับไปแก้ต่อ</button>
            <button className="btn danger" onClick={stopEdit}>ทิ้งทั้งหมด</button>
          </div>
        </div>
      )}

      {managing && !editing && (
        <ManagePanel matrix={matrix} onChanged={reload} setError={setError} />
      )}

      <section className="rate-section">
        <h2>รายวัน / รายสัปดาห์ <span className="muted">(เรทเดียว ใช้ร่วมทุกเกรด)</span></h2>
        <RateTable
          label="รูปแบบบริการ" formats={sharedFormats} gradeId={null}
          editing={editing} rateMap={rateMap} draft={draft} dirty={dirty} onPatchCell={patchCell}
        />
      </section>

      {matrix.grades.map((g, i) => (
        <section className="rate-section" key={g.grade_id}>
          <h2>
            {g.name}
            {careLevelOf(i) && ` (${careLevelOf(i)})`}
            {' '}<span className="muted">· รายเดือน</span>
          </h2>
          {g.description && <p className="grade-desc">{g.description}</p>}
          <RateTable
            label="รูปแบบบริการ" formats={gradedFormats} gradeId={g.grade_id}
            editing={editing} rateMap={rateMap} draft={draft} dirty={dirty} onPatchCell={patchCell}
          />
        </section>
      ))}

      {matrix.grades.length === 0 && (
        <p className="muted">ยังไม่มีเกรด — กด "จัดการเกรด/รูปแบบ" เพื่อเพิ่ม</p>
      )}
    </PageRefresh>
  );
}

/** แผงจัดการโครงสร้าง: เพิ่ม/แก้/ลบ เกรด และ รูปแบบบริการ (แต่ละปุ่มยิง API ทันที) */
function ManagePanel({ matrix, onChanged, setError }) {
  const [gradeForm, setGradeForm] = useState({ name: '', description: '' });
  const [formatForm, setFormatForm] = useState({ name: '', category: 'monthly', graded: true });
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card manage-panel">
      <div className="manage-cols">
        <div>
          <h3>เกรด</h3>
          <ul className="manage-list">
            {matrix.grades.map((g, i) => (
              <li key={g.grade_id}>
                <div>
                  <strong>
                    {g.name}
                    {careLevelOf(i) && ` (${careLevelOf(i)})`}
                  </strong>
                  {g.description && <p className="muted">{g.description}</p>}
                </div>
                <ConfirmButton
                  className="btn tiny danger-ghost"
                  disabled={busy}
                  title={`ลบเกรด "${g.name}"?`}
                  detail="ราคาทุกช่องของเกรดนี้จะถูกลบไปด้วย และกู้คืนไม่ได้"
                  confirmLabel="ลบเกรด"
                  onConfirm={() => run(() => api.deleteGrade(g.grade_id))}
                >
                  ลบ
                </ConfirmButton>
              </li>
            ))}
          </ul>
          <div className="manage-add">
            <input
              placeholder="ชื่อเกรด เช่น เกรด 4"
              value={gradeForm.name}
              onChange={(e) => setGradeForm((p) => ({ ...p, name: e.target.value }))}
            />
            <input
              placeholder="คำอธิบาย (ไม่บังคับ)"
              value={gradeForm.description}
              onChange={(e) => setGradeForm((p) => ({ ...p, description: e.target.value }))}
            />
            <button
              className="btn" disabled={busy || !gradeForm.name.trim()}
              onClick={() =>
                run(async () => {
                  await api.createGrade({
                    name: gradeForm.name.trim(),
                    description: gradeForm.description.trim() || null,
                    sort_order: matrix.grades.length + 1,
                  });
                  setGradeForm({ name: '', description: '' });
                })
              }
            >
              + เพิ่มเกรด
            </button>
          </div>
        </div>

        <div>
          <h3>รูปแบบบริการ</h3>
          <ul className="manage-list">
            {matrix.formats.map((f) => (
              <li key={f.format_id}>
                <div>
                  <strong>{f.name}</strong>
                  <p className="muted">
                    {CATEGORY_LABELS[f.category]}
                    {' · '}
                    {f.graded ? 'แยกราคาตามเกรด' : 'เรทเดียวทุกเกรด'}
                  </p>
                </div>
                <ConfirmButton
                  className="btn tiny danger-ghost"
                  disabled={busy}
                  title={`ลบรูปแบบบริการ "${f.name}"?`}
                  detail="ราคาทุกช่องของรูปแบบนี้จะถูกลบไปด้วย และกู้คืนไม่ได้"
                  confirmLabel="ลบรูปแบบ"
                  onConfirm={() => run(() => api.deleteFormat(f.format_id))}
                >
                  ลบ
                </ConfirmButton>
              </li>
            ))}
          </ul>
          <div className="manage-add">
            <input
              placeholder="ชื่อรูปแบบ เช่น รายเดือน 8 ชม."
              value={formatForm.name}
              onChange={(e) => setFormatForm((p) => ({ ...p, name: e.target.value }))}
            />
            <select
              value={formatForm.category}
              onChange={(e) => setFormatForm((p) => ({ ...p, category: e.target.value }))}
            >
              {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={formatForm.graded}
                onChange={(e) => setFormatForm((p) => ({ ...p, graded: e.target.checked }))}
              />
              แยกราคาตามเกรด
            </label>
            <button
              className="btn" disabled={busy || !formatForm.name.trim()}
              onClick={() =>
                run(async () => {
                  await api.createFormat({
                    name: formatForm.name.trim(),
                    category: formatForm.category,
                    graded: formatForm.graded,
                    sort_order: matrix.formats.length + 1,
                  });
                  setFormatForm({ name: '', category: 'monthly', graded: true });
                })
              }
            >
              + เพิ่มรูปแบบ
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
