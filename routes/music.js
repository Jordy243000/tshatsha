import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import pool from '../database/connection.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { uploadToS3, deleteFromS3 } from '../services/s3Service.js';
import { resolveArtistContext, createSingleSubmission } from '../services/releaseWorkflowService.js';
import {
  multerAudioLimit,
  validateAudioFile,
  validateCoverDimensions,
  COVER_SIZE_PX,
} from '../utils/uploadRequirements.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: multerAudioLimit,
});

// Get all tracks (exclude tracks from non-approved albums)
router.get('/', optionalAuth, async (req, res) => {
  try {
    // Exclude tracks that belong to albums with status 'pending' or 'rejected'
    // Tracks not in album_tracks are standalone and always visible
    const [tracks] = await pool.execute(
      `SELECT DISTINCT m.* FROM music m
       LEFT JOIN album_tracks at ON m.id = at.track_id
       LEFT JOIN albums a ON at.album_id = a.id
       WHERE (at.track_id IS NULL OR (a.status = 'approved' AND (a.release_date IS NULL OR a.release_date <= CURDATE())))
       ORDER BY m.created_at DESC`
    );
    res.json(tracks);
  } catch (error) {
    console.error('Error fetching tracks:', error);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// Get trending tracks (exclude tracks from non-approved albums)
router.get('/trending', optionalAuth, async (req, res) => {
  try {
    // Exclude tracks that belong to albums with status 'pending' or 'rejected'
    const [tracks] = await pool.execute(
      `SELECT m.*, COUNT(lh.id) as plays
       FROM music m
       LEFT JOIN listening_history lh ON m.id = lh.track_id
       LEFT JOIN album_tracks at ON m.id = at.track_id
       LEFT JOIN albums a ON at.album_id = a.id
       WHERE m.is_trending = true
       AND (at.track_id IS NULL OR (a.status = 'approved' AND (a.release_date IS NULL OR a.release_date <= CURDATE())))
       GROUP BY m.id
       ORDER BY m.created_at DESC
       LIMIT 60`
    );
    res.json(tracks);
  } catch (error) {
    console.error('Error fetching trending tracks:', error);
    res.status(500).json({ error: 'Failed to fetch trending tracks' });
  }
});

// Get track by ID (exclude if from non-approved album)
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    // Check if track belongs to an album and if so, verify album is approved
    const [tracks] = await pool.execute(
      `SELECT m.* FROM music m
       LEFT JOIN album_tracks at ON m.id = at.track_id
       LEFT JOIN albums a ON at.album_id = a.id
       WHERE m.id = ?
       AND (at.track_id IS NULL OR (a.status = 'approved' AND (a.release_date IS NULL OR a.release_date <= CURDATE())))`,
      [id]
    );
    
    if (tracks.length === 0) {
      return res.status(404).json({ error: 'Track not found or not yet approved' });
    }
    
    res.json(tracks[0]);
  } catch (error) {
    console.error('Error fetching track:', error);
    res.status(500).json({ error: 'Failed to fetch track' });
  }
});

