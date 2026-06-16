import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';

const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const RELEASE_STATUSES = {
  PRODUCER_REVIEW: 'producer_review',
  DISTRIBUTOR_REVIEW: 'distributor_review',
  ADMIN_REVIEW: 'admin_review',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
};

export async function ensureReleaseWorkflowTables() {
  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN distributor_type ENUM('internal','external') NULL DEFAULT NULL`);
  } catch (_) { /* exists */ }

  try {
    await pool.execute(`ALTER TABLE distributor_partnerships ADD COLUMN initiated_by ENUM('distributor','artist','producer') DEFAULT 'distributor'`);
  } catch (_) { /* exists */ }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS artist_distributor_links (
      id VARCHAR(36) PRIMARY KEY,
      artist_id VARCHAR(36) NOT NULL,
      distributor_user_id VARCHAR(36) NOT NULL,
      message TEXT,
      status ENUM('pending','distributor_accepted','active','rejected','suspended') DEFAULT 'pending',
      distributor_response_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_artist_distributor (artist_id, distributor_user_id),
      INDEX idx_status (status),
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS producer_distributor_links (
      id VARCHAR(36) PRIMARY KEY,
      producer_user_id VARCHAR(36) NOT NULL,
      distributor_user_id VARCHAR(36) NOT NULL,
      message TEXT,
      status ENUM('pending','distributor_accepted','active','rejected','suspended') DEFAULT 'pending',
      distributor_response_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_producer_distributor (producer_user_id, distributor_user_id),
      INDEX idx_status (status),
      FOREIGN KEY (producer_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (distributor_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS release_submissions (
      id VARCHAR(36) PRIMARY KEY,
      release_type ENUM('single','album') NOT NULL,
      artist_id VARCHAR(36) NOT NULL,
      artist_user_id VARCHAR(36) NOT NULL,
      artist_name VARCHAR(255) NOT NULL,
      producer_user_id VARCHAR(36) NULL,
      distributor_user_id VARCHAR(36) NOT NULL,
      distributor_type ENUM('internal','external') NOT NULL DEFAULT 'internal',
      title VARCHAR(255) NOT NULL,
      cover_url TEXT,
      release_date DATE NULL,
      is_premium BOOLEAN DEFAULT FALSE,
      is_trending BOOLEAN DEFAULT FALSE,
      is_paid_release BOOLEAN DEFAULT FALSE,
      paid_price_usd DECIMAL(10,2) NULL,
      is_preorder_enabled BOOLEAN DEFAULT FALSE,
      status ENUM('producer_review','distributor_review','admin_review','published','rejected') NOT NULL DEFAULT 'distributor_review',
      producer_comment TEXT,
      distributor_comment TEXT,
      admin_comment TEXT,
      music_id VARCHAR(36) NULL,
      album_id VARCHAR(36) NULL,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      published_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_artist (artist_id),
      INDEX idx_producer (producer_user_id),
      INDEX idx_distributor (distributor_user_id),
      INDEX idx_status (status),
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS release_submission_tracks (
      id VARCHAR(36) PRIMARY KEY,
      submission_id VARCHAR(36) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      title VARCHAR(255) NOT NULL,
      audio_url TEXT NOT NULL,
      image_url TEXT,
      lyrics_text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_submission (submission_id),
      FOREIGN KEY (submission_id) REFERENCES release_submissions(id) ON DELETE CASCADE
    ) ${suffix}
  `);
}

/** Marque le distributeur interne TshaTsha (admin plateforme) */
export async function bootstrapInternalDistributor() {
  const [admins] = await pool.execute(
    `SELECT id FROM users WHERE is_admin = TRUE ORDER BY created_at ASC LIMIT 1`
  );
  if (!admins[0]?.id) return null;
  await pool.execute(
    `UPDATE users SET is_distributor = TRUE, distributor_type = 'internal' WHERE id = ?`,
    [admins[0].id]
  );
  return admins[0].id;
}

export async function getInternalDistributorUserId() {
  const [rows] = await pool.execute(
    `SELECT id FROM users WHERE is_distributor = TRUE AND distributor_type = 'internal' LIMIT 1`
  );
  return rows[0]?.id || null;
}

