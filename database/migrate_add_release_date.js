import pool from './connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate() {
  try {
    const sql = readFileSync(join(__dirname, 'add_release_date.sql'), 'utf8');
    
    // Vérifier si la colonne existe déjà
    const [columns] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'music' AND COLUMN_NAME = 'release_date'"
    );

    if (columns.length > 0) {
      console.log('La colonne release_date existe déjà dans la table music.');
      return;
    }

    await pool.execute(sql);
    console.log('Migration réussie : colonne release_date ajoutée à la table music.');
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('La colonne release_date existe déjà.');
    } else {
      console.error('Erreur lors de la migration:', error);
      throw error;
    }
  } finally {
    await pool.end();
  }
}

migrate();

