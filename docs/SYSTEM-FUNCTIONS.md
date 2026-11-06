# KIN Homecare — รายการฟังก์ชันและ logic ทั้งระบบ

> วิเคราะห์จากโค้ดจริง ณ commit `3e5d2e3` (3 พ.ย. 2569) · README.md บางส่วนล้าสมัย เอกสารนี้ยึดตามโค้ด
> Stack: Node 22 + Express 4 + PostgreSQL (Neon) · React 19 + Vite · deploy บน Vercel (serverless + Cron)

---

## 0. ภาพรวมสถาปัตยกรรม

```
[เว็บหลังบ้าน React]  ──cookie JWT──►  /api/*  (Express บน Vercel)  ──►  PostgreSQL
[หน้าสาธารณะ /review, /bill]  ──token ในลิงก์──►  /api/reviews/form, /api/public/bill
[chat.kinorigin.com (LINE OA)] ──ตั๋ว Ed25519──►  /api/integration/*   (ทั้ง push และมาดึง outbox)
[Vercel Cron 01:00 UTC]  ──Bearer CRON_SECRET──►  /api/notify/daily-digest
```

- backend **ไม่ยิง LINE เอง** — เขียนงานลงตารางคิว (outbox) แล้วระบบแชทมา claim ไปส่ง แล้วยิง ack กลับ
- ทุกโมดูล = `routes.js` (HTTP + สิทธิ์) + `repo.js` (SQL ล้วน) + `schema.js` (zod validation, error ภาษาไทย)
- ID ที่ระบบออก (ตาราง `id_counters` เดินหน้าอย่างเดียว):

| ของ | รูปแบบ |
| --- | --- |
| พนักงาน | `A` + พ.ศ. 2 หลัก + ชุด 2 หลัก + รัน 3 หลัก เช่น `A6901059` (ของเก่า `EMP-xxxx` ยังใช้ได้) |
| ลูกค้า (ผู้ว่าจ้าง) | `CUS-0001` |
| ผู้รับการดูแล | `KN` + 9 หลัก (กรอกเอง บังคับ) · ของเก่า `PAT-xxxx` |
| เคส | = รหัส KN ของผู้รับบริการ · เคสถัดไป `KN…-R2`, `-R3` · ยังไม่มีแฟ้ม = `CASE-0001` |
| เลขนัด (VN) | `VN` + พ.ศ. 2 หลัก + 7 หลัก · กายภาพ 1 VN/นัด · Homecare 1 VN/เคส |
| ใบแจ้งหนี้ | `HC-IV` + YYMMDD (พ.ศ.) + ลำดับของวัน 4 หลัก เช่น `HC-IV6909010001` (ของเก่า `INV-xxxx`) |
| รอบจ่ายค่าจ้าง | `PAY-0001` |

---

## 1. สิทธิ์การเข้าถึง (`lib/auth.js`)

สิทธิ์คิดจาก **ตำแหน่ง (position)** อ่านสดจาก DB ทุก request — ไม่ได้ใช้คอลัมน์ role

| ตำแหน่ง | office | billing | money |
| --- | :-: | :-: | :-: |
| super_admin, manager | ✅ | ✅ | ✅ |
| hr, admin | ✅ | ✅ | — |
| finance | — | ✅ | ✅ |
| ตำแหน่งหน้างาน (caregiver, assistant_nurse, practical_nurse, nurse, therapist, occupational_therapist, speech_therapist) | — | — | — |

| Middleware | เงื่อนไข | ใช้กับ |
| --- | --- | --- |
| `requireAuth` | JWT ในคุกกี้ `kin_session` (httpOnly, 8 ชม.) → อ่านพนักงานสด · 401 ถ้า token ออกก่อนเปลี่ยนรหัส / jti ถูก revoke / ลาออก-พักงาน | ทุกเส้นที่ต้อง login |
| `requirePasswordChanged` | **ตอนนี้ปล่อยผ่านเสมอ** (ยกเลิกบังคับเปลี่ยนรหัสแล้ว) | ทุกเส้นที่ต้อง login |
| `requireAdmin` | office | employees, customers, patients, packages, physio, reviews, family |
| `requireCaseAccess` | office ผ่านทุกเส้น · money (finance) ผ่านเฉพาะเส้นจ่ายเงิน/อนุมัติกะ | cases |
| `requireBilling` | billing | invoices |
| `requireManager` | **money** (ชื่อชวนสับสน — finance ก็ผ่าน) | payroll, attendance/report |
| `requireBackOffice` | มีอย่างน้อย 1 หมวด | notify/alerts |
| `canSeeStaffPay` / `stripPayFields` | money เท่านั้น — **ตัดฟิลด์ staff_pay / margin ออกจาก payload จริง** และคนไม่มีสิทธิ์ส่ง staff_pay มาจะถูกทิ้ง/403 | packages, physio, cases |

---

## 2. Auth — `/api/auth` (ไม่ผ่านด่าน)

