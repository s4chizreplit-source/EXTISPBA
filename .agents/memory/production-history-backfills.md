---
name: Production history backfills
description: Safe restoration when a production overwrite skips a large related table group.
---

## Rule
Do not assume a successful bulk production overwrite copied every large related table. Restore a skipped group with an idempotent, transactional backfill that validates the complete archive and live state before inserting anything.

**Why:** A production overwrite copied ordinary application data but omitted a large engagement-history group. A first backfill also showed that a database CLI available in development may be absent or unreliable in the deployment VM. The portable application-owned database stream succeeded while preserving live-only orders.

**How to apply:** Package the archive with the application, use an application dependency rather than a development system binary, stage and count every related table inside one locked transaction, accept only all-empty or all-complete live history, reject partial state, and preserve the live sequence/range. Keep writers and background dispatch gated until verification succeeds. When production has new activity, use a normal publish rather than another data overwrite, then query production directly to confirm counts.