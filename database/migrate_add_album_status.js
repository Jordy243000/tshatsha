import pool from './connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate() {
  try {
    // Vérifier si la colonne status existe déjà
    const [statusColumns] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'albums' AND COLUMN_NAME = 'status'"
    );

    if (statusColumns.length === 0) {
      // Ajouter la colonne status
      await pool.execute(
        "ALTER TABLE albums ADD COLUMN status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending' AFTER release_date"
      );
      console.log('Colonne status ajoutée.');
    } else {
      console.log('La colonne status existe déjà.');
    }

    // Vérifier si la colonne submitted_by existe déjà
    const [submittedByColumns] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'albums' AND COLUMN_NAME = 'submitted_by'"
    );

    if (submittedByColumns.length === 0) {
      // Ajouter la colonne submitted_by
      await pool.execute(
        "ALTER TABLE albums ADD COLUMN submitted_by VARCHAR(36) NULL AFTER status"
      );
      console.log('Colonne submitted_by ajoutée.');
    } else {
      console.log('La colonne submitted_by existe déjà.');
    }

    // Vérifier si l'index existe déjà
    const [indexes] = await pool.execute(
      "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'albums' AND INDEX_NAME = 'idx_status'"
    );

    if (indexes.length === 0) {
      // Ajouter l'index
      await pool.execute("ALTER TABLE albums ADD INDEX idx_status (status)");
      console.log('Index idx_status ajouté.');
    } else {
      console.log('L\'index idx_status existe déjà.');
    }

    console.log('Migration réussie : colonnes status et submitted_by ajoutées à la table albums.');
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_DUP_KEYNAME') {
      console.log('Les colonnes ou index existent déjà.');
    } else {
      console.error('Erreur lors de la migration:', error);
      throw error;
    }
  } finally {
    await pool.end();
  }
}

migrate();

