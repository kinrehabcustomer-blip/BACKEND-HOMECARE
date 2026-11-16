import { Router } from 'express';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { likeEscape } from '../lib/likeEscape.js';
import { AUDIT_LEVELS, AUDIT_RETENTION_DAYS, ensureAuditTable, purgeAuditLogs } from '../lib/audit.js';
import { ACTION_LABELS, labelFor } from './labels.js';
import { can } from '../lib/auth.js';

/**
 * หน้าดูบันทึกการใช้งาน — สิทธิ์ audit_logs ตั้งรายตำแหน่งได้ที่หน้าจัดการสิทธิ์ (ผู้ใช้ขอ 16 พ.ย. 2569)
 * ค่าตั้งต้น: Super Admin เท่านั้น (ได้ครบเสมอ) · การเปิดให้ตำแหน่งอื่นถูกบันทึกเป็น permissions.update
 * การเปิดดู/ส่งออกหน้านี้เองก็ถูกบันทึกด้วย (audit-logs.view · audit-logs.export)
 */
export const auditRouter = Router();

auditRouter.use((req, res, next) =>
  req.user && can(req.user.position, 'audit_logs')
    ? next()
    : next(new ApiError(403, 'บัญชีของคุณไม่มีสิทธิ์ดูบันทึกการใช้งาน — ตั้งได้ที่หน้าจัดการสิทธิ์')),
);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const listSchema = z.object({
  from: z.string().regex(DATE).optional(),
  to: z.string().regex(DATE).optional(),
  level: z.coerce.number().int().min(1).max(4).optional(),
  actor: z.string().trim().max(60).optional(),
  action: z.string().trim().max(80).optional(),
  q: z.string().trim().max(120).optional(),
  ok: z.enum(['1', '0']).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function whereFor(query) {
  const where = [];
  const params = {};
  if (query.from) {
    where.push(`a.at >= (:from::date)::timestamp AT TIME ZONE 'Asia/Bangkok'`);
    params.from = query.from;
  }
  if (query.to) {
    where.push(`a.at < ((:to::date) + 1)::timestamp AT TIME ZONE 'Asia/Bangkok'`);
    params.to = query.to;
  }
  if (query.level) {
    where.push('a.level = :level');
    params.level = query.level;
  }
  if (query.actor) {
    where.push('a.actor_id = :actor');
    params.actor = query.actor;
  }
  if (query.action) {
    // ชื่อเต็ม หรือหมวด (patients → patients.*)
    where.push(`(a.action = :action OR a.action LIKE :action_prefix)`);
    params.action = query.action;
    params.action_prefix = `${likeEscape(query.action)}.%`;
  }
  if (query.ok) {
    where.push('a.ok = :ok');
    params.ok = query.ok === '1';
  }
  if (query.q) {
    where.push(`(a.actor_name ILIKE :q OR a.actor_id ILIKE :q OR a.target_id ILIKE :q OR a.target_label ILIKE :q
               OR a.action ILIKE :q OR a.path ILIKE :q OR a.ip ILIKE :q OR a.detail ->> 'login' ILIKE :q)`);
    params.q = `%${likeEscape(query.q)}%`;
  }
  return { where, params };
}

const SELECT = `SELECT a.log_id, to_char(a.at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') AS at,
                       a.actor_id, a.actor_name, a.actor_position, a.action, a.level, a.method, a.path,
                       a.target_type, a.target_id, a.target_label, a.status, a.ok, a.ip, a.user_agent, a.detail
                  FROM audit_logs a`;

const withLabel = (r) => ({ ...r, log_id: Number(r.log_id), label: labelFor(r.action) });

// กวาดของเก่าตอนมีคนเปิดหน้านี้ด้วย (สำรองงานตั้งเวลา) — ไม่เกินวันละครั้งต่อ instance
let lastPurge = 0;
const purgeOccasionally = () => {
  if (Date.now() - lastPurge < 24 * 3600_000) return;
  lastPurge = Date.now();
  purgeAuditLogs().catch((err) => console.error('[audit] กวาดบันทึกเก่าไม่สำเร็จ:', err.message));
};

auditRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    await ensureAuditTable();
    purgeOccasionally();
    const query = listSchema.parse(req.query);
    const { where, params } = whereFor(query);
    if (query.before) {
      where.push('a.log_id < :before');
      params.before = query.before;
    }
    const rows = await sql.all(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.log_id DESC LIMIT :limit`,
      { ...params, limit: query.limit + 1 },
    );
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map(withLabel);
    res.set('Cache-Control', 'no-store');
    res.json({ rows: page, has_more: hasMore, next_before: hasMore ? page.at(-1).log_id : null });
  }),
);

/** ส่งออกตามตัวกรองเดียวกัน (หน้าเว็บแปลงเป็นไฟล์ CSV เอง) — ไม่เกิน 20,000 รายการต่อครั้ง */
const EXPORT_MAX = 20_000;
auditRouter.get(
  '/export',
  asyncRoute(async (req, res) => {
    await ensureAuditTable();
    const query = listSchema.parse(req.query);
    if (!query.from || !query.to) throw new ApiError(400, 'กรุณาระบุช่วงวันที่ก่อนส่งออก');
    const { where, params } = whereFor(query);
    const rows = await sql.all(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.log_id DESC LIMIT :limit`,
      { ...params, limit: EXPORT_MAX + 1 },
    );
    res.set('Cache-Control', 'no-store');
    res.json({ rows: rows.slice(0, EXPORT_MAX).map(withLabel), truncated: rows.length > EXPORT_MAX, max: EXPORT_MAX });
  }),
);

/** ตัวเลือกของตัวกรอง + ข้อมูลระยะเก็บ */
auditRouter.get(
  '/meta',
  asyncRoute(async (req, res) => {
    await ensureAuditTable();
    /* ไม่กวาดทั้งตาราง — เก็บทั้งปีอาจถึงหลักล้านแถว และหน้านี้เรียก meta ทุกครั้งที่เปิด
       · รายชื่อในตัวกรอง = พนักงานจากทะเบียน (คนที่ถูกลบไปแล้วยังค้นด้วยช่องค้นหาได้)
       · จำนวน = ค่าประมาณจากสถิติของ Postgres · ตารางยังเล็ก (< 50,000) ค่อยนับจริง
       · รายการเก่าสุด = อ่านปลายดัชนี at */
    const [actors, est, oldest] = await Promise.all([
      sql.all(
        `SELECT employee_id AS actor_id, first_name || ' ' || last_name AS actor_name, position AS actor_position
           FROM employees ORDER BY first_name, last_name LIMIT 2000`,
      ),
      sql.one(`SELECT GREATEST(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = 'audit_logs'::regclass`),
      sql.one(
        `SELECT to_char(at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS oldest
           FROM audit_logs ORDER BY at LIMIT 1`,
      ),
    ]);
    let total = Number(est?.n ?? 0);
    let approx = true;
    if (total < 50_000) {
      total = (await sql.one('SELECT count(*)::int AS n FROM audit_logs')).n;
      approx = false;
    }
    res.json({
      levels: AUDIT_LEVELS,
      actions: Object.entries(ACTION_LABELS).map(([action, label]) => ({ action, label })),
      actors,
      retention_days: AUDIT_RETENTION_DAYS,
      total,
      total_approx: approx,
      oldest: oldest?.oldest ?? null,
    });
  }),
);
