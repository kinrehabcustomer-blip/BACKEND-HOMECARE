import { sql, nextInvoiceId, transaction } from '../db/index.js';

const NOW = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')`;
/* วันนี้ตามเวลาไทย ไม่ใช่ UTC — ใช้กับวันที่ออกใบ/วันรับชำระ/เกณฑ์เลยกำหนด
   ของเดิมใช้ UTC ทำให้ทุกอย่างที่ทำระหว่างเที่ยงคืนถึงตีเจ็ดถูกลงวันที่เป็นเมื่อวาน
   (ออกใบตีสองของวันที่ 1 ได้ issue_date เป็นวันที่ 31 ของเดือนก่อน — ผิดทั้งเอกสารและรอบบัญชี) */
const TODAY = () => new Date(Date.now() + 7 * 3.6e6).toISOString().slice(0, 10);

// ช่องที่แก้ได้ตอนยังเป็นร่าง (สถานะ/ยอดรวมไม่อยู่ในนี้ — total คิดจาก amount-discount เสมอ)
const EDITABLE = [
  'issue_date', 'due_date', 'bill_to_name', 'bill_to_tax_id', 'bill_to_address',
  'service_description', 'amount', 'discount', 'payment_method', 'note',
];

// case_payer_name = ชื่อผู้จ่าย "ที่ควรจะเป็น" ของเคสตอนนี้ ไล่ตามลำดับ:
//   ผู้ว่าจ้างของเคส -> ผู้ว่าจ้างของแฟ้มผู้ป่วย (เผื่อเพิ่งผูกทีหลัง เคสยังไม่มี) -> ชื่อผู้ป่วยในเคส
// ใช้เทียบกับ bill_to_name ในใบ เพื่อรู้ว่าใบยังตรงกับผู้จ่ายปัจจุบันไหม (ดู withComputed.payer_stale)
const SELECT_INVOICE = `
  SELECT i.*,
         EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id) AS has_items,
         c.title       AS case_title,
         c.status      AS case_status,
         c.fee         AS case_fee,
         cu.name       AS customer_name,
         cu.phone      AS customer_phone,
         COALESCE(ccu.name, pcu.name, c.client_name) AS case_payer_name
  FROM invoices i
  LEFT JOIN cases c      ON c.case_id      = i.case_id
  LEFT JOIN customers cu ON cu.customer_id = i.customer_id
  LEFT JOIN customers ccu ON ccu.customer_id = c.customer_id
  LEFT JOIN patients p    ON p.patient_id   = c.patient_id
  LEFT JOIN customers pcu ON pcu.customer_id = p.customer_id
`;

/**
 * ราคาเต็มก่อนลดของเคส — กายภาพใช้ราคาเต็มของแพ็คเกจ · Homecare ใช้ค่าบริการในตารางเรท
 * ว่าง = ไม่ได้ตั้งราคาเต็มไว้ (แพ็คที่ไม่ใช่โปรโมชัน / เคสที่ไม่ได้เลือกบริการ) = ไม่มีส่วนลดให้แสดง
 */
const listPriceOf = (c) =>
  c.service_kind === 'physio' || c.physio_package_id != null
    ? c.physio_original_price
    : c.rate_customer_price;

/**
 * แยกค่าจ้างของเคสเป็น "ยอดก่อนลด + ส่วนลด" เพื่อให้ใบแจ้งหนี้แสดงส่วนลดที่ลูกค้าได้รับ
 *
 * fee ของเคสเป็นราคา "หลังลด" อยู่แล้ว (คัดลอกมาจากราคาสุทธิของแพ็คเกจ/เรท) — ถ้าเอาลงใบตรงๆ
 * บรรทัดส่วนลดจะเป็น 0 เสมอทั้งที่ลูกค้าได้ส่วนลดจริง จึงย้อนกลับด้วยราคาเต็มที่เคสอ้างอิงอยู่
 * ยอดสุทธิ (total) ยังเท่ากับ fee เสมอ — ตัวเลขที่ลูกค้าต้องจ่ายไม่เปลี่ยน แค่แจกแจงที่มาให้เห็น
 *
 * ไม่มีราคาเต็ม หรือราคาเต็มไม่เกินค่าจ้าง (เช่น แก้ค่าจ้างเองให้สูงกว่าราคาตั้ง) = ไม่มีส่วนลด
 */
