import express from 'express';
import multer from 'multer';
import { imageSize } from 'image-size';
import pool from '../database/connection.js';
import { optionalAuth, authenticateToken } from '../middleware/auth.js';
import { uploadToS3, deleteFromS3 } from '../services/s3Service.js';
import { resolveArtistContext, createAlbumSubmission } from '../services/releaseWorkflowService.js';
import {
  multerAudioLimit,
  isJpgOrPngImage,
  validateAudioFile,
  validateCoverDimensions,
  COVER_SIZE_PX,
} from '../utils/uploadRequirements.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: multerAudioLimit,
});
const REQUIRED_ALBUM_COVER_SIZE = COVER_SIZE_PX;
const ARTIST_PROFILE_MAX = 2000;
const ARTIST_BANNER_MAX_W = 2000;
const ARTIST_BANNER_MAX_H = 1000;

const validateAlbumCoverDimensions = (file) => validateCoverDimensions(file, REQUIRED_ALBUM_COVER_SIZE);

const validateArtistProfileImage = (file) => {
  if (!file) return;
  if (!isJpgOrPngImage(file)) {
    throw new Error('Photo profil : JPG ou PNG uniquement');
  }
  const { width, height } = imageSize(file.buffer);
  if (width > ARTIST_PROFILE_MAX || height > ARTIST_PROFILE_MAX) {
    throw new Error(`Photo profil : maximum ${ARTIST_PROFILE_MAX}×${ARTIST_PROFILE_MAX} px (actuel : ${width}×${height})`);
  }
  const ratio = width / height;
  if (Math.abs(ratio - 1) > 0.05) {
    throw new Error(`Photo profil : format carré requis (actuel : ${width}×${height} px)`);
  }
};

const validateArtistBannerCover = (file) => {
  if (!file) return;
  if (!isJpgOrPngImage(file)) {
    throw new Error('Couverture : JPG ou PNG uniquement');
  }
  const { width, height } = imageSize(file.buffer);
  if (width > ARTIST_BANNER_MAX_W || height > ARTIST_BANNER_MAX_H) {
    throw new Error(`Couverture : maximum ${ARTIST_BANNER_MAX_W}×${ARTIST_BANNER_MAX_H} px (actuel : ${width}×${height})`);
  }
  const ratio = width / height;
  if (Math.abs(ratio - 2) > 0.08) {
    throw new Error(`Couverture : format 2:1 requis, ex. 2000×1000 px (actuel : ${width}×${height})`);
  }
};

// Get all artists
router.get('/', optionalAuth, async (req, res) => {
  try {
    const [artists] = await pool.execute(
      'SELECT * FROM artists ORDER BY monthly_listeners DESC, name ASC'
    );
    res.json(artists);
  } catch (error) {
    console.error('Error fetching artists:', error);
    res.status(500).json({ error: 'Failed to fetch artists' });
  }
});

// Get popular artists
router.get('/popular', optionalAuth, async (req, res) => {
  try {
    const [artists] = await pool.execute(
      'SELECT * FROM artists WHERE is_popular = true ORDER BY monthly_listeners DESC LIMIT 10'
    );
    res.json(artists);
  } catch (error) {
    console.error('Error fetching popular artists:', error);
    res.status(500).json({ error: 'Failed to fetch popular artists' });
  }
});

// Search artists by name (for autocomplete) - DOIT être AVANT /:id
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length === 0) {
      return res.json([]);
    }

    const searchTerm = `%${q.trim()}%`;
    const [artists] = await pool.execute(
      'SELECT id, name, image_url FROM artists WHERE name LIKE ? ORDER BY monthly_listeners DESC, name ASC LIMIT 10',
      [searchTerm]
    );

    res.json(artists);
  } catch (error) {
    console.error('Error searching artists:', error);
    res.status(500).json({ error: 'Failed to search artists' });
  }
});

// ===== ROUTES /me/* - DOIVENT être AVANT /:id =====

