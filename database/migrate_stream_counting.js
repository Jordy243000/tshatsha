import pool from './connection.js';

async function migrateStreamCounting() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('🔄 Migration stream counting (24h unique)...');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_track_streams (
        user_id VARCHAR(36) NOT NULL,
        track_id VARCHAR(36) NOT NULL,
        last_counted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        total_counted INT NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, track_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES music(id) ON DELETE CASCADE,
        INDEX idx_last_counted (last_counted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✅ Table user_track_streams ready');
    console.log('✅ Migration stream counting completed');
  } catch (error) {
    console.error('❌ Migration stream counting failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

migrateStreamCounting();
