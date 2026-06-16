import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import pool from '../database/connection.js';
import requireAdmin from '../middleware/adminAuth.js';
import { uploadToS3, deleteFromS3 } from '../services/s3Service.js';
import {
  multerAudioLimit,
  validateAudioFile,
  validateCoverDimensions,
} from '../utils/uploadRequirements.js';
import {
  STREAM_RATE_USD, PAYOUT_THRESHOLD_USD, FORFEIT_MONTHS,
  processQuarterlyPayouts,
} from '../services/streamRoyaltyService.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: multerAudioLimit,
});
const ADS_S3_PREFIX = 'pub';

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

const ensureConcertArtistLinkColumns = async () => {
  try {
    await pool.query('ALTER TABLE concerts ADD COLUMN artist_id VARCHAR(36) NULL AFTER artist');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  try {
    await pool.query('ALTER TABLE concerts ADD INDEX idx_concert_artist_id (artist_id)');
  } catch (e) {
    if (e.code !== 'ER_DUP_KEYNAME') throw e;
  }
};

// Routes pour la gestion de la musique
router.post('/music', requireAdmin, upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, artist_name, is_premium, is_trending, release_date, lyrics_text } = req.body;
    const audioFile = req.files?.['audio']?.[0];
    const imageFile = req.files?.['image']?.[0];

    if (!title || !artist_name || !audioFile || !imageFile) {
      return res.status(400).json({ error: 'Titre, artiste, audio WAV et cover 2000×2000 sont requis' });
    }
    try {
      validateAudioFile(audioFile);
      validateCoverDimensions(imageFile);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Upload vers S3
    let audioUrl = null;
    let imageUrl = null;

    try {
      console.log('📤 Upload du fichier audio vers S3...');
      audioUrl = await uploadToS3(audioFile.buffer, audioFile.originalname, 'songs');
      console.log('✅ Fichier audio uploadé vers S3:', audioUrl);
      
      if (imageFile) {
        console.log('📤 Upload de l\'image vers S3...');
        imageUrl = await uploadToS3(imageFile.buffer, imageFile.originalname, 'covers');
        console.log('✅ Image uploadée vers S3:', imageUrl);
      }
    } catch (s3Error) {
      console.error('❌ Erreur S3:', s3Error);
      // Si S3 n'est pas configuré, utiliser le stockage local comme fallback
      if (!process.env.AWS_S3_BUCKET_NAME) {
        console.warn('⚠️ S3 non configuré, utilisation du stockage local');
        audioUrl = `/uploads/${audioFile.originalname}`;
        if (imageFile) {
          imageUrl = `/uploads/${imageFile.originalname}`;
        }
      } else {
        throw s3Error;
      }
    }

    // Si release_date n'est pas fourni ou est vide, utiliser la date actuelle (publication immédiate)
    const releaseDate = release_date && release_date.trim() !== '' ? release_date : new Date().toISOString().slice(0, 19).replace('T', ' ');

    const trackId = uuidv4();
    console.log('💾 Enregistrement dans MySQL avec les URLs S3:');
    console.log('   - audio_url:', audioUrl);
    console.log('   - image_url:', imageUrl || 'null');
    
    await pool.execute(
      'INSERT INTO music (id, title, artist_name, audio_url, image_url, is_premium, is_trending, release_date, lyrics_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        trackId,
        title,
        artist_name,
        audioUrl,
        imageUrl,
        is_premium === 'true',
        is_trending === 'true',
        releaseDate,
        lyrics_text || null
      ]
    );

    const [tracks] = await pool.execute('SELECT * FROM music WHERE id = ?', [trackId]);
    console.log('✅ Chanson enregistrée avec succès dans MySQL');
    res.status(201).json(tracks[0]);
  } catch (error) {
    console.error('❌ Error uploading track:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    res.status(500).json({ 
      error: 'Failed to upload track',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

router.put('/music/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_trending, is_premium } = req.body;

    const updateFields = [];
    const values = [];

    if (is_trending !== undefined) {
      updateFields.push('is_trending = ?');
      values.push(is_trending);
    }
    if (is_premium !== undefined) {
      updateFields.push('is_premium = ?');
      values.push(is_premium);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await pool.execute(
      `UPDATE music SET ${updateFields.join(', ')} WHERE id = ?`,
      values
    );

    const [tracks] = await pool.execute('SELECT * FROM music WHERE id = ?', [id]);
    res.json(tracks[0]);
  } catch (error) {
    console.error('Error updating track:', error);
    res.status(500).json({ error: 'Failed to update track' });
  }
});

// Synchronisation des paroles (début de chaque ligne) - calibrage admin
router.put('/music/:id/lyrics-sync', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { lyrics_synced_starts } = req.body;

    if (!Array.isArray(lyrics_synced_starts)) {
      return res.status(400).json({ error: 'lyrics_synced_starts must be an array' });
    }

    // Normaliser : n'accepter que des nombres finis ou null
    const normalized = lyrics_synced_starts.map((v) => {
      if (v === null || v === undefined) return null;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    });

    const json = normalized.length > 0 ? JSON.stringify(normalized) : null;

    await pool.execute(
      'UPDATE music SET lyrics_synced_starts = ? WHERE id = ?',
      [json, id]
    );

    const [tracks] = await pool.execute('SELECT * FROM music WHERE id = ?', [id]);
    if (!tracks || tracks.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    res.json(tracks[0]);
  } catch (error) {
    console.error('Error updating lyrics sync:', error);
    res.status(500).json({ error: 'Failed to update lyrics sync' });
  }
});

