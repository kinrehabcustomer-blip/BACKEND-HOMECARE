import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useAuth, useCan } from '../auth.jsx';
import { useToast } from '../toast.jsx';
import { useSheetSwipe } from '../lib/sheetSwipe.js';
import { useScrollLock } from '../lib/scrollLock.js';
import { usePrintFit } from '../lib/printFit.js';
import {
  ADJUSTMENT_REASON_LABELS, ADJUSTMENT_REASON_OPTIONS, amountText, docDate, invoiceStatusLabel, todayTH, isPaidReceipt,
} from '../labels.js';
import LineIcon from './LineIcon.jsx';
import ConfirmButton from './ConfirmButton.jsx';
import FinanceReceiptDoc from './FinanceReceiptDoc.jsx';
import CustomerInvoiceDoc, { addonAmount, paidBy } from './CustomerInvoiceDoc.jsx';
import ReceiptDoc from './ReceiptDoc.jsx';
import AdjustmentNoteDoc from './AdjustmentNoteDoc.jsx';
import RefundVoucherDoc from './RefundVoucherDoc.jsx';
import { ACCEPTED, compressImage, formatFileSize } from '../lib/image.js';
import { caseCode } from '../lib/patientCode.js';
import { TRANSFER_PAYMENT_INSTRUCTION } from '../lib/issuer.js';
import { addonLabel } from '../lib/addons.js';
import SearchSelect from './SearchSelect.jsx';


const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/* action คืนค่านี้ = ใบที่เปิดอยู่ถูกลบไปแล้ว ห้ามโหลดซ้ำ
   ไม่งั้น run() จะไปดึงใบที่เพิ่งลบแล้วได้ 404 มาขึ้นเป็นข้อความแดงทับสิ่งที่เพิ่งบอกไป */
const GONE = Symbol('gone');

/**
 * popup ใบแจ้งหนี้ — ดูรายละเอียด เปลี่ยนสถานะ และพิมพ์/บันทึกเป็น PDF
 *
 * PDF ใช้เครื่องพิมพ์ของเบราว์เซอร์ (กดพิมพ์ → เลือก "Save as PDF") ไม่ใช้ไลบรารีสร้าง PDF
 * เพราะภาษาไทยมีสระ/วรรณยุกต์ซ้อนกัน ไลบรารีฝั่ง JS มักวางตำแหน่งเพี้ยน
 * ส่วนเบราว์เซอร์ใช้ฟอนต์ Anuphan ที่หน้าเว็บโหลดอยู่แล้ว จึงได้ตัวหนังสือไทยถูกต้องแน่นอน
 */
/** ช่องทางชำระเงิน — ตรงกับ 3 ช่องบนหัวเอกสาร (เงินสด / บัตรเครดิต / โอน) */
const PAYMENT_METHODS = ['เงินสด', 'โอน', 'บัตรเครดิต'];

/** ยอดของบรรทัดอุปกรณ์ — ปัดแบบเดียวกับ server/src/lib/addons.js */

