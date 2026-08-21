#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { verifyLatestRemoteBackup } from '../server/src/services/databaseBackup.js';

function parseOutputPath(argv) {
  const outputIndex = argv.indexOf('--output');
  if (outputIndex === -1) return null;
  const value = argv[outputIndex + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--output requires a destination file path');
  }
  return path.resolve(value);
}

try {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const result = await verifyLatestRemoteBackup({ outputPath });
  console.log(
    `[backup-verify] Valid PostgreSQL archive: ${result.archiveObject} ` +
    `(${result.sizeBytes} bytes, sha256=${result.sha256.slice(0, 12)}…)`
  );
  if (result.outputPath) {
    console.log(`[backup-verify] Archive retained at ${result.outputPath}`);
  }
} catch (error) {
  console.error(`[backup-verify] Verification failed: ${error.message}`);
  process.exitCode = 1;
}