import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { pool } from '../db.js';
import {
  preparePreviewItemsForMigration,
  preparePreviewRunsForMigration,
} from './previewOrderMigrationState.js';

const SNAPSHOT_FILE = fileURLToPath(
  new URL('../../data/preview-order-migration/order-3800.json.gz', import.meta.url)
);
const MIGRATION_LOCK = 8213800;
const EXPECTED_ITEMS = 4;
const EXPECTED_RUNS = 12;

let cachedSnapshot;

async function loadSnapshot() {
  if (!cachedSnapshot) {
    cachedSnapshot = JSON.parse(gunzipSync(await readFile(SNAPSHOT_FILE)).toString('utf8'));
  }
  return cachedSnapshot;
}

async function verifyExistingMigration(client, sourceOrderId) {
  const { rows: [existing] } = await client.query(
    `SELECT o.order_number,
       (SELECT count(*)::int FROM engagement_order_items i
         WHERE i.engagement_order_id=o.id) AS items,
       (SELECT count(*)::int
          FROM organic_run_schedule r
          JOIN engagement_order_items i ON i.id=r.engagement_order_item_id
         WHERE i.engagement_order_id=o.id) AS runs,
       EXISTS(
         SELECT 1 FROM transactions t
          WHERE t.payment_reference=$2
       ) AS has_transaction
     FROM engagement_orders o
     WHERE o.id=$1`,
    [sourceOrderId, `engagement-order:${sourceOrderId}`]
  );

  if (!existing) return null;
  if (
    Number(existing.items) !== EXPECTED_ITEMS ||
    Number(existing.runs) !== EXPECTED_RUNS ||
    !existing.has_transaction
  ) {
    throw new Error('preview order migration is partial; refusing startup');
  }
  return Number(existing.order_number);
}

export async function seedPreviewOrderMigration() {
  const snapshot = await loadSnapshot();
  if (
    snapshot.sourceOrderId !== snapshot.order?.id ||
    snapshot.items?.length !== EXPECTED_ITEMS ||
    snapshot.runs?.length !== EXPECTED_RUNS ||
    snapshot.transaction?.payment_reference !== `engagement-order:${snapshot.sourceOrderId}`
  ) {
    throw new Error('preview order migration snapshot validation failed');
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);

    const existingOrderNumber = await verifyExistingMigration(client, snapshot.sourceOrderId);
    if (existingOrderNumber !== null) {
      await client.query('COMMIT');
      transactionOpen = false;
      console.log(`[seed] preview order migration: already present as #${existingOrderNumber}`);
      return;
    }

    const duplicateTransaction = await client.query(
      `SELECT 1 FROM transactions
        WHERE id=$1 OR payment_reference=$2
        LIMIT 1`,
      [snapshot.transaction.id, snapshot.transaction.payment_reference]
    );
    if (duplicateTransaction.rowCount > 0) {
      throw new Error('preview order migration transaction already exists without its order');
    }

    const { rows: [wallet] } = await client.query(
      `UPDATE wallets
          SET balance = balance - $1,
              total_spent = COALESCE(total_spent, 0) + $1,
              updated_at = now()
        WHERE user_id=$2
          AND balance >= $1
      RETURNING id, balance`,
      [snapshot.order.total_price, snapshot.order.user_id]
    );
    if (!wallet) {
      throw new Error('preview order migration wallet is missing or has insufficient balance');
    }

    const order = snapshot.order;
    const { rows: [insertedOrder] } = await client.query(
      `INSERT INTO engagement_orders
        (id, order_number, user_id, bundle_id, link, base_quantity, total_price,
         is_organic_mode, variance_percent, peak_hours_enabled, status,
         error_message, created_at, updated_at, completed_at,
         current_botting_percent, current_health_score, last_health_check_at,
         campaign_name)
       VALUES
        ($1, nextval('engagement_orders_order_number_seq'), $2, $3, $4, $5, $6,
         $7, $8, $9, 'processing', NULL, $10, now(), NULL, $11, $12, $13, $14)
       RETURNING order_number`,
      [
        order.id,
        order.user_id,
        order.bundle_id,
        order.link,
        order.base_quantity,
        order.total_price,
        order.is_organic_mode,
        order.variance_percent,
        order.peak_hours_enabled,
        order.created_at,
        order.current_botting_percent,
        order.current_health_score,
        order.last_health_check_at,
        order.campaign_name,
      ]
    );

    const migratedItems = preparePreviewItemsForMigration(snapshot.items);
    await client.query(
      `INSERT INTO engagement_order_items
       SELECT * FROM json_populate_recordset(
         NULL::engagement_order_items,
         $1::json
       )`,
      [JSON.stringify(migratedItems)]
    );

    const migratedRuns = preparePreviewRunsForMigration(snapshot.runs);
    await client.query(
      `INSERT INTO organic_run_schedule
       SELECT * FROM json_populate_recordset(
         NULL::organic_run_schedule,
         $1::json
       )`,
      [JSON.stringify(migratedRuns)]
    );

    if (snapshot.health.length > 0) {
      await client.query(
        `INSERT INTO engagement_health_history
         SELECT * FROM json_populate_recordset(
           NULL::engagement_health_history,
           $1::json
         )`,
        [JSON.stringify(snapshot.health)]
      );
    }

    const transaction = snapshot.transaction;
    await client.query(
      `INSERT INTO transactions
        (id, user_id, type, amount, balance_after, order_id, description,
         payment_method, payment_reference, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        transaction.id,
        transaction.user_id,
        transaction.type,
        transaction.amount,
        wallet.balance,
        transaction.order_id,
        `Engagement Order #${insertedOrder.order_number}`,
        transaction.payment_method,
        transaction.payment_reference,
        transaction.status,
        transaction.created_at,
      ]
    );

    await client.query('COMMIT');
    transactionOpen = false;
    console.log(
      `[seed] preview order migration: moved as #${insertedOrder.order_number} ` +
      `(${migratedItems.length} items, ${migratedRuns.length} runs)`
    );
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}