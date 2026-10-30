import { sql } from '../db/index.js';
import { todayTh } from '../lib/dates.js';
import { ensureFamilyTable } from '../lib/family.js';
import { ensureCustomerLineColumns } from '../lib/customerLine.js';
import { FAMILY_IDS, PHYSIO, START_AT, ensureVisitReminderColumns, ensureVisitNotificationOutbox } from './visitReminders.js';

/**
 * แจ้ง LINE ทันทีเมื่อเกิดเหตุการณ์ในเคส/ปฏิทิน (ต่อยอดจาก visitReminders.js ซึ่งดูแลการเตือนก่อนนัดและการเลื่อนนัด)
 *   case_assigned   → พนักงานที่ได้รับเคส (คนหลักหรือคนในทีม) พร้อมกะข้างหน้าของตัวเอง
 *   case_unassigned → พนักงานที่ถูกถอดจากเคส
 *   case_staff      → ญาติ: ผู้รับผิดชอบหลักของเคสคือใคร (เฉพาะตอนเปลี่ยนคนหลัก)
 *   visits_added    → พนักงาน: กะใหม่ที่เพิ่งถูกลง (รวมเป็นข้อความเดียวต่อคนต่อครั้งที่กดบันทึก)
 *   visit_checkin / visit_checkout → ญาติ: นักกายภาพถึงบ้านแล้ว/เสร็จแล้ว (เฉพาะเคสกายภาพ เหตุผลเดียวกับ family reminder)
 *
 * แยกคิวจาก visit_notification_outbox โดยตั้งใจ — ตัวรับฝั่ง chat.kinorigin.com ที่ใช้อยู่จะไม่เจอชนิดข้อความที่ยังไม่รู้จัก
 * ฝั่ง chat มารับที่ /api/integration/cases/events (ตั๋ว 'kin-case-events') เมื่อพร้อม · ยังไม่มาก็แค่ค้างคิว ไม่กระทบอะไร
 *
 * ทุกฟังก์ชัน on* ถูกเรียกหลังงานหลักบันทึกเสร็จแล้ว ผ่าน notifySafely — แจ้งเตือนพัง = log ไว้ ไม่ทำให้คำขอเดิมล้ม
 */
let ready = null;
export const ensureCaseEventOutbox = () =>
  (ready ??= (async () => {
    await sql.run(`CREATE TABLE IF NOT EXISTS case_event_outbox (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL,
      recipient_line_user_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      case_id TEXT,
      visit_id INTEGER,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      error TEXT
    )`);
    await sql.run(`CREATE INDEX IF NOT EXISTS idx_case_event_pending
      ON case_event_outbox(created_at)
      WHERE sent_at IS NULL AND attempts < 3`);
  })().catch((err) => { ready = null; throw err; }));

export async function notifySafely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[case-events] ${label}:`, err?.message ?? err);
  }
}

/** คืนจำนวนแถวที่เข้าคิวจริง (0 = ซ้ำกับที่อยู่ในคิวแล้ว หรือไม่มีผู้รับ) */
async function queue({ key, channel, recipient, eventKind, caseId, visitId = null, payload }) {
  if (!recipient) return 0;
  await ensureCaseEventOutbox();
  return sql.run(
    `INSERT INTO case_event_outbox
       (dedupe_key, channel, recipient_line_user_id, event_kind, case_id, visit_id, payload)
     VALUES (:key, :channel, :recipient, :eventKind, :caseId, :visitId, :payload::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    { key, channel, recipient, eventKind, caseId, visitId, payload: JSON.stringify(payload) },
  );
}

/**
 * ลิงก์นำทางของเคส — สูตรและเงื่อนไขเดียวกับ "ลิงก์นำทาง" ในหน้าเคส (client/src/components/CaseLocationLink.jsx)
 * ไม่มีพิกัดหรือพิกัดเพี้ยน = null (หน้าเคสก็ไม่แสดงลิงก์) ฝั่ง chat จึงซ่อนปุ่มเปิดแผนที่ได้ตรงกัน
 */
