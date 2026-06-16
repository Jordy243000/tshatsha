import pool from './connection.js';

async function run() {
  let c;
  try {
    c = await pool.getConnection();

    // lyrics_text: texte simple (1 ligne par phrase/vers)
    const [lyricsTextCols] = await c.execute(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'music' AND COLUMN_NAME = 'lyrics_text'
    `);
    if (lyricsTextCols.length === 0) {
      await c.execute(`
        ALTER TABLE music
        ADD COLUMN lyrics_text TEXT NULL DEFAULT NULL AFTER image_url
      `);
      console.log('✅ Colonne lyrics_text ajoutée à music');
    } else {
      console.log('✅ Colonne lyrics_text déjà présente sur music');
    }

    // lyrics_synced_starts: tableau JSON des timestamps (secondes) de début par ligne
    const [lyricsSyncCols] = await c.execute(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'music' AND COLUMN_NAME = 'lyrics_synced_starts'
    `);
    if (lyricsSyncCols.length === 0) {
      await c.execute(`
        ALTER TABLE music
        ADD COLUMN lyrics_synced_starts JSON NULL DEFAULT NULL AFTER lyrics_text
      `);
      console.log('✅ Colonne lyrics_synced_starts ajoutée à music');
    } else {
      console.log('✅ Colonne lyrics_synced_starts déjà présente sur music');
    }
  } finally {
    if (c) c.release();
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

