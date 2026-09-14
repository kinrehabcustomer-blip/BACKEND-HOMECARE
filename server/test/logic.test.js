/**
 * เทสตรรกะล้วน — ไม่ต่อฐานข้อมูล ไม่ยิง query สักตัว
 *
 * รันด้วย `npm test` (จาก root หรือจาก server/) — ปลอดภัยเสมอ ใครกดก็ได้
 * ชุดที่ต้องใช้ฐานข้อมูลอยู่แยกที่ api.test.js และต้องสั่งเปิดเองถึงจะทำงาน
 *
 * ครอบเรื่องที่พังได้เงียบๆ และตรวจด้วยตาไม่เจอ: การเทียบเวลาเช็คอิน–เอาท์,
 * สิทธิ์ตามตำแหน่ง, การกันเลื่อนตำแหน่งตัวเอง, และการตัดข้อความ error ดิบ
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/* โหลด .env ถ้ามี แล้วเติมค่าหลอกให้ตัวแปรที่ยังขาด
   โมดูลที่เทสนี้เรียกใช้ (cases/repo.js -> db/index.js, lib/auth.js) โยน error ตั้งแต่ตอน import
   ถ้าไม่มี DATABASE_URL/JWT_SECRET — เติมให้จึงรันได้ทุกเครื่อง แม้เครื่องที่ยังไม่ได้ตั้ง .env
   ค่าหลอกนี้ไม่เคยถูกใช้ต่อ เพราะไม่มี query ไหนถูกยิงในไฟล์นี้ (Pool ของ pg ไม่ต่อจนกว่าจะ query) */
await import('../src/lib/env.js');
process.env.DATABASE_URL ||= 'postgresql://placeholder/placeholder';
process.env.JWT_SECRET ||= 'x'.repeat(48);

const { createCaseSchema, updateCaseSchema, adjustVisitSchema, bulkVisitSchema, visitRangeSchema, createReportSchema, hasReportContent, REPORT_CONTENT_FIELDS } = await import('../src/cases/schema.js');
const { updateInvoiceSchema, paySchema } = await import('../src/invoices/schema.js');
const { createRunSchema } = await import('../src/payroll/schema.js');
const { isCalendarDate } = await import('../src/lib/dates.js');
const { isAllowedHost } = await import('../src/lib/maplink.js');
const { generateTempPassword } = await import('../src/lib/auth.js');
const { checkInSchema } = await import('../src/my/schema.js');
const {
  withVisitState,
  allocateShares,
  weightsFor,
  staffPayUpdateMode,
  assessStaffPayUpdate,
  staffPayUpdateForTransaction,
  payoutCancellationForUpdate,
  assessReleaseCapacity,
  MAX_INSTALLMENTS,
} = await import('../src/cases/repo.js');
const {
  assessInvoiceAction,
  invoiceForUpdate,
  invoicePlanForUpdate,
  invoiceMutationResult,
  assessPaymentCapacity,
  paymentCapacityForUpdate,
  updateInvoiceForTransaction,
  issueInvoiceForTransaction,
  setBillingPlanForTransaction,
  setDepositAmountForTransaction,
  removeInvoiceForTransaction,
} = await import('../src/invoices/repo.js');
const {
  firstAvailablePayrollRound,
  payrollRoundSlotForUpdate,
  payrollRunForRoundSlotUpdate,
  createRunForTransaction,
  assessPayrollRunAction,
  payrollRunForUpdate,
} = await import('../src/payroll/repo.js');
const { firstAvailablePayrollRound: firstAvailablePayrollRoundOnClient } = await import('../../client/src/lib/payrollUi.js');
const { reviewSubmitSchema, REVIEW_QUESTIONS, WANT_AGAIN_OPTIONS, RECOMMEND_OPTIONS } = await import('../src/reviews/schema.js');
const { REVIEW_POSITIONS, perReviewAvg } = await import('../src/reviews/repo.js');
const { THERAPY_POSITIONS } = await import('../src/employees/schema.js');
const { distanceMeters, DEFAULT_GEOFENCE_M } = await import('../src/lib/geo.js');
const { roleForPosition, canSeeStaffPay, requireManager, stripPayFields, BLOCKED_STATUSES } = await import('../src/lib/auth.js');
const { errorHandler, ApiError } = await import('../src/lib/errors.js');
const guards = await import('../src/employees/routes.js');
const caseGuards = await import('../src/cases/routes.js');

// ---------- contract ค่าจ้างของเคส ----------
describe('staff_pay — schema, สิทธิ์ และการคำนวณใหม่ต้องตรงกัน', () => {
  const base = { case_type: 'other', client_name: 'ผู้ป่วยทดสอบ' };

  test('schema เก็บ staff_pay ของ manager ไว้ ไม่ strip ทิ้ง', () => {
    assert.equal(createCaseSchema.parse({ ...base, staff_pay: 1234 }).staff_pay, 1234);
    assert.equal(updateCaseSchema.parse({ staff_pay: 0 }).staff_pay, 0);
    assert.equal(updateCaseSchema.parse({ staff_pay: null }).staff_pay, null);
    assert.equal(createCaseSchema.safeParse({ ...base, staff_pay: -1 }).success, false);
  });

  test('manager ตั้งค่าจ้างได้ แต่ HR ส่งคีย์นี้ตรงเข้า API ไม่ได้', () => {
    assert.doesNotThrow(() => caseGuards.ensureCanSetStaffPay({ user: { position: 'manager' } }, { staff_pay: 9000 }));
    assert.throws(
      () => caseGuards.ensureCanSetStaffPay({ user: { position: 'hr' } }, { staff_pay: 9000 }),
      (error) => error.status === 403,
    );
    assert.doesNotThrow(() => caseGuards.ensureCanSetStaffPay({ user: { position: 'hr' } }, { note: 'แก้หมายเหตุ' }));
  });

  test('ไม่เปลี่ยนบริการและไม่ส่ง staff_pay = รักษาค่าพิเศษเดิม', () => {
    const current = { service_kind: 'homecare', pkg_format_id: 1, pkg_grade_id: 2, pkg_staff_tier: 'NA' };
    assert.equal(staffPayUpdateMode(current, { ...current, note: 'แก้หมายเหตุ' }), 'preserve');
  });

  test('เปลี่ยนบริการโดยไม่ส่ง staff_pay = ดึงค่าจากบริการใหม่', () => {
    const current = { service_kind: 'homecare', pkg_format_id: 1, pkg_grade_id: 2, pkg_staff_tier: 'NA' };
    assert.equal(staffPayUpdateMode(current, { ...current, pkg_staff_tier: 'PN' }), 'service');
    assert.equal(staffPayUpdateMode(current, { service_kind: 'physio', physio_package_id: 5 }), 'service');
  });

  test('ตัวเลขที่ manager ส่งเป็น custom; null หมายถึงกลับไปใช้ค่าบริการ', () => {
    assert.equal(staffPayUpdateMode({}, { staff_pay: 7777 }), 'explicit');
    assert.equal(staffPayUpdateMode({}, { staff_pay: 0 }), 'explicit');
    assert.equal(staffPayUpdateMode({}, { staff_pay: null }), 'service');
  });

  test('ค่าจ้างใหม่ต้องไม่ต่ำกว่ายอดที่ปล่อยแล้ว แต่เท่ากันหรือสูงกว่ายังแก้ได้', () => {
    assert.equal(assessStaffPayUpdate(6999, 7000).reason, 'below_released');
    assert.equal(assessStaffPayUpdate(6999.994, 7000).reason, 'below_released');
    assert.equal(assessStaffPayUpdate(null, 7000).reason, 'below_released');
    assert.deepEqual(assessStaffPayUpdate(7000, 7000), { staff_pay: 7000, released: 7000 });
    assert.deepEqual(assessStaffPayUpdate(6999.996, 7000), { staff_pay: 7000, released: 7000 });
    assert.deepEqual(assessStaffPayUpdate(9000, 7000), { staff_pay: 9000, released: 7000 });
    assert.deepEqual(assessStaffPayUpdate(0, 0), { staff_pay: 0, released: 0 });
    assert.deepEqual(assessStaffPayUpdate(null, 0), { staff_pay: null, released: 0 });
  });

  test('ล็อก case ก่อนอ่าน SUM payouts และหยุดก่อน UPDATE เมื่อยอดใหม่ต่ำเกินไป', async () => {
    const calls = [];
    const tx = {
      one: async (query) => {
        calls.push(query);
        if (query.includes('FOR UPDATE')) {
          return { case_id: 'CASE-0001', staff_pay: 10000, service_kind: 'homecare' };
        }
        if (query.includes('SUM(amount)')) return { released: 7000 };
        throw new Error(`unexpected query: ${query}`);
      },
    };

    await assert.rejects(
      () => staffPayUpdateForTransaction(tx, 'CASE-0001', { staff_pay: 6000 }),
      (error) => error.status === 409,
    );
    assert.match(calls[0], /FOR UPDATE/);
    assert.match(calls[1], /SUM\(amount\)/);
    assert.equal(calls.length, 2);
  });

  test('ไม่เปลี่ยน staff_pay ไม่ต้องอ่าน payouts แต่ยังล็อก case เพื่อเทียบ service ล่าสุด', async () => {
    const calls = [];
    const tx = {
      one: async (query) => {
        calls.push(query);
        return { case_id: 'CASE-0001', staff_pay: 10000, service_kind: 'homecare' };
      },
    };

    const state = await staffPayUpdateForTransaction(tx, 'CASE-0001', { note: 'แก้หมายเหตุ' });
    assert.equal(state.mode, 'preserve');
    assert.equal(state.staff_pay, 10000);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /FOR UPDATE/);
  });

  test('HR เปลี่ยนบริการแล้วค่าจากเรทใหม่ต่ำกว่ายอดที่ปล่อยไปแล้ว = 409', async () => {
    const calls = [];
    const tx = {
      one: async (query) => {
        calls.push(query);
        if (query.includes('FOR UPDATE')) {
          return {
            case_id: 'CASE-0001',
            staff_pay: 10000,
            service_kind: 'homecare',
            pkg_format_id: 1,
            pkg_grade_id: 2,
            pkg_staff_tier: 'NA',
          };
        }
        if (query.includes('FROM pkg_rates')) return { staff_pay: 6000 };
        if (query.includes('SUM(amount)')) return { released: 7000 };
        throw new Error(`unexpected query: ${query}`);
      },
    };

    await assert.rejects(
      () => staffPayUpdateForTransaction(tx, 'CASE-0001', { pkg_staff_tier: 'PN' }),
      (error) => error.status === 409,
    );
    assert.match(calls[0], /FOR UPDATE/);
    assert.match(calls[1], /FROM pkg_rates/);
    assert.match(calls[2], /SUM\(amount\)/);
    assert.equal(calls.length, 3);
  });
});

// ---------- เพดานยอดปล่อยค่าจ้างภายใต้ transaction ----------
describe('assessReleaseCapacity — ห้ามปล่อยค่าจ้างเกินยอดเหมาของเคส', () => {
  test('ไม่ระบุยอด = ใช้ยอดคงเหลือล่าสุด', () => {
    assert.deepEqual(assessReleaseCapacity(20000, 7000, undefined), {
      staff_pay: 20000,
      released: 7000,
      remaining: 13000,
      amount: 13000,
    });
  });

  test('คำขอที่ถือยอดเก่ามาถูกปฏิเสธหลังอีกคำขอปล่อยเงินไปแล้ว', () => {
    assert.deepEqual(assessReleaseCapacity(20000, 15000, 13000), {
      reason: 'amount_exceeds_remaining',
      staff_pay: 20000,
      released: 15000,
      remaining: 5000,
      amount: 13000,
    });
  });

  test('ปล่อยครบแล้ว คำขอถัดไปถูกปฏิเสธ', () => {
    assert.equal(assessReleaseCapacity(20000, 20000, undefined).reason, 'fully_released');
    assert.equal(assessReleaseCapacity(20000, 21000, 1).reason, 'fully_released');
  });

  test('staff_pay ถูกล้างระหว่างทำรายการ = ไม่เขียน payout', () => {
    assert.equal(assessReleaseCapacity(null, 7000, 1000).reason, 'staff_pay_not_set');
  });
});

// ---------- เพดานยอดรับชำระ invoice ภายใต้ transaction ----------
describe('assessPaymentCapacity — ห้ามรับชำระเกินยอดคงเหลือ', () => {
  test('ไม่ระบุยอด = ใช้ยอดคงเหลือล่าสุด', () => {
    assert.deepEqual(assessPaymentCapacity('issued', 20000, 7000, undefined), {
      total: 20000,
      paid: 7000,
      balance: 13000,
      amount: 13000,
    });
  });

  test('คำขอที่ถือ balance เก่ามาถูกปฏิเสธหลังอีกคำขอรับเงินไปแล้ว', () => {
    assert.deepEqual(assessPaymentCapacity('issued', 20000, 15000, 13000), {
      reason: 'amount_exceeds_balance',
      total: 20000,
      paid: 15000,
      balance: 5000,
      amount: 13000,
    });
  });

  test('ใบที่รับครบหรือถูกยกเลิกแล้วรับเพิ่มไม่ได้', () => {
    assert.equal(assessPaymentCapacity('paid', 20000, 20000, undefined).reason, 'fully_paid');
    assert.equal(assessPaymentCapacity('issued', 20000, 21000, 1).reason, 'fully_paid');
    assert.equal(assessPaymentCapacity('cancelled', 20000, 0, 1).reason, 'cancelled');
  });

  test('รับบางส่วนที่ไม่เกินยอดคงเหลือได้', () => {
    assert.equal(assessPaymentCapacity('issued', 20000, 7000, 5000).amount, 5000);
  });

  test('ล็อก invoice ก่อน แล้วจึงอ่าน SUM payments ด้วย statement ถัดไป', async () => {
    const calls = [];
    const tx = {
      one: async (query) => {
        calls.push(query);
        if (query.includes('FOR UPDATE')) {
          return { invoice_id: 'INV-0001', total: 20000, billing_kind: 'full', status: 'issued' };
        }
        if (query.includes('SUM(amount)')) return { paid: 15000 };
        throw new Error(`unexpected query: ${query}`);
      },
    };

    const result = await paymentCapacityForUpdate(tx, 'INV-0001', undefined);
    assert.equal(result.amount, 5000);
    assert.match(calls[0], /FOR UPDATE/);
    assert.match(calls[1], /SUM\(amount\)/);
  });

  test('ไม่พบ invoice แล้วหยุดก่อนอ่านตาราง payments', async () => {
    let queries = 0;
    const result = await paymentCapacityForUpdate(
      { one: async () => ((queries += 1), null) },
      'INV-MISSING',
      100,
    );
    assert.equal(result.reason, 'not_found');
    assert.equal(queries, 1);
  });

  test('ยังไม่เลือกแผนวางบิลแล้วหยุดหลัง lock โดยไม่สร้าง payment', async () => {
    let queries = 0;
    const result = await paymentCapacityForUpdate(
      {
        one: async () => {
          queries += 1;
          return { invoice_id: 'INV-0001', total: 20000, billing_kind: null, status: 'draft' };
        },
      },
      'INV-0001',
      1000,
    );
    assert.equal(result.reason, 'billing_plan_required');
    assert.equal(queries, 1);
  });
});

