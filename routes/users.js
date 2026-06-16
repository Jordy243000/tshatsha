import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { deviceFromUserAgent, geoFromTimezone } from '../utils/listenAnalytics.js';
import { processPremiumStream, STREAM_RATE_USD } from '../services/streamRoyaltyService.js';

const router = express.Router();

const ensureAdsTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_config (
      audio_url VARCHAR(700) NOT NULL PRIMARY KEY,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      display_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ads_enabled_order (is_enabled, display_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try {
    await pool.query('ALTER TABLE ads_config ADD COLUMN image_url TEXT NULL AFTER audio_url');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_play_events (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      audio_url TEXT NOT NULL,
      user_id VARCHAR(36) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ad_plays_created (created_at),
      INDEX idx_ad_plays_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

// Get user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Try to get all fields, but handle case where new columns might not exist yet
    let users;
    try {
      [users] = await pool.execute(
        'SELECT id, email, full_name, avatar_url, date_of_birth, bio, location, favorite_genre, is_artist, artist_id, created_at FROM users WHERE id = ?',
        [userId]
      );
    } catch (selectError) {
      // If columns don't exist, fallback to basic columns
      if (selectError.code === 'ER_BAD_FIELD_ERROR') {
        console.warn('New profile columns not found, using basic columns');
        [users] = await pool.execute(
          'SELECT id, email, full_name, avatar_url, date_of_birth, is_artist, artist_id, created_at FROM users WHERE id = ?',
          [userId]
        );
        // Add null values for missing columns
        if (users.length > 0) {
          users[0].bio = null;
          users[0].location = null;
          users[0].favorite_genre = null;
        }
      } else {
        throw selectError;
      }
    }

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(users[0]);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user profile (nom, date de naissance, localisation — enregistrés en base)
router.put('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name, avatar_url, date_of_birth, bio, location, favorite_genre, billing_address, payment_method } = req.body;

    // Mise à jour des champs profil : full_name, date_of_birth, location (liés au formulaire "Modifier le profil")
    try {
      await pool.execute(
        'UPDATE users SET full_name = ?, date_of_birth = ?, location = ? WHERE id = ?',
        [
          full_name != null ? full_name : null,
          date_of_birth != null ? date_of_birth : null,
          location != null ? location : null,
          userId
        ]
      );
    } catch (updateError) {
      if (updateError.code === 'ER_BAD_FIELD_ERROR') {
        console.warn('Column location/date_of_birth may not exist, trying basic columns');
        await pool.execute(
          'UPDATE users SET full_name = ?, date_of_birth = ? WHERE id = ?',
          [full_name != null ? full_name : null, date_of_birth != null ? date_of_birth : null, userId]
        );
      } else {
        throw updateError;
      }
    }

    // Handle billing_address and payment_method if they exist in schema
    if (billing_address !== undefined || payment_method !== undefined) {
      try {
        await pool.execute(
          'UPDATE users SET billing_address = ?, payment_method = ? WHERE id = ?',
          [
            billing_address ? JSON.stringify(billing_address) : null, 
            payment_method ? JSON.stringify(payment_method) : null, 
            userId
          ]
        );
      } catch (billingError) {
        // Ignore if columns don't exist
        if (billingError.code !== 'ER_BAD_FIELD_ERROR') {
          console.warn('Error updating billing info:', billingError.message);
        }
      }
    }

    // Get updated user (with fallback for missing columns)
    let users;
    try {
      [users] = await pool.execute(
        'SELECT id, email, full_name, avatar_url, date_of_birth, bio, location, favorite_genre, is_artist, artist_id, created_at FROM users WHERE id = ?',
        [userId]
      );
    } catch (selectError) {
      if (selectError.code === 'ER_BAD_FIELD_ERROR') {
        [users] = await pool.execute(
          'SELECT id, email, full_name, avatar_url, date_of_birth, is_artist, artist_id, created_at FROM users WHERE id = ?',
          [userId]
        );
        if (users.length > 0) {
          users[0].bio = null;
          users[0].location = null;
          users[0].favorite_genre = null;
        }
      } else {
        throw selectError;
      }
    }

    res.json(users[0]);
  } catch (error) {
    console.error('Error updating user:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage
    });
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Get user's liked tracks
router.get('/me/liked-tracks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [tracks] = await pool.execute(
      `SELECT m.*, ls.created_at as liked_at
       FROM liked_song ls
       JOIN music m ON ls.song_id = m.id
       WHERE ls.user_id = ?
       ORDER BY ls.created_at DESC`,
      [userId]
    );

    res.json(tracks);
  } catch (error) {
    console.error('Error fetching liked tracks:', error);
    res.status(500).json({ error: 'Failed to fetch liked tracks' });
  }
});

// Toggle like track
router.post('/me/liked-tracks/:trackId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { trackId } = req.params;

    // Check if already liked
    const [existing] = await pool.execute(
      'SELECT * FROM liked_song WHERE user_id = ? AND song_id = ?',
      [userId, trackId]
    );

    if (existing.length > 0) {
      // Unlike
      await pool.execute(
        'DELETE FROM liked_song WHERE user_id = ? AND song_id = ?',
        [userId, trackId]
      );
      res.json({ liked: false });
    } else {
      // Like
      await pool.execute(
        'INSERT INTO liked_song (user_id, song_id) VALUES (?, ?)',
        [userId, trackId]
      );
      res.json({ liked: true });
    }
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

// Get followed artists
router.get('/me/followed-artists', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [follows] = await pool.execute(
      `SELECT a.*, af.created_at as followed_at
       FROM artist_follows af
       JOIN artists a ON af.artist_id = a.id
       WHERE af.user_id = ?
       ORDER BY af.created_at DESC`,
      [userId]
    );

    res.json(follows);
  } catch (error) {
    console.error('Error fetching followed artists:', error);
    res.status(500).json({ error: 'Failed to fetch followed artists' });
  }
});

