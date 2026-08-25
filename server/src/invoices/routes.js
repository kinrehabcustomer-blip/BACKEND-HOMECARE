import { Router } from 'express';
import * as repo from './repo.js';
import * as cases from '../cases/repo.js';
import * as customers from '../customers/repo.js';
import * as patients from '../patients/repo.js';
import {
  createInvoiceSchema,
  updateInvoiceSchema,
  depositAmountSchema,
  paySchema,
  billingPlanSchema,
  listQuerySchema,
  revenueQuerySchema,
  INVOICE_STATUSES,
} from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';
import { requireManager } from '../lib/auth.js';

export const invoicesRouter = Router();

// ใบที่เอกสารยังอยู่ในมือเรา — แก้/รีเฟรชได้ (ส่งมอบให้ลูกค้าครั้งเดียวตอนพิมพ์)
const OPEN_STATUSES = ['draft', 'issued'];

function throwIfInvoiceMoved(result) {
  if (!result) {
    throw new ApiError(409, 'ข้อมูลใบแจ้งหนี้เปลี่ยนไประหว่างทำรายการ กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง');
  }
  if (result.reason === 'not_found') throw notFound('ไม่พบใบแจ้งหนี้นี้');
  if (result.reason === 'state_changed') {
    throw new ApiError(409, 'ข้อมูลใบแจ้งหนี้เปลี่ยนไประหว่างทำรายการ กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง');
  }
}

/**
 * หาผู้ว่าจ้าง (ผู้จ่าย) ของเคสสำหรับคัดลอกลงใบแจ้งหนี้
 * เคสมีผู้ว่าจ้างของตัวเองใช้อันนั้น — ไม่มีแต่แฟ้มผู้ป่วยผูกลูกค้าไว้ ให้ใช้ลูกค้าของผู้ป่วยแทน
 * (กรณีเปิดเคสตอนยังไม่รู้ผู้จ่าย แล้วเพิ่งมาผูกลูกค้ากับผู้ป่วยทีหลัง)
 */
export async function resolvePayer(caseRow) {
  if (caseRow.customer_id) return customers.findById(caseRow.customer_id);
  if (caseRow.patient_id) {
    const patient = await patients.findById(caseRow.patient_id);
    if (patient?.customer_id) return customers.findById(patient.customer_id);
  }
  return null;
}

/**
 * ใบร่างของเคสหนึ่งใบ — ใช้ตอนเปิดเคสใหม่ (ระบบออกให้เอง ไม่ต้องรอคนกด)
 *
 * อยู่ที่นี่ไม่ใช่ที่ repo เพราะการหา "ผู้จ่าย" ต้องไล่จากเคส → ผู้ว่าจ้าง → แฟ้มผู้ป่วย
 * ซึ่งเป็นตรรกะเดียวกับตอนกดออกใบเอง ถ้าเขียนแยกสองที่ วันหนึ่งใบที่ระบบออกให้กับใบที่คนกด
 * จะได้ชื่อผู้จ่ายคนละคน
 *
 * ไม่ส่ง input อะไรไปเลย = ใช้ค่าที่คัดลอกมาจากเคสทั้งหมด (ยอด/ผู้จ่าย/รายการบริการ)
 * ยังไม่ได้ตั้งค่าบริการก็ออกได้ ใบจะเป็นยอด 0 แล้วซิงก์ตามทีหลังตอนแก้เคส (ดู syncOpenFromCase)
 */
export async function createDraftForCase(caseRow, actor) {
  /* กันใบร่างซ้ำไว้ตรงนี้ด้วย ไม่ใช่แค่ที่ปุ่มออกใบ — เส้นนี้ทำงานเองตอนเปิดเคส
     ถ้าคำขอเปิดเคสถูกยิงซ้ำ (เน็ตหลุดกลางทางแล้วกดใหม่) จะได้ไม่เหลือใบร่างค้างสองใบเงียบๆ */
  const existing = await repo.findDraftForCase(caseRow.case_id);
  if (existing) return repo.findById(existing.invoice_id);

  const customer = await resolvePayer(caseRow);
  return repo.createFromCase({ ...caseRow, customer }, {}, actor);
}