// ---------- mutation ของ invoice ต้องตัดสินจากข้อมูลหลังได้ row lock ----------
describe('invoice mutations — สถานะ แผน และ payment ต้อง recheck ใน transaction', () => {
  test('state matrix รักษากติกาเดิม และยกเลิกใบ paid ได้แต่แก้/ออกซ้ำไม่ได้', () => {
    for (const status of ['draft', 'issued']) {
      assert.equal(assessInvoiceAction('update', status).reason, undefined);
    }
    assert.equal(assessInvoiceAction('issue', 'draft').reason, undefined);
    assert.equal(assessInvoiceAction('billing_plan', 'draft').reason, undefined);
    assert.equal(assessInvoiceAction('cancel', 'paid').reason, undefined);
    assert.equal(assessInvoiceAction('update', 'paid').reason, 'invalid_status');
    assert.equal(assessInvoiceAction('issue', 'cancelled').reason, 'invalid_status');
    assert.equal(assessInvoiceAction('cancel', 'cancelled').reason, 'invalid_status');
  });

  test('single-row mutation อ่านสถานะล่าสุดด้วย FOR UPDATE ก่อนอนุญาต', async () => {
    const calls = [];
    const result = await invoiceForUpdate(
      {
        one: async (query) => {
          calls.push(query);
          return { invoice_id: 'INV-0001', status: 'paid' };
        },
      },
      'INV-0001',
      'update',
    );
    assert.equal(result.reason, 'invalid_status');
    assert.equal(result.status, 'paid');
    assert.match(calls[0], /FOR UPDATE/);
  });

  test('ใบถูกลบหลัง commit แต่ก่อนโหลด response = คืน conflict ไม่ใช่ null/500', async () => {
    let loads = 0;
    const result = await invoiceMutationResult(
      { invoice_id: 'INV-0001' },
      async () => ((loads += 1), null),
    );
    assert.deepEqual(result, { reason: 'state_changed' });
    assert.equal(loads, 1);

    const conflict = await invoiceMutationResult(
      { reason: 'invalid_status' },
      async () => {
        throw new Error('reason เดิมต้องไม่โหลด DB ซ้ำ');
      },
    );
    assert.equal(conflict.reason, 'invalid_status');
  });

  test('plan mutation ล็อก root ก่อน แล้วค่อยอ่าน children ใหม่ตาม invoice_id', async () => {
    const calls = [];
    const tx = {
      one: async (query, params) => {
        calls.push({ query, params });
        if (query.includes('COALESCE(parent_invoice_id')) {
          return { invoice_id: 'INV-0002', root_id: 'INV-0001' };
        }
        if (query.includes('SELECT * FROM invoices WHERE invoice_id = :root_id')) {
          return { invoice_id: 'INV-0001', parent_invoice_id: null, billing_kind: 'deposit' };
        }
        throw new Error(`unexpected query: ${query}`);
      },
      all: async (query, params) => {
        calls.push({ query, params });
        return [{ invoice_id: 'INV-0002', parent_invoice_id: 'INV-0001', billing_kind: 'balance' }];
      },
    };

    const plan = await invoicePlanForUpdate(tx, 'INV-0002');
    assert.equal(plan.root_id, 'INV-0001');
    assert.equal(plan.target.invoice_id, 'INV-0002');
    assert.match(calls[1].query, /invoice_id = :root_id FOR UPDATE/);
    assert.match(calls[2].query, /ORDER BY invoice_id[\s\S]*FOR UPDATE/);
  });

  test('แก้ยอดหลังมี partial payment แล้วห้ามลด total ต่ำกว่าเงินที่รับจริง', async () => {
    let mutations = 0;
    const result = await updateInvoiceForTransaction(
      {
        one: async (query) => {
          if (query.includes('FROM invoices i')) {
            return {
              invoice_id: 'INV-0001', status: 'issued', billing_kind: 'full', amount: 100, discount: 0,
            };
          }
          if (query.includes('SUM(amount)')) return { paid: 80, last_paid_at: '2026-08-24' };
          throw new Error(`unexpected query: ${query}`);
        },
        run: async () => ((mutations += 1), 1),
      },
      'INV-0001',
      { amount: 70 },
    );
    assert.equal(result.reason, 'amount_below_paid');
    assert.equal(result.paid, 80);
    assert.equal(mutations, 0);
  });

  test('API รับเงินเป็นหน่วยสตางค์เท่านั้น และ total ที่บันทึกตรงกับค่าที่ใช้ตรวจ', async () => {
    assert.equal(updateInvoiceSchema.safeParse({ amount: 0.105 }).success, false);
    assert.equal(paySchema.safeParse({ amount: 0.001 }).success, false);
    assert.equal(updateInvoiceSchema.safeParse({ amount: 0.11 }).success, true);

    let mutation;
    const result = await updateInvoiceForTransaction(
      {
        one: async (query) => {
          if (query.includes('FROM invoices i')) {
            return {
              invoice_id: 'INV-0001', status: 'issued', billing_kind: 'full', amount: 1, discount: 0,
            };
          }
          return { paid: 0.11, last_paid_at: '2026-08-24' };
        },
        run: async (query, params) => {
          mutation = { query, params };
          return 1;
        },
      },
      'INV-0001',
      { amount: 0.105 },
    );
    assert.equal(result.reason, undefined);
    assert.match(mutation.query, /total = :next_total/);
    assert.equal(mutation.params.next_total, 0.11);
    assert.equal(mutation.params.settled, true);
  });

  test('ออกใบไม่ได้หากยังไม่เลือก full/deposit แม้ snapshot ก่อนหน้าเคยอนุญาต', async () => {
    let mutations = 0;
    const result = await issueInvoiceForTransaction(
      {
        one: async () => ({ invoice_id: 'INV-0001', status: 'draft', billing_kind: null }),
        run: async () => ((mutations += 1), 1),
      },
      'INV-0001',
    );
    assert.equal(result.reason, 'billing_plan_required');
    assert.equal(mutations, 0);
  });

  test('คำขอแบ่งงวดที่รอ lock เห็น billing_kind ที่อีกคำขอเพิ่งตั้งและไม่สร้าง child ซ้ำ', async () => {
    let mutations = 0;
    const result = await setBillingPlanForTransaction(
      {
        one: async () => ({ invoice_id: 'INV-0001', status: 'draft', billing_kind: 'deposit' }),
        all: async () => {
          throw new Error('ต้องหยุดก่อนอ่าน children');
        },
        run: async () => ((mutations += 1), 1),
      },
      'INV-0001',
      { mode: 'deposit', deposit_amount: 30 },
      null,
    );
    assert.equal(result.reason, 'billing_plan_already_set');
    assert.equal(mutations, 0);
  });

  test('แก้มัดจำอ่าน payment หลังล็อกใบคู่ และกันยอด balance ต่ำกว่าเงินที่เพิ่งรับ', async () => {
    const calls = [];
    let mutations = 0;
    const tx = {
      one: async (query) => {
        calls.push(query);
        if (query.includes('COALESCE(parent_invoice_id')) {
          return { invoice_id: 'INV-0001', root_id: 'INV-0001' };
        }
        return {
          invoice_id: 'INV-0001', parent_invoice_id: null, billing_kind: 'deposit', status: 'issued', total: 60,
        };
      },
      all: async (query) => {
        calls.push(query);
        if (query.includes('parent_invoice_id = :root_id')) {
          return [{
            invoice_id: 'INV-0002', parent_invoice_id: 'INV-0001', billing_kind: 'balance', status: 'issued', total: 40,
          }];
        }
        if (query.includes('FROM invoice_payments')) {
          return [
            { invoice_id: 'INV-0001', paid: 10, last_paid_at: '2026-08-01' },
            { invoice_id: 'INV-0002', paid: 35, last_paid_at: '2026-08-24' },
          ];
        }
        throw new Error(`unexpected query: ${query}`);
      },
      run: async () => ((mutations += 1), 1),
    };

    const result = await setDepositAmountForTransaction(tx, 'INV-0001', 70);
    assert.equal(result.reason, 'balance_below_paid');
    assert.equal(result.invoice_id, 'INV-0002');
    assert.equal(mutations, 0);
    assert.ok(calls.findIndex((q) => q.includes('FOR UPDATE')) < calls.findIndex((q) => q.includes('FROM invoice_payments')));
  });

  test('รับเงิน commit ก่อนคำขอลบได้ lock แล้ว การลบเห็นยอดใหม่และไม่ยิง DELETE', async () => {
    const calls = [];
    const tx = {
      one: async (query) => {
        calls.push(query);
        if (query.includes('COALESCE(parent_invoice_id')) {
          return { invoice_id: 'INV-0001', root_id: 'INV-0001' };
        }
        return {
          invoice_id: 'INV-0001', parent_invoice_id: null, billing_kind: 'deposit', status: 'issued',
        };
      },
      all: async (query) => {
        calls.push(query);
        if (query.includes('parent_invoice_id = :root_id')) {
          return [{
            invoice_id: 'INV-0002', parent_invoice_id: 'INV-0001', billing_kind: 'balance', status: 'issued',
          }];
        }
        if (query.includes('FROM invoice_payments')) return [{ invoice_id: 'INV-0002', paid: 500 }];
        if (query.includes('DELETE FROM invoices')) throw new Error('ต้องไม่ลบใบที่รับเงินแล้ว');
        throw new Error(`unexpected query: ${query}`);
      },
    };

    const result = await removeInvoiceForTransaction(tx, 'INV-0001');
    assert.equal(result.reason, 'has_payments');
    assert.equal(result.invoice_id, 'INV-0002');
    assert.equal(calls.some((q) => q.includes('DELETE FROM invoices')), false);
    assert.ok(calls.findIndex((q) => q.includes('FOR UPDATE')) < calls.findIndex((q) => q.includes('FROM invoice_payments')));
  });
});

