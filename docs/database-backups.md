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