function priceParts(caseRow) {
  const net = caseRow.fee ?? 0;
  const list = listPriceOf(caseRow);
  return list != null && list > net
    ? { amount: list, discount: list - net }
    : { amount: net, discount: 0 };
}

/**
 * "เกินกำหนดชำระ" คำนวณตอนอ่าน ไม่เก็บเป็นสถานะใน DB
 * เพราะมันเปลี่ยนเองตามวันที่ผ่านไป ถ้าเก็บไว้ต้องมีงานคอยไล่อัปเดตทุกวัน แล้วก็มีโอกาสค้างไม่ตรงจริง
 */
const withComputed = (row) => {
  /*
   * ใบไม่ตรงกับข้อมูลเคสแล้ว — แยกเป็น 2 กรณี เพราะทางแก้/ข้อความที่โชว์ต่างกัน:
   *   fee_stale   = ยอดในใบไม่ตรงกับค่าจ้างของเคส
   *   payer_stale = ชื่อผู้จ่ายในใบไม่ตรงกับผู้จ่ายปัจจุบันของเคส
   *                 (มักเกิดตอนออกใบไปก่อน แล้วเพิ่งมาผูกผู้ว่าจ้างกับผู้ป่วย/เคสทีหลัง)
   * ใบร่างระบบซิงก์ให้เองตอนแก้เคส/ผูกลูกค้า แต่ยังไม่ตรงได้ถ้ามีคนแก้ยอดในใบเอง — จึงเช็คทุกสถานะ
   * แล้วให้หน้าเว็บเลือกทางแก้ตามสถานะ (ร่าง/ออกใบแล้ว = กดรีเฟรช · ชำระแล้ว = ยกเลิกแล้วออกใบใหม่)
   */
  // เทียบกับยอดสุทธิ ไม่ใช่ยอดก่อนลด — amount เป็นราคาเต็มแล้ว ส่วน total คือเงินที่ลูกค้าต้องจ่ายจริง
  // ซึ่งเป็นตัวที่ต้องตรงกับค่าจ้างของเคส (ดู priceParts)
  // ใบที่แตกเป็นรายครั้ง (มี items) ตั้งใจให้ยอดเป็นสัดส่วนของกะที่ไปจริง ไม่ใช่ยอดเต็มของเคส
  // เทียบกับ fee ของเคสแล้วจะขึ้นป้าย "ไม่ตรงกับเคส" ตลอดทั้งที่ถูกต้องอยู่แล้ว
  const feeStale =
    !row.has_items &&
    row.case_id != null && row.case_fee != null && Number(row.case_fee) !== Number(row.total);
  const payerStale =
    row.case_id != null && row.case_payer_name != null && row.case_payer_name !== row.bill_to_name;

  return {
    ...row,
    is_overdue: row.status === 'issued' && row.due_date != null && row.due_date < TODAY(),
    fee_stale: feeStale,
    payer_stale: payerStale,
    is_stale: feeStale || payerStale,
  };
};

/**
 * เงื่อนไขกรองที่ใช้ร่วมกันระหว่างรายการกับยอดสรุป — ต้องเป็นก้อนเดียวกันจริงๆ
 * ไม่งั้นตัวเลขสรุปด้านบนจะไม่ตรงกับรายการที่เห็นข้างล่าง (เช่น กรอง "ชำระแล้ว" แต่ยังขึ้น "รอชำระ 5 ใบ")
 */
