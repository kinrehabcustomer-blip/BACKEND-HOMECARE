/**
 * ตรวจรอบ 13 — "ฝั่งเก็บเงินลูกค้า": ใบแจ้งหนี้ · เงินที่รับมา · ลิงก์เอกสารที่ส่งเข้า LINE ลูกค้า
 * รันบน PostgreSQL ชั่วคราว + แอป Express ตัวจริง ยิงคำขอ HTTP จริงทุกข้อ
 *   node test/_run_probe.mjs test/_qa_billing_20261025.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');

const { createApp } = await import('../src/app.js');
const { signToken, COOKIE_NAME, hashPassword } = await import('../src/lib/auth.js');
const { sql, pool } = await import('../src/db/index.js');
const { seedFixtures } = await import('./fixtures.js');

const MANAGER = { employee_id: 'EMP-0001', position: 'manager', name: 'ผู้จัดการ ทดสอบ' };
const HR = { employee_id: 'EMP-0007', position: 'hr', name: 'HR ทดสอบ' };

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

let vn = 700000000;
const nextVN = () => `VN${++vn}`;
import { randomUUID } from 'node:crypto';
const rid = () => randomUUID();

const found = [];
const notes = [];
const hit = (title, detail) => { found.push({ title, detail }); console.log(`\n🔴 ${title}\n   ${detail}`); };
const ok = (what) => { notes.push(what); console.log(`   ✅ ${what}`); };
const head = (t) => console.log(`\n━━ ${t} ━━`);

/** เคสใหม่พร้อมลูกค้าผู้จ่าย + ใบร่างที่ระบบออกให้เอง */
async function caseWithInvoice({ fee = 20000, customer = true } = {}) {
  let customer_id = null;
  if (customer) {
    const c = await post('/api/customers', { name: 'บริษัท ทดสอบ จำกัด', phone: '0811111111', tax_id: '0105500000001' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    customer_id = c.body.customer_id;
  }
  const r = await post('/api/cases', { case_id: nextVN(), case_type: 'other', client_name: 'คุณทดสอบ', fee, customer_id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inv = (await get(`/api/invoices?case_id=${r.body.case_id}`)).body.data[0];
  return { caseRow: r.body, invoice: inv };
}

// ───────────────────────────────────────────────────────────────────────────
head('1 · ลิงก์เอกสารที่ส่งเข้า LINE ลูกค้า');
{
  const { invoice } = await caseWithInvoice({ fee: 20000 });
  await post(`/api/invoices/${invoice.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${invoice.invoice_id}/issue`);

  // ผูก LINE ให้ลูกค้าเพื่อให้ส่งได้ (คอลัมน์ถูกเพิ่มแบบ lazy ตอนเรียกเส้น /line ครั้งแรก)
  await get(`/api/invoices/${invoice.invoice_id}/line`);
  await sql.run(`UPDATE customers SET line_user_id = 'Utest0001' WHERE customer_id = (SELECT customer_id FROM invoices WHERE invoice_id = :id)`, { id: invoice.invoice_id });

  const sent = await post(`/api/invoices/${invoice.invoice_id}/line`);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const url = sent.body.url;
  const token = url.split('/bill/')[1];

  const r1 = await fetch(`${base}/api/public/bill/${token}`);
  if (r1.status !== 200) hit('ลิงก์ที่เพิ่งออกเปิดไม่ได้', `GET /api/public/bill/<token> ได้ ${r1.status}`);
  else ok('ลิงก์ที่ส่งให้ลูกค้าเปิดได้ และเห็นเฉพาะข้อมูลบนเอกสาร');

  const doc = await r1.json();
  for (const k of ['payments', 'slips', 'case_id', 'staff_pay', 'margin']) {
    if (k in doc && ['slips', 'case_id', 'staff_pay', 'margin'].includes(k)) {
      hit('เอกสารสาธารณะมีข้อมูลภายในหลุดออกไป', `ฟิลด์ ${k} โผล่ใน /api/public/bill`);
    }
  }

  // ลูกค้าถือลิงก์ไว้ แล้วทีมแก้ยอดในใบ
  const before = doc.total;
  const up = await patch(`/api/invoices/${invoice.invoice_id}`, { amount: 99999, discount: 0 });
  if (up.status === 200) {
    const after = await (await fetch(`${base}/api/public/bill/${token}`)).json();
    if (Number(after.total) !== Number(before)) {
      notes.push(`ลิงก์เดิมแสดงยอดล่าสุดเสมอ (${before} → ${after.total}) — ตั้งใจ`);
      console.log(`   ℹ️ ลิงก์เดิมแสดงยอดล่าสุด ${before} → ${after.total} (ใบยังไม่ชำระ ถือว่าถูก)`);
    }
    await patch(`/api/invoices/${invoice.invoice_id}`, { amount: 20000, discount: 0 });
  }

  // ใบที่ "ชำระแล้ว" = ใบเสร็จของลูกค้า · ถ้าทีมยกเลิกใบทีหลัง (คืนเงิน/ออกใบผิด) ลูกค้าเปิดใบเสร็จเดิมไม่ได้
  await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid() });
  const paidDoc = await (await fetch(`${base}/api/public/bill/${token}`)).json();
  if (paidDoc.status !== 'paid') hit('ลิงก์ไม่กลายเป็นใบเสร็จหลังชำระ', `status = ${paidDoc.status}`);
  else ok('ชำระแล้วลิงก์เดิมกลายเป็นใบเสร็จ ไม่ต้องส่งลิงก์ใหม่');

  const cancelPaid = await post(`/api/invoices/${invoice.invoice_id}/cancel`);
  if (cancelPaid.status === 200) {
    const r2 = await fetch(`${base}/api/public/bill/${token}`);
    if (r2.status === 404) {
      hit(
        'ยกเลิกใบที่ลูกค้าจ่ายเงินมาแล้ว = ใบเสร็จที่ลูกค้าถืออยู่เปิดไม่ได้ทันที',
        'ลูกค้าโอนเงินมาจริงและได้ลิงก์ใบเสร็จไปแล้ว · ทีมยกเลิกใบ แล้วลิงก์เดิมขึ้น "หมดอายุ" ' +
        'ทั้งที่เงินยังอยู่กับบริษัท ลูกค้าไม่เหลือหลักฐานการจ่ายเลยสักอย่าง',
      );
    } else {
      const d2 = await r2.json();
      if (d2.status !== 'cancelled') hit('ลิงก์ไม่บอกว่าใบถูกยกเลิก', `status = ${d2.status}`);
      else if (!(Number(d2.paid_amount) > 0)) hit('ลิงก์ใบที่ยกเลิกไม่เหลือยอดที่จ่ายมาแล้ว', JSON.stringify(d2.payments));
      else ok('ใบที่ยกเลิกหลังลูกค้าจ่ายแล้ว ลิงก์ยังเปิดได้ บอกว่ายกเลิก และเก็บงวดที่จ่ายไว้เป็นหลักฐาน');
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('2 · รับชำระผิด แล้วแก้คืนได้ไหม');
{
  const { invoice } = await caseWithInvoice({ fee: 5000 });
  await post(`/api/invoices/${invoice.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${invoice.invoice_id}/issue`);

  // พิมพ์ 50,000 แทน 5,000 → เกินยอด ต้องถูกกั้น
  const over = await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 50000 });
  if (over.status === 200) hit('รับชำระเกินยอดได้', `รับ 50,000 เข้าใบยอด 5,000 สำเร็จ`);
  else ok('รับเกินยอดค้างถูกกั้น (409)');

  // พิมพ์ 500 แทน 5,000 → รับได้ (เป็นชำระบางส่วน) แล้วจะแก้ยังไง
  const part = await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 500 });
  assert.equal(part.status, 200, JSON.stringify(part.body));

  const payments = (await get(`/api/invoices/${invoice.invoice_id}`)).body.payments ?? [];
  const pid = payments[0]?.payment_id;
  // สำรวจว่ามีเส้นไหม โดยยิงไปที่รหัสรายการที่ไม่มีอยู่ — ไม่ให้ตัวสำรวจลงมือจริง
  const routes = [
    ['DELETE', `/api/invoices/${invoice.invoice_id}/payments/999999`],
    ['PATCH', `/api/invoices/${invoice.invoice_id}/payments/999999`],
    ['POST', `/api/invoices/${invoice.invoice_id}/payments/999999/void`],
  ];
  const alive = [];
  for (const [m, p] of routes) {
    const r = await call(m, p, m === 'DELETE' ? undefined : { reason: 'กรอกยอดผิด' });
    if (r.status !== 404 || !/ไม่พบ endpoint/.test(r.body?.error ?? '')) alive.push(`${m} ${p} → ${r.status}`);
  }
  if (alive.length === 0) {
    hit(
      'รับชำระผิดจำนวนแล้วลบ/แก้รายการนั้นไม่ได้เลย',
      'ไม่มีเส้นลบหรือแก้ invoice_payments สักเส้น · กรอก 500 แทน 5,000 (หรือรับซ้ำสองครั้ง) ' +
      'แล้วยอดค้างกับรายได้ในกราฟผิดถาวร',
    );
  } else ok(`มีเส้นยกเลิกรายการรับชำระ: ${alive.join(' · ')}`);

  // เส้นยกเลิกต้องทำงานจริง ไม่ใช่แค่มีอยู่
  const need = await post(`/api/invoices/${invoice.invoice_id}/payments/${pid}/void`, {});
  if (need.status !== 400) hit('ยกเลิกรายการได้โดยไม่ต้องบอกเหตุผล', `ไม่ส่ง reason ได้ ${need.status}`);
  else ok('ยกเลิกรายการต้องพิมพ์เหตุผลก่อน (400)');

  const voided = await post(`/api/invoices/${invoice.invoice_id}/payments/${pid}/void`, { reason: 'กรอกยอดผิด 500 แทน 5,000' });
  if (voided.status !== 200) hit('ยกเลิกรายการรับชำระไม่สำเร็จ', JSON.stringify(voided.body));
  else {
    const inv = voided.body;
    if (Number(inv.paid_amount) !== 0) hit('ยกเลิกแล้วยอดที่รับไม่ลด', `paid_amount = ${inv.paid_amount}`);
    else ok('ยกเลิกแล้วยอดที่รับกลับเป็น 0 และยอดค้างกลับมาเต็ม');
    if (!(inv.payment_voids ?? []).some((v) => Number(v.amount) === 500)) hit('ไม่มีร่องรอยรายการที่ยกเลิก', JSON.stringify(inv.payment_voids));
    else ok('รายการที่ยกเลิกยังอยู่ในประวัติพร้อมเหตุผลและคนที่กด');
  }

  // รับเต็มยอดแล้วยกเลิกงวดนั้น — สถานะต้องถอยจาก "ชำระแล้ว" กลับเป็น "รอชำระ"
  await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 5000 });
  const full = (await get(`/api/invoices/${invoice.invoice_id}`)).body;
  const lastPid = full.payments[full.payments.length - 1].payment_id;
  const back = await post(`/api/invoices/${invoice.invoice_id}/payments/${lastPid}/void`, { reason: 'บันทึกซ้ำ' });
  if (back.body?.status !== 'issued') hit('ยกเลิกงวดที่ปิดยอดแล้ว สถานะไม่ถอยกลับ', `status = ${back.body?.status}`);
  else ok('ยกเลิกงวดที่ปิดยอด สถานะถอยจาก "ชำระแล้ว" กลับเป็น "รอชำระ"');

  // HR ยกเลิกรายการของคนอื่นไม่ได้ (ผู้จัดการเป็นคนบันทึกไว้)
  await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 1000 });
  const mine = (await get(`/api/invoices/${invoice.invoice_id}`)).body.payments.slice(-1)[0];
  const hrVoid = await post(`/api/invoices/${invoice.invoice_id}/payments/${mine.payment_id}/void`, { reason: 'ลองดู' }, HR);
  if (hrVoid.status !== 403) hit('คนที่ไม่มีสิทธิ์การเงินยกเลิกรายการของคนอื่นได้', `ได้ ${hrVoid.status}`);
  else ok('HR ยกเลิกรายการที่คนอื่นบันทึกไม่ได้ (403)');

  // รับซ้ำด้วย request_id ใหม่ (กดสองครั้งคนละหน้าจอ) → ยอดเกินจริงไหม
  await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 100 });
  const after = (await get(`/api/invoices/${invoice.invoice_id}`)).body;
  if (Number(after.paid_amount) > Number(after.total)) {
    hit('ยอดรับรวมเกินยอดใบ', `paid ${after.paid_amount} > total ${after.total}`);
  } else ok('ยอดรับรวมไม่เกินยอดใบ');
}

