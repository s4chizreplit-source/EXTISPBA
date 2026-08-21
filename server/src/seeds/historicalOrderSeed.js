import { constants, createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { from as copyFrom } from 'pg-copy-streams';
import { pool, query } from '../db.js';

const ARCHIVES = [
  {
    key: 'orders',
    table: 'engagement_orders',
    file: 'engagement_orders.copy.gz',
    columns: 'id, order_number, user_id, bundle_id, link, base_quantity, total_price, is_organic_mode, variance_percent, peak_hours_enabled, status, error_message, created_at, updated_at, completed_at, current_botting_percent, current_health_score, last_health_check_at, campaign_name',
  },
  {
    key: 'items',
    table: 'engagement_order_items',
    file: 'engagement_order_items.copy.gz',
    columns: 'id, engagement_order_id, engagement_type, service_id, quantity, price, drip_qty_per_run, drip_interval, drip_interval_unit, speed_preset, is_enabled, status, provider_order_id, error_message, created_at, updated_at, auto_refill_enabled, auto_refill_threshold_pct, auto_refill_count, auto_refill_max, last_refill_at',
  },
  {
    key: 'runs',
    table: 'organic_run_schedule',
    file: 'organic_run_schedule.copy.gz',
    columns: 'id, order_id, run_number, scheduled_at, quantity_to_send, base_quantity, variance_applied, peak_multiplier, status, provider_order_id, provider_response, error_message, started_at, completed_at, created_at, engagement_order_item_id, provider_start_count, provider_remains, provider_status, provider_charge, last_status_check, retry_count, provider_account_id, provider_account_name, rotation_lock_key',
  },
  {
    key: 'health',
    table: 'engagement_health_history',
    file: 'engagement_health_history.copy.gz',
    columns: 'id, engagement_order_id, health_score, botting_percent, views_count, likes_count, comments_count, shares_count, saves_count, followers_count, ratios, warnings, recorded_at, created_at',
  },
].map(archive => ({
  ...archive,
  path: fileURLToPath(
    new URL(`../../data/historical-orders/${archive.file}`, import.meta.url)
  ),
}));

const EXPECTED = Object.freeze(
  {
    orders: 2695,
    items: 7558,
    runs: 92533,
    health: 233216,
  }
);

let engagementOrderWritesReady = false;

export function areEngagementOrderWritesReady() {
  return engagementOrderWritesReady;
}

async function historicalCounts(runQuery = query) {
  const { rows } = await runQuery(
    `SELECT
       (SELECT count(*)::int
          FROM engagement_orders
         WHERE order_number < 3800) AS orders,
       (SELECT count(*)::int
          FROM engagement_order_items i
          JOIN engagement_orders o ON o.id = i.engagement_order_id
         WHERE o.order_number < 3800) AS items,
       (SELECT count(*)::int
          FROM organic_run_schedule r
          JOIN engagement_order_items i ON i.id = r.engagement_order_item_id
          JOIN engagement_orders o ON o.id = i.engagement_order_id
         WHERE o.order_number < 3800) AS runs,
       (SELECT count(*)::int
          FROM engagement_health_history h
          JOIN engagement_orders o ON o.id = h.engagement_order_id
         WHERE o.order_number < 3800) AS health`
  );
  return rows[0];
}

function countsMatch(counts, expected) {
  return Object.entries(expected).every(([key, value]) => Number(counts[key]) === value);
}

async function ensureEngagementOrderSequence(runQuery = query) {
  await runQuery(
    `WITH current_sequence AS (
       SELECT last_value, is_called
         FROM engagement_orders_order_number_seq
     ),
     max_order AS (
       SELECT COALESCE(max(order_number), 0)::bigint AS value
         FROM engagement_orders
     )
     SELECT setval(
       'engagement_orders_order_number_seq',
       GREATEST(current_sequence.last_value, max_order.value, 3800),
       CASE
         WHEN max_order.value >= 3800 THEN true
         WHEN current_sequence.last_value >= 3800 THEN current_sequence.is_called
         ELSE false
       END
     )
       FROM current_sequence, max_order`
  );
}

async function copyArchiveIntoTempTable(client, archive) {
  const destination = client.query(
    copyFrom(`COPY pg_temp.seed_${archive.table} (${archive.columns}) FROM STDIN`)
  );
  await pipeline(createReadStream(archive.path), createGunzip(), destination);
}

async function stagedArchiveCounts(client) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM pg_temp.seed_engagement_orders) AS orders,
       (SELECT count(*)::int FROM pg_temp.seed_engagement_order_items) AS items,
       (SELECT count(*)::int FROM pg_temp.seed_organic_run_schedule) AS runs,
       (SELECT count(*)::int FROM pg_temp.seed_engagement_health_history) AS health`
  );
  return rows[0];
}

async function importWithNodeCopy() {
  await Promise.all(ARCHIVES.map(archive => access(archive.path, constants.R_OK)));

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '0'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [8212026]);

    for (const archive of ARCHIVES) {
      await client.query(
        `CREATE TEMP TABLE seed_${archive.table} ` +
        `(LIKE public.${archive.table} INCLUDING DEFAULTS) ON COMMIT DROP`
      );
    }
    for (const archive of ARCHIVES) {
      await copyArchiveIntoTempTable(client, archive);
    }

    const staged = await stagedArchiveCounts(client);
    if (!countsMatch(staged, EXPECTED)) {
      throw new Error('historical archive row-count validation failed');
    }

    const actual = await historicalCounts(text => client.query(text));
    const isEmpty = Object.values(actual).every(value => Number(value) === 0);
    if (isEmpty) {
      for (const archive of ARCHIVES) {
        await client.query(
          `INSERT INTO public.${archive.table} SELECT * FROM pg_temp.seed_${archive.table}`
        );
      }
    } else if (!countsMatch(actual, EXPECTED)) {
      throw new Error('historical production data is partial; refusing import');
    }

    await ensureEngagementOrderSequence(text => client.query(text));
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function seedHistoricalOrderData() {
  engagementOrderWritesReady = false;
  const before = await historicalCounts();

  if (countsMatch(before, EXPECTED)) {
    await ensureEngagementOrderSequence();
    engagementOrderWritesReady = true;
    console.log(
      `[seed] historical orders: already complete ` +
      `(${EXPECTED.orders} orders, ${EXPECTED.runs} runs) — skipping`
    );
    return;
  }

  const isEmpty = Object.values(before).every(value => Number(value) === 0);
  if (!isEmpty) {
    throw new Error(
      `historical order data is partial; refusing automatic import ` +
      `(orders=${before.orders}, items=${before.items}, runs=${before.runs}, health=${before.health})`
    );
  }

  console.log('[seed] historical orders: importing verified archive…');
  await importWithNodeCopy();

  const after = await historicalCounts();
  if (!countsMatch(after, EXPECTED)) {
    throw new Error(
      `historical import verification failed ` +
      `(orders=${after.orders}, items=${after.items}, runs=${after.runs}, health=${after.health})`
    );
  }

  await ensureEngagementOrderSequence();
  engagementOrderWritesReady = true;
  console.log(
    `[seed] historical orders: restored ${after.orders} orders, ` +
    `${after.items} items, ${after.runs} runs, ${after.health} health rows`
  );
}