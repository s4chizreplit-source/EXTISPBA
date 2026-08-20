---
name: Order placement migration
description: Order creation endpoint ported from Supabase edge function to Express REST; auth/admin table name bugs fixed.
---

# Order Placement Migration

## The rule
`POST /api/engagement-orders/create` (server/src/routes/create-engagement-order.js) now handles all order creation. The Supabase edge function `process-engagement-order` is no longer called from the frontend.

**Why:** `supabase.functions.invoke('process-engagement-order')` failed on production with "Auth session missing" because Supabase auth context is absent — the app uses Express sessions, not Supabase JWT.

**How to apply:** Any future order-related changes go in `server/src/routes/create-engagement-order.js` and `server/src/routes/engagement-orders.js`. Do not re-introduce Supabase function calls in `src/pages/EngagementOrder.tsx`.

## Signup column mismatch (auth.js)
`auth_users` uses VPS Supabase schema — columns are `encrypted_password` + `raw_user_meta_data` (jsonb), NOT `password_hash`/`full_name`/`role`. Signup route must:
- Use `gen_random_uuid()` for `id` (no default in prod)
- INSERT `encrypted_password` (not `password_hash`)
- Store `full_name` + `role` in `raw_user_meta_data` jsonb
- Insert into `user_roles` table separately for role
- Insert into `profiles` with `user_id, email, full_name`
- Insert into `wallets`

Reset-password also uses `encrypted_password` (not `password_hash`).

## Table name bug (auth.js + admin.js)
Both files used `FROM users` / `INSERT INTO users` / `UPDATE users` — correct table is `auth_users` (seeded VPS table). This caused `relation "users" does not exist` on production login/signup.

**Fixed files:** `server/src/routes/auth.js` (lines ~105, 112, 116, 167, 200), `server/src/routes/admin.js` (users list + patch routes).

## Cron status-check (real delivery verification)
Runs were previously marked `completed` immediately after placing provider order (`action=add`). Fixed flow:
1. After `action=add` succeeds → mark run `processing` (not completed)
2. `checkProcessingRuns()` runs every 15s → polls `action=status` for all `processing` runs (bulk first, then individual fallback)
3. Provider says "Completed" → mark `completed` with `provider_status`, `provider_remains`, `provider_start_count`, `provider_charge`
4. Provider says "Canceled" → mark `failed`
5. Startup auto-re-queues existing `completed` runs with no `provider_status` (7-day window) for retroactive verification

Quantity randomization: `generateRunSchedule` now assigns random weights per run, reconciles to exact total, avoids uniform distribution.

## VPS historical orders missing item data
Production `engagement_order_items` = 0 rows for order_numbers 1–2695 (dev has 5,901). `organic_run_schedule` = 0 rows (dev has 71,737). Only `engagement_orders` was seeded. New orders placed after fix have correct items + runs. Historical orders show 0/0 — tracked as follow-up task.