/** โหลดใบแจ้งหนี้ก่อนทุก route ที่มี :id — ไม่มีก็ 404 ตั้งแต่ตรงนี้ */
invoicesRouter.param('id', (req, res, next, id) => {
  repo
    .findById(id)
    .then((found) => {
      if (!found) return next(notFound(`ไม่พบใบแจ้งหนี้รหัส ${id}`));
      req.invoice = found;
      next();
    })
    .catch(next);
});

invoicesRouter.get('/meta', (req, res) => res.json({ statuses: INVOICE_STATUSES }));

/** ยอดสรุป — รับตัวกรองชุดเดียวกับรายการ เพื่อให้ตัวเลขด้านบนตรงกับสิ่งที่ผู้ใช้เห็นอยู่ */
invoicesRouter.get(
  '/summary',
  asyncRoute(async (req, res) => res.json(await repo.summary(listQuerySchema.parse(req.query)))),
);

/**
 * รายได้ตามช่วงเวลาสำหรับกราฟหน้าภาพรวม — ต้องอยู่เหนือ '/:id' ไม่งั้นโดนจับเป็นรหัสใบแจ้งหนี้
 *
 * เฉพาะผู้จัดการ (แคบกว่าทั้ง router ที่เป็น requireAdmin ซึ่งรวม HR ด้วย) — ตัวเลขนี้คือรายได้รวม
 * ของบริษัท ไม่ใช่ข้อมูลที่ต้องใช้ทำงานประจำวัน กันที่เส้น API ไม่ใช่แค่ซ่อนการ์ดบนหน้าจอ
 * ไม่งั้นยิง /api/invoices/revenue ตรงด้วยคุกกี้เดิมก็ได้ตัวเลขครบ
 */
invoicesRouter.get(
  '/revenue',
  requireManager,
  asyncRoute(async (req, res) => res.json(await repo.revenue(revenueQuerySchema.parse(req.query)))),
);

invoicesRouter.get(
  '/',
  asyncRoute(async (req, res) => res.json(await repo.list(listQuerySchema.parse(req.query)))),
);

/**
 * ออกใบแจ้งหนี้จากเคส — server คัดลอกชื่อผู้จ่าย/ที่อยู่/ค่าบริการ ณ ตอนนี้มาเก็บไว้ในใบ
 * เคสที่ยกเลิกไปแล้วออกบิลไม่ได้ (ไม่ได้ให้บริการจริง)
 */
invoicesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createInvoiceSchema.parse(req.body);

    const caseRow = await cases.findById(input.case_id);
    if (!caseRow) throw new ApiError(400, `ไม่พบเคสรหัส ${input.case_id}`);
    if (caseRow.status === 'cancelled') {
      throw new ApiError(409, 'เคสนี้ถูกยกเลิกไปแล้ว ออกใบแจ้งหนี้ไม่ได้');
    }

    /* เคสนี้มีใบร่างค้างอยู่แล้ว — ออกเพิ่มจะได้ใบเหมือนกันสองใบที่แยกไม่ออกว่าใบไหนคือใบจริง
       (ที่มาของใบซ้ำคือปุ่ม "ลบแล้วออกใบใหม่" ซึ่งเสนอออกใบใหม่ให้ทุกครั้งโดยไม่ได้ดูว่าเคสยังมีใบร่างอยู่ไหม)
       กันที่นี่ ไม่ใช่แค่ซ่อนปุ่มฝั่งหน้าเว็บ เพราะ endpoint เรียกตรงได้
       ส่งรหัสใบเดิมกลับไปด้วย หน้าเว็บจะได้พาไปเปิดใบนั้นแทนที่จะให้ไล่หาเอง */
    const draft = await repo.findDraftForCase(input.case_id);
    if (draft) {
      throw new ApiError(
        409,
        `เคสนี้มีใบร่าง ${draft.invoice_id} ค้างอยู่แล้ว — แก้ใบเดิมหรือลบทิ้งก่อนจึงจะออกใบใหม่ได้`,
        { existing_invoice_id: draft.invoice_id },
      );
    }

    // ดึงลูกค้าเต็มๆ เพื่อเอาเลขผู้เสียภาษี/ที่อยู่ออกบิลมาคัดลอก (SELECT ของเคสมีแค่ชื่อ)
    // เคสไม่มีผู้ว่าจ้างแต่ผูกลูกค้าไว้ที่แฟ้มผู้ป่วย → ใช้ลูกค้าของผู้ป่วย ชื่อจะได้ขึ้นในใบ
    const customer = await resolvePayer(caseRow);

    // ออกใบตามกะที่ไปจริง — แตกเป็นรายการรายครั้ง ยอดรวมคิดจากกะที่ทำเสร็จแล้วเท่านั้น
    let items = [];
    if (input.basis === 'visits') {
      ({ lines: items } = await repo.visitLines(caseRow, input));
      if (items.length === 0) {
        throw new ApiError(409, 'เคสนี้ยังไม่มีกะที่เช็คอิน–เอาท์ครบในช่วงที่เลือก จึงออกใบตามกะไม่ได้');
      }
    }

    // req.user มาจาก requireAuth = พนักงานที่กำลังทำรายการนี้ → บันทึกเป็นผู้ออกเอกสาร
    res.status(201).json(await repo.createFromCase({ ...caseRow, customer }, input, req.user, items));
  }),
);

invoicesRouter.get('/:id', (req, res) => res.json(req.invoice));

/**
 * แก้ได้ตราบใดที่เอกสารยังอยู่ในมือเรา (ร่าง/ออกใบแล้ว) — ส่งมอบให้ลูกค้าครั้งเดียวตอนพิมพ์
 * ชำระแล้ว = เงินเข้ามือแล้ว ยอดกลายเป็นข้อเท็จจริง ต้องยกเลิกแล้วออกใบใหม่แทน
 */
invoicesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const result = await repo.update(req.params.id, updateInvoiceSchema.parse(req.body ?? {}));
    throwIfInvoiceMoved(result);
    if (result.reason === 'invalid_status') {
      throw new ApiError(409, 'ใบที่ชำระ/ยกเลิกแล้วแก้ไม่ได้ — ต้องยกเลิกแล้วออกใบใหม่');
    }
    if (result.reason === 'plan_amount_locked') {
      throw new ApiError(
        409,
        'ใบนี้เป็นงวดหนึ่งของแผนมัดจำ — แก้ยอดที่ช่อง "ยอดมัดจำ" ของใบมัดจำ เพื่อให้ใบคู่ขยับตามกัน',
      );
    }
    if (result.reason === 'amount_below_paid') {
      throw new ApiError(
        409,
        `ใบนี้รับชำระมาแล้ว ${result.paid.toLocaleString('th-TH')} บาท จึงตั้งยอดสุทธิต่ำกว่านี้ไม่ได้`,
      );
    }
    res.json(result);
  }),
);

/** ดึงข้อมูลล่าสุดจากเคสมาทับใบ — ใช้ตอนแก้ข้อมูลลูกค้า/ค่าจ้างแล้วอยากให้ใบตรงก่อนพิมพ์ส่งลูกค้า */
invoicesRouter.post(
  '/:id/refresh',
  asyncRoute(async (req, res) => {
    if (!OPEN_STATUSES.includes(req.invoice.status)) {
      throw new ApiError(409, 'ใบที่ชำระ/ยกเลิกแล้วรีเฟรชไม่ได้ — ต้องยกเลิกแล้วออกใบใหม่');
    }
    if (!req.invoice.case_id) throw new ApiError(409, 'ใบนี้ไม่ได้ผูกกับเคส จึงไม่มีต้นทางให้ดึงข้อมูล');
    if (req.invoice.has_items) {
      throw new ApiError(
        409,
        'ใบนี้แตกเป็นรายครั้งไว้แล้ว จึงรีเฟรชจากค่าบริการของเคสไม่ได้ — ถ้าจำนวนครั้งเปลี่ยน ให้ลบใบนี้แล้วออกใหม่',
      );
    }

    const caseRow = await cases.findById(req.invoice.case_id);
    if (!caseRow) throw new ApiError(409, 'เคสต้นทางถูกลบไปแล้ว');

    const customer = await resolvePayer(caseRow);
    await repo.syncOpenFromCase(caseRow, customer);

    res.json(await repo.findById(req.params.id));
  }),
);