// Get current artist profile (for the artist themselves)
router.get('/me/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Récupérer l'artiste associé à l'utilisateur
    const [users] = await pool.execute(
      'SELECT artist_id FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0 || !users[0].artist_id) {
      // Vérifier si l'utilisateur a une demande approuvée
      const [applications] = await pool.execute(
        'SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = "approved" ORDER BY created_at DESC LIMIT 1',
        [userId]
      );

      if (applications.length > 0) {
        // Récupérer l'artiste par nom
        const [artists] = await pool.execute(
          'SELECT * FROM artists WHERE name = ?',
          [applications[0].artist_name]
        );

        if (artists.length > 0) {
          return res.json(artists[0]);
        }
      }

      return res.status(404).json({ error: 'Aucun profil artiste trouvé' });
    }

    const artistId = users[0].artist_id;

    // Récupérer le profil de l'artiste
    const [artists] = await pool.execute(
      'SELECT * FROM artists WHERE id = ?',
      [artistId]
    );

    if (artists.length === 0) {
      return res.status(404).json({ error: 'Artiste non trouvé' });
    }

    res.json(artists[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération du profil artiste:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du profil' });
  }
});

// Get artist statistics (tracks, plays, likes, followers, monthly listeners)
router.get('/me/statistics', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Récupérer l'artiste associé à l'utilisateur
    const [users] = await pool.execute(
      'SELECT artist_id FROM users WHERE id = ?',
      [userId]
    );

    let artistId = null;
    let artistName = null;

    if (users.length > 0 && users[0].artist_id) {
      artistId = users[0].artist_id;
      const [artists] = await pool.execute(
        'SELECT name FROM artists WHERE id = ?',
        [artistId]
      );
      if (artists.length > 0) {
        artistName = artists[0].name;
      }
    } else {
      // Vérifier si l'utilisateur a une demande approuvée
      const [applications] = await pool.execute(
        'SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = "approved" ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      if (applications.length > 0) {
        artistName = applications[0].artist_name;
        const [artists] = await pool.execute(
          'SELECT id FROM artists WHERE name = ?',
          [artistName]
        );
        if (artists.length > 0) {
          artistId = artists[0].id;
        }
      }
    }

    if (!artistName) {
      return res.status(404).json({ error: 'Aucun profil artiste trouvé' });
    }

    // Compter les titres
    const [tracksCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM music WHERE LOWER(artist_name) = LOWER(?)',
      [artistName]
    );
    const totalTracks = tracksCount[0]?.count || 0;

    // Récupérer les lectures totales depuis l'artiste
    const [artistData] = await pool.execute(
      'SELECT total_plays, monthly_listeners FROM artists WHERE id = ? OR name = ?',
      [artistId || '', artistName]
    );
    const totalPlays = artistData[0]?.total_plays || 0;
    const monthlyListeners = artistData[0]?.monthly_listeners || 0;

    // Compter les j'aime (likes) sur les titres de l'artiste
    const [likesCount] = await pool.execute(
      `SELECT COUNT(*) as count 
       FROM liked_song ls 
       JOIN music m ON ls.song_id = m.id 
       WHERE LOWER(m.artist_name) = LOWER(?)`,
      [artistName]
    );
    const totalLikes = likesCount[0]?.count || 0;

    // Compter les abonnés (followers)
    let totalFollowers = 0;
    if (artistId) {
      const [followersCount] = await pool.execute(
        'SELECT COUNT(*) as count FROM artist_follows WHERE artist_id = ?',
        [artistId]
      );
      totalFollowers = followersCount[0]?.count || 0;
    }

    res.json({
      totalTracks,
      totalPlays,
      totalLikes,
      totalFollowers,
      monthlyListeners
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
  }
});

