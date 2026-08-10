-- ตารางหลัก: พนักงาน
-- employee_id (เช่น EMP-0001) เป็น PRIMARY KEY และเป็นกุญแจเดียวที่ระบบใช้อ้างอิงพนักงานในทุกโมดูล
CREATE TABLE IF NOT EXISTS employees (
  employee_id             TEXT PRIMARY KEY,
  first_name              TEXT NOT NULL,
  last_name               TEXT NOT NULL,
  nickname                TEXT,
  national_id             TEXT UNIQUE,
  phone                   TEXT,
  email                   TEXT,
  gender                  TEXT CHECK (gender IN ('male', 'female', 'other')),
  birth_date              TEXT,
  address                 TEXT,

  position                TEXT NOT NULL CHECK (position IN ('caregiver', 'assistant_nurse', 'practical_nurse', 'nurse', 'therapist', 'manager', 'hr')),
  employment_type         TEXT NOT NULL DEFAULT 'fulltime' CHECK (employment_type IN ('fulltime', 'parttime', 'contract', 'daily')),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'probation', 'on_leave', 'suspended', 'resigned')),

  hire_date               TEXT,
  resign_date             TEXT,
  base_salary             DOUBLE PRECISION,

  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  note                    TEXT,

  -- เก็บเป็น TEXT รูปแบบ 'YYYY-MM-DD HH:MM:SS' (UTC) ให้ JSON ที่ส่งออกหน้าตาเหมือนเดิมกับตอนใช้ SQLite
  created_at              TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at              TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_employees_status   ON employees (status);
CREATE INDEX IF NOT EXISTS idx_employees_position ON employees (position);
CREATE INDEX IF NOT EXISTS idx_employees_name     ON employees (first_name, last_name);

-- รายการตำแหน่ง: สายดูแล (CG, NA, PN, RN, นักกายภาพบำบัด) + สายสำนักงาน (ผู้จัดการ, HR)
-- ตาราง employees ถูกสร้างไปแล้วในฐานข้อมูลเดิม (CHECK ด้านบนไม่ถูกแตะ) จึงต้อง drop/add constraint ตรงนี้
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_position_check;
ALTER TABLE employees ADD CONSTRAINT employees_position_check
  CHECK (position IN ('caregiver', 'assistant_nurse', 'practical_nurse', 'nurse', 'therapist', 'manager', 'hr'));

