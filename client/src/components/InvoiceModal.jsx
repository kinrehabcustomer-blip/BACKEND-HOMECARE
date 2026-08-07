import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../toast.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { INVOICE_STATUS_LABELS, amountText, bahtText, docDate } from '../labels.js';
import LineIcon from './LineIcon.jsx';

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** ข้อมูลผู้ออกเอกสาร — แก้ที่เดียวตรงนี้ เปลี่ยนทุกใบ */
const ISSUER = {
  // ไฟล์เดียวกับที่ใช้บนแถบเมนู/หน้าเข้าสู่ระบบ (client/public/) — เปลี่ยนไฟล์ทีเดียวเปลี่ยนทุกที่
  logo: '/logo-navbar.webp',
  name: 'ศูนย์ฟื้นฟูโรคหลอดเลือดสมองคิน',
  address: '6 ซอยนาคนิวาส 18 ถนนนาคนิวาส แขวงลาดพร้าว เขตลาดพร้าว กรุงเทพมหานคร 10230',
  tel: '020201171',
};

/** วันเวลาที่สั่งพิมพ์ มุมขวาบนของเอกสาร (พ.ศ. อัตโนมัติจาก locale ไทย) */
const printStamp = () =>
  new Date().toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * จับคู่ช่องทางชำระเงินกับช่องบนเอกสาร — เก็บเป็นข้อความอิสระ จึงเดาจากคำที่พิมพ์มา
 * ไม่เข้าเงื่อนไขไหนถือเป็นเงินสด (ช่องทางที่ใช้บ่อยสุด)
 */
function paidBy(method, total, status) {
  const blank = { cash: '', credit: '', transfer: '' };
  if (status !== 'paid') return blank;

  const m = (method ?? '').toLowerCase();
  const value = amountText(total);
  if (m.includes('โอน') || m.includes('transfer')) return { ...blank, transfer: value };
  if (m.includes('บัตร') || m.includes('credit')) return { ...blank, credit: value };
  return { ...blank, cash: value };
}

/**
 * popup ใบแจ้งหนี้ — ดูรายละเอียด เปลี่ยนสถานะ และพิมพ์/บันทึกเป็น PDF
 *
 * PDF ใช้เครื่องพิมพ์ของเบราว์เซอร์ (กดพิมพ์ → เลือก "Save as PDF") ไม่ใช้ไลบรารีสร้าง PDF
 * เพราะภาษาไทยมีสระ/วรรณยุกต์ซ้อนกัน ไลบรารีฝั่ง JS มักวางตำแหน่งเพี้ยน
 * ส่วนเบราว์เซอร์ใช้ฟอนต์ Sarabun ที่หน้าเว็บโหลดอยู่แล้ว จึงได้ตัวหนังสือไทยถูกต้องแน่นอน
 */
/** ช่องทางชำระเงิน — ตรงกับ 3 ช่องบนหัวเอกสาร (เงินสด / บัตรเครดิต / โอน) */
const PAYMENT_METHODS = ['เงินสด', 'โอน', 'บัตรเครดิต'];

const today = () => new Date().toISOString().slice(0, 10);

/* ความกว้างกระดาษ A4 คิดเป็นพิกเซลที่ 96dpi (หน่วยอ้างอิงที่ CSS ใช้แปลง mm) — ต้องตรงกับ
   width: 210mm ใน .invoice-doc · เป็นค่าคงที่ ไม่ได้มาจากขนาดจอ อัตราย่อจึงคำนวณจบในรอบเดียว */
const A4_WIDTH = (210 * 96) / 25.4;

