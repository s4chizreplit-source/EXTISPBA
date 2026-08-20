# Lovable Cloud → VPS full migration (copy-paste blocks)

Repo: `https://github.com/xbhisofy/extips-new-pannel` (branch `main`)

Audit: **143 migrations**, **44 edge functions**, no `manualChunks` in `vite.config.ts` (safe).
Secrets used by functions: `OXAPAY_MERCHANT_API_KEY`, `ZAPUPI_ZAP_KEY`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
`TELEGRAM_CHAT_ID`, `TELEGRAM_API_KEY`, `APIFY_API_TOKEN`, `LOVABLE_API_KEY`, `RESEND_API_KEY`,
`PROVIDER_CURRENCY` (plus the auto-provided `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`).

Every block below is idempotent — safe to re-run.

## 0) One-time: migration config file on the VPS

```bash
printf 'CLOUD_URL=https://CLOUD_PROJECT_REF.supabase.co\nMIGRATION_TOKEN=YOUR_MIGRATION_TOKEN\n' \
  > /etc/smmpanel.migration && chmod 600 /etc/smmpanel.migration && cat /etc/smmpanel.migration
```
Expected: the two lines printed back.

## 1) Bootstrap the full Supabase stack

```bash
curl -fsSL https://raw.githubusercontent.com/xbhisofy/extips-new-pannel/main/deploy/supabase-selfhost.sh | bash
```
Expected: `migrations applied this run: 143` (or fewer on re-runs) and a printed credential block with `API_EXTERNAL_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`.

## 2) App install + build

```bash
bash /opt/smmpanel/deploy/hostinger-setup.sh
```
Expected: `GET http://127.0.0.1:3000 -> HTTP 200`.

## 3) Data import (automatic, no manual export)

```bash
bash /opt/smmpanel/deploy/import-data.sh
```
Expected: per-table `-> table  N rows` lines, then a row-count table matching Cloud.

## 4) Auth hashes + login proof

```bash
VERIFY_EMAIL='you@mail.com' VERIFY_PASSWORD='your-old-password' \
  bash /opt/smmpanel/deploy/import-auth-passwords.sh
```
Expected: `total_users / valid_bcrypt / email_identities` counts, then green `LOGIN OK — old password works`.

## 5) Edge functions + secrets

```bash
bash /opt/smmpanel/deploy/deploy-edge-functions.sh \
  && nano /etc/smmpanel.secrets \
  && bash /opt/smmpanel/deploy/deploy-edge-functions.sh \
  && bash /opt/smmpanel/deploy/schedule-cron.sh
```
Expected: `cron-status -> HTTP 200`, webhook URL table, then the `cron.job` list with 9 active jobs.

## 6) Domain + Caddy (auto-HTTPS)

```bash
DOMAIN=mydomain.com bash /opt/smmpanel/deploy/setup-domain.sh
```
Expected: `Valid configuration` from `caddy validate`, then `https://mydomain.com -> HTTP 200` and `https://api.mydomain.com/auth/v1/health -> HTTP 200`.

## 7) Future updates

```bash
bash /opt/smmpanel/deploy/update.sh
```
Expected: `HTTP 200 — update live at <sha>`; on any failure it prints `rolled back to <sha>` and the old site stays up.

## 8) Cleanup (mandatory, after 3–7 succeed)

In Lovable: delete the edge functions `export-cloud-data` and `export-auth-hashes`, delete the
`MIGRATION_TOKEN` secret, and drop the helper DB function:

```sql
DROP FUNCTION IF EXISTS public.export_auth_hashes();
```

Rollback plan: put the old `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` back in
`/opt/smmpanel/.env`, rebuild, restart — Cloud backend is never modified.
