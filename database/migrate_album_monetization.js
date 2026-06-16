import pool from './connection.js';

async function migrateAlbumMonetization() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('🔄 Migration album monetization...');

    const [columns] = await connection.query('SHOW COLUMNS FROM albums');
    const columnNames = new Set(columns.map((c) => c.Field));

    if (!columnNames.has('is_paid_release')) {
      await connection.query('ALTER TABLE albums ADD COLUMN is_paid_release BOOLEAN DEFAULT FALSE AFTER is_popular');
      console.log('✅ Added albums.is_paid_release');
    }
    if (!columnNames.has('paid_price_usd')) {
      await connection.query('ALTER TABLE albums ADD COLUMN paid_price_usd DECIMAL(5,2) NULL AFTER is_paid_release');
      console.log('✅ Added albums.paid_price_usd');
    }
    if (!columnNames.has('paid_window_days')) {
      await connection.query('ALTER TABLE albums ADD COLUMN paid_window_days INT DEFAULT 14 AFTER paid_price_usd');
      console.log('✅ Added albums.paid_window_days');
    }
    if (!columnNames.has('is_preorder_enabled')) {
      await connection.query('ALTER TABLE albums ADD COLUMN is_preorder_enabled BOOLEAN DEFAULT FALSE AFTER paid_window_days');
      console.log('✅ Added albums.is_preorder_enabled');
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS album_purchases (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        album_id VARCHAR(36) NOT NULL,
        price_usd DECIMAL(5,2) NOT NULL,
        purchase_type ENUM('purchase', 'preorder') DEFAULT 'purchase',
        purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        UNIQUE KEY unique_album_purchase (user_id, album_id),
        INDEX idx_album (album_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Ensured album_purchases table');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS album_preorders (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        album_id VARCHAR(36) NOT NULL,
        price_usd DECIMAL(5,2) NOT NULL,
        status ENUM('active', 'converted', 'canceled') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        UNIQUE KEY unique_album_preorder (user_id, album_id),
        INDEX idx_album (album_id),
        INDEX idx_user (user_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Ensured album_preorders table');

    console.log('✅ Album monetization migration completed');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

migrateAlbumMonetization();