export async function resolveArtistContext(userId) {
  const [users] = await pool.execute(
    'SELECT id, artist_id, is_admin FROM users WHERE id = ?',
    [userId]
  );
  const user = users[0];
  if (!user?.artist_id) return null;

  const artistId = user.artist_id;
  const [artists] = await pool.execute('SELECT id, name FROM artists WHERE id = ?', [artistId]);
  if (!artists[0]) return null;

  const [producerRows] = await pool.execute(
    `SELECT producer_user_id FROM producer_artist_associations
     WHERE artist_id = ? AND status = 'admin_approved' ORDER BY updated_at DESC LIMIT 1`,
    [artistId]
  );

  const [distributorRows] = await pool.execute(
    `SELECT adl.distributor_user_id, u.distributor_type
     FROM artist_distributor_links adl
     JOIN users u ON u.id = adl.distributor_user_id
     WHERE adl.artist_id = ? AND adl.status = 'active'
     ORDER BY adl.updated_at DESC LIMIT 1`,
    [artistId]
  );

  let distributorUserId = distributorRows[0]?.distributor_user_id || null;
  let distributorType = distributorRows[0]?.distributor_type || 'internal';

  if (!distributorUserId) {
    distributorUserId = await getInternalDistributorUserId();
    distributorType = 'internal';
  }

  return {
    artistId,
    artistName: artists[0].name,
    artistUserId: userId,
    producerUserId: producerRows[0]?.producer_user_id || null,
    distributorUserId,
    distributorType,
    /** Upload passe par le pipeline si un distributeur est défini */
    useWorkflow: !!distributorUserId,
    /** Validation producteur requise si association active */
    requiresProducer: !!producerRows[0]?.producer_user_id,
  };
}

export async function listApprovedDistributors() {
  const internalId = await getInternalDistributorUserId();
  const [external] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, da.company_name, u.distributor_type
     FROM users u
     LEFT JOIN distributor_applications da ON da.user_id = u.id AND da.status = 'approved'
     WHERE u.is_distributor = TRUE AND u.distributor_type = 'external'
     ORDER BY da.company_name, u.full_name`
  );

  const list = [];
  if (internalId) {
    list.push({
      id: internalId,
      company_name: 'TshaTsha Stream',
      display_name: 'TshaTsha Stream (officiel)',
      distributor_type: 'internal',
      is_default: true,
    });
  }
  for (const row of external) {
    list.push({
      id: row.id,
      company_name: row.company_name || row.full_name || row.email,
      display_name: row.company_name || row.full_name || row.email,
      distributor_type: 'external',
      is_default: false,
    });
  }
  return list;
}

function initialStatus(ctx) {
  if (ctx.requiresProducer) return RELEASE_STATUSES.PRODUCER_REVIEW;
  if (ctx.distributorType === 'internal') return RELEASE_STATUSES.ADMIN_REVIEW;
  return RELEASE_STATUSES.DISTRIBUTOR_REVIEW;
}

export async function createSingleSubmission(ctx, payload) {
  const id = uuidv4();
  const status = initialStatus(ctx);
  await pool.execute(
    `INSERT INTO release_submissions (
      id, release_type, artist_id, artist_user_id, artist_name,
      producer_user_id, distributor_user_id, distributor_type,
      title, cover_url, release_date, is_premium, is_trending, status
    ) VALUES (?, 'single', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ctx.artistId, ctx.artistUserId, ctx.artistName,
      ctx.producerUserId, ctx.distributorUserId, ctx.distributorType,
      payload.title, payload.coverUrl, payload.releaseDate || null,
      !!payload.isPremium, !!payload.isTrending, status,
    ]
  );
  await pool.execute(
    `INSERT INTO release_submission_tracks (id, submission_id, position, title, audio_url, image_url, lyrics_text)
     VALUES (?, ?, 0, ?, ?, ?, ?)`,
    [uuidv4(), id, payload.title, payload.audioUrl, payload.coverUrl, payload.lyricsText || null]
  );
  return getSubmissionById(id);
}

