import { Router } from 'express';
import * as repo from './repo.js';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  listQuerySchema,
  certificateSchema,
  certificateImageSchema,
  employeePhotoSchema,
  decodeImage,
  portfolioSchema,
  portfolioUpdateSchema,
  POSITIONS,
  BACK_POSITIONS,
  EMPLOYMENT_TYPES,
  STATUSES,
  EMPLOYEE_CODE_RE,
} from './schema.js';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';
import { sql } from '../db/index.js';
import { canSeeStaffPay, BLOCKED_STATUSES, can } from '../lib/auth.js';
import { ensureLineColumn, ensureLinkCodeTables, hashLinkCode, LINK_CODE_TTL_HOURS } from '../lib/lineBridge.js';
import { randomInt } from 'node:crypto';

export const employeesRouter = Router();

/** รูปไม่ถูกต้องคือความผิดของผู้ส่ง (400) ไม่ใช่ระบบพัง (500) */
function toImage(dataUrl) {
  if (!dataUrl) return null;
  try {
    return decodeImage(dataUrl);
  } catch (err) {
    throw new ApiError(400, err.message);
  }
}

/** ทุก route ที่มี :id จะโหลดพนักงานจาก employee_id (PK) มาก่อน — ไม่มีก็ 404 ตั้งแต่ตรงนี้ */
employeesRouter.param('id', (req, res, next, id) => {
  repo
    .findById(id)
    .then((employee) => {
      if (!employee) return next(notFound(`ไม่พบพนักงานรหัส ${id}`));
      req.employee = employee;
      next();
    })
    .catch(next);
});

/** ค่า enum สำหรับให้ฝั่ง React เอาไปทำ dropdown โดยไม่ต้อง hard-code */
employeesRouter.get('/meta', (req, res) => {
  res.json({ positions: POSITIONS, employment_types: EMPLOYMENT_TYPES, statuses: STATUSES });
});

employeesRouter.get(
  '/summary',
  asyncRoute(async (req, res) => {
    res.json(await repo.summary());
  }),
);

employeesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await repo.list(query));
  }),
);

employeesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const input = createEmployeeSchema.parse(req.body);
    ensureCanGrantManager(req, input.position);
    const employee = await repo.create(input);
    res.set('Cache-Control', 'no-store');
    res.status(201).json(employee);
  }),
);

/**
 * ตรวจรหัสพนักงานระหว่างกรอก (add-on กรอกรหัสเอง) — ต้องมาก่อน '/:id'
 * ?id=A6901059[&except=รหัสของคนที่กำลังแก้] → { valid, available, taken_by }
 * ตัวจริงที่กันซ้ำคือตอนบันทึก (ensureEmployeeCodeFree + PK) อันนี้แค่บอกล่วงหน้า
 */
employeesRouter.get(
  '/check-id',
  asyncRoute(async (req, res) => {
    const code = String(req.query.id ?? '').trim();
    const valid = EMPLOYEE_CODE_RE.test(code);
    const owner = valid ? await repo.codeOwner(sql, code, req.query.except || null) : null;
    res.json({ valid, available: valid && !owner, taken_by: owner?.name ?? null });
  }),
);

employeesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    /* รหัสผ่านชั่วคราวให้เห็นเฉพาะคนที่ "จัดการบัญชีนั้นได้" — ไม่งั้น HR/Admin HC เปิดดูรหัสของบัญชีผู้จัดการ/ฝ่ายการเงิน
       ที่เพิ่งสร้าง แล้ว login เป็นบัญชีนั้นก่อนเจ้าตัว = ได้สิทธิ์เงินผ่านประตูหลัง (ข้าม ensureCanGrantManager) */
    const detail = await repo.findDetailById(req.params.id, false);
    if (!detail || !can(req.user.position, 'office')) return res.json(detail);
    try {
      ensureCanManageTarget(req, detail);
    } catch {
      return res.json(detail);
    }
    res.json(await repo.findDetailById(req.params.id, true));
  }),
);

