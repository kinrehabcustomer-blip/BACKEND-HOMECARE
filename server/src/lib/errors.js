import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (message = 'ไม่พบข้อมูล') => new ApiError(404, message);
export const badRequest = (message, details) => new ApiError(400, message, details);
export const conflict = (message) => new ApiError(409, message);

/** ครอบ async handler ให้ error เด้งเข้า errorHandler แทนที่จะค้างเป็น unhandled rejection */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars -- express ต้องการ 4 args ถึงจะรู้ว่าเป็น error handler
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'ข้อมูลไม่ถูกต้อง',
      details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  // 23505 = unique_violation ของ Postgres (เช่น เลขบัตรประชาชนซ้ำ)
  // ทั้งพนักงานและลูกค้าห้ามเลขบัตรซ้ำ — ต้องบอกให้ตรงว่าไปชนกับใคร ไม่งั้นคนอ่านตามหาผิดที่
  if (err?.code === '23505' && err.constraint?.includes('national_id')) {
    const who = err.constraint.includes('customer') ? 'ลูกค้ารายอื่น' : 'พนักงานคนอื่น';
    return res.status(409).json({ error: `เลขบัตรประชาชนนี้ถูกใช้กับ${who}แล้ว` });
  }

  console.error(err);
  return res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
}