/**
 * เลือกวิธีเก็บเงิน (เต็มจำนวน / แบ่งมัดจำ) — ต้องเลือกก่อนถึงจะใช้ใบเป็นเอกสารได้
 * เลือกได้ครั้งเดียว: ใบที่เลือกไปแล้วมีเลขที่เอกสารและอาจส่งให้ลูกค้าไปแล้ว
 * เปลี่ยนใจให้ลบใบร่างทิ้งแล้วออกใหม่ (เลขที่เอกสารจะเดินต่อ ไม่ย้อนกลับ)
 */
invoicesRouter.post(
  '/:id/billing-plan',
  asyncRoute(async (req, res) => {
    const input = billingPlanSchema.parse(req.body ?? {});
    const result = await repo.setBillingPlan(req.params.id, input, req.user);
    throwIfInvoiceMoved(result);
    if (result.reason === 'invalid_status') {
      throw new ApiError(409, 'ใบนี้ออกไปแล้ว เปลี่ยนวิธีเก็บเงินไม่ได้');
    }
    if (result.reason === 'billing_plan_already_set') {
      throw new ApiError(409, 'ใบนี้เลือกวิธีเก็บเงินไปแล้ว');
    }
    if (result.reason === 'empty_total') {
      throw new ApiError(409, 'ใบนี้ยังไม่มียอด — ตั้งค่าบริการของเคสก่อนจึงจะแบ่งงวดได้');
    }
    if (result.reason === 'deposit_not_less_than_total') {
      throw new ApiError(400, 'ยอดมัดจำต้องน้อยกว่ายอดเต็ม — ถ้าเก็บทั้งหมดให้เลือก "เก็บเต็มจำนวน"');
    }
    if (result.reason === 'has_payments') {
      throw new ApiError(409, 'ใบนี้มีรายการรับชำระแล้ว จึงเปลี่ยนวิธีเก็บเงินไม่ได้');
    }
    if (result.reason === 'plan_invalid') {
      throw new ApiError(409, 'ข้อมูลแผนวางบิลของใบนี้ไม่สมบูรณ์ กรุณาตรวจสอบก่อนแบ่งงวดใหม่');
    }
    res.json(result);
  }),
);

/**
 * แก้ยอดมัดจำโดยไม่ต้องลบใบทิ้ง — ยอดเต็มของแผนคงเดิม ใบส่วนที่เหลือขยับตามให้เอง
 *
 * ของเดิมเลือกวิธีเก็บเงินได้ครั้งเดียวจบ ตกลงยอดมัดจำใหม่กับลูกค้าทีไรต้องลบทั้งแผนทิ้งแล้วแบ่งใหม่
 * ซึ่งทำให้เลขที่เอกสารข้ามและใบที่ส่งให้ลูกค้าไปแล้วหายไปทั้งคู่ ทั้งที่แค่ตัวเลขเดียวเปลี่ยน
 *
 * แก้ได้ที่ "ใบมัดจำ" เท่านั้น — ใบส่วนที่เหลือคือ "ยอดเต็มลบมัดจำ" ตามนิยาม ไม่ใช่ตัวเลขอิสระ
 * ถ้าให้แก้ได้ทั้งสองทาง จะตอบไม่ได้ทันทีว่าที่แก้นั้นแปลว่ายอดเต็มเปลี่ยน หรือมัดจำเปลี่ยน
 */
