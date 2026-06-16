import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import requireAdmin from '../middleware/adminAuth.js';
import {
  listApprovedDistributors,
  getSubmissionById,
  publishSubmission,
  RELEASE_STATUSES,
} from '../services/releaseWorkflowService.js';

const router = express.Router();

async function requireArtist(req, res, next) {
  try {
    const [users] = await pool.execute('SELECT artist_id FROM users WHERE id = ?', [req.user.id]);
    if (!users[0]?.artist_id) return res.status(403).json({ error: 'Compte artiste requis' });
    req.artistId = users[0].artist_id;
    next();
  } catch {
    res.status(500).json({ error: 'Erreur vérification artiste' });
  }
}

async function requireProducer(req, res, next) {
  try {
    const [users] = await pool.execute('SELECT is_producer FROM users WHERE id = ?', [req.user.id]);
    if (!users[0]?.is_producer) return res.status(403).json({ error: 'Compte producteur requis' });
    next();
  } catch {
    res.status(500).json({ error: 'Erreur vérification producteur' });
  }
}

async function requireDistributor(req, res, next) {
  try {
    const [users] = await pool.execute('SELECT is_distributor, distributor_type FROM users WHERE id = ?', [req.user.id]);
    if (!users[0]?.is_distributor) return res.status(403).json({ error: 'Compte distributeur requis' });
    req.distributorType = users[0].distributor_type || 'external';
    next();
  } catch {
    res.status(500).json({ error: 'Erreur vérification distributeur' });
  }
}

// ─── Registre distributeurs ───────────────────────────────────────────────────