// Get current artist tracks
router.get('/me/tracks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Récupérer l'artiste associé à l'utilisateur
    const [users] = await pool.execute(
      'SELECT artist_id FROM users WHERE id = ?',
      [userId]
    );

    let artistName = null;

    if (users.length > 0 && users[0].artist_id) {
      const [artists] = await pool.execute(
        'SELECT name FROM artists WHERE id = ?',
        [users[0].artist_id]
      );
      if (artists.length > 0) {
        artistName = artists[0].name;
      }
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

    if (!artistName) {
      return res.json([]);
    }

    // Récupérer les titres de l'artiste
    const [tracks] = await pool.execute(
      'SELECT * FROM music WHERE LOWER(artist_name) = LOWER(?) ORDER BY created_at DESC',
      [artistName]
    );

    res.json(tracks);
  } catch (error) {
    console.error('Erreur lors de la récupération des titres:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des titres' });
  }
});

// Create album (for artists)
router.post('/me/albums', authenticateToken, upload.fields([
  { name: 'cover_image', maxCount: 1 },
  { name: 'audio_files', maxCount: 50 } // Up to 50 tracks per album
]), async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, release_date } = req.body;
    const isPaidRelease = String(req.body.is_paid_release || 'false') === 'true';
    const rawPrice = req.body.paid_price_usd != null ? Number(req.body.paid_price_usd) : null;
    const isPreorderEnabled = String(req.body.is_preorder_enabled || 'false') === 'true';
    const coverFile = req.files?.['cover_image']?.[0];
    
    // Multer retourne les fichiers sous req.files['audio_files'] qui devrait être un tableau
    let audioFiles = req.files?.['audio_files'] || [];
    
    // Vérifier et convertir en tableau si nécessaire
    if (!Array.isArray(audioFiles)) {
      // Si ce n'est pas un tableau mais un objet, essayer de convertir
      if (audioFiles && typeof audioFiles === 'object') {
        audioFiles = Object.values(audioFiles).filter(f => f && f.buffer);
      } else if (audioFiles) {
        // Si c'est un seul fichier, le mettre dans un tableau
        audioFiles = [audioFiles].filter(Boolean);
      } else {
        audioFiles = [];
      }
    }
    
    const trackTitles = JSON.parse(req.body.track_titles || '[]'); // Array of track titles
    const rawTrackLyrics = req.body.track_lyrics_texts || '[]';
    let trackLyricsTexts = [];
    try {
      const parsed = JSON.parse(rawTrackLyrics);
      if (Array.isArray(parsed) && parsed.length === trackTitles.length) {
        trackLyricsTexts = parsed.map((v) => (typeof v === 'string' ? v : null));
      } else {
        trackLyricsTexts = trackTitles.map(() => null);
      }
    } catch {
      trackLyricsTexts = trackTitles.map(() => null);
    }
    
    console.log('Album creation request:', {
      title,
      release_date,
      hasCover: !!coverFile,
      audioFilesCount: audioFiles.length,
      trackTitlesCount: trackTitles.length,
      audioFiles: audioFiles.map(f => ({ name: f.originalname, size: f.size }))
    });

    // Get artist name
    let artistName = null;
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
    } else {
      // Check if user has approved application
      const [applications] = await pool.execute(
        'SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = "approved" ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      if (applications.length > 0) {
        artistName = applications[0].artist_name;
      }
    }

    if (!artistName) {
      return res.status(403).json({ error: 'Vous devez être un artiste vérifié pour créer un album' });
    }

    if (!title || !coverFile || audioFiles.length === 0 || trackTitles.length === 0) {
      return res.status(400).json({ error: 'Title, cover image, audio files, and track titles are required' });
    }
    try {
      validateAlbumCoverDimensions(coverFile);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    for (let i = 0; i < audioFiles.length; i++) {
      try {
        validateAudioFile(audioFiles[i]);
      } catch (e) {
        return res.status(400).json({ error: `Piste ${i + 1} : ${e.message}` });
      }
    }

    if (audioFiles.length !== trackTitles.length) {
      return res.status(400).json({ error: 'Le nombre de fichiers audio doit correspondre au nombre de titres' });
    }

    let paidPrice = null;
    if (isPaidRelease) {
      if (![5, 9.99].includes(rawPrice)) {
        return res.status(400).json({ error: 'Le prix d’un album payant doit être 5$ ou 9,99$' });
      }
      paidPrice = rawPrice;
    }

    if (isPreorderEnabled) {
      if (!isPaidRelease) {
        return res.status(400).json({ error: 'La précommande est disponible uniquement pour un album payant' });
      }
      if (!release_date) {
        return res.status(400).json({ error: 'La précommande nécessite une date de sortie' });
      }
      const now = new Date();
      const releaseAt = new Date(`${release_date}T00:00:00`);
      const diffMs = releaseAt.getTime() - now.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays < 7) {
        return res.status(400).json({
          error: 'La précommande est autorisée uniquement si la sortie est prévue dans au moins 7 jours'
        });
      }
    }

    // Upload cover image to S3
    let coverImageUrl = null;
    try {
      coverImageUrl = await uploadToS3(coverFile.buffer, coverFile.originalname, 'covers');
    } catch (s3Error) {
      console.error('Erreur S3 cover:', s3Error);
      return res.status(500).json({ error: 'Erreur lors de l\'upload de la pochette' });
    }

    // Upload all audio files to S3
    const uploadedTracks = [];
    console.log(`Processing ${audioFiles.length} audio files for album "${title}"`);

    for (let i = 0; i < audioFiles.length; i++) {
      const audioFile = audioFiles[i];
      const trackTitle = trackTitles[i];

      if (!audioFile || !audioFile.buffer) {
        console.error(`Audio file ${i} is missing or has no buffer:`, audioFile);
        if (coverImageUrl) await deleteFromS3(coverImageUrl).catch(console.error);
        return res.status(400).json({ error: `Le fichier audio ${i + 1} est manquant ou invalide` });
      }

      try {
        console.log(`Uploading audio file ${i + 1}/${audioFiles.length}: ${audioFile.originalname}`);
        const audioUrl = await uploadToS3(audioFile.buffer, audioFile.originalname, 'songs');
        uploadedTracks.push({
          title: trackTitle,
          audioUrl,
          lyricsText: trackLyricsTexts[i] || null,
        });
      } catch (s3Error) {
        console.error(`Erreur S3 audio ${i + 1}:`, s3Error);
        if (coverImageUrl) await deleteFromS3(coverImageUrl).catch(console.error);
        return res.status(500).json({
          error: `Erreur lors de l'upload du fichier audio ${i + 1}: ${s3Error.message || 'Erreur inconnue'}`,
        });
      }
    }

    const ctx = await resolveArtistContext(userId);
    if (ctx?.useWorkflow) {
      const submission = await createAlbumSubmission(ctx, {
        title,
        coverUrl: coverImageUrl,
        releaseDate: release_date || null,
        isPaidRelease,
        paidPrice,
        isPreorderEnabled,
        tracks: uploadedTracks,
      });
      const message = ctx.requiresProducer
        ? 'Album soumis à votre producteur pour validation.'
        : submission.distributor_type === 'internal'
          ? 'Album soumis à TshaTsha Stream pour validation.'
          : 'Album soumis à votre distributeur pour validation.';
      return res.status(201).json({ ...submission, workflow: true, message });
    }

    // Legacy: création directe album + pistes
    const trackIds = [];
    const albumId = uuidv4();

    for (let i = 0; i < uploadedTracks.length; i++) {
      const t = uploadedTracks[i];
      const trackId = uuidv4();
      await pool.execute(
        'INSERT INTO music (id, title, artist_name, audio_url, image_url, is_premium, is_trending, release_date, lyrics_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [trackId, t.title, artistName, t.audioUrl, coverImageUrl, false, false, release_date || null, t.lyricsText]
      );
      trackIds.push(trackId);
    }

    // Create album with status 'pending'
    await pool.execute(
      `INSERT INTO albums (
        id, title, artist_name, cover_image_url, release_date, status, submitted_by,
        is_paid_release, paid_price_usd, paid_window_days, is_preorder_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        albumId,
        title,
        artistName,
        coverImageUrl,
        release_date || null,
        'pending',
        userId,
        isPaidRelease,
        paidPrice,
        14,
        isPreorderEnabled
      ]
    );

    // Create album_tracks relationships
    for (let i = 0; i < trackIds.length; i++) {
      const trackId = trackIds[i];
      const relationId = uuidv4();
      await pool.execute(
        'INSERT INTO album_tracks (id, album_id, track_id, position) VALUES (?, ?, ?, ?)',
        [relationId, albumId, trackId, i + 1]
      );
    }
    console.log(`Created ${trackIds.length} album_tracks relationships for album ${albumId}`);

    const [albums] = await pool.execute('SELECT * FROM albums WHERE id = ?', [albumId]);
    res.status(201).json(albums[0]);
  } catch (error) {
    console.error('Error creating album:', error);
    res.status(500).json({ error: 'Failed to create album' });
  }
});

// Get current artist albums
router.get('/me/albums', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Récupérer l'artiste associé à l'utilisateur
    const [users] = await pool.execute(
      'SELECT artist_id FROM users WHERE id = ?',
      [userId]
    );

    let artistName = null;

    if (users.length > 0 && users[0].artist_id) {
      const [artists] = await pool.execute(
        'SELECT name FROM artists WHERE id = ?',
        [users[0].artist_id]
      );
      if (artists.length > 0) {
        artistName = artists[0].name;
      }
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

    if (!artistName) {
      return res.json([]);
    }

    // Récupérer les albums de l'artiste
    const [albums] = await pool.execute(
      'SELECT * FROM albums WHERE LOWER(artist_name) = LOWER(?) ORDER BY release_date DESC, created_at DESC',
      [artistName]
    );

    res.json(albums);
  } catch (error) {
    console.error('Erreur lors de la récupération des albums:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des albums' });
  }
});

// Get current artist listening history (tracks played by users)
router.get('/me/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Récupérer l'artiste associé à l'utilisateur
    const [users] = await pool.execute(
      'SELECT artist_id FROM users WHERE id = ?',
      [userId]
    );

    let artistName = null;

    if (users.length > 0 && users[0].artist_id) {
      const [artists] = await pool.execute(
        'SELECT name FROM artists WHERE id = ?',
        [users[0].artist_id]
      );
      if (artists.length > 0) {
        artistName = artists[0].name;
      }
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

    if (!artistName) {
      return res.json([]);
    }

    // Récupérer l'historique d'écoute des titres de l'artiste
    const [history] = await pool.execute(
      `SELECT lh.*, m.*, u.email as user_email, u.full_name as user_name
       FROM listening_history lh
       JOIN music m ON lh.track_id = m.id
       JOIN users u ON lh.user_id = u.id
       WHERE LOWER(m.artist_name) = LOWER(?)
       ORDER BY lh.played_at DESC
       LIMIT 50`,
      [artistName]
    );

    res.json(history);
  } catch (error) {
    console.error('Erreur lors de la récupération de l\'historique:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de l\'historique' });
  }
});

// Update current artist profile (with image uploads)
router.put('/me/profile', authenticateToken, upload.fields([
  { name: 'profile_image', maxCount: 1 },
  { name: 'cover_image', maxCount: 1 }
]), async (req, res) => {
  try {
    const userId = req.user.id;
    const { bio, genre, country, social_links } = req.body;
    const profileImageFile = req.files?.['profile_image']?.[0];
    const coverImageFile = req.files?.['cover_image']?.[0];

    // Récupérer l'artiste associé à l'utilisateur
    const [users] = await pool.execute(
      'SELECT artist_id FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0 || !users[0].artist_id) {
      // Vérifier si l'utilisateur a une demande approuvée
      const [applications] = await pool.execute(
        'SELECT artist_name FROM artist_applications WHERE user_id = ? AND status = "approved" ORDER BY created_at DESC LIMIT 1',
        [userId]
      );

      if (applications.length === 0) {
        return res.status(404).json({ error: 'Aucun profil artiste trouvé' });
      }

      // Récupérer l'artiste par nom
      const [artists] = await pool.execute(
        'SELECT id FROM artists WHERE name = ?',
        [applications[0].artist_name]
      );

      if (artists.length === 0) {
        return res.status(404).json({ error: 'Artiste non trouvé' });
      }

      users[0].artist_id = artists[0].id;
    }

    const artistId = users[0].artist_id;

    // Récupérer le profil actuel pour les URLs existantes
    const [currentArtists] = await pool.execute(
      'SELECT image_url, cover_image_url FROM artists WHERE id = ?',
      [artistId]
    );

    let profileImageUrl = currentArtists[0]?.image_url || null;
    let coverImageUrl = currentArtists[0]?.cover_image_url || null;

    if (profileImageFile) {
      validateArtistProfileImage(profileImageFile);
    }
    if (coverImageFile) {
      validateArtistBannerCover(coverImageFile);
    }

    // Upload de la nouvelle image de profil si fournie
    if (profileImageFile) {
      const profileImageKey = `artists/profile/${uuidv4()}-${profileImageFile.originalname}`;
      profileImageUrl = await uploadToS3(profileImageFile.buffer, profileImageKey, profileImageFile.mimetype);
      
      // Supprimer l'ancienne image si elle existe
      if (currentArtists[0]?.image_url && currentArtists[0].image_url.includes('s3')) {
        await deleteFromS3(currentArtists[0].image_url);
      }
    }

    // Upload de la nouvelle image de couverture si fournie
    if (coverImageFile) {
      const coverImageKey = `artists/cover/${uuidv4()}-${coverImageFile.originalname}`;
      coverImageUrl = await uploadToS3(coverImageFile.buffer, coverImageKey, coverImageFile.mimetype);
      
      // Supprimer l'ancienne image si elle existe
      if (currentArtists[0]?.cover_image_url && currentArtists[0].cover_image_url.includes('s3')) {
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

    // Mettre à jour le profil
    await pool.execute(
      `UPDATE artists 
       SET bio = ?, genre = ?, country = ?, social_links = ?, image_url = ?, cover_image_url = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        bio || null,
        genre || null,
        country || null,
        socialLinksJson ? JSON.stringify(socialLinksJson) : null,
        profileImageUrl,
        coverImageUrl,
        artistId
      ]
    );

    // Récupérer le profil mis à jour
    const [updatedArtists] = await pool.execute(
      'SELECT * FROM artists WHERE id = ?',
      [artistId]
    );

    res.json(updatedArtists[0]);
  } catch (error) {
    console.error('Erreur lors de la mise à jour du profil:', error);
    const message = error?.message || 'Erreur lors de la mise à jour du profil';
    const isValidation = /profil|couverture|JPG|PNG|carré|2:1|maximum/i.test(message);
    res.status(isValidation ? 400 : 500).json({ error: message });
  }
});

