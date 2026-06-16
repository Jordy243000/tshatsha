import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const sql = `
CREATE TABLE IF NOT EXISTS ads_config (
  audio_url VARCHAR(700) NOT NULL PRIMARY KEY,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ads_enabled_order (is_enabled, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_play_events (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  audio_url TEXT NOT NULL,
  user_id VARCHAR(36) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_plays_created (created_at),
  INDEX idx_ad_plays_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'TshaTshaStream_db',
    multipleStatements: true,
  });

  try {
    await connection.query(sql);
    console.log('✅ Migration ads_management OK (ads_config, ad_play_events)');
  } catch (e) {
    console.error('❌ Migration ads_management:', e.message);
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
}

migrate();