// ───────────────────────────────────────────────────────────────────────────
head('3 · วันที่เงินเข้า — เข้ารายงานรายได้ถูกช่วงไหม');
{
  const { invoice } = await caseWithInvoice({ fee: 1000 });
  await post(`/api/invoices/${invoice.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${invoice.invoice_id}/issue`);

  const future = await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 1000, paid_at: '2099-12-31' });
  if (future.status === 200) {
    hit(
      'บันทึกวันที่เงินเข้าเป็นอนาคตได้',
      'กรอก paid_at = 2099-12-31 ผ่าน (พิมพ์ปี พ.ศ. 2569 ลงช่อง ค.ศ. ก็ได้ 2569-xx-xx) · ' +
      'ใบขึ้นว่าชำระแล้ว แต่เงินก้อนนั้นไม่โผล่ในกราฟรายได้ของช่วงไหนเลย เพราะ generate_series ' +
      'กางถึงแค่วันนี้ — เงินหายจากรายงานเงียบ ๆ',
    );
  } else ok('วันที่เงินเข้าเป็นอนาคตถูกกั้น');

  const be = await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 1000, paid_at: '2569-10-25' });
  if (be.status === 200) hit('กรอกปี พ.ศ. ลงช่องวันที่ได้', 'paid_at = 2569-10-25 ผ่าน — เงินไปโผล่ปี ค.ศ. 2569');
  else ok('ปี พ.ศ. ที่พิมพ์ลงช่อง ค.ศ. ถูกกั้น (2569-10-25)');
}

