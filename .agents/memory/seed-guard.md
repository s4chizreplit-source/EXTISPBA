---
name: Seed guard — engagement orders
description: Why VPS engagement orders must NOT be re-seeded on server startup.
---

## Rule
The `seedAllData.js` seed must NOT insert rows into `engagement_orders`. The engagement orders seed block was permanently removed.

## Why
User explicitly requested a full order history wipe (clean slate). The seed previously contained 2695 VPS historical orders and would re-insert them after any TRUNCATE because the seed's count-guard (`cnt >= seedData.length`) detected 0 rows and inserted all of them.

## What remains
- Sequence is kept at >= 3800 so new production orders don't collide with old VPS order numbers.
- profiles, wallets, engagement_bundles, bundle_items are still seeded on first startup.

## How to apply
If someone asks to "restore order history" or "re-seed orders", do NOT add the engagement orders back to seedAllData.js. Instead, restore from a DB backup or manually import.
If `engagement_orders_order_number_seq` is ever reset, re-run: `SELECT setval('engagement_orders_order_number_seq', 3800, false);`