router.delete('/music/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Récupérer l'URL du fichier audio avant suppression
    const [tracks] = await pool.execute('SELECT audio_url, image_url FROM music WHERE id = ?', [id]);
    if (tracks.length > 0) {
      const track = tracks[0];
      // Supprimer les fichiers de S3
      if (track.audio_url) await deleteFromS3(track.audio_url);
      if (track.image_url) await deleteFromS3(track.image_url);
    }
    
    await pool.execute('DELETE FROM music WHERE id = ?', [id]);
    res.json({ message: 'Track deleted successfully' });
  } catch (error) {
    console.error('Error deleting track:', error);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

// Routes pour les albums
router.post('/albums', requireAdmin, upload.fields([
  { name: 'cover_image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { name, artist_name, release_date, status, submitted_by } = req.body;
    const coverFile = req.files?.['cover_image']?.[0];

    if (!name || !artist_name) {
      return res.status(400).json({ error: 'Name and artist_name are required' });
    }

    let coverImageUrl = null;
    if (coverFile) {
      try {
        coverImageUrl = await uploadToS3(coverFile.buffer, coverFile.originalname, 'covers');
      } catch (s3Error) {
        if (!process.env.AWS_S3_BUCKET_NAME) {
          coverImageUrl = `/uploads/${coverFile.originalname}`;
        } else {
          throw s3Error;
        }
      }
    }

    const albumId = uuidv4();
    const albumStatus = status || 'approved'; // Par défaut approuvé si créé par admin

    await pool.execute(
      'INSERT INTO albums (id, title, artist_name, cover_image_url, release_date, status, submitted_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [albumId, name, artist_name, coverImageUrl, release_date || null, albumStatus, submitted_by || null]
    );

    const [albums] = await pool.execute('SELECT * FROM albums WHERE id = ?', [albumId]);
    res.status(201).json(albums[0]);
  } catch (error) {
    console.error('Error creating album:', error);
    res.status(500).json({ error: 'Failed to create album' });
  }
});

// Route pour modifier un album
router.put('/albums/:id', requireAdmin, upload.fields([
  { name: 'cover_image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, artist_name, release_date, description, genre, is_popular } = req.body;
    const coverFile = req.files?.['cover_image']?.[0];

    // Récupérer l'album existant
    const [existingAlbums] = await pool.execute('SELECT * FROM albums WHERE id = ?', [id]);
    if (existingAlbums.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const existingAlbum = existingAlbums[0];
    const updateFields = [];
    const values = [];

    if (name) {
      updateFields.push('title = ?');
      values.push(name);
    }
    if (artist_name) {
      updateFields.push('artist_name = ?');
      values.push(artist_name);
    }
    if (release_date !== undefined) {
      updateFields.push('release_date = ?');
      values.push(release_date || null);
    }
    if (description !== undefined) {
      updateFields.push('description = ?');
      values.push(description);
    }
    if (genre !== undefined) {
      updateFields.push('genre = ?');
      values.push(genre);
    }
    if (is_popular !== undefined) {
      updateFields.push('is_popular = ?');
      values.push(is_popular === 'true' || is_popular === true);
    }

    // Gérer l'upload de la nouvelle image
    if (coverFile) {
      // Supprimer l'ancienne image de S3
      if (existingAlbum.cover_image_url) {
        await deleteFromS3(existingAlbum.cover_image_url);
      }

      try {
        const coverImageUrl = await uploadToS3(coverFile.buffer, coverFile.originalname, 'covers');
        updateFields.push('cover_image_url = ?');
        values.push(coverImageUrl);
      } catch (s3Error) {
        if (!process.env.AWS_S3_BUCKET_NAME) {
          updateFields.push('cover_image_url = ?');
          values.push(`/uploads/${coverFile.originalname}`);
        } else {
          throw s3Error;
        }
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await pool.execute(
      `UPDATE albums SET ${updateFields.join(', ')} WHERE id = ?`,
      values
    );

    const [albums] = await pool.execute('SELECT * FROM albums WHERE id = ?', [id]);
    res.json(albums[0]);
  } catch (error) {
    console.error('Error updating album:', error);
    // Vérifier si l'erreur est due à une colonne manquante
    if (error.message && error.message.includes('is_popular')) {
      console.error('La colonne is_popular n\'existe pas encore. Exécutez la migration SQL: backend/database/add_album_is_popular.sql');
      res.status(500).json({ 
        error: 'La colonne is_popular n\'existe pas encore. Veuillez exécuter la migration SQL: backend/database/add_album_is_popular.sql',
        migration_required: true
      });
    } else {
      res.status(500).json({ error: `Failed to update album: ${error.message}` });
    }
  }
});

// Route pour valider/rejeter un album
router.put('/albums/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be pending, approved, or rejected' });
    }

    // If rejecting, delete all tracks, album_tracks, and files from S3
    if (status === 'rejected') {
      // Get album info and all tracks
      const [albums] = await pool.execute('SELECT * FROM albums WHERE id = ?', [id]);
      if (albums.length === 0) {
        return res.status(404).json({ error: 'Album not found' });
      }
      
      const album = albums[0];
      
      // Get all tracks in this album
      const [albumTracks] = await pool.execute(
        'SELECT track_id FROM album_tracks WHERE album_id = ?',
        [id]
      );
      
      // Delete audio files and tracks from S3
      for (const row of albumTracks) {
        const [tracks] = await pool.execute('SELECT audio_url, image_url FROM music WHERE id = ?', [row.track_id]);
        if (tracks.length > 0) {
          const track = tracks[0];
          // Delete audio file from S3
          if (track.audio_url) {
            try {
              await deleteFromS3(track.audio_url);
              console.log(`Deleted audio file from S3: ${track.audio_url}`);
            } catch (s3Error) {
              console.error(`Error deleting audio file from S3: ${track.audio_url}`, s3Error);
            }
          }
          // Delete image file from S3 (if different from cover)
          if (track.image_url && track.image_url !== album.cover_image_url) {
            try {
              await deleteFromS3(track.image_url);
              console.log(`Deleted image file from S3: ${track.image_url}`);
            } catch (s3Error) {
              console.error(`Error deleting image file from S3: ${track.image_url}`, s3Error);
            }
          }
        }
        
        // Delete track from database
        await pool.execute('DELETE FROM music WHERE id = ?', [row.track_id]);
      }
      
      // Delete cover image from S3
      if (album.cover_image_url) {
        try {
          await deleteFromS3(album.cover_image_url);
          console.log(`Deleted cover image from S3: ${album.cover_image_url}`);
        } catch (s3Error) {
          console.error(`Error deleting cover image from S3: ${album.cover_image_url}`, s3Error);
        }
      }
      
      // Delete album_tracks relationships
      await pool.execute('DELETE FROM album_tracks WHERE album_id = ?', [id]);
      
      // Delete album
      await pool.execute('DELETE FROM albums WHERE id = ?', [id]);
      
      console.log(`Album ${id} rejected and all associated files deleted`);
      return res.json({ message: 'Album rejected and all files deleted', id });
    }

    // If approving, just update status
    await pool.execute(
      'UPDATE albums SET status = ? WHERE id = ?',
      [status, id]
    );

    const [albums] = await pool.execute('SELECT * FROM albums WHERE id = ?', [id]);
    res.json(albums[0]);
  } catch (error) {
    console.error('Error updating album status:', error);
    res.status(500).json({ error: 'Failed to update album status' });
  }
});

// Route pour obtenir les albums en attente
router.get('/albums/pending', requireAdmin, async (req, res) => {
  try {
    const [albums] = await pool.execute(
      'SELECT * FROM albums WHERE status = ? ORDER BY created_at DESC',
      ['pending']
    );
    res.json(albums);
  } catch (error) {
    console.error('Error fetching pending albums:', error);
    res.status(500).json({ error: 'Failed to fetch pending albums' });
  }
});

// Route pour obtenir les pistes d'un album (pour l'admin, même si l'album est en attente)
router.get('/albums/:id/tracks', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Admin can see tracks even if album is pending or not released yet
    const [tracks] = await pool.execute(
      `SELECT m.* FROM music m 
       INNER JOIN album_tracks at ON m.id = at.track_id 
       WHERE at.album_id = ?
       ORDER BY at.position ASC, m.created_at ASC`,
      [id]
    );
    
    res.json(tracks);
  } catch (error) {
    console.error('Error fetching album tracks:', error);
    res.status(500).json({ error: 'Failed to fetch album tracks' });
  }
});

