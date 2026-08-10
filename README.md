# KIN Homecare — ระบบหลังบ้าน

ระบบจัดการภายในของ KIN Homecare (ธุรกิจดูแลผู้สูงอายุ/ผู้ป่วยที่บ้าน) — จัดการพนักงาน ลูกค้า ผู้รับการดูแล เคสงาน และแพ็คเกจราคา ในที่เดียว UI ภาษาไทยทั้งหมด

- `server/` — Node.js + Express (REST API) + PostgreSQL
- `client/` — React + Vite (หน้าเว็บแอดมิน)
- เป็น monorepo แบบ npm workspaces · deploy เป็น serverless บน Vercel

---

## เทคโนโลยี

| ส่วน | ใช้ |
| --- | --- |
| Backend | Node.js 22 (ESM), Express 4, PostgreSQL (ไดรเวอร์ `pg`) |
| Validation | zod — ข้อมูลผิดได้ HTTP 400 พร้อมบอกเป็นภาษาไทยว่า field ไหนผิด |
| Auth | JWT ใน httpOnly cookie, รหัสผ่าน bcrypt, OTP รีเซ็ตรหัสผ่านทางอีเมล (nodemailer) |
| Frontend | React 19, React Router 7, Vite 8 — ไม่มี state library (ใช้ Context), CSS ไฟล์เดียว |
| ฐานข้อมูล | PostgreSQL (Neon) |
| Deploy | Vercel (serverless function + static SPA) |

---

## หลักการออกแบบสำคัญ

**1. ID ที่ระบบออกให้เอง เป็นกุญแจอ้างอิงเดียว**
พนักงาน `EMP-0001`, ลูกค้า `CUS-0001`, ผู้รับการดูแล `PAT-0001`, เคส `CASE-0001` — ออกโดยตาราง `id_counters` (เดินหน้าเสมอ ไม่วนใช้เลขซ้ำแม้ลบแถวไปแล้ว) **ห้ามใช้ชื่อ/เลขบัตรเป็นตัวอ้างอิง และ `employee_id` ห้ามแก้หลังสร้าง** — API จึงไม่เปิดให้แก้

**2. แยก "ผู้ว่าจ้าง" ออกจาก "ผู้รับการดูแล"**
`customers` = คนจ่ายเงิน/ผู้ติดต่อ · `patients` = ผู้ป่วยที่รับบริการจริง — เพราะลูกค้า 1 คนอาจจ้างดูแลหลายคน (เช่น พ่อ+แม่) **ข้อมูลสุขภาพอยู่ที่ `patients` เท่านั้น ไม่เก็บที่ลูกค้า**

**3. เคสเก็บ snapshot ข้อมูล ณ วันเปิดเคส**
เคส "คัดลอก" ข้อมูลลูกค้า/ผู้ป่วย/ค่าบริการมาเก็บในตัวเอง ไม่อ่านสดจากต้นทาง — เคสที่ปิดไปแล้วจึงคงข้อมูล ณ วันให้บริการไว้ถูกต้อง แม้ต้นทางจะถูกแก้หรือลบ (FK เป็น `ON DELETE SET NULL` ไม่ลบเคสตาม)

**4. สถานะเคสถูกบังคับให้สอดคล้องกับความจริงระดับฐานข้อมูล**
CHECK constraint กันไม่ให้เกิดเคส "จับคู่แล้ว/กำลังให้บริการ" ที่ไม่มีพนักงาน — และการเปลี่ยนสถานะทำผ่าน endpoint เฉพาะเท่านั้น (ไม่ให้แก้ field `status`/`assigned_to` ตรงๆ)

**5. ค่าตอบแทนคิดที่ "กะที่ทำจริง" ไม่ใช่ "เคสที่ปิด"**
ยอดของแต่ละกะ = `case_visits.staff_pay` ถ้าตั้งไว้ ไม่ตั้งก็เกลี่ยจาก `cases.staff_pay` หารจำนวนกะที่นัดไว้ — นับให้**คนที่เช็คอินจริง**ใน**เดือนที่เช็คอิน** และถูก**ตรึงเป็นตัวเลขถาวรตอนปิดเคส** เปลี่ยนพนักงานกลางคันหรือเคสลากข้ามเดือนแล้วยอดยังตกถูกคน ถูกเดือน

**6. ทุกการเปลี่ยนสถานะของเคสถูกบันทึกว่าใครทำ**
`case_events` เก็บทีละครั้ง (เปิด/แก้/จับคู่/ถอด/เริ่ม/ปิด/ยกเลิก/เปิดใหม่/แก้กะ) พร้อมชื่อผู้ทำรายการ ณ ตอนนั้น — เขียนใน transaction เดียวกับการเปลี่ยนแปลงเสมอ

