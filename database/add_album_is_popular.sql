-- Ajouter la colonne is_popular à la table albums
ALTER TABLE albums ADD COLUMN is_popular BOOLEAN DEFAULT FALSE AFTER status;
ALTER TABLE albums ADD INDEX idx_popular (is_popular);

