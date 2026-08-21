---
name: Production database isolation
description: Why live-data fixes must be verified against the production database rather than inferred from development.
---

## Rule
Treat development and published production as separate databases. A cleanup or count verified in development does not prove the live site has the same data.

**Why:** Development showed no historical engagement orders while the published site still had the full imported history. Production-only inspection exposed the mismatch.

**How to apply:** For any live-data report, query the production environment read-only and compare key counts before diagnosing or declaring success. Data cleanup that must run in production needs an explicit publish/startup path and post-publish verification.