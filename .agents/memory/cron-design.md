---
name: Cron design
description: Organic run dispatcher race conditions, fixes, and tuning decisions.
---

# Cron design — organic_run_schedule dispatcher

## Root causes of duplicate dispatches (both must be fixed together)

1. **Transaction scope bug**: original code did `query(SELECT ... FOR UPDATE SKIP LOCKED)` as a plain query (auto-commit). The lock released immediately, before status was updated to 'started'. A second tick starting within 15s could SELECT the same rows.

2. **JOIN fan-out bug**: `service_provider_mapping` has 2-3 active rows per service. Joining it in the same query multiplied each `ors` row — so one run appeared 2-3 times in the result set and `Promise.allSettled` dispatched it to the provider 2-3 times.

## Fix applied
Three-step transaction in `processBatch()`:
1. `SELECT ors.id ... FOR UPDATE SKIP LOCKED` (no fan-out joins) — locks rows.
2. `UPDATE ... SET status='started'` on those IDs — within same tx, before lock releases.
3. Separate `SELECT DISTINCT ON (ors.id) ... WHERE ors.id = ANY($ids)` — safe join for account details, no FOR UPDATE.

**Why:** DISTINCT ON + FOR UPDATE is a PostgreSQL error (0A000). Separating the lock step from the detail fetch lets us use DISTINCT ON safely.

## Tuning
- `BATCH_SIZE = 25`, `TICK_MS = 15_000` (was 10 / 30s)
- Query filter: `ors.retry_count < 3` — prevents exhausted VPS-imported runs from consuming the batch
- Bulk-cleanup: `UPDATE ... SET status='failed' WHERE status='pending' AND retry_count >= 3` — run once in Aug 2026 to clear 1,395 stale rows

## Known remaining issue
Runs stuck in `status='started'` after server restart are orphaned (cron only picks `status='pending'`). Fix: on startup, reset `started` rows older than 5 min back to `pending`.

## "You have active order with this link" error
Provider-side constraint: they already have an active order for that Instagram URL (from VPS era). These runs get 3 retries then are marked failed. Workaround: don't retry these — future improvement is to detect this error code and mark failed immediately.
