---
name: VPS import
description: What was imported from the VPS Supabase dump into Replit PostgreSQL.
---

# VPS PostgreSQL import

## What was imported
The live VPS database and its large server-side backups were empty; the valid source was the workspace Supabase export.
The normalized PostgreSQL 16 import preserved 811 auth users, 811 profiles, 811 wallets, 3679 transactions, 40 services, provider configuration, and storage metadata. Full engagement-order history was subsequently restored from the same archive.

**Why:** User wanted old Gmail/password login and financial/provider data to work in the Replit app without restoring obsolete delivery history.

## Key constraint
Passwords are bcrypt hashes stored in `auth.users.encrypted_password` (not `public.users.password_hash`).
Startup mirrors imported credentials into `public.auth_users`; Express authentication uses that public table first and verifies with `bcryptjs.compare`.
The retained `auth.users` rows anchor imported foreign keys, and new signups must be mirrored to both tables with the same user ID.
Legacy engagement orders and organic runs below order number 3800 are preserved as read-only history; the next new order is 3800.

## How to apply
Use `public.auth_users` for application authentication and admin user counts. Preserve matching `auth.users` identities unless all dependent foreign keys are deliberately migrated.
Historical order data may be restored from the archived snapshot, but cron must never dispatch or mutate rows belonging to order numbers below 3800.
