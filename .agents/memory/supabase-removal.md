---
name: Supabase removal
description: All non-admin Supabase client calls replaced with REST API equivalents; stub routes added for secondary features.
---

## Rule
Never call `supabase.*` in any non-admin frontend file. All data access goes through `/api/*` Express routes.

## What was replaced
- Settings.tsx — profile save → PATCH /api/auth/profile; password → POST /api/auth/change-password; api-key → PATCH /api/auth/api-key; avatar → disabled (toast "coming soon")
- ApiAccess.tsx — api-key save → PATCH /api/auth/api-key
- Orders.tsx — orders list → GET /api/orders; organic runs → return [] (schema mismatch); reschedule → POST /api/engagement-orders/runs/:runId/reschedule
- EngagementOrder.tsx — realtime bundle invalidation → setInterval every 5 min
- useMaintenanceMode.ts — supabase.rpc + realtime → GET /api/platform/maintenance (polling 60s)
- OxapayDepositCard.tsx — supabase.functions.invoke → fetch /api/oxapay/* (stub: 501)
- AISpeedRecommender.tsx, AIEngagementChat.tsx — supabase.functions.invoke → fetch /api/ai/speed-recommender (stub: 501)
- LiveChatWidget.tsx — realtime → setInterval 5s; chat_messages insert → POST /api/chat/messages
- Instagram.tsx — accounts/link-events → REST; link-account/refresh-media → stub 501; delete → REST
- MassOrder.tsx — process-engagement-order → POST /api/engagement-orders/create; batch tracking → REST stubs
- MyPosts.tsx — instagram_accounts → REST; refresh-media → REST; realtime → setInterval 10s

## Server endpoints added (auth.js)
- PATCH /api/auth/profile
- POST /api/auth/change-password
- PATCH /api/auth/api-key

## Server endpoints added (create-engagement-order.js)
- PATCH /api/engagement-orders/items/:itemId/refill
- POST /api/engagement-orders/runs/:runId/check-status
- POST /api/engagement-orders/runs/check-all-status
- POST /api/engagement-orders/runs/:runId/reschedule

## Stub routes (server/src/routes/stubs.js)
- GET /api/platform/maintenance
- GET/DELETE /api/instagram/accounts, GET /api/instagram/link-events
- POST /api/instagram/link-account → 501, POST /api/instagram/refresh-media → 501
- GET/POST /api/chat/messages
- PATCH /api/mass-orders/batch-items/:id, PATCH /api/mass-orders/batches/:id, GET /api/mass-orders/batch-items
- POST /api/ai/speed-recommender → 501
- POST /api/oxapay/create-wallet-topup → 501, POST /api/oxapay/sync-deposit → 501

**Why:** User explicitly requested removal of all Supabase dependencies; site was failing for paying users because Supabase credentials were VPS-specific.

**How to apply:** If you add a new page/component that needs data, always write a new Express route and fetch from `/api/*`. Never re-import supabase client for data calls.
