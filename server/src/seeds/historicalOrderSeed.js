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

export const HISTORICAL_ORDER_EXPECTED_COUNTS = Object.freeze(
  {
    orders: 2695,
    items: 7558,
    runs: 92533,
    health: 233216,
  }
);

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function countsMatch(counts, expected) {
  return Object.entries(expected).every(([key, value]) => Number(counts[key]) === value);
}

function hasHistoricalOrphans(state) {
  return ['orphanItems', 'orphanRuns', 'orphanHealth']
    .some(key => Number(state[key]) > 0);
}

function expectedCountsFrom(state) {
  return Object.fromEntries(
    Object.keys(HISTORICAL_ORDER_EXPECTED_COUNTS)
      .map(key => [key, Number(state[key])])
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

export function createHistoricalOrderSeed({
  connectionPool = pool,
  runQuery = query,
  schema = 'public',
} = {}) {
  const schemaIdentifier = quoteIdentifier(schema);
  const table = name => `${schemaIdentifier}.${quoteIdentifier(name)}`;
  const sequence = table('engagement_orders_order_number_seq');
  const sequenceRegclass = `${schema}.engagement_orders_order_number_seq`;
  let engagementOrderWritesReady = false;

  function areEngagementOrderWritesReady() {
    return engagementOrderWritesReady;
  }

  async function historicalState(execute = runQuery) {
    const { rows } = await execute(
      `SELECT
         (SELECT count(*)::int
            FROM ${table('engagement_orders')}
           WHERE order_number < 3800) AS orders,
         (SELECT count(*)::int
            FROM ${table('engagement_order_items')} i
            JOIN ${table('engagement_orders')} o ON o.id = i.engagement_order_id
           WHERE o.order_number < 3800) AS items,
         (SELECT count(*)::int
            FROM ${table('organic_run_schedule')} r
            JOIN ${table('engagement_order_items')} i ON i.id = r.engagement_order_item_id
            JOIN ${table('engagement_orders')} o ON o.id = i.engagement_order_id
           WHERE o.order_number < 3800) AS runs,
         (SELECT count(*)::int
            FROM ${table('engagement_health_history')} h
            JOIN ${table('engagement_orders')} o ON o.id = h.engagement_order_id
           WHERE o.order_number < 3800) AS health,
         (SELECT count(*)::int
            FROM ${table('engagement_order_items')} i
            LEFT JOIN ${table('engagement_orders')} o ON o.id = i.engagement_order_id
           WHERE o.id IS NULL) AS "orphanItems",
         (SELECT count(*)::int
            FROM ${table('organic_run_schedule')} r
            LEFT JOIN ${table('engagement_order_items')} i
              ON i.id = r.engagement_order_item_id
           WHERE r.engagement_order_item_id IS NOT NULL
             AND i.id IS NULL) AS "orphanRuns",
         (SELECT count(*)::int
            FROM ${table('engagement_health_history')} h
            LEFT JOIN ${table('engagement_orders')} o ON o.id = h.engagement_order_id
           WHERE o.id IS NULL) AS "orphanHealth"`
    );
    return rows[0];
  }

  async function historicalCounts(execute = runQuery) {
    return expectedCountsFrom(await historicalState(execute));
  }

  async function ensureEngagementOrderSequence(execute = runQuery) {
    await execute(
      `WITH current_sequence AS (
         SELECT last_value, is_called
           FROM ${sequence}
       ),
       max_order AS (
         SELECT COALESCE(max(order_number), 0)::bigint AS value
           FROM ${table('engagement_orders')}
       )
       SELECT setval(
         $1::regclass,
         GREATEST(current_sequence.last_value, max_order.value, 3800),
         CASE
           WHEN max_order.value >= 3800 THEN true
           WHEN current_sequence.last_value >= 3800 THEN current_sequence.is_called
           ELSE false
         END
       )
         FROM current_sequence, max_order`,
      [sequenceRegclass]
    );
  }

  async function importWithNodeCopy() {
    await Promise.all(ARCHIVES.map(archive => access(archive.path, constants.R_OK)));

    const client = await connectionPool.connect();
    let transactionOpen = false;

    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query("SET LOCAL statement_timeout = '0'");
      await client.query('SELECT pg_advisory_xact_lock($1)', [8212026]);

      for (const archive of ARCHIVES) {
        await client.query(
          `CREATE TEMP TABLE seed_${archive.table} ` +
          `(LIKE ${table(archive.table)} INCLUDING DEFAULTS) ON COMMIT DROP`
        );
      }
      for (const archive of ARCHIVES) {
        await copyArchiveIntoTempTable(client, archive);
      }

      const staged = await stagedArchiveCounts(client);
      if (!countsMatch(staged, HISTORICAL_ORDER_EXPECTED_COUNTS)) {
        throw new Error('historical archive row-count validation failed');
      }

      const actual = await historicalState((text, params) => client.query(text, params));
      const actualCounts = expectedCountsFrom(actual);
      const isEmpty =
        Object.values(actualCounts).every(value => value === 0) &&
        !hasHistoricalOrphans(actual);
      if (isEmpty) {
        for (const archive of ARCHIVES) {
          await client.query(
            `INSERT INTO ${table(archive.table)} SELECT * FROM pg_temp.seed_${archive.table}`
          );
        }
      } else if (
        !countsMatch(actualCounts, HISTORICAL_ORDER_EXPECTED_COUNTS) ||
        hasHistoricalOrphans(actual)
      ) {
        throw new Error('historical production data is partial; refusing import');
      }

      await ensureEngagementOrderSequence((text, params) => client.query(text, params));
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

  async function seedHistoricalOrderData() {
    engagementOrderWritesReady = false;
    const beforeState = await historicalState();
    const before = expectedCountsFrom(beforeState);

    if (
      countsMatch(before, HISTORICAL_ORDER_EXPECTED_COUNTS) &&
      !hasHistoricalOrphans(beforeState)
    ) {
      await ensureEngagementOrderSequence();
      engagementOrderWritesReady = true;
      console.log(
        `[seed] historical orders: already complete ` +
        `(${HISTORICAL_ORDER_EXPECTED_COUNTS.orders} orders, ` +
        `${HISTORICAL_ORDER_EXPECTED_COUNTS.runs} runs) — skipping`
      );
      return before;
    }

    const isEmpty =
      Object.values(before).every(value => value === 0) &&
      !hasHistoricalOrphans(beforeState);
    if (!isEmpty) {
      throw new Error(
        `historical order data is partial; refusing automatic import ` +
        `(orders=${before.orders}, items=${before.items}, runs=${before.runs}, ` +
        `health=${before.health}, orphanItems=${beforeState.orphanItems}, ` +
        `orphanRuns=${beforeState.orphanRuns}, orphanHealth=${beforeState.orphanHealth})`
      );
    }

    console.log('[seed] historical orders: importing verified archive…');
    await importWithNodeCopy();

    const afterState = await historicalState();
    const after = expectedCountsFrom(afterState);
    if (
      !countsMatch(after, HISTORICAL_ORDER_EXPECTED_COUNTS) ||
      hasHistoricalOrphans(afterState)
    ) {
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
    return after;
  }

  return {
    areEngagementOrderWritesReady,
    historicalCounts,
    seedHistoricalOrderData,
  };
}

const historicalOrderSeed = createHistoricalOrderSeed();

export const areEngagementOrderWritesReady =
  historicalOrderSeed.areEngagementOrderWritesReady;
export const getHistoricalOrderCounts = historicalOrderSeed.historicalCounts;
export const seedHistoricalOrderData = historicalOrderSeed.seedHistoricalOrderData;