/**
 * One-time startup seed: ensures public.auth_users table exists and is populated.
 * Runs on every startup but only inserts missing rows (ON CONFLICT DO NOTHING).
 * This allows production to get VPS-imported user credentials without manual DB access.
 */
import { query } from '../db.js';
import { AUTH_USERS_SEED } from './authUsersSeed.js';

export async function seedAuthUsers() {
  try {
    // Create table if it doesn't exist (safe DDL — idempotent)
    await query(`
      CREATE TABLE IF NOT EXISTS public.auth_users (
        id                 uuid PRIMARY KEY,
        email              text NOT NULL,
        encrypted_password text,
        raw_user_meta_data jsonb,
        created_at         timestamptz DEFAULT now()
      )
    `);

    // Count how many rows are already there
    const { rows: [{ cnt }] } = await query(
      `SELECT COUNT(*)::int AS cnt FROM public.auth_users`
    );

    if (cnt >= AUTH_USERS_SEED.length) {
      // Already seeded — nothing to do
      return;
    }

    // Batch-insert in chunks of 100 to avoid huge single query
    const CHUNK = 100;
    let inserted = 0;
    for (let i = 0; i < AUTH_USERS_SEED.length; i += CHUNK) {
      const batch = AUTH_USERS_SEED.slice(i, i + CHUNK);
      const values = batch.map((_, j) => {
        const base = j * 3;
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
      }).join(', ');
      const params = batch.flatMap(u => [u.id, u.email, u.encrypted_password]);
      const res = await query(
        `INSERT INTO public.auth_users (id, email, encrypted_password)
         VALUES ${values}
         ON CONFLICT (id) DO NOTHING`,
        params
      );
      inserted += res.rowCount || 0;
    }

    console.log(`[seed] auth_users: seeded ${inserted} new rows (total: ${AUTH_USERS_SEED.length})`);
  } catch (e) {
    // Non-fatal — log and continue
    console.error('[seed] auth_users seed failed (non-fatal):', e.message);
  }
}
