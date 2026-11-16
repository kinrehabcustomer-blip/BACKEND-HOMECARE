import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncRoute } from '../lib/errors.js';
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  PERMISSION_ADMINS,
  EDITABLE_POSITIONS,
  DEFAULT_PERMISSIONS,
  permissionMatrix,
  savePermissions,
  SUPER_ONLY_KEYS,
  keysFor,
  loadPermissions,
} from '../lib/permissions.js';

/**
 * หน้าจัดการสิทธิ์ — Super Admin กับผู้จัดการเท่านั้น (ตายตัว ไม่อยู่ในตารางสิทธิ์ กันปิดทางกลับของตัวเอง)
 * แก้ได้ทุกตำแหน่งสายสำนักงานยกเว้น Super Admin ซึ่งมีสิทธิ์ครบเสมอ
 */
export const permissionsRouter = Router();

permissionsRouter.use((req, res, next) =>
  PERMISSION_ADMINS.includes(req.user?.position)
    ? next()
    : next(new ApiError(403, 'หน้าจัดการสิทธิ์เปิดได้เฉพาะ Super Admin และผู้จัดการ')),
);

const saveSchema = z.object({
  permissions: z.array(z.enum(PERMISSION_KEYS, { errorMap: () => ({ message: 'มีสิทธิ์ที่ระบบไม่รู้จัก' }) })).max(PERMISSION_KEYS.length),
});

/** สิทธิ์ superOnly (บันทึกการใช้งาน) — คนที่ไม่ใช่ Super Admin เปลี่ยนสถานะเปิด/ปิดไม่ได้ ทั้งเปิดเพิ่มและถอนออก */
async function guardSuperOnly(req, position, nextKeys) {
  if (req.user?.position === 'super_admin') return;
  await loadPermissions({ force: true });
  const now = keysFor(position);
  const touched = SUPER_ONLY_KEYS.filter((k) => now.includes(k) !== nextKeys.includes(k));
  if (touched.length) {
    throw new ApiError(403, 'สิทธิ์ "ดูบันทึกการใช้งานระบบ" เปิด/ปิดได้เฉพาะ Super Admin');
  }
}

const editableOr403 = (position) => {
  if (!EDITABLE_POSITIONS.includes(position)) {
    throw new ApiError(403, position === 'super_admin'
      ? 'Super Admin มีสิทธิ์ครบทุกอย่างเสมอ แก้ไม่ได้ — กันไม่ให้ไม่มีใครเข้าระบบจัดการได้'
      : 'ตำแหน่งนี้ไม่ใช่สายสำนักงาน ไม่มีสิทธิ์หลังบ้านให้ตั้ง');
  }
};

permissionsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json({ catalog: PERMISSION_CATALOG, defaults: DEFAULT_PERMISSIONS, positions: await permissionMatrix() });
  }),
);

permissionsRouter.put(
  '/:position',
  asyncRoute(async (req, res) => {
    editableOr403(req.params.position);
    const { permissions } = saveSchema.parse(req.body ?? {});
    await guardSuperOnly(req, req.params.position, permissions);
    await savePermissions(req.params.position, permissions, req.user);
    res.json({ positions: await permissionMatrix() });
  }),
);

/** กลับไปใช้ค่าตั้งต้น (= สิทธิ์เดิมก่อนมีหน้านี้) */
permissionsRouter.delete(
  '/:position',
  asyncRoute(async (req, res) => {
    editableOr403(req.params.position);
    await guardSuperOnly(req, req.params.position, DEFAULT_PERMISSIONS[req.params.position] ?? []);
    await savePermissions(req.params.position, null, req.user);
    res.json({ positions: await permissionMatrix() });
  }),
);
