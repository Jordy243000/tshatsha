import pool from './connection.js';

async function run() {
  let c;
  try {
    c = await pool.getConnection();
    const [cols] = await c.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'music' AND COLUMN_NAME = 'duration_seconds'
    `);
    if (cols.length > 0) {
      console.log('✅ duration_seconds déjà présent sur music');
      return;
    }
    await c.execute(`
      ALTER TABLE music ADD COLUMN duration_seconds INT UNSIGNED NULL DEFAULT NULL AFTER image_url
    `);
    console.log('✅ Colonne duration_seconds ajoutée à music');
  } finally {
    if (c) c.release();
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
