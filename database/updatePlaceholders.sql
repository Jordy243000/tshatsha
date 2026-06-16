-- Script pour remplacer les URLs placeholder par NULL dans la base
-- Les placeholders seront générés automatiquement par l'application

USE TshaTshaStream_db;

-- Mettre à jour les images des pistes
UPDATE music 
SET image_url = NULL 
WHERE image_url LIKE '%via.placeholder.com%' OR image_url LIKE '%placeholder%';

-- Mettre à jour les images des artistes
UPDATE artists 
SET image_url = NULL 
WHERE image_url LIKE '%via.placeholder.com%' OR image_url LIKE '%placeholder%';

-- Mettre à jour les images de couverture des artistes
UPDATE artists 
SET cover_image_url = NULL 
WHERE cover_image_url LIKE '%via.placeholder.com%' OR cover_image_url LIKE '%placeholder%';

-- Mettre à jour les images des albums
UPDATE albums 
SET cover_image_url = NULL 
WHERE cover_image_url LIKE '%via.placeholder.com%' OR cover_image_url LIKE '%placeholder%';

SELECT '✅ URLs placeholder remplacées par NULL' as message;
SELECT COUNT(*) as tracks_with_null_image FROM music WHERE image_url IS NULL;
SELECT COUNT(*) as artists_with_null_image FROM artists WHERE image_url IS NULL;
SELECT COUNT(*) as albums_with_null_image FROM albums WHERE cover_image_url IS NULL;

