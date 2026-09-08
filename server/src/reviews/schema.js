import { z } from 'zod';
import { zodDate } from '../lib/dates.js';

/**
 * หัวข้อของแบบประเมิน — ลำดับนี้คือลำดับที่โชว์ในฟอร์มและในหน้ารายงาน
 *
 * ชื่อในนี้ = ชื่อคอลัมน์ใน staff_reviews เป๊ะ ทั้ง validation, INSERT และ AVG() รายหัวข้อ
 * จึงไล่จากรายการเดียวกันหมด — เพิ่ม/ตัดข้อทีหลังแตะที่นี่กับ schema.sql เท่านั้น
 * (ป้ายภาษาไทยอยู่ฝั่งหน้าเว็บที่ client/src/lib/reviewQuestions.js — server ไม่ต้องรู้ข้อความ)
 *
 * เดิมมีสิบข้อ ย่อเหลือห้า — แบบประเมินที่ยาวเกินไปได้คำตอบที่แย่ลง ไม่ใช่ละเอียดขึ้น
 * คนกรอกเริ่มกดดาวเดิมรวดเดียวลงมาเพื่อให้จบ (straight-lining) แล้วค่าเฉลี่ยรายหัวข้อ
 * ก็เท่ากันหมดจนแยกไม่ออกว่าใครเก่งเรื่องไหน · ห้าข้อที่เหลือครอบคลุมคนละด้านกันจริงๆ
 *
 * ห้าคอลัมน์ที่เลิกใช้ (q_attentive, q_safety, q_adapt, q_home_advice, q_progress)
 * ยังอยู่ในตาราง ไม่ได้ลบทิ้ง — ใบที่ญาติกรอกไปแล้วต้องไม่หายไปเพราะเราเปลี่ยนแบบฟอร์ม
 * (ดู "เลิกใช้ห้าข้อ" ใน schema.sql ที่ปลด NOT NULL ให้)
 */
export const REVIEW_QUESTIONS = [
  'q_punctual',
  'q_manner',
  'q_professional',
  'q_communication',
  'q_overall',
];

export const WANT_AGAIN_OPTIONS = ['strongly', 'yes', 'unsure', 'no'];
export const RECOMMEND_OPTIONS = ['definitely', 'yes', 'unsure', 'no'];

/* ช่องที่ไม่ได้กรอกมาจากฟอร์ม HTML เป็น "" ไม่ใช่ null — ถ้าไม่แปลงก่อน
   z.enum จะฟ้องว่า "" ไม่ใช่ตัวเลือกที่มี และตัวตรวจวันที่ก็ไม่ผ่าน
   ทั้งที่ทั้งสองช่องเป็นช่องไม่บังคับ คนกรอกจะเจอ error ที่แก้ไม่ได้เพราะไม่ได้ทำอะไรผิด */
const blankToNull = (schema) => z.preprocess((v) => (v === '' ? null : v), schema);

const score = z
  .number({ invalid_type_error: 'กรุณาให้คะแนนข้อนี้' })
  .int('คะแนนต้องเป็นจำนวนเต็ม')
  .min(1, 'คะแนนต่ำสุดคือ 1')
  .max(5, 'คะแนนสูงสุดคือ 5');

/* ข้อความอิสระ: กรอกว่างไว้ = ไม่มีความเห็น ให้เก็บเป็น NULL ไม่ใช่สตริงว่าง
   ไม่งั้นหน้ารายงานต้องคอยเช็คสองแบบว่า "ไม่มีความเห็น" หมายถึงอะไรกันแน่ */
const comment = (max) =>
  z
    .string()
    .trim()
    .max(max, `ข้อความยาวเกิน ${max} ตัวอักษร`)
    .nullable()
    .optional()
    .transform((v) => v || null);

export const reviewSubmitSchema = z.object({
  patient_name: comment(100),
  /* zodDate ไม่ใช่ regex เอง — คอลัมน์วันที่ในฐานนี้เป็น TEXT ทั้งหมด Postgres จึงไม่ช่วยตรวจ
     regex สี่หลัก-สองหลัก-สองหลัก ปล่อย '2026-02-31' กับ '2026-13-45' ผ่านได้หมด
     แล้วไปโผล่เป็น Invalid Date บนหน้ารายงานทีหลัง (เหตุผลเดียวกับที่ lib/dates.js เกิดมา) */
  service_date: blankToNull(zodDate(z).nullable().optional()),

  // คะแนนบังคับครบทุกข้อ — ใบที่ให้คะแนนมาครึ่งเดียวทำให้ค่าเฉลี่ยรายหัวข้อเทียบกันไม่ได้
  ...Object.fromEntries(REVIEW_QUESTIONS.map((q) => [q, score])),

  impressed: comment(2000),
  improve: comment(2000),

  want_again: blankToNull(z.enum(WANT_AGAIN_OPTIONS).nullable().optional()),
  recommend: blankToNull(z.enum(RECOMMEND_OPTIONS).nullable().optional()),
});