invoicesRouter.patch(
  '/:id/deposit',
  asyncRoute(async (req, res) => {
    const { deposit_amount } = depositAmountSchema.parse(req.body ?? {});
    const result = await repo.setDepositAmount(req.params.id, deposit_amount);
    throwIfInvoiceMoved(result);

    if (result.reason === 'not_deposit_invoice') {
      throw new ApiError(
        409,
        result.billing_kind === 'balance'
          ? 'ยอดของใบส่วนที่เหลือคิดมาจากยอดมัดจำ — แก้ที่ใบมัดจำแล้วใบนี้จะเปลี่ยนตามเอง'
          : 'ใบนี้ไม่ได้แบ่งเก็บมัดจำ จึงไม่มียอดมัดจำให้แก้',
      );
    }
    if (result.reason === 'plan_invalid') {
      throw new ApiError(409, 'ไม่พบใบส่วนที่เหลือเพียงใบเดียวของแผนนี้ จึงแก้ยอดมัดจำไม่ได้');
    }
    if (result.reason === 'invalid_status') {
      throw new ApiError(
        409,
        `ใบ ${result.invoice_id} ${result.status === 'paid' ? 'ชำระครบแล้ว' : 'ถูกยกเลิกแล้ว'}` +
          ' — แก้ยอดมัดจำไม่ได้ เพราะใบทั้งคู่ต้องขยับตามกันเสมอ',
      );
    }
    if (result.reason === 'deposit_not_less_than_total') {
      throw new ApiError(
        400,
        `ยอดมัดจำต้องน้อยกว่ายอดเต็มของแผน (${result.total.toLocaleString('th-TH')} บาท)` +
          ' — ถ้าจะเก็บทั้งหมดในใบเดียว ให้ลบใบส่วนที่เหลือแล้วออกใบใหม่',
      );
    }
    if (result.reason === 'deposit_below_paid') {
      throw new ApiError(
        409,
        `ใบมัดจำนี้รับเงินมาแล้ว ${result.paid.toLocaleString('th-TH')} บาท — ตั้งยอดมัดจำต่ำกว่านี้ไม่ได้`,
      );
    }
    if (result.reason === 'balance_below_paid') {
      throw new ApiError(
        409,
        `ใบส่วนที่เหลือ ${result.invoice_id} รับเงินมาแล้ว ${result.paid.toLocaleString('th-TH')} บาท` +
          ` — ยอดมัดจำจึงสูงได้ไม่เกิน ${result.max_deposit.toLocaleString('th-TH')} บาท`,
      );
    }
    res.json(result);
  }),
);

/** ใบคู่ในแผนเดียวกัน (มัดจำ ↔ ส่วนที่เหลือ) */
invoicesRouter.get(
  '/:id/plan',
  asyncRoute(async (req, res) => res.json(await repo.listPlanSiblings(req.params.id))),
);

invoicesRouter.post(
  '/:id/issue',
  asyncRoute(async (req, res) => {
    const result = await repo.issue(req.params.id);
    throwIfInvoiceMoved(result);
    if (result.reason === 'invalid_status') throw new ApiError(409, 'ใบนี้ออกไปแล้ว');
    if (result.reason === 'billing_plan_required') {
      throw new ApiError(409, 'กรุณาเลือกว่าจะเก็บเต็มจำนวนหรือแบ่งมัดจำก่อนออกใบ');
    }
    res.json(result);
  }),
);

/**
 * รับชำระหนึ่งงวด — ไม่ส่งจำนวนเงินมา = รับเต็มยอดที่ค้าง
 * รับได้ไม่เกินยอดค้าง: รับเกินแล้วยอดคงเหลือจะติดลบ ซึ่งอ่านไม่ออกว่าเป็นเงินทอนหรือกรอกผิด
 */