| Endpoint | Logic |
| --- | --- |
| `POST /login` | รับอีเมล **หรือ** รหัสพนักงาน + รหัสผ่าน · ผิด ≥10 ครั้ง/15 นาที/ชื่อ → 429 · ไม่เจอบัญชีก็ bcrypt กับ dummy hash ให้เวลาตอบเท่ากัน · ลาออก/พักงาน → 403 · ออกคุกกี้ JWT 8 ชม. |
| `GET /line?t=&to=` | เข้าระบบจาก LINE: ตรวจตั๋ว `kin-staff` (Ed25519, อายุ ≤15 นาที) ใช้ครั้งเดียว · ยังไม่ผูก LINE → ส่งไปหน้า login พร้อมตั๋ว · `to` ต้องอยู่ใน whitelist |
| `GET /admin-sso?t=` | SSO จากแดชบอร์ดแชท: ตั๋ว `kin-admin-sso` {email} ใช้ครั้งเดียว · เฉพาะ super_admin/manager/admin/hr |
| `POST /line-code` | ผูก LINE ด้วยรหัส 6 หลักที่แอดมินออก แล้ว login ทันที · ผิดได้ 5 ครั้ง/ชม. · รหัสถูกลบแบบ atomic |
| `POST /line-link` | ผูก LINE เข้ากับบัญชีที่ login อยู่ · LINE ผูกคนอื่นอยู่ → 409 |
| `POST /logout` | บันทึก jti ลง `revoked_sessions` (ตัดเฉพาะเครื่องนี้) + ล้างคุกกี้ · ตอบ 204 เสมอ |
| `GET /me` | ข้อมูล session สด (position, role, permissions) |
| `POST /forgot-password` | ตอบข้อความกลางเสมอ (กันไล่หาอีเมล) · OTP 6 หลัก เก็บ bcrypt · อายุ 10 นาที · cooldown 60 วิ · OTP เก่าถูกยกเลิก |
| `POST /reset-password` | เดาได้ 5 ครั้ง/OTP · ห้ามใช้รหัสพนักงานเป็นรหัสผ่าน · ตั้ง `password_changed_at` → ทุกเซสชันเก่าตาย |
| `POST /change-password` | ต้องใส่รหัสเดิม · ใหม่ 8–72 ตัว ไม่ซ้ำเดิม ไม่เท่ารหัสพนักงาน · ออกคุกกี้ใบใหม่ให้ |

---

## 3. พนักงาน — `/api/employees` (office)

กติกากลาง: ตั้ง/แก้ super_admin ได้เฉพาะ super_admin · manager ได้เฉพาะ manager/super_admin · ตำแหน่งที่มีสิทธิ์เงินได้เฉพาะคนมีสิทธิ์เงิน · ห้ามทำให้ผู้ดูแลระบบ (manager/super_admin) เหลือ 0 คน

| Endpoint | Logic |
| --- | --- |
| `GET /meta` `/summary` | enum ต่าง ๆ · นับตามสถานะ/ตำแหน่ง |
| `GET /` | ค้นรหัส/ชื่อ/ชื่อเล่น/เบอร์ · กรอง status, position · ≤100/หน้า · ไม่ส่ง password_hash และ line id (ส่งแค่ `line_linked`) |
| `POST /` | ไม่กรอกรหัส = ระบบออกให้ (ตัวนับแยกรายปี ข้ามเลขที่ใช้แล้ว) · ซ้ำ → 409 · **รหัสผ่านเริ่มต้น `12345678` ไม่บังคับเปลี่ยน** |
| `GET /check-id` | ตรวจรูปแบบ + ว่าง/ไม่ว่าง |
| `GET /:id` | รายละเอียด + ใบรับรอง + ผลงาน + เคสที่ถือ |
| `PATCH /:id` | แก้ตัวเองห้ามเปลี่ยนรหัส/ตำแหน่ง/สถานะ · เปลี่ยนรหัสคนอื่นได้ (FK cascade) · อีเมลบัญชีหลังบ้านคนอื่นแก้ได้เฉพาะ manager |
| `DELETE /:id` | ปริยาย = soft (status=resigned + resign_date) · `?hard=true` ลบจริงได้เมื่อไม่มีประวัติเลย (กะที่เช็คอิน, ค่าจ้าง, รายงาน, รีวิว ฯลฯ) ไม่งั้น 409 พร้อมรายการ · ห้ามลบตัวเอง |
| `DELETE /:id/line` | ปลด LINE |
| `POST /:id/line-code` | ออกรหัสผูก LINE 6 หลัก อายุ 24 ชม. (1 คน 1 รหัส) |
| `GET/PUT /:id/photo` | รูป JPG/PNG/WebP ≤5MB ตรวจ magic bytes · `image:null` = ลบ · เก็บเป็น BYTEA |
| `/:id/certificates[...]` | ใบรับรอง: list / เพิ่ม / แนบ-ลบรูป / ลบ |
| `/:id/portfolio[...]` | ผลงาน: list / เพิ่ม (ต้องมีรูป) / แก้ title-description / ดูรูป / ลบ |

## 4. ผู้ว่าจ้าง — `/api/customers` · ผู้รับการดูแล — `/api/patients` (office)

- **ผู้ว่าจ้าง** = คนจ่ายเงิน · **ผู้รับการดูแล** = คนรับบริการ (ข้อมูลสุขภาพอยู่ที่นี่เท่านั้น) · 1 ผู้ว่าจ้าง : หลายผู้รับการดูแล

| Endpoint | Logic |
| --- | --- |
| customers `GET /` | ค้นหลายช่อง (escape LIKE) · กรอง `has_cases` · คืน case_count |
| customers `POST /` `PATCH /:id` | บังคับแค่ชื่อ · เบอร์ ≥8 หลัก · บัตร/เลขภาษี 13 หลัก · ไปรษณีย์ 5 หลัก |
| customers `GET /:id` | + ผู้รับการดูแล + เคส |
| customers `DELETE /:id` | 409 ถ้ายังมีเคสไม่จบ หรือมีใบแจ้งหนี้ค้างชำระ · ลบจริง (เคส/ใบเก่าเป็น SET NULL) |
| patients `GET /` | กรอง customer_id, has_customer, status |
| patients `GET /check-id` `POST /` | ตรวจรหัส KN ซ้ำ → 409 |
| patients `PATCH /:id` | เปลี่ยนรหัส KN ได้ → case_id เปลี่ยนตาม · ผูกผู้ว่าจ้างแล้ว backfill ให้เคส + sync ชื่อผู้จ่ายในใบแจ้งหนี้ที่เปิดอยู่ |
| patients `DELETE /:id` | 409 ถ้ายังมีเคสไม่จบ |

