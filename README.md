# NEW PANNEL

Mera GitHub repo connect ho chuka hai. Ye ek full SMM platform hai — "Organic SMM Pro". Isme sab kuch already coded hai. Mujhe bas ensure karna hai ki:

Lovable Cloud (Supabase) Setup — Database tables, RLS policies, Edge Functions sab deploy ho jayein exactly jaisa code me hai.

Database Migration — Ye tables create karo agar nahi hain:

profiles, wallets, transactions, user_roles (enum: admin/moderator/user)

services, providers, provider_accounts, service_provider_mapping

engagement_bundles, bundle_items

engagement_orders, engagement_order_items, organic_run_schedule

orders, subscriptions, subscription_requests

support_tickets, chat_conversations, chat_messages

platform_settings (maintenance_mode, global_markup_percent)

deposits table if needed

RLS Policies — Users apna data dekh sakein, admins sab dekh sakein. has_role() security definer function use karo.

Edge Functions Deploy — Ye sab deploy karo:

process-order, process-engagement-order, execute-organic-runs, execute-all-runs

check-order-status, cancel-order, import-services

verify-usdt-deposit, get-exchange-rates

check-subscription-expiry, send-telegram-notification

auto-verify-signup, public-api

Storage Bucket — deposit-screenshots bucket create karo (public).

Auth Setup — Email/password auth enable karo. Auto-confirm OFF rakho.

Database Functions — has_role(), get_user_role(), get_admin_dashboard_stats(), get_admin_users_summary() create karo.

Triggers — Profile auto-create on signup, wallet auto-create on signup.

Realtime — Enable realtime for: organic_run_schedule, engagement_order_items, orders, chat_messages

Platform Settings — Insert default row: maintenance_mode=false, global_markup_percent=0

Sab kuch code me already hai — bas database aur cloud infrastructure setup karna hai. Code me koi change MAT karo. Sirf backend setup karo.

Step 2: Agar koi error aaye to ye paste karo:

Build errors fix karo. Code me jo bhi import errors, type errors ya missing dependencies hain wo resolve karo. Features ya UI change MAT karo — sirf errors fix karo.

Step 3: Admin user setup:

Mera account admin banao. user_roles table me meri user_id ke saath role='admin' insert karo. Pehle meri user_id profiles table se nikal lo.

Important Notes:

GitHub repo: https://github.com/xbhishekh/organicsmm

Brand: Organic SMM Pro

Color: Orange + White theme

Logo already codebase me hai: src/assets/logo.jpg

Favicon: public/favicon.ico (already set)

All features: Engagement orders, Organic delivery, Multi-provider rotation, Wallet, Subscriptions, Live Chat, Admin Panel

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://whopxbot.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/09c93b64-47c3-4f88-9897-bf2db15f9438).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