**7. ข้อมูลความปลอดภัยของผู้ป่วยอ่านสด ไม่ใช่ snapshot**
ราคา/ผู้จ่าย = snapshot (ต้องไม่ขยับ) แต่ **แพ้ยา / แพ้อาหาร / โรคประจำตัว อ่านสดจากแฟ้ม `patients`** — แก้แฟ้มแล้วคนที่กำลังจะเข้าบ้านเห็นทันที และเคสจะขึ้นป้ายว่า snapshot เดิมไม่ตรงแล้ว

**8. SQL รวมอยู่ที่เดียว**
คำสั่ง SQL ทั้งหมดอยู่ใน [server/src/db/](server/src/db/) และไฟล์ `repo.js` ของแต่ละโมดูล — route/validation/หน้าเว็บไม่แตะ SQL

---

## โมดูล

| โมดูล | ความหมาย | จุดเด่น |
| --- | --- | --- |
| **auth** | เข้าสู่ระบบ | JWT cookie (อายุ 8 ชม.), ลืมรหัส = OTP อีเมล, เปลี่ยน/รีเซ็ตรหัส |
| **employees** พนักงาน | ผู้ให้บริการ | ใบรับรอง + portfolio (รูปเก็บใน DB), ลาออกแบบ soft/ลบถาวร |
| **customers** ลูกค้า | ผู้ว่าจ้าง/ผู้จ่ายเงิน | ข้อมูลติดต่อ + ที่อยู่ (ไม่มีข้อมูลสุขภาพ) |
| **patients** ผู้รับการดูแล | ผู้ป่วยจริง | ข้อมูลการแพทย์, ผูกกับลูกค้าได้, สถานะ active/inactive |
| **cases** เคส | งานดูแล 1 งาน | วงจร 5 สถานะ, มอบหมายพนักงาน, dashboard สรุป |
| **packages** แพ็คเกจ Homecare | ตารางราคา | เกรด × รูปแบบบริการ × ระดับพนักงาน (CG/NA/PN) |
| **physio** แพ็คเกจกายภาพ | คอร์สเหมาครั้ง | จำนวนครั้ง + ราคาพิเศษ (คนละโมเดลกับ Homecare) |

### วงจรสถานะเคส

```
ยังไม่จับคู่ (unassigned) ──จับคู่──► จับคู่แล้ว/รอเริ่ม (assigned) ──เริ่ม──► กำลังให้บริการ (in_progress)
                                            │                              │
                                            └──────────► ปิดเคส (closed) ◄─┘
   ทุกสถานะที่ยังไม่จบ ──ยกเลิก──► ยกเลิก (cancelled)
   closed / cancelled ──เปิดใหม่──► กลับเป็น unassigned / assigned
```

---

## เริ่มใช้งาน

```bash
npm install
npm run migrate          # สร้าง/อัปเดตตารางใน Postgres (รันซ้ำได้ ไม่ทับของเดิม)
npm run seed:packages    # (ครั้งแรก) ใส่ข้อมูลตัวอย่างตารางราคา Homecare — ไม่บังคับ
npm run dev              # รัน API (:4000) + หน้าเว็บ (:5173) พร้อมกัน
```

เปิด http://localhost:5173

> ต้องมี `DATABASE_URL` (Neon/Postgres) และ `JWT_SECRET` ใน `.env` ที่ root ของ repo ก่อนรัน — ดู [server/.env.example](server/.env.example)

ระบบไม่มีข้อมูล mock — ข้อมูลทุกแถวคือของจริงที่กรอกผ่านหน้าเว็บ (ยกเว้นตารางราคาตัวอย่างจาก `seed:packages`)

### Environment variables

| ตัวแปร | จำเป็น | คำอธิบาย |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | connection string ของ Neon/Postgres |
| `JWT_SECRET` | ✅ | กุญแจเซ็น session token (ยาว ≥ 32 ตัวอักษร) |
| `CORS_ORIGIN` | — | origin ของหน้าเว็บ (dev: `http://localhost:5173`) |
| `PORT` | — | พอร์ต API (ปริยาย 4000) |
| `SMTP_HOST/PORT/USER/PASS/FROM` | — | ส่ง OTP รีเซ็ตรหัส + สรุปของค้างประจำวัน — เว้นว่าง = พิมพ์ลง console (ใช้เฉพาะ dev) |
| `CRON_SECRET` | — | กุญแจให้ Vercel Cron เรียก `/api/notify/daily-digest` ได้ · ไม่ตั้ง = เรียกได้เฉพาะผู้จัดการที่ login แล้ว |

---

## API

ทุก endpoint ขึ้นต้น `/api` และต้อง login ก่อน (JWT cookie) ยกเว้น `/api/health` และ `/api/auth/*`