-- ใบรับรอง / ใบประกอบวิชาชีพ ผูกกับพนักงานผ่าน employee_id
CREATE TABLE IF NOT EXISTS employee_certificates (
  certificate_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees (employee_id) ON DELETE CASCADE ON UPDATE CASCADE,
  name           TEXT NOT NULL,
  issuer         TEXT,
  issued_date    TEXT,
  expiry_date    TEXT,
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_certificates_employee ON employee_certificates (employee_id);

-- ชื่อภาษาอังกฤษ (ใช้กับเอกสาร/ใบรับรองที่เป็นภาษาอังกฤษ) — ไม่บังคับกรอก
ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name_en TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name_en  TEXT;

-- ประวัติการศึกษา — ข้อความอิสระหลายบรรทัด (วุฒิ / สถาบัน / ปีที่จบ)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS education TEXT;

-- รูปใบรับรอง (ถ่าย/สแกนมา) — เก็บไบนารีไว้ใน DB เลย ไม่ต้องพึ่งบริการเก็บไฟล์ภายนอก
-- ฝั่งเบราว์เซอร์ย่อรูปก่อนส่ง (ด้านยาวสุด 1600px, JPEG) ไฟล์จริงจึงเหลือราว 100–300 KB
ALTER TABLE employee_certificates ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE employee_certificates ADD COLUMN IF NOT EXISTS image_mime TEXT;
ALTER TABLE employee_certificates ADD COLUMN IF NOT EXISTS image_size INTEGER;

-- ผลงานของพนักงาน (โปรไฟล์) — รูปผลงานพร้อมคำอธิบาย ผูกกับ employee_id
CREATE TABLE IF NOT EXISTS employee_portfolio (
  portfolio_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id  TEXT NOT NULL REFERENCES employees (employee_id) ON DELETE CASCADE ON UPDATE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  image_data   BYTEA NOT NULL,   -- ผลงานต้องมีรูปเสมอ ไม่งั้นไม่มีอะไรให้ดู
  image_mime   TEXT NOT NULL,
  image_size   INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_portfolio_employee ON employee_portfolio (employee_id);

-- ---------- ระบบเข้าสู่ระบบ ----------
-- เพิ่มทีหลังด้วย ALTER เพราะตาราง employees ถูกสร้างไปแล้ว (CREATE TABLE IF NOT EXISTS ข้างบนจะไม่แตะของเดิม)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash        TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role                 TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_login_at        TEXT;

-- อีเมลคือ username จึงต้องไม่ซ้ำ — เทียบแบบไม่สนตัวพิมพ์ใหญ่เล็ก
-- ใช้ partial index เพราะพนักงานที่ยังไม่มีอีเมลมีได้หลายคน (NULL ไม่ชนกัน) เขาแค่ยัง login ไม่ได้
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_unique
  ON employees (lower(email))
  WHERE email IS NOT NULL;

-- ---------- ลูกค้า / ผู้รับบริการ ----------
-- customer_id (เช่น CUS-0001) เป็น PRIMARY KEY ที่ใช้อ้างอิงลูกค้าทั้งระบบ
CREATE TABLE IF NOT EXISTS customers (
  customer_id      TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  gender           TEXT CHECK (gender IN ('male', 'female', 'other')),
  age              INTEGER CHECK (age BETWEEN 0 AND 130),
  phone            TEXT,
  address          TEXT,
  note             TEXT,

  created_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name);

-- ข้อมูลลูกค้าเพิ่มเติม — เพิ่มด้วย ALTER เพราะตาราง customers ถูกสร้างไปแล้ว (CREATE TABLE IF NOT EXISTS ข้างบนไม่แตะของเดิม)
-- ทุกช่องไม่บังคับกรอก: เคสส่วนใหญ่รับทางโทรศัพท์ ได้ข้อมูลมาไม่ครบตั้งแต่แรก บังคับแล้วจะเปิดเคสไม่ได้
-- ชื่อ (name) ยังเป็นช่องเดียวที่บังคับ ส่วน customer_id ระบบออกให้เอง
ALTER TABLE customers ADD COLUMN IF NOT EXISTS title            TEXT CHECK (title IN ('mr', 'mrs', 'miss', 'boy', 'girl'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS nickname         TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS name_en          TEXT;   -- ชื่อ-นามสกุล ภาษาอังกฤษ (ใช้กับ passport/เอกสารต่างประเทศ)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS national_id      TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS passport_no      TEXT;
-- วันเกิดแม่นกว่าอายุ: อายุที่เก็บเป็นตัวเลขจะเก่าลงทุกปีจนผิด ส่วนวันเกิดคำนวณอายุสดได้เสมอ
-- คอลัมน์ age เดิมยังอยู่ ใช้กับลูกค้าที่รู้แต่อายุคร่าวๆ ไม่รู้วันเกิด
ALTER TABLE customers ADD COLUMN IF NOT EXISTS birth_date       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS nationality      TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marital_status   TEXT CHECK (marital_status IN ('single', 'married', 'divorced', 'widowed'));

-- ช่องทางติดต่อ (phone มีอยู่แล้ว = มือถือ)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS line_id          TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email            TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS home_phone       TEXT;

-- ที่อยู่แยกส่วน — งาน homecare จัดพนักงานตามพื้นที่ ต้องกรองด้วยจังหวัด/อำเภอได้ ไม่ใช่อ่านจากที่อยู่ก้อนเดียว
-- address เดิมยังอยู่ = บ้านเลขที่/ถนน/รายละเอียดที่เหลือ
ALTER TABLE customers ADD COLUMN IF NOT EXISTS province         TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS district         TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS subdistrict      TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code      TEXT;

-- ข้อมูลสุขภาพ "ไม่เก็บที่ลูกค้า (ผู้ว่าจ้าง)" — ย้ายไปอยู่ที่แฟ้มผู้รับการดูแล (patients) เท่านั้น
-- ลบคอลัมน์ทั้ง 6 ทิ้งถาวร (รวมของเดิมใน CREATE TABLE ด้วย) — DROP ... IF EXISTS จึงเงียบบนฐานใหม่ที่ไม่เคยมี
ALTER TABLE customers DROP COLUMN IF EXISTS weight_kg;
ALTER TABLE customers DROP COLUMN IF EXISTS height_cm;
ALTER TABLE customers DROP COLUMN IF EXISTS medical_history;
ALTER TABLE customers DROP COLUMN IF EXISTS allergies;
ALTER TABLE customers DROP COLUMN IF EXISTS blood_type;
ALTER TABLE customers DROP COLUMN IF EXISTS medical_rights;

-- ผู้ดูแล/ญาติที่ติดต่อได้ — แยกชื่อกับเบอร์เหมือนตาราง employees เพื่อให้กดโทรจากเบอร์ตรงๆ ได้
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emergency_contact_name  TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS occupation       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type    TEXT;   -- ข้อความอิสระ ยังไม่ตายตัวว่าแบ่งกลุ่มลูกค้ายังไง
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_source  TEXT;   -- รู้จักผ่านช่องทางไหน (ใช้ดูว่าการตลาดช่องทางไหนได้ผล)

-- เลขบัตรประชาชนซ้ำ = สร้างลูกค้าคนเดิมซ้ำสองรอบ (มักเกิดตอนเปิดเคสแล้วสร้างลูกค้าอัตโนมัติ)
-- partial index เพราะลูกค้าที่ยังไม่ได้กรอกเลขบัตรมีได้หลายคน (NULL ไม่ชนกัน)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_national_id
  ON customers (national_id) WHERE national_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_province ON customers (province);

-- ---------- ผู้รับการดูแล (Patient) ----------
-- แฟ้ม "คนที่ถูกดูแล" แยกจาก customers ("คนที่ว่าจ้าง/จ่ายเงิน") — ลูกค้าหนึ่งคนดูแลได้หลายคน (พ่อ+แม่)
-- จึงต้องเป็นตารางของตัวเอง ไม่ใช่คัดลอกประวัติลงทุกเคส เปิดเคสรอบใหม่ก็อ้างแฟ้มเดิมได้
-- customer_id เป็น FK แบบ SET NULL: เปลี่ยนผู้ว่าจ้างได้ และลบลูกค้าแล้วแฟ้มผู้ป่วยไม่หายตาม
-- เก็บเฉพาะข้อมูล "คงที่" (ตัวตน/โรคประจำตัว/แพ้ยา/ที่อยู่) — อาการ/ADL ที่เปลี่ยนตามเวลาอยู่ที่เคส/การประเมิน
CREATE TABLE IF NOT EXISTS patients (
  patient_id   TEXT PRIMARY KEY,
  customer_id  TEXT REFERENCES customers (customer_id) ON DELETE SET NULL ON UPDATE CASCADE,

  name         TEXT NOT NULL,
  title        TEXT CHECK (title IN ('mr', 'mrs', 'miss', 'boy', 'girl')),
  nickname     TEXT,
  name_en      TEXT,
  gender       TEXT CHECK (gender IN ('male', 'female', 'other')),
  national_id  TEXT,
  passport_no  TEXT,
  birth_date   TEXT,   -- วันเกิดแม่นกว่าอายุ (อายุที่เก็บเป็นตัวเลขจะเก่าลงทุกปี) — คำนวณอายุสดจากตรงนี้
  age          INTEGER CHECK (age BETWEEN 0 AND 130),  -- ใช้เมื่อรู้แต่อายุคร่าวๆ ไม่รู้วันเกิด
  nationality  TEXT,

  -- ความสัมพันธ์กับผู้ว่าจ้าง เช่น 'บิดา'/'มารดา' เมื่อผู้จ้างเป็นลูก
  relation_to_customer TEXT,

  -- การแพทย์เชิงคงที่ (อาการปัจจุบัน/อุปกรณ์ที่เปลี่ยนได้ อยู่ที่เคส ไม่ใช่ที่นี่)
  medical_history TEXT,   -- โรคประจำตัว
  allergies       TEXT,   -- แพ้ยา — พนักงานต้องเห็นก่อนเข้าเคส (แพ้อาหารอยู่ที่ food_allergies)
  blood_type      TEXT CHECK (blood_type IN ('A', 'B', 'AB', 'O')),
  medical_rights  TEXT,   -- สิทธิการรักษา

  -- ที่อยู่สถานที่ดูแล — อาจต่างจากที่อยู่ผู้ว่าจ้าง
  address      TEXT,
  subdistrict  TEXT,
  district     TEXT,
  province     TEXT,
  postal_code  TEXT,

  -- ญาติ/ผู้ติดต่อกรณีฉุกเฉิน (ที่ตัวผู้ป่วย — อาจไม่ใช่คนเดียวกับผู้ว่าจ้าง)
  emergency_contact_name     TEXT,
  emergency_contact_phone    TEXT,
  emergency_contact_relation TEXT,

  -- active = กำลังดูแล/พร้อมใช้บริการ, inactive = พักการดูแล
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  note   TEXT,

  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_patients_customer ON patients (customer_id);
CREATE INDEX IF NOT EXISTS idx_patients_name     ON patients (name);
CREATE INDEX IF NOT EXISTS idx_patients_status   ON patients (status);
-- เลขบัตรซ้ำ = สร้างแฟ้มผู้ป่วยคนเดิมซ้ำ; partial index เพราะผู้ป่วยที่ยังไม่กรอกเลขบัตรมีได้หลายคน
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_national_id
  ON patients (national_id) WHERE national_id IS NOT NULL;

-- เอาสถานะ 'deceased' (เสียชีวิต) ออก — ย้ายแถวเดิมที่เป็น deceased ไปเป็น 'inactive' ก่อนแล้วค่อยเปลี่ยน constraint
-- (ทำก่อน drop/add เสมอ ไม่งั้น constraint ใหม่จะปฏิเสธแถวเดิมที่ยังเป็น deceased)
UPDATE patients SET status = 'inactive' WHERE status = 'deceased';
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_status_check;
ALTER TABLE patients ADD CONSTRAINT patients_status_check
  CHECK (status IN ('active', 'inactive'));

-- น้ำหนัก/ส่วนสูง อยู่ที่แฟ้มผู้ป่วย (ย้ายมาจากเคส) — เพิ่มด้วย ALTER เพราะตาราง patients ถูกสร้างไปแล้ว
ALTER TABLE patients ADD COLUMN IF NOT EXISTS weight_kg DOUBLE PRECISION CHECK (weight_kg > 0);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS height_cm DOUBLE PRECISION CHECK (height_cm > 0);

-- แยก "แพ้อาหาร" ออกจาก allergies ที่เดิมเก็บรวมกัน — คนละเรื่องกันในทางปฏิบัติ
-- (แพ้ยาเป็นเรื่องของการให้ยา/พยาบาล · แพ้อาหารเป็นเรื่องของการเตรียมอาหาร คนละคนที่ต้องรู้)
-- ข้อมูลเดิมยังอยู่ในช่องแพ้ยาทั้งก้อน แยกอัตโนมัติไม่ได้เพราะเป็นข้อความอิสระ ต้องให้คนมาแยกเอง
ALTER TABLE patients ADD COLUMN IF NOT EXISTS food_allergies TEXT;

-- ---------- เคส (งานดูแลผู้รับบริการหนึ่งราย) ----------
CREATE TABLE IF NOT EXISTS cases (
  case_id       TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  case_type     TEXT NOT NULL CHECK (case_type IN (
                  'elderly_care', 'bedridden_care', 'post_op_care', 'physiotherapy',
                  'wound_care', 'hospital_watch', 'medical_escort', 'other')),

  -- ผู้รับบริการ (โมดูลผู้ป่วยยังไม่มี จึงเก็บไว้ในเคสไปก่อน)
  client_name   TEXT NOT NULL,
  client_phone  TEXT,
  address       TEXT,

  -- วงจรเคส: 'unassigned' = ยังไม่จับคู่พนักงาน, 'assigned' = จับคู่แล้ว/รอเริ่ม,
  -- 'in_progress' = กำลังให้บริการ, 'closed' = ปิดเคส (จบปกติ), 'cancelled' = ยกเลิก
  status        TEXT NOT NULL DEFAULT 'unassigned'
                CHECK (status IN ('unassigned', 'assigned', 'in_progress', 'closed', 'cancelled')),

  -- พนักงานที่รับเคส — อ้างอิงด้วย employee_id ตามหลักของทั้งระบบ
  -- ลบพนักงานถาวรแล้วเคสไม่หายตาม แต่กลับไปเป็น 'ยังไม่จับคู่' ให้หาคนใหม่
  assigned_to   TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
  assigned_at   TEXT,
  started_at    TEXT,   -- เวลาที่กดเริ่มให้บริการจริง (เข้าสถานะ in_progress)
  closed_at     TEXT,
  cancelled_at  TEXT,   -- เวลาที่ยกเลิกเคส
  cancel_reason TEXT,   -- เหตุผลที่ยกเลิก (เช่น ลูกค้าเปลี่ยนใจ, หาพนักงานไม่ได้)

  start_date    TEXT,
  end_date      TEXT,
  note          TEXT,

  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),

  -- กันข้อมูลขัดแย้งกันเองในระดับฐานข้อมูล: สถานะที่ยัง "ทำงานอยู่" ต้องสอดคล้องกับการมีพนักงาน
  -- 'จับคู่แล้ว'/'กำลังให้บริการ' ต้องมีพนักงาน, 'ยังไม่จับคู่' ต้องไม่มี
  -- 'ปิดเคส'/'ยกเลิก' เป็นสถานะปลายทาง เก็บพนักงานเดิมไว้เป็นประวัติได้ (ไม่บังคับ)
  CONSTRAINT case_status_matches_assignee CHECK (
    (status IN ('assigned', 'in_progress') AND assigned_to IS NOT NULL) OR
    (status = 'unassigned' AND assigned_to IS NULL) OR
    (status IN ('closed', 'cancelled'))
  )
);

CREATE INDEX IF NOT EXISTS idx_cases_status      ON cases (status);
CREATE INDEX IF NOT EXISTS idx_cases_assigned_to ON cases (assigned_to);
CREATE INDEX IF NOT EXISTS idx_cases_type        ON cases (case_type);

-- ค่าจ้างที่ได้รับจากเคสนี้ (บาท) — ไม่บังคับกรอก เพราะบางเคสยังตกลงราคาไม่จบตอนเปิดเคส
ALTER TABLE cases ADD COLUMN IF NOT EXISTS fee DOUBLE PRECISION;

-- ลูกค้าที่เคสนี้ให้บริการ — เคส "คัดลอก" ข้อมูลลูกค้ามาเก็บไว้ในตัวเอง (client_name, patient_age ฯลฯ)
-- ไม่ใช่อ่านสดจากตาราง customers เพราะข้อมูลลูกค้าเปลี่ยนได้ แต่เคสที่ปิดไปแล้วต้องคงข้อมูล ณ วันให้บริการไว้
-- ลบลูกค้าแล้วเคสไม่หาย แค่ขาดการเชื่อมโยง (ข้อมูลที่คัดลอกไว้ยังอยู่ครบ)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS customer_id TEXT
  REFERENCES customers (customer_id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_cases_customer ON cases (customer_id);

-- ผู้รับการดูแลของเคสนี้ (แฟ้มถาวรใน patients) — ต่างจาก customer_id ที่เป็น "ผู้ว่าจ้าง"
-- SET NULL แบบเดียวกับ customer_id: ลบแฟ้มผู้ป่วยแล้วเคสไม่หาย ข้อมูลผู้ป่วยที่คัดลอกไว้ในเคสยังอยู่
ALTER TABLE cases ADD COLUMN IF NOT EXISTS patient_id TEXT
  REFERENCES patients (patient_id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS idx_cases_patient ON cases (patient_id);

-- ---------- รายละเอียดผู้ป่วย ----------
-- (client_name = ชื่อผู้ป่วย, client_phone = เบอร์ติดต่อญาติ, address = ที่อยู่สถานที่ดูแล — มีอยู่แล้วด้านบน)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS patient_gender    TEXT CHECK (patient_gender IN ('male', 'female', 'other'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS patient_age       INTEGER CHECK (patient_age BETWEEN 0 AND 130);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS weight_kg         DOUBLE PRECISION CHECK (weight_kg > 0);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS height_cm         DOUBLE PRECISION CHECK (height_cm > 0);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS medical_history   TEXT;  -- โรคประจำตัว
ALTER TABLE cases ADD COLUMN IF NOT EXISTS current_symptoms  TEXT;  -- อาการปัจจุบัน
ALTER TABLE cases ADD COLUMN IF NOT EXISTS medical_devices   TEXT;  -- อุปกรณ์/สายต่างๆ (สายให้อาหาร, สายสวนปัสสาวะ ฯลฯ)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS care_goal         TEXT;  -- จุดประสงค์ของญาติในการดูแล

-- ---------- รายละเอียดการใช้บริการ ----------
-- เก็บเป็นข้อความอิสระ เพราะเป็น "ความสะดวก" ไม่ใช่วันเวลาที่ตายตัว (เช่น "จันทร์-ศุกร์ หลังบ่าย 2")
ALTER TABLE cases ADD COLUMN IF NOT EXISTS service_start_preference TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS nurse_call_preference    TEXT;

-- ---------- ขยายวงจรเคสให้ละเอียดขึ้น: เพิ่ม 'in_progress' (กำลังให้บริการ) และ 'cancelled' (ยกเลิก) ----------
-- ตาราง cases ถูกสร้างไปแล้วในฐานข้อมูลเดิม (CHECK ด้านบนไม่ถูกแตะ) จึงต้อง drop/add constraint ที่นี่
-- คอลัมน์เวลาของสถานะใหม่ — เก็บ ณ ตอนกดเปลี่ยนสถานะ ให้ไล่ประวัติเคสได้
ALTER TABLE cases ADD COLUMN IF NOT EXISTS started_at    TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS cancelled_at  TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_status_check
  CHECK (status IN ('unassigned', 'assigned', 'in_progress', 'closed', 'cancelled'));

ALTER TABLE cases DROP CONSTRAINT IF EXISTS case_status_matches_assignee;
ALTER TABLE cases ADD CONSTRAINT case_status_matches_assignee CHECK (
  (status IN ('assigned', 'in_progress') AND assigned_to IS NOT NULL) OR
  (status = 'unassigned' AND assigned_to IS NULL) OR
  (status IN ('closed', 'cancelled'))
);

-- ---------- วันนัดให้บริการของเคส (ลงตารางว่าจะไปทำงานวันไหนบ้าง) ----------
-- ต่างจาก start_date/end_date ของเคสที่เป็น "ช่วงสัญญา" — ตารางนี้คือ "วันที่ไปจริง" ทีละครั้ง
-- เช่น แพ็คเกจกายภาพบำบัด 10 ครั้ง = จอง 10 แถวในตารางนี้ (คนละวัน)
-- ลบเคสแล้ววันนัดหายตาม (CASCADE) เพราะวันนัดไม่มีความหมายถ้าไม่มีเคส
CREATE TABLE IF NOT EXISTS case_visits (
  visit_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE ON UPDATE CASCADE,
  visit_date TEXT NOT NULL,  -- 'YYYY-MM-DD'

  -- scheduled = นัดไว้, done = ไปมาแล้ว, cancelled = วันนั้นไม่ได้ไป (เก็บไว้เป็นประวัติ ไม่ลบทิ้ง)
  status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
  note       TEXT,

  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_case_visits_case ON case_visits (case_id);
CREATE INDEX IF NOT EXISTS idx_case_visits_date ON case_visits (visit_date);
-- เคยมี unique (case_id, visit_date) ตรงนี้ ("กดวันเดิมซ้ำ = ยกเลิกนัด") — ถูกปลดไปแล้วท้ายไฟล์
-- ตอนขึ้นระบบกะ เพราะวันเดียวมีได้หลายกะ/หลายคน จึงลบคำสั่งสร้างทิ้ง ไม่ใช่แค่ DROP ทีหลัง
-- ไม่งั้นรันซ้ำรอบถัดไปจะสร้าง index กลับมาบนข้อมูลที่มีวันซ้ำแล้ว แล้วล้มทั้งไฟล์ (23505)

-- ---------- ข้อมูลสำหรับออกบิล (เก็บที่ลูกค้า = ผู้จ่ายเงิน) ----------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id          TEXT;  -- เลขผู้เสียภาษี (นิติบุคคล 13 หลัก)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms   TEXT;  -- เช่น 'เงินสด', 'เครดิต 30 วัน' — ใช้คิดวันครบกำหนด
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_address TEXT;  -- ที่อยู่ออกใบเสร็จ ว่าง = ใช้ที่อยู่หลัก

-- ---------- ใบแจ้งหนี้ (1 เคส = 1 ใบ) ----------
-- ธุรกิจไม่ได้จด VAT จึงไม่มีช่องภาษี — มีแค่ ยอดก่อนลด → ส่วนลด → ยอดสุทธิ
--
-- ทุกช่องที่ขึ้นต้นด้วย bill_to_* กับ service_description/amount เป็น "สำเนา ณ วันออกใบ"
-- ไม่ใช่การอ่านสดจากลูกค้า/เคส เพราะใบที่ส่งให้ลูกค้าไปแล้วต้องไม่เปลี่ยนตามข้อมูลต้นทางที่ถูกแก้ทีหลัง
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id      TEXT PRIMARY KEY,          -- INV-0001

  -- ลบเคส/ลูกค้าแล้วใบแจ้งหนี้ต้องไม่หาย (เป็นเอกสารการเงิน) — ข้อมูลที่คัดลอกไว้ยังอยู่ครบ
  case_id         TEXT REFERENCES cases (case_id)         ON DELETE SET NULL ON UPDATE CASCADE,
  customer_id     TEXT REFERENCES customers (customer_id) ON DELETE SET NULL ON UPDATE CASCADE,

  issue_date      TEXT NOT NULL,             -- 'YYYY-MM-DD'
  due_date        TEXT,                      -- ว่าง = ไม่กำหนด (จ่ายทันที)
  paid_at         TEXT,

  -- draft = ร่าง แก้ได้/ลบได้ · issued = ออกใบแล้ว ส่งให้ลูกค้าแล้ว · paid = ชำระแล้ว · cancelled = ยกเลิก
  -- "เกินกำหนด" ไม่เก็บเป็นสถานะ เพราะคำนวณจาก issued + วันครบกำหนดที่ผ่านมาแล้วได้ตอนอ่าน
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'issued', 'paid', 'cancelled')),

  -- สำเนาผู้จ่าย ณ วันออกใบ
  bill_to_name    TEXT NOT NULL,
  bill_to_tax_id  TEXT,
  bill_to_address TEXT,

  -- สำเนารายการบริการและราคา ณ วันออกใบ
  service_description TEXT NOT NULL,
  amount          DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (amount >= 0),   -- ยอดก่อนลด
  discount        DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total           DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (total >= 0),    -- ยอดสุทธิที่ต้องจ่าย

  payment_method  TEXT,
  note            TEXT,

  created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- พนักงานที่ทำธุรกรรม — เก็บทั้งรหัส (ไว้ทำรายงาน) และชื่อ ณ ตอนนั้น (ไว้พิมพ์ลงเอกสาร)
-- ต้องเก็บชื่อไว้ด้วย ไม่อ่านสดจากตารางพนักงาน เพราะใบที่ออกไปแล้วต้องคงชื่อผู้ทำรายการเดิม
-- แม้พนักงานจะเปลี่ยนชื่อหรือลาออกไปแล้ว (และคนอื่นมาเปิดพิมพ์ทีหลังก็ต้องไม่ขึ้นชื่อตัวเอง)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_by      TEXT
  REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_by_name TEXT;
-- ผู้รับชำระเงิน (อาจเป็นคนละคนกับผู้ออกใบ) — ใช้เป็นผู้ลงนามบนใบเสร็จ
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_by        TEXT
  REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_by_name   TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_case     ON invoices (case_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_issued   ON invoices (issue_date);

-- OTP สำหรับรีเซ็ตรหัสผ่าน — เก็บเป็น hash เหมือนรหัสผ่าน คนที่อ่าน DB ได้ก็เอาไปใช้ไม่ได้
CREATE TABLE IF NOT EXISTS password_reset_otps (
  otp_id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees (employee_id) ON DELETE CASCADE ON UPDATE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otps_employee ON password_reset_otps (employee_id, used_at);

-- ---------- แพ็คเกจบริการ (โมเดลตารางเรท: เกรด × รูปแบบบริการ × ระดับพนักงาน CG/NA/PN) ----------
-- เลิกใช้โมเดลเดิม (packages: ชื่อ+ราคา+ส่วนลด) แล้ว — ลบทิ้งพร้อมคอลัมน์อ้างอิงในตาราง cases
-- DROP ตรงนี้ทำงานเฉพาะฐานข้อมูลเดิมที่เคยมีของเก่า (ฐานใหม่ไม่มีอยู่แล้ว IF EXISTS จึงเงียบ)
ALTER TABLE cases DROP COLUMN IF EXISTS package_id;
DROP TABLE IF EXISTS packages;

-- เกรดการดูแล (ระดับความยากของเคส) — เช่น เกรด 1 ผู้สูงอายุทั่วไป, เกรด 2 NG tube/ดูดเสมหะ, เกรด 3 ติดเตียง
CREATE TABLE IF NOT EXISTS pkg_grades (
  grade_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- รูปแบบบริการ — เช่น 'รายวัน 12 ชม.', 'รายเดือน 24 ชม. ไม่มีวันหยุด'
-- category ใช้จัดกลุ่มแสดงผล; graded=false = เรทเดียวใช้ร่วมทุกเกรด (รายวัน/สัปดาห์), true = แยกราคาตามเกรด (รายเดือน)
CREATE TABLE IF NOT EXISTS pkg_service_formats (
  format_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'monthly' CHECK (category IN ('daily', 'weekly', 'monthly')),
  graded      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- ราคาแต่ละช่องของตาราง: (รูปแบบ, เกรด, ระดับพนักงาน) -> ค่าบริการ + ค่าตอบแทน
-- grade_id = NULL สำหรับรูปแบบที่ไม่อิงเกรด (รายวัน/สัปดาห์) — เรทเดียวใช้ทุกเกรด
-- available=false = ช่องที่ให้บริการระดับนี้ไม่ได้ (ช่องเทาในตาราง เช่น CG ทำเคสติดเตียงไม่ได้)
-- ส่วนต่าง% = (customer_price - staff_pay)/customer_price*100 คำนวณตอนอ่าน ไม่เก็บซ้ำ
CREATE TABLE IF NOT EXISTS pkg_rates (
  rate_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  format_id      INTEGER NOT NULL REFERENCES pkg_service_formats (format_id) ON DELETE CASCADE,
  grade_id       INTEGER REFERENCES pkg_grades (grade_id) ON DELETE CASCADE,
  staff_tier     TEXT NOT NULL CHECK (staff_tier IN ('CG', 'NA', 'PN', 'RN')),
  customer_price DOUBLE PRECISION CHECK (customer_price >= 0),
  staff_pay      DOUBLE PRECISION CHECK (staff_pay >= 0),
  available      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- หนึ่งช่องต่อหนึ่ง (รูปแบบ, เกรด, ระดับ) — แยก 2 index เพราะ NULL ใน UNIQUE ปกติไม่ชนกัน
CREATE UNIQUE INDEX IF NOT EXISTS idx_rates_graded
  ON pkg_rates (format_id, grade_id, staff_tier) WHERE grade_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rates_ungraded
  ON pkg_rates (format_id, staff_tier) WHERE grade_id IS NULL;

-- เคสอ้างอิงเรทที่เลือก: เกรด + รูปแบบ + ระดับพนักงาน — ค่าบริการถูก "คัดลอก" เป็น fee ตอนเปิดเคส
-- ลบเกรด/รูปแบบแล้วเคสไม่หาย แค่ขาดการเชื่อมโยง (fee ที่คัดลอกไว้ยังอยู่)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pkg_grade_id  INTEGER REFERENCES pkg_grades (grade_id) ON DELETE SET NULL;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pkg_format_id INTEGER REFERENCES pkg_service_formats (format_id) ON DELETE SET NULL;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pkg_staff_tier TEXT CHECK (pkg_staff_tier IN ('CG', 'NA', 'PN', 'RN'));

-- ---------- เพิ่มระดับพนักงาน RN (พยาบาลวิชาชีพ) เป็นระดับที่ 4 ต่อจาก CG/NA/PN ----------
-- ตาราง pkg_rates และคอลัมน์ cases.pkg_staff_tier ถูกสร้างไปแล้วบนฐานเดิม (CHECK inline ด้านบนจึงไม่ถูกแตะ)
-- ต้อง drop/add constraint ตรงนี้ เหมือนที่ทำกับ position/status/case_type ก่อนหน้า
ALTER TABLE pkg_rates DROP CONSTRAINT IF EXISTS pkg_rates_staff_tier_check;
ALTER TABLE pkg_rates ADD CONSTRAINT pkg_rates_staff_tier_check
  CHECK (staff_tier IN ('CG', 'NA', 'PN', 'RN'));

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_pkg_staff_tier_check;
ALTER TABLE cases ADD CONSTRAINT cases_pkg_staff_tier_check
  CHECK (pkg_staff_tier IN ('CG', 'NA', 'PN', 'RN'));

-- ---------- แพ็คเกจกายภาพบำบัด (โมเดลคนละแบบกับ Homecare) ----------
-- Homecare = ตารางเรท (เกรด × รูปแบบ × ระดับพนักงาน) คิดเป็นรายวัน/เดือน
-- กายภาพ  = แพ็คเกจเหมาจำนวนครั้ง ซื้อยกแพ็ค มีราคาเดิมขีดฆ่า + ราคาโปรโมชัน
-- ตกเฉลี่ย (บาท/ครั้ง) = special_price / sessions คำนวณตอนอ่าน ไม่เก็บซ้ำ (กันตัวเลขขัดกันเอง)
CREATE TABLE IF NOT EXISTS physio_packages (
  physio_package_id SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  -- จำนวนครั้งที่ใช้บริการได้ในแพ็คเกจ — ต้องมากกว่า 0 เพราะเป็นตัวหารของ "ตกเฉลี่ย"
  sessions          INTEGER NOT NULL CHECK (sessions > 0),
  -- ระยะเวลาที่ใช้สิทธิ์ได้ (เดือน) — ว่างได้ เช่น แพ็คทดลองครั้งเดียวไม่มีกำหนด
  duration_months   INTEGER CHECK (duration_months > 0),
  -- ราคาเต็มก่อนลด (ตัวขีดฆ่า) — ว่างได้ ถ้าแพ็คนั้นไม่ได้ตั้งเป็นโปรโมชัน
  original_price    DOUBLE PRECISION CHECK (original_price >= 0),
  special_price     DOUBLE PRECISION NOT NULL CHECK (special_price >= 0),
  -- ปิดขายชั่วคราวโดยไม่ต้องลบทิ้ง (ลบแล้วประวัติราคาหาย)
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  note              TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at        TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- ---------- ส่วนลดของแพ็คเกจ (ทั้งสองสายใช้กติกาเดียวกัน) ----------
-- กรอกได้ทั้งเป็น % หรือเป็นจำนวนเงิน — ถ้ากรอก % ไว้จะใช้ % ก่อน (กันกรณีเผลอกรอกทั้งคู่)
-- เก็บ "ค่าที่ผู้ใช้กรอก" เท่านั้น ส่วน "ราคาสุทธิ" คำนวณตอนอ่าน ไม่เก็บซ้ำ จะได้ไม่มีวันขัดกับราคาจริง
ALTER TABLE pkg_rates ADD COLUMN IF NOT EXISTS discount_percent DOUBLE PRECISION
  CHECK (discount_percent >= 0 AND discount_percent <= 100);
ALTER TABLE pkg_rates ADD COLUMN IF NOT EXISTS discount_amount  DOUBLE PRECISION
  CHECK (discount_amount >= 0);

-- กายภาพบำบัดเก็บส่วนลดที่กรอกไว้ด้วย เพื่อให้เปิดฟอร์มแก้ทีหลังแล้วยังเห็นว่าเคยตั้งไว้กี่ %
-- (special_price ยังเป็นราคาสุทธิที่ใช้จริงเหมือนเดิม — เคสคัดลอกค่านี้ไปเป็นค่าจ้าง)
ALTER TABLE physio_packages ADD COLUMN IF NOT EXISTS discount_percent DOUBLE PRECISION
  CHECK (discount_percent >= 0 AND discount_percent <= 100);
ALTER TABLE physio_packages ADD COLUMN IF NOT EXISTS discount_amount  DOUBLE PRECISION
  CHECK (discount_amount >= 0);

-- เคสเลือกบริการได้สองสาย: Homecare (ตารางเรท เกรด×รูปแบบ×ระดับ) หรือ กายภาพ (แพ็คเกจเหมาครั้ง)
-- service_kind บอกว่าเคสใช้สายไหน — เคสเก่าที่เปิดก่อนมีระบบนี้เป็น NULL (ยังอ่านเรท Homecare เดิมได้ตามปกติ)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS service_kind TEXT CHECK (service_kind IN ('homecare', 'physio'));
-- ลบแพ็คเกจกายภาพบำบัดแล้วเคสไม่หาย แค่ขาดการเชื่อมโยง (fee ที่คัดลอกไว้ตอนเปิดเคสยังอยู่) — แบบเดียวกับ pkg_format_id
ALTER TABLE cases ADD COLUMN IF NOT EXISTS physio_package_id INTEGER
  REFERENCES physio_packages (physio_package_id) ON DELETE SET NULL;

-- เคสที่เปิดไว้ก่อนมีสองสาย แต่เลือกเรท Homecare ไว้แล้ว = เป็นเคส Homecare อยู่แล้วโดยพฤตินัย
-- ไม่เติมให้ ฟอร์มแก้ไขจะซ่อนชุด dropdown ของ Homecare แล้วเรทที่เลือกไว้จะหายไปจากสายตา
-- แตะเฉพาะแถวที่ยังว่างและมีรูปแบบบริการอยู่จริง — เคสที่ไม่ได้ระบุบริการเลยยังคงเป็น NULL ตามเดิม
UPDATE cases SET service_kind = 'homecare' WHERE service_kind IS NULL AND pkg_format_id IS NOT NULL;

-- ---------- รูปพนักงาน (รูปติดบัตร — คนละคนละรูปเดียว) ----------
-- เก็บไบนารีไว้ใน DB เหมือนรูปใบรับรอง/ผลงาน ไม่ต้องพึ่งบริการเก็บไฟล์ภายนอก
-- เป็นคอลัมน์ของ employees ไม่ใช่ตารางแยก เพราะหนึ่งคนมีได้รูปเดียว (เปลี่ยนรูป = ทับของเดิม)
-- ฝั่งเบราว์เซอร์ย่อรูปก่อนส่ง (ด้านยาวสุด 1600px, JPEG) ไฟล์จริงจึงเหลือราว 100–300 KB
ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_data BYTEA;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_mime TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_size INTEGER;

-- ตัวนับรหัสพนักงาน: กันเลขซ้ำแม้จะมีการลบพนักงานออกไปแล้ว
CREATE TABLE IF NOT EXISTS id_counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- ระบบเช็คอินพนักงานภาคสนาม (homecare) — พนักงานไปทำงานที่บ้านผู้ป่วยตามวันนัด
-- ยกระดับ case_visits จาก "วันนัด" เป็น "กะงาน": แต่ละแถว = งาน 1 กะ ของพนักงาน 1 คน
-- เก็บทั้งแผน (ใครไป/เวลานัด) และของจริง (เช็คอิน/เอาท์ พิกัด รูป) ไว้บนแถวเดียวกัน
-- ============================================================================

-- ---------- พิกัดสถานที่ดูแล (สำหรับ geofence) ----------
-- snapshot ลงเคสเหมือน client_name/address — ตั้งจากหน้าจัดการเคส (geocode ที่อยู่ หรือปักหมุด)
-- ว่างได้ = ยังไม่ตั้งพิกัด เทียบระยะไม่ได้ (ตอนเช็คอินยังเก็บพิกัดดิบไว้ แต่ไม่ flag)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS geo_lng DOUBLE PRECISION;
-- รัศมี geofence เฉพาะเคส (เมตร) — ว่าง = ใช้ค่าปริยายของระบบ (เช่น บ้านในหมู่บ้านกว้างตั้งให้ใหญ่ขึ้นได้)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS geofence_radius_m INTEGER CHECK (geofence_radius_m > 0);

-- ---------- case_visits: แผนของกะ (ใครไป + เวลานัด) ----------
-- assigned_to = พนักงานที่นัดให้ไปกะนี้ — การมอบงานจริงย้ายมาที่ระดับกะ รองรับหลายคน/หลายกะต่อเคสต่อวัน
-- (cases.assigned_to เดิมยังอยู่ = "ผู้รับผิดชอบหลัก" ของเคส)
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS assigned_to TEXT
  REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
-- เวลานัดเริ่ม/เลิก เก็บ 'HH:MM' (ว่างได้ = ไม่กำหนดเวลา) — ใช้แยกกะ + คำนวณเข้างานเร็ว/สายตอนอ่าน
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS planned_start TEXT;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS planned_end   TEXT;

-- วันนัดเดิม (ก่อนมีระบบกะ) ยังไม่มีเจ้าของกะ — เติมด้วยพนักงานที่รับเคสนั้นอยู่
-- แตะเฉพาะแถวที่ assigned_to ว่าง และเคสมีคนรับ ไม่งั้นวันนัดเก่าจะไม่โผล่ในตารางงานของใครเลย
UPDATE case_visits v SET assigned_to = c.assigned_to
  FROM cases c
  WHERE v.case_id = c.case_id AND v.assigned_to IS NULL AND c.assigned_to IS NOT NULL;

-- ---------- case_visits: การไปจริง (actual) ----------
-- checked_in_by = คนที่กดเช็คอินจริง (snapshot) — แยกจาก assigned_to เผื่อสลับคนแล้วคนอื่นไปแทน
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS checked_in_by TEXT
  REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
-- เวลาเป็น TIMESTAMPTZ (ไม่ใช่ TEXT เหมือน created_at) เพราะต้องเอาไปลบกันหาชั่วโมง + ถูกเรื่อง timezone
-- ตั้งจาก now() ของ server เท่านั้น ไม่เชื่อเวลาเครื่องพนักงาน (กันปลอมเวลา)
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_at         TIMESTAMPTZ;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_lat        DOUBLE PRECISION;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_lng        DOUBLE PRECISION;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_accuracy_m DOUBLE PRECISION;  -- accuracy ที่ GPS เครื่องรายงาน (เมตร)
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_distance_m INTEGER;  -- ระยะจากพิกัดเคส (snapshot; null ถ้าเคสไม่มีพิกัด)
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_out_at        TIMESTAMPTZ;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_out_lat       DOUBLE PRECISION;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_out_lng       DOUBLE PRECISION;
-- true = อยู่นอก geofence / พิกัดน่าสงสัย → เข้ารายการให้ admin ตรวจ (ไม่บล็อกการเช็คอิน)
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS location_flagged    BOOLEAN NOT NULL DEFAULT FALSE;
-- admin แก้เวลา/ปิดกะให้ (ลืมเช็คเอาท์/GPS พัง) — เก็บว่าใครแก้ ไว้ตรวจสอบย้อนหลัง
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS adjusted_by TEXT
  REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- รูปเซลฟี่ตอนเช็คอิน (ไม่บังคับ) ----------
-- หลักฐานว่าคนไปจริง (กัน GPS ปลอม) — เก็บ BYTEA ใน DB เหมือนรูปพนักงาน/ใบรับรอง เบราว์เซอร์ย่อก่อนส่ง
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_photo_data BYTEA;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_photo_mime TEXT;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_photo_size INTEGER;

-- ============================================================================
-- ค่าจ้างพนักงานของเคส — ตัวตั้งของ "สรุปค่าตอบแทน" ที่พนักงานเห็น
--
-- คัดลอกจากแพ็คเกจ/เรทตอนเปิดเคส แบบเดียวกับ fee (ค่าบริการฝั่งลูกค้า)
-- ต้อง snapshot ไม่ใช่อ่านสด เพราะเป็นตัวเลขที่พนักงานเห็นเป็น "รายได้ของตัวเอง"
-- ถ้าอ่านสดจากตารางเรท วันหนึ่งที่ปรับราคา ยอดของเดือนที่ผ่านไปแล้วจะขยับตาม
-- ============================================================================
ALTER TABLE cases ADD COLUMN IF NOT EXISTS staff_pay DOUBLE PRECISION CHECK (staff_pay >= 0);

-- แพ็คเกจกายภาพบำบัดไม่เคยมีช่องค่าจ้าง — เคสสายนี้จึงคำนวณค่าตอบแทนไม่ได้เลย
-- เพิ่มให้เป็นคู่กับ special_price (ราคาที่ลูกค้าจ่าย) เหมือน pkg_rates ที่มี customer_price คู่กับ staff_pay
ALTER TABLE physio_packages ADD COLUMN IF NOT EXISTS staff_pay DOUBLE PRECISION CHECK (staff_pay >= 0);

-- เคสเดิมที่เปิดก่อนมีคอลัมน์นี้ — เติมจากเรท/แพ็คเกจที่เคสอ้างอิงอยู่ (เท่าที่ยังหาเจอ)
-- แตะเฉพาะแถวที่ยังว่าง เคสที่กรอกค่าจ้างเองไว้แล้วไม่ถูกทับ
-- รันซ้ำได้เรื่อยๆ: ตั้งค่าจ้างในตารางเรท/แพ็คเกจทีหลังแล้วรันอีกครั้ง เคสที่ยังว่างจะได้ค่าไปด้วย
UPDATE cases c SET staff_pay = r.staff_pay
  FROM pkg_rates r
  WHERE c.staff_pay IS NULL
    AND r.format_id = c.pkg_format_id
    AND r.grade_id IS NOT DISTINCT FROM c.pkg_grade_id
    AND r.staff_tier = c.pkg_staff_tier
    AND r.staff_pay IS NOT NULL;

-- สายกายภาพบำบัดคิดค่าจ้างต่อแพ็คเกจ ไม่มีเรท/ระดับพนักงาน จึงต้องเติมแยกอีกชุด
UPDATE cases c SET staff_pay = pp.staff_pay
  FROM physio_packages pp
  WHERE c.staff_pay IS NULL
    AND pp.physio_package_id = c.physio_package_id
    AND pp.staff_pay IS NOT NULL;

-- ค้นเคสที่ปิดแล้วของพนักงานคนหนึ่ง (หน้าสรุปค่าตอบแทน) — ดึงด้วย (assigned_to, status)
CREATE INDEX IF NOT EXISTS idx_cases_assignee_status ON cases (assigned_to, status);

-- ---------- index ----------
-- ตารางงานพนักงาน: "กะของฉันในวันที่..." ดึงด้วย (assigned_to, visit_date)
CREATE INDEX IF NOT EXISTS idx_case_visits_assignee ON case_visits (assigned_to, visit_date);
-- ปลด unique เดิม (case_id, visit_date) — วันเดียวมีได้หลายกะ/หลายคน (addVisit เลิกใช้ ON CONFLICT แล้ว)
-- index ค้นตามวัน (idx_case_visits_date) ยังอยู่ ปฏิทินจึงยังเร็วเหมือนเดิม
DROP INDEX IF EXISTS idx_case_visits_unique;

-- ============================================================================
-- ค่าตอบแทนย้ายมาคิดที่ "กะที่ทำจริง" แทน "เคสที่ปิด"
--
-- ของเดิมรวมยอดจาก cases.staff_pay ของเคสที่ปิดในเดือนนั้น โดยจ่ายให้ cases.assigned_to
-- ซึ่งผิดสองทาง: (1) เปลี่ยนผู้รับผิดชอบกลางคัน คนเดิมที่ไปทำจริงได้ศูนย์ ยอดทั้งก้อนตกกับคนที่ถืออยู่ตอนปิด
-- (2) เคสที่ลากข้ามเดือน เงินไปกองในเดือนที่ปิด ไม่ใช่เดือนที่ลงแรง
--
-- ของใหม่: ยอดของกะ = staff_pay ของกะเอง ถ้าไม่ได้ตั้งไว้ก็เกลี่ยจากยอดเคสหารจำนวนกะที่นัดไว้
-- (ไม่รวมกะที่ยกเลิก) แล้วนับให้ "คนที่เช็คอินจริง" ใน "เดือนที่เช็คอิน"
-- เคส 1 ใบ = แพ็คเกจ 1 ชุด ยอดรวมทุกกะจึงเท่ากับ cases.staff_pay เท่าเดิม แค่กระจายถูกคน/ถูกเดือน
-- ============================================================================
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS staff_pay DOUBLE PRECISION CHECK (staff_pay >= 0);

-- ดึงกะของคนที่เช็คอินตามเดือน (สรุปค่าตอบแทน) — ของเดิมมีแต่ index ตาม assigned_to
CREATE INDEX IF NOT EXISTS idx_case_visits_checkin ON case_visits (checked_in_by, check_in_at);

-- ============================================================================
-- ประวัติการทำรายการของเคส (audit log)
--
-- คอลัมน์เวลาบนตาราง cases (assigned_at/closed_at/...) เก็บได้แค่ "ครั้งล่าสุด" และไม่บอกว่าใครกด
-- สลับพนักงาน 3 รอบแล้วปิดเคส เหลือร่องรอยแค่รอบสุดท้าย — ธุรกิจดูแลผู้ป่วยมีข้อพิพาทได้
-- (ญาติแจ้งว่าไม่มีคนมา / ใครสั่งเปลี่ยนคนดูแล / ใครยกเลิกเคส) จึงต้องมีบันทึกทีละครั้ง
--
-- actor_name เก็บชื่อ ณ ตอนนั้นคู่กับรหัส แบบเดียวกับ issued_by_name ของใบแจ้งหนี้:
-- คนทำรายการอาจเปลี่ยนชื่อหรือถูกลบทีหลัง ประวัติต้องยังอ่านได้ว่าตอนนั้นใครทำ
-- ============================================================================
CREATE TABLE IF NOT EXISTS case_events (
  event_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE ON UPDATE CASCADE,

  -- created · edited · assigned · unassigned · started · closed · cancelled · reopened
  event      TEXT NOT NULL,
  detail     TEXT,   -- ข้อความอ่านออก เช่น 'มอบหมายให้ สมชาย ใจดี (EMP-0003)'

  actor_id   TEXT REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE,
  actor_name TEXT,

  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events (case_id, event_id);

-- ============================================================================
-- เช็คอินให้ตรงกับ "แผน" ไม่ใช่แค่ตรงกับ "สถานที่"
--
-- ของเดิมเช็คแค่ว่าเป็นกะของตัวเองและยังไม่เคยเช็คอิน — กะของอาทิตย์หน้าจึงกดได้ตั้งแต่วันนี้
-- และไม่มีอะไรบอกว่ามาช้ากว่าเวลานัดแค่ไหน ทั้งที่ planned_start ถูกกรอกไว้อยู่แล้ว
--
-- ของใหม่: กะในอนาคตกดไม่ได้เลย (กันที่ route) · กะของวันที่ผ่านมาแล้วยังกดได้แต่ติดธง off_schedule
-- (พนักงานลืมกดตอนอยู่หน้างานเป็นเรื่องที่เกิดจริง ปิดทางเลยจะได้ข้อมูลที่ขาดไปเฉยๆ)
-- ============================================================================
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS check_in_late_minutes INTEGER;
ALTER TABLE case_visits ADD COLUMN IF NOT EXISTS off_schedule BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================================
-- รายการย่อยบนใบแจ้งหนี้ (ไม่บังคับต้องมี)
--
-- ใบส่วนใหญ่เป็น "แพ็คเกจ 1 ชุด = 1 บรรทัด" ซึ่งไม่ต้องใช้ตารางนี้เลย (items ว่าง = พิมพ์บรรทัดเดียวเหมือนเดิม)
-- แต่เคสที่ตกลงกันเป็นรายครั้ง ลูกค้าอยากเห็นว่าไปวันไหนบ้าง กี่ครั้ง ครั้งละเท่าไหร่
-- ของเดิมต้องพิมพ์ลงช่อง service_description เอาเองทุกใบ
--
-- เป็นสำเนา ณ วันออกใบเหมือนช่อง bill_to_* — ไม่ผูกกับ case_visits ด้วย FK
-- ลบกะทิ้งทีหลังแล้วใบที่ส่งลูกค้าไปแล้วต้องไม่เปลี่ยนตาม
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_items (
  item_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices (invoice_id) ON DELETE CASCADE ON UPDATE CASCADE,
  seq         INTEGER NOT NULL,           -- ลำดับบนใบ (1, 2, 3, …)
  description TEXT NOT NULL,
  quantity    DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit_price  DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  amount      DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (amount >= 0),
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id, seq);