// Demandes d'association producteur → artiste
router.get('/me/producer-associations', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.execute('SELECT artist_id FROM users WHERE id = ?', [req.user.id]);
    if (!users.length || !users[0].artist_id) {
      return res.json([]);
    }
    const artistId = users[0].artist_id;
    const [rows] = await pool.execute(
      `SELECT paa.*,
              u.full_name AS producer_user_name,
              u.email AS producer_email,
              (SELECT pa.company_name FROM producer_applications pa
               WHERE pa.user_id = paa.producer_user_id AND pa.status = 'approved'
               ORDER BY pa.created_at DESC LIMIT 1) AS producer_company,
              (SELECT pa.studio_address FROM producer_applications pa
               WHERE pa.user_id = paa.producer_user_id AND pa.status = 'approved'
               ORDER BY pa.created_at DESC LIMIT 1) AS producer_studio
       FROM producer_artist_associations paa
       JOIN users u ON u.id = paa.producer_user_id
       WHERE paa.artist_id = ?
       ORDER BY paa.created_at DESC`,
      [artistId]
    );
    const labels = {
      pending: 'En attente',
      artist_accepted: 'Acceptée — validation admin en cours',
      rejected: 'Refusée',
      admin_approved: 'Approuvée',
      suspended: 'Suspendue',
    };
    res.json(rows.map((r) => ({ ...r, status_label: labels[r.status] || r.status })));
  } catch (error) {
    console.error('Erreur associations producteur:', error);
    res.status(500).json({ error: 'Erreur chargement demandes producteur' });
  }
});

