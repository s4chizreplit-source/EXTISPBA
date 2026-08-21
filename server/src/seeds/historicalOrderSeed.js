import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { query } from '../db.js';

const HISTORY_FILE = fileURLToPath(
  new URL('../../data/historical-orders.sql.gz', import.meta.url)
);

const EXPECTED = {
  orders: 2695,
  items: 7558,
  runs: 92533,
  health: 233216,
};

let engagementOrderWritesReady = false;

export function areEngagementOrderWritesReady() {
  return engagementOrderWritesReady;
}

async function historicalCounts() {
  const { rows } = await query(
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

async function ensureEngagementOrderSequence() {
  await query(
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

async function importWithPsql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is unavailable for historical import');
  }
  await access(HISTORY_FILE, constants.R_OK);

  const child = spawn('psql', ['-X', '--set', 'ON_ERROR_STOP=1'], {
    env: {
      ...process.env,
      // libpq reads PGDATABASE, not the Node driver's DATABASE_URL variable.
      // Passing the URI through the environment keeps credentials out of argv.
      PGDATABASE: process.env.DATABASE_URL,
      PGAPPNAME: 'historical-order-seed',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  // Keep provider credentials, links, and row contents out of application logs.
  child.stderr.resume();

  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });

  const inputPromise = pipeline(
    createReadStream(HISTORY_FILE),
    createGunzip(),
    child.stdin
  );

  const [code] = await Promise.all([exitPromise, inputPromise]);
  if (code !== 0) {
    throw new Error(`historical import process exited with code ${code}`);
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
  await importWithPsql();

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