export async function createAlbumSubmission(ctx, payload) {
  const id = uuidv4();
  const status = initialStatus(ctx);
  await pool.execute(
    `INSERT INTO release_submissions (
      id, release_type, artist_id, artist_user_id, artist_name,
      producer_user_id, distributor_user_id, distributor_type,
      title, cover_url, release_date, is_premium, is_trending,
      is_paid_release, paid_price_usd, is_preorder_enabled, status
    ) VALUES (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, FALSE, ?, ?, ?, ?)`,
    [
      id, ctx.artistId, ctx.artistUserId, ctx.artistName,
      ctx.producerUserId, ctx.distributorUserId, ctx.distributorType,
      payload.title, payload.coverUrl, payload.releaseDate || null,
      !!payload.isPaidRelease, payload.paidPrice || null, !!payload.isPreorderEnabled, status,
    ]
  );
  for (let i = 0; i < payload.tracks.length; i++) {
    const t = payload.tracks[i];
    await pool.execute(
      `INSERT INTO release_submission_tracks (id, submission_id, position, title, audio_url, image_url, lyrics_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), id, i, t.title, t.audioUrl, payload.coverUrl, t.lyricsText || null]
    );
  }
  return getSubmissionById(id);
}

export async function getSubmissionById(id) {
  const [rows] = await pool.execute('SELECT * FROM release_submissions WHERE id = ?', [id]);
  if (!rows[0]) return null;
  const [tracks] = await pool.execute(
    'SELECT * FROM release_submission_tracks WHERE submission_id = ? ORDER BY position ASC',
    [id]
  );
  return { ...rows[0], tracks };
}

export async function publishSubmission(submissionId, comment = null) {
  const submission = await getSubmissionById(submissionId);
  if (!submission) throw new Error('Soumission introuvable');

  if (submission.release_type === 'single') {
    const track = submission.tracks[0];
    if (!track) throw new Error('Piste manquante');
    const musicId = uuidv4();
    const releaseDate = submission.release_date || new Date().toISOString().slice(0, 10);
    await pool.execute(
      `INSERT INTO music (id, title, artist_name, audio_url, image_url, is_premium, is_trending, release_date, lyrics_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        musicId, track.title, submission.artist_name, track.audio_url, track.image_url || submission.cover_url,
        submission.is_premium, submission.is_trending, releaseDate, track.lyrics_text,
      ]
    );
    await pool.execute(
      `UPDATE release_submissions SET status = 'published', music_id = ?, published_at = NOW(), distributor_comment = COALESCE(?, distributor_comment) WHERE id = ?`,
      [musicId, comment, submissionId]
    );
    return { ...submission, music_id: musicId, status: 'published' };
  }

  const albumId = uuidv4();
  const releaseDate = submission.release_date || new Date().toISOString().slice(0, 10);
  await pool.execute(
    `INSERT INTO albums (id, title, artist_name, cover_image_url, release_date, status, submitted_by, is_paid_release, paid_price_usd, is_preorder_enabled)
     VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
    [
      albumId, submission.title, submission.artist_name, submission.cover_url, releaseDate,
      submission.artist_user_id, submission.is_paid_release, submission.paid_price_usd, submission.is_preorder_enabled,
    ]
  );

  for (const t of submission.tracks) {
    const trackId = uuidv4();
    await pool.execute(
      `INSERT INTO music (id, title, artist_name, audio_url, image_url, release_date, lyrics_text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [trackId, t.title, submission.artist_name, t.audio_url, submission.cover_url, releaseDate, t.lyrics_text]
    );
    await pool.execute(
      'INSERT INTO album_tracks (album_id, track_id, position) VALUES (?, ?, ?)',
      [albumId, trackId, t.position]
    );
  }

  await pool.execute(
    `UPDATE release_submissions SET status = 'published', album_id = ?, published_at = NOW(), distributor_comment = COALESCE(?, distributor_comment) WHERE id = ?`,
    [albumId, comment, submissionId]
  );
  return { ...submission, album_id: albumId, status: 'published' };
}
