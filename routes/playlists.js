import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import requireAdmin from '../middleware/adminAuth.js';

const router = express.Router();

// Get user's playlists
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [playlists] = await pool.execute(
      `SELECT p.*, COUNT(pt.id) as track_count
       FROM playlists p
       LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
       WHERE p.user_id = ?
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [userId]
    );

    res.json(playlists);
  } catch (error) {
    console.error('Error fetching playlists:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get all public playlists (for admin)
router.get('/public', optionalAuth, async (req, res) => {
  try {
    const [playlists] = await pool.execute(
      `SELECT p.*, COUNT(pt.id) as track_count
       FROM playlists p
       LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
       WHERE p.is_public = true
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );

    res.json(playlists);
  } catch (error) {
    console.error('Error fetching public playlists:', error);
    res.status(500).json({ error: 'Failed to fetch public playlists' });
  }
});

// Get playlist by ID
// Allow access to public playlists or user's own playlists
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id; // Optional, can be undefined if not authenticated

    // If user is authenticated, allow access to their own playlists or public playlists
    // If user is not authenticated, only allow access to public playlists
    let query = 'SELECT * FROM playlists WHERE id = ?';
    let params = [id];
    
    if (userId) {
      query += ' AND (is_public = true OR user_id = ?)';
      params.push(userId);
    } else {
      query += ' AND is_public = true';
    }

    const [playlists] = await pool.execute(query, params);

    if (playlists.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    res.json(playlists[0]);
  } catch (error) {
    console.error('Error fetching playlist:', error);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

// Get playlist tracks
// Allow access to public playlist tracks or user's own playlist tracks
router.get('/:id/tracks', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id; // Optional, can be undefined if not authenticated

    // Verify playlist exists and is accessible (public or owned by user)
    let query = 'SELECT id, is_public, user_id FROM playlists WHERE id = ?';
    let params = [id];
    
    if (userId) {
      query += ' AND (is_public = true OR user_id = ?)';
      params.push(userId);
    } else {
      query += ' AND is_public = true';
    }

    const [playlists] = await pool.execute(query, params);

    if (playlists.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const [tracks] = await pool.execute(
      `SELECT pt.id, pt.playlist_id, pt.track_id, pt.position, pt.added_at,
              m.id as music_id, m.title, m.artist_name, m.audio_url, m.image_url, m.is_premium, m.created_at
       FROM playlist_tracks pt
       JOIN music m ON pt.track_id = m.id
       WHERE pt.playlist_id = ?
       ORDER BY pt.position ASC`,
      [id]
    );

    // Format tracks to match frontend expectations
    const formattedTracks = tracks.map((row) => ({
      id: row.id,
      playlist_id: row.playlist_id,
      track_id: row.track_id,
      position: row.position,
      added_at: row.added_at,
      track: {
        id: row.music_id,
        title: row.title,
        artist_name: row.artist_name,
        audio_url: row.audio_url,
        image_url: row.image_url,
        is_premium: row.is_premium === 1 || row.is_premium === true,
        created_at: row.created_at
      }
    }));

    res.json(formattedTracks);
  } catch (error) {
    console.error('Error fetching playlist tracks:', error);
    res.status(500).json({ error: 'Failed to fetch playlist tracks' });
  }
});

// Create playlist
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, image_url, is_public, track_ids } = req.body;
    const userId = req.user.id;

    if (!name) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    const playlistId = uuidv4();

    await pool.execute(
      'INSERT INTO playlists (id, name, description, user_id, image_url, is_public) VALUES (?, ?, ?, ?, ?, ?)',
      [playlistId, name, description || null, userId, image_url || null, is_public || false]
    );

    // Add tracks if provided
    if (track_ids && Array.isArray(track_ids) && track_ids.length > 0) {
      const trackInserts = track_ids.map((trackId, index) => {
        return [uuidv4(), playlistId, trackId, index];
      });

      for (const [id, pid, tid, pos] of trackInserts) {
        await pool.execute(
          'INSERT INTO playlist_tracks (id, playlist_id, track_id, position) VALUES (?, ?, ?, ?)',
          [id, pid, tid, pos]
        );
      }
    }

    const [playlists] = await pool.execute('SELECT * FROM playlists WHERE id = ?', [playlistId]);
    res.status(201).json(playlists[0]);
  } catch (error) {
    console.error('Error creating playlist:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// Update playlist
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, image_url, is_public } = req.body;
    const userId = req.user.id;

    // Verify playlist ownership
    const [playlists] = await pool.execute(
      'SELECT id FROM playlists WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (playlists.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    await pool.execute(
      'UPDATE playlists SET name = ?, description = ?, image_url = ?, is_public = ? WHERE id = ?',
      [name, description || null, image_url || null, is_public || false, id]
    );

    const [updatedPlaylists] = await pool.execute('SELECT * FROM playlists WHERE id = ?', [id]);
    res.json(updatedPlaylists[0]);
  } catch (error) {
    console.error('Error updating playlist:', error);
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

// Delete playlist
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Verify playlist ownership
    const [playlists] = await pool.execute(
      'SELECT id FROM playlists WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (playlists.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    await pool.execute('DELETE FROM playlists WHERE id = ?', [id]);
    res.json({ message: 'Playlist deleted successfully' });
  } catch (error) {
    console.error('Error deleting playlist:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// Add track to playlist
router.post('/:id/tracks', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { track_id } = req.body;
    const userId = req.user.id;

    if (!track_id) {
      return res.status(400).json({ error: 'track_id is required' });
    }

    // Verify playlist ownership
    const [playlists] = await pool.execute(
      'SELECT id FROM playlists WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (playlists.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Get current max position
    const [positions] = await pool.execute(
      'SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id = ?',
      [id]
    );
    const nextPosition = (positions[0]?.max_pos ?? -1) + 1;

    const playlistTrackId = uuidv4();

    await pool.execute(
      'INSERT INTO playlist_tracks (id, playlist_id, track_id, position) VALUES (?, ?, ?, ?)',
      [playlistTrackId, id, track_id, nextPosition]
    );

    res.status(201).json({ message: 'Track added to playlist' });
  } catch (error) {
    console.error('Error adding track to playlist:', error);
    res.status(500).json({ error: 'Failed to add track to playlist' });
  }
});

// Remove track from playlist
router.delete('/:id/tracks/:trackId', authenticateToken, async (req, res) => {
  try {
    const { id, trackId } = req.params;
    const userId = req.user.id;

    // Verify playlist ownership
    const [playlists] = await pool.execute(
      'SELECT id FROM playlists WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (playlists.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    await pool.execute(
      'DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?',
      [id, trackId]
    );

    res.json({ message: 'Track removed from playlist' });
  } catch (error) {
    console.error('Error removing track from playlist:', error);
    res.status(500).json({ error: 'Failed to remove track from playlist' });
  }
});

export default router;