// ---------- สถานะรอบจ่ายต้องตัดสินหลังได้ row lock ----------
describe('payroll run transitions — paid/cancelled ต้องไม่ถูกแก้จาก snapshot เก่า', () => {
  test('ทุกคำสั่งแก้รอบร่างได้ตามกติกา; paid ยกเลิกได้อย่างเดียว; cancelled แตะซ้ำไม่ได้', () => {
    for (const action of ['rebuild', 'remove_item', 'pay', 'cancel', 'remove']) {
      assert.equal(assessPayrollRunAction(action, 'draft').reason, undefined, action);
    }

    assert.equal(assessPayrollRunAction('cancel', 'paid').reason, undefined);
    for (const action of ['rebuild', 'remove_item', 'pay', 'remove']) {
      assert.equal(assessPayrollRunAction(action, 'paid').reason, 'invalid_status', action);
    }
    for (const action of ['rebuild', 'remove_item', 'pay', 'cancel', 'remove']) {
      assert.equal(assessPayrollRunAction(action, 'cancelled').reason, 'invalid_status', action);
    }
  });

  test('อ่านสถานะด้วย SELECT FOR UPDATE และปฏิเสธสถานะล่าสุดก่อน mutation', async () => {
    const calls = [];
    const result = await payrollRunForUpdate(
      {
        one: async (query) => {
          calls.push(query);
          return { run_id: 'PAY-0001', status: 'paid', period_to: '2026-08-15' };
        },
      },
      'PAY-0001',
      'remove',
    );

    assert.equal(result.reason, 'invalid_status');
    assert.equal(result.status, 'paid');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /FOR UPDATE/);
  });

  test('ไม่พบรอบแล้วหยุดหลัง query lock แรก', async () => {
    let queries = 0;
    const result = await payrollRunForUpdate(
      { one: async () => ((queries += 1), null) },
      'PAY-MISSING',
      'pay',
    );
    assert.equal(result.reason, 'not_found');
    assert.equal(queries, 1);
  });

  test('ถอน payout ที่รอบเพิ่งเปลี่ยนเป็น paid ถูกกันหลัง lock และ re-read', async () => {
    const calls = [];
    const tx = {
      one: async (query) => {
        calls.push(query);
        if (query.includes('SELECT p.payout_id, pi.run_id')) return { payout_id: 7, run_id: 'PAY-0001' };
        if (query.includes('FROM payroll_runs') && query.includes('FOR UPDATE')) {
          return { run_id: 'PAY-0001', status: 'paid' };
        }
        if (query.includes('FROM cases') && query.includes('FOR UPDATE')) return { case_id: 'CASE-0001' };
        if (query.includes('FROM case_payouts') && query.includes('FOR UPDATE')) {
          return { payout_id: 7, installment_no: 1, employee_name: 'ทดสอบ', amount: 7000 };
        }
        if (query.includes('SELECT pi.run_id, pr.status')) {
          return { run_id: 'PAY-0001', run_status: 'paid' };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    };

    const result = await payoutCancellationForUpdate(tx, 'CASE-0001', 7);
    assert.equal(result.reason, 'already_paid');
    assert.match(calls[1], /payroll_runs[\s\S]*FOR UPDATE/);
    assert.match(calls[2], /FROM cases[\s\S]*FOR UPDATE/);
    assert.match(calls[3], /FROM case_payouts[\s\S]*FOR UPDATE/);
    assert.equal(calls.length, 5);
  });

  test('binding เปลี่ยนจากไม่มีรอบเป็นมีรอบระหว่างถอน = 409/retry ไม่ไล่ lock กลับลำดับ', async () => {
    const calls = [];
    const tx = {
      one: async (query) => {
        calls.push(query);
        if (query.includes('SELECT p.payout_id, pi.run_id')) return { payout_id: 7, run_id: null };
        if (query.includes('FROM cases') && query.includes('FOR UPDATE')) return { case_id: 'CASE-0001' };
        if (query.includes('FROM case_payouts') && query.includes('FOR UPDATE')) {
          return { payout_id: 7, installment_no: 1, employee_name: 'ทดสอบ', amount: 7000 };
        }
        if (query.includes('SELECT pi.run_id, pr.status')) {
          return { run_id: 'PAY-0002', run_status: 'draft' };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    };

    const result = await payoutCancellationForUpdate(tx, 'CASE-0001', 7);
    assert.equal(result.reason, 'state_changed');
    assert.equal(calls.some((q) => q.includes('FROM payroll_runs') && q.includes('FOR UPDATE')), false);
    assert.equal(calls.length, 4);
  });
});

// ---------- เลขรอบต้องใช้ช่อง active ที่ว่าง และจองการเลือกต่อเดือน ----------
describe('payroll round allocation — ช่องว่างและคำขอพร้อมกันต้องไม่ชนเลขรอบ', () => {
  test('เลือกเลขต่ำสุดที่ว่าง ไม่ใช้ COUNT + 1', () => {
    const scenarios = [
      { active: [], expected: 1 },
      { active: [1], expected: 2 },
      { active: [1, 3], expected: 2 },
      { active: [2, 3], expected: 1 },
      { active: [1, 2, 3], expected: null },
    ];

    for (const { active, expected } of scenarios) {
      assert.equal(firstAvailablePayrollRound(active), expected, `server: ${active}`);
      assert.equal(firstAvailablePayrollRoundOnClient(active), expected, `client: ${active}`);
    }
  });

  test('ล็อกเดือนก่อนอ่านรอบ active และเห็นช่องว่างจากค่าที่อ่านหลัง lock', async () => {
    const calls = [];
    const tx = {
      one: async (query, params) => {
        calls.push({ query, params });
        return { locked: '' };
      },
      all: async (query, params) => {
        calls.push({ query, params });
        return [{ round_no: '1' }, { round_no: '3' }];
      },
    };

    const result = await payrollRoundSlotForUpdate(tx, '2026-08');
    assert.deepEqual(result, {
      period_month: '2026-08',
      round_no: 2,
      active_rounds: [1, 3],
    });
    assert.match(calls[0].query, /pg_advisory_xact_lock/);
    assert.match(calls[1].query, /status <> 'cancelled'/);
    assert.deepEqual(calls.map((call) => call.params), [
      { month: '2026-08' },
      { month: '2026-08' },
    ]);
  });

  test('ครบสามช่องแล้วคืนเหตุผลให้ route ตอบ 409', async () => {
    const result = await payrollRoundSlotForUpdate(
      {
        one: async () => ({ locked: '' }),
        all: async () => [{ round_no: 1 }, { round_no: 2 }, { round_no: 3 }],
      },
      '2026-08',
    );
    assert.deepEqual(result, {
      reason: 'round_limit',
      period_month: '2026-08',
      active_rounds: [1, 2, 3],
    });
  });

  test('เต็มแล้วหยุดก่อนขอ run_id และก่อน INSERT', async () => {
    const calls = [];
    const result = await createRunForTransaction(
      {
        one: async (query) => {
          calls.push(query);
          if (query.includes('pg_advisory_xact_lock')) return { locked: '' };
          throw new Error(`ไม่ควรมาถึง query นี้: ${query}`);
        },
        all: async (query) => {
          calls.push(query);
          return [{ round_no: 1 }, { round_no: 2 }, { round_no: 3 }];
        },
        run: async (query) => {
          throw new Error(`ไม่ควร INSERT เมื่อเต็ม: ${query}`);
        },
      },
      { period_to: '2026-08-31' },
      { employee_id: 'EMP-0001', name: 'ผู้จัดการ' },
    );

    assert.equal(result.reason, 'round_limit');
    assert.equal(calls.length, 2);
    assert.equal(calls.some((query) => query.includes('id_counters')), false);
  });

  test('ช่องกลางว่างแล้ว INSERT ด้วยเลขนั้น ก่อน fill ชุด payout', async () => {
    const calls = [];
    let inserted = null;
    const result = await createRunForTransaction(
      {
        one: async (query) => {
          calls.push(query);
          if (query.includes('pg_advisory_xact_lock')) return { locked: '' };
          if (query.includes('INSERT INTO id_counters')) return { value: 42 };
          throw new Error(`unexpected query: ${query}`);
        },
        all: async (query) => {
          calls.push(query);
          if (query.includes('SELECT round_no FROM payroll_runs')) {
            return [{ round_no: 1 }, { round_no: 3 }];
          }
          if (query.includes('FOR UPDATE OF p')) return [];
          throw new Error(`unexpected query: ${query}`);
        },
        run: async (query, params) => {
          calls.push(query);
          if (!query.includes('INSERT INTO payroll_runs')) throw new Error(`unexpected query: ${query}`);
          inserted = params;
          return 1;
        },
      },
      { period_to: '2026-08-31', note: 'รอบแทนช่องว่าง' },
      { employee_id: 'EMP-0001', name: 'ผู้จัดการ' },
    );

    assert.deepEqual(result, { run_id: 'PAY-0042' });
    assert.equal(inserted.round_no, 2);
    assert.equal(inserted.period_month, '2026-08');
    assert.equal(inserted.note, 'รอบแทนช่องว่าง');
    assert.match(calls.at(-1), /FOR UPDATE OF p/);
  });

  test('ยกเลิก/ลบรอบล็อก month ก่อน row lock เพื่อคืนช่องโดยไม่แข่งกับ create', async () => {
    const calls = [];
    const result = await payrollRunForRoundSlotUpdate(
      {
        one: async (query) => {
          calls.push(query);
          if (query.includes('SELECT period_month FROM payroll_runs')) {
            return { period_month: '2026-08' };
          }
          if (query.includes('pg_advisory_xact_lock')) return { locked: '' };
          if (query.includes('FOR UPDATE')) {
            return {
              run_id: 'PAY-0001',
              period_month: '2026-08',
              period_to: '2026-08-15',
              status: 'draft',
            };
          }
          throw new Error(`unexpected query: ${query}`);
        },
      },
      'PAY-0001',
      'remove',
    );

    assert.equal(result.run.run_id, 'PAY-0001');
    assert.match(calls[0], /SELECT period_month FROM payroll_runs/);
    assert.match(calls[1], /pg_advisory_xact_lock/);
    assert.match(calls[2], /FOR UPDATE/);
  });
});

// ---------- เวลาออกต้องมาหลังเวลาเข้า ----------
describe('adjustVisitSchema — กันเวลาออกมาก่อนเวลาเข้า', () => {
  const iso = (t) => `2026-08-10T${t}+07:00`;

  test('เวลาออกหลังเวลาเข้า = ผ่าน', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_in_at: iso('09:00:00'), check_out_at: iso('17:00:00') }).success, true);
  });

  test('เวลาออกก่อนเวลาเข้า = ถูกปฏิเสธ', () => {
    const r = adjustVisitSchema.safeParse({ check_in_at: iso('17:00:00'), check_out_at: iso('09:00:00') });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /เวลาออกต้องมาหลังเวลาเข้า/);
    assert.deepEqual(r.error.issues[0].path, ['check_out_at']);
  });

  test('เวลาเข้า = เวลาออก (ทำงาน 0 นาที) = ถูกปฏิเสธ', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_in_at: iso('17:13:00'), check_out_at: iso('17:13:00') }).success, false);
  });

  test('ส่งมาช่องเดียว = ผ่านที่ชั้น schema (ชั้น route เทียบกับค่าใน DB ต่อ)', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_out_at: iso('17:00:00') }).success, true);
    assert.equal(adjustVisitSchema.safeParse({ location_flagged: false }).success, true);
  });

  test('ล้างเวลาทิ้ง (null) ยังทำได้', () => {
    assert.equal(adjustVisitSchema.safeParse({ check_in_at: null, check_out_at: null }).success, true);
  });
});

describe('การเทียบเวลาข้ามชนิด (Date object จาก DB กับ ISO string จาก client)', () => {
  test('Date.parse บน object ทิ้งมิลลิวินาที — จึงเทียบพลาดในวินาทีเดียวกัน', () => {
    const fromDb = new Date('2026-08-10T15:47:56.473+07:00');   // pg คืน TIMESTAMPTZ มาเป็น Date
    const fromClient = '2026-08-10T15:47:56.100+07:00';          // จริงๆ แล้ว "ก่อน" ค่าใน DB

    assert.equal(Date.parse(fromClient) <= Date.parse(fromDb), false, 'วิธีเดิมมองว่าเวลาออกมาทีหลัง (พลาด)');
    assert.equal(new Date(fromClient).getTime() <= new Date(fromDb).getTime(), true, 'วิธีที่ใช้จริงจับได้');
  });
});

// ---------- สถานะกะที่คำนวณตอนอ่าน ----------
describe('withVisitState', () => {
  const now = new Date('2026-08-10T12:00:00+07:00');
  const at = (t) => new Date(`2026-08-10T${t}+07:00`);

  test('ยกเลิก มาก่อนทุกอย่าง', () => {
    assert.equal(withVisitState({ status: 'cancelled', check_in_at: at('08:00:00') }, now).state, 'cancelled');
  });
  test('เช็คเอาท์แล้ว = done + นับนาทีถูก', () => {
    const v = withVisitState({ status: 'scheduled', check_in_at: at('08:00:00'), check_out_at: at('11:30:00') }, now);
    assert.equal(v.state, 'done');
    assert.equal(v.worked_minutes, 210);
  });
  test('เช็คอินแล้วยังไม่ออก = working', () => {
    assert.equal(withVisitState({ status: 'scheduled', check_in_at: at('08:00:00') }, now).state, 'working');
  });
  test('ค้างเกิน 16 ชม. = stale', () => {
    assert.equal(withVisitState({ status: 'scheduled', check_in_at: new Date('2026-08-09T10:00:00+07:00') }, now).state, 'stale');
  });
  test('เลยวันแล้วไม่เช็คอิน = missed', () => {
    assert.equal(withVisitState({ status: 'scheduled', visit_date: '2026-08-09' }, now).state, 'missed');
  });
  test('ยังไม่ถึงวัน = scheduled', () => {
    assert.equal(withVisitState({ status: 'scheduled', visit_date: '2026-08-11' }, now).state, 'scheduled');
  });
});

// ---------- สิทธิ์ตามตำแหน่ง ----------
describe('สิทธิ์ตามตำแหน่ง', () => {
  test('manager/hr = admin · ที่เหลือ = field', () => {
    assert.equal(roleForPosition('manager'), 'admin');
    assert.equal(roleForPosition('hr'), 'admin');
    for (const p of ['caregiver', 'assistant_nurse', 'practical_nurse', 'nurse', 'therapist']) {
      assert.equal(roleForPosition(p), 'field');
    }
  });

  test('เห็นค่าจ้าง/กำไร = manager เท่านั้น (แคบกว่า admin)', () => {
    assert.equal(canSeeStaffPay('manager'), true);
    assert.equal(canSeeStaffPay('hr'), false);
    assert.equal(canSeeStaffPay('nurse'), false);
    assert.equal(canSeeStaffPay(undefined), false);
  });

  test('ด่าน manager-only ให้ผู้จัดการผ่าน แต่กัน HR/field และคนที่ยังไม่ login', () => {
    const check = (user) => {
      let result = { called: false, error: null };
      requireManager({ user }, {}, (error) => {
        result = { called: true, error: error ?? null };
      });
      return result;
    };

    assert.deepEqual(check({ position: 'manager' }), { called: true, error: null });
    assert.equal(check({ position: 'hr' }).error.status, 403);
    assert.equal(check({ position: 'nurse' }).error.status, 403);
    assert.equal(check(undefined).error.status, 401);
  });

  test('stripPayFields ตัด staff_pay/margin/staff_share ทิ้ง แต่คงราคาลูกค้าไว้', () => {
    assert.deepEqual(
      stripPayFields({ customer_price: 15000, staff_pay: 9000, margin: 40, staff_share: 60, name: 'x' }),
      { customer_price: 15000, name: 'x' },
    );
  });

  test('BLOCKED_STATUSES ครอบ resigned/suspended และไม่บล็อกสถานะที่ยังทำงานอยู่', () => {
    assert.ok(BLOCKED_STATUSES.resigned);
    assert.ok(BLOCKED_STATUSES.suspended);
    for (const ok of ['active', 'probation', 'on_leave']) {
      assert.equal(BLOCKED_STATUSES[ok], undefined, `${ok} ต้องไม่ถูกบล็อก`);
    }
  });
});

// ---------- กันเลื่อนตำแหน่ง ----------
describe('ตัวกันเลื่อนตำแหน่ง (employees)', () => {
  const asHr = { user: { employee_id: 'EMP-0007', position: 'hr' } };
  const asManager = { user: { employee_id: 'EMP-0001', position: 'manager' } };
  const someone = { employee_id: 'EMP-0003', position: 'caregiver' };

  test('HR ตั้งตำแหน่ง manager ให้คนอื่นไม่ได้', () => {
    assert.throws(() => guards.ensureCanGrantManager(asHr, 'manager'), (e) => e.status === 403);
  });
  test('HR ตั้งตำแหน่งอื่นให้คนอื่นได้ตามปกติ', () => {
    assert.doesNotThrow(() => guards.ensureCanGrantManager(asHr, 'nurse'));
    assert.doesNotThrow(() => guards.ensureCanGrantManager(asHr, undefined));
  });
  test('ผู้จัดการตั้งตำแหน่ง manager ได้', () => {
    assert.doesNotThrow(() => guards.ensureCanGrantManager(asManager, 'manager'));
  });
  test('แก้ตำแหน่งของตัวเองไม่ได้ แม้เป็นผู้จัดการ', async () => {
    await assert.rejects(
      guards.ensurePositionChangeAllowed(asManager, { employee_id: 'EMP-0001', position: 'manager' }, 'hr'),
      (e) => e.status === 403,
    );
  });
  test('HR ยิงเลื่อนตัวเองเป็น manager = ถูกปฏิเสธ (ทางที่เคยหลุด)', async () => {
    await assert.rejects(
      guards.ensurePositionChangeAllowed(asHr, { employee_id: 'EMP-0007', position: 'hr' }, 'manager'),
      (e) => e.status === 403,
    );
  });
  test('ตำแหน่งไม่เปลี่ยน = ผ่านทันที ไม่ต้องแตะ DB', async () => {
    await guards.ensurePositionChangeAllowed(asHr, someone, 'caregiver');
    await guards.ensurePositionChangeAllowed(asHr, someone, undefined);
  });
});