// ───────────────────────────────────────────────────────────────────────────
head('4 · สิทธิ์ — ใครทำอะไรกับเงินของลูกค้าได้');
{
  const { invoice } = await caseWithInvoice({ fee: 3000 });
  await post(`/api/invoices/${invoice.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${invoice.invoice_id}/issue`);

  const hrPay = await post(`/api/invoices/${invoice.invoice_id}/pay`, { request_id: rid(), amount: 3000 }, HR);
  const hrRev = await get('/api/invoices/revenue?bucket=day&points=7', HR);
  const sum = await get('/api/invoices/summary', HR);
  const paidRow = (sum.body ?? []).find((r) => r.status === 'paid');
  if (hrRev.status !== 403) hit('HR เปิดรายได้รวมบริษัทได้', `GET /api/invoices/revenue → ${hrRev.status}`);
  else ok('HR เปิด /revenue ไม่ได้ (403)');
  if (paidRow && 'amount' in paidRow) hit('ยอดเงินของใบที่ชำระแล้วหลุดถึง HR ทาง /summary', JSON.stringify(paidRow));
  else ok('/summary ตัดยอดเงินของแถว "ชำระแล้ว" ออกจาก HR');
  assert.equal(hrPay.status, 200, 'HR มีสิทธิ์ billing จึงรับชำระได้ตามออกแบบ');
}