---

## 5. เคส — `/api/cases` (office; finance เฉพาะเส้นเงิน) — โมดูลใหญ่สุด

### 5.1 วงจรสถานะ

```
unassigned ──assign──► assigned ──start / เช็คอินกะแรก──► in_progress
                          └───────────── close ◄──────────────┘
ทุกสถานะที่ยังไม่จบ ──cancel──► cancelled
closed / cancelled ──reopen──► assigned / unassigned
```

### 5.2 ภาพรวม / ค้นหา

| Endpoint | Logic |
| --- | --- |
| `GET /meta` | CASE_TYPES 8 ค่า + สถานะ 5 ค่า |
| `GET /summary` | นับตามสถานะและสาย (physio/homecare) กรองปี/เดือนจาก created_at |
| `GET /dashboard` | กราฟ: กะรายวัน −14..+7 วัน, เคสใหม่ 12 เดือน, พนักงาน 8 คนที่ถือเคสมากสุด (ไม่มีตัวเลขเงิน) |
| `GET /periods` | ปี/เดือนที่มีเคส |
| `GET /calendar` | กะไม่ยกเลิกของเดือน (+กรองพนักงาน) |
| `GET /assignable-employees` | พนักงาน active/probation + ธงรับเคสได้ (ตำแหน่งหน้างาน) |
| `GET /` | ค้น + กรองสถานะจริง หรือ stage คำนวณ (`pending_start`, `active`, `awaiting_close`) + ตัวกรองงานค้าง: `no_staff_pay`, `overdue_close`, `closed_no_invoice`, `ending_soon` (7 วัน) |

### 5.3 สร้าง / แก้ / เปลี่ยนสถานะ

| Endpoint | Logic |
| --- | --- |
| `POST /` | ต้องมีชื่อผู้รับบริการหรือผู้ว่าจ้าง · เลือก Homecare (รูปแบบ × เกรด × ระดับ CG/NA/PN/RN) หรือแพ็กกายภาพ (ต้อง active) · **snapshot ราคา/ผู้จ่าย** ลงเคส · staff_pay ไม่ส่ง = ดึงจากแพ็กเกจ · ต่อเคส (`renewed_from`) ได้ round_no+1 คัดลอกทีม · **สร้างใบแจ้งหนี้ร่างอัตโนมัติ** · log `created` |
| `GET /:id` | เคส + ทีม + ข้อมูลแพ้ยา/โรค **อ่านสด** จากแฟ้ม + ธง `medical_history_stale` |
| `GET /:id/events` | audit log (ซ่อน event เงินถ้าไม่มีสิทธิ์) |
| `PATCH /:id` | แก้ assigned_to/status ตรงไม่ได้ · staff_pay ห้ามต่ำกว่าที่ปล่อยไปแล้ว · เคสจบแล้วเปลี่ยนแพ็กไม่ได้ · ใส่ชื่อจริง + KN → สร้างแฟ้มผู้รับบริการ + case_id เปลี่ยนเป็น KN · ราคา/ผู้จ่ายเปลี่ยน → **sync ใบแจ้งหนี้ร่าง** |
| `POST /:id/assign` | ตั้งคนหลัก · ย้ายกะอนาคตที่ยังไม่เช็คอินของคนเดิม (+กะที่ไม่มีคน) ไปให้คนใหม่ · แจ้ง LINE คนใหม่/คนเก่า/ญาติ |
| `POST /:id/unassign` | มีทีม → เลื่อนคนในทีมที่อยู่นานสุดขึ้นเป็นคนหลัก · ไม่มี → unassigned + กะอนาคตว่าง |
| `POST /:id/start` | assigned → in_progress · start_date ว่างเติมวันนี้ |
| `POST /:id/close` | ถ้ามีกะค้าง (ยังไม่ถึง/ยังไม่เช็คเอาท์) ต้องส่ง `force` · กะที่ยังไม่เช็คอินตั้งแต่วันนี้ → cancelled (ติดธง auto) · **ไม่ปล่อยค่าจ้าง/ไม่รับเงินอัตโนมัติ** |
| `POST /:id/cancel` | ยกเลิกกะที่ยังไม่เช็คอินทั้งหมด + ยกเลิกใบร่างที่ยังไม่รับเงิน |
| `POST /:id/reopen` | ห้ามถ้ามีรอบต่อเคสอื่นเปิดอยู่ · คืนกะที่ระบบยกเลิกให้ (เฉพาะวันนี้ขึ้นไป) |
| `DELETE /:id` | มีกะเช็คอิน/รายงาน/ญาติ/ใบแจ้งหนี้ → 409 เว้นแต่ `force` · **มีค่าจ้างที่ปล่อยแล้ว ห้ามลบเสมอ** |
| `GET/POST /:id/team` `DELETE /:id/team/:emp` | ทีมเสริม (ไม่รวมคนหลัก) · ถอดออก → กะอนาคตคืนคนหลัก · แจ้ง LINE |

