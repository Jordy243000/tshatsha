import express from 'express';
import pool from '../database/connection.js';
import { optionalAuth, authenticateToken } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

function computeAlbumMonetization(album) {
  const paidWindowDays = Number(album.paid_window_days || 14);
  if (!album.is_paid_release || !album.release_date) {
    return { isCurrentlyPaid: false, paidWindowDays };
  }
  const now = new Date();
  const releaseAt = new Date(`${album.release_date}T00:00:00`);
  const paidUntil = new Date(releaseAt);
  paidUntil.setDate(paidUntil.getDate() + paidWindowDays);
  const isCurrentlyPaid = now >= releaseAt && now < paidUntil;
  const canPreorder = Boolean(
    album.is_preorder_enabled &&
    now < releaseAt &&
    ((releaseAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) >= 7
  );
  return { isCurrentlyPaid, paidUntil, paidWindowDays, canPreorder };
}

async function hasAlbumAccess(albumId, userId) {
  if (!userId) return false;
  const [rows] = await pool.execute(
    'SELECT id FROM album_purchases WHERE album_id = ? AND user_id = ? LIMIT 1',
    [albumId, userId]
  );
  return rows.length > 0;
}

// Get all albums (only approved and released)
router.get('/', optionalAuth, async (req, res) => {
  try {
    // Only return approved albums that have been released (or have no release date)
    const [albums] = await pool.execute(
      `SELECT * FROM albums 
       WHERE status = 'approved' 
       AND (release_date IS NULL OR release_date <= CURDATE())
       ORDER BY created_at DESC`
    );
    res.json(albums);
  } catch (error) {
    console.error('Error fetching albums:', error);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

// Get popular albums (only approved and released)
router.get('/popular', optionalAuth, async (req, res) => {
  try {
    // Return only popular albums that are approved and released
    const [albums] = await pool.execute(
      `SELECT * FROM albums 
       WHERE is_popular = true
       AND status = 'approved' 
       AND (release_date IS NULL OR release_date <= CURDATE())
       ORDER BY created_at DESC
       LIMIT 10`
    );
    res.json(albums);
  } catch (error) {
    console.error('Error fetching popular albums:', error);
    res.status(500).json({ error: 'Failed to fetch popular albums' });
  }
});

// Get album by ID (only if approved and released)
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [albums] = await pool.execute(
      `SELECT * FROM albums 
       WHERE id = ? 
       AND status = 'approved' 
       AND (release_date IS NULL OR release_date <= CURDATE())`,
      [id]
    );
    
    if (albums.length === 0) {
      return res.status(404).json({ error: 'Album not found or not yet approved/released' });
    }
    
    const album = albums[0];
    const { isCurrentlyPaid, paidUntil, canPreorder } = computeAlbumMonetization(album);
    const userHasAccess = await hasAlbumAccess(album.id, req.user?.id);
    res.json({
      ...album,
      is_currently_paid: isCurrentlyPaid,
      paid_until: paidUntil ? paidUntil.toISOString() : null,
      user_has_access: userHasAccess,
      can_preorder: canPreorder
    });
  } catch (error) {
    console.error('Error fetching album:', error);
    res.status(500).json({ error: 'Failed to fetch album' });
  }
});

// Get album tracks
// For regular users: only if album is approved and released
// For admin: can preview pending albums (handled via admin routes)
router.get('/:id/tracks', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [albums] = await pool.execute(
      `SELECT * FROM albums
       WHERE id = ?
       AND status = 'approved'
       AND (release_date IS NULL OR release_date <= CURDATE())`,
      [id]
    );
    if (albums.length === 0) {
      return res.status(404).json({ error: 'Album not found or not yet approved/released' });
    }
    const album = albums[0];
    const { isCurrentlyPaid } = computeAlbumMonetization(album);

    if (isCurrentlyPaid) {
      const userHasAccess = await hasAlbumAccess(id, req.user?.id);
      if (!userHasAccess) {
        return res.status(402).json({
          error: 'Album payant temporaire. Achat requis.',
          code: 'ALBUM_PURCHASE_REQUIRED',
          price_usd: album.paid_price_usd || 5
        });
      }
    }

    // Use JOIN with album_tracks table since music table doesn't have album_id column
    // Only return tracks if album is approved and released
    const [tracks] = await pool.execute(
      `SELECT m.* FROM music m 
       INNER JOIN album_tracks at ON m.id = at.track_id 
       INNER JOIN albums a ON at.album_id = a.id
       WHERE at.album_id = ?
       AND a.status = 'approved'
       AND (a.release_date IS NULL OR a.release_date <= CURDATE())
       ORDER BY at.position ASC, m.created_at ASC`,
      [id]
    );
    
    res.json(tracks);
  } catch (error) {
    console.error('Error fetching album tracks:', error);
    res.status(500).json({ error: 'Failed to fetch album tracks' });
  }
});

// Buy album (paid mode for first 2 weeks)
router.post('/:id/purchase', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const [albums] = await pool.execute('SELECT * FROM albums WHERE id = ? AND status = "approved"', [id]);
    if (albums.length === 0) {
      return res.status(404).json({ error: 'Album introuvable' });
    }
    const album = albums[0];
    const { isCurrentlyPaid } = computeAlbumMonetization(album);
    if (!album.is_paid_release || !isCurrentlyPaid) {
      return res.status(400).json({ error: 'Cet album n’est pas en vente payante actuellement' });
    }
    const price = Number(album.paid_price_usd || 5);
    if (![5, 9.99].includes(price)) {
      return res.status(400).json({ error: 'Prix album invalide' });
    }

    const purchaseId = uuidv4();
    await pool.execute(
      `INSERT INTO album_purchases (id, user_id, album_id, price_usd, purchase_type)
       VALUES (?, ?, ?, ?, 'purchase')
       ON DUPLICATE KEY UPDATE price_usd = VALUES(price_usd), purchased_at = CURRENT_TIMESTAMP`,
      [purchaseId, userId, id, price]
    );
    res.status(201).json({ success: true, album_id: id, price_usd: price });
  } catch (error) {
    console.error('Error purchasing album:', error);
    res.status(500).json({ error: 'Failed to purchase album' });
  }
});

// Preorder album (only if release is at least 7 days away and album has preorder enabled)
router.post('/:id/preorder', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const [albums] = await pool.execute('SELECT * FROM albums WHERE id = ? AND status = "approved"', [id]);
    if (albums.length === 0) {
      return res.status(404).json({ error: 'Album introuvable' });
    }
    const album = albums[0];
    const { canPreorder } = computeAlbumMonetization(album);
    if (!album.is_paid_release || !album.is_preorder_enabled || !canPreorder) {
      return res.status(400).json({ error: 'Précommande indisponible pour cet album' });
    }
    const price = Number(album.paid_price_usd || 5);
    if (![5, 9.99].includes(price)) {
      return res.status(400).json({ error: 'Prix album invalide' });
    }

    const preorderId = uuidv4();
    await pool.execute(
      `INSERT INTO album_preorders (id, user_id, album_id, price_usd, status)
       VALUES (?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE price_usd = VALUES(price_usd), status = 'active'`,
      [preorderId, userId, id, price]
    );
    res.status(201).json({ success: true, album_id: id, price_usd: price, status: 'active' });
  } catch (error) {
    console.error('Error preordering album:', error);
    res.status(500).json({ error: 'Failed to preorder album' });
  }
});

export default router;

