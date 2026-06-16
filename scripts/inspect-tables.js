import pool from '../database/connection.js';

const [users] = await pool.execute('SHOW CREATE TABLE users');
console.log('=== users ===');
console.log(users[0]['Create Table']);

for (const table of ['producer_applications', 'distributor_applications', 'artist_applications']) {
  const [exists] = await pool.execute(`SHOW TABLES LIKE '${table}'`);
  console.log(`\n=== ${table} exists: ${exists.length > 0} ===`);
  if (exists.length) {
    const [ddl] = await pool.execute(`SHOW CREATE TABLE ${table}`);
    console.log(ddl[0]['Create Table']);
  }
}

const [cols] = await pool.execute(
  `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users','producer_applications')
   AND COLUMN_NAME IN ('id','user_id')`
);
console.log('\n=== column types ===');
console.table(cols);

process.exit(0);