### 5.4 กะ (case_visits) — 1 แถว = พนักงาน 1 คน ไป 1 รอบ

สถานะกะคำนวณตอนอ่าน: `scheduled` · `working` · `stale` (เช็คอิน >16 ชม. ยังไม่ออก) · `done` · `missed` · `cancelled`

| Endpoint | Logic |
| --- | --- |
| `GET /:id/visits` | กะทั้งหมด + state + worked_minutes |
| `GET /:id/physio-quota` | กายภาพ: sessions / booked / attended / remaining / วันหมดอายุแพ็ก (แสดงเฉยๆ ไม่บล็อก) |
| `POST /:id/visits` · `/bulk` | ลงกะ (bulk: `dates[]` หรือ `from/to+weekdays` หรือ `from+count`, ≤200/ครั้ง) · ข้ามกะซ้ำ · ไม่ระบุคน = คนหลัก · ออก VN · **กะชนไม่บล็อก แค่เตือน** · แจ้ง LINE พนักงาน |
| `POST /:id/visits/preview` | ตรวจชนก่อนบันทึก (ไม่เขียน DB) — คนเดียวกันข้ามเคส, ข้ามเที่ยงคืนได้, ชนเมื่อช่วงเวลาซ้อนกัน |
| `DELETE /:id/visits?dates/from&to` | ลบเฉพาะกะที่ยังไม่เช็คอิน · แจ้ง LINE ว่ายกเลิก |
| `PATCH /:id/visits/:vid` | แก้วัน/คน/เวลา/สถานะ/โน้ต · กะที่เช็คอินแล้วแก้ไม่ได้ (ใช้ /adjust) · ย้ายนัด → ล้างตราเตือน + คิวแจ้งเลื่อน/เปลี่ยนคน |
| `DELETE /:id/visits/:vid` | กะเช็คอินแล้วลบไม่ได้ |
| `POST /:id/visits/:vid/move` | ลากย้ายจากปฏิทิน: วันเดิมต้องยังไม่ผ่าน, วันใหม่ไม่อยู่ในอดีต |
| `POST /:id/visits/:vid/remind` | กดเตือน LINE เอง (พนักงาน + ญาติ ≤6) · กดซ้ำในนาทีเดียว → 429 |
| `PATCH /:id/visits/:vid/adjust` | แอดมินแก้เวลาเข้า-ออก/สถานะ/ธง · ออกต้องหลังเข้า · ถ้าอนุมัติแล้วถูกดึงกลับเป็น pending · มีค่าจ้างปล่อยแล้ว → 409 |
| `GET /:id/visits/:vid/photo` | รูปเซลฟี่เช็คอิน |

### 5.5 การมาทำงาน / ยืนยันกะ

| Endpoint | Logic |
| --- | --- |
| `GET /attendance` | ประวัติเช็คอิน กรองเดือน/คน |
| `GET /attendance/exceptions` | ย้อน 180 วัน: นอกพื้นที่ · นอกวันนัด · สาย >30 นาที · ค้างเช็คเอาท์ >16 ชม. · ขาดงาน |
| `GET /attendance/pending` | กะเช็คเอาท์แล้ว `pay_status=pending` |
| `POST /attendance/decide` | ยืนยัน/ไม่ยืนยัน 1–500 กะ (ไม่ยืนยันต้องมีเหตุผล) · แตะเฉพาะกะที่ยัง pending · **ไม่สร้างเงิน** |
| `POST /:id/approve-pay` | ยืนยันทุกกะ pending ของเคส |
| `GET /attendance/report` | (money) รวมต่อคน: ชั่วโมงตามเดือนที่เช็คอิน + เงินตามเดือนที่ปล่อย (แยกจ่ายแล้ว/ยัง) |

### 5.6 ค่าจ้างของเคส (ก้อนเดียวต่อเคส → ปล่อยเป็นงวด)

| Endpoint | Logic |
| --- | --- |
| `GET /:id/pay` | staff_pay, fee, ส่วนบริษัท, ปล่อยแล้ว, คงเหลือ, งวดที่ใช้ (สูงสุด **5 งวด**) · เคสยกเลิก: ยอดแนะนำ = staff_pay × กะที่ทำ/กะที่นัด |
| `PUT /:id/pay/shares` | ตั้งสัดส่วนรายคน · ผลรวมต้องเท่า staff_pay พอดี · คนต้องเกี่ยวกับเคส |
| `POST /:id/pay/release` | ปล่อยงวด (กันยิงซ้ำด้วย `request_id`) · ยอด ≤ คงเหลือ · หลายคนแต่ไม่มีสัดส่วนและไม่ส่ง shares → 400 · แบ่งตามสัดส่วนสะสม เศษให้คนสุดท้าย · INSERT `case_payouts` คนละแถว |
| `DELETE /:id/pay/:payoutId` | ถอนงวด — ห้ามถ้าอยู่ในรอบจ่ายที่จ่ายแล้ว |

### 5.7 รายงานการดูแล + geo

| Endpoint | Logic |
| --- | --- |
| `GET/POST /:id/reports` | รายงานประจำวัน (routine/change/incident) สัญญาณชีพ แผล กายภาพ · ห้ามวันอนาคต · รูป ≤6/ครั้ง ≤10/รายงาน |
| `PATCH/DELETE /:id/reports/:rid` · รูป | แก้/ลบรูป/ลบรายงาน |
| `POST /geocode` | ที่อยู่ → พิกัด (Google Geocoding) |
| `POST /resolve-map-link` | อ่านพิกัดจากลิงก์ Google Maps · whitelist โดเมนทุกชั้น redirect (≤5) กัน SSRF |
| `POST /search-place` | Places Text Search (เอนรัศมี 30 กม.) → fallback Geocoding · ≤6 ผล |