// ───────────────────────────────────────────────────────────────────────────
head('5 · เคสยกเลิกหลังออกใบไปแล้ว');
{
  const { caseRow, invoice } = await caseWithInvoice({ fee: 8000 });
  await post(`/api/invoices/${invoice.invoice_id}/billing-plan`, { mode: 'full' });
  await post(`/api/invoices/${invoice.invoice_id}/issue`);
  const cancelled = await post(`/api/cases/${caseRow.case_id}/cancel`, { reason: 'ลูกค้ายกเลิก' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  const inv = (await get(`/api/invoices/${invoice.invoice_id}`)).body;
  if (inv.status === 'issued' && !inv.case_cancelled_flag && inv.case_status === 'cancelled') {
    const row = (await get(`/api/invoices?case_id=${caseRow.case_id}`)).body.data[0];
    const flags = Object.entries(row).filter(([k, v]) => /stale|warn|flag|cancel/.test(k) && v === true);
    if (!row.case_cancelled) {
      hit(
        'เคสถูกยกเลิก แต่ใบแจ้งหนี้ที่ออกไปแล้วไม่มีป้ายเตือนอะไรเลย',
        `ใบ ${invoice.invoice_id} ยังขึ้น "รอชำระ ${inv.total} บาท" ในรายการและในยอดค้างรวม ` +
        'ทั้งที่เคสยกเลิกไปแล้ว · คนตามเก็บเงินเห็นแต่ยอดค้าง ไม่มีอะไรบอกว่าอย่าโทรไปทวง',
      );
    } else ok(`ใบของเคสที่ยกเลิกมีป้ายเตือน: ${flags.map(([k]) => k).join(', ')}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('6 · เพดานกันไล่เดาลิงก์ — ลูกค้าคนละคนแย่งโควตากันไหม');
{
  let blocked = 0;
  for (let i = 0; i < 70; i++) {
    const r = await fetch(`${base}/api/public/bill/${'a'.repeat(32)}${i}`);
    if (r.status === 429) blocked++;
  }
  if (blocked > 0) {
    notes.push(`เพดาน 60/นาที/IP ทำงาน (บล็อก ${blocked} จาก 70)`);
    console.log(`   ℹ️ เพดานทำงาน บล็อก ${blocked}/70 — บนจริง trust proxy=1 จึงแยกตาม IP ลูกค้า`);
  } else hit('ไม่มีเพดานกันไล่เดา token', 'ยิง 70 ครั้งติดกันไม่โดนบล็อกเลย');
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n━━ สรุป: พบที่ต้องแก้ ${found.length} ข้อ · ผ่าน ${notes.length} จุด ━━`);
found.forEach((f, i) => console.log(`${i + 1}. ${f.title}`));

await new Promise((r) => server.close(r));
await pool.end();
