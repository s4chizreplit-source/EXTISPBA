---
name: Auth migration
description: Frontend auth replaced from Supabase to Express REST API; key decisions and constraints.
---

# Auth migration

## Rule
All auth (signIn, signUp, signOut, session) now goes through `/api/auth/*` on the Express server (port 3000), proxied by Vite on port 5000. Do NOT revert to Supabase auth.

**Why:** Imported users exist in `auth.users` with bcrypt hashes (Supabase format). Supabase auth service is no longer used; Replit PostgreSQL is the database.

## How to apply
- `src/hooks/useAuth.tsx` — uses `fetch('/api/auth/...')` with `credentials: 'include'`
- `server/src/routes/auth.js` — queries `auth.users` + `public.profiles` + `public.user_roles`
- Login password validation uses `min(1)` not `min(8)` so imported short passwords work
- Many other components still call `supabase.from(...)` and `supabase.functions.invoke(...)` — those need migrating in follow-up tasks
