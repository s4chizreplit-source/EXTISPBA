import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import {
  buildMirrorValidationSql,
  buildMirrorRestorePreamble,
  extractSupabaseProjectRef,
  filterPublicRestoreList,
  getMirrorTargetEnvironment,
  isProductionRuntime,
  sanitizeMirrorError,
} from '../src/services/databaseMirror.js';

test('Supabase project reference is derived without exposing credentials', () => {
  assert.equal(
    extractSupabaseProjectRef(
      'postgresql://postgres.projectref:secret@aws-0-region.pooler.supabase.com:5432/postgres'
    ),
    'projectref'
  );
  assert.equal(
    extractSupabaseProjectRef(
      'postgresql://postgres:secret@db.projectref.supabase.co:5432/postgres'
    ),
    'projectref'
  );
  assert.throws(
    () => extractSupabaseProjectRef('postgresql://user:secret@example.com/db'),
    /does not identify a Supabase project/
  );
});

test('restore list preserves public objects but never replaces the public schema', () => {
  const list = [
    '; Archive created at 2026-08-22',
    '5; 2615 2200 SCHEMA - public owner',
    '100; 1259 123 TABLE public auth_users owner',
    '101; 0 123 TABLE DATA public auth_users owner',
  ].join('\n');
  const filtered = filterPublicRestoreList(list);
  assert.equal(filtered.includes('SCHEMA - public'), false);
  assert.equal(filtered.includes('TABLE public auth_users'), true);
  assert.equal(filtered.includes('TABLE DATA public auth_users'), true);
});

test('target command environment excludes unrelated application secrets', () => {
  const env = getMirrorTargetEnvironment(
    'postgresql://postgres.project:p%40ss@pooler.supabase.com:5432/postgres',
    {
      PATH: '/bin',
      HOME: '/tmp',
      SESSION_SECRET: 'do-not-copy',
      PROVIDER_API_KEY: 'do-not-copy',
    }
  );
  assert.equal(env.PGUSER, 'postgres.project');
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal('SESSION_SECRET' in env, false);
  assert.equal('PROVIDER_API_KEY' in env, false);
});

test('validation SQL verifies inventory, counts, credentials, and relationships', () => {
  const sql = buildMirrorValidationSql({
    manifest: {
      tables: ['auth_users', 'profiles'],
      rowCounts: { auth_users: '811', profiles: '811' },
      totalRows: '1622',
      userCount: '811',
      bcryptCount: '811',
      credentialFingerprint: '0123456789abcdef0123456789abcdef',
      integrity: {
        profile_orphans: '0',
        wallet_orphans: '0',
        transaction_orphans: '0',
        engagement_order_orphans: '0',
      },
    },
    sourceEnvironment: 'production',
    projectRef: 'projectref',
    snapshotAt: new Date('2026-08-22T12:00:00.000Z'),
    archiveSha256: 'a'.repeat(64),
  });
  assert.match(sql, /public\."auth_users"/);
  assert.match(sql, /actual_tables IS DISTINCT FROM/);
  assert.match(sql, /Mirror user credential verification failed/);
  assert.match(sql, /profile_orphans/);
  assert.match(sql, /replit_mirror\.snapshots/);
});

test('restore preamble protects cleanup and removes stale mirror tables', () => {
  const sql = buildMirrorRestorePreamble(
    {
      auth_users: ['id', 'encrypted_password'],
      profiles: ['id', 'user_id'],
    },
    ['auth_users', 'legacy_table']
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."auth_users" \(\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."profiles" \(\)/);
  assert.match(sql, /ALTER TABLE public\."auth_users" ADD COLUMN IF NOT EXISTS "encrypted_password" TEXT/);
  assert.match(sql, /DROP TABLE IF EXISTS public\."legacy_table" CASCADE/);
  assert.equal(sql.includes('DROP TABLE IF EXISTS public."auth_users" CASCADE'), false);
});

test('runtime guard only enables the scheduled mirror in production', () => {
  assert.equal(isProductionRuntime({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionRuntime({ REPLIT_DEPLOYMENT: '1' }), true);
  assert.equal(isProductionRuntime({ NODE_ENV: 'development' }), false);
});

test('mirror errors redact database URLs and explicit mirror settings', () => {
  const safe = sanitizeMirrorError(
    new Error(
      'SUPABASE_MIRROR_DATABASE_URL=postgresql://postgres:secret@host/db ' +
      'failed postgresql://other:hunter2@host/db'
    )
  );
  assert.equal(safe.includes('secret'), false);
  assert.equal(safe.includes('hunter2'), false);
  assert.match(safe, /\[redacted database URL\]/);
});

test('mirror status migration is idempotent on a clean schema', async () => {
  const schema = `mirror_test_${randomUUID().replace(/-/g, '')}`;
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'server/migrations/20260822_database_mirror_runs.sql'),
    'utf8'
  );
  const sslMode = String(process.env.PGSSLMODE || '').toLowerCase();
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ['require', 'verify-ca', 'verify-full'].includes(sslMode)
      ? { rejectUnauthorized: true }
      : false,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const scopedMigration = migration
      .replaceAll('replit_ops.database_mirror_runs', `"${schema}".database_mirror_runs`)
      .replace('CREATE SCHEMA IF NOT EXISTS replit_ops;', '');
    await client.query(scopedMigration);
    await client.query(scopedMigration);
    const { rows } = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='database_mirror_runs'
        ORDER BY ordinal_position`,
      [schema]
    );
    assert.deepEqual(rows.map(row => row.column_name), [
      'id',
      'status',
      'source_environment',
      'target_project_ref',
      'source_table_count',
      'source_row_count',
      'source_user_count',
      'archive_sha256',
      'started_at',
      'completed_at',
      'error_message',
    ]);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});