/**
 * สิทธิ์ในระบบคิดจาก "ตำแหน่ง" (ดู roleForPosition/canSeeStaffPay) — ช่อง position จึงไม่ใช่ข้อมูลธรรมดา
 * มันคือปุ่มเลื่อนสิทธิ์ และหน้าพนักงานเปิดให้ทั้งผู้จัดการและ HR เข้าถึงเท่ากัน
 *
 * ไม่มีตัวกันไว้เลย HR มีทางขึ้นเป็นผู้จัดการสองทางซึ่งง่ายพอกัน:
 *   1. PATCH ใส่รหัสตัวเองเป็น 'manager' แล้วได้สิทธิ์ทันทีในคำขอถัดไป (requireAuth อ่านตำแหน่งสด)
 *   2. POST สร้างพนักงานใหม่ตำแหน่ง 'manager' — รหัสผ่านเริ่มต้นคือรหัสพนักงานซึ่งโชว์อยู่ในตาราง
 *      แล้ว login เป็นบัญชีนั้นได้เลย (ทางนี้ไม่ต้องแตะบัญชีตัวเองด้วยซ้ำ)
 * ปิดทางเดียวไม่พอ ต้องปิดที่ "ใครมีสิทธิ์แต่งตั้งผู้จัดการ" ซึ่งคือผู้จัดการเท่านั้น
 */
/** ผู้ดูแลระบบระดับบน — Super Admin อยู่เหนือผู้จัดการ (ทำทุกอย่างที่ผู้จัดการทำได้ และตั้ง/แก้ Super Admin ได้คนเดียว) */
const isTopAdmin = (position) => position === 'manager' || position === 'super_admin';

export function ensureCanGrantManager(req, nextPosition) {
  if (nextPosition === 'super_admin' && req.user.position !== 'super_admin') {
    throw new ApiError(403, 'เฉพาะ Super Admin เท่านั้นที่ตั้งตำแหน่ง Super Admin ให้คนอื่นได้');
  }
  if (nextPosition === 'manager' && !isTopAdmin(req.user.position)) {
    throw new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่ตั้งตำแหน่งผู้จัดการให้คนอื่นได้');
  }
  // ตำแหน่งที่เห็นเรื่องเงิน (เช่น การเงิน) ก็เป็นการเลื่อนสิทธิ์เหมือนกัน — HR/Admin HC แต่งตั้งเองไม่ได้
  if (canSeeStaffPay(nextPosition) && !canSeeStaffPay(req.user.position)) {
    throw new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่ตั้งตำแหน่งที่เห็นข้อมูลการเงินให้คนอื่นได้');
  }
}

/**
 * บัญชีผู้จัดการแก้/ลดตำแหน่ง/พักงาน/ลบ ได้เฉพาะผู้จัดการด้วยกัน
 *
 * ถ้าไม่กัน HR เปลี่ยนอีเมลของผู้จัดการเป็นอีเมลตัวเอง แล้วกด "ลืมรหัสผ่าน" รับ OTP ไปตั้งรหัสใหม่
 * ก็ได้บัญชีผู้จัดการทั้งบัญชี — เป็นทางอ้อมของการเลื่อนสิทธิ์ที่ ensureCanGrantManager ปิดไว้
 */
export function ensureCanManageTarget(req, target) {
  if (target.position === 'super_admin' && req.user.position !== 'super_admin') {
    throw new ApiError(403, 'เฉพาะ Super Admin เท่านั้นที่แก้ไขหรือนำบัญชี Super Admin ออกได้');
  }
  if (target.position === 'manager' && !isTopAdmin(req.user.position)) {
    throw new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่แก้ไขหรือนำบัญชีผู้จัดการออกได้');
  }
  // บัญชีที่เห็นเรื่องเงินถูกยึดผ่านทางเดียวกับผู้จัดการได้ (แก้อีเมลแล้วกดลืมรหัสผ่าน) — กันแบบเดียวกัน
  if (canSeeStaffPay(target.position) && !canSeeStaffPay(req.user.position)) {
    throw new ApiError(403, 'เฉพาะผู้จัดการเท่านั้นที่แก้ไขหรือนำบัญชีฝ่ายการเงินออกได้');
  }
}

