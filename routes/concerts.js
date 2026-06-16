import express from 'express';
import pool from '../database/connection.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

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

// Get all concerts
router.get('/', optionalAuth, async (req, res) => {
  try {
    await ensureConcertArtistLinkColumns();
    const [concerts] = await pool.execute(
      `SELECT c.*, a.id AS linked_artist_id, a.name AS linked_artist_name, a.image_url AS linked_artist_image_url
       FROM concerts c
       LEFT JOIN artists a ON a.id = c.artist_id
       WHERE c.is_active = true
       ORDER BY c.date ASC, c.time ASC`
    );
    res.json(concerts);
  } catch (error) {
    console.error('Error fetching concerts:', error);
    res.status(500).json({ error: 'Failed to fetch concerts' });
  }
});

// Get popular concerts
router.get('/popular', optionalAuth, async (req, res) => {
  try {
    await ensureConcertArtistLinkColumns();
    const [concerts] = await pool.execute(
      `SELECT c.*, a.id AS linked_artist_id, a.name AS linked_artist_name, a.image_url AS linked_artist_image_url
       FROM concerts c
       LEFT JOIN artists a ON a.id = c.artist_id
       WHERE c.is_active = true AND c.is_popular = true
       ORDER BY c.date ASC
       LIMIT 6`
    );
    res.json(concerts);
  } catch (error) {
    console.error('Error fetching popular concerts:', error);
    res.status(500).json({ error: 'Failed to fetch popular concerts' });
  }
});

// Get concert by ID
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    await ensureConcertArtistLinkColumns();
    const { id } = req.params;
    const [concerts] = await pool.execute(
      `SELECT c.*, a.id AS linked_artist_id, a.name AS linked_artist_name, a.image_url AS linked_artist_image_url
       FROM concerts c
       LEFT JOIN artists a ON a.id = c.artist_id
       WHERE c.id = ?`,
      [id]
    );

    if (concerts.length === 0) {
      return res.status(404).json({ error: 'Concert not found' });
    }

    res.json(concerts[0]);
  } catch (error) {
    console.error('Error fetching concert:', error);
    res.status(500).json({ error: 'Failed to fetch concert' });
  }
});

// Get concerts linked to an artist (for artist profile)
router.get('/by-artist/:artistId', optionalAuth, async (req, res) => {
  try {
    await ensureConcertArtistLinkColumns();
    const { artistId } = req.params;
    const [concerts] = await pool.execute(
      `SELECT c.*, a.id AS linked_artist_id, a.name AS linked_artist_name, a.image_url AS linked_artist_image_url
       FROM concerts c
       LEFT JOIN artists a ON a.id = c.artist_id
       WHERE c.is_active = true AND c.artist_id = ?
       ORDER BY c.date ASC, c.time ASC`,
      [artistId]
    );
    res.json(concerts);
  } catch (error) {
    console.error('Error fetching artist concerts:', error);
    res.status(500).json({ error: 'Failed to fetch artist concerts' });
  }
});

export default router;