export function mapUrlFor(geoLat, geoLng) {
  if (geoLat == null || geoLat === '' || geoLng == null || geoLng === '') return null;
  const lat = Number(geoLat);
  const lng = Number(geoLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

// กดซ้ำภายในนาทีเดียวกัน = ข้อความเดียว · จับคู่คนเดิมใหม่ในวันหลัง = แจ้งใหม่
const minuteStamp = () => new Date().toISOString().slice(0, 16);
const MAX_LISTED_VISITS = 31;

const staffInfo = (employeeId) =>
  employeeId
    ? sql.one(
        `SELECT employee_id, line_user_id, position,
                COALESCE(NULLIF(nickname, ''), first_name) AS name
         FROM employees WHERE employee_id = :id`,
        { id: employeeId },
      )
    : null;

const caseInfo = (caseId) =>
  sql.one(
    `SELECT c.case_id, c.client_name, c.address, c.geo_lat, c.geo_lng, c.service_kind, c.status,
            ${FAMILY_IDS} AS family
     FROM cases c WHERE c.case_id = :id`,
    { id: caseId },
  );

const upcomingVisitsOf = (caseId, employeeId) =>
  sql.all(
    `SELECT visit_id, visit_date, planned_start, planned_end
     FROM case_visits
     WHERE case_id = :case_id AND assigned_to = :emp AND status = 'scheduled'
       AND check_in_at IS NULL AND visit_date >= :today
     ORDER BY visit_date, planned_start NULLS FIRST, visit_id
     LIMIT ${MAX_LISTED_VISITS}`,
    { case_id: caseId, emp: employeeId, today: todayTh() },
  );

async function prepare() {
  await ensureFamilyTable();
  await ensureCustomerLineColumns();
}

/**
 * คนหลักของเคสเปลี่ยน (assign/unassign) หรือคนในทีมเปลี่ยน
 * from = คนที่ออก · to = คนที่เข้า · role = 'lead' | 'team' — ญาติได้ยินเฉพาะตอนคนหลักเปลี่ยน
 */
export async function onCaseStaffChanged(caseId, { from = null, to = null, role = 'lead' }) {
  if (from === to) return;
  await prepare();
  const c = await caseInfo(caseId);
  if (!c) return;
  const stamp = minuteStamp();
  const base = { case_id: c.case_id, client_name: c.client_name, role };

  const incoming = await staffInfo(to);
  if (incoming?.line_user_id) {
    const visits = await upcomingVisitsOf(caseId, incoming.employee_id);
    await queue({
      key: `case-assigned:${caseId}:${incoming.employee_id}:${role}:${stamp}`,
      channel: 'staff', recipient: incoming.line_user_id, eventKind: 'case_assigned', caseId,
      payload: {
        type: 'staff_case_assigned',
        data: {
          ...base, address: c.address, geo_lat: c.geo_lat, geo_lng: c.geo_lng, map_url: mapUrlFor(c.geo_lat, c.geo_lng),
          service_kind: c.service_kind, upcoming_visits: visits,
        },
        recipient: incoming,
      },
    });
  }

  const outgoing = await staffInfo(from);
  if (outgoing?.line_user_id) {
    await queue({
      key: `case-unassigned:${caseId}:${outgoing.employee_id}:${role}:${stamp}`,
      channel: 'staff', recipient: outgoing.line_user_id, eventKind: 'case_unassigned', caseId,
      payload: { type: 'staff_case_unassigned', data: base, recipient: outgoing },
    });
  }

  if (role === 'lead' && incoming) {
    for (const uid of (c.family ?? []).slice(0, 6)) {
      await queue({
        key: `case-staff:${caseId}:${incoming.employee_id}:${uid}:${stamp}`,
        channel: 'family', recipient: uid, eventKind: 'case_staff', caseId,
        payload: { type: 'family_case_staff', data: { ...base, staff: { name: incoming.name, position: incoming.position } } },
      });
    }
  }
}

/**
 * รหัสกะที่มีอยู่ก่อนลงกะ — route เก็บไว้ก่อนเรียก addVisits แล้วส่งให้ onVisitsAdded เพื่อแยกกะที่เพิ่งเพิ่ม
 * ถูกเรียกก่อนงานหลัก จึงห้ามโยน error — อ่านไม่ได้ = null = ข้ามการแจ้งรอบนี้ไป
 */
export async function visitIdsOf(caseId) {
  try {
    const rows = await sql.all('SELECT visit_id FROM case_visits WHERE case_id = :id', { id: caseId });
    return new Set(rows.map((r) => r.visit_id));
  } catch (err) {
    console.error('[case-events] visitIdsOf:', err?.message ?? err);
    return null;
  }
}

/**
 * กะที่เพิ่งลง (result = ผลจาก addVisits) → แจ้งพนักงานแต่ละคนเป็นข้อความเดียว
 * ไม่แจ้งกะย้อนหลัง (เป็นการลงบันทึก ไม่ใช่งานที่ต้องไป) และกะที่ยังไม่มีคนรับ
 */
export async function onVisitsAdded(caseId, beforeIds, result) {
  if (!beforeIds || !result?.added) return;
  const today = todayTh();
  const fresh = (result.visits ?? []).filter(
    (v) => !beforeIds.has(v.visit_id) && v.assigned_to && v.status === 'scheduled' && v.visit_date >= today,
  );
  if (!fresh.length) return;
  const c = await sql.one('SELECT case_id, client_name, address, geo_lat, geo_lng FROM cases WHERE case_id = :id', { id: caseId });
  if (!c) return;

  const byStaff = new Map();
  for (const v of fresh) byStaff.set(v.assigned_to, [...(byStaff.get(v.assigned_to) ?? []), v]);
  for (const [employeeId, visits] of byStaff) {
    const person = await staffInfo(employeeId);
    if (!person?.line_user_id) continue;
    const ids = visits.map((v) => v.visit_id);
    await queue({
      key: `visits-added:${caseId}:${employeeId}:${Math.min(...ids)}-${Math.max(...ids)}`,
      channel: 'staff', recipient: person.line_user_id, eventKind: 'visits_added', caseId,
      payload: {
        type: 'staff_visits_added',
        data: {
          ...c,
          map_url: mapUrlFor(c.geo_lat, c.geo_lng),
          total: visits.length,
          visits: visits.slice(0, MAX_LISTED_VISITS).map(({ visit_id, visit_date, planned_start, planned_end }) => ({
            visit_id, visit_date, planned_start, planned_end,
          })),
        },
        recipient: person,
      },
    });
  }
}

/** ญาติรู้ว่านักกายภาพถึงแล้ว/เสร็จแล้ว — kind = 'checkin' | 'checkout' · เวลาจากฐานข้อมูลที่บันทึกจริง */
export async function onVisitAttendance(visitId, kind) {
  await prepare();
  const r = await sql.one(
    `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end,
            to_char(v.check_in_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_in_time,
            to_char(v.check_out_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS check_out_time,
            c.client_name, pp.sessions AS package_sessions,
            (SELECT COUNT(*) FROM case_visits o
              WHERE o.case_id = v.case_id AND o.status <> 'cancelled'
                AND (o.visit_date, COALESCE(o.planned_start, ''), o.visit_id)
                    <= (v.visit_date, COALESCE(v.planned_start, ''), v.visit_id))::int AS session_no,
            COALESCE(NULLIF(e.nickname, ''), e.first_name) AS employee_name, e.position AS employee_position,
            ${FAMILY_IDS} AS family
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees e ON e.employee_id = COALESCE(v.checked_in_by, v.assigned_to)
     LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
     WHERE v.visit_id = :id AND ${PHYSIO}`,
    { id: visitId },
  );
  if (!r?.family?.length) return;
  const { family, ...data } = r;
  for (const uid of family.slice(0, 6)) {
    await queue({
      key: `visit-${kind}:${visitId}:${uid}`,
      channel: 'family', recipient: uid, eventKind: `visit_${kind}`, caseId: r.case_id, visitId,
      payload: { type: `family_visit_${kind}`, data },
    });
  }
}

/**
 * แอดมินกด "ส่งเตือน" ที่กะหนึ่งกะ → เตือนพนักงานที่ไปกะนั้น + ญาติของเคส (ทุกประเภทเคส เพราะคนกดตั้งใจเอง)
 * กดซ้ำภายในนาทีเดียวกัน = ไม่เข้าคิวซ้ำ (dedupe ด้วย minuteStamp)
 * คืน { staff, family } = จำนวนข้อความที่เข้าคิว · หรือ { error } ให้ route แปลงเป็นข้อความ HTTP
 */
export async function queueManualReminder(caseId, visitId, actor) {
  await prepare();
  const r = await sql.one(
    `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end, v.status, v.check_in_at,
            c.client_name, c.address, c.geo_lat, c.geo_lng, c.status AS case_status, pp.sessions AS package_sessions,
            (SELECT COUNT(*) FROM case_visits o
              WHERE o.case_id = v.case_id AND o.status <> 'cancelled'
                AND (o.visit_date, COALESCE(o.planned_start, ''), o.visit_id)
                    <= (v.visit_date, COALESCE(v.planned_start, ''), v.visit_id))::int AS session_no,
            e.employee_id, e.line_user_id, e.position AS employee_position,
            COALESCE(NULLIF(e.nickname, ''), e.first_name) AS employee_name,
            ${FAMILY_IDS} AS family
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees e ON e.employee_id = v.assigned_to
     LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
     WHERE v.visit_id = :visitId AND v.case_id = :caseId`,
    { visitId, caseId },
  );
  if (!r) return { error: 'not_found' };
  if (r.status !== 'scheduled' || r.check_in_at || r.visit_date < todayTh() || !ACTIVE_CASE.includes(r.case_status)) {
    return { error: 'not_open' };
  }

  const stamp = minuteStamp();
  const { family, line_user_id: staffLine, check_in_at, status, case_status, ...visit } = r;
  const data = { ...visit, map_url: mapUrlFor(visit.geo_lat, visit.geo_lng), sent_by: actor?.name ?? actor?.first_name ?? null };
  const out = { staff: 0, family: 0, duplicate: false };
  const count = (n, side) => { if (n) out[side] += n; else out.duplicate = true; };

  if (staffLine) {
    count(await queue({
      key: `manual:${visitId}:staff:${staffLine}:${stamp}`,
      channel: 'staff', recipient: staffLine, eventKind: 'manual_reminder', caseId, visitId,
      payload: { type: 'staff_manual_reminder', data },
    }), 'staff');
  }
  const { address, geo_lat, geo_lng, map_url, ...forFamily } = data; // ญาติรู้ที่อยู่ตัวเองอยู่แล้ว ไม่ต้องส่งพิกัด
  for (const uid of (family ?? []).slice(0, 6)) {
    count(await queue({
      key: `manual:${visitId}:family:${uid}:${stamp}`,
      channel: 'family', recipient: uid, eventKind: 'manual_reminder', caseId, visitId,
      payload: { type: 'family_manual_reminder', data: forFamily },
    }), 'family');
  }
  if (out.staff || out.family) out.duplicate = false;
  return out;
}
const ACTIVE_CASE = ['unassigned', 'assigned', 'in_progress'];

/**
 * เตือนญาติ/ลูกค้ารอบ 3 ชม. ก่อนนัด (ดร.ธงชัย 30 ต.ค. 2569 "เตือนก่อนถึงวันนัด 1 วัน และเตือนอีกครั้งก่อนถึงเวลานัด 3 ชั่วโมง")
 *   รอบวันก่อนนัด (08:00) ของญาติอยู่ที่ visitReminders.claimDueFamilyReminders เหมือนเดิม — ที่นี่เติมรอบที่สอง
 *   พนักงานได้ครบสองรอบอยู่แล้ว (claimDueVisitReminders: day + 3h)
 * ขอบเขตเดียวกับรอบวันก่อนนัดของญาติ: เคสกายภาพ · นัดที่ระบุเวลาเริ่ม · มีญาติ/ลูกค้าที่ผูก LINE
 * เข้าคิว case_event_outbox (ไม่ใช่คิวเดิม) — ตัวส่งเดิมฝั่ง chat ยังไม่รู้จักข้อความรอบนี้ ใส่คิวเดิมจะถูกส่งเป็น "พรุ่งนี้มีนัด" ผิดความหมาย
 * จองด้วย UPDATE … RETURNING (ตั้งตรา remind_family_3h_at ทันที) — cron ซ้อนไม่หยิบนัดเดียวกันสองรอบ
 * เลื่อนนัด/เปลี่ยนคน = updateVisit ล้างตรานี้ → เตือนใหม่ตามเวลาใหม่
 *
 * นัดที่ลงกระชั้น (เหลือไม่ถึง 3 ชม.) ญาติได้รอบวันก่อนนัดจากคิวเดิมไปแล้วในช่วงนี้ → ข้ามรอบ 3 ชม.
 * ไม่งั้นได้สองข้อความติดกันภายในไม่กี่นาที · ไม่ไปตัดรอบวันก่อนนัดแทน เพราะฝั่ง chat ยังดึงแค่คิวเดิม
 * ตัดตรงนั้นแล้วนัดกระชั้นจะไม่มีข้อความถึงญาติเลยจนกว่า chat จะมารับคิวนี้
 */
export async function claimDueFamily3hReminders() {
  await ensureVisitReminderColumns();
  await ensureVisitNotificationOutbox();
  await prepare();
  const ids = (
    await sql.all(
      `UPDATE case_visits v
          SET remind_family_3h_at = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
         FROM cases c
        WHERE c.case_id = v.case_id AND v.remind_family_3h_at IS NULL
          AND v.status = 'scheduled' AND v.check_in_at IS NULL AND v.planned_start IS NOT NULL
          AND c.status IN ('unassigned', 'assigned', 'in_progress') AND ${PHYSIO}
          AND now() >= ${START_AT} - interval '3 hours' AND ${START_AT} > now()
          AND ${FAMILY_IDS} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM visit_notification_outbox o
                           WHERE o.visit_id = v.visit_id AND o.event_kind = 'family'
                             AND o.created_at >= ${START_AT} - interval '3 hours')
          AND v.visit_date BETWEEN to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
                               AND to_char((now() AT TIME ZONE 'Asia/Bangkok') + interval '1 day', 'YYYY-MM-DD')
        RETURNING v.visit_id`,
    )
  ).map((r) => r.visit_id);
  if (!ids.length) return 0;

  const rows = await sql.all(
    `SELECT v.visit_id, v.case_id, v.visit_date, v.planned_start, v.planned_end,
            c.client_name, pp.sessions AS package_sessions,
            (SELECT COUNT(*) FROM case_visits o
              WHERE o.case_id = v.case_id AND o.status <> 'cancelled'
                AND (o.visit_date, COALESCE(o.planned_start, ''), o.visit_id)
                    <= (v.visit_date, COALESCE(v.planned_start, ''), v.visit_id))::int AS session_no,
            COALESCE(NULLIF(e.nickname, ''), e.first_name) AS employee_name, e.position AS employee_position,
            ${FAMILY_IDS} AS family
     FROM case_visits v
     JOIN cases c ON c.case_id = v.case_id
     LEFT JOIN employees e ON e.employee_id = v.assigned_to
     LEFT JOIN physio_packages pp ON pp.physio_package_id = c.physio_package_id
     WHERE v.visit_id = ANY(:ids::int[])`,
    { ids },
  );
  let queued = 0;
  for (const { family, ...data } of rows) {
    for (const uid of (family ?? []).slice(0, 6)) {
      queued += await queue({
        key: `family-3h:${data.visit_id}:${data.visit_date}:${data.planned_start}:${uid}`,
        channel: 'family', recipient: uid, eventKind: 'family_3h', caseId: data.case_id, visitId: data.visit_id,
        payload: { type: 'family_reminder_3h', data: { ...data, kind: '3h' } },
      });
    }
  }
  return queued;
}

/** lease 10 นาที + เพิ่ม attempts ตอน claim — แบบเดียวกับ claimVisitNotificationOutbox */
export async function claimCaseEventOutbox(limit = 120) {
  await ensureCaseEventOutbox();
  return sql.all(
    `UPDATE case_event_outbox o
        SET claimed_at = now(), attempts = attempts + 1
       FROM (
         SELECT id FROM case_event_outbox
          WHERE sent_at IS NULL AND attempts < 3
            AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')
          ORDER BY created_at, id
          LIMIT :limit FOR UPDATE SKIP LOCKED
       ) q
      WHERE o.id = q.id
      RETURNING o.id, o.channel, o.recipient_line_user_id, o.event_kind, o.case_id, o.visit_id, o.payload, o.attempts`,
    { limit },
  );
}

export async function ackCaseEventOutbox(results) {
  await ensureCaseEventOutbox();
  let acked = 0;
  for (const r of Array.isArray(results) ? results.slice(0, 200) : []) {
    const id = Number(r?.id);
    if (!Number.isSafeInteger(id)) continue;
    acked += r.ok === true
      ? await sql.run(
          `UPDATE case_event_outbox SET sent_at = now(), claimed_at = NULL, error = NULL
            WHERE id = :id AND sent_at IS NULL`,
          { id },
        )
      : await sql.run(
          `UPDATE case_event_outbox SET claimed_at = NULL, error = left(:error, 1000)
            WHERE id = :id AND sent_at IS NULL`,
          { id, error: String(r?.error || 'ส่งไม่สำเร็จ') },
        );
  }
  return acked;
}
