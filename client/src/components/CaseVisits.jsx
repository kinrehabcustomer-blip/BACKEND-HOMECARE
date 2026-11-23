import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import {
  POSITION_LABELS, VISIT_STATE_LABELS, MONTH_LABELS, formatBaht, formatDate, timeText, toBuddhistYear, todayTH, positionsForCase,
} from '../labels.js';
import LineIcon from './LineIcon.jsx';
import TimeSelect from './TimeSelect.jsx';
import { caseCode } from '../lib/patientCode.js';
import SearchSelect from './SearchSelect.jsx';
import { useConfirm } from './ConfirmDialog.jsx';
import ReasonPicker, { useHasReasons } from './ReasonPicker.jsx';
import MoveVisitDialog from './MoveVisitDialog.jsx';
import ChangeVisitPersonDialog from './ChangeVisitPersonDialog.jsx';
import PartnerLogo from './PartnerLogo.jsx';
import PackSummary from './PackSummary.jsx';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/* ป้ายวันของการ์ดนัด — 'YYYY-MM-DD' → "พ." / "พ.ย." (ปีอื่นต่อท้ายปี พ.ศ. สองหลัก เช่น "ม.ค. 70") · คิดบน UTC ให้วันไม่เลื่อน */
const MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const dowTH = (key) => `${WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()]}.`;
const monTH = (key) => {
  const y = Number(key.slice(0, 4));
  const m = MONTHS_SHORT[Number(key.slice(5, 7)) - 1];
  return y === new Date().getFullYear() ? m : `${m} ${String(y + 543).slice(2)}`;
};

/* สีประจำตัวของแต่ละคนในเคสที่มีหลายคน (ผู้ใช้ขอ 6 พ.ย. 2569) — จุดบนปฏิทิน/ชิปชื่อ/แถวนัดใช้สีเดียวกัน
   เลี่ยงทอง/เขียว/แดง ที่ปฏิทินใช้บอกสถานะนัดอยู่แล้ว · เกิน 6 คนวนสีซ้ำ (ยังมีชื่อกำกับทุกที่) */
const PERSON_COLORS = 6;
// ชิปชื่อเกินนี้แถวจะยาวเกินอ่าน — แถบลงนัดกลับไปใช้ช่องค้นหาชื่อแทน
const MAX_PERSON_CHIPS = 6;

/**
 * ปุ่มเลือกเร็วกวาดกี่วัน — "หนึ่งเดือนของสัญญา" คือ 30 วันติดต่อกัน ไม่ใช่ถึงสิ้นเดือนตามปฏิทิน
 *
 * ของเดิมกวาดแค่ในเดือนที่เปิดดูอยู่ กดวันที่ 24 จึงได้แค่ 8 วันแล้วจบ ทั้งที่งานรายเดือน
 * ต้องลงต่อไปถึงเดือนหน้าให้ครบเดือน — คนใช้ต้องกดลูกศรไปเดือนถัดไปแล้วกดซ้ำอีกครั้งทุกครั้ง
 * และต้องนับเองว่าเดือนหน้าต้องหยุดวันไหนถึงจะไม่เกิน
 */
const SPAN_DAYS = 30;

/** เดินวันถัดไปจาก 'YYYY-MM-DD' — ใช้ UTC ล้วนเพื่อไม่ให้โซนเวลาของเครื่องทำให้วันเลื่อน */
const nextDay = (key) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** 'YYYY-MM-DD' ประกอบเอง — ไม่ใช้ toISOString เพราะแปลงเป็น UTC แล้ววันเพี้ยน */
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// วันนี้ตามเวลาไทย (ไม่ใช่นาฬิกาเครื่อง) — server ตัดสิน "กะที่ผ่านมาแล้ว" ด้วยวันไทย ปุ่มต้องตรงกัน
const todayISO = () => todayTH();

/**
 * เวลากะที่ใช้จริงซ้ำๆ — กดชิปแทนการพิมพ์
 * การพิมพ์เวลาบนมือถือคือขั้นที่ช้าที่สุดของหน้านี้ (native time picker + AM/PM กรอกผิดง่าย)
 * กะที่ไม่เข้าแบบไหนเลย (เช่น ข้ามเที่ยงคืน) ใช้ "กำหนดเอง" ซึ่งยังเป็นช่องเวลาปกติ
 */
const TIME_PRESETS = [
  { key: 'none', label: 'ไม่ระบุเวลา', start: '', end: '' },
  /* กะกลางวัน / กะกลางคืน (ผู้ใช้ขอ 16 พ.ย. 2569) — เคส 24 ชม. แบ่งสองคนผลัดกัน 12 ชม.
     กะกลางคืนข้ามเที่ยงคืน (จบ ≤ เริ่ม) ระบบนับเป็นกะต่อเนื่องถึงเช้าวันถัดไปอยู่แล้ว (ตรวจงานชน/นับชั่วโมง)
     ลงทั้งสองกะในวันเดียวกัน = ยังนับเป็นหนึ่งวันของแพ็ก */
  { key: 'dayshift', label: 'กะกลางวัน 08:00–20:00', start: '08:00', end: '20:00' },
  { key: 'nightshift', label: 'กะกลางคืน 20:00–08:00', start: '20:00', end: '08:00' },
  // 08:00–17:00 / 09:00–18:00 เอาออก (ผู้ใช้ขอ 16 พ.ย. 2569) — เวลาอื่นใช้ "กำหนดเอง"
  { key: 'full', label: '24 ชม.', start: '00:00', end: '23:59' },
];

/**
 * นัดกายภาพบำบัดเป็นการเข้าเซสชันครั้งละราวหนึ่งชั่วโมง ไม่ใช่กะทั้งวันแบบ Homecare
 * ชิปจึงคนละชุดกัน — เอาชุดกะมาใช้จะได้ตัวเลือกที่ไม่มีใครกดเลย (นัดกายภาพ 24 ชม.)
 */
const APPOINTMENT_TIME_PRESETS = [
  { key: 'none', label: 'ไม่ระบุเวลา', start: '', end: '' },
  { key: 'morning', label: '09:00–10:00', start: '09:00', end: '10:00' },
  { key: 'noon', label: '13:00–14:00', start: '13:00', end: '14:00' },
  { key: 'afternoon', label: '15:00–16:00', start: '15:00', end: '16:00' },
];

/** สีของช่องวันบนปฏิทินจากกะทั้งหมดในวันนั้น: มีกะรอ/กำลังทำ = เขียวแบรนด์, เสร็จหมด = เขียวเข้ม, ยกเลิกหมด = แดง */
function dayClass(list) {
  if (!list?.length) return '';
  if (list.some((v) => v.status === 'scheduled')) return 'is-booked visit-scheduled';
  if (list.some((v) => v.status === 'done')) return 'is-booked visit-done';
  return 'is-booked visit-cancelled';
}

/**
 * ปฏิทินลงตารางของเคส — "เลือกวันก่อน แล้วบันทึกทีเดียว"
 *
 * ของเดิมแตะวัน = บันทึกทันทีด้วยค่าที่ตั้งไว้ล่วงหน้าในแถบด้านบน ซึ่งมีปัญหาสามอย่าง:
 * ลืมตั้งค่าก่อนแตะแล้วต้องลบทิ้งทำใหม่ (ไม่มี undo) · ลง 20 กะ = ยิง 20 request ·
 * และรู้ว่ากะชนกับงานอื่นก็ต่อเมื่อบันทึกไปแล้ว
 *
 * ของใหม่: แตะวันเป็นการ "เลือก" (อยู่ในหน้าเว็บล้วนๆ) แก้ไปมาได้จนพอใจ แล้วค่อยกดบันทึกครั้งเดียว
 * ระหว่างเลือกจะเช็คให้ตลอดว่าวันไหนชนกับงานอื่นของคนคนนั้น และวันไหนมีกะเหมือนกันอยู่แล้ว
 *
 * mode='shift' (Homecare)     เลือกคน + เวลาให้กับกะที่กำลังจะลง
 * mode='appointment' (กายภาพ) นับเป็น "ครั้ง" ในคอร์ส ไม่ต้องระบุคน/เวลา
 */
/* onFootAction = popup แม่วาดปุ่ม "ยกเลิกนัดทั้งหมด" เองที่มุมซ้ายของ footer (ผู้ใช้ขอ 19 พ.ย. 2569 — ย้ายจากแถวเลือกเดือน)
   ได้ค่า { label, title, busy, onClick } หรือ null (ไม่มีนัดให้ยกเลิก) · ไม่ส่งมา = วาดปุ่มไว้บนแถวเดือนตามเดิม */
