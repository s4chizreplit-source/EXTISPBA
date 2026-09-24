/**
 * Google Drive database backup — runs every 6 hours.
 *
 * Creates a plain-SQL gzipped dump of the Replit PostgreSQL database and
 * uploads it to the "DhanSMM VPS Backups" folder in the connected Google Drive.
 * Keeps the last RETENTION_COUNT backups and deletes older ones automatically.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReplitConnectors } from '@replit/connectors-sdk';
import { getPgDumpEnvironment } from './databaseBackup.js';

const DRIVE_FOLDER_NAME  = 'DhanSMM VPS Backups';
const FILE_PREFIX        = 'replit_organicsmm_db_';
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const RETRY_INTERVAL_MS  = 30 * 60 * 1000;       // retry after 30 min on failure
const RETENTION_COUNT    = 20;                    // keep last 20 Drive backups
const INITIAL_DELAY_MS   = 90_000;               // 90 s after startup
const CHECK_INTERVAL_MS  = 5 * 60 * 1000;        // poll every 5 min
const DUMP_TIMEOUT_MS    = 15 * 60 * 1000;       // pg_dump hard kill after 15 min
const MULTIPART_LIMIT    = 40 * 1024 * 1024;     // use resumable upload above 40 MB

let initialTimer  = null;
let intervalTimer = null;
let running       = false;
let lastSuccessAt = null;
let lastAttemptAt = null;

// ── Drive client ──────────────────────────────────────────────────────────────

function createDriveProxy() {
  const connectors = new ReplitConnectors();
  return connectors.createProxyFetch('google-drive');
}

async function driveJson(proxy, apiPath, options = {}) {
  const resp = await proxy(apiPath, options);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Drive API ${resp.status} [${apiPath.slice(0, 60)}]: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ── Folder lookup / creation ─────────────────────────────────────────────────

async function findOrCreateFolder(proxy) {
  const q = `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const data = await driveJson(
    proxy,
    `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
    { method: 'GET' }
  );
  if (data.files?.length > 0) {
    return data.files[0].id;
  }

  // Folder doesn't exist yet — create it
  const folder = await driveJson(proxy, '/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  console.log(`[gdrive-backup] Created folder "${DRIVE_FOLDER_NAME}" (${folder.id})`);
  return folder.id;
}

// ── File name ─────────────────────────────────────────────────────────────────

function buildFileName(now = new Date()) {
  const y   = now.getUTCFullYear();
  const mo  = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d   = String(now.getUTCDate()).padStart(2, '0');
  const h   = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  return `${FILE_PREFIX}${y}${mo}${d}_${h}${min}.sql.gz`;
}

// ── Database dump ─────────────────────────────────────────────────────────────

async function dumpDatabase(filePath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured');
  const env = getPgDumpEnvironment(databaseUrl);

  return new Promise((resolve, reject) => {
    // pg_dump plain SQL piped through gzip → file
    const child = spawn(
      'sh',
      ['-c', 'pg_dump --format=plain --no-owner --no-privileges | gzip -9'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const out = createWriteStream(filePath);
    child.stdout.pipe(out);

    const errChunks = [];
    child.stderr.on('data', chunk => errChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
      reject(new Error('pg_dump timed out after 15 minutes'));
    }, DUMP_TIMEOUT_MS);

    child.once('close', () => clearTimeout(timer));

    out.once('finish', () => {
      const errText = Buffer.concat(errChunks).toString().trim();
      // pg_dump writes progress notices to stderr even on success; only fail on "error:"
      if (errText.toLowerCase().includes('error:')) {
        reject(new Error(`pg_dump error: ${errText.slice(0, 400)}`));
      } else {
        resolve();
      }
    });

    child.once('error', err => { clearTimeout(timer); reject(err); });
    out.once('error', err => { clearTimeout(timer); child.kill(); reject(err); });
  });
}

// ── Upload helpers ────────────────────────────────────────────────────────────

async function uploadMultipart(proxy, folderId, fileName, fileData) {
  const boundary = `gdrivebkp${Date.now().toString(36)}`;
  const metaJson = JSON.stringify({ name: fileName, parents: [folderId] });
  const headerBuf = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n` +
    `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`
  );
  const footerBuf = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([headerBuf, fileData, footerBuf]);

  return driveJson(proxy, '/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function uploadResumable(proxy, folderId, fileName, filePath, fileSize) {
  // Step 1 — create upload session
  const initResp = await proxy('/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'application/gzip',
      'X-Upload-Content-Length': String(fileSize),
    },
    body: JSON.stringify({ name: fileName, parents: [folderId] }),
  });
  if (!initResp.ok) {
    const text = await initResp.text().catch(() => '');
    throw new Error(`Drive resumable init failed (${initResp.status}): ${text.slice(0, 200)}`);
  }

  // Convert absolute Location URL → relative path for the proxy
  const locationRaw = initResp.headers.get('Location') || '';
  let uploadPath;
  try {
    const url = new URL(locationRaw);
    uploadPath = `${url.pathname}${url.search}`;
  } catch {
    throw new Error(`Drive returned an invalid resumable upload location: ${locationRaw.slice(0, 100)}`);
  }

  // Step 2 — send file content in one PUT (file already in memory via caller)
  const fileData = await readFile(filePath);
  const uploadResp = await proxy(uploadPath, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(fileSize),
    },
    body: fileData,
  });
  if (!uploadResp.ok) {
    const text = await uploadResp.text().catch(() => '');
    throw new Error(`Drive resumable upload failed (${uploadResp.status}): ${text.slice(0, 200)}`);
  }
  return uploadResp.json();
}

async function uploadToDrive(proxy, folderId, fileName, filePath) {
  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;

  if (fileSize === 0) throw new Error('Database dump is empty — backup aborted');

  if (fileSize <= MULTIPART_LIMIT) {
    const fileData = await readFile(filePath);
    return uploadMultipart(proxy, folderId, fileName, fileData);
  }
  return uploadResumable(proxy, folderId, fileName, filePath, fileSize);
}

// ── Retention ─────────────────────────────────────────────────────────────────

async function pruneOldBackups(proxy, folderId) {
  const q = `'${folderId}' in parents and name contains '${FILE_PREFIX}' and trashed = false`;
  const resp = await proxy(
    `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime)&orderBy=createdTime%20desc&pageSize=100`,
    { method: 'GET' }
  );
  if (!resp.ok) return 0;

  const data = await resp.json();
  const toDelete = (data.files || []).slice(RETENTION_COUNT);
  await Promise.allSettled(
    toDelete.map(f => proxy(`/drive/v3/files/${f.id}`, { method: 'DELETE' }))
  );
  return toDelete.length;
}

// ── Main backup run ───────────────────────────────────────────────────────────

async function runGoogleDriveBackup() {
  const now = new Date();
  lastAttemptAt = now;

  const tempDir  = await mkdtemp(path.join(os.tmpdir(), 'gdrive-backup-'));
  const fileName = buildFileName(now);
  const filePath = path.join(tempDir, fileName);

  try {
    console.log('[gdrive-backup] Starting database dump...');
    await dumpDatabase(filePath);

    const fileStat = await stat(filePath);
    const kb = (fileStat.size / 1024).toFixed(1);
    console.log(`[gdrive-backup] Dump ready: ${kb} KB — uploading to Drive...`);

    const proxy    = createDriveProxy();
    const folderId = await findOrCreateFolder(proxy);
    await uploadToDrive(proxy, folderId, fileName, filePath);
    console.log(`[gdrive-backup] ✅ ${fileName} uploaded to "${DRIVE_FOLDER_NAME}"`);

    const pruned = await pruneOldBackups(proxy, folderId).catch(e => {
      console.warn(`[gdrive-backup] Retention warning: ${e.message}`);
      return 0;
    });
    if (pruned > 0) console.log(`[gdrive-backup] Pruned ${pruned} old backup(s)`);

    lastSuccessAt = new Date();
    return { status: 'succeeded', fileName, sizeBytes: fileStat.size };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────────

function isBackupDue() {
  const now = Date.now();
  if (lastSuccessAt && now - lastSuccessAt.getTime() < BACKUP_INTERVAL_MS) return false;
  if (lastAttemptAt && now - lastAttemptAt.getTime() < RETRY_INTERVAL_MS)  return false;
  return true;
}

async function tick() {
  if (running || !isBackupDue()) return;
  running = true;
  try {
    await runGoogleDriveBackup();
  } catch (err) {
    const safe = String(err?.message || err)
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted DB URL]')
      .replace(/\b(password|token|api_key)=([^\s&]+)/gi, '$1=[redacted]')
      .slice(0, 600);
    console.error(`[gdrive-backup] ❌ Backup failed: ${safe}`);
  } finally {
    running = false;
  }
}

export function startGoogleDriveBackupScheduler({
  initialDelayMs = INITIAL_DELAY_MS,
  checkIntervalMs = CHECK_INTERVAL_MS,
} = {}) {
  if (initialTimer || intervalTimer) return false;
  console.log(`[gdrive-backup] Scheduler started (every 6h, retention=${RETENTION_COUNT})`);
  initialTimer = setTimeout(() => {
    initialTimer = null;
    tick();
    intervalTimer = setInterval(tick, checkIntervalMs);
    intervalTimer.unref?.();
  }, initialDelayMs);
  initialTimer.unref?.();
  return true;
}

export function stopGoogleDriveBackupScheduler() {
  if (initialTimer)  clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer  = null;
  intervalTimer = null;
}