// Get user preferences
router.get('/me/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [users] = await pool.execute(
      'SELECT preferences FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Parse JSON preferences or return default
    const preferences = users[0].preferences 
      ? (typeof users[0].preferences === 'string' 
          ? JSON.parse(users[0].preferences) 
          : users[0].preferences)
      : {};

    res.json(preferences);
  } catch (error) {
    console.error('Error fetching preferences:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// Update user preferences
router.put('/me/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const preferences = req.body;

    // Check if preferences column exists
    const [columns] = await pool.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'users' 
      AND COLUMN_NAME = 'preferences'
    `);

    if (columns.length === 0) {
      return res.status(500).json({ 
        error: 'Preferences column does not exist',
        message: 'Please run: npm run migrate-user-preferences'
      });
    }

    // Get existing preferences
    const [users] = await pool.execute(
      'SELECT preferences FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Merge with existing preferences
    const existingPreferences = users[0].preferences 
      ? (typeof users[0].preferences === 'string' 
          ? JSON.parse(users[0].preferences) 
          : users[0].preferences)
      : {};

    const mergedPreferences = { ...existingPreferences, ...preferences };

    // Update preferences
    await pool.execute(
      'UPDATE users SET preferences = ? WHERE id = ?',
      [JSON.stringify(mergedPreferences), userId]
    );

    res.json(mergedPreferences);
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Delete listening history
router.delete('/me/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await pool.execute(
      'DELETE FROM listening_history WHERE user_id = ?',
      [userId]
    );

    res.json({ message: 'Listening history deleted successfully' });
  } catch (error) {
    console.error('Error deleting listening history:', error);
    res.status(500).json({ error: 'Failed to delete listening history' });
  }
});

// Export user data
router.get('/me/export-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user profile
    const [users] = await pool.execute(
      'SELECT id, email, full_name, avatar_url, date_of_birth, bio, location, favorite_genre, created_at FROM users WHERE id = ?',
      [userId]
    );

    // Get playlists
    const [playlists] = await pool.execute(
      'SELECT * FROM playlists WHERE user_id = ?',
      [userId]
    );

    // Get liked tracks
    const [likedTracks] = await pool.execute(
      `SELECT m.*, ls.created_at as liked_at
       FROM liked_song ls
       JOIN music m ON ls.song_id = m.id
       WHERE ls.user_id = ?`,
      [userId]
    );

    // Get listening history
    const [history] = await pool.execute(
      `SELECT m.*, lh.played_at
       FROM listening_history lh
       JOIN music m ON lh.track_id = m.id
       WHERE lh.user_id = ?
       ORDER BY lh.played_at DESC`,
      [userId]
    );

    // Get followed artists
    const [followedArtists] = await pool.execute(
      `SELECT a.*, af.created_at as followed_at
       FROM artist_follows af
       JOIN artists a ON af.artist_id = a.id
       WHERE af.user_id = ?`,
      [userId]
    );

    // Get preferences
    const [prefs] = await pool.execute(
      'SELECT preferences FROM users WHERE id = ?',
      [userId]
    );

    const preferences = prefs[0]?.preferences 
      ? (typeof prefs[0].preferences === 'string' 
          ? JSON.parse(prefs[0].preferences) 
          : prefs[0].preferences)
      : {};

    const exportData = {
      user: users[0] || {},
      playlists: playlists || [],
      likedTracks: likedTracks || [],
      listeningHistory: history || [],
      followedArtists: followedArtists || [],
      preferences: preferences,
      exportedAt: new Date().toISOString()
    };

    res.json(exportData);
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Delete user account
router.delete('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Delete user (cascade will handle related data)
    await pool.execute(
      'DELETE FROM users WHERE id = ?',
      [userId]
    );

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Get listening history
router.get('/me/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const parsedLimit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;
    // Récupérer assez de lignes pour dédoublonner (même titre joué plusieurs fois) tout en gardant le plus récent par morceau
    const fetchLimit = Math.min(500, Math.max(limit * 25, 80));

    // Use LEFT JOIN to include history even if track is deleted
    const [history] = await pool.execute(
      `SELECT 
         lh.id AS history_entry_id,
         m.id,
         m.title,
         m.artist_name,
         m.audio_url,
         m.image_url,
         m.is_premium,
         m.is_trending,
         m.created_at,
         lh.played_at
       FROM listening_history lh
       LEFT JOIN music m ON lh.track_id = m.id
       WHERE lh.user_id = ?
       ORDER BY lh.played_at DESC
       LIMIT ${fetchLimit}`,
      [userId]
    );

    // Filter out entries where track was deleted (m.id is NULL)
    const validHistory = history.filter(item => item.id !== null);

    // Une seule entrée par morceau : la plus récente (ordre déjà DESC sur played_at)
    const seenTrackIds = new Set();
    const deduped = [];
    for (const row of validHistory) {
      if (seenTrackIds.has(row.id)) continue;
      seenTrackIds.add(row.id);
      deduped.push(row);
      if (deduped.length >= limit) break;
    }

    res.json(deduped);
  } catch (error) {
    console.error('Error fetching listening history:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlMessage: error.sqlMessage,
      sqlState: error.sqlState
    });
    
    // If table doesn't exist or column issue, return empty array
    if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
      console.warn('Listening history table or column does not exist, returning empty array');
      return res.json([]);
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch listening history',
      details: error.message 
    });
  }
});

// Add to listening history
router.post('/me/history', authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = req.user.id;
    const { track_id, source, country, city, timezone, device, completion_percent } = req.body;

    if (!track_id) {
      return res.status(400).json({ error: 'track_id is required' });
    }

    const listenDevice = device || deviceFromUserAgent(req.headers['user-agent']);
    const geo = country ? { country, city: city || null } : geoFromTimezone(timezone);
    const listenSource = source || 'direct';

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Ensure track exists and get artist for global stream stats.
    const [tracks] = await connection.execute(
      'SELECT id, title, artist_name FROM music WHERE id = ? LIMIT 1',
      [track_id]
    );
    if (tracks.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Track not found' });
    }

    const historyId = uuidv4();

    // Keep full listening history (every play) + métadonnées analytics
    try {
      await connection.execute(
        `INSERT INTO listening_history (id, user_id, track_id, source, device, country, city, completion_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyId, userId, track_id, listenSource, listenDevice,
          geo.country, geo.city,
          completion_percent != null ? Math.min(100, Math.max(0, Number(completion_percent))) : null,
        ]
      );
    } catch (insertErr) {
      if (insertErr.code === 'ER_BAD_FIELD_ERROR') {
        await connection.execute(
          'INSERT INTO listening_history (id, user_id, track_id) VALUES (?, ?, ?)',
          [historyId, userId, track_id]
        );
      } else {
        throw insertErr;
      }
    }

    // Comptage stream premium uniquement (1 stream = $0.001, 1×/24h/utilisateur)
    const streamResult = await processPremiumStream(connection, {
      userId,
      trackId: track_id,
      trackTitle: tracks[0].title,
      artistName: tracks[0].artist_name,
      source: listenSource,
      device: listenDevice,
      country: geo.country,
    });

    if (streamResult.stream_counted) {
      const [usage] = await connection.execute(
        'SELECT id FROM user_usage WHERE user_id = ? LIMIT 1',
        [userId]
      );
      if (usage.length === 0) {
        await connection.execute(
          'INSERT INTO user_usage (id, user_id, plays_count) VALUES (?, ?, 1)',
          [uuidv4(), userId]
        );
      } else {
        await connection.execute(
          'UPDATE user_usage SET plays_count = plays_count + 1 WHERE user_id = ?',
          [userId]
        );
      }
    }

    await connection.commit();
    res.status(201).json({
      message: 'Added to history',
      stream_counted: streamResult.stream_counted,
      is_premium: streamResult.is_premium,
      stream_rate_usd: STREAM_RATE_USD,
      reason: streamResult.reason || null,
      rule: 'one_premium_stream_per_user_per_track_per_24h',
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch {}
    }
    console.error('Error adding to history:', error);
    res.status(500).json({ error: 'Failed to add to history' });
  } finally {
    if (connection) connection.release();
  }
});