### Auth — `/api/auth`
| Method | Endpoint | คำอธิบาย |
| --- | --- | --- |
| POST | `/login` | เข้าสู่ระบบ (email + password) — พนักงานที่ลาออก/พักงาน เข้าไม่ได้ |
| POST | `/logout` | ออกจากระบบ |
| GET | `/me` | ข้อมูล session ปัจจุบัน |
| POST | `/forgot-password` | ขอ OTP รีเซ็ตรหัส (ส่งอีเมล) |
| POST | `/reset-password` | ตั้งรหัสใหม่ด้วย OTP |
| POST | `/change-password` | เปลี่ยนรหัส (ต้องใส่รหัสเดิม) |

### Employees — `/api/employees`
| Method | Endpoint | คำอธิบาย |
| --- | --- | --- |
| GET | `/` `/:id` `/summary` `/meta` | รายการ (ค้นหา/กรอง/แบ่งหน้า), รายละเอียด, สรุปจำนวน, ค่า enum |
| POST/PATCH | `/` `/:id` | เพิ่ม (ออก `EMP-####` ให้), แก้ไข |
| DELETE | `/:id` | บันทึกลาออก (soft) · `?hard=true` = ลบถาวร |
| GET/PUT | `/:id/photo` | รูปพนักงาน (คนละ 1 รูป) — `PUT { image: null }` = ลบรูป |
| — | `/:id/certificates` · `/:id/portfolio` | ใบรับรอง / portfolio (มีรูปแนบได้) |

### Customers — `/api/customers` · Patients — `/api/patients`
| Method | Endpoint | คำอธิบาย |
| --- | --- | --- |
| GET | `/` `/:id` | รายการ + รายละเอียด (พร้อมประวัติเคส) |
| POST/PATCH | `/` `/:id` | เพิ่ม (ออก `CUS-####`/`PAT-####`), แก้ไข — บังคับแค่ชื่อ |
| DELETE | `/:id` | ลบถาวร (เคสไม่หายตาม เพราะ snapshot ไว้) |

### Cases — `/api/cases`
| Method | Endpoint | คำอธิบาย |
| --- | --- | --- |
| GET | `/` `/:id` `/summary` `/periods` `/meta` | รายการ/รายละเอียด/สรุป/ช่วงเวลา/ค่า enum |
| GET | `/assignable-employees` | พนักงานที่รับเคสได้ + จำนวนเคสที่ถืออยู่ |
| GET | `/:id/events` | ประวัติการทำรายการของเคส (ใครทำอะไร เมื่อไหร่) |
| POST/PATCH | `/` `/:id` | เปิดเคส (ออก `CASE-####`), แก้ไขข้อมูล |
| POST | `/:id/assign` `/:id/unassign` | จับคู่ / ยกเลิกจับคู่พนักงาน |
| POST | `/:id/start` `/:id/close` `/:id/cancel` `/:id/reopen` | เริ่มบริการ / ปิด / ยกเลิก / เปิดใหม่ — `close` ต้องส่ง `force: true` ถ้ายังมีกะค้าง |
| GET/POST/PATCH/DELETE | `/:id/visits` `/:id/visits/:visitId` | กะของเคส (เพิ่ม/แก้/ลบทีละกะ) |
| POST | `/:id/visits/bulk` | ลงกะหลายวันครั้งเดียว — `dates: [...]` หรือ `from`/`to`(+`weekdays`) · คืนจำนวนที่เพิ่ม/ข้าม + กะที่ชนกัน |
| POST | `/:id/visits/preview` | **ตรวจก่อนบันทึก** ว่าวันที่เลือกชนกับงานอื่นของคนนั้นไหม (ไม่เขียนอะไร) |
| DELETE | `/:id/visits?dates=` / `?from=&to=` | ลบกะหลายวัน (ข้ามกะที่เช็คอินไปแล้ว) |

### Packages (Homecare) — `/api/packages` · Physio — `/api/physio`
| Method | Endpoint | คำอธิบาย |
| --- | --- | --- |
| GET | `/matrix` (homecare) | ตารางราคาเต็ม (เกรด × รูปแบบ × ระดับ) + `margin`/`staff_share` คำนวณให้ |
| POST/PATCH/DELETE | `/grades` `/formats` `/rates` | จัดการเกรด/รูปแบบ/ราคา (bulk) |
| GET/POST/PATCH/DELETE | `/physio/packages` | แพ็คเกจกายภาพบำบัด + `/reorder` จัดลำดับ |

**ค่า enum หลัก**
- `position` = caregiver, assistant_nurse, practical_nurse, nurse, therapist, manager, hr
- `employment_type` = fulltime, parttime, contract, daily
- พนักงาน `status` = active, probation, on_leave, suspended, resigned
- เคส `status` = unassigned, assigned, in_progress, closed, cancelled
- ผู้รับการดูแล `status` = active, inactive
- ระดับพนักงาน (แพ็คเกจ) = CG, NA, PN

