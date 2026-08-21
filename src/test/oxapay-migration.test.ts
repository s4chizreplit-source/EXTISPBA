import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

function postgresClient() {
  const sslMode = String(process.env.PGSSLMODE || '').toLowerCase();
  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ['require', 'verify-ca', 'verify-full'].includes(sslMode)
      ? { rejectUnauthorized: true }
      : false,
  });
}

describe('OxaPay clean-schema migration', () => {
  it('provisions the payment tables and ledger columns after the base migration', async () => {
    const schema = `oxapay_test_${randomUUID().replace(/-/g, '')}`;
    const root = process.cwd();
    const baseMigration = fs.readFileSync(
      path.join(root, 'server/migrations/001_init.sql'),
      'utf8',
    );
    const oxapayMigration = fs.readFileSync(
      path.join(root, 'server/migrations/20260822_oxapay_wallet_topups.sql'),
      'utf8',
    );
    const client = postgresClient();
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(baseMigration);
      await client.query(oxapayMigration);

      const { rows: tables } = await client.query(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema=$1
            AND table_name IN ('oxapay_deposits','webhook_events','oxapay_activity_log')
          ORDER BY table_name`,
        [schema],
      );
      expect(tables.map(row => row.table_name)).toEqual([
        'oxapay_activity_log',
        'oxapay_deposits',
        'webhook_events',
      ]);

      const { rows: columns } = await client.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema=$1 AND table_name='transactions'
            AND column_name IN ('status','payment_method','payment_reference')
          ORDER BY column_name`,
        [schema],
      );
      expect(columns.map(row => row.column_name)).toEqual([
        'payment_method',
        'payment_reference',
        'status',
      ]);

      const userId = randomUUID();
      const orderId = `oxw_migration_${Date.now()}`;
      await client.query(
        `INSERT INTO users (id,email,password_hash) VALUES ($1,$2,'test-hash')`,
        [userId, `${userId}@example.invalid`],
      );
      await client.query(
        `INSERT INTO oxapay_deposits
          (user_id,order_id,track_id,amount_usd,amount_inr)
         VALUES ($1,$2,'migration-track',1.2,100)`,
        [userId, orderId],
      );
      await client.query(
        `INSERT INTO webhook_events
          (provider,order_id,track_id,payload_hash,event_status)
         VALUES ('oxapay',$1,'migration-track','hash','paid')`,
        [orderId],
      );
      await client.query(
        `INSERT INTO oxapay_activity_log
          (source,event,order_id,user_id,ok)
         VALUES ('webhook','wallet_credited',$1,$2,true)`,
        [orderId, userId],
      );
      await client.query(
        `INSERT INTO transactions
          (user_id,type,amount,balance_after,status,payment_method,payment_reference)
         VALUES ($1,'deposit',1.2,1.2,'completed','oxapay',$2)`,
        [userId, orderId],
      );

      await expect(
        client.query(
          `INSERT INTO transactions
            (user_id,type,amount,balance_after,status,payment_method,payment_reference)
           VALUES ($1,'deposit',1.2,2.4,'completed','oxapay',$2)`,
          [userId, orderId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }, 30000);
});