// Get usage tracking
router.get('/me/usage', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [usage] = await pool.execute(
      'SELECT * FROM user_usage WHERE user_id = ?',
      [userId]
    );

    if (usage.length === 0) {
      // Create usage record if doesn't exist
      const usageId = uuidv4();
      await pool.execute(
        'INSERT INTO user_usage (id, user_id) VALUES (?, ?)',
        [usageId, userId]
      );
      const [newUsage] = await pool.execute(
        'SELECT * FROM user_usage WHERE id = ?',
        [usageId]
      );
      return res.json(newUsage[0]);
    }

    res.json(usage[0]);
  } catch (error) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// Get dynamic user stats for profile dashboard
router.get('/me/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const AVG_MINUTES_PER_TRACK = 3.5;

    const [
      [usageRows],
      [historyRows],
      [monthlyHistoryRows],
      [artistsRows],
      [likedRows],
      [playlistsRows]
    ] = await Promise.all([
      pool.execute(
        'SELECT plays_count FROM user_usage WHERE user_id = ? LIMIT 1',
        [userId]
      ),
      pool.execute(
        'SELECT COUNT(*) AS total FROM listening_history WHERE user_id = ?',
        [userId]
      ),
      pool.execute(
        'SELECT COUNT(*) AS total FROM listening_history WHERE user_id = ? AND played_at >= ?',
        [userId, monthStart]
      ),
      pool.execute(
        `SELECT COUNT(DISTINCT m.artist_name) AS total
         FROM listening_history lh
         INNER JOIN music m ON m.id = lh.track_id
         WHERE lh.user_id = ?`,
        [userId]
      ),
      pool.execute(
        'SELECT COUNT(*) AS total FROM liked_song WHERE user_id = ?',
        [userId]
      ),
      pool.execute(
        'SELECT COUNT(*) AS total FROM playlists WHERE user_id = ?',
        [userId]
      )
    ]);

    const historyCount = Number(historyRows?.[0]?.total || 0);
    const monthlyCount = Number(monthlyHistoryRows?.[0]?.total || 0);
    const usagePlays = Number(usageRows?.[0]?.plays_count || 0);

    const songsPlayed = Math.max(historyCount, usagePlays);
    const totalMinutes = songsPlayed * AVG_MINUTES_PER_TRACK;
    const monthlyMinutes = monthlyCount * AVG_MINUTES_PER_TRACK;

    res.json({
      generated_at: new Date().toISOString(),
      songs_played: songsPlayed,
      artists_discovered: Number(artistsRows?.[0]?.total || 0),
      playlists_created: Number(playlistsRows?.[0]?.total || 0),
      liked_songs: Number(likedRows?.[0]?.total || 0),
      total_listening_minutes: totalMinutes,
      monthly_listening_minutes: monthlyMinutes
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({
        generated_at: new Date().toISOString(),
        songs_played: 0,
        artists_discovered: 0,
        playlists_created: 0,
        liked_songs: 0,
        total_listening_minutes: 0,
        monthly_listening_minutes: 0
      });
    }
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

// Increment plays
router.post('/me/usage/plays', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get or create usage record
    const [usage] = await pool.execute(
      'SELECT * FROM user_usage WHERE user_id = ?',
      [userId]
    );

    if (usage.length === 0) {
      const usageId = uuidv4();
      await pool.execute(
        'INSERT INTO user_usage (id, user_id, plays_count) VALUES (?, ?, 1)',
        [usageId, userId]
      );
    } else {
      await pool.execute(
        'UPDATE user_usage SET plays_count = plays_count + 1 WHERE user_id = ?',
        [userId]
      );
    }

    const [updated] = await pool.execute(
      'SELECT * FROM user_usage WHERE user_id = ?',
      [userId]
    );

    res.json(updated[0]);
  } catch (error) {
    console.error('Error incrementing plays:', error);
    res.status(500).json({ error: 'Failed to increment plays' });
  }
});

