import pool from './connection.js';

async function updatePlaceholders() {
  try {
    console.log('🔄 Mise à jour des placeholders...');

    // Mettre à jour les images des pistes
    const [tracksResult] = await pool.execute(
      'UPDATE music SET image_url = NULL WHERE image_url LIKE ? OR image_url LIKE ?',
      ['%via.placeholder.com%', '%placeholder%']
    );
    console.log(`  ✓ ${tracksResult.affectedRows} pistes mises à jour`);

    // Mettre à jour les images des artistes
    const [artistsResult] = await pool.execute(
      'UPDATE artists SET image_url = NULL WHERE image_url LIKE ? OR image_url LIKE ?',
      ['%via.placeholder.com%', '%placeholder%']
    );
    console.log(`  ✓ ${artistsResult.affectedRows} artistes mis à jour`);

    // Mettre à jour les images de couverture des artistes
    const [artistsCoverResult] = await pool.execute(
      'UPDATE artists SET cover_image_url = NULL WHERE cover_image_url LIKE ? OR cover_image_url LIKE ?',
      ['%via.placeholder.com%', '%placeholder%']
    );
    console.log(`  ✓ ${artistsCoverResult.affectedRows} couvertures d'artistes mises à jour`);

    // Mettre à jour les images des albums
    const [albumsResult] = await pool.execute(
      'UPDATE albums SET cover_image_url = NULL WHERE cover_image_url LIKE ? OR cover_image_url LIKE ?',
      ['%via.placeholder.com%', '%placeholder%']
    );
    console.log(`  ✓ ${albumsResult.affectedRows} albums mis à jour`);

    console.log('✅ Mise à jour terminée!');
    console.log('Les placeholders seront maintenant générés automatiquement par l\'application.');

  } catch (error) {
    console.error('❌ Erreur lors de la mise à jour:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

updatePlaceholders()
  .then(() => {
    console.log('🎉 Script terminé!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Erreur fatale:', error);
    process.exit(1);
  });

