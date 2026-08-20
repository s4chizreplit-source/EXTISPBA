# Plan: Instagram Engagement Ordering — End-to-End Fix

## Current state
- **Bundle exists but inactive**, only 2 IG services (Views + Likes, no Comments), `bundle_items.price_per_k` = NULL
- **Missing edge functions**: `instagram-poll`, `telegram-engagement-bot`, `instagram-place-engagement`
- **Missing table**: `engagement_presets` (per-user default qty + mode)
- **Existing** `telegram-webhook` handles only `/start /link /wallet /posts /orders /cancel` — no preset/mode/order commands
- No `QuickOrderSheet` component
- No cron for auto-poll

## Step 1 — Database migration
1. Activate IG bundle, backfill `price_per_k` in `bundle_items` from `services.price`
2. Insert missing **Instagram Comments** service + bundle_item
3. New table `engagement_presets` — `user_id`, `views`, `likes`, `comments`, `drip_minutes`, `mode` ('auto'|'manual')
4. New table `instagram_poll_state` — `account_id`, `last_seen_media_id`, `last_polled_at` (so poll doesn't re-order old posts)

## Step 2 — Single order function `instagram-place-engagement`
Central function used by **poll + bot + website**. Input: `{ user_id, link, views?, likes?, comments? }`.
- Validate subscription + wallet balance
- Look up active IG bundle_items, price = Σ(qty/1000 × price_per_k × (1+markup))
- Debit wallet via `debit_wallet_for_order` RPC (idempotency key = `ig:{link}:{ts}`)
- Insert `engagement_orders` + `engagement_order_items` (one per type)
- Return `{ order_id, charged_inr }`

## Step 3 — `instagram-poll` (cron worker)
- For each active `instagram_accounts`, fetch profile embeds `engagement_presets` + `telegram_engagement_links` in **separate queries** (no FK joins → avoids PGRST200)
- Refresh media via existing `instagram-refresh-media`
- Compare new media vs `last_seen_media_id`
- If mode=`auto` + preset exists → call `instagram-place-engagement` directly
- If mode=`manual` + linked telegram → send inline-button msg (`callback_data: apply:<shortcode>:all`, `post:<shortcode>`)
- Update `last_seen_media_id`

## Step 4 — Extend `telegram-webhook` (rename mental model to "engagement bot")
Add commands:
- `/setdefault <v> <l> <c> <drip>` → upsert preset
- `/mode auto|manual`
- `/order <link> [v] [l] [c]` → calls place-engagement
- `/posts` → inline keyboard with "Apply preset" + "Custom" buttons
- `/status <n>`, refund on `/cancel <n>` (revert wallet)
- Callback handlers for `apply:<shortcode>:all` and `post:<shortcode>`

## Step 5 — Website UI
- New `QuickOrderSheet.tsx` — sheet with 3 sliders (views/likes/comments) + price preview + Confirm button that calls `instagram-place-engagement`
- `MyPosts.tsx`: existing "Boost" button opens QuickOrderSheet with post shortcode
- Add **manual link input** at top of `/my-posts` (paste any IG link → open sheet)

## Step 6 — Cron
`pg_cron` job every 10 min → `net.http_post` to `instagram-poll`. Visible in existing `/admin/cron-monitor`.

## Files
**New (backend):** `supabase/functions/instagram-place-engagement/index.ts`, `supabase/functions/instagram-poll/index.ts`
**Modified (backend):** `supabase/functions/telegram-webhook/index.ts` (add commands + callbacks)
**Migration:** activate bundle, add comments service, engagement_presets, instagram_poll_state, backfill price_per_k, cron job
**New (frontend):** `src/components/instagram/QuickOrderSheet.tsx`
**Modified (frontend):** `src/pages/MyPosts.tsx` (manual link input + sheet wiring)

## Note
Cancellation refunds: earlier you told me "user cancel karega to refund nahi milna chahiye" — that global rule is in `cancel-order`. This spec asks refund on `/cancel <n>` from bot. **Confirm:** should Telegram `/cancel` refund (spec) or stay no-refund (earlier rule)? I'll default to **no refund** to keep consistent unless you say otherwise.