// Route pour supprimer un album
router.delete('/albums/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Récupérer l'URL de l'image avant suppression
    const [albums] = await pool.execute('SELECT cover_image_url FROM albums WHERE id = ?', [id]);
    if (albums.length > 0 && albums[0].cover_image_url) {
      await deleteFromS3(albums[0].cover_image_url);
    }
    
    await pool.execute('DELETE FROM albums WHERE id = ?', [id]);
    res.json({ message: 'Album deleted successfully' });
  } catch (error) {
    console.error('Error deleting album:', error);
    res.status(500).json({ error: 'Failed to delete album' });
  }
});

// Routes pour les playlists
router.post('/playlists', requireAdmin, upload.fields([
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { name, description, is_public, track_ids } = req.body;
    const imageFile = req.files?.['image']?.[0];

    if (!name) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    let imageUrl = null;
    if (imageFile) {
      try {
        imageUrl = await uploadToS3(imageFile.buffer, imageFile.originalname, 'playlists');
      } catch (s3Error) {
        if (!process.env.AWS_S3_BUCKET_NAME) {
          imageUrl = `/uploads/${imageFile.originalname}`;
        } else {
          throw s3Error;
        }
      }
    }

    const playlistId = uuidv4();
    // Admin playlists are public by default (for homepage)
    const isPublic = is_public === 'true' || is_public === true || true;

    // Use the authenticated admin user ID (req.user.id is set by requireAdmin middleware)
    const adminUserId = req.user.id;
    if (!adminUserId) {
      return res.status(401).json({ error: 'Admin user ID not found' });
    }

    await pool.execute(
      'INSERT INTO playlists (id, name, description, image_url, is_public, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [playlistId, name, description || null, imageUrl, isPublic, adminUserId]
    );

    // Add tracks if provided
    if (track_ids) {
      let trackIdsArray = [];
      if (typeof track_ids === 'string') {
        try {
          trackIdsArray = JSON.parse(track_ids);
        } catch (e) {
          trackIdsArray = track_ids.split(',').map(id => id.trim()).filter(Boolean);
        }
      } else if (Array.isArray(track_ids)) {
        trackIdsArray = track_ids;
      }

      if (trackIdsArray.length > 0) {
        for (let i = 0; i < trackIdsArray.length; i++) {
          const trackId = trackIdsArray[i];
          const relationId = uuidv4();
          await pool.execute(
            'INSERT INTO playlist_tracks (id, playlist_id, track_id, position) VALUES (?, ?, ?, ?)',
            [relationId, playlistId, trackId, i + 1]
          );
        }
        console.log(`Added ${trackIdsArray.length} tracks to playlist ${playlistId}`);
      }
    }

    const [playlists] = await pool.execute('SELECT * FROM playlists WHERE id = ?', [playlistId]);
    res.status(201).json(playlists[0]);
  } catch (error) {
    console.error('Error creating playlist:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
      files: req.files
    });
    res.status(500).json({ 
      error: 'Failed to create playlist',
      details: error.message 
    });
  }
});

// Update playlist
router.put('/playlists/:id', requireAdmin, upload.fields([
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, is_public, track_ids } = req.body;
    const imageFile = req.files?.['image']?.[0];

    // Check if playlist exists
    const [playlists] = await pool.execute('SELECT * FROM playlists WHERE id = ?', [id]);
    if (playlists.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    let imageUrl = playlists[0].image_url; // Keep existing image if not updated
    if (imageFile) {
      // Delete old image from S3 if exists
      if (playlists[0].image_url && playlists[0].image_url.includes('amazonaws.com')) {
        await deleteFromS3(playlists[0].image_url).catch(console.error);
      }

      try {
        imageUrl = await uploadToS3(imageFile.buffer, imageFile.originalname, 'playlists');
      } catch (s3Error) {
        if (!process.env.AWS_S3_BUCKET_NAME) {
          imageUrl = `/uploads/${imageFile.originalname}`;
        } else {
          throw s3Error;
        }
      }
    }

    const isPublic = is_public === 'true' || is_public === true || playlists[0].is_public;

    // Update playlist
    await pool.execute(
      'UPDATE playlists SET name = ?, description = ?, image_url = ?, is_public = ? WHERE id = ?',
      [name || playlists[0].name, description !== undefined ? description : playlists[0].description, imageUrl, isPublic, id]
    );

    // Update tracks if provided
    if (track_ids !== undefined) {
      // Delete existing tracks
      await pool.execute('DELETE FROM playlist_tracks WHERE playlist_id = ?', [id]);

      // Add new tracks
      let trackIdsArray = [];
      if (typeof track_ids === 'string') {
        try {
          trackIdsArray = JSON.parse(track_ids);
        } catch (e) {
          trackIdsArray = track_ids.split(',').map(id => id.trim()).filter(Boolean);
        }
      } else if (Array.isArray(track_ids)) {
        trackIdsArray = track_ids;
      }

      if (trackIdsArray.length > 0) {
        for (let i = 0; i < trackIdsArray.length; i++) {
          const trackId = trackIdsArray[i];
          const relationId = uuidv4();
          await pool.execute(
            'INSERT INTO playlist_tracks (id, playlist_id, track_id, position) VALUES (?, ?, ?, ?)',
            [relationId, id, trackId, i + 1]
          );
        }
        console.log(`Updated ${trackIdsArray.length} tracks in playlist ${id}`);
      }
    }

    const [updatedPlaylists] = await pool.execute('SELECT * FROM playlists WHERE id = ?', [id]);
    res.json(updatedPlaylists[0]);
  } catch (error) {
    console.error('Error updating playlist:', error);
    res.status(500).json({ 
      error: 'Failed to update playlist',
      details: error.message 
    });
  }
});

