# Database backups

The server creates a PostgreSQL custom-format (`pg_dump -Fc`) snapshot every six
hours and uploads it to the private Supabase Storage bucket
`replit-db-backups`. Each archive has a JSON sidecar containing its byte size and
SHA-256 checksum. The newest 28 snapshots are retained (seven days at four
snapshots per day).

The snapshot contains all database schemas and rows, including user IDs, bcrypt
password hashes, wallet/order history, and values stored in application tables.
It does not contain Replit Secrets or environment variables. Treat every archive
as highly sensitive.

The Supabase connection must remain attached to both the Repl and its published
Replit VM. Missing/invalid connector access fails the backup safely, records the
failure, and leaves existing snapshots untouched.

## Verify the latest backup

Run:

```sh
node scripts/verify-database-backup.js
```

This downloads the latest complete archive pair to a temporary directory,
checks the size and SHA-256 checksum, runs `pg_restore --list`, and deletes the
temporary copy.

To retain a verified archive for a controlled recovery:

```sh
node scripts/verify-database-backup.js --output /tmp/extipspanel-recovery.dump
```

The destination must not already exist. The file is created with owner-only
permissions.

## Recovery procedure

1. Stop all application writers and the order dispatcher.
2. Download and verify the latest archive with the command above.
3. Create an empty recovery PostgreSQL database. Do not test a restore against
   the live database. Its recovery role must be allowed to create schemas and
   any extensions listed by `pg_restore --list`; provision unavailable
   extensions before restoring.
4. Supply the recovery database connection through the standard PostgreSQL
   environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and
   `PGDATABASE`) using a secure secrets mechanism.
5. Restore with:

   ```sh
   pg_restore --dbname="$PGDATABASE" --exit-on-error --no-owner --no-privileges \
     --clean --if-exists /tmp/extipspanel-recovery.dump
   ```

6. Validate user, wallet, transaction, order, schedule, and migration counts in
   the recovery database before switching any application to it.
7. Rotate session credentials when recovering after a security incident.

Never publish the bucket, share a backup URL, or paste database credentials into
logs or chat.

## Supabase database mirror

The published server also refreshes the `extips-backup` Supabase PostgreSQL
database every six hours. This is separate from Storage archives: the mirror
creates real application tables and rows in Supabase's `public` schema, so they
are visible in Table Editor and can be used by a replacement backend.

Only the application's `public` schema is mirrored. Supabase-managed `auth`,
`storage`, and other internal schemas are never restored or replaced. Login
continues to use `public.auth_users`; user IDs and bcrypt password hashes are
validated by a one-way fingerprint during each refresh. Active
`public.user_sessions` rows are intentionally not copied, so users must sign in
again after a recovery.

Each refresh:

1. Exports a consistent source snapshot from the published production database.
2. Restores it to Supabase in one transaction.
3. Verifies the complete public table inventory, every table's row count,
   bcrypt credential fingerprint, and critical user relationships before commit.
4. Rolls back on any restore or verification failure, preserving the previous
   healthy mirror.

Successful snapshots are recorded in `replit_mirror.snapshots` on Supabase.
Development servers do not refresh the mirror automatically.

### Mirror recovery

To run the app against the Supabase mirror:

1. Deploy the complete project, including the Express server—not only the Vite
   frontend.
2. Set that deployment's `DATABASE_URL` to the secure Supabase Session pooler
   PostgreSQL URI.
3. Configure `SESSION_SECRET`, provider/OxaPay/Zapupi credentials, and other
   required environment secrets separately. Secrets are never copied into the
   database mirror.
4. Rotate `SESSION_SECRET`, start the backend, confirm `/healthz`, and test login,
   wallet balances, orders, and the dispatcher before changing DNS.

The mirror may be up to six hours behind the primary database. Storage archives
remain the longer-retention recovery option.