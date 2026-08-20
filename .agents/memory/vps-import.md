---
name: VPS import
description: What was imported from the VPS Supabase dump into Replit PostgreSQL.
---

# VPS PostgreSQL import

## What was imported
All `auth.*`, `public.*`, and `storage.*` tables from `supabase-export.sql.gz` (50 MB).
Key counts: 811 auth users, 811 profiles, 811 wallets, 3679 transactions, 40 services, 2695 engagement orders.

**Why:** User wanted old Gmail/password login to work in Replit app.

## Key constraint
Passwords are bcrypt hashes stored in `auth.users.encrypted_password` (not `public.users.password_hash`).
The Express login route queries `auth.users` and verifies with `bcryptjs.compare`.

## How to apply
Always query `auth.users` for authentication. The separate `public.users` table from the Express server's own migration is not used — the imported data lives in `auth.users`.
