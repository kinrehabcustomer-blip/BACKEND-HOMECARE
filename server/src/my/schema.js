import { z } from 'zod';
import { imageSchema } from '../employees/schema.js'; // ใช้ตัวตรวจ data URL รูปตัวเดียวกับใบรับรอง/รูปพนักงาน

// พิกัดจากเบราว์เซอร์ (navigator.geolocation) — เว้นได้ถ้า GPS ถูกปฏิเสธ/ไม่มีสัญญาณ (จะถูก flag แทน)
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

export const checkInSchema = z.object({
  lat: lat.optional().nullable(),
  lng: lng.optional().nullable(),
  accuracy: z.number().nonnegative().optional().nullable(), // ความคลาด (เมตร) ที่ GPS รายงาน
  photo: imageSchema.optional().nullable(),                 // เซลฟี่ — ไม่บังคับ
});

export const checkOutSchema = z.object({
  lat: lat.optional().nullable(),
  lng: lng.optional().nullable(),
});

// ประวัติการมาทำงานรายเดือน — ไม่ส่ง = เดือนปัจจุบัน
export const attendanceQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนต้องอยู่ในรูปแบบ YYYY-MM').optional(),
});