---

## 6. พนักงานหน้างาน — `/api/my` (login อย่างเดียว กรองด้วย employee_id ของตัวเอง)

- ตัดข้อมูลเงินของเคสออกทั้งหมด · เข้าเคสได้ถ้าเป็นคนหลัก / อยู่ในทีม / มีกะใน 30 วัน (ไม่ผ่าน → 404)

| Endpoint | Logic |
| --- | --- |
| `GET /cases` `/cases/:id` | เคสของฉัน + กะ |
| `GET /today` | กะวันนี้ (เวลาไทย) + กะเมื่อวานที่ยังไม่เช็คเอาท์ |
| `GET /calendar` `/attendance` | ปฏิทิน / ประวัติรายเดือน |
| `GET /attendance/report` | ชั่วโมงตามเดือนเช็คอิน + เงินตามงวดที่ปล่อยในเดือน |
| `GET /payslips` | สลิปเฉพาะรอบที่จ่ายแล้ว |
| `POST /visits/:id/check-in` | **เซลฟี่บังคับ** · กะอนาคตเช็คอินไม่ได้ · เคสจบ/กะยกเลิก/เช็คอินแล้ว → 409 · เวลา = `now()` ของ DB · `off_schedule` ถ้าไม่ตรงวัน · `late_minutes` · **geofence เป็นธงไม่บล็อก** (ไม่มีพิกัด หรือห่าง > รัศมี ปริยาย 200 ม. Haversine) · เคส assigned → in_progress · แจ้งญาติ (กายภาพ) |
| `POST /visits/:id/check-out` | ต้องเช็คอินแล้ว · ไม่ตรวจ geofence · state → done |
| `GET/POST /cases/:id/reports` · `PATCH .../:rid` | ลงรายงาน (ย้อนหลังได้ ต้องผูกกะของตัวเอง) · แก้ได้เฉพาะของตัวเอง · ลบไม่ได้ |
| `GET/POST /visits/:id/reports` | รายงานต่อกะ (หลายใบได้) |
| `GET /visits/:id/photo` | เซลฟี่ของตัวเอง |
| `GET/POST /cases/:id/family-messages` | แชทกับญาติในเคส (≤1000 ตัว และ/หรือรูป) |

---

## 7. ใบแจ้งหนี้ — `/api/invoices` (billing)

**สถานะ:** `draft → issued → paid` · `cancelled` ได้จากทุกสถานะ · "เกินกำหนด"/"รับบางส่วน" คำนวณตอนอ่าน
**ยอด:** `total = max(0, amount − discount)` server คิดเอง · `paid` = SUM(payments) · **ไม่มี VAT**
**แผนเก็บเงิน (`billing_kind`):** `full` หรือ `deposit` (แตกเป็นใบมัดจำ + ใบส่วนที่เหลือ `balance`)

| Endpoint | Logic |
| --- | --- |
| `GET /meta` `/summary` | จำนวน/ยอด/ยอดค้าง ตามสถานะ (ไม่มีสิทธิ์เงินไม่เห็นยอด paid) |
| `GET /revenue` | (money) รายได้ **เกณฑ์เงินสด** ตาม paid_at รายวัน/สัปดาห์ |
| `GET /` | กรอง q, status, ลูกค้า, เคส, overdue, stale, ร่างเกิน 7 วัน, มีสลิปรอตรวจ |
| `GET /cases-without-invoice` | เคสที่ยังไม่มีใบ (≤50) |
| `POST /` | สร้างจากเคส · เคสมีใบร่างอยู่แล้ว → 409 · `basis=visits` ออกตามกะที่เช็คเอาท์แล้วและยังไม่เคยออกใบ (ราคา/กะ = fee ÷ จำนวนกะ, ชุดสุดท้ายรับเศษ) · snapshot ผู้จ่าย |
| `GET /:id` | ใบ + รายการ + การรับเงิน + สลิป + ธง stale (ราคา/ผู้จ่าย/แพ็กไม่ตรงเคส, เคสถูกยกเลิก) |
| `PATCH /:id` | แก้ได้เฉพาะ draft/issued · ห้ามต่ำกว่าที่รับแล้ว · แก้ช่องที่ sync → `manual_edit` (หลุดจาก auto-sync) |
| `POST /:id/refresh` | ดึงข้อมูลเคสมาทับใหม่ |
| `POST /:id/acknowledge-service` | ยอมรับว่าแพ็กเปลี่ยน (ปิดป้ายเตือน) |
| `POST /:id/billing-plan` | เลือกครั้งเดียวตอนร่าง: `full` หรือ `deposit` (สร้างใบ balance ใหม่ใน transaction) |
| `PATCH /:id/deposit` `GET /:id/plan` | แก้ยอดมัดจำ (ใบคู่ปรับให้ผลรวมคงที่) / ดูใบคู่ |
| `POST /:id/issue` | draft → issued · ต้องเลือกแผนก่อน · issue_date = วันนี้ |
| `POST /:id/pay` | รับเงิน (กันซ้ำด้วย `request_id`) · ไม่ส่งยอด = เต็มคงเหลือ · ห้ามเกิน/วันอนาคต · ครบ → paid · ผูกสลิปลูกค้าได้ |
| `POST /:id/payments/:pid/void` | ยกเลิกการรับเงิน (เหตุผล 3–300 ตัว) · billing ล้วนยกเลิกได้เฉพาะรายการของตัวเองวันนี้ · paid ถอยเป็น issued |
| `POST /:id/slips` · รูป · ลบ · `/reject` | แนบสลิป / ปฏิเสธสลิปลูกค้า |
| `POST /:id/share-link` | ออกลิงก์ `/bill/<token>` (issued/paid) |
| `GET/POST /:id/line` | เข้าคิวส่งใบ/ใบเสร็จทาง LINE (ลูกค้าต้องผูก LINE) · กันคิวซ้ำ |
| `POST /:id/cancel` | ใบงวด: ใบคู่ที่ยังไม่รับเงินถูกยกเลิกตาม |
| `DELETE /:id` | ลบถาวรทั้งแผน — ห้ามถ้ามีการรับเงิน เคยแชร์ลิงก์ หรือเคยเข้าคิว LINE |

