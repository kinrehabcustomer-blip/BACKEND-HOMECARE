PRAGMA foreign_keys = ON;

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

  position                TEXT NOT NULL CHECK (position IN ('caregiver', 'nurse', 'assistant_nurse', 'therapist', 'admin', 'driver', 'manager')),
  employment_type         TEXT NOT NULL DEFAULT 'fulltime' CHECK (employment_type IN ('fulltime', 'parttime', 'contract', 'daily')),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'probation', 'on_leave', 'suspended', 'resigned')),

  hire_date               TEXT,
  resign_date             TEXT,
  base_salary             REAL,

  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  note                    TEXT,

  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_employees_status   ON employees (status);
CREATE INDEX IF NOT EXISTS idx_employees_position ON employees (position);
CREATE INDEX IF NOT EXISTS idx_employees_name     ON employees (first_name, last_name);

-- ใบรับรอง / ใบประกอบวิชาชีพ ผูกกับพนักงานผ่าน employee_id
CREATE TABLE IF NOT EXISTS employee_certificates (
  certificate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    TEXT NOT NULL REFERENCES employees (employee_id) ON DELETE CASCADE ON UPDATE CASCADE,
  name           TEXT NOT NULL,
  issuer         TEXT,
  issued_date    TEXT,
  expiry_date    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_certificates_employee ON employee_certificates (employee_id);

-- ตัวนับรหัสพนักงาน: กันเลขซ้ำแม้จะมีการลบพนักงานออกไปแล้ว
CREATE TABLE IF NOT EXISTS id_counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