// Increment skips
router.post('/me/usage/skips', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get or create usage record
    const [usage] = await pool.execute(
      'SELECT * FROM user_usage WHERE user_id = ?',
      [userId]
    );

    if (usage.length === 0) {
      const usageId = uuidv4();
      await pool.execute(
        'INSERT INTO user_usage (id, user_id, skips_count) VALUES (?, ?, 1)',
        [usageId, userId]
      );
    } else {
      await pool.execute(
        'UPDATE user_usage SET skips_count = skips_count + 1 WHERE user_id = ?',
        [userId]
      );
    }

    const [updated] = await pool.execute(
      'SELECT * FROM user_usage WHERE user_id = ?',
      [userId]
    );

    res.json(updated[0]);
  } catch (error) {
    console.error('Error incrementing skips:', error);
    res.status(500).json({ error: 'Failed to increment skips' });
  }
});

// Get ad files list (si ads_config contient au moins une ligne → uniquement les pubs activées par l’admin)
router.get('/ads/list', async (req, res) => {
  try {
    await ensureAdsTables();
    const [[row]] = await pool.execute('SELECT COUNT(*) AS cnt FROM ads_config');
    const configCount = Number(row?.cnt || 0);
    if (configCount > 0) {
      const [enabled] = await pool.execute(
        'SELECT audio_url FROM ads_config WHERE is_enabled = 1 ORDER BY display_order ASC, audio_url ASC'
      );
      return res.json(enabled.map((r) => r.audio_url));
    }
    const { listAdFiles } = await import('../services/s3Service.js');
    const adFiles = await listAdFiles();
    res.json(adFiles);
  } catch (error) {
    // Table absente ou S3 HS : ne pas bloquer l’app
    if (error.code === 'ER_NO_SUCH_TABLE') {
      try {
        const { listAdFiles } = await import('../services/s3Service.js');
        const adFiles = await listAdFiles();
        return res.json(adFiles);
      } catch (e2) {
        console.warn('Ad files unavailable, returning empty list:', e2.message);
        return res.json([]);
      }
    }
    console.warn('Ad files unavailable, returning empty list:', error.message);
    res.json([]);
  }
});

