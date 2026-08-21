import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { ReplitConnectors } from '@replit/connectors-sdk';
import { pool } from '../db.js';
import {
  assertValidArchive,
  BACKUP_INTERVAL_MS,
  BACKUP_RETRY_MS,
  getPgDumpEnvironment,
  isBackupDue,
  runCommand,
  sanitizeBackupError,
} from './databaseBackup.js';

const { Client } = pg;

export const MIRROR_INTERVAL_MS = BACKUP_INTERVAL_MS;
export const MIRROR_RETRY_MS = BACKUP_RETRY_MS;

const MIRROR_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MIRROR_INITIAL_DELAY_MS = 2 * 60 * 1000;
const MIRROR_LOCK_KEY = 1_947_021_559;
const TARGET_MIRROR_LOCK_KEY = 1_947_021_560;
const MIRROR_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const CONNECTOR_TIMEOUT_MS = 20 * 1000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const EXCLUDED_TABLE_DATA = new Set(['user_sessions']);

let runningMirrorPromise = null;
let initialTimer = null;
let intervalTimer = null;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function minimalProcessEnvironment(baseEnv = process.env) {
  const env = {
    PATH: baseEnv.PATH || '',
    HOME: baseEnv.HOME || os.homedir(),
    LANG: baseEnv.LANG || 'C.UTF-8',
  };
  for (const key of ['NIX_SSL_CERT_FILE', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }
  return env;
}

export function isProductionRuntime(env = process.env) {
  return env.NODE_ENV === 'production' || env.REPLIT_DEPLOYMENT === '1';
}

export function extractSupabaseProjectRef(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('SUPABASE_MIRROR_DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('SUPABASE_MIRROR_DATABASE_URL is not a PostgreSQL URL');
  }
  if (!parsed.username || !parsed.password || parsed.pathname.length <= 1) {
    throw new Error('SUPABASE_MIRROR_DATABASE_URL is incomplete');
  }

  const username = decodeURIComponent(parsed.username);
  const poolerMatch = username.match(/^postgres\.([a-z0-9]+)$/i);
  if (parsed.hostname.includes('pooler.supabase.com') && poolerMatch) {
    return poolerMatch[1].toLowerCase();
  }

  const directMatch = parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (directMatch && username === 'postgres') return directMatch[1].toLowerCase();
  throw new Error('SUPABASE_MIRROR_DATABASE_URL does not identify a Supabase project');
}

export function filterPublicRestoreList(listText) {
  const lines = String(listText).split('\n');
  return lines
    .filter(line => !/^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public(?:\s|$)/.test(line))
    .join('\n');
}

export function getMirrorTargetEnvironment(databaseUrl, baseEnv = process.env) {
  const env = getPgDumpEnvironment(databaseUrl, baseEnv);
  env.PGAPPNAME = 'extipspanel-database-mirror';
  env.PGSSLMODE = 'require';
  delete env.PGSSLROOTCERT;
  return env;
}

export function sanitizeMirrorError(error) {
  return sanitizeBackupError(error)
    .replace(/\bSUPABASE_MIRROR_DATABASE_URL=[^\s]+/gi, 'SUPABASE_MIRROR_DATABASE_URL=[redacted]');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function connectedSupabaseProjectRef() {
  const connectors = new ReplitConnectors();
  const proxyFetch = connectors.createProxyFetch('supabase');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);
  try {
    const response = await proxyFetch('/auth/v1/.well-known/openid-configuration', {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Connected Supabase project check failed (HTTP ${response.status})`);
    const body = await response.json();
    const issuer = new URL(body?.issuer);
    const match = issuer.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    if (!match) throw new Error('Connected Supabase project returned an invalid issuer');
    return match[1].toLowerCase();
  } finally {
    clearTimeout(timeout);
  }
}

function targetClientConfig(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    application_name: 'extipspanel-mirror-check',
    connectionTimeoutMillis: 20_000,
    statement_timeout: 60_000,
    query_timeout: 60_000,
    ssl: { rejectUnauthorized: false },
  };
}

async function validateMirrorTarget(databaseUrl) {
  const targetRef = extractSupabaseProjectRef(databaseUrl);
  const connectedRef = await connectedSupabaseProjectRef();
  if (targetRef !== connectedRef) {
    throw new Error('Mirror database URL does not match the connected Supabase backup project');
  }

  const sourceUrl = new URL(process.env.DATABASE_URL);
  const targetUrl = new URL(databaseUrl);
  if (
    sourceUrl.hostname === targetUrl.hostname &&
    sourceUrl.pathname === targetUrl.pathname &&
    sourceUrl.username === targetUrl.username
  ) {
    throw new Error('Mirror target cannot be the source database');
  }

  const client = new Client(targetClientConfig(databaseUrl));
  await client.connect();
  try {
    if (client.connection?.stream?.encrypted !== true) {
      throw new Error('Mirror target connection is not encrypted');
    }
    const { rows } = await client.query(`
      SELECT current_database() AS database_name,
             EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='auth') AS has_auth,
             EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='storage') AS has_storage
    `);
    const target = rows[0];
    if (!target?.has_auth || !target?.has_storage) {
      throw new Error('Mirror target is not a Supabase database');
    }
    const publicTables = await publicTableNames(client);
    return {
      projectRef: targetRef,
      databaseName: target.database_name,
      publicTables,
    };
  } finally {
    await client.end();
  }
}

async function publicTableNames(client) {
  const { rows } = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema='public'
       AND table_type='BASE TABLE'
     ORDER BY table_name
  `);
  return rows.map(row => row.table_name);
}

async function sourceSnapshotManifest(client) {
  const tables = await publicTableNames(client);
  if (!tables.includes('auth_users')) throw new Error('Source public.auth_users table is missing');
  const columnResult = await client.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position
  `, [tables]);
  const columns = Object.fromEntries(tables.map(table => [table, []]));
  for (const row of columnResult.rows) columns[row.table_name].push(row.column_name);
  if (Object.values(columns).some(tableColumns => tableColumns.length === 0)) {
    throw new Error('Source public table column inventory is incomplete');
  }

  const rowCounts = {};
  for (const table of tables) {
    if (EXCLUDED_TABLE_DATA.has(table)) {
      rowCounts[table] = '0';
      continue;
    }
    const { rows } = await client.query(
      `SELECT COUNT(*)::text AS count FROM public.${quoteIdentifier(table)}`
    );
    rowCounts[table] = rows[0].count;
  }

  const credentials = await client.query(`
    SELECT COUNT(*)::text AS user_count,
           COUNT(*) FILTER (
             WHERE encrypted_password ~ '^\\$2[aby]\\$[0-9]{2}\\$'
           )::text AS bcrypt_count,
           md5(string_agg(id::text || ':' || encrypted_password, ',' ORDER BY id)) AS fingerprint
      FROM public.auth_users
  `);
  const credential = credentials.rows[0];
  if (credential.user_count !== credential.bcrypt_count) {
    throw new Error('Source auth_users contains an account without a bcrypt password hash');
  }

  const integrityResult = await client.query(`
    SELECT
      (SELECT COUNT(*)::text
         FROM public.profiles p
         LEFT JOIN public.auth_users u ON u.id=p.user_id
        WHERE u.id IS NULL) AS profile_orphans,
      (SELECT COUNT(*)::text
         FROM public.wallets w
         LEFT JOIN public.auth_users u ON u.id=w.user_id
        WHERE u.id IS NULL) AS wallet_orphans,
      (SELECT COUNT(*)::text
         FROM public.transactions t
         LEFT JOIN public.auth_users u ON u.id=t.user_id
        WHERE u.id IS NULL) AS transaction_orphans,
      (SELECT COUNT(*)::text
         FROM public.engagement_orders o
         LEFT JOIN public.auth_users u ON u.id=o.user_id
        WHERE u.id IS NULL) AS engagement_order_orphans
  `);

  const totalRows = Object.values(rowCounts)
    .reduce((total, count) => total + BigInt(count), 0n)
    .toString();

  return {
    tables,
    columns,
    rowCounts,
    totalRows,
    userCount: credential.user_count,
    bcryptCount: credential.bcrypt_count,
    credentialFingerprint: credential.fingerprint,
    integrity: integrityResult.rows[0],
  };
}

async function createPublicArchive(filePath, snapshotId) {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL is not configured');
  const env = getPgDumpEnvironment(sourceUrl);
  env.PGAPPNAME = 'extipspanel-mirror-export';
  await runCommand('pg_dump', [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    '--schema=public',
    '--exclude-table-data=public.user_sessions',
    `--snapshot=${snapshotId}`,
    '--file',
    filePath,
  ], { env, timeoutMs: MIRROR_COMMAND_TIMEOUT_MS });
  await assertValidArchive(filePath);
}

async function captureConsistentSourceSnapshot(client, archivePath) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const snapshotResult = await client.query('SELECT pg_export_snapshot() AS snapshot_id');
    const snapshotId = snapshotResult.rows[0].snapshot_id;
    const manifest = await sourceSnapshotManifest(client);
    await createPublicArchive(archivePath, snapshotId);
    await client.query('COMMIT');
    return manifest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export function buildMirrorValidationSql({
  manifest,
  sourceEnvironment,
  projectRef,
  snapshotAt,
  archiveSha256,
}) {
  const tableArray = manifest.tables.map(quoteLiteral).join(', ');
  const checks = manifest.tables.map(table => `
    SELECT COUNT(*) INTO actual_count FROM public.${quoteIdentifier(table)};
    IF actual_count <> ${BigInt(manifest.rowCounts[table])} THEN
      RAISE EXCEPTION 'Mirror row count mismatch for ${String(table).replaceAll("'", "''")}';
    END IF;`).join('\n');

  const integrityChecks = Object.entries(manifest.integrity).map(([name, expected]) => {
    const queries = {
      profile_orphans: 'FROM public.profiles p LEFT JOIN public.auth_users u ON u.id=p.user_id WHERE u.id IS NULL',
      wallet_orphans: 'FROM public.wallets w LEFT JOIN public.auth_users u ON u.id=w.user_id WHERE u.id IS NULL',
      transaction_orphans: 'FROM public.transactions t LEFT JOIN public.auth_users u ON u.id=t.user_id WHERE u.id IS NULL',
      engagement_order_orphans: 'FROM public.engagement_orders o LEFT JOIN public.auth_users u ON u.id=o.user_id WHERE u.id IS NULL',
    };
    if (!queries[name]) throw new Error(`Unsupported mirror integrity check: ${name}`);
    return `
    SELECT COUNT(*) INTO actual_count ${queries[name]};
    IF actual_count <> ${BigInt(expected)} THEN
      RAISE EXCEPTION 'Mirror integrity mismatch for ${name}';
    END IF;`;
  }).join('\n');

  return `
DO $mirror_validation$
DECLARE
  actual_count BIGINT;
  actual_tables TEXT[];
  actual_fingerprint TEXT;
BEGIN
  SELECT array_agg(table_name ORDER BY table_name)
    INTO actual_tables
    FROM information_schema.tables
   WHERE table_schema='public' AND table_type='BASE TABLE';
  IF actual_tables IS DISTINCT FROM ARRAY[${tableArray}]::TEXT[] THEN
    RAISE EXCEPTION 'Mirror public table inventory mismatch';
  END IF;
${checks}
  SELECT COUNT(*) FILTER (
           WHERE encrypted_password ~ '^\\$2[aby]\\$[0-9]{2}\\$'
         ),
         md5(string_agg(id::text || ':' || encrypted_password, ',' ORDER BY id))
    INTO actual_count, actual_fingerprint
    FROM public.auth_users;
  IF actual_count <> ${BigInt(manifest.bcryptCount)}
     OR actual_fingerprint IS DISTINCT FROM ${quoteLiteral(manifest.credentialFingerprint)} THEN
    RAISE EXCEPTION 'Mirror user credential verification failed';
  END IF;
${integrityChecks}
END
$mirror_validation$;

CREATE SCHEMA IF NOT EXISTS replit_mirror;
CREATE TABLE IF NOT EXISTS replit_mirror.snapshots (
  id BIGSERIAL PRIMARY KEY,
  source_environment TEXT NOT NULL,
  source_snapshot_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_ref TEXT NOT NULL,
  table_count INTEGER NOT NULL,
  row_count BIGINT NOT NULL,
  user_count BIGINT NOT NULL,
  archive_sha256 CHAR(64) NOT NULL
);
INSERT INTO replit_mirror.snapshots (
  source_environment, source_snapshot_at, project_ref,
  table_count, row_count, user_count, archive_sha256
) VALUES (
  ${quoteLiteral(sourceEnvironment)},
  ${quoteLiteral(snapshotAt.toISOString())}::timestamptz,
  ${quoteLiteral(projectRef)},
  ${manifest.tables.length},
  ${BigInt(manifest.totalRows)},
  ${BigInt(manifest.userCount)},
  ${quoteLiteral(archiveSha256)}
);
DELETE FROM replit_mirror.snapshots
 WHERE id NOT IN (
   SELECT id FROM replit_mirror.snapshots ORDER BY completed_at DESC, id DESC LIMIT 100
 );
`;
}

export function buildMirrorRestorePreamble(sourceColumns, targetTables = []) {
  const sourceTables = Object.keys(sourceColumns);
  const source = new Set(sourceTables);
  const placeholders = sourceTables
    .map(table => {
      const tableName = `public.${quoteIdentifier(table)}`;
      const addColumns = sourceColumns[table]
        .map(column => `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column)} TEXT;`)
        .join('\n');
      return `CREATE TABLE IF NOT EXISTS ${tableName} ();\n${addColumns}`;
    })
    .join('\n');
  const staleDrops = targetTables
    .filter(table => !source.has(table))
    .map(table => `DROP TABLE IF EXISTS public.${quoteIdentifier(table)} CASCADE;`)
    .join('\n');
  return `${placeholders}\n${staleDrops}\n`;
}

function captureChildStderr(child) {
  const chunks = [];
  let captured = 0;
  child.stderr.on('data', chunk => {
    if (captured >= MAX_CAPTURE_BYTES) return;
    chunks.push(chunk);
    captured += chunk.length;
  });
  return () => Buffer.concat(chunks).toString('utf8').trim();
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function restoreArchiveAtomically({
  archivePath,
  restoreListPath,
  targetEnvironment,
  preambleSql,
  validationSql,
}) {
  const restore = spawn('pg_restore', [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--no-comments',
    `--use-list=${restoreListPath}`,
    '--file=-',
    archivePath,
  ], {
    env: minimalProcessEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const psql = spawn('psql', [
    '--dbname',
    targetEnvironment.PGDATABASE,
    '--single-transaction',
    '--set',
    'ON_ERROR_STOP=1',
    '--file=-',
  ], {
    env: targetEnvironment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const restoreError = captureChildStderr(restore);
  const psqlError = captureChildStderr(psql);
  psql.stdout.resume();
  const restoreExit = waitForChild(restore);
  const psqlExit = waitForChild(psql);
  const timer = setTimeout(() => {
    restore.kill('SIGTERM');
    psql.kill('SIGTERM');
    setTimeout(() => {
      restore.kill('SIGKILL');
      psql.kill('SIGKILL');
    }, 5000).unref();
  }, MIRROR_COMMAND_TIMEOUT_MS);

  const wrappedSql = Readable.from((async function* () {
    yield `SET statement_timeout='25min';\nSET lock_timeout='2min';\nSELECT pg_catalog.pg_advisory_xact_lock(${TARGET_MIRROR_LOCK_KEY});\n`;
    yield preambleSql;
    for await (const chunk of restore.stdout) yield chunk;
    const result = await restoreExit;
    if (result.code !== 0) {
      const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
      throw new Error(`pg_restore failed (${reason})${restoreError() ? `: ${restoreError()}` : ''}`);
    }
    yield validationSql;
  })());

  const [pipeResult, restoreResult, psqlResult] = await Promise.allSettled([
    pipeline(wrappedSql, psql.stdin),
    restoreExit,
    psqlExit,
  ]);
  clearTimeout(timer);

  if (psqlResult.status === 'rejected') throw psqlResult.reason;
  if (psqlResult.value.code !== 0) {
    const reason = psqlResult.value.signal
      ? `signal ${psqlResult.value.signal}`
      : `exit code ${psqlResult.value.code}`;
    throw new Error(`Supabase mirror transaction failed (${reason})${psqlError() ? `: ${psqlError()}` : ''}`);
  }
  if (restoreResult.status === 'rejected') throw restoreResult.reason;
  if (pipeResult.status === 'rejected') {
    throw new Error(`Atomic mirror stream failed: ${pipeResult.reason?.message || pipeResult.reason}`);
  }
}

async function verifyCommittedMirror(databaseUrl, expected) {
  const client = new Client(targetClientConfig(databaseUrl));
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT source_environment, table_count::text, row_count::text,
             user_count::text, archive_sha256
        FROM replit_mirror.snapshots
       ORDER BY completed_at DESC, id DESC
       LIMIT 1
    `);
    const latest = rows[0];
    if (
      latest?.source_environment !== expected.sourceEnvironment ||
      latest?.table_count !== String(expected.tableCount) ||
      latest?.row_count !== String(expected.rowCount) ||
      latest?.user_count !== String(expected.userCount) ||
      latest?.archive_sha256 !== expected.archiveSha256
    ) {
      throw new Error('Committed Supabase mirror metadata verification failed');
    }
  } finally {
    await client.end();
  }
}

