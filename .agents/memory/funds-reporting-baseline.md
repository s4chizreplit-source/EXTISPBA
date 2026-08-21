---
name: Funds reporting baseline
description: Why historical admin fund totals are corrected independently from user wallet and transaction data.
---

## Rule
Treat the confirmed historical “Total Funds Added” value as a reporting baseline, then add only successful deposits created after the baseline timestamp.

**Why:** Development had a full imported deposit history while production did not, even though wallet data remained present. Editing wallets or old ledger rows to force the dashboard total would risk changing user money and would still produce inconsistent environments.

**How to apply:** Keep the baseline timestamp stable and initialize it only once. Future successful deposits increment the reported amount and count normally. Never reset the baseline on restart or use wallet balance mutations to correct an admin-only aggregate.