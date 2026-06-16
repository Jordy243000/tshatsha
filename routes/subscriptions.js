import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get user subscription
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [subscriptions] = await pool.execute(
      'SELECT * FROM subscriptions WHERE user_id = ?',
      [userId]
    );

    if (subscriptions.length === 0) {
      return res.json(null);
    }

    res.json(subscriptions[0]);
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// Create or update subscription
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      status,
      price_id,
      quantity,
      cancel_at_period_end,
      current_period_start,
      current_period_end,
      ended_at,
      cancel_at,
      canceled_at,
      trial_start,
      trial_end
    } = req.body;

    // Check if subscription exists
    const [existing] = await pool.execute(
      'SELECT id FROM subscriptions WHERE user_id = ?',
      [userId]
    );

    if (existing.length > 0) {
      // Update existing subscription
      await pool.execute(
        `UPDATE subscriptions SET 
         status = ?, price_id = ?, quantity = ?, cancel_at_period_end = ?,
         current_period_start = ?, current_period_end = ?, ended_at = ?,
         cancel_at = ?, canceled_at = ?, trial_start = ?, trial_end = ?
         WHERE user_id = ?`,
        [
          status, price_id, quantity, cancel_at_period_end,
          current_period_start, current_period_end, ended_at,
          cancel_at, canceled_at, trial_start, trial_end,
          userId
        ]
      );

      const [updated] = await pool.execute(
        'SELECT * FROM subscriptions WHERE user_id = ?',
        [userId]
      );
      return res.json(updated[0]);
    } else {
      // Create new subscription
      const subscriptionId = uuidv4();
      await pool.execute(
        `INSERT INTO subscriptions 
         (id, user_id, status, price_id, quantity, cancel_at_period_end,
          current_period_start, current_period_end, ended_at,
          cancel_at, canceled_at, trial_start, trial_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          subscriptionId, userId, status || 'incomplete', price_id, quantity || 1,
          cancel_at_period_end || false, current_period_start, current_period_end,
          ended_at, cancel_at, canceled_at, trial_start, trial_end
        ]
      );

      const [created] = await pool.execute(
        'SELECT * FROM subscriptions WHERE id = ?',
        [subscriptionId]
      );
      return res.status(201).json(created[0]);
    }
  } catch (error) {
    console.error('Error creating/updating subscription:', error);
    res.status(500).json({ error: 'Failed to create/update subscription' });
  }
});

// Cancel subscription
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await pool.execute(
      'UPDATE subscriptions SET status = ?, canceled_at = NOW() WHERE user_id = ?',
      ['canceled', userId]
    );

    res.json({ message: 'Subscription canceled successfully' });
  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;