// Get playlist tracks (for admin)
router.get('/playlists/:id/tracks', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [tracks] = await pool.execute(
      `SELECT pt.*, m.*
       FROM playlist_tracks pt
       JOIN music m ON pt.track_id = m.id
       WHERE pt.playlist_id = ?
       ORDER BY pt.position ASC`,
      [id]
    );
    res.json(tracks);
  } catch (error) {
    console.error('Error fetching playlist tracks:', error);
    res.status(500).json({ error: 'Failed to fetch playlist tracks' });
  }
});
router.delete('/playlists/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM playlists WHERE id = ?', [id]);
    res.json({ message: 'Playlist deleted successfully' });
  } catch (error) {
    console.error('Error deleting playlist:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// Routes pour les artistes
router.put('/artists/:id', requireAdmin, upload.fields([
  { name: 'profile_image', maxCount: 1 },
  { name: 'cover_image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      bio, 
      genre, 
      country, 
      is_popular, 
      verified,
      social_links 
    } = req.body;

    // Récupérer l'artiste actuel pour les URLs existantes
    const [currentArtists] = await pool.execute(
      'SELECT image_url, cover_image_url FROM artists WHERE id = ?',
      [id]
    );

    if (currentArtists.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    let profileImageUrl = currentArtists[0].image_url;
    let coverImageUrl = currentArtists[0].cover_image_url;

    // Upload de la nouvelle image de profil si fournie
    const profileImageFile = req.files?.['profile_image']?.[0];
    if (profileImageFile) {
      const profileImageKey = `artists/profile/${uuidv4()}-${profileImageFile.originalname}`;
      profileImageUrl = await uploadToS3(profileImageFile.buffer, profileImageKey, profileImageFile.mimetype);
      
      // Supprimer l'ancienne image si elle existe
      if (currentArtists[0].image_url && currentArtists[0].image_url.includes('s3')) {
        await deleteFromS3(currentArtists[0].image_url);
      }
    }

    // Upload de la nouvelle image de couverture si fournie
    const coverImageFile = req.files?.['cover_image']?.[0];
    if (coverImageFile) {
      const coverImageKey = `artists/cover/${uuidv4()}-${coverImageFile.originalname}`;
      coverImageUrl = await uploadToS3(coverImageFile.buffer, coverImageKey, coverImageFile.mimetype);
      
      // Supprimer l'ancienne image si elle existe
      if (currentArtists[0].cover_image_url && currentArtists[0].cover_image_url.includes('s3')) {
        await deleteFromS3(currentArtists[0].cover_image_url);
      }
    }

    // Parser les liens sociaux si fournis
    let socialLinksJson = null;
    if (social_links) {
      try {
        socialLinksJson = typeof social_links === 'string' ? JSON.parse(social_links) : social_links;
      } catch (e) {
        console.error('Error parsing social_links:', e);
      }
    }

    // Construire la requête de mise à jour
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (bio !== undefined) {
      updates.push('bio = ?');
      values.push(bio);
    }
    if (genre !== undefined) {
      updates.push('genre = ?');
      values.push(genre);
    }
    if (country !== undefined) {
      updates.push('country = ?');
      values.push(country);
    }
    if (is_popular !== undefined) {
      updates.push('is_popular = ?');
      values.push(is_popular === 'true' || is_popular === true);
    }
    if (verified !== undefined) {
      updates.push('verified = ?');
      values.push(verified === 'true' || verified === true);
    }
    if (socialLinksJson !== null) {
      updates.push('social_links = ?');
      values.push(JSON.stringify(socialLinksJson));
    }
    if (profileImageUrl !== currentArtists[0].image_url) {
      updates.push('image_url = ?');
      values.push(profileImageUrl);
    }
    if (coverImageUrl !== currentArtists[0].cover_image_url) {
      updates.push('cover_image_url = ?');
      values.push(coverImageUrl);
    }

    if (updates.length === 0) {
      const [artists] = await pool.execute('SELECT * FROM artists WHERE id = ?', [id]);
      return res.json(artists[0]);
    }

    values.push(id);
    const query = `UPDATE artists SET ${updates.join(', ')} WHERE id = ?`;
    await pool.execute(query, values);

    const [artists] = await pool.execute('SELECT * FROM artists WHERE id = ?', [id]);
    res.json(artists[0]);
  } catch (error) {
    console.error('Error updating artist:', error);
    res.status(500).json({ error: 'Failed to update artist' });
  }
});

// Supprimer un artiste
router.delete('/artists/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Récupérer l'artiste pour supprimer les images S3
    const [artists] = await pool.execute(
      'SELECT image_url, cover_image_url FROM artists WHERE id = ?',
      [id]
    );

    if (artists.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const artist = artists[0];

    // Supprimer les images S3 si elles existent
    if (artist.image_url && artist.image_url.includes('s3')) {
      try {
        await deleteFromS3(artist.image_url);
      } catch (error) {
        console.error('Error deleting profile image from S3:', error);
      }
    }

    if (artist.cover_image_url && artist.cover_image_url.includes('s3')) {
      try {
        await deleteFromS3(artist.cover_image_url);
      } catch (error) {
        console.error('Error deleting cover image from S3:', error);
      }
    }

    // Supprimer l'artiste (les foreign keys CASCADE supprimeront les relations)
    await pool.execute('DELETE FROM artists WHERE id = ?', [id]);

    res.json({ success: true, message: 'Artist deleted successfully' });
  } catch (error) {
    console.error('Error deleting artist:', error);
    res.status(500).json({ error: 'Failed to delete artist' });
  }
});

// Tableau de bord global (admin)
router.get('/stats/overview', requireAdmin, async (req, res) => {
  try {
    const [[usersRow]] = await pool.execute('SELECT COUNT(*) AS c FROM users');
    const [[artistsRow]] = await pool.execute('SELECT COUNT(*) AS c FROM artists');
    const [[streamsRow]] = await pool.execute(
      `SELECT COUNT(*) AS c FROM counted_stream_events WHERE is_counted = TRUE`
    ).catch(async () => {
      const [[fallback]] = await pool.execute(
        'SELECT COALESCE(SUM(total_counted), 0) AS c FROM user_track_streams'
      );
      return [[fallback]];
    });
    const [[revenueRow]] = await pool.execute(
      `SELECT COALESCE(SUM(artist_amount + producer_amount), 0) AS c FROM counted_stream_events WHERE is_counted = TRUE`
    ).catch(() => [[{ c: 0 }]]);
    const [[pendingRow]] = await pool.execute(
      'SELECT COALESCE(SUM(pending_balance), 0) AS c FROM royalty_balances'
    ).catch(() => [[{ c: 0 }]]);
    let adPlays = 0;
    try {
      const [[adRow]] = await pool.execute('SELECT COUNT(*) AS c FROM ad_play_events');
      adPlays = Number(adRow?.c || 0);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    res.json({
      generated_at: new Date().toISOString(),
      total_users: Number(usersRow?.c || 0),
      total_artists: Number(artistsRow?.c || 0),
      total_streams_counted: Number(streamsRow?.c || 0),
      total_revenue_usd: Number(revenueRow?.c || 0),
      total_pending_payouts_usd: Number(pendingRow?.c || 0),
      total_ad_plays: adPlays,
    });
  } catch (error) {
    console.error('Error fetching admin overview stats:', error);
    res.status(500).json({ error: 'Failed to fetch overview stats' });
  }
});

// Catalogue pubs S3 + réglages admin
router.get('/ads/catalog', requireAdmin, async (req, res) => {
  await ensureAdsTables();
  let s3Files = [];
  try {
    const { listAdFiles } = await import('../services/s3Service.js');
    s3Files = await listAdFiles();
  } catch (e) {
    console.warn('listAdFiles (admin catalog):', e.message);
  }

  let dbRows = [];
  try {
    const [rows] = await pool.execute(
      'SELECT audio_url, image_url, is_enabled, display_order FROM ads_config ORDER BY display_order ASC, audio_url ASC'
    );
    dbRows = rows;
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }

  const dbMap = new Map(dbRows.map((r) => [r.audio_url, r]));
  const allUrls = [...new Set([...s3Files, ...dbRows.map((r) => r.audio_url)])];
  allUrls.sort((a, b) => {
    const oa = dbMap.get(a)?.display_order ?? 1e9;
    const ob = dbMap.get(b)?.display_order ?? 1e9;
    if (oa !== ob) return oa - ob;
    return String(a).localeCompare(String(b));
  });

  const s3Set = new Set(s3Files);
  const items = allUrls.map((audio_url, idx) => {
    const row = dbMap.get(audio_url);
    return {
      audio_url,
      image_url: row?.image_url || null,
      is_enabled: row ? Boolean(row.is_enabled) : true,
      display_order: row?.display_order ?? idx,
      in_s3: s3Set.has(audio_url),
    };
  });

  res.json({
    s3_available: s3Files.length,
    uses_admin_filter: dbRows.length > 0,
    items,
  });
});

// Mettre à jour activation / ordre des pubs
router.put('/ads', requireAdmin, async (req, res) => {
  try {
    await ensureAdsTables();
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'items[] requis' });
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const audio_url = typeof it?.audio_url === 'string' ? it.audio_url.trim() : '';
      if (!audio_url) continue;
      const is_enabled = Boolean(it?.is_enabled);
      await pool.execute(
        `INSERT INTO ads_config (audio_url, is_enabled, display_order)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), display_order = VALUES(display_order)`,
        [audio_url, is_enabled, i]
      );
    }
    res.json({ ok: true, updated: items.length });
  } catch (error) {
    console.error('Error saving ads config:', error);
    res.status(500).json({ error: 'Failed to save ads config' });
  }
});

