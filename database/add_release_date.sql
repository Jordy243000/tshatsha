-- Ajouter la colonne release_date à la table music
ALTER TABLE music ADD COLUMN release_date DATETIME NULL AFTER created_at;

