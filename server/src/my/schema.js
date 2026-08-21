import { z } from 'zod';
import { imageSchema } from '../employees/schema.js'; // ใช้ตัวตรวจ data URL รูปตัวเดียวกับใบรับรอง/รูปพนักงาน

// พิกัดจากเบราว์เซอร์ (navigator.geolocation) — เว้นได้ถ้า GPS ถูกปฏิเสธ/ไม่มีสัญญาณ (จะถูก flag แทน)
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

/**
 * เช็คอินกะ — รูปเซลฟี่บังคับ
 *
 * เดิมไม่บังคับ ผลคือแทบไม่มีใครถ่าย แล้วหลักฐานว่า "ไปถึงหน้างานจริง" เหลือแค่พิกัด GPS
 * ซึ่งปลอมง่ายกว่ามาก (แชร์ตำแหน่ง/ตั้งค่ามือถือ) และคลาดเคลื่อนเองได้หลายสิบเมตรจนธงนอกพื้นที่
 * ไม่มีความหมาย — พอมีทั้งรูปและพิกัดคู่กัน ผู้จัดการถึงจะตรวจกะที่น่าสงสัยได้จริง
 *
 * บังคับที่ชั้นนี้ ไม่ใช่ NOT NULL ในตาราง เพราะเช็คอินที่เกิดก่อนกติกานี้ยังไม่มีรูป
 * ใส่ NOT NULL แล้ว migration ล้มทันที และประวัติเดิมจะกลายเป็นข้อมูลผิดกติกาย้อนหลัง
 * ทั้งที่ตอนนั้นทำถูกตามกติกาที่มีอยู่ (ดูหมายเหตุที่คอลัมน์ check_in_photo_data ใน schema.sql)
 */
export const checkInSchema = z
  .object({
    lat: lat.optional().nullable(),
    lng: lng.optional().nullable(),
    accuracy: z.number().nonnegative().optional().nullable(), // ความคลาด (เมตร) ที่ GPS รายงาน
    photo: imageSchema.optional().nullable(),
  })
  /* บังคับด้วย superRefine ไม่ใช่ตัด .optional() ทิ้ง เพราะ zod ใช้ข้อความของ imageSchema
     เฉพาะตอน "ส่งค่ามาแล้วผิดรูปแบบ" ส่วนตอนไม่ส่งมาเลยจะได้ข้อความปริยาย "Required"
     ซึ่งพนักงานภาคสนามอ่านแล้วไม่รู้ว่าต้องทำอะไร — แยกสองกรณีให้ได้ข้อความคนละอันจึงต้องทำที่นี่ */
  .superRefine((v, ctx) => {
    if (!v.photo) {
      ctx.addIssue({ code: 'custom', path: ['photo'], message: 'กรุณาถ่ายรูปเซลฟี่ก่อนเช็คอิน' });
    }
  });

export const checkOutSchema = z.object({
  lat: lat.optional().nullable(),
  lng: lng.optional().nullable(),
});

// ประวัติการมาทำงานรายเดือน — ไม่ส่ง = เดือนปัจจุบัน
export const attendanceQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนต้องอยู่ในรูปแบบ YYYY-MM').optional(),
});