/** กันเลื่อนตำแหน่งตัวเอง และกันลดผู้จัดการคนสุดท้ายจนไม่เหลือใครดูแลระบบ */
export async function ensurePositionChangeAllowed(req, target, nextPosition) {
  if (nextPosition == null || nextPosition === target.position) return;

  if (target.employee_id === req.user.employee_id) {
    throw new ApiError(403, 'เปลี่ยนตำแหน่งของตัวเองไม่ได้ — ต้องให้ผู้จัดการคนอื่นเป็นคนแก้ให้');
  }
  ensureCanGrantManager(req, nextPosition);

  if (isTopAdmin(target.position) && (await repo.activeManagerCount(target.employee_id)) === 0) {
    throw new ApiError(409, 'นี่คือผู้ดูแลระบบคนสุดท้ายที่ใช้งานได้ — ตั้งผู้จัดการคนใหม่ก่อนจึงจะลดตำแหน่งคนนี้ได้');
  }
}

/**
 * ลาออก/พักงาน/ลบ ผู้จัดการคนสุดท้าย ล้วนทำให้ไม่เหลือใครดูแลระบบเหมือนกัน — ใช้เกณฑ์เดียวกันทุกทาง
 *
 * ไม่ใช่แค่ "เสียของ" ชั่วคราว แต่กู้เองไม่ได้: เมื่อไม่เหลือผู้จัดการ ก็ไม่มีใครมีสิทธิ์
 * ตั้งผู้จัดการคนใหม่ได้อีกเลย (ดู ensureCanGrantManager) ต้องเข้าไปแก้ที่ฐานข้อมูลตรงๆ ทางเดียว
 */
export async function ensureRemovable(target, action = 'นำคนนี้ออกได้') {
  if (isTopAdmin(target.position) && (await repo.activeManagerCount(target.employee_id)) === 0) {
    throw new ApiError(409, `นี่คือผู้ดูแลระบบคนสุดท้ายที่ใช้งานได้ — ตั้งผู้จัดการคนใหม่ก่อนจึงจะ${action}`);
  }
}

employeesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const input = updateEmployeeSchema.parse(req.body);
    ensureCanManageTarget(req, req.employee);
    /* เปลี่ยนอีเมลของบัญชีหลังบ้านคนอื่น แล้วกด "ลืมรหัสผ่าน" = ยึดบัญชีนั้นได้ใน 2 ขั้น (ยิงจริงแล้วได้ OTP จริง)
       hr กับ admin สิทธิ์เท่ากัน ensureCanManageTarget จึงไม่กันกันเอง — ไม่ใช่การเลื่อนสิทธิ์
       แต่ทำให้ไล่ย้อนไม่ได้ว่าใครลงมือ ซึ่งสำคัญขึ้นมากตั้งแต่มีบัญชีจริงหลายคน (ตรวจรอบ 9) */
    if (input.email !== undefined && input.email !== req.employee.email
        && BACK_POSITIONS.includes(req.employee.position)
        && req.employee.employee_id !== req.user.employee_id
        && !isTopAdmin(req.user.position)) {
      throw new ApiError(403, 'เปลี่ยนอีเมลของบัญชีหลังบ้านคนอื่นได้เฉพาะผู้จัดการ');
    }

    // รหัสพนักงานคือชื่อที่ใช้ login ด้วย — เปลี่ยนของตัวเองแล้ว session ปัจจุบันหลุดทันที ต้องให้คนอื่นเปลี่ยนให้
    if (input.employee_id && input.employee_id !== req.employee.employee_id
        && req.employee.employee_id === req.user.employee_id) {
      throw new ApiError(403, 'เปลี่ยนรหัสพนักงานของตัวเองไม่ได้ — ให้ผู้จัดการหรือ HR คนอื่นเปลี่ยนให้');
    }
    await ensurePositionChangeAllowed(req, req.employee, input.position);

    const statusChanged = input.status && input.status !== req.employee.status;

    // ปิดบัญชีตัวเอง (ลาออก/พักงาน) แล้วเด้งตัวเองออกทันทีเป็นอุบัติเหตุที่กู้เองไม่ได้
    if (req.employee.employee_id === req.user.employee_id && statusChanged) {
      throw new ApiError(403, 'เปลี่ยนสถานะของตัวเองไม่ได้ — ต้องให้ผู้จัดการคนอื่นเป็นคนแก้ให้');
    }

    /* ตั้งสถานะเป็นลาออก/พักงาน = บัญชีนั้น login ไม่ได้อีก (ดู BLOCKED_STATUSES) ซึ่งให้ผลเท่ากับ
       การนำคนออกจากระบบทุกประการ ปุ่ม "นำออก" (DELETE) กันผู้จัดการคนสุดท้ายไว้แล้วด้วย
       ensureRemovable แต่ถ้าไม่กันที่นี่ด้วย ช่องสถานะในฟอร์มแก้ไขก็เป็นประตูอีกบานที่เปิดอยู่เฉยๆ
       — และเป็นบานที่เดินเข้าง่ายกว่า เพราะดูเหมือนแค่แก้ข้อมูลพนักงานตามปกติ */
    if (statusChanged && BLOCKED_STATUSES[input.status]) {
      await ensureRemovable(req.employee, 'ปิดบัญชีคนนี้ได้');
    }

    res.json(await repo.update(req.params.id, input));
  }),
);

