/**
 * Seeds VPS-imported data into production on first startup.
 * Uses a count guard (no ON CONFLICT needed — production tables lack PK/UNIQUE constraints).
 */
import { query } from '../db.js';
import { PROFILES_SEED } from './profilesSeed.js';
import { WALLETS_SEED } from './walletsSeed.js';
import { ENG_ORDERS_SEED } from './engOrdersSeed.js';
import { BUNDLES_SEED } from './bundlesSeed.js';
import { BUNDLE_ITEMS_SEED } from './bundleItemsSeed.js';

const CHUNK = 50; // smaller batches = safer on prod

async function seedTable(name, seedData, countQuery, insertFn) {
  try {
    const { rows } = await query(countQuery);
    const cnt = Number(rows[0]?.cnt ?? 0);
    if (cnt >= seedData.length) {
      console.log(`[seed] ${name}: already has ${cnt} rows — skipping`);
      return;
    }
    console.log(`[seed] ${name}: starting insert of ${seedData.length} rows…`);
    let inserted = 0;
    for (let i = 0; i < seedData.length; i += CHUNK) {
      const batch = seedData.slice(i, i + CHUNK);
      try {
        const n = await insertFn(batch);
        inserted += n;
      } catch (e) {
        console.error(`[seed] ${name} batch ${i}-${i + CHUNK} failed:`, e.message);
      }
    }
    console.log(`[seed] ${name}: done — ${inserted} rows inserted`);
  } catch (e) {
    console.error(`[seed] ${name} aborted:`, e.message);
  }
}

// Build parameterised VALUES list: batch × colCount params
function buildValues(batch, colCount) {
  return batch
    .map((_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(',')})`)
    .join(',');
}

export async function seedAllData() {
  console.log('[seed] Starting VPS data seed…');

  // ── Profiles ──────────────────────────────────────────────────────────────
  await seedTable(
    'profiles', PROFILES_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.profiles`,
    async (batch) => {
      const res = await query(
        `INSERT INTO public.profiles (user_id, email, full_name, avatar_url)
         VALUES ${buildValues(batch, 4)}`,
        batch.flatMap(r => [
          r.user_id,
          r.email || `user_${r.user_id}@imported.local`,
          r.full_name || null,
          r.avatar_url || null,
        ])
      );
      return res.rowCount || 0;
    }
  );

  // ── Wallets ───────────────────────────────────────────────────────────────
  await seedTable(
    'wallets', WALLETS_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.wallets`,
    async (batch) => {
      const res = await query(
        `INSERT INTO public.wallets (id, user_id, balance, total_deposited)
         VALUES ${buildValues(batch, 4)}`,
        batch.flatMap(r => [r.id, r.user_id, r.balance ?? 0, r.total_deposited ?? 0])
      );
      return res.rowCount || 0;
    }
  );

  // ── Engagement Bundles ────────────────────────────────────────────────────
  await seedTable(
    'engagement_bundles', BUNDLES_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.engagement_bundles`,
    async (batch) => {
      const res = await query(
        `INSERT INTO public.engagement_bundles (id, name, platform, is_active, sort_order)
         VALUES ${buildValues(batch, 5)}`,
        batch.flatMap(r => [r.id, r.name, r.platform, r.is_active ?? true, r.sort_order ?? 0])
      );
      return res.rowCount || 0;
    }
  );

  // ── Bundle Items ──────────────────────────────────────────────────────────
  await seedTable(
    'bundle_items', BUNDLE_ITEMS_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.bundle_items`,
    async (batch) => {
      const res = await query(
        `INSERT INTO public.bundle_items (id, bundle_id, service_id, engagement_type)
         VALUES ${buildValues(batch, 4)}`,
        batch.flatMap(r => [r.id, r.bundle_id, r.service_id, r.engagement_type || null])
      );
      return res.rowCount || 0;
    }
  );

  // ── Engagement Orders ─────────────────────────────────────────────────────
  await seedTable(
    'engagement_orders', ENG_ORDERS_SEED,
    `SELECT COUNT(*)::int AS cnt FROM public.engagement_orders`,
    async (batch) => {
      const res = await query(
        `INSERT INTO public.engagement_orders
           (id, user_id, link, base_quantity, total_price, status, created_at)
         VALUES ${buildValues(batch, 7)}`,
        batch.flatMap(r => [
          r.id, r.user_id, r.link, r.base_quantity,
          r.total_price, r.status || 'completed', r.created_at,
        ])
      );
      return res.rowCount || 0;
    }
  );

  // ── Post-seed cleanup ─────────────────────────────────────────────────────
  // Mark stuck "processing" VPS historical orders as "partial".
  // Only touches orders older than 30 minutes so active new orders are safe.
  try {
    const { rowCount } = await query(`
      UPDATE public.engagement_orders
      SET    status = 'partial'
      WHERE  status = 'processing'
        AND  created_at < NOW() - INTERVAL '30 minutes'
    `);
    if (rowCount > 0) {
      console.log(`[seed] cleanup: marked ${rowCount} stuck VPS orders as partial`);
    }
  } catch (e) {
    console.error('[seed] cleanup failed:', e.message);
  }

  // ── Advance order_number sequence past VPS range ────────────────────────
  // Ensures next real production order gets a number >= 3800 (above VPS #2695)
  try {
    const { rows } = await query(`SELECT MAX(order_number) AS mx FROM public.engagement_orders`);
    const maxOn = Number(rows[0]?.mx ?? 0);
    if (maxOn < 3800) {
      await query(`SELECT setval('engagement_orders_order_number_seq', 3800, false)`);
      console.log(`[seed] sequence: advanced order_number seq to 3800 (was at ${maxOn})`);
    }
  } catch (e) {
    console.error('[seed] sequence advance failed:', e.message);
  }

  console.log('[seed] VPS data seed complete.');
}
