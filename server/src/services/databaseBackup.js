import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  mkdtemp,
  open,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReplitConnectors } from '@replit/connectors-sdk';
import { pool } from '../db.js';

export const BACKUP_BUCKET = 'replit-db-backups';
export const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BACKUP_RETRY_MS = 30 * 60 * 1000;
export const BACKUP_RETENTION_COUNT = 28;

const BACKUP_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const BACKUP_INITIAL_DELAY_MS = 30 * 1000;
const BACKUP_LOCK_KEY = 1_947_021_558;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ERROR_LENGTH = 800;
const OBJECT_PREFIX = 'extipspanel-db-';
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;
const TUS_VERSION = '1.0.0';
const STORAGE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

let runningBackupPromise = null;
let initialTimer = null;
let intervalTimer = null;

function encodeStorageSegment(value) {
  return encodeURIComponent(String(value));
}

function storageObjectPath(bucket, objectName) {
  return `/storage/v1/object/${encodeStorageSegment(bucket)}/${encodeStorageSegment(objectName)}`;
}

async function responseError(response) {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const body = JSON.parse(text);
    const message = body?.message || body?.error || body?.code;
    return `HTTP ${response.status}: ${String(message || 'request failed').slice(0, 300)}`;
  } catch {
    return `HTTP ${response.status}: ${text.slice(0, 300)}`;
  }
}

export function sanitizeBackupError(error) {
  const message = String(error?.message || error || 'Unknown backup error');
  return message
    .replace(/\bpostgres(?:ql)?:\/\/[^\s]+/gi, '[redacted database URL]')
    .replace(/\b(password|token|apikey|api_key)=([^\s&]+)/gi, '$1=[redacted]')
    .slice(0, MAX_ERROR_LENGTH);
}

export function buildBackupObjectName(now = new Date(), suffix = randomBytes(4).toString('hex')) {
  const timestamp = now.toISOString().replace(/[-:.]/g, '');
  return `${OBJECT_PREFIX}${timestamp}-${suffix}.dump`;
}

export function isBackupDue({
  lastSuccessAt,
  lastAttemptAt,
  now = new Date(),
  intervalMs = BACKUP_INTERVAL_MS,
  retryMs = BACKUP_RETRY_MS,
}) {
  const nowMs = now.getTime();
  const lastSuccessMs = lastSuccessAt ? new Date(lastSuccessAt).getTime() : NaN;
  if (Number.isFinite(lastSuccessMs) && nowMs - lastSuccessMs < intervalMs) {
    return false;
  }

  const lastAttemptMs = lastAttemptAt ? new Date(lastAttemptAt).getTime() : NaN;
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < retryMs) {
    return false;
  }

  return true;
}

export function getRetentionDeletes(objects, retentionCount = BACKUP_RETENTION_COUNT) {
  const names = new Set(objects.map(item => String(item?.name || '')));
  const completeArchiveNames = [...names]
    .filter(name =>
      name.startsWith(OBJECT_PREFIX) &&
      name.endsWith('.dump') &&
      names.has(name.replace(/\.dump$/, '.json'))
    )
    .sort((a, b) => b.localeCompare(a));

  return completeArchiveNames.slice(retentionCount).flatMap(archiveName => [
    archiveName,
    archiveName.replace(/\.dump$/, '.json'),
  ]);
}

export function selectLatestCompleteBackup(objects) {
  const names = new Set(objects.map(item => String(item?.name || '')));
  const manifests = [...names]
    .filter(name => name.startsWith(OBJECT_PREFIX) && name.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a));

  for (const manifestName of manifests) {
    const archiveName = manifestName.replace(/\.json$/, '.dump');
    if (names.has(archiveName)) return { archiveName, manifestName };
  }
  return null;
}