// ---------- ข้อความ error ดิบ ----------
describe('errorHandler — technical เห็นเฉพาะ admin', () => {
  const fakeRes = () => {
    const r = { code: null, body: null };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };
  const req = (role) => ({ method: 'GET', originalUrl: '/api/x', user: role ? { role } : undefined });

  test('admin ได้ข้อความดิบไปส่งต่อให้คนแก้', () => {
    const res = fakeRes();
    errorHandler(new Error('column "foo" does not exist'), req('admin'), res, () => {});
    assert.equal(res.code, 500);
    assert.match(res.body.technical, /column "foo"/);
  });
  test('พนักงานภาคสนามไม่ได้ข้อความดิบ', () => {
    const res = fakeRes();
    errorHandler(new Error('column "foo" does not exist'), req('field'), res, () => {});
    assert.equal(res.code, 500);
    assert.equal(res.body.technical, undefined);
    assert.equal(res.body.error, 'เกิดข้อผิดพลาดภายในระบบ');
  });
  test('ยังไม่ผ่าน login ก็ไม่ได้ข้อความดิบ', () => {
    const res = fakeRes();
    errorHandler(new Error('boom'), req(null), res, () => {});
    assert.equal(res.body.technical, undefined);
  });
  test('ApiError ยังตอบ status/ข้อความของตัวเองตามเดิม', () => {
    const res = fakeRes();
    errorHandler(new ApiError(409, 'ซ้ำ'), req('admin'), res, () => {});
    assert.equal(res.code, 409);
    assert.equal(res.body.error, 'ซ้ำ');
  });
});

// ---------- ลงกะหลายวัน ----------
describe('bulkVisitSchema / visitRangeSchema', () => {
  test('วันซ้ำถูกรวบและเรียงให้', () => {
    assert.deepEqual(
      bulkVisitSchema.parse({ dates: ['2026-08-03', '2026-08-01', '2026-08-03'] }).dates,
      ['2026-08-01', '2026-08-03'],
    );
  });
  test('ช่วงวัน + วันในสัปดาห์ (จ–ศ)', () => {
    const r = bulkVisitSchema.parse({ from: '2026-08-03', to: '2026-08-09', weekdays: [1, 2, 3, 4, 5] });
    assert.equal(r.dates.length, 5);
    assert.equal(r.dates[0], '2026-08-03');
    assert.equal(r.dates.at(-1), '2026-08-07');
  });
  test('วันสิ้นสุดมาก่อนวันเริ่ม = ปฏิเสธ', () => {
    assert.equal(bulkVisitSchema.safeParse({ from: '2026-08-09', to: '2026-08-01' }).success, false);
  });
  test('เกิน 200 กะต่อครั้ง = ปฏิเสธ (กันกรอกปีผิด)', () => {
    assert.equal(bulkVisitSchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success, false);
  });
  test('ไม่ระบุวันเลย = ปฏิเสธ', () => {
    assert.equal(bulkVisitSchema.safeParse({}).success, false);
  });
  test('ลบเป็นช่วงต้องมีทั้ง from และ to', () => {
    assert.equal(visitRangeSchema.safeParse({ from: '2026-08-01' }).success, false);
    assert.equal(visitRangeSchema.safeParse({ from: '2026-08-01', to: '2026-08-02' }).success, true);
  });
});

// ---------- geofence ----------
describe('geofence', () => {
  test('จุดเดียวกัน = 0 เมตร', () => {
    assert.equal(distanceMeters(13.7563, 100.5018, 13.7563, 100.5018), 0);
  });
  test('ระยะ ~1 กม. คำนวณได้ใกล้เคียง', () => {
    const d = distanceMeters(13.7563, 100.5018, 13.7653, 100.5018);
    assert.ok(d > 980 && d < 1020, `ได้ ${d} เมตร`);
  });
  test('รัศมีปริยาย 200 เมตร', () => {
    assert.equal(DEFAULT_GEOFENCE_M, 200);
  });
});

// ---------- รายงานอาการผู้ป่วย ----------
describe('createReportSchema — รายงานว่างเปล่าต้องบันทึกไม่ได้', () => {
  test('กรอกช่องเดียวก็พอ (วัดไม่ครบเป็นเรื่องปกติหน้างาน)', () => {
    assert.equal(createReportSchema.safeParse({ pulse: 78 }).success, true);
    assert.equal(createReportSchema.safeParse({ symptoms: 'มีไข้ต่ำๆ' }).success, true);
  });

  test('มีแต่วันที่/เวลา = ปฏิเสธ (แถวที่บอกว่ามีการบันทึกทั้งที่ไม่มีอะไรให้อ่าน)', () => {
    const r = createReportSchema.safeParse({ report_date: '2026-08-18', report_time: '09:00' });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /อย่างน้อยหนึ่งช่อง/);
  });

  test('ข้อความที่มีแต่ช่องว่าง ไม่นับว่ากรอกแล้ว', () => {
    assert.equal(createReportSchema.safeParse({ symptoms: '   ' }).success, false);
  });

  test('0 นับว่ากรอกแล้ว — ความเจ็บปวดระดับ 0 คือคำตอบ ไม่ใช่ช่องว่าง', () => {
    assert.equal(createReportSchema.safeParse({ pain_score: 0 }).success, true);
  });

  test('ค่าเกินช่วงต้องบอกได้ว่าผิดช่องไหน (ไม่ปล่อยไปตายที่ CHECK ของฐานข้อมูล)', () => {
    const r = createReportSchema.safeParse({ pulse: 780 });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['pulse']);
    assert.match(r.error.issues[0].message, /20–250/);
  });

  test('อุณหภูมิมีทศนิยมได้ แต่ชีพจรต้องเป็นจำนวนเต็ม', () => {
    assert.equal(createReportSchema.safeParse({ temperature_c: 36.8 }).success, true);
    assert.equal(createReportSchema.safeParse({ pulse: 78.5 }).success, false);
  });
});

describe('hasReportContent — ตอนแก้ต้องตรวจกับผลลัพธ์หลังรวมของเดิม', () => {
  const saved = { pulse: 78, symptoms: 'มีไข้' };

  test('ล้างข้อความทิ้งแต่ยังเหลือสัญญาณชีพ = ยังบันทึกได้', () => {
    assert.equal(hasReportContent({ ...saved, symptoms: null }), true);
  });

  test('ล้างจนไม่เหลืออะไรเลย = ต้องกันไว้ (zod มองไม่เห็นเพราะส่งมาช่องเดียว)', () => {
    assert.equal(hasReportContent({ ...saved, symptoms: null, pulse: null }), false);
  });
});

// ---------- แบบบันทึกการดูแลประจำวัน ----------
describe('createReportSchema — ฟอร์มเต็มของเคสดูแลต่อเนื่อง', () => {
  test('บันทึกที่มีแต่ช่องติ๊ก (ไม่มีตัวเลข/ข้อความ) ก็เป็นรายงานที่สมบูรณ์', () => {
    const r = createReportSchema.safeParse({ adl_bath: true, positioning_count: 6, shift: 'day' });
    assert.equal(r.success, true);
  });

  test('"ไม่ได้ทำ" (false) นับเป็นเนื้อหา — เป็นคำตอบ ไม่ใช่ช่องว่าง', () => {
    assert.equal(createReportSchema.safeParse({ adl_bath: false }).success, true);
  });

  test('มีแต่ช่องกำกับ (เวร/ประเภทรายงาน) = ยังไม่ได้บันทึกอะไร', () => {
    const r = createReportSchema.safeParse({ shift: 'night', report_type: 'routine' });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /อย่างน้อยหนึ่งช่อง/);
  });

  test('ตัวเลือกนอกรายการถูกปฏิเสธพร้อมบอกชื่อช่อง (ไม่หลุดไปชน CHECK ของฐานข้อมูล)', () => {
    const r = createReportSchema.safeParse({ sputum_color: 'ม่วง' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['sputum_color']);
    assert.match(r.error.issues[0].message, /สีเสมหะ/);
  });

  test('เหตุการณ์ผิดปกติเลือกได้หลายข้อพร้อมกัน', () => {
    const r = createReportSchema.safeParse({ incident_types: ['fall', 'bleeding'], incident_detail: 'ล้มข้างเตียง' });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.incident_types, ['fall', 'bleeding']);
  });

  test('ปริมาณติดลบถูกปฏิเสธ (ปัสสาวะ -50 ml ไม่มีทางเป็นของจริง)', () => {
    assert.equal(createReportSchema.safeParse({ urine_ml: -50 }).success, false);
  });

  test('Bristol scale รับเฉพาะ 1–7', () => {
    assert.equal(createReportSchema.safeParse({ stool_scale: 4 }).success, true);
    assert.equal(createReportSchema.safeParse({ stool_scale: 8 }).success, false);
  });
});

describe('createReportSchema — ฟอร์มกายภาพบำบัด', () => {
  test('ปวดก่อน/หลังเป็นคนละช่อง — คู่นี้คือผลของการรักษาครั้งนั้น ไม่ใช่ค่าเดียวทับกัน', () => {
    const r = createReportSchema.safeParse({ pain_score: 7, post_pain_score: 3 });
    assert.equal(r.success, true);
    assert.equal(r.data.pain_score, 7);
    assert.equal(r.data.post_pain_score, 3);
  });

  test('หัตถการเลือกได้หลายอย่างในครั้งเดียว (ยืด + ฝึกเดิน + ประคบร้อน เป็นเรื่องปกติ)', () => {
    const r = createReportSchema.safeParse({ physio_treatments: ['rom', 'gait', 'heat_cold'] });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.physio_treatments, ['rom', 'gait', 'heat_cold']);
  });

  test('ระดับการช่วยเหลือนอกรายการถูกปฏิเสธพร้อมบอกชื่อช่อง', () => {
    const r = createReportSchema.safeParse({ assist_level: 'ช่วยนิดหน่อย' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['assist_level']);
    assert.match(r.error.issues[0].message, /ระดับการช่วยเหลือ/);
  });

  test('สัญญาณชีพหลังทำใช้ช่วงเดียวกับก่อนทำ — ไม่งั้นค่าคู่กันจะเทียบกันไม่ได้', () => {
    for (const [pre, post] of [
      ['bp_systolic', 'post_bp_systolic'],
      ['bp_diastolic', 'post_bp_diastolic'],
      ['pulse', 'post_pulse'],
      ['spo2', 'post_spo2'],
      ['pain_score', 'post_pain_score'],
    ]) {
      for (const value of [-1, 1000]) {
        assert.equal(
          createReportSchema.safeParse({ [pre]: value }).success,
          createReportSchema.safeParse({ [post]: value }).success,
          `${pre} กับ ${post} รับค่าไม่เท่ากันที่ ${value}`,
        );
      }
    }
  });

  test('บันทึกที่มีแต่หัตถการกับระยะเวลา ก็เป็นรายงานที่สมบูรณ์', () => {
    assert.equal(createReportSchema.safeParse({ physio_treatments: ['rom'], rehab_minutes: 45 }).success, true);
  });
});

/* นิยามฟอร์มอยู่ฝั่งหน้าเว็บ (client/src/lib/dailyCare.js) ส่วนกฎการรับค่าอยู่ฝั่งนี้
   พิมพ์ชื่อช่องผิดที่ฝั่งใดฝั่งหนึ่ง = ช่องนั้นกรอกได้บนหน้าจอแต่หายไปเงียบๆ ตอนบันทึก
   ไม่มี error ให้เห็นเลยเพราะ zod ตัดคีย์ที่ไม่รู้จักทิ้ง — จับด้วยตาไม่ได้ ต้องให้เทสจับ */
describe('นิยามฟอร์มฝั่งหน้าเว็บต้องตรงกับ schema ฝั่ง server', () => {
  test('ทุกช่องในฟอร์มดูแลประจำวันและฟอร์มกายภาพ มีอยู่จริงใน createReportSchema', async () => {
    const { DAILY_SECTIONS, PHYSIO_SECTIONS } = await import('../../client/src/lib/dailyCare.js');
    const known = new Set([...REPORT_CONTENT_FIELDS, 'visit_id', 'report_date', 'report_time', 'shift', 'report_type']);

    for (const [name, sections] of [['ดูแลประจำวัน', DAILY_SECTIONS], ['กายภาพบำบัด', PHYSIO_SECTIONS]]) {
      for (const s of sections) {
        for (const f of s.fields) {
          assert.equal(known.has(f.key), true, `ฟอร์ม${name} มีช่อง ${f.key} ที่ schema ฝั่ง server ไม่รู้จัก`);
        }
      }
    }
  });

  test('ตัวเลือกของช่องแบบเลือกหนึ่ง ต้องเป็นค่าที่ schema ยอมรับ (ไม่หลุดไปชน CHECK ของฐานข้อมูล)', async () => {
    const { DAILY_SECTIONS, PHYSIO_SECTIONS } = await import('../../client/src/lib/dailyCare.js');

    for (const sections of [DAILY_SECTIONS, PHYSIO_SECTIONS]) {
      for (const s of sections) {
        for (const f of s.fields) {
          if (f.type !== 'choice') continue;
          for (const o of f.options) {
            assert.equal(
              // pulse เป็นตัวประกอบให้ใบไม่ว่าง (ช่องกำกับอย่าง shift อยู่คนเดียวจะถูกปฏิเสธเพราะใบเปล่า ไม่ใช่เพราะตัวเลือกผิด)
              createReportSchema.safeParse({ [f.key]: o.value, pulse: 80 }).success,
              true,
              `ช่อง ${f.key} มีตัวเลือก "${o.value}" ที่ schema ปฏิเสธ`,
            );
          }
        }
      }
    }
  });
});

