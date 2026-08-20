---
name: Cron design
description: Organic run dispatcher race conditions, fixes, tuning, and provider rotation design.
---

# Cron design — organic_run_schedule dispatcher

## Root causes of duplicate dispatches (both must be fixed together)

1. **Transaction scope bug**: original code did `query(SELECT ... FOR UPDATE SKIP LOCKED)` as a plain query (auto-commit). The lock released immediately, before status was updated to 'started'. A second tick starting within 15s could SELECT the same rows.

2. **JOIN fan-out bug**: `service_provider_mapping` has 2-3 active rows per service. Joining it in the same query multiplied each `ors` row — so one run appeared 2-3 times in the result set and `Promise.allSettled` dispatched it to the provider 2-3 times.

## Fix applied (3-step transaction)
1. `SELECT ors.id ... FOR UPDATE SKIP LOCKED` (no fan-out joins) — locks rows.
2. `UPDATE ... SET status='started'` on those IDs — within same tx, before lock releases.
3. Separate query fetching ALL providers per run ordered by `sort_order` (no FOR UPDATE). Grouped in JS by run.id.

**Why DISTINCT ON was removed:** DISTINCT ON + FOR UPDATE is a PostgreSQL error (0A000). Step 3 now returns multiple rows per run (one per provider account) and JS groups them into `{ id, providers: [] }`.

## Provider rotation system (implemented)
Step 3 fetches **all** provider accounts for each run's service ordered by `sort_order` (priority 1 = lowest number = try first).

`dispatchRun()` logic:
- Iterate providers in sort_order.
- If provider API returns "active order with this link" → skip to next provider (`↩` log).
- If another provider succeeds → done (`✅` log).
- If **all** providers are busy → `UPDATE status='pending', scheduled_at=now()` — **no** `retry_count` increment (`⏳` log). Requeued immediately for next tick.
- Any other error (timeout, bad response) → `retry_count++`, pending + 5 min delay, or failed after 3 strikes.

**Why no retry_count on busy:** "active order with this link" is not a failure — it is a capacity constraint. Incrementing retry_count would waste the 3-strike budget and eventually fail a valid run.

**New provider auto-detection:** Because we query `service_provider_mapping` fresh every tick, any provider added to the DB mapping is automatically tried on the next cycle without restart.

## Tuning
- `BATCH_SIZE = 25`, `TICK_MS = 15_000`
- Query filter: `ors.retry_count < 3` — prevents exhausted runs from consuming the batch
- Bulk-cleanup: ran once Aug 2026 to mark 1,395 stale rows (retry_count >= 3) as failed

## Known remaining issue
Runs stuck in `status='started'` after server restart are orphaned. Fix: on startup, reset `started` rows older than 5 min back to `pending`.
