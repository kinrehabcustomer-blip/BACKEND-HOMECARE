import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { can, requirePermission } from '../lib/auth.js';
import { PERMISSION_ADMINS } from '../lib/permissions.js';
import * as repo from './repo.js';

/**
 * หมวดหมู่ — อ่านได้ทุกคนที่ login (ช่องเลือกเหตุผลยกเลิก · ช่องค้นหาหัตถการ ใช้ทั่วระบบ)
 * เพิ่ม/แก้ แคตตาล็อก (แพ็ก/หัตถการ/อุปกรณ์) = สิทธิ์ categories (หน้าจัดการสิทธิ์ · ค่าตั้งต้น Super Admin + ผู้จัดการ)
 * เพิ่ม/แก้ หมวดของระบบ (meta.settings — เหตุผลยกเลิก · เหตุการณ์) = Super Admin + ผู้จัดการ เท่านั้น (หน้าตั้งค่า)
 * ทุกการแก้ถูกบันทึกในบันทึกการใช้งานเองอยู่แล้ว (lib/audit.js)
 */
export const categoriesRouter = Router();
const canManage = requirePermission('categories', 'บัญชีของคุณไม่มีสิทธิ์จัดการหมวดหมู่');
const isSettingsAdmin = (req) => PERMISSION_ADMINS.includes(req.user?.position);

/** ด่านตามโดเมน — หมวดของระบบต้องเป็น Super Admin/ผู้จัดการ · แคตตาล็อกต้องมีสิทธิ์ categories */
function ensureCanManage(req, domain) {
  if (repo.CATEGORY_DOMAINS[domain]?.settings) {
    if (!isSettingsAdmin(req)) throw new ApiError(403, 'หมวดนี้จัดการได้เฉพาะ Super Admin และผู้จัดการ (หน้าตั้งค่า)');
  } else if (!can(req.user?.position, 'categories')) {
    throw new ApiError(403, 'บัญชีของคุณไม่มีสิทธิ์จัดการหมวดหมู่');
  }
}

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
    if (includeInactive && !can(req.user?.position, 'categories') && !isSettingsAdmin(req)) {
      throw new ApiError(403, 'บัญชีของคุณไม่มีสิทธิ์จัดการหมวดหมู่');
    }
    const rows = await repo.list({ domain: q.domain ?? null, includeInactive });
    // ราคาของแคตตาล็อก (หัตถการ/อุปกรณ์) — ฟอร์มเคสใช้เติมราคา · เป็นราคาขายลูกค้า ไม่ใช่ต้นทุน อ่านได้ทุกคน
    const prices = await repo.listPrices({ domain: q.domain && repo.PRICE_FIELDS[q.domain] ? q.domain : null });
    res.json({
      domains: repo.CATEGORY_DOMAINS,
      categories: rows,
      prices: q.domain && !repo.PRICE_FIELDS[q.domain] ? [] : prices,
      price_fields: repo.PRICE_FIELDS,
    });
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
  asyncRoute(async (req, res) => {
    const body = createSchema.parse(req.body ?? {});
    ensureCanManage(req, body.domain);
    res.status(201).json(await repo.create(body));
  }),
);

/* ตั้งราคาของรายการในแคตตาล็อก (หัตถการ: ครั้ง/วัน/เดือน · อุปกรณ์: เช่า/ขาย) — repo.setPrice */
const money = z.union([z.number(), z.string().trim()])
  .transform((v, ctx) => {
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ราคาต้องเป็นตัวเลข 0 ขึ้นไป' });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  })
  .nullable()
  .optional();
const priceSchema = z.object({
  domain: z.enum(repo.DOMAIN_KEYS, { errorMap: () => ({ message: 'ไม่รู้จักโดเมนนี้' }) }),
  item_key: z.union([z.string(), z.number()]).transform(String),
  price_visit: money, price_day: money, price_month: money, price_rent: money, price_sale: money,
});

categoriesRouter.put(
  '/prices',
  asyncRoute(async (req, res) => {
    const body = priceSchema.parse(req.body ?? {});
    ensureCanManage(req, body.domain);
    res.json(await repo.setPrice(body.domain, body.item_key, body));
  }),
);

/* จัดรายการเข้าหมวดย่อย (แทนทั้งชุด) — โดเมนแคตตาล็อกเท่านั้น (repo.setItems) */
const itemsSchema = z.object({
  item_keys: z
    .array(z.union([z.string(), z.number()]).transform(String))
    .max(repo.MAX_ITEMS, `หมวดหนึ่งมีได้ไม่เกิน ${repo.MAX_ITEMS} รายการ`),
});

categoriesRouter.put(
  '/:id/items',
  canManage,
  asyncRoute(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    res.json({ categories: await repo.setItems(id, itemsSchema.parse(req.body ?? {}).item_keys) });
  }),
);

categoriesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const domain = await repo.domainOf(id);
    if (!domain) throw new ApiError(404, 'ไม่พบหมวดนี้');
    ensureCanManage(req, domain);
    res.json(await repo.update(id, updateSchema.parse(req.body ?? {})));
  }),
);
