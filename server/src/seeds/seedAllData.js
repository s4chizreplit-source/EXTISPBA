/**
 * Seeds VPS-imported data into production on first startup.
 * Runs on every startup but only inserts missing rows (ON CONFLICT DO NOTHING / count check).
 * Tables: profiles, wallets, engagement_orders
 */
import { query } from '../db.js';
import { PROFILES_SEED } from './profilesSeed.js';
import { WALLETS_SEED } from './walletsSeed.js';
import { ENG_ORDERS_SEED } from './engOrdersSeed.js';

const CHUNK = 100;

async function seedTable({ name, seedData, countQuery, insertFn }) {
  try {
    const { rows: [{ cnt }] } = await query(countQuery);
    if (Number(cnt) >= seedData.length) return; // already seeded

    let inserted = 0;
    for (let i = 0; i < seedData.length; i += CHUNK) {
      const batch = seedData.slice(i, i + CHUNK);
      inserted += await insertFn(batch);
    }
    console.log(`[seed] ${name}: seeded ${inserted} new rows (total in DB: ${seedData.length})`);
  } catch (e) {
    console.error(`[seed] ${name} seed failed (non-fatal):`, e.message);
  }
}

export async function seedAllData() {
  // ── Profiles ──────────────────────────────────────────────────────────────
  await seedTable({
    name: 'profiles',
    seedData: PROFILES_SEED,
    countQuery: `SELECT COUNT(*)::int AS cnt FROM public.profiles`,
    insertFn: async (batch) => {
      const values = batch.map((_, j) => {
        const b = j * 3;
        return `($${b+1},$${b+2},$${b+3})`;
      }).join(',');
      const params = batch.flatMap(r => [r.user_id, r.full_name || null, r.avatar_url || null]);
      const res = await query(
        `INSERT INTO public.profiles (user_id, full_name, avatar_url)
         VALUES ${values}
         ON CONFLICT (user_id) DO NOTHING`,
        params
      );
      return res.rowCount || 0;
    },
  });

  // ── Wallets ───────────────────────────────────────────────────────────────
  await seedTable({
    name: 'wallets',
    seedData: WALLETS_SEED,
    countQuery: `SELECT COUNT(*)::int AS cnt FROM public.wallets`,
    insertFn: async (batch) => {
      const values = batch.map((_, j) => {
        const b = j * 4;
        return `($${b+1},$${b+2},$${b+3},$${b+4})`;
      }).join(',');
      const params = batch.flatMap(r => [r.id, r.user_id, r.balance || 0, r.total_deposited || 0]);
      const res = await query(
        `INSERT INTO public.wallets (id, user_id, balance, total_deposited)
         VALUES ${values}
         ON CONFLICT (id) DO NOTHING`,
        params
      );
      return res.rowCount || 0;
    },
  });

  // ── Engagement Orders ─────────────────────────────────────────────────────
  await seedTable({
    name: 'engagement_orders',
    seedData: ENG_ORDERS_SEED,
    countQuery: `SELECT COUNT(*)::int AS cnt FROM public.engagement_orders`,
    insertFn: async (batch) => {
      const values = batch.map((_, j) => {
        const b = j * 8;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
      }).join(',');
      const params = batch.flatMap(r => [
        r.id, r.user_id, r.link, r.base_quantity,
        r.total_price, r.status || 'completed',
        r.campaign_name || null, r.created_at,
      ]);
      const res = await query(
        `INSERT INTO public.engagement_orders
           (id, user_id, link, base_quantity, total_price, status, campaign_name, created_at)
         VALUES ${values}
         ON CONFLICT (id) DO NOTHING`,
        params
      );
      return res.rowCount || 0;
    },
  });
}