// Create track (authenticated artists only) - avec support fichiers
router.post('/', authenticateToken, upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const userId = req.user.id;
  const { title, is_premium, is_trending, release_date, lyrics_text } = req.body;
    const audioFile = req.files?.['audio']?.[0];
    const imageFile = req.files?.['image']?.[0];

    if (!title || !audioFile || !imageFile) {
      return res.status(400).json({ error: 'Titre, audio WAV et cover 2000×2000 sont requis' });
    }
    try {
      validateAudioFile(audioFile);
      validateCoverDimensions(imageFile);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Récupérer le nom de l'artiste depuis le profil
    let artistName = null;
    
    // Vérifier si l'utilisateur a un artist_id
    const [users] = await pool.execute(
      'SELECT artist_id FROM users WHERE id = ?',
      [userId]
    );

    if (users.length > 0 && users[0].artist_id) {
      const [artists] = await pool.execute(
        'SELECT name FROM artists WHERE id = ?',
        [users[0].artist_id]
      );
      if (artists.length > 0) {
        artistName = artists[0].name;
      }
    }

    // Si pas d'artist_id, vérifier via les demandes approuvées
    if (!artistName) {
      const [applications] = await pool.execute(
        'SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = "approved" ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      if (applications.length > 0) {
        artistName = applications[0].artist_name;
      }
    }

    if (!artistName) {
      return res.status(403).json({ error: 'Vous devez être un artiste vérifié pour uploader des titres' });
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
      return res.status(500).json({ error: 'Erreur lors de l\'upload des fichiers vers S3' });
    }

    const ctx = await resolveArtistContext(userId);
    if (ctx?.useWorkflow) {
      const submission = await createSingleSubmission(ctx, {
        title,
        coverUrl: imageUrl,
        audioUrl,
        releaseDate: release_date && release_date.trim() !== '' ? release_date : null,
        isPremium: is_premium === 'true' || is_premium === true,
        isTrending: is_trending === 'true' || is_trending === true,
        lyricsText: lyrics_text || null,
      });
      const message = ctx.requiresProducer
        ? 'Soumission envoyée à votre producteur pour validation.'
        : submission.distributor_type === 'internal'
          ? 'Soumission envoyée à TshaTsha Stream pour validation.'
          : 'Soumission envoyée à votre distributeur pour validation.';
      return res.status(201).json({ ...submission, workflow: true, message });
    }

    // Si release_date n'est pas fourni ou est vide, utiliser la date actuelle (publication immédiate)
    const releaseDate = release_date && release_date.trim() !== '' ? release_date : new Date().toISOString().slice(0, 19).replace('T', ' ');

    const trackId = uuidv4();
    
    await pool.execute(
      'INSERT INTO music (id, title, artist_name, audio_url, image_url, is_premium, is_trending, release_date, lyrics_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        trackId,
        title,
        artistName,
        audioUrl,
        imageUrl,
        is_premium === 'true' || is_premium === true,
        is_trending === 'true' || is_trending === true,
        releaseDate,
        lyrics_text || null
      ]
    );

    const [tracks] = await pool.execute('SELECT * FROM music WHERE id = ?', [trackId]);
    res.status(201).json(tracks[0]);
  } catch (error) {
    console.error('Error creating track:', error);
    res.status(500).json({ error: 'Failed to create track' });
  }
});

// Update track
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, artist_name, audio_url, image_url, is_premium, is_trending, lyrics_text } = req.body;

    await pool.execute(
      'UPDATE music SET title = ?, artist_name = ?, audio_url = ?, image_url = ?, is_premium = ?, is_trending = ?, lyrics_text = ? WHERE id = ?',
      [title, artist_name, audio_url, image_url, is_premium, is_trending, lyrics_text || null, id]
    );

    const [tracks] = await pool.execute('SELECT * FROM music WHERE id = ?', [id]);
    res.json(tracks[0]);
  } catch (error) {
    console.error('Error updating track:', error);
    res.status(500).json({ error: 'Failed to update track' });
  }
});

// Delete track (only by owner artist or admin)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Vérifier si l'utilisateur est admin
    const [users] = await pool.execute(
      'SELECT is_admin FROM users WHERE id = ?',
      [userId]
    );
    
    const isAdmin = users.length > 0 && users[0].is_admin === 1;
    
    if (!isAdmin) {
      // Vérifier si l'utilisateur est le propriétaire du track
      const [tracks] = await pool.execute(
        'SELECT artist_name FROM music WHERE id = ?',
        [id]
      );
      
      if (tracks.length === 0) {
        return res.status(404).json({ error: 'Track not found' });
      }
      
      // Récupérer le nom de l'artiste de l'utilisateur
      const [userArtists] = await pool.execute(
        `SELECT a.name FROM artists a 
         JOIN users u ON u.artist_id = a.id 
         WHERE u.id = ?`,
        [userId]
      );
      
      let artistName = null;
      if (userArtists.length > 0) {
        artistName = userArtists[0].name;
      } else {
        // Vérifier si l'utilisateur a une demande approuvée
        const [applications] = await pool.execute(
          'SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = "approved" ORDER BY created_at DESC LIMIT 1',
          [userId]
        );
        if (applications.length > 0) {
          artistName = applications[0].artist_name;
        }
      }
      
      if (!artistName || tracks[0].artist_name.toLowerCase() !== artistName.toLowerCase()) {
        return res.status(403).json({ error: 'You do not have permission to delete this track' });
      }
    }
    
    // Récupérer l'URL du fichier audio avant suppression
    const [trackData] = await pool.execute('SELECT audio_url, image_url FROM music WHERE id = ?', [id]);
    if (trackData.length > 0) {
      const track = trackData[0];
      // Supprimer les fichiers de S3 si nécessaire
      if (track.audio_url && track.audio_url.includes('s3')) {
        await deleteFromS3(track.audio_url);
      }
      if (track.image_url && track.image_url.includes('s3')) {
        await deleteFromS3(track.image_url);
      }
    }
    
    await pool.execute('DELETE FROM music WHERE id = ?', [id]);
    res.json({ message: 'Track deleted successfully' });
  } catch (error) {
    console.error('Error deleting track:', error);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

export default router;

