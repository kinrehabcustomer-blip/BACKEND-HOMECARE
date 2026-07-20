import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// สคริปต์ของ workspace รันโดยมี cwd เป็น server/ แต่ .env อยู่ที่ root ของ repo
// จึงชี้ path ตรงจากตำแหน่งไฟล์นี้ แทนที่จะพึ่ง cwd แบบ `import 'dotenv/config'`
config({ path: join(here, '../../../.env') });
config({ path: join(here, '../../.env') }); // server/.env ถ้ามี (ตัวแรกที่เจอชนะ — dotenv ไม่ทับค่าเดิม)