export function getPgDumpEnvironment(databaseUrl, baseEnv = process.env) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL is not a PostgreSQL connection URL');
  }

  const env = {
    PATH: baseEnv.PATH || '',
    HOME: baseEnv.HOME || os.homedir(),
    LANG: baseEnv.LANG || 'C.UTF-8',
    PGAPPNAME: 'extipspanel-backup',
    PGCONNECT_TIMEOUT: '20',
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };

  for (const key of ['NIX_SSL_CERT_FILE', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }
  const sslMode = parsed.searchParams.get('sslmode') || baseEnv.PGSSLMODE;
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

function minimalCommandEnvironment(baseEnv = process.env) {
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

export async function runCommand(command, args, { env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env || minimalCommandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const capture = (target, chunk) => {
      if (outputBytes >= 64 * 1024) return;
      outputBytes += chunk.length;
      target.push(chunk);
    };
    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) {
        resolve({ stdout: output, stderr: errorOutput });
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${command} failed (${reason})${errorOutput ? `: ${errorOutput}` : ''}`));
    });
  });
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function assertValidArchive(filePath) {
  const header = Buffer.alloc(5);
  const file = await open(filePath, 'r');
  try {
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString('ascii') !== 'PGDMP') {
      throw new Error('pg_dump did not create a PostgreSQL custom-format archive');
    }
  } finally {
    await file.close();
  }
  await runCommand('pg_restore', ['--list', filePath]);
}

async function createDatabaseArchive(filePath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured');
  const env = getPgDumpEnvironment(databaseUrl);
  await runCommand('pg_dump', [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    '--file',
    filePath,
  ], { env });
  await assertValidArchive(filePath);
}

function createStorageClient() {
  const connectors = new ReplitConnectors();
  const proxyFetch = connectors.createProxyFetch('supabase');
  return {
    async proxy(pathname, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), STORAGE_REQUEST_TIMEOUT_MS);
      let body = options.body;
      const headers = { ...(options.headers || {}) };
      if (
        body &&
        typeof body === 'object' &&
        !Buffer.isBuffer(body) &&
        !(body instanceof ArrayBuffer) &&
        Object.getPrototypeOf(body) === Object.prototype
      ) {
        body = JSON.stringify(body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      try {
        return await proxyFetch(pathname, {
          ...options,
          headers,
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function ensurePrivateBucket(storage) {
  const bucketPath = `/storage/v1/bucket/${encodeStorageSegment(BACKUP_BUCKET)}`;
  let response = await storage.proxy(bucketPath, { method: 'GET' });

  if (response.status === 404) {
    const createResponse = await storage.proxy('/storage/v1/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        id: BACKUP_BUCKET,
        name: BACKUP_BUCKET,
        public: false,
      },
    });
    if (!createResponse.ok && createResponse.status !== 409) {
      throw new Error(`Could not create private backup bucket (${await responseError(createResponse)})`);
    }
    response = await storage.proxy(bucketPath, { method: 'GET' });
  }

  if (!response.ok) {
    throw new Error(`Could not inspect backup bucket (${await responseError(response)})`);
  }
  const bucket = await response.json();
  if (bucket?.public !== false) {
    throw new Error('Backup bucket is public; refusing to upload sensitive database data');
  }
}

function tusMetadata(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
    .join(',');
}

function normalizeTusLocation(location) {
  if (!location) throw new Error('Supabase resumable upload returned no location');
  if (location.startsWith('/')) return location;
  try {
    const url = new URL(location);
    if (url.protocol !== 'https:') {
      throw new Error('Supabase resumable upload returned a non-HTTPS location');
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    if (error.message.includes('non-HTTPS')) throw error;
    throw new Error('Supabase resumable upload returned an invalid location');
  }
}

async function getTusOffset(storage, uploadPath) {
  const response = await storage.proxy(uploadPath, {
    method: 'HEAD',
    headers: { 'Tus-Resumable': TUS_VERSION },
  });
  if (!response.ok) {
    throw new Error(`Could not resume backup upload (${await responseError(response)})`);
  }
  const offset = Number(response.headers.get('upload-offset'));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Supabase resumable upload returned an invalid offset');
  }
  return offset;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function uploadArchive(storage, objectName, filePath) {
  const archiveStat = await stat(filePath);
  const createResponse = await storage.proxy('/storage/v1/upload/resumable', {
    method: 'POST',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(archiveStat.size),
      'Upload-Metadata': tusMetadata({
        bucketName: BACKUP_BUCKET,
        objectName,
        contentType: 'application/octet-stream',
        cacheControl: '0',
      }),
      'x-upsert': 'false',
    },
  });
  if (createResponse.status !== 201) {
    throw new Error(`Backup upload initialization failed (${await responseError(createResponse)})`);
  }
  const uploadPath = normalizeTusLocation(createResponse.headers.get('location'));

  const file = await open(filePath, 'r');
  let offset = 0;
  try {
    uploadLoop:
    while (offset < archiveStat.size) {
      const chunkLength = Math.min(TUS_CHUNK_SIZE, archiveStat.size - offset);
      const chunk = Buffer.allocUnsafe(chunkLength);
      const { bytesRead } = await file.read(chunk, 0, chunkLength, offset);
      if (bytesRead !== chunkLength) throw new Error('Could not read the complete backup upload chunk');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        let response;
        try {
          response = await storage.proxy(uploadPath, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/offset+octet-stream',
              'Tus-Resumable': TUS_VERSION,
              'Upload-Offset': String(offset),
            },
            body: chunk,
          });
        } catch (error) {
          if (attempt === 4) throw error;
        }

        if (response?.ok) {
          const nextOffset = Number(response.headers.get('upload-offset'));
          if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + bytesRead) {
            throw new Error('Supabase resumable upload returned an unexpected offset');
          }
          offset = nextOffset;
          continue uploadLoop;
        }

        if (response && attempt === 4) {
          throw new Error(`Backup archive upload failed (${await responseError(response)})`);
        }

        await delay(500 * (attempt + 1));
        const remoteOffset = await getTusOffset(storage, uploadPath);
        if (remoteOffset > archiveStat.size) {
          throw new Error('Supabase resumable upload offset exceeded the archive size');
        }
        if (remoteOffset !== offset) {
          offset = remoteOffset;
          continue uploadLoop;
        }
      }
      throw new Error('Backup archive upload exhausted its retry budget');
    }
  } finally {
    await file.close();
  }
}

async function uploadManifest(storage, manifestName, manifest) {
  const response = await storage.proxy(storageObjectPath(BACKUP_BUCKET, manifestName), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upsert': 'false',
    },
    body: JSON.stringify(manifest),
  });
  if (!response.ok) {
    throw new Error(`Backup manifest upload failed (${await responseError(response)})`);
  }
}

async function listBackupObjects(storage) {
  const objects = [];
  const limit = 100;
  for (let offset = 0; offset < 10_000; offset += limit) {
    const response = await storage.proxy(
      `/storage/v1/object/list/${encodeStorageSegment(BACKUP_BUCKET)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          prefix: '',
          limit,
          offset,
          sortBy: { column: 'name', order: 'desc' },
        },
      }
    );
    if (!response.ok) {
      throw new Error(`Could not list backup archives (${await responseError(response)})`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Supabase returned an invalid backup object list');
    objects.push(...page);
    if (page.length < limit) return objects;
  }
  throw new Error('Backup object listing exceeded the safety limit');
}

async function deleteBackupObjects(storage, objectNames) {
  if (objectNames.length === 0) return;
  const response = await storage.proxy(
    `/storage/v1/object/${encodeStorageSegment(BACKUP_BUCKET)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: { prefixes: objectNames },
    }
  );
  if (!response.ok) {
    throw new Error(`Backup retention cleanup failed (${await responseError(response)})`);
  }
}

async function applyRetention(storage) {
  const objects = await listBackupObjects(storage);
  const expired = getRetentionDeletes(objects);
  await deleteBackupObjects(storage, expired);
  return expired.length;
}

async function verifyRemoteArchive(storage, objectName, expectedSize) {
  const objects = await listBackupObjects(storage);
  const object = objects.find(item => item?.name === objectName);
  if (!object) throw new Error('Uploaded backup archive is missing from Supabase Storage');
  const remoteSize = Number(object?.metadata?.size);
  if (Number.isFinite(remoteSize) && remoteSize !== expectedSize) {
    throw new Error('Uploaded backup archive size does not match the local snapshot');
  }
}

async function downloadObject(storage, objectName) {
  const response = await storage.proxy(storageObjectPath(BACKUP_BUCKET, objectName), {
    method: 'GET',
  });
  if (!response.ok) {
    throw new Error(`Backup download failed (${await responseError(response)})`);
  }
  return response;
}

async function ensureBackupRunSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS database_backup_runs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      object_name TEXT,
      manifest_name TEXT,
      size_bytes BIGINT,
      sha256 CHAR(64),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS database_backup_runs_status_completed_idx
      ON database_backup_runs (status, completed_at DESC);
  `);
}

async function runLockedBackup(lockClient, { force = false, now = new Date() } = {}) {
  await lockClient.query(`
    UPDATE database_backup_runs
       SET status = 'failed',
           completed_at = now(),
           error_message = 'Previous backup process ended before completion'
     WHERE status = 'running'
       AND started_at < now() - interval '30 minutes'
  `);

  const schedule = await lockClient.query(`
    SELECT
      MAX(completed_at) FILTER (WHERE status = 'succeeded') AS last_success_at,
      MAX(started_at) AS last_attempt_at
    FROM database_backup_runs
  `);
  const { last_success_at: lastSuccessAt, last_attempt_at: lastAttemptAt } = schedule.rows[0];
  if (!force && !isBackupDue({ lastSuccessAt, lastAttemptAt, now })) {
    return { status: 'skipped', reason: 'not_due' };
  }

  const runResult = await lockClient.query(
    `INSERT INTO database_backup_runs (status, started_at)
     VALUES ('running', $1)
     RETURNING id`,
    [now]
  );
  const runId = runResult.rows[0].id;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'extipspanel-backup-'));
  const objectName = buildBackupObjectName(now);
  const manifestName = objectName.replace(/\.dump$/, '.json');
  const archivePath = path.join(tempDirectory, objectName);

  try {
    const storage = createStorageClient();
    await ensurePrivateBucket(storage);
    await createDatabaseArchive(archivePath);
    const archiveStat = await stat(archivePath);
    if (archiveStat.size <= 0) throw new Error('Database backup archive is empty');
    const sha256 = await sha256File(archivePath);

    await uploadArchive(storage, objectName, archivePath);
    await verifyRemoteArchive(storage, objectName, archiveStat.size);
    await uploadManifest(storage, manifestName, {
      version: 1,
      createdAt: now.toISOString(),
      archiveObject: objectName,
      format: 'postgresql-custom',
      sizeBytes: archiveStat.size,
      sha256,
    });

    let retentionWarning = null;
    try {
      await applyRetention(storage);
    } catch (error) {
      retentionWarning = sanitizeBackupError(error);
      console.warn(`[backup] Retention warning: ${retentionWarning}`);
    }

    await lockClient.query(
      `UPDATE database_backup_runs
          SET status = 'succeeded',
              object_name = $1,
              manifest_name = $2,
              size_bytes = $3,
              sha256 = $4,
              completed_at = now(),
              error_message = $5
        WHERE id = $6`,
      [objectName, manifestName, archiveStat.size, sha256, retentionWarning, runId]
    );
    return {
      status: 'succeeded',
      objectName,
      sizeBytes: archiveStat.size,
      sha256,
      retentionWarning,
    };
  } catch (error) {
    const safeMessage = sanitizeBackupError(error);
    await lockClient.query(
      `UPDATE database_backup_runs
          SET status = 'failed',
              completed_at = now(),
              error_message = $1
        WHERE id = $2`,
      [safeMessage, runId]
    ).catch(() => {});
    throw new Error(safeMessage);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function executeBackup(options) {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lockResult = await lockClient.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [BACKUP_LOCK_KEY]
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return { status: 'skipped', reason: 'already_running' };
    await ensureBackupRunSchema(lockClient);
    return await runLockedBackup(lockClient, options);
  } finally {
    if (locked) {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [BACKUP_LOCK_KEY]).catch(() => {});
    }
    lockClient.release();
  }
}