describe('REPORT_CONTENT_FIELDS — เส้นแบ่ง "เนื้อหา" กับ "ข้อมูลกำกับ"', () => {
  test('ช่องกำกับต้องไม่ถูกนับเป็นเนื้อหา ไม่งั้นใบเปล่าจะผ่านไปได้', () => {
    for (const meta of ['visit_id', 'report_date', 'report_time', 'shift', 'report_type']) {
      assert.equal(REPORT_CONTENT_FIELDS.includes(meta), false, `${meta} ไม่ควรเป็นเนื้อหา`);
    }
  });

  test('ครอบทุกหมวดของฟอร์มเต็ม (สัญญาณชีพ ทางเดินหายใจ อาหาร ขับถ่าย ADL แผล อุปกรณ์ เหตุการณ์)', () => {
    for (const f of ['pulse', 'suction_status', 'feed_volume_ml', 'urine_ml', 'adl_bath', 'pressure_sore', 'dev_ng', 'incident_types']) {
      assert.equal(REPORT_CONTENT_FIELDS.includes(f), true, `${f} หายไปจากรายการเนื้อหา`);
    }
  });
});

describe('createRunSchema — รอบจ่ายค่าตอบแทน', () => {
  test('กรอกแค่วันตัดรอบก็เปิดรอบได้', () => {
    assert.equal(createRunSchema.safeParse({ period_to: '2026-08-31' }).success, true);
  });

  test('ไม่มีวันตัดรอบ = เปิดไม่ได้ — เป็นข้อมูลชิ้นเดียวที่รอบต้องมี', () => {
    assert.equal(createRunSchema.safeParse({}).success, false);
  });

  test('รูปแบบวันที่ผิดถูกปฏิเสธพร้อมบอกชื่อช่อง', () => {
    const r = createRunSchema.safeParse({ period_to: '2026-8-1' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['period_to']);
  });

  /* เดือนกับเลขรอบเป็นของที่ระบบตั้งเองจากวันตัดรอบ (ดู createRun) — ส่งมาก็ต้องไม่มีผล
     ถ้าวันหนึ่งมีใครเผลอเปิดช่องพวกนี้ให้กรอกอีก ป้ายชื่อรอบจะหลุดจากสิ่งที่รอบกวาดมาจริงทันที */
  test('เดือน/รอบที่ ที่ส่งมาเองถูกตัดทิ้ง ไม่ใช้เป็นค่าของรอบ', () => {
    const r = createRunSchema.parse({ period_to: '2026-08-31', period_month: '2026-01', round_no: 9 });
    assert.deepEqual(Object.keys(r).filter((k) => r[k] !== undefined), ['period_to']);
  });

  test('วันตัดรอบข้ามเดือนได้ — รอบกวาดกะตกค้างจากเดือนก่อนมาด้วยตามนิยาม', () => {
    assert.equal(createRunSchema.safeParse({ period_to: '2026-09-05' }).success, true);
  });
});

describe('checkInSchema — เช็คอินต้องมีรูปเซลฟี่', () => {
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=';

  /* รูปคือหลักฐานชิ้นเดียวที่พนักงานคุมเองได้และปลอมยากกว่าพิกัด — ถ้าเผลอเปิดให้เว้นว่างอีก
     กะที่น่าสงสัยจะเหลือแค่ GPS ให้ตรวจ ซึ่งคลาดเองได้หลายสิบเมตรจนธงนอกพื้นที่ไม่มีความหมาย */
  test('ไม่ส่งรูปมา = เช็คอินไม่ได้ พร้อมบอกว่าต้องทำอะไร', () => {
    const r = checkInSchema.safeParse({ lat: 13.7, lng: 100.5 });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues.at(-1).path, ['photo']);
    assert.match(r.error.issues.at(-1).message, /ถ่ายรูป/);
  });

  test('ส่ง null มาก็ไม่ผ่าน (ค่าว่างที่ตั้งใจ ไม่ใช่ข้อยกเว้น)', () => {
    assert.equal(checkInSchema.safeParse({ photo: null }).success, false);
  });

  test('ไฟล์ที่ไม่ใช่รูปถูกปฏิเสธด้วยข้อความคนละอันกับตอนไม่ส่งรูป', () => {
    const r = checkInSchema.safeParse({ photo: 'data:text/plain;base64,aGVsbG8=' });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /รูปภาพ/);
  });

  /* GPS ไม่บังคับโดยตั้งใจ — พนักงานคุมกล้องได้ แต่คุมสัญญาณ/สิทธิ์ตำแหน่งไม่ได้
     บล็อกเพราะ GPS = กันคนที่ไปทำงานจริงออกจากระบบ (กะแบบนั้นถูกติดธงให้ตรวจแทนอยู่แล้ว) */
  test('มีรูปแต่ไม่มีพิกัด = ยังเช็คอินได้', () => {
    assert.equal(checkInSchema.safeParse({ photo }).success, true);
  });
});

// ---------- แบ่งค่าจ้างของงวดให้ผู้รับ ----------
describe('allocateShares — เคสที่มีพนักงานคนเดียว', () => {
  /* เคสตัวอย่างของกติกานี้: ยอดเหมา 20,000 ตกลงจ่ายสองงวด 7,000 แล้ว 13,000
     ผู้รับคนเดียวจึงต้องได้เต็มยอดของงวดนั้นเป๊ะ ไม่ใช่ตัวเลขที่ถูกเกลี่ยจนเพี้ยน */
  test('ได้เต็มยอดของงวด', () => {
    const rows = allocateShares([{ employee_id: 'EMP-0001', shifts: 8, paid: 0 }], 7000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 7000);
  });

  test('งวดที่สองก็ยังได้เต็ม — ของที่ได้ไปแล้วไม่ถูกหักซ้ำ', () => {
    const rows = allocateShares([{ employee_id: 'EMP-0001', shifts: 10, paid: 7000 }], 13000);
    assert.equal(rows[0].amount, 13000);
  });

  /* กะไม่ใช่ประตูของเงินอีกแล้ว — คนที่ยังไม่เคยเช็คอินเลยก็รับค่าจ้างของเคสได้
     (พนักงานลืมเช็คอินทั้งเคสเกิดขึ้นจริง และไม่ควรแปลว่าเขาทำงานฟรี)
     สิ่งเดียวที่ทำให้แบ่งไม่ได้คือ "ไม่มีใครอยู่ในเคสเลย" ซึ่งแปลว่าไม่รู้จะจ่ายให้ใคร */
  test('ยังไม่เคยเช็คอินเลยก็ยังได้เต็มยอดของงวด', () => {
    const rows = allocateShares([{ employee_id: 'A', shifts: 0, paid: 0 }], 5000);
    assert.equal(rows[0].amount, 5000);
  });

  test('ไม่มีใครอยู่ในเคสเลย = ไม่แบ่งให้ใคร ไม่ใช่ NaN จากการหารศูนย์', () => {
    assert.deepEqual(allocateShares([], 5000), []);
  });

  test('ข้อมูลอื่นของผู้รับติดไปด้วย — ตอนบันทึกต้องรู้ชื่อและนาทีที่ทำ', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', employee_name: 'สมชาย', shifts: 2, minutes: 480, paid: 0 }],
      1000,
    );
    assert.equal(rows[0].employee_name, 'สมชาย');
    assert.equal(rows[0].minutes, 480);
  });
});

describe('allocateShares — เคสที่มีพนักงานหลายคน (ค่าปริยาย: หารเท่ากัน)', () => {
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const of = (rows, id) => rows.find((r) => r.employee_id === id).amount;

  /* หัวใจของกติกา: หารเท่ากันตามหัว ไม่ใช่ตามจำนวนกะ — คนที่ไปน้อยครั้งอาจรับกะที่หนักกว่า
     และเรื่องพวกนี้ตกลงกันด้วยปากเปล่า ไม่ได้อยู่ในตารางกะ ถ้าจะแบ่งไม่เท่ากันต้องเป็นการตัดสินใจ
     ของคน (ตั้งข้อตกลง) ไม่ใช่ผลข้างเคียงของตัวเลขที่ระบบบังเอิญมี */
  test('สองคน = คนละครึ่ง แม้จำนวนกะจะต่างกันมาก', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 8, paid: 0 }, { employee_id: 'B', shifts: 2, paid: 0 }],
      15000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [7500, 7500]);
  });

  test('สามคน = หารสาม', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 4, paid: 0 },
        { employee_id: 'B', shifts: 3, paid: 0 },
        { employee_id: 'C', shifts: 1, paid: 0 },
      ],
      15000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [5000, 5000, 5000]);
  });

  /* นับหัวจาก "ใครอยู่ในเคส" ไม่ใช่ "ใครมีกะที่ยืนยันแล้ว" — ถ้าจะไม่ให้ใครสักคน
     ต้องเป็นการตัดสินใจของผู้จัดการ (ตั้งส่วนแบ่งเป็น 0) ไม่ใช่ผลข้างเคียงของตารางกะ */
  test('คนที่ยังไม่เคยเช็คอินก็ถูกนับเป็นหัวในการหาร', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 0 }, { employee_id: 'B', shifts: 0, paid: 0 }],
      10000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [5000, 5000]);
  });

  /* งวดแรกถูกปล่อยตอนที่อีกคนยังไม่มีกะที่อนุมัติ ถ้าแบ่งเฉพาะเงินของงวดนั้น คนที่มาทีหลัง
     จะเสียส่วนแบ่งถาวรทั้งที่ตกลงกันว่าคนละครึ่ง — งวดหลังต้องแก้ความเอียงนั้นให้เอง */
  test('งวดหลังไล่ชดเชยงวดก่อน — จบเคสแล้วได้คนละครึ่งตามที่ตกลง', () => {
    // งวดที่ 1: ปล่อย 7,000 ตอนที่เคสยังมีชื่อ A คนเดียว (B เพิ่งมาเสริมทีหลัง)
    const first = allocateShares([{ employee_id: 'A', shifts: 5, paid: 0 }], 7000);
    assert.equal(of(first, 'A'), 7000);

    // งวดที่ 2: ปล่อย 8,000 ที่เหลือ ตอนที่ทั้งคู่พร้อมแล้ว
    const second = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 7000 }, { employee_id: 'B', shifts: 5, paid: 0 }],
      8000,
    );
    assert.equal(of(second, 'A'), 500);
    assert.equal(of(second, 'B'), 7500);
    assert.equal(7000 + of(second, 'A'), 7500);
  });

  /* ได้เกินส่วนของตัวเองไปแล้วเรียกคืนไม่ได้ (เงินออกไปแล้ว) ทำได้แค่หยุดจ่ายเพิ่มจนคนอื่นไล่ทัน
     ถ้าปล่อยให้ส่วนที่ขาดติดลบไปหารต่อ คนที่ยังไม่ได้เงินจะได้ยอดติดลบ ซึ่งลงฐานข้อมูลไม่ได้ */
  test('คนที่ได้ล่วงหน้าเกินส่วนของตัวเองแล้ว ได้ 0 ในงวดนี้ ไม่ใช่ยอดติดลบ', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 9000 }, { employee_id: 'B', shifts: 5, paid: 0 }],
      6000,
    );
    assert.equal(of(rows, 'A'), 0);
    assert.equal(of(rows, 'B'), 6000);
    assert.equal(sum(rows), 6000);
  });

  test('ยอดไม่พอให้ทุกคนถึงส่วนของตัวเอง = คนที่ยังขาดโดนหารลดตามส่วน ไม่ใช่คนแรกได้ก่อนจนหมด', () => {
    const rows = allocateShares(
      [{ employee_id: 'A', shifts: 5, paid: 0 }, { employee_id: 'B', shifts: 5, paid: 0 }],
      1000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [500, 500]);
  });

  /* จุดที่พังเงียบที่สุดของการแบ่งเงิน: 20,000 ÷ 3 = 6,666.666… ถ้าให้ทุกคนปัดเอง
     ผลรวมจะเป็น 20,000.01 คือจ่ายเกินที่ตกลงไปหนึ่งสตางค์ทุกครั้งที่แบ่งไม่ลงตัว */
  test('เศษการปัดตกที่คนสุดท้ายที่มีส่วนได้ — ผลรวมเท่ากับยอดของงวดเป๊ะ', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 1, paid: 0 },
        { employee_id: 'B', shifts: 1, paid: 0 },
        { employee_id: 'C', shifts: 1, paid: 0 },
      ],
      20000,
    );
    assert.equal(sum(rows), 20000);
    assert.deepEqual(rows.map((r) => r.amount), [6666.67, 6666.67, 6666.66]);
  });

  /* แถวสุดท้ายอาจเป็นคนที่ไม่ได้ส่วนแบ่งในงวดนี้ (ตกลงกันว่าไม่รับ) — โยนเศษให้เขา
     คือสร้างก้อนเงิน 1 สตางค์ที่อธิบายไม่ได้ และทำให้คนที่ควรได้ ได้ไม่ครบ */
  test('เศษไม่ตกใส่คนที่ตกลงว่าไม่รับ', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 1, paid: 0, share: 1 },
        { employee_id: 'B', shifts: 1, paid: 0, share: 1 },
        { employee_id: 'ZERO', shifts: 0, paid: 0, share: 0 },
      ],
      10000.01,
    );
    assert.equal(of(rows, 'ZERO'), 0);
    assert.equal(sum(rows), 10000.01);
  });

  test('จ่ายครบทุกงวดแล้ว ทุกคนได้เท่ากันพอดี ไม่ว่าจะซอยงวดยังไง', () => {
    const people = [{ employee_id: 'A', shifts: 7 }, { employee_id: 'B', shifts: 3 }, { employee_id: 'C', shifts: 5 }];
    const paid = { A: 0, B: 0, C: 0 };

    for (const amount of [4000, 5500.25, 5499.75]) {
      const rows = allocateShares(people.map((p) => ({ ...p, paid: paid[p.employee_id] })), amount);
      assert.equal(sum(rows), amount);
      for (const r of rows) paid[r.employee_id] = Math.round((paid[r.employee_id] + r.amount) * 100) / 100;
    }

    assert.equal(Math.round((paid.A + paid.B + paid.C) * 100) / 100, 15000);
    for (const p of people) assert.ok(Math.abs(paid[p.employee_id] - 5000) < 0.02);
  });
});

