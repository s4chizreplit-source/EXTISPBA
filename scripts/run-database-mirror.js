#!/usr/bin/env node
import 'dotenv/config';
import { pool } from '../server/src/db.js';
import {
  isProductionRuntime,
  runDatabaseMirrorIfDue,
  sanitizeMirrorError,
} from '../server/src/services/databaseMirror.js';

const args = new Set(process.argv.slice(2));
const allowDevelopment = args.has('--allow-development');
const force = args.has('--force');

if (!isProductionRuntime() && !allowDevelopment) {
  console.error(
    '[mirror] Refusing to mirror development data. ' +
    'Use --allow-development only for an explicitly labelled bootstrap/test.'
  );
  process.exitCode = 1;
} else {
  try {
    const result = await runDatabaseMirrorIfDue({
      allowNonProduction: allowDevelopment,
      force,
    });
    console.log(`[mirror] Result: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`[mirror] Failed: ${sanitizeMirrorError(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}