---
name: Organic delivery policy
description: Product rules for random schedules and real provider dispatch.
---

Apply organic quantity and timing randomization only when creating new orders. Do not rewrite already-scheduled runs. Every item schedule must still sum to its exact ordered quantity and respect provider minimums.

**Why:** The user explicitly chose future orders only and requires natural delivery without changing purchased totals.

**How to apply:** Generate and validate randomized quantities and gaps before saving a new schedule; never alter quantities inside the dispatch cron.

If an active provider account or service mapping is unavailable, keep the run pending with a visible configuration error. Never create a simulated provider ID or mark a run completed without a real provider response.

**Why:** Simulated completions were shown as delivered even though no provider request occurred, which is unacceptable for paid orders.

**How to apply:** Treat provider configuration as a prerequisite for dispatch and recover any known simulated runs back to the real dispatch queue.