describe('allocateShares — เคสที่ตกลงส่วนแบ่งกันไว้เป็นพิเศษ', () => {
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const of = (rows, id) => rows.find((r) => r.employee_id === id).amount;

  /* เคสตัวอย่างของกติกานี้: ค่าจ้าง 15,000 ที่ปกติหารครึ่ง (คนละ 7,500) แต่ตกลงกันแล้วว่า
     คนที่ลงแรงมากกว่ารับ 9,000 อีกคนรับ 6,000 — ข้อตกลงเป็นของทั้งเคส ไม่ใช่ของงวดใดงวดหนึ่ง */
  test('ทุกงวดแบ่งตามสัดส่วนที่ตกลง แล้วจบเคสได้ตรงตามที่ตกลงพอดี', () => {
    const first = allocateShares(
      [
        { employee_id: 'A', shifts: 6, paid: 0, share: 9000 },
        { employee_id: 'B', shifts: 4, paid: 0, share: 6000 },
      ],
      7000,
    );
    assert.deepEqual(first.map((r) => r.amount), [4200, 2800]); // 60:40 ของงวดนี้

    const second = allocateShares(
      [
        { employee_id: 'A', shifts: 6, paid: 4200, share: 9000 },
        { employee_id: 'B', shifts: 4, paid: 2800, share: 6000 },
      ],
      8000,
    );
    assert.equal(4200 + of(second, 'A'), 9000);
    assert.equal(2800 + of(second, 'B'), 6000);
  });

  test('ข้อตกลงชนะจำนวนกะ — คนที่ทำกะน้อยกว่ารับมากกว่าได้ถ้าตกลงกันแบบนั้น', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 1, paid: 0, share: 12000 },
        { employee_id: 'B', shifts: 9, paid: 0, share: 3000 },
      ],
      15000,
    );
    assert.equal(of(rows, 'A'), 12000);
    assert.equal(of(rows, 'B'), 3000);
  });

  /* ตั้ง 0 ให้ใคร = ตกลงกันว่าคนนั้นไม่รับค่าจ้างของเคสนี้ ซึ่งต่างจาก "ยังไม่ได้ตั้ง" (null)
     ถ้ายุบสองอย่างนี้เป็นค่าเดียวกัน การตกลงว่า "คนนี้ไม่รับ" จะสั่งไม่ได้เลย */
  test('ตั้งส่วนแบ่งเป็น 0 = ไม่รับค่าจ้างของเคสนี้ ทั้งที่มีกะอยู่', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 5, paid: 0, share: 15000 },
        { employee_id: 'B', shifts: 5, paid: 0, share: 0 },
      ],
      15000,
    );
    assert.equal(of(rows, 'A'), 15000);
    assert.equal(of(rows, 'B'), 0);
  });

  test('มีข้อตกลงแค่บางคน = คนที่ไม่มีถือว่าไม่รับ (ไม่กลับไปหารเท่ากันครึ่งทาง)', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 5, paid: 0, share: 15000 },
        { employee_id: 'B', shifts: 5, paid: 0 },
      ],
      15000,
    );
    assert.equal(of(rows, 'A'), 15000);
    assert.equal(of(rows, 'B'), 0);
  });

  test('ผลรวมข้อตกลงไม่ตรงกับค่าจ้างของเคส ก็ยังใช้เป็นสัดส่วนได้ (หน้าจอเป็นคนฟ้อง)', () => {
    const rows = allocateShares(
      [
        { employee_id: 'A', shifts: 5, paid: 0, share: 6 },
        { employee_id: 'B', shifts: 5, paid: 0, share: 4 },
      ],
      15000,
    );
    assert.deepEqual(rows.map((r) => r.amount), [9000, 6000]);
    assert.equal(sum(rows), 15000);
  });

  test('ข้อตกลงเป็น 0 ทุกคน = ไม่มีใครรับ จึงไม่แบ่งอะไรเลย', () => {
    assert.deepEqual(
      allocateShares(
        [{ employee_id: 'A', shifts: 5, paid: 0, share: 0 }, { employee_id: 'B', shifts: 5, paid: 0, share: 0 }],
        15000,
      ),
      [],
    );
  });
});

describe('ตัวแบ่งค่าจ้างฝั่งหน้าเว็บต้องให้ผลตรงกับฝั่ง server', () => {
  /* หน้าจอโชว์ส่วนแบ่งให้ดูก่อนกด แล้วส่งตัวเลขชุดนั้นไปบันทึกเลย ส่วน server คิดเองได้ด้วย
     เมื่อไม่มีใครส่งมา — สองสูตรนี้ต่างกันเมื่อไหร่ ตัวเลขที่ผู้จัดการเห็นกับที่ลงจริงจะไม่ใช่ตัวเดียวกัน
     โปรเจคนี้ไม่มีโค้ดที่ใช้ร่วมกันสองฝั่ง จึงพินกันด้วยเทสนี้แทน */
  const CASES = [
    [[{ employee_id: 'A', shifts: 5, paid: 0 }], 7000],
    [[{ employee_id: 'A', shifts: 5, paid: 0 }, { employee_id: 'B', shifts: 5, paid: 0 }], 13000],
    [[{ employee_id: 'A', shifts: 5, paid: 7000 }, { employee_id: 'B', shifts: 5, paid: 0 }], 8000],
    [[{ employee_id: 'A', shifts: 5, paid: 9000 }, { employee_id: 'B', shifts: 15, paid: 0 }], 6000],
    [[{ employee_id: 'A', shifts: 1, paid: 0 }, { employee_id: 'B', shifts: 1, paid: 0 }, { employee_id: 'C', shifts: 1, paid: 0 }], 20000],
    [[{ employee_id: 'A', shifts: 3, paid: 120.5 }, { employee_id: 'B', shifts: 4, paid: 0 }], 7000.55],
    [[{ employee_id: 'A', shifts: 0, paid: 0 }], 5000],
    [[{ employee_id: 'A', shifts: 2, paid: 0 }, { employee_id: 'Z', shifts: 0, paid: 900 }], 3000],
    // มีข้อตกลง — สองฝั่งต้องตีความ share = null / 0 เหมือนกันเป๊ะ ไม่งั้นคนที่ "ตกลงว่าไม่รับ" จะได้เงิน
    [[{ employee_id: 'A', shifts: 6, paid: 0, share: 9000 }, { employee_id: 'B', shifts: 4, paid: 0, share: 6000 }], 7000],
    [[{ employee_id: 'A', shifts: 5, paid: 0, share: 15000 }, { employee_id: 'B', shifts: 5, paid: 0, share: 0 }], 15000],
    [[{ employee_id: 'A', shifts: 5, paid: 0, share: 15000 }, { employee_id: 'B', shifts: 5, paid: 0 }], 15000],
  ];

  test('แบ่งเงินของงวดได้ผลเท่ากันทุกกรณีที่ไล่เทียบ', async () => {
    const { allocateShares: onClient } = await import('../../client/src/lib/payShare.js');

    for (const [shares, amount] of CASES) {
      assert.deepEqual(
        onClient(shares, amount).map((r) => [r.employee_id, r.amount]),
        allocateShares(shares, amount).map((r) => [r.employee_id, r.amount]),
        `ผลต่างกันที่ ${JSON.stringify(shares)} ยอด ${amount}`,
      );
    }
  });

  /* น้ำหนักคือกฎ "หารเท่ากันหรือตามข้อตกลง" ตัวจริง — ผลลัพธ์สุดท้ายอาจบังเอิญเท่ากัน
     ทั้งที่กฎต่างกัน (เช่นตอนที่ทุกคนได้ 0 อยู่ดี) จึงเทียบตัวกฎเองด้วย */
  test('น้ำหนักของแต่ละคนตีความเหมือนกัน', async () => {
    const { weightsFor: onClient } = await import('../../client/src/lib/payShare.js');
    for (const [shares] of CASES) {
      assert.deepEqual(onClient(shares), weightsFor(shares), `น้ำหนักต่างกันที่ ${JSON.stringify(shares)}`);
    }
  });

  /* entitlements อยู่ฝั่งหน้าเว็บอย่างเดียว (ใช้โชว์ว่าใครควรได้เท่าไหร่ทั้งเคส) แต่มันต่อยอดจาก
     weightsFor เดียวกัน — ผลรวมจึงต้องเท่ากับค่าจ้างของเคสเป๊ะ ไม่งั้นตัวเลขบนหน้าจอไม่ลงตัว */
  test('ส่วนของทั้งเคสรวมกันแล้วเท่ากับค่าจ้างของเคสเสมอ', async () => {
    const { entitlements } = await import('../../client/src/lib/payShare.js');

    for (const [shares] of CASES) {
      const out = entitlements(shares, 15000);
      const total = Math.round(out.reduce((s, v) => s + v, 0) * 100) / 100;
      // ไม่มีใครมีน้ำหนักเลย (ยังไม่มีกะที่อนุมัติ) = ไม่มีส่วนของใครให้แสดง
      const anyWeight = weightsFor(shares).some((w) => w > 0);
      assert.equal(total, anyWeight ? 15000 : 0, `ผลรวมไม่ลงตัวที่ ${JSON.stringify(shares)}`);
    }
  });
});

describe('เพดานงวดของเคส', () => {
  /* ค่าปริยายของการจ่ายคือทีเดียวจบ — ตัวเลขนี้คือขอบบนของกรณีที่ตกลงกันว่าจะซอย
     ไม่ใช่จำนวนงวดที่ทุกเคสต้องมี (หน้าจอจึงไม่โชว์ "งวดที่ 1 จาก 5" ให้เข้าใจผิด) */
  test('แบ่งจ่ายได้สูงสุด 5 งวดต่อเคส', () => {
    assert.equal(MAX_INSTALLMENTS, 5);
  });
});

/* ==========================================================================
   ชุดที่เพิ่มตอนอุดช่องโหว่รอบตรวจความปลอดภัย — แต่ละอันผูกกับข้อที่เคยเป็นบั๊กจริง
   ========================================================================== */

describe('วันที่ต้องมีอยู่จริงในปฏิทิน (lib/dates.js)', () => {
  test('วันปกติผ่าน', () => {
    assert.equal(isCalendarDate('2026-08-24'), true);
    assert.equal(isCalendarDate('2024-02-29'), true); // ปีอธิกสุรทิน
  });

  test('วันที่ไม่มีอยู่จริงต้องไม่ผ่าน แม้รูปแบบจะถูก', () => {
    // ของเดิมตรวจด้วยรูปแบบอย่างเดียว ทั้งสามอันนี้จึงลงฐานข้อมูลได้ (คอลัมน์เป็น TEXT)
    assert.equal(isCalendarDate('2026-02-31'), false);
    assert.equal(isCalendarDate('2026-02-29'), false);
    assert.equal(isCalendarDate('2026-13-45'), false);
    assert.equal(isCalendarDate('2026-00-10'), false);
  });

  test('รูปแบบผิด/ไม่ใช่ข้อความ ก็ไม่ผ่าน', () => {
    assert.equal(isCalendarDate('26-8-4'), false);
    assert.equal(isCalendarDate(''), false);
    assert.equal(isCalendarDate(null), false);
    assert.equal(isCalendarDate(20260824), false);
  });
});

describe('โดเมนที่ยอมให้ server ยิงออกไป (lib/maplink.js)', () => {
  test('โดเมนของ Google จริงผ่าน', () => {
    for (const h of ['maps.google.com', 'www.google.com', 'google.co.th', 'maps.app.goo.gl', 'goo.gl', 'g.co']) {
      assert.equal(isAllowedHost(h), true, h);
    }
  });

  test('โดเมนคนอื่นที่ตั้งซับโดเมนชื่อ google ต้องไม่ผ่าน', () => {
    // ของเดิม /(^|\.)(google\.[a-z.]+|...)$/ ปล่อยสามอันนี้ผ่านหมด = SSRF
    for (const h of ['google.evil.com', 'www.google.attacker.io', 'google.xyz.io', 'notgoogle.com', 'evil.com']) {
      assert.equal(isAllowedHost(h), false, h);
    }
  });

  test('ไม่พังกับค่าว่าง และตัดจุดท้าย FQDN ให้', () => {
    assert.equal(isAllowedHost('maps.google.com.'), true);
    assert.equal(isAllowedHost(''), false);
    assert.equal(isAllowedHost(null), false);
  });
});

describe('รหัสผ่านชั่วคราวของพนักงานใหม่ (lib/auth.js)', () => {
  test('ยาวพอและไม่ซ้ำกันในแต่ละครั้ง', () => {
    const a = generateTempPassword();
    const b = generateTempPassword();
    assert.equal(a.length, 12);
    assert.notEqual(a, b);
  });

  test('ไม่มีตัวอักษรที่อ่านสลับกันง่าย (0 O 1 I l)', () => {
    const pool = new Set();
    for (let i = 0; i < 50; i += 1) for (const ch of generateTempPassword()) pool.add(ch);
    for (const bad of ['0', 'O', '1', 'I', 'l']) assert.ok(!pool.has(bad), `ไม่ควรมี ${bad}`);
  });

  test('ไม่ใช่รหัสพนักงาน — ของเดิมตั้งเป็น employee_id ซึ่งเดาได้ทันที', () => {
    assert.notEqual(generateTempPassword(), 'EMP-0007');
  });
});

/* ==========================================================================
   Workflow เต็มเส้น: เปิดเคส → ออกใบแจ้งหนี้ → นัดกะ → เช็คอิน → ปล่อยค่าจ้าง 2 งวด → เงินได้พนักงาน

   เดินทีละขั้นด้วยฟังก์ชันตัวจริงของแต่ละโมดูล ไม่ใช่เขียนสูตรซ้ำในเทส — ตัวเลขที่ออกมาจึงเป็น
   ตัวเลขเดียวกับที่ระบบจะใช้จริง และถ้าใครแก้กติกาการแบ่งเงินทีหลัง เทสนี้จะแดงทันที

   ไม่แตะฐานข้อมูล: ทุกด่านที่ตัดสิน "ทำได้/ไม่ได้" กับ "ใครได้เท่าไหร่" ถูกแยกเป็นฟังก์ชันบริสุทธิ์
   ไว้แล้วโดยตั้งใจ (assess* / allocateShares / withVisitState) ส่วนที่เหลือคือ INSERT/UPDATE
   ที่ทำงานใน transaction — ซึ่งเทสด้วยฐาน production ไม่ได้ (ดู README ท้ายไฟล์)
   ========================================================================== */