/**
 * ปลด LINE ที่ผูกไว้กับพนักงานคนนี้ (ดู lib/lineBridge.js) — ใช้ตอนเปลี่ยนเครื่อง/เปลี่ยน LINE หรือผูกผิดคน
 * ปลดแล้วเจ้าตัวกดจาก LINE ครั้งหน้าจะต้อง login รหัสผ่านเดิม 1 ครั้งเพื่อผูกใหม่ · เซสชันที่เปิดอยู่ไม่ถูกตัด
 */
employeesRouter.delete(
  '/:id/line',
  asyncRoute(async (req, res) => {
    ensureCanManageTarget(req, req.employee);
    await ensureLineColumn();
    await sql.run('UPDATE employees SET line_user_id = NULL WHERE employee_id = :id', { id: req.params.id });
    res.json({ ok: true });
  }),
);

/**
 * ออกรหัสผูก LINE 6 หลักให้พนักงานคนนี้ (ดู lib/lineBridge.js) — พนักงานพิมพ์รหัสใน LINE @kinjobs แล้วผูกทันที ไม่ต้องใช้รหัสผ่าน
 * ออกใหม่ = รหัสเก่าใช้ไม่ได้ · ผูก LINE อยู่แล้วก็ออกได้ (ใช้ตอนเปลี่ยนเครื่อง/เปลี่ยน LINE)
 */
employeesRouter.post(
  '/:id/line-code',
  asyncRoute(async (req, res) => {
    ensureCanManageTarget(req, req.employee);
    if (BLOCKED_STATUSES[req.employee.status]) throw new ApiError(400, 'บัญชีนี้ถูกปิดอยู่ ออกรหัสผูก LINE ไม่ได้');
    await ensureLineColumn();
    await ensureLinkCodeTables();
    await sql.run('DELETE FROM line_link_codes WHERE expires_at < now()');
    for (let i = 0; i < 5; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const taken = await sql.one(
        'SELECT 1 AS x FROM line_link_codes WHERE code_hash = :h AND employee_id <> :id',
        { h: hashLinkCode(code), id: req.params.id },
      );
      if (taken) continue;
      const row = await sql.one(
        `INSERT INTO line_link_codes (employee_id, code_hash, expires_at, created_by)
         VALUES (:id, :h, now() + make_interval(hours => :ttl), :by)
         ON CONFLICT (employee_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
           created_by = EXCLUDED.created_by, created_at = now()
         RETURNING to_char(expires_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS expires_at`,
        { id: req.params.id, h: hashLinkCode(code), ttl: LINK_CODE_TTL_HOURS, by: req.user.employee_id },
      );
      return res.json({ code, expires_at: row.expires_at, ttl_hours: LINK_CODE_TTL_HOURS });
    }
    throw new ApiError(500, 'ออกรหัสไม่สำเร็จ ลองกดใหม่อีกครั้ง');
  }),
);

