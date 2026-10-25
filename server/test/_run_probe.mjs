/**
 * ตัวยกฐาน PostgreSQL ชั่วคราวให้สคริปต์ตรวจบัครันบนของจริง
 *   node test/_run_probe.mjs test/_qa_xxx.mjs
 *
 * เหมือน run-api-tests.js ทุกอย่าง ต่างแค่รับชื่อไฟล์เป้าหมายเป็นอาร์กิวเมนต์
 * และรันตรง ๆ (ไม่ใช่ --test) เพื่อให้สคริปต์ตรวจพิมพ์รายงานของตัวเองได้
 * ห้ามอ่าน DATABASE_URL จาก shell หรือ .env — สคริปต์พวกนี้เขียนข้อมูลลงฐาน
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, generateKeyPairSync } from 'node:crypto';

const target = process.argv[2];
if (!target) throw new Error('ต้องบอกไฟล์ที่จะรัน เช่น node test/_run_probe.mjs test/_qa_xxx.mjs');

const probe = createServer();
await new Promise((res, rej) => { probe.once('error', rej); probe.listen(0, '127.0.0.1', res); });
const port = probe.address().port;
await new Promise((res) => probe.close(res));
const root = resolve(tmpdir());
const directory = await mkdtemp(join(root, 'kin-api-test-'));
const password = randomBytes(24).toString('hex');

/* กุญแจคู่ชั่วคราวสำหรับชุดทดสอบสะพาน (integration) — สร้างใหม่ทุกครั้งที่รัน
   ชุดทดสอบต้องเซ็นตั๋วเองเพื่อยิงเส้น /api/integration ซึ่งปกติเซ็นจากฝั่ง chat
   ใช้กุญแจชั่วคราวแทนกุญแจลับตัวจริง — ของจริงไม่ต้องออกจากที่เก็บเลย
   ฝั่ง server อ่าน public key จาก env ได้ (ดู lib/lineBridge.js) ค่าปริยายยังเป็นกุญแจจริงเหมือนเดิม */
const bridge = generateKeyPairSync('ed25519');
const BRIDGE_PUBLIC = bridge.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
const BRIDGE_PRIVATE = bridge.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
const logs = [];
const postgres = new EmbeddedPostgres({
  databaseDir: join(directory, 'data'), port, user: 'postgres', password,
  persistent: true,
  initdbFlags: ['--encoding=UTF8'],
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: (m) => logs.push(String(m)),
  onError: (m) => logs.push(String(m)),
});
let started = false;
try {
  await postgres.initialise();
  await postgres.start();
  started = true;
  await postgres.createDatabase('kin_api_test');
  const code = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [target, ...process.argv.slice(3)], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'test', RUN_DB_TESTS: '1',
        DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/kin_api_test?sslmode=disable`,
        JWT_SECRET: randomBytes(48).toString('hex'),
        STAFF_BRIDGE_PUBLIC_KEY: BRIDGE_PUBLIC,
        STAFF_BRIDGE_PRIVATE_KEY: BRIDGE_PRIVATE,
      },
    });
    child.once('error', rej);
    child.once('exit', (c) => res(c ?? 1));
  });
  process.exitCode = code;
} catch (error) {
  console.error(logs.slice(-15).join('\n'));
  console.error(error);
  process.exitCode = 1;
} finally {
  if (started) await postgres.stop();
  const childPath = relative(root, resolve(directory));
  if (!childPath.startsWith('kin-api-test-') || childPath.includes('..') || childPath.includes('/') || childPath.includes('\\')) {
    throw new Error('Refusing to remove a directory outside the test temp root');
  }
  await rm(directory, { recursive: true, force: true });
}