// Upload direct de pubs depuis l'appareil admin
router.post('/ads/upload', requireAdmin, upload.array('ads', 20), async (req, res) => {
  try {
    await ensureAdsTables();
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const acceptedExtensions = ['.mp3', '.wav', '.m4a', '.mp4'];
    const uploadedUrls = [];

    for (const file of files) {
      const lower = String(file.originalname || '').toLowerCase();
      const hasValidExtension = acceptedExtensions.some((ext) => lower.endsWith(ext));
      if (!hasValidExtension) continue;
      const audioUrl = await uploadToS3(file.buffer, file.originalname, ADS_S3_PREFIX);
      // Garde-fou: on refuse tout upload hors dossier pub/
      if (!String(audioUrl).includes(`/${ADS_S3_PREFIX}/`)) {
        throw new Error('Upload pub invalide: fichier non stocké dans pub/');
      }
      uploadedUrls.push(audioUrl);
    }

    if (uploadedUrls.length === 0) {
      return res.status(400).json({ error: 'Formats autorisés: mp3, wav, m4a, mp4' });
    }

    const [[maxRow]] = await pool.execute(
      'SELECT COALESCE(MAX(display_order), -1) AS m FROM ads_config'
    );
    let nextOrder = Number(maxRow?.m ?? -1) + 1;

    for (const url of uploadedUrls) {
      await pool.execute(
        `INSERT INTO ads_config (audio_url, is_enabled, display_order)
         VALUES (?, 1, ?)
         ON DUPLICATE KEY UPDATE is_enabled = 1`,
        [url, nextOrder++]
      );
    }

    res.status(201).json({
      ok: true,
      uploaded: uploadedUrls.length,
      s3_prefix: ADS_S3_PREFIX,
      urls: uploadedUrls
    });
  } catch (error) {
    console.error('Error uploading ads files:', error);
    res.status(500).json({ error: 'Failed to upload ad files' });
  }
});