/** ค่าเริ่มต้นคือบันทึกลาออก (เก็บประวัติไว้); ?hard=true ถึงจะลบแถวจริง */
employeesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    if (req.employee.employee_id === req.user.employee_id) {
      throw new ApiError(403, 'นำบัญชีของตัวเองออกจากระบบไม่ได้');
    }
    ensureCanManageTarget(req, req.employee);
    await ensureRemovable(req.employee);

    if (req.query.hard === 'true') {
      /* ลบถาวรได้เฉพาะคนที่ยังไม่มีอะไรผูกอยู่ (เช่น เพิ่งกดสร้างผิด) — คนที่เคยทำงานหรือมีเงินค้าง
         ต้องใช้ "บันทึกลาออก" แทน ซึ่งปิดบัญชีได้เหมือนกันแต่ประวัติยังอยู่ครบ */
      const blockers = await repo.removalBlockers(req.params.id);
      if (blockers.unpaid_payouts > 0) {
        throw new ApiError(
          409,
          `คนนี้มีค่าจ้างที่ปล่อยแล้วแต่ยังไม่ได้จ่าย ${blockers.unpaid_payouts} ก้อน — ลบถาวรแล้วเงินก้อนนั้นจะหลุดจากรอบจ่ายทุกรอบอย่างถาวร (จ่ายให้ครบก่อน หรือใช้ "บันทึกลาออก" แทน)`,
        );
      }
      if (blockers.worked_visits > 0) {
        throw new ApiError(
          409,
          `คนนี้มีกะที่เช็คอินไปแล้ว ${blockers.worked_visits} กะ — ลบถาวรแล้วกะเหล่านั้นจะไม่มีเจ้าของและหายไปจากสรุปค่าตอบแทน (ใช้ "บันทึกลาออก" แทน)`,
        );
      }
      await repo.remove(req.params.id);
      return res.status(204).end();
    }
    res.json(await repo.resign(req.params.id, req.body?.resign_date));
  }),
);

// ---------- รูปพนักงาน ----------

/** แนบรูปทับของเดิม หรือส่ง image: null มาเพื่อลบรูปทิ้ง — คืนข้อมูลพนักงานที่อัปเดตแล้ว */
employeesRouter.put(
  '/:id/photo',
  asyncRoute(async (req, res) => {
    // ด่านเดียวกับ PATCH/DELETE /:id — ไม่มีบรรทัดนี้ บัญชีหลังบ้านระดับล่างแก้แฟ้มของผู้จัดการได้ (ตรวจรอบ 9)
    ensureCanManageTarget(req, req.employee);
    const { image } = employeePhotoSchema.parse(req.body);
    res.json(await repo.photo.set(req.params.id, toImage(image)));
  }),
);

/** ส่งไฟล์รูปออกไปตรงๆ — แท็ก <img> เรียกเส้นนี้ (คุกกี้ session ถูกส่งไปด้วยอัตโนมัติ) */
employeesRouter.get(
  '/:id/photo',
  asyncRoute(async (req, res, next) => {
    const row = await repo.photo.find(req.params.id);
    if (!row) return next(notFound('พนักงานคนนี้ยังไม่มีรูป'));

    res.setHeader('Content-Type', row.photo_mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // เป็นข้อมูลส่วนบุคคล — แคชได้เฉพาะเครื่องผู้ใช้ (private)
    // เปลี่ยนรูปแล้วไม่ค้างรูปเก่า เพราะหน้าเว็บต่อ ?v=updated_at ท้าย URL (ดู api.employeePhotoUrl)
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.photo_data);
  }),
);

employeesRouter.get(
  '/:id/certificates',
  asyncRoute(async (req, res) => {
    res.json(await repo.certificates.listFor(req.params.id));
  }),
);

employeesRouter.post(
  '/:id/certificates',
  asyncRoute(async (req, res) => {
    // ด่านเดียวกับ PATCH/DELETE /:id — ไม่มีบรรทัดนี้ บัญชีหลังบ้านระดับล่างแก้แฟ้มของผู้จัดการได้ (ตรวจรอบ 9)
    ensureCanManageTarget(req, req.employee);
    const { image, ...input } = certificateSchema.parse(req.body);
    const created = await repo.certificates.add(req.params.id, {
      ...input,
      image: toImage(image),
    });
    res.status(201).json(created);
  }),
);

/** แนบรูปทับของเดิม หรือส่ง image: null มาเพื่อลบรูปทิ้ง (ตัวใบรับรองยังอยู่) */
employeesRouter.put(
  '/:id/certificates/:certificateId/image',
  asyncRoute(async (req, res, next) => {
    // ด่านเดียวกับ PATCH/DELETE /:id — ไม่มีบรรทัดนี้ บัญชีหลังบ้านระดับล่างแก้แฟ้มของผู้จัดการได้ (ตรวจรอบ 9)
    ensureCanManageTarget(req, req.employee);
    const { image } = certificateImageSchema.parse(req.body);
    const updated = await repo.certificates.setImage(
      req.params.id,
      Number(req.params.certificateId),
      toImage(image),
    );

    if (!updated) return next(notFound('ไม่พบใบรับรองนี้'));
    res.json(updated);
  }),
);

