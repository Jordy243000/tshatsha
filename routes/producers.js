import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import requireAdmin from '../middleware/adminAuth.js';
import { uploadToS3 } from '../services/s3Service.js';
import {
  multerAudioLimit,
  validateAudioFile,
  validateCoverDimensions,
} from '../utils/uploadRequirements.js';
import {
  getRoyaltyBalance, getPayoutHistory, getStreamHistory,
  STREAM_RATE_USD, PAYOUT_THRESHOLD_USD,
} from '../services/streamRoyaltyService.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: multerAudioLimit });

const ASSOCIATION_STATUSES = ['pending', 'artist_accepted', 'rejected', 'admin_approved', 'suspended'];
const TRACK_STATUSES = ['draft', 'pending_validation', 'published', 'rejected'];
const CREDIT_ROLES = ['author', 'composer', 'producer', 'beatmaker', 'musician', 'engineer', 'studio', 'main_performer', 'featuring'];

export async function ensureProducerTables() {
  const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_artist_associations (
      id VARCHAR(36) PRIMARY KEY,
      producer_user_id VARCHAR(36) NOT NULL,
      artist_id VARCHAR(36) NOT NULL,
      message TEXT,
      status ENUM('pending','artist_accepted','rejected','admin_approved','suspended') DEFAULT 'pending',
      artist_response_at TIMESTAMP NULL,
      admin_response_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_producer (producer_user_id),
      INDEX idx_artist (artist_id),
      INDEX idx_status (status),
      FOREIGN KEY (producer_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_catalog_tracks (
      id VARCHAR(36) PRIMARY KEY,
      producer_user_id VARCHAR(36) NOT NULL,
      artist_id VARCHAR(36) NOT NULL,
      title VARCHAR(255) NOT NULL,
      featuring VARCHAR(255),
      composer VARCHAR(255),
      author VARCHAR(255),
      producer_name VARCHAR(255),
      arranger VARCHAR(255),
      genre VARCHAR(100),
      language VARCHAR(50),
      isrc VARCHAR(20),
      release_date DATE,
      cover_url TEXT,
      audio_url TEXT,
      lyrics TEXT,
      status ENUM('draft','pending_validation','published','rejected') DEFAULT 'draft',
      play_count INT DEFAULT 0,
      revenue DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_producer (producer_user_id),
      INDEX idx_artist (artist_id),
      INDEX idx_status (status),
      FOREIGN KEY (producer_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_catalog_albums (
      id VARCHAR(36) PRIMARY KEY,
      producer_user_id VARCHAR(36) NOT NULL,
      artist_id VARCHAR(36) NOT NULL,
      title VARCHAR(255) NOT NULL,
      cover_url TEXT,
      release_date DATE,
      description TEXT,
      status ENUM('draft','pending_validation','published','rejected') DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_producer (producer_user_id),
      FOREIGN KEY (producer_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_track_credits (
      id VARCHAR(36) PRIMARY KEY,
      track_id VARCHAR(36) NOT NULL,
      role ENUM('author','composer','producer','beatmaker','musician','engineer','studio','main_performer','featuring') NOT NULL,
      person_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_track (track_id),
      FOREIGN KEY (track_id) REFERENCES producer_catalog_tracks(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_track_rights (
      id VARCHAR(36) PRIMARY KEY,
      track_id VARCHAR(36) NOT NULL,
      artist_pct DECIMAL(5,2) DEFAULT 0,
      producer_pct DECIMAL(5,2) DEFAULT 0,
      composer_pct DECIMAL(5,2) DEFAULT 0,
      author_pct DECIMAL(5,2) DEFAULT 0,
      label_pct DECIMAL(5,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_track (track_id),
      FOREIGN KEY (track_id) REFERENCES producer_catalog_tracks(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_revenue (
      id VARCHAR(36) PRIMARY KEY,
      producer_user_id VARCHAR(36) NOT NULL,
      artist_id VARCHAR(36),
      track_id VARCHAR(36),
      amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'USD',
      period_date DATE NOT NULL,
      source VARCHAR(100) DEFAULT 'streaming',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_producer (producer_user_id),
      INDEX idx_period (period_date),
      FOREIGN KEY (producer_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_settings (
      user_id VARCHAR(36) PRIMARY KEY,
      company_name VARCHAR(255),
      address TEXT,
      phone VARCHAR(50),
      email VARCHAR(255),
      website TEXT,
      logo_url TEXT,
      payment_mobile_money TEXT,
      payment_bank TEXT,
      payment_paypal TEXT,
      payment_stripe TEXT,
      two_factor_enabled BOOLEAN DEFAULT FALSE,
      theme ENUM('dark','light') DEFAULT 'dark',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_notifications (
      id VARCHAR(36) PRIMARY KEY,
      producer_user_id VARCHAR(36) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_producer (producer_user_id),
      INDEX idx_read (is_read),
      FOREIGN KEY (producer_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_activity (
      id VARCHAR(36) PRIMARY KEY,
      producer_user_id VARCHAR(36) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      detail TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_producer (producer_user_id),
      FOREIGN KEY (producer_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);
}

async function requireProducer(req, res, next) {
  try {
    const [users] = await pool.execute('SELECT is_producer FROM users WHERE id = ?', [req.user.id]);
    if (users[0]?.is_producer) return next();
    const [apps] = await pool.execute(
      'SELECT status FROM producer_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );
    if (apps[0]?.status === 'approved') return next();
    return res.status(403).json({ error: 'Compte producteur approuvé requis' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur de vérification producteur' });
  }
}

async function logActivity(producerUserId, type, title, detail = null) {
  await pool.execute(
    'INSERT INTO producer_activity (id, producer_user_id, type, title, detail) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), producerUserId, type, title, detail]
  );
}

async function notifyProducer(producerUserId, type, title, message) {
  await pool.execute(
    'INSERT INTO producer_notifications (id, producer_user_id, type, title, message) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), producerUserId, type, title, message]
  );
}

function statusLabel(status) {
  const map = {
    pending: 'En attente',
    artist_accepted: 'Acceptée par l\'artiste',
    rejected: 'Refusée',
    admin_approved: 'Approuvée par l\'administrateur',
    suspended: 'Suspendue',
    draft: 'Brouillon',
    pending_validation: 'En validation',
    published: 'Publié',
  };
  return map[status] || status;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

router.get('/dashboard', authenticateToken, requireProducer, async (req, res) => {
  try {
    const uid = req.user.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

    const [[artistCount]] = await pool.execute(
      `SELECT COUNT(*) as c FROM producer_artist_associations WHERE producer_user_id = ? AND status = 'admin_approved'`,
      [uid]
    );
    const [[trackCount]] = await pool.execute(
      'SELECT COUNT(*) as c FROM producer_catalog_tracks WHERE producer_user_id = ?',
      [uid]
    );
    const [[albumCount]] = await pool.execute(
      'SELECT COUNT(*) as c FROM producer_catalog_albums WHERE producer_user_id = ?',
      [uid]
    );
    const [[streamCount]] = await pool.execute(
      `SELECT COUNT(*) as c FROM counted_stream_events WHERE producer_user_id = ? AND is_counted = TRUE`,
      [uid]
    );
    const payout = await getRoyaltyBalance('producer', uid);
    const payoutHistory = await getPayoutHistory('producer', uid, 10);

    const [topTracks] = await pool.execute(
      `SELECT cse.track_id as id, cse.track_title as title, COUNT(*) as play_count, cse.artist_name
       FROM counted_stream_events cse
       WHERE cse.producer_user_id = ? AND cse.is_counted = TRUE
       GROUP BY cse.track_id, cse.track_title, cse.artist_name
       ORDER BY play_count DESC LIMIT 5`,
      [uid]
    );
    const [[monthRevenue]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) as c FROM producer_revenue WHERE producer_user_id = ? AND period_date >= ?',
      [uid, monthStart]
    );
    const [[totalRevenue]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) as c FROM producer_revenue WHERE producer_user_id = ?',
      [uid]
    );

    const [topArtist] = await pool.execute(
      `SELECT a.id, a.name, a.image_url, COALESCE(SUM(t.play_count), 0) as streams, COALESCE(SUM(t.revenue), 0) as revenue
       FROM producer_artist_associations paa
       JOIN artists a ON a.id = paa.artist_id
       LEFT JOIN producer_catalog_tracks t ON t.artist_id = a.id AND t.producer_user_id = ?
       WHERE paa.producer_user_id = ? AND paa.status = 'admin_approved'
       GROUP BY a.id, a.name, a.image_url ORDER BY streams DESC LIMIT 1`,
      [uid, uid]
    );

    const [streamsByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(listened_at, '%Y-%m') as month, COUNT(*) as total
       FROM counted_stream_events WHERE producer_user_id = ? AND is_counted = TRUE
       GROUP BY DATE_FORMAT(listened_at, '%Y-%m') ORDER BY month ASC LIMIT 12`,
      [uid]
    );

    const [revenueByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(period_date, '%Y-%m') as month, COALESCE(SUM(amount), 0) as total
       FROM producer_revenue WHERE producer_user_id = ?
       GROUP BY DATE_FORMAT(period_date, '%Y-%m') ORDER BY month ASC LIMIT 12`,
      [uid]
    );

    const [revenueByArtist] = await pool.execute(
      `SELECT a.name as artist, COALESCE(SUM(r.amount), 0) as total
       FROM producer_revenue r LEFT JOIN artists a ON a.id = r.artist_id
       WHERE r.producer_user_id = ? GROUP BY a.name ORDER BY total DESC LIMIT 8`,
      [uid]
    );

    const [subscriberGrowth] = await pool.execute(
      `SELECT a.name as artist, a.monthly_listeners as listeners
       FROM producer_artist_associations paa JOIN artists a ON a.id = paa.artist_id
       WHERE paa.producer_user_id = ? AND paa.status = 'admin_approved' ORDER BY a.monthly_listeners DESC LIMIT 6`,
      [uid]
    );

    const [recentActivity] = await pool.execute(
      'SELECT * FROM producer_activity WHERE producer_user_id = ? ORDER BY created_at DESC LIMIT 15',
      [uid]
    );

    res.json({
      stats: {
        totalArtists: artistCount.c,
        totalTracks: trackCount.c,
        totalAlbums: albumCount.c,
        totalStreams: streamCount.c,
        premiumStreams: streamCount.c,
        streamRateUsd: STREAM_RATE_USD,
        monthRevenue: Number(monthRevenue.c),
        totalRevenue: Number(totalRevenue.c),
        topTracks,
        topArtist: topArtist[0] || null,
      },
      payout,
      payoutHistory,
      charts: { streamsByMonth, revenueByMonth, revenueByArtist, subscriberGrowth },
      recentActivity,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur dashboard producteur' });
  }
});

// ─── Artists ─────────────────────────────────────────────────────────────────

router.get('/artists', authenticateToken, requireProducer, async (req, res) => {
  try {
    const uid = req.user.id;
    const [rows] = await pool.execute(
      `SELECT a.id, a.name, a.image_url, a.genre, a.total_plays, a.monthly_listeners,
              paa.status as collaboration_status, paa.id as association_id,
              (SELECT COUNT(*) FROM producer_catalog_tracks t WHERE t.artist_id = a.id AND t.producer_user_id = ?) as track_count,
              (SELECT COUNT(*) FROM producer_catalog_albums al WHERE al.artist_id = a.id AND al.producer_user_id = ?) as album_count,
              (SELECT COALESCE(SUM(play_count), 0) FROM producer_catalog_tracks t WHERE t.artist_id = a.id AND t.producer_user_id = ?) as streams,
              (SELECT COALESCE(SUM(revenue), 0) FROM producer_catalog_tracks t WHERE t.artist_id = a.id AND t.producer_user_id = ?) as revenue
       FROM producer_artist_associations paa
       JOIN artists a ON a.id = paa.artist_id
       WHERE paa.producer_user_id = ? AND paa.status IN ('admin_approved', 'artist_accepted', 'pending', 'suspended')
       ORDER BY a.name ASC`,
      [uid, uid, uid, uid, uid]
    );
    res.json(rows.map((r) => ({ ...r, collaboration_label: statusLabel(r.collaboration_status) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur chargement artistes' });
  }
});

router.get('/artists/search', authenticateToken, requireProducer, async (req, res) => {
  try {
    const q = `%${req.query.q || ''}%`;
    const [rows] = await pool.execute(
      'SELECT id, name, image_url, genre FROM artists WHERE name LIKE ? ORDER BY name LIMIT 20',
      [q]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erreur recherche artistes' });
  }
});

// ─── Associations ────────────────────────────────────────────────────────────

router.get('/associations', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT paa.*, a.name as artist_name, a.image_url as artist_image, a.genre
       FROM producer_artist_associations paa JOIN artists a ON a.id = paa.artist_id
       WHERE paa.producer_user_id = ? ORDER BY paa.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, status_label: statusLabel(r.status) })));
  } catch (error) {
    res.status(500).json({ error: 'Erreur chargement associations' });
  }
});

router.post('/associations', authenticateToken, requireProducer, async (req, res) => {
  try {
    const { artist_id, message } = req.body;
    if (!artist_id) return res.status(400).json({ error: 'artist_id requis' });

    const [existing] = await pool.execute(
      `SELECT id FROM producer_artist_associations WHERE producer_user_id = ? AND artist_id = ? AND status NOT IN ('rejected')`,
      [req.user.id, artist_id]
    );
    if (existing.length) return res.status(409).json({ error: 'Une demande existe déjà pour cet artiste' });

    const id = uuidv4();
    await pool.execute(
      'INSERT INTO producer_artist_associations (id, producer_user_id, artist_id, message, status) VALUES (?, ?, ?, ?, ?)',
      [id, req.user.id, artist_id, message || null, 'pending']
    );
    await logActivity(req.user.id, 'association_request', 'Demande d\'association envoyée', message);
    await notifyProducer(req.user.id, 'association_pending', 'Demande envoyée', 'Votre demande d\'association est en attente de réponse de l\'artiste.');
    const [artistUsers] = await pool.execute('SELECT id FROM users WHERE artist_id = ?', [artist_id]);
    if (artistUsers[0]) {
      await pool.execute(
        'INSERT INTO artist_notifications (id, artist_user_id, type, title, message) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), artistUsers[0].id, 'association_request', 'Nouvelle demande producteur', message || 'Un producteur souhaite collaborer avec vous.']
      ).catch(() => {});
    }
    res.status(201).json({ id, status: 'pending', status_label: statusLabel('pending') });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur envoi demande' });
  }
});

router.get('/associations/admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT paa.*, a.name AS artist_name, a.image_url AS artist_image,
             u.email AS producer_email, u.full_name AS producer_user_name,
             (SELECT pa.company_name FROM producer_applications pa
              WHERE pa.user_id = paa.producer_user_id AND pa.status = 'approved'
              ORDER BY pa.created_at DESC LIMIT 1) AS producer_company
      FROM producer_artist_associations paa
      JOIN artists a ON a.id = paa.artist_id
      JOIN users u ON u.id = paa.producer_user_id
      WHERE 1=1`;
    const params = [];
    if (status && status !== 'all') {
      sql += ' AND paa.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY paa.created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows.map((r) => ({ ...r, status_label: statusLabel(r.status) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur chargement associations admin' });
  }
});

router.put('/associations/:id/admin-approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM producer_artist_associations WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Demande introuvable' });
    if (rows[0].status !== 'artist_accepted') {
      return res.status(400).json({ error: 'L\'artiste doit d\'abord accepter la demande' });
    }
    await pool.execute(
      `UPDATE producer_artist_associations SET status = 'admin_approved', admin_response_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    await notifyProducer(rows[0].producer_user_id, 'admin_approved', 'Association validée', 'L\'administrateur a approuvé votre collaboration.');
    await logActivity(rows[0].producer_user_id, 'admin_approved', 'Association approuvée par l\'admin');
    res.json({ success: true, status: 'admin_approved', status_label: statusLabel('admin_approved') });
  } catch (error) {
    res.status(500).json({ error: 'Erreur validation admin' });
  }
});

router.put('/associations/:id/admin-reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const [rows] = await pool.execute('SELECT * FROM producer_artist_associations WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Demande introuvable' });
    if (!['artist_accepted', 'pending'].includes(rows[0].status)) {
      return res.status(400).json({ error: 'Cette demande ne peut plus être rejetée' });
    }
    await pool.execute(
      `UPDATE producer_artist_associations SET status = 'rejected', admin_response_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    const msg = reason || 'Rejetée par l\'administrateur';
    await notifyProducer(rows[0].producer_user_id, 'admin_rejected', 'Association rejetée', msg);
    await logActivity(rows[0].producer_user_id, 'admin_rejected', 'Association rejetée par l\'admin', msg);
    res.json({ success: true, status: 'rejected', status_label: statusLabel('rejected') });
  } catch (error) {
    res.status(500).json({ error: 'Erreur rejet admin' });
  }
});

router.put('/associations/:id/suspend', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM producer_artist_associations WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Demande introuvable' });
    if (rows[0].status !== 'admin_approved') {
      return res.status(400).json({ error: 'Seules les associations actives peuvent être suspendues' });
    }
    await pool.execute(
      `UPDATE producer_artist_associations SET status = 'suspended', updated_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    await notifyProducer(rows[0].producer_user_id, 'association_suspended', 'Collaboration suspendue', 'L\'administrateur a suspendu cette association.');
    await logActivity(rows[0].producer_user_id, 'association_suspended', 'Association suspendue');
    res.json({ success: true, status: 'suspended', status_label: statusLabel('suspended') });
  } catch (error) {
    res.status(500).json({ error: 'Erreur suspension' });
  }
});

// ─── Catalog tracks ──────────────────────────────────────────────────────────

router.get('/catalog/tracks', authenticateToken, requireProducer, async (req, res) => {
  try {
    const { artist_id, status } = req.query;
    let sql = `SELECT t.*, a.name as artist_name FROM producer_catalog_tracks t
               JOIN artists a ON a.id = t.artist_id WHERE t.producer_user_id = ?`;
    const params = [req.user.id];
    if (artist_id) { sql += ' AND t.artist_id = ?'; params.push(artist_id); }
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    sql += ' ORDER BY t.created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows.map((r) => ({ ...r, status_label: statusLabel(r.status) })));
  } catch (error) {
    res.status(500).json({ error: 'Erreur catalogue' });
  }
});

router.post('/catalog/tracks', authenticateToken, requireProducer, upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]), async (req, res) => {
  try {
    const b = req.body;
    if (!b.title || !b.artist_id) return res.status(400).json({ error: 'Titre et artiste requis' });

    const [assoc] = await pool.execute(
      `SELECT id FROM producer_artist_associations WHERE producer_user_id = ? AND artist_id = ? AND status = 'admin_approved'`,
      [req.user.id, b.artist_id]
    );
    if (!assoc.length) return res.status(403).json({ error: 'Association admin approuvée requise pour publier' });

    const audioFile = req.files?.audio?.[0];
    const coverFile = req.files?.cover?.[0];
    if (!audioFile || !coverFile) {
      return res.status(400).json({ error: 'Audio WAV et cover 2000×2000 sont obligatoires' });
    }
    try {
      validateAudioFile(audioFile);
      validateCoverDimensions(coverFile);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    let audioUrl = await uploadToS3(audioFile, 'producer-tracks');
    let coverUrl = await uploadToS3(coverFile, 'producer-covers');

    const id = uuidv4();
    await pool.execute(
      `INSERT INTO producer_catalog_tracks
       (id, producer_user_id, artist_id, title, featuring, composer, author, producer_name, arranger,
        genre, language, isrc, release_date, cover_url, audio_url, lyrics, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, b.artist_id, b.title, b.featuring || null, b.composer || null, b.author || null,
        b.producer_name || null, b.arranger || null, b.genre || null, b.language || null, b.isrc || null,
        b.release_date || null, coverUrl, audioUrl, b.lyrics || null, b.status || 'draft']
    );
    await logActivity(req.user.id, 'track_created', `Chanson créée : ${b.title}`);
    res.status(201).json({ id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Erreur création chanson' });
  }
});

router.put('/catalog/tracks/:id', authenticateToken, requireProducer, upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]), async (req, res) => {
  try {
    const [existing] = await pool.execute(
      'SELECT * FROM producer_catalog_tracks WHERE id = ? AND producer_user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Chanson introuvable' });

    const b = req.body;
    let audioUrl = existing[0].audio_url;
    let coverUrl = existing[0].cover_url;
    if (req.files?.audio?.[0]) {
      try { validateAudioFile(req.files.audio[0]); } catch (e) { return res.status(400).json({ error: e.message }); }
      audioUrl = await uploadToS3(req.files.audio[0], 'producer-tracks');
    }
    if (req.files?.cover?.[0]) {
      try { validateCoverDimensions(req.files.cover[0]); } catch (e) { return res.status(400).json({ error: e.message }); }
      coverUrl = await uploadToS3(req.files.cover[0], 'producer-covers');
    }

    await pool.execute(
      `UPDATE producer_catalog_tracks SET title=?, featuring=?, composer=?, author=?, producer_name=?,
       arranger=?, genre=?, language=?, isrc=?, release_date=?, cover_url=?, audio_url=?, lyrics=?, status=?
       WHERE id = ?`,
      [b.title || existing[0].title, b.featuring, b.composer, b.author, b.producer_name, b.arranger,
        b.genre, b.language, b.isrc, b.release_date, coverUrl, audioUrl, b.lyrics, b.status || existing[0].status, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur mise à jour chanson' });
  }
});

router.delete('/catalog/tracks/:id', authenticateToken, requireProducer, async (req, res) => {
  try {
    await pool.execute('DELETE FROM producer_catalog_tracks WHERE id = ? AND producer_user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur suppression' });
  }
});

// ─── Catalog albums ──────────────────────────────────────────────────────────

router.get('/catalog/albums', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT al.*, a.name as artist_name FROM producer_catalog_albums al
       JOIN artists a ON a.id = al.artist_id WHERE al.producer_user_id = ? ORDER BY al.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erreur albums' });
  }
});

router.post('/catalog/albums', authenticateToken, requireProducer, upload.single('cover'), async (req, res) => {
  try {
    const { title, artist_id, release_date, description, status } = req.body;
    if (!title || !artist_id) return res.status(400).json({ error: 'Titre et artiste requis' });
    let coverUrl = null;
    if (req.file) coverUrl = await uploadToS3(req.file, 'producer-covers');
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO producer_catalog_albums (id, producer_user_id, artist_id, title, cover_url, release_date, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.user.id, artist_id, title, coverUrl, release_date || null, description || null, status || 'draft']
    );
    res.status(201).json({ id });
  } catch (error) {
    res.status(500).json({ error: 'Erreur création album' });
  }
});

// ─── Credits ─────────────────────────────────────────────────────────────────

router.get('/catalog/tracks/:id/credits', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM producer_track_credits WHERE track_id = ?', [req.params.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erreur crédits' });
  }
});

router.post('/catalog/tracks/:id/credits', authenticateToken, requireProducer, async (req, res) => {
  try {
    const { role, person_name } = req.body;
    if (!CREDIT_ROLES.includes(role) || !person_name) {
      return res.status(400).json({ error: 'Rôle et nom requis' });
    }
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO producer_track_credits (id, track_id, role, person_name) VALUES (?, ?, ?, ?)',
      [id, req.params.id, role, person_name]
    );
    res.status(201).json({ id });
  } catch (error) {
    res.status(500).json({ error: 'Erreur ajout crédit' });
  }
});

router.delete('/catalog/credits/:id', authenticateToken, requireProducer, async (req, res) => {
  await pool.execute('DELETE FROM producer_track_credits WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ─── Rights ──────────────────────────────────────────────────────────────────

router.get('/rights', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT r.*, t.title as track_title, a.name as artist_name
       FROM producer_track_rights r
       JOIN producer_catalog_tracks t ON t.id = r.track_id
       JOIN artists a ON a.id = t.artist_id
       WHERE t.producer_user_id = ?`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erreur droits' });
  }
});

router.put('/catalog/tracks/:id/rights', authenticateToken, requireProducer, async (req, res) => {
  try {
    const { artist_pct, producer_pct, composer_pct, author_pct, label_pct } = req.body;
    const total = Number(artist_pct) + Number(producer_pct) + Number(composer_pct) + Number(author_pct) + Number(label_pct);
    if (Math.abs(total - 100) > 0.01) {
      return res.status(400).json({ error: 'Le total des pourcentages doit être égal à 100%' });
    }
    const [existing] = await pool.execute('SELECT id FROM producer_track_rights WHERE track_id = ?', [req.params.id]);
    if (existing[0]) {
      await pool.execute(
        `UPDATE producer_track_rights SET artist_pct=?, producer_pct=?, composer_pct=?, author_pct=?, label_pct=? WHERE track_id=?`,
        [artist_pct, producer_pct, composer_pct, author_pct, label_pct, req.params.id]
      );
    } else {
      await pool.execute(
        `INSERT INTO producer_track_rights (id, track_id, artist_pct, producer_pct, composer_pct, author_pct, label_pct) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.params.id, artist_pct, producer_pct, composer_pct, author_pct, label_pct]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur répartition droits' });
  }
});

// ─── Historique streams ──────────────────────────────────────────────────────

router.get('/streams/history', authenticateToken, requireProducer, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const history = await getStreamHistory({ accountType: 'producer', userId: req.user.id, limit, offset });
    res.json(history);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur historique streams' });
  }
});

// ─── Revenue ─────────────────────────────────────────────────────────────────

router.get('/revenue', authenticateToken, requireProducer, async (req, res) => {
  try {
    const uid = req.user.id;
    const { artist_id, track_id, from, to } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const yearStart = `${new Date().getFullYear()}-01-01`;

    const sum = async (fromDate) => {
      const [[r]] = await pool.execute(
        'SELECT COALESCE(SUM(amount), 0) as t FROM producer_revenue WHERE producer_user_id = ? AND period_date >= ?',
        [uid, fromDate]
      );
      return Number(r.t);
    };

    let sql = `SELECT r.*, a.name as artist_name, t.title as track_title FROM producer_revenue r
               LEFT JOIN artists a ON a.id = r.artist_id LEFT JOIN producer_catalog_tracks t ON t.id = r.track_id
               WHERE r.producer_user_id = ?`;
    const params = [uid];
    if (artist_id) { sql += ' AND r.artist_id = ?'; params.push(artist_id); }
    if (track_id) { sql += ' AND r.track_id = ?'; params.push(track_id); }
    if (from) { sql += ' AND r.period_date >= ?'; params.push(from); }
    if (to) { sql += ' AND r.period_date <= ?'; params.push(to); }
    sql += ' ORDER BY r.period_date DESC LIMIT 200';
    const [entries] = await pool.execute(sql, params);

    const [byMonth] = await pool.execute(
      `SELECT DATE_FORMAT(period_date, '%Y-%m') as month, SUM(amount) as total FROM producer_revenue
       WHERE producer_user_id = ? GROUP BY month ORDER BY month`,
      [uid]
    );
    const [byArtist] = await pool.execute(
      `SELECT a.name as artist, SUM(r.amount) as total FROM producer_revenue r
       LEFT JOIN artists a ON a.id = r.artist_id WHERE r.producer_user_id = ? GROUP BY a.name`,
      [uid]
    );
    const [byTrack] = await pool.execute(
      `SELECT t.title as track, SUM(r.amount) as total FROM producer_revenue r
       LEFT JOIN producer_catalog_tracks t ON t.id = r.track_id WHERE r.producer_user_id = ? GROUP BY t.title`,
      [uid]
    );

    const payout = await getRoyaltyBalance('producer', uid);
    const payoutHistory = await getPayoutHistory('producer', uid, 20);
    const [streamEvents] = await pool.execute(
      `SELECT id, track_title, artist_name, is_premium, is_counted, skip_reason, producer_amount as amount, listened_at
       FROM counted_stream_events WHERE producer_user_id = ?
       ORDER BY listened_at DESC LIMIT 200`,
      [uid]
    );

    res.json({
      summary: {
        today: await sum(today),
        week: await sum(weekAgo),
        month: await sum(monthStart),
        year: await sum(yearStart),
        total: (await pool.execute('SELECT COALESCE(SUM(amount),0) as t FROM producer_revenue WHERE producer_user_id = ?', [uid]))[0][0].t,
      },
      payout,
      payoutHistory,
      streamEvents,
      rules: {
        stream_rate_usd: STREAM_RATE_USD,
        payout_threshold_usd: PAYOUT_THRESHOLD_USD,
        payout_frequency: 'trimestriel',
        forfeit_after_months: 9,
        premium_only: true,
        dedup_rule: '1 stream par titre par utilisateur premium toutes les 24h',
      },
      entries,
      charts: { byMonth, byArtist, byTrack },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur revenus' });
  }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

router.get('/analytics', authenticateToken, requireProducer, async (req, res) => {
  try {
    const uid = req.user.id;
    const [[plays]] = await pool.execute(
      'SELECT COALESCE(SUM(play_count), 0) as t FROM producer_catalog_tracks WHERE producer_user_id = ?', [uid]
    );
    const [[uniqueListeners]] = await pool.execute(
      `SELECT COALESCE(SUM(a.monthly_listeners), 0) as t FROM producer_artist_associations paa
       JOIN artists a ON a.id = paa.artist_id WHERE paa.producer_user_id = ? AND paa.status = 'admin_approved'`, [uid]
    );

    res.json({
      totalPlays: plays.t,
      uniqueListeners: uniqueListeners.t,
      countries: [
        { country: 'RDC', percent: 42 },
        { country: 'France', percent: 18 },
        { country: 'Belgique', percent: 12 },
        { country: 'USA', percent: 10 },
        { country: 'Autres', percent: 18 },
      ],
      cities: [
        { city: 'Kinshasa', percent: 35 },
        { city: 'Lubumbashi', percent: 12 },
        { city: 'Paris', percent: 8 },
        { city: 'Bruxelles', percent: 6 },
      ],
      devices: [
        { device: 'Mobile', percent: 68 },
        { device: 'Desktop', percent: 22 },
        { device: 'Tablette', percent: 10 },
      ],
      trafficSources: [
        { source: 'Recherche', percent: 40 },
        { source: 'Playlists', percent: 30 },
        { source: 'Profil artiste', percent: 20 },
        { source: 'Partages', percent: 10 },
      ],
      avgListenTime: '2:34',
      completionRate: 72,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur analytics' });
  }
});

// ─── Reports ─────────────────────────────────────────────────────────────────

router.get('/reports/summary', authenticateToken, requireProducer, async (req, res) => {
  try {
    const uid = req.user.id;
    const [tracks] = await pool.execute(
      'SELECT title, play_count, revenue FROM producer_catalog_tracks WHERE producer_user_id = ? ORDER BY play_count DESC',
      [uid]
    );
    const [artists] = await pool.execute(
      `SELECT a.name, COALESCE(SUM(t.play_count),0) as streams, COALESCE(SUM(t.revenue),0) as revenue
       FROM producer_artist_associations paa JOIN artists a ON a.id = paa.artist_id
       LEFT JOIN producer_catalog_tracks t ON t.artist_id = a.id AND t.producer_user_id = ?
       WHERE paa.producer_user_id = ? GROUP BY a.name ORDER BY streams DESC`,
      [uid, uid]
    );
    const [[rev]] = await pool.execute('SELECT COALESCE(SUM(amount),0) as t FROM producer_revenue WHERE producer_user_id = ?', [uid]);
    res.json({ tracks, artists, totalRevenue: rev.t, generatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Erreur rapport' });
  }
});

// ─── Notifications ───────────────────────────────────────────────────────────

router.get('/notifications', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM producer_notifications WHERE producer_user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erreur notifications' });
  }
});

router.put('/notifications/:id/read', authenticateToken, requireProducer, async (req, res) => {
  await pool.execute('UPDATE producer_notifications SET is_read = TRUE WHERE id = ? AND producer_user_id = ?', [req.params.id, req.user.id]);
  res.json({ success: true });
});

router.put('/notifications/read-all', authenticateToken, requireProducer, async (req, res) => {
  await pool.execute('UPDATE producer_notifications SET is_read = TRUE WHERE producer_user_id = ?', [req.user.id]);
  res.json({ success: true });
});

// ─── Settings ────────────────────────────────────────────────────────────────

router.get('/settings', authenticateToken, requireProducer, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM producer_settings WHERE user_id = ?', [req.user.id]);
    res.json(rows[0] || { user_id: req.user.id, theme: 'dark' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur paramètres' });
  }
});

router.put('/settings', authenticateToken, requireProducer, upload.single('logo'), async (req, res) => {
  try {
    const b = req.body;
    let logoUrl = b.logo_url;
    if (req.file) logoUrl = await uploadToS3(req.file, 'producer-logos');

    const [existing] = await pool.execute('SELECT user_id FROM producer_settings WHERE user_id = ?', [req.user.id]);
    const fields = {
      company_name: b.company_name, address: b.address, phone: b.phone, email: b.email,
      website: b.website, logo_url: logoUrl, payment_mobile_money: b.payment_mobile_money,
      payment_bank: b.payment_bank, payment_paypal: b.payment_paypal, payment_stripe: b.payment_stripe,
      two_factor_enabled: b.two_factor_enabled === 'true' || b.two_factor_enabled === true,
      theme: b.theme || 'dark',
    };

    if (existing[0]) {
      await pool.execute(
        `UPDATE producer_settings SET company_name=?, address=?, phone=?, email=?, website=?, logo_url=?,
         payment_mobile_money=?, payment_bank=?, payment_paypal=?, payment_stripe=?, two_factor_enabled=?, theme=? WHERE user_id=?`,
        [...Object.values(fields), req.user.id]
      );
    } else {
      await pool.execute(
        `INSERT INTO producer_settings (user_id, company_name, address, phone, email, website, logo_url,
         payment_mobile_money, payment_bank, payment_paypal, payment_stripe, two_factor_enabled, theme)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, ...Object.values(fields)]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur sauvegarde paramètres' });
  }
});

export default router;