export async function runDatabaseBackupIfDue(options = {}) {
  if (runningBackupPromise) return { status: 'skipped', reason: 'already_running' };
  runningBackupPromise = executeBackup(options);
  try {
    return await runningBackupPromise;
  } finally {
    runningBackupPromise = null;
  }
}

async function backupSchedulerTick() {
  try {
    const result = await runDatabaseBackupIfDue();
    if (result.status === 'succeeded') {
      console.log(`[backup] Database snapshot stored (${result.sizeBytes} bytes, sha256=${result.sha256.slice(0, 12)}…)`);
    }
  } catch (error) {
    console.error(`[backup] Database snapshot failed: ${sanitizeBackupError(error)}`);
  }
}

export function startDatabaseBackupScheduler({
  initialDelayMs = BACKUP_INITIAL_DELAY_MS,
  checkIntervalMs = BACKUP_CHECK_INTERVAL_MS,
} = {}) {
  if (initialTimer || intervalTimer) return false;
  console.log(
    `[backup] Scheduler started (every ${BACKUP_INTERVAL_MS / 3_600_000}h, retention=${BACKUP_RETENTION_COUNT})`
  );
  initialTimer = setTimeout(() => {
    initialTimer = null;
    backupSchedulerTick();
    intervalTimer = setInterval(backupSchedulerTick, checkIntervalMs);
    intervalTimer.unref?.();
  }, initialDelayMs);
  initialTimer.unref?.();
  return true;
}