async function runLockedMirror(lockClient, {
  force = false,
  now = new Date(),
  sourceEnvironment,
} = {}) {
  await lockClient.query(`
    UPDATE replit_ops.database_mirror_runs
       SET status='failed',
           completed_at=now(),
           error_message='Previous mirror process ended before completion'
     WHERE status='running'
       AND started_at < now() - interval '60 minutes'
  `);

  const schedule = await lockClient.query(`
    SELECT
      MAX(completed_at) FILTER (WHERE status='succeeded') AS last_success_at,
      MAX(started_at) AS last_attempt_at
    FROM replit_ops.database_mirror_runs
  `);
  const { last_success_at: lastSuccessAt, last_attempt_at: lastAttemptAt } = schedule.rows[0];
  if (!force && !isBackupDue({
    lastSuccessAt,
    lastAttemptAt,
    now,
    intervalMs: MIRROR_INTERVAL_MS,
    retryMs: MIRROR_RETRY_MS,
  })) {
    return { status: 'skipped', reason: 'not_due' };
  }

  const run = await lockClient.query(
    `INSERT INTO replit_ops.database_mirror_runs
       (status, source_environment, started_at)
     VALUES ('running', $1, $2)
     RETURNING id`,
    [sourceEnvironment, now]
  );
  const runId = run.rows[0].id;
  const targetUrl = process.env.SUPABASE_MIRROR_DATABASE_URL;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'extipspanel-mirror-'));
  const archivePath = path.join(tempDirectory, 'public-mirror.dump');
  const restoreListPath = path.join(tempDirectory, 'restore.list');

  try {
    const target = await validateMirrorTarget(targetUrl);
    const manifest = await captureConsistentSourceSnapshot(lockClient, archivePath);
    const archiveSha256 = await sha256File(archivePath);
    const restoreList = await runCommand('pg_restore', ['--list', archivePath]);
    const filteredList = filterPublicRestoreList(restoreList.stdout);
    if (!filteredList.includes('TABLE')) throw new Error('Mirror archive contains no public tables');
    await writeFile(restoreListPath, filteredList, { mode: 0o600 });

    const targetEnvironment = getMirrorTargetEnvironment(targetUrl);
    const preambleSql = buildMirrorRestorePreamble(manifest.columns, target.publicTables);
    const validationSql = buildMirrorValidationSql({
      manifest,
      sourceEnvironment,
      projectRef: target.projectRef,
      snapshotAt: now,
      archiveSha256,
    });
    await restoreArchiveAtomically({
      archivePath,
      restoreListPath,
      targetEnvironment,
      preambleSql,
      validationSql,
    });
    await verifyCommittedMirror(targetUrl, {
      sourceEnvironment,
      tableCount: manifest.tables.length,
      rowCount: manifest.totalRows,
      userCount: manifest.userCount,
      archiveSha256,
    });

    await lockClient.query(
      `UPDATE replit_ops.database_mirror_runs
          SET status='succeeded',
              target_project_ref=$1,
              source_table_count=$2,
              source_row_count=$3,
              source_user_count=$4,
              archive_sha256=$5,
              completed_at=now(),
              error_message=NULL
        WHERE id=$6`,
      [
        target.projectRef,
        manifest.tables.length,
        manifest.totalRows,
        manifest.userCount,
        archiveSha256,
        runId,
      ]
    );
    return {
      status: 'succeeded',
      sourceEnvironment,
      tableCount: manifest.tables.length,
      rowCount: Number(manifest.totalRows),
      userCount: Number(manifest.userCount),
      archiveSha256,
    };
  } catch (error) {
    const safeMessage = sanitizeMirrorError(error);
    await lockClient.query(
      `UPDATE replit_ops.database_mirror_runs
          SET status='failed', completed_at=now(), error_message=$1
        WHERE id=$2`,
      [safeMessage, runId]
    ).catch(() => {});
    throw new Error(safeMessage);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function executeMirror(options) {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const result = await lockClient.query(
      'SELECT pg_catalog.pg_try_advisory_lock($1) AS locked',
      [MIRROR_LOCK_KEY]
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return { status: 'skipped', reason: 'already_running' };
    return await runLockedMirror(lockClient, options);
  } finally {
    if (locked) {
      await lockClient.query('SELECT pg_catalog.pg_advisory_unlock($1)', [MIRROR_LOCK_KEY]).catch(() => {});
    }
    lockClient.release();
  }
}

export async function runDatabaseMirrorIfDue({
  allowNonProduction = false,
  ...options
} = {}) {
  const production = isProductionRuntime();
  if (!production && !allowNonProduction) {
    return { status: 'skipped', reason: 'non_production' };
  }
  if (!process.env.SUPABASE_MIRROR_DATABASE_URL) {
    throw new Error('SUPABASE_MIRROR_DATABASE_URL is not configured');
  }
  if (runningMirrorPromise) return { status: 'skipped', reason: 'already_running' };

  const sourceEnvironment = production ? 'production' : 'development';
  runningMirrorPromise = executeMirror({ ...options, sourceEnvironment });
  try {
    return await runningMirrorPromise;
  } finally {
    runningMirrorPromise = null;
  }
}

async function mirrorSchedulerTick() {
  try {
    const result = await runDatabaseMirrorIfDue();
    if (result.status === 'succeeded') {
      console.log(
        `[mirror] Supabase database mirror refreshed ` +
        `(${result.tableCount} tables, ${result.rowCount} rows, ${result.userCount} users)`
      );
    }
  } catch (error) {
    console.error(`[mirror] Supabase database mirror failed: ${sanitizeMirrorError(error)}`);
  }
}

export function startDatabaseMirrorScheduler({
  initialDelayMs = MIRROR_INITIAL_DELAY_MS,
  checkIntervalMs = MIRROR_CHECK_INTERVAL_MS,
} = {}) {
  if (initialTimer || intervalTimer) return false;
  if (!isProductionRuntime()) {
    console.log('[mirror] Scheduler disabled outside production');
    return false;
  }
  if (!process.env.SUPABASE_MIRROR_DATABASE_URL) {
    console.error('[mirror] Scheduler disabled: SUPABASE_MIRROR_DATABASE_URL is not configured');
    return false;
  }

  console.log(`[mirror] Scheduler started (every ${MIRROR_INTERVAL_MS / 3_600_000}h)`);
  initialTimer = setTimeout(() => {
    initialTimer = null;
    mirrorSchedulerTick();
    intervalTimer = setInterval(mirrorSchedulerTick, checkIntervalMs);
    intervalTimer.unref?.();
  }, initialDelayMs);
  initialTimer.unref?.();
  return true;
}

export function stopDatabaseMirrorScheduler() {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
}