describe('Workflow — เปิดเคสถึงเงินเข้าพนักงาน (จ่าย 2 งวด)', () => {
  /* เคสตัวอย่าง: เก็บลูกค้า 30,000 · ค่าจ้างพนักงานเหมา 20,000 · พนักงานสองคนหารเท่ากัน
     ตัวเลขเลือกให้หารไม่ลงตัวในงวดแรกโดยตั้งใจ (12,000 / 2 คน แล้วงวดสองเหลือ 8,000) */
  const CASE_FEE = 30_000;
  const CASE_STAFF_PAY = 20_000;
  const TEAM = ['EMP-0002', 'EMP-0005'];

  test('1. เปิดเคส — ชื่อผู้ป่วยกับประเภทเคสเป็นสองช่องที่ขาดไม่ได้', () => {
    const base = {
      case_type: 'elderly_care',
      client_name: 'ผู้ป่วยทดสอบ workflow',
      service_kind: 'homecare',
      fee: CASE_FEE,
      staff_pay: CASE_STAFF_PAY,
      start_date: '2026-09-01',
    };
    assert.equal(createCaseSchema.safeParse(base).success, true);

    // ขาดชื่อผู้ป่วย = เปิดเคสไม่ได้ (เคสไม่มีชื่อคนไข้ก็ไม่รู้ว่าไปดูแลใคร)
    assert.equal(createCaseSchema.safeParse({ ...base, client_name: '' }).success, false);
    // ประเภทเคสต้องเป็นค่าใน enum ไม่ใช่ข้อความอิสระ — ไม่งั้นหลุดไปชน CHECK ของฐานข้อมูล
    assert.equal(createCaseSchema.safeParse({ ...base, case_type: 'อื่นๆ' }).success, false);
  });

  test('2. ออกใบแจ้งหนี้ — ออกได้จากร่างเท่านั้น แล้วรับชำระเกินยอดไม่ได้', () => {
    // ออกใบ: draft -> issued ได้ · ออกซ้ำจากใบที่ออกแล้วไม่ได้
    assert.deepEqual(assessInvoiceAction('issue', 'draft'), { status: 'draft' });
    assert.equal(assessInvoiceAction('issue', 'issued').reason, 'invalid_status');
    assert.equal(assessInvoiceAction('issue', 'cancelled').reason, 'invalid_status');

    // รับชำระบางส่วน 10,000 จาก 30,000
    const first = assessPaymentCapacity('issued', CASE_FEE, 0, 10_000);
    assert.equal(first.amount, 10_000);
    assert.equal(first.balance, CASE_FEE);

    // ที่เหลือ 20,000 — ไม่ส่งยอดมา = รับยอดคงเหลือทั้งหมด
    const rest = assessPaymentCapacity('issued', CASE_FEE, 10_000, null);
    assert.equal(rest.amount, 20_000);

    // เกินยอดคงเหลือ / ใบที่ชำระครบแล้ว / ใบที่ยกเลิก — ต้องถูกปฏิเสธคนละเหตุผล
    assert.equal(assessPaymentCapacity('issued', CASE_FEE, 10_000, 25_000).reason, 'amount_exceeds_balance');
    assert.equal(assessPaymentCapacity('issued', CASE_FEE, CASE_FEE, null).reason, 'fully_paid');
    assert.equal(assessPaymentCapacity('cancelled', CASE_FEE, 0, 100).reason, 'cancelled');
  });

  test('3. นัดกะ — ลงยาวด้วยช่วงวัน + วันในสัปดาห์ ต้องระบุอย่างน้อยทางใดทางหนึ่ง', () => {
    const ok = bulkVisitSchema.safeParse({
      from: '2026-09-01',
      to: '2026-09-30',
      weekdays: [1, 3, 5],
      assigned_to: TEAM[0],
      planned_start: '08:00',
      planned_end: '17:00',
    });
    assert.equal(ok.success, true);

    // ลงเป็นรายวันก็ได้
    assert.equal(bulkVisitSchema.safeParse({ dates: ['2026-09-01', '2026-09-02'] }).success, true);
    // ไม่บอกทั้งวันที่และช่วงวัน = ไม่รู้จะลงกะวันไหน
    assert.equal(bulkVisitSchema.safeParse({ assigned_to: TEAM[0] }).success, false);
    // วันที่ไม่มีอยู่จริงในปฏิทินต้องไม่ผ่าน (คอลัมน์วันที่เป็น TEXT ฐานข้อมูลไม่ช่วยตรวจ)
    assert.equal(bulkVisitSchema.safeParse({ dates: ['2026-02-31'] }).success, false);
  });

  test('4. พนักงานเช็คอิน — สถานะกะเดินตามเวลาจริง และคิดชั่วโมงจากเวลาเข้า–ออก', () => {
    const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=';
    assert.equal(checkInSchema.safeParse({ lat: 13.7, lng: 100.5, photo }).success, true);
    // ไม่มีรูป = เช็คอินไม่ได้ (รูปคือหลักฐานชิ้นเดียวที่ปลอมยากกว่าพิกัด)
    assert.equal(checkInSchema.safeParse({ lat: 13.7, lng: 100.5 }).success, false);

    const now = new Date('2026-09-10T18:00:00+07:00');
    const visit = { visit_date: '2026-09-10', status: 'scheduled' };

    // ยังไม่เช็คอิน + ยังไม่เลยวัน = รอเช็คอิน
    assert.equal(withVisitState({ ...visit, visit_date: '2026-09-30' }, now).state, 'scheduled');
    // เช็คอินแล้วยังไม่ออก = กำลังทำงาน
    assert.equal(
      withVisitState({ ...visit, check_in_at: '2026-09-10T08:00:00+07:00' }, now).state,
      'working',
    );
    // เลยวันแล้วไม่มีการเช็คอิน = ขาดงาน
    assert.equal(withVisitState({ ...visit, visit_date: '2026-09-01' }, now).state, 'missed');

    // เช็คเอาท์แล้ว = เสร็จ + ชั่วโมงทำงานคิดจากผลต่างเวลาจริง (8 ชม. = 480 นาที)
    const done = withVisitState(
      {
        ...visit,
        check_in_at: '2026-09-10T08:00:00+07:00',
        check_out_at: '2026-09-10T16:00:00+07:00',
      },
      now,
    );
    assert.equal(done.state, 'done');
    assert.equal(done.worked_minutes, 480);

    // ค้างเช็คเอาท์เกิน 16 ชม. ต้องขึ้นเป็น stale ไม่ใช่ working ตลอดกาล
    assert.equal(
      withVisitState({ ...visit, visit_date: '2026-09-09', check_in_at: '2026-09-09T08:00:00+07:00' }, now).state,
      'stale',
    );
  });

  test('5. ปล่อยค่าจ้างงวดที่ 1 — 12,000 จาก 20,000 แบ่งสองคนเท่ากัน', () => {
    const gate = assessReleaseCapacity(CASE_STAFF_PAY, 0, 12_000);
    assert.equal(gate.reason, undefined);
    assert.equal(gate.remaining, CASE_STAFF_PAY);
    assert.equal(gate.amount, 12_000);

    const split = allocateShares(TEAM.map((employee_id) => ({ employee_id, paid: 0 })), gate.amount);
    assert.deepEqual(split.map((r) => r.amount), [6_000, 6_000]);
    assert.equal(split.reduce((s, r) => s + r.amount, 0), 12_000);
  });

  test('6. ปล่อยค่าจ้างงวดที่ 2 — ไม่ส่งยอดมา = ปิดยอดคงเหลือ 8,000 พอดี', () => {
    const gate = assessReleaseCapacity(CASE_STAFF_PAY, 12_000, null);
    assert.equal(gate.reason, undefined);
    assert.equal(gate.remaining, 8_000);
    assert.equal(gate.amount, 8_000, 'ไม่ส่งยอด = ปล่อยยอดคงเหลือทั้งหมด');

    const split = allocateShares(TEAM.map((employee_id) => ({ employee_id, paid: 6_000 })), gate.amount);
    assert.deepEqual(split.map((r) => r.amount), [4_000, 4_000]);

    // รวมสองงวดต้องเท่ายอดเหมาของเคสเป๊ะ ไม่ขาดไม่เกินแม้เศษสตางค์
    const perPerson = split.map((r) => r.paid + r.amount);
    assert.deepEqual(perPerson, [10_000, 10_000]);
    assert.equal(perPerson.reduce((s, n) => s + n, 0), CASE_STAFF_PAY);
  });

  test('7. ปล่อยงวดที่ 3 ไม่ได้ และปล่อยเกินยอดคงเหลือก็ไม่ได้', () => {
    // จ่ายครบแล้ว = ไม่มีอะไรให้ปล่อยอีก
    assert.equal(assessReleaseCapacity(CASE_STAFF_PAY, CASE_STAFF_PAY, null).reason, 'fully_released');
    // ขอเกินยอดคงเหลือ (เหลือ 8,000 แต่ขอ 9,000)
    assert.equal(assessReleaseCapacity(CASE_STAFF_PAY, 12_000, 9_000).reason, 'amount_exceeds_remaining');
    // เคสที่ยังไม่ตั้งค่าจ้าง = ปล่อยไม่ได้เลย (ไม่ใช่ปล่อย 0 บาท)
    assert.equal(assessReleaseCapacity(null, 0, 5_000).reason, 'staff_pay_not_set');
    // เพดานงวดต่อเคสยังอยู่ที่เดิม — เปลี่ยนแล้วหน้าเว็บที่โชว์ "งวดที่ n/N" จะเพี้ยนตาม
    assert.equal(MAX_INSTALLMENTS, 5);
  });

  test('8. งวดที่คนรับไม่เท่ากัน — งวดถัดไปต้องเกลี่ยให้ไล่ทันข้อตกลง', () => {
    /* งวดแรกปล่อยตอนที่คนที่สองยังไม่พร้อมรับ (กะยังไม่ถูกยืนยัน) คนแรกจึงได้ไปคนเดียว
       งวดสองต้องไม่หารครึ่งเฉพาะเงินก้อนนั้น ไม่งั้นยอดรวมทั้งเคสจะผิดข้อตกลงถาวร */
    const split = allocateShares(
      [{ employee_id: TEAM[0], paid: 12_000 }, { employee_id: TEAM[1], paid: 0 }],
      8_000,
    );
    assert.deepEqual(split.map((r) => r.amount), [0, 8_000], 'คนที่ยังไม่ได้เงินต้องได้ก่อน');

    const perPerson = split.map((r) => r.paid + r.amount);
    assert.deepEqual(perPerson, [12_000, 8_000]);
    assert.equal(perPerson.reduce((s, n) => s + n, 0), CASE_STAFF_PAY, 'ยอดรวมยังเท่าค่าจ้างเหมา');
  });

  test('9. แสดงเงินได้พนักงาน — เปิดรอบจ่ายแล้วบันทึกจ่ายได้ครั้งเดียว', () => {
    // เดือนแรกยังไม่มีรอบ = ได้รอบที่ 1 · มีรอบ 1 แล้ว = ได้รอบที่ 2
    assert.equal(firstAvailablePayrollRound([]), 1);
    assert.equal(firstAvailablePayrollRound([1]), 2);

    // บันทึกการจ่ายทำได้จากร่างเท่านั้น — กดซ้ำจากรอบที่จ่ายแล้วต้องไม่ผ่าน
    assert.deepEqual(assessPayrollRunAction('pay', 'draft'), { status: 'draft' });
    assert.equal(assessPayrollRunAction('pay', 'paid').reason, 'invalid_status');
    // ยกเลิกได้ทั้งร่างและรอบที่จ่ายแล้ว (เงินกลับเข้ากองรอจ่าย) แต่ยกเลิกซ้ำไม่ได้
    assert.deepEqual(assessPayrollRunAction('cancel', 'paid'), { status: 'paid' });
    assert.equal(assessPayrollRunAction('cancel', 'cancelled').reason, 'invalid_status');
  });
});