**อัตโนมัติจากเคส:** เปิดเคส → ใบร่าง · แก้ราคา/ผู้จ่ายของเคส → sync ใบ **draft** ที่ยังไม่แก้มือ/ไม่แชร์/ไม่รับเงิน

### หน้าบิลสาธารณะ — `/api/public/bill` (ไม่ต้อง login)

| Endpoint | Logic |
| --- | --- |
| `GET /:token` | token สุ่ม 24 ไบต์ เก็บแค่ sha256 · อายุ 180 วัน · เปิดได้เฉพาะ issued/paid/cancelled |
| `POST /:token/slip` | ลูกค้าแนบสลิป (ใบ issued ที่ยังค้าง) ≤8MB ตรวจ magic bytes → สถานะ pending + แจ้งทีม · **ไม่ตัดยอดอัตโนมัติ** |
| Rate limit | 60 ครั้ง/นาที/IP · สลิป 10 ครั้ง/วัน/token (in-memory ต่อ instance) |

---

## 8. รอบจ่ายค่าจ้าง — `/api/payroll` (money)

แหล่งเงิน = งวดที่ปล่อยจากเคส (`case_payouts`) · โมดูลนี้ **ไม่คำนวณค่าจ้างเอง**
งวดที่เข้ารอบได้ = ปล่อยวันที่ ≤ `period_to` และยังไม่อยู่ในรอบอื่น · **≤3 รอบ (ไม่นับยกเลิก) ต่อเดือน** · สถานะ `draft → paid | cancelled`

| Endpoint | Logic |
| --- | --- |
| `GET /meta` | สถานะ |
| `GET /employee-cases` `/case-queue` | ค่าจ้างรายเคสของคน · คิวเคสที่รอปล่อย (priority 1–6) |
| `GET /preview?period_to` | ยอดต่อคน + เคสที่ปิดแล้วแต่ยังไม่ปล่อยเงินเลย |
| `GET /` `GET /:id` | รายการรอบ (draft คิดสด, paid ใช้ยอดตรึง) · รายละเอียด + สลิปรายคน |
| `POST /` | เปิดรอบ (period_to ≤ วันนี้) กวาดงวดเข้า, จัดกลุ่มต่อคน · advisory lock กันเปิดพร้อมกัน |
| `POST /pay-now` | เปิด + จ่ายใน transaction เดียว · ชุดงวดต้องตรงกับพรีวิวเป๊ะ ไม่งั้น rollback |
| `GET /:id/items/:iid/payouts` | งวดในสลิปใบนั้น |
| `POST /:id/rebuild` | สร้างรายการใหม่ (คนที่เคยเอาออกกลับมา) |
| `DELETE /:id/items/:iid` | เอาคนออก → งวดกลับกองรอจ่าย |
| `POST /:id/pay` | บันทึกจ่าย → ตรึงยอด แก้/ยกเลิกไม่ได้อีก |
| `POST /:id/cancel` `DELETE /:id` | ยกเลิก (คืนงวด เก็บประวัติ) / ลบรอบร่าง |

**สายเงินพนักงานครบวงจร:** ตั้ง `staff_pay` เคส → (ตั้งสัดส่วน) → ปล่อยงวด ≤5 → เปิดรอบจ่าย → บันทึกจ่าย → พนักงานเห็นสลิปใน `/my/payslips` และ LINE

---

## 9. แพ็กเกจ — `/api/packages` · `/api/physio` (office)

| Endpoint | Logic |
| --- | --- |
| `GET /packages/meta` | ระดับ CG/NA/PN/RN · หมวด daily/weekly/monthly |
| `GET /packages/matrix` | ตารางราคา เกรด × รูปแบบ × ระดับ + ส่วนลด (% ก่อน แล้วบาท) + net, margin, staff_share (ตัดฟิลด์เงินถ้าไม่มีสิทธิ์) |
| `POST/PATCH/DELETE /packages/grades` `/formats` | จัดการเกรด/รูปแบบ (`graded=false` = เรทเดียวทุกเกรด) · ลบไม่มีด่านกัน (rates หายตาม) |
| `PATCH /packages/rates` | bulk upsert ใน tx เดียว · ไม่มีสิทธิ์เงิน = คง staff_pay เดิม |
| `GET/POST /physio/packages` `GET/PATCH/DELETE /:id` | คอร์สเหมาครั้ง · special = original − discount (server คิด) · ชื่อห้ามซ้ำ · มีเคสใช้แล้ว → แก้จำนวนครั้ง/ลบไม่ได้ (ให้ปิดขายแทน) |
| `PATCH /physio/reorder` | เรียงลำดับ |

