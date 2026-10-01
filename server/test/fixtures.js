import { readFile } from 'node:fs/promises';

export async function seedFixtures(pool, hashPassword) {
  await pool.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  const password = await hashPassword('Fixture-password-123!');
  for (const [id, position, mustChange, status] of [
    ['EMP-0001', 'manager', false, 'active'],
    ['EMP-0007', 'hr', false, 'active'],
    ['EMP-0003', 'caregiver', false, 'active'],
    ['EMP-0004', 'caregiver', true, 'active'],
    ['EMP-0005', 'caregiver', false, 'suspended'],
  ]) {
    await pool.query(
      `INSERT INTO employees (employee_id,first_name,last_name,position,email,status,password_hash,must_change_password)
       VALUES ($1,'Test','Employee',$2,$1 || '@example.invalid',$4,$5,$3)`,
      [id, position, mustChange, status, password],
    );
  }
  const format = (await pool.query(`INSERT INTO pkg_service_formats (name,category,graded) VALUES ('Test daily','daily',false) RETURNING format_id`)).rows[0];
  await pool.query(`INSERT INTO pkg_rates (format_id,staff_tier,customer_price,staff_pay) VALUES ($1,'CG',2000,1200)`, [format.format_id]);
  await pool.query(`INSERT INTO physio_packages (name,sessions,special_price,staff_pay) VALUES ('Test therapy',1,1500,900)`);
  await pool.query(`INSERT INTO cases (case_id,title,case_type,client_name,status,assigned_to,fee,staff_pay)
                   VALUES ('CASE-FIXTURE','Fixture case','other','Test patient','assigned','EMP-0003',2000,1200)`);
  await pool.query(`INSERT INTO case_visits (case_id,visit_date,assigned_to,status,checked_in_by,check_in_at,check_out_at,pay_status)
                   VALUES ('CASE-FIXTURE',to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD'),'EMP-0003','done',
                           'EMP-0003',now() - interval '2 hours',now() - interval '1 hour','approved')`);
}
