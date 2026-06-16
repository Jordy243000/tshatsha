import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { optionalAuth, authenticateToken } from '../middleware/auth.js';
import {
  isIvsConfigured,
  createIvsLiveChannel,
  deleteIvsChannel,
  getIvsStreamState,
  cleanupOrphanIvsChannels,
} from '../services/ivsService.js';

const router = express.Router();

const FALLBACK_STREAM = process.env.LIVE_STREAM_FALLBACK_URL
  || 'https://res.cloudinary.com/dpzckdops/video/upload/v1767632175/6007788_Rhythmic_Dancing_3840x2160_1_xy1e0m.mp4';

/** Compteurs viewers en mémoire (join/leave rapide) */
const viewerDelta = new Map();

export async function ensureLiveTables() {
  const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      id VARCHAR(36) PRIMARY KEY,
      artist_id VARCHAR(36),
      host_user_id VARCHAR(36) NOT NULL,
      artist_name VARCHAR(255) NOT NULL,
      artist_image_url TEXT,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      stream_url TEXT NOT NULL,
      thumbnail_url TEXT,
      status ENUM('live','ended','scheduled') DEFAULT 'live',
      is_demo BOOLEAN DEFAULT FALSE,
      viewer_count INT DEFAULT 0,
      like_count INT DEFAULT 0,
      comment_count INT DEFAULT 0,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_host (host_user_id),
      INDEX idx_artist (artist_id),
      FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS live_comments (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36),
      user_name VARCHAR(255) NOT NULL,
      text VARCHAR(220) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_session (session_id),
      FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await ensureLiveIvsColumns();
}

async function ensureLiveIvsColumns() {
  const cols = [
    ['ivs_channel_arn', 'VARCHAR(255) NULL'],
    ['ivs_ingest_endpoint', 'VARCHAR(255) NULL'],
    ['ivs_stream_key', 'VARCHAR(255) NULL'],
    ['stream_type', "ENUM('ivs','custom','fallback') DEFAULT 'fallback'"],
  ];
  for (const [name, def] of cols) {
    const [rows] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = ?`,
      [name]
    );
    if (!rows.length) {
      await pool.execute(`ALTER TABLE live_sessions ADD COLUMN ${name} ${def}`);
    }
  }
}

function computeRankScore(session) {
  const viewers = Number(session.viewer_count || 0) + (viewerDelta.get(session.id) || 0);
  return (viewers * 3) + (Number(session.like_count || 0) * 2) + Number(session.comment_count || 0);
}

function mapSession(row, options = {}) {
  const { includeBroadcast = false } = options;
  const extra = viewerDelta.get(row.id) || 0;
  const session = {
    id: row.id,
    artist_id: row.artist_id,
    host_user_id: row.host_user_id,
    artist_name: row.artist_name,
    artist_image_url: row.artist_image_url,
    title: row.title,
    description: row.description,
    stream_url: row.stream_url,
    thumbnail_url: row.thumbnail_url,
    status: row.status,
    is_demo: !!row.is_demo,
    is_live: row.status === 'live',
    stream_type: row.stream_type || 'fallback',
    viewer_count: Math.max(0, Number(row.viewer_count || 0) + extra),
    like_count: Number(row.like_count || 0),
    comment_count: Number(row.comment_count || 0),
    started_at: row.started_at,
    tags: row.is_demo ? ['demo', 'live'] : ['live', 'music'],
    rank_score: 0,
  };

  if (row.ivs_channel_arn && row.stream_type === 'ivs') {
    session.ivs_stream_state = row._ivs_stream_state || 'OFFLINE';
  }

  if (includeBroadcast && row.ivs_channel_arn && row.ivs_stream_key) {
    session.broadcast = {
      rtmps_server: row.ivs_ingest_endpoint
        ? `rtmps://${row.ivs_ingest_endpoint}:443/app/`
        : null,
      stream_key: row.ivs_stream_key,
      playback_url: row.stream_url,
      ingest_endpoint: row.ivs_ingest_endpoint,
    };
  }

  return session;
}