---

## 10. คะแนนประเมินจากญาติ — `/api/reviews`

| Endpoint | Logic |
| --- | --- |
| `GET /form/:token` (สาธารณะ) | token 16 ไบต์ อายุ 90 วัน · คืนแค่ชื่อ/ตำแหน่ง |
| `POST /form/:token` (สาธารณะ) | 5 ข้อ คะแนน 1–5 บังคับ + ความเห็น + คำถามปลายปิด 2 ข้อ · เครื่องเดิมซ้ำใน 3 นาที → 409 · ≤30 ใบ/คน/24 ชม. → 429 · เก็บ hash ของ IP ไม่เก็บ IP ดิบ |
| `GET /summary` | คะแนนเฉลี่ยทุกคน (เฉลี่ยของค่าเฉลี่ยรายใบ) |
| `GET /employees/:id` | เฉลี่ยรายข้อ + แจกแจงดาว + 200 ใบล่าสุด |
| `GET/POST /employees/:id/link` | ลิงก์ปัจจุบัน (ออกให้ถ้ายังไม่มี) / ออกใหม่ ลิงก์เดิมตาย |
| `DELETE /entries/:rid` | ลบใบที่ยิงมั่ว |

---

## 11. ญาติดูการดูแลผ่าน LINE — `/api/family` (office) + `lib/family.js`

- ญาติสูงสุด **5 คน/เคส** · รหัสเชิญ 6 ตัว อายุ 7 วัน · สิทธิ์ญาติอยู่ต่อหลังปิด/ยกเลิกเคส **30 วัน**
- ญาติคนแรกที่แอดมินเชิญ (`can_invite`) ชวนต่อได้ คนที่ถูกชวนชวนต่อไม่ได้

| Endpoint | Logic |
| --- | --- |
| `GET /cases/:cid` | รายชื่อญาติ (linked/expired/pending) |
| `POST /cases/:cid/invites` | ต้อง `consent:true` · ได้รหัส + ลิงก์ `line.me/R/oaMessage/@kinhomecare/?ญาติ <code>` |
| `GET/POST /cases/:cid/customer-line` | ผูก LINE ของผู้ว่าจ้างเป็นญาติคนแรกทันที |
| `GET/POST /cases/:cid/messages` · รูป · `DELETE` | ไทม์ไลน์แชทเคส (100 ล่าสุด) · ทีมโพสต์ในนาม "ทีม KIN HomeCare" · ลบ = ซ่อน |
| `DELETE /cases/:cid/links/:lid` | ปลดญาติ |

---

## 12. เชื่อมระบบแชท/LINE — `/api/integration` (ตั๋ว Ed25519)

ทุกคำขอเป็น `{token}` = payload + ลายเซ็น Ed25519 จาก chat.kinorigin.com · ตรวจ purpose ตรง, ยังไม่หมดอายุ, อายุ ≤15 นาที · งานที่เขียนข้อมูลครอบด้วย `onceByTicket` (ยิงซ้ำได้คำตอบเดิม)

| กลุ่ม | Endpoints | Logic |
| --- | --- | --- |
| พนักงาน | `/line-code` | ผูก LINE ด้วยรหัส 6 หลัก |
| | `/report` | พนักงานพิมพ์ "รายงาน …" ใน LINE → หากะวันนี้/กะข้ามคืนอัตโนมัติ (เลือกไม่ได้คืน choices) → บันทึกรายงาน + คืน LINE ญาติให้ส่งต่อ |
| | `/my-summary` `/my-earnings` | กะวันนี้/พรุ่งนี้ · รายได้เดือนนี้ + tier |
| | `/hire` | สร้างพนักงานจากใบสมัคร (เฉพาะตำแหน่งหน้างาน) · เบอร์ซ้ำ → 409 |
| | `/employees/line-code` `/badge` `/line-roster` `/shift-counts` | ออกรหัสผูก · ดาว/ระดับ · รายชื่อที่ผูก LINE · นับกะ (แต้มชวนเพื่อน) |
| ลูกค้า/เคส | `/customers/link` `/match` `/cases` `/case-overview` `/billing` | ผูกลูกค้ากับแชท (เทียบเบอร์ 9 หลักท้าย) · ภาพรวมเคส/ยอดค้างสำหรับแอดมินแชท |
| | `/cases/assign` | มอบงานจากประกาศรับสมัคร: ไม่มีคนหลัก → assign, มีแล้ว → เข้าทีม |
| บิล | `/invoices/pending-slip` | สลิปจาก LINE → จับคู่บิลยอดตรง (±0.01) ไม่งั้นบิลครบกำหนดเร็วสุด · ดึงรูปเฉพาะ Vercel Blob |
| | `/invoices/line-outbox` `/slip-outbox` | claim คิว (lease 10 นาที ≤20 แถว) / ack |
| ญาติ | `/family/accept` `/summary` `/invite` `/post` `/photo` | รับคำเชิญ · หน้าสรุปญาติ · ชวนต่อ · โพสต์ (ตรวจ sha ของรูป) |
| | `/family/report-feed` `/message-feed` | feed แบบ cursor (≤50) ให้แชทส่งรายงาน/ข้อความต่อให้ญาติ/ทีม |
| | `/family/team-post` `/forward-customer` `/message-photo` | ทีมโพสต์/ส่งต่อข้อความลูกค้าเข้าไทม์ไลน์ |
| | `/family/weekly-summary` `/lifecycle-due` | สรุปสัญญาณชีพสัปดาห์นี้เทียบสัปดาห์ก่อน · แจ้งญาติเมื่อเคสปิด/สิทธิ์ใกล้หมด (≤3 วัน) |
| ดาว | `/ratings/due` `/ratings/submit` | ถามดาวรอบ d3 (วันที่ 3–13), ทุก 14 วัน, ปิดเคส · ดาว ≤2 = low |
| คิวแจ้งเตือน | `/visits/reminders` `/cases/events` | claim/ack คิวเตือนนัด และ event เคส |

