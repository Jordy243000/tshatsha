import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import pool from '../database/connection.js';
import requireAdmin from '../middleware/adminAuth.js';
import { authenticateToken } from '../middleware/auth.js';
import { uploadToS3 } from '../services/s3Service.js';
import { ensureProfessionalTables } from './professionalAccounts.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function createApplicationRouter(config) {
  const router = express.Router();
  const { tableName, userFlag, requiredFields, insertFields } = config;

  router.post('/', authenticateToken, upload.single('identity_document'), async (req, res) => {
    try {
      await ensureProfessionalTables();
      const userId = req.user.id;
      const identityFile = req.file;

      for (const field of requiredFields) {
        if (!req.body[field]) {
          return res.status(400).json({ error: `Le champ "${field}" est requis` });
        }
      }

      if (!identityFile) {
        return res.status(400).json({ error: 'La pièce d\'identité est requise' });
      }

      const [existing] = await pool.execute(
        `SELECT id, status FROM ${tableName} WHERE user_id = ? AND status IN ("pending", "approved")`,
        [userId]
      );

      if (existing.length > 0) {
        return res.status(400).json({
          error: existing[0].status === 'approved'
            ? 'Vous avez déjà un compte approuvé'
            : 'Vous avez déjà une demande en attente',
        });
      }

      let identityUrl;
      try {
        identityUrl = await uploadToS3(identityFile.buffer, identityFile.originalname, 'identity-documents');
      } catch {
        return res.status(500).json({ error: 'Erreur lors de l\'upload de la pièce d\'identité' });
      }

      const applicationId = uuidv4();
      const values = insertFields.map((f) => {
        if (f === 'id') return applicationId;
        if (f === 'user_id') return userId;
        if (f === 'identity_document_url') return identityUrl;
        if (f === 'status') return 'pending';
        const val = req.body[f];
        if (f === 'years_experience' || f === 'catalog_size') return parseInt(val, 10) || 0;
        return val || null;
      });

      const placeholders = insertFields.map(() => '?').join(', ');
      await pool.execute(
        `INSERT INTO ${tableName} (${insertFields.join(', ')}) VALUES (${placeholders})`,
        values
      );

      res.status(201).json({
        success: true,
        message: 'Demande soumise avec succès',
        application: { id: applicationId, status: 'pending' },
      });
    } catch (error) {
      console.error(`Erreur soumission ${tableName}:`, error);
      res.status(500).json({ error: 'Erreur lors de la soumission de la demande' });
    }
  });

  router.get('/my-application', authenticateToken, async (req, res) => {
    try {
      await ensureProfessionalTables();
      const [applications] = await pool.execute(
        `SELECT * FROM ${tableName} WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
        [req.user.id]
      );
      res.json(applications[0] || null);
    } catch (error) {
      console.error(`Erreur récupération ${tableName}:`, error);
      res.status(500).json({ error: 'Erreur lors de la récupération de la demande' });
    }
  });

  router.get('/all', requireAdmin, async (req, res) => {
    try {
      await ensureProfessionalTables();
      const { status } = req.query;
      let query = `SELECT * FROM ${tableName}`;
      const params = [];
      if (status && ['pending', 'approved', 'rejected'].includes(status)) {
        query += ' WHERE status = ?';
        params.push(status);
      }
      query += ' ORDER BY created_at DESC';
      const [applications] = await pool.execute(query, params);
      res.json(applications);
    } catch (error) {
      console.error(`Erreur liste ${tableName}:`, error);
      res.status(500).json({ error: 'Erreur lors de la récupération des demandes' });
    }
  });

  router.put('/:id/status', requireAdmin, async (req, res) => {
    try {
      await ensureProfessionalTables();
      const { id } = req.params;
      const { status, rejection_reason } = req.body;

      if (!status || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Status invalide' });
      }
      if (status === 'rejected' && !rejection_reason) {
        return res.status(400).json({ error: 'Une raison de rejet est requise' });
      }

      const [applications] = await pool.execute(`SELECT * FROM ${tableName} WHERE id = ?`, [id]);
      if (applications.length === 0) {
        return res.status(404).json({ error: 'Demande non trouvée' });
      }

      const application = applications[0];
      if (application.status !== 'pending') {
        return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
      }

      await pool.execute(
        `UPDATE ${tableName} SET status = ?, rejection_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [status, rejection_reason || null, id]
      );

      if (status === 'approved' && userFlag) {
        await pool.execute(`UPDATE users SET ${userFlag} = true WHERE id = ?`, [application.user_id]);
      }

      res.json({
        success: true,
        message: `Demande ${status === 'approved' ? 'approuvée' : 'rejetée'} avec succès`,
      });
    } catch (error) {
      console.error(`Erreur statut ${tableName}:`, error);
      res.status(500).json({ error: 'Erreur lors de la mise à jour du statut' });
    }
  });

  return router;
}

export const producerRouter = createApplicationRouter({
  tableName: 'producer_applications',
  userFlag: 'is_producer',
  requiredFields: ['company_name', 'real_name', 'email', 'phone', 'studio_address', 'years_experience', 'portfolio_url'],
  insertFields: [
    'id', 'user_id', 'company_name', 'real_name', 'email', 'phone',
    'identity_document_url', 'studio_address', 'years_experience', 'portfolio_url',
    'linkedin_url', 'website_url', 'bio', 'status',
  ],
});

export const distributorRouter = createApplicationRouter({
  tableName: 'distributor_applications',
  userFlag: 'is_distributor',
  requiredFields: ['company_name', 'real_name', 'email', 'phone', 'business_registration', 'distribution_territories', 'catalog_size'],
  insertFields: [
    'id', 'user_id', 'company_name', 'real_name', 'email', 'phone',
    'identity_document_url', 'business_registration', 'distribution_territories', 'catalog_size',
    'website_url', 'linkedin_url', 'bio', 'status',
  ],
});

export default producerRouter;
