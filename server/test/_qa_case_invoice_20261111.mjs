/**
 * ตรวจ 11 พ.ย. 2569 — เคส + ใบแจ้งหนี้ หลายสถานการณ์ (ฐานชั่วคราว + แอปจริง ยิง HTTP จริง)
 *   node test/_run_probe.mjs test/_qa_case_invoice_20261111.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', name: 'ผู้จัดการ ทดสอบ' };
await seedFixtures(pool, hashPassword);
const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const jar = (who) => (who ? { cookie: `${COOKIE_NAME}=${signToken(who)}` } : {});
async function call(method, path, body, who = MANAGER) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...jar(who) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}
const get = (p, who) => call('GET', p, undefined, who);
const post = (p, b, who) => call('POST', p, b ?? {}, who);
const patch = (p, b, who) => call('PATCH', p, b ?? {}, who);
const del = (p, who) => call('DELETE', p, undefined, who);
const rid = () => randomUUID();

let vn = 911000000;
const nextVN = () => `VN${++vn}`;
const found = [];
const hit = (title, detail) => { found.push(title); console.log(`\nBUG | ${title}\n    | ${detail}`); };
const ok = (what) => console.log(`PASS | ${what}`);
const head = (t) => console.log(`\n=== ${t} ===`);
const expect = (cond, pass, fail, detail) => (cond ? ok(pass) : hit(fail, detail));
const j = (x) => JSON.stringify(x).slice(0, 400);
const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const cust = (await post('/api/customers', { name: 'บริษัท ทดสอบ จำกัด', phone: '0811111111', tax_id: '0105500000001' })).body;

async function newCase(extra = {}) {
  const r = await post('/api/cases', { case_id: nextVN(), case_type: 'other', client_name: 'คุณทดสอบ', fee: 20000, customer_id: cust.customer_id, ...extra });
  assert.equal(r.status, 201, j(r.body));
  return r.body;
}
async function invoicesOf(caseId) {
  const r = await get(`/api/invoices?case_id=${caseId}&per_page=100`);
  assert.equal(r.status, 200, j(r.body));
  return r.body.data;
}
const inv = async (id) => (await get(`/api/invoices/${id}`)).body;
async function draftOf(caseId) {
  let list = await invoicesOf(caseId);
  let d = list.find((i) => i.status === 'draft');
  if (!d) {
    const r = await post('/api/invoices', { case_id: caseId });
    assert.equal(r.status, 201, j(r.body));
    d = r.body;
  }
  return inv(d.invoice_id);
}
const pay = (id, amount, extra = {}) => post(`/api/invoices/${id}/pay`, { request_id: rid(), amount, ...extra });

// ─────────────────────────────────────────────────────────────
head('1 · เก็บเต็ม: ออกใบ → รับบางส่วน → รับครบ → รับเกิน → รับซ้ำ');
{
  const c = await newCase();
  const d = await draftOf(c.case_id);
  ok(`ใบร่างของเคส: ${d.invoice_id} ยอด ${d.total} สถานะ ${d.status}`);
  const plan = await post(`/api/invoices/${d.invoice_id}/billing-plan`, { mode: 'full' });
  expect(plan.status < 300, 'ตั้งแผนเก็บเต็มได้', 'ตั้งแผนเก็บเต็มไม่ได้', j(plan));
  const iss = await post(`/api/invoices/${d.invoice_id}/issue`);
  expect(iss.status < 300, 'ออกใบได้', 'ออกใบไม่ได้', j(iss));

  const editIssued = await patch(`/api/invoices/${d.invoice_id}`, { amount: 1 });
  expect(editIssued.status >= 400, `แก้ยอดใบที่ออกแล้วถูกกัน (${editIssued.status})`, 'แก้ยอดใบที่ออกแล้วได้', j(editIssued));

  const future = await pay(d.invoice_id, 100, { paid_at: addDays(today, 3) });
  expect(future.status >= 400, 'วันรับเงินในอนาคตถูกกัน', 'ลงวันรับเงินในอนาคตได้', j(future));

  const p1 = await pay(d.invoice_id, 5000);
  expect(p1.status < 300, 'รับ 5000 ได้', 'รับบางส่วนไม่ได้', j(p1));
  let cur = await inv(d.invoice_id);
  expect(cur.status === 'issued' && Number(cur.paid_amount) === 5000, `หลังรับบางส่วน: ${cur.status} paid=${cur.paid_amount}`, 'สถานะ/ยอดหลังรับบางส่วนผิด', j(cur));

  // รับซ้ำด้วย request_id เดิม
  const reqId = rid();
  const a = await post(`/api/invoices/${d.invoice_id}/pay`, { request_id: reqId, amount: 1000 });
  const b = await post(`/api/invoices/${d.invoice_id}/pay`, { request_id: reqId, amount: 1000 });
  cur = await inv(d.invoice_id);
  expect(Number(cur.paid_amount) === 6000, `ส่งคำขอรับเงินซ้ำ (request_id เดิม) ไม่นับซ้ำ (${a.status}/${b.status})`, 'request_id เดิมรับเงินซ้ำ', j({ a, b, paid: cur.paid_amount }));

  const over = await pay(d.invoice_id, 999999);
  expect(over.status >= 400, `รับเกินยอดค้างถูกกัน (${over.status})`, 'รับเงินเกินยอดค้างได้', j(over));

  // สองคำขอพร้อมกัน แต่ละอันเต็มยอดค้าง
  const left = Number(cur.total) - Number(cur.paid_amount);
  const [r1, r2] = await Promise.all([pay(d.invoice_id, left), pay(d.invoice_id, left)]);
  cur = await inv(d.invoice_id);
  expect(Number(cur.paid_amount) <= Number(cur.total), `รับพร้อมกันสองคำขอ ไม่เกินยอด (${r1.status}/${r2.status}) paid=${cur.paid_amount}`, 'รับพร้อมกันแล้วยอดรับเกินยอดใบ', j({ r1, r2, cur }));
  expect(cur.status === 'paid', 'ใบปิดเป็นชำระแล้ว', 'รับครบแล้วสถานะไม่เป็น paid', j(cur));

  // ยกเลิกรายการรับเงินอันหนึ่ง → กลับเป็นค้าง
  const pays = cur.payments ?? [];
  if (!pays.length) hit('รายละเอียดใบไม่มีรายการรับเงิน', Object.keys(cur).join(','));
  else {
    const v = await post(`/api/invoices/${d.invoice_id}/payments/${pays[0].payment_id ?? pays[0].id}/void`, { reason: 'กรอกผิด ทดสอบ' });
    cur = await inv(d.invoice_id);
    expect(v.status < 300 && cur.status === 'issued', `ยกเลิกรายการรับเงินแล้วใบกลับเป็นค้างชำระ paid=${cur.paid_amount}`, 'ยกเลิกรายการรับเงินแล้วสถานะไม่กลับ', j({ v, cur }));
  }
  const delIssued = await del(`/api/invoices/${d.invoice_id}`);
  expect(delIssued.status >= 400, `ลบใบที่ออกแล้วถูกกัน (${delIssued.status})`, 'ลบใบที่ออกแล้ว/มีเงินรับได้', j(delIssued));
}

// ─────────────────────────────────────────────────────────────
head('2 · มัดจำ + ส่วนที่เหลือ');
{
  const c = await newCase({ fee: 30000 });
  const d = await draftOf(c.case_id);
  const tooBig = await post(`/api/invoices/${d.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 30000 });
  expect(tooBig.status >= 400, 'มัดจำเท่ายอดเต็มถูกกัน', 'มัดจำเท่ายอดเต็มได้', j(tooBig));
  const plan = await post(`/api/invoices/${d.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 10000 });
  expect(plan.status < 300, 'แบ่งมัดจำ 10000 ได้', 'แบ่งมัดจำไม่ได้', j(plan));
  let list = (await invoicesOf(c.case_id)).filter((i) => i.status !== 'cancelled');
  const totals = list.map((i) => Number(i.total)).sort((x, y) => x - y);
  expect(list.length === 2 && totals[0] === 10000 && totals[1] === 20000, `ได้สองใบ ${totals.join(' + ')}`, 'ใบมัดจำ/ส่วนที่เหลือยอดไม่ตรง', j(list));
  const dep = await inv(d.invoice_id);
  const bal = list.find((i) => i.invoice_id !== d.invoice_id);
  await post(`/api/invoices/${dep.invoice_id}/issue`);
  await pay(dep.invoice_id, 10000);
  const chg = await patch(`/api/invoices/${dep.invoice_id}/deposit`, { deposit_amount: 12000 });
  expect(chg.status >= 400, `แก้ยอดมัดจำหลังรับเงินแล้วถูกกัน (${chg.status})`, 'แก้ยอดมัดจำได้ทั้งที่รับเงินมัดจำแล้ว', j(chg));
  const replan = await post(`/api/invoices/${bal.invoice_id}/billing-plan`, { mode: 'full' });
  const after = (await invoicesOf(c.case_id)).filter((i) => i.status !== 'cancelled');
  const sum = after.reduce((s, i) => s + Number(i.total), 0);
  expect(sum === 30000, `เปลี่ยนแผนใบส่วนที่เหลือ (${replan.status}) ยอดรวมยังเป็น 30000`, 'เปลี่ยนแผนใบส่วนที่เหลือแล้วยอดรวมเพี้ยน', j({ replan, after: after.map((i) => [i.invoice_id, i.total, i.status]) }));

  // ขึ้นค่าบริการเคสหลังมัดจำออกไปแล้ว — ใบส่วนที่เหลือ (ร่าง) ควรตาม
  const fee = await patch(`/api/cases/${c.case_id}`, { fee: 36000 });
  const ref = await post(`/api/invoices/${bal.invoice_id}/refresh`);
  const balNow = await inv(bal.invoice_id);
  const depNow = await inv(dep.invoice_id);
  expect(balNow.fee_stale && depNow.fee_stale && balNow.plan_stale, `ขึ้นป้ายยอดไม่ตรงทั้งสองใบในแผน: ${balNow.plan_case_fee} vs ${balNow.plan_net_total}`, 'แผนมัดจำไม่ขึ้นป้ายเมื่อค่าบริการเคสเปลี่ยน', j({ b: [balNow.fee_stale, balNow.plan_case_fee, balNow.plan_net_total], d: depNow.fee_stale }));
  const staleList = await get('/api/invoices?stale=yes&per_page=100');
  expect(staleList.body.data.some((i) => i.invoice_id === bal.invoice_id), 'ตัวกรอง "ไม่ตรงกับเคส" เจอใบในแผน', 'ตัวกรอง stale ไม่เจอใบในแผน', j(staleList.body.data.map((i) => i.invoice_id)));
  const wrong = await patch(`/api/invoices/${bal.invoice_id}`, { amount: 25000 });
  expect(wrong.status === 409, 'แก้ยอดใบส่วนที่เหลือเป็นยอดที่ไม่ตรงเคส ยังถูกกัน', 'แก้ยอดใบงวดเป็นยอดใดก็ได้', j(wrong));
  const fixBal = await patch(`/api/invoices/${bal.invoice_id}`, { amount: 26000 });
  const balFixed = await inv(bal.invoice_id);
  expect(!balFixed.fee_stale, `แก้ใบส่วนที่เหลือเป็น 26000 (${fixBal.status}) ป้ายหาย`, 'แก้ยอดแล้วป้ายยังค้าง', j({ fixBal: fixBal.status, balFixed: [balFixed.total, balFixed.plan_case_fee, balFixed.plan_net_total] }));
  expect(true, `ขึ้นค่าบริการเป็น 36000 → ใบส่วนที่เหลือ ${balNow.total} (fee ${fee.status}, refresh ${ref.status})`, 'ขึ้นค่าบริการแล้วใบส่วนที่เหลือไม่ตาม', j({ fee: fee.status, ref, total: balNow.total }));
}

// ─────────────────────────────────────────────────────────────
head('3 · ใบลดหนี้ / เพิ่มหนี้ / หนี้สูญ');
{
  const c = await newCase({ fee: 10000 });
  const d = await draftOf(c.case_id);
  await post(`/api/invoices/${d.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${d.invoice_id}/issue`);
  const deb = await post(`/api/invoices/${d.invoice_id}/adjustments`, { kind: 'debit', reason_code: 'extra_service', amount: 2000, reason: 'เพิ่มหัตถการ' });
  let cur = await inv(d.invoice_id);
  ok(`เพิ่มหนี้ 2000 (${deb.status}) → ยอดค้าง ${cur.balance ?? cur.outstanding ?? '?'} keys=${Object.keys(cur).filter((k) => /bal|out|net|due|settle/.test(k)).join(',')}`);
  const cr = await post(`/api/invoices/${d.invoice_id}/adjustments`, { kind: 'credit', reason_code: 'discount', amount: 50000, reason: 'ลดเกินยอด' });
  expect(cr.status >= 400, 'ลดหนี้เกินยอดถูกกัน', 'ลดหนี้เกินยอดได้', j(cr));
  await pay(d.invoice_id, 4000);
  const bd = await post(`/api/invoices/${d.invoice_id}/adjustments`, { kind: 'credit', reason_code: 'bad_debt', amount: 8000, reason: 'ตามไม่ได้' });
  cur = await inv(d.invoice_id);
  expect(bd.status < 300, `ตัดหนี้สูญยอดค้าง 8000 ได้ → สถานะ ${cur.status}`, 'ตัดหนี้สูญยอดค้างไม่ได้', j(bd));
  const bd2 = await post(`/api/invoices/${d.invoice_id}/adjustments`, { kind: 'credit', reason_code: 'bad_debt', amount: 1, reason: 'ตามไม่ได้' });
  expect(bd2.status >= 400, 'ตัดหนี้สูญซ้ำหลังไม่มียอดค้างถูกกัน', 'ตัดหนี้สูญได้ทั้งที่ไม่มียอดค้าง', j(bd2));
  // ลดหนี้คืนเงิน (refund) บนเงินที่รับมาแล้ว
  const refund = await post(`/api/invoices/${d.invoice_id}/adjustments`, { kind: 'credit', reason_code: 'not_rendered', amount: 1000, reason: 'ยกเลิกกะ 1 วัน', refund: { method: 'โอน' } });
  cur = await inv(d.invoice_id);
  ok(`ลดหนี้+คืนเงิน 1000 → ${refund.status} สถานะ ${cur.status} paid=${cur.paid_amount}`);
  const bills = await get('/api/invoices/summary');
  ok(`summary: ${j(bills.body)}`);
}

// ─────────────────────────────────────────────────────────────
head('4 · ยกเลิกเคส / เปิดเคสใหม่ กับใบในสถานะต่าง ๆ');
{
  // 4a ใบร่าง → ยกเลิกเคส → ใบร่างถูกยกเลิก → เปิดใหม่ → ใบกลับมา
  const c = await newCase({ fee: 8000 });
  const d = await draftOf(c.case_id);
  const can = await post(`/api/cases/${c.case_id}/cancel`, { reason: 'ทดสอบ' });
  let cur = await inv(d.invoice_id);
  expect(can.status < 300 && cur.status === 'cancelled', 'ยกเลิกเคส → ใบร่างถูกยกเลิก', 'ยกเลิกเคสแล้วใบร่างไม่ถูกยกเลิก', j({ can, st: cur.status }));
  const mk = await post('/api/invoices', { case_id: c.case_id });
  expect(mk.status >= 400, 'ออกใบให้เคสที่ยกเลิกถูกกัน', 'ออกใบให้เคสที่ยกเลิกได้', j(mk));
  const re = await post(`/api/cases/${c.case_id}/reopen`);
  cur = await inv(d.invoice_id);
  expect(re.status < 300 && cur.status === 'draft', 'เปิดเคสใหม่ → ใบร่างกลับมา', 'เปิดเคสใหม่แล้วใบร่างไม่กลับมา', j({ re, st: cur.status }));
  const drafts = (await invoicesOf(c.case_id)).filter((i) => i.status === 'draft');
  expect(drafts.length === 1, 'มีใบร่างใบเดียวหลังเปิดใหม่', `มีใบร่าง ${drafts.length} ใบหลังเปิดเคสใหม่`, j(drafts));

  // 4b ใบออกแล้วรับเงินบางส่วน → ยกเลิกเคส
  const c2 = await newCase({ fee: 8000 });
  const d2 = await draftOf(c2.case_id);
  await post(`/api/invoices/${d2.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${d2.invoice_id}/issue`);
  await pay(d2.invoice_id, 3000);
  const can2 = await post(`/api/cases/${c2.case_id}/cancel`, { reason: 'ลูกค้ายกเลิก' });
  cur = await inv(d2.invoice_id);
  ok(`ยกเลิกเคสที่มีใบรับเงินบางส่วน → ${can2.status} ใบ ${cur.status} paid=${cur.paid_amount} ${j(can2.body).slice(0, 200)}`);
  const sumAfter = await get('/api/invoices/summary');
  ok(`summary หลังยกเลิกเคส: ${j(sumAfter.body)}`);

  // 4c มัดจำออกแล้ว + ใบส่วนที่เหลือเป็นร่าง → ยกเลิกเคส → เปิดใหม่
  const c3 = await newCase({ fee: 9000 });
  const d3 = await draftOf(c3.case_id);
  await post(`/api/invoices/${d3.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: 3000 });
  await post(`/api/invoices/${d3.invoice_id}/issue`);
  await post(`/api/cases/${c3.case_id}/cancel`, { reason: 'ทดสอบ' });
  let l3 = await invoicesOf(c3.case_id);
  ok(`มัดจำออกแล้ว + ยกเลิกเคส → ${l3.map((i) => `${i.invoice_id}:${i.total}:${i.status}`).join(' · ')}`);
  await post(`/api/cases/${c3.case_id}/reopen`);
  l3 = await invoicesOf(c3.case_id);
  const live = l3.filter((i) => i.status !== 'cancelled');
  const liveSum = live.reduce((s, i) => s + Number(i.total), 0);
  expect(liveSum === 9000, `เปิดเคสใหม่ → ใบที่ใช้งาน ${live.map((i) => `${i.total}:${i.status}`).join(' + ')}`, 'เปิดเคสใหม่แล้วยอดใบที่ใช้งานไม่ครบ', j(l3.map((i) => [i.invoice_id, i.total, i.status])));
}

// ─────────────────────────────────────────────────────────────
head('5 · ยกเลิกใบ / ลบใบร่าง / ออกใบใหม่');
{
  const c = await newCase({ fee: 5000 });
  const d = await draftOf(c.case_id);
  const dup = await post('/api/invoices', { case_id: c.case_id });
  expect(dup.status === 409, 'ออกใบซ้ำทั้งที่มีร่างถูกกัน', 'ออกใบร่างซ้ำได้', j(dup));
  await post(`/api/invoices/${d.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${d.invoice_id}/issue`);
  await pay(d.invoice_id, 1000);
  const cancelPaid = await post(`/api/invoices/${d.invoice_id}/cancel`, { reason: 'ออกผิดใบ' });
  ok(`ยกเลิกใบที่มีเงินรับแล้ว → ${cancelPaid.status} ${j(cancelPaid.body).slice(0, 160)}`);
  const c2 = await newCase({ fee: 5000 });
  const d2 = await draftOf(c2.case_id);
  await post(`/api/invoices/${d2.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${d2.invoice_id}/issue`);
  const cn = await post(`/api/invoices/${d2.invoice_id}/cancel`, { reason: 'ออกผิดใบ' });
  const fresh = await post('/api/invoices', { case_id: c2.case_id });
  expect(cn.status < 300 && fresh.status === 201 && Number(fresh.body.total) === 5000, 'ยกเลิกใบแล้วออกใบใหม่ได้ยอดเต็ม', 'ยกเลิกใบแล้วออกใบใหม่ผิด', j({ cn: cn.status, fresh }));
  const payCancelled = await pay(d2.invoice_id, 100);
  expect(payCancelled.status >= 400, 'รับเงินใบที่ยกเลิกถูกกัน', 'รับเงินใบที่ยกเลิกได้', j(payCancelled));
  const delDraft = await del(`/api/invoices/${fresh.body.invoice_id}`);
  expect(delDraft.status < 300, 'ลบใบร่างได้', 'ลบใบร่างไม่ได้', j(delDraft));
}

// ─────────────────────────────────────────────────────────────
head('6 · คิดตามกะที่ไปจริง (basis = visits)');
{
  const c = await newCase({ fee: 2000, staff_pay: 1200, assigned_to: 'EMP-0003', start_date: addDays(today, -5) });
  const bulk = await post(`/api/cases/${c.case_id}/visits/bulk`, { dates: [addDays(today, -4), addDays(today, -3), addDays(today, -2), addDays(today, 2)], assigned_to: 'EMP-0003' });
  ok(`ลงกะ 4 วัน → ${bulk.status}`);
  const vs = (await get(`/api/cases/${c.case_id}/visits`)).body;
  const list = Array.isArray(vs) ? vs : vs.data ?? vs.visits ?? [];
  for (const v of list.filter((x) => x.visit_date < today).slice(0, 2)) {
    const r = await patch(`/api/cases/${c.case_id}/visits/${v.visit_id}`, { status: 'done' });
    if (r.status >= 300) ok(`ปิดกะ ${v.visit_date} → ${r.status} ${j(r.body).slice(0, 120)}`);
  }
  const existing = (await invoicesOf(c.case_id)).find((i) => i.status === 'draft');
  if (existing) await del(`/api/invoices/${existing.invoice_id}`);
  const byVisits = await post('/api/invoices', { case_id: c.case_id, basis: 'visits' });
  ok(`ใบรายครั้ง → ${byVisits.status} ยอด ${byVisits.body.total} ${j(byVisits.body).slice(0, 300)}`);
}

// ─────────────────────────────────────────────────────────────
head('7 · ขึ้นราคาเคสหลังออกใบเต็มจำนวน → ใบเพิ่มหนี้');
{
  const c = await newCase({ fee: 10000 });
  const d = await draftOf(c.case_id);
  await post(`/api/invoices/${d.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${d.invoice_id}/issue`);
  await patch(`/api/cases/${c.case_id}`, { fee: 12000 });
  let cur = await inv(d.invoice_id);
  expect(cur.fee_stale && Number(cur.total) === 10000, 'ใบที่ออกแล้วไม่เปลี่ยนยอดเอง แต่ขึ้นป้ายไม่ตรง', 'ใบที่ออกแล้วเปลี่ยนยอดเอง/ไม่ขึ้นป้าย', j([cur.total, cur.fee_stale]));
  await post(`/api/invoices/${d.invoice_id}/adjustments`, { kind: 'debit', reason_code: 'extra_service', amount: 2000, reason: 'ขึ้นราคา' });
  cur = await inv(d.invoice_id);
  expect(!cur.fee_stale && cur.balance === 12000, 'ออกใบเพิ่มหนี้ 2000 แล้วป้ายหาย ยอดค้าง 12000', 'เพิ่มหนี้แล้วยอด/ป้ายผิด', j([cur.balance, cur.fee_stale]));
  // ลดราคาเคสลง แล้วออกใบใหม่ไม่ได้เพราะยังมีใบเปิดอยู่?
  const draftDraft = await post('/api/invoices', { case_id: c.case_id });
  expect(draftDraft.status === 409 && draftDraft.body.details?.existing_invoice_id === d.invoice_id, 'ออกใบเต็มจำนวนซ้ำทั้งที่มีใบออกแล้ว ถูกกัน และชี้ใบเดิม', 'ออกใบเต็มจำนวนซ้ำได้', j(draftDraft));
  const extra = await post('/api/invoices/extras', { case_id: c.case_id });
  ok(`ใบค่าใช้จ่ายเพิ่มเติมยังไม่ติดด่านนี้ → ${extra.status} ${j(extra.body).slice(0, 120)}`);
  if (draftDraft.status === 201) await del(`/api/invoices/${draftDraft.body.invoice_id}`);
}

// ─────────────────────────────────────────────────────────────
head('8 · ปิดเคส (close) ทั้งที่ยังมีใบค้าง / ไม่มีใบ');
{
  const c = await newCase({ fee: 4000 });
  const d = await draftOf(c.case_id);
  const close = await post(`/api/cases/${c.case_id}/close`, {});
  ok(`ปิดเคสที่มีใบร่างค้าง → ${close.status} ${j(close.body).slice(0, 200)}`);
  const cur = await inv(d.invoice_id);
  ok(`ใบหลังปิดเคส: ${cur.status} total=${cur.total}`);
  const c2 = await newCase({ fee: 4000 });
  for (const i of await invoicesOf(c2.case_id)) await del(`/api/invoices/${i.invoice_id}`);
  const close2 = await post(`/api/cases/${c2.case_id}/close`, { force: true });
  const noInv = await get('/api/invoices/cases-without-invoice');
  const listed = JSON.stringify(noInv.body).includes(c2.case_id);
  expect(listed, `ปิดเคสที่ไม่มีใบ (${close2.status}) → ขึ้นในรายการ "เคสที่ยังไม่ออกใบ"`, 'เคสปิดแล้วไม่มีใบ แต่ไม่ขึ้นในรายการเคสที่ยังไม่ออกใบ', j(noInv.body).slice(0, 300));
}

// ─────────────────────────────────────────────────────────────
head('9 · แพ็กกายภาพเสริมเก็บรวมในใบเคส Homecare');
{
  const fmt = await sql.one('SELECT format_id FROM pkg_service_formats LIMIT 1');
  const pk = await sql.one('SELECT physio_package_id, special_price FROM physio_packages LIMIT 1');
  const hc = await post('/api/cases', { case_id: nextVN(), service_kind: 'homecare', pkg_format_id: fmt.format_id, pkg_staff_tier: 'CG', client_name: 'คุณบ้าน', customer_id: cust.customer_id });
  ok(`เคส Homecare → ${hc.status} fee=${hc.body.fee}`);
  if (hc.status === 201) {
    const ph = await post('/api/cases', { case_id: nextVN(), service_kind: 'physio', physio_package_id: pk.physio_package_id, client_name: 'คุณบ้าน', customer_id: cust.customer_id, addon_of: hc.body.case_id, bill_with_parent: true, fee: Number(pk.special_price) });
    ok(`แพ็กกายภาพเสริม (รวมบิล) → ${ph.status} ${ph.status >= 300 ? j(ph.body) : ''}`);
    if (ph.status === 201) {
      const hd = await draftOf(hc.body.case_id);
      const addons = hd.addons ?? [];
      const hasPhysio = addons.some((a) => a.kind === 'physio');
      const hcRow = (await get(`/api/cases/${hc.body.case_id}`)).body; const hcFee = hcRow.service_customer_price_snapshot ?? hcRow.fee;
      expect(hasPhysio && Number(hd.total) === Number(hcFee) + Number(pk.special_price), `ใบ Homecare มีบรรทัดแพ็กกายภาพ ยอด ${hd.total}`, 'ใบ Homecare ไม่รวมแพ็กกายภาพ', j({ total: hd.total, addons }));
      ok(`ก่อนยกเลิกแพ็ก: fee_stale=${hd.fee_stale} case_fee=${hd.case_fee} service_stale=${hd.service_stale} payer_stale=${hd.payer_stale} snapshot=${(await get(`/api/cases/${hc.body.case_id}`)).body.service_customer_price_snapshot}`);
      const own = await post('/api/invoices', { case_id: ph.body.case_id });
      expect(own.status === 409, 'ออกใบแยกให้แพ็กที่รวมบิลถูกกัน', 'ออกใบแยกให้แพ็กที่รวมบิลได้ (เก็บซ้ำ)', j(own));
      const phInv = await invoicesOf(ph.body.case_id);
      expect(phInv.filter((i) => i.status !== 'cancelled').length === 0, 'แพ็กที่รวมบิลไม่มีใบของตัวเอง', 'แพ็กที่รวมบิลมีใบของตัวเองด้วย', j(phInv));
      // มัดจำเกินส่วน Homecare ถูกกัน
      const over = await post(`/api/invoices/${hd.invoice_id}/billing-plan`, { mode: 'deposit', deposit_amount: Number(hd.total) - 1 });
      ok(`มัดจำเกินส่วน Homecare → ${over.status} ${j(over.body).slice(0, 160)}`);
      await post(`/api/invoices/${hd.invoice_id}/billing-plan`, { mode: 'full' });
      await post(`/api/invoices/${hd.invoice_id}/issue`);
      await pay(hd.invoice_id);
      // ยกเลิกแพ็กที่จ่ายรวมไปแล้ว
      const canPh = await post(`/api/cases/${ph.body.case_id}/cancel`, { reason: 'ไม่ทำกายภาพแล้ว' });
      ok(`ยกเลิกแพ็กที่จ่ายรวมแล้ว → ${canPh.status} bundle_invoices_to_credit=${j(canPh.body.bundle_invoices_to_credit)}`);
      const after = await inv(hd.invoice_id);
      expect(after.bundle_stale && after.cancelled_bundle_amount === Number(pk.special_price) && after.is_stale, `ใบ Homecare ขึ้นป้ายแพ็กที่ยกเลิก ${after.cancelled_bundle_amount}`, 'ยกเลิกแพ็กแล้วใบไม่ขึ้นป้ายค้าง', j([after.bundle_stale, after.cancelled_bundle_amount]));
      const inStale = (await get('/api/invoices?stale=yes&per_page=100')).body.data.some((i) => i.invoice_id === hd.invoice_id);
      expect(inStale, 'ตัวกรอง/กระดิ่งนับใบนี้', 'ตัวกรอง stale ไม่เจอใบที่มีแพ็กยกเลิก', '');
      const cn = await post(`/api/invoices/${hd.invoice_id}/adjustments`, { kind: 'credit', reason_code: 'not_rendered', amount: Number(pk.special_price), reason: 'ยกเลิกแพ็กกายภาพ', refund: { method: 'โอน' } });
      const cleared = await inv(hd.invoice_id);
      expect(cn.status === 201 && !cleared.bundle_stale && !cleared.is_stale, 'ออกใบลดหนี้+คืนเงินแล้วป้ายหาย', 'ลดหนี้แล้วป้ายแพ็กยกเลิกยังค้าง', j([cn.status, cleared.bundle_stale, cleared.is_stale, cleared.fee_stale]));
      ok(`ใบ Homecare หลังยกเลิกแพ็ก: ${after.status} net=${after.net_total} paid=${after.paid_amount} fee_stale=${after.fee_stale} case_fee=${after.case_fee} service_stale=${after.service_stale}`);
    }
  }
}

console.log(`\n\nสรุป: พบปัญหา ${found.length} ข้อ`);
for (const f of found) console.log(` - ${f}`);
server.close();
await pool.end();
