import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {
  createHistoricalOrderSeed,
  HISTORICAL_ORDER_EXPECTED_COUNTS,
} from '../src/seeds/historicalOrderSeed.js';
import {
  createEngagementOrderReadinessMiddleware,
} from '../src/middleware/engagementOrderReadiness.js';
import { isCronReady, startCron } from '../src/cron.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the historical seed integration test');
}

function identifier(name) {
  assert.match(name, /^[a-z_][a-z0-9_]*$/);
  return `"${name}"`;
}

function readinessResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function assertMiddlewareState(seeder, expectedReady) {
  const middleware = createEngagementOrderReadinessMiddleware(
    seeder.areEngagementOrderWritesReady
  );
  const response = readinessResponse();
  let continued = false;
  middleware({}, response, () => {
    continued = true;
  });

  assert.equal(continued, expectedReady);
  assert.equal(response.statusCode, expectedReady ? 200 : 503);
  if (!expectedReady) {
    assert.match(response.body.error, /finishing startup/i);
  }
}

test(
  'restores and verifies historical engagement data before enabling writes or cron',
  { timeout: 180_000 },
  async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const schema = `historical_seed_test_${process.pid}_${Date.now()}`;
    const quotedSchema = identifier(schema);
    const table = name => `${quotedSchema}.${identifier(name)}`;
    const sequence = table('engagement_orders_order_number_seq');
    const liveOrderId = randomUUID();
    const liveOrderNumber = 3807;
    const preservedSequenceValue = 5000;

    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      await pool.query(`CREATE SEQUENCE ${sequence}`);

      for (const name of [
        'engagement_orders',
        'engagement_order_items',
        'organic_run_schedule',
        'engagement_health_history',
      ]) {
        await pool.query(
          `CREATE TABLE ${table(name)} ` +
          `(LIKE public.${identifier(name)} INCLUDING DEFAULTS)`
        );
      }
      await pool.query(
        `ALTER TABLE ${table('engagement_orders')}
           ALTER COLUMN order_number
           SET DEFAULT nextval('${schema}.engagement_orders_order_number_seq'::regclass)`
      );

      await pool.query(
        `INSERT INTO ${table('engagement_orders')}
           (id, order_number, user_id, link, base_quantity, total_price, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          liveOrderId,
          liveOrderNumber,
          randomUUID(),
          'https://example.com/live-order',
          100,
          1.25,
          'processing',
        ]
      );
      await pool.query(`SELECT setval($1::regclass, $2, true)`, [
        `${schema}.engagement_orders_order_number_seq`,
        preservedSequenceValue,
      ]);

      const seeder = createHistoricalOrderSeed({
        connectionPool: pool,
        runQuery: (text, params) => pool.query(text, params),
        schema,
      });

      assert.deepEqual(await seeder.historicalCounts(), {
        orders: 0,
        items: 0,
        runs: 0,
        health: 0,
      });
      assert.equal(seeder.areEngagementOrderWritesReady(), false);
      await assertMiddlewareState(seeder, false);
      assert.equal(isCronReady(seeder.areEngagementOrderWritesReady), false);
      assert.equal(
        startCron({ isReady: seeder.areEngagementOrderWritesReady }),
        false
      );

      const firstSeedCounts = await seeder.seedHistoricalOrderData();
      assert.deepEqual(firstSeedCounts, HISTORICAL_ORDER_EXPECTED_COUNTS);
      assert.deepEqual(
        await seeder.historicalCounts(),
        HISTORICAL_ORDER_EXPECTED_COUNTS
      );

      const { rows: liveRowsAfterSeed } = await pool.query(
        `SELECT id, order_number, link
           FROM ${table('engagement_orders')}
          WHERE order_number >= 3800`
      );
      assert.deepEqual(liveRowsAfterSeed, [{
        id: liveOrderId,
        order_number: liveOrderNumber,
        link: 'https://example.com/live-order',
      }]);

      const { rows: sequenceAfterSeed } = await pool.query(
        `SELECT last_value, is_called FROM ${sequence}`
      );
      assert.equal(Number(sequenceAfterSeed[0].last_value), preservedSequenceValue);
      assert.equal(sequenceAfterSeed[0].is_called, true);
      assert.equal(seeder.areEngagementOrderWritesReady(), true);
      await assertMiddlewareState(seeder, true);
      assert.equal(isCronReady(seeder.areEngagementOrderWritesReady), true);

      const secondSeedCounts = await seeder.seedHistoricalOrderData();
      assert.deepEqual(secondSeedCounts, HISTORICAL_ORDER_EXPECTED_COUNTS);
      assert.deepEqual(
        await seeder.historicalCounts(),
        HISTORICAL_ORDER_EXPECTED_COUNTS
      );

      const { rows: preservedState } = await pool.query(
        `SELECT
           (SELECT count(*)::int
              FROM ${table('engagement_orders')}
             WHERE order_number >= 3800) AS live_orders,
           (SELECT last_value::bigint FROM ${sequence}) AS sequence_value`
      );
      assert.equal(preservedState[0].live_orders, 1);
      assert.equal(
        Number(preservedState[0].sequence_value),
        preservedSequenceValue
      );

      await pool.query(
        `DELETE FROM ${table('engagement_health_history')}
          WHERE id = (
            SELECT id FROM ${table('engagement_health_history')} LIMIT 1
          )`
      );
      await assert.rejects(
        seeder.seedHistoricalOrderData(),
        /historical order data is partial; refusing automatic import/
      );
      assert.deepEqual(await seeder.historicalCounts(), {
        ...HISTORICAL_ORDER_EXPECTED_COUNTS,
        health: HISTORICAL_ORDER_EXPECTED_COUNTS.health - 1,
      });
      assert.equal(seeder.areEngagementOrderWritesReady(), false);
      await assertMiddlewareState(seeder, false);
      assert.equal(isCronReady(seeder.areEngagementOrderWritesReady), false);
      assert.equal(
        startCron({ isReady: seeder.areEngagementOrderWritesReady }),
        false
      );

      await pool.query(
        `DELETE FROM ${table('engagement_orders')} WHERE order_number < 3800`
      );
      await assert.rejects(
        seeder.seedHistoricalOrderData(),
        /historical order data is partial; refusing automatic import/
      );
      assert.deepEqual(await seeder.historicalCounts(), {
        orders: 0,
        items: 0,
        runs: 0,
        health: 0,
      });
      assert.equal(seeder.areEngagementOrderWritesReady(), false);
      await assertMiddlewareState(seeder, false);
      assert.equal(isCronReady(seeder.areEngagementOrderWritesReady), false);

      const { rows: liveRowsAfterRejection } = await pool.query(
        `SELECT id, order_number
           FROM ${table('engagement_orders')}
          WHERE order_number >= 3800`
      );
      assert.deepEqual(liveRowsAfterRejection, [{
        id: liveOrderId,
        order_number: liveOrderNumber,
      }]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  }
);