router.put('/me/producer-associations/:id/respond', authenticateToken, async (req, res) => {
  try {
    const { accept } = req.body;
    const [users] = await pool.execute('SELECT artist_id FROM users WHERE id = ?', [req.user.id]);
    if (!users.length || !users[0].artist_id) {
      return res.status(403).json({ error: 'Profil artiste requis' });
    }
    const [rows] = await pool.execute(
      'SELECT * FROM producer_artist_associations WHERE id = ? AND artist_id = ?',
      [req.params.id, users[0].artist_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Demande introuvable' });
    }
    if (rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }

    const status = accept ? 'artist_accepted' : 'rejected';
    await pool.execute(
      'UPDATE producer_artist_associations SET status = ?, artist_response_at = NOW() WHERE id = ?',
      [status, req.params.id]
    );

    const notifType = accept ? 'association_accepted' : 'association_rejected';
    const notifTitle = accept
      ? 'Demande acceptée par l\'artiste'
      : 'Demande refusée par l\'artiste';
    const notifMsg = accept
      ? 'En attente de validation par l\'administrateur TshaTsha Stream.'
      : 'L\'artiste a refusé votre demande d\'association.';

    await pool.execute(
      'INSERT INTO producer_notifications (id, producer_user_id, type, title, message) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), rows[0].producer_user_id, notifType, notifTitle, notifMsg]
    );
    await pool.execute(
      'INSERT INTO producer_activity (id, producer_user_id, type, title, detail) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), rows[0].producer_user_id, notifType, notifTitle, notifMsg]
    );
    await pool.execute(
      'INSERT INTO artist_activity (id, artist_user_id, type, title, detail) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, notifType, accept ? 'Association acceptée' : 'Association refusée', notifMsg]
    ).catch(() => {});

    const labels = {
      artist_accepted: 'Acceptée — validation admin en cours',
      rejected: 'Refusée',
    };
    res.json({ success: true, status, status_label: labels[status] });
  } catch (error) {
    console.error('Erreur réponse association:', error);
    res.status(500).json({ error: 'Erreur lors de la réponse' });
  }
});

// ===== FIN DES ROUTES /me/* =====

// Toggle follow/unfollow an artist by name - DOIT être AVANT /:id
router.post('/:name/follow', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const userId = req.user.id;

    // Trouver l'artiste par nom (insensible à la casse)
    const [artists] = await pool.execute(
      'SELECT id FROM artists WHERE LOWER(name) = LOWER(?)',
      [name]
    );

    if (artists.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const artistId = artists[0].id;

    // Vérifier si l'utilisateur suit déjà l'artiste
    const [existingFollows] = await pool.execute(
      'SELECT id FROM artist_follows WHERE user_id = ? AND artist_id = ?',
      [userId, artistId]
    );

    if (existingFollows.length > 0) {
      // Unfollow: supprimer le follow
      await pool.execute(
        'DELETE FROM artist_follows WHERE user_id = ? AND artist_id = ?',
        [userId, artistId]
      );
      res.json({ 
        success: true, 
        following: false,
        message: 'Artist unfollowed successfully' 
      });
    } else {
      // Follow: ajouter le follow
      const followId = uuidv4();
      await pool.execute(
        'INSERT INTO artist_follows (id, user_id, artist_id) VALUES (?, ?, ?)',
        [followId, userId, artistId]
      );
      res.json({ 
        success: true, 
        following: true,
        message: 'Artist followed successfully' 
      });
    }
  } catch (error) {
    console.error('Error toggling artist follow:', error);
    res.status(500).json({ error: 'Failed to toggle artist follow' });
  }
});

