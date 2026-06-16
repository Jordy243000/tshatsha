import pool from './connection.js';

async function migrateAddAlbumIsPopular() {
  try {
    // Vérifier si la colonne existe déjà
    const [columns] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'albums' AND COLUMN_NAME = 'is_popular'"
    );

    if (columns.length > 0) {
      console.log('La colonne is_popular existe déjà dans la table albums.');
      return;
    }

    // Ajouter la colonne is_popular
    await pool.execute(
      "ALTER TABLE albums ADD COLUMN is_popular BOOLEAN DEFAULT FALSE AFTER status"
    );
    console.log('Colonne is_popular ajoutée avec succès.');

    // Ajouter l'index si nécessaire
    const [indexes] = await pool.execute(
      "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'albums' AND INDEX_NAME = 'idx_popular'"
    );

    if (indexes.length === 0) {
      await pool.execute("ALTER TABLE albums ADD INDEX idx_popular (is_popular)");
      console.log('Index idx_popular ajouté avec succès.');
    } else {
      console.log('L\'index idx_popular existe déjà.');
    }

    console.log('Migration réussie : colonne is_popular ajoutée à la table albums.');
  } catch (error) {
    console.error('Erreur lors de la migration:', error);
    throw error;
  }
}

// Exécuter la migration si le script est appelé directement
migrateAddAlbumIsPopular()
  .then(() => {
    console.log('Migration terminée.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Échec de la migration:', error);
    process.exit(1);
  });

export default migrateAddAlbumIsPopular;

