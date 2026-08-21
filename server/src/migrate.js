import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Databases imported from the original Supabase/VPS app use auth_users and
  // structurally supersede the early self-hosted users/services bootstrap.
  // Baseline those two migrations instead of trying to apply the incompatible
  // fresh-install schema over live imported tables.
  const { rows: [legacySchema] } = await pool.query(`
    SELECT
      to_regclass('public.auth_users') IS NOT NULL AS has_auth_users,
      to_regclass('public.engagement_orders') IS NOT NULL AS has_engagement_orders
  `);
  if (legacySchema.has_auth_users && legacySchema.has_engagement_orders) {
    await pool.query(`
      INSERT INTO schema_migrations (name)
      VALUES ('001_init.sql'), ('002_seed_services.sql')
      ON CONFLICT (name) DO NOTHING
    `);
  }

  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${file}:`, err.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? 'no pending migrations' : `${ran} migration(s) applied`);
  await pool.end();
}

main();
