-- Ajouter la colonne status à la table albums
-- status peut être: 'pending' (en attente), 'approved' (approuvé), 'rejected' (rejeté)
ALTER TABLE albums ADD COLUMN status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending' AFTER release_date;
ALTER TABLE albums ADD COLUMN submitted_by VARCHAR(36) NULL AFTER status;
ALTER TABLE albums ADD INDEX idx_status (status);

