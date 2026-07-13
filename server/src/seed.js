import 'dotenv/config';
import { db } from './db/index.js';
import * as repo from './employees/repo.js';

const SAMPLES = [
  {
    first_name: 'สมหญิง', last_name: 'ใจดี', nickname: 'หญิง', national_id: '1101700201234',
    phone: '081-234-5678', email: 'somying@kin.co.th', gender: 'female', birth_date: '1992-03-14',
    position: 'caregiver', employment_type: 'fulltime', status: 'active',
    hire_date: '2023-01-09', base_salary: 18000,
    emergency_contact_name: 'สมชาย ใจดี', emergency_contact_phone: '089-111-2222',
    certificates: [{ name: 'ผู้ดูแลผู้สูงอายุ 420 ชั่วโมง', issuer: 'กรมอนามัย', issued_date: '2022-11-20' }],
  },
  {
    first_name: 'ปรียา', last_name: 'วงศ์สุวรรณ', nickname: 'ปุ๊ก', national_id: '3102000456789',
    phone: '062-888-1234', email: 'preeya@kin.co.th', gender: 'female', birth_date: '1988-07-02',
    position: 'nurse', employment_type: 'fulltime', status: 'active',
    hire_date: '2021-05-17', base_salary: 32000,
    certificates: [{ name: 'ใบประกอบวิชาชีพการพยาบาล', issuer: 'สภาการพยาบาล', issued_date: '2011-06-01', expiry_date: '2026-06-01' }],
  },
  {
    first_name: 'อนุชา', last_name: 'ศรีสมบัติ', nickname: 'ชา', national_id: '1409900112233',
    phone: '090-555-7788', gender: 'male', birth_date: '1995-12-25',
    position: 'therapist', employment_type: 'parttime', status: 'probation',
    hire_date: '2026-05-01', base_salary: 15000,
  },
  {
    first_name: 'วิภา', last_name: 'ทองมี', nickname: 'แนน', phone: '086-222-3344',
    gender: 'female', position: 'admin', employment_type: 'fulltime', status: 'active',
    hire_date: '2024-08-19', base_salary: 22000,
  },
  {
    first_name: 'ธนกร', last_name: 'พูลสุข', nickname: 'กร', phone: '084-777-9900',
    gender: 'male', position: 'driver', employment_type: 'daily', status: 'on_leave',
    hire_date: '2024-02-01', base_salary: 650,
  },
  {
    first_name: 'มาลี', last_name: 'ดวงแก้ว', nickname: 'ลี', phone: '095-303-1122',
    gender: 'female', position: 'assistant_nurse', employment_type: 'fulltime', status: 'resigned',
    hire_date: '2022-04-04', resign_date: '2026-03-31', base_salary: 20000,
  },
];

const { total } = db.prepare('SELECT COUNT(*) AS total FROM employees').get();
if (total > 0) {
  console.log(`มีพนักงานอยู่แล้ว ${total} คน — ข้ามการ seed (ลบไฟล์ server/data/kin.db ถ้าต้องการเริ่มใหม่)`);
  process.exit(0);
}

for (const { certificates = [], ...employee } of SAMPLES) {
  const created = repo.create(employee);
  for (const cert of certificates) repo.certificates.add(created.employee_id, cert);
  console.log(`เพิ่ม ${created.employee_id}  ${created.first_name} ${created.last_name}`);
}

console.log(`\nseed เสร็จแล้ว: ${SAMPLES.length} คน`);
