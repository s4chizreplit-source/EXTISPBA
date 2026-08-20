/**
 * Seeds VPS-imported data into production on first startup.
 * Runs on every startup but only inserts missing rows (ON CONFLICT DO NOTHING / count check).
 * Tables: profiles, wallets, engagement_orders, engagement_bundles, bundle_items
 */
import { query } from '../db.js';
import { PROFILES_SEED } from './profilesSeed.js';
import { WALLETS_SEED } from './walletsSeed.js';
import { ENG_ORDERS_SEED } from './engOrdersSeed.js';
import { BUNDLES_SEED } from './bundlesSeed.js';
import { BUNDLE_ITEMS_SEED } from './bundleItemsSeed.js';

const CHUNK = 100;

async function seedTable(name, seedData, countQuery, insertFn) {
  try {
    const { rows } = await query(countQuery);
    const cnt = Number(rows[0]?.cnt ?? 0);
    if (cnt >= seedData.length) {
      console.log(`[seed] ${name}: already has ${cnt} rows — skipping`);
      return;
    }
    let inserted = 0;
    for (let i = 0; i < seedData.length; i += CHUNK) {
      const batch = seedData.slice(i, i + CHUNK);
      try {
        const n = await insertFn(batch);
        inserted += n;
      } catch (e) {
        console.error(`[seed] ${name} batch ${i}-${i+CHUNK} failed:`, e.message);
      }
    }
    console.log(`[seed] ${name}: inserted ${inserted} new rows`);
  } catch (e) {
    console.error(`[seed] ${name} failed:`, e.message);
  }
}

export async function seedAllData() {
  console.log('[seed] Starting data seed…');

  // ── Profiles ──────────────────────────────────────────────────────────────
  await seedTable('profiles', PROFILES_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.profiles`,
    async (batch) => {
      const values = batch.map((_, j) => {
        const b = j * 4;
        return `($${b+1},$${b+2},$${b+3},$${b+4})`;
      }).join(',');
      const params = batch.flatMap(r => [
        r.user_id,
        r.email || `user_${r.user_id}@imported.local`,
        r.full_name || null,
        r.avatar_url || null,
      ]);
      const res = await query(
        `INSERT INTO public.profiles (user_id, email, full_name, avatar_url)
         VALUES ${values}
         ON CONFLICT (user_id) DO NOTHING`,
        params
      );
      return res.rowCount || 0;
    }
  );

  // ── Wallets ───────────────────────────────────────────────────────────────
  await seedTable('wallets', WALLETS_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.wallets`,
    async (batch) => {
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
    }
  );

  // ── Engagement Bundles ────────────────────────────────────────────────────
  await seedTable('engagement_bundles', BUNDLES_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.engagement_bundles`,
    async (batch) => {
      const values = batch.map((_, j) => {
        const b = j * 5;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
      }).join(',');
      const params = batch.flatMap(r => [
        r.id, r.name, r.platform, r.is_active ?? true, r.sort_order ?? 0
      ]);
      const res = await query(
        `INSERT INTO public.engagement_bundles (id, name, platform, is_active, sort_order)
         VALUES ${values}
         ON CONFLICT (id) DO NOTHING`,
        params
      );
      return res.rowCount || 0;
    }
  );

  // ── Bundle Items ──────────────────────────────────────────────────────────
  await seedTable('bundle_items', BUNDLE_ITEMS_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.bundle_items`,
    async (batch) => {
      const values = batch.map((_, j) => {
        const b = j * 4;
        return `($${b+1},$${b+2},$${b+3},$${b+4})`;
      }).join(',');
      const params = batch.flatMap(r => [
        r.id, r.bundle_id, r.service_id, r.engagement_type || null
      ]);
      const res = await query(
        `INSERT INTO public.bundle_items (id, bundle_id, service_id, engagement_type)
         VALUES ${values}
         ON CONFLICT (id) DO NOTHING`,
        params
      );
      return res.rowCount || 0;
    }
  );

  // ── Engagement Orders ─────────────────────────────────────────────────────
  await seedTable('engagement_orders', ENG_ORDERS_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.engagement_orders`,
    async (batch) => {
      const values = batch.map((_, j) => {
        const b = j * 7;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
      }).join(',');
      const params = batch.flatMap(r => [
        r.id, r.user_id, r.link, r.base_quantity,
        r.total_price, r.status || 'completed', r.created_at,
      ]);
      const res = await query(
        `INSERT INTO public.engagement_orders
           (id, user_id, link, base_quantity, total_price, status, created_at)
         VALUES ${values}
         ON CONFLICT (id) DO NOTHING`,
        params
      );
      return res.rowCount || 0;
    }
  );

  console.log('[seed] Data seed complete.');
}