export default function CaseVisits({ caseId, caseItem = null, target = null, readOnly = false, mode = 'shift', onFootAction = null }) {
  const toast = useToast();
  const ask = useConfirm();
  // หมวดเหตุผลยกเลิกนัด (categories · cancel_visit) — มีให้เลือก = กล่องยกเลิกถามเหตุผลเป็นช่องเลือก
  const hasCancelReasons = useHasReasons('cancel_visit');
  // ค่าจ้างรายกะเห็น/แก้ได้เฉพาะผู้จัดการ เหมือนค่าจ้างของเคส (server ตัดฟิลด์ให้อยู่แล้ว)
  const isAppt = mode === 'appointment';
  /* เปิดปฏิทินที่เดือนของ "วันแรกที่ลงนัดได้จริง" ไม่ใช่เดือนปัจจุบันเสมอไป
     เคสที่เริ่มเดือนหน้า ถ้าเปิดมาเจอเดือนนี้ กดเลือกเร็วจะไม่ได้อะไรเลยและไม่รู้ว่าทำไม
     ต้องเดาเองว่าต้องกดลูกศรไปข้างหน้าก่อน — ค่าตั้งต้นควรพาไปที่เดือนที่ทำงานได้ทันที */
  const firstBookable =
    caseItem?.start_date && caseItem.start_date > todayISO() ? caseItem.start_date : todayISO();
  const [year, setYear] = useState(Number(firstBookable.slice(0, 4)));
  const [month, setMonth] = useState(Number(firstBookable.slice(5, 7)));
  const [visits, setVisits] = useState([]);
  const [staff, setStaff] = useState([]);
  // พนักงานทุกคนที่รับงานได้ — ใช้หาคนไปแทน (นอกทีมของเคส) ตอนเปลี่ยนคนไปนัด
  const [allStaff, setAllStaff] = useState([]);
  // เปลี่ยนคนไปนัด (กดชื่อพนักงานในแถวนัด) · { visit, error }
  const [swapping, setSwapping] = useState(null);
  const [partnering, setPartnering] = useState(null); // กะที่กำลังเลือกบริษัทพาร์ทเนอร์ (21 พ.ย. 2569)
  /* ลงนัดแล้วส่งให้พาร์ทเนอร์เลย (ผู้ใช้ขอ 21 พ.ย. 2569) — ชิปบริษัทต่อจากชิปพนักงานในแผงลงนัด
     เลือกบริษัท = ไม่ลงให้พนักงานคนไหน · บริษัทที่เปิดใช้และมีบัญชีหัวหน้าแล้วเท่านั้น (สิทธิ์ไม่พอ = ไม่มีชิป) */
  const [toPartner, setToPartner] = useState(null);
  const [partnerList, setPartnerList] = useState([]);
  useEffect(() => {
    if (readOnly) return undefined;
    let off = false;
    api.partners()
      .then((rows) => !off && setPartnerList(rows.filter((p) => p.status === 'active' && p.leads > 0)))
      .catch(() => {});
    return () => { off = true; };
  }, [readOnly]);
  const pickPerson = (id) => { setWho(id); setToPartner(null); };

  // ร่างที่ยังไม่บันทึก — เลือก/ยกเลิกได้อิสระ ไม่มีอะไรถูกเขียนลงฐานข้อมูลจนกว่าจะกดบันทึก
  const [picked, setPicked] = useState(() => new Set());
  const [who, setWho] = useState('');
  const [timeKey, setTimeKey] = useState('none');
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [preview, setPreview] = useState({ conflicts: [], duplicates: [] });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // เลื่อนนัด (ผู้ใช้ขอ 16 พ.ย. 2569 — แบบเดียวกับลากย้ายในปฏิทินสัปดาห์) · { visit, error }
  const [moving, setMoving] = useState(null);
  // นัดที่ผ่านไปแล้ว (ก่อนวันนี้) พับเก็บได้ (ผู้ใช้ขอ 16 พ.ย. 2569) · null = ตามค่าเริ่มต้น (ดูด้านล่าง)
  const [pastOpen, setPastOpen] = useState(null);
  // สิทธิ์แพ็กกายภาพ (ซื้อ/ลงแล้ว/หมดอายุ) + วันในสัปดาห์ของปุ่ม "ลงนัดทั้งแพ็ก" (ดร.ธงชัย 26 ต.ค. 2569)
  const [quota, setQuota] = useState(null);
  const [packDays, setPackDays] = useState([1, 4]);

  const mm = String(month).padStart(2, '0');
  const today = todayISO();

  /**
   * วันแรกที่ "เลือกเร็ว" จะเริ่มนับ — ไม่มีทางย้อนไปวันที่ผ่านมาแล้ว
   *
   * ของเดิมกวาดทั้งเดือนที่กำลังดูอยู่ กด "ทั้งเดือน" วันที่ 24 จึงได้วันที่ 1–23 ติดมาด้วย
   * ซึ่งเป็นวันที่ผ่านไปแล้ว ลงนัดไม่ได้จริง ต้องมานั่งแตะออกทีละวันก่อนกดบันทึกทุกครั้ง
   *
   * เคสที่ระบุ "วันเริ่ม" ไว้และเป็นวันในอนาคต ให้ยึดวันนั้นแทน — สัญญายังไม่เริ่ม ลงนัดก่อนไม่ได้
   * ส่วนเคสที่วันเริ่มผ่านมาแล้ว วันนี้คือวันแรกที่ลงได้จริง (เทียบข้อความ YYYY-MM-DD ตรงๆ ได้เลย)
   */
  const startFrom = caseItem?.start_date && caseItem.start_date > today ? caseItem.start_date : today;

  const unit = isAppt ? 'นัด' : 'กะ'; // คำเรียกของหนึ่งรายการ ใช้ในข้อความทุกที่ของโหมดนั้น
  const presets = isAppt ? APPOINTMENT_TIME_PRESETS : TIME_PRESETS;
  const time = timeKey === 'custom' ? custom : presets.find((p) => p.key === timeKey) ?? presets[0];
  const plannedStart = time.start;
  const plannedEnd = time.end;

  useEffect(() => {
    let cancelled = false;
    /* ลงกะให้ได้เฉพาะคนที่รับผิดชอบเคสนี้ — ผู้รับผิดชอบหลัก + คนในทีม
       เดิมเป็นรายชื่อพนักงานทั้งบริษัท ซึ่งเลือกผิดคนได้ง่ายมาก (ชื่อคล้ายกัน/เรียงติดกัน)
       และกะที่ลงให้คนนอกเคสจะไปโผล่ในตารางงานของเขาโดยที่เขาไม่เคยรู้จักเคสนี้เลย */
    // โควตาของแพ็ก — กายภาพ (ครั้ง) และ Homecare (วัน ตามรูปแบบบริการ · 16 พ.ย. 2569) ใช้เส้นเดียวกัน
    api.physioQuota(caseId).then((q) => !cancelled && setQuota(q)).catch(() => {});
    Promise.all([api.listVisits(caseId), api.assignableEmployees(), api.listCaseTeam(caseId)])
      .then(([v, all, team]) => {
        if (cancelled) return;
        setVisits(v);

        const inCase = new Set([caseItem?.assigned_to, ...team.map((m) => m.employee_id)].filter(Boolean));
        // ลงกะได้เฉพาะสายดูแล/สายบำบัด — server กันซ้ำตอนบันทึก (ดู ensureAssignable)
        // ผู้รับผิดชอบหลักขึ้นก่อนเสมอ — ได้สีแรกและเป็นคนตั้งต้นของการลงนัด
        const eligible = all.filter((e) => inCase.has(e.employee_id) && e.can_take_cases);
        eligible.sort((a, b) => (b.employee_id === caseItem?.assigned_to) - (a.employee_id === caseItem?.assigned_to));
        setStaff(eligible);
        setAllStaff(all.filter((e) => e.can_take_cases));
        /* หลายคน = ต้องรู้เสมอว่ากำลังลงให้ใคร — ตั้งต้นที่ผู้รับผิดชอบหลัก (ตรงกับที่ server เติมให้ถ้าไม่ระบุ)
           คนเดียว = เหมือนเดิม (กะ: เลือกจากช่องค้นหา · นัดกายภาพ: ผู้รับผิดชอบหลักเสมอ) */
        if (eligible.length >= 2) setWho((w) => w || eligible[0].employee_id);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [caseId, caseItem?.assigned_to]);

  /* เคสที่มีหลายคน: ดูตารางของ "ทุกคน" รวมกัน หรือของคนเดียว (view = รหัสพนักงาน)
     เลือกดูคนไหน = ลงนัดให้คนนั้นด้วย (who) และ "ลบของวันที่เลือก" ลบเฉพาะของคนนั้น
     เดิมนัดกายภาพไม่มีช่องเลือกคนเลย ทุกนัดตกเป็นของผู้รับผิดชอบหลักคนเดียว — ทีมสองคนลงตารางแยกกันไม่ได้ */
  const multi = staff.length >= 2;
  const [view, setView] = useState('');
  const colorIndex = useMemo(() => new Map(staff.map((s, i) => [s.employee_id, i % PERSON_COLORS])), [staff]);
  const dotClass = (id) => (colorIndex.has(id) ? `pc-${colorIndex.get(id)}` : 'pc-none');
  const nameOf = (id) => {
    const s = staff.find((x) => x.employee_id === id);
    return s ? `${s.first_name} ${s.last_name}`.trim() : null;
  };
  const shown = useMemo(
    () => (multi && view ? visits.filter((v) => v.assigned_to === view) : visits),
    [visits, multi, view],
  );
  const countFor = (id) => visits.filter((v) => v.assigned_to === id && v.status !== 'cancelled').length;

  function pickView(id) {
    setView(id);
    if (id) setWho(id); // ดูของใคร = ลงให้คนนั้น — กันลงผิดคนตอนกำลังดูตารางของอีกคนอยู่
  }

  const byDate = useMemo(() => {
    const map = new Map();
    for (const v of shown) {
      if (!map.has(v.visit_date)) map.set(v.visit_date, []);
      map.get(v.visit_date).push(v);
    }
    return map;
  }, [shown]);

  const booked = visits.filter((v) => v.status !== 'cancelled').length;
  const pastCount = shown.filter((v) => v.visit_date < today).length;
  const pastMissed = shown.filter((v) => v.visit_date < today && v.state === 'missed').length;
  const showPast = pastOpen ?? pastCount === shown.length;
  const doneCount = visits.filter((v) => v.state === 'done').length;
  /* เพดานของแพ็ก (ล็อกลงเกิน) — กายภาพ = จำนวนครั้ง (นับนัด) · Homecare = จำนวนวันของรูปแบบบริการ (นับ "วัน" ที่มีกะ
     วันละหลายกะนับหนึ่ง · ผู้ใช้ขอ 16 พ.ย. 2569: รายเดือน 30 วัน · หยุด 4 วัน = 26 วัน) · ไม่มีเพดาน (รายวัน) = null */
  const cap = quota?.sessions ?? (isAppt ? target : null) ?? null;
  const capUnit = isAppt ? 'ครั้ง' : 'วัน';
  const activeDates = useMemo(
    () => new Set(visits.filter((v) => v.status !== 'cancelled').map((v) => v.visit_date)),
    [visits],
  );
  /* เคสที่เข้าระบบกลางทาง: ครั้ง/วันที่ใช้ไปก่อนเข้าระบบ (server นับให้ใน physio-quota) — นับเป็นของที่ใช้แล้ว
     ทั้งในตัวล็อก (ลงเพิ่มได้อีกเท่าไร) แผงสรุป และเลข "ครั้งที่" ของนัดในระบบ (นัดแรกในระบบ = ครั้งที่ 6 ถ้าใช้ไปแล้ว 5) */
  const carried = Number(quota?.carried ?? 0);
  const capUsed = (isAppt ? booked : activeDates.size) + carried;
  const doneDays = new Set(visits.filter((v) => v.state === 'done').map((v) => v.visit_date)).size;
  // แผงสรุป: ใช้ไปแล้ว / ทั้งหมด — มีเพดาน = เพดานของแพ็ก · ไม่มี = กะที่นัดไว้
  const packUsed = (isAppt ? doneCount : cap ? doneDays : doneCount) + carried;
  const packTotal = cap || booked;
  const packUnit = cap ? capUnit : unit;

  const pickedList = useMemo(() => [...picked].sort(), [picked]);
  const conflictDates = useMemo(
    () => new Set(preview.conflicts.map((c) => c.visit_date)),
    [preview.conflicts],
  );
  const duplicateDates = useMemo(() => new Set(preview.duplicates), [preview.duplicates]);
  // วันที่เลือกไว้ (ที่ยังไม่มีกะ) ซึ่งอยู่นอกช่วงวันเริ่ม–วันสิ้นสุดของเคส — ใช้เตือนก่อนบันทึก
  const outOfRange = pickedList.filter(
    (d) => !byDate.has(d)
      && ((caseItem?.start_date && d < caseItem.start_date) || (caseItem?.end_date && d > caseItem.end_date)),
  );
  // วันที่เลือกไว้ซึ่งมีกะอยู่แล้ว = ลบทิ้งได้ (ปุ่มลบจึงโผล่เฉพาะตอนที่ลบได้จริง)
  const pickedWithVisits = pickedList.filter((d) => byDate.has(d));

  /* เคสที่จบแล้วลงนัด/ย้ายนัดไม่ได้ (server: ensureSchedulable) — ซ่อนปุ่มไว้เลย ไม่ให้กดแล้วค่อยเจอ error */
  const caseOpen = !caseItem || !['closed', 'cancelled'].includes(caseItem.status);

  /* เปลี่ยนคนไปนัด (ผู้ใช้ขอ 16 พ.ย. 2569 — นักกายภาพติดธุระ ให้อีกคนไปแทน) — กดชื่อพนักงานในแถวนัด
     รอบแรกเป็นกล่องในแถบเลือกวัน ผู้ใช้บอกว่ายังใช้ยาก จึงย้ายมาไว้ที่แถวนัดเอง
     ทำได้กับนัดที่ยังไม่ถึงวันและยังไม่เช็คอิน · คนไปแทนเลือกได้ทั้งทีมของเคสและคนนอกทีม
     (ไปแทนชั่วคราว ไม่ต้องเพิ่มเข้าทีม — เห็นเคสผ่านนัดที่ได้รับเอง)
     server แจ้ง LINE ถึงคนเดิม (ถอดงาน) และคนใหม่ (ได้งาน) ไม่แจ้งญาติ (notify/visitReminders.js · kind reassigned) */
  const canSwap = (v) => !readOnly && caseOpen && v.status === 'scheduled' && !v.check_in_at && v.visit_date >= today;
  const teamIds = new Set(staff.map((s) => s.employee_id));
  // คนนอกทีม: เฉพาะตำแหน่งที่ตรงกับบริการของเคส (กายภาพ = สายบำบัด) — กติกาเดียวกับตอนจับคู่ (positionsForCase)
  const wanted = caseItem ? positionsForCase(caseItem) : null;
  const outsiders = allStaff.filter((e) => !teamIds.has(e.employee_id) && (!wanted || wanted.includes(e.position)));
  const teamChips = staff.map((s) => ({ ...s, dotClass: multi ? dotClass(s.employee_id) : null }));
  // นัดถัดไปของคนเดิมในเคสนี้ที่ยังเปลี่ยนได้ — ตัวเลือก "เปลี่ยนทั้งชุด" ในกล่อง
  const followUpsOf = (v) => visits.filter((o) => o.visit_id !== v.visit_id && canSwap(o)
    && o.assigned_to === v.assigned_to && o.visit_date >= v.visit_date
    // กะที่ส่งพาร์ทเนอร์อยู่ไม่ติดไปกับ "ทั้งชุด" (ตรวจ 23 พ.ย. 2569) — เปลี่ยนคนกะพวกนั้น = ดึงคืนจากบริษัทเงียบๆ
    && (o.partner_id ?? null) === (v.partner_id ?? null));

  /* พาร์ทเนอร์ (ผู้รับเหมาช่วงรายครั้ง · 21 พ.ย. 2569) — ส่งกะให้บริษัท / ดึงคืน (ให้ผู้รับผิดชอบเคสถ้ามี) */
  async function sendToPartner(v, partner) {
    setBusy(true);
    try {
      await api.sendVisitToPartner(v.visit_id, partner.partner_id);
      setVisits(await api.listVisits(caseId));
      setPartnering(null);
      toast(`ส่งให้ ${partner.name} แล้ว — หัวหน้าบริษัทได้แจ้งเตือน รอเลือกคน`);
    } catch (e) {
      setPartnering((cur) => (cur ? { ...cur, error: e.message } : cur));
    } finally {
      setBusy(false);
    }
  }
  async function pullFromPartner(v) {
    setBusy(true);
    try {
      const lead = caseItem?.assigned_to ?? null;
      await api.pullVisitFromPartner(v.visit_id, lead);
      setVisits(await api.listVisits(caseId));
      toast(lead ? `ดึงกะคืนให้ ${caseItem?.assigned_name ?? 'ผู้รับผิดชอบเคส'} แล้ว` : 'ดึงกะคืนแล้ว — ยังไม่มีคนไป เลือกคนได้ที่ชื่อในนัด');
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSwap(to, targets) {
    const name = [...staff, ...allStaff].find((s) => s.employee_id === to);
    const label = name ? `${name.first_name} ${name.last_name}`.trim() : to;
    setBusy(true);
    setSwapping((s) => ({ ...s, error: null }));
    try {
      for (const v of targets) await api.updateVisit(caseId, v.visit_id, { assigned_to: to });
      setVisits(await api.listVisits(caseId));
      setSwapping(null);
      toast(`เปลี่ยนเป็น ${label} แล้ว ${targets.length} ${unit} · ระบบจะแจ้งทาง LINE`);
    } catch (e) {
      // เปลี่ยนไปได้บางนัดแล้วค่อยพัง — โหลดรายการใหม่ให้เห็นสถานะจริง แล้วบอกเหตุผลในกล่อง
      api.listVisits(caseId).then(setVisits).catch(() => {});
      setSwapping((s) => (s ? { ...s, error: e.message } : s));
    } finally {
      setBusy(false);
    }
  }


  /**
   * ถามฝั่ง server ว่าร่างชุดนี้ชนกับงานอื่นไหม — หน่วงไว้ก่อนยิง
   * ผู้ใช้กดวันรัวๆ ทีละหลายวัน ถ้ายิงทุกครั้งที่แตะจะได้ request ท่วมโดยไม่จำเป็น
   */
  const previewRef = useRef(0);
  useEffect(() => {
    if (pickedList.length === 0 || toPartner) {
      setPreview({ conflicts: [], duplicates: [] });
      return undefined;
    }

    const seq = ++previewRef.current;
    const timer = setTimeout(() => {
      api
        .previewVisits(caseId, {
          dates: pickedList,
          assigned_to: who || null,
          planned_start: plannedStart || null,
          planned_end: plannedEnd || null,
        })
        // ผลของคำขอเก่าที่กลับมาช้ากว่าต้องไม่ทับของใหม่
        .then((r) => seq === previewRef.current && setPreview(r))
        // ตรวจไม่สำเร็จต้องบอก ไม่ใช่ทำเหมือน "ไม่ชน" (ตรวจ Codex 30 ต.ค. 2569 ข้อ 6)
        .catch(() => seq === previewRef.current && setPreview({ conflicts: [], duplicates: [], failed: true }));
    }, 300);

    return () => clearTimeout(timer);
  }, [caseId, pickedList, who, plannedStart, plannedEnd, toPartner]);

  /**
   * ทุกคำสั่งคืน "รายการกะล่าสุด" มาให้เสมอ จึงไม่ต้องดึงซ้ำเอง
   * คำสั่งที่เพิ่ม/ลบทีละหลายกะคืนสรุปผลมาด้วย — เอามาบอกผู้ใช้ว่าเกิดอะไรขึ้นจริง
   * (กดบันทึกแล้วหน้าจอนิ่งเพราะซ้ำทั้งหมด จะดูเหมือนปุ่มเสีย)
   *
   * ผลลัพธ์บอกผ่าน toast ไม่ใช่ข้อความในหน้า เพราะบนมือถือปุ่มบันทึกอยู่ท้ายสุด
   * ข้อความที่อยู่เหนือปฏิทินจึงอยู่นอกจอตอนกด — เท่ากับไม่ได้บอกอะไรเลย
   */
  async function run(action, { clearPicked = false, verb = 'ลบ' } = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (Array.isArray(res)) {
        setVisits(res);
      } else {
        setVisits(res.visits);
        if (res.deleted != null) {
          toast(
            `${verb} ${res.deleted} ${unit}` +
              (res.kept ? ` · เก็บ ${res.kept} ${unit}ที่เช็คอินไปแล้วไว้` : '') +
              (res.past ? ` · ${res.past} ${unit}ที่ผ่านมาแล้วลบไม่ได้ (ถ้าไม่ได้ไปให้กด "ยกเลิก" ที่${unit}นั้น)` : ''),
          );
        } else if (res.added != null) {
          toast(`บันทึก ${res.added} ${unit}${res.skipped ? ` · ข้าม ${res.skipped} วันที่มี${unit}เหมือนกันอยู่แล้ว` : ''}`);
        }
      }
      if (clearPicked) setPicked(new Set());
      api.physioQuota(caseId).then(setQuota).catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** ส่งเตือนนัดทาง LINE เอง — ไม่เปลี่ยนรายการกะ จึงไม่ผ่าน run() · ข้อความเข้าคิว ส่งจริงเมื่อระบบแชทมารับ */
  async function remind(v) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.remindVisit(caseId, v.visit_id);
      const who = [res.staff && 'พนักงาน', res.family && `ญาติ ${res.family} คน`].filter(Boolean).join(' และ ');
      toast(`เข้าคิวส่ง LINE ถึง${who}แล้ว`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const canMoveVisit = (v) => !readOnly && caseOpen && v.state === 'scheduled' && !v.check_in_at && v.visit_date >= today;

  /**
   * เลื่อนนัดไปวัน/เวลาใหม่ — เส้นเดียวกับลากย้ายในปฏิทิน (POST …/move) จึงแจ้งเลื่อนนัดทาง LINE ถึงพนักงานและญาติเหมือนกัน
   * ไม่สำเร็จ = กล่องยังเปิดอยู่พร้อมเหตุผล (เช่น เวลาผ่านไปแล้ว) ให้แก้แล้วกดใหม่ได้ทันที
   */
  async function confirmMove(to, times) {
    const v = moving.visit;
    setBusy(true);
    setMoving((m) => ({ ...m, error: null }));
    try {
      const res = await api.moveVisit(caseId, v.visit_id, to, times ?? {});
      setVisits(await api.listVisits(caseId));
      setMoving(null);
      const where = `${formatDate(to)}${times ? ` ${times.planned_start}` : ''}`;
      toast(
        res.conflicts?.length
          ? `เลื่อนไป ${where} แล้ว · ชนกับงานอื่นของ ${v.assigned_name ?? 'พนักงาน'} ${res.conflicts.length} รายการ ตรวจตารางอีกครั้ง`
          : `เลื่อนไป ${where} แล้ว · ระบบจะแจ้งพนักงานและญาติทาง LINE`,
      );
    } catch (e) {
      setMoving((m) => (m ? { ...m, error: e.message } : m));
    } finally {
      setBusy(false);
    }
  }

  /* ยกเลิกนัดที่ลงไว้ทั้งหมด (ผู้ใช้ขอ 19 พ.ย. 2569) — นัดที่ยังไม่ถึงวัน (รวมวันนี้) และยังไม่เช็คอิน
     กติกาเดียวกับปุ่ม "ยกเลิก" ทีละนัด: นำออกจากตาราง (โควตาแพ็กคืน) + แจ้ง LINE พนักงานและญาติรายนัดพร้อมเหตุผล
     นัดที่ผ่านมาแล้ว (ขาดงาน) และที่เช็คอินแล้วไม่แตะ · ดูตารางของคนเดียวอยู่ = เฉพาะนัดของคนนั้น */
  const upcoming = shown.filter((v) => !v.check_in_at && v.visit_date >= today && v.status !== 'cancelled');
  async function cancelAllUpcoming() {
    const whose = multi && view ? ` ของ ${nameOf(view)}` : '';
    const first = upcoming[0]?.visit_date;
    const last = upcoming[upcoming.length - 1]?.visit_date;
    const answer = await ask({
      title: `ยกเลิก${unit}ที่ลงไว้ทั้งหมด${whose} ${upcoming.length} ${unit}?`,
      detail:
        `${unit}ตั้งแต่ ${formatDate(first)}${first !== last ? ` ถึง ${formatDate(last)}` : ''} จะถูกนำออกจากตาราง ` +
        `และระบบจะแจ้งยกเลิกทาง LINE ถึงพนักงานและญาติที่ผูกเคสไว้ทีละ${unit} พร้อมเหตุผลนี้` +
        (pastCount > 0 ? ` · ${unit}ที่ผ่านไปแล้วเก็บไว้เป็นประวัติตามเดิม` : ''),
      ...(hasCancelReasons
        ? {
          select: {
            required: true,
            render: (value, set) => (
              <ReasonPicker domain="cancel_visit" label="เหตุผลที่ยกเลิก" required value={value} onChange={set} autoFocus />
            ),
          },
          input: { label: 'รายละเอียดเพิ่มเติม (ไม่บังคับ)', placeholder: 'เช่น ผู้รับบริการเข้าโรงพยาบาล' },
        }
        : { input: { label: 'หมายเหตุ / เหตุผลที่ยกเลิก', placeholder: 'เช่น ผู้รับบริการเข้าโรงพยาบาล', required: true } }),
      confirmLabel: `ยกเลิกทั้งหมดและแจ้ง`,
      cancelLabel: 'ไม่ยกเลิก',
      danger: true,
    });
    if (answer == null) return;
    const body = typeof answer === 'string'
      ? { reason: answer }
      : { reason: answer.text || null, reason_id: Number(answer.choice) };
    if (multi && view) body.employee = view;
    run(() => api.cancelUpcomingVisits(caseId, body), { clearPicked: true, verb: 'ยกเลิก' });
  }
  const canCancelAll = !readOnly && caseOpen && upcoming.length > 0;
  const cancelAllLabel = `ยกเลิก${unit}ทั้งหมด (${upcoming.length})`;
  const cancelAllTitle = `ยกเลิก${unit}ที่ยังไม่ถึงวันทั้งหมด — แจ้งพนักงานและญาติทาง LINE`;
  // ฟังก์ชันล่าสุดเสมอ (ปิดค่าของรอบ render ล่าสุด) — popup แม่ถือแค่ตัวเรียกผ่าน ref ไม่ต้องรับฟังก์ชันใหม่ทุก render
  const cancelAllRef = useRef(cancelAllUpcoming);
  cancelAllRef.current = cancelAllUpcoming;
  useEffect(() => {
    if (!onFootAction) return undefined;
    onFootAction(canCancelAll
      ? { label: cancelAllLabel, title: cancelAllTitle, busy, onClick: () => cancelAllRef.current() }
      : null);
    return undefined;
  }, [onFootAction, canCancelAll, cancelAllLabel, cancelAllTitle, busy]);
  useEffect(() => () => onFootAction?.(null), [onFootAction]);

  /* แพ็กกายภาพ: ลงนัดได้ไม่เกินจำนวนครั้งของแพ็ก (ผู้ใช้ขอ 16 พ.ย. 2569 · server ล็อกซ้ำใน ensurePhysioRoom)
     วันที่มีนัดอยู่แล้วยังเลือกได้เสมอ — เลือกไว้เพื่อลบ ไม่ใช่เพื่อเพิ่ม */
  const quotaLeft = cap ? Math.max(0, cap - capUsed) : Infinity;
  // ปุ่ม "ทุกวัน N วัน" — Homecare ที่มีจำนวนวันของแพ็ก ใช้ตัวนั้น (รายเดือน 30 · หยุด 4 วัน = 26) · อื่นๆ 30 วันตามเดิม
  const everyDays = !isAppt && cap ? cap : SPAN_DAYS;
  // วันที่เลือกที่จะกลายเป็นนัด/วันใหม่ — วันที่มีนัด (ไม่ถูกยกเลิก) อยู่แล้วไม่นับ (เลือกไว้เพื่อลบ/เปลี่ยน)
  const pickedNew = pickedList.filter((d) => !activeDates.has(d)).length;
  const overPick = pickedNew > quotaLeft;

  function toggleDay(dateStr) {
    if (readOnly) return;
    if (!picked.has(dateStr) && !activeDates.has(dateStr) && pickedNew >= quotaLeft) {
      toast(quotaLeft === 0
        ? `ลง${unit}ครบ ${cap} ${capUnit}ของแพ็กเกจแล้ว — ลบ/ยกเลิก${unit}เดิมก่อนจึงจะลงวันใหม่ได้`
        : `แพ็กเกจเหลือ ${quotaLeft} ${capUnit} — เลือกครบแล้ว เอาวันที่เลือกไว้ออกก่อนถ้าต้องการเปลี่ยน`);
      return;
    }
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  }

  /**
   * เลือกเร็ว 30 วันติดต่อกันตามวันในสัปดาห์ที่ระบุ — ข้ามไปเดือนถัดไปได้
   *
   * จุดตั้งต้นคือวันแรกที่ลงได้จริงของเดือนที่กำลังเปิดดู: เปิดเดือนนี้อยู่ก็เริ่มที่วันนี้
   * เปิดเดือนหน้าก็เริ่มวันที่ 1 ของเดือนนั้น — คนกดจึงได้ช่วงที่ตรงกับสิ่งที่เห็นตรงหน้าเสมอ
   */
  function pickPattern(weekdays, { fill = false } = {}) {
    const monthStart = iso(year, month, 1);
    const monthEnd = iso(year, month, new Date(year, month, 0).getDate());

    // ทั้งเดือนที่เปิดดูอยู่ผ่านไปแล้ว — ไม่มีอะไรให้เลือก บอกเหตุผลแทนการเงียบ
    if (monthEnd < startFrom) {
      toast(`เดือนนี้ผ่านไปแล้ว — เลือกได้ตั้งแต่ ${formatDate(startFrom)} เป็นต้นไป`);
      return;
    }

    const anchor = monthStart > startFrom ? monthStart : startFrom;

    /* แพ็กมีเพดาน — หยุดให้พอดีที่เหลือ (กายภาพ = ครั้ง · Homecare = วัน)
       Homecare: วันที่มีกะอยู่แล้วไม่กินโควตา (ลงกะที่สองของวันเดิม = วันเดิม) — เคส 24 ชม. ลงกะกลางวันครบ 30 วัน
       แล้วต้องลงกะกลางคืนให้อีกคนทับวันเดิมได้ (ผู้ใช้เจอ 16 พ.ย. 2569: เดิมนับทุกวันที่เลือก ปุ่มเลยขึ้น "ครบแล้ว")
       วันที่เลือกไว้ก่อนแล้วก็ไม่นับซ้ำ (นับอยู่ใน pickedNew แล้ว) */
    let budget = cap ? Math.max(0, quotaLeft - pickedNew) : Infinity;
    const costOf = (d) => (picked.has(d) || (!isAppt && activeDates.has(d)) ? 0 : 1);
    let capped = false;

    const keys = [];
    let cursor = anchor;
    /* fill = ลงนัดทั้งแพ็ก: ไล่ต่อจนครบจำนวนครั้งที่เหลือ (ไม่จำกัด 30 วัน) แต่ไม่เลยวันหมดอายุแพ็ก */
    // "ทุกวัน" ของ Homecare = จำนวนวันของแพ็ก (หยุด 4 วัน = 26 · 16 พ.ย. 2569) · จ–ศ / ส–อา ยังกวาดหน้าต่าง 30 วันเหมือนเดิม
    const span = fill ? 400 : !weekdays ? everyDays : SPAN_DAYS;
    const until = quota?.expires_on ?? null;
    for (let i = 0; i < span; i += 1) {
      if (until && cursor > until) break;
      if (!weekdays || weekdays.includes(new Date(`${cursor}T00:00:00Z`).getUTCDay())) {
        const cost = costOf(cursor);
        if (cost > budget) { capped = true; break; }
        budget -= cost;
        keys.push(cursor);
      }
      cursor = nextDay(cursor);
    }

    /* นับจาก picked ของรอบนี้ ไม่ใช่นับในตัวอัปเดต state — React อาจรันตัวอัปเดตทีหลัง (ตอน render)
       ตัวนับจึงยังเป็น 0 ตอนเลือกข้อความ แล้วขึ้น "ถูกเลือกไว้ครบแล้ว" ทั้งที่เพิ่งเลือกไป (พบ 16 พ.ย. 2569) */
    const added = keys.filter((key) => !picked.has(key)).length;
    setPicked((prev) => new Set([...prev, ...keys]));

    if (added === 0) {
      toast(
        capped
          ? `ครบจำนวนของแพ็คเกจแล้ว (${cap} ${capUnit})`
          : 'วันที่ตรงกับแบบนี้ถูกเลือกไว้ครบแล้ว',
      );
      return;
    }

    /* บอกช่วงที่ได้จริงทุกครั้ง — ปุ่มเดียวเลือกได้ 30 วันข้ามเดือน ถ้าไม่บอกว่าถึงวันไหน
       คนกดต้องไล่ดูปฏิทินทีละเดือนเองเพื่อตรวจว่าระบบเลือกให้ถูกหรือเปล่า */
    const last = keys[keys.length - 1];
    toast(
      capped || (cap && budget === 0 && keys.some((k) => costOf(k) > 0))
        ? `เลือกให้ ${added} วัน (${formatDate(anchor)} – ${formatDate(last)}) — พอดีจำนวน${capUnit}ที่เหลือของแพ็คเกจ`
        : `เลือกให้ ${added} วัน: ${formatDate(anchor)} – ${formatDate(last)}`,
    );
  }

  function save() {
    return run(
      () =>
        api.addVisits(caseId, {
          dates: pickedList,
          ...(toPartner ? { partner_id: toPartner.partner_id } : { assigned_to: who || null }),
          planned_start: plannedStart || null,
          planned_end: plannedEnd || null,
        }),
      { clearPicked: true },
    );
  }


  function shiftMonth(delta) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }

  const leading = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  return (
    <>
      {/* สรุปแพ็ก/ตาราง (ผู้ใช้ขอ 16 พ.ย. 2569) — เหลือแค่ "ใช้ไปแล้ว X / ทั้งหมด N" + แถบเดียว + วันหมดอายุ
          (รอบแรกมีตัวเลขแยก ไปแล้ว/ขาดงาน/รอไป/ยังไม่ลงนัด ผู้ใช้ขอเอาออก)
          ใช้ไปแล้ว = นัดที่ไปจริง (เช็คอินแล้ว) · ทั้งหมด = จำนวนครั้งของแพ็ก (Homecare ไม่มีเพดาน = กะที่นัดไว้) */}
      <PackSummary
        used={packUsed}
        total={packTotal}
        unitWord={packUnit}
        expiresOn={isAppt ? quota?.expires_on ?? null : null}
        today={today}
        carried={carried}
      />

      <div className="visit-head">
        <div className="visit-nav">
          <button type="button" className="btn tiny" onClick={() => shiftMonth(-1)} aria-label="เดือนก่อนหน้า">←</button>
          <span className="visit-month">{MONTH_LABELS[mm]} {toBuddhistYear(year)}</span>
          <button type="button" className="btn tiny" onClick={() => shiftMonth(1)} aria-label="เดือนถัดไป">→</button>
        </div>
        {canCancelAll && !onFootAction && (
          <button
            type="button"
            className="btn tiny danger-ghost visit-cancel-all"
            disabled={busy}
            title={cancelAllTitle}
            onClick={cancelAllUpcoming}
          >
            <LineIcon name="x-circle" className="text-ico" />
            {cancelAllLabel}
          </button>
        )}
      </div>

      {/* เตือนอย่างเดียว ไม่บล็อก (ดร. 26 ต.ค. 2569) — นัดที่เลยวันหมดอายุแพ็ก */}
      {quota?.expires_on && visits.some((v) => v.status !== 'cancelled' && v.visit_date > quota.expires_on) && (
        <p className="notice">
          มีนัดเลยวันหมดอายุแพ็ก ({formatDate(quota.expires_on)}){' '}
          {visits.filter((v) => v.status !== 'cancelled' && v.visit_date > quota.expires_on).length} นัด — ตรวจกับลูกค้าก่อน
        </p>
      )}
      {/* ไม่มีป้ายค้าง "นัดเกิน/ครบจำนวนครั้ง" แล้ว (ผู้ใช้ขอ 16 พ.ย. 2569) — เตือนเฉพาะตอนแตะวันเกินแพ็ก (toast ใน toggleDay)
          ยอด "นัดแล้ว X / N ครั้ง" บนหัวยังบอกจำนวนอยู่ */}
      {error && <p className="error">{error}</p>}

      {/* เคสหลายคน: แท็บเลือกดูตารางของใคร — ตัวเลข = นัดที่ยังไม่ยกเลิกของคนนั้น */}
      {multi && (
        <div className="visit-people" role="group" aria-label={`ดู${unit}ของ`}>
          <button type="button" className="vp-chip" aria-pressed={view === ''} onClick={() => pickView('')}>
            ทุกคน <span className="vp-n">{booked}</span>
          </button>
          {staff.map((s) => (
            <button
              key={s.employee_id}
              type="button"
              className="vp-chip"
              aria-pressed={view === s.employee_id}
              onClick={() => pickView(s.employee_id)}
              title={`${s.first_name} ${s.last_name} · ${POSITION_LABELS[s.position] ?? ''}`}
            >
              <i className={`vp-dot ${dotClass(s.employee_id)}`} aria-hidden="true" />
              <span className="vp-name">{s.first_name} {s.last_name}</span>
              <span className="vp-n">{countFor(s.employee_id)}</span>
            </button>
          ))}
        </div>
      )}

      {/* ปฏิทินอยู่บนสุด — เป็นสิ่งที่คนเปิดหน้านี้มาดู ฟอร์มค่อยโผล่ตอนเลือกวันแล้ว */}
      <div className="mini-cal">
        {WEEKDAYS.map((w) => <div key={w} className="mini-cal-head">{w}</div>)}

        {Array.from({ length: leading }, (_, i) => (
          <div key={`pad-${i}`} className="mini-cal-day is-blank" />
        ))}

        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = iso(year, month, day);
          const list = byDate.get(key) ?? [];
          const isPicked = picked.has(key);
          const hasConflict = isPicked && conflictDates.has(key);
          const isDuplicate = isPicked && duplicateDates.has(key);

          const existing = list.length
            ? list
                .map((v) => `${[v.planned_start, v.planned_end].filter(Boolean).join('-') || 'ไม่ระบุเวลา'} · ${v.assigned_name ?? 'ไม่ระบุคน'}`)
                .join('\n')
            : '';
          /* เคสหลายคน: วันที่มีนัดรออยู่ ระบายด้วยสีของคนที่ไป (ผู้ใช้ขอ 6 พ.ย. 2569) แทนทองเดียวกันทุกช่อง
             สองคนในวันเดียว = แบ่งช่องเฉียงครึ่ง/สามส่วน · วันที่ไปแล้ว/ยกเลิกหมดยังใช้สีสถานะเดิม (เขียว/แดง) */
          const cls = dayClass(list);
          const people = multi && cls.includes('visit-scheduled')
            ? [...new Set(list.filter((v) => v.status === 'scheduled').map((v) => v.assigned_to))].slice(0, 3)
            : [];
          const tone = (id) => (colorIndex.has(id) ? `var(--pc-${colorIndex.get(id)})` : 'var(--pc-none)');
          const fill = people.length === 0
            ? null
            : people.length === 1
              ? tone(people[0])
              : `linear-gradient(135deg, ${people
                  .map((id, n) => `${tone(id)} ${(n * 100) / people.length}% ${((n + 1) * 100) / people.length}%`)
                  .join(', ')})`;
          const title = [
            formatDate(key),
            existing,
            hasConflict && 'ชนกับงานอื่นของคนนี้',
            isDuplicate && 'มีกะเหมือนกันอยู่แล้ว — บันทึกแล้วจะถูกข้าม',
          ]
            .filter(Boolean)
            .join('\n');

          return (
            <button
              key={day}
              type="button"
              disabled={busy || readOnly}
              aria-pressed={isPicked}
              className={[
                'mini-cal-day',
                cls,
                fill ? 'by-person' : '',
                key === today ? 'is-today' : '',
                isPicked ? 'is-picked' : '',
                hasConflict ? 'has-conflict' : '',
                isDuplicate ? 'is-duplicate' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => toggleDay(key)}
              title={title}
              style={fill ? { '--day-fill': fill } : undefined}
            >
              {day}
              {list.length > 0 && <span className="mini-cal-count">{list.length}</span>}
              {/* ดูทุกคน: วันที่ไม่ได้ระบายสีคน (ไปแล้ว/ยกเลิก) ยังมีจุดสีบอกว่าเป็นนัดของใคร (สูงสุด 3 จุด) */}
              {multi && !view && !fill && list.length > 0 && (
                <span className="mini-cal-dots" aria-hidden="true">
                  {[...new Set(list.filter((v) => v.status !== 'cancelled').map((v) => v.assigned_to))]
                    .slice(0, 3)
                    .map((id) => <i key={id ?? 'none'} className={`vp-dot ${dotClass(id)}`} />)}
                </span>
              )}
              {hasConflict && <span className="mini-cal-warn" aria-hidden="true">!</span>}
            </button>
          );
        })}
      </div>

      {!readOnly && (
        <div className="pick-presets">
          <span className="muted">เลือกเร็ว:</span>
          <button type="button" className="btn tiny" disabled={busy} onClick={() => pickPattern([1, 2, 3, 4, 5])}>จ–ศ</button>
          <button type="button" className="btn tiny" disabled={busy} onClick={() => pickPattern([0, 6])}>ส–อา</button>
          <button type="button" className="btn tiny" disabled={busy} onClick={() => pickPattern(null)}>ทุกวัน {everyDays} วัน</button>
          {picked.size > 0 && (
            <button type="button" className="btn tiny" disabled={busy} onClick={() => setPicked(new Set())}>ล้าง</button>
          )}
        </div>
      )}

      {/* ลงนัดทั้งแพ็กในครั้งเดียว — เลือกวันในสัปดาห์ แล้วระบบไล่วันให้ครบจำนวนครั้งที่เหลือ (ตรวจกับวันหมดอายุแพ็ก) */}
      {!readOnly && isAppt && target && booked < target && (
        <div className="pick-presets">
          <span className="muted">ลงนัดทั้งแพ็ก:</span>
          {['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map((label, d) => (
            <label key={d} className="btn tiny" style={{ opacity: packDays.includes(d) ? 1 : 0.45 }}>
              <input
                type="checkbox"
                style={{ display: 'none' }}
                checked={packDays.includes(d)}
                onChange={() => setPackDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d].sort()))}
              />
              {label}
            </label>
          ))}
          <button
            type="button"
            className="btn tiny primary"
            disabled={busy || packDays.length === 0}
            onClick={() => pickPattern(packDays, { fill: true })}
          >
            เลือกให้ครบ {Math.max(0, quotaLeft - pickedNew)} ครั้ง
          </button>
        </div>
      )}

      {!readOnly && picked.size === 0 && (
        <p className="muted visit-hint">
          {isAppt
            ? 'แตะวันบนปฏิทินเพื่อเลือกวันนัด (แตะซ้ำเพื่อยกเลิก) แล้วเลือกเวลานัดแล้วกดบันทึก'
            : 'แตะวันบนปฏิทินเพื่อเลือก (แตะซ้ำเพื่อยกเลิก) แล้วตั้งคน/เวลาแล้วกดบันทึก'}
          <span className="cell-sub">เปลี่ยนคนไปนัด: กดชื่อพนักงานในรายการนัดด้านล่าง</span>
          {/* บอกจุดตั้งต้นของปุ่มเลือกเร็วไว้ตรงนี้ ไม่งั้นคนกดแล้วสงสัยว่าทำไมต้นเดือนไม่ถูกเลือก */}
          <span className="cell-sub">
            {everyDays === SPAN_DAYS
              ? <>ปุ่มเลือกเร็วกวาด <strong>{SPAN_DAYS} วันติดต่อกัน</strong></>
              : <>ปุ่ม &quot;ทุกวัน&quot; เลือก <strong>{everyDays} วันติดต่อกัน</strong> ตามแพ็กเกจ · จ–ศ / ส–อา กวาด {SPAN_DAYS} วัน</>}
            {' '}(ข้ามไปเดือนถัดไปให้เอง) เริ่มจาก{' '}
            <strong>
              {startFrom === today ? `วันนี้ (${formatDate(today)})` : `วันเริ่มของเคส (${formatDate(startFrom)})`}
            </strong>{' '}
            ไม่ย้อนวันที่ผ่านมาแล้ว
          </span>
        </p>
      )}

      {/* แถบสรุปร่าง — โผล่เมื่อเลือกวันแล้วเท่านั้น จอเล็กจึงไม่ถูกฟอร์มบังปฏิทินตั้งแต่แรก */}
      {!readOnly && picked.size > 0 && (
        <div className="pick-bar">
          <p className="pick-count">
            เลือกไว้ <strong>{picked.size}</strong> วัน
            {overPick && <span className="cell-sub">เลือกเกินแพ็กเกจ {pickedNew - quotaLeft} วัน — เอาออกก่อนบันทึก</span>}
            {duplicateDates.size > 0 && (
              <span className="cell-sub">
                {duplicateDates.size} วันมี{unit}เหมือนกันอยู่แล้ว — จะถูกข้าม
              </span>
            )}
          </p>

          {/* หลายคน (ไม่เกิน 6): ชิปชื่อ แตะเลือกได้ทันทีและเห็นครบว่ากำลังลงให้ใคร — ใช้ทั้งกะและนัดกายภาพ */}
          {multi && staff.length <= MAX_PERSON_CHIPS && (
            <div className="time-chips who-chips" role="radiogroup" aria-label={`ลง${unit}ให้`}>
              <span className="muted time-chips-label">ลง{unit}ให้</span>
              {staff.map((s) => (
                <button
                  key={s.employee_id}
                  type="button"
                  role="radio"
                  aria-checked={!toPartner && who === s.employee_id}
                  className={`btn tiny ${!toPartner && who === s.employee_id ? 'primary' : ''}`}
                  disabled={busy}
                  onClick={() => pickPerson(s.employee_id)}
                >
                  <i className={`vp-dot ${dotClass(s.employee_id)}`} aria-hidden="true" />
                  {s.first_name} {s.last_name}
                </button>
              ))}
            </div>
          )}

          {/* คนเดียว / เกิน 6 คน: ช่องค้นหาชื่อแบบเดิม — คนเดียวของนัดกายภาพไม่ต้องเลือก (ผู้รับผิดชอบหลักเสมอ) */}
          {!isAppt && !(multi && staff.length <= MAX_PERSON_CHIPS) && (
            <SearchSelect value={toPartner ? '' : who} disabled={busy} onChange={(e) => pickPerson(e.target.value)}>
              {!multi && <option value="">— ไม่ระบุคน —</option>}
              {staff.map((s) => (
                <option key={s.employee_id} value={s.employee_id}>
                  {s.first_name} {s.last_name} ({POSITION_LABELS[s.position]})
                </option>
              ))}
            </SearchSelect>
          )}

          {partnerList.length > 0 && (
            <div className="time-chips who-chips" role="radiogroup" aria-label="หรือส่งให้พาร์ทเนอร์">
              <span className="muted time-chips-label">หรือส่งให้พาร์ทเนอร์</span>
              {partnerList.map((p) => {
                const on = toPartner?.partner_id === p.partner_id;
                return (
                  <button
                    key={p.partner_id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`btn tiny ${on ? 'primary' : ''}`}
                    disabled={busy}
                    title={`ลงนัดแล้วส่งให้ ${p.name} — หัวหน้าบริษัทเลือกคนไปเอง`}
                    onClick={() => setToPartner(on ? null : p)}
                  >
                    <PartnerLogo partner={p} size={18} />
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
          {toPartner && (
            <p className="muted visit-hint">
              {unit}ที่ลงจะยังไม่มีคน — {toPartner.name} ได้แจ้งเตือนครั้งเดียว แล้วหัวหน้าบริษัทเลือกคนไปเอง
              (ยังไม่มีคน 24 ชม. ก่อนนัด/ถูกปฏิเสธ ขึ้นในกระดิ่งหลังบ้าน)
            </p>
          )}

          {!isAppt && staff.length === 0 && (
            <p className="muted visit-hint">
              เคสนี้ยังไม่มีพนักงานให้เลือก — เพิ่มคนเข้าเคสที่หัวข้อ “พนักงานที่รับเคส” ก่อน
            </p>
          )}

          {/* ช่วงเวลา: ใช้ทั้งสองโหมด — นัดกายภาพก็ต้องบอกคนไข้ได้ว่ามากี่โมง
              และเวลาที่ระบุไว้ทำให้ตรวจกะชนกันได้แม่นขึ้น (ไม่งั้นนับเป็นชนทั้งวัน) */}
          <div className="time-chips">
            <span className="muted time-chips-label">{isAppt ? 'เวลานัด' : 'เวลากะ'}</span>
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`btn tiny ${timeKey === p.key ? 'primary' : ''}`}
                disabled={busy}
                onClick={() => setTimeKey(p.key)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className={`btn tiny ${timeKey === 'custom' ? 'primary' : ''}`}
              disabled={busy}
              onClick={() => setTimeKey('custom')}
            >
              กำหนดเอง
            </button>
          </div>

          {timeKey === 'custom' && (
            <div className="time-custom">
              <TimeSelect
                label={isAppt ? 'เวลานัด' : 'เวลาเริ่ม'}
                value={custom.start}
                disabled={busy}
                onChange={(v) => setCustom((p) => ({ ...p, start: v }))}
              />
              <span className="muted">–</span>
              <TimeSelect
                label="เวลาเลิก"
                value={custom.end}
                disabled={busy}
                onChange={(v) => setCustom((p) => ({ ...p, end: v }))}
              />
            </div>
          )}

          {/* วันที่เลือกเลยช่วงของเคส (ก่อนวันเริ่ม/หลังวันสิ้นสุด) — เตือนเฉยๆ ไม่กั้น เพราะบางครั้งต่อเวลาให้จริง
              แต่ส่วนใหญ่คือกดพลาด และกะที่เลยวันสิ้นสุดจะไม่อยู่ในรอบบิล/ค่าจ้างของเคสนี้ */}
          {outOfRange.length > 0 && (
            <div className="banner">
              <strong>
                {outOfRange.length} วันอยู่นอกช่วงของเคส
                {' '}({caseItem?.start_date ? formatDate(caseItem.start_date) : '—'} – {caseItem?.end_date ? formatDate(caseItem.end_date) : 'ไม่ระบุ'})
              </strong>
              <span className="cell-sub">{outOfRange.slice(0, 5).map(formatDate).join(' · ')}{outOfRange.length > 5 ? ' …' : ''} — ถ้าต้องการต่อเวลาจริง ให้แก้วันสิ้นสุดของเคสหรือต่อเคสรอบใหม่</span>
            </div>
          )}

          {preview.failed && (
            <div className="banner">
              <strong>ตรวจตารางชนไม่สำเร็จ</strong>
              <span className="cell-sub">ยังไม่รู้ว่าวันที่เลือกชนกับงานอื่นของพนักงานคนนี้หรือไม่ — ลองเลือกวันใหม่อีกครั้ง หรือดูปฏิทินพนักงานก่อนบันทึก</span>
            </div>
          )}

          {/* เตือนก่อนบันทึก ไม่ใช่หลังบันทึก — ยังกดบันทึกได้ บางครั้งจงใจซ้อน (แวะสองบ้านติดกัน) */}
          {preview.conflicts.length > 0 && (
            <div className="banner">
              <strong>ชนกับงานอื่น {preview.conflicts.length} รายการ</strong>
              <ul className="conflict-list">
                {preview.conflicts.slice(0, 4).map((c) => (
                  <li key={`${c.visit_date}-${c.other_case_id}`}>
                    {formatDate(c.visit_date)} · {c.employee_name ?? 'ไม่ระบุคน'} มีงานที่ {c.other_client_name}
                    {' ('}<span className="mono">{caseCode(c.other_case_id)}</span>
                    {c.other_start ? ` ${c.other_start}-${c.other_end ?? ''}` : ' ไม่ระบุเวลา'})
                  </li>
                ))}
                {preview.conflicts.length > 4 && (
                  <li className="muted">และอีก {preview.conflicts.length - 4} รายการ</li>
                )}
              </ul>
            </div>
          )}

          <div className="pick-actions">
            <button type="button" className="btn primary" disabled={busy || overPick} onClick={save}>
              บันทึก {picked.size} {unit}{toPartner ? ` · ส่งให้ ${toPartner.name}` : multi && who ? ` ให้ ${nameOf(who)}` : ''}
            </button>
            {pickedWithVisits.length > 0 && (
              <button
                type="button"
                className="btn danger-ghost"
                disabled={busy}
                onClick={async () => {
                  // ลบถาวรทุกนัดที่ยังไม่เช็คอินในวันที่เลือก — ถามก่อน (ตรวจ Codex 30 ต.ค. 2569 ข้อ 7)
                  // ดูตารางของคนเดียวอยู่ = ลบเฉพาะนัดของคนนั้น ไม่ไปลบนัดของคนอื่นในวันเดียวกัน
                  const whose = multi && view ? ` ของ ${nameOf(view)}` : '';
                  if (!(await ask({
                    title: `ลบนัดที่ยังไม่เช็คอิน${whose} ${pickedWithVisits.length} วันที่เลือก?`,
                    detail: 'ลบแล้วกู้คืนไม่ได้',
                    confirmLabel: 'ลบนัด',
                    danger: true,
                  }))) return;
                  run(() => api.deleteVisitsOn(caseId, pickedWithVisits, multi && view ? view : null), { clearPicked: true });
                }}
              >
                {/* ชื่อต้นพอ — ชื่อเต็มทำให้ปุ่มบนมือถือตัดเป็นสองบรรทัด (ยืนยันก่อนลบมีชื่อเต็มอยู่แล้ว) */}
                {multi && view ? `ลบนัดของ ${nameOf(view).split(' ')[0]}` : 'ลบของวันที่เลือก'} ({pickedWithVisits.length})
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => setPicked(new Set())}>ล้าง</button>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="muted visit-empty">
          {isAppt ? 'ยังไม่ได้ลงนัด' : 'ยังไม่ได้นัดกะ'}{multi && view ? `ของ ${nameOf(view)}` : ''}
          {readOnly ? '' : ' — แตะวันบนปฏิทินเพื่อเลือก'}
        </p>
      ) : (
        <ol className="visit-list visit-rows">
          {/* นัดที่ผ่านไปแล้วอยู่บนสุดเสมอ (server เรียงตามวัน) — พับไว้ตั้งต้น ให้นัดที่กำลังจะมาถึงขึ้นมาก่อน
              ขาดงานที่ยังไม่ได้จัดการบอกจำนวนไว้บนแถบ จะได้ไม่ถูกพับหายไปเงียบๆ
              ไม่มีนัดข้างหน้าเหลือเลย = กางไว้ตั้งต้น (ไม่งั้นรายการว่างเหลือแค่แถบ) */}
          {pastCount > 0 && (
            <li className="visit-past-toggle">
              <button type="button" aria-expanded={showPast} onClick={() => setPastOpen(!showPast)}>
                <LineIcon name="chevron" className={`visit-past-chev${showPast ? ' is-open' : ''}`} />
                <span>{showPast ? `ซ่อน${unit}ที่ผ่านไปแล้ว` : `${unit}ที่ผ่านไปแล้ว`} <strong>{pastCount}</strong> รายการ</span>
                {pastMissed > 0 && <span className="badge visit-missed">ขาดงาน {pastMissed}</span>}
              </button>
            </li>
          )}
          {shown.map((v, idx) => {
            if (!showPast && v.visit_date < today) return null;
            const t = [v.planned_start, v.planned_end].filter(Boolean).join('-');
            return (
              <li key={v.visit_id} className={`visit-card visit-${v.state}${v.visit_date === today ? ' is-today' : ''}`}>
                {/* การ์ดนัด (ออกแบบใหม่ 16 พ.ย. 2569): ป้ายวันซ้าย · เวลา+สถานะ / คนไป+ครั้งที่+VN กลาง · ปุ่มไอคอนขวา
                    เดิมเป็นข้อความสามบรรทัดอัดกับปุ่มตัวหนังสือสามปุ่ม วันที่กับเวลาเบียดกันจนอ่านยาก */}
                <span className="vc-date" aria-hidden="true">
                  <span className="vc-dow">{v.visit_date === today ? 'วันนี้' : dowTH(v.visit_date)}</span>
                  <span className="vc-day">{Number(v.visit_date.slice(8, 10))}</span>
                  <span className="vc-mon">{monTH(v.visit_date)}</span>
                </span>
                <span className="vc-body">
                  <span className="vc-top">
                    <span className="sr-only">{formatDate(v.visit_date)}</span>
                    <span className={`vc-time${t ? '' : ' is-none'}`}>{t || 'ไม่ระบุเวลา'}</span>
                    <span className={`badge visit-${v.state}`}>{VISIT_STATE_LABELS[v.state]}</span>
                  </span>
                  <span className="vc-meta">
                    {/* ชื่อคนไป = ปุ่มเปลี่ยนคน (นัดที่ยังเปลี่ยนได้) · ที่เหลือเป็นข้อความเฉยๆ */}
                    {canSwap(v) ? (
                      <button
                        type="button"
                        className="visit-person is-button"
                        disabled={busy}
                        title="เปลี่ยนคนไปนัดนี้ — ให้อีกคนไปแทน"
                        onClick={() => setSwapping({ visit: v, error: null })}
                      >
                        {multi && <i className={`vp-dot ${dotClass(v.assigned_to)}`} aria-hidden="true" />}
                        {v.assigned_name ?? (v.partner_id ? 'รอพาร์ทเนอร์เลือกคน' : 'ไม่ระบุคน')}
                        <span className="visit-person-act">เปลี่ยน</span>
                      </button>
                    ) : (
                      <span className="visit-person">
                        {multi && <i className={`vp-dot ${dotClass(v.assigned_to)}`} aria-hidden="true" />}
                        {v.assigned_name ?? 'ไม่ระบุคน'}
                      </span>
                    )}
                    {/* ส่งให้พาร์ทเนอร์ / พาร์ทเนอร์ปฏิเสธกลับมา (21 พ.ย. 2569) */}
                    {v.partner_id && (
                      <span className={`pt-tag ${v.partner_status === 'accepted' ? 'is-ok' : 'is-warn'}`}>
                        {v.partner_name} · {v.partner_status === 'accepted' ? 'พาร์ทเนอร์' : 'รอเลือกคน'}
                      </span>
                    )}
                    {!v.partner_id && v.partner_rejected_at && !v.assigned_to && v.state === 'scheduled' && (
                      <span className="nw vc-warn"><LineIcon name="alert" className="text-ico" />{v.partner_rejected_name ?? 'พาร์ทเนอร์'} ปฏิเสธ{v.partner_reject_reason ? ` — ${v.partner_reject_reason}` : ''}</span>
                    )}
                    <span className="nw">{unit}ที่ {idx + 1 + (isAppt ? carried : 0)}</span>
                    {/* กายภาพ: หนึ่งนัดหนึ่ง VN (ระบบออกตอนลงนัด) · Homecare ไม่มี VN รายกะ ใช้ VN ของเคส */}
                    {v.vn && <span className="mono nw">{v.vn}</span>}
                    {(v.check_in_at || v.check_out_at) && (
                      <span className="nw">
                        {[v.check_in_at && `เข้า ${timeText(v.check_in_at)}`, v.check_out_at && `ออก ${timeText(v.check_out_at)}`].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    {v.location_flagged && <span className="nw vc-warn"><LineIcon name="alert" className="text-ico" />{v.location_note ?? 'นอกพื้นที่'}</span>}
                    {v.off_schedule && <span className="nw vc-warn"><LineIcon name="alert" className="text-ico" />นอกวันนัด</span>}
                    {/* นัดที่ยกเลิก: หมายเหตุมีเหตุผลที่กรอกตอนกดยกเลิก ("ยกเลิก: …") — เห็นได้โดยไม่ต้องเปิดประวัติเคส */}
                    {v.state === 'cancelled' && v.note && <span className="visit-note">{v.note}</span>}
                  </span>
                </span>
                <span className="vc-actions">
                  {canMoveVisit(v) && (
                    <button
                      type="button"
                      className="vc-act"
                      disabled={busy}
                      title="เลื่อนนัดนี้ไปวัน/เวลาใหม่ — ระบบแจ้งเลื่อนนัดทาง LINE ถึงพนักงานและญาติ"
                      onClick={() => setMoving({ visit: { ...v, case_id: caseId, client_name: caseItem?.client_name }, error: null })}
                    >
                      <LineIcon name="calendar" className="vc-ico" />
                      <span>เลื่อนนัด</span>
                    </button>
                  )}
                  {canSwap(v) && (
                    v.partner_id ? (
                      <button type="button" className="vc-act" disabled={busy}
                        title="ดึงกะคืนจากพาร์ทเนอร์ — ให้ผู้รับผิดชอบเคส (คนของพาร์ทเนอร์ที่ถูกเลือกไว้ได้แจ้งถอนงาน)"
                        onClick={() => pullFromPartner(v)}>
                        <LineIcon name="refresh" className="vc-ico" />
                        <span>ดึงคืน</span>
                      </button>
                    ) : (
                      <button type="button" className="vc-act" disabled={busy}
                        title="ส่งกะนี้ให้บริษัทพาร์ทเนอร์ — หัวหน้าบริษัทเลือกคนไปเอง"
                        onClick={() => setPartnering({ visit: v, error: null })}>
                        <LineIcon name="download" className="vc-ico" />
                        <span>ส่งพาร์ทเนอร์</span>
                      </button>
                    )
                  )}
                  {!readOnly && v.state === 'scheduled' && v.visit_date >= today && (
                    <button
                      type="button"
                      className="vc-act"
                      disabled={busy}
                      title="ส่งข้อความเตือนนัดนี้ทาง LINE ถึงพนักงานและญาติ"
                      onClick={() => remind(v)}
                    >
                      <LineIcon name="bell" className="vc-ico" />
                      <span>ส่งเตือน</span>
                    </button>
                  )}
                  {/* ลบได้เฉพาะกะที่ยังไม่ถึงวัน · กะที่ผ่านมาแล้ว (ขาดงาน) เก็บไว้เป็นประวัติ — ยกเลิกได้แต่ลบไม่ได้ */}
                  {!readOnly && !v.check_in_at && v.visit_date >= today && (
                    <button
                      type="button"
                      className="vc-act is-danger"
                      disabled={busy}
                      title={`ยกเลิก${unit}นี้ (นำออกจากตาราง) — ระบบแจ้งยกเลิกทาง LINE`}
                      onClick={async () => {
                        /* ลบนัดที่ยังไม่ถึงวัน = แจ้งยกเลิกทาง LINE อยู่แล้ว — ขอหมายเหตุส่งไปด้วย เหมือนปุ่มยกเลิก (11 พ.ย. 2569) */
                        const reason = await ask({
                          title: `ยกเลิก${unit}วันที่ ${formatDate(v.visit_date)}?`,
                          detail: `${unit}นี้จะถูกนำออกจากตาราง และระบบจะแจ้งยกเลิกทาง LINE ถึง${v.assigned_name ? ` ${v.assigned_name} ` : 'พนักงาน'}และญาติที่ผูกเคสไว้ พร้อมหมายเหตุนี้`,
                          input: { label: 'หมายเหตุ / เหตุผลที่ยกเลิก', placeholder: 'เช่น ลูกค้าขอเลื่อนนัด', required: true },
                          confirmLabel: `ยกเลิก${unit}และแจ้ง`,
                          cancelLabel: 'ไม่ยกเลิก',
                          danger: true,
                        });
                        if (reason == null) return;
                        run(() => api.deleteVisit(caseId, v.visit_id, reason));
                      }}
                    >
                      <LineIcon name="x-circle" className="vc-ico" />
                      {/* ชื่อปุ่ม "ยกเลิก" (ผู้ใช้ขอ 16 พ.ย. 2569) — การทำงานเหมือนเดิม: นำนัดที่ยังไม่ถึงวันออกจากตาราง + แจ้ง LINE */}
                      <span>ยกเลิก</span>
                    </button>
                  )}
                  {!readOnly && v.state === 'missed' && (
                    <button
                      type="button"
                      className="vc-act is-danger"
                      disabled={busy}
                      title="วันนั้นไม่ได้ไปจริง — เปลี่ยนเป็นยกเลิก (ยังเก็บเป็นประวัติ)"
                      onClick={async () => {
                        /* หมายเหตุส่งไปกับข้อความแจ้งยกเลิกนัดทาง LINE (พนักงาน + ญาติ) และเก็บไว้ในกะ (11 พ.ย. 2569) */
                        /* มีหมวดเหตุผล (categories · cancel_visit · 16 พ.ย. 2569) = เลือกเหตุผล + รายละเอียดไม่บังคับ
                           ชื่อเหตุผลถูกเขียนนำหน้าหมายเหตุที่ server — ข้อความ LINE ได้ทั้งสองส่วน */
                        const answer = await ask({
                          title: `ยกเลิก${unit}วันที่ ${formatDate(v.visit_date)}?`,
                          detail: `ระบบจะแจ้งยกเลิก${unit}ทาง LINE ถึง${v.assigned_name ? ` ${v.assigned_name} ` : 'พนักงาน'}และญาติที่ผูกเคสไว้ พร้อมเหตุผลนี้`,
                          ...(hasCancelReasons
                            ? {
                              select: {
                                required: true,
                                render: (value, set) => (
                                  <ReasonPicker domain="cancel_visit" label="เหตุผลที่ยกเลิก" required value={value} onChange={set} autoFocus />
                                ),
                              },
                              input: { label: 'รายละเอียดเพิ่มเติม (ไม่บังคับ)', placeholder: 'เช่น ขอเลื่อนไปสัปดาห์หน้า' },
                            }
                            : { input: { label: 'หมายเหตุ / เหตุผลที่ยกเลิก', placeholder: 'เช่น ผู้รับบริการไม่สบาย ขอเลื่อนไปก่อน', required: true } }),
                          confirmLabel: `ยกเลิก${unit}และแจ้ง`,
                          cancelLabel: 'ไม่ยกเลิก',
                          danger: true,
                        });
                        if (answer == null) return;
                        const body = typeof answer === 'string'
                          ? { status: 'cancelled', cancel_reason: answer }
                          : { status: 'cancelled', cancel_reason: answer.text || null, cancel_reason_id: Number(answer.choice) };
                        run(() => api.updateVisit(caseId, v.visit_id, body));
                      }}
                    >
                      <LineIcon name="x-circle" className="vc-ico" />
                      <span>ยกเลิก</span>
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {swapping && (
        <ChangeVisitPersonDialog
          visit={swapping.visit}
          caseId={caseId}
          team={teamChips}
          outsiders={outsiders}
          followUps={followUpsOf(swapping.visit)}
          busy={busy}
          error={swapping.error}
          onConfirm={confirmSwap}
          onCancel={() => !busy && setSwapping(null)}
        />
      )}

      {partnering && (
        <SendPartnerDialog
          visit={partnering.visit}
          busy={busy}
          error={partnering.error}
          onConfirm={(p) => sendToPartner(partnering.visit, p)}
          onCancel={() => !busy && setPartnering(null)}
        />
      )}

      {moving && (
        <MoveVisitDialog
          move={{ visit: moving.visit }}
          pickDate
          busy={busy}
          today={today}
          error={moving.error}
          onConfirm={confirmMove}
          onCancel={() => !busy && setMoving(null)}
        />
      )}
    </>
  );
}

/** เลือกบริษัทพาร์ทเนอร์ที่จะส่งกะให้ (21 พ.ย. 2569) — เฉพาะบริษัทที่เปิดใช้และมีบัญชีหัวหน้าแล้ว */
function SendPartnerDialog({ visit, busy, error, onConfirm, onCancel }) {
  const [list, setList] = useState(null);
  const [pick, setPick] = useState(null);
  const [loadError, setLoadError] = useState(null);
  useEffect(() => {
    api.partners().then((rows) => setList(rows.filter((p) => p.status === 'active'))).catch((e) => setLoadError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  const when = [visit.planned_start, visit.planned_end].filter(Boolean).join('-');
  return createPortal(
    <div className="modal-backdrop modal-stacked" onClick={onCancel}>
      <div className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="send-partner-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 id="send-partner-title">ส่งกะให้พาร์ทเนอร์</h2>
            <p className="muted">{formatDate(visit.visit_date)}{when ? ` · ${when}` : ''} · ตอนนี้: {visit.assigned_name ?? 'ยังไม่มีคน'}</p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="ปิด" disabled={busy}>×</button>
        </header>
        <div className="modal-body">
          {loadError && <p className="error">{loadError}</p>}
          {!list ? (!loadError && <p className="muted">กำลังโหลด…</p>) : list.length === 0 ? (
            <p className="muted">ยังไม่มีพาร์ทเนอร์ที่เปิดใช้ — เพิ่มที่ตั้งค่าระบบ › พาร์ทเนอร์</p>
          ) : (
            <div className="pt-people" role="radiogroup" aria-label="บริษัทพาร์ทเนอร์">
              {list.map((p) => (
                <label key={p.partner_id} className={`pt-person${pick?.partner_id === p.partner_id ? ' is-on' : ''}${p.leads ? '' : ' is-busy'}`}>
                  <input type="radio" name="send-partner" checked={pick?.partner_id === p.partner_id} disabled={!p.leads || busy}
                    onChange={() => setPick(p)} />
                  <PartnerLogo partner={p} size={36} />
                  <span className="pt-person-main">
                    <b>{p.name}</b>
                    <span className="muted">{p.rate_per_visit != null && `${formatBaht(p.rate_per_visit)}/ครั้ง · `}ทีม {p.staff} คน · งานค้าง {p.open_visits}{p.leads ? '' : ' · ยังไม่มีบัญชีหัวหน้า'}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <p className="move-note"><LineIcon name="bell" className="text-ico" />
            {visit.assigned_to ? `${visit.assigned_name ?? 'คนเดิม'} ได้แจ้งว่ากะถูกย้าย · ` : ''}หัวหน้าบริษัทได้แจ้งเตือนแล้วเลือกคนเอง · ญาติได้แจ้งตอนมีคนรับ
          </p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="button" className="btn primary" disabled={!pick || busy} onClick={() => onConfirm(pick)}>
            {busy ? 'กำลังส่ง…' : pick ? `ส่งให้ ${pick.name}` : 'ส่ง'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