function buildWhere({ q, status, customer_id, case_id, overdue }) {
  const where = [];
  const params = {};

  if (q) {
    where.push('(i.invoice_id ILIKE :q OR i.bill_to_name ILIKE :q OR i.case_id ILIKE :q)');
    params.q = `%${q}%`;
  }
  if (status) {
    where.push('i.status = :status');
    params.status = status;
  }
  if (customer_id) {
    where.push('i.customer_id = :customer_id');
    params.customer_id = customer_id;
  }
  if (case_id) {
    where.push('i.case_id = :case_id');
    params.case_id = case_id;
  }
  // "เกินกำหนด" ไม่ใช่สถานะใน DB — คิดสดจากวันครบกำหนดที่ผ่านมาแล้ว (นิยามเดียวกับ withComputed)
  if (overdue === 'yes') {
    where.push("i.status = 'issued' AND i.due_date IS NOT NULL AND i.due_date < :today");
    params.today = TODAY();
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function list({ q, status, customer_id, case_id, overdue, page, per_page, sort, order }) {
  const { clause, params } = buildWhere({ q, status, customer_id, case_id, overdue });
  const { total } = await sql.one(`SELECT COUNT(*) AS total FROM invoices i ${clause}`, params);

  // NULLS LAST — due_date/paid_at ว่างได้ ถ้าไม่ใส่ การเรียงจากมากไปน้อยจะเอาใบที่ยังไม่ได้ระบุขึ้นก่อน
  const rows = await sql.all(
    `${SELECT_INVOICE} ${clause}
     ORDER BY i.${sort} ${order.toUpperCase()} NULLS LAST
     LIMIT :limit OFFSET :offset`,
    { ...params, limit: per_page, offset: (page - 1) * per_page },
  );

  const count = Number(total);
  return {
    data: rows.map(withComputed),
    pagination: { page, per_page, total: count, total_pages: Math.ceil(count / per_page) || 1 },
  };
}

/**
 * ใบเดี่ยว + รายการย่อย — หน้ารายการไม่ต้องใช้ items จึงดึงเฉพาะตอนเปิดดูใบจริง
 * items ว่าง = ใบแบบแพ็คเกจบรรทัดเดียว (ส่วนใหญ่เป็นแบบนี้)
 */
export const findById = async (id) => {
  const row = await sql.one(`${SELECT_INVOICE} WHERE i.invoice_id = :id`, { id });
  if (!row) return null;
  return withComputed({ ...row, items: await listItems(id) });
};

// ใบแจ้งหนี้ของลูกค้ารายหนึ่งดึงผ่าน list({ customer_id }) ซึ่งมีตัวกรอง/แบ่งหน้าครบอยู่แล้ว
// เคยมี listForCustomer แยกไว้ที่นี่แต่ไม่มีใครเรียก — ลบทิ้งแล้ว

/** ใบแจ้งหนี้ของเคสหนึ่งใบ — เคสหนึ่งออกได้ใบเดียว แต่ถ้ายกเลิกแล้วออกใหม่ได้ จึงคืนเป็นรายการ */
export const listForCase = (caseId) =>
  sql
    .all(`${SELECT_INVOICE} WHERE i.case_id = :id ORDER BY i.invoice_id DESC`, { id: caseId })
    .then((rows) => rows.map(withComputed));

/** รายการย่อยของใบ (ว่าง = ใบแบบแพ็คเกจบรรทัดเดียวตามปกติ) */
export const listItems = (invoiceId) =>
  sql.all(
    `SELECT seq, description, quantity, unit_price, amount
     FROM invoice_items WHERE invoice_id = :id ORDER BY seq`,
    { id: invoiceId },
  );

/**
 * แตกใบเป็นรายการรายครั้งจาก "กะที่ไปมาแล้วจริง" ของเคส
 *
 * ราคาต่อครั้ง = ค่าบริการของเคส ÷ จำนวนกะที่นัดไว้ทั้งหมด (นิยามเดียวกับการเกลี่ยค่าจ้างพนักงาน)
 * บรรทัดสุดท้ายรับเศษที่ปัดทิ้งไป ผลรวมจึงเท่ากับยอดที่ตั้งใจเก็บเป๊ะ ไม่ขาดไม่เกินสตางค์
 * ไม่มีกะที่ทำเสร็จเลย = ออกใบแบบนี้ไม่ได้ (ให้ผู้เรียกตัดสินใจต่อ)
 */
export async function visitLines(caseRow, { from, to } = {}) {
  const where = ['v.case_id = :id', 'v.check_out_at IS NOT NULL'];
  const params = { id: caseRow.case_id };
  if (from) {
    where.push('v.visit_date >= :from');
    params.from = from;
  }
  if (to) {
    where.push('v.visit_date <= :to');
    params.to = to;
  }

  const [visits, booked] = await Promise.all([
    sql.all(
      `SELECT v.visit_date, v.planned_start, v.planned_end,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM case_visits v
       LEFT JOIN employees e ON e.employee_id = v.checked_in_by
       WHERE ${where.join(' AND ')}
       ORDER BY v.visit_date, v.planned_start NULLS FIRST, v.visit_id`,
      params,
    ),
    sql.one(
      `SELECT COUNT(*) AS n FROM case_visits WHERE case_id = :id AND status <> 'cancelled'`,
      { id: caseRow.case_id },
    ),
  ]);

  if (visits.length === 0) return { lines: [], amount: 0 };

  const perVisit = Number(booked.n) > 0 ? (caseRow.fee ?? 0) / Number(booked.n) : 0;
  const rounded = Math.round(perVisit * 100) / 100;
  // เก็บเฉพาะครั้งที่ไปจริง — ยอดรวมจึงเป็นสัดส่วนของกะที่ทำ ไม่ใช่ทั้งแพ็คเกจ
  const total = Math.round(rounded * visits.length * 100) / 100;

  const lines = visits.map((v, i) => ({
    seq: i + 1,
    description: [
      `${v.visit_date}`,
      [v.planned_start, v.planned_end].filter(Boolean).join('-'),
      v.employee_name,
    ]
      .filter(Boolean)
      .join(' · '),
    quantity: 1,
    unit_price: rounded,
    // บรรทัดสุดท้ายกลืนเศษการปัดของทุกบรรทัดก่อนหน้า
    amount: i === visits.length - 1 ? Math.round((total - rounded * i) * 100) / 100 : rounded,
  }));

  return { lines, amount: total };
}

/**
 * สร้างใบแจ้งหนี้จากเคส — คัดลอกข้อมูลผู้จ่ายและค่าบริการ ณ ตอนนี้มาเก็บไว้ในใบ
 * ไม่ผูกอ่านสด เพราะใบที่ออกไปแล้วต้องคงเดิมแม้ลูกค้าจะย้ายบ้านหรือเคสจะถูกแก้ราคา
 *
 * items = รายการรายครั้งที่ route เตรียมมาให้ (ออกใบตามกะที่ไปจริง) — ไม่ส่งมา = ใบแบบแพ็คเกจตามเดิม
 */
export function createFromCase(caseRow, input, actor, items = []) {
  const customer = caseRow.customer ?? null;

  // ยอดก่อนลด + ส่วนลด แจกแจงมาจากราคาเต็มที่เคสอ้างอิงอยู่ (ดู priceParts)
  // ส่งยอดมาเองก็ให้ส่วนลดเป็นของผู้เรียกล้วนๆ ไม่เดาจากราคาตั้งของเคส จะได้ไม่ขัดกับยอดที่ตั้งใจ
  // ใบที่แตกเป็นรายครั้งใช้ผลรวมของรายการเป็นยอดก่อนลด — ราคาตั้งของแพ็คเกจไม่เกี่ยวแล้ว
  const auto = items.length > 0
    ? { amount: items.reduce((s, i) => s + i.amount, 0), discount: 0 }
    : priceParts(caseRow);
  const amount = input.amount ?? auto.amount;
  const discount = input.discount ?? (input.amount != null ? 0 : auto.discount);

  const values = {
    case_id: caseRow.case_id,
    // ผู้ว่าจ้างที่ route หามาให้ (อาจมาจากแฟ้มผู้ป่วยถ้าเคสยังไม่มี) — ต้องตรงกับ bill_to ด้านล่าง
    // ไม่งั้น "รหัสลูกค้า" ว่างแต่ชื่อขึ้น หรือกลับกัน
    customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
    issue_date: input.issue_date ?? TODAY(),
    due_date: input.due_date ?? null,

    bill_to_name: input.bill_to_name ?? customer?.name ?? caseRow.client_name,
    bill_to_tax_id: input.bill_to_tax_id ?? customer?.tax_id ?? null,
    bill_to_address:
      input.bill_to_address ?? customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,

    service_description: input.service_description ?? describeService(caseRow),
    amount,
    discount,
    total: Math.max(0, amount - discount),

    payment_method: input.payment_method ?? null,
    note: input.note ?? null,

    // พนักงานที่กดออกใบ — เก็บชื่อ ณ ตอนนั้นไว้เลย ใบจะได้ไม่เปลี่ยนชื่อผู้ทำรายการทีหลัง
    issued_by: actor?.employee_id ?? null,
    issued_by_name: actor?.name ?? null,
  };

  return transaction(async (tx) => {
    const invoiceId = await nextInvoiceId(tx);
    await tx.one(
      `INSERT INTO invoices
         (invoice_id, case_id, customer_id, issue_date, due_date,
          bill_to_name, bill_to_tax_id, bill_to_address,
          service_description, amount, discount, total, payment_method, note,
          issued_by, issued_by_name)
       VALUES
         (:invoice_id, :case_id, :customer_id, :issue_date, :due_date,
          :bill_to_name, :bill_to_tax_id, :bill_to_address,
          :service_description, :amount, :discount, :total, :payment_method, :note,
          :issued_by, :issued_by_name)
       RETURNING invoice_id`,
      { ...values, invoice_id: invoiceId },
    );

    for (const line of items) {
      await tx.run(
        `INSERT INTO invoice_items (invoice_id, seq, description, quantity, unit_price, amount)
         VALUES (:invoice_id, :seq, :description, :quantity, :unit_price, :amount)`,
        { ...line, invoice_id: invoiceId },
      );
    }

    return invoiceId;
  }).then(findById);
}

// ใบที่ยัง "แก้ได้" — เอกสารยังอยู่ในมือเรา ยังไม่ได้ส่งมอบให้ลูกค้าจริง
// ชำระแล้ว = เงินเข้ามือแล้ว ยอดกลายเป็นข้อเท็จจริง · ยกเลิกแล้ว = จบไปแล้ว ทั้งคู่จึงไม่แตะ
const OPEN_STATUSES = "('draft', 'issued')";

/**
 * เคสถูกแก้ -> ดึงข้อมูลใหม่ลงใบที่ยังแก้ได้ของเคสนั้นให้ตรงกัน
 *
 * ยอดก่อนลด/ส่วนลด ถูกคิดใหม่ทั้งคู่จากราคาของเคส (ดู priceParts) — ทับค่าเดิมในใบ
 * เพราะสองตัวนี้เป็นคู่กัน ถ้าอัปเดตแค่ตัวเดียวยอดสุทธิจะเพี้ยนทันที
 */
export async function syncOpenFromCase(caseRow, customer) {
  const price = priceParts(caseRow);

  /* ::double precision ในบรรทัด total ไม่ใช่ของประดับ — node-postgres ส่งพารามิเตอร์มาโดยไม่ระบุชนิด
     พอเขียน ":amount - :discount" ตรงๆ Postgres เจอ unknown ลบ unknown แล้วเลือกไม่ถูกว่าจะใช้
     ตัวลบของชนิดไหน (int/numeric/date/…) จึงโยน "operator is not unique: unknown - unknown"
     ตั้งแต่ตอน parse — คือพังทุกครั้งที่บันทึกเคส ไม่ว่าจะมีใบแจ้งหนี้ให้ซิงก์อยู่จริงหรือไม่
     เพราะ Postgres ตรวจไวยากรณ์ก่อนดูว่า WHERE ตรงกับแถวไหนบ้าง

     บรรทัด total ใน update() ด้านล่างเขียนคล้ายกันแต่ไม่เจอปัญหา เพราะห่อด้วย COALESCE คู่กับคอลัมน์
     คอลัมน์จึงบอกชนิดให้พารามิเตอร์ไปแล้ว — ต่างกันแค่นั้น

     หมายเหตุ: ห้ามเขียนคอมเมนต์ที่มีข้อความหน้าตาแบบ :ชื่อ ไว้ในสตริง SQL —
     ตัวแปลง :name เป็น $n ใน db/index.js ข้ามแค่ string literal กับ cast ไม่ได้ข้ามคอมเมนต์ของ SQL
     ข้อความในคอมเมนต์จึงถูกนับเป็นพารามิเตอร์ไปด้วย แล้วลำดับ $n จะเพี้ยนทั้งคำสั่ง */
  const changed = await sql.run(
    `UPDATE invoices
     SET customer_id         = :customer_id,
         bill_to_name        = :bill_to_name,
         bill_to_tax_id      = :bill_to_tax_id,
         bill_to_address     = :bill_to_address,
         service_description = :service_description,
         amount              = :amount,
         discount            = :discount,
         total               = GREATEST(0, :amount::double precision - :discount::double precision),
         updated_at          = ${NOW}
     WHERE case_id = :case_id AND status IN ${OPEN_STATUSES}
       AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = invoices.invoice_id)`,
    {
      case_id: caseRow.case_id,
      customer_id: customer?.customer_id ?? caseRow.customer_id ?? null,
      bill_to_name: customer?.name ?? caseRow.client_name,
      bill_to_tax_id: customer?.tax_id ?? null,
      bill_to_address:
        customer?.billing_address ?? customer?.address ?? caseRow.address ?? null,
      service_description: describeService(caseRow),
      amount: price.amount,
      discount: price.discount,
    },
  );
  return changed;
}

/** ข้อความรายการบริการบนใบ — ประกอบจากสิ่งที่เคสเลือกไว้ */
function describeService(c) {
  /* แพ็คเกจกายภาพที่นี่ตั้งชื่อตามจำนวนครั้งอยู่แล้ว ("แพ็ค 20 ครั้ง", "10 ครั้ง 3 เดือน")
     เติม "· 20 ครั้ง" ต่อท้ายอีกจึงได้ "แพ็ค 20 ครั้ง · 20 ครั้ง" ซึ่งซ้ำคำเปล่าๆ
     และกินที่จนรายการโดน … ตัดกลางคำในตาราง — เติมเฉพาะตอนชื่อยังไม่ได้บอกจำนวนครั้งไว้ */
  const sessions =
    c.physio_sessions && !String(c.physio_package_name ?? '').includes(`${c.physio_sessions} ครั้ง`)
      ? `${c.physio_sessions} ครั้ง`
      : null;

  const parts =
    c.service_kind === 'physio'
      ? [c.physio_package_name, sessions]
      : [c.format_name, c.grade_name, c.pkg_staff_tier];

  const service = parts.filter(Boolean).join(' · ');
  return [service || c.title, c.client_name && `ผู้รับบริการ: ${c.client_name}`]
    .filter(Boolean)
    .join(' — ');
}

export async function update(invoiceId, input) {
  const fields = EDITABLE.filter((c) => c in input);
  if (fields.length === 0) return findById(invoiceId);

  const values = { invoice_id: invoiceId };
  for (const c of fields) values[c] = input[c] ?? null;

  // ยอดสุทธิคิดใหม่ทุกครั้งที่ยอด/ส่วนลดถูกแตะ — ไม่ให้หน้าเว็บส่ง total มาเอง จะได้ไม่มีทางขัดกัน
  const sets = fields.map((c) => `${c} = :${c}`);
  if ('amount' in input || 'discount' in input) {
    sets.push('total = GREATEST(0, COALESCE(:amount_f, amount) - COALESCE(:discount_f, discount))');
    values.amount_f = input.amount ?? null;
    values.discount_f = input.discount ?? null;
  }

  await sql.run(
    `UPDATE invoices SET ${sets.join(', ')}, updated_at = ${NOW} WHERE invoice_id = :invoice_id`,
    values,
  );
  return findById(invoiceId);
}

/** ออกใบ (ร่าง -> ออกแล้ว) — หลังจากนี้แก้ไม่ได้ เพราะถือว่าส่งให้ลูกค้าไปแล้ว */
export async function issue(invoiceId) {
  await sql.run(
    `UPDATE invoices SET status = 'issued', updated_at = ${NOW} WHERE invoice_id = :id`,
    { id: invoiceId },
  );
  return findById(invoiceId);
}

/** บันทึกรับชำระ — เก็บชื่อพนักงานที่รับเงินไว้ใช้เป็นผู้ลงนามบนใบเสร็จ (อาจคนละคนกับผู้ออกใบ) */
export async function pay(invoiceId, { paid_at, payment_method }, actor) {
  await sql.run(
    `UPDATE invoices
     SET status = 'paid',
         paid_at = :paid_at,
         payment_method = COALESCE(:payment_method, payment_method),
         paid_by = :paid_by,
         paid_by_name = :paid_by_name,
         updated_at = ${NOW}
     WHERE invoice_id = :id`,
    {
      id: invoiceId,
      paid_at: paid_at ?? TODAY(),
      payment_method: payment_method ?? null,
      paid_by: actor?.employee_id ?? null,
      paid_by_name: actor?.name ?? null,
    },
  );
  return findById(invoiceId);
}

/** ยกเลิก — ไม่ลบทิ้ง เพราะเลขที่เอกสารต้องเรียงต่อเนื่อง ห้ามข้าม */
export async function cancel(invoiceId) {
  await sql.run(
    `UPDATE invoices SET status = 'cancelled', updated_at = ${NOW} WHERE invoice_id = :id`,
    { id: invoiceId },
  );
  return findById(invoiceId);
}

export const remove = (invoiceId) =>
  sql.run('DELETE FROM invoices WHERE invoice_id = :id', { id: invoiceId }).then((n) => n > 0);

/**
 * ยอดสรุปแยกตามสถานะ — รับตัวกรองชุดเดียวกับ list() เพื่อให้ตัวเลขด้านบนตรงกับรายการที่เห็น
 * ไม่ส่งตัวกรองมา = นับทั้งระบบเหมือนเดิม
 */
export async function summary(filters = {}) {
  const { clause, params } = buildWhere(filters);
  const rows = await sql.all(
    `SELECT i.status, COUNT(*) AS count, SUM(i.total) AS amount FROM invoices i ${clause} GROUP BY i.status`,
    params,
  );
  return rows.map((r) => ({ ...r, count: Number(r.count), amount: Number(r.amount ?? 0) }));
}

// ความละเอียดของแกนเวลาในกราฟรายได้ — ค่ามาจาก enum ใน schema แล้ว จึงต่อเข้า SQL ตรงๆ ได้
// (สัปดาห์ของ date_trunc เริ่มวันจันทร์ ตรงกับที่คนไทยนับสัปดาห์)
const BUCKETS = {
  day: { unit: 'day', step: '1 day' },
  week: { unit: 'week', step: '1 week' },
};

/**
 * รายได้ตามช่วงเวลา สำหรับกราฟเส้นในหน้าภาพรวม
 *
 * นับเฉพาะใบที่ "ชำระแล้ว" และยึด paid_at (วันที่เงินเข้า) ไม่ใช่ issue_date — ใบที่ออกไปแล้ว
 * แต่ยังไม่เก็บเงินไม่ใช่รายได้ และวันที่ออกใบกับวันที่รับเงินมักคนละวัน
 *
 * ช่วงเวลาถูกกางด้วย generate_series ก่อนแล้วค่อย LEFT JOIN — วันที่ไม่มีใบชำระเลยต้องได้ 0
 * ไม่ใช่หายไปจากผลลัพธ์ ไม่งั้นกราฟเส้นจะลากข้ามช่องว่างเหมือนวันนั้นมีรายได้ต่อเนื่อง
 *
 * หมายเหตุ: "วันนี้" อิงเวลาไทยเหมือน TODAY() ที่ใช้ตอนบันทึกชำระ — เส้นแบ่งวันของกราฟ
 * จึงตรงกับเส้นแบ่งวันของข้อมูลที่บันทึกไว้ และตรงกับวันที่คนดูกราฟเข้าใจ
 */
export async function revenue({ bucket, points }) {
  const { unit, step } = BUCKETS[bucket];

  const rows = await sql.all(
    `WITH buckets AS (
       SELECT generate_series(
                date_trunc('${unit}', :today::date) - :span::interval,
                date_trunc('${unit}', :today::date),
                '${step}'::interval
              )::date AS bucket
     )
     SELECT to_char(b.bucket, 'YYYY-MM-DD') AS period,
            COALESCE(SUM(i.total), 0)       AS revenue,
            COUNT(i.invoice_id)             AS invoices
     FROM buckets b
     LEFT JOIN invoices i
            ON i.status = 'paid'
           AND i.paid_at IS NOT NULL
           AND date_trunc('${unit}', LEFT(i.paid_at, 10)::date)::date = b.bucket
     GROUP BY b.bucket
     ORDER BY b.bucket`,
    { today: TODAY(), span: `${points - 1} ${unit}` },
  );

  const data = rows.map((r) => ({
    period: r.period,
    revenue: Number(r.revenue),
    invoices: Number(r.invoices),
  }));

  return {
    bucket,
    data,
    total: data.reduce((sum, r) => sum + r.revenue, 0),
    invoices: data.reduce((sum, r) => sum + r.invoices, 0),
  };
}