export function stopDatabaseBackupScheduler() {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
}

export async function verifyLatestRemoteBackup({ outputPath } = {}) {
  const storage = createStorageClient();
  await ensurePrivateBucket(storage);
  const objects = await listBackupObjects(storage);
  const latest = selectLatestCompleteBackup(objects);
  if (!latest) throw new Error('No complete Supabase database backup was found');

  const manifestResponse = await downloadObject(storage, latest.manifestName);
  const manifest = await manifestResponse.json();
  if (
    manifest?.version !== 1 ||
    manifest?.archiveObject !== latest.archiveName ||
    !/^[a-f0-9]{64}$/.test(String(manifest?.sha256 || '')) ||
    !Number.isSafeInteger(Number(manifest?.sizeBytes))
  ) {
    throw new Error('Latest database backup manifest is invalid');
  }

  const tempDirectory = outputPath
    ? null
    : await mkdtemp(path.join(os.tmpdir(), 'extipspanel-verify-'));
  const destination = outputPath || path.join(tempDirectory, latest.archiveName);
  try {
    const archiveResponse = await downloadObject(storage, latest.archiveName);
    if (!archiveResponse.body) throw new Error('Backup download returned no data');
    await pipeline(
      Readable.fromWeb(archiveResponse.body),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    );

    const archiveStat = await stat(destination);
    const actualSha256 = await sha256File(destination);
    if (archiveStat.size !== Number(manifest.sizeBytes)) {
      throw new Error('Backup archive size does not match its manifest');
    }
    if (actualSha256 !== manifest.sha256) {
      throw new Error('Backup archive checksum does not match its manifest');
    }
    await assertValidArchive(destination);
    return {
      archiveObject: latest.archiveName,
      createdAt: manifest.createdAt,
      sizeBytes: archiveStat.size,
      sha256: actualSha256,
      outputPath: outputPath ? destination : null,
    };
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  }
}