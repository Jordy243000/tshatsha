import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import pool from '../database/connection.js';
import requireAdmin from '../middleware/adminAuth.js';
import { authenticateToken } from '../middleware/auth.js';
import { uploadToS3 } from '../services/s3Service.js';

const router = express.Router();

// Configuration Multer pour stocker les fichiers en mémoire (pour S3)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max pour les pièces d'identité
});

// Soumettre une demande d'artiste (utilisateur authentifié)
router.post('/', authenticateToken, upload.single('identity_document'), async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      artist_name,
      real_name,
      email,
      phone,
      facebook_url,
      instagram_url,
      twitter_url,
      youtube_url,
      spotify_url,
      bio
    } = req.body;

    const identityFile = req.file;

    // Validation des champs requis
    if (!artist_name || !real_name || !email || !phone) {
      return res.status(400).json({ error: 'Tous les champs requis doivent être remplis' });
    }

    if (!identityFile) {
      return res.status(400).json({ error: 'La pièce d\'identité est requise' });
    }

    // Validation : minimum 2 réseaux sociaux
    const socialNetworks = [
      facebook_url,
      instagram_url,
      twitter_url,
      youtube_url,
      spotify_url
    ].filter(url => url && url.trim() !== '');

    if (socialNetworks.length < 2) {
      return res.status(400).json({ error: 'Au moins 2 réseaux sociaux sont requis' });
    }

    // Vérifier si l'utilisateur a déjà une demande en attente ou approuvée
    const [existingApplications] = await pool.execute(
      'SELECT id, status FROM artist_applications WHERE user_id = ? AND status IN ("pending", "approved")',
      [userId]
    );

    if (existingApplications.length > 0) {
      return res.status(400).json({ 
        error: existingApplications[0].status === 'approved' 
          ? 'Vous avez déjà un compte artiste approuvé' 
          : 'Vous avez déjà une demande en attente' 
      });
    }

    // Upload de la pièce d'identité vers S3
    let identityUrl = null;
    try {
      console.log('📤 Upload de la pièce d\'identité vers S3...');
      identityUrl = await uploadToS3(identityFile.buffer, identityFile.originalname, 'identity-documents');
      console.log('✅ Pièce d\'identité uploadée vers S3:', identityUrl);
    } catch (s3Error) {
      console.error('❌ Erreur S3:', s3Error);
      return res.status(500).json({ error: 'Erreur lors de l\'upload de la pièce d\'identité' });
    }

    // Créer la demande
    const applicationId = uuidv4();
    await pool.execute(
      `INSERT INTO artist_applications (
        id, user_id, artist_name, real_name, email, phone,
        identity_document_url, facebook_url, instagram_url, twitter_url,
        youtube_url, spotify_url, bio, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        applicationId,
        userId,
        artist_name,
        real_name,
        email,
        phone,
        identityUrl,
        facebook_url || null,
        instagram_url || null,
        twitter_url || null,
        youtube_url || null,
        spotify_url || null,
        bio || null
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Demande soumise avec succès',
      application: {
        id: applicationId,
        status: 'pending'
      }
    });
  } catch (error) {
    console.error('Erreur lors de la soumission de la demande:', error);
    res.status(500).json({ error: 'Erreur lors de la soumission de la demande' });
  }
});

// Récupérer la demande de l'utilisateur connecté
router.get('/my-application', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [applications] = await pool.execute(
      'SELECT * FROM artist_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    if (applications.length === 0) {
      return res.json(null);
    }

    res.json(applications[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération de la demande:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la demande' });
  }
});

// Récupérer toutes les demandes (admin uniquement)
router.get('/all', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;

    // Vérifier si la table existe
    try {
      await pool.execute('SELECT 1 FROM artist_applications LIMIT 1');
    } catch (tableError) {
      console.error('La table artist_applications n\'existe pas:', tableError);
      console.error('Veuillez exécuter: npm run init-db');
      // Si la table n'existe pas, retourner un tableau vide
      return res.json([]);
    }

    // Commencer par une requête simple sans jointure pour éviter les erreurs
    let query = 'SELECT * FROM artist_applications';
    const params = [];

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const [applications] = await pool.execute(query, params);

    // Enrichir avec les informations utilisateur si possible
    const enrichedApplications = await Promise.all(
      applications.map(async (app) => {
        try {
          const [users] = await pool.execute(
            'SELECT username, email FROM users WHERE id = ?',
            [app.user_id]
          );
          if (users.length > 0) {
            return {
              ...app,
              username: users[0].username,
              user_email: users[0].email
            };
          }
          return app;
        } catch (userError) {
          // Si erreur lors de la récupération de l'utilisateur, retourner l'application sans enrichissement
          console.warn(`Erreur lors de la récupération de l'utilisateur ${app.user_id}:`, userError.message);
          return app;
        }
      })
    );

    res.json(enrichedApplications);
  } catch (error) {
    console.error('Erreur lors de la récupération des demandes:', error);
    console.error('Détails de l\'erreur:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage
    });
    res.status(500).json({ 
      error: 'Erreur lors de la récupération des demandes',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

// Récupérer une demande spécifique (admin uniquement)
router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const [applications] = await pool.execute(
      `SELECT 
        aa.*,
        u.username,
        u.email as user_email
      FROM artist_applications aa
      LEFT JOIN users u ON aa.user_id = u.id
      WHERE aa.id = ?`,
      [id]
    );

    if (applications.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }

    res.json(applications[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération de la demande:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la demande' });
  }
});

// Approuver ou rejeter une demande (admin uniquement)
router.put('/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;

    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status invalide. Doit être "approved" ou "rejected"' });
    }

    if (status === 'rejected' && !rejection_reason) {
      return res.status(400).json({ error: 'Une raison de rejet est requise' });
    }

    // Récupérer la demande
    const [applications] = await pool.execute(
      'SELECT * FROM artist_applications WHERE id = ?',
      [id]
    );

    if (applications.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }

    const application = applications[0];

    if (application.status !== 'pending') {
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }

    // Mettre à jour le statut
    await pool.execute(
      'UPDATE artist_applications SET status = ?, rejection_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, rejection_reason || null, id]
    );

    // Si approuvé, créer l'artiste dans la table artists et lier à l'utilisateur
    if (status === 'approved') {
      // Vérifier si l'artiste existe déjà
      const [existingArtists] = await pool.execute(
        'SELECT id FROM artists WHERE name = ?',
        [application.artist_name]
      );

      let artistId;
      if (existingArtists.length === 0) {
        artistId = uuidv4();
        await pool.execute(
          `INSERT INTO artists (id, name, image_url, monthly_listeners, is_popular)
           VALUES (?, ?, NULL, 0, false)`,
          [artistId, application.artist_name]
        );
      } else {
        artistId = existingArtists[0].id;
      }

      // Lier l'artiste à l'utilisateur
      await pool.execute(
        'UPDATE users SET artist_id = ?, is_artist = true WHERE id = ?',
        [artistId, application.user_id]
      );
    }

    res.json({
      success: true,
      message: `Demande ${status === 'approved' ? 'approuvée' : 'rejetée'} avec succès`
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du statut:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du statut' });
  }
});

export default router;

