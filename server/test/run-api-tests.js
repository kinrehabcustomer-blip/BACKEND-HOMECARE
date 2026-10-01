// Always provision a disposable local cluster. Never inherit DATABASE_URL from
// the shell or load .env here: integration tests are allowed to write fixtures.
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const root = resolve(tmpdir());
const directory = await mkdtemp(join(root, 'kin-api-test-'));
const password = randomBytes(24).toString('hex');
const logs = [];
const postgres = new EmbeddedPostgres({
  databaseDir: join(directory, 'data'), port, user: 'postgres', password,
  persistent: true,
  initdbFlags: ['--encoding=UTF8'],
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: (message) => logs.push(String(message)),
  onError: (message) => logs.push(String(message)),
});
let started = false;
try {
  await postgres.initialise();
  await postgres.start();
  started = true;
  await postgres.createDatabase('kin_api_test');
  console.log('API tests: disposable local PostgreSQL (fresh fixtures, no production connection)');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/api.test.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'test', RUN_DB_TESTS: '1',
        DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/kin_api_test?sslmode=disable`,
        JWT_SECRET: randomBytes(48).toString('hex'),
      },
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} catch (error) {
  console.error(logs.slice(-15).join('\n'));
  console.error(error);
  process.exitCode = 1;
} finally {
  if (started) await postgres.stop();
  // Validate the exact mkdtemp result before deleting the temporary cluster.
  const childPath = relative(root, resolve(directory));
  if (!childPath.startsWith('kin-api-test-') || childPath.includes('..') || childPath.includes('/') || childPath.includes('\\')) {
    throw new Error('Refusing to remove a directory outside the test temp root');
  }
  await rm(directory, { recursive: true, force: true });
}
// embedded-postgres registers a beforeExit hook that otherwise exits with 0.
// Preserve the test runner's status after the cluster has been shut down.
process.exit(process.exitCode ?? 0);