---

## Data model (ตารางหลัก)

| ตาราง | หน้าที่ |
| --- | --- |
| `employees` | พนักงาน (PK `employee_id`) + auth (password_hash, role) + รูปพนักงาน (`photo_data` BYTEA) |
| `employee_certificates` · `employee_portfolio` | ใบรับรอง / ผลงาน — รูปเก็บเป็น `BYTEA` ใน DB (ไม่มี file storage ภายนอก) |
| `customers` | ผู้ว่าจ้าง (PK `customer_id`) |
| `patients` | ผู้รับการดูแล (PK `patient_id`) — FK → customers |
| `cases` | เคสงาน (PK `case_id`) — snapshot + FK → employees/customers/patients/แพ็คเกจ |
| `pkg_grades` · `pkg_service_formats` · `pkg_rates` | ตารางราคา Homecare (เกรด × รูปแบบ × ระดับ) |
| `physio_packages` | แพ็คเกจกายภาพบำบัด (เหมาจำนวนครั้ง) |
| `case_visits` | กะงาน 1 แถว = 1 กะ ของพนักงาน 1 คน — แผน (ใครไป/เวลานัด/ค่าจ้างกะ) + ของจริง (เช็คอิน-เอาท์ พิกัด รูป สาย นอกวันนัด) |
| `case_events` | ประวัติการทำรายการของเคส (audit log) — ใครทำอะไร เมื่อไหร่ |
| `invoice_items` | รายการย่อยบนใบแจ้งหนี้ (มีเฉพาะใบที่ออกตามกะที่ไปจริง — ใบแพ็คเกจปกติไม่มี) |
| `password_reset_otps` | OTP รีเซ็ตรหัส (เก็บเป็น hash) |
| `id_counters` | ตัวนับออก ID รันนิ่ง (EMP/CUS/PAT/CASE) |

schema ทั้งหมด (พร้อมคำอธิบายทุกคอลัมน์) อยู่ที่ [server/src/db/schema.sql](server/src/db/schema.sql) — เป็นสคริปต์ migration แบบ additive (`CREATE TABLE IF NOT EXISTS` + `ALTER ... IF EXISTS`) รันซ้ำได้เสมอไม่ทับของเดิม

---

## Deploy (Vercel)

- `vercel.json` — build หน้าเว็บด้วย `client` (`outputDirectory: client/dist`), rewrite `/api/*` ไปที่ serverless function, ที่เหลือ fallback เป็น SPA
- [api/index.js](api/index.js) — จุดเข้า serverless: `export default createApp()` (Express app เป็น `(req, res)` handler อยู่แล้ว)
- การเชื่อมต่อ DB ([server/src/db/index.js](server/src/db/index.js)) ตั้ง pool เล็ก (`max: 3`) ให้เหมาะกับ serverless + โควตา connection ของ Neon
- push ขึ้น `main` แล้ว Vercel deploy อัตโนมัติ (ถ้าตั้ง auto-deploy)
- **Cron** — `vercel.json` ตั้งให้เรียก `/api/notify/daily-digest` ทุกวัน 01:00 UTC (08:00 เวลาไทย) ส่งสรุปของค้าง
  (กะวันนี้ที่ยังไม่มีคน · ค้างเช็คเอาท์ · ขาดงาน · เช็คอินที่ต้องตรวจ · ใบแจ้งหนี้เลยกำหนด) ให้ผู้จัดการทุกคนทางอีเมล
  ต้องตั้ง `CRON_SECRET` ใน Vercel ก่อน ไม่งั้น cron จะถูกปฏิเสธ · ไม่มีของค้าง = ไม่ส่ง

---

## โครงสร้างโปรเจค

```
BACKEND-HOMECARE/
├── api/index.js            จุดเข้า serverless (Vercel)
├── vercel.json
├── server/
│   └── src/
│       ├── app.js          ประกอบ Express app + ผูก router ทุกโมดูล
│       ├── index.js        จุดเข้าแบบรันเครื่อง (npm run dev)
│       ├── db/             schema.sql, migrate.js, seed, ตัวเชื่อม pg
│       ├── lib/            auth (JWT/bcrypt), env, mailer, errors
│       └── {auth,employees,customers,patients,cases,packages,physio}/
│                           แต่ละโมดูล = routes.js + repo.js + schema.js
└── client/
    └── src/
        ├── App.jsx         routing + layout + sidebar
        ├── auth.jsx        AuthProvider + RequireAuth (cookie session)
        ├── api.js          ตัวเรียก API รวมศูนย์
        ├── labels.js       enum → ป้ายภาษาไทย + helper (เงิน/วันที่/อายุ)
        ├── pages/          หน้าแต่ละโมดูล
        └── components/     modal + ส่วนย่อย (ใบรับรอง/portfolio/ประวัติ)
```