// Associer / remplacer l'image d'une pub
router.post('/ads/image', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    await ensureAdsTables();
    const audio_url = typeof req.body?.audio_url === 'string' ? req.body.audio_url.trim() : '';
    const image = req.file;

    if (!audio_url) return res.status(400).json({ error: 'audio_url requis' });
    if (!image) return res.status(400).json({ error: 'Fichier image requis' });

    const lower = String(image.originalname || '').toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const hasValidExtension = imageExtensions.some((ext) => lower.endsWith(ext));
    if (!hasValidExtension) {
      return res.status(400).json({ error: 'Formats image autorisés: jpg, jpeg, png, webp, gif' });
    }

    const imageUrl = await uploadToS3(image.buffer, image.originalname, ADS_S3_PREFIX);
    if (!String(imageUrl).includes(`/${ADS_S3_PREFIX}/`)) {
      throw new Error('Upload image pub invalide: fichier non stocké dans pub/');
    }

    await pool.execute(
      `INSERT INTO ads_config (audio_url, image_url, is_enabled, display_order)
       VALUES (?, ?, 1, 0)
       ON DUPLICATE KEY UPDATE image_url = VALUES(image_url)`,
      [audio_url, imageUrl]
    );

    res.status(201).json({ ok: true, audio_url, image_url: imageUrl });
  } catch (error) {
    console.error('Error uploading ad image:', error);
    res.status(500).json({ error: 'Failed to upload ad image' });
  }
});

// Importer les fichiers présents sur S3 (nouvelles entrées activées par défaut)
router.post('/ads/sync-from-s3', requireAdmin, async (req, res) => {
  try {
    await ensureAdsTables();
    const { listAdFiles } = await import('../services/s3Service.js');
    const s3Files = await listAdFiles();
    const [[maxRow]] = await pool.execute(
      'SELECT COALESCE(MAX(display_order), -1) AS m FROM ads_config'
    );
    let nextOrder = Number(maxRow?.m ?? -1) + 1;
    let inserted = 0;
    for (const url of s3Files) {
      const [existing] = await pool.execute(
        'SELECT audio_url FROM ads_config WHERE audio_url = ?',
        [url]
      );
      if (existing.length === 0) {
        await pool.execute(
          'INSERT INTO ads_config (audio_url, is_enabled, display_order) VALUES (?, 1, ?)',
          [url, nextOrder++]
        );
        inserted += 1;
      }
    }
    res.json({ ok: true, inserted, total_on_s3: s3Files.length });
  } catch (error) {
    console.error('Error syncing ads from S3:', error);
    res.status(500).json({ error: 'Failed to sync ads from S3' });
  }
});

// Concerts management (admin)
router.get('/concerts', requireAdmin, async (req, res) => {
  try {
    await ensureConcertArtistLinkColumns();
    const [rows] = await pool.execute(
      `SELECT c.*, a.id AS linked_artist_id, a.name AS linked_artist_name
       FROM concerts c
       LEFT JOIN artists a ON a.id = c.artist_id
       ORDER BY c.date DESC, c.time DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error('Error fetching admin concerts:', error);
    res.status(500).json({ error: 'Failed to fetch concerts' });
  }
});

router.post('/concerts', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    await ensureConcertArtistLinkColumns();
    const {
      title,
      artist,
      artist_id,
      venue,
      city,
      date,
      time,
      price,
      currency,
      genre,
      capacity,
      description,
      is_popular
    } = req.body;

    if (!title || !venue || !city || !date || !time || !price || !capacity) {
      return res.status(400).json({ error: 'Champs requis manquants' });
    }

    let artistName = (artist || '').trim();
    let linkedArtistId = (artist_id || '').trim() || null;
    if (linkedArtistId) {
      const [artists] = await pool.execute('SELECT id, name FROM artists WHERE id = ? LIMIT 1', [linkedArtistId]);
      if (artists.length > 0) {
        artistName = artists[0].name;
      } else {
        linkedArtistId = null;
      }
    }
    if (!artistName) {
      return res.status(400).json({ error: 'Nom artiste requis (lié ou manuel)' });
    }

    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadToS3(req.file.buffer, req.file.originalname, 'concerts');
    }

    const id = uuidv4();
    await pool.execute(
      `INSERT INTO concerts
      (id, title, artist, artist_id, venue, city, date, time, price, currency, image_url, genre, capacity, description, is_popular, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        title,
        artistName,
        linkedArtistId,
        venue,
        city,
        date,
        time,
        Number(price),
        (currency || 'CDF').toUpperCase(),
        imageUrl,
        genre || null,
        Number(capacity),
        description || null,
        String(is_popular) === 'true' || is_popular === true
      ]
    );

    const [rows] = await pool.execute('SELECT * FROM concerts WHERE id = ?', [id]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating concert:', error);
    res.status(500).json({ error: 'Failed to create concert' });
  }
});

router.put('/concerts/:id', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    await ensureConcertArtistLinkColumns();
    const { id } = req.params;
    const {
      title,
      artist,
      artist_id,
      venue,
      city,
      date,
      time,
      price,
      currency,
      genre,
      capacity,
      description,
      is_popular,
      is_active
    } = req.body;

    const [currentRows] = await pool.execute('SELECT * FROM concerts WHERE id = ?', [id]);
    if (currentRows.length === 0) return res.status(404).json({ error: 'Concert not found' });

    let artistName = (artist || '').trim();
    let linkedArtistId = (artist_id || '').trim() || null;
    if (linkedArtistId) {
      const [artists] = await pool.execute('SELECT id, name FROM artists WHERE id = ? LIMIT 1', [linkedArtistId]);
      if (artists.length > 0) artistName = artists[0].name;
      else linkedArtistId = null;
    }
    if (!artistName) artistName = currentRows[0].artist;

    let imageUrl = currentRows[0].image_url || null;
    if (req.file) {
      imageUrl = await uploadToS3(req.file.buffer, req.file.originalname, 'concerts');
    }

    await pool.execute(
      `UPDATE concerts
       SET title = ?, artist = ?, artist_id = ?, venue = ?, city = ?, date = ?, time = ?,
           price = ?, currency = ?, image_url = ?, genre = ?, capacity = ?, description = ?,
           is_popular = ?, is_active = ?
       WHERE id = ?`,
      [
        title || currentRows[0].title,
        artistName,
        linkedArtistId,
        venue || currentRows[0].venue,
        city || currentRows[0].city,
        date || currentRows[0].date,
        time || currentRows[0].time,
        Number(price ?? currentRows[0].price),
        (currency || currentRows[0].currency || 'CDF').toUpperCase(),
        imageUrl,
        genre ?? currentRows[0].genre,
        Number(capacity ?? currentRows[0].capacity),
        description ?? currentRows[0].description,
        is_popular === undefined ? currentRows[0].is_popular : (String(is_popular) === 'true' || is_popular === true),
        is_active === undefined ? currentRows[0].is_active : (String(is_active) === 'true' || is_active === true),
        id
      ]
    );

    const [rows] = await pool.execute('SELECT * FROM concerts WHERE id = ?', [id]);
    res.json(rows[0]);
  } catch (error) {
    console.error('Error updating concert:', error);
    res.status(500).json({ error: 'Failed to update concert' });
  }
});

