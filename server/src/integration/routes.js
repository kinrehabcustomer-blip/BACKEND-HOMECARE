import { Router } from 'express';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { ensureLineColumn, isLineUserId, verifySigned } from '../lib/lineBridge.js';
import { createEmployeeSchema } from '../employees/schema.js';
import * as repo from '../employees/repo.js';
import * as cases from '../cases/repo.js';
import { BLOCKED_STATUSES } from '../lib/auth.js';

/**
 * ทางเข้าจากระบบสมัครงาน chat.kinorigin.com (ดร.ธงชัย 22 ต.ค. 2569 "ได้งาน → สร้างพนักงานใน staff ในคลิกเดียว")
 *
 * ไม่ใช้คุกกี้ — คำขอทุกใบลงลายเซ็น Ed25519 จากฝั่ง chat (purpose 'kin-hire' อายุ 5 นาที · ดู lib/lineBridge.js)
 * ฝั่ง chat ยิงหลังแอดมินที่ล็อกอินแล้วกดปุ่มที่ใบสมัคร จึงไม่มีคนนอกเรียกเส้นนี้ได้โดยไม่มีกุญแจลับ
 *
 * กันซ้ำ: LINE นี้ผูกกับพนักงานอยู่แล้ว = คืนคนเดิม (กดซ้ำได้ไม่เกิดคนซ้อน)
 *         เบอร์โทรตรงกับพนักงานที่มีอยู่ = ไม่สร้าง ตอบ 409 พร้อมรหัสคนนั้น ให้ทีมตัดสินเอง
 *         (ไม่ผูก LINE ให้คนเดิมเองจากเบอร์ — ผูกผิดคน = เข้าบัญชีคนอื่นได้)
 * รหัสผ่านชั่วคราวไม่ส่งกลับ — ฝ่ายบุคคลดูได้ที่หน้าพนักงานตามเดิม เจ้าตัวเข้าจาก LINE ได้เลยเพราะผูกให้แล้ว
 */
export const integrationRouter = Router();

const hireSchema = z.object({ token: z.string().min(1) });

/**
 * สรุปงานของฉันให้หน้า "งานของฉัน" ใน LINE (chat.kinorigin.com/me) — ตั๋ว purpose 'kin-my' อายุ 1 นาที ยิงจากเซิร์ฟเวอร์ chat
 * ส่งแค่ที่จำเป็นต่อการเห็นภาพรวม: วันที่ เวลา รหัสเคส ชนิดบริการ สถานะกะ · ไม่ส่งชื่อ/ที่อยู่/เบอร์ผู้ป่วย และไม่ส่งยอดเงิน
 * เพราะลิงก์หน้า /me ส่งต่อกันได้ — รายละเอียดเต็มดูในระบบงานนี้ (เข้าด้วยตั๋ว LINE อายุสั้น + ผูกด้วยรหัสผ่าน)
 */
const thDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3.6e6 + offsetDays * 864e5).toISOString().slice(0, 10);
const shiftBrief = (v) => ({
  case_id: v.case_id,
  date: v.visit_date,
  start: v.planned_start,
  end: v.planned_end,
  state: v.state,
  service: v.physio_package_name || v.format_name || null,
  reports: v.report_count,
});

integrationRouter.post(
  '/my-summary',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-my');
    if (!p || !isLineUserId(p.u)) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();

    const emp = await sql.one(
      `SELECT employee_id, first_name, last_name, position, status FROM employees WHERE line_user_id = :uid`,
      { uid: p.u },
    );
    if (!emp || BLOCKED_STATUSES[emp.status]) return res.json({ linked: false });

    const [today, tomorrow, slip] = await Promise.all([
      cases.visitsForEmployeeOn(emp.employee_id, thDate(0)),
      cases.visitsForEmployeeOn(emp.employee_id, thDate(1)),
      sql.one(
        `SELECT r.period_month, r.round_no, r.pay_date
         FROM payroll_items i JOIN payroll_runs r ON r.run_id = i.run_id
         WHERE i.employee_id = :emp AND r.status = 'paid'
         ORDER BY r.pay_date DESC, r.run_id DESC LIMIT 1`,
        { emp: emp.employee_id },
      ),
    ]);
    res.json({
      linked: true,
      employee: { employee_id: emp.employee_id, name: `${emp.first_name} ${emp.last_name}`, position: emp.position },
      today: today.filter((v) => v.state !== 'cancelled').map(shiftBrief),
      tomorrow: tomorrow.filter((v) => v.state !== 'cancelled').map(shiftBrief),
      last_slip: slip ?? null,
    });
  }),
);


const digits = (s) => String(s ?? '').replace(/\D/g, '');

integrationRouter.post(
  '/hire',
  asyncRoute(async (req, res) => {
    const { token } = hireSchema.parse(req.body);
    const p = verifySigned(token, 'kin-hire');
    if (!p || !p.d) throw new ApiError(401, 'ลายเซ็นไม่ถูกต้องหรือหมดอายุ');
    await ensureLineColumn();

    const lineUserId = isLineUserId(p.d.line_user_id) ? p.d.line_user_id : null;
    if (lineUserId) {
      const linked = await sql.one(
        `SELECT employee_id, first_name || ' ' || last_name AS name FROM employees WHERE line_user_id = :uid`,
        { uid: lineUserId },
      );
      if (linked) return res.json({ employee_id: linked.employee_id, name: linked.name, created: false });
    }

    const input = createEmployeeSchema.parse(p.d.employee);
    const phone = digits(input.phone);
    if (phone.length >= 9) {
      const same = await sql.one(
        `SELECT employee_id, first_name || ' ' || last_name AS name FROM employees
         WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = :phone LIMIT 1`,
        { phone },
      );
      if (same) {
        return res.status(409).json({
          error: `เบอร์นี้มีในระบบแล้ว: ${same.employee_id} ${same.name} — ตรวจว่าเป็นคนเดียวกันไหมก่อน`,
          employee_id: same.employee_id,
          name: same.name,
        });
      }
    }

    // ตำแหน่งหลังบ้าน (ผู้จัดการ/HR/แอดมิน/การเงิน) ห้ามสร้างจากทางนี้ — ใบสมัครเป็นงานภาคสนามเท่านั้น
    if (!['caregiver', 'assistant_nurse', 'practical_nurse', 'nurse', 'therapist', 'occupational_therapist', 'speech_therapist'].includes(input.position)) {
      throw new ApiError(400, 'สร้างได้เฉพาะตำแหน่งภาคสนาม');
    }

    const created = await repo.create(input);
    if (lineUserId) {
      await sql.run('UPDATE employees SET line_user_id = :uid WHERE employee_id = :id', {
        uid: lineUserId,
        id: created.employee_id,
      });
    }
    res.status(201).json({
      employee_id: created.employee_id,
      name: `${created.first_name} ${created.last_name}`,
      created: true,
    });
  }),
);