export default function InvoiceModal({ invoiceId, siblings = [], onNavigate, onClose, onChanged, onReissued }) {
  const { user } = useAuth();
  // ใบลดหนี้ลดรายได้และอาจต้องคืนเงิน — server เปิดให้เฉพาะหมวด money (ใบเพิ่มหนี้ทุกคนที่ทำบิลได้ออกได้)
  // ใบลดหนี้ · ยกเลิกใบ · แก้ข้อมูลเงินคืน — สิทธิ์ invoice_adjust (ตั้งได้ในหน้าจัดการสิทธิ์)
  const canMoney = useCan('invoice_adjust');
  // ลบสลิป (หลักฐานการโอน) — สิทธิ์ slip_delete (ตั้งได้ในหน้าจัดการสิทธิ์)
  const canDeleteSlip = useCan('slip_delete');
  const toast = useToast();
  const boxRef = useRef(null);
  // จอแคบ: ปัดลงเพื่อปิด — ใช้ ref เดียวกับ focus trap เพราะ element เดียวแปะสอง ref ไม่ได้
  useSheetSwipe(onClose, boxRef);
  // พิมพ์ใบแจ้งหนี้/ใบเสร็จให้จบใน A4 แผ่นเดียว (ตัวใบใน .print-sheet ครอบด้วย .inv-fit)
  usePrintFit();
  const [item, setItem] = useState(null);
  /* เอกสารที่ดู/พิมพ์อยู่: 'customer' = ใบแจ้งหนี้ (ชำระแล้วขึ้นเป็นใบเสร็จ) · 'finance' = ใบเสร็จส่วนที่ 2 ของฝ่ายการเงิน
     'rc:<เลขที่>' = ใบเสร็จของการรับเงินครั้งนั้น · 'note:<เลขที่>' = ใบลดหนี้/เพิ่มหนี้ */
  const [docView, setDocView] = useState('customer');
  // ฟอร์มใบลดหนี้/เพิ่มหนี้ — ใบที่ออกแล้วแก้ยอดตรง ๆ ไม่ได้ (4 พ.ย. 2569)
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjKind, setAdjKind] = useState('debit');
  const [adjReasonCode, setAdjReasonCode] = useState('other');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [refundDate, setRefundDate] = useState(todayTH);
  const [refundMethod, setRefundMethod] = useState(PAYMENT_METHODS[1]);
  // ใบลดหนี้/เพิ่มหนี้ที่กำลังจะยกเลิก + เหตุผล
  const [noteCancelFor, setNoteCancelFor] = useState(null);
  const [noteCancelReason, setNoteCancelReason] = useState('');
  // ยกเลิกทั้งใบ — ต้องพิมพ์เหตุผลก่อน (server เก็บเหตุผล + ชื่อคนยกเลิกไว้กับใบ)
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  // แก้ข้อมูลเงินคืนที่กรอกผิด (วันที่ · ช่องทาง · หมายเหตุ) — ยอดแก้ไม่ได้
  const [refundEditFor, setRefundEditFor] = useState(null);
  const [refundEdit, setRefundEdit] = useState({ refunded_at: '', method: '', note: '' });
  // เปิดใบอื่น (กดลูกศรไปใบถัดไป) = เริ่มที่ใบของลูกค้าเสมอ ไม่ค้างหน้าฝ่ายการเงินของใบก่อน
  useEffect(() => setDocView('customer'), [invoiceId]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // ฟอร์มรับชำระ — ทำเป็นฟอร์มในหน้าแทน prompt() เพราะเบราว์เซอร์บล็อกกล่องเด้งได้ กดแล้วจะเหมือนปุ่มเสีย
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');   // ว่าง = รับเต็มยอดที่ค้าง
  const [depositDraft, setDepositDraft] = useState(''); // ยอดมัดจำที่กรอกในตัวเลือกแบ่งจ่าย
  const [depositEdit, setDepositEdit] = useState('');   // ยอดมัดจำในช่องแก้ไขของใบมัดจำที่แบ่งงวดไปแล้ว
  const [plan, setPlan] = useState([]);                 // ใบคู่ในแผนเดียวกัน (มัดจำ ↔ ส่วนที่เหลือ)
  /* ลบใบแล้วเคสไม่เหลือใบร่าง — ถามต่อว่าจะออกใบใหม่ไหม (เก็บรหัสที่เพิ่งลบไว้บอกในกล่อง)
     เป็นกล่องในหน้าแทน confirm() ของเบราว์เซอร์ ซึ่งถูกบล็อกได้แล้วคืน false เงียบๆ */
  const [reissue, setReissue] = useState(null);         // { caseId, deleted: [...] }
  const [payDate, setPayDate] = useState(todayTH);
  const [payMethod, setPayMethod] = useState(PAYMENT_METHODS[0]);
  /* รหัสกันบันทึกซ้ำของคำขอรับชำระ (server บังคับ — ดู paySchema)
     ออกรหัสตอนเปิดฟอร์ม แล้วใช้รหัสเดิมทุกครั้งที่กดยืนยันจนกว่าจะสำเร็จ
     กรณีที่มันมีไว้กัน: คำขอถึง server แล้วบันทึกเงินสำเร็จ แต่คำตอบหายกลางทาง
     (พนักงานอยู่จุดอับสัญญาณ) คนกดจะเห็นว่า error แล้วกดซ้ำ — รหัสเดิมทำให้
     server รู้ว่าเป็นคำขอเดิม จึงคืนรายการรับเงินใบเดิมแทนที่จะรับเงินซ้ำสองรอบ
     ออกรหัสใหม่ทุกครั้งที่เปิดฟอร์ม = การรับเงินรอบใหม่คือคำขอใหม่จริงๆ */
  const [payRequestId, setPayRequestId] = useState(null);
  const [paySlipId, setPaySlipId] = useState(null); // มีค่าเมื่อเปิดฟอร์มจากปุ่มยืนยันสลิปรอตรวจ
  // รายการรับชำระที่กำลังจะยกเลิก + เหตุผล (ยกเลิกทีละรายการ จึงเก็บรหัสเดียวพอ)
  const [voidFor, setVoidFor] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  /* ส่งใบเข้า LINE ลูกค้า (ดร.ธงชัย 24 ต.ค. 2569 ข้อ 4) — { can_send, reason, customer_name, history } · ดู server/src/invoices/share.js */
  const [lineInfo, setLineInfo] = useState(null);
  const [lineInfoError, setLineInfoError] = useState(null);
  const [copyText, setCopyText] = useState(null);
  // ลิงก์บิลสาธารณะที่ยังเปิดได้ของใบนี้ (Codex ข้อ 10 · 8 พ.ย. 2569)
  const [shareLinks, setShareLinks] = useState(null);
  const lineStatus = item?.status;
  useEffect(() => {
    setLineInfo(null);
    setLineInfoError(null);
    setCopyText(null);
    setShareLinks(null);
    if (lineStatus !== 'issued' && lineStatus !== 'paid') return;
    let cancelled = false;
    api.invoiceLine(invoiceId)
      .then((v) => !cancelled && setLineInfo(v))
      .catch(() => !cancelled && setLineInfoError('ตรวจสถานะ LINE ไม่ได้'));
    /* ล้มแล้วแค่ไม่โชว์ปุ่มปิดลิงก์ ไม่ต้องขึ้น error — เป็นข้อมูลประกอบ ไม่ใช่สิ่งที่คนเปิดใบมาเพื่อดู */
    api.invoiceShareLinks(invoiceId)
      .then((v) => !cancelled && setShareLinks(v.links ?? []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [invoiceId, lineStatus]);

  async function retryLineInfo() {
    setLineInfoError(null);
    try {
      setLineInfo(await api.invoiceLine(invoiceId));
    } catch {
      setLineInfoError('ตรวจสถานะ LINE ไม่ได้');
    }
  }

  async function sendLine() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.sendInvoiceLine(invoiceId);
      setLineInfo((v) => ({ ...v, history: r.history }));
      toast(r.already ? 'ใบนี้อยู่ในคิวส่งแล้ว รอระบบส่งสักครู่' : `ใส่คิวส่งเข้า LINE ${lineInfo?.customer_name ?? 'ลูกค้า'} แล้ว — ถึงลูกค้าภายในประมาณ 3 นาที`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyBill() {
    setBusy(true);
    setError(null);
    try {
      const bill = await api.invoiceShareLink(invoiceId);
      const amountLine = bill.kind === 'receipt'
        ? 'ชำระแล้ว'
        : bill.paid > 0
          ? `ยอดคงเหลือ ${amountText(bill.balance)} บาท`
          : `ยอดที่ต้องชำระ ${amountText(bill.balance)} บาท`;
      const text = [
        `${bill.kind === 'receipt' ? 'ใบเสร็จ' : 'ใบแจ้งหนี้'}จาก KIN HomeCare`,
        `เลขที่ ${bill.invoice_id}`,
        `ชื่อผู้รับบริการ ${bill.patient_name ?? '—'}`,
        amountLine,
        // ใบเสร็จของการรับเงินครั้งล่าสุด — ลูกค้าเปิดลิงก์เดียวกันดูใบเสร็จทุกใบได้
        bill.latest_receipt_id ? `ใบเสร็จล่าสุด เลขที่ ${bill.latest_receipt_id}` : null,
        bill.due_date ? `วันครบกำหนด ${docDate(bill.due_date)}` : null,
        bill.kind !== 'receipt' && Number(bill.balance) > 0
          ? `ช่องทางชำระเงิน\n${TRANSFER_PAYMENT_INSTRUCTION}`
          : null,
        bill.url,
        'ลิงก์ใช้ได้ 6 เดือน',
      ].filter(Boolean).join('\n');
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(text);
        setCopyText(null);
        toast('คัดลอกข้อความบิลแล้ว — นำไปวางส่งให้ผู้จ่ายเงินได้เลย');
      } catch {
        setCopyText(text);
        toast('คัดลอกอัตโนมัติไม่ได้ — เลือกข้อความในกล่องแล้วคัดลอกเอง');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const lastSend = lineInfo?.history?.[0];

  const load = () =>
    Promise.all([api.getInvoice(invoiceId), api.invoicePlan(invoiceId)]).then(([v, sib]) => {
      setItem(v);
      setPlan(sib);
    });

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);
    setPayOpen(false);
    setAdjOpen(false);
    setCancelOpen(false);
    setCancelReason('');
    setPaySlipId(null);
    Promise.all([api.getInvoice(invoiceId), api.invoicePlan(invoiceId)])
      .then(([v, sib]) => {
        if (cancelled) return;
        setItem(v);
        setPlan(sib);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [invoiceId]);

  /* เติมยอดมัดจำปัจจุบันลงช่องแก้ไขทุกครั้งที่ใบถูกโหลด (รวมหลังบันทึกด้วย — run() โหลดซ้ำให้เสมอ)
     ช่องเปล่าจะอ่านไม่ออกว่าตอนนี้ตกลงกันไว้เท่าไหร่ แล้วคนกรอกต้องเลื่อนไปดูยอดข้างบนเอง */
  useEffect(() => {
    setDepositEdit(item?.billing_kind === 'deposit' ? String(item.total) : '');
  }, [item?.invoice_id, item?.billing_kind, item?.total]);

  /*
   * ล็อกไม่ให้หน้าหลังเลื่อนตาม + คืนโฟกัสกลับไปที่แถวเดิมตอนปิด (ไม่ใช่ดีดกลับไปต้นหน้า)
   * แยกเป็น effect ที่ทำงานครั้งเดียวตลอดอายุกล่อง — ถ้าไปรวมกับ effect ที่มี deps
   * โฟกัสจะถูกคืนออกไปข้างนอกทุกครั้งที่ deps เปลี่ยน
   */
  useScrollLock();
  useEffect(() => {
    const previous = document.activeElement;
    boxRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  /* ปิดด้วย Esc + ขังโฟกัสไว้ในกล่อง — ถ้าไม่ขัง Tab จะวิ่งไปโดนลิงก์ที่อยู่หลังฉาก */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // ฟอร์มรับชำระเปิดอยู่ Esc ควรพับฟอร์มก่อน ไม่ใช่ปิดทั้งกล่องจนวันที่/วิธีจ่ายที่เลือกไว้หาย
        if (payOpen) setPayOpen(false);
        else if (adjOpen) setAdjOpen(false);
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
  }, [onClose, payOpen, adjOpen]);

  // ตำแหน่งของใบนี้ในรายการหน้าปัจจุบัน — ใช้ทำปุ่มดูใบก่อนหน้า/ถัดไป
  const index = siblings.indexOf(invoiceId);
  const prevId = index > 0 ? siblings[index - 1] : null;
  const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result !== GONE) await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function openPaymentForm(slip = null) {
    setPayAmount(String(slip?.extracted_amount ?? item.balance));
    setPayDate(/^\d{4}-\d{2}-\d{2}$/.test(slip?.extracted_date || '') ? slip.extracted_date : todayTH());
    setPayMethod(slip ? 'โอน' : PAYMENT_METHODS[0]);
    setPaySlipId(slip?.slip_id ?? null);
    setPayRequestId(crypto.randomUUID());
    setPayOpen(true);
  }

  // ชำระแล้วถือเป็น "ใบเสร็จรับเงิน" ตามธรรมเนียมเอกสารไทย · ยังไม่ชำระคือ "ใบแจ้งหนี้"
  // ใบเสร็จ = ปิดยอดด้วยเงินที่รับมาจริง · ปิดด้วยหนี้สูญ/ลดหนี้จนหมดยังเป็นใบแจ้งหนี้ (ดู isPaidReceipt)
  const isReceipt = isPaidReceipt(item);
  const showFinance = isReceipt && docView === 'finance';
  // ใบเสร็จรายครั้ง / ใบลดหนี้-เพิ่มหนี้ที่เลือกดูอยู่ (ไม่พบ = ใบถูกโหลดใหม่แล้วเอกสารนั้นหาย → กลับไปดูใบแจ้งหนี้)
  const viewReceipt = docView.startsWith('rc:') ? item?.receipts?.find((r) => r.receipt_id === docView.slice(3)) : null;
  const viewNote = docView.startsWith('note:') ? item?.adjustments?.find((n) => n.note_id === docView.slice(5)) : null;
  // 'pv:<refund_id>' = ใบสำคัญจ่ายของเงินคืน (ใช้ refund_id เพราะเงินคืนเก่าอาจยังไม่ได้เลข PV จนกว่าจะ migrate)
  const viewRefund = docView.startsWith('pv:') ? item?.refunds?.find((r) => String(r.refund_id) === docView.slice(3)) : null;
  const printTitle = item?.invoice_id
    ? (viewReceipt
        ? `ใบเสร็จรับเงิน_${viewReceipt.receipt_id}`
        : viewRefund
          ? `ใบสำคัญจ่าย_${viewRefund.refund_doc_id ?? item.invoice_id}`
          : viewNote
          ? `${viewNote.kind === 'credit' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'}_${viewNote.note_id}`
          : `${isReceipt ? (showFinance ? 'ใบเสร็จรับเงิน_ฝ่ายการเงิน' : 'ใบเสร็จรับเงิน') : 'ใบแจ้งหนี้'}_${item.invoice_id}`
      ).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    : null;

  // Save as PDF ใช้ชื่อเอกสารเป็นชื่อไฟล์เริ่มต้น และคืนชื่อหน้าเดิมเมื่อปิดเอกสาร
  useEffect(() => {
    if (!printTitle) return;
    const previousTitle = document.title;
    document.title = printTitle;
    return () => { document.title = previousTitle; };
  }, [printTitle]);
  /* แก้ยอด/ดึงยอดจากเคสได้เฉพาะใบร่าง — ใบที่ออกแล้วปรับยอดด้วยใบลดหนี้/เพิ่มหนี้เท่านั้น (4 พ.ย. 2569) */
  const canEdit = item?.status === 'draft';
  // ใบที่ออกแล้วยังถือเป็นเอกสาร = ปรับยอดด้วย CN/DN ได้ (ใบร่างแก้ในใบได้เลย · ใบยกเลิกไม่มียอดให้ปรับ)
  const canAdjust = item?.status === 'issued' || item?.status === 'paid';
  /* ดึงข้อมูลจากเคสมาทับได้จริงไหม — ต้องตรงกับเงื่อนไขใน syncOpenFromCase ฝั่ง server
     ใบงวด/ใบรายครั้ง/ใบที่รับเงินแล้วถูกข้าม ปุ่มรีเฟรชจะกดแล้วไม่เกิดอะไร (หรือ error) จึงไม่โชว์ */
  const refreshable =
    canEdit && !item?.has_items && !item?.is_plan_part && Number(item?.paid_amount ?? 0) === 0;
  // ใบที่ออกแล้ว server ดึงจากเคสได้แค่ผู้จ่าย (ชื่อ/เลขผู้เสียภาษี/ที่อยู่) — ยอดไม่แตะ
  const payerRefreshable = item?.status === 'issued' && item?.payer_stale;
  // ยกเลิกใบได้เมื่อไม่ถือเงินลูกค้าอยู่ — ที่รับไว้ต้องลดหนี้พร้อมคืนเงินก่อน (server ตรวจซ้ำ)
  // ยกเลิกใบ = เลิกเก็บเงินทั้งใบ เท่ากับลดหนี้เต็มยอด จึงต้องมีสิทธิ์เงินเหมือนใบลดหนี้ (server กันซ้ำ)
  const canCancel = canMoney && canAdjust && Number(item?.paid_amount ?? 0) <= 0;

  /* ตัวเลขตัวอย่างของฟอร์มใบลดหนี้/เพิ่มหนี้ — server คิดซ้ำเองทุกตัว (ที่นี่แค่ให้เห็นก่อนกด)
     ลดหนี้จนเงินที่รับไว้เกินยอดใหม่ = ต้องคืนส่วนเกินทันที ฟอร์มจึงขอวันที่/ช่องทางคืนเงินเพิ่ม */
  const adjValue = Math.round(Number(adjAmount) * 100) / 100;
  const netNow = Number(item?.net_total ?? item?.total ?? 0);
  const paidNow = Number(item?.paid_amount ?? 0);
  const adjAfter = Math.round((adjKind === 'credit' ? netNow - adjValue : netNow + adjValue) * 100) / 100;
  const adjRefund = adjKind === 'credit' ? Math.max(0, Math.round((paidNow - adjAfter) * 100) / 100) : 0;
  const isBadDebt = adjKind === 'credit' && adjReasonCode === 'bad_debt';
  // กติกาเดียวกับ assessAdjustment ฝั่ง server — ที่นี่แค่บอกให้รู้ก่อนกด
  const adjOverBalance = isBadDebt && adjValue > Math.max(0, Number(item?.balance ?? 0));
  const adjCancelInstead = adjKind === 'credit' && !isBadDebt && adjValue > 0 && adjAfter <= 0 && paidNow <= 0;
  const adjValid =
    adjValue > 0 && adjReason.trim().length >= 3 && adjAfter >= 0 && !adjOverBalance && !adjCancelInstead &&
    (adjRefund === 0 || !!refundDate);

  function openAdjustForm() {
    setAdjKind(canMoney ? 'credit' : 'debit');
    setAdjReasonCode(canMoney ? 'discount' : 'extra_service');
    setAdjAmount('');
    setAdjReason('');
    setRefundDate(todayTH());
    setRefundMethod(PAYMENT_METHODS[1]);
    setPayOpen(false);
    setAdjOpen(true);
  }

  /**
   * ยกเลิกใบ — ใบยังอยู่ในระบบ เปลี่ยนสถานะเป็น "ยกเลิก" เก็บไว้เป็นประวัติ
   * ใช้กับใบที่ออกให้ลูกค้าไปแล้ว (ออกใบแล้ว/ชำระแล้ว) ซึ่งไม่ควรลบให้หายไปเฉยๆ
   */
  function cancelInvoice() {
    return run(async () => {
      await api.cancelInvoice(item.invoice_id, cancelReason.trim());
      setCancelOpen(false);
      setCancelReason('');
      toast(`ยกเลิก ${item.invoice_id} แล้ว`);
    });
  }

  /**
   * ลบใบทิ้งถาวร แล้วถามต่อว่าจะออกใบใหม่ตามข้อมูลปัจจุบันเลยไหม
   * ไม่ออกให้อัตโนมัติ เพราะบางครั้งลบเพราะไม่เก็บเงินเคสนี้แล้ว ไม่ได้จะออกใบแทน
   *
   * ถามเฉพาะตอนเคสไม่เหลือใบร่างแล้วจริงๆ — ของเดิมถามทุกครั้ง คนกดก็ตอบ "ใช่" ทุกครั้ง
   * เคสที่มีใบร่างซ้ำอยู่สองใบจึงลบเท่าไหร่ก็ไม่มีวันเหลือใบเดียว (ลบใบหนึ่ง ได้ใบใหม่มาแทนทันที)
   */
  function deleteInvoice() {
    return run(async () => {
      // ลบใบมัดจำ/ใบส่วนที่เหลือ = ลบทั้งแผน server จึงคืนรายการที่ลบจริงมาให้บอกคนกดตามนั้น
      const { deleted = [item.invoice_id] } = (await api.deleteInvoice(item.invoice_id)) ?? {};
      toast(deleted.length > 1 ? `ลบทั้งแผน (${deleted.join(' และ ')}) แล้ว` : `ลบ ${deleted[0]} แล้ว`);
      if (!item.case_id) {
        onClose();
        return GONE;
      }

      /* เคสยังเหลือใบร่างอยู่ = ได้สิ่งที่ต้องการแล้ว (เหลือใบเดียว) พาไปเปิดใบนั้นแทนการออกใบใหม่
         ถึงจะพลาดกดออกใหม่ server ก็ปฏิเสธให้อีกชั้น (ดู POST /api/invoices) */
      const { data: drafts } = await api.listInvoices({ case_id: item.case_id, status: 'draft', per_page: 1 });
      if (drafts.length > 0) {
        toast(`เคสนี้เหลือใบร่าง ${drafts[0].invoice_id} ใบเดียวแล้ว`);
        onReissued?.(drafts[0].invoice_id);
        return GONE;
      }

      setReissue({ caseId: item.case_id, deleted });
      return GONE;
    });
  }

  /** ตอบกล่องถามออกใบใหม่ — ไม่ออก = ปิด popup เพราะใบที่เปิดอยู่ถูกลบไปแล้ว ค้างหน้าไว้ไม่ได้ */
  async function answerReissue(yes) {
    if (!yes) {
      setReissue(null);
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createInvoice({ case_id: reissue.caseId });
      toast(`ออกใบใหม่ ${created.invoice_id} แล้ว`);
      setReissue(null);
      onReissued?.(created.invoice_id);
    } catch (e) {
      // ออกใบไม่สำเร็จ — ปิดกล่องให้เห็นข้อความแดงในใบ (ใบเดิมถูกลบแล้ว ปุ่มอื่นในใบจะใช้ไม่ได้)
      setReissue(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ชื่อผู้ลงนาม = คนที่กำลังสั่งพิมพ์ — session ส่ง first_name/last_name แยกกันมา ไม่มีฟิลด์ name รวม
  // สำรองด้วยชื่อที่บันทึกไว้ในใบ เผื่อ session โหลดไม่ทันตอนกดพิมพ์
  const printerName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    (isReceipt ? item?.paid_by_name : null) ||
    item?.issued_by_name ||
    '';
  /* ยอดเต็มที่ตกลงกับลูกค้า = ใบมัดจำ + ใบส่วนที่เหลือ ไม่ใช่ค่าจ้างของเคส
     (ใบที่แบ่งงวดแล้วไม่ซิงก์ตามเคส ยอดที่ตกลงกันจึงอยู่ในใบทั้งสองเท่านั้น — เกณฑ์เดียวกับฝั่ง server) */
  const planTotal = item?.is_plan_part && plan.length > 0 ? item.total + Number(plan[0].total) : 0;
  const depositValue = Number(depositEdit);
  const depositValid = depositValue > 0 && depositValue < planTotal;

  const pay = item ? paidBy(item.payments, item.payment_method, item.total, item.status, item.paid_amount) : {};

  /* อุปกรณ์เสริม — เก็บแยกในคอลัมน์ addons แต่บวกอยู่ใน amount แล้ว
     แตกเป็นบรรทัดของตัวเอง แล้วบรรทัดแพ็คเกจเหลือเฉพาะส่วนที่เป็นค่าบริการ (ยอดรวมยังเท่า amount)
     ใบแบ่งงวด: อุปกรณ์อยู่ที่ใบส่วนที่เหลือ ใบมัดจำไม่มี จึงเป็นบรรทัดเดียวเหมือนเดิม
     ยอดในใบน้อยกว่าค่าอุปกรณ์ (มัดจำกินเข้าไปถึงค่าอุปกรณ์ / แก้ยอดเอง) = แตกไม่ลง พิมพ์บรรทัดเดียว
     ใบรายครั้งมีบรรทัดอุปกรณ์อยู่ใน items อยู่แล้ว */
  const addonCandidates = item && !(item.items?.length > 0) ? (item.addons ?? []) : [];
  const addonSum = Math.round(addonCandidates.reduce((s, a) => s + addonAmount(a), 0) * 100) / 100;
  const addons = item && Number(item.amount) >= addonSum ? addonCandidates : [];
  const serviceAmount = item
    ? Math.round((Number(item.amount) - (addons.length > 0 ? addonSum : 0)) * 100) / 100
    : 0;

  /* บรรทัดของใบเสร็จฝ่ายการเงิน — ชุดเดียวกับใบของลูกค้าทุกบรรทัด แต่มีช่องส่วนลดแยก
     ส่วนลดของใบเป็นส่วนลดค่าบริการ จึงลงบรรทัดแรก (แพ็คเกจ) · ผลรวม (ยอด − ส่วนลด) เท่ายอดสุทธิของใบพอดี */
  const financeLines = !item
    ? []
    : (item.items?.length > 0
        ? item.items.map((l) => ({ description: l.description, amount: Number(l.amount), discount: 0 }))
        : [
            { description: item.service_description, amount: serviceAmount, discount: 0 },
            ...addons.map((a) => ({
              description: `${addonLabel(a)}${a.quantity !== 1 ? ` (${amountText(a.unit_price)} × ${a.quantity})` : ''}`,
              amount: addonAmount(a),
              discount: 0,
            })),
          ]
      ).map((l, i) => (i === 0 ? { ...l, discount: Number(item.discount ?? 0) } : l));

  /* ผู้ลงนามช่องเจ้าหน้าที่การเงิน = คนที่บันทึกรับเงินจริง (ใบเสร็จฝ่ายการเงินเป็นหลักฐานว่าใครรับเงิน)
     ใบเก่าที่ไม่ได้เก็บชื่อผู้รับเงิน → ใช้คนที่กำลังพิมพ์แทน */
  const financeBody = item && isReceipt && (
    <FinanceReceiptDoc item={item} lines={financeLines} pay={pay} cashier={item.paid_by_name || printerName} />
  );

  /* เนื้อในของเอกสาร — ใช้สองที่: ตัวที่เห็นในกล่องบนจอ กับสำเนาที่พิมพ์ (.print-sheet)
     สร้างครั้งเดียวแล้วใช้ซ้ำ สองที่จึงไม่มีวันพิมพ์ออกมาไม่ตรงกับที่เห็น */
  /* เนื้อในของเอกสาร — ใช้สองที่: ตัวที่เห็นในกล่องบนจอ กับสำเนาที่พิมพ์ (.print-sheet) · ตัวเอกสารอยู่ใน CustomerInvoiceDoc (ใช้ร่วมกับลิงก์ลูกค้า) */
  const docBody = item && <CustomerInvoiceDoc item={item} signer={printerName} />;
  // เอกสารที่ถูกเลือกดู — ใบเสร็จรายครั้ง / ใบลดหนี้-เพิ่มหนี้ / ใบเสร็จฝ่ายการเงิน / ใบแจ้งหนี้ ตามลำดับ
  const shownBody = !item
    ? null
    : viewReceipt
      ? <ReceiptDoc item={item} receipt={viewReceipt} signer={printerName} />
      : viewRefund
        ? (
          <RefundVoucherDoc
            item={item}
            refund={viewRefund}
            note={item.adjustments?.find((n) => n.note_id === viewRefund.note_id)}
            signer={printerName}
          />
        )
        : viewNote
          ? <AdjustmentNoteDoc item={item} note={viewNote} refund={refundOfNote(viewNote.note_id)} signer={printerName} />
          : showFinance ? financeBody : docBody;
  // สลิปแนบท้ายเฉพาะตอนพิมพ์ใบแจ้งหนี้/ใบเสร็จรวม — ใบเสร็จรายครั้ง ใบลดหนี้ ใบสำคัญจ่ายเป็นเอกสารเดี่ยว
  const attachSlips = !viewReceipt && !viewNote && !viewRefund;
  const receiptOf = (paymentId) => item?.receipts?.find((r) => r.payment_id === paymentId);
  // เงินคืนของใบลดหนี้ — ยังมีผลก่อน ถ้ายกเลิกไปแล้วพร้อมใบลดหนี้ก็ยังโชว์ไว้เป็นประวัติ
  function refundOfNote(noteId) {
    const rows = item?.refunds?.filter((r) => r.note_id === noteId) ?? [];
    return rows.find((r) => r.status !== 'voided') ?? rows.at(-1);
  }

  function openRefundEdit(refund) {
    setRefundEditFor(refundEditFor === refund.refund_id ? null : refund.refund_id);
    setRefundEdit({ refunded_at: refund.refunded_at, method: refund.method ?? '', note: refund.note ?? '' });
  }

  /*
   * สำเนาสำหรับพิมพ์ — portal ไปเป็นลูกตรงของ <body> แล้ว CSS ตอนพิมพ์ซ่อนทั้งแอป (display: none) เหลือแต่ตัวนี้
   *
   * ทำไมไม่พิมพ์ตัวในกล่องตรงๆ: ตัวในกล่องต้องถูกยกขึ้นหัวกระดาษด้วย position: absolute
   * (ของที่เหลือในหน้าถูกซ่อนด้วย visibility ซึ่งยังกินที่) แล้วเบราว์เซอร์ไม่ตัดหน้าให้ของที่ลอยอยู่แบบนั้น
   * ใบหนึ่งหน้าพอไหว แต่พอมีสลิปแนบต่อท้าย สลิปถูกอัดลงหน้าเดียวกับลายเซ็นแล้วโดนตัดขาดที่ขอบกระดาษ
   * ตัวนี้อยู่ใน flow ปกติของหน้า จึงขึ้นแผ่นใหม่ได้จริงทุกเบราว์เซอร์
   */
  const printSheet =
    item && !item.needs_plan &&
    createPortal(
      <div className="print-sheet" aria-hidden="true">
        <div className="invoice-doc">
          {/* ตัวใบต้องจบในแผ่นเดียว (usePrintFit ย่อถ้าเกิน) — สลิปแนบอยู่นอกกรอบนี้ ขึ้นแผ่นใหม่ของตัวเองตามเดิม */}
          <div className="inv-fit">{shownBody}</div>

          {/* สลิปโอนเงินแนบท้ายเอกสาร — มีเฉพาะในสำเนาที่พิมพ์ แต่ละใบขึ้นแผ่นใหม่ต่อจากตัวใบ
              บนจอไม่ต้องเห็นซ้ำ ส่วน "สลิปโอนเงิน" ด้านบนโชว์อยู่แล้ว (รูปเป็น URL เดียวกัน จึงโหลดค้างไว้แล้วตอนกดพิมพ์) */}
          {attachSlips && item.slips?.some((s) => s.status === 'confirmed') && (
            <div className="inv-slips">
              {/* หนึ่งสลิปต่อหนึ่งแผ่น — หัวข้ออยู่ในแต่ละแผ่น หยิบแผ่นไหนขึ้นมาก็รู้ว่าเป็นของใบไหน */}
              {item.slips.filter((s) => s.status === 'confirmed').map((slip, i, printed) => (
                <figure className="inv-slip" key={slip.slip_id}>
                  <p className="inv-slips-title">
                    เอกสารแนบ: หลักฐานการโอนเงิน (Payment slip) — {item.invoice_id}
                    {printed.length > 1 && ` · ${i + 1}/${printed.length}`}
                  </p>
                  <img src={api.invoiceSlipUrl(item.invoice_id, slip.slip_id)} alt={`สลิป ${i + 1}`} />
                  <figcaption>แนบเมื่อ {docDate(slip.created_at.slice(0, 10))}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </div>,
      document.body,
    );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        /* ยังไม่ได้เลือกวิธีเก็บเงิน = ตัวเอกสารถูกซ่อนอยู่ เหลือแค่กล่องตัวเลือกสองใบ
           ความกว้าง 60rem ที่ไว้วางใบแจ้งหนี้จึงกลายเป็นที่ว่างรอบๆ กล่องเล็กๆ กลางจอ */
        className={`modal modal-wide ${item?.needs_plan ? 'is-choosing' : ''}`}
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
                {/* รับมาบางส่วนแล้วเป็นสถานะที่คนดูต้องรู้ก่อนอย่างอื่น — สำคัญกว่า "ออกใบแล้ว"
                    แต่ยังไม่บังคับเหนือ "เกินกำหนด" ซึ่งเป็นเรื่องที่ต้องตามทวง */}
                <span
                  className={`badge invoice-${
                    item.is_overdue ? 'overdue' : item.is_partial ? 'partial' : item.status
                  }`}
                >
                  {item.is_overdue
                    ? 'เกินกำหนดชำระ'
                    : item.is_partial
                      ? 'ชำระบางส่วน'
                      : invoiceStatusLabel(item)}
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

            <div className="modal-body">
              {error && <p className="error no-print">{error}</p>}

              {item.slips?.some((s) => s.status === 'pending') && (
                <section className="pending-slips no-print" aria-label="สลิปรอตรวจ">
                  <h3>สลิปรอตรวจจากลูกค้า</h3>
                  {item.slips.filter((s) => s.status === 'pending').map((slip) => (
                    <article className="pending-slip-card" key={slip.slip_id}>
                      <a href={api.invoiceSlipUrl(item.invoice_id, slip.slip_id)} target="_blank" rel="noreferrer">
                        <img src={api.invoiceSlipUrl(item.invoice_id, slip.slip_id)} alt={`สลิปรอตรวจ #${slip.slip_id}`} />
                      </a>
                      <div>
                        <span className="badge pending-slip-badge">รอตรวจ · จากลูกค้า</span>
                        <p className="muted">
                          {slip.source === 'line_auto' ? 'ส่งทาง LINE HomeCare' : 'แนบจากหน้าบิล'}
                          {' · '}{docDate(slip.created_at.slice(0, 10))}
                        </p>
                        {slip.extracted_amount != null && <p>ยอดที่ AI อ่าน: <strong>{amountText(slip.extracted_amount)} บาท</strong></p>}
                        {slip.extracted_date && <p>วันที่โอนที่ AI อ่าน: {docDate(slip.extracted_date)}</p>}
                        {slip.extracted_ref && <p>เลขอ้างอิง: <span className="mono">{slip.extracted_ref}</span></p>}
                        {slip.extracted_bank && <p>ธนาคาร: {slip.extracted_bank}</p>}
                        <div className="pending-slip-actions">
                          <button className="btn primary" disabled={busy} onClick={() => openPaymentForm(slip)}>
                            ยืนยันรับเงินตามสลิปนี้
                          </button>
                          <ConfirmButton
                            className="btn danger"
                            disabled={busy}
                            title="ไม่ใช่สลิป/ปฏิเสธรายการนี้?"
                            detail="รายการจะถูกเก็บเป็นประวัติการปฏิเสธ และไม่บันทึกรับเงิน"
                            confirmLabel="ยืนยันปฏิเสธ"
                            onConfirm={() => run(() => api.rejectInvoiceSlip(item.invoice_id, slip.slip_id, 'ไม่ใช่สลิป/ปฏิเสธโดยทีม'))}
                          >
                            ไม่ใช่สลิป/ปฏิเสธ
                          </ConfirmButton>
                        </div>
                      </div>
                    </article>
                  ))}
                </section>
              )}

              {/* ใบร่างระบบอัปเดตตามเคสให้เอง จึงเตือนเฉพาะใบที่ออกไปแล้วและตัวเลขไม่ตรงกับเคส */}
              {/* ฟอร์มรับชำระ — เปิดจากปุ่มท้าย popup */}
              {payOpen && (
                <div className="notice pay-form no-print">
                  <label>
                    จำนวนเงินที่รับ (บาท)
                    <input
                      type="number"
                      min="0.01"
                      max={item.balance}
                      step="0.01"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                    />
                  </label>
                  <label>
                    วันที่ชำระ
                    <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                  </label>
                  <label>
                    ช่องทาง
                    <SearchSelect value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </SearchSelect>
                  </label>
                  <div className="pay-form-actions">
                    <button className="btn" disabled={busy} onClick={() => { setPayOpen(false); setPaySlipId(null); }}>ยกเลิก</button>
                    <button
                      className="btn primary"
                      disabled={
                        // ไม่มีรหัสกันบันทึกซ้ำ = ยิงไปก็โดน 400 อยู่ดี กันที่ปุ่มดีกว่าให้ไปเจอ error
                        busy || !payRequestId || !payDate ||
                        Number(payAmount) <= 0 || Number(payAmount) > item.balance
                      }
                      onClick={() =>
                        run(async () => {
                          const received = payAmount === '' ? item.balance : Number(payAmount);
                          await api.payInvoice(item.invoice_id, {
                            request_id: payRequestId,
                            amount: received,
                            paid_at: payDate,
                            payment_method: payMethod,
                            slip_id: paySlipId,
                          });
                          toast(`รับชำระ ${amountText(received)} บาท แล้ว`);
                          setPayOpen(false);
                          // สำเร็จแล้ว = คำขอนี้จบ · รอบหน้าต้องเป็นรหัสใหม่ ไม่ใช่ replay ของรอบนี้
                          setPayRequestId(null);
                          setPaySlipId(null);
                        })
                      }
                    >
                      ยืนยันรับชำระ {amountText(payAmount === '' ? item.balance : Number(payAmount))} บาท
                    </button>
                  </div>
                </div>
              )}

              {cancelOpen && canCancel && (
                <div className="notice pay-form no-print">
                  <p>
                    ยกเลิก{isReceipt ? 'ใบเสร็จ' : 'ใบแจ้งหนี้'} {item.invoice_id} — ใบจะยังอยู่ในระบบเป็นประวัติ ไม่ถูกลบทิ้ง
                    และเลขที่เอกสารไม่หาย ระบบจะบันทึกชื่อคุณกับเหตุผลไว้กับใบ
                  </p>
                  <label>
                    เหตุผลที่ยกเลิก
                    <input
                      type="text"
                      value={cancelReason}
                      maxLength={300}
                      placeholder="เช่น ลูกค้ายกเลิกบริการ · ออกใบผิด"
                      onChange={(e) => setCancelReason(e.target.value)}
                    />
                  </label>
                  <div className="pay-form-actions">
                    <button type="button" className="btn" disabled={busy} onClick={() => setCancelOpen(false)}>
                      ไม่ยกเลิกแล้ว
                    </button>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy || cancelReason.trim().length < 3}
                      onClick={cancelInvoice}
                    >
                      ยืนยันยกเลิกใบ
                    </button>
                  </div>
                </div>
              )}

              {/* ฟอร์มใบลดหนี้/เพิ่มหนี้ — ทางเดียวที่ปรับยอดของใบที่ออกแล้ว (server invoices/ledger.js) */}
              {adjOpen && canAdjust && (
                <div className="notice pay-form adj-form no-print">
                  <label>
                    ชนิดเอกสาร
                    <SearchSelect
                      value={adjKind}
                      onChange={(e) => {
                        setAdjKind(e.target.value);
                        setAdjReasonCode(e.target.value === 'credit' ? 'discount' : 'extra_service');
                      }}
                    >
                      {canMoney && <option value="credit">ใบลดหนี้ (ลดยอด)</option>}
                      <option value="debit">ใบเพิ่มหนี้ (เพิ่มยอด)</option>
                    </SearchSelect>
                  </label>
                  <label>
                    ประเภท
                    <SearchSelect value={adjReasonCode} onChange={(e) => setAdjReasonCode(e.target.value)}>
                      {ADJUSTMENT_REASON_OPTIONS[adjKind].map(([code, label]) => (
                        <option key={code} value={code}>{label}</option>
                      ))}
                    </SearchSelect>
                  </label>
                  <label>
                    จำนวนเงิน (บาท)
                    <input
                      type="number"
                      min="0.01"
                      max={adjKind === 'credit' ? netNow : undefined}
                      step="0.01"
                      value={adjAmount}
                      onChange={(e) => setAdjAmount(e.target.value)}
                    />
                  </label>
                  <label className="adj-reason">
                    เหตุผล (พิมพ์ลงบนเอกสาร)
                    <input
                      type="text"
                      maxLength={300}
                      value={adjReason}
                      placeholder={adjKind === 'credit' ? 'เช่น ยกเลิกกะ 2 วัน (2 × 1,500)' : 'เช่น เพิ่มหัตถการ PR0008 ทำแผลขนาดเล็ก'}
                      onChange={(e) => setAdjReason(e.target.value)}
                    />
                  </label>
                  {adjRefund > 0 && (
                    <>
                      <p className="adj-refund-note">
                        ลดแล้วเงินที่รับไว้เกินยอดใหม่ — ต้องคืนเงินลูกค้า <strong>{amountText(adjRefund)} บาท</strong> พร้อมกัน
                      </p>
                      <label>
                        วันที่คืนเงิน
                        <input type="date" value={refundDate} max={todayTH()} onChange={(e) => setRefundDate(e.target.value)} />
                      </label>
                      <label>
                        ช่องทางคืนเงิน
                        <SearchSelect value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </SearchSelect>
                      </label>
                    </>
                  )}
                  <p className="muted adj-preview">
                    ยอดสุทธิตอนนี้ {amountText(netNow)} → หลังออกเอกสาร{' '}
                    <strong>{adjValue > 0 && adjAfter >= 0 ? amountText(adjAfter) : '—'}</strong> บาท
                    {adjKind === 'credit' && adjAfter < 0 && ' · ลดได้ไม่เกินยอดสุทธิ'}
                  </p>
                  {adjOverBalance && (
                    <p className="adj-refund-note">
                      ตัดหนี้สูญได้ไม่เกินยอดค้าง {amountText(Math.max(0, Number(item.balance)))} บาท — เงินที่รับมาแล้วตัดเป็นหนี้สูญไม่ได้
                    </p>
                  )}
                  {adjCancelInstead && (
                    <p className="adj-refund-note">
                      ใบนี้ยังไม่ได้รับเงิน ลดจนยอดเหลือ 0 เท่ากับไม่มีการขาย — ให้กด “ยกเลิกใบ” แทน
                      (ถ้าให้บริการแล้วแต่ลูกค้าไม่จ่าย ให้เลือกประเภท “ตัดหนี้สูญ”)
                    </p>
                  )}
                  <div className="pay-form-actions">
                    <button className="btn" disabled={busy} onClick={() => setAdjOpen(false)}>ยกเลิก</button>
                    <button
                      className="btn primary"
                      disabled={busy || !adjValid}
                      onClick={() =>
                        run(async () => {
                          const res = await api.createInvoiceAdjustment(item.invoice_id, {
                            kind: adjKind,
                            reason_code: adjReasonCode,
                            amount: adjValue,
                            reason: adjReason.trim(),
                            refund: adjRefund > 0 ? { refunded_at: refundDate, method: refundMethod } : null,
                          });
                          toast(
                            `ออก${adjKind === 'credit' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'} ${res.created_note_id} แล้ว` +
                              (adjRefund > 0 ? ` · บันทึกคืนเงิน ${amountText(adjRefund)} บาท` : ''),
                          );
                          setAdjOpen(false);
                          setDocView(`note:${res.created_note_id}`);
                        })
                      }
                    >
                      ออก{adjKind === 'credit' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'} {adjValue > 0 ? `${amountText(adjValue)} บาท` : ''}
                    </button>
                  </div>
                </div>
              )}

              {item.status === 'cancelled' && item.cancel_reason && (
                <div className="notice no-print">
                  <p>
                    ยกเลิกโดย {item.cancelled_by_name ?? '—'} · {item.cancelled_at ?? ''} — เหตุผล: {item.cancel_reason}
                  </p>
                </div>
              )}

              {/* เคสต้นทางถูกยกเลิกแล้วแต่ใบยังเปิดค้างอยู่ — ไม่ใช่ "ข้อมูลไม่ตรง" ที่กดรีเฟรชแล้วจบ
                  แต่เป็นคำถามว่ายังจะเก็บเงินใบนี้อยู่ไหม จึงแยกกล่องออกมา (ตรวจรอบ 13) */}
              {item.case_cancelled && (
                <div className="notice stale-notice no-print">
                  <p>
                    <LineIcon name="alert" className="text-ico" />
                    <strong>เคสของใบนี้ถูกยกเลิกแล้ว</strong> แต่ใบยังเปิดค้างอยู่และยังนับอยู่ในยอดค้างรวม —
                    ตรวจก่อนว่ายังต้องเก็บเงินใบนี้อยู่ไหม ถ้าไม่เก็บแล้วให้กด “ยกเลิกใบนี้”
                    ถ้าเก็บตามกะที่ไปจริง ให้{canEdit ? 'แก้ยอดก่อนส่งให้ลูกค้า' : 'ออกใบลดหนี้ส่วนที่ไม่ได้ให้บริการ'}
                  </p>
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
                      <LineIcon name="alert" className="text-ico" />ยอดตามเคสตอนนี้ (ค่าบริการ + อุปกรณ์เสริมในใบนี้) คือ <strong>{amountText(item.case_fee)}</strong>
                      {' '}แต่ยอดสุทธิของใบนี้เป็น <strong>{amountText(item.net_total ?? item.total)}</strong> — ยังไม่ตรงกัน
                    </p>
                  )}
                  {item.service_stale && (
                    <p>
                      <LineIcon name="alert" className="text-ico" />เคสนี้เปลี่ยนแพ็คเกจ/บริการหลังออกใบนี้ —
                      {' '}รายการและยอดในใบยังเป็นของชุดเดิม
                    </p>
                  )}
                  <p>
                    {refreshable
                      ? 'กดรีเฟรชเพื่อดึงข้อมูลล่าสุดจากเคสมาใส่ใบนี้'
                      : canEdit
                        ? 'ใบนี้แบ่งงวด แตกรายครั้ง หรือรับเงินมาแล้ว ระบบจึงปรับให้ตามเคสเองไม่ได้ — ตรวจยอดแล้วแก้ที่ใบ หรือลบแล้วออกใหม่'
                        : `ใบที่ออกแล้วแก้ยอดในใบไม่ได้ — ${item.fee_stale ? 'ลดยอดให้ออกใบลดหนี้ เพิ่มยอดให้ออกใบเพิ่มหนี้' : 'ปรับยอดด้วยใบลดหนี้/ใบเพิ่มหนี้'}`
                          + (payerRefreshable ? ' · ผู้จ่ายดึงจากเคสได้ด้วยปุ่มด้านล่าง' : '')}
                    {item.service_stale && ' · ถ้ายอดเดิมยังถูกต้อง (เช่น ส่วนต่างออกใบแยก) กด "รับทราบ" เพื่อปิดคำเตือนเรื่องแพ็คเกจ'}
                  </p>
                  <div className="stale-actions">
                    {item.service_stale && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => run(() => api.acknowledgeInvoiceService(item.invoice_id))}
                      >
                        รับทราบ ใบนี้ถูกต้องแล้ว
                      </button>
                    )}
                    {refreshable && (
                      <button
                        className="btn primary"
                        disabled={busy}
                        onClick={() => run(() => api.refreshInvoice(item.invoice_id))}
                      >
                        รีเฟรชจากเคส
                      </button>
                    )}
                    {payerRefreshable && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => run(() => api.refreshInvoice(item.invoice_id))}
                      >
                        ดึงผู้จ่ายจากเคส
                      </button>
                    )}
                    {canAdjust && (item.fee_stale || item.service_stale) && (
                      <button className="btn primary" disabled={busy} onClick={openAdjustForm}>
                        ออกใบลดหนี้/เพิ่มหนี้
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* สรุปเงินของใบนี้ — ยอดสุทธิ / มัดจำที่ตกลง / รับมาแล้ว / คงเหลือ
                  แยกจากตัวเอกสารที่พิมพ์ เพราะเป็นเครื่องมือของคนเก็บเงิน ไม่ใช่ข้อความบนใบ */}
              {item.status !== 'cancelled' && !item.needs_plan && (
                <section className="pay-summary no-print">
                  <div className="pay-figures">
                    <div>
                      <span className="field-label">ยอดสุทธิ</span>
                      <strong>{amountText(item.net_total ?? item.total)}</strong>
                      {/* ยอดหน้าใบไม่เปลี่ยนหลังออกใบ — ส่วนต่างมาจากใบลดหนี้/เพิ่มหนี้ด้านล่าง */}
                      {Number(item.adjustment_total ?? 0) !== 0 && (
                        <span className="muted pay-figure-note">
                          หน้าใบ {amountText(item.total)} · ปรับ {item.adjustment_total > 0 ? '+' : '−'}{amountText(Math.abs(item.adjustment_total))}
                        </span>
                      )}
                    </div>
                    <div>
                      <span className="field-label">รับมาแล้ว</span>
                      <strong>{amountText(item.paid_amount)}</strong>
                      {Number(item.refunded_amount ?? 0) > 0 && (
                        <span className="muted pay-figure-note">คืนลูกค้าแล้ว {amountText(item.refunded_amount)}</span>
                      )}
                    </div>
                    <div className={item.balance > 0 ? 'is-due' : ''}>
                      <span className="field-label">คงเหลือ</span>
                      <strong>{amountText(item.balance)}</strong>
                    </div>
                  </div>

                  {/* ใบที่เป็นงวดหนึ่งของแผน — บอกว่าคู่กับใบไหน กดข้ามไปดูได้เลย
                      ไม่งั้นคนเปิดดูใบมัดจำจะไม่รู้ว่ายังมีอีกใบที่ต้องตามเก็บ */}
                  {item.is_plan_part && (
                    <p className="muted plan-note">
                      {item.billing_kind === 'deposit' ? 'ใบมัดจำ' : 'ใบส่วนที่เหลือ'}
                      {plan.length > 0 && (
                        <>
                          {' · คู่กับ '}
                          {plan.map((sib) => (
                            <button
                              key={sib.invoice_id}
                              type="button"
                              className="btn link-btn mono"
                              onClick={() => onNavigate?.(sib.invoice_id)}
                            >
                              {sib.invoice_id}
                            </button>
                          ))}
                          {' '}({amountText(plan[0].total)} บาท)
                        </>
                      )}
                    </p>
                  )}

                  {/* แก้ยอดมัดจำได้ทันทีโดยไม่ต้องลบใบ — ยอดเต็มของแผนคงเดิม ใบส่วนที่เหลือขยับตามให้เอง
                      ของเดิมเลือกวิธีเก็บเงินได้ครั้งเดียว ตกลงมัดจำใหม่ทีไรต้องลบทั้งแผนทิ้งแล้วแบ่งใหม่
                      ซึ่งทำให้เลขที่เอกสารข้ามและใบที่ส่งให้ลูกค้าไปแล้วหายไปทั้งคู่ เพราะตัวเลขเดียวเปลี่ยน */}
                  {item.billing_kind === 'deposit' && canEdit && plan.length > 0 && (
                    <div className="deposit-edit">
                      <label>
                        ยอดมัดจำ (บาท)
                        <input
                          type="number"
                          min="0.01"
                          max={planTotal}
                          step="0.01"
                          value={depositEdit}
                          onChange={(e) => setDepositEdit(e.target.value)}
                        />
                      </label>
                      <div className="deposit-edit-side">
                        {/* บอกยอดใบคู่ตั้งแต่ยังไม่กดบันทึก — ตัวเลขที่ต้องตามเก็บทีหลังคือสิ่งที่ต้องเห็นก่อนตัดสินใจ */}
                        <p className="muted">
                          {depositValid ? (
                            <>
                              ใบส่วนที่เหลือ <span className="mono">{plan[0].invoice_id}</span> จะกลายเป็น{' '}
                              <strong>{amountText(planTotal - depositValue)}</strong> บาท
                            </>
                          ) : (
                            `ยอดเต็มที่ตกลงไว้คือ ${amountText(planTotal)} บาท — ยอดมัดจำต้องมากกว่า 0 และน้อยกว่ายอดนี้`
                          )}
                        </p>
                        <button
                          className="btn"
                          disabled={busy || !depositValid || depositValue === item.total}
                          onClick={() =>
                            run(async () => {
                              await api.updateDepositAmount(item.invoice_id, { deposit_amount: depositValue });
                              toast(`แก้ยอดมัดจำเป็น ${amountText(depositValue)} บาทแล้ว`);
                            })
                          }
                        >
                          บันทึกยอดมัดจำ
                        </button>
                      </div>
                    </div>
                  )}

                  {/* เปิดมาจากใบส่วนที่เหลือ — ยอดใบนี้ไม่ใช่ตัวเลขอิสระ บอกให้รู้ว่าไปแก้ที่ไหน
                      ไม่งั้นจะเห็นแค่ว่าใบนี้แก้ยอดไม่ได้ แล้วเข้าใจว่าต้องลบทั้งแผนทิ้งเหมือนเดิม */}
                  {item.billing_kind === 'balance' && canEdit && plan.length > 0 && (
                    <p className="muted plan-note">
                      ยอดของใบนี้คือยอดเต็มหักมัดจำ — แก้ได้ที่ช่อง “ยอดมัดจำ” ในใบมัดจำ{' '}
                      <span className="mono">{plan[0].invoice_id}</span> แล้วใบนี้จะเปลี่ยนตามเอง
                    </p>
                  )}

                  {item.payments?.length > 0 && (
                    <ul className="pay-history">
                      {item.payments.map((pmt) => (
                        <li key={pmt.payment_id}>
                          <span className="pay-history-date">{docDate(pmt.paid_at)}</span>
                          <span className="pay-history-amount">{amountText(pmt.amount)}</span>
                          <span className="muted">
                            {pmt.is_deposit && <span className="badge deposit-tag">มัดจำ</span>}
                            {pmt.method ?? '—'}
                            {pmt.received_by_name && ` · รับโดย ${pmt.received_by_name}`}
                          </span>
                          {/* ใบเสร็จของการรับเงินครั้งนี้ — กดแล้วเอกสารด้านล่างเปลี่ยนเป็นใบเสร็จใบนั้น (พิมพ์ได้ทันที) */}
                          {receiptOf(pmt.payment_id) && (
                            <button
                              type="button"
                              className="inline-link mono"
                              onClick={() => setDocView(`rc:${receiptOf(pmt.payment_id).receipt_id}`)}
                            >
                              {receiptOf(pmt.payment_id).receipt_id}
                            </button>
                          )}
                          {/* กรอกยอดผิด/บันทึกซ้ำ — เดิมแก้ไม่ได้เลย ต้องยกเลิกใบทั้งใบแล้วออกใหม่
                              เซิร์ฟเวอร์เป็นคนตัดสินว่าใครยกเลิกได้ (ดู assessPaymentVoid) ที่นี่แค่เปิดช่องให้กรอกเหตุผล */}
                          <button
                            type="button"
                            className="inline-link danger-link"
                            disabled={busy}
                            onClick={() => { setVoidFor(voidFor === pmt.payment_id ? null : pmt.payment_id); setVoidReason(''); }}
                          >
                            {voidFor === pmt.payment_id ? 'ไม่ยกเลิกแล้ว' : 'ยกเลิกรายการนี้'}
                          </button>
                          {voidFor === pmt.payment_id && (
                            <div className="pay-void-form">
                              <input
                                type="text"
                                value={voidReason}
                                maxLength={300}
                                placeholder="เหตุผล เช่น กรอกยอดผิด · บันทึกซ้ำ"
                                onChange={(e) => setVoidReason(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn danger"
                                disabled={busy || voidReason.trim().length < 3}
                                onClick={() =>
                                  run(async () => {
                                    await api.voidInvoicePayment(item.invoice_id, pmt.payment_id, voidReason.trim());
                                    setVoidFor(null);
                                    setVoidReason('');
                                    toast(`ยกเลิกรายการรับชำระ ${amountText(pmt.amount)} บาทแล้ว`);
                                  })
                                }
                              >
                                ยืนยันยกเลิกรายการ
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* รายการที่ถูกยกเลิกไปแล้ว — เงินที่เคยบันทึกแล้วหายต้องมีร่องรอย ไม่ใช่หายเฉย ๆ */}
                  {item.payment_voids?.length > 0 && (
                    <ul className="pay-history pay-history-void">
                      {item.payment_voids.map((v) => (
                        <li key={v.void_id}>
                          <span className="pay-history-date">{docDate(v.paid_at)}</span>
                          <span className="pay-history-amount">{amountText(v.amount)}</span>
                          <span className="muted">
                            <span className="badge">ยกเลิกแล้ว</span>
                            {v.reason}
                            {v.voided_by_name && ` · โดย ${v.voided_by_name}`}
                            {v.voided_at && ` · ${v.voided_at.slice(0, 16)}`}
                          </span>
                          {receiptOf(v.payment_id) && (
                            <button
                              type="button"
                              className="inline-link mono"
                              onClick={() => setDocView(`rc:${receiptOf(v.payment_id).receipt_id}`)}
                            >
                              {receiptOf(v.payment_id).receipt_id}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* ใบลดหนี้/เพิ่มหนี้ของใบนี้ — ที่มาของส่วนต่างระหว่างยอดหน้าใบกับยอดสุทธิ */}
                  {item.adjustments?.length > 0 && (
                    <ul className="pay-history adj-history">
                      {item.adjustments.map((n) => {
                        const refund = refundOfNote(n.note_id);
                        const refundActive = refund && refund.status !== 'voided';
                        return (
                          <li key={n.note_id} className={n.status === 'cancelled' ? 'is-void' : ''}>
                            <span className="pay-history-date">{docDate(n.issue_date)}</span>
                            <span className="pay-history-amount">
                              {n.kind === 'credit' ? '−' : '+'}{amountText(n.amount)}
                            </span>
                            <span className="muted">
                              <span className={`badge ${n.kind === 'credit' ? 'adj-credit' : 'adj-debit'}`}>
                                {n.kind === 'credit' ? 'ลดหนี้' : 'เพิ่มหนี้'}
                              </span>
                              {n.status === 'cancelled' && <span className="badge">ยกเลิกแล้ว</span>}
                              {ADJUSTMENT_REASON_LABELS[n.reason_code] && n.reason_code !== 'other' && (
                                <span className="badge adj-reason-tag">{ADJUSTMENT_REASON_LABELS[n.reason_code]}</span>
                              )}
                              {n.reason}
                              {refund && ` · คืนเงิน ${amountText(refund.amount)} ${docDate(refund.refunded_at)} (${refund.method ?? '—'})`}
                              {refund?.status === 'voided' && ' · เงินคืนยกเลิกแล้ว'}
                              {n.issued_by_name && ` · โดย ${n.issued_by_name}`}
                            </span>
                            <button type="button" className="inline-link mono" onClick={() => setDocView(`note:${n.note_id}`)}>
                              {n.note_id}
                            </button>
                            {/* ใบสำคัญจ่ายของเงินคืน — เปิดดู/พิมพ์เป็นเอกสารแยก */}
                            {refund && (
                              <button
                                type="button"
                                className="inline-link mono"
                                onClick={() => setDocView(`pv:${refund.refund_id}`)}
                              >
                                {refund.refund_doc_id ?? 'ใบสำคัญจ่าย'}
                              </button>
                            )}
                            {/* แก้ข้อมูลเงินคืนที่กรอกผิด — ยอดเงินแก้ไม่ได้ (ยอดผิด = ใบลดหนี้ผิด ต้องยกเลิกแล้วออกใหม่) */}
                            {canMoney && refundActive && (
                              <button
                                type="button"
                                className="inline-link"
                                disabled={busy}
                                onClick={() => openRefundEdit(refund)}
                              >
                                {refundEditFor === refund.refund_id ? 'ไม่แก้แล้ว' : 'แก้ข้อมูลเงินคืน'}
                              </button>
                            )}
                            {refundActive && refundEditFor === refund.refund_id && (
                              <div className="pay-void-form refund-edit-form">
                                <input
                                  type="date"
                                  aria-label="วันที่คืนเงิน"
                                  value={refundEdit.refunded_at}
                                  max={todayTH()}
                                  onChange={(e) => setRefundEdit((v) => ({ ...v, refunded_at: e.target.value }))}
                                />
                                <SearchSelect
                                  aria-label="ช่องทางคืนเงิน"
                                  value={refundEdit.method}
                                  onChange={(e) => setRefundEdit((v) => ({ ...v, method: e.target.value }))}
                                >
                                  {[...new Set([...PAYMENT_METHODS, refundEdit.method].filter(Boolean))].map((m) => (
                                    <option key={m} value={m}>{m}</option>
                                  ))}
                                </SearchSelect>
                                <input
                                  type="text"
                                  aria-label="หมายเหตุ"
                                  maxLength={500}
                                  placeholder="หมายเหตุ เช่น เลขอ้างอิงการโอนคืน"
                                  value={refundEdit.note}
                                  onChange={(e) => setRefundEdit((v) => ({ ...v, note: e.target.value }))}
                                />
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busy || !refundEdit.refunded_at}
                                  onClick={() =>
                                    run(async () => {
                                      await api.updateInvoiceRefund(item.invoice_id, refund.refund_id, {
                                        refunded_at: refundEdit.refunded_at,
                                        method: refundEdit.method || null,
                                        note: refundEdit.note.trim() || null,
                                      });
                                      setRefundEditFor(null);
                                      toast('แก้ข้อมูลเงินคืนแล้ว — ค่าเดิมเก็บไว้ในประวัติ');
                                    })
                                  }
                                >
                                  บันทึก
                                </button>
                              </div>
                            )}
                            {/* ยกเลิกเอกสารที่ออกผิด — ใบลดหนี้ที่มีเงินคืน เงินคืนถูกยกเลิกไปพร้อมกัน (server ทำใน transaction เดียว)
                                ใบเพิ่มหนี้ที่ทำให้ยอดต่ำกว่าเงินที่รับ server ปฏิเสธ */}
                            {canMoney && canAdjust && n.status === 'issued' && (
                              <button
                                type="button"
                                className="inline-link danger-link"
                                disabled={busy}
                                onClick={() => { setNoteCancelFor(noteCancelFor === n.note_id ? null : n.note_id); setNoteCancelReason(''); }}
                              >
                                {noteCancelFor === n.note_id ? 'ไม่ยกเลิกแล้ว' : 'ยกเลิกเอกสารนี้'}
                              </button>
                            )}
                            {noteCancelFor === n.note_id && (
                              <div className="pay-void-form">
                                {refundActive && (
                                  <p className="adj-refund-note">
                                    ใบนี้มีเงินคืน {amountText(refund.amount)} บาท ({refund.refund_doc_id ?? 'ใบสำคัญจ่าย'}) —
                                    ยกเลิกใบลดหนี้แล้วเงินคืนจะถูกยกเลิกด้วย ยอดค้างของลูกค้าจะกลับมา
                                    ใช้เมื่อไม่ได้โอนคืนจริง หรือลูกค้าโอนเงินกลับมาแล้วเท่านั้น
                                  </p>
                                )}
                                <input
                                  type="text"
                                  value={noteCancelReason}
                                  maxLength={300}
                                  placeholder="เหตุผล เช่น ออกผิดใบ · ยอดผิด"
                                  onChange={(e) => setNoteCancelReason(e.target.value)}
                                />
                                <button
                                  type="button"
                                  className="btn danger"
                                  disabled={busy || noteCancelReason.trim().length < 3}
                                  onClick={() =>
                                    run(async () => {
                                      await api.cancelInvoiceAdjustment(item.invoice_id, n.note_id, noteCancelReason.trim());
                                      setNoteCancelFor(null);
                                      setNoteCancelReason('');
                                      toast(`ยกเลิก ${n.note_id} แล้ว${refundActive ? ' พร้อมเงินคืน' : ''}`);
                                    })
                                  }
                                >
                                  ยืนยันยกเลิกเอกสาร
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* สลิปโอนเงินของลูกค้า — หลักฐานของเงินที่รับ จึงแนบได้เมื่อใบรับเงินมาแล้วเท่านั้น */}
                  {Number(item.paid_amount) > 0 && (
                    <div className="slip-block">
                      <span className="field-label">สลิปโอนเงิน</span>
                      <div className="slip-list">
                        {item.slips?.filter((slip) => slip.status === 'confirmed').map((slip) => (
                          <figure className="slip" key={slip.slip_id}>
                            <a
                              className="slip-thumb"
                              href={api.invoiceSlipUrl(item.invoice_id, slip.slip_id)}
                              target="_blank"
                              rel="noreferrer"
                              title="กดเพื่อดูรูปเต็ม"
                            >
                              <img src={api.invoiceSlipUrl(item.invoice_id, slip.slip_id)} alt={`สลิป #${slip.slip_id}`} />
                            </a>
                            <figcaption className="muted">
                              {docDate(slip.created_at.slice(0, 10))} · {formatFileSize(slip.image_size)}
                              {slip.uploaded_by_name && <><br />แนบโดย {slip.uploaded_by_name}</>}
                              {canDeleteSlip && <br />}
                              {canDeleteSlip && <ConfirmButton
                                className="inline-link"
                                disabled={busy}
                                title="ลบสลิปนี้?"
                                detail="ลบแล้วกู้คืนไม่ได้ — ยอดรับชำระของใบไม่เปลี่ยน"
                                confirmLabel="ลบสลิป"
                                onConfirm={() => run(() => api.deleteInvoiceSlip(item.invoice_id, slip.slip_id))}
                              >
                                ลบ
                              </ConfirmButton>}
                            </figcaption>
                          </figure>
                        ))}
                        <label className={`slip-thumb empty${busy ? ' is-busy' : ''}`} title="แนบรูปสลิปโอนเงิน">
                          <span>{busy ? 'กำลังแนบ…' : '+ แนบสลิป'}</span>
                          <input
                            type="file"
                            accept={ACCEPTED}
                            hidden
                            disabled={busy}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = ''; // ล้างไว้ เลือกไฟล์เดิมซ้ำได้ (เช่น แนบพลาดแล้วลองใหม่)
                              if (!file) return;
                              run(async () => {
                                await api.addInvoiceSlip(item.invoice_id, await compressImage(file));
                                toast('แนบสลิปแล้ว');
                              });
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* ใบที่ระบบเตรียมไว้ตอนเปิดเคส ยังไม่ใช่เอกสารจนกว่าจะเลือกวิธีเก็บเงิน
                  ตัวใบจึงถูกซ่อนไว้ก่อน — ส่งใบที่ยังไม่รู้ว่าจะเก็บเท่าไหร่ให้ลูกค้าไม่ได้ */}
              {item.needs_plan && (
                <section className="plan-choose no-print">
                  <h3>เลือกวิธีเก็บเงิน</h3>
                  {/* ไม่ทวนยอดซ้ำตรงนี้ — การ์ดซ้ายแสดงยอดเต็มเป็นตัวเลขใหญ่อยู่แล้ว
                      ประโยคนำจึงเหลือหน้าที่เดียวคือบอกว่ากำลังให้เลือกอะไร (และจบในบรรทัดเดียว) */}
                  <p className="muted">เลือกก่อนว่าจะเก็บครั้งเดียวจบ หรือแบ่งเก็บมัดจำก่อน</p>

                  <div className="plan-options">
                    <div className="plan-option">
                      <h4>จ่ายเต็มจำนวน</h4>
                      {/* ป้ายกำกับ + ตัวเลข วางตรงกับป้ายกำกับ + ช่องกรอกของการ์ดขวาแถวต่อแถว
                          สองใบจึงอ่านคู่กันได้ทีละบรรทัด ไม่ใช่สองก้อนที่บังเอิญวางข้างกัน */}
                      <div className="plan-figure">
                        <span className="plan-figure-label">ยอดเต็ม</span>
                        <p className="plan-amount">{amountText(item.total)}<span> บาท</span></p>
                      </div>
                      <p className="muted">ออกใบเดียว เก็บครั้งเดียวจบ ไม่มีใบตามเก็บทีหลัง</p>
                      <button
                        className="btn primary"
                        disabled={busy || item.total <= 0}
                        onClick={() =>
                          run(async () => {
                            await api.setInvoiceBillingPlan(item.invoice_id, { mode: 'full' });
                            toast('ตั้งเป็นใบเก็บเต็มจำนวนแล้ว');
                          })
                        }
                      >
                        เก็บเต็มจำนวน
                      </button>
                    </div>

                    {/* ใบรายครั้งแบ่งมัดจำไม่ได้ (server ปฏิเสธด้วย 409) — บรรทัดรายกะรวมเต็มยอดจะค้างอยู่ที่ใบมัดจำ
                        บอกเหตุผลแทนการโชว์ช่องกรอกที่กดแล้วยังไงก็ไม่ผ่าน */}
                    {item.has_items ? (
                    <div className="plan-option">
                      <h4>มัดจำก่อน แล้วเก็บส่วนที่เหลือ</h4>
                      <p className="muted">
                        ใบนี้แตกเป็นรายครั้งตามกะที่ไปจริง จึงแบ่งมัดจำไม่ได้ — ถ้าต้องการเก็บมัดจำ
                        ให้ลบใบนี้แล้วออกใบแบบแพ็คเกจแทน
                      </p>
                    </div>
                    ) : (
                    <div className="plan-option">
                      <h4>มัดจำก่อน แล้วเก็บส่วนที่เหลือ</h4>
                      <label>
                        ยอดมัดจำ (บาท)
                        <input
                          type="number"
                          min="1"
                          max={item.total}
                          step="0.01"
                          placeholder="เช่น 5000"
                          value={depositDraft}
                          onChange={(e) => setDepositDraft(e.target.value)}
                        />
                      </label>
                      {/* บอกยอดใบที่สองให้เห็นตั้งแต่ยังไม่กด — ตัวเลขที่ต้องตามเก็บทีหลังคือสิ่งที่ต้องรู้ก่อนตัดสินใจ */}
                      <p className="muted">
                        {Number(depositDraft) > 0 && Number(depositDraft) < item.total
                          ? `ใบที่ 1 มัดจำ ${amountText(Number(depositDraft))} · ใบที่ 2 คงเหลือ ${amountText(item.total - Number(depositDraft))}`
                          : 'ระบบจะออกใบมัดจำ และใบส่วนที่เหลือให้อัตโนมัติ'}
                      </p>
                      <button
                        className="btn primary"
                        disabled={
                          busy ||
                          !(Number(depositDraft) > 0) ||
                          Number(depositDraft) >= item.total
                        }
                        onClick={() =>
                          run(async () => {
                            const res = await api.setInvoiceBillingPlan(item.invoice_id, {
                              mode: 'deposit',
                              deposit_amount: Number(depositDraft),
                            });
                            setDepositDraft('');
                            toast(`แบ่งเป็นใบมัดจำ ${amountText(res.total)} และใบส่วนที่เหลือแล้ว`);
                          })
                        }
                      >
                        แบ่งเก็บมัดจำ
                      </button>
                    </div>
                    )}
                  </div>
                </section>
              )}

              {/* ตัวเอกสารบนจอ (ดูก่อนพิมพ์) — ตอนสั่งพิมพ์ใช้สำเนาใน .print-sheet ด้านล่างแทน */}
              <div className={`invoice-doc ${item.needs_plan ? 'is-hidden' : ''}`}>
                {shownBody}
              </div>
            </div>

            <footer className="modal-foot no-print">
              {/* ปุ่มทำลายดันไปชิดซ้ายสุด แยกออกจากกลุ่มปุ่มที่กดกันจริง — ไม่ให้มือไปโดนตอนเล็งปุ่มข้างๆ
                  (อีกปุ่มหนึ่งอยู่ในกล่องเตือน "ไม่ตรงกับเคส" ซึ่งเป็นคนละบริบท จงใจให้อยู่ตรงนั้น)

                  ใบที่รับชำระแล้วให้ "ยกเลิก" ไม่ใช่ "ลบ" — ตัวเลขที่รับมาจริงพร้อมวันที่/ช่องทางที่จ่าย
                  เป็นหลักฐานการเงิน ลบทิ้งแล้วไม่เหลืออะไรบอกว่าเคยรับเงินก้อนนี้มา
                  (ต่างจากใบร่าง/ใบที่ออกผิดซึ่งลบทิ้งได้ ตามที่ตั้งใจไว้ในโค้ดฝั่ง server)
                  ถ้าจำเป็นต้องลบจริงๆ ยกเลิกก่อนแล้วค่อยลบใบที่ยกเลิกได้ — สองจังหวะสำหรับของที่กู้ไม่ได้ */}
              {/* ลบถาวรได้เฉพาะใบร่าง — ใบที่ออกแล้วมีเลขที่เอกสาร ต้องยกเลิกแทน (server ปฏิเสธเหมือนกัน · 4 พ.ย. 2569) */}
              {item.status === 'draft' && (
                <ConfirmButton
                  className="btn danger-ghost foot-danger"
                  disabled={busy}
                  /* ใบที่เป็นงวดของแผนถูกลบพร้อมใบคู่เสมอ — ต้องบอกตั้งแต่ในกล่องยืนยัน
                     ไม่ใช่ให้รู้ตอนกดไปแล้วว่าอีกใบหายไปด้วย */
                  title={
                    item.is_plan_part && plan.length > 0
                      ? `ลบทั้งแผนมัดจำ (${[item.invoice_id, ...plan.map((s) => s.invoice_id)].join(' และ ')}) ทิ้งถาวร?`
                      : `ลบใบแจ้งหนี้ ${item.invoice_id} ทิ้งถาวร?`
                  }
                  detail={
                    item.is_plan_part && plan.length > 0
                      ? 'ใบมัดจำกับใบส่วนที่เหลือเป็นยอดเดียวกันคนละครึ่ง จึงถูกลบพร้อมกันทั้งคู่ · ลบแล้วกู้คืนไม่ได้ และเลขที่ใบจะข้าม — จากนั้นระบบจะถามว่าจะออกใบร่างใหม่ให้เลือกวิธีเก็บเงินอีกครั้งไหม'
                      : 'ลบแล้วกู้คืนไม่ได้ และเลขที่ใบจะข้าม'
                  }
                  confirmLabel="ลบถาวร"
                  onConfirm={deleteInvoice}
                >
                  ลบใบนี้
                </ConfirmButton>
              )}

              {/* ใบที่ออกแล้วแต่ไม่ได้ถือเงินลูกค้า — ยกเลิกได้โดยไม่ต้องลบทิ้ง เก็บไว้เป็นประวัติ
                  ใบที่รับเงินไว้ต้องออกใบลดหนี้เต็มยอดพร้อมคืนเงินก่อน ปุ่มนี้จึงโผล่หลังคืนเงินครบแล้ว */}
              {canCancel && (
                <button
                  type="button"
                  className="btn danger-ghost foot-danger"
                  disabled={busy}
                  onClick={() => {
                    setCancelOpen((open) => !open);
                    setCancelReason('');
                    setPayOpen(false);
                    setAdjOpen(false);
                  }}
                >
                  ยกเลิกใบ
                </button>
              )}

              {canAdjust && (
                <button
                  className="btn"
                  disabled={busy}
                  title={Number(item.paid_amount) > 0 ? 'ยกเลิกใบที่รับเงินแล้ว = ออกใบลดหนี้เต็มยอดพร้อมคืนเงินก่อน' : undefined}
                  onClick={() => (adjOpen ? setAdjOpen(false) : openAdjustForm())}
                >
                  ใบลดหนี้/เพิ่มหนี้
                </button>
              )}

              {/* เลือกเอกสารที่จะดู/พิมพ์ — ตัวเอกสารด้านบนเปลี่ยนตาม และปุ่มพิมพ์พิมพ์ใบที่เลือกอยู่
                  ชำระแล้วมีใบเสร็จฝ่ายการเงิน · รับเงินแต่ละครั้งมีใบเสร็จของตัวเอง · ใบลดหนี้/เพิ่มหนี้แยกใบ */}
              {(isReceipt || item.receipts?.length > 0 || item.adjustments?.length > 0) && !item.needs_plan && (
                <SearchSelect
                  className="foot-switch"
                  aria-label="เลือกเอกสารที่จะดู/พิมพ์"
                  value={viewReceipt || viewNote || viewRefund || docView === 'finance' ? docView : 'customer'}
                  onChange={(e) => setDocView(e.target.value)}
                >
                  <option value="customer">{isReceipt ? 'ใบเสร็จรวม (ลูกค้า)' : 'ใบแจ้งหนี้'}</option>
                  {isReceipt && <option value="finance">ใบเสร็จฝ่ายการเงิน</option>}
                  {item.receipts?.map((r) => (
                    <option key={r.receipt_id} value={`rc:${r.receipt_id}`}>
                      ใบเสร็จ {r.receipt_id} · {amountText(r.amount)}{r.status === 'voided' ? ' (ยกเลิก)' : ''}
                    </option>
                  ))}
                  {item.adjustments?.map((n) => (
                    <option key={n.note_id} value={`note:${n.note_id}`}>
                      {n.kind === 'credit' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'} {n.note_id}{n.status === 'cancelled' ? ' (ยกเลิก)' : ''}
                    </option>
                  ))}
                  {item.refunds?.map((r) => (
                    <option key={r.refund_id} value={`pv:${r.refund_id}`}>
                      ใบสำคัญจ่าย {r.refund_doc_id ?? `#${r.refund_id}`} · {amountText(r.amount)}{r.status === 'voided' ? ' (ยกเลิก)' : ''}
                    </option>
                  ))}
                </SearchSelect>
              )}

              {lineInfo && (
                <ConfirmButton
                  className="btn"
                  disabled={busy || !lineInfo.can_send}
                  title={`ส่ง${isReceipt ? 'ใบเสร็จ' : 'ใบแจ้งหนี้'} ${item.invoice_id} เข้า LINE ${lineInfo.customer_name ?? 'ลูกค้า'}?`}
                  detail="ลูกค้าได้ข้อความสรุปยอด + ลิงก์เปิดดู/บันทึกเอกสาร (ลิงก์ใช้ได้ 6 เดือน) · ข้อความขึ้นในห้องแชทของลูกค้าในแดชบอร์ด admin ด้วย"
                  confirmLabel="ส่งเข้า LINE"
                  cancelLabel="ยังไม่ส่ง"
                  onConfirm={sendLine}
                >
                  <span title={lineInfo.can_send ? undefined : lineInfo.reason}>ส่งเข้า LINE ลูกค้า</span>
                </ConfirmButton>
              )}
              {(item.status === 'issued' || item.status === 'paid') && (
                <button className="btn" disabled={busy} onClick={copyBill}>
                  คัดลอกบิล
                </button>
              )}
              {/* ลิงก์บิลที่ส่งออกไปแล้วเปิดได้ 6 เดือน (ดร.ธงชัยเคาะ 24 ต.ค. 2569)
                  ถ้าส่งผิดห้องหรือรู้ว่าถูกส่งต่อ ต้องปิดได้ ไม่ใช่รอครบหกเดือน
                  ในลิงก์มีชื่อผู้ป่วย รหัสผู้ป่วย เลขผู้เสียภาษี และประวัติชำระ */}
              {shareLinks?.length > 0 && (
                <ConfirmButton
                  className="btn danger-ghost"
                  disabled={busy}
                  title={`ปิดลิงก์บิลของ ${item.invoice_id} ทั้ง ${shareLinks.length} ลิงก์?`}
                  detail="คนที่ถือลิงก์เดิมจะเปิดไม่ได้อีก · ส่งใหม่ได้ด้วยปุ่ม “ส่งเข้า LINE ลูกค้า” หรือ “คัดลอกบิล”"
                  confirmLabel="ปิดลิงก์"
                  cancelLabel="ไม่ปิดแล้ว"
                  onConfirm={() =>
                    run(async () => {
                      const r = await api.revokeInvoiceShareLinks(item.invoice_id, 'ปิดจากหน้าใบแจ้งหนี้');
                      setShareLinks(r.links ?? []);
                      toast(`ปิดลิงก์บิลแล้ว ${r.revoked} ลิงก์`);
                    })
                  }
                >
                  ปิดลิงก์ที่ส่งไปแล้ว ({shareLinks.length})
                </ConfirmButton>
              )}
              {lineInfoError && (
                <button className="btn danger-ghost" disabled={busy} onClick={retryLineInfo}>
                  ตรวจสถานะ LINE ไม่ได้ · ลองใหม่
                </button>
              )}
              {lineInfo && (lastSend || !lineInfo.can_send) && (
                <span className="muted foot-note">
                  {!lineInfo.can_send ? lineInfo.reason
                    : lastSend.error?.startsWith('ข้าม:') ? lastSend.error
                    : lastSend.sent_at ? `ส่งเข้า LINE แล้ว ${new Date(lastSend.sent_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${lastSend.created_by_name ? ` · ${lastSend.created_by_name}` : ''}`
                    : lastSend.attempts >= 3 ? `ส่งไม่สำเร็จ: ${lastSend.error ?? ''}`
                    // คิวหมดอายุ 1 วัน (ระบบแชทไม่หยิบแล้ว) — บอกให้กดส่งใหม่ ไม่ค้าง "อยู่ในคิว" ตลอดไป
                    : Date.now() - new Date(lastSend.created_at).getTime() > 864e5 ? `ส่งไม่สำเร็จ (หมดเวลา)${lastSend.error ? `: ${lastSend.error}` : ''} — กดส่งใหม่ได้`
                    : 'อยู่ในคิวส่ง…'}
                </span>
              )}

              {copyText && (
                <div className="notice warn" style={{ width: '100%' }}>
                  <strong>คัดลอกอัตโนมัติไม่ได้</strong> · เลือกข้อความด้านล่างแล้วคัดลอกเอง
                  <textarea
                    readOnly
                    value={copyText}
                    rows={8}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.currentTarget.select()}
                    style={{ width: '100%', marginTop: '.5rem' }}
                    aria-label="ข้อความบิลสำหรับคัดลอก"
                  />
                </div>
              )}

              {!item.needs_plan && (
                <button className="btn" onClick={() => window.print()}>พิมพ์ / บันทึก PDF</button>
              )}

              {/* ใบที่ไม่ตรงกับเคสมีปุ่มรีเฟรชอยู่ในกล่องเตือนแล้ว — ตรงนี้ไว้ให้ใบที่ยอดตรงอยู่แต่
                  อยากดึงข้อมูลใหม่ (เช่น ใบเก่าที่ยังไม่ได้แจกแจงส่วนลด หรือแก้ที่อยู่ลูกค้าทีหลัง) */}
              {canEdit && item.case_id && !item.is_stale && !item.needs_plan && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => run(() => api.refreshInvoice(item.invoice_id))}
                >
                  รีเฟรชจากเคส
                </button>
              )}

              {item.status === 'draft' && !item.needs_plan && (
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
              {(item.status === 'draft' || item.status === 'issued') && !item.needs_plan && (
                <button
                  className={`btn ${item.status === 'issued' ? 'primary' : ''}`}
                  disabled={busy}
                  onClick={() => {
                    if (payOpen) { setPayOpen(false); setPaySlipId(null); }
                    else { setAdjOpen(false); openPaymentForm(); }
                  }}
                >
                  บันทึกการชำระเงิน
                </button>
              )}
            </footer>
          </>
        )}
      </div>

      {printSheet}

      {/* portal ออกไปที่ body เหมือน ConfirmButton — บนจอแคบ .modal มี transform กล่องจะโผล่ผิดที่
          Esc ระหว่างนี้ = ปิด popup ทั้งชุด ซึ่งเท่ากับตอบ "ไม่ออกใบใหม่" อยู่แล้ว */}
      {reissue &&
        createPortal(
          <div className="modal-backdrop modal-stacked" onClick={(e) => e.stopPropagation()}>
            <div
              className="modal modal-narrow confirm-box"
              role="alertdialog"
              aria-modal="true"
              aria-label="ออกใบร่างใหม่"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-body confirm-body">
                <h2>ลบ {reissue.deleted.join(' และ ')} แล้ว</h2>
                <p className="muted">
                  ออกใบร่างใหม่ตามข้อมูลปัจจุบันของเคส {caseCode(reissue.caseId)} เลยไหม? ระบบจะดึงยอดจากค่าบริการของเคส
                  แล้วให้เลือกวิธีเก็บเงิน (เต็มจำนวน / แบ่งมัดจำ) อีกครั้ง
                </p>
              </div>
              <footer className="modal-foot">
                <button type="button" className="btn" disabled={busy} onClick={() => answerReissue(false)}>
                  ไม่ต้อง
                </button>
                <button type="button" className="btn primary" autoFocus disabled={busy} onClick={() => answerReissue(true)}>
                  {busy ? 'กำลังออกใบ…' : 'ออกใบร่างใหม่'}
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