router.delete('/concerts/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM concerts WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting concert:', error);
    res.status(500).json({ error: 'Failed to delete concert' });
  }
});

// Rapport streams premium (comptage monétisable: 1 stream premium/user/track/24h)
router.get('/streams/report', requireAdmin, async (req, res) => {
  try {
    const daysParam = Number.parseInt(String(req.query.days ?? '30'), 10);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 365) : 30;

    const [globalRows] = await pool.execute(
      `SELECT
         COUNT(*) AS total_events,
         SUM(CASE WHEN is_counted = TRUE THEN 1 ELSE 0 END) AS total_counted_streams,
         SUM(CASE WHEN is_counted = FALSE AND skip_reason = 'not_premium' THEN 1 ELSE 0 END) AS skipped_not_premium,
         SUM(CASE WHEN is_counted = FALSE AND skip_reason = 'within_24h' THEN 1 ELSE 0 END) AS skipped_within_24h,
         COUNT(DISTINCT CASE WHEN is_counted = TRUE THEN listener_user_id END) AS unique_premium_listeners,
         COALESCE(SUM(CASE WHEN is_counted = TRUE THEN artist_amount + producer_amount ELSE 0 END), 0) AS total_revenue_usd
       FROM counted_stream_events
       WHERE listened_at >= (NOW() - INTERVAL ? DAY)`,
      [days]
    );

    const [trackRows] = await pool.execute(
      `SELECT
         cse.track_id,
         cse.track_title AS title,
         cse.artist_name,
         m.image_url,
         COUNT(*) AS counted_streams,
         COALESCE(SUM(cse.artist_amount + cse.producer_amount), 0) AS revenue_usd,
         COUNT(DISTINCT cse.listener_user_id) AS unique_listeners,
         MAX(cse.listened_at) AS last_counted_at
       FROM counted_stream_events cse
       LEFT JOIN music m ON m.id = cse.track_id
       WHERE cse.is_counted = TRUE AND cse.listened_at >= (NOW() - INTERVAL ? DAY)
       GROUP BY cse.track_id, cse.track_title, cse.artist_name, m.image_url
       ORDER BY counted_streams DESC
       LIMIT 50`,
      [days]
    );

    const [artistRows] = await pool.execute(
      `SELECT
         cse.artist_name,
         COUNT(*) AS counted_streams,
         COALESCE(SUM(cse.artist_amount + cse.producer_amount), 0) AS revenue_usd,
         COUNT(DISTINCT cse.listener_user_id) AS unique_listeners,
         COUNT(DISTINCT cse.track_id) AS tracks_count,
         MAX(cse.listened_at) AS last_counted_at
       FROM counted_stream_events cse
       WHERE cse.is_counted = TRUE AND cse.listened_at >= (NOW() - INTERVAL ? DAY)
       GROUP BY cse.artist_name
       ORDER BY counted_streams DESC
       LIMIT 50`,
      [days]
    );

    const global = globalRows[0] || {};

    res.json({
      period_days: days,
      generated_at: new Date().toISOString(),
      rules: {
        stream_rate_usd: STREAM_RATE_USD,
        payout_threshold_usd: PAYOUT_THRESHOLD_USD,
        premium_only: true,
        dedup_rule: '1 stream par titre par utilisateur premium toutes les 24h',
      },
      global: {
        total_events: Number(global.total_events || 0),
        total_counted_streams: Number(global.total_counted_streams || 0),
        skipped_not_premium: Number(global.skipped_not_premium || 0),
        skipped_within_24h: Number(global.skipped_within_24h || 0),
        unique_premium_listeners: Number(global.unique_premium_listeners || 0),
        total_revenue_usd: Number(global.total_revenue_usd || 0),
        unique_user_track_pairs: Number(global.total_counted_streams || 0),
        unique_listeners: Number(global.unique_premium_listeners || 0),
      },
      top_tracks: trackRows.map((row) => ({
        track_id: row.track_id,
        title: row.title,
        artist_name: row.artist_name,
        image_url: row.image_url,
        counted_streams: Number(row.counted_streams || 0),
        revenue_usd: Number(row.revenue_usd || 0),
        unique_listeners: Number(row.unique_listeners || 0),
        last_counted_at: row.last_counted_at,
      })),
      top_artists: artistRows.map((row) => ({
        artist_name: row.artist_name,
        counted_streams: Number(row.counted_streams || 0),
        revenue_usd: Number(row.revenue_usd || 0),
        unique_listeners: Number(row.unique_listeners || 0),
        tracks_count: Number(row.tracks_count || 0),
        last_counted_at: row.last_counted_at,
      })),
    });
  } catch (error) {
    console.error('Error fetching streams report:', error);
    res.status(500).json({ error: 'Failed to fetch streams report' });
  }
});

