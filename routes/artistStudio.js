import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import { uploadToS3 } from '../services/s3Service.js';
import { buildPercentDistribution, formatListenDuration } from '../utils/listenAnalytics.js';
import {
  getRoyaltyBalance, getPayoutHistory, getStreamHistory,
  STREAM_RATE_USD, PAYOUT_THRESHOLD_USD,
} from '../services/streamRoyaltyService.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export async function ensureArtistStudioTables() {
  const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS artist_revenue (
      id VARCHAR(36) PRIMARY KEY,
      artist_user_id VARCHAR(36) NOT NULL,
      track_id VARCHAR(36),
      amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'USD',
      period_date DATE NOT NULL,
      source VARCHAR(100) DEFAULT 'streaming',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_artist_user (artist_user_id),
      INDEX idx_period (period_date),
      FOREIGN KEY (artist_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS artist_settings (
      user_id VARCHAR(36) PRIMARY KEY,
      display_name VARCHAR(255),
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
    CREATE TABLE IF NOT EXISTS artist_notifications (
      id VARCHAR(36) PRIMARY KEY,
      artist_user_id VARCHAR(36) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_artist_user (artist_user_id),
      INDEX idx_read (is_read),
      FOREIGN KEY (artist_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS artist_activity (
      id VARCHAR(36) PRIMARY KEY,
      artist_user_id VARCHAR(36) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      detail TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_artist_user (artist_user_id),
      FOREIGN KEY (artist_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await ensureListeningAnalyticsColumns();
}

export async function ensureListeningAnalyticsColumns() {
  const cols = [
    ['source', "VARCHAR(50) DEFAULT 'direct'"],
    ['device', 'VARCHAR(50) NULL'],
    ['country', 'VARCHAR(100) NULL'],
    ['city', 'VARCHAR(100) NULL'],
    ['completion_percent', 'TINYINT UNSIGNED NULL'],
  ];
  for (const [col, def] of cols) {
    try {
      await pool.execute(`ALTER TABLE listening_history ADD COLUMN ${col} ${def}`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
  }
  await pool.execute(
    `UPDATE listening_history SET device = 'Desktop', source = 'direct' WHERE device IS NULL`
  ).catch(() => {});
}

const CITY_TO_PROVINCE = {
  Kinshasa: 'Kinshasa',
  Lubumbashi: 'Katanga',
  Kisangani: 'Tshopo',
  Goma: 'Nord-Kivu',
  Paris: 'Île-de-France',
  Bruxelles: 'Bruxelles',
  'New York': 'New York',
};

const SOURCE_LABELS = {
  direct: 'Lecture directe',
  search: 'Recherche',
  playlist: 'Playlists',
  artist_profile: 'Profil artiste',
  share: 'Partages',
  trending: 'Tendances',
  album: 'Album',
};

function provincesFromCityCounts(cityRows) {
  const agg = {};
  for (const row of cityRows) {
    const prov = CITY_TO_PROVINCE[row.name] || row.name;
    agg[prov] = (agg[prov] || 0) + Number(row.count || 0);
  }
  return buildPercentDistribution(
    Object.entries(agg).map(([name, count]) => ({ name, count }))
  );
}

async function resolveArtist(userId) {
  const [users] = await pool.execute('SELECT artist_id FROM users WHERE id = ?', [userId]);
  if (users[0]?.artist_id) {
    const [artists] = await pool.execute('SELECT id, name FROM artists WHERE id = ?', [users[0].artist_id]);
    if (artists[0]) return { artistId: artists[0].id, artistName: artists[0].name };
  }
  const [applications] = await pool.execute(
    'SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = "approved" ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  if (applications[0]) {
    const artistName = applications[0].artist_name;
    const [artists] = await pool.execute('SELECT id, name FROM artists WHERE name = ?', [artistName]);
    if (artists[0]) return { artistId: artists[0].id, artistName: artists[0].name };
    return { artistId: null, artistName };
  }
  return null;
}

async function requireArtist(req, res, next) {
  try {
    const [users] = await pool.execute('SELECT is_artist FROM users WHERE id = ?', [req.user.id]);
    if (users[0]?.is_artist) return next();
    const [apps] = await pool.execute(
      'SELECT status FROM artist_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );
    if (apps[0]?.status === 'approved') return next();
    return res.status(403).json({ error: 'Compte artiste approuvé requis' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur de vérification artiste' });
  }
}

async function logActivity(userId, type, title, detail = null) {
  await pool.execute(
    'INSERT INTO artist_activity (id, artist_user_id, type, title, detail) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), userId, type, title, detail]
  );
}

/** Streams premium comptés (monétisables) */
const SQL_TRACK_PLAYS_SUM = `
  SELECT COALESCE(COUNT(*), 0) as t
  FROM counted_stream_events
  WHERE artist_user_id = ? AND is_counted = TRUE
`;

const SQL_TOP_TRACKS = `
  SELECT track_id as id, track_title as title, COUNT(*) as play_count
  FROM counted_stream_events
  WHERE artist_user_id = ? AND is_counted = TRUE
  GROUP BY track_id, track_title
  ORDER BY play_count DESC
`;

const SQL_PLAYS_BY_MONTH = `
  SELECT DATE_FORMAT(listened_at, '%Y-%m') as month, COUNT(*) as total
  FROM counted_stream_events
  WHERE artist_user_id = ? AND is_counted = TRUE
  GROUP BY DATE_FORMAT(listened_at, '%Y-%m')
  ORDER BY month ASC
  LIMIT 12
`;

// ─── Dashboard ───────────────────────────────────────────────────────────────

router.get('/dashboard', authenticateToken, requireArtist, async (req, res) => {
  try {
    const uid = req.user.id;
    const artist = await resolveArtist(uid);
    if (!artist) return res.status(404).json({ error: 'Profil artiste introuvable' });

    const { artistId, artistName } = artist;
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

    const [[trackCount]] = await pool.execute(
      'SELECT COUNT(*) as c FROM music WHERE LOWER(artist_name) = LOWER(?)',
      [artistName]
    );
    const [[albumCount]] = await pool.execute(
      'SELECT COUNT(*) as c FROM albums WHERE LOWER(artist_name) = LOWER(?)',
      [artistName]
    );
    const [[artistRow]] = artistId
      ? await pool.execute('SELECT total_plays, monthly_listeners FROM artists WHERE id = ?', [artistId])
      : await pool.execute('SELECT total_plays, monthly_listeners FROM artists WHERE LOWER(name) = LOWER(?)', [artistName]);
    const followers = artistId
      ? (await pool.execute('SELECT COUNT(*) as c FROM artist_follows WHERE artist_id = ?', [artistId]))[0][0]
      : { c: 0 };
    const [[likes]] = await pool.execute(
      `SELECT COUNT(*) as c FROM liked_song ls JOIN music m ON ls.song_id = m.id WHERE LOWER(m.artist_name) = LOWER(?)`,
      [artistName]
    );
    const pendingAssoc = artistId
      ? (await pool.execute(
          `SELECT COUNT(*) as c FROM producer_artist_associations WHERE artist_id = ? AND status = 'pending'`,
          [artistId]
        ))[0][0]
      : { c: 0 };
    const [[monthRevenue]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) as c FROM artist_revenue WHERE artist_user_id = ? AND period_date >= ?',
      [uid, monthStart]
    );
    const [[totalRevenue]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) as c FROM artist_revenue WHERE artist_user_id = ?',
      [uid]
    );

    const [[premiumStreams]] = await pool.execute(SQL_TRACK_PLAYS_SUM, [uid]);
    const [topTracks] = await pool.execute(`${SQL_TOP_TRACKS} LIMIT 5`, [uid]);
    const [playsByMonth] = await pool.execute(SQL_PLAYS_BY_MONTH, [uid]);
    const payout = await getRoyaltyBalance('artist', uid);
    const payoutHistory = await getPayoutHistory('artist', uid, 10);

    const [revenueByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(period_date, '%Y-%m') as month, COALESCE(SUM(amount), 0) as total
       FROM artist_revenue WHERE artist_user_id = ? GROUP BY month ORDER BY month ASC LIMIT 12`,
      [uid]
    );

    const [revenueByTrack] = await pool.execute(
      `SELECT m.title as track, COALESCE(SUM(r.amount), 0) as total
       FROM artist_revenue r LEFT JOIN music m ON m.id = r.track_id
       WHERE r.artist_user_id = ? GROUP BY m.title ORDER BY total DESC LIMIT 8`,
      [uid]
    );

    const [recentActivity] = await pool.execute(
      'SELECT * FROM artist_activity WHERE artist_user_id = ? ORDER BY created_at DESC LIMIT 15',
      [uid]
    );

    res.json({
      stats: {
        totalTracks: trackCount.c,
        totalAlbums: albumCount.c,
        totalPlays: Number(premiumStreams.t),
        premiumStreams: Number(premiumStreams.t),
        streamRateUsd: STREAM_RATE_USD,
        monthlyListeners: artistRow?.monthly_listeners || 0,
        totalFollowers: followers.c,
        totalLikes: likes.c,
        pendingAssociations: pendingAssoc.c,
        monthRevenue: Number(monthRevenue.c),
        totalRevenue: Number(totalRevenue.c),
        topTracks,
      },
      payout,
      payoutHistory,
      charts: { playsByMonth, revenueByMonth, revenueByTrack },
      recentActivity,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur dashboard artiste' });
  }
});

// ─── Revenue ─────────────────────────────────────────────────────────────────

router.get('/revenue', authenticateToken, requireArtist, async (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const yearStart = `${new Date().getFullYear()}-01-01`;

    const sum = async (from) => {
      const [[r]] = await pool.execute(
        'SELECT COALESCE(SUM(amount), 0) as t FROM artist_revenue WHERE artist_user_id = ? AND period_date >= ?',
        [uid, from]
      );
      return Number(r.t);
    };

    const [entries] = await pool.execute(
      `SELECT r.*, m.title as track_title FROM artist_revenue r
       LEFT JOIN music m ON m.id = r.track_id WHERE r.artist_user_id = ?
       ORDER BY r.period_date DESC LIMIT 200`,
      [uid]
    );
    const [byMonth] = await pool.execute(
      `SELECT DATE_FORMAT(period_date, '%Y-%m') as month, SUM(amount) as total FROM artist_revenue
       WHERE artist_user_id = ? GROUP BY month ORDER BY month`,
      [uid]
    );
    const [byTrack] = await pool.execute(
      `SELECT m.title as track, SUM(r.amount) as total FROM artist_revenue r
       LEFT JOIN music m ON m.id = r.track_id WHERE r.artist_user_id = ? GROUP BY m.title`,
      [uid]
    );
    const [bySource] = await pool.execute(
      `SELECT source as name, SUM(amount) as total FROM artist_revenue WHERE artist_user_id = ? GROUP BY source`,
      [uid]
    );

    const payout = await getRoyaltyBalance('artist', uid);
    const payoutHistory = await getPayoutHistory('artist', uid, 20);
    const [streamEvents] = await pool.execute(
      `SELECT id, track_title, is_premium, is_counted, skip_reason, artist_amount as amount, listened_at
       FROM counted_stream_events WHERE artist_user_id = ?
       ORDER BY listened_at DESC LIMIT 200`,
      [uid]
    );

    res.json({
      summary: {
        today: await sum(today),
        week: await sum(weekAgo),
        month: await sum(monthStart),
        year: await sum(yearStart),
        total: (await pool.execute('SELECT COALESCE(SUM(amount),0) as t FROM artist_revenue WHERE artist_user_id = ?', [uid]))[0][0].t,
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
      charts: { byMonth, byTrack, bySource },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur revenus' });
  }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

router.get('/analytics', authenticateToken, requireArtist, async (req, res) => {
  try {
    const artist = await resolveArtist(req.user.id);
    if (!artist) return res.status(404).json({ error: 'Profil artiste introuvable' });

    const { artistId, artistName } = artist;
    const uid = req.user.id;
    const [[plays]] = await pool.execute(SQL_TRACK_PLAYS_SUM, [uid]);
    const totalPlays = Number(plays.t || 0);

    const [[uniqueRow]] = await pool.execute(
      `SELECT COUNT(DISTINCT lh.user_id) as t FROM listening_history lh
       JOIN music m ON lh.track_id = m.id WHERE LOWER(m.artist_name) = LOWER(?)`,
      [artistName]
    );
    const uniqueListeners = Number(uniqueRow.t || 0);

    const [[likesRow]] = await pool.execute(
      `SELECT COUNT(*) as t FROM liked_song ls JOIN music m ON ls.song_id = m.id
       WHERE LOWER(m.artist_name) = LOWER(?)`,
      [artistName]
    );
    const totalLikes = Number(likesRow.t || 0);

    const [[completionRow]] = await pool.execute(
      `SELECT AVG(lh.completion_percent) as avg_comp FROM listening_history lh
       JOIN music m ON lh.track_id = m.id
       WHERE LOWER(m.artist_name) = LOWER(?) AND lh.completion_percent IS NOT NULL`,
      [artistName]
    );

    const AVG_TRACK_SEC = 210;
    const avgListenTime = formatListenDuration(
      uniqueListeners > 0 ? (totalPlays * AVG_TRACK_SEC) / uniqueListeners : 0
    );

    let completionRate = completionRow.avg_comp != null
      ? Math.round(Number(completionRow.avg_comp))
      : (totalPlays > 0 ? Math.min(100, Math.round((totalLikes / totalPlays) * 100)) : 0);

    const baseJoin = `FROM listening_history lh JOIN music m ON lh.track_id = m.id WHERE LOWER(m.artist_name) = LOWER(?)`;

    const [countryRows] = await pool.execute(
      `SELECT COALESCE(NULLIF(lh.country, ''), 'Inconnu') as name, COUNT(*) as count ${baseJoin}
       AND lh.country IS NOT NULL GROUP BY lh.country ORDER BY count DESC LIMIT 8`,
      [artistName]
    );

    const [cityRows] = await pool.execute(
      `SELECT COALESCE(NULLIF(lh.city, ''), 'Inconnu') as name, COUNT(*) as count ${baseJoin}
       AND lh.city IS NOT NULL GROUP BY lh.city ORDER BY count DESC LIMIT 8`,
      [artistName]
    );

    const [deviceRows] = await pool.execute(
      `SELECT COALESCE(NULLIF(lh.device, ''), 'Inconnu') as name, COUNT(*) as count ${baseJoin}
       AND lh.device IS NOT NULL GROUP BY lh.device ORDER BY count DESC`,
      [artistName]
    );

    const [sourceRows] = await pool.execute(
      `SELECT COALESCE(NULLIF(lh.source, ''), 'direct') as name, COUNT(*) as count ${baseJoin}
       GROUP BY lh.source ORDER BY count DESC`,
      [artistName]
    );

    const [playsByMonth] = await pool.execute(SQL_PLAYS_BY_MONTH, [artistName]);
    const [topRows] = await pool.execute(`${SQL_TOP_TRACKS} LIMIT 10`, [uid]);
    const topTracks = topRows.map((r) => ({ title: r.title, streams: Number(r.play_count) }));

    const countries = buildPercentDistribution(countryRows);
    const cities = buildPercentDistribution(cityRows);
    const provinces = provincesFromCityCounts(cityRows);
    const devices = buildPercentDistribution(deviceRows);
    const trafficSources = buildPercentDistribution(
      sourceRows.map((r) => ({
        name: SOURCE_LABELS[r.name] || r.name,
        count: r.count,
      }))
    );

    res.json({
      totalPlays,
      uniqueListeners,
      totalLikes,
      avgListenTime,
      completionRate,
      countries,
      provinces,
      cities,
      devices,
      trafficSources,
      playsByMonth,
      topTracks,
      hasListenData: totalPlays > 0 || uniqueListeners > 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur analytics' });
  }
});

// ─── Historique streams ──────────────────────────────────────────────────────

router.get('/streams/history', authenticateToken, requireArtist, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const history = await getStreamHistory({ accountType: 'artist', userId: req.user.id, limit, offset });
    res.json(history);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur historique streams' });
  }
});

// ─── Reports ─────────────────────────────────────────────────────────────────

router.get('/reports/summary', authenticateToken, requireArtist, async (req, res) => {
  try {
    const uid = req.user.id;
    const artist = await resolveArtist(uid);
    if (!artist) return res.status(404).json({ error: 'Profil artiste introuvable' });

    const [tracks] = await pool.execute(`${SQL_TOP_TRACKS}`, [uid]);
    const [albums] = await pool.execute(
      'SELECT title, created_at FROM albums WHERE LOWER(artist_name) = LOWER(?) ORDER BY created_at DESC',
      [artist.artistName]
    );
    const [[rev]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) as t FROM artist_revenue WHERE artist_user_id = ?',
      [uid]
    );
    const [byMonth] = await pool.execute(
      `SELECT DATE_FORMAT(period_date, '%Y-%m') as month, SUM(amount) as total FROM artist_revenue
       WHERE artist_user_id = ? GROUP BY month ORDER BY month`,
      [uid]
    );

    res.json({
      tracks,
      albums,
      totalRevenue: rev.t,
      monthlyRevenue: byMonth,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur rapport' });
  }
});

// ─── Notifications ───────────────────────────────────────────────────────────

router.get('/notifications', authenticateToken, requireArtist, async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT * FROM artist_notifications WHERE artist_user_id = ? ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json(rows);
});

router.put('/notifications/:id/read', authenticateToken, requireArtist, async (req, res) => {
  await pool.execute(
    'UPDATE artist_notifications SET is_read = TRUE WHERE id = ? AND artist_user_id = ?',
    [req.params.id, req.user.id]
  );
  res.json({ success: true });
});

router.put('/notifications/read-all', authenticateToken, requireArtist, async (req, res) => {
  await pool.execute('UPDATE artist_notifications SET is_read = TRUE WHERE artist_user_id = ?', [req.user.id]);
  res.json({ success: true });
});

// ─── Settings ────────────────────────────────────────────────────────────────

router.get('/settings', authenticateToken, requireArtist, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM artist_settings WHERE user_id = ?', [req.user.id]);
  res.json(rows[0] || { user_id: req.user.id, theme: 'dark' });
});

router.put('/settings', authenticateToken, requireArtist, upload.single('logo'), async (req, res) => {
  try {
    const b = req.body;
    let logoUrl = b.logo_url;
    if (req.file) logoUrl = await uploadToS3(req.file, 'artist-logos');
    const fields = [
      b.display_name, b.address, b.phone, b.email, b.website, logoUrl,
      b.payment_mobile_money, b.payment_bank, b.payment_paypal, b.payment_stripe,
      b.two_factor_enabled === 'true' || b.two_factor_enabled === true,
      b.theme || 'dark',
    ];
    const [ex] = await pool.execute('SELECT user_id FROM artist_settings WHERE user_id = ?', [req.user.id]);
    if (ex[0]) {
      await pool.execute(
        `UPDATE artist_settings SET display_name=?, address=?, phone=?, email=?, website=?, logo_url=?,
         payment_mobile_money=?, payment_bank=?, payment_paypal=?, payment_stripe=?, two_factor_enabled=?, theme=? WHERE user_id=?`,
        [...fields, req.user.id]
      );
    } else {
      await pool.execute(
        `INSERT INTO artist_settings (user_id, display_name, address, phone, email, website, logo_url,
         payment_mobile_money, payment_bank, payment_paypal, payment_stripe, two_factor_enabled, theme)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, ...fields]
      );
    }
    await logActivity(req.user.id, 'settings', 'Paramètres mis à jour');
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur paramètres' });
  }
});

export default router;
