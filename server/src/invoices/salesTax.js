import { sql } from '../db/index.js';
import { ensureLedgerTables } from './ledger.js';
import { round2 } from './buReport.js';

/**
 * รายงานภาษีขายรายเดือน (ผู้ใช้ขอ 24 พ.ย. 2569 — แบบฟอร์มตามตัวอย่าง แต่หน้าตาของระบบเรา)
 *
 * เอกสารที่นับ = ใบเสร็จรับเงิน/ใบกำกับภาษี (receipts) ตามวันที่รับเงิน
 *                + ใบลดหนี้ (ติดลบ) / ใบเพิ่มหนี้ (บวก) ตามวันที่ออก — ผู้ใช้เลือกให้รวม (24 พ.ย. 2569)
 * VAT: ธุรกิจไม่ได้จด VAT (ดู schema.sql ตาราง invoices) ผู้ใช้เลือก "ไม่มี VAT" (24 พ.ย. 2569)
 *      → มูลค่าสินค้า/บริการ = ยอดเต็ม · ภาษีมูลค่าเพิ่ม = 0 · มูลค่าสุทธิ = ยอดเต็ม
 * ใบที่ยกเลิกแล้ว (ใบเสร็จ voided · ใบลด/เพิ่มหนี้ cancelled) ยังอยู่ในรายงานเป็นยอด 0 พร้อมป้าย "ยกเลิก"
 *   — เลขที่เอกสารต้องเห็นครบไม่ขาดช่วง ตามแบบรายงานภาษีขายทั่วไป
 */
/**
 * ช่วงที่ดูได้สองแบบ (ผู้ใช้ขอเพิ่ม 24 พ.ย. 2569 "เพิ่มให้เลือกช่วงเวลาได้")
 *   { month: 'YYYY-MM' } = ทั้งเดือน (แบบฟอร์มภาษีรายเดือน) · { from, to } = ช่วงวันที่ที่เลือกเอง (รวมสองปลาย)
 */
export async function salesTaxReport({ month = null, from: rangeFrom = null, to: rangeTo = null }) {
  await ensureLedgerTables();
  let from = rangeFrom;
  let to = rangeTo;
  if (month) {
    from = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  const rows = await sql.all(
    `SELECT 'receipt' AS doc_type, r.receipt_id AS doc_id, LEFT(r.paid_at, 10) AS doc_date, r.invoice_id,
            r.amount, r.status = 'voided' AS cancelled, r.is_deposit, r.bill_to_name, r.bill_to_tax_id,
            i.billing_kind, NULL AS reason
       FROM receipts r JOIN invoices i ON i.invoice_id = r.invoice_id
      WHERE LEFT(r.paid_at, 10) BETWEEN :from AND :to
     UNION ALL
     SELECT a.kind, a.note_id, a.issue_date, a.invoice_id,
            CASE WHEN a.kind = 'credit' THEN -a.amount ELSE a.amount END, a.status = 'cancelled', FALSE,
            a.bill_to_name, a.bill_to_tax_id, i.billing_kind, a.reason
       FROM invoice_adjustments a JOIN invoices i ON i.invoice_id = a.invoice_id
      WHERE a.issue_date BETWEEN :from AND :to
     ORDER BY 3, 2`,
    { from, to },
  );
  const data = rows.map((r) => {
    const amount = r.cancelled ? 0 : round2(Number(r.amount));
    return {
      doc_type: r.doc_type, // receipt · credit · debit
      doc_id: r.doc_id,
      doc_date: r.doc_date,
      invoice_id: r.invoice_id,
      billing_kind: r.billing_kind ?? null,
      is_deposit: Boolean(r.is_deposit),
      buyer_name: r.bill_to_name ?? '',
      buyer_tax_id: r.bill_to_tax_id ?? '',
      cancelled: Boolean(r.cancelled),
      reason: r.reason ?? null,
      base: amount,
      vat: 0,
      total: amount,
    };
  });
  const sum = (k) => round2(data.reduce((s, r) => s + r[k], 0));
  return { month, from, to, data, totals: { count: data.length, base: sum('base'), vat: sum('vat'), total: sum('total') } };
}