// Check if user is following an artist by name - DOIT être AVANT /:id
router.get('/:name/is-following', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const userId = req.user.id;

    // Trouver l'artiste par nom (insensible à la casse)
    const [artists] = await pool.execute(
      'SELECT id FROM artists WHERE LOWER(name) = LOWER(?)',
      [name]
    );

    if (artists.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const artistId = artists[0].id;

    // Vérifier si l'utilisateur suit l'artiste
    const [follows] = await pool.execute(
      'SELECT id FROM artist_follows WHERE user_id = ? AND artist_id = ?',
      [userId, artistId]
    );

    res.json({ isFollowing: follows.length > 0 });
  } catch (error) {
    console.error('Error checking artist follow status:', error);
    res.status(500).json({ error: 'Failed to check artist follow status' });
  }
});

// Get artist by ID - DOIT être APRÈS /search, /me/*, /:name/follow, /:name/is-following
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [artists] = await pool.execute(
      'SELECT * FROM artists WHERE id = ?',
      [id]
    );

    if (artists.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    res.json(artists[0]);
  } catch (error) {
    console.error('Error fetching artist:', error);
    res.status(500).json({ error: 'Failed to fetch artist' });
  }
});

// Get artist by name (with fallback to music table if artist doesn't exist)
router.get('/name/:name', optionalAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const decodedName = decodeURIComponent(name);
    
    // First, try to find in artists table (case-insensitive)
    const [artists] = await pool.execute(
      'SELECT * FROM artists WHERE LOWER(name) = LOWER(?)',
      [decodedName]
    );

    if (artists.length > 0) {
      return res.json(artists[0]);
    }

    // If not found, check if there are tracks with this artist name
    const [tracks] = await pool.execute(
      'SELECT COUNT(*) as track_count, MIN(image_url) as image_url FROM music WHERE LOWER(artist_name) = LOWER(?)',
      [decodedName]
    );

    if (tracks.length > 0 && tracks[0].track_count > 0) {
      // Return a virtual artist object based on music data
      const virtualArtist = {
        id: null, // No ID since it doesn't exist in artists table
        name: decodedName,
        bio: null,
        image_url: tracks[0].image_url,
        cover_image_url: null,
        genre: null,
        country: null,
        verified: false,
        monthly_listeners: 0,
        total_plays: 0,
        followers: 0,
        is_popular: false,
        social_links: null,
        created_at: null,
        updated_at: null
      };
      
      return res.json(virtualArtist);
    }

    // Artist not found in either table
    return res.status(404).json({ error: 'Artist not found' });
  } catch (error) {
    console.error('Error fetching artist:', error);
    res.status(500).json({ error: 'Failed to fetch artist' });
  }
});

// Get artist albums (only approved and released)
router.get('/:id/albums', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get artist name first
    const [artists] = await pool.execute(
      'SELECT name FROM artists WHERE id = ?',
      [id]
    );

    if (artists.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const artistName = artists[0].name;

    // Only return approved albums that have been released
    const [albums] = await pool.execute(
      `SELECT * FROM albums 
       WHERE artist_name = ? 
       AND status = 'approved' 
       AND (release_date IS NULL OR release_date <= CURDATE())
       ORDER BY release_date DESC`,
      [artistName]
    );

    res.json(albums);
  } catch (error) {
    console.error('Error fetching artist albums:', error);
    res.status(500).json({ error: 'Failed to fetch artist albums' });
  }
});

export default router;
