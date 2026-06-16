import express from 'express';
import pool from '../database/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import { PROFESSIONAL_ACCOUNT_TYPES } from '../config/professionalAccountTypes.js';

const router = express.Router();

export async function ensureProfessionalTables() {
  const tableSuffix = `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_applications (
      id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      real_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      identity_document_url TEXT NOT NULL,
      studio_address TEXT,
      years_experience INT DEFAULT 0,
      portfolio_url TEXT,
      linkedin_url TEXT,
      website_url TEXT,
      bio TEXT,
      status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
      rejection_reason TEXT,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_user (user_id),
      INDEX idx_status (status),
      CONSTRAINT producer_applications_ibfk_1 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${tableSuffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_applications (
      id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      real_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      identity_document_url TEXT NOT NULL,
      business_registration TEXT,
      distribution_territories TEXT,
      catalog_size INT DEFAULT 0,
      website_url TEXT,
      linkedin_url TEXT,
      bio TEXT,
      status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
      rejection_reason TEXT,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_user (user_id),
      INDEX idx_status (status),
      CONSTRAINT distributor_applications_ibfk_1 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${tableSuffix}
  `);

  try {
    await pool.execute('ALTER TABLE users ADD COLUMN is_producer BOOLEAN DEFAULT FALSE');
  } catch (_) { /* column exists */ }
  try {
    await pool.execute('ALTER TABLE users ADD COLUMN is_distributor BOOLEAN DEFAULT FALSE');
  } catch (_) { /* column exists */ }
}

async function fetchApplicationStatus(userId, typeId) {
  if (typeId === 'artist') {
    const [rows] = await pool.execute(
      'SELECT id, status, rejection_reason, created_at, updated_at, artist_name as display_name FROM artist_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    return rows[0] || null;
  }
  if (typeId === 'producer') {
    const [rows] = await pool.execute(
      'SELECT id, status, rejection_reason, created_at, updated_at, company_name as display_name FROM producer_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    return rows[0] || null;
  }
  if (typeId === 'distributor') {
    const [rows] = await pool.execute(
      'SELECT id, status, rejection_reason, created_at, updated_at, company_name as display_name FROM distributor_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    return rows[0] || null;
  }
  return null;
}

// Types de comptes professionnels (public)
router.get('/types', async (_req, res) => {
  try {
    res.json(PROFESSIONAL_ACCOUNT_TYPES.map(({ formFields, ...rest }) => ({
      ...rest,
      formFieldCount: formFields?.length || 0,
    })));
  } catch (error) {
    console.error('Erreur types professionnels:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des types' });
  }
});

// Config complète d'un type (pour les apps dédiées)
router.get('/types/:typeId', async (req, res) => {
  try {
    const type = PROFESSIONAL_ACCOUNT_TYPES.find((t) => t.id === req.params.typeId);
    if (!type) return res.status(404).json({ error: 'Type de compte introuvable' });
    res.json(type);
  } catch (error) {
    console.error('Erreur config type:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la configuration' });
  }
});

// Statuts de toutes les candidatures de l'utilisateur
router.get('/my-status', authenticateToken, async (req, res) => {
  try {
    await ensureProfessionalTables();
    const userId = req.user.id;

    const statuses = await Promise.all(
      PROFESSIONAL_ACCOUNT_TYPES.map(async (type) => {
        const application = await fetchApplicationStatus(userId, type.id);
        return {
          typeId: type.id,
          label: type.label,
          appUrl: type.appUrl,
          application,
          isApproved: application?.status === 'approved',
          isPending: application?.status === 'pending',
        };
      })
    );

    res.json(statuses);
  } catch (error) {
    console.error('Erreur statuts professionnels:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statuts' });
  }
});

export default router;