invoicesRouter.post(
  '/:id/pay',
  asyncRoute(async (req, res) => {
    const input = paySchema.parse(req.body ?? {});
    const result = await repo.pay(req.params.id, input, req.user);
    throwIfInvoiceMoved(result);
    if (result.reason === 'cancelled') throw new ApiError(409, 'ใบนี้ถูกยกเลิกไประหว่างทำรายการ');
    if (result.reason === 'fully_paid') throw new ApiError(409, 'ใบนี้มีผู้รับชำระครบยอดไปแล้ว กรุณาโหลดข้อมูลใหม่');
    if (result.reason === 'billing_plan_required') {
      throw new ApiError(409, 'กรุณาเลือกว่าจะเก็บเต็มจำนวนหรือแบ่งมัดจำก่อนรับชำระ');
    }
    if (result.reason === 'request_id_required') {
      throw new ApiError(400, 'คำขอรับชำระไม่มีรหัสป้องกันการบันทึกซ้ำ');
    }
    if (result.reason === 'idempotency_conflict') {
      throw new ApiError(409, 'คำขอรับชำระเดิมถูกส่งมาด้วยข้อมูลที่ต่างกัน กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง');
    }
    if (result.reason === 'amount_exceeds_balance') {
      throw new ApiError(
        409,
        `ยอดคงเหลือเปลี่ยนไประหว่างทำรายการ ขณะนี้รับได้ไม่เกิน ${result.balance.toLocaleString('th-TH')} บาท`,
      );
    }
    if (result.reason === 'invalid_amount') throw new ApiError(400, 'จำนวนเงินที่รับต้องมากกว่า 0');

    res.json(result);
  }),
);

invoicesRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    const result = await repo.cancel(req.params.id);
    throwIfInvoiceMoved(result);
    if (result.reason === 'invalid_status') throw new ApiError(409, 'ใบนี้ถูกยกเลิกไปแล้ว');
    res.json(result);
  }),
);

/**
 * ลบใบถาวร — ใช้ตอนออกใบผิดแล้วอยากออกใหม่ให้สะอาด ไม่เหลือใบยกเลิกรกรายการ
 *
 * ธุรกิจไม่ได้จดทะเบียน VAT จึงไม่ติดข้อบังคับเรื่องเลขเอกสารต้องเรียงต่อเนื่อง
 * แลกกับการที่เลขที่ใบจะข้าม และไม่เหลือประวัติว่าเคยออกใบยอดเท่าไหร่
 * (ถ้าวันหนึ่งจด VAT ต้องเปลี่ยนมาใช้ "ยกเลิก" แทน — endpoint /cancel ยังอยู่ครบ)
 *
 * ยกเว้นใบที่รับชำระแล้ว: ยอดที่รับมาจริงพร้อมวันที่/ช่องทางที่จ่ายเป็นหลักฐานการเงิน
 * ไม่ใช่แค่เรื่องเลขเอกสาร ลบทิ้งแล้วไม่เหลืออะไรบอกว่าเคยรับเงินก้อนนี้มา
 * ต้องยกเลิกก่อน (ใบยังอยู่เป็นประวัติ) แล้วค่อยลบใบที่ยกเลิกได้ถ้าจำเป็นจริงๆ
 * — กันที่นี่ด้วย ไม่ใช่แค่ซ่อนปุ่มฝั่งหน้าเว็บ เพราะ endpoint เรียกตรงได้
 */
invoicesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const result = await repo.remove(req.params.id);
    throwIfInvoiceMoved(result);
    if (result.reason === 'has_payments') {
      throw new ApiError(
        409,
        `ใบ ${result.invoice_id} ในแผนเดียวกันรับชำระมาแล้ว — ลบใบนี้ต้องลบทั้งแผนจึงทำไม่ได้ ` +
          'ให้กด "ยกเลิกใบนี้" แทน (ใบจะยังอยู่เป็นประวัติ)',
      );
    }
    // คืนรายการที่ลบจริงกลับไป หน้าเว็บจะได้บอกได้ว่าลบไปกี่ใบ (ลบใบมัดจำ = ใบส่วนที่เหลือหายไปด้วย)
    res.json({ deleted: result.deleted });
  }),
);