describe('กระดิ่งแจ้งเตือน — สัญญาคีย์ระหว่าง server กับหน้าเว็บ', () => {
  test('ทุกกลุ่ม/ทุกคีย์ที่ server ส่งมา มีป้ายภาษาไทยฝั่งหน้าเว็บครบ', async () => {
    const { ALERT_KEYS } = await import('../src/notify/alerts.js');
    const { ALERT_GROUPS } = await import('../../client/src/lib/alertDefs.js');

    const onClient = Object.fromEntries(
      ALERT_GROUPS.map((g) => [g.key, g.items.map((i) => i.key)]),
    );
    assert.deepEqual(Object.keys(onClient).sort(), Object.keys(ALERT_KEYS).sort());
    for (const [group, keys] of Object.entries(ALERT_KEYS)) {
      assert.deepEqual([...onClient[group]].sort(), [...keys].sort(), `กลุ่ม ${group} ไม่ตรงกัน`);
    }
  });

  /* กระดิ่งที่กดแล้วไม่ไปไหน (หรือไปหน้าเปล่าให้ไปกรองเอง) คือขั้นตอนที่เพิ่มมาโดยไม่ช่วยอะไร */
  test('ทุกแถวมีป้าย คำอธิบาย และลิงก์ที่เป็น path จริง', async () => {
    const { ALERT_GROUPS } = await import('../../client/src/lib/alertDefs.js');
    for (const g of ALERT_GROUPS) {
      assert.ok(g.label?.length > 0, `กลุ่ม ${g.key} ไม่มีชื่อ`);
      for (const i of g.items) {
        assert.ok(i.label?.length > 0, `${g.key}.${i.key} ไม่มีป้าย`);
        assert.ok(i.hint?.length > 0, `${g.key}.${i.key} ไม่มีคำอธิบาย`);
        assert.match(i.to, /^\/[a-z-]+(\?[\w=&-]*)?$/, `${g.key}.${i.key} ลิงก์ไม่ใช่ path`);
      }
    }
  });

  /* เคยพลาดจริง: สามแถวลิงก์ไปช่องสถานะเฉยๆ ซึ่งกว้างกว่าเกณฑ์ที่นับ
     (overdue_close ชี้ ?status=in_progress · closed_no_invoice ชี้ ?status=closed ·
      draft_stale ชี้ ?status=draft) กระดิ่งบอก 1 เคส แต่กดเข้ามาเจอ 7 เคส

     เทสนี้คุมสองชั้น:
     1. พารามิเตอร์ในลิงก์ต้องเป็นตัวที่ schema ของหน้านั้นรับจริง ไม่ใช่ค่าที่ถูกทิ้งเงียบๆ
     2. แถวจะชี้ไปช่อง status ได้ "เฉพาะเมื่อแถวนั้นคือสถานะนั้นเอง" — เกณฑ์ที่แคบกว่าสถานะ
        (เลยกำหนด · ไม่มีใบแจ้งหนี้ · ค้างเกิน 7 วัน) ต้องมีตัวกรองของตัวเองฝั่ง server
        ซึ่งใช้ก้อนเกณฑ์เดียวกับที่ alertCounts() นับ */
  test('ลิงก์ของทุกแถวพาไปถึงเฉพาะของที่นับ ไม่ใช่หน้าที่กว้างกว่า', async () => {
    const { ALERT_GROUPS } = await import('../../client/src/lib/alertDefs.js');
    const { listQuerySchema: caseQuery } = await import('../src/cases/schema.js');
    const { listQuerySchema: invoiceQuery } = await import('../src/invoices/schema.js');
    const schemaFor = { '/cases': caseQuery, '/invoices': invoiceQuery };

    for (const g of ALERT_GROUPS) {
      for (const i of g.items) {
        const [path, query] = i.to.split('?');
        const schema = schemaFor[path];
        if (!schema || !query) continue;

        const sent = Object.fromEntries(new URLSearchParams(query));
        const parsed = schema.parse(sent);
        for (const [key, value] of Object.entries(sent)) {
          assert.equal(parsed[key], value, `${g.key}.${i.key}: ${path} ไม่รับพารามิเตอร์ ${key}`);
        }
        if (sent.status !== undefined) {
          assert.equal(
            sent.status,
            i.key,
            `${g.key}.${i.key} ชี้ไป ?status=${sent.status} ซึ่งกว้างกว่าที่นับ — ต้องมีตัวกรองของตัวเอง`,
          );
        }
      }
    }
  });

  /* กะที่ไม่มีใครเช็คอินอยู่ใน exceptions แล้ว เคยนับแยกอีกแถวจึงบวกซ้ำ
     (วัดกับฐานจริงตอนนั้น: exceptions 50 · missed 14 · ซ้ำกัน 14 จาก 14)
     เทสนี้กันการเผลอเพิ่มแถวนั้นกลับมา — ยอดบนกระดิ่งคือผลบวกตรงๆ ของทุกคีย์ */
  test('กลุ่มการมาทำงานไม่มีคีย์ที่นับกะชุดเดียวกันซ้ำ', async () => {
    const { ALERT_KEYS } = await import('../src/notify/alerts.js');
    assert.deepEqual(ALERT_KEYS.attendance, ['exceptions', 'unstaffed_today']);
  });
});

/* ---------- แบบประเมินความพึงพอใจจากญาติ (reviews) ----------

   โมดูลนี้รับข้อมูลจาก "หน้าสาธารณะที่ไม่ต้อง login" ซึ่งเป็นทางเข้าเดียวในระบบที่คนนอกยิงเข้ามาได้
   schema จึงเป็นด่านเดียวที่กันของเสียก่อนถึงฐานข้อมูล — ทุกกฎในนั้นต้องมีเทสคุม */

/** ใบที่กรอกครบถูกต้อง ใช้เป็นฐานแล้วแก้ทีละช่องในแต่ละเทส */
const validReview = (extra = {}) => ({
  ...Object.fromEntries(REVIEW_QUESTIONS.map((q) => [q, 5])),
  ...extra,
});

describe('แบบประเมิน — schema ที่ญาติกรอกจากหน้าสาธารณะ', () => {
  test('ใบที่ให้คะแนนครบทุกข้อผ่าน และช่องไม่บังคับที่เว้นว่างกลายเป็น null', () => {
    const parsed = reviewSubmitSchema.parse(
      validReview({ patient_name: '', service_date: '', impressed: '', improve: '', want_again: '', recommend: '' }),
    );

    for (const q of REVIEW_QUESTIONS) assert.equal(parsed[q], 5);
    // '' จากฟอร์ม HTML ต้องกลายเป็น null ไม่ใช่สตริงว่างลงฐาน (ไม่งั้น "ไม่มีความเห็น" มีสองความหมาย)
    for (const f of ['patient_name', 'service_date', 'impressed', 'improve', 'want_again', 'recommend']) {
      assert.equal(parsed[f], null, `ช่อง ${f} ที่เว้นว่างต้องเป็น null`);
    }
  });

  test('ขาดคะแนนแม้ข้อเดียวต้องไม่ผ่าน — ใบครึ่งใบทำให้ค่าเฉลี่ยรายหัวข้อเทียบกันไม่ได้', () => {
    for (const missing of REVIEW_QUESTIONS) {
      const body = validReview();
      delete body[missing];
      assert.equal(reviewSubmitSchema.safeParse(body).success, false, `ขาดข้อ ${missing} แต่ยังผ่าน`);
    }
  });

  test('คะแนนต้องเป็นจำนวนเต็ม 1–5 เท่านั้น', () => {
    for (const bad of [0, 6, -1, 3.5, '5', null, true]) {
      assert.equal(
        reviewSubmitSchema.safeParse(validReview({ q_overall: bad })).success,
        false,
        `คะแนน ${JSON.stringify(bad)} ไม่ควรผ่าน`,
      );
    }
    for (const ok of [1, 2, 3, 4, 5]) {
      assert.equal(reviewSubmitSchema.safeParse(validReview({ q_overall: ok })).success, true);
    }
  });

  /* คอลัมน์วันที่ในฐานนี้เป็น TEXT ทั้งหมด Postgres จึงไม่ช่วยตรวจให้อีกชั้น
     เคยใช้ regex สี่หลัก-สองหลัก-สองหลัก ซึ่งปล่อยวันที่ที่ไม่มีอยู่จริงลงฐานได้ */
  test('วันที่รับบริการต้องมีอยู่จริงในปฏิทิน ไม่ใช่แค่รูปแบบถูก', () => {
    for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-1-1', '31-01-2026', 'เมื่อวาน']) {
      assert.equal(
        reviewSubmitSchema.safeParse(validReview({ service_date: bad })).success,
        false,
        `วันที่ ${bad} ไม่ควรผ่าน`,
      );
    }
    assert.equal(reviewSubmitSchema.safeParse(validReview({ service_date: '2026-02-28' })).success, true);
    assert.equal(reviewSubmitSchema.safeParse(validReview({ service_date: '2028-02-29' })).success, true); // ปีอธิกสุรทิน
  });

  test('ตัวเลือกปลายปิดรับเฉพาะค่าที่ CHECK ของฐานข้อมูลยอมรับ', () => {
    for (const v of WANT_AGAIN_OPTIONS) {
      assert.equal(reviewSubmitSchema.safeParse(validReview({ want_again: v })).success, true);
    }
    for (const v of RECOMMEND_OPTIONS) {
      assert.equal(reviewSubmitSchema.safeParse(validReview({ recommend: v })).success, true);
    }
    assert.equal(reviewSubmitSchema.safeParse(validReview({ want_again: 'maybe' })).success, false);
    // ค่าของอีกช่องหนึ่งต้องใช้ข้ามช่องไม่ได้ — สองชุดนี้ตั้งใจตั้งชื่อไม่ให้ซ้ำกัน
    assert.equal(reviewSubmitSchema.safeParse(validReview({ want_again: 'definitely' })).success, false);
  });

  test('ข้อความยาวเกินเพดานไม่ผ่าน และช่องเว้นวรรคล้วนถือว่าไม่ได้กรอก', () => {
    assert.equal(reviewSubmitSchema.safeParse(validReview({ impressed: 'ก'.repeat(2001) })).success, false);
    assert.equal(reviewSubmitSchema.safeParse(validReview({ patient_name: 'ก'.repeat(101) })).success, false);
    assert.equal(reviewSubmitSchema.parse(validReview({ impressed: '   ' })).impressed, null);
  });

  /* หน้าสาธารณะ = ใครก็ยิง body อะไรมาก็ได้ · ชั้นที่เขียนฐานประกอบคำสั่งจากรายชื่อคอลัมน์ของตัวเอง
     แต่ schema ต้องไม่ปล่อยของแปลกปลอมผ่านมาให้ตั้งแต่แรก (กันชั้นเดียวคือกันไม่พอ) */
  test('คีย์แปลกปลอมที่ส่งแนบมาถูกตัดทิ้ง ไม่ไหลต่อไปถึงชั้นที่เขียนฐานข้อมูล', () => {
    const parsed = reviewSubmitSchema.parse(
      validReview({ employee_id: 'EMP-0001', ip_hash: 'x', review_id: 99, submitted_at: '2020-01-01 00:00:00' }),
    );
    for (const k of ['employee_id', 'ip_hash', 'review_id', 'submitted_at']) {
      assert.equal(k in parsed, false, `คีย์ ${k} ไม่ควรผ่าน schema มาได้`);
    }
  });
});

describe('แบบประเมิน — ตัวหารของคะแนนเฉลี่ย', () => {
  /* เคยเขียน "/ 10.0" ไว้ตายตัวตอนที่แบบประเมินมีสิบข้อ
     วันที่ย่อเหลือห้าข้อ คะแนนทุกคนจะหล่นครึ่งหนึ่งเงียบๆ โดยไม่มีอะไรฟ้อง */
  test('หารด้วยจำนวนข้อจริง ไม่ใช่เลขที่เขียนไว้ตายตัว', () => {
    assert.ok(
      perReviewAvg().endsWith(`/ ${REVIEW_QUESTIONS.length}.0)`),
      `ตัวหารไม่ตรงกับจำนวนข้อ: ${perReviewAvg()}`,
    );
  });

  test('ให้ดาวเท่ากันทุกข้อต้องได้ค่าเฉลี่ยเท่ากับดาวที่ให้', () => {
    // แทนชื่อคอลัมน์ด้วยตัวเลข แล้วคิดนิพจน์เดียวกับที่ Postgres จะคิด
    const evaluate = (score) => eval(perReviewAvg().replace(/q_\w+/g, String(score)));
    assert.equal(evaluate(5), 5);
    assert.equal(evaluate(3), 3);
    assert.equal(evaluate(1), 1);
  });

  test('prefix ของตารางถูกเติมให้ครบทุกคอลัมน์ (ใช้ตอน JOIN กับ employees)', () => {
    const sql = perReviewAvg('r.');
    for (const q of REVIEW_QUESTIONS) assert.ok(sql.includes(`r.${q}`), `ขาด r.${q}`);
  });
});

describe('แบบประเมิน — ตำแหน่งที่เปิดใช้', () => {
  test('เปิดให้สายบำบัดทั้งชุด โดยอ้างรายการกลาง ไม่ประกาศชื่อซ้ำ', () => {
    assert.deepEqual(REVIEW_POSITIONS, THERAPY_POSITIONS);
    assert.deepEqual([...THERAPY_POSITIONS].sort(), ['occupational_therapist', 'speech_therapist', 'therapist']);
  });

  test('สายบำบัดเป็นพนักงานภาคสนาม ไม่ใช่ admin และไม่เห็นค่าจ้าง/กำไร', () => {
    for (const p of REVIEW_POSITIONS) {
      assert.equal(roleForPosition(p), 'field', `${p} ต้องไม่ได้สิทธิ์ระดับ admin`);
      assert.equal(canSeeStaffPay(p), false, `${p} ต้องไม่เห็นค่าจ้าง/กำไร`);
    }
  });

  test('ตำแหน่งสำนักงานและสายดูแลยังไม่เปิดให้ออกลิงก์ประเมิน', () => {
    for (const p of ['manager', 'hr', 'admin', 'caregiver', 'assistant_nurse', 'practical_nurse', 'nurse']) {
      assert.equal(REVIEW_POSITIONS.includes(p), false, `${p} ไม่ควรออกลิงก์ประเมินได้`);
    }
  });
});

describe('แบบประเมิน — นิยามฝั่งหน้าเว็บต้องตรงกับ schema ฝั่ง server', () => {
  test('คำถามในฟอร์มตรงกับคอลัมน์ที่ server รับ ทั้งชุดและลำดับ', async () => {
    const { REVIEW_QUESTIONS: CLIENT_QUESTIONS } = await import('../../client/src/lib/reviewQuestions.js');
    assert.deepEqual(CLIENT_QUESTIONS.map((q) => q.key), REVIEW_QUESTIONS);
  });

  test('ทุกคำถามมีทั้งป้ายเต็มและป้ายสั้น (ป้ายสั้นใช้ในกราฟที่มีที่จำกัด)', async () => {
    const { REVIEW_QUESTIONS: CLIENT_QUESTIONS } = await import('../../client/src/lib/reviewQuestions.js');
    for (const q of CLIENT_QUESTIONS) {
      assert.ok(q.label?.length > 0, `${q.key} ไม่มี label`);
      assert.ok(q.short?.length > 0, `${q.key} ไม่มี short`);
    }
  });

  test('ป้ายของตัวเลือกปลายปิดครอบค่าที่ server ยอมรับครบทุกค่า', async () => {
    const { WANT_AGAIN_LABELS, RECOMMEND_LABELS } = await import('../../client/src/lib/reviewQuestions.js');
    assert.deepEqual(Object.keys(WANT_AGAIN_LABELS), WANT_AGAIN_OPTIONS);
    assert.deepEqual(Object.keys(RECOMMEND_LABELS), RECOMMEND_OPTIONS);
  });

  test('SCORE_LABELS ครอบคะแนน 1–5 ครบ — ไม่งั้นกดดาวแล้วไม่มีคำขึ้นข้างๆ', async () => {
    const { SCORE_LABELS } = await import('../../client/src/lib/reviewQuestions.js');
    for (const n of [1, 2, 3, 4, 5]) assert.ok(SCORE_LABELS[n], `ขาดป้ายของ ${n} ดาว`);
  });
});