---

## 13. แจ้งเตือน — `/api/notify` + outbox

| ส่วน | Logic |
| --- | --- |
| `GET /daily-digest` (Cron 08:00 ไทย, `Bearer CRON_SECRET`) | ส่งอีเมลวันละครั้ง (จองวันกันซ้ำ) ถึงคนที่มีสิทธิ์ office · **ไม่มีของค้าง = ไม่ส่ง** · หมวด: กะวันนี้ไม่มีคน, ค้างเช็คเอาท์, ขาดงาน 14 วัน, เช็คอินผิดปกติ 24 ชม., LINE ส่งล้ม, บิลเกินกำหนด |
| `POST /daily-digest` | แอดมินกดส่งเอง |
| `GET /digest-preview` | ดูเนื้อหาโดยไม่ส่ง |
| `GET /alerts` | ตัวเลขกระดิ่งตามหมวดสิทธิ์ (office/billing/money) |
| เตือนนัดพนักงาน | รอบ "วันก่อน" ตั้งแต่ 08:00 วันก่อนนัด · รอบ "3 ชม." ก่อนนัด · เฉพาะกะที่มีคนผูก LINE |
| เตือนญาติ | เคสกายภาพ: วันก่อนนัด + 3 ชม. ก่อน + แจ้งเช็คอิน/เช็คเอาท์ |
| เลื่อน/ยกเลิก/เปลี่ยนคน | รอนิ่ง 2 นาทีแล้วรวมเป็นข้อความเดียว · เลื่อนกลับที่เดิม = ไม่ส่ง |
| retry | backoff 10/20/40/80 นาที สูงสุด 5 ครั้ง · ข้ามข้อความที่ล้าสมัย (นัดเปลี่ยน/เช็คอินแล้ว) |
| event เคส | มอบงาน/ถอดคน/กะใหม่ → แจ้งพนักงาน (+ญาติถ้าเป็นคนหลัก) · แจ้งพังไม่ทำให้คำขอหลักล้ม |

---

## 14. หน้าเว็บ (client) ↔ โมดูล

| เมนู | สิทธิ์ | API หลัก |
| --- | --- | --- |
| แดชบอร์ด | office | cases/dashboard, summary, notify/alerts |
| พนักงาน · ลูกค้า · ผู้รับการดูแล | office | employees, customers, patients |
| เคส · ปฏิทิน · การมาทำงาน | office | cases/* |
| ใบแจ้งหนี้ | billing | invoices/* |
| ค่าตอบแทน · รายได้ | money | payroll/*, invoices/revenue |
| คะแนนประเมิน · แพ็กเกจ · แพ็กกายภาพ | office | reviews, packages, physio |
| งานวันนี้ · เคสของฉัน · แชท · รายงาน · ปฏิทิน · การมาทำงานของฉัน | ทุกคน (หน้างาน) | my/* |
| `/review/:token` · `/bill/:token` | สาธารณะ | reviews/form, public/bill |

---

## 15. ข้อสังเกตจากการวิเคราะห์ (ควรพิจารณา)

1. **รหัสผ่านเริ่มต้น `12345678` เหมือนกันทุกคนและไม่บังคับเปลี่ยน** (`lib/auth.js:69`, `requirePasswordChanged` ปล่อยผ่าน) — login ด้วยรหัสพนักงานได้ ใครรู้รหัสพนักงานก็เข้าบัญชีที่ยังไม่เปลี่ยนรหัสได้ รวมบัญชีที่เห็นข้อมูลสุขภาพ/การเงิน
2. ชื่อ `requireManager` จริง ๆ คือสิทธิ์ money (finance ผ่านด้วย) — ชวนสับสน
3. Geofence: เคสที่ไม่ตั้งพิกัดจะไม่ติดธงเลย · check-out ไม่ตรวจพิกัด
4. ปล่อยงวดเคสหลายคนโดยไม่ตั้งสัดส่วน → 400 `shares_required` (คอมเมนต์ในโค้ดบอกว่า "หารเท่ากัน" ไม่ตรงพฤติกรรมจริง)
5. Rate limit ของหน้าบิลสาธารณะเก็บในหน่วยความจำ — บน serverless หลาย instance นับแยกกัน
6. `POST /invoices/:id/refresh` บนใบที่เข้าเงื่อนไขห้าม sync ตอบ 200 แต่ใบไม่เปลี่ยน (อนุมานจาก SQL)
7. ลบเกรด/รูปแบบแพ็กเกจไม่มีด่านกัน — rates หายตามทันที
8. `GET /employees` ค้นหาไม่ได้ escape อักขระ LIKE (`%`, `_`) ต่างจาก customers/patients
9. คอมเมนต์ล้าสมัยหลายจุด: payStatus "≤3 งวด" (จริง 5), integration "≤3 ครั้ง" (จริง 5), `reset.js` "บังคับเปลี่ยนรหัส"
10. README.md ส่วน API ขาดโมดูลใหม่: payroll แบบงวด, family, integration, public bill, billing-plan/มัดจำ, สลิป
