# Guide d'insertion des données mockées

## Méthode 1 : Script Node.js (Recommandé)

1. Assurez-vous que votre base de données est créée et que les tables existent :
   ```bash
   npm run init-db
   ```

2. Exécutez le script d'insertion :
   ```bash
   npm run seed
   ```

Le script va :
- Insérer 8 pistes musicales
- Insérer 6 artistes
- Insérer 6 albums
- Lier les pistes aux albums

## Méthode 2 : Script SQL direct

1. Connectez-vous à MySQL :
   ```bash
   mysql -u root -p
   ```

2. Exécutez le script SQL :
   ```bash
   mysql -u root -p TshaTshaStream_db < database/seedData.sql
   ```

Ou depuis MySQL :
```sql
USE TshaTshaStream_db;
SOURCE database/seedData.sql;
```

## Vérification

Après l'insertion, vérifiez les données :

```sql
SELECT COUNT(*) as total_tracks FROM music;
SELECT COUNT(*) as total_artists FROM artists;
SELECT COUNT(*) as total_albums FROM albums;
```

Vous devriez voir :
- 8 pistes
- 6 artistes
- 6 albums

## Notes

- Les URLs audio utilisent des fichiers de démonstration SoundHelix
- Les images utilisent des placeholders (via.placeholder.com)
- Vous pouvez remplacer ces URLs par vos propres fichiers plus tard
- Le script évite les doublons avec `ON DUPLICATE KEY UPDATE`