/** ส่งไฟล์รูปออกไปตรงๆ — แท็ก <img> เรียกเส้นนี้ (คุกกี้ session ถูกส่งไปด้วยอัตโนมัติ) */
employeesRouter.get(
  '/:id/certificates/:certificateId/image',
  asyncRoute(async (req, res, next) => {
    const row = await repo.certificates.findImage(req.params.id, Number(req.params.certificateId));
    if (!row) return next(notFound('ไม่พบรูปของใบรับรองนี้'));

    res.setHeader('Content-Type', row.image_mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // รูปใบรับรองไม่เปลี่ยนบ่อย แต่เป็นข้อมูลส่วนบุคคล — ให้เบราว์เซอร์แคชได้เฉพาะเครื่องผู้ใช้ (private)
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.image_data);
  }),
);

employeesRouter.delete(
  '/:id/certificates/:certificateId',
  asyncRoute(async (req, res, next) => {
    // ด่านเดียวกับ PATCH/DELETE /:id — ไม่มีบรรทัดนี้ บัญชีหลังบ้านระดับล่างแก้แฟ้มของผู้จัดการได้ (ตรวจรอบ 9)
    ensureCanManageTarget(req, req.employee);
    const removed = await repo.certificates.remove(req.params.id, Number(req.params.certificateId));
    if (!removed) return next(notFound('ไม่พบใบรับรองนี้'));
    res.status(204).end();
  }),
);

// ---------- ผลงาน (โปรไฟล์พนักงาน) ----------
employeesRouter.get(
  '/:id/portfolio',
  asyncRoute(async (req, res) => {
    res.json(await repo.portfolio.listFor(req.params.id));
  }),
);

employeesRouter.post(
  '/:id/portfolio',
  asyncRoute(async (req, res) => {
    // ด่านเดียวกับ PATCH/DELETE /:id — ไม่มีบรรทัดนี้ บัญชีหลังบ้านระดับล่างแก้แฟ้มของผู้จัดการได้ (ตรวจรอบ 9)
    ensureCanManageTarget(req, req.employee);
    const { image, ...input } = portfolioSchema.parse(req.body);
    res.status(201).json(await repo.portfolio.add(req.params.id, { ...input, image: toImage(image) }));
  }),
);

/** แก้ชื่อ/คำอธิบายของผลงานที่บันทึกแล้ว (รูปเปลี่ยนไม่ได้ — ลบแล้วอัปโหลดใหม่) */
employeesRouter.patch(
  '/:id/portfolio/:portfolioId',
  asyncRoute(async (req, res, next) => {
    // ด่านเดียวกับ PATCH/DELETE /:id — ไม่มีบรรทัดนี้ บัญชีหลังบ้านระดับล่างแก้แฟ้มของผู้จัดการได้ (ตรวจรอบ 9)
    ensureCanManageTarget(req, req.employee);
    const input = portfolioUpdateSchema.parse(req.body);
    const updated = await repo.portfolio.update(req.params.id, Number(req.params.portfolioId), input);

    if (!updated) return next(notFound('ไม่พบผลงานนี้'));
    res.json(updated);
  }),
);

/** ส่งไฟล์รูปผลงานออกไปตรงๆ — แท็ก <img> เรียกเส้นนี้ */
employeesRouter.get(
  '/:id/portfolio/:portfolioId/image',
  asyncRoute(async (req, res, next) => {
    const row = await repo.portfolio.findImage(req.params.id, Number(req.params.portfolioId));
    if (!row) return next(notFound('ไม่พบรูปผลงานนี้'));

    res.setHeader('Content-Type', row.image_mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.image_data);
  }),
);

employeesRouter.delete(
  '/:id/portfolio/:portfolioId',
  asyncRoute(async (req, res, next) => {
    // ด่านเดียวกับ PATCH/DELETE /:id — ไม่มีบรรทัดนี้ บัญชีหลังบ้านระดับล่างแก้แฟ้มของผู้จัดการได้ (ตรวจรอบ 9)
    ensureCanManageTarget(req, req.employee);
    const removed = await repo.portfolio.remove(req.params.id, Number(req.params.portfolioId));
    if (!removed) return next(notFound('ไม่พบผลงานนี้'));
    res.status(204).end();
  }),
);
