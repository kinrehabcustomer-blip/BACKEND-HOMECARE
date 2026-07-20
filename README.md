# KIN Homecare — ระบบหลังบ้าน

ระบบจัดการภายในของ KIN Homecare เริ่มจากโมดูล **จัดการพนักงาน**

- `server/` — Node.js + Express (REST API) + SQLite
- `client/` — React + Vite (หน้าเว็บแอดมิน)

## หลักการสำคัญ: employee_id เป็น primary key

พนักงานทุกคนมีรหัสรูปแบบ **`EMP-0001`** ที่ระบบออกให้อัตโนมัติ (เดินหน้าเสมอ ไม่วนใช้เลขซ้ำแม้พนักงานถูกลบ)

รหัสนี้คือกุญแจเดียวที่ใช้อ้างอิงพนักงานทั้งระบบ — ทุก endpoint, ทุกหน้าจอ, และทุกตารางที่จะเพิ่มในอนาคต (ตารางเวร, เงินเดือน, การมอบหมายผู้ป่วย) ให้ผูกกับ `employee_id` เท่านั้น ห้ามใช้ชื่อหรือเลขบัตรประชาชนเป็นตัวอ้างอิง และ **ห้ามแก้ไข `employee_id` หลังสร้างแล้ว** — API จึงไม่เปิดให้แก้ field นี้

ตัวอย่างที่ทำไว้แล้ว: ตาราง `employee_certificates` ผูกกับพนักงานผ่าน `employee_id` แบบ `ON DELETE CASCADE`

## เริ่มใช้งาน

```bash
npm install
npm run migrate  # สร้างตารางในฐานข้อมูล (รันซ้ำได้ ไม่ทับของเดิม)
npm run dev      # รัน API (:4000) + หน้าเว็บ (:5173) พร้อมกัน
```

เปิด http://localhost:5173

ฐานข้อมูลเป็น PostgreSQL (Neon) — ต้องมี `DATABASE_URL` ใน `.env` ที่ root ของ repo

ระบบไม่มีข้อมูลตัวอย่าง/mock อยู่แล้ว ข้อมูลทุกแถวคือของจริงที่กรอกผ่านหน้าเว็บ

## API

| Method | Endpoint | คำอธิบาย |
| --- | --- | --- |
| GET | `/api/employees` | รายชื่อพนักงาน — รองรับ `q`, `status`, `position`, `page`, `per_page`, `sort`, `order` |
| POST | `/api/employees` | เพิ่มพนักงาน (ระบบออก `employee_id` ให้เอง) |
| GET | `/api/employees/:id` | ข้อมูลพนักงาน + ใบรับรองทั้งหมด |
| PATCH | `/api/employees/:id` | แก้ไขข้อมูล (ส่งเฉพาะ field ที่ต้องการแก้) |
| DELETE | `/api/employees/:id` | บันทึกลาออก — เก็บประวัติไว้ เปลี่ยนสถานะเป็น `resigned` |
| DELETE | `/api/employees/:id?hard=true` | ลบถาวร (ใบรับรอง cascade ตาม) |
| GET | `/api/employees/summary` | นับจำนวนแยกตามสถานะและตำแหน่ง |
| GET | `/api/employees/meta` | ค่า enum ทั้งหมด สำหรับทำ dropdown |
| GET/POST | `/api/employees/:id/certificates` | ใบรับรองของพนักงาน |
| DELETE | `/api/employees/:id/certificates/:certificateId` | ลบใบรับรอง |

**ค่า enum:** `position` = caregiver, nurse, assistant_nurse, therapist, admin, driver, manager · `employment_type` = fulltime, parttime, contract, daily · `status` = active, probation, on_leave, suspended, resigned

Validation ทำด้วย zod ที่ [server/src/employees/schema.js](server/src/employees/schema.js) — ข้อมูลผิดจะได้ HTTP 400 พร้อมบอกว่า field ไหนผิดเพราะอะไร (เป็นภาษาไทย), เลขบัตรประชาชนซ้ำได้ HTTP 409

## ย้ายไป PostgreSQL ตอน deploy

SQL ทั้งหมดอยู่ใน [server/src/db/](server/src/db/) และ [server/src/employees/repo.js](server/src/employees/repo.js) เท่านั้น — ส่วนที่ต้องแก้คือ `AUTOINCREMENT` → `SERIAL`/`IDENTITY`, `datetime('now')` → `NOW()` และเปลี่ยน driver เป็น `pg` ส่วน route/validation/หน้าเว็บไม่ต้องแตะ
