import { ensureStreamRoyaltyTables } from '../services/streamRoyaltyService.js';
import pool from './connection.js';

async function migrate() {
  try {
    await ensureStreamRoyaltyTables();
    console.log('✅ Tables royalties streams prêtes (counted_stream_events, royalty_balances, royalty_payouts)');
    process.exit(0);
  } catch (e) {
    console.error('❌ Migration royalties échouée:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
