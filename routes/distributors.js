import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import requireAdmin from '../middleware/adminAuth.js';
import { uploadToS3 } from '../services/s3Service.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const DISTRIBUTION_PLATFORMS = [
  'Spotify', 'Apple Music', 'YouTube Music', 'Deezer', 'Amazon Music',
  'Boomplay', 'Audiomack', 'TikTok Music', 'Facebook Music', 'Instagram Music', 'TshaTshaStream',
];

const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export async function ensureDistributorTables() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_partnerships (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      partner_type ENUM('artist','producer','label') NOT NULL,
      artist_id VARCHAR(36) NULL,
      producer_user_id VARCHAR(36) NULL,
      label_name VARCHAR(255) NULL,
      label_country VARCHAR(100) NULL,
      label_logo_url TEXT NULL,
      invite_email VARCHAR(255) NULL,
      message TEXT,
      status ENUM('pending','accepted','rejected','active','suspended') DEFAULT 'pending',
      partner_response_at TIMESTAMP NULL,
      admin_response_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_distributor (distributor_user_id),
      INDEX idx_type (partner_type),
      INDEX idx_status (status),
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_catalog_submissions (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      release_type ENUM('single','ep','album','compilation') DEFAULT 'single',
      title VARCHAR(255) NOT NULL,
      artist_name VARCHAR(255) NOT NULL,
      producer_name VARCHAR(255),
      label_name VARCHAR(255),
      genre VARCHAR(100),
      composer VARCHAR(255),
      author VARCHAR(255),
      isrc VARCHAR(20),
      upc VARCHAR(20),
      release_date DATE,
      cover_url TEXT,
      audio_url TEXT,
      status ENUM('pending','in_review','approved','distributed','rejected','correction_requested') DEFAULT 'pending',
      validation_comment TEXT,
      play_count INT DEFAULT 0,
      revenue DECIMAL(12,2) DEFAULT 0,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_distributor (distributor_user_id),
      INDEX idx_status (status),
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_platform_distribution (
      id VARCHAR(36) PRIMARY KEY,
      catalog_id VARCHAR(36) NOT NULL,
      distributor_user_id VARCHAR(36) NOT NULL,
      platform VARCHAR(100) NOT NULL,
      status ENUM('pending','in_progress','distributed','rejected','removed') DEFAULT 'pending',
      published_at TIMESTAMP NULL,
      streams INT DEFAULT 0,
      revenue DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_catalog (catalog_id),
      INDEX idx_platform (platform),
      FOREIGN KEY (catalog_id) REFERENCES distributor_catalog_submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_revenue (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      catalog_id VARCHAR(36),
      platform VARCHAR(100),
      amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'USD',
      period_date DATE NOT NULL,
      source VARCHAR(100) DEFAULT 'streaming',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_distributor (distributor_user_id),
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_royalty_payments (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      recipient_name VARCHAR(255) NOT NULL,
      recipient_role VARCHAR(50),
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(50),
      status ENUM('pending','scheduled','completed') DEFAULT 'pending',
      payment_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_distributor (distributor_user_id),
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_settings (
      user_id VARCHAR(36) PRIMARY KEY,
      company_name VARCHAR(255),
      address TEXT,
      phone VARCHAR(50),
      email VARCHAR(255),
      website TEXT,
      logo_url TEXT,
      payment_bank TEXT,
      payment_mobile_money TEXT,
      payment_paypal TEXT,
      payment_stripe TEXT,
      two_factor_enabled BOOLEAN DEFAULT FALSE,
      theme ENUM('dark','light') DEFAULT 'dark',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_notifications (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_distributor (distributor_user_id),
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_activity (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      detail TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_distributor (distributor_user_id),
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_contracts (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      party_name VARCHAR(255) NOT NULL,
      contract_type VARCHAR(100),
      status VARCHAR(50) DEFAULT 'active',
      expires_at DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_licenses (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      work_title VARCHAR(255) NOT NULL,
      territory VARCHAR(255) DEFAULT 'Mondial',
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_disputes (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      work_title VARCHAR(255),
      claimant VARCHAR(255),
      status VARCHAR(50) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS distributor_copyright_claims (
      id VARCHAR(36) PRIMARY KEY,
      distributor_user_id VARCHAR(36) NOT NULL,
      platform VARCHAR(100),
      work_title VARCHAR(255),
      status VARCHAR(50) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);
}

async function requireDistributor(req, res, next) {
  try {
    const [users] = await pool.execute('SELECT is_distributor FROM users WHERE id = ?', [req.user.id]);
    if (users[0]?.is_distributor) return next();
    const [apps] = await pool.execute(
      'SELECT status FROM distributor_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );
    if (apps[0]?.status === 'approved') return next();
    return res.status(403).json({ error: 'Compte distributeur approuvé requis' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur vérification distributeur' });
  }
}

async function logActivity(uid, type, title, detail = null) {
  await pool.execute(
    'INSERT INTO distributor_activity (id, distributor_user_id, type, title, detail) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), uid, type, title, detail]
  );
}

async function notify(uid, type, title, message = '') {
  await pool.execute(
    'INSERT INTO distributor_notifications (id, distributor_user_id, type, title, message) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), uid, type, title, message]
  );
}

function statusLabel(status) {
  const map = {
    pending: 'En attente', accepted: 'Accepté', rejected: 'Refusé', active: 'Actif', suspended: 'Suspendu',
    in_review: 'En validation', approved: 'Approuvé', distributed: 'Distribué', correction_requested: 'Correction demandée',
    in_progress: 'En cours', removed: 'Supprimé', scheduled: 'Programmé', completed: 'Effectué',
  };
  return map[status] || status;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

router.get('/dashboard', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const uid = req.user.id;
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

    const count = async (sql, params = [uid]) => (await pool.execute(sql, params))[0][0].c;

    const stats = {
      partnerArtists: await count(`SELECT COUNT(*) as c FROM distributor_partnerships WHERE distributor_user_id=? AND partner_type='artist' AND status='active'`),
      partnerProducers: await count(`SELECT COUNT(*) as c FROM distributor_partnerships WHERE distributor_user_id=? AND partner_type='producer' AND status='active'`),
      partnerLabels: await count(`SELECT COUNT(*) as c FROM distributor_partnerships WHERE distributor_user_id=? AND partner_type='label' AND status='active'`),
      totalTracks: await count(`SELECT COUNT(*) as c FROM distributor_catalog_submissions WHERE distributor_user_id=? AND release_type IN ('single','ep')`),
      totalAlbums: await count(`SELECT COUNT(*) as c FROM distributor_catalog_submissions WHERE distributor_user_id=? AND release_type IN ('album','compilation')`),
      pendingPublications: await count(`SELECT COUNT(*) as c FROM distributor_catalog_submissions WHERE distributor_user_id=? AND status IN ('pending','in_review','correction_requested')`),
      distributedPublications: await count(`SELECT COUNT(*) as c FROM distributor_catalog_submissions WHERE distributor_user_id=? AND status='distributed'`),
      monthRevenue: Number((await pool.execute('SELECT COALESCE(SUM(amount),0) as c FROM distributor_revenue WHERE distributor_user_id=? AND period_date>=?', [uid, monthStart]))[0][0].c),
      totalRevenue: Number((await pool.execute('SELECT COALESCE(SUM(amount),0) as c FROM distributor_revenue WHERE distributor_user_id=?', [uid]))[0][0].c),
      connectedPlatforms: DISTRIBUTION_PLATFORMS.length,
    };

    const [revenueByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(period_date,'%Y-%m') as month, COALESCE(SUM(amount),0) as total FROM distributor_revenue WHERE distributor_user_id=? GROUP BY month ORDER BY month LIMIT 12`, [uid]
    );
    const [streamsByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(submitted_at,'%Y-%m') as month, COALESCE(SUM(play_count),0) as total FROM distributor_catalog_submissions WHERE distributor_user_id=? GROUP BY month ORDER BY month LIMIT 12`, [uid]
    );
    const [distributionByPlatform] = await pool.execute(
      `SELECT platform as label, COALESCE(SUM(streams),0) as total FROM distributor_platform_distribution WHERE distributor_user_id=? GROUP BY platform ORDER BY total DESC`, [uid]
    );
    const [topArtists] = await pool.execute(
      `SELECT artist_name as name, COALESCE(SUM(play_count),0) as streams, COALESCE(SUM(revenue),0) as revenue FROM distributor_catalog_submissions WHERE distributor_user_id=? GROUP BY artist_name ORDER BY streams DESC LIMIT 5`, [uid]
    );
    const [topTracks] = await pool.execute(
      `SELECT title, artist_name as artist, play_count as streams FROM distributor_catalog_submissions WHERE distributor_user_id=? ORDER BY play_count DESC LIMIT 5`, [uid]
    );
    const [topAlbums] = await pool.execute(
      `SELECT title, artist_name as artist, play_count as streams FROM distributor_catalog_submissions WHERE distributor_user_id=? AND release_type IN ('album','compilation') ORDER BY play_count DESC LIMIT 5`, [uid]
    );
    const [recentActivity] = await pool.execute(
      'SELECT * FROM distributor_activity WHERE distributor_user_id=? ORDER BY created_at DESC LIMIT 15', [uid]
    );

    res.json({
      stats,
      charts: {
        revenueByMonth,
        streamsByMonth,
        distributionByPlatform: distributionByPlatform.map((r) => ({ label: r.label, value: Number(r.total) })),
        topArtists,
        topTracks,
        topAlbums,
      },
      recentActivity,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur dashboard distributeur' });
  }
});

// ─── Partners ────────────────────────────────────────────────────────────────

router.get('/partners/artists', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, a.name, a.image_url, a.genre, a.country,
              (SELECT COUNT(*) FROM distributor_catalog_submissions c WHERE c.distributor_user_id=p.distributor_user_id AND c.artist_name=a.name) as releases,
              (SELECT COALESCE(SUM(revenue),0) FROM distributor_catalog_submissions c WHERE c.distributor_user_id=p.distributor_user_id AND c.artist_name=a.name) as revenue
       FROM distributor_partnerships p JOIN artists a ON a.id=p.artist_id
       WHERE p.distributor_user_id=? AND p.partner_type='artist' AND p.status IN ('active','accepted','pending')
       ORDER BY a.name`, [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, status_label: statusLabel(r.status) })));
  } catch (e) { res.status(500).json({ error: 'Erreur artistes partenaires' }); }
});

router.get('/partners/producers', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, u.full_name, u.email,
              (SELECT company_name FROM producer_applications pa WHERE pa.user_id=p.producer_user_id AND pa.status='approved' ORDER BY created_at DESC LIMIT 1) as company,
              (SELECT COUNT(*) FROM producer_artist_associations paa WHERE paa.producer_user_id=p.producer_user_id AND paa.status='admin_approved') as artists_managed
       FROM distributor_partnerships p JOIN users u ON u.id=p.producer_user_id
       WHERE p.distributor_user_id=? AND p.partner_type='producer' AND p.status IN ('active','accepted','pending')
       ORDER BY company`, [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, company: r.company || r.full_name, status_label: statusLabel(r.status) })));
  } catch (e) { res.status(500).json({ error: 'Erreur producteurs partenaires' }); }
});

router.get('/partners/labels', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*,
              (SELECT COUNT(DISTINCT artist_name) FROM distributor_catalog_submissions c WHERE c.distributor_user_id=p.distributor_user_id AND c.label_name=p.label_name) as artists,
              (SELECT COUNT(*) FROM distributor_catalog_submissions c WHERE c.distributor_user_id=p.distributor_user_id AND c.label_name=p.label_name) as releases,
              (SELECT COALESCE(SUM(revenue),0) FROM distributor_catalog_submissions c WHERE c.distributor_user_id=p.distributor_user_id AND c.label_name=p.label_name) as revenue
       FROM distributor_partnerships p
       WHERE p.distributor_user_id=? AND p.partner_type='label' AND p.status IN ('active','accepted','pending')
       ORDER BY p.label_name`, [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, name: r.label_name, status_label: statusLabel(r.status) })));
  } catch (e) { res.status(500).json({ error: 'Erreur labels partenaires' }); }
});

router.get('/partnerships', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const { type } = req.query;
    let sql = 'SELECT * FROM distributor_partnerships WHERE distributor_user_id=?';
    const params = [req.user.id];
    if (type) { sql += ' AND partner_type=?'; params.push(type); }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows.map((r) => ({
      ...r,
      name: r.label_name || r.invite_email || r.partner_type,
      status_label: statusLabel(r.status),
    })));
  } catch (e) { res.status(500).json({ error: 'Erreur partenariats' }); }
});

router.post('/partnerships', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const { partner_type, artist_id, producer_user_id, label_name, label_country, invite_email, message } = req.body;
    if (!partner_type) return res.status(400).json({ error: 'partner_type requis' });
    const id = uuidv4();
    await pool.execute(
      `INSERT INTO distributor_partnerships (id, distributor_user_id, partner_type, artist_id, producer_user_id, label_name, label_country, invite_email, message, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, req.user.id, partner_type, artist_id || null, producer_user_id || null, label_name || null, label_country || null, invite_email || null, message || null]
    );
    await logActivity(req.user.id, 'partnership_invite', `Invitation ${partner_type} envoyée`, message);
    await notify(req.user.id, 'partnership', 'Invitation envoyée', `Partenariat ${partner_type} en attente`);
    res.status(201).json({ id, status: 'pending', status_label: statusLabel('pending') });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur envoi invitation' });
  }
});

router.get('/artists/search', authenticateToken, requireDistributor, async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const [rows] = await pool.execute('SELECT id, name, image_url, genre, country FROM artists WHERE name LIKE ? ORDER BY name LIMIT 20', [q]);
  res.json(rows);
});

router.put('/partnerships/:id/admin-activate', authenticateToken, requireAdmin, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM distributor_partnerships WHERE id=?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Partenariat introuvable' });
  if (rows[0].status !== 'accepted') return res.status(400).json({ error: 'Le partenaire doit d\'abord accepter' });
  await pool.execute(`UPDATE distributor_partnerships SET status='active', admin_response_at=NOW() WHERE id=?`, [req.params.id]);
  await notify(rows[0].distributor_user_id, 'partnership_active', 'Partenariat activé', 'Validé par l\'administrateur');
  res.json({ success: true });
});

// ─── Catalog ─────────────────────────────────────────────────────────────────

router.get('/catalog', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const { type, status, artist, label } = req.query;
    let sql = 'SELECT * FROM distributor_catalog_submissions WHERE distributor_user_id=?';
    const params = [req.user.id];
    if (type) { sql += ' AND release_type=?'; params.push(type); }
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (artist) { sql += ' AND artist_name=?'; params.push(artist); }
    if (label) { sql += ' AND label_name=?'; params.push(label); }
    sql += ' ORDER BY submitted_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows.map((r) => ({ ...r, type: r.release_type, status_label: statusLabel(r.status), submittedAt: r.submitted_at })));
  } catch (e) { res.status(500).json({ error: 'Erreur catalogue' }); }
});

router.post('/catalog', authenticateToken, requireDistributor, upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  try {
    const b = req.body;
    let audioUrl = b.audio_url || null;
    let coverUrl = b.cover_url || null;
    if (req.files?.audio?.[0]) audioUrl = await uploadToS3(req.files.audio[0], 'distributor-audio');
    if (req.files?.cover?.[0]) coverUrl = await uploadToS3(req.files.cover[0], 'distributor-covers');
    const id = uuidv4();
    await pool.execute(
      `INSERT INTO distributor_catalog_submissions
       (id, distributor_user_id, release_type, title, artist_name, producer_name, label_name, genre, composer, author, isrc, upc, release_date, cover_url, audio_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, req.user.id, b.release_type || 'single', b.title, b.artist_name, b.producer_name, b.label_name, b.genre, b.composer, b.author, b.isrc, b.upc, b.release_date || null, coverUrl, audioUrl]
    );
    await logActivity(req.user.id, 'submission', `Soumission : ${b.title}`, b.artist_name);
    await notify(req.user.id, 'submission', 'Nouvelle soumission', b.title);
    res.status(201).json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur soumission' });
  }
});

router.get('/publications', authenticateToken, requireDistributor, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT * FROM distributor_catalog_submissions WHERE distributor_user_id=? AND status!='rejected' ORDER BY submitted_at DESC`, [req.user.id]
  );
  res.json(rows.map((r) => ({ ...r, type: r.release_type, status_label: statusLabel(r.status) })));
});

router.get('/validation/queue', authenticateToken, requireDistributor, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT * FROM distributor_catalog_submissions WHERE distributor_user_id=? AND status IN ('pending','in_review','correction_requested') ORDER BY submitted_at ASC`, [req.user.id]
  );
  res.json(rows.map((r) => ({ ...r, status_label: statusLabel(r.status) })));
});

router.put('/catalog/:id/validate', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const { action, comment } = req.body;
    const statusMap = { approve: 'approved', reject: 'rejected', correction: 'correction_requested' };
    const status = statusMap[action];
    if (!status) return res.status(400).json({ error: 'action invalide' });
    if ((action === 'reject' || action === 'correction') && !comment?.trim()) {
      return res.status(400).json({ error: 'Commentaire obligatoire' });
    }
    const [rows] = await pool.execute('SELECT * FROM distributor_catalog_submissions WHERE id=? AND distributor_user_id=?', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Œuvre introuvable' });
    await pool.execute('UPDATE distributor_catalog_submissions SET status=?, validation_comment=? WHERE id=?', [status, comment || null, req.params.id]);
    await logActivity(req.user.id, 'validation', `Validation : ${rows[0].title}`, action);
    await notify(req.user.id, 'validation', `Contenu ${statusLabel(status)}`, rows[0].title);
    res.json({ success: true, status, status_label: statusLabel(status) });
  } catch (e) { res.status(500).json({ error: 'Erreur validation' }); }
});

// ─── Distribution ────────────────────────────────────────────────────────────

router.get('/distribution/platforms', authenticateToken, requireDistributor, async (req, res) => {
  res.json(DISTRIBUTION_PLATFORMS);
});

router.get('/distribution', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const { catalog_id } = req.query;
    let sql = `SELECT d.*, c.title, c.artist_name FROM distributor_platform_distribution d
               JOIN distributor_catalog_submissions c ON c.id=d.catalog_id WHERE d.distributor_user_id=?`;
    const params = [req.user.id];
    if (catalog_id) { sql += ' AND d.catalog_id=?'; params.push(catalog_id); }
    const [rows] = await pool.execute(sql, params);
    res.json(rows.map((r) => ({ ...r, platform: r.platform, status_label: statusLabel(r.status) })));
  } catch (e) { res.status(500).json({ error: 'Erreur distribution' }); }
});

router.post('/catalog/:id/distribute', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const [cat] = await pool.execute('SELECT * FROM distributor_catalog_submissions WHERE id=? AND distributor_user_id=? AND status=?', [req.params.id, req.user.id, 'approved']);
    if (!cat[0]) return res.status(400).json({ error: 'Œuvre approuvée requise' });
    for (const platform of DISTRIBUTION_PLATFORMS) {
      const [ex] = await pool.execute('SELECT id FROM distributor_platform_distribution WHERE catalog_id=? AND platform=?', [req.params.id, platform]);
      if (!ex.length) {
        await pool.execute(
          'INSERT INTO distributor_platform_distribution (id, catalog_id, distributor_user_id, platform, status) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), req.params.id, req.user.id, platform, 'in_progress']
        );
      }
    }
    await pool.execute(`UPDATE distributor_catalog_submissions SET status='distributed' WHERE id=?`, [req.params.id]);
    await logActivity(req.user.id, 'distribution', `Distribution lancée : ${cat[0].title}`);
    await notify(req.user.id, 'distribution', 'Distribution en cours', cat[0].title);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur lancement distribution' }); }
});

router.get('/distribution/:catalogId/timeline', authenticateToken, requireDistributor, async (req, res) => {
  const [cat] = await pool.execute('SELECT * FROM distributor_catalog_submissions WHERE id=? AND distributor_user_id=?', [req.params.catalogId, req.user.id]);
  if (!cat[0]) return res.status(404).json({ error: 'Introuvable' });
  const timeline = [
    { date: cat[0].submitted_at, event: 'Soumission reçue', status: 'done' },
    { date: cat[0].updated_at, event: cat[0].status === 'approved' || cat[0].status === 'distributed' ? 'Validation métadonnées' : 'En cours de validation', status: ['approved','distributed'].includes(cat[0].status) ? 'done' : 'active' },
  ];
  if (cat[0].status === 'distributed') {
    timeline.push({ date: cat[0].updated_at, event: 'Distribution aux plateformes', status: 'done' });
  }
  const [platforms] = await pool.execute('SELECT platform, status FROM distributor_platform_distribution WHERE catalog_id=?', [req.params.catalogId]);
  platforms.forEach((p) => {
    timeline.push({ date: new Date().toISOString(), event: `${p.platform} — ${statusLabel(p.status)}`, status: p.status === 'distributed' ? 'done' : 'pending' });
  });
  res.json(timeline);
});

// ─── Revenue & Royalties ───────────────────────────────────────────────────

router.get('/revenue', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const sum = async (from) => Number((await pool.execute('SELECT COALESCE(SUM(amount),0) as t FROM distributor_revenue WHERE distributor_user_id=? AND period_date>=?', [uid, from]))[0][0].t);

    const [byMonth] = await pool.execute(`SELECT DATE_FORMAT(period_date,'%Y-%m') as month, SUM(amount) as total FROM distributor_revenue WHERE distributor_user_id=? GROUP BY month ORDER BY month`, [uid]);
    const [byArtist] = await pool.execute(
      `SELECT c.artist_name as name, SUM(r.amount) as total FROM distributor_revenue r
       JOIN distributor_catalog_submissions c ON c.id=r.catalog_id WHERE r.distributor_user_id=? GROUP BY c.artist_name`, [uid]
    );
    const [byPlatform] = await pool.execute(`SELECT platform as name, SUM(amount) as total FROM distributor_revenue WHERE distributor_user_id=? GROUP BY platform`, [uid]);
    const [byLabel] = await pool.execute(
      `SELECT c.label_name as name, SUM(r.amount) as total FROM distributor_revenue r
       JOIN distributor_catalog_submissions c ON c.id=r.catalog_id WHERE r.distributor_user_id=? AND c.label_name IS NOT NULL GROUP BY c.label_name`, [uid]
    );
    const [entries] = await pool.execute(`SELECT * FROM distributor_revenue WHERE distributor_user_id=? ORDER BY period_date DESC LIMIT 200`, [uid]);

    res.json({
      summary: { today: await sum(today), week: await sum(weekAgo), month: await sum(monthStart), year: await sum(yearStart), total: await sum('1970-01-01') },
      charts: { byMonth, byArtist, byPlatform, byLabel },
      entries,
    });
  } catch (e) { res.status(500).json({ error: 'Erreur revenus' }); }
});

router.get('/royalties', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const uid = req.user.id;
    const [[gross]] = await pool.execute('SELECT COALESCE(SUM(amount),0) as t FROM distributor_revenue WHERE distributor_user_id=?', [uid]);
    const grossVal = Number(gross.t);
    const commission = grossVal * 0.15;
    const net = grossVal - commission;
    const [payments] = await pool.execute('SELECT * FROM distributor_royalty_payments WHERE distributor_user_id=? ORDER BY payment_date DESC', [uid]);
    res.json({
      gross: grossVal,
      distributorCommission: commission,
      net,
      splits: [
        { role: 'Artiste', percent: 45, amount: net * 0.45 },
        { role: 'Producteur', percent: 25, amount: net * 0.25 },
        { role: 'Label', percent: 15, amount: net * 0.15 },
        { role: 'Compositeur', percent: 10, amount: net * 0.10 },
        { role: 'Auteur', percent: 5, amount: net * 0.05 },
      ],
      paymentHistory: payments,
    });
  } catch (e) { res.status(500).json({ error: 'Erreur royalties' }); }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

router.get('/analytics', authenticateToken, requireDistributor, async (req, res) => {
  try {
    const uid = req.user.id;
    const [[plays]] = await pool.execute('SELECT COALESCE(SUM(play_count),0) as t FROM distributor_catalog_submissions WHERE distributor_user_id=?', [uid]);
    const [platformPerf] = await pool.execute(
      `SELECT platform, COALESCE(SUM(streams),0) as streams, COALESCE(SUM(revenue),0) as revenue FROM distributor_platform_distribution WHERE distributor_user_id=? GROUP BY platform ORDER BY streams DESC`, [uid]
    );
    res.json({
      totalStreams: plays.t,
      uniqueListeners: Math.round(plays.t * 0.23),
      listenTime: '3:12',
      completionRate: 68,
      countries: [{ name: 'RDC', percent: 48 }, { name: 'France', percent: 14 }, { name: 'Belgique', percent: 10 }, { name: 'Autres', percent: 28 }],
      provinces: [{ name: 'Kinshasa', percent: 35 }, { name: 'Katanga', percent: 12 }],
      cities: [{ name: 'Kinshasa', percent: 35 }, { name: 'Lubumbashi', percent: 10 }, { name: 'Paris', percent: 6 }],
      platformPerformance: platformPerf,
    });
  } catch (e) { res.status(500).json({ error: 'Erreur analytics' }); }
});

// ─── Reports ─────────────────────────────────────────────────────────────────

router.get('/reports/summary', authenticateToken, requireDistributor, async (req, res) => {
  const uid = req.user.id;
  const [tracks] = await pool.execute('SELECT title, play_count, revenue FROM distributor_catalog_submissions WHERE distributor_user_id=? ORDER BY play_count DESC', [uid]);
  const [artists] = await pool.execute(
    `SELECT artist_name as name, SUM(play_count) as streams, SUM(revenue) as revenue FROM distributor_catalog_submissions WHERE distributor_user_id=? GROUP BY artist_name ORDER BY streams DESC`, [uid]
  );
  const [[rev]] = await pool.execute('SELECT COALESCE(SUM(amount),0) as t FROM distributor_revenue WHERE distributor_user_id=?', [uid]);
  const [byMonth] = await pool.execute(`SELECT DATE_FORMAT(period_date,'%Y-%m') as month, SUM(amount) as total FROM distributor_revenue WHERE distributor_user_id=? GROUP BY month`, [uid]);
  res.json({ tracks, artists, totalRevenue: rev.t, monthlyRevenue: byMonth, generatedAt: new Date().toISOString() });
});

// ─── Notifications & Settings ────────────────────────────────────────────────

router.get('/notifications', authenticateToken, requireDistributor, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM distributor_notifications WHERE distributor_user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json(rows.map((r) => ({ ...r, date: r.created_at, read: r.is_read })));
});

router.put('/notifications/read-all', authenticateToken, requireDistributor, async (req, res) => {
  await pool.execute('UPDATE distributor_notifications SET is_read=TRUE WHERE distributor_user_id=?', [req.user.id]);
  res.json({ success: true });
});

router.get('/settings', authenticateToken, requireDistributor, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM distributor_settings WHERE user_id=?', [req.user.id]);
  res.json(rows[0] || { user_id: req.user.id, theme: 'dark' });
});

router.put('/settings', authenticateToken, requireDistributor, upload.single('logo'), async (req, res) => {
  try {
    const b = req.body;
    let logoUrl = b.logo_url;
    if (req.file) logoUrl = await uploadToS3(req.file, 'distributor-logos');
    const fields = [b.company_name, b.address, b.phone, b.email, b.website, logoUrl, b.payment_bank, b.payment_mobile_money, b.payment_paypal, b.payment_stripe, b.two_factor_enabled === 'true' || b.two_factor_enabled === true, b.theme || 'dark'];
    const [ex] = await pool.execute('SELECT user_id FROM distributor_settings WHERE user_id=?', [req.user.id]);
    if (ex[0]) {
      await pool.execute(`UPDATE distributor_settings SET company_name=?, address=?, phone=?, email=?, website=?, logo_url=?, payment_bank=?, payment_mobile_money=?, payment_paypal=?, payment_stripe=?, two_factor_enabled=?, theme=? WHERE user_id=?`, [...fields, req.user.id]);
    } else {
      await pool.execute(`INSERT INTO distributor_settings (user_id, company_name, address, phone, email, website, logo_url, payment_bank, payment_mobile_money, payment_paypal, payment_stripe, two_factor_enabled, theme) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.user.id, ...fields]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur paramètres' }); }
});

// ─── Admin internal ──────────────────────────────────────────────────────────

router.get('/admin', authenticateToken, requireDistributor, async (req, res) => {
  const uid = req.user.id;
  const [contracts] = await pool.execute('SELECT * FROM distributor_contracts WHERE distributor_user_id=?', [uid]);
  const [licenses] = await pool.execute('SELECT * FROM distributor_licenses WHERE distributor_user_id=?', [uid]);
  const [disputes] = await pool.execute('SELECT * FROM distributor_disputes WHERE distributor_user_id=?', [uid]);
  const [copyrightClaims] = await pool.execute('SELECT * FROM distributor_copyright_claims WHERE distributor_user_id=?', [uid]);
  res.json({ contracts, licenses, disputes, copyrightClaims });
});

router.post('/admin/contracts', authenticateToken, requireDistributor, async (req, res) => {
  const { party_name, contract_type, expires_at } = req.body;
  const id = uuidv4();
  await pool.execute('INSERT INTO distributor_contracts (id, distributor_user_id, party_name, contract_type, expires_at) VALUES (?, ?, ?, ?, ?)', [id, req.user.id, party_name, contract_type, expires_at || null]);
  res.status(201).json({ id });
});

export default router;