router.get('/distributors/registry', authenticateToken, async (_req, res) => {
  try {
    res.json(await listApprovedDistributors());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Artiste → demande distributeur ───────────────────────────────────────────

router.get('/artist/distributor-links', authenticateToken, requireArtist, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT adl.*, u.full_name, u.email, da.company_name, u.distributor_type
       FROM artist_distributor_links adl
       JOIN users u ON u.id = adl.distributor_user_id
       LEFT JOIN distributor_applications da ON da.user_id = u.id AND da.status = 'approved'
       WHERE adl.artist_id = ?
       ORDER BY adl.created_at DESC`,
      [req.artistId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/artist/distributor-links', authenticateToken, requireArtist, async (req, res) => {
  try {
    const { distributor_user_id, message } = req.body;
    if (!distributor_user_id) return res.status(400).json({ error: 'distributor_user_id requis' });

    const [dist] = await pool.execute(
      'SELECT id, is_distributor FROM users WHERE id = ? AND is_distributor = TRUE',
      [distributor_user_id]
    );
    if (!dist[0]) return res.status(404).json({ error: 'Distributeur introuvable' });

    const [existing] = await pool.execute(
      `SELECT id FROM artist_distributor_links WHERE artist_id = ? AND distributor_user_id = ? AND status NOT IN ('rejected')`,
      [req.artistId, distributor_user_id]
    );
    if (existing.length) return res.status(409).json({ error: 'Demande déjà en cours ou active' });

    const id = uuidv4();
    await pool.execute(
      `INSERT INTO artist_distributor_links (id, artist_id, distributor_user_id, message, status) VALUES (?, ?, ?, ?, 'pending')`,
      [id, req.artistId, distributor_user_id, message || null]
    );
    res.status(201).json({ id, status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Producteur → demande distributeur ────────────────────────────────────────

router.get('/producer/distributor-links', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT pdl.*, u.full_name, da.company_name, u.distributor_type
       FROM producer_distributor_links pdl
       JOIN users u ON u.id = pdl.distributor_user_id
       LEFT JOIN distributor_applications da ON da.user_id = u.id AND da.status = 'approved'
       WHERE pdl.producer_user_id = ?
       ORDER BY pdl.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/producer/distributor-links', authenticateToken, requireProducer, async (req, res) => {
  try {
    const { distributor_user_id, message } = req.body;
    if (!distributor_user_id) return res.status(400).json({ error: 'distributor_user_id requis' });

    const id = uuidv4();
    await pool.execute(
      `INSERT INTO producer_distributor_links (id, producer_user_id, distributor_user_id, message, status) VALUES (?, ?, ?, ?, 'pending')`,
      [id, req.user.id, distributor_user_id, message || null]
    );
    res.status(201).json({ id, status: 'pending' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Demande déjà existante' });
    res.status(500).json({ error: e.message });
  }
});

// ─── Distributeur : répondre aux demandes ─────────────────────────────────────

router.get('/distributor/incoming-links', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const [artistLinks] = await pool.execute(
      `SELECT adl.*, a.name as artist_name, 'artist' as link_type
       FROM artist_distributor_links adl
       JOIN artists a ON a.id = adl.artist_id
       WHERE adl.distributor_user_id = ? AND adl.status = 'pending'
       ORDER BY adl.created_at DESC`,
      [req.user.id]
    );
    const [producerLinks] = await pool.execute(
      `SELECT pdl.*, u.full_name as producer_name, 'producer' as link_type
       FROM producer_distributor_links pdl
       JOIN users u ON u.id = pdl.producer_user_id
       WHERE pdl.distributor_user_id = ? AND pdl.status = 'pending'
       ORDER BY pdl.created_at DESC`,
      [req.user.id]
    );
    res.json({ artist_requests: artistLinks, producer_requests: producerLinks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/distributor/artist-links/:id/respond', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const { accept } = req.body;
    const [rows] = await pool.execute(
      'SELECT * FROM artist_distributor_links WHERE id = ? AND distributor_user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demande introuvable' });
    const status = accept ? 'active' : 'rejected';
    await pool.execute(
      `UPDATE artist_distributor_links SET status = ?, distributor_response_at = NOW() WHERE id = ?`,
      [status, req.params.id]
    );
    res.json({ id: req.params.id, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/distributor/producer-links/:id/respond', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const { accept } = req.body;
    const [rows] = await pool.execute(
      'SELECT * FROM producer_distributor_links WHERE id = ? AND distributor_user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demande introuvable' });
    const status = accept ? 'active' : 'rejected';
    await pool.execute(
      `UPDATE producer_distributor_links SET status = ?, distributor_response_at = NOW() WHERE id = ?`,
      [status, req.params.id]
    );
    res.json({ id: req.params.id, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Files d'attente validations ──────────────────────────────────────────────

router.get('/producer/queue', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT rs.*, (SELECT COUNT(*) FROM release_submission_tracks t WHERE t.submission_id = rs.id) as track_count
       FROM release_submissions rs
       WHERE rs.producer_user_id = ? AND rs.status = 'producer_review'
       ORDER BY rs.submitted_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/producer/submissions/:id/validate', authenticateToken, requireProducer, async (req, res) => {
  try {
    const { action, comment } = req.body;
    const [rows] = await pool.execute(
      `SELECT * FROM release_submissions WHERE id = ? AND producer_user_id = ? AND status = 'producer_review'`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Soumission introuvable' });

    if (action === 'reject') {
      await pool.execute(
        `UPDATE release_submissions SET status = 'rejected', producer_comment = ? WHERE id = ?`,
        [comment || null, req.params.id]
      );
      return res.json({ id: req.params.id, status: 'rejected' });
    }

    const nextStatus = rows[0].distributor_type === 'internal'
      ? RELEASE_STATUSES.ADMIN_REVIEW
      : RELEASE_STATUSES.DISTRIBUTOR_REVIEW;

    await pool.execute(
      `UPDATE release_submissions SET status = ?, producer_comment = ? WHERE id = ?`,
      [nextStatus, comment || null, req.params.id]
    );
    res.json({ id: req.params.id, status: nextStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/distributor/queue', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT rs.*, (SELECT COUNT(*) FROM release_submission_tracks t WHERE t.submission_id = rs.id) as track_count
       FROM release_submissions rs
       WHERE rs.distributor_user_id = ? AND rs.status = 'distributor_review'
       ORDER BY rs.submitted_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/queue', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT rs.*, (SELECT COUNT(*) FROM release_submission_tracks t WHERE t.submission_id = rs.id) as track_count
       FROM release_submissions rs
       WHERE rs.status = 'admin_review'
       ORDER BY rs.submitted_at ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/submissions/:id', authenticateToken, async (req, res) => {
  try {
    const sub = await getSubmissionById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Introuvable' });
    res.json(sub);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/distributor/submissions/:id/publish', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM release_submissions WHERE id = ? AND distributor_user_id = ? AND status = 'distributor_review'`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Soumission introuvable ou déjà traitée' });
    const result = await publishSubmission(req.params.id, req.body?.comment || null);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/distributor/submissions/:id/reject', authenticateToken, requireDistributor, async (req, res) => {
  try {
    await pool.execute(
      `UPDATE release_submissions SET status = 'rejected', distributor_comment = ? WHERE id = ? AND distributor_user_id = ? AND status = 'distributor_review'`,
      [req.body?.comment || null, req.params.id, req.user.id]
    );
    res.json({ id: req.params.id, status: 'rejected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/submissions/:id/publish', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM release_submissions WHERE id = ? AND status = 'admin_review'`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Soumission introuvable' });
    const result = await publishSubmission(req.params.id, req.body?.comment || null);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/submissions/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.execute(
      `UPDATE release_submissions SET status = 'rejected', admin_comment = ? WHERE id = ? AND status = 'admin_review'`,
      [req.body?.comment || null, req.params.id]
    );
    res.json({ id: req.params.id, status: 'rejected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Mes soumissions (artiste) ────────────────────────────────────────────────

router.get('/artist/my-submissions', authenticateToken, requireArtist, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT rs.*, (SELECT COUNT(*) FROM release_submission_tracks t WHERE t.submission_id = rs.id) as track_count
       FROM release_submissions rs WHERE rs.artist_id = ? ORDER BY rs.created_at DESC LIMIT 50`,
      [req.artistId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
