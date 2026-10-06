import '../lib/env.js';
import { pool } from './index.js';

try {
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS temp_password_encrypted TEXT`);
  const result = await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'employees'
      AND column_name = 'temp_password_encrypted'`);
  if (result.rowCount !== 1) throw new Error('Temporary password column was not created');
  console.log('Temporary password column is ready');
} finally {
  await pool.end();
}
