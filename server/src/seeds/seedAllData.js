/**
 * Seeds VPS-imported data into production on first startup.
 * Uses a count guard (no ON CONFLICT needed — production tables lack PK/UNIQUE constraints).
 */
import { query } from '../db.js';
import { PROFILES_SEED } from './profilesSeed.js';
import { WALLETS_SEED } from './walletsSeed.js';
import { BUNDLES_SEED } from './bundlesSeed.js';
import { BUNDLE_ITEMS_SEED, BUNDLE_ITEM_CONFIG_SEED } from './bundleItemsSeed.js';
import { BUNDLE_SERVICES_SEED } from './bundleServicesSeed.js';
import { seedProviderConfiguration } from './providerSetupSeed.js';

const CHUNK = 50; // smaller batches = safer on prod
const FUNDS_ADDED_BASELINE_INR = 95234;
const FUNDS_ADDED_BASELINE_COUNT = 800;

async function seedTable(name, seedData, countQuery, insertFn, countParams = []) {
  try {
    const { rows } = await query(countQuery, countParams);
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

  // One-time historical reporting baseline. This changes only the admin
  // aggregate; wallet balances and transaction history remain untouched.
  try {
    const baseline = await query(
      `UPDATE platform_settings
          SET funds_added_baseline_inr = $1,
              funds_added_baseline_count = $2,
              funds_added_baseline_at = now(),
              updated_at = now()
        WHERE id = 'global'
          AND funds_added_baseline_at IS NULL`,
      [FUNDS_ADDED_BASELINE_INR, FUNDS_ADDED_BASELINE_COUNT]
    );
    if (baseline.rowCount > 0) {
      console.log(
        `[seed] funds-added reporting baseline set to ₹${FUNDS_ADDED_BASELINE_INR} ` +
        `(${FUNDS_ADDED_BASELINE_COUNT} historical deposits)`
      );
    }
  } catch (e) {
    console.error('[seed] funds-added reporting baseline failed:', e.message);
  }

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

  // ── Services referenced by engagement bundles ─────────────────────────────
  await seedTable(
    'bundle services', BUNDLE_SERVICES_SEED,
    `SELECT COUNT(*)::int AS cnt
       FROM public.services
      WHERE id = ANY($1::uuid[])`,
    async (batch) => {
      const res = await query(
        `INSERT INTO public.services
          (id, provider_id, provider_service_id, name, category, price,
           min_quantity, max_quantity, speed, quality, drip_feed_enabled,
           is_active, refill, cancel_allowed)
         VALUES ${buildValues(batch, 14)}`,
        batch.flatMap(r => [
          r.id, r.provider_id, r.provider_service_id, r.name, r.category, r.price,
          r.min_quantity, r.max_quantity, r.speed, r.quality, r.drip_feed_enabled,
          r.is_active, r.refill, r.cancel_allowed,
        ])
      );
      return res.rowCount || 0;
    },
    [BUNDLE_SERVICES_SEED.map(service => service.id)]
  );

  try {
    await seedProviderConfiguration();
  } catch (e) {
    console.error('[seed] provider setup failed:', e.message);
  }

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

  // Restore pricing/ratio fields omitted by the original production import.
  // Only null-priced rows are repaired, so later admin edits remain untouched.
  try {
    const values = BUNDLE_ITEM_CONFIG_SEED
      .map((_, i) => {
        const p = i * 4;
        return `($${p + 1}::uuid, $${p + 2}::numeric, $${p + 3}::boolean, $${p + 4}::numeric)`;
      })
      .join(',');
    const params = BUNDLE_ITEM_CONFIG_SEED.flatMap(item => [
      item.id, item.ratio_percent, item.is_base, item.price_per_k,
    ]);
    const restored = await query(
      `UPDATE bundle_items bi
          SET ratio_percent = cfg.ratio_percent,
              is_base = cfg.is_base,
              price_per_k = cfg.price_per_k
         FROM (VALUES ${values}) AS cfg(id, ratio_percent, is_base, price_per_k)
        WHERE bi.id = cfg.id
          AND bi.price_per_k IS NULL`,
      params
    );
    if (restored.rowCount > 0) {
      console.log(`[seed] restored pricing for ${restored.rowCount} bundle items`);
    }
  } catch (e) {
    console.error('[seed] bundle item pricing repair failed:', e.message);
  }

  // ── Engagement Orders ─────────────────────────────────────────────────────
  // NOTE: VPS order history intentionally NOT re-seeded (user requested clean slate).
  // Production was initially published with 2,695 legacy order headers, while
  // development had already been cleaned. Remove only that imported range.
  // This is idempotent and can never touch new orders, which start at 3800.
  try {
    await query(
      `DELETE FROM organic_run_schedule
        WHERE engagement_order_item_id IN (
          SELECT eoi.id
            FROM engagement_order_items eoi
            JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
           WHERE eo.order_number < 3800
        )`
    );
    await query(
      `DELETE FROM engagement_order_items
        WHERE engagement_order_id IN (
          SELECT id FROM engagement_orders WHERE order_number < 3800
        )`
    );
    const removed = await query(
      `DELETE FROM engagement_orders WHERE order_number < 3800`
    );
    if (removed.rowCount > 0) {
      console.log(`[seed] removed ${removed.rowCount} legacy engagement orders (< 3800)`);
    }
  } catch (e) {
    console.error('[seed] legacy engagement order cleanup failed:', e.message);
  }

  // Sequence starts at 3800 so new orders don't collide with VPS order numbers.
  try {
    const { rows } = await query(`SELECT last_value FROM engagement_orders_order_number_seq`);
    const cur = Number(rows[0]?.last_value ?? 1);
    if (cur < 3800) {
      await query(`SELECT setval('engagement_orders_order_number_seq', 3800, false)`);
      console.log(`[seed] sequence: ensured >= 3800 (was ${cur})`);
    }
  } catch (e) {
    console.error('[seed] sequence check failed:', e.message);
  }

  console.log('[seed] VPS data seed complete.');
}