async function enrichIvsState(row) {
  if (!row?.ivs_channel_arn || row.stream_type !== 'ivs') return row;
  row._ivs_stream_state = await getIvsStreamState(row.ivs_channel_arn);
  return row;
}

async function resolveArtistHost(userId) {
  const [users] = await pool.execute('SELECT artist_id, full_name FROM users WHERE id = ?', [userId]);
  if (users[0]?.artist_id) {
    const [artists] = await pool.execute('SELECT id, name, image_url, genre FROM artists WHERE id = ?', [users[0].artist_id]);
    if (artists[0]) return { artistId: artists[0].id, artistName: artists[0].name, imageUrl: artists[0].image_url, genre: artists[0].genre };
  }
  const [apps] = await pool.execute(
    `SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (apps[0]) {
    const [artists] = await pool.execute('SELECT id, name, image_url, genre FROM artists WHERE name = ?', [apps[0].artist_name]);
    if (artists[0]) return { artistId: artists[0].id, artistName: artists[0].name, imageUrl: artists[0].image_url, genre: artists[0].genre };
    return { artistId: null, artistName: apps[0].artist_name, imageUrl: null, genre: null };
  }
  return null;
}

async function requireApprovedArtist(req, res, next) {
  try {
    const host = await resolveArtistHost(req.user.id);
    if (!host) return res.status(403).json({ error: 'Compte artiste approuvé requis' });
    req.artistHost = host;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Erreur vérification artiste' });
  }
}

async function getLiveSessionsFromDb() {
  const [rows] = await pool.execute(
    `SELECT * FROM live_sessions WHERE status = 'live' AND is_demo = FALSE ORDER BY started_at DESC`
  );
  return rows.map((r) => {
    const s = mapSession(r);
    s.rank_score = computeRankScore(s);
    return s;
  });
}


/** Nettoyage IVS + suppression des sessions demo résiduelles */
export async function bootstrapLiveDemoSessions() {
  try {
    if (isIvsConfigured()) {
      const [active] = await pool.execute(
        `SELECT ivs_channel_arn FROM live_sessions WHERE status = 'live' AND ivs_channel_arn IS NOT NULL`
      );
      const { deleted } = await cleanupOrphanIvsChannels(active.map((r) => r.ivs_channel_arn));
      if (deleted > 0) console.log(`🧹 Live IVS: ${deleted} canal/canaux orphelin(s) supprimé(s)`);
    }
    const [ended] = await pool.execute(
      `UPDATE live_sessions SET status = 'ended', ended_at = NOW() WHERE status = 'live' AND is_demo = TRUE`
    );
    if (ended.affectedRows > 0) {
      console.log(`🧹 Live: ${ended.affectedRows} session(s) demo terminée(s)`);
    }
  } catch (err) {
    console.warn('[live] bootstrap:', err.message);
  }
}

function filterFeedSessions(sessions) {
  return sessions.filter((s) => !s.is_demo);
}

async function buildSortedSessions(limit = 20) {
  let sessions = filterFeedSessions(await getLiveSessionsFromDb());

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.stream_type === 'ivs' && s.is_demo === false) {
      const [rows] = await pool.execute('SELECT * FROM live_sessions WHERE id = ?', [s.id]);
      if (rows[0]) {
        const row = await enrichIvsState({ ...rows[0] });
        const fresh = mapSession(row);
        sessions[i] = { ...s, ...fresh, rank_score: computeRankScore(fresh) };
      }
    } else {
      sessions[i].rank_score = computeRankScore(s);
    }
  }

  sessions.sort((a, b) => b.rank_score - a.rank_score || b.viewer_count - a.viewer_count);

  return sessions.slice(0, limit);
}

async function getSessionById(id, options = {}) {
  const [rows] = await pool.execute('SELECT * FROM live_sessions WHERE id = ?', [id]);
  if (!rows[0]) return null;
  let row = rows[0];
  if (options.withIvsState) row = await enrichIvsState({ ...row });
  const s = mapSession(row, options);
  s.rank_score = computeRankScore(s);
  return s;
}

// ─── Public feed ─────────────────────────────────────────────────────────────

router.get('/feed', optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);
    const sessions = await buildSortedSessions(limit);

    res.json({
      sessions,
      recommended: sessions.slice(0, 5).map((s) => ({
        id: s.id, title: s.title, artist_name: s.artist_name,
        thumbnail_url: s.thumbnail_url, viewer_count: s.viewer_count,
        like_count: s.like_count, rank_score: s.rank_score,
      })),
      has_real_lives: sessions.some((s) => !s.is_demo),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching live feed:', error);
    res.status(500).json({ error: 'Failed to fetch live feed' });
  }
});

router.get('/snapshot', optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const sessions = await buildSortedSessions(limit);
    const ranking = [...sessions].sort((a, b) => b.rank_score - a.rank_score).slice(0, 20);
    res.json({
      sessions,
      ranking,
      has_real_lives: sessions.some((s) => !s.is_demo),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching live snapshot:', error);
    res.status(500).json({ error: 'Failed to fetch live snapshot' });
  }
});

router.get('/ranking', optionalAuth, async (req, res) => {
  try {
    const sessions = await buildSortedSessions(50);
    sessions.sort((a, b) => b.rank_score - a.rank_score);
    res.json(sessions.slice(0, 20));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch live ranking' });
  }
});

router.get('/sessions/:id', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionById(req.params.id, { withIvsState: true });
    if (!session || !session.is_live) return res.status(404).json({ error: 'Live session not found' });
    res.json(session);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

router.post('/sessions/:id/join', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session || !session.is_live) return res.status(404).json({ error: 'Live session not found' });

    viewerDelta.set(session.id, (viewerDelta.get(session.id) || 0) + 1);

    const updated = await getSessionById(session.id);
    res.json({ session: updated, joined: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to join live session' });
  }
});

router.post('/sessions/:id/leave', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Live session not found' });

    const delta = viewerDelta.get(session.id) || 0;
    if (delta > 0) viewerDelta.set(session.id, delta - 1);

    const updated = await getSessionById(session.id);
    res.json({ session: updated, left: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to leave live session' });
  }
});

router.post('/sessions/:id/like', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session || !session.is_live) return res.status(404).json({ error: 'Live session not found' });

    await pool.execute('UPDATE live_sessions SET like_count = like_count + 1 WHERE id = ?', [session.id]);
    const updated = await getSessionById(session.id);
    res.json({ like_count: updated.like_count, rank_score: updated.rank_score });
  } catch (error) {
    res.status(500).json({ error: 'Failed to like live session' });
  }
});

router.get('/sessions/:id/comments', optionalAuth, async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Live session not found' });

    const since = req.query.since ? Number(req.query.since) : 0;
    const [rows] = since > 0
      ? await pool.execute(
          'SELECT id, user_id, user_name, text, UNIX_TIMESTAMP(created_at)*1000 as timestamp FROM live_comments WHERE session_id = ? AND UNIX_TIMESTAMP(created_at)*1000 > ? ORDER BY created_at ASC LIMIT 80',
          [session.id, since]
        )
      : await pool.execute(
          'SELECT id, user_id, user_name, text, UNIX_TIMESTAMP(created_at)*1000 as timestamp FROM live_comments WHERE session_id = ? ORDER BY created_at ASC LIMIT 80',
          [session.id]
        );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

router.post('/sessions/:id/comments', authenticateToken, async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session || !session.is_live) return res.status(404).json({ error: 'Live session not found' });

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Comment text is required' });
    if (text.length > 220) return res.status(400).json({ error: 'Comment too long (max 220 chars)' });

    const id = uuidv4();
    const userName = req.body?.user_name || req.user.full_name || 'Fan';
    await pool.execute(
      'INSERT INTO live_comments (id, session_id, user_id, user_name, text) VALUES (?, ?, ?, ?, ?)',
      [id, session.id, req.user.id, userName, text]
    );
    await pool.execute('UPDATE live_sessions SET comment_count = comment_count + 1 WHERE id = ?', [session.id]);

    const [[comment]] = await pool.execute(
      'SELECT id, user_id, user_name, text, UNIX_TIMESTAMP(created_at)*1000 as timestamp FROM live_comments WHERE id = ?',
      [id]
    );
    res.status(201).json(comment);
  } catch (error) {
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

// ─── Artist studio ───────────────────────────────────────────────────────────

router.get('/my-session', authenticateToken, requireApprovedArtist, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM live_sessions WHERE host_user_id = ? AND status = 'live' AND is_demo = FALSE ORDER BY started_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!rows[0]) return res.json(null);
    const row = await enrichIvsState({ ...rows[0] });
    res.json(mapSession(row, { includeBroadcast: true }));
  } catch (error) {
    res.status(500).json({ error: 'Erreur session live' });
  }
});

router.post('/sessions', authenticateToken, requireApprovedArtist, async (req, res) => {
  try {
    const host = req.artistHost;
    const { title, description, stream_url: customStreamUrl } = req.body;

    const [existing] = await pool.execute(
      `SELECT id FROM live_sessions WHERE host_user_id = ? AND status = 'live' AND is_demo = FALSE`,
      [req.user.id]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'Vous avez déjà un live en cours. Terminez-le avant d\'en lancer un nouveau.' });
    }

    const id = uuidv4();
    const liveTitle = String(title || `${host.artistName} en live`).trim().slice(0, 255);

    let streamUrl = FALLBACK_STREAM;
    let streamType = 'fallback';
    let ivsChannelArn = null;
    let ivsIngestEndpoint = null;
    let ivsStreamKey = null;

    const customUrl = String(customStreamUrl || '').trim();
    if (customUrl) {
      streamUrl = customUrl;
      streamType = 'custom';
    } else if (isIvsConfigured()) {
      try {
        const ivs = await createIvsLiveChannel(id, host.artistName);
        streamUrl = ivs.playbackUrl;
        streamType = 'ivs';
        ivsChannelArn = ivs.channelArn;
        ivsIngestEndpoint = ivs.ingestEndpoint;
        ivsStreamKey = ivs.streamKey;
        console.log(`[live] Canal IVS créé pour ${host.artistName} (${id})`);
      } catch (ivsErr) {
        console.error('[live] IVS create failed, fallback video:', ivsErr.message);
      }
    }

    await pool.execute(
      `INSERT INTO live_sessions (
        id, artist_id, host_user_id, artist_name, artist_image_url, title, description,
        stream_url, thumbnail_url, status, is_demo, stream_type,
        ivs_channel_arn, ivs_ingest_endpoint, ivs_stream_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', FALSE, ?, ?, ?, ?)`,
      [
        id, host.artistId, req.user.id, host.artistName, host.imageUrl,
        liveTitle, description || null, streamUrl, host.imageUrl,
        streamType, ivsChannelArn, ivsIngestEndpoint, ivsStreamKey,
      ]
    );

    const session = await getSessionById(id, { includeBroadcast: true, withIvsState: true });
    res.status(201).json(session);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Impossible de démarrer le live' });
  }
});

router.put('/sessions/:id/end', authenticateToken, requireApprovedArtist, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM live_sessions WHERE id = ? AND host_user_id = ? AND status = \'live\'',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Live introuvable' });

    if (rows[0].ivs_channel_arn) {
      await deleteIvsChannel(rows[0].ivs_channel_arn);
    }

    await pool.execute(
      `UPDATE live_sessions SET status = 'ended', ended_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    viewerDelta.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de terminer le live' });
  }
});

router.get('/my-history', authenticateToken, requireApprovedArtist, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM live_sessions WHERE host_user_id = ? AND is_demo = FALSE ORDER BY started_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(rows.map(mapSession));
  } catch (error) {
    res.status(500).json({ error: 'Erreur historique live' });
  }
});

export default router;