export default function InvoiceModal({ invoiceId, siblings = [], onNavigate, onClose, onChanged, onReissued }) {
  const { user } = useAuth();
  const toast = useToast();
  const boxRef = useRef(null);
  // จอแคบ: ปัดลงเพื่อปิด — ใช้ ref เดียวกับ focus trap เพราะ element เดียวแปะสอง ref ไม่ได้
  useSheetSwipe(onClose, boxRef);
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // ฟอร์มรับชำระ — ทำเป็นฟอร์มในหน้าแทน prompt() เพราะเบราว์เซอร์บล็อกกล่องเด้งได้ กดแล้วจะเหมือนปุ่มเสีย
  const [payOpen, setPayOpen] = useState(false);
  const [payDate, setPayDate] = useState(today);
  const [payMethod, setPayMethod] = useState(PAYMENT_METHODS[0]);

  /* ใบแจ้งหนี้เป็นเอกสารกระดาษ A4 ที่สูงกว่าจอมือถือเสมอ — เดิมต้องเลื่อนอ่านทีละส่วน
     จึงย่อทั้งใบให้พอดีกรอบตั้งแต่เปิดมา แล้วแตะเพื่อกางเป็นขนาดเต็มถ้าอยากอ่านละเอียด
     ใช้ transform: scale ไม่ใช่ zoom — zoom จะจัดบรรทัดใหม่ (กลายเป็น "ตัวหนังสือเล็กลง")
     ส่วน scale ย่อทั้งแผ่นตามสัดส่วนจริง เหมือนมองกระดาษไกลๆ ซึ่งเป็นสิ่งที่ต้องการ */
  const bodyRef = useRef(null);
  const fitRef = useRef(null);
  const docRef = useRef(null);
  /* null = แสดงขนาดเต็ม · มีค่า = กำลังย่อ — เก็บความสูงจริงกับอัตราย่อไว้ด้วยกันเป็นก้อนเดียว
     เพราะความสูงกรอบ (= natural × scale) ต้องมาจากการวัดครั้งเดียวกันเสมอ
     ถ้าไปอ่านความสูงจาก ref ตอน render กรอบจะได้เลขของเฟรมก่อน ไม่ตรงกับใบที่เพิ่งย่อ */
  const [fitBox, setFitBox] = useState(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!item || zoomed) { setFitBox(null); return undefined; }

    const measure = () => {
      const doc = docRef.current;
      const box = fitRef.current;
      const body = bodyRef.current;
      if (!doc || !box || !body) return;
      // scrollHeight เป็นค่าจาก layout จึงไม่ถูก transform ที่ครอบอยู่กวน — วัดซ้ำได้ไม่เพี้ยน
      const natural = doc.scrollHeight;

      /* ที่ว่างจริง = ความสูงกรอบเนื้อหา − ของที่อยู่เหนือใบ − ระยะขอบล่าง
         "ของที่อยู่เหนือใบ" คือ padding บนของ .modal-body บวกกล่องเตือน/ฟอร์มรับชำระที่อาจโผล่มา
         ซึ่งสูงไม่เท่ากันในแต่ละใบ จะหักด้วยตัวเลขตายตัวไม่ได้ · บวก scrollTop กลับเข้าไป
         เพราะ rect เป็นตำแหน่งบนจอ ถ้าผู้ใช้เลื่อนอยู่แล้ววัดใหม่ตอนหมุนจอ ระยะจะเพี้ยนไปเท่าที่เลื่อน */
      const bodyTop = body.getBoundingClientRect().top;
      const above = box.getBoundingClientRect().top - bodyTop + body.scrollTop;
      const padBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0;
      const avail = body.clientHeight - above - padBottom;
      if (avail <= 0 || box.clientWidth <= 0) return;

      /* ย่อตามด้านที่คับกว่า — กระดาษกว้างตายตัว 210mm บนมือถือจึงมักติดความกว้างก่อนความสูง
         คิดแต่ความสูงอย่างเดียวแผ่นจะยังล้นออกข้างจนโดนตัดซ้าย-ขวา */
      const scale = Math.min(box.clientWidth / A4_WIDTH, avail / natural);
      // พอดีอยู่แล้ว (จอใหญ่) ไม่ต้องย่อ — ปล่อยเป็นแผ่นขนาดจริงไปเลย
      if (scale >= 1) { setFitBox(null); return; }
      // วัดได้เท่าเดิมให้คืนก้อนเดิมไป — ออบเจ็กต์ใหม่ทุกรอบจะทำให้ render กับ ResizeObserver ปลุกกันไม่จบ
      setFitBox((prev) =>
        prev && prev.natural === natural && prev.scale === scale ? prev : { natural, scale });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bodyRef.current);
    observer.observe(docRef.current);
    return () => observer.disconnect();
    // payOpen อยู่ในรายการด้วยเพราะฟอร์มรับชำระกางอยู่เหนือใบ — กางแล้วที่ว่างหายไปหนึ่งฟอร์ม
    // แต่ตัว .modal-body กับตัวใบไม่ได้เปลี่ยนขนาด ResizeObserver จึงไม่รู้เรื่อง ต้องสั่งวัดใหม่เอง
  }, [item, zoomed, payOpen]);

  const load = () => api.getInvoice(invoiceId).then(setItem);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);
    api
      .getInvoice(invoiceId)
      .then((v) => !cancelled && setItem(v))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [invoiceId]);

  /*
   * ล็อกไม่ให้หน้าหลังเลื่อนตาม + คืนโฟกัสกลับไปที่แถวเดิมตอนปิด (ไม่ใช่ดีดกลับไปต้นหน้า)
   * แยกเป็น effect ที่ทำงานครั้งเดียวตลอดอายุกล่อง — ถ้าไปรวมกับ effect ที่มี deps
   * โฟกัสจะถูกคืนออกไปข้างนอกทุกครั้งที่ deps เปลี่ยน
   */
  useEffect(() => {
    const previous = document.activeElement;
    boxRef.current?.focus();
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  /* ปิดด้วย Esc + ขังโฟกัสไว้ในกล่อง — ถ้าไม่ขัง Tab จะวิ่งไปโดนลิงก์ที่อยู่หลังฉาก */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // ฟอร์มรับชำระเปิดอยู่ Esc ควรพับฟอร์มก่อน ไม่ใช่ปิดทั้งกล่องจนวันที่/วิธีจ่ายที่เลือกไว้หาย
        if (payOpen) setPayOpen(false);
        else onClose();
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
  }, [onClose, payOpen]);

  // ตำแหน่งของใบนี้ในรายการหน้าปัจจุบัน — ใช้ทำปุ่มดูใบก่อนหน้า/ถัดไป
  const index = siblings.indexOf(invoiceId);
  const prevId = index > 0 ? siblings[index - 1] : null;
  const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ชำระแล้วถือเป็น "ใบเสร็จรับเงิน" ตามธรรมเนียมเอกสารไทย · ยังไม่ชำระคือ "ใบแจ้งหนี้"
  const isReceipt = item?.status === 'paid';
  // เอกสารยังอยู่ในมือเรา (ส่งมอบให้ลูกค้าครั้งเดียวตอนพิมพ์) จึงยังรีเฟรช/แก้ได้
  const canEdit = item?.status === 'draft' || item?.status === 'issued';

  /**
   * ยกเลิกใบ — ใบยังอยู่ในระบบ เปลี่ยนสถานะเป็น "ยกเลิก" เก็บไว้เป็นประวัติ
   * ใช้กับใบที่ออกให้ลูกค้าไปแล้ว (ออกใบแล้ว/ชำระแล้ว) ซึ่งไม่ควรลบให้หายไปเฉยๆ
   */
  function cancelInvoice() {
    const warning =
      item.status === 'paid'
        ? `ยกเลิกใบเสร็จ ${item.invoice_id} ที่รับชำระแล้ว?\nใบจะยังอยู่ในระบบเป็นประวัติ แต่ยอดนี้จะไม่ถูกนับเป็นรายได้อีก`
        : `ยกเลิกใบแจ้งหนี้ ${item.invoice_id}?\nใบจะยังอยู่ในระบบเป็นประวัติ ไม่ถูกลบทิ้ง`;
    if (!confirm(warning)) return;

    run(async () => {
      await api.cancelInvoice(item.invoice_id);
      toast(`ยกเลิก ${item.invoice_id} แล้ว`);
    });
  }

  /**
   * ลบใบทิ้งถาวร แล้วถามต่อว่าจะออกใบใหม่ตามข้อมูลปัจจุบันเลยไหม
   * ไม่ออกให้อัตโนมัติ เพราะบางครั้งลบเพราะไม่เก็บเงินเคสนี้แล้ว ไม่ได้จะออกใบแทน
   */
  function deleteInvoice() {
    const warning =
      item.status === 'paid'
        ? `ลบใบเสร็จ ${item.invoice_id} ที่รับชำระแล้วทิ้งถาวร?\nลบแล้วกู้คืนไม่ได้ และเลขที่ใบจะข้าม`
        : `ลบใบแจ้งหนี้ ${item.invoice_id} ทิ้งถาวร?\nลบแล้วกู้คืนไม่ได้ และเลขที่ใบจะข้าม`;
    if (!confirm(warning)) return;

    run(async () => {
      await api.deleteInvoice(item.invoice_id);
      toast(`ลบ ${item.invoice_id} แล้ว`);
      if (!item.case_id) return onClose();

      if (confirm('ลบแล้ว — ออกใบใหม่ตามข้อมูลปัจจุบันของเคสเลยไหม?')) {
        const created = await api.createInvoice({ case_id: item.case_id });
        toast(`ออกใบใหม่ ${created.invoice_id} แล้ว`);
        onReissued?.(created.invoice_id);
      } else {
        onClose(); // ใบที่เปิดอยู่ถูกลบไปแล้ว ค้างหน้าไว้ไม่ได้
      }
    });
  }

  // ชื่อผู้ลงนาม = คนที่กำลังสั่งพิมพ์ — session ส่ง first_name/last_name แยกกันมา ไม่มีฟิลด์ name รวม
  // สำรองด้วยชื่อที่บันทึกไว้ในใบ เผื่อ session โหลดไม่ทันตอนกดพิมพ์
  const printerName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    (isReceipt ? item?.paid_by_name : null) ||
    item?.issued_by_name ||
    '';
  const pay = item ? paidBy(item.payment_method, item.total, item.status) : {};

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* modal-preview = กล่องสูงคงที่เท่าเพดาน ไม่หดตามเนื้อหา — เป็นเงื่อนไขที่ทำให้การวัดพื้นที่ว่าง
          ข้างบนได้เลขคงที่ ไม่ใช่เลขที่ขยับตามขนาดที่เราเพิ่งย่อไปเอง */}
      <div
        className="modal modal-wide modal-preview"
        role="dialog"
        aria-modal="true"
        aria-label="ใบแจ้งหนี้"
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
        {!item && !error && <p className="muted modal-loading">กำลังโหลด…</p>}
        {!item && error && <pre className="error modal-loading">{error}</pre>}

        {item && (
          <>
            <header className="modal-head no-print">
              <div>
                <p className="mono muted">{item.invoice_id}</p>
                <h2>{isReceipt ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้'}</h2>
                <span className={`badge invoice-${item.is_overdue ? 'overdue' : item.status}`}>
                  {item.is_overdue ? 'เกินกำหนดชำระ' : INVOICE_STATUS_LABELS[item.status]}
                </span>
              </div>
              <div className="modal-head-actions">
                {/* ไล่ดูทีละใบได้โดยไม่ต้องปิด-เปิดใหม่ (เฉพาะใบที่อยู่ในหน้ารายการปัจจุบัน) */}
                {siblings.length > 1 && (
                  <span className="modal-nav">
                    <button className="btn icon-btn" disabled={!prevId} onClick={() => onNavigate?.(prevId)} title="ใบก่อนหน้า" aria-label="ใบก่อนหน้า"><LineIcon name="chevron-left" /></button>
                    <button className="btn icon-btn" disabled={!nextId} onClick={() => onNavigate?.(nextId)} title="ใบถัดไป" aria-label="ใบถัดไป"><LineIcon name="chevron-right" /></button>
                  </span>
                )}
                <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
              </div>
            </header>

            <div className="modal-body" ref={bodyRef}>
              {error && <p className="error no-print">{error}</p>}

              {/* ใบร่างระบบอัปเดตตามเคสให้เอง จึงเตือนเฉพาะใบที่ออกไปแล้วและตัวเลขไม่ตรงกับเคส */}
              {/* ฟอร์มรับชำระ — เปิดจากปุ่มท้าย popup */}
              {payOpen && (
                <div className="notice pay-form no-print">
                  <label>
                    วันที่ชำระ
                    <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                  </label>
                  <label>
                    ช่องทาง
                    <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  <div className="pay-form-actions">
                    <button className="btn" disabled={busy} onClick={() => setPayOpen(false)}>ยกเลิก</button>
                    <button
                      className="btn primary"
                      disabled={busy || !payDate}
                      onClick={() =>
                        run(async () => {
                          await api.payInvoice(item.invoice_id, {
                            paid_at: payDate,
                            payment_method: payMethod,
                          });
                          toast(`รับชำระ ${amountText(item.total)} บาท แล้ว`);
                          setPayOpen(false);
                        })
                      }
                    >
                      ยืนยันรับชำระ {amountText(item.total)} บาท
                    </button>
                  </div>
                </div>
              )}

              {/* ข้อมูลในใบไม่ตรงกับเคสแล้ว — ทางแก้ต่างกันตามสถานะ ใบร่างดึงของใหม่ได้เลย ที่ออกไปแล้วต้องออกใบใหม่ */}
              {item.is_stale && item.status !== 'cancelled' && (
                <div className="notice stale-notice no-print">
                  {/* แยกบรรทัดตามสิ่งที่ไม่ตรง — อาจไม่ตรงทั้งค่าจ้างและผู้จ่ายพร้อมกันได้ */}
                  {item.payer_stale && (
                    <p>
                      <LineIcon name="alert" className="text-ico" />ผู้จ่ายของเคสตอนนี้คือ <strong>{item.case_payer_name}</strong>
                      {' '}แต่ใบนี้ออกในชื่อ <strong>{item.bill_to_name}</strong> — ยังไม่ตรงกัน
                    </p>
                  )}
                  {item.fee_stale && (
                    <p>
                      <LineIcon name="alert" className="text-ico" />ค่าจ้างในเคสตอนนี้คือ <strong>{amountText(item.case_fee)}</strong>
                      {' '}แต่ยอดสุทธิของใบนี้เป็น <strong>{amountText(item.total)}</strong> — ยังไม่ตรงกัน
                    </p>
                  )}
                  <p>
                    {canEdit
                      ? 'กดรีเฟรชเพื่อดึงข้อมูลล่าสุดจากเคสมาใส่ใบนี้'
                      : 'ใบที่ชำระแล้วแก้ไม่ได้ ต้องยกเลิกแล้วออกใบใหม่'}
                  </p>
                  <div className="stale-actions">
                    {canEdit ? (
                      <button
                        className="btn primary"
                        disabled={busy}
                        onClick={() => run(() => api.refreshInvoice(item.invoice_id))}
                      >
                        รีเฟรชจากเคส
                      </button>
                    ) : (
                      <button className="btn danger-ghost" disabled={busy} onClick={deleteInvoice}>
                        ลบแล้วออกใบใหม่
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* กรอบย่อ — สูงเท่าใบหลังย่อแล้ว (transform ไม่ลดพื้นที่ที่ layout จองไว้เอง
                  ถ้าไม่บีบความสูงตรงนี้จะเหลือช่องว่างใต้ใบเท่ากับส่วนที่ย่อหายไป)
                  ปุ่มมุมบนขวาสลับเป็นขนาดเต็ม — ตอนเต็มปล่อยให้ modal เลื่อนอ่านตามปกติ */}
              <div
                className={`invoice-fit ${fitBox ? 'is-fitted' : ''} ${zoomed ? 'is-zoomed' : ''}`}
                ref={fitRef}
                style={fitBox ? { height: fitBox.natural * fitBox.scale } : undefined}
              >
                {/* ใบที่พอดีกรอบอยู่แล้วไม่ต้องมีปุ่ม — "แตะเพื่อดูขนาดเต็ม" ทั้งที่เต็มอยู่แล้วคือปุ่มที่กดไปก็ไม่มีอะไรเกิด */}
                {(fitBox || zoomed) && (
                  <button
                    type="button"
                    className="invoice-zoom no-print"
                    onClick={() => setZoomed((v) => !v)}
                    aria-expanded={zoomed}
                  >
                    {zoomed ? 'ย่อให้พอดีจอ' : 'แตะเพื่อดูขนาดเต็ม'}
                  </button>
                )}

                {/* เอกสารจริงที่จะถูกพิมพ์ — ตอนสั่งพิมพ์ CSS จะซ่อนทุกอย่างนอกกล่องนี้ */}
                <div
                  className="invoice-doc"
                  ref={docRef}
                  style={fitBox ? { transform: `scale(${fitBox.scale}) translateX(-50%)` } : undefined}
                >
                  <p className="inv-printed">วันที่พิมพ์: {printStamp()}</p>

                  <div className="inv-header">
                    <div className="inv-logo">
                      <img src={ISSUER.logo} alt={ISSUER.name} />
                    </div>

                    <h3 className="inv-title">
                      {isReceipt ? 'ใบเสร็จรับเงิน /Receipt' : 'ใบแจ้งหนี้ /Invoice'}
                    </h3>
                    <p className="inv-copy">สำเนา</p>

                    <p className="inv-org">{ISSUER.name}</p>
                    <p className="inv-org-line">{ISSUER.address}</p>
                    <p className="inv-org-line">Tel. {ISSUER.tel}</p>
                    <hr className="inv-rule" />
                  </div>

                  <div className="inv-parties">
                    <div>
                      <p>รหัสลูกค้า : <span className="mono">{item.customer_id ?? '—'}</span></p>
                      <p>คุณ {item.bill_to_name}</p>
                      {item.bill_to_tax_id && (
                        <p>เลขผู้เสียภาษี : <span className="mono">{item.bill_to_tax_id}</span></p>
                      )}
                    </div>
                    <div className="inv-parties-right">
                      <p>Bill No: <strong className="mono">{item.invoice_id}</strong></p>
                      <p>วันที่ /Date : {docDate(item.issue_date)}</p>
                      {item.due_date && <p>ครบกำหนด /Due : {docDate(item.due_date)}</p>}
                    </div>
                  </div>

                  <table className="inv-table">
                    <colgroup>
                      <col style={{ width: '8%' }} />
                      <col />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '20%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>No.</th>
                        <th>รายการ (Description)</th>
                        <th>จำนวน (Qty)</th>
                        <th>จำนวนเงิน (Amount)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="inv-c">1</td>
                        <td>{item.service_description}</td>
                        <td className="inv-c">1</td>
                        <td className="inv-r">{amountText(item.amount)}</td>
                      </tr>
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3} className="inv-r">ยอดรวมทั้งสิ้น/Total</td>
                        <td className="inv-r">{amountText(item.amount)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="inv-r">ส่วนลดที่ได้รับ/Discount</td>
                        <td className="inv-r">{amountText(item.discount)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="inv-r">รวมเงิน(หลังหักส่วนลด)/Sub Total</td>
                        <td className="inv-r">{amountText(item.total)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="inv-r">
                          {isReceipt ? 'จ่ายชำระทั้งสิ้น/Paid' : 'ยอดที่ต้องชำระ/Amount Due'}
                        </td>
                        <td className="inv-r"><strong>{amountText(item.total)}</strong></td>
                      </tr>
                      <tr>
                        <td colSpan={4} className="inv-r inv-words">( {bahtText(item.total)} )</td>
                      </tr>
                    </tfoot>
                  </table>

                  <p className="inv-methods">
                    <span>เงินสด Cash={pay.cash}</span>
                    <span>บัตรเครดิต/Credit Card={pay.credit}</span>
                    <span>โอน/Transfer={pay.transfer}</span>
                  </p>

                  {isReceipt && <p className="inv-line">ได้รับเงินจาก (Received from) คุณ {item.bill_to_name}</p>}
                  <p className="inv-line">หมายเหตุ : {item.note ?? ''}</p>

                  <div className="inv-signs">
                    <div className="inv-sign">
                      <span className="inv-sign-role">ผู้จ่ายเงิน</span>
                      <span className="inv-sign-dots">(...................................................)</span>
                      <span className="inv-sign-name">( คุณ {item.bill_to_name} )</span>
                    </div>
                    {/* ผู้ลงนาม = คนที่กำลังสั่งพิมพ์ (บัญชีที่ล็อกอินอยู่) เพราะเป็นคนยื่นเอกสารให้ลูกค้าจริง
                        ส่วนคนที่ออกใบ/รับเงินยังถูกบันทึกไว้ใน DB (issued_by/paid_by) สำหรับทำรายงาน */}
                    <div className="inv-sign">
                      <span className="inv-sign-role">ผู้ออกเอกสาร / ผู้รับชำระเงิน</span>
                      <span className="inv-sign-dots">(...................................................)</span>
                      <span className="inv-sign-name">( {printerName} )</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <footer className="modal-foot no-print">
              {/* ปุ่มทำลายดันไปชิดซ้ายสุด แยกออกจากกลุ่มปุ่มที่กดกันจริง — ไม่ให้มือไปโดนตอนเล็งปุ่มข้างๆ
                  (อีกปุ่มหนึ่งอยู่ในกล่องเตือน "ไม่ตรงกับเคส" ซึ่งเป็นคนละบริบท จงใจให้อยู่ตรงนั้น)

                  ใบที่รับชำระแล้วให้ "ยกเลิก" ไม่ใช่ "ลบ" — ตัวเลขที่รับมาจริงพร้อมวันที่/ช่องทางที่จ่าย
                  เป็นหลักฐานการเงิน ลบทิ้งแล้วไม่เหลืออะไรบอกว่าเคยรับเงินก้อนนี้มา
                  (ต่างจากใบร่าง/ใบที่ออกผิดซึ่งลบทิ้งได้ ตามที่ตั้งใจไว้ในโค้ดฝั่ง server)
                  ถ้าจำเป็นต้องลบจริงๆ ยกเลิกก่อนแล้วค่อยลบใบที่ยกเลิกได้ — สองจังหวะสำหรับของที่กู้ไม่ได้ */}
              {item.status === 'paid' ? (
                <button className="btn danger-ghost foot-danger" disabled={busy} onClick={cancelInvoice}>
                  ยกเลิกใบนี้
                </button>
              ) : (
                <button className="btn danger-ghost foot-danger" disabled={busy} onClick={deleteInvoice}>
                  ลบใบนี้
                </button>
              )}

              {/* ใบที่ออกให้ลูกค้าไปแล้วแต่ยังไม่ได้เงิน — ยกเลิกได้โดยไม่ต้องลบทิ้ง เก็บไว้เป็นประวัติ
                  endpoint /cancel มีมาตั้งแต่แรกแต่ไม่เคยมีปุ่มเรียกใช้เลย */}
              {item.status === 'issued' && (
                <button className="btn" disabled={busy} onClick={cancelInvoice}>
                  ยกเลิกใบ
                </button>
              )}

              <button className="btn" onClick={() => window.print()}>พิมพ์ / บันทึก PDF</button>

              {/* ใบที่ไม่ตรงกับเคสมีปุ่มรีเฟรชอยู่ในกล่องเตือนแล้ว — ตรงนี้ไว้ให้ใบที่ยอดตรงอยู่แต่
                  อยากดึงข้อมูลใหม่ (เช่น ใบเก่าที่ยังไม่ได้แจกแจงส่วนลด หรือแก้ที่อยู่ลูกค้าทีหลัง) */}
              {canEdit && item.case_id && !item.is_stale && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => run(() => api.refreshInvoice(item.invoice_id))}
                >
                  รีเฟรชจากเคส
                </button>
              )}

              {item.status === 'draft' && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => run(async () => {
                    await api.issueInvoice(item.invoice_id);
                    toast(`ออกใบ ${item.invoice_id} แล้ว`);
                  })}
                >
                  ออกใบแจ้งหนี้
                </button>
              )}
              {(item.status === 'draft' || item.status === 'issued') && (
                <button
                  className={`btn ${item.status === 'issued' ? 'primary' : ''}`}
                  disabled={busy}
                  onClick={() => setPayOpen((v) => !v)}
                >
                  บันทึกการชำระเงิน
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
