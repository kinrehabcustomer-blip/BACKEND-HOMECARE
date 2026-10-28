/**
 * QA รอบใหญ่ — วงจรเคส เปิด → ทำงาน → เก็บเงิน → จ่ายค่าจ้าง → ปิด/เปิดใหม่/ต่อรอบ
 *
 * รันบน PostgreSQL ชั่วคราว + Express จริง + HTTP จริง:
 *   node test/_run_probe.mjs test/_qa_lifecycle_20261026.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', first_name: 'Test', last_name: 'Employee' };
const FIELD_A = { employee_id: 'EMP-0003', position: 'caregiver', first_name: 'Test', last_name: 'Employee' };
const FIELD_B = { employee_id: 'EMP-9481', position: 'caregiver', first_name: 'คนใหม่', last_name: 'LifecycleQA' };
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';

await seedFixtures(pool, hashPassword);
await sql.run(
  `INSERT INTO employees
     (employee_id, first_name, last_name, position, email, status, password_hash, must_change_password)
   VALUES (:id, :first, :last, :position, :email, 'active', 'x', false)`,
  {
    id: FIELD_B.employee_id,
    first: FIELD_B.first_name,
    last: FIELD_B.last_name,
    position: FIELD_B.position,
    email: `${FIELD_B.employee_id}@example.invalid`,
  },
);
await sql.run(
  `UPDATE employees SET status = 'active', must_change_password = false
   WHERE employee_id IN (:manager, :a, :b)`,
  { manager: MANAGER.employee_id, a: FIELD_A.employee_id, b: FIELD_B.employee_id },
);
await sql.run('DELETE FROM invoices');
await sql.run('DELETE FROM cases');
await sql.run('DELETE FROM patients');
await sql.run('DELETE FROM customers');

const server = createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = (who) => ({ cookie: `${COOKIE_NAME}=${signToken(who)}` });
async function call(method, path, { body, who = MANAGER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...jar(who) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}
const get = (path, who = MANAGER) => call('GET', path, { who });
const post = (path, body, who = MANAGER) => call('POST', path, { body: body ?? {}, who });
const del = (path, who = MANAGER) => call('DELETE', path, { who });

let checks = 0;
const found = [];
const passed = [];
const observations = [];
const head = (title) => console.log(`\n=== ${title} ===`);
const brief = (value) => {
  const valueText = typeof value === 'string' ? value : JSON.stringify(value);
  return valueText.length > 900 ? `${valueText.slice(0, 900)}...` : valueText;
};
const hit = (title, detail) => {
  found.push({ title, detail });
  console.log(`BUG | ${title}\nRESULT | ${detail}`);
};
const ok = (what) => {
  passed.push(what);
  console.log(`PASS | ${what}`);
};
const info = (what) => {
  observations.push(what);
  console.log(`INFO | ${what}`);
};
const probe = (condition, bugTitle, detail, passText) => {
  checks += 1;
  if (condition) ok(passText);
  else hit(bugTitle, detail);
};
function mustStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label}: ${brief(response.body)}`);
  return response.body;
}

let caseNo = 690800000;
const nextCaseId = () => `VN${++caseNo}`;
const dateTH = (offsetDays = 0) => new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function createCase(input = {}) {
  const response = await post('/api/cases', {
    case_id: nextCaseId(),
    case_type: 'other',
    client_name: `เคสวงจร ${caseNo}`,
    fee: 2000,
    staff_pay: 1200,
    ...input,
  });
  mustStatus(response, 201, 'เปิดเคส');
  return response.body;
}
async function invoiceForCase(caseId) {
  const response = await get(`/api/invoices?case_id=${encodeURIComponent(caseId)}&per_page=20`);
  mustStatus(response, 200, 'โหลดใบของเคส');
  assert.equal(response.body.data.length, 1, `ต้องมีใบร่างอัตโนมัติหนึ่งใบ: ${brief(response.body)}`);
  return response.body.data[0];
}
async function issueFull(invoiceId) {
  mustStatus(await post(`/api/invoices/${invoiceId}/billing-plan`, { mode: 'full' }), 200, 'เลือกเก็บเต็ม');
  mustStatus(await post(`/api/invoices/${invoiceId}/issue`), 200, 'ออกใบ');
}
async function scalar(query, params = {}) {
  const row = await sql.one(query, params);
  return Number(row?.n ?? 0);
}

try {
  head('1 · เดินเส้นจริงครบวงจรและลองผิดลำดับ');
  const main = await createCase({ fee: 2000, staff_pay: 1200, medical_history: 'ความดันสูง' });
  const invoice = await invoiceForCase(main.case_id);

  const startTooSoon = await post(`/api/cases/${main.case_id}/start`);
  const payWithoutWorker = await post(`/api/cases/${main.case_id}/pay/release`, { request_id: randomUUID(), amount: 100 });
  probe(
    startTooSoon.status === 409 && payWithoutWorker.status === 409,
    'เริ่มงานหรือปล่อยค่าจ้างได้ทั้งที่ยังไม่มีพนักงานรับเคส',
    `start=${startTooSoon.status}/${brief(startTooSoon.body)} pay=${payWithoutWorker.status}/${brief(payWithoutWorker.body)}`,
    'ยังไม่จับคู่พนักงาน: เริ่มงานและปล่อยค่าจ้างถูกกัน 409',
  );

  mustStatus(await post(`/api/cases/${main.case_id}/assign`, { employee_id: FIELD_A.employee_id }), 200, 'จับคู่พนักงาน');
  const scheduled = mustStatus(await post(`/api/cases/${main.case_id}/visits/bulk`, {
    dates: [dateTH(0)], assigned_to: FIELD_A.employee_id, planned_start: '08:00', planned_end: '12:00',
  }), 201, 'ลงกะวันนี้');
  const visit = scheduled.visits.find((row) => row.visit_date === dateTH(0));
  assert.ok(visit, `ไม่พบกะวันนี้: ${brief(scheduled)}`);

  const checkoutTooSoon = await post(`/api/my/visits/${visit.visit_id}/check-out`, {}, FIELD_A);
  probe(
    checkoutTooSoon.status === 409,
    'เช็คเอาท์ได้ก่อนเช็คอิน ทำให้ชั่วโมงทำงานไม่มีจุดเริ่ม',
    `HTTP=${checkoutTooSoon.status} body=${brief(checkoutTooSoon.body)}`,
    'เช็คเอาท์ก่อนเช็คอินถูกกัน 409',
  );

  mustStatus(await post(`/api/cases/${main.case_id}/start`), 200, 'เริ่มให้บริการ');
  mustStatus(await post(`/api/my/visits/${visit.visit_id}/check-in`, { photo: PHOTO }, FIELD_A), 200, 'เช็คอิน');
  const closeOpenShift = await post(`/api/cases/${main.case_id}/close`);
  probe(
    closeOpenShift.status === 409 && closeOpenShift.body?.details?.pending?.open_shifts === 1,
    'ปิดเคสได้ทั้งที่พนักงานยังเช็คอินค้าง ทำให้ชั่วโมง/ค่าจ้างไม่ครบ',
    `HTTP=${closeOpenShift.status} body=${brief(closeOpenShift.body)}`,
    'ปิดเคสที่มีกะเช็คอินค้างถูกกัน 409 พร้อมบอก open_shifts=1',
  );

  const report = mustStatus(await post(`/api/my/visits/${visit.visit_id}/reports`, {
    report_date: dateTH(0), report_type: 'routine', shift: 'day',
    pulse: 72, symptoms: 'อาการคงที่', care_given: 'ดูแลตามแผน',
  }, FIELD_A), 201, 'ส่งรายงานประจำกะ');
  mustStatus(await post(`/api/my/visits/${visit.visit_id}/check-out`, {}, FIELD_A), 200, 'เช็คเอาท์');
  mustStatus(await post('/api/cases/attendance/decide', { visit_ids: [visit.visit_id], approve: true }), 200, 'อนุมัติกะ');

  const issueWithoutPlanCase = await createCase({ fee: 300, staff_pay: 100 });
  const issueWithoutPlanInvoice = await invoiceForCase(issueWithoutPlanCase.case_id);
  const issueWithoutPlan = await post(`/api/invoices/${issueWithoutPlanInvoice.invoice_id}/issue`);
  probe(
    issueWithoutPlan.status === 409,
    'ออกใบได้ก่อนเลือกแผนวางบิล ทำให้ไม่รู้ว่าจะเก็บเต็มหรือมัดจำ',
    `HTTP=${issueWithoutPlan.status} body=${brief(issueWithoutPlan.body)}`,
    'ออกใบก่อนเลือกแผนวางบิลถูกกัน 409',
  );

  await issueFull(invoice.invoice_id);
  mustStatus(await post(`/api/invoices/${invoice.invoice_id}/pay`, {
    request_id: randomUUID(), amount: 2000, payment_method: 'โอน',
  }), 200, 'รับชำระครบ');
  const released = mustStatus(await post(`/api/cases/${main.case_id}/pay/release`, { request_id: randomUUID(), amount: 1200 }), 201, 'ปล่อยค่าจ้าง');
  assert.equal(released.released, 1200, `ยอดปล่อยค่าจ้างไม่ตรง: ${brief(released)}`);
  const payout = await sql.one(
    'SELECT payout_id, employee_id, amount FROM case_payouts WHERE case_id = :id',
    { id: main.case_id },
  );
  assert.ok(payout, 'ต้องมี payout หลังปล่อยค่าจ้าง');
  const payroll = mustStatus(await post('/api/payroll/pay-now', {
    period_to: dateTH(0), payout_ids: [payout.payout_id], method: 'โอน',
  }), 201, 'จ่ายค่าจ้างจริง');
  mustStatus(await post(`/api/cases/${main.case_id}/close`), 200, 'ปิดเคส');

  const [caseStored, visitStored, invoiceStored, reportStored, payoutStored, runStored] = await Promise.all([
    sql.one('SELECT status FROM cases WHERE case_id = :id', { id: main.case_id }),
    sql.one('SELECT status, checked_in_by, check_in_at, check_out_at FROM case_visits WHERE visit_id = :id', { id: visit.visit_id }),
    sql.one('SELECT status FROM invoices WHERE invoice_id = :id', { id: invoice.invoice_id }),
    sql.one('SELECT report_id, reported_by FROM case_reports WHERE report_id = :id', { id: report.report_id }),
    sql.one('SELECT employee_id, amount FROM case_payouts WHERE payout_id = :id', { id: payout.payout_id }),
    sql.one('SELECT status FROM payroll_runs WHERE run_id = :id', { id: payroll.run_id }),
  ]);
  probe(
    caseStored?.status === 'closed' && visitStored?.status === 'done' && visitStored?.checked_in_by === FIELD_A.employee_id &&
      visitStored?.check_in_at && visitStored?.check_out_at && invoiceStored?.status === 'paid' &&
      reportStored?.reported_by === FIELD_A.employee_id && payoutStored?.employee_id === FIELD_A.employee_id &&
      Number(payoutStored?.amount) === 1200 && runStored?.status === 'paid',
    'วงจรที่ทำสำเร็จแล้วทิ้งข้อมูลบางช่วงหายหรือสถานะเงิน/งานไม่ตรงกัน',
    `case=${brief(caseStored)} visit=${brief(visitStored)} invoice=${brief(invoiceStored)} report=${brief(reportStored)} payout=${brief(payoutStored)} payroll=${brief(runStored)}`,
    'ครบวงจรแล้วเคสปิด กะ/รายงานครบ ใบ paid และค่าจ้างอยู่ในรอบ paid ของคนที่ทำจริง',
  );

  const [startClosed, reportClosed, scheduleClosed] = await Promise.all([
    post(`/api/cases/${main.case_id}/start`),
    post(`/api/my/visits/${visit.visit_id}/reports`, {
      report_date: dateTH(0), report_type: 'routine', shift: 'day', pulse: 70,
    }, FIELD_A),
    post(`/api/cases/${main.case_id}/visits/bulk`, { dates: [dateTH(1)] }),
  ]);
  probe(
    startClosed.status === 409 && reportClosed.status === 409 && scheduleClosed.status === 409,
    'เคสปิดแล้วยังเริ่มงาน ลงกะ หรือเพิ่มรายงานใหม่ได้',
    `start=${startClosed.status} report=${reportClosed.status} schedule=${scheduleClosed.status}`,
    'เคสปิดแล้วเริ่มงาน ลงกะ และเพิ่มรายงานใหม่ถูกกัน 409',
  );

  head('2 · เปิดเคสเดิมกลับมาและยกเลิกหลังจ่ายค่าจ้างแล้ว');
  {
    const before = {
      payments: await scalar('SELECT count(*) AS n FROM invoice_payments WHERE invoice_id = :id', { id: invoice.invoice_id }),
      reports: await scalar('SELECT count(*) AS n FROM case_reports WHERE case_id = :id', { id: main.case_id }),
      payouts: await scalar('SELECT count(*) AS n FROM case_payouts WHERE case_id = :id', { id: main.case_id }),
    };
    const reopened = await post(`/api/cases/${main.case_id}/reopen`);
    const afterReopenInvoice = await sql.one('SELECT status FROM invoices WHERE invoice_id = :id', { id: invoice.invoice_id });
    const paidLink = await sql.one(
      `SELECT r.status FROM payroll_payout_lines pl
       JOIN payroll_items i ON i.item_id = pl.item_id
       JOIN payroll_runs r ON r.run_id = i.run_id
       WHERE pl.payout_id = :id`,
      { id: payout.payout_id },
    );
    probe(
      reopened.status === 200 && reopened.body.status === 'assigned' &&
        afterReopenInvoice?.status === 'paid' && paidLink?.status === 'paid' &&
        (await scalar('SELECT count(*) AS n FROM invoice_payments WHERE invoice_id = :id', { id: invoice.invoice_id })) === before.payments &&
        (await scalar('SELECT count(*) AS n FROM case_reports WHERE case_id = :id', { id: main.case_id })) === before.reports &&
        (await scalar('SELECT count(*) AS n FROM case_payouts WHERE case_id = :id', { id: main.case_id })) === before.payouts,
      'เปิดเคสที่ปิดกลับมาแล้วใบรับเงิน ค่าจ้าง หรือรายงานเดิมถูกรีเซ็ต/นับซ้ำ',
      `reopen=${reopened.status}/${brief(reopened.body)} invoice=${brief(afterReopenInvoice)} payroll=${brief(paidLink)}`,
      'reopen กลับเป็น assigned โดยใบ paid ค่าจ้าง paid และรายงานเดิมไม่เปลี่ยน',
    );

    const cancelled = await post(`/api/cases/${main.case_id}/cancel`, { reason: 'ลูกค้ายกเลิกหลังเปิดกลับ' });
    const afterCancel = await Promise.all([
      scalar('SELECT count(*) AS n FROM invoice_payments WHERE invoice_id = :id', { id: invoice.invoice_id }),
      scalar('SELECT count(*) AS n FROM case_payouts WHERE payout_id = :id', { id: payout.payout_id }),
      scalar('SELECT count(*) AS n FROM payroll_payout_lines WHERE payout_id = :id', { id: payout.payout_id }),
    ]);
    probe(
      cancelled.status === 200 && cancelled.body.status === 'cancelled' &&
        afterCancel[0] === before.payments && afterCancel[1] === 1 && afterCancel[2] === 1,
      'ยกเลิกเคสหลังจ่ายค่าจ้างแล้วทำให้หลักฐานรับเงิน/จ่ายเงินหายหรือยกเลิกไม่ได้',
      `cancel=${cancelled.status}/${brief(cancelled.body)} payments=${afterCancel[0]} payout=${afterCancel[1]} payroll_link=${afterCancel[2]}`,
      'ยกเลิกกลางคันหลังจ่ายค่าจ้างได้ แต่หลักฐานรับเงินและจ่ายค่าจ้างยังอยู่ครบ',
    );
  }

  head('3 · เปลี่ยนผู้รับผิดชอบกลางคัน');
  {
    const kase = await createCase({ fee: 1500, staff_pay: 900 });
    mustStatus(await post(`/api/cases/${kase.case_id}/assign`, { employee_id: FIELD_A.employee_id }), 200, 'จับคู่คนเดิม');
    mustStatus(await post(`/api/cases/${kase.case_id}/start`), 200, 'เริ่มเคสเปลี่ยนคน');
    const scheduled = mustStatus(await post(`/api/cases/${kase.case_id}/visits/bulk`, {
      dates: [dateTH(0), dateTH(1)], assigned_to: FIELD_A.employee_id,
    }), 201, 'ลงกะเก่าและกะอนาคต');
    const worked = scheduled.visits.find((row) => row.visit_date === dateTH(0));
    const future = scheduled.visits.find((row) => row.visit_date === dateTH(1));
    mustStatus(await post(`/api/my/visits/${worked.visit_id}/check-in`, { photo: PHOTO }, FIELD_A), 200, 'คนเดิมเช็คอิน');
    mustStatus(await post(`/api/my/visits/${worked.visit_id}/check-out`, {}, FIELD_A), 200, 'คนเดิมเช็คเอาท์');
    mustStatus(await post(`/api/cases/${kase.case_id}/pay/release`, { request_id: randomUUID(), amount: 300 }), 201, 'ปล่อยค่าจ้างก้อนเก่า');
    const oldPayout = await sql.one(
      'SELECT payout_id, employee_id, amount FROM case_payouts WHERE case_id = :id ORDER BY payout_id LIMIT 1',
      { id: kase.case_id },
    );
    mustStatus(await post(`/api/cases/${kase.case_id}/assign`, { employee_id: FIELD_B.employee_id }), 200, 'เปลี่ยนผู้รับผิดชอบ');
    const [workedAfter, futureAfter, payoutAfter, caseAfter] = await Promise.all([
      sql.one('SELECT assigned_to, checked_in_by FROM case_visits WHERE visit_id = :id', { id: worked.visit_id }),
      sql.one('SELECT assigned_to, checked_in_by FROM case_visits WHERE visit_id = :id', { id: future.visit_id }),
      sql.one('SELECT employee_id, amount FROM case_payouts WHERE payout_id = :id', { id: oldPayout.payout_id }),
      sql.one('SELECT assigned_to, status FROM cases WHERE case_id = :id', { id: kase.case_id }),
    ]);
    probe(
      caseAfter?.assigned_to === FIELD_B.employee_id && caseAfter?.status === 'in_progress' &&
        workedAfter?.assigned_to === FIELD_A.employee_id && workedAfter?.checked_in_by === FIELD_A.employee_id &&
        futureAfter?.assigned_to === FIELD_B.employee_id && futureAfter?.checked_in_by == null &&
        payoutAfter?.employee_id === FIELD_A.employee_id && Number(payoutAfter?.amount) === 300,
      'เปลี่ยนผู้รับผิดชอบแล้วกะ/ค่าจ้างเก่าถูกย้ายให้คนใหม่ หรือกะอนาคตยังค้างคนเดิม',
      `case=${brief(caseAfter)} worked=${brief(workedAfter)} future=${brief(futureAfter)} old_payout=${brief(payoutAfter)}`,
      'เปลี่ยนคนกลางคัน: กะและค่าจ้างที่เกิดแล้วอยู่คนเดิม ส่วนกะอนาคตย้ายให้คนใหม่',
    );
  }

  head('4 · ต่อเคสรอบใหม่');
  {
    const source = await createCase({
      fee: 2400,
      staff_pay: 1400,
      assigned_to: FIELD_A.employee_id,
      address: 'บ้านเดิมสำหรับต่อเคส',
      medical_history: 'ข้อมูลรอบเดิม',
    });
    mustStatus(await post(`/api/cases/${source.case_id}/team`, { employee_id: FIELD_B.employee_id }), 200, 'เพิ่มทีมรอบเดิม');
    const sourceVisit = mustStatus(await post(`/api/cases/${source.case_id}/visits/bulk`, {
      dates: [dateTH(1)], assigned_to: FIELD_A.employee_id,
    }), 201, 'ลงกะรอบเดิม').visits[0];
    await sql.run(
      `INSERT INTO case_reports (case_id, report_date, pulse, reported_by, reported_by_name)
       VALUES (:id, :today, 75, :employee, 'พนักงานรอบเดิม')`,
      { id: source.case_id, today: dateTH(0), employee: FIELD_A.employee_id },
    );
    await sql.run(
      `INSERT INTO case_payouts (case_id, employee_id, employee_name, amount, released_by_name)
       VALUES (:id, :employee, 'พนักงานรอบเดิม', 100, 'ผู้จัดการ')`,
      { id: source.case_id, employee: FIELD_A.employee_id },
    );
    mustStatus(await post(`/api/cases/${source.case_id}/close`, { force: true }), 200, 'ปิดรอบเดิม');
    const sourceInvoice = await invoiceForCase(source.case_id);

    const renewed = await createCase({
      renewed_from: source.case_id,
      assigned_to: FIELD_A.employee_id,
      client_name: source.client_name,
      fee: 2400,
      staff_pay: 1400,
      address: source.address,
      medical_history: source.medical_history,
    });
    const renewedInvoice = await invoiceForCase(renewed.case_id);
    const [team, counts, oldInvoiceStill] = await Promise.all([
      get(`/api/cases/${renewed.case_id}/team`),
      sql.one(
        `SELECT
           (SELECT COUNT(*) FROM case_visits WHERE case_id = :id) AS visits,
           (SELECT COUNT(*) FROM case_reports WHERE case_id = :id) AS reports,
           (SELECT COUNT(*) FROM case_payouts WHERE case_id = :id) AS payouts`,
        { id: renewed.case_id },
      ),
      sql.one('SELECT case_id, status FROM invoices WHERE invoice_id = :id', { id: sourceInvoice.invoice_id }),
    ]);
    probe(
      renewed.renewed_from === source.case_id && renewed.round_no === 2 && renewed.assigned_to === FIELD_A.employee_id &&
        renewed.address === source.address && renewed.medical_history === source.medical_history &&
        team.status === 200 && team.body.some((row) => row.employee_id === FIELD_B.employee_id) &&
        Number(counts.visits) === 0 && Number(counts.reports) === 0 && Number(counts.payouts) === 0 &&
        renewedInvoice.invoice_id !== sourceInvoice.invoice_id && renewedInvoice.case_id === renewed.case_id &&
        oldInvoiceStill?.case_id === source.case_id && sourceVisit.visit_id != null,
      'ต่อเคสแล้วประวัติ/เงินรอบเก่าปนรอบใหม่ หรือทีมและสายรอบไม่ตามมา',
      `renewed=${brief(renewed)} team=${brief(team.body)} counts=${brief(counts)} old_invoice=${brief(oldInvoiceStill)} new_invoice=${brief(renewedInvoice)}`,
      'รอบใหม่ได้ round_no/สายต่อ/ทีมและข้อมูลฟอร์มที่คัดลอก แต่กะ รายงาน ค่าจ้าง และใบของรอบเก่าไม่ปนมา',
    );

    const duplicateDirect = await post('/api/cases', {
      case_id: nextCaseId(), case_type: 'other', client_name: 'รอบซ้ำที่ต้องถูกกัน',
      fee: 2400, staff_pay: 1400, renewed_from: source.case_id,
    });
    probe(
      duplicateDirect.status === 409,
      'ต่อเคสรอบเดิมซ้ำได้ ทำให้สัญญารอบเดียวมีสองเคสและสองใบเรียกเก็บ',
      `HTTP=${duplicateDirect.status} body=${brief(duplicateDirect.body)}`,
      'ต่อเคสต้นทางที่มีรอบใหม่เดินอยู่แล้วถูกกัน 409',
    );
  }

  head('5 · พฤติกรรมที่ตั้งใจให้ยืดหยุ่น');
  {
    const untouched = await createCase({ fee: 500, staff_pay: 200 });
    const closedBeforeStart = await post(`/api/cases/${untouched.case_id}/close`);
    info(
      closedBeforeStart.status === 200
        ? 'เคสที่ยังไม่เริ่มและไม่มีกะปิดเป็น closed ได้ — ไม่จัดเป็นบัค: อาจเป็นงานที่จบด้านเอกสาร; ถ้าต้องบังคับให้ใช้ “ยกเลิก” ต้องเป็นคำตัดสินธุรกิจ'
        : `เคสยังไม่เริ่มปิดได้สถานะ ${closedBeforeStart.status}`,
    );
  }

  console.log(`\n=== สรุป: ${checks} จุด · พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${passed.length} จุด · ข้อสังเกต ${observations.length} ===`);
  for (const item of found) console.log(`- ${item.title}: ${item.detail}`);
  for (const item of observations) console.log(`- INFO: ${item}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
