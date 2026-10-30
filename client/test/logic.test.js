/**
 * เทสตรรกะฝั่งหน้าเว็บ — ฟังก์ชันบริสุทธิ์ที่ตัวเลข/ข้อความบนจอทั้งระบบพึ่งอยู่
 *
 * ใช้ตัวรันเทสที่ติดมากับ Node (node --test) ไม่ได้เพิ่ม dependency ใหม่เข้าโปรเจค —
 * ไฟล์พวกนี้เป็น .js ล้วน ไม่มี JSX จึง import ตรงๆ ได้โดยไม่ต้องมี bundler มาแปลงก่อน
 *
 * ที่เลือกเทสคือของที่ "ผิดแล้วดูไม่ออก": เงิน วันที่ เวลา และการตัดสินสิทธิ์ —
 * ไม่ใช่การวาดหน้าจอซึ่งเห็นด้วยตาอยู่แล้วว่าเพี้ยน
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBaht, amountText, bahtText, stampText, docDate, durationText,
  distanceText, ageFromBirthDate, toBuddhistYear, formatPeriod, todayTH,
} from '../src/labels.js';
import { dayLabel, timeRange, CAL_STATES, parseTime } from '../src/lib/calendarUi.js';
import { ISSUER, TRANSFER_ACCOUNT_TEXT, TRANSFER_PAYMENT_INSTRUCTION } from '../src/lib/issuer.js';
import { customerAddonDescription, customerItemDescription } from '../src/lib/customerInvoice.js';

describe('เอกสารลูกค้า HomeCare', () => {
  test('ข้อมูลผู้ออกและบัญชีรับโอนตรงกับบิลจริง', () => {
    assert.equal(ISSUER.brand, 'คิน เวลเนส สหคลินิก');
    assert.equal(ISSUER.name, 'บริษัท ทีทรี สโตรก เนอสซิ่งโฮม จำกัด (สำนักงานใหญ่)');
    assert.equal(ISSUER.taxId, '0105561155236');
    assert.equal(ISSUER.tel, '061-881-9399');
    assert.equal(ISSUER.transfer.copyNumber, '0471475769');
    assert.match(TRANSFER_ACCOUNT_TEXT, /047-1-47576-9/);
    assert.match(TRANSFER_PAYMENT_INSTRUCTION, /LINE KIN HomeCare/);
  });

  test('เอกสารลูกค้าซ่อนชื่อบริการ/ของเช่า แต่ซื้อขาดคงชื่อสินค้าจริง', () => {
    const item = {
      items: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
      addons: [
        { name: 'เตียงผู้ป่วย', kind: 'rent' },
        { name: 'เครื่องวัดความดัน', kind: 'sale' },
      ],
    };
    assert.equal(customerItemDescription(item, 0), 'ค่าบริการทางการแพทย์');
    assert.equal(customerItemDescription(item, 1), 'ค่าบริการทางการแพทย์');
    assert.equal(customerItemDescription(item, 2), 'เครื่องวัดความดัน');
    assert.equal(customerAddonDescription({ name: 'ของเก่าไม่มี kind' }), 'ค่าบริการทางการแพทย์');
  });
});

describe('stampText — เวลาในประวัติการทำรายการ', () => {
  test('ค่าที่ไม่มีโซนเวลา = เวลาไทยอยู่แล้ว ห้ามบวกเพิ่มอีก 7 ชั่วโมง', () => {
    // เคยเป็นบั๊ก: 16:57 ในฐานข้อมูลขึ้นเป็น 23:57 บนหน้าจอ เพราะถูกอ่านเป็น UTC แล้วแปลงซ้ำ
    assert.match(stampText('2026-08-19 16:57:38'), /16:57$/);
    assert.match(stampText('2026-08-19T16:57:38'), /16:57$/);
  });

  test('ค่าที่มีโซนเวลามาด้วย ยังแปลงตามปกติ', () => {
    assert.match(stampText('2026-08-19T09:57:38Z'), /16:57$/); // UTC+7
  });

  test('ค่าว่าง/ขยะ ไม่ทำให้หน้าพัง', () => {
    assert.equal(stampText(null), '—');
    assert.equal(stampText(''), '—');
    assert.equal(stampText('ไม่ใช่วันที่'), '—');
  });
});

describe('ตัวเลขเงิน', () => {
  test('formatBaht ใส่สัญลักษณ์บาทและคั่นหลักพัน', () => {
    assert.match(formatBaht(25887.5), /25,887/);
    assert.match(formatBaht(0), /0/);
  });

  test('amountText บนเอกสารมีทศนิยมสองตำแหน่งเสมอ', () => {
    assert.equal(amountText(12000), '12,000.00');
    assert.equal(amountText(687.5), '687.50');
    assert.equal(amountText(null), '0.00');
  });

  test('bahtText อ่านเป็นตัวหนังสือตามหลักเลขไทย', () => {
    assert.equal(bahtText(12000), 'หนึ่งหมื่นสองพันบาทถ้วน');
    assert.equal(bahtText(21), 'ยี่สิบเอ็ดบาทถ้วน');
    assert.equal(bahtText(0), 'ศูนย์บาทถ้วน');
    assert.equal(bahtText(1000000), 'หนึ่งล้านบาทถ้วน');
  });

  test('bahtText มีสตางค์เมื่อยอดไม่ลงตัว', () => {
    assert.equal(bahtText(687.5), 'หกร้อยแปดสิบเจ็ดบาทห้าสิบสตางค์');
  });
});

describe('วันที่และเวลา', () => {
  test('docDate เป็น วัน-เดือน-พ.ศ.', () => {
    assert.equal(docDate('2026-07-22'), '22-07-2569');
    assert.equal(docDate(null), '—');
    assert.equal(docDate('ขยะ'), '—');
  });

  test('todayTH คืนรูปแบบ YYYY-MM-DD', () => {
    assert.match(todayTH(), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('toBuddhistYear บวก 543', () => {
    assert.equal(toBuddhistYear(2026), '2569');
  });

  test('formatPeriod อ่านเป็นเดือนไทย', () => {
    assert.equal(formatPeriod('2026', '08'), 'สิงหาคม 2569');
    assert.equal(formatPeriod('2026'), 'ปี 2569');
    assert.equal(formatPeriod(null), 'ทุกช่วงเวลา');
  });

  test('durationText แปลงนาทีเป็นชั่วโมง', () => {
    assert.match(durationText(90), /1/);
    assert.match(durationText(90), /30/);
  });
});

describe('ระยะทางและอายุ', () => {
  test('distanceText ต่ำกว่ากิโลเมตรบอกเป็นเมตร', () => {
    assert.match(distanceText(250), /250/);
  });

  test('ageFromBirthDate คืนตัวเลขที่สมเหตุผล', () => {
    const born = new Date();
    born.setFullYear(born.getFullYear() - 30);
    const iso = born.toISOString().slice(0, 10);
    assert.equal(ageFromBirthDate(iso), 30);
  });

  test('ไม่มีวันเกิด = ไม่เดาอายุให้', () => {
    assert.equal(ageFromBirthDate(null), null);
  });
});

describe('ตัวช่วยของปฏิทิน', () => {
  test('dayLabel บอกทั้งชื่อวันและวันที่ (ใช้ในโหมดการ์ดบนมือถือ)', () => {
    const label = dayLabel('2026-08-13');
    assert.match(label, /13/);
    assert.ok(label.length > 3, 'ต้องมีชื่อวันนำหน้า ไม่ใช่เลขวันเปล่าๆ');
  });

  test('timeRange รวมเวลาเข้า–ออกเป็นช่วงเดียว', () => {
    assert.equal(timeRange({ planned_start: '09:00', planned_end: '12:00' }), '09:00–12:00');
    assert.equal(timeRange({ planned_start: '09:00' }), '09:00');
    assert.equal(timeRange({}), null);
  });

  test('สถานะกะบนปฏิทินต้องไม่มี cancelled (server ตัดออกตั้งแต่ต้นทาง)', () => {
    assert.ok(!CAL_STATES.includes('cancelled'));
    assert.equal(CAL_STATES.length, 5);
  });
});

describe('parseTime — เวลาที่พิมพ์เองในกล่องย้ายกะ', () => {
  test('รูปแบบที่คนพิมพ์จริงได้ HH:MM เดียวกัน', () => {
    for (const t of ['9:30', '09:30', '9.30', '930', '0930', '9 30']) assert.equal(parseTime(t), '09:30', t);
    assert.equal(parseTime('9'), '09:00');
    assert.equal(parseTime('23:59'), '23:59');
    assert.equal(parseTime(' 14:05 '), '14:05');
  });
  test('ว่าง = ไม่ได้กรอก (ใช้เวลาเดิม) · ไม่ใช่เวลา = null', () => {
    assert.equal(parseTime(''), '');
    assert.equal(parseTime('   '), '');
    for (const t of ['24:00', '12:60', 'abc', '9:3x', '12345', '-1']) assert.equal(parseTime(t), null, t);
  });
});
