---
name: Historical order restore guard
description: Preserve restored VPS history without redispatching old delivery runs.
---

## Rule
Keep the restored VPS engagement orders, items, delivery runs, and health history. Startup seeds must never delete or rewrite them, and cron must only mutate orders numbered 3800 or newer.

## Why
The user reversed the earlier clean-slate decision and explicitly requested the complete Extips history. The archive includes unfinished historical runs; allowing cron to process them would resend old paid orders to providers.

## What is preserved
- Historical order numbers range below 3800.
- New orders still begin at 3800.
- Historical statuses, provider responses, health records, quantities, and timestamps remain exactly as archived.

## How to apply
Restore history from the archived database rather than application seed arrays. Any cron query that dispatches, polls, recovers, resets, or requeues runs must join the parent engagement order and enforce order number 3800 or newer.
After any restore, keep the next order sequence at 3800 without consuming it.
