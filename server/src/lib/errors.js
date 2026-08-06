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

  /*
   * ข้อมูลไม่ผ่านกฎของฐานข้อมูล — เดิมตกไปเป็น 500 "เกิดข้อผิดพลาดภายในระบบ" เหมือนระบบพัง
   * ทั้งที่จริงคือข้อมูลบางช่องไม่ผ่านเงื่อนไข ซึ่งคนกรอกแก้เองได้ถ้ารู้ว่าช่องไหน
   * ที่แย่กว่านั้นคือมันมองไม่เห็นเลยว่าติดตรงไหน ต้องไปไล่อ่าน log ของ server ทุกครั้ง
   * จึงบอกชื่อ constraint/คอลัมน์กลับไปด้วย — เป็นระบบหลังบ้านของทีมตัวเอง ไม่ใช่หน้าเว็บสาธารณะ
   */
  const DB_RULES = {
    23514: 'ค่าที่กรอกไม่ผ่านเงื่อนไขของระบบ',          // check_violation
    23502: 'มีช่องที่จำเป็นถูกเว้นว่างไว้',                  // not_null_violation
    23503: 'อ้างถึงข้อมูลที่ไม่มีอยู่แล้ว (อาจถูกลบไปก่อนหน้า)', // foreign_key_violation
    23505: 'ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว',                    // unique_violation (ที่ไม่ใช่เลขบัตร)
    22003: 'ตัวเลขเกินขนาดที่เก็บได้',                    // numeric_value_out_of_range
    '22P02': 'รูปแบบข้อมูลไม่ถูกต้อง',                    // invalid_text_representation
  };
  const rule = DB_RULES[err?.code];
  if (rule) {
    const where = err.constraint ?? err.column ?? null;
    console.error(`[${req.method} ${req.originalUrl}] ${err.code} ${err.constraint ?? ''}`, err.detail ?? err.message);
    return res.status(409).json({
      error: where ? `${rule} (${where})` : rule,
    });
  }

  // เหลือจากนี้คือพังจริง — log ให้ครบพอตามรอยได้ว่ามาจาก request ไหน
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  return res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
}
