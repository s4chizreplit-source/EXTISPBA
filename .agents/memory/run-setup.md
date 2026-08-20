---
name: Run setup
description: How this project starts and what ports/env it needs.
---

# Run setup

## Workflow command
`sh -c 'node server/src/index.js & exec npm run dev'`

- Express API: port 3000 (needs DATABASE_URL, SESSION_SECRET)
- Vite dev server: port 5000 (webview, proxies /api → :3000)

## Env
- `DATABASE_URL` — Replit managed, points to Replit PostgreSQL with imported VPS data
- `SESSION_SECRET` — Replit secret, required for Express sessions
- `VITE_SUPABASE_*` — still in `.env` for frontend components not yet migrated off Supabase

## Why
Express `app.get(/.*/)` (regex) needed instead of `app.get('*')` — newer path-to-regexp rejects the `*` wildcard pattern.