// Get ads playlist with optional images
router.get('/ads/playlist', async (req, res) => {
  try {
    await ensureAdsTables();
    const [[row]] = await pool.execute('SELECT COUNT(*) AS cnt FROM ads_config');
    const configCount = Number(row?.cnt || 0);
    if (configCount > 0) {
      const [enabled] = await pool.execute(
        'SELECT audio_url, image_url FROM ads_config WHERE is_enabled = 1 ORDER BY display_order ASC, audio_url ASC'
      );
      return res.json(enabled.map((r) => ({
        audio_url: r.audio_url,
        image_url: r.image_url || null
      })));
    }

    const { listAdFiles } = await import('../services/s3Service.js');
    const adFiles = await listAdFiles();
    return res.json(adFiles.map((audio_url) => ({ audio_url, image_url: null })));
  } catch (error) {
    console.warn('Ads playlist unavailable, returning empty list:', error.message);
    res.json([]);
  }
});

// Enregistrer une pub écoutée jusqu’au bout (stats admin)
router.post('/ads/played', optionalAuth, async (req, res) => {
  try {
    await ensureAdsTables();
    const audio_url = typeof req.body?.audio_url === 'string' ? req.body.audio_url.trim() : '';
    if (!audio_url || audio_url.length > 4096) {
      return res.status(400).json({ error: 'audio_url requis' });
    }
    const userId = req.user?.id || null;
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO ad_play_events (id, audio_url, user_id) VALUES (?, ?, ?)',
      [id, audio_url, userId]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Error recording ad play:', error);
    res.status(500).json({ error: 'Failed to record ad play' });
  }
});

export default router;

