import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// มีแต่ notFound ที่ถูกใช้จริง — เส้นอื่นเรียก new ApiError(400/409, ...) ตรงๆ พร้อมข้อความของตัวเอง
// (เคยมี badRequest กับ conflict เป็นทางลัดคู่กัน แต่ไม่เคยมีใครเรียกเลยสักครั้ง จึงลบทิ้ง)
export const notFound = (message = 'ไม่พบข้อมูล') => new ApiError(404, message);

/** ครอบ async handler ให้ error เด้งเข้า errorHandler แทนที่จะค้างเป็น unhandled rejection */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** URL สำหรับเขียน log — ตัด query และปิดท่อนที่หน้าตาเป็นโทเคน (ลิงก์บิล · ตั๋ว LINE/SSO)
 *  log ของ Vercel อ่านได้หลายคน โทเคนที่ค้างใน log = เปิดบิลลูกค้าได้จนหมดอายุ (ตรวจ Codex 30 ต.ค. 2569 ข้อ 18) */
const logUrl = (req) => String(req.originalUrl || '').split('?')[0].replace(/[A-Za-z0-9_.~-]{24,}/g, '***');

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

  /*
   * body-parser ตีกลับตั้งแต่ก่อนถึง route — เดิมตกไปเป็น 500 "เกิดข้อผิดพลาดภายในระบบ"
   * ซึ่งเป็นคำตอบที่คนหน้างานแก้เองไม่ได้ ทั้งที่สาเหตุคือ "รูปที่แนบใหญ่เกิน" ซึ่งแก้ได้ทันที
   * เจอได้จริงกับรูปที่ไม่ได้ย่อ: เพดาน JSON คือ 8 MB แต่ data URL โตขึ้นจากไฟล์จริงราว 1.37 เท่า
   * ไฟล์ราว 6 MB ขึ้นไปจึงถูกตัดทิ้งก่อนที่ด่าน 5 MB ใน decodeImage จะได้ทำงานและบอกเหตุผล
   */
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'ไฟล์ที่แนบมาใหญ่เกินไป — รูปต้องไม่เกิน 5 MB ต่อใบ (ย่อรูปแล้วลองใหม่)' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง' });
  }

  // 23505 = unique_violation ของ Postgres (เช่น เลขบัตรประชาชนซ้ำ)
  // ทั้งพนักงานและลูกค้าห้ามเลขบัตรซ้ำ — ต้องบอกให้ตรงว่าไปชนกับใคร ไม่งั้นคนอ่านตามหาผิดที่
  if (err?.code === '23505' && err.constraint?.includes('national_id')) {
    /* ต้องไล่ทีละแฟ้ม ไม่ใช่ "ลูกค้า หรือไม่ก็พนักงาน" (ตรวจรอบ 18)
       ดัชนีของผู้รับบริการคือ idx_patients_national_id ซึ่งไม่มีคำว่า customer
       เลขบัตรผู้รับบริการซ้ำจึงเคยขึ้นว่า "ถูกใช้กับพนักงานคนอื่นแล้ว" — คนอ่านไปตามหาในรายชื่อพนักงานแล้วไม่เจอ */
    const c = err.constraint;
    const who = c.includes('customer') ? 'ลูกค้ารายอื่น'
      : c.includes('patient') ? 'ผู้รับบริการรายอื่น'
      : 'พนักงานคนอื่น';
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
    console.error(`[${req.method} ${logUrl(req)}] ${err.code} ${err.constraint ?? ''}`, err.detail ?? err.message);
    return res.status(409).json({
      error: where ? `${rule} (${where})` : rule,
    });
  }

  /*
   * เหลือจากนี้คือพังจริง — เดิมตอบแค่ "เกิดข้อผิดพลาดภายในระบบ" ซึ่งบอกอะไรไม่ได้เลย
   * ตัวจริงไปโผล่ที่ console ของ server เท่านั้น คนหน้างานที่เจอปัญหาจึงไม่มีอะไรส่งต่อให้คนแก้
   * และคนแก้ก็ต้องขอให้ไปเปิด log ทุกครั้ง กลายเป็นวนอยู่แบบนั้น
   *
   * ระบบนี้เป็นหลังบ้านของทีมตัวเอง อยู่หลัง login ทั้งหมด — ส่งชื่อ/ข้อความของ error กลับไปด้วย
   * คุ้มกว่าการปิดเงียบมาก (ไม่ส่ง stack เพราะยาวและไม่ช่วยคนหน้างาน)
   */
  console.error(`[${req.method} ${logUrl(req)}]`, err);

  /* ข้อความดิบส่งให้เฉพาะผู้ดูแลระบบ (ผู้จัดการ/HR) ซึ่งเป็นคนที่ส่งต่อให้คนแก้ได้จริง
     พนักงานภาคสนามเอาไปทำอะไรไม่ได้อยู่แล้ว และข้อความมักมีชื่อคอลัมน์/constraint ติดมาด้วย
     — ไม่ใช่ความลับ แต่ก็ไม่มีเหตุผลจะยิงโครงสร้างฐานข้อมูลไปลงมือถือทุกเครื่องในทีม */
  const forAdmin = req.user?.role === 'admin';
  return res.status(500).json({
    error: 'เกิดข้อผิดพลาดภายในระบบ',
    ...(forAdmin
      ? { technical: `${err?.name ?? 'Error'}: ${String(err?.message ?? '').slice(0, 300)}` }
      : null),
  });
}