// Rapport royalties & paiements (supervision admin complète)
router.get('/royalties/report', requireAdmin, async (req, res) => {
  try {
    const daysParam = Number.parseInt(String(req.query.days ?? '90'), 10);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 365) : 90;

    const [[global]] = await pool.execute(
      `SELECT
         COUNT(*) AS total_events,
         SUM(CASE WHEN is_counted = TRUE THEN 1 ELSE 0 END) AS counted_streams,
         SUM(CASE WHEN skip_reason = 'not_premium' THEN 1 ELSE 0 END) AS skipped_not_premium,
         SUM(CASE WHEN skip_reason = 'within_24h' THEN 1 ELSE 0 END) AS skipped_within_24h,
         COALESCE(SUM(CASE WHEN is_counted = TRUE THEN artist_amount + producer_amount ELSE 0 END), 0) AS total_revenue
       FROM counted_stream_events
       WHERE listened_at >= (NOW() - INTERVAL ? DAY)`,
      [days]
    );

    const [[balancesGlobal]] = await pool.execute(
      `SELECT
         COALESCE(SUM(pending_balance), 0) AS total_pending,
         COALESCE(SUM(total_earned), 0) AS total_earned,
         COALESCE(SUM(total_paid), 0) AS total_paid,
         COUNT(*) AS accounts_with_balance
       FROM royalty_balances`
    );

    const [[payoutsGlobal]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) AS total_paid,
         COALESCE(SUM(CASE WHEN status = 'forfeited' THEN amount ELSE 0 END), 0) AS total_forfeited,
         COUNT(*) AS payout_count
       FROM royalty_payouts`
    );

    const [balances] = await pool.execute(
      `SELECT rb.*, u.email, u.full_name,
              CASE WHEN rb.account_type = 'artist' THEN aa.artist_name ELSE ps.company_name END AS display_name
       FROM royalty_balances rb
       JOIN users u ON u.id = rb.user_id
       LEFT JOIN artist_applications aa ON aa.user_id = rb.user_id AND aa.status = 'approved' AND rb.account_type = 'artist'
       LEFT JOIN producer_applications pa ON pa.user_id = rb.user_id AND pa.status = 'approved' AND rb.account_type = 'producer'
       LEFT JOIN producer_settings ps ON ps.user_id = rb.user_id AND rb.account_type = 'producer'
       ORDER BY rb.pending_balance DESC`
    );

    const enrichedBalances = balances.map((b) => {
      const accumStart = new Date(b.accumulation_started_at);
      const monthsElapsed =
        (new Date().getFullYear() - accumStart.getFullYear()) * 12 +
        (new Date().getMonth() - accumStart.getMonth());
      return {
        ...b,
        pending_balance: Number(b.pending_balance),
        total_earned: Number(b.total_earned),
        total_paid: Number(b.total_paid),
        months_until_forfeit: Math.max(0, FORFEIT_MONTHS - monthsElapsed),
        can_be_paid: Number(b.pending_balance) >= PAYOUT_THRESHOLD_USD,
        display_name: b.display_name || b.full_name || b.email,
      };
    });

    const [payouts] = await pool.execute(
      `SELECT rp.*, u.email, u.full_name
       FROM royalty_payouts rp
       JOIN users u ON u.id = rp.user_id
       ORDER BY rp.created_at DESC LIMIT 100`
    );

    const [recentEvents] = await pool.execute(
      `SELECT cse.id, cse.track_title, cse.artist_name, cse.is_premium, cse.is_counted, cse.skip_reason,
              cse.artist_amount, cse.producer_amount, cse.listened_at,
              lu.email AS listener_email
       FROM counted_stream_events cse
       LEFT JOIN users lu ON lu.id = cse.listener_user_id
       ORDER BY cse.listened_at DESC LIMIT 200`
    );

    const [streamsByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(listened_at, '%Y-%m') AS month,
              SUM(CASE WHEN is_counted = TRUE THEN 1 ELSE 0 END) AS counted,
              COALESCE(SUM(CASE WHEN is_counted = TRUE THEN artist_amount + producer_amount ELSE 0 END), 0) AS revenue
       FROM counted_stream_events
       WHERE listened_at >= (NOW() - INTERVAL ? DAY)
       GROUP BY DATE_FORMAT(listened_at, '%Y-%m')
       ORDER BY month ASC`,
      [days]
    );

    const [topEarners] = await pool.execute(
      `SELECT rb.account_type, rb.user_id, u.email, u.full_name,
              COALESCE(aa.artist_name, ps.company_name, u.full_name) AS display_name,
              rb.pending_balance, rb.total_earned, rb.total_paid
       FROM royalty_balances rb
       JOIN users u ON u.id = rb.user_id
       LEFT JOIN artist_applications aa ON aa.user_id = rb.user_id AND rb.account_type = 'artist'
       LEFT JOIN producer_settings ps ON ps.user_id = rb.user_id AND rb.account_type = 'producer'
       ORDER BY rb.total_earned DESC LIMIT 20`
    );

    res.json({
      period_days: days,
      generated_at: new Date().toISOString(),
      rules: {
        stream_rate_usd: STREAM_RATE_USD,
        payout_threshold_usd: PAYOUT_THRESHOLD_USD,
        payout_frequency: 'trimestriel',
        forfeit_after_months: FORFEIT_MONTHS,
        premium_only: true,
      },
      global: {
        total_events: Number(global?.total_events || 0),
        counted_streams: Number(global?.counted_streams || 0),
        skipped_not_premium: Number(global?.skipped_not_premium || 0),
        skipped_within_24h: Number(global?.skipped_within_24h || 0),
        total_revenue: Number(global?.total_revenue || 0),
        total_pending: Number(balancesGlobal?.total_pending || 0),
        total_earned: Number(balancesGlobal?.total_earned || 0),
        total_paid: Number(payoutsGlobal?.total_paid || 0),
        total_forfeited: Number(payoutsGlobal?.total_forfeited || 0),
        accounts_with_balance: Number(balancesGlobal?.accounts_with_balance || 0),
        payout_count: Number(payoutsGlobal?.payout_count || 0),
      },
      balances: enrichedBalances,
      payouts: payouts.map((p) => ({ ...p, amount: Number(p.amount) })),
      recent_events: recentEvents.map((e) => ({
        ...e,
        artist_amount: Number(e.artist_amount),
        producer_amount: Number(e.producer_amount),
        total_amount: Number(e.artist_amount) + Number(e.producer_amount),
      })),
      streams_by_month: streamsByMonth.map((r) => ({
        month: r.month,
        counted: Number(r.counted),
        revenue: Number(r.revenue),
      })),
      top_earners: topEarners.map((e) => ({
        ...e,
        pending_balance: Number(e.pending_balance),
        total_earned: Number(e.total_earned),
        total_paid: Number(e.total_paid),
      })),
    });
  } catch (error) {
    console.error('Error fetching royalties report:', error);
    res.status(500).json({ error: 'Failed to fetch royalties report' });
  }
});

// Déclencher manuellement la revue trimestrielle des paiements
router.post('/royalties/process-quarterly', requireAdmin, async (req, res) => {
  try {
    const result = await processQuarterlyPayouts(true);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error processing quarterly payouts:', error);
    res.status(500).json({ error: 'Failed to process quarterly payouts' });
  }
});

export default router;
