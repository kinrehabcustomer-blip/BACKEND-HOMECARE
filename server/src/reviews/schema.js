import { z } from 'zod';

/**
 * 10 หัวข้อของแบบประเมิน — ลำดับนี้คือลำดับที่โชว์ในฟอร์มและในหน้ารายงาน
 *
 * ชื่อในนี้ = ชื่อคอลัมน์ใน staff_reviews เป๊ะ ทั้ง validation, INSERT และ AVG() รายหัวข้อ
 * จึงไล่จากรายการเดียวกันหมด — เพิ่มข้อใหม่ทีหลังต้องแตะที่นี่กับ schema.sql เท่านั้น
 * (ป้ายภาษาไทยอยู่ฝั่งหน้าเว็บที่ client/src/lib/reviewQuestions.js — server ไม่ต้องรู้ข้อความ)
 */
export const REVIEW_QUESTIONS = [
  'q_punctual',
  'q_manner',
  'q_attentive',
  'q_safety',
  'q_professional',
  'q_communication',
  'q_adapt',
  'q_home_advice',
  'q_progress',
  'q_overall',
];

export const WANT_AGAIN_OPTIONS = ['strongly', 'yes', 'unsure', 'no'];
export const RECOMMEND_OPTIONS = ['definitely', 'yes', 'unsure', 'no'];

/* ช่องที่ไม่ได้กรอกมาจากฟอร์ม HTML เป็น "" ไม่ใช่ null — ถ้าไม่แปลงก่อน
   z.enum จะฟ้องว่า "" ไม่ใช่ตัวเลือกที่มี และ regex ของวันที่ก็ไม่ผ่าน
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
  service_date: blankToNull(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ต้องเป็น ปี-เดือน-วัน')
      .nullable()
      .optional(),
  ),

  // คะแนนบังคับครบทั้ง 10 ข้อ — ใบที่ให้คะแนนมาครึ่งเดียวทำให้ค่าเฉลี่ยรายหัวข้อเทียบกันไม่ได้
  ...Object.fromEntries(REVIEW_QUESTIONS.map((q) => [q, score])),

  impressed: comment(2000),
  improve: comment(2000),

  want_again: blankToNull(z.enum(WANT_AGAIN_OPTIONS).nullable().optional()),
  recommend: blankToNull(z.enum(RECOMMEND_OPTIONS).nullable().optional()),
});
