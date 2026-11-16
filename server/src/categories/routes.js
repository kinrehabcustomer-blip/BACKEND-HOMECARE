import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { can, requirePermission } from '../lib/auth.js';
import * as repo from './repo.js';

/**
 * หมวดหมู่ — อ่านได้ทุกคนที่ login (ช่องเลือกเหตุผลยกเลิก · ช่องค้นหาหัตถการ ใช้ทั่วระบบ)
 * เพิ่ม/แก้ = สิทธิ์ categories (หน้าจัดการสิทธิ์ · ค่าตั้งต้น Super Admin + ผู้จัดการ)
 * ทุกการแก้ถูกบันทึกในบันทึกการใช้งานเองอยู่แล้ว (lib/audit.js)
 */
export const categoriesRouter = Router();
const canManage = requirePermission('categories', 'บัญชีของคุณไม่มีสิทธิ์จัดการหมวดหมู่');

const listSchema = z.object({
  domain: z.enum(repo.DOMAIN_KEYS).optional(),
  all: z.enum(['1', '0']).optional(),
});

categoriesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const q = listSchema.parse(req.query);
    // หมวดที่ปิดแล้ว — ให้เฉพาะคนจัดการหมวดเห็น (ช่องเลือกทั่วไปต้องไม่มีตัวเลือกที่ใช้ไม่ได้)
    const includeInactive = q.all === '1';
    if (includeInactive && !can(req.user?.position, 'categories')) {
      throw new ApiError(403, 'บัญชีของคุณไม่มีสิทธิ์จัดการหมวดหมู่');
    }
    const rows = await repo.list({ domain: q.domain ?? null, includeInactive });
    res.json({ domains: repo.CATEGORY_DOMAINS, categories: rows });
  }),
);

const name = z.string().trim().min(1, 'กรุณากรอกชื่อหมวด').max(120, 'ชื่อหมวดยาวเกิน 120 ตัวอักษร');
const createSchema = z.object({
  domain: z.enum(repo.DOMAIN_KEYS, { errorMap: () => ({ message: 'ไม่รู้จักโดเมนนี้' }) }),
  parent_id: z.number().int().positive().nullable().optional(),
  code: z.string().trim().toUpperCase().optional().nullable(),
  name_th: name,
  name_en: z.string().trim().max(120).optional().nullable(),
});
const updateSchema = z
  .object({
    name_th: name,
    name_en: z.string().trim().max(120).nullable(),
    sort_order: z.number().int().min(0).max(100000),
    active: z.boolean(),
  })
  .partial();

categoriesRouter.post(
  '/',
  canManage,
  asyncRoute(async (req, res) => {
    res.status(201).json(await repo.create(createSchema.parse(req.body ?? {})));
  }),
);

categoriesRouter.patch(
  '/:id',
  canManage,
  asyncRoute(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json(await repo.update(id, updateSchema.parse(req.body ?? {})));
  }),
);
