import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';

export const STREAM_RATE_USD = 0.001;
export const PAYOUT_THRESHOLD_USD = 20;
export const FORFEIT_MONTHS = 9;
export const QUARTER_MONTHS = 3;

function safeLimit(value, max = 500, fallback = 50) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function safeOffset(value) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export async function ensureStreamRoyaltyTables() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS counted_stream_events (
      id VARCHAR(36) PRIMARY KEY,
      listener_user_id VARCHAR(36) NOT NULL,
      track_id VARCHAR(36) NOT NULL,
      track_title VARCHAR(255),
      artist_name VARCHAR(255),
      artist_user_id VARCHAR(36) NULL,
      producer_user_id VARCHAR(36) NULL,
      is_premium BOOLEAN NOT NULL DEFAULT FALSE,
      is_counted BOOLEAN NOT NULL DEFAULT FALSE,
      skip_reason VARCHAR(50) NULL,
      rate_usd DECIMAL(10,6) NOT NULL DEFAULT 0.001000,
      artist_amount DECIMAL(12,6) NOT NULL DEFAULT 0,
      producer_amount DECIMAL(12,6) NOT NULL DEFAULT 0,
      source VARCHAR(50) DEFAULT 'direct',
      device VARCHAR(50) NULL,
      country VARCHAR(100) NULL,
      listened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_listener (listener_user_id),
      INDEX idx_track (track_id),
      INDEX idx_artist_user (artist_user_id),
      INDEX idx_producer_user (producer_user_id),
      INDEX idx_counted (is_counted),
      INDEX idx_listened_at (listened_at),
      FOREIGN KEY (listener_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES music(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS royalty_balances (
      id VARCHAR(36) PRIMARY KEY,
      account_type ENUM('artist','producer') NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      pending_balance DECIMAL(12,4) NOT NULL DEFAULT 0,
      total_earned DECIMAL(12,4) NOT NULL DEFAULT 0,
      total_paid DECIMAL(12,4) NOT NULL DEFAULT 0,
      accumulation_started_at DATE NOT NULL,
      last_quarterly_review_at DATE NULL,
      quarters_below_threshold INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_account (account_type, user_id),
      INDEX idx_pending (pending_balance),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS royalty_payouts (
      id VARCHAR(36) PRIMARY KEY,
      account_type ENUM('artist','producer') NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      amount DECIMAL(12,4) NOT NULL,
      status ENUM('completed','forfeited','pending') NOT NULL DEFAULT 'pending',
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      streams_count INT DEFAULT 0,
      note TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (account_type, user_id),
      INDEX idx_status (status),
      INDEX idx_period (period_end),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${suffix}
  `);

  try {
    await pool.execute('ALTER TABLE producer_catalog_tracks ADD COLUMN music_id VARCHAR(36) NULL');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS royalty_quarterly_runs (
      id VARCHAR(36) PRIMARY KEY,
      quarter_key VARCHAR(10) NOT NULL UNIQUE,
      ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ${suffix}
  `);

  try {
    await pool.execute('ALTER TABLE royalty_quarterly_runs MODIFY COLUMN quarter_key VARCHAR(10) NOT NULL');
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
}

export async function isUserPremium(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT status FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

function quarterBounds(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const q = Math.floor(m / 3);
  const start = new Date(y, q * 3, 1);
  const end = new Date(y, q * 3 + 3, 0);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    nextReview: new Date(y, q * 3 + 3, 1).toISOString().slice(0, 10),
  };
}

async function resolveArtistUserId(connection, artistName) {
  const [byLink] = await connection.execute(
    `SELECT u.id FROM users u JOIN artists a ON u.artist_id = a.id WHERE LOWER(a.name) = LOWER(?) LIMIT 1`,
    [artistName]
  );
  if (byLink[0]?.id) return byLink[0].id;

  const [byApp] = await connection.execute(
    `SELECT user_id as id FROM artist_applications WHERE LOWER(artist_name) = LOWER(?) AND status = 'approved' ORDER BY created_at DESC LIMIT 1`,
    [artistName]
  );
  return byApp[0]?.id || null;
}

async function resolveProducerRights(connection, trackId, trackTitle, artistName) {
  const [byMusicId] = await connection.execute(
    `SELECT pct.id, pct.producer_user_id, COALESCE(ptr.artist_pct, 100) as artist_pct, COALESCE(ptr.producer_pct, 0) as producer_pct
     FROM producer_catalog_tracks pct
     LEFT JOIN producer_track_rights ptr ON ptr.track_id = pct.id
     WHERE pct.music_id = ? AND pct.status = 'published' LIMIT 1`,
    [trackId]
  );
  if (byMusicId[0]) return byMusicId[0];

  const [byTitle] = await connection.execute(
    `SELECT pct.id, pct.producer_user_id, COALESCE(ptr.artist_pct, 100) as artist_pct, COALESCE(ptr.producer_pct, 0) as producer_pct
     FROM producer_catalog_tracks pct
     JOIN artists a ON a.id = pct.artist_id
     LEFT JOIN producer_track_rights ptr ON ptr.track_id = pct.id
     WHERE LOWER(pct.title) = LOWER(?) AND LOWER(a.name) = LOWER(?) AND pct.status = 'published' LIMIT 1`,
    [trackTitle, artistName]
  );
  return byTitle[0] || null;
}

async function upsertRoyaltyBalance(connection, accountType, userId, amount) {
  const today = new Date().toISOString().slice(0, 10);
  const [existing] = await connection.execute(
    'SELECT id, pending_balance FROM royalty_balances WHERE account_type = ? AND user_id = ? LIMIT 1',
    [accountType, userId]
  );

  if (existing.length === 0) {
    await connection.execute(
      `INSERT INTO royalty_balances (id, account_type, user_id, pending_balance, total_earned, accumulation_started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), accountType, userId, amount, amount, today]
    );
    return;
  }

  await connection.execute(
    `UPDATE royalty_balances SET pending_balance = pending_balance + ?, total_earned = total_earned + ? WHERE id = ?`,
    [amount, amount, existing[0].id]
  );
}

async function creditRevenue(connection, {
  artistUserId, producerUserId, producerCatalogTrackId,
  trackId, artistId, artistAmount, producerAmount, periodDate,
}) {
  const period = periodDate || new Date().toISOString().slice(0, 10);

  if (artistUserId && artistAmount > 0) {
    await connection.execute(
      `INSERT INTO artist_revenue (id, artist_user_id, track_id, amount, currency, period_date, source)
       VALUES (?, ?, ?, ?, 'USD', ?, 'streaming')`,
      [uuidv4(), artistUserId, trackId, artistAmount, period]
    );
    await upsertRoyaltyBalance(connection, 'artist', artistUserId, artistAmount);
    await connection.execute(
      `INSERT INTO artist_activity (id, artist_user_id, type, title, detail) VALUES (?, ?, 'stream', ?, ?)`,
      [uuidv4(), artistUserId, 'Stream premium compté', `+$${artistAmount.toFixed(4)} — 1 écoute premium`]
    ).catch(() => {});
  }

  if (producerUserId && producerAmount > 0) {
    await connection.execute(
      `INSERT INTO producer_revenue (id, producer_user_id, artist_id, track_id, amount, currency, period_date, source)
       VALUES (?, ?, ?, ?, ?, 'USD', ?, 'streaming')`,
      [uuidv4(), producerUserId, artistId || null, producerCatalogTrackId || null, producerAmount, period]
    );
    await upsertRoyaltyBalance(connection, 'producer', producerUserId, producerAmount);
    await connection.execute(
      `INSERT INTO producer_activity (id, producer_user_id, type, title, detail) VALUES (?, ?, 'stream', ?, ?)`,
      [uuidv4(), producerUserId, 'Stream premium compté', `+$${producerAmount.toFixed(4)} — 1 écoute premium`]
    ).catch(() => {});
  }

  if (producerCatalogTrackId) {
    await connection.execute(
      `UPDATE producer_catalog_tracks SET play_count = play_count + 1, revenue = revenue + ? WHERE id = ?`,
      [artistAmount + producerAmount, producerCatalogTrackId]
    );
  }
}

/**
 * Vérifie la règle 24h pour les streams premium et crédite les royalties si applicable.
 * Doit être appelé dans une transaction existante.
 */
export async function processPremiumStream(connection, {
  userId, trackId, trackTitle, artistName, source, device, country,
}) {
  const eventId = uuidv4();
  const isPremium = await isUserPremium(connection, userId);

  const artistUserId = await resolveArtistUserId(connection, artistName);
  const producerRights = await resolveProducerRights(connection, trackId, trackTitle, artistName);
  const producerUserIdEarly = producerRights?.producer_user_id || null;

  if (!isPremium) {
    await connection.execute(
      `INSERT INTO counted_stream_events
       (id, listener_user_id, track_id, track_title, artist_name, artist_user_id, producer_user_id,
        is_premium, is_counted, skip_reason, source, device, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, FALSE, 'not_premium', ?, ?, ?)`,
      [eventId, userId, trackId, trackTitle, artistName, artistUserId, producerUserIdEarly, source || 'direct', device || null, country || null]
    );
    return { stream_counted: false, is_premium: false, reason: 'not_premium', event_id: eventId };
  }

  const [streamRows] = await connection.execute(
    'SELECT last_counted_at FROM user_track_streams WHERE user_id = ? AND track_id = ? LIMIT 1',
    [userId, trackId]
  );

  let countedAsStream = false;
  if (streamRows.length === 0) {
    await connection.execute(
      'INSERT INTO user_track_streams (user_id, track_id, last_counted_at, total_counted) VALUES (?, ?, NOW(), 1)',
      [userId, trackId]
    );
    countedAsStream = true;
  } else {
    const lastCountedAt = new Date(streamRows[0].last_counted_at);
    const diffMs = Date.now() - lastCountedAt.getTime();
    if (diffMs >= 24 * 60 * 60 * 1000) {
      await connection.execute(
        'UPDATE user_track_streams SET last_counted_at = NOW(), total_counted = total_counted + 1 WHERE user_id = ? AND track_id = ?',
        [userId, trackId]
      );
      countedAsStream = true;
    }
  }

  if (!countedAsStream) {
    await connection.execute(
      `INSERT INTO counted_stream_events
       (id, listener_user_id, track_id, track_title, artist_name, artist_user_id, producer_user_id,
        is_premium, is_counted, skip_reason, source, device, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, FALSE, 'within_24h', ?, ?, ?)`,
      [eventId, userId, trackId, trackTitle, artistName, artistUserId, producerUserIdEarly, source || 'direct', device || null, country || null]
    );
    return { stream_counted: false, is_premium: true, reason: 'within_24h', event_id: eventId };
  }

  let artistPct = 100;
  let producerPct = 0;
  let producerUserId = null;
  let producerCatalogTrackId = null;
  let artistId = null;

  if (producerRights) {
    artistPct = Number(producerRights.artist_pct) || 0;
    producerPct = Number(producerRights.producer_pct) || 0;
    producerUserId = producerRights.producer_user_id;
    producerCatalogTrackId = producerRights.id;

    const [aRows] = await connection.execute(
      'SELECT artist_id FROM producer_catalog_tracks WHERE id = ? LIMIT 1',
      [producerCatalogTrackId]
    );
    artistId = aRows[0]?.artist_id || null;
  }

  const totalPct = artistPct + producerPct;
  if (totalPct <= 0) {
    artistPct = 100;
    producerPct = 0;
  }

  const artistAmount = STREAM_RATE_USD * (artistPct / (totalPct || 100));
  const producerAmount = STREAM_RATE_USD * (producerPct / (totalPct || 100));

  await connection.execute(
    `INSERT INTO counted_stream_events
     (id, listener_user_id, track_id, track_title, artist_name, artist_user_id, producer_user_id,
      is_premium, is_counted, rate_usd, artist_amount, producer_amount, source, device, country)
     VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, TRUE, ?, ?, ?, ?, ?, ?)`,
    [
      eventId, userId, trackId, trackTitle, artistName, artistUserId, producerUserId,
      STREAM_RATE_USD, artistAmount, producerAmount, source || 'direct', device || null, country || null,
    ]
  );

  await connection.execute(
    'UPDATE artists SET total_plays = total_plays + 1 WHERE LOWER(name) = LOWER(?)',
    [artistName]
  );

  await creditRevenue(connection, {
    artistUserId, producerUserId, producerCatalogTrackId,
    trackId, artistId, artistAmount, producerAmount,
  });

  return {
    stream_counted: true,
    is_premium: true,
    amount_usd: STREAM_RATE_USD,
    artist_amount: artistAmount,
    producer_amount: producerAmount,
    event_id: eventId,
  };
}

export async function getRoyaltyBalance(accountType, userId) {
  const bounds = quarterBounds();
  const today = new Date();

  try {
    const [[balance]] = await pool.execute(
      'SELECT * FROM royalty_balances WHERE account_type = ? AND user_id = ? LIMIT 1',
      [accountType, userId]
    );

    if (!balance) {
      return emptyRoyaltyBalance(bounds);
    }

    const accumStart = new Date(balance.accumulation_started_at);
    const monthsElapsed = (today.getFullYear() - accumStart.getFullYear()) * 12 + (today.getMonth() - accumStart.getMonth());
    const monthsUntilForfeit = Math.max(0, FORFEIT_MONTHS - monthsElapsed);
    const pending = Number(balance.pending_balance);

    return {
      pending_balance: pending,
      total_earned: Number(balance.total_earned),
      total_paid: Number(balance.total_paid),
      payout_threshold: PAYOUT_THRESHOLD_USD,
      stream_rate: STREAM_RATE_USD,
      next_payout_date: bounds.nextReview,
      accumulation_started_at: balance.accumulation_started_at,
      months_until_forfeit: monthsUntilForfeit,
      quarters_below_threshold: balance.quarters_below_threshold,
      can_be_paid: pending >= PAYOUT_THRESHOLD_USD,
      streams_needed_for_payout: Math.max(0, Math.ceil((PAYOUT_THRESHOLD_USD - pending) / STREAM_RATE_USD)),
    };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return emptyRoyaltyBalance(bounds);
    throw e;
  }
}

function emptyRoyaltyBalance(bounds) {
  return {
    pending_balance: 0,
    total_earned: 0,
    total_paid: 0,
    payout_threshold: PAYOUT_THRESHOLD_USD,
    stream_rate: STREAM_RATE_USD,
    next_payout_date: bounds.nextReview,
    accumulation_started_at: null,
    months_until_forfeit: FORFEIT_MONTHS,
    quarters_below_threshold: 0,
    can_be_paid: false,
    streams_needed_for_payout: Math.ceil(PAYOUT_THRESHOLD_USD / STREAM_RATE_USD),
  };
}

export async function getPayoutHistory(accountType, userId, limit = 50) {
  const lim = safeLimit(limit, 200, 50);
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM royalty_payouts WHERE account_type = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ${lim}`,
      [accountType, userId]
    );
    return rows;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

export async function getStreamHistory({ accountType, userId, limit = 100, offset = 0 }) {
  const field = accountType === 'artist' ? 'artist_user_id' : 'producer_user_id';
  const amountField = accountType === 'artist' ? 'artist_amount' : 'producer_amount';
  const lim = safeLimit(limit, 500, 100);
  const off = safeOffset(offset);

  const [rows] = await pool.execute(
    `SELECT id, track_title, artist_name, is_premium, is_counted, skip_reason,
            rate_usd, ${amountField} as amount, source, device, country, listened_at
     FROM counted_stream_events
     WHERE ${field} = ? AND is_counted = TRUE
     ORDER BY listened_at DESC LIMIT ${lim} OFFSET ${off}`,
    [userId]
  );

  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) as c FROM counted_stream_events WHERE ${field} = ? AND is_counted = TRUE`,
    [userId]
  );

  const [allEvents] = await pool.execute(
    `SELECT id, track_title, artist_name, is_premium, is_counted, skip_reason,
            rate_usd, ${amountField} as amount, source, device, country, listened_at
     FROM counted_stream_events
     WHERE ${field} = ?
     ORDER BY listened_at DESC LIMIT ${lim} OFFSET ${off}`,
    [userId]
  );

  return { counted: rows, all: allEvents, total_counted: countRow.c };
}

export async function processQuarterlyPayouts(force = false) {
  const now = new Date();
  const bounds = quarterBounds(now);
  const quarterKey = bounds.start;

  if (!force) {
    const [already] = await pool.execute(
      'SELECT id FROM royalty_quarterly_runs WHERE quarter_key = ? LIMIT 1',
      [quarterKey]
    );
    if (already.length > 0) {
      return { skipped: true, quarter: quarterKey, paid: 0, forfeited: 0, reviewed: 0 };
    }
  }

  const connection = await pool.getConnection();
  const today = now.toISOString().slice(0, 10);
  const prevBounds = quarterBounds(new Date(now.getFullYear(), now.getMonth() - 1, 15));
  let paid = 0;
  let forfeited = 0;

  try {
    await connection.beginTransaction();

    const [balances] = await connection.execute('SELECT * FROM royalty_balances WHERE pending_balance > 0');

    for (const bal of balances) {
      const pending = Number(bal.pending_balance);
      const accumStart = new Date(bal.accumulation_started_at);
      const monthsElapsed =
        (now.getFullYear() - accumStart.getFullYear()) * 12 +
        (now.getMonth() - accumStart.getMonth());

      if (pending >= PAYOUT_THRESHOLD_USD) {
        await connection.execute(
          `INSERT INTO royalty_payouts (id, account_type, user_id, amount, status, period_start, period_end, note)
           VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
          [
            uuidv4(), bal.account_type, bal.user_id, pending,
            prevBounds.start, prevBounds.end,
            `Paiement trimestriel — seuil de $${PAYOUT_THRESHOLD_USD} atteint`,
          ]
        );
        await connection.execute(
          `UPDATE royalty_balances SET pending_balance = 0, total_paid = total_paid + ?,
           accumulation_started_at = ?, quarters_below_threshold = 0, last_quarterly_review_at = ?
           WHERE id = ?`,
          [pending, today, today, bal.id]
        );
        paid++;
      } else if (monthsElapsed >= FORFEIT_MONTHS) {
        await connection.execute(
          `INSERT INTO royalty_payouts (id, account_type, user_id, amount, status, period_start, period_end, note)
           VALUES (?, ?, ?, ?, 'forfeited', ?, ?, ?)`,
          [
            uuidv4(), bal.account_type, bal.user_id, pending,
            prevBounds.start, prevBounds.end,
            `Solde annulé après ${FORFEIT_MONTHS} mois sans atteindre le seuil de $${PAYOUT_THRESHOLD_USD}`,
          ]
        );
        await connection.execute(
          `UPDATE royalty_balances SET pending_balance = 0, quarters_below_threshold = 0,
           accumulation_started_at = ?, last_quarterly_review_at = ? WHERE id = ?`,
          [today, today, bal.id]
        );
        forfeited++;
      } else {
        await connection.execute(
          `UPDATE royalty_balances SET quarters_below_threshold = quarters_below_threshold + 1,
           last_quarterly_review_at = ? WHERE id = ?`,
          [today, bal.id]
        );
      }
    }

    await connection.execute(
      'INSERT INTO royalty_quarterly_runs (id, quarter_key) VALUES (?, ?)',
      [uuidv4(), quarterKey]
    );

    await connection.commit();
    return { skipped: false, quarter: quarterKey, paid, forfeited, reviewed: balances.length };
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

/** Streams premium comptés pour un artiste (par nom) */
export const SQL_PREMIUM_STREAMS_BY_ARTIST = `
  SELECT COALESCE(SUM(uts.total_counted), 0) as t
  FROM music m
  JOIN user_track_streams uts ON uts.track_id = m.id
  JOIN subscriptions s ON s.user_id = uts.user_id AND s.status IN ('active', 'trialing')
  WHERE LOWER(m.artist_name) = LOWER(?)
`;

export const SQL_TOP_PREMIUM_TRACKS = `
  SELECT m.id, m.title, COALESCE(SUM(uts.total_counted), 0) as play_count
  FROM music m
  JOIN user_track_streams uts ON uts.track_id = m.id
  JOIN subscriptions s ON s.user_id = uts.user_id AND s.status IN ('active', 'trialing')
  WHERE LOWER(m.artist_name) = LOWER(?)
  GROUP BY m.id, m.title
  ORDER BY play_count DESC
`;

export const SQL_PREMIUM_STREAMS_BY_MONTH = `
  SELECT DATE_FORMAT(cse.listened_at, '%Y-%m') as month, COUNT(*) as total
  FROM counted_stream_events cse
  WHERE cse.artist_user_id = ? AND cse.is_counted = TRUE
  GROUP BY DATE_FORMAT(cse.listened_at, '%Y-%m')
  ORDER BY month ASC
  LIMIT 12
`;
