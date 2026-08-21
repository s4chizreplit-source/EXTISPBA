import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import {
  buildBackupObjectName,
  getPgDumpEnvironment,
  getRetentionDeletes,
  isBackupDue,
  sanitizeBackupError,
  selectLatestCompleteBackup,
} from '../src/services/databaseBackup.js';

test('backup schedule runs every six hours and throttles failed retries', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');
  assert.equal(isBackupDue({ lastSuccessAt: null, lastAttemptAt: null, now }), true);
  assert.equal(isBackupDue({
    lastSuccessAt: '2026-08-22T07:00:01.000Z',
    lastAttemptAt: '2026-08-22T07:00:01.000Z',
    now,
  }), false);
  assert.equal(isBackupDue({
    lastSuccessAt: '2026-08-22T05:59:59.000Z',
    lastAttemptAt: '2026-08-22T11:45:01.000Z',
    now,
  }), false);
  assert.equal(isBackupDue({
    lastSuccessAt: '2026-08-22T05:59:59.000Z',
    lastAttemptAt: '2026-08-22T11:29:59.000Z',
    now,
  }), true);
});

test('retention keeps the newest complete snapshot pairs', () => {
  const objects = [];
  for (let hour = 0; hour < 4; hour += 1) {
    const archive = `extipspanel-db-20260822T0${hour}0000000Z-aaaaaaaa.dump`;
    objects.push({ name: archive }, { name: archive.replace('.dump', '.json') });
  }
  objects.push({ name: 'unrelated-file.txt' });

  assert.deepEqual(getRetentionDeletes(objects, 2), [
    'extipspanel-db-20260822T010000000Z-aaaaaaaa.dump',
    'extipspanel-db-20260822T010000000Z-aaaaaaaa.json',
    'extipspanel-db-20260822T000000000Z-aaaaaaaa.dump',
    'extipspanel-db-20260822T000000000Z-aaaaaaaa.json',
  ]);
});

test('incomplete uploads never evict complete backup pairs', () => {
  const completeOld = 'extipspanel-db-20260821T000000000Z-complete.dump';
  const incompleteNew = 'extipspanel-db-20260822T120000000Z-incomplete.dump';
  assert.deepEqual(getRetentionDeletes([
    { name: completeOld },
    { name: completeOld.replace('.dump', '.json') },
    { name: incompleteNew },
  ], 1), []);
});

test('latest backup selection requires both archive and manifest', () => {
  const objects = [
    { name: 'extipspanel-db-20260822T120000000Z-newest.json' },
    { name: 'extipspanel-db-20260822T110000000Z-complete.json' },
    { name: 'extipspanel-db-20260822T110000000Z-complete.dump' },
  ];
  assert.deepEqual(selectLatestCompleteBackup(objects), {
    archiveName: 'extipspanel-db-20260822T110000000Z-complete.dump',
    manifestName: 'extipspanel-db-20260822T110000000Z-complete.json',
  });
});

test('pg_dump environment contains only connection and process essentials', () => {
  const env = getPgDumpEnvironment(
    'postgresql://backup%40user:p%40ss@db.example.test:6543/app%20db?sslmode=require',
    {
      PATH: '/bin',
      HOME: '/tmp',
      SESSION_SECRET: 'must-not-leak',
      PROVIDER_API_KEY: 'must-not-leak',
    }
  );
  assert.equal(env.PGHOST, 'db.example.test');
  assert.equal(env.PGPORT, '6543');
  assert.equal(env.PGUSER, 'backup@user');
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGDATABASE, 'app db');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal('SESSION_SECRET' in env, false);
  assert.equal('PROVIDER_API_KEY' in env, false);
});

test('backup names are sortable and errors redact credentials', () => {
  assert.equal(
    buildBackupObjectName(new Date('2026-08-22T12:34:56.789Z'), '1234abcd'),
    'extipspanel-db-20260822T123456789Z-1234abcd.dump'
  );
  const safe = sanitizeBackupError(
    new Error('failed postgresql://user:secret@host/db password=hunter2')
  );
  assert.equal(safe.includes('secret'), false);
  assert.equal(safe.includes('hunter2'), false);
  assert.match(safe, /\[redacted database URL\]/);
});

test('backup status migration is idempotent on a clean schema', async () => {
  const schema = `backup_test_${randomUUID().replace(/-/g, '')}`;
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'server/migrations/20260822_database_backup_runs.sql'),
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
    await client.query(migration);
    await client.query(migration);
    const { rows } = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'database_backup_runs'
        ORDER BY ordinal_position`,
      [schema]
    );
    assert.deepEqual(rows.map(row => row.column_name), [
      'id',
      'status',
      'object_name',
      'manifest_name',
      'size_bytes',
      'sha256',
      'started_at',
      'completed_at',
      'error_message',